import { RequiredWorkerProfileError } from "../../config/required-worker-profile.js";
import type { OpenClawConfig } from "../../config/types.js";
import { supportsCurrentWorkerLaunch } from "../../worker/worker-build-identity.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerPlacementReclaimRequest } from "./service-contract.js";

export type WorkerPlacementCancellationTarget = Readonly<
  Pick<WorkerSessionPlacementRecord, "state" | "generation" | "environmentId" | "activeOwnerEpoch">
>;

export function matchesWorkerPlacementTarget(
  current: WorkerPlacementCancellationTarget | undefined,
  expected: WorkerPlacementCancellationTarget | undefined,
): boolean {
  return (
    current?.state === expected?.state &&
    current?.generation === expected?.generation &&
    current?.environmentId === expected?.environmentId &&
    current?.activeOwnerEpoch === expected?.activeOwnerEpoch
  );
}

export function isExactAttachedEnvironment(
  environment: WorkerEnvironmentRecord | undefined,
  placement: Extract<WorkerSessionPlacementRecord, { state: "active" | "draining" }>,
): boolean {
  return Boolean(
    environment &&
    environment.environmentId === placement.environmentId &&
    environment.state === "attached" &&
    environment.destroyRequestedAtMs === null &&
    isWorkerEnvironmentAttachedTo(environment, placement),
  );
}

export function isWorkerEnvironmentAttachedTo<
  Environment extends Pick<WorkerEnvironmentRecord, "state" | "ownerEpoch"> & {
    attachedSessionIds: readonly string[];
  },
>(
  environment: Environment | undefined,
  placement: Pick<WorkerSessionPlacementRecord, "sessionId" | "activeOwnerEpoch">,
): environment is Environment {
  return (
    environment?.state === "attached" &&
    environment.ownerEpoch === placement.activeOwnerEpoch &&
    environment.attachedSessionIds.length === 1 &&
    environment.attachedSessionIds[0] === placement.sessionId
  );
}

export function assertWorkerSandboxEnvironment(
  environment: WorkerEnvironmentRecord | undefined,
  placement: Pick<WorkerSessionPlacementRecord, "sessionId" | "activeOwnerEpoch" | "environmentId">,
  sandbox: { backendId: string; placementNodeId?: string },
): void {
  if (
    !isWorkerEnvironmentAttachedTo(environment, placement) ||
    environment.environmentId !== placement.environmentId ||
    (sandbox.backendId === "node" && environment.nodeDeviceId !== sandbox.placementNodeId)
  ) {
    throw new Error("Remote-exec environment changed while preparing its sandbox");
  }
}

export function isCurrentActiveWorkerEnvironment(
  placement: Extract<WorkerSessionPlacementRecord, { state: "active" | "draining" }>,
  environment: WorkerEnvironmentRecord | undefined,
): boolean {
  return (
    isExactAttachedEnvironment(environment, placement) &&
    environment?.bootstrapReceipt?.bundleHash === placement.workerBundleHash &&
    // A persisted bundle hash can still match a worker using an older launch shape.
    // Recovery may reuse only the currently admitted execution-context dialect.
    supportsCurrentWorkerLaunch(environment?.bootstrapReceipt)
  );
}

/** Initial setup never owned a workspace; completed teardown may admit a fresh attempt. */
export function isCompletedInitialRetainedWorkerCleanup(
  placement: WorkerSessionPlacementRecord,
  environment: WorkerEnvironmentRecord | undefined,
): boolean {
  return Boolean(
    placement.state === "failed" &&
    placement.activeOwnerEpoch === null &&
    placement.workspaceBaseManifestRef === null &&
    placement.remoteWorkspaceDir === null &&
    !placement.turnClaim &&
    !placement.confirmedLossRecovery &&
    environment &&
    environment.environmentId === placement.environmentId &&
    environment.providerId !== DEVICE_WORKER_PROVIDER_ID &&
    environment.sharedHost !== true &&
    environment.state === "destroyed" &&
    environment.lastActivatedAtMs === null &&
    environment.attachedSessionIds.length === 0 &&
    environment.retention &&
    environment.retention.owner.sessionId === placement.sessionId &&
    environment.retention.owner.sessionKey === placement.sessionKey &&
    environment.retention.owner.agentId === placement.agentId,
  );
}

export function isFailedWorkerPlacementEnvironmentGone(params: {
  environmentService:
    | {
        get(environmentId: string): Pick<WorkerEnvironmentRecord, "state" | "leaseId"> | undefined;
      }
    | undefined;
  placement: Extract<WorkerSessionPlacementRecord, { state: "failed" }>;
}): boolean {
  if (params.placement.environmentId === null) {
    return true;
  }
  // Provisioning persists deterministic allocation intent first; only the configured service
  // can prove that the corresponding durable environment row was never created or is gone.
  if (!params.environmentService) {
    return false;
  }
  try {
    const environment = params.environmentService.get(params.placement.environmentId);
    return (
      environment === undefined ||
      environment.state === "destroyed" ||
      (environment.state === "failed" && environment.leaseId === null)
    );
  } catch {
    return false;
  }
}

/** Explicit Gateway recovery requires a failed placement and proven old cleanup. */
export function assertWorkerGatewayRecoverySource({
  request,
  source,
  config,
  environmentService,
}: {
  request: WorkerPlacementReclaimRequest;
  source: WorkerSessionPlacementRecord | undefined;
  config: OpenClawConfig;
  environmentService: Parameters<
    typeof isFailedWorkerPlacementEnvironmentGone
  >[0]["environmentService"];
}) {
  if (request.recoverToGateway && config.cloudWorkers?.requiredProfile) {
    throw new RequiredWorkerProfileError(
      "Gateway recovery is disabled by the required worker profile policy; Stop retains the workspace for remote recovery.",
    );
  }
  if (!request.recoverToGateway) {
    return;
  }
  if (
    source?.state !== "failed" ||
    source.generation !== request.recoverToGateway.expectedGeneration ||
    source.sessionKey !== request.sessionKey ||
    source.agentId !== request.agentId
  ) {
    throw new Error(`Session ${request.sessionKey} changed before Gateway recovery. Retry.`);
  }
  if (
    !isFailedWorkerPlacementEnvironmentGone({
      environmentService,
      placement: source,
    })
  ) {
    throw new Error(
      "Failed cloud worker environment cleanup is still pending; use Stop cloud worker",
    );
  }
}
