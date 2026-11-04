import { DEVICE_FOLDER_MANIFEST_REF } from "../../worker/device-folder.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import { hasForcedWorkerEnvironmentAbandonment } from "./environment-errors.js";
import {
  isUnavailableEnvironment,
  type WorkerDispatchPlacement,
} from "./placement-dispatch-failure.js";
import {
  forceAbandonWorkerEnvironment,
  reportWorkerAbandonmentCleanupError,
} from "./placement-force-abandon.js";
import type { WorkerPlacementMoveIntent } from "./placement-move-intent.types.js";
import type { WorkerPlacementRunnerAvailabilityReader } from "./placement-projector.js";
import {
  FORCED_WORKER_ABANDONMENT_ERROR,
  isForceAbandonedWorkerPlacement,
} from "./placement-record.js";
import type { PlacementRecoveryDeps } from "./placement-recovery-contract.js";
import {
  matchesWorkerPlacementTarget,
  type WorkerPlacementCancellationTarget,
} from "./placement-target.js";
import {
  isCurrentWorkerWorkspacePendingResultOwner,
  isWorkerReclaimWorkspaceResult,
} from "./placement-workspace-result-owner.js";
import type {
  WorkerPlacementAuthorization,
  WorkerPlacementMoveRequest,
  WorkerPlacementReclaimRequest,
} from "./service-contract.js";

