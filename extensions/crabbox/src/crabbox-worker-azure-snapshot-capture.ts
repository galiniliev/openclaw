import { performance } from "node:perf_hooks";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { sleepWithAbort } from "openclaw/plugin-sdk/retry-runtime";
import { reportCrabboxSnapshotPhase } from "./crabbox-provision-timing.js";
import {
  readCrabboxSnapshotVerifier,
  type AzureSandboxImage,
  type AzureSandboxCaptureAdmission,
} from "./crabbox-worker-azure-snapshot-binding.js";
import {
  runCrabboxAzureSnapshotEffect,
  type AzureSandboxSnapshotContext,
} from "./crabbox-worker-azure-snapshot.js";
import {
  leaseRunArgs,
  runCrabboxCommand,
  type LeaseCommandContext,
} from "./crabbox-worker-command.js";
import type { ParsedInspect } from "./crabbox-worker-inspect.js";
import { createCrabboxRuntimeCacheVerification } from "./crabbox-worker-node-enrollment.js";
import type { parseCrabboxProfile } from "./crabbox-worker-profile.js";
import { resolveCrabboxProfileCommandEnv } from "./crabbox-worker-profile.js";
import { readCrabboxRuntimeInstallation } from "./crabbox-worker-runtime-verification.js";
import { wrapCrabboxNodeScript } from "./crabbox-worker-script.js";
import {
  createCrabboxSnapshotVerifierScript,
  readCrabboxSnapshotVerifierResult,
  type CrabboxSnapshotVerifierInput,
} from "./crabbox-worker-snapshot-verifier.js";
import {
  WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS,
  WARM_IMAGE_NATIVE_WAIT_TIMEOUT_MS,
} from "./crabbox-worker-timeouts.js";

const log = createSubsystemLogger("crabbox/snapshot-verification");

type RuntimeIdentity = NonNullable<
  NonNullable<Parameters<WorkerProvider["provision"]>[2]>["nodeRuntimeIdentity"]
>;

export function restoreCrabboxAzureSnapshotContext(
  image: AzureSandboxImage,
  helperPath: string,
): AzureSandboxSnapshotContext {
  return {
    scope: image.scope,
    providerScope: image.providerScope,
    sdkPython: image.route.sdkPython,
    helperPath,
    providerEnv: resolveCrabboxProfileCommandEnv(image.route),
  };
}

