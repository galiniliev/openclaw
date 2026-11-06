import type { WorkerEnvironmentStartStatus } from "../../../packages/gateway-protocol/src/schema/environments.js";
import {
  WorkerProviderError,
  type WorkerExecutionMode,
  type WorkerLease,
  type WorkerNodeRuntimeIdentity,
  type WorkerProvider,
} from "../../plugins/types.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { MAX_NODE_BOOTSTRAP_TIMEOUT_MS } from "./bootstrap-timeouts.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { createDedicatedNodeLeaseAttestations } from "./dedicated-node-lease-attestations.js";
import {
  WorkerEnvironmentServiceError,
  workerEnvironmentServiceError as serviceError,
} from "./environment-errors.js";
import type { WorkerInitialSnapshotCustody } from "./preparation-identity.js";
import { readWorkerPreparation } from "./preparation-identity.schema.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import {
  prepareWorkerProviderProject,
  retainedWorkerProjectImage,
  type WorkerProviderRepositorySource,
} from "./provider-project-preparation.js";
import { createWorkerProvisionCancellation } from "./provider-provisioning-cancellation.js";
import { measureWorkerProvisionPhase } from "./provision-timing.js";
import { createWorkerRetainedLeaseLifecycle } from "./retained-lease-lifecycle.js";
import {
  requireProviderOperationTimeoutMs,
  requireWorkerLease,
  requireInstall,
  requireWorkerProfile,
  resolveWorkerLeaseTransportError,
} from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

