import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { reportCrabboxSnapshotPhase } from "./crabbox-provision-timing.js";
import { runCrabboxCommand, type CrabboxProviderEnvironment } from "./crabbox-worker-command.js";
import {
  resolveCrabboxProfileCommandEnv,
  type parseCrabboxProfile,
} from "./crabbox-worker-profile.js";

const SCHEMA = "openclaw.azure-sandbox-checkpoint.v1";
const SEGMENT = /^[A-Za-z0-9._()-]{1,256}$/u;

export type AzureSandboxSnapshotScope = {
  region: string;
  subscriptionId: string;
  resourceGroup: string;
  group: string;
};

export type AzureSandboxSnapshotFact = {
  snapshotId: string;
  sourceSandboxId: string;
  operationId: string;
  capturedAt: string;
};

export type AzureSandboxSnapshotContext = {
  scope: AzureSandboxSnapshotScope;
  providerScope: string;
  sdkPython: string;
  helperPath: string;
  providerEnv: CrabboxProviderEnvironment;
};

type Authority = { assertCurrent: () => void; signal?: AbortSignal };
type TimingIdentity = { operationId: string; environmentId?: string };

function segment(value: unknown): value is string {
  return typeof value === "string" && SEGMENT.test(value) && value !== "." && value !== "..";
}

