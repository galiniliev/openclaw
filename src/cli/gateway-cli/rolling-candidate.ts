import fs from "node:fs/promises";
import {
  MAX_GATEWAY_ROLLING_CONTROL_BYTES,
  parseGatewayRollingContract,
  parseGatewayRollingControlRequest,
  type BoundGatewayRollingContract,
  type GatewayRollingContract,
  type GatewayRollingControlRequest,
  type GatewayRollingControlStatus,
  type GatewayRollingPhase,
} from "../../gateway/rolling-release-contract.js";
import { GatewayRollingStartup } from "../../gateway/rolling-startup.js";
import type { GatewayServer, GatewayServerOptions } from "../../gateway/server-public.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { routeLogsToStderr } from "../../logging/console.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  setGatewayRollingAdmission,
  getGatewayRollingAdmission,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";

type CandidateHost = { server: Promise<GatewayServer>; stop: () => Promise<void> };
type CandidateDependencies = {
  prewarm: () => Promise<void>;
  start: (
    options: GatewayServerOptions,
    publishServer: (server: GatewayServer) => void,
  ) => CandidateHost;
  reset: () => Promise<void>;
  now: () => number;
};

/** Fixed private control adapter. Resource effects stay with the ordinary Gateway owners. */
export class GatewayRollingCandidate {
  private phase: GatewayRollingPhase = "prewarming";
  private server?: GatewayServer;
  private host?: CandidateHost;
  private startup?: GatewayRollingStartup;
  private binding?: Promise<void>;
  private bound?: BoundGatewayRollingContract;
  private restoreReceiptId?: string;
  private observed?: GatewayRollingControlStatus["observed"];
  private closing?: Promise<void>;
  private activationSubmitted = false;

  constructor(
    private readonly contract: GatewayRollingContract,
    private readonly deps: CandidateDependencies,
  ) {
    if (contract.companionGeneration !== undefined) {
      throw new Error("Gateway final companion must be late-bound after immutable prewarm");
    }
  }

  async prewarm(): Promise<void> {
    this.assertUnexpired();
    await this.deps.prewarm();
    this.assertUnexpired();
    this.phase = "prewarmed";
  }

  status(): GatewayRollingControlStatus {
    if (
      this.activationSubmitted &&
      !this.closing &&
      this.server?.isRollingWriterReady?.() === true
    ) {
      this.phase = "writer-ready";
    }
    const readReady =
      ["read-only", "writer-prepared", "activating", "writer-ready"].includes(this.phase) &&
      this.server?.isRollingReadReady?.() === true;
    return {
      version: 1,
      releaseId: this.contract.releaseId,
      candidateBootId: this.contract.candidateBootId,
      phase: this.phase,
      immutableReady: this.phase !== "prewarming" && this.phase !== "failed",
      readReady,
      writerReady: this.phase === "writer-ready" && this.server?.isRollingWriterReady?.() === true,
      ...(this.observed ? { observed: this.observed } : {}),
    };
  }

  private assertUnexpired(): void {
    if (this.deps.now() >= this.contract.expiresAtMs) {
      throw new Error("Gateway rolling contract expired");
    }
  }

  private async bind(writer: boolean): Promise<void> {
    const bound = this.bound;
    if (!bound || !this.restoreReceiptId) {
      throw new Error("Gateway final companion has not been bound");
    }
    this.assertUnexpired();
    const ready = createDeferredCore();
    this.startup = new GatewayRollingStartup(ready.resolve, bound.releaseId);
    setGatewayRollingAdmission(bound.releaseId, true);
    this.host = this.deps.start(
      {
        bootId: bound.candidateBootId,
        sidecarStartup: "defer",
        rollingStartup: this.startup,
        ...(writer ? { rollingWriterPreparation: bound } : { rollingReadOnlyBinding: true }),
      },
      (server) => {
        this.server = server;
      },
    );
    this.server = await this.host.server;
    await racePromiseWithAbortSignal(ready.promise, this.startup.signal);
    this.assertUnexpired();
    const actual = await this.server.readRollingFacts?.();
    if (
      !actual ||
      actual.compatibilityDigest !== bound.compatibilityDigest ||
      (!writer && actual.executionOwner !== bound.predecessorOwner)
    ) {
      throw new Error("Gateway bound runtime does not match rolling compatibility and ownership");
    }
    this.observed = {
      ...actual,
      observedAtMs: this.deps.now(),
      companionGeneration: bound.companionGeneration,
      restoreReceiptId: this.restoreReceiptId,
    };
    this.phase = writer ? "writer-prepared" : "read-only";
  }

