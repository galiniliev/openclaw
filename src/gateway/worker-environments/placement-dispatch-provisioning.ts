import { isDeepStrictEqual } from "node:util";
import type { RetainedWorkspaceAuthority } from "../../state/retained-workspace-authority.js";
import { supportsCurrentWorkerLaunch } from "../../worker/worker-build-identity.js";
import type { WorkerDispatchEnvironmentService } from "./placement-dispatch-failure.js";
import { retainedRepositoryDisk } from "./retained-workspace.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";

export function requireProvisionedEnvironment(
  environment: Awaited<ReturnType<WorkerEnvironmentService["createWithRequest"]>>,
  expectedEnvironmentId: string,
  executionMode: WorkerPlacementDispatchRequest["executionMode"],
  environments: Pick<WorkerDispatchEnvironmentService, "supportsProviderExecutionMode">,
  owner?: WorkerPlacementDispatchRequest,
  disk?: RetainedWorkspaceAuthority,
): { environmentId: string; ownerEpoch: number; bundleHash: string } {
  const retainedInitial =
    environment.state === "attached" &&
    environment.lastActivatedAtMs === null &&
    environment.sharedHost === false &&
    environment.attachedSessionIds.length === 1 &&
    environment.attachedSessionIds[0] === owner?.sessionId &&
    owner &&
    disk &&
    isDeepStrictEqual(retainedRepositoryDisk(environment, owner, disk.workspaceDir), disk);
  if (
    (environment.state !== "ready" && environment.state !== "idle" && !retainedInitial) ||
    environment.environmentId !== expectedEnvironmentId ||
    environment.destroyRequestedAtMs !== null ||
    !environment.bootstrapReceipt ||
    !supportsCurrentWorkerLaunch(environment.bootstrapReceipt)
  ) {
    throw new Error(
      `Worker environment is not dispatchable with the current worker launch contract: ${environment.state}`,
    );
  }
  if (
    (environment.profileSnapshot.executionMode !== undefined &&
      environment.profileSnapshot.executionMode !== executionMode) ||
    (executionMode === "worker-turn" &&
      environment.profileSnapshot.executionMode !== undefined &&
      !environment.nodeDeviceId) ||
    !environments.supportsProviderExecutionMode(environment.providerId, executionMode)
  ) {
    throw new Error("Worker environment does not support the placement's exact execution mode");
  }
  return {
    environmentId: environment.environmentId,
    ownerEpoch: environment.ownerEpoch,
    bundleHash: environment.bootstrapReceipt.bundleHash,
  };
}
