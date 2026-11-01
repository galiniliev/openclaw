import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import {
  crabboxCommandOutput,
  leaseRunArgs,
  runCrabboxCommand,
  type LeaseCommandContext,
} from "./crabbox-worker-command.js";
import { createCrabboxNodeRuntimeSetup } from "./crabbox-worker-node-enrollment.js";
import { runProvisionSetup } from "./crabbox-worker-provision-commands.js";
import { readCrabboxRuntimeInstallation } from "./crabbox-worker-runtime-verification.js";
import { runCrabboxSetupEgress } from "./crabbox-worker-setup-egress.js";
import type { CrabboxSnapshotVerifierInput } from "./crabbox-worker-snapshot-verifier.js";
import {
  resolveCrabboxNodeEnrollmentTimeoutMs,
  WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS,
} from "./crabbox-worker-timeouts.js";
import type { RecipePreparation } from "./crabbox-worker-warm-image-recipe.js";

type ProjectPreparation = NonNullable<
  NonNullable<Parameters<WorkerProvider["provision"]>[2]>["project"]
>;

export async function prepareCrabboxWorkerRuntime(params: {
  context: Omit<Parameters<typeof runProvisionSetup>[0], "phase" | "setup">;
  prepareNodeRuntime: NonNullable<Parameters<WorkerProvider["provision"]>[2]>["prepareNodeRuntime"];
  leaseId: string;
  preparationSignal?: AbortSignal;
  assertCurrent: () => void;
  onSetupFailure: () => void;
}) {
  if (!params.prepareNodeRuntime) {
    throw new Error("Crabbox project snapshots require node runtime preparation");
  }
  const runtime = await params.prepareNodeRuntime();
  params.context.signal?.throwIfAborted();
  params.assertCurrent();
  const setup = createCrabboxNodeRuntimeSetup({
    nodeBootstrap: runtime.nodeBootstrap,
    workerBundle: runtime.workerBundle,
    leaseId: params.leaseId,
    target: params.context.profile.target,
  });
  const timeoutMs = resolveCrabboxNodeEnrollmentTimeoutMs(runtime.bootstrapTimeoutMs);
  let installationOutput: string | undefined;
  return {
    timeoutMs,
    snapshotRuntime: (): CrabboxSnapshotVerifierInput["currentRuntime"] => {
      params.assertCurrent();
      runtime.signal?.throwIfAborted();
      const { nodeBootstrap: node, workerBundle: worker } = runtime;
      if (!node.buildId || !node.manifestSha256 || !worker.bundleHash) {
        throw new Error("Snapshot capture requires complete current runtime producer identities");
      }
      if (installationOutput === undefined) {
        throw new Error("Snapshot capture requires completed native runtime installation");
      }
      const installationVerification = readCrabboxRuntimeInstallation(installationOutput, {
        nodeBootstrap: {
          sha256: node.sha256,
          bytes: node.bytes,
          manifestSha256: node.manifestSha256,
          buildId: node.buildId,
          openclawVersion: node.openclawVersion,
          enabledPluginIds: node.enabledPluginIds,
        },
        workerBundle: {
          sha256: worker.sha256,
          bytes: worker.bytes,
          packageRelativePath: worker.packageRelativePath,
        },
      });
      return {
        installationVerification,
        nodeBootstrap: {
          sha256: node.sha256,
          bytes: node.bytes,
          openclawVersion: node.openclawVersion,
          buildId: node.buildId,
          manifestSha256: node.manifestSha256,
          enabledPluginIds: node.enabledPluginIds,
        },
        workerBundle: {
          sha256: worker.sha256,
          bytes: worker.bytes,
          packageRelativePath: worker.packageRelativePath,
          bundleHash: worker.bundleHash,
          ...(worker.protocolFeatures ? { protocolFeatures: worker.protocolFeatures } : {}),
        },
      };
    },
    async run(scrubScript?: string) {
      params.context.signal?.throwIfAborted();
      runtime.signal?.throwIfAborted();
      params.assertCurrent();
      try {
        const output = await runProvisionSetup({
          ...params.context,
          phase: "node runtime preparation",
          // Node clears its own environment; scrub must also inherit no shell credentials.
          setup: scrubScript
            ? `${setup.command}\nunset ${Object.keys(setup.forwardedEnv).join(" ")}\n${scrubScript}`
            : setup.command,
          forwardedEnv: setup.forwardedEnv,
          timeoutMs: timeoutMs + (scrubScript ? WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS : 0),
          signal:
            runtime.signal && params.preparationSignal
              ? AbortSignal.any([params.preparationSignal, runtime.signal])
              : (params.preparationSignal ?? runtime.signal),
        });
        params.assertCurrent();
        installationOutput = output;
      } catch (error) {
        // The command owner stops on failure; callers must not stop the lease twice.
        params.onSetupFailure();
        throw error;
      }
    },
  };
}

