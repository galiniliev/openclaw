import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { WorkerDispatchPlacement } from "./placement-dispatch-failure.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { PlacementRecoveryDeps } from "./placement-recovery-contract.js";
import type { WorkerSessionPlacementStore, WorkerSessionTurnClaim } from "./placement-store.js";
import { isWorkerReclaimWorkspaceResult } from "./placement-workspace-result-owner.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";
import { assertRetainedWorkspaceDisk } from "./retained-workspace.js";
import type { WorkerEnvironmentService } from "./service.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import { WorkerWorkspaceReconciliationError } from "./worker-turn-failure.js";
import { measureReconcileStep } from "./workspace-reconcile-timing.js";

const log = createSubsystemLogger("gateway/worker-workspace");

export type WorkerOwnedPendingPlacement = Extract<
  WorkerSessionPlacementRecord,
  { state: "active" | "draining" }
>;

/** Retained compute and the saved node must be available before native result cleanup. */
export async function prepareRetainedResultNode(
  deps: Pick<PlacementRecoveryDeps, "environments" | "hasCurrentRunner" | "waitForRecoveryNode">,
  placement: WorkerOwnedPendingPlacement,
  turnClaim: WorkerSessionTurnClaim,
  assertCurrent: () => void,
): Promise<boolean> {
  const environment = deps.environments.get(placement.environmentId);
  if (
    (isWorkerReclaimWorkspaceResult(turnClaim) || environment?.retention) &&
    environment?.nodeDeviceId &&
    deps.hasCurrentRunner?.(environment.nodeDeviceId) === false
  ) {
    if (!environment.retention || !deps.waitForRecoveryNode) {
      return false;
    }
    assertCurrent();
    // Reconnect only for the handed-off result, never revive its input authority.
    deps.environments.fenceWorkerTurnForRecovery(turnClaim);
    await deps.waitForRecoveryNode(placement, assertCurrent);
    assertCurrent();
  }
  return true;
}

/** A persisted disk result is distinct from every legacy mirror result, even after restart. */
export async function settleRetainedWorkspaceResult(params: {
  placements: Pick<
    WorkerSessionPlacementStore,
    | "preparedWorkspaceResult"
    | "preparedWorkspaceResultPlacement"
    | "validateWorkspaceResultClaim"
    | "acceptWorkspaceResult"
    | "closeWorkerTurnToolState"
    | "completeWorkspaceResultAndReleaseTurn"
  >;
  turnClaim: WorkerSessionTurnClaim;
  workspace: WorkerSessionWorkspace;
  environments?: Pick<WorkerEnvironmentService, "get">;
  assertCurrent: () => void;
  stop?: (assertCurrent: () => void) => Promise<void>;
  needsAcceptedWorkspacePublication?: (claim: WorkerSessionTurnClaim) => Promise<boolean>;
  publishAcceptedWorkspace?: (claim: WorkerSessionTurnClaim) => Promise<void>;
}): Promise<boolean> {
  const pending = params.placements.preparedWorkspaceResult(params.turnClaim);
  if (!pending?.diskAuthority || pending.stagedResultRef) {
    return false;
  }
  const authority = pending.diskAuthority;
  const assertCurrent = () => {
    params.assertCurrent();
    const placement = params.placements.preparedWorkspaceResultPlacement(params.turnClaim);
    if (
      placement?.state !== "active" ||
      !params.environments ||
      params.workspace.kind !== "repository" ||
      pending.repositoryWorkspaceId !== params.workspace.repository.workspaceId ||
      !params.placements.validateWorkspaceResultClaim(params.turnClaim)
    ) {
      throw new Error("Retained workspace result lost its exact repository and placement owner");
    }
    assertRetainedWorkspaceDisk(
      authority,
      params.environments.get(placement.environmentId),
      placement,
    );
  };
  try {
    assertCurrent();
    // Recovery must join exact native cleanup; an unknown process result cannot settle.
    await params.stop?.(assertCurrent);
    assertCurrent();
    const publication = await params.needsAcceptedWorkspacePublication?.(params.turnClaim);
    assertCurrent();
    if (publication) {
      return false;
    }
    await measureReconcileStep("durable-result-accept", () =>
      params.placements.acceptWorkspaceResult(params.turnClaim, assertCurrent),
    );
    await params.publishAcceptedWorkspace?.(params.turnClaim);
    assertCurrent();
    await measureReconcileStep("turn-tools-close", () =>
      params.placements.closeWorkerTurnToolState(params.turnClaim),
    );
    await measureReconcileStep("claim-release", () =>
      params.placements.completeWorkspaceResultAndReleaseTurn(params.turnClaim, assertCurrent),
    );
    try {
      // This selected branch has no routine file-transfer operation; explicit transfers are separate.
      log.info("Worker workspace result settled", {
        runId: params.turnClaim.runId,
        sessionId: params.turnClaim.sessionId,
        claimId: params.turnClaim.claimId,
        environmentId: authority.environmentId,
        mode: "retained-disk",
        routineWorkspaceTransferCount: 0,
        routineWorkspaceTransferBytes: 0,
      });
    } catch {
      /* Diagnostics cannot overturn committed settlement. */
    }
    return true;
  } catch (error) {
    throw new WorkerWorkspaceReconciliationError(
      "Retained workspace settlement is held; verify the exact disk owner and settle native process cleanup before continuing",
      { cause: error },
    );
  }
}

/** A pending result keeps its original repository even after an explicit Gateway move. */
export function createPendingRepositoryWorkspaceResolver(
  resolve: PlacementRecoveryDeps["resolveWorkspace"],
) {
  return async (
    placement: WorkerDispatchPlacement,
    pending: WorkerWorkspacePendingResult,
    preparedWorkspace?: WorkerSessionWorkspace,
  ): Promise<WorkerSessionWorkspace> => {
    const workspace = preparedWorkspace ?? (await resolve(placement));
    if (!pending.repositoryWorkspaceId) {
      return workspace;
    }
    const repository = await getSessionRepositoryWorkspaceStore().get(
      pending.repositoryWorkspaceId,
    );
    if (
      !repository ||
      repository.agentId !== placement.agentId ||
      repository.sessionKey !== placement.sessionKey ||
      (workspace.kind === "repository" &&
        workspace.repository.workspaceId !== pending.repositoryWorkspaceId)
    ) {
      throw new Error("Pending repository checkpoint lost its exact session workspace owner");
    }
    // An explicit Gateway move may already have bound a local worktree. The
    // result's recorded source still owns its immutable artifact until settlement.
    return { kind: "repository", repository };
  };
}
