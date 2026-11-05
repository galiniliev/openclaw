import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getRepositoryIntegration } from "../../plugins/repository-integration-runtime.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { WORKER_ADMISSION_DEADLINE_MS } from "../../worker/worker-connection-contract.js";
import { GitHubPublicationRecoveryPendingError } from "../github-publication-git-index.js";
import { assertRepositoryDispatchAdmission } from "../repository-dispatch.js";
import type { RepositoryPublicationIntegrationInput } from "../repository-publication-checkpoint.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import type { WorkerDevicePlacementRequirementResolver } from "./placement-dispatch-startup.js";
import type {
  WorkerSessionPlacementIdentity,
  WorkerSessionPlacementRecord,
} from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { matchesWorkerPlacementTarget } from "./placement-target.js";
import { readWorkerProfileSelection } from "./service-validation.js";
import type { WorkerEnvironmentService } from "./service.js";

/** Restore compute for an accepted checkpoint through ordinary placement admission, never a turn. */
async function prepareRepositoryPublicationWorker(params: {
  identity: WorkerSessionPlacementIdentity;
  input: RepositoryPublicationIntegrationInput;
  placements: Pick<WorkerSessionPlacementStore, "get" | "getAsync">;
  environments: Pick<WorkerEnvironmentService, "get">;
  ensurePlacement: ReturnType<typeof coordinateWorkerPlacementDispatch>["ensurePlacement"];
  resolveDevicePlacementRequirement: WorkerDevicePlacementRequirementResolver;
  getConfig: () => OpenClawConfig;
}): Promise<Extract<WorkerSessionPlacementRecord, { state: "active" }>> {
  const { identity, input } = params;
  input.assertCurrent();
  if (getRepositoryIntegration(params.getConfig()) && !input.readNativeCredential?.admit) {
    throw new GitHubPublicationRecoveryPendingError(
      "Repository worker recovery needs current startup admission. Retry this same publication from the original signed-in account; its accepted checkpoint is retained.",
    );
  }
  const previous = await params.placements.getAsync(identity.sessionId);
  input.assertCurrent();
  const environment = previous?.environmentId
    ? params.environments.get(previous.environmentId)
    : undefined;
  const requiredProfile = params.getConfig().cloudWorkers?.requiredProfile;
  const profileId = environment?.profileId ?? requiredProfile;
  if (!profileId) {
    throw new GitHubPublicationRecoveryPendingError(
      "The saved publication has no recorded worker destination. Choose where this session should continue, then retry the same publication request.",
    );
  }
  const executionMode = previous?.executionMode ?? "worker-turn";
  const { machineClass, os } = environment
    ? readWorkerProfileSelection(environment.profileSnapshot)
    : {};
  const devicePlacement = environment?.nodeDeviceId
    ? await params.resolveDevicePlacementRequirement({ ...identity, executionMode })
    : undefined;
  input.assertCurrent();
  const prepared = await params.ensurePlacement({
    request: {
      ...identity,
      profileId,
      executionMode,
      runSetupScript: false,
      readNativeCredential: input.readNativeCredential,
      ...(requiredProfile ? { requiredProfile } : {}),
      ...(environment
        ? {
            ...(machineClass ? { machineClass } : {}),
            ...(os ? { os } : {}),
            inheritedProfile: {
              providerId: environment.providerId,
              profileSnapshot: environment.profileSnapshot,
            },
          }
        : {}),
      ...(devicePlacement ? { devicePlacement } : {}),
      ...(environment?.providerId === DEVICE_WORKER_PROVIDER_ID && environment.nodeDeviceId
        ? { deviceId: environment.nodeDeviceId }
        : {}),
    },
    assertCurrent: input.assertCurrent,
    authorizeDispatch: input.assertCurrent,
    // The existing repository/checkpoint already owns source preparation; never create a new checkout choice.
    prepareWorkspace: async (canPrepare) => {
      input.assertCurrent();
      if (!canPrepare()) {
        throw new GitHubPublicationRecoveryPendingError(
          "Publication worker preparation is busy; retry the same request.",
        );
      }
    },
    waitForReady: true,
  });
  try {
    prepared.assertCurrent();
    input.assertCurrent();
    const active = params.placements.get(identity.sessionId);
    if (active?.state !== "active") {
      throw new GitHubPublicationRecoveryPendingError(
        "Publication worker preparation did not become ready; retry the same request.",
      );
    }
    return active;
  } finally {
    prepared.release();
  }
}

