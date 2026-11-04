import { composePlacementAuthorization } from "./placement-authorization.js";
import type { WorkerPlacementReclaimBarriers } from "./placement-reclaim-contract.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type {
  WorkerPlacementReclaimRequest,
  WorkerPlacementAuthorization,
  WorkerPlacementDispatchContract,
  WorkerEnvironmentServiceContract,
} from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";

/** Same serialized session preparation as Stop, retaining its active attachment and disk. */
export function createWorkerPlacementDiskPause({
  placements,
  environments,
  runReclaimPreparation,
}: {
  placements: Pick<
    WorkerSessionPlacementStore,
    "get" | "getAsync" | "listPendingWorkspaceResultsAsync"
  >;
  environments: Partial<Pick<WorkerEnvironmentService, "pauseRetained">>;
  runReclaimPreparation: WorkerPlacementReclaimBarriers["runReclaimPreparation"];
}) {
  return (request: WorkerPlacementReclaimRequest, authorize?: WorkerPlacementAuthorization) =>
    runReclaimPreparation({
      ...request,
      authorize,
      run: async (assertSource) => {
        const placement = await placements.getAsync(request.sessionId);
        if (placement?.state !== "active" || !environments.pauseRetained) {
          throw new Error("Retained session is not active");
        }
        const assertCurrent = () => {
          assertSource?.();
          const live = placements.get(request.sessionId);
          if (
            live?.state !== "active" ||
            live.generation !== placement.generation ||
            live.turnClaim ||
            live.environmentId !== placement.environmentId
          ) {
            throw new Error("Retained pause is waiting for current work to settle");
          }
        };
        assertCurrent();
        const pending = await placements.listPendingWorkspaceResultsAsync(request.sessionId);
        assertCurrent();
        if (pending.length) {
          throw new Error("Retained pause is waiting for workspace recovery");
        }
        await environments.pauseRetained({
          environmentId: placement.environmentId,
          ownerEpoch: placement.activeOwnerEpoch,
          assertCurrent,
        });
        const current = placements.get(request.sessionId);
        if (current?.state !== "active") {
          throw new Error("Retained placement changed during suspension");
        }
        return current;
      },
    });
}

/** Manual Stop differs from the retirement owner's destructive reclaim. */
export async function stopWorkerSessionPlacement(
  dispatch: WorkerPlacementDispatchContract,
  environments: Pick<WorkerEnvironmentServiceContract, "get"> | undefined,
  placement: WorkerSessionPlacementRecord | undefined,
  request: WorkerPlacementReclaimRequest,
  authorize?: WorkerPlacementAuthorization,
): Promise<WorkerSessionPlacementRecord> {
  const environment = placement?.environmentId
    ? environments?.get(placement.environmentId)
    : undefined;
  if (!environment?.retention) {
    if (!dispatch.reclaim) {
      throw new Error("Worker reclaim is unavailable");
    }
    return dispatch.reclaim(request, authorize);
  }
  // Retention intent exists before allocation. A failed initial provision has no
  // admitted disk to suspend; the failed-reclaim owner must reconcile its allocation
  // and teardown before clearing placement. A null lease alone proves nothing.
  if (
    !request.recoverToGateway &&
    placement?.state === "failed" &&
    placement.activeOwnerEpoch === null &&
    placement.workspaceBaseManifestRef === null &&
    placement.remoteWorkspaceDir === null
  ) {
    const assertUnadmittedRetention = () => {
      const current = environments?.get(environment.environmentId);
      const retention = current?.retention;
      if (
        !current ||
        !retention ||
        retention.ownerBinding !== environment.retention?.ownerBinding ||
        retention.owner.sessionId !== request.sessionId ||
        retention.owner.sessionKey !== request.sessionKey ||
        retention.owner.agentId !== request.agentId ||
        retention.receipt !== null ||
        current.lastActivatedAtMs !== null ||
        current.attachedSessionIds.length !== 0
      ) {
        throw new Error(
          "Retained session disk recovery must keep its existing worker; replacement is refused",
        );
      }
    };
    assertUnadmittedRetention();
    if (!dispatch.reclaim) {
      throw new Error("Worker reclaim is unavailable");
    }
    return dispatch.reclaim(
      request,
      composePlacementAuthorization(authorize, assertUnadmittedRetention),
    );
  }
  if (request.recoverToGateway || placement?.state !== "active") {
    throw new Error(
      "Retained session disk recovery must keep its existing worker; replacement is refused",
    );
  }
  if (!dispatch.pause) {
    throw new Error("Retained worker suspension is unavailable");
  }
  return dispatch.pause(request, authorize);
}

export async function finishRetainedWorkerCleanup(
  environments: Pick<WorkerEnvironmentService, "get" | "destroy">,
  environmentId: string | null,
): Promise<void> {
  const environment = environmentId ? environments.get(environmentId) : undefined;
  if (!environment?.retention || environment.state === "destroyed") {
    return;
  }
  await environments.destroy(environment.environmentId);
  const settled = environments.get(environment.environmentId);
  if (
    settled?.state !== "destroyed" &&
    !(settled?.state === "failed" && settled.leaseId === null)
  ) {
    throw new Error("Retained disk cleanup is still pending");
  }
}