/** Core owns Git contents; this adapter owns only the existing lease's transport. */
export async function prepareCrabboxProjectFiles(
  params: LeaseCommandContext & {
    project: ProjectPreparation;
    timeoutMs: () => number;
    signal?: AbortSignal;
    inspectPrepared?: true;
    recordRecipePreparation?: (metadata: RecipePreparation) => Promise<void>;
    setupSecrets?: Readonly<Record<string, SecretRef>>;
    setupInitializer?: Parameters<ProjectPreparation["prepare"]>[0]["setupInitializer"];
    assertCurrent?: () => void;
  },
) {
  const run = async (
    args: string[],
    signal: AbortSignal,
    createScript?: (timeoutMs: number, setupEnv?: Record<string, string>) => string,
  ) => {
    params.project.assertCurrent();
    const timeoutMs = params.timeoutMs();
    const assertCurrent = () => {
      params.signal?.throwIfAborted();
      params.project.assertCurrent();
      params.assertCurrent?.();
    };
    const commandSignal = params.signal ? AbortSignal.any([signal, params.signal]) : signal;
    const result =
      createScript && Object.keys(params.setupSecrets ?? {}).length
        ? await runCrabboxSetupEgress({
            ...params,
            secrets: params.setupSecrets ?? {},
            createScript: (env) => createScript(timeoutMs, env),
            signal: commandSignal,
            timeoutMs,
            assertCurrent,
          })
        : await runCrabboxCommand({
            action: "project preparation",
            args,
            binary: params.binary,
            providerEnv: params.providerEnv,
            signal: commandSignal,
            input: createScript?.(timeoutMs),
            timeoutMs,
          });
    params.project.assertCurrent();
    return crabboxCommandOutput("project preparation", result);
  };
  if (params.inspectPrepared) {
    if (!params.project.inspectPreparedWorkspace) {
      throw new Error("Enrolled project cannot verify its completed workspace");
    }
    await params.project.inspectPreparedWorkspace({
      runScript: (input, signal) => run(leaseRunArgs(params), signal, () => input),
    });
    return undefined;
  }
  return await params.project.prepare({
    setupInitializer: params.setupInitializer,
    ...(params.recordRecipePreparation
      ? { recordRecipePreparation: params.recordRecipePreparation }
      : {}),
    runScript: (input, signal) => run(leaseRunArgs(params), signal, () => input),
    runScriptWithBudget: (createScript, signal) => run(leaseRunArgs(params), signal, createScript),
    upload: async (localPath, remotePath, signal) => {
      await run(
        [
          "cp",
          "--provider",
          params.provider,
          "--id",
          params.id,
          localPath,
          `SANDBOX:${remotePath}`,
        ],
        signal,
      );
    },
  });
}

/** The host owns source/completion verification; this adapter supplies only the existing lease transport. */
export async function prepareCrabboxSnapshotVerifierInput(
  params: LeaseCommandContext & {
    project?: ProjectPreparation;
    signal?: AbortSignal;
    assertCurrent: () => void;
    currentRuntime: () => CrabboxSnapshotVerifierInput["currentRuntime"];
  },
): Promise<CrabboxSnapshotVerifierInput> {
  params.assertCurrent();
  if (!params.project?.inspectPreparedWorkspace) {
    throw new Error("Snapshot capture has no canonical project inspection owner");
  }
  const currentRuntime = params.currentRuntime();
  const inspected = await params.project.inspectPreparedWorkspace({
    snapshot: true,
    ...(currentRuntime.workerBundle.protocolFeatures
      ? {
          snapshotWorkerBundle: {
            bundleHash: currentRuntime.workerBundle.bundleHash,
            openclawVersion: currentRuntime.nodeBootstrap.openclawVersion,
            protocolFeatures: currentRuntime.workerBundle.protocolFeatures,
          },
        }
      : {}),
    runScript: async (input, signal) => {
      params.assertCurrent();
      const result = await runCrabboxCommand({
        ...params,
        action: "snapshot project inspection",
        args: leaseRunArgs(params),
        input,
        signal: params.signal ? AbortSignal.any([signal, params.signal]) : signal,
        timeoutMs: WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS,
      });
      params.assertCurrent();
      // Inspection errors can contain Git paths. Capture exposes closed phase diagnostics only.
      if (
        result.termination !== "exit" ||
        result.code !== 0 ||
        result.stdoutTruncatedBytes ||
        result.outputLimitExceeded
      ) {
        throw new Error("Snapshot project inspection failed or was truncated");
      }
      return result.stdout;
    },
  });
  params.assertCurrent();
  if (!inspected) {
    throw new Error("Snapshot capture has no verified project root set");
  }
  return {
    schema: "openclaw.snapshot-verifier-input.v1",
    preparedProject: inspected,
    currentRuntime,
  };
}