/** Complete clean-source admission before the existing owner marks create uncertain. */
export async function prepareCrabboxAzureSnapshotCapture(
  context: LeaseCommandContext & {
    profile: ReturnType<typeof parseCrabboxProfile>;
    azureSnapshot: AzureSandboxSnapshotContext;
    timingIdentity: { operationId: string; environmentId?: string };
    signal?: AbortSignal;
    assertCurrent: () => void;
  },
  input: {
    inspection: ParsedInspect;
    runtimeIdentity: RuntimeIdentity;
    captureId: string;
    verifySnapshot?: () => Promise<CrabboxSnapshotVerifierInput>;
  },
): Promise<{
  admission: AzureSandboxCaptureAdmission;
  capture: () => Promise<{
    checkpointId: string;
    kind: string;
    state: "pending";
    azureSandbox: AzureSandboxImage;
  }>;
}> {
  const { profile } = context;
  const { snapshotVerifier: verifier, sdkPython, configFile, sdkIdentity } = profile;
  const sourceSandboxId = input.inspection.azureSandboxId;
  const sourceDiskId = profile.azureSandboxDiskId;
  if (!verifier || !sourceSandboxId || !sourceDiskId || !sdkPython || !configFile || !sdkIdentity) {
    throw new Error(
      "Snapshot capture requires its exact Sandbox/disk, selected SDK route and canonical verifier arguments",
    );
  }
  context.assertCurrent();
  // Preserve the known source identity before cleanup can release its allocation claim.
  const identity = {
    ...context.timingIdentity,
    leaseId: context.id,
    captureId: input.captureId,
    sourceSandboxId,
    sourceDiskId,
  };
  log.info("Snapshot verification source", identity);
  const verifierInput = await input.verifySnapshot?.();
  context.assertCurrent();
  const current = verifierInput?.currentRuntime;
  if (
    !verifierInput ||
    !current ||
    current.nodeBootstrap.sha256 !== input.runtimeIdentity.nodeBootstrapSha256 ||
    current.workerBundle.sha256 !== input.runtimeIdentity.workerBundleSha256
  ) {
    throw new Error(
      "Snapshot capture requires current owner-verified project and runtime descriptors",
    );
  }
  const expected = {
    nodeBootstrap: current.nodeBootstrap,
    workerBundle: {
      sha256: current.workerBundle.sha256,
      bytes: current.workerBundle.bytes,
      packageRelativePath: current.workerBundle.packageRelativePath,
    },
  };
  const verification = createCrabboxRuntimeCacheVerification({ ...expected, target: "linux" });
  context.signal?.throwIfAborted();
  let cacheResult;
  try {
    cacheResult = await runCrabboxCommand({
      ...context,
      action: "snapshot runtime cache verification",
      args: leaseRunArgs(context),
      input: verification.command,
      timeoutMs: WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS,
    });
  } catch {
    context.signal?.throwIfAborted();
    context.assertCurrent();
    throw new Error("Snapshot runtime cache verification transport failed");
  }
  context.signal?.throwIfAborted();
  context.assertCurrent();
  if (
    cacheResult.termination !== "exit" ||
    cacheResult.code !== 0 ||
    cacheResult.signal ||
    cacheResult.stdoutTruncatedBytes ||
    cacheResult.stderrTruncatedBytes ||
    cacheResult.outputLimitExceeded
  ) {
    throw new Error("Snapshot runtime cache verification failed or was truncated");
  }
  let installationVerification;
  try {
    installationVerification = readCrabboxRuntimeInstallation(cacheResult.stdout, expected);
  } catch {
    throw new Error("Snapshot runtime cache verification returned an invalid result");
  }
  if (installationVerification.disposition !== "existing-verified") {
    throw new Error("Snapshot runtime cache verification requires an existing-verified result");
  }
  // This measurement belongs to capture; preserve the runtime owner's original install evidence.
  const captureInput = {
    ...verifierInput,
    currentRuntime: { ...current, installationVerification },
  };
  const result = await runCrabboxCommand({
    ...context,
    action: "clean snapshot verification",
    args: leaseRunArgs(context),
    input: wrapCrabboxNodeScript(
      createCrabboxSnapshotVerifierScript(verifier, captureInput),
      "linux",
      "OPENCLAW_SNAPSHOT_VERIFIER",
      "runtime",
    ),
    timeoutMs: WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS,
  });
  context.assertCurrent();
  const transport = {
    termination: result.termination,
    status: result.code,
    signal: result.signal,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    stdoutTruncatedBytes: result.stdoutTruncatedBytes ?? 0,
    stderrTruncatedBytes: result.stderrTruncatedBytes ?? 0,
    outputLimitExceeded: result.outputLimitExceeded === true,
  };
  if (
    result.termination !== "exit" ||
    result.code !== 0 ||
    result.stdoutTruncatedBytes ||
    result.outputLimitExceeded
  ) {
    log.warn("Snapshot verification transport failed", { ...identity, ...transport });
    throw new Error(`Clean snapshot verification transport failed: ${JSON.stringify(transport)}`);
  }
  let envelope: ReturnType<typeof readCrabboxSnapshotVerifierResult>;
  try {
    envelope = readCrabboxSnapshotVerifierResult(result.stdout);
  } catch {
    log.warn("Snapshot verification result invalid", { ...identity, ...transport });
    throw new Error("Clean snapshot verification returned an invalid result envelope");
  }
  const { child } = envelope;
  if (
    child.status !== 0 ||
    child.signal !== null ||
    child.errorCode !== null ||
    envelope.receipt === undefined
  ) {
    log.warn("Snapshot verification child failed", { ...identity, ...transport, child });
    throw new Error(`Clean snapshot verifier failed: ${JSON.stringify(child)}`);
  }
  const attested = readCrabboxSnapshotVerifier(envelope.receipt, input.runtimeIdentity);
  const admission: AzureSandboxCaptureAdmission = {
    sourceSandboxId,
    operationId: input.captureId,
    providerScope: context.azureSnapshot.providerScope,
    scope: context.azureSnapshot.scope,
    sourceDiskId,
    ...attested,
    route: { sdkPython, configFile, sdkIdentity },
  };
  return {
    admission,
    capture: async () => {
      context.assertCurrent();
      const created = await runCrabboxAzureSnapshotEffect(context.azureSnapshot, {
        action: "capture",
        operationId: input.captureId,
        sourceSandboxId,
        sourceDiskId,
        timeoutMs: WARM_IMAGE_NATIVE_WAIT_TIMEOUT_MS,
        timingIdentity: context.timingIdentity,
        signal: context.signal,
        assertCurrent: context.assertCurrent,
      });
      context.assertCurrent();
      if (!created.snapshot) {
        throw new Error(
          "Snapshot capture has no definite identity; retain capture ownership for recovery",
        );
      }
      return {
        checkpointId: `chk_azure_sandbox_${created.snapshot.snapshotId}`,
        kind: "azure-sandbox-snapshot",
        state: "pending",
        azureSandbox: {
          ...admission,
          ...created.snapshot,
        },
      };
    },
  };
}