  async dispatch(request: GatewayRollingControlRequest): Promise<GatewayRollingControlStatus> {
    if (request.releaseId !== this.contract.releaseId) {
      throw new Error("Gateway rolling control release does not match");
    }
    if (request.action === "status") {
      return this.status();
    }
    if (request.action === "abort") {
      await this.close();
      return this.status();
    }
    this.assertUnexpired();
    let enteredEffect = false;
    try {
      if (request.action === "bind-read-only") {
        if (this.phase !== "prewarmed" || !request.companion || this.bound) {
          throw new Error("Gateway companion bind is allowed exactly once after prewarm");
        }
        this.bound = { ...this.contract, companionGeneration: request.companion.generation };
        this.restoreReceiptId = request.companion.restoreReceiptId;
        enteredEffect = true;
        this.phase = "binding-read-only";
        this.binding = this.bind(false);
        await this.binding;
      } else if (request.action === "prepare-writer") {
        if (this.phase !== "read-only") {
          throw new Error("Gateway writer preparation requires the bound read-only candidate");
        }
        enteredEffect = true;
        this.phase = "preparing-writer";
        // The predecessor remains the verified reader throughout this reset.
        await this.host?.stop();
        this.host = undefined;
        this.server = undefined;
        await this.deps.reset();
        this.binding = this.bind(true);
        await this.binding;
      } else {
        const retirement = request.predecessorRetirement;
        if (
          this.phase !== "writer-prepared" ||
          !this.server?.activateRollingWriter ||
          !retirement ||
          retirement.bootId !== this.contract.predecessorBootId ||
          retirement.releaseId !== this.contract.releaseId ||
          !retirement.exited
        ) {
          throw new Error("Gateway activation requires the exact predecessor child retirement");
        }
        enteredEffect = true;
        this.activationSubmitted = true;
        this.phase = "activating";
        await this.server.activateRollingWriter(() => {
          if (
            retirement.bootId !== this.contract.predecessorBootId ||
            retirement.releaseId !== this.contract.releaseId ||
            !retirement.exited
          ) {
            throw new Error("Gateway predecessor retirement changed during activation");
          }
        });
        this.phase = "writer-ready";
      }
    } catch (error) {
      if (enteredEffect) {
        this.phase = "failed";
      }
      throw error;
    }
    return this.status();
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.phase = "aborting";
      await this.host?.stop();
      await this.binding?.catch(() => undefined);
      this.server = undefined;
      await this.deps.reset();
      this.phase = "aborted";
    })());
  }
}

/** Writer preparation and all later restarts/stops use the established native run loop. */
function launchRollingGateway(
  port: number,
  options: GatewayServerOptions,
  publishServer: (server: GatewayServer) => void,
): CandidateHost {
  if (!options.rollingWriterPreparation) {
    const starting = import("../../gateway/server.js").then(async ({ startGatewayServer }) => {
      const server = await startGatewayServer(port, options);
      publishServer(server);
      return server;
    });
    return {
      server: starting,
      stop: async () => {
        options.rollingStartup?.beginClose();
        const server = await starting;
        await server.close();
        await options.rollingStartup?.close();
      },
    };
  }
  const contract = options.rollingWriterPreparation;
  const firstServer = createDeferredCore<GatewayServer>();
  const control = createDeferredCore<{ stop: () => void }>();
  const startupAbort = new AbortController();
  let first = true;
  const loop = import("./run-loop.js").then(({ runGatewayLoop }) =>
    runGatewayLoop({
      ownsProcessLifecycle: true,
      lockPort: port,
      rollingHandoff: contract,
      lifecycleLockDeadlineMs: performance.now() + Math.max(0, contract.expiresAtMs - Date.now()),
      startupSignal: startupAbort.signal,
      canRestart: () =>
        options.rollingStartup?.mutableActivationStarted === true &&
        getGatewayRollingAdmission() === undefined,
      controlReady: control.resolve,
      beforeReleaseLock: async (lock) => {
        if (!options.rollingStartup?.mutableActivationStarted) {
          if (!lock.returnRollingPreparationToPredecessor) {
            throw new Error("Gateway preparation return owner is unavailable");
          }
          await lock.returnRollingPreparationToPredecessor();
        }
      },
      start: async (runOptions) => {
        const initial = first;
        first = false;
        try {
          const { startGatewayServer } = await import("../../gateway/server.js");
          const server = await startGatewayServer(
            port,
            initial
              ? {
                  ...options,
                  ...runOptions,
                  hotReloadRecovery: runOptions?.requestHotReloadRecovery,
                }
              : {
                  ...runOptions,
                  sidecarStartup: "defer",
                  hotReloadRecovery: runOptions?.requestHotReloadRecovery,
                },
          );
          publishServer(server);
          if (initial) {
            firstServer.resolve(server);
          }
          return server;
        } catch (error) {
          if (initial) {
            firstServer.reject(error);
          }
          throw error;
        }
      },
    }),
  );
  void loop.then(
    (code) => {
      firstServer.reject(new Error("Gateway loop exited before writer preparation"));
      process.exitCode = code;
      process.stdin.destroy();
    },
    (error: unknown) => {
      firstServer.reject(error);
      process.exitCode = 1;
      process.stdin.destroy();
    },
  );
  return {
    server: firstServer.promise,
    stop: async () => {
      startupAbort.abort(new Error("Gateway rolling host stop requested"));
      const owner = await Promise.race([
        control.promise,
        loop.then(
          () => undefined,
          () => undefined,
        ),
      ]);
      owner?.stop();
      options.rollingStartup?.beginClose();
      const code = await loop;
      await options.rollingStartup?.close();
      if (code !== 0) {
        throw new Error(`Gateway loop stopped with exit ${code}`);
      }
    },
  };
}