/** Own the complete provider allocation -> registered node readiness handoff. */
export function createWorkerProviderProvisioning(params: {
  options: WorkerProviderLifecycleOptions & { ownerSignal: AbortSignal };
  nodeProvisioning: ReturnType<typeof createWorkerNodeProvisioning>;
  retained: ReturnType<typeof createWorkerRetainedLeaseLifecycle>;
  dedicatedLeases: ReturnType<typeof createDedicatedNodeLeaseAttestations>;
  startStatuses: Map<string, { ownerEpoch: number; status: WorkerEnvironmentStartStatus }>;
  owner: Pick<
    ReturnType<typeof createWorkerProviderOwnerLifecycle>,
    | "requireCurrentOwner"
    | "failBootstrap"
    | "finishBootstrap"
    | "finishConfirmedProvisionCleanup"
    | "preserveIndeterminateProvisionCleanup"
  >;
}) {
  const { options, nodeProvisioning, retained, dedicatedLeases, startStatuses, owner } = params;
  const { callProvider, move, saveError } = options;
  const {
    requireCurrentOwner,
    failBootstrap,
    finishBootstrap,
    finishConfirmedProvisionCleanup,
    preserveIndeterminateProvisionCleanup,
  } = owner;
  const finishProvision = async (
    initialRecord: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    workSignal: AbortSignal,
    preparedInstallation?: WorkerInstallationArtifact,
    cancellation?: ReturnType<typeof createWorkerProvisionCancellation>,
    nodeRuntimeIdentity?: WorkerNodeRuntimeIdentity,
    beforeProvision?: () => void,
    repositorySource?: WorkerProviderRepositorySource,
    recordInitialSnapshot?: (custody: WorkerInitialSnapshotCustody) => void,
  ) => {
    let record = initialRecord;
    let lease: WorkerLease;
    let attemptOpen = true;
    const closedAttempt = new Error("Worker provisioning operation is closed");
    let preparationComplete = false;
    let provisioningTransition: Promise<WorkerEnvironmentRecord> | undefined;
    let executionMode: WorkerExecutionMode | undefined;
    let enrollmentOperation: ReturnType<typeof nodeProvisioning.createEnrollmentOperation>;
    let projectOperation: Awaited<ReturnType<typeof prepareWorkerProviderProject>> | undefined;
    try {
      const profile = requireWorkerProfile(record.profileSnapshot.settings);
      const requestedExecutionMode = record.profileSnapshot.executionMode;
      if (
        requestedExecutionMode !== undefined &&
        requestedExecutionMode !== "worker-turn" &&
        requestedExecutionMode !== "remote-exec"
      ) {
        throw new WorkerProviderError("Worker environment has an invalid placement execution mode");
      }
      executionMode = requestedExecutionMode;
      if (executionMode && !provider.supportedExecutionModes?.includes(executionMode)) {
        // Current provider metadata cannot disprove allocation by an earlier attempt.
        throw new Error(
          `Worker provider ${provider.id} does not support ${executionMode} placement`,
        );
      }
      // Grants are issued after allocation. Reserve the core policy's maximum now,
      // including the connection wait that starts after the bootstrap command exits.
      const nodeBootstrapTimeoutMs = provider.requiresNodeEnrollment
        ? MAX_NODE_BOOTSTRAP_TIMEOUT_MS
        : undefined;
      const providerTimeoutMs =
        options.providerCallTimeoutMs === undefined
          ? requireProviderOperationTimeoutMs(
              "provision",
              provider.resolveProvisionTimeoutMs?.(profile, { nodeBootstrapTimeoutMs }),
            )
          : undefined;
      const preparation = readWorkerPreparation(record.profileSnapshot);
      const machineClass =
        preparation?.target.machineClass ??
        (typeof record.profileSnapshot.machineClass === "string"
          ? record.profileSnapshot.machineClass
          : undefined);
      const os =
        typeof record.profileSnapshot.os === "string" ? record.profileSnapshot.os : undefined;
      enrollmentOperation = nodeProvisioning.createEnrollmentOperation(
        record,
        provider,
        workSignal,
        preparedInstallation,
        nodeRuntimeIdentity,
        beforeProvision,
      );
      const assertCurrent = () => {
        cancellation?.assertActive();
        if (!attemptOpen || options.isStopping()) {
          throw closedAttempt;
        }
        beforeProvision?.();
        const current =
          enrollmentOperation?.current(record, requireCurrentOwner) ?? requireCurrentOwner(record);
        if (current.destroyRequestedAtMs !== null) {
          throw new Error("Worker provisioning operation is closed");
        }
        return current;
      };
      const project = readWorkerProjectSnapshot(record.profileSnapshot.project);
      const projectImage = retainedWorkerProjectImage(
        record,
        provider,
        profile,
        project,
        preparation,
        machineClass,
        os,
      );
      if (project && (!record.retention || projectImage.projectImage)) {
        if (
          !provider.supportsProjectPreparation?.(profile, machineClass, os) ||
          !options.projectNamespace
        ) {
          throw new Error("Worker provider cannot resume its prepared project contract");
        }
        projectOperation = await prepareWorkerProviderProject({
          project,
          preparation,
          record,
          namespace: options.projectNamespace,
          getConfig: options.getConfig,
          requireCurrent: assertCurrent,
          signal: workSignal,
          repositorySource,
        });
      }
      const provisionOptions = {
        environmentId: record.environmentId,
        ...(record.retention ? { retention: record.retention } : {}),
        nodeBootstrapTimeoutMs,
        profileId: record.profileId,
        assertCurrent,
        reportStartStatus: (status: WorkerEnvironmentStartStatus) => {
          const current = assertCurrent();
          startStatuses.set(current.environmentId, { ownerEpoch: current.ownerEpoch, status });
          sessionChanges.emit({ all: true, scope: "worker-environments" });
        },
        ...(machineClass ? { machineClass } : {}),
        ...(os ? { os } : {}),
        ...(executionMode ? { executionMode } : {}),
        ...(enrollmentOperation
          ? {
              beginNodeEnrollment: enrollmentOperation.begin,
              prepareNodeRuntime: enrollmentOperation.prepareRuntime,
              nodeRuntimeIdentity,
            }
          : {}),
        signal: workSignal,
        ...(projectOperation ? { project: projectOperation.project } : {}),
        ...projectImage,
      } satisfies NonNullable<Parameters<WorkerProvider["provision"]>[2]>;
      cancellation?.assertActive();
      const provision = () =>
        measureWorkerProvisionPhase(record, "provider.request", async () => {
          assertCurrent();
          const preparedProvision = await provider.prepareProvision?.(
            profile,
            record.provisionOperationId,
            provisionOptions,
          );
          const current = assertCurrent();
          if (provider.prepareProvision && typeof preparedProvision !== "function") {
            throw new Error("Worker provider preparation must return an allocation operation");
          }
          // Preparation and allocation share one timeout and settlement owner. Only a
          // fresh requested row proves there was no earlier allocation to clean up.
          record =
            current.state === "requested"
              ? await (provisioningTransition = move(
                  current,
                  "provisioning",
                  undefined,
                  assertCurrent,
                ))
              : current;
          assertCurrent();
          preparationComplete = true;
          return preparedProvision
            ? preparedProvision()
            : provider.provision(profile, record.provisionOperationId, provisionOptions);
        });
      lease = requireWorkerLease(
        await callProvider(
          record.environmentId,
          "provision",
          cancellation ? cancellation.retainProvider(provision) : provision,
          providerTimeoutMs,
        ),
      );
    } catch (error) {
      attemptOpen = false;
      // A provider timeout can precede delivery of its committed provisioning transition.
      // Join that write, without joining provider work that may still be blocked.
      if (provisioningTransition) {
        try {
          record = await provisioningTransition;
        } catch (transitionError) {
          if (transitionError !== closedAttempt) {
            throw transitionError;
          }
        }
      }
      await cancellation?.settleStopIntent();
      if (WorkerProviderError.isCleanupIndeterminate(error)) {
        return preserveIndeterminateProvisionCleanup(record, error);
      }
      // A cancelled attempt may already own a paid allocation, even when its late
      // provider error looks permanent. Keep it available for canonical teardown.
      cancellation?.assertActive();
      if (WorkerProviderError.isCleanupComplete(error)) {
        return await finishConfirmedProvisionCleanup(record, error);
      }
      options.ownerSignal.throwIfAborted();
      const detail = boundedError(error);
      const permanent =
        error instanceof WorkerProviderError ||
        (error instanceof WorkerEnvironmentServiceError && error.code === "invalid_profile");
      // A current refusal cannot disprove allocation by an earlier attempt.
      const terminalFailure =
        !record.retention?.receipt &&
        (record.state === "requested" ||
          (provisioningTransition !== undefined && preparationComplete && permanent));
      await (terminalFailure
        ? move(record, "failed", { lastError: detail })
        : saveError(record, error));
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      throw serviceError(
        terminalFailure && permanent ? "invalid_profile" : "provider_failure",
        `Worker provider ${!terminalFailure ? "operation failed" : permanent ? "rejected profile" : "preparation failed"}: ${detail}`,
      );
    } finally {
      // A replay keeps its durable owner after timeout; this invocation must still close.
      attemptOpen = false;
      if (startStatuses.delete(record.environmentId)) {
        sessionChanges.emit({ all: true, scope: "worker-environments" });
      }
      projectOperation?.close();
      enrollmentOperation?.close();
    }
    if (!lease.node) {
      record = await retained.acceptInitial(record, lease, () => {
        cancellation?.assertActive();
        beforeProvision?.();
        requireCurrentOwner(record);
      });
    }
    // A timeout can happen after allocation; retain the same operation id for safe replay.
    const patch = {
      leaseId: lease.leaseId,
      sharedHost: lease.sharedHost === true,
      desktop: lease.desktop ?? null,
      ...(lease.node
        ? { nodeDeviceId: lease.node.deviceId, sshEndpoint: null }
        : { nodeDeviceId: null, sshEndpoint: lease.ssh }),
    };
    if (cancellation?.signal.aborted) {
      await cancellation.settleStopIntent();
      await move(requireCurrentOwner(record), "draining", patch);
      cancellation.assertActive();
    }
    const leaseModeError = resolveWorkerLeaseTransportError(
      provider,
      lease.node ? "node" : "ssh",
      executionMode,
    );
    if (leaseModeError) {
      return await failBootstrap(
        record,
        lease.leaseId,
        provider,
        leaseModeError,
        patch,
        "invalid_profile",
      );
    }
    if (lease.node) {
      const ready = await nodeProvisioning.finish(
        record,
        lease,
        provider,
        workSignal,
        patch,
        enrollmentOperation?.installation ?? preparedInstallation,
        cancellation,
        projectOperation?.getPreparedWorkspace(),
        beforeProvision,
        projectOperation?.getInitialSnapshot(),
      );
      const snapshot = projectOperation?.getInitialSnapshot();
      if (ready.state === "ready" && snapshot) {
        beforeProvision?.();
        recordInitialSnapshot?.({
          environmentId: ready.environmentId,
          provisionOperationId: ready.provisionOperationId,
          nodeDeviceId: lease.node.deviceId,
          snapshot,
        });
      }
      dedicatedLeases.note(ready, lease.sharedHost === false);
      return ready;
    }
    const bootstrapping = await move(record, "bootstrapping", patch);
    let installation = preparedInstallation;
    if (!installation) {
      try {
        // A persisted provisioning row can represent an allocation whose response was lost.
        // Replay the idempotent provider operation before packaging can terminalize that lease.
        installation = await options.prepareInstallation(requireInstall(bootstrapping), workSignal);
        cancellation?.assertActive();
      } catch (error) {
        await cancellation?.settleStopIntent();
        options.ownerSignal.throwIfAborted();
        return await failBootstrap(bootstrapping, lease.leaseId, provider, error);
      }
    }
    return finishBootstrap(bootstrapping, provider, installation, cancellation);
  };

  return finishProvision;
}