export function createWorkerPlacementMoveAbandonment(
  options: Pick<
    PlacementRecoveryDeps,
    | "placements"
    | "environments"
    | "workspaceOperations"
    | "resolveWorkspace"
    | "prepareGatewayMove"
  > & { runnerAvailability: WorkerPlacementRunnerAvailabilityReader },
) {
  const { environments, placements } = options;
  const forceDestroyEnvironment = async (
    environmentId: string,
    onCleanupError?: (error: unknown) => void,
  ) =>
    await options.workspaceOperations.run(environmentId, async () => {
      const ownedPlacements = await placements.listForReconcileAsync();
      if (
        ownedPlacements.some(
          (placement) =>
            placement.environmentId === environmentId &&
            placement.workspaceBaseManifestRef === DEVICE_FOLDER_MANIFEST_REF,
        )
      ) {
        throw new Error(
          "Device folders cannot be abandoned onto the Gateway; reconnect the device and stop its session instead.",
        );
      }
      // Capture the selected owner before journal cleanup can yield to a replacement.
      const environment = environments.get(environmentId);
      const sessionId = environment?.attachedSessionIds[0];
      const abandonment =
        environment?.providerId === DEVICE_WORKER_PROVIDER_ID &&
        environment.nodeDeviceId &&
        environment.sharedHost !== false &&
        environment.attachedSessionIds.length === 1 &&
        sessionId
          ? { sessionId, ownerEpoch: environment.ownerEpoch }
          : undefined;
      try {
        return await environments.destroy(environmentId, abandonment, async () => {
          await forceAbandonWorkerEnvironment({
            placements,
            environmentId,
            resolveWorkspace: options.resolveWorkspace,
            onCleanupError,
          });
        });
      } catch (error) {
        const current = environments.get(environmentId);
        if (!current || !isUnavailableEnvironment(current)) {
          throw error;
        }
        reportWorkerAbandonmentCleanupError(onCleanupError, error);
        return current;
      }
    });

  // Delete/archive discard the private workspace; normal Stop and Move still save it.
  const retireRetainedSession = async (
    request: WorkerPlacementReclaimRequest,
    authorize?: WorkerPlacementAuthorization,
    beforeDrain?: () => void,
  ): Promise<Extract<WorkerDispatchPlacement, { state: "local" }>> => {
    const initial = await placements.getAsync(request.sessionId);
    authorize?.();
    beforeDrain?.();
    if (!initial?.environmentId || initial.activeOwnerEpoch === null) {
      throw new Error("Retained retirement lost its worker placement");
    }
    const environmentId = initial.environmentId;
    const ownerEpoch = initial.activeOwnerEpoch;
    return options.workspaceOperations.run(environmentId, async () => {
      const current = await placements.getAsync(request.sessionId);
      const environment = environments.get(environmentId);
      const retention = environment?.retention;
      const hasSettledResource = (record: typeof environment) =>
        record?.state === "destroyed" || (record?.state === "failed" && record.leaseId === null);
      // Proven provider cleanup retires the execution epoch and attachment. The
      // retained binding still owns discard, bounded to that exact terminal owner.
      let settledOwnerEpoch = hasSettledResource(environment) ? environment?.ownerEpoch : undefined;
      const assertCurrent = () => {
        authorize?.();
        const live = placements.get(request.sessionId);
        const owned = environments.get(environmentId);
        const settledOwner =
          settledOwnerEpoch !== undefined &&
          owned?.ownerEpoch === settledOwnerEpoch &&
          hasSettledResource(owned);
        if (
          !live ||
          live.sessionKey !== request.sessionKey ||
          live.agentId !== request.agentId ||
          live.environmentId !== initial.environmentId ||
          live.activeOwnerEpoch !== initial.activeOwnerEpoch ||
          !owned?.retention ||
          owned.retention.ownerBinding !== retention?.ownerBinding ||
          owned.retention.owner.sessionId !== request.sessionId ||
          owned.retention.owner.sessionKey !== request.sessionKey ||
          owned.retention.owner.agentId !== request.agentId ||
          (owned.sharedHost !== false && !settledOwner) ||
          (!hasForcedWorkerEnvironmentAbandonment(owned) &&
            !settledOwner &&
            (owned.ownerEpoch !== initial.activeOwnerEpoch ||
              owned.attachedSessionIds.length !== 1 ||
              owned.attachedSessionIds[0] !== request.sessionId))
        ) {
          throw new Error("Retained retirement worker owner changed");
        }
      };
      assertCurrent();
      if (
        !current ||
        !environment ||
        !retention ||
        !["active", "draining", "failed"].includes(current.state)
      ) {
        throw new Error("Retained retirement is waiting for placement settlement");
      }
      const pending = (await placements.listPendingWorkspaceResultsAsync(request.sessionId))[0];
      assertCurrent();
      if (
        current.turnClaim &&
        (!pending ||
          !isCurrentWorkerWorkspacePendingResultOwner(current, pending) ||
          !isWorkerReclaimWorkspaceResult(pending))
      ) {
        throw new Error("Retained retirement is waiting for active model work to settle");
      }
      const cleanupErrors: unknown[] = [];
      const destroyed = await environments.destroy(
        environmentId,
        {
          sessionId: request.sessionId,
          ownerEpoch,
          retainedOwnerBinding: retention.ownerBinding,
          authorize: assertCurrent,
        },
        async () => {
          assertCurrent();
          await forceAbandonWorkerEnvironment({
            placements,
            environmentId,
            resolveWorkspace: options.resolveWorkspace,
            onCleanupError: (error) => cleanupErrors.push(error),
          });
        },
      );
      // A live retirement can itself finish teardown and revoke its execution epoch.
      // Adopt only that acknowledged terminal result for subsequent cleanup checks.
      if (hasSettledResource(destroyed)) {
        settledOwnerEpoch = destroyed.ownerEpoch;
      }
      // Physical cleanup may commit while local rollback remains uncertain. Keep
      // the failed placement/journal, so deletion cannot cascade away its evidence.
      if (cleanupErrors.length) {
        throw new AggregateError(cleanupErrors, "Retained workspace cleanup is still pending");
      }
      const journals = await placements.listWorkspaceReconciliationOwners();
      assertCurrent();
      if (journals.some((owner) => owner.environmentId === initial.environmentId)) {
        throw new Error("Retained workspace journal cleanup is still pending");
      }
      const failed = await placements.getAsync(request.sessionId);
      const cleanup = environments.get(environmentId);
      assertCurrent();
      if (
        !failed ||
        failed.state !== "failed" ||
        !isForceAbandonedWorkerPlacement(failed) ||
        failed.turnClaim ||
        failed.environmentId !== initial.environmentId ||
        !cleanup ||
        (!hasSettledResource(cleanup) && !hasForcedWorkerEnvironmentAbandonment(cleanup))
      ) {
        throw new Error("Retained resource cleanup has no durable owner");
      }
      const local = await placements.transition(
        {
          sessionId: request.sessionId,
          from: "failed",
          to: "local",
          expectedGeneration: failed.generation,
        },
        authorize,
      );
      if (local.state !== "local") {
        throw new Error("Retained retirement did not finish its placement");
      }
      return local;
    });
  };

  const validateAbandonSource = (
    request: WorkerPlacementMoveRequest,
    current: WorkerDispatchPlacement | undefined,
  ): void => {
    if (
      (current?.state !== "active" && !isForceAbandonedWorkerPlacement(current)) ||
      current.generation !== request.source.generation ||
      current.environmentId !== request.source.environmentId ||
      current.activeOwnerEpoch !== request.source.ownerEpoch
    ) {
      throw new Error(`Cannot abandon stale worker placement for session ${request.sessionKey}`);
    }
    if (isForceAbandonedWorkerPlacement(current)) {
      return;
    }
    const runner = options.runnerAvailability.read(current);
    if (!runner) {
      throw new Error(
        "Continue on Gateway can abandon only an active paired-device placement with a known runner binding",
      );
    }
    if (runner.status === "available") {
      throw new Error(
        "Device runner is available; use Move session so OpenClaw can reconcile its workspace safely",
      );
    }
  };

  const abandonSource = async (
    request: WorkerPlacementReclaimRequest,
    intent: WorkerPlacementMoveIntent,
    authorize?: WorkerPlacementAuthorization,
    expectedSource?: WorkerPlacementCancellationTarget,
  ): Promise<Extract<WorkerDispatchPlacement, { state: "local" }>> => {
    const fenced = await options.workspaceOperations.run(intent.source.environmentId, async () => {
      const { placement: current, move } = await placements.getWithMoveAsync(request.sessionId);
      authorize?.();
      if (
        !current ||
        (expectedSource !== undefined && !matchesWorkerPlacementTarget(current, expectedSource)) ||
        (current.state !== "active" &&
          current.state !== "draining" &&
          current.state !== "reconciling" &&
          current.state !== "failed") ||
        current.sessionKey !== request.sessionKey ||
        current.agentId !== request.agentId ||
        current.environmentId !== intent.source.environmentId ||
        current.activeOwnerEpoch !== intent.source.ownerEpoch ||
        move?.operationId !== intent.operationId ||
        !move.abandonSource ||
        move.target.kind !== "gateway" ||
        move.source.generation !== intent.source.generation ||
        move.source.environmentId !== intent.source.environmentId ||
        move.source.ownerEpoch !== intent.source.ownerEpoch
      ) {
        throw new Error(`Session ${request.sessionKey} abandonment source changed before teardown`);
      }
      const failedPlacements = await forceAbandonWorkerEnvironment({
        placements,
        environmentId: intent.source.environmentId,
        resolveWorkspace: options.resolveWorkspace,
      });
      const failed = failedPlacements.get(request.sessionId);
      if (!isForceAbandonedWorkerPlacement(failed)) {
        throw new Error(`Session ${request.sessionKey} abandonment did not fence its remote owner`);
      }
      const assertCurrent = () => {
        authorize?.();
      };
      assertCurrent();
      if (intent.target.kind === "gateway") {
        if (options.prepareGatewayMove) {
          await options.prepareGatewayMove({ ...request, assertCurrent });
        } else if ((await options.resolveWorkspace(failed)).kind === "repository") {
          throw new Error("Repository workspace Gateway materialization is unavailable");
        }
        assertCurrent();
      }
      if (environments.get(intent.source.environmentId)) {
        await environments.destroy(intent.source.environmentId, {
          sessionId: intent.sessionId,
          ownerEpoch: intent.source.ownerEpoch,
          authorize: assertCurrent,
        });
      }
      // The completion transaction compares this acknowledged generation after teardown.
      return failed;
    });
    authorize?.();
    if (fenced?.state !== "failed") {
      throw new Error(`Session ${request.sessionKey} abandonment did not fence its remote owner`);
    }
    const local = await placements.completeAbandonedPlacementMoveSourceToLocal(
      {
        operationId: intent.operationId,
        sessionId: intent.sessionId,
        expectedGeneration: fenced.generation,
        expectedRecoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
      },
      { assertCurrent: authorize },
    );
    if (local.state !== "local") {
      throw new Error(`Session ${request.sessionKey} abandonment did not finish on the Gateway`);
    }
    return local;
  };

  return { abandonSource, forceDestroyEnvironment, validateAbandonSource, retireRetainedSession };
}
