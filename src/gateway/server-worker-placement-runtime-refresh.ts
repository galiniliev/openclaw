import { compareOpenClawReleaseVersions } from "../infra/npm-registry-spec.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import { WORKER_ADMISSION_DEADLINE_MS } from "../worker/worker-connection-contract.js";
import type { waitForNodeWorkerSupervisor } from "./node-registry-private.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./worker-environments/device-provider-identity.js";
import type { WorkerInitialNodeReadiness } from "./worker-environments/placement-dispatch-startup.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";
import type { WorkerInitialDispatchBinding } from "./worker-environments/placement-worker-gate.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";

type NodeAvailabilityWait = (
  nodeId: string,
  options: Parameters<typeof waitForNodeWorkerSupervisor>[2],
) => Promise<void>;

type NodeOwnerPlacement = Pick<
  Extract<WorkerSessionPlacementRecord, { state: "active" | "draining" }>,
  "state" | "sessionId" | "environmentId" | "activeOwnerEpoch"
>;

/** Bind pre-handoff admission to this Gateway's node registry and lifetime. */
export function createWorkerRuntimeRefreshWaiter(params: {
  environments: WorkerEnvironmentService;
  isStopping: () => boolean;
}) {
  let waitForNode: NodeAvailabilityWait | undefined;
  let isNodeConnected: ((nodeId: string) => Promise<boolean>) | undefined;
  let nodeVersion: ((nodeId: string) => string | undefined) | undefined;
  let nodeBuildId: ((nodeId: string) => string | undefined) | undefined;
  const waitForOwner = async ({
    owner,
    initialDispatch,
    placementState,
    signal,
    assertCurrent,
  }: {
    owner: { sessionId: string; environmentId: string; ownerEpoch: number };
    initialDispatch?: WorkerInitialDispatchBinding;
    placementState?: NodeOwnerPlacement["state"];
    signal: AbortSignal;
    assertCurrent: () => void;
  }) => {
    const environment = params.environments.get(owner.environmentId);
    if (!environment?.nodeDeviceId) {
      if (initialDispatch) {
        throw new Error("Initial retained node readiness lost its original Node");
      }
      return;
    }
    if (!waitForNode) {
      throw new Error("Worker node availability runtime is unavailable");
    }
    const waitingSignal = AbortSignal.any([signal, getGatewayRestartDrainSignal()]);
    const assertWaitingCurrent = () => {
      waitingSignal.throwIfAborted();
      assertCurrent();
      const current = params.environments.get(owner.environmentId);
      if (
        params.isStopping() ||
        params.environments.isStopping() ||
        current?.state !== "attached" ||
        current.ownerEpoch !== owner.ownerEpoch ||
        current.nodeDeviceId !== environment.nodeDeviceId ||
        current.leaseId !== environment.leaseId ||
        current.destroyRequestedAtMs !== null ||
        current.attachedSessionIds.length !== 1 ||
        current.attachedSessionIds[0] !== owner.sessionId ||
        (initialDispatch &&
          (current.leaseId !== initialDispatch.leaseId ||
            current.nodeDeviceId !== initialDispatch.nodeDeviceId))
      ) {
        throw new Error("Worker admission lost its environment while waiting for reconnect");
      }
    };
    assertWaitingCurrent();
    if (initialDispatch) {
      if (!environment.retention || !environment.leaseId) {
        throw new Error("Initial retained node readiness lost its original lease");
      }
      await params.environments.inspectTurnLease({
        environmentId: owner.environmentId,
        ownerEpoch: owner.ownerEpoch,
        leaseId: environment.leaseId,
        signal: waitingSignal,
        assertCurrent: assertWaitingCurrent,
      });
      assertWaitingCurrent();
    }
    const version = nodeVersion?.(environment.nodeDeviceId);
    const currentBuildId = resolveRuntimeServiceBuildId();
    const staleBuild =
      placementState !== "draining" &&
      currentBuildId &&
      version &&
      compareOpenClawReleaseVersions(version, VERSION) === 0 &&
      nodeBuildId?.(environment.nodeDeviceId) !== currentBuildId;
    const obsolete =
      environment.providerId !== DEVICE_WORKER_PROVIDER_ID &&
      environment.sharedHost === false &&
      version &&
      ((compareOpenClawReleaseVersions(version, VERSION) ?? 0) < 0 || staleBuild);
    let retainedCleanupOnly = false;
    if (isNodeConnected && (!(await isNodeConnected(environment.nodeDeviceId)) || obsolete)) {
      assertWaitingCurrent();
      if (!environment.leaseId) {
        throw new Error("Worker node recovery has no retained lease");
      }
      const resumed = await params.environments.resumeNode({
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        leaseId: environment.leaseId,
        signal: waitingSignal,
        assertCurrent: assertWaitingCurrent,
        nodeBuildId: nodeBuildId?.(environment.nodeDeviceId),
        placementState,
        ...(initialDispatch ? { initialDispatch } : {}),
      });
      retainedCleanupOnly = Boolean(resumed && resumed.retainedCleanupOnly);
      assertWaitingCurrent();
    }
    await waitForNode(environment.nodeDeviceId, {
      signal: waitingSignal,
      assertCurrent: assertWaitingCurrent,
      ...(obsolete && !retainedCleanupOnly
        ? {
            isReady: () => {
              const current = nodeVersion?.(environment.nodeDeviceId!);
              return (
                current !== undefined &&
                (compareOpenClawReleaseVersions(current, VERSION) ?? -1) >= 0 &&
                (!staleBuild || nodeBuildId?.(environment.nodeDeviceId!) === currentBuildId)
              );
            },
          }
        : {}),
    });
    assertWaitingCurrent();
    if (initialDispatch) {
      // Host readiness precedes worker installation; startup consumes only the published receipt.
      await params.environments.refreshInitialRuntime({
        environmentId: owner.environmentId,
        ownerEpoch: owner.ownerEpoch,
        initialDispatch,
        signal: waitingSignal,
        assertCurrent: assertWaitingCurrent,
      });
      assertWaitingCurrent();
    }
  };
  const wait = (input: {
    placement: NodeOwnerPlacement;
    signal: AbortSignal;
    assertCurrent: () => void;
  }) =>
    waitForOwner({
      owner: {
        sessionId: input.placement.sessionId,
        environmentId: input.placement.environmentId,
        ownerEpoch: input.placement.activeOwnerEpoch,
      },
      signal: input.signal,
      placementState: input.placement.state,
      assertCurrent: input.assertCurrent,
    });
  const waitForInitialNode: WorkerInitialNodeReadiness = async (input) => {
    if (!input.placement.environmentId) {
      throw new Error("Initial retained node has no dispatch environment");
    }
    // Initial retries use the same finite admission window as ordinary turns.
    const deadline = AbortSignal.timeout(WORKER_ADMISSION_DEADLINE_MS);
    await waitForOwner({
      owner: {
        sessionId: input.placement.sessionId,
        environmentId: input.placement.environmentId,
        ownerEpoch: input.ownerEpoch,
      },
      initialDispatch: {
        generation: input.placement.generation,
        agentId: input.placement.agentId,
        sessionKey: input.placement.sessionKey,
        leaseId: input.leaseId,
        nodeDeviceId: input.nodeDeviceId,
      },
      signal: input.signal ? AbortSignal.any([input.signal, deadline]) : deadline,
      assertCurrent: input.assertCurrent,
    });
  };
  return {
    wait,
    waitForInitialNode,
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
    bind: (
      bound: NodeAvailabilityWait,
      connected: (nodeId: string) => Promise<boolean>,
      version?: (nodeId: string) => string | undefined,
      buildId?: (nodeId: string) => string | undefined,
    ) => {
      waitForNode = bound;
      isNodeConnected = connected;
      nodeVersion = version;
      nodeBuildId = buildId;
    },
  };
}