export async function observeCrabboxAzureSnapshot(
  context: AzureSandboxSnapshotContext,
  image: AzureSandboxImage,
  request: {
    timeoutMs: number;
    timingIdentity: { operationId: string; environmentId?: string };
    assertCurrent: () => void;
    signal?: AbortSignal;
  },
): Promise<"available" | "pending" | "missing"> {
  if (context.providerScope !== image.providerScope) {
    throw new Error("Snapshot belongs to a different provider scope");
  }
  const started = performance.now();
  let outcome: "success" | "failed" = "failed";
  try {
    const observed = await runCrabboxAzureSnapshotEffect(context, {
      ...request,
      action: "inspect",
      operationId: image.operationId,
      sourceSandboxId: image.sourceSandboxId,
      snapshotId: image.snapshotId,
    });
    if (observed.state === "unknown") {
      throw new Error("Snapshot observation is unknown; retain the current image operation");
    }
    outcome = "success";
    return observed.state;
  } finally {
    reportCrabboxSnapshotPhase(request.timingIdentity, "snapshot.capture.readiness", {
      durationMs: performance.now() - started,
      outcome,
      nonAdditive: true,
    });
  }
}

/** Deletion success requires scoped 404 readback, never just an accepted DELETE. */
export async function deleteCrabboxAzureSnapshot(
  context: AzureSandboxSnapshotContext,
  image: AzureSandboxImage,
  request: {
    remainingMs: () => number;
    assertCurrent: () => void;
    signal?: AbortSignal;
    timingIdentity: { operationId: string; environmentId?: string };
  },
): Promise<boolean> {
  const initialMs = request.remainingMs();
  if (initialMs <= 0) {
    return false;
  }
  const initial = await runCrabboxAzureSnapshotEffect(context, {
    action: "delete",
    operationId: image.operationId,
    sourceSandboxId: image.sourceSandboxId,
    snapshotId: image.snapshotId,
    timeoutMs: initialMs,
    signal: request.signal,
    assertCurrent: request.assertCurrent,
    timingIdentity: request.timingIdentity,
  });
  if (initial.state === "missing") {
    return true;
  }
  while (request.remainingMs() > 0) {
    request.assertCurrent();
    const observed = await runCrabboxAzureSnapshotEffect(context, {
      action: "inspect",
      operationId: image.operationId,
      sourceSandboxId: image.sourceSandboxId,
      snapshotId: image.snapshotId,
      timeoutMs: request.remainingMs(),
      signal: request.signal,
      assertCurrent: request.assertCurrent,
      timingIdentity: request.timingIdentity,
    });
    if (observed.state === "missing") {
      return true;
    }
    if (observed.state === "unknown") {
      throw new Error("Snapshot deletion is unconfirmed; preserve its retirement debt");
    }
    await sleepWithAbort(Math.min(5_000, Math.max(0, request.remainingMs())), request.signal);
  }
  return false;
}
