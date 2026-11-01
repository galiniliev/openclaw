import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import type { waitForNodeWorkerSupervisor } from "./node-registry-private.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";

type NodeAvailabilityWait = (
  nodeId: string,
  options: Parameters<typeof waitForNodeWorkerSupervisor>[2],
) => Promise<void>;

type NodeOwnerPlacement = Pick<
  Extract<WorkerSessionPlacementRecord, { state: "active" | "draining" }>,
  "sessionId" | "environmentId" | "activeOwnerEpoch"
>;

/** Bind pre-handoff admission to this Gateway's node registry and lifetime. */
export function createWorkerRuntimeRefreshWaiter(params: {
  environments: WorkerEnvironmentService;
  isStopping: () => boolean;
}) {
  let waitForNode: NodeAvailabilityWait | undefined;
  let isNodeConnected: ((nodeId: string) => Promise<boolean>) | undefined;
  const wait = async ({
    placement,
    signal,
    assertCurrent,
  }: {
    placement: NodeOwnerPlacement;
    signal: AbortSignal;
    assertCurrent: () => void;
  }) => {
    const environment = params.environments.get(placement.environmentId);
    if (!environment?.nodeDeviceId) {
      return;
    }
    if (!waitForNode) {
      throw new Error("Worker node availability runtime is unavailable");
    }
    const waitingSignal = AbortSignal.any([signal, getGatewayRestartDrainSignal()]);
    const assertWaitingCurrent = () => {
      waitingSignal.throwIfAborted();
      assertCurrent();
      const current = params.environments.get(placement.environmentId);
      if (
        params.isStopping() ||
        params.environments.isStopping() ||
        current?.state !== "attached" ||
        current.ownerEpoch !== placement.activeOwnerEpoch ||
        current.nodeDeviceId !== environment.nodeDeviceId ||
        current.leaseId !== environment.leaseId ||
        current.destroyRequestedAtMs !== null ||
        current.attachedSessionIds.length !== 1 ||
        current.attachedSessionIds[0] !== placement.sessionId
      ) {
        throw new Error("Worker admission lost its environment while waiting for reconnect");
      }
    };
    assertWaitingCurrent();
    if (isNodeConnected && !(await isNodeConnected(environment.nodeDeviceId))) {
      assertWaitingCurrent();
      if (!environment.leaseId) {
        throw new Error("Worker node recovery has no retained lease");
      }
      await params.environments.resumeNode({
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        leaseId: environment.leaseId,
        signal: waitingSignal,
        assertCurrent: assertWaitingCurrent,
      });
      assertWaitingCurrent();
    }
    await waitForNode(environment.nodeDeviceId, {
      signal: waitingSignal,
      assertCurrent: assertWaitingCurrent,
    });
    assertWaitingCurrent();
  };
  return {
    wait,
    waitForRecoveryNode: async (placement: NodeOwnerPlacement, assertCurrent: () => void) => {
      assertCurrent();
      const environment = params.environments.get(placement.environmentId);
      if (!environment?.retention || !environment.leaseId) {
        throw new Error("Retained workspace recovery lost its lease");
      }
      const signal = getGatewayRestartDrainSignal();
      // The retained lease owner restores the finite compute window before the
      // existing node helper resumes the exact installed supervisor and identity.
      await params.environments.inspectTurnLease({
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
        leaseId: environment.leaseId,
        signal,
        assertCurrent,
      });
      assertCurrent();
      await wait({ placement, signal, assertCurrent });
    },
    bind: (bound: NodeAvailabilityWait, connected: (nodeId: string) => Promise<boolean>) => {
      waitForNode = bound;
      isNodeConnected = connected;
    },
  };
}