/** Use complete explicit Crabbox env overrides, never private YAML or controller-only contracts. */
export async function prepareCrabboxAzureSnapshotContext(
  params: Authority & {
    binary: string;
    helperPath: string;
    profile: ReturnType<typeof parseCrabboxProfile>;
  },
): Promise<AzureSandboxSnapshotContext> {
  const { profile } = params;
  if (!profile.sdkPython || !profile.sdkIdentity || !profile.configFile) {
    throw new Error(
      "Snapshot preparation requires a qualified SDK interpreter and selected identity/config",
    );
  }
  const providerEnv = resolveCrabboxProfileCommandEnv({
    configFile: profile.configFile,
    sdkIdentity: profile.sdkIdentity,
  });
  const region = providerEnv.CRABBOX_AZURE_SANDBOX_REGION;
  const subscriptionId = providerEnv.CRABBOX_AZURE_SANDBOX_SUBSCRIPTION_ID;
  const resourceGroup = providerEnv.CRABBOX_AZURE_SANDBOX_RESOURCE_GROUP;
  const group = providerEnv.CRABBOX_AZURE_SANDBOX_GROUP;
  if (!region || !subscriptionId || !resourceGroup || !group) {
    throw new Error("Snapshot preparation requires explicit Azure Sandbox scope environment");
  }
  if (
    !segment(region) ||
    !/^[a-z0-9]+$/u.test(region) ||
    !segment(subscriptionId) ||
    !segment(resourceGroup) ||
    !segment(group)
  ) {
    throw new Error("Snapshot provider scope is invalid");
  }
  // ClaimScope in the selected Azure Sandbox provider uses these exact fields.
  // All four env inputs override file configuration; no scope flags are passed.
  const providerScope = `azure-sandbox:${region}:${subscriptionId}:${resourceGroup}:${group}`;
  params.assertCurrent();
  const configured = await runCrabboxCommand({
    binary: params.binary,
    providerEnv,
    action: "snapshot provider identity",
    args: ["config", "show", "--provider", "azure-sandbox", "--json"],
    signal: params.signal,
    timeoutMs: 30_000,
  });
  params.assertCurrent();
  // Config output is private even on failure. Expose only this closed diagnosis.
  if (
    configured.termination !== "exit" ||
    configured.code !== 0 ||
    configured.stdoutTruncatedBytes ||
    configured.outputLimitExceeded
  ) {
    throw new Error(
      "Snapshot provider identity is unavailable; check the selected Crabbox configuration",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(configured.stdout);
  } catch {
    throw new Error("Snapshot provider identity returned invalid JSON");
  }
  if (!isRecord(value) || value.provider !== "azure-sandbox") {
    throw new Error("Snapshot provider identity does not match Azure Sandbox");
  }
  params.assertCurrent();
  const runtime = await runCrabboxCommand({
    binary: profile.sdkPython,
    providerEnv,
    action: "snapshot SDK qualification",
    args: ["-I", "-B", params.helperPath, "--check-runtime"],
    signal: params.signal,
    timeoutMs: 30_000,
  });
  params.assertCurrent();
  if (
    runtime.termination !== "exit" ||
    runtime.code !== 0 ||
    runtime.stdoutTruncatedBytes ||
    runtime.outputLimitExceeded
  ) {
    throw new Error(
      "Snapshot SDK is unavailable or unqualified; stage the matched runtime before preparing a worker",
    );
  }
  let qualified: unknown;
  try {
    qualified = JSON.parse(runtime.stdout);
  } catch {
    throw new Error("Snapshot SDK did not return its runtime qualification receipt");
  }
  if (
    !isRecord(qualified) ||
    qualified.schema !== SCHEMA ||
    qualified.state !== "available" ||
    !isRecord(qualified.versions)
  ) {
    throw new Error("Snapshot SDK runtime qualification receipt is invalid");
  }
  return {
    scope: { region, subscriptionId, resourceGroup, group },
    providerScope,
    sdkPython: profile.sdkPython,
    helperPath: params.helperPath,
    providerEnv,
  };
}

function reportTimings(value: Record<string, unknown>, identity: TimingIdentity) {
  const observations = Array.isArray(value.phases) ? value.phases.slice(0, 16) : [];
  for (const phase of observations) {
    if (
      !isRecord(phase) ||
      typeof phase.phase !== "string" ||
      typeof phase.durationMs !== "number" ||
      !Number.isFinite(phase.durationMs) ||
      phase.durationMs < 0 ||
      (phase.outcome !== "success" && phase.outcome !== "failed")
    ) {
      continue;
    }
    // Only the SDK's closed phase vocabulary reaches the existing timing owner.
    switch (phase.phase) {
      case "snapshot.capture.source":
      case "snapshot.capture.request":
      case "snapshot.inspect.request":
      case "snapshot.recovery.lookup":
      case "snapshot.delete.request":
        reportCrabboxSnapshotPhase(identity, phase.phase, {
          durationMs: phase.durationMs,
          outcome: phase.outcome,
          opaque: true,
        });
    }
  }
  const total = value.timing;
  if (
    isRecord(total) &&
    typeof total.durationMs === "number" &&
    Number.isFinite(total.durationMs) &&
    total.durationMs >= 0 &&
    (total.outcome === "success" || total.outcome === "failed")
  ) {
    reportCrabboxSnapshotPhase(identity, "snapshot.client.total", {
      durationMs: total.durationMs,
      outcome: total.outcome,
      opaque: true,
      nonAdditive: true,
    });
  }
}

/** One SDK effect; canonical warm-image state owns retries and unknown outcomes. */
export async function runCrabboxAzureSnapshotEffect(
  context: AzureSandboxSnapshotContext,
  request: Authority & {
    operationId: string;
    sourceSandboxId: string;
    timeoutMs: number;
    timingIdentity: TimingIdentity;
  } & (
      | { action: "capture"; sourceDiskId: string; snapshotId?: never }
      | { action: "inspect"; snapshotId?: string; sourceDiskId?: never }
      | { action: "delete"; snapshotId: string; sourceDiskId?: never }
    ),
): Promise<{
  state: "pending" | "available" | "missing" | "unknown";
  snapshot?: AzureSandboxSnapshotFact;
}> {
  request.assertCurrent();
  const result = await runCrabboxCommand({
    binary: context.sdkPython,
    providerEnv: context.providerEnv,
    action: "snapshot SDK effect",
    args: ["-I", "-B", context.helperPath],
    input: JSON.stringify({
      schema: SCHEMA,
      action: request.action,
      scope: context.scope,
      sourceSandboxId: request.sourceSandboxId,
      operationId: request.operationId,
      ...(request.action === "capture" ? { sourceDiskId: request.sourceDiskId } : {}),
      ...(request.snapshotId ? { snapshotId: request.snapshotId } : {}),
    }),
    timeoutMs: request.timeoutMs,
    signal: request.signal,
  });
  request.assertCurrent();
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      "Snapshot SDK outcome is unknown; retain the current image operation for recovery",
    );
  }
  if (!isRecord(value) || value.schema !== SCHEMA) {
    throw new Error("Snapshot SDK returned an invalid effect receipt; retain operation ownership");
  }
  reportTimings(value, request.timingIdentity);
  if (
    result.termination !== "exit" ||
    result.code !== 0 ||
    result.stdoutTruncatedBytes ||
    result.outputLimitExceeded
  ) {
    throw new Error(
      value.error === "authorization_denied"
        ? "Snapshot access was denied for the selected provider identity"
        : "Snapshot SDK outcome is unknown; retain the current image operation for recovery",
    );
  }
  const state = value.state;
  if (state !== "pending" && state !== "available" && state !== "missing" && state !== "unknown") {
    throw new Error("Snapshot SDK returned an invalid readiness state");
  }
  if (state === "missing" || state === "unknown") {
    return { state };
  }
  const snapshot = value.snapshot;
  if (
    !isRecord(snapshot) ||
    !segment(snapshot.snapshotId) ||
    snapshot.sourceSandboxId !== request.sourceSandboxId ||
    snapshot.operationId !== request.operationId ||
    (request.snapshotId !== undefined && snapshot.snapshotId !== request.snapshotId) ||
    typeof snapshot.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(snapshot.capturedAt))
  ) {
    throw new Error("Snapshot SDK receipt differs from its exact source operation");
  }
  return {
    state,
    snapshot: {
      snapshotId: snapshot.snapshotId,
      sourceSandboxId: request.sourceSandboxId,
      operationId: request.operationId,
      capturedAt: snapshot.capturedAt,
    },
  };
}