/** Called before ordinary Gateway config/state bootstrap; stdout is private NDJSON only. */
export async function runGatewayRollingCandidateCommand(input: {
  releaseId: string;
  contractPath: string;
  port: number;
}): Promise<void> {
  routeLogsToStderr();
  const stat = await fs.lstat(input.contractPath);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size > MAX_GATEWAY_ROLLING_CONTROL_BYTES ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("Gateway rolling contract must be a private bounded regular file");
  }
  const contract = parseGatewayRollingContract(
    JSON.parse(await fs.readFile(input.contractPath, "utf8")),
  );
  if (
    contract.releaseId !== input.releaseId ||
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535
  ) {
    throw new Error("Gateway rolling CLI selection does not match its contract");
  }
  const candidate = new GatewayRollingCandidate(contract, {
    now: Date.now,
    prewarm: async () => {
      await import("../../gateway/server-start.js");
    },
    start: (options, publishServer) => launchRollingGateway(input.port, options, publishServer),
    reset: async () => {
      const { prepareGatewayRestartIteration } = await import("./run-loop-startup.js");
      await prepareGatewayRestartIteration(
        await import("./lifecycle.runtime.js"),
        createSubsystemLogger("gateway/rolling"),
        () => true,
      );
    },
  });
  let bytes = Buffer.alloc(0);
  const stop = () => {
    void candidate
      .close()
      .then(() => process.stdin.destroy())
      .catch(() => {
        process.exitCode = 1;
      });
  };
  const expire = setTimeout(
    () => {
      // Expiry refuses new handoff actions; it cannot revoke an already admitted
      // writer after the predecessor has positively retired.
      if (!["activating", "writer-ready"].includes(candidate.status().phase)) {
        stop();
      }
    },
    Math.max(0, contract.expiresAtMs - Date.now()),
  );
  expire.unref();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdin.once("end", stop);
  try {
    await candidate.prewarm();
    for await (const chunk of process.stdin) {
      bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
      if (bytes.length > MAX_GATEWAY_ROLLING_CONTROL_BYTES) {
        throw new Error("Gateway rolling control frame exceeds its bound");
      }
      let end: number;
      while ((end = bytes.indexOf(10)) >= 0) {
        const line = bytes.subarray(0, end).toString("utf8");
        bytes = bytes.subarray(end + 1);
        const request = parseGatewayRollingControlRequest(JSON.parse(line));
        try {
          const status = await candidate.dispatch(request);
          if (status.writerReady) {
            clearTimeout(expire);
          }
          await new Promise<void>((resolve, reject) => {
            process.stdout.write(
              `${JSON.stringify({ ...status, id: request.id, ok: true })}\n`,
              (error) => (error ? reject(error) : resolve()),
            );
          });
          if (status.phase === "aborted") {
            return;
          }
        } catch (error) {
          createSubsystemLogger("gateway/rolling").error(
            Buffer.from(formatErrorMessage(error)).subarray(0, 16_384).toString("utf8"),
          );
          process.stdout.write(
            `${JSON.stringify({ version: 1, id: request.id, releaseId: contract.releaseId, ok: false, errorCode: "ROLLING_ACTION_FAILED", phase: candidate.status().phase })}\n`,
          );
        }
      }
    }
  } finally {
    clearTimeout(expire);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    process.stdin.off("end", stop);
    await candidate.close();
  }
}
