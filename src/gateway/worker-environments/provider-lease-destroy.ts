import type { WorkerProvider } from "../../plugins/types.js";
import {
  isWorkerRecoveryDisposalSettled,
  type WorkerEnvironmentRecord,
} from "./environment-record.js";
import { recordWorkerPlacementStage } from "./placement-diagnostics.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { RetainedWorkerRecoveryAcceptance } from "./recovery-hold-store.js";
import { requireProviderOperationTimeoutMs } from "./service-validation.js";
import type { WorkerEnvironmentStore } from "./store.js";

/** The existing provider effect and its held-resource receipt share exact owner custody. */
export async function destroyWorkerProviderLease(
  options: Pick<
    WorkerProviderLifecycleOptions,
    "store" | "callProvider" | "providerCallTimeoutMs"
  > & {
    record: WorkerEnvironmentRecord;
    provider: WorkerProvider;
    lease: Parameters<WorkerProvider["destroy"]>[0];
    requireCurrentOwner: (record: WorkerEnvironmentRecord) => WorkerEnvironmentRecord;
  },
): Promise<WorkerEnvironmentRecord> {
  const { record, provider, lease, requireCurrentOwner } = options;
  requireCurrentOwner(record);
  if (record.recoveryHold?.cleanup?.providerReleasedAtMs !== undefined) {
    return record;
  }
  const timeoutMs =
    options.providerCallTimeoutMs === undefined
      ? requireProviderOperationTimeoutMs(
          "destroy",
          provider.resolveDestroyTimeoutMs?.(lease.profile),
        )
      : undefined;
  await options.callProvider(
    record.environmentId,
    () => {
      // An earlier timed-out operation can keep this call queued across owner changes.
      requireCurrentOwner(record);
      return provider.destroy(lease);
    },
    timeoutMs,
  );
  requireCurrentOwner(record);
  if (!record.recoveryHold) {
    return record;
  }
  // Enrollment retirement may still fail. Persist known release so that restart does
  // not repeat a settled provider effect; the hold remains charged until finalization.
  return await options.store.requestDestroy({
    environmentId: record.environmentId,
    state: record.state,
    providerRelease: { leaseId: lease.leaseId, ownerEpoch: record.ownerEpoch },
    assertCurrent: () => {
      requireCurrentOwner(record);
    },
  });
}

/** Keep logical cutover behind confirmed physical disposal and fresh caller admission. */
export async function completeRetainedWorkerRecovery(
  store: WorkerEnvironmentStore,
  destroy: (environmentId: string) => Promise<WorkerEnvironmentRecord>,
  input: RetainedWorkerRecoveryAcceptance & { assertCurrent?: () => void },
) {
  const started = performance.now();
  const staged = await store.acceptRetainedRecovery(input);
  const facts = { environmentId: input.environmentId, generation: staged.generation };
  if (staged.state === "reclaimed") {
    recordWorkerPlacementStage(input.sessionId, "recovery_checkpoint_accepted", facts);
    return staged;
  }
  input.assertCurrent?.();
  recordWorkerPlacementStage(input.sessionId, "recovery_disposal_staged", {
    ...facts,
    certainty: "unknown",
  });
  try {
    const settled = await destroy(input.environmentId);
    if (!isWorkerRecoveryDisposalSettled(settled)) {
      throw new Error("Failed worker disposal is not yet confirmed");
    }
    recordWorkerPlacementStage(input.sessionId, "recovery_disposal_settled", {
      ...facts,
      certainty: "confirmed",
      elapsedMs: performance.now() - started,
    });
  } catch (error) {
    recordWorkerPlacementStage(input.sessionId, "recovery_disposal_pending", {
      ...facts,
      certainty: "unknown",
      elapsedMs: performance.now() - started,
    });
    throw error;
  }
  input.assertCurrent?.();
  if (input.disposalOnly) {
    return staged;
  }
  const accepted = await store.acceptRetainedRecovery(input);
  if (accepted.state !== "reclaimed") {
    throw new Error("Retained worker cutover still requires physical settlement");
  }
  recordWorkerPlacementStage(input.sessionId, "recovery_checkpoint_accepted", {
    ...facts,
    generation: accepted.generation,
    certainty: "confirmed",
  });
  return accepted;
}
