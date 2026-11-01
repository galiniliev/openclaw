import type { WorkerProvider } from "../../plugins/types.js";
import type { createDedicatedNodeLeaseAttestations } from "./dedicated-node-lease-attestations.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import type { WorkerEnvironmentRecord } from "./store.js";

type Owner = ReturnType<typeof createWorkerProviderOwnerLifecycle>;

/** Shared provider-loss disposition for maintenance and preclaim admission. */
export function createWorkerLeaseInspection(
  options: Pick<WorkerProviderLifecycleOptions, "store" | "saveError" | "isStopping"> &
    Pick<
      Owner,
      "lifecycleLease" | "stopOwner" | "beginDrain" | "finishProvenDestroy" | "finishDestroy"
    > & {
      providerFor: (providerId: string) => WorkerProvider;
      inspect: ReturnType<typeof createDedicatedNodeLeaseAttestations>["inspect"];
    },
) {
  const {
    store,
    saveError,
    lifecycleLease,
    stopOwner,
    beginDrain,
    finishProvenDestroy,
    finishDestroy,
    providerFor,
  } = options;
  const ORPHANED_LEASE_ERROR = "Worker provider no longer recognizes the lease";
  const settleLostLease = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    status: "destroyed" | "unknown",
    assertCurrent?: () => void,
  ) => {
    const teardownExpected = record.destroyRequestedAtMs !== null || record.state === "destroying";
    if (status === "destroyed") {
      const requested =
        record.destroyRequestedAtMs === null
          ? await store.requestDestroy({
              assertCurrent,
              environmentId: record.environmentId,
              state: record.state,
              ...(!teardownExpected
                ? {
                    terminalState: "failed",
                    lastError: "Worker environment disappeared before teardown was requested",
                  }
                : {}),
            })
          : record;
      const stopped = await stopOwner(requested, "provider-destroyed");
      const draining = await beginDrain(stopped);
      await finishProvenDestroy(draining).catch(async (error: unknown) => {
        await saveError(draining, error);
      });
      return;
    }
    if (status === "unknown") {
      // Provider loss fences placement authority before remote cleanup, which may remain
      // unreachable after node revocation. Preserve its exact attachment until stop is proven.
      const requested = teardownExpected
        ? record
        : await store.requestDestroy({
            assertCurrent,
            environmentId: record.environmentId,
            state: record.state,
            terminalState: "failed",
            lastError: ORPHANED_LEASE_ERROR,
          });
      await finishDestroy(requested, provider).catch(() => undefined);
    }
  };

  return {
    settleLostLease,
    async inspectTurnLease(
      this: void,
      params: {
        environmentId: string;
        ownerEpoch: number;
        leaseId: string;
        assertCurrent: () => void;
        signal?: AbortSignal;
      },
    ) {
      const assertCurrent = () => {
        params.signal?.throwIfAborted();
        params.assertCurrent();
        if (options.isStopping()) {
          throw serviceError("invalid_state", "Worker admission is stopping");
        }
        const current = store.get(params.environmentId);
        if (
          !current ||
          current.ownerEpoch !== params.ownerEpoch ||
          current.leaseId !== params.leaseId ||
          current.state !== "attached" ||
          current.destroyRequestedAtMs !== null
        ) {
          throw serviceError("invalid_state", "Worker lease changed during turn admission");
        }
        return current;
      };
      const record = assertCurrent();
      const provider = providerFor(record.providerId);
      const inspection = await options.inspect(
        record,
        provider,
        lifecycleLease(record, params.leaseId),
      );
      assertCurrent();
      if (!inspection) {
        throw serviceError(
          "provider_failure",
          "Worker lease inspection failed before turn admission",
        );
      }
      if (inspection.status === "destroyed" || inspection.status === "unknown") {
        await settleLostLease(record, provider, inspection.status, assertCurrent);
        const settled = store.get(params.environmentId);
        if (
          !settled ||
          (settled.state !== "destroyed" &&
            !(settled.state === "failed" && settled.leaseId === null))
        ) {
          throw serviceError(
            "invalid_state",
            "Worker lease cleanup is incomplete before turn admission",
          );
        }
      }
      // Dormant paired devices still own their lease; existing node admission owns
      // reconnect waiting. Only confirmed terminal loss changes allocation ownership.
    },
  };
}