/** The normal runtime owner may refresh only an idle, exact placement; publication never fences a live turn. */
async function refreshRepositoryPublicationRuntime(params: {
  placement: Extract<WorkerSessionPlacementRecord, { state: "active" }>;
  placements: Pick<WorkerSessionPlacementStore, "get" | "prepareRuntimeRefresh">;
  environments: Pick<WorkerEnvironmentService, "get" | "inspectTurnLease">;
  assertCurrent: () => void;
  readNativeCredential?: RepositoryPublicationIntegrationInput["readNativeCredential"];
  getConfig: () => OpenClawConfig;
  waitForNode: (input: {
    placement: Extract<WorkerSessionPlacementRecord, { state: "active" }>;
    signal: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<void>;
  reconcileActive: (environmentId: string) => Promise<unknown>;
}): Promise<void> {
  const assertRequesterCurrent = () => {
    params.assertCurrent();
    assertRepositoryDispatchAdmission(params.readNativeCredential, params.getConfig());
  };
  const facts = await params.placements.prepareRuntimeRefresh(params.placement.sessionId);
  const assertCurrent = () => {
    assertRequesterCurrent();
    facts.assertCurrent();
    const current = params.placements.get(params.placement.sessionId);
    if (
      !matchesWorkerPlacementTarget(current, params.placement) ||
      current?.turnClaim ||
      facts.pendingResult ||
      facts.recoveryPending ||
      facts.move
    ) {
      throw new GitHubPublicationRecoveryPendingError(
        "Publication is waiting for current worker work and recovery to settle before the normal runtime upgrade. Retry the same request; its accepted checkpoint is retained.",
      );
    }
  };
  try {
    assertCurrent();
    await params.readNativeCredential?.admit?.();
    assertCurrent();
    const signal = AbortSignal.any([
      getGatewayRestartDrainSignal(),
      AbortSignal.timeout(WORKER_ADMISSION_DEADLINE_MS),
    ]);
    const environment = params.environments.get(params.placement.environmentId);
    if (environment?.retention) {
      if (!environment.leaseId) {
        throw new GitHubPublicationRecoveryPendingError(
          "Publication is waiting for its retained worker lease; retry the same request after worker recovery.",
        );
      }
      // Node bootstrap needs the same finite compute admission as a fresh turn.
      await params.environments.inspectTurnLease({
        environmentId: params.placement.environmentId,
        ownerEpoch: params.placement.activeOwnerEpoch,
        leaseId: environment.leaseId,
        signal,
        assertCurrent,
      });
      assertCurrent();
    }
    await params.waitForNode({
      placement: params.placement,
      signal,
      assertCurrent,
    });
    assertCurrent();
  } finally {
    facts.release();
  }
  assertRequesterCurrent();
  await params.reconcileActive(params.placement.environmentId);
  assertRequesterCurrent();
}

/** Bind publication to the existing placement and runtime owners without another lifecycle store. */
export function createRepositoryPublicationPreparation(
  dependencies: Omit<
    Parameters<typeof prepareRepositoryPublicationWorker>[0],
    "identity" | "input"
  > &
    Omit<
      Parameters<typeof refreshRepositoryPublicationRuntime>[0],
      "placement" | "assertCurrent" | "readNativeCredential"
    >,
) {
  return {
    preparePublicationWorker: (
      identity: WorkerSessionPlacementIdentity,
      input: RepositoryPublicationIntegrationInput,
    ) => prepareRepositoryPublicationWorker({ ...dependencies, identity, input }),
    refreshPublicationRuntime: (
      placement: Extract<WorkerSessionPlacementRecord, { state: "active" }>,
      assertCurrent: () => void,
      readNativeCredential?: RepositoryPublicationIntegrationInput["readNativeCredential"],
    ) =>
      refreshRepositoryPublicationRuntime({
        ...dependencies,
        placement,
        assertCurrent,
        readNativeCredential,
      }),
  };
}
