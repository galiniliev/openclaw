import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import {
  isRecord,
  normalizeOptionalString as nonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  observeCrabboxAzureSnapshot,
  restoreCrabboxAzureSnapshotContext,
} from "./crabbox-worker-azure-snapshot-capture.js";
import type { AzureSandboxSnapshotContext } from "./crabbox-worker-azure-snapshot.js";
import {
  crabboxCommandError,
  crabboxCommandOutput,
  parseCrabboxJson,
  runCrabboxCommand,
  type CrabboxProviderEnvironment,
} from "./crabbox-worker-command.js";
import { WARM_IMAGE_COMMAND_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";
import {
  projectCrabboxWarmImage,
  type WarmImageRecord,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-records.js";
import {
  CrabboxWarmImageRequestError,
  type openCrabboxWarmImageStore,
} from "./crabbox-worker-warm-image-store.js";

export const CHECKPOINT_ID_PATTERN = /^chk_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export class CrabboxCheckpointCreateError extends Error {
  private readonly notSubmitted?: { provider: string; leaseId: string };
  private readonly unsupported?: { message: string };

  static wasNotSubmitted(error: unknown, context: { provider: string; id: string }): boolean {
    return (
      error instanceof CrabboxCheckpointCreateError &&
      error.notSubmitted?.provider === context.provider &&
      error.notSubmitted.leaseId === context.id
    );
  }

  static unsupportedCapture(
    error: unknown,
    context: { provider: string; id: string },
  ): { message: string } | undefined {
    return error instanceof CrabboxCheckpointCreateError && this.wasNotSubmitted(error, context)
      ? error.unsupported
      : undefined;
  }

  constructor(result: SpawnResult) {
    super(crabboxCommandError("checkpoint create", result).message);
    if (
      result.termination !== "exit" ||
      result.code === null ||
      result.code === 0 ||
      result.killed ||
      result.signal !== null ||
      (result.cleanup !== undefined && result.cleanup !== "normal") ||
      result.outputLimitExceeded ||
      result.outputErrorStream ||
      result.stdoutTruncatedBytes ||
      result.stderrTruncatedBytes ||
      result.stdout.length > 4096
    ) {
      return;
    }
    try {
      const record = parseCheckpointJson(result.stdout, "create");
      if (
        Object.keys(record).length === 6 &&
        record.schema === "crabbox.checkpoint.create.failure.v1" &&
        record.outcome === "not_submitted" &&
        record.localReservation === "removed" &&
        typeof record.provider === "string" &&
        typeof record.leaseId === "string" &&
        typeof record.checkpointId === "string" &&
        CHECKPOINT_ID_PATTERN.test(record.checkpointId)
      ) {
        this.notSubmitted = { provider: record.provider, leaseId: record.leaseId };
      } else if (
        Object.keys(record).length === 7 &&
        record.schema === "crabbox.checkpoint.create.failure.v1" &&
        record.outcome === "not_submitted" &&
        record.reason === "native_unsupported" &&
        record.localReservation === "none" &&
        typeof record.provider === "string" &&
        typeof record.leaseId === "string" &&
        typeof record.message === "string" &&
        record.message.length > 0 &&
        record.message.length <= 1024
      ) {
        this.notSubmitted = { provider: record.provider, leaseId: record.leaseId };
        this.unsupported = { message: record.message };
      }
    } catch {
      // Old, malformed, or incomplete failure output retains capture uncertainty.
    }
  }
}

function parseCheckpointJson(stdout: string, action: string): Record<string, unknown> {
  const parsed = parseCrabboxJson(stdout, `checkpoint ${action}`);
  if (!isRecord(parsed)) {
    throw new Error(`Crabbox checkpoint ${action} returned an invalid record`);
  }
  return parsed;
}

export function parseCreatedCheckpoint(
  stdout: string,
  leaseId: string,
): Pick<WarmImageRecord, "checkpointId" | "kind" | "state"> & { captureEstablished: boolean } {
  const record = parseCheckpointJson(stdout, "create");
  const checkpointId = nonEmptyString(record.id);
  const kind = nonEmptyString(record.kind);
  const nativeState = isRecord(record.native) ? nonEmptyString(record.native.state) : undefined;
  if (
    !checkpointId ||
    !CHECKPOINT_ID_PATTERN.test(checkpointId) ||
    !kind ||
    record.leaseId !== leaseId ||
    !nativeState
  ) {
    throw new Error("Crabbox checkpoint create returned an invalid native checkpoint");
  }
  return {
    checkpointId,
    kind,
    captureEstablished: record.captureEstablished === true,
    state: ["available", "ready", "succeeded", "completed"].includes(nativeState.toLowerCase())
      ? "available"
      : "pending",
  };
}

export function parseForkedCheckpoint(
  stdout: string,
  expected: { checkpointId: string; leaseId: string; provider: string; slug: string },
): void {
  const fork = parseCheckpointJson(stdout, "fork");
  if (
    fork.checkpointId !== expected.checkpointId ||
    fork.leaseId !== expected.leaseId ||
    fork.provider !== expected.provider ||
    fork.slug !== expected.slug ||
    !nonEmptyString(fork.workdir)
  ) {
    throw new Error("Crabbox checkpoint fork returned an invalid lease identity");
  }
}

export function parseCheckpointAvailability(stdout: string): "available" | "pending" | "missing" {
  const record = parseCheckpointJson(stdout, "inspect");
  if (!nonEmptyString(record.localState) || !nonEmptyString(record.nextAction)) {
    throw new Error("Crabbox checkpoint inspect returned an invalid verification record");
  }
  if (record.providerState === undefined || record.providerState === "missing") {
    return "missing";
  }
  if (typeof record.providerState !== "string") {
    throw new Error("Crabbox checkpoint inspect returned an invalid provider state");
  }
  // Provider states are native (for example Machine0 ACTIVE); verified fork actions
  // carry readiness. Docker reports available/delete, so retain that positive state.
  return record.providerState === "available" ||
    record.nextAction === "fork_or_delete" ||
    record.nextAction === "fork_restore_or_delete"
    ? "available"
    : "pending";
}

export type CheckpointContext = {
  binary: string;
  providerEnv?: CrabboxProviderEnvironment;
  azureSnapshot?: AzureSandboxSnapshotContext;
  timingIdentity?: { operationId: string; environmentId?: string };
  signal?: AbortSignal;
  assertCurrent?: () => void;
};
export type MaintenanceContext = Omit<CheckpointContext, "binary"> & {
  binaries: readonly string[];
};

function assertCurrent(context: CheckpointContext | MaintenanceContext) {
  context.assertCurrent?.();
  context.signal?.throwIfAborted();
}

export async function checkpointCommand(
  context: CheckpointContext,
  action: "create" | "delete" | "fork" | "inspect" | "list" | "scrub",
  args: string[],
  timeoutMs = WARM_IMAGE_COMMAND_TIMEOUT_MS,
  input?: string,
): Promise<string> {
  assertCurrent(context);
  const commandAction = action === "scrub" ? action : `checkpoint ${action}`;
  const result = await runCrabboxCommand({
    action: commandAction,
    args,
    binary: context.binary,
    providerEnv: context.providerEnv,
    timeoutMs,
    ...(context.signal ? { signal: context.signal } : {}),
    ...(input === undefined ? {} : { input }),
  });
  if (action === "create" && (result.termination !== "exit" || result.code !== 0)) {
    throw new CrabboxCheckpointCreateError(result);
  }
  return crabboxCommandOutput(commandAction, result);
}

export async function deleteCheckpoint(
  context: CheckpointContext | MaintenanceContext,
  checkpointId: string,
  remainingMs: () => number,
): Promise<boolean> {
  const binaries = "binary" in context ? [context.binary] : context.binaries;
  for (const [index, binary] of binaries.entries()) {
    assertCurrent(context);
    const timeoutMs = remainingMs();
    if (timeoutMs <= 0) {
      return false;
    }
    const stdout = await checkpointCommand(
      { ...context, binary },
      "delete",
      ["checkpoint", "delete", checkpointId],
      timeoutMs,
    );
    // Crabbox exits 0 with this line for ids outside its catalog; a record clears only
    // after a real deletion or once every configured executable reports it absent.
    if (
      index === binaries.length - 1 ||
      !stdout.split("\n").some((line) => line.trim() === `checkpoint absent id=${checkpointId}`)
    ) {
      return true;
    }
  }
  return false;
}

export function createCrabboxWarmImageCheckpointUpdates(
  openStore: () => ReturnType<typeof openCrabboxWarmImageStore>,
) {
  const checkpointEntry = async (checkpointId: string) => {
    const entry = (await openStore().entries()).find(
      ({ value }) =>
        value.image?.checkpointId === checkpointId ||
        value.previous?.checkpointId === checkpointId ||
        value.retirements?.some((debt) => debt.checkpointId === checkpointId),
    );
    if (!entry) {
      throw new CrabboxWarmImageRequestError("Unknown snapshot checkpoint.");
    }
    return entry;
  };
  const updateCheckpoint = async (
    checkpointId: string,
    change: (record: WarmProfileRecord) => WarmProfileRecord | string,
    assertOwnerCurrent?: () => void,
  ) => {
    const { key } = await checkpointEntry(checkpointId);
    let rejection: string | undefined;
    let accepted: WarmProfileRecord | undefined;
    const updated = await openStore().update(key, (record) => {
      assertOwnerCurrent?.();
      rejection = undefined;
      accepted = undefined;
      if (!record) {
        rejection = "Snapshot changed; refresh the list and retry.";
        return undefined;
      }
      const next = change(record);
      if (typeof next === "string") {
        rejection = next;
        return undefined;
      }
      accepted = next;
      return next;
    });
    if (!updated || !accepted || rejection) {
      throw new CrabboxWarmImageRequestError(rejection ?? "Snapshot changed; refresh and retry.");
    }
    return projectCrabboxWarmImage(key, accepted);
  };

  return { checkpointEntry, updateCheckpoint };
}

export async function observeCrabboxWarmImage(
  context: CheckpointContext,
  image: Pick<WarmImageRecord, "checkpointId" | "azureSandbox">,
  requireSnapshotHelper: () => string,
  timeoutMs = WARM_IMAGE_COMMAND_TIMEOUT_MS,
) {
  if (image.azureSandbox) {
    return observeCrabboxAzureSnapshot(
      context.azureSnapshot ??
        restoreCrabboxAzureSnapshotContext(image.azureSandbox, requireSnapshotHelper()),
      image.azureSandbox,
      {
        timeoutMs,
        assertCurrent: () => assertCurrent(context),
        signal: context.signal,
        timingIdentity: context.timingIdentity ?? { operationId: image.azureSandbox.operationId },
      },
    );
  }
  const args = ["checkpoint", "inspect", image.checkpointId, "--verify", "--json"];
  return parseCheckpointAvailability(
    await checkpointCommand(
      context,
      "inspect",
      args,
      Math.min(timeoutMs, WARM_IMAGE_COMMAND_TIMEOUT_MS),
    ),
  );
}
