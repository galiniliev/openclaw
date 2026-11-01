import { getRuntimeConfig } from "../../config/config.js";
import { assertRequiredWorkerDispatch } from "../../config/required-worker-profile.js";
import { getRepositoryIntegration } from "../../plugins/repository-integration-runtime.js";
import { resolveNodeCommandAllowlist } from "../node-command-policy.js";
import { sessionLog } from "../session-log.js";
import { startSlowRequestDiagnostics } from "../slow-request-diagnostics.js";
import type { WorkerNodePlacementAuthority } from "./device-placement-eligibility.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import { composePlacementAuthorization } from "./placement-authorization.js";
import {
  createWorkerPlacementDiskPause,
  finishRetainedWorkerCleanup,
} from "./placement-disk-pause.js";
import {
  createPlacementFailureActions,
  type WorkerActivationBarrier,
  type WorkerActiveDispatchPlacement,
  type WorkerDispatchEnvironmentService,
  type WorkerDispatchPlacement,
} from "./placement-dispatch-failure.js";
import { createPlacementRecoveryActions } from "./placement-dispatch-recovery.js";
import {
  createWorkerPlacementDispatchStartup,
  type WorkerDevicePlacementRequirementResolver,
} from "./placement-dispatch-startup.js";
import { createWorkerPlacementMoveAbandonment } from "./placement-move-abandon.js";
import {
  createWorkerPlacementMoveService,
  type WorkerPlacementMoveBarrier,
} from "./placement-move-service.js";
import type { WorkerPlacementRunnerAvailabilityReader } from "./placement-projector.js";
import type {
  WorkerPlacementReclaimBarriers,
  WorkerPlacementPendingOperations,
  WorkerReclaimPlacement,
} from "./placement-reclaim-contract.js";
import {
  createWorkerPlacementReclaim,
  type WorkerPlacementReclaimOptions,
} from "./placement-reclaim.js";
import { reportPlacementTransition } from "./placement-record.js";
import type { PlacementRecoveryDeps } from "./placement-recovery-contract.js";
import {
  assertWorkerGatewayRecoverySource,
  isFailedWorkerPlacementEnvironmentGone,
  matchesWorkerPlacementTarget,
  type WorkerPlacementCancellationTarget,
} from "./placement-target.js";
import { prepareLostRepositoryWorkspaceSource } from "./repository-lost-worker-recovery.js";
import { prepareRepositoryRecovery } from "./repository-workspace-startup.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementAuthorization,
  WorkerPlacementMoveDestination,
  WorkerPlacementMoveRequest,
  WorkerPlacementReclaimRequest,
  WorkerPlacementReclaimSourceCheck,
} from "./service-contract.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import { usesRepositoryRefWorkerRecovery } from "./service-validation.js";
import type { WorkerEnvironmentService } from "./service.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";

type WorkerLocalDispatchBarrier = (params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  executionMode: WorkerPlacementDispatchRequest["executionMode"];
  authorize?: WorkerPlacementAuthorization;
  requiredProfile?: string;
  signal?: AbortSignal;
  startDispatch: () => Promise<WorkerDispatchPlacement>;
}) => Promise<WorkerDispatchPlacement>;

type WorkerPlacementDispatchOptions = WorkerPlacementReclaimBarriers &
  WorkerPlacementReclaimOptions &
  Pick<
    PlacementRecoveryDeps,
    | "resolveWorkspace"
    | "needsAcceptedWorkspacePublication"
    | "prepareAcceptedWorkspacePublication"
    | "publishAcceptedWorkspace"
    | "hasCurrentRunner"
    | "waitForRecoveryNode"
  > & {
    environments: WorkerDispatchEnvironmentService &
      Pick<WorkerEnvironmentService, "recordError" | "requestDestroy"> &
      Partial<Pick<WorkerEnvironmentService, "requiresNodeEnrollment" | "pauseRetained">>;
    initialPlacements: readonly WorkerDispatchPlacement[];
    isShuttingDown?: () => boolean;
    runnerAvailability: WorkerPlacementRunnerAvailabilityReader;
    runLocalBarrier: WorkerLocalDispatchBarrier;
    runActivationBarrier: WorkerActivationBarrier;
    runMoveBarrier: WorkerPlacementMoveBarrier;
    resolveMoveDestination: (
      identity: Pick<WorkerPlacementMoveRequest, "sessionId" | "sessionKey" | "agentId">,
      target: WorkerPlacementMoveRequest["target"],
    ) => Promise<WorkerPlacementMoveDestination | undefined>;
    onActivated?: (
      request: WorkerPlacementDispatchRequest,
      placement: WorkerActiveDispatchPlacement,
    ) => void;
    resolveGitAuthor?: (agentId: string) => { name?: string; email?: string } | undefined;
    resolveDevicePlacementRequirement?: WorkerDevicePlacementRequirementResolver;
    isCurrentNodePlacement?: WorkerNodePlacementAuthority;
  };

export function createWorkerPlacementDispatchService(options: WorkerPlacementDispatchOptions) {
  const { environments, placements } = options;
  const failure = createPlacementFailureActions({ environments, placements });

  const startup = createWorkerPlacementDispatchStartup(options);

  // Background recovery observes previously requested cleanup; explicit Stop and
  // Move retain their retry contract. Pending-result recovery must inherit this too.
  const recoveryEnvironments = { ...environments, destroy: environments.requestDestroy };
  const recovery = createPlacementRecoveryActions(
    {
      ...options,
      environments: recoveryEnvironments,
      failure: createPlacementFailureActions({ environments: recoveryEnvironments, placements }),
      recoverPlacementMoves: (projection, environmentId) =>
        moveService.recoverSession(projection, environmentId),
    },
    options.initialPlacements,
  );

  const dispatch = async (
    request: WorkerPlacementDispatchRequest,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
    authorize?: WorkerPlacementAuthorization,
    signal?: AbortSignal,
    awaitRequestedHandoff?: (signal?: AbortSignal) => Promise<void>,
  ): Promise<WorkerActiveDispatchPlacement> => {
    using diagnostics = startSlowRequestDiagnostics<string>(
      sessionLog,
      "slow placement dispatch",
      "sessions.dispatch",
      "admission",
    );
    let dispatchActive = true;
    const assertCurrent = composePlacementAuthorization(authorize, () => {
      if (!dispatchActive) {
        throw new Error("Repository dispatch was released");
      }
      signal?.throwIfAborted();
      assertRequiredWorkerDispatch(getRuntimeConfig(), request);
    });
    assertCurrent();
    let placement: WorkerDispatchPlacement | undefined;
    const credentialCleanups = new Set<() => Promise<void>>();
    const retainCredentialCleanup = (revoke: () => Promise<void>) => {
      credentialCleanups.add(revoke);
    };
    // Source owners compose dispatch liveness with the original reader's admission and policy guard.
    const readNativeCredential = request.readNativeCredential;
    try {
      signal?.throwIfAborted();
      placement = await options.runLocalBarrier({
        sessionId: request.sessionId,
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        executionMode: request.executionMode,
        authorize: assertCurrent,
        requiredProfile: request.requiredProfile,
        signal,
        startDispatch: async () => {
          let assertDispatchCurrent = assertCurrent;
          const previous =
            request.expectedPlacement?.state === "failed"
              ? await placements.getAsync(request.sessionId)
              : undefined;
          assertCurrent();
          const lostEnvironment =
            previous?.state === "failed" && previous.environmentId
              ? environments.get(previous.environmentId)
              : undefined;
          if (
            previous?.state === "failed" &&
            request.expectedPlacement?.state === "failed" &&
            matchesWorkerPlacementTarget(previous, request.expectedPlacement) &&
            previous.activeOwnerEpoch !== null &&
            !previous.turnClaim &&
            lostEnvironment &&
            lostEnvironment.providerId !== DEVICE_WORKER_PROVIDER_ID &&
            (lostEnvironment.retention ||
              (lostEnvironment.sharedHost === false &&
                usesRepositoryRefWorkerRecovery(getRuntimeConfig(), lostEnvironment))) &&
            isFailedWorkerPlacementEnvironmentGone({
              placement: previous,
              environmentService: environments,
            })
          ) {
            const assertLostOwner = () => {
              assertCurrent();
              const live = environments.get(lostEnvironment.environmentId);
              const owner = placements.get(request.sessionId);
              if (
                !matchesWorkerPlacementTarget(owner, previous) ||
                owner?.agentId !== request.agentId ||
                owner.sessionKey !== request.sessionKey ||
                owner.turnClaim ||
                live?.ownerEpoch !== lostEnvironment.ownerEpoch ||
                (live.sharedHost !== false && !(live.retention && live.sharedHost === null)) ||
                !(live.retention || usesRepositoryRefWorkerRecovery(getRuntimeConfig(), live)) ||
                (lostEnvironment.retention &&
                  (!live.retention ||
                    live.retention.ownerBinding !== lostEnvironment.retention.ownerBinding ||
                    live.retention.owner.sessionId !== request.sessionId ||
                    live.retention.owner.sessionKey !== request.sessionKey ||
                    live.retention.owner.agentId !== request.agentId)) ||
                !isFailedWorkerPlacementEnvironmentGone({
                  placement: previous,
                  environmentService: environments,
                })
              ) {
                throw new Error("Lost worker repository recovery changed before replacement");
              }
            };
            assertDispatchCurrent = assertLostOwner;
            const workspace = await options.resolveWorkspace(request);
            assertLostOwner();
            if (workspace.kind === "repository") {
              await prepareLostRepositoryWorkspaceSource({
                repository: workspace.repository,
                request: { ...request, readNativeCredential },
                retained: Boolean(lostEnvironment.retention),
                environmentId: lostEnvironment.environmentId,
                ownerEpoch: previous.activeOwnerEpoch,
                placements,
                assertCurrent: assertLostOwner,
                signal,
                retainCredentialCleanup,
              });
            }
          }
          placement = await placements.startDispatch(
            {
              sessionId: request.sessionId,
              sessionKey: request.sessionKey,
              agentId: request.agentId,
              executionMode: request.executionMode,
              ...(request.expectedPlacement
                ? { expectedPlacement: request.expectedPlacement }
                : {}),
            },
            { assertCurrent: assertDispatchCurrent },
          );
          reportPlacementTransition(onTransition, placement);
          return placement;
        },
      });
      await awaitRequestedHandoff?.(signal);
      // The requested transition can acknowledge a detached caller while setup continues.
      // Revalidate that retained caller before any node or provider-side preparation.
      assertCurrent();
      if (
        !request.deviceId &&
        request.devicePlacement?.requiredNodeCommands.length &&
        environments.requiresNodeEnrollment?.(
          request.profileId,
          request.inheritedProfile?.providerId,
        )
      ) {
        const allowlist = resolveNodeCommandAllowlist(getRuntimeConfig());
        const deniedCommand = request.devicePlacement.requiredNodeCommands.find(
          (command) => !allowlist.has(command),
        );
        if (deniedCommand) {
          throw new Error(
            `cloud worker node command ${deniedCommand} is not enabled; add it to gateway.nodes.commands.allow and approve the command on the node`,
          );
        }
      }
      diagnostics?.mark("workspacePreparation");
      let workspace = await options.resolveWorkspace(request);
      if (
        workspace.kind === "device-folder" &&
        (request.deviceId !== workspace.deviceId || request.executionMode !== "worker-turn")
      ) {
        throw new Error(
          "Device folders require an explicit dispatch to their original paired device using the OpenClaw harness.",
        );
      }
      if (
        workspace.kind === "repository" &&
        !request.deviceId &&
        environments.requiresNodeEnrollment?.(
          request.profileId,
          request.inheritedProfile?.providerId,
        ) !== true
      ) {
        throw new Error(
          "Repository cloud sessions require a managed-node cloud provider or paired node. Choose one and retry dispatch.",
        );
      }
      const repositoryIntegration =
        workspace.kind === "repository" && !request.deviceId
          ? getRepositoryIntegration()
          : undefined;
      if (repositoryIntegration && !readNativeCredential) {
        throw new Error("Repository worker startup requires current GitHub dispatch admission");
      }
      // Inherited allocation facts select the profile; private disks never consume unbound capacity.
      const retention = request.inheritedProfile
        ? request.inheritedProfile.profileSnapshot.retention
        : getRuntimeConfig().cloudWorkers?.profiles?.[request.profileId]?.retention;
      const imageReserve = repositoryIntegration?.preparedCapacity === "image" && !retention;
      const recoveryAdmission = { assertCurrent, signal, retainCredentialCleanup };
      workspace = await prepareRepositoryRecovery(workspace, request, recoveryAdmission);
      const projectPath = workspace.kind === "local" ? workspace.path : undefined;
      // Workspace preparation yields; fence the current paired node again before durable provision.
      await startup.validateDevicePlacement(request);
      assertCurrent();
      const preparedIntent = !request.deviceId
        ? await environments.prepareProjectIntent(request.profileId, {
            machineClass: request.machineClass,
            executionMode: request.executionMode,
            assertCurrent,
            inherited: request.inheritedProfile,
            signal,
            os: request.os,
            ...(imageReserve
              ? { imageReserve: true }
              : {
                  projectPath,
                  readNativeCredential,
                  retainCredentialCleanup,
                  ...(workspace.kind === "repository"
                    ? {
                        repository: {
                          agentId: request.agentId,
                          url: workspace.repository.url,
                          ref: workspace.repository.requestedRef ?? undefined,
                          baseCommit: workspace.repository.baseCommit ?? undefined,
                        },
                      }
                    : {}),
                  runSetupScript:
                    workspace.kind === "repository"
                      ? workspace.repository.runSetupScript && request.runSetupScript !== false
                      : request.runSetupScript,
                  setupAuthorized: request.runSetupScript !== undefined,
                }),
          })
        : undefined;
      assertCurrent();
      diagnostics?.mark("reserveClaim");
      const prepared = preparedIntent
        ? await startup.bindPreparedPlacement({
            request,
            placement,
            intent: preparedIntent,
            assertCurrent,
          })
        : undefined;
      assertCurrent();
      const idempotencyKey =
        request.idempotencyKey ?? `session-dispatch:${request.sessionId}:${placement.generation}`;
      // Select the reserve before assigning a cold environment identity.
      const expectedEnvironmentId =
        (workspace.kind === "repository"
          ? workspace.repository.diskAuthority?.environmentId
          : undefined) ??
        prepared?.environment.environmentId ??
        deriveEnvironmentIntent(idempotencyKey).environmentId;
      placement =
        prepared?.placement ??
        (await placements.transition(
          {
            sessionId: request.sessionId,
            from: "requested",
            to: "provisioning",
            expectedGeneration: placement.generation,
            patch: { environmentId: expectedEnvironmentId },
          },
          assertCurrent,
        ));
      reportPlacementTransition(onTransition, placement);
      assertCurrent();
      if (!prepared) {
        diagnostics?.mark("provision");
      }
      const environment = prepared
        ? prepared.environment
        : await environments.createWithRequest({
            profileId: request.profileId,
            retentionOwner: {
              sessionId: request.sessionId,
              sessionKey: request.sessionKey,
              agentId: request.agentId,
            },
            ...(workspace.kind === "repository" && workspace.repository.diskAuthority
              ? { retainedWorkspaceAuthority: workspace.repository.diskAuthority }
              : {}),
            idempotencyKey,
            machineClass: request.machineClass,
            executionMode: request.executionMode,
            projectPath,
            signal,
            os: request.os,
            runSetupScript: request.runSetupScript,
            admittedIntent: preparedIntent,
            inheritedProfile: request.inheritedProfile,
            beforeProvision: assertCurrent,
          });
      return await startup.continueProvisionedDispatch({
        markPhase: diagnostics?.mark,
        request: { ...request, readNativeCredential },
        retainCredentialCleanup,
        placement,
        environment,
        expectedEnvironmentId,
        workspace,
        onTransition,
        authorize: assertCurrent,
        signal,
        ...(prepared ? { admittedNode: prepared.admittedNode } : {}),
      });
    } catch (error) {
      diagnostics?.mark("cleanup");
      if (error instanceof AcceptedWorkspacePublicationIndeterminateError) {
        throw error;
      }
      try {
        const current = placement ? await placements.getAsync(request.sessionId) : undefined;
        if (current && current.state !== "local" && current.state !== "reclaimed") {
          if (current.state === "active") {
            await failure.failActive(current, error);
          } else {
            const currentEnvironment = current.environmentId
              ? environments.get(current.environmentId)
              : undefined;
            const ownedEnvironment =
              currentEnvironment?.environmentId === current.environmentId
                ? currentEnvironment
                : undefined;
            await failure.teardownEnvironment({
              placement: current,
              environmentId: ownedEnvironment?.environmentId ?? null,
              ownerEpoch: ownedEnvironment?.ownerEpoch ?? null,
              primaryError: error,
            });
          }
        }
      } finally {
        const finalPlacement = await placements.getAsync(request.sessionId);
        if (finalPlacement) {
          reportPlacementTransition(onTransition, finalPlacement);
        }
      }
      throw error;
    } finally {
      dispatchActive = false;
      const cleanup = await Promise.allSettled([...credentialCleanups].map((revoke) => revoke()));
      if (cleanup.some((result) => result.status === "rejected")) {
        sessionLog.warn(
          "Repository dispatch credential cleanup failed; retry GitHub credential cleanup before reusing the worker.",
        );
      }
    }
  };

  const reclaimOnce = createWorkerPlacementReclaim(options);

  const reclaimCurrent = async (
    request: WorkerPlacementReclaimRequest,
    authorize?: WorkerPlacementAuthorization,
    beforeDrain?: WorkerPlacementReclaimSourceCheck,
    initial?: WorkerDispatchPlacement,
    completedOperation?: WorkerPlacementCancellationTarget,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
  ): Promise<WorkerReclaimPlacement> => {
    const { placement: current, move } = await placements.getWithMoveAsync(request.sessionId);
    authorize?.();
    beforeDrain?.();
    if (current?.state === "draining" && move?.abandonSource) {
      if (
        move.target.kind !== "gateway" ||
        move.sessionId !== current.sessionId ||
        current.sessionKey !== request.sessionKey ||
        current.agentId !== request.agentId ||
        current.generation !== move.source.generation + 1 ||
        current.environmentId !== move.source.environmentId ||
        current.activeOwnerEpoch !== move.source.ownerEpoch
      ) {
        throw new Error("Abandoned cloud worker move changed before Stop cleanup");
      }
      // Stop owns live authority after the canceled Move settles; its committed disposition stays.
      return await options.runFailedReclaimBarrier({
        ...request,
        authorize,
        reclaim: async (reauthorize) => {
          const local = await abandonment.abandonSource(request, move, reauthorize, current);
          reportPlacementTransition(onTransition, local);
          return local;
        },
      });
    }
    if (
      request.retireRetainedWorkspace &&
      (current?.state === "active" || current?.state === "draining" || current?.state === "failed")
    ) {
      const retired = await abandonment.retireRetainedSession(request, authorize, beforeDrain);
      reportPlacementTransition(onTransition, retired);
      return retired;
    }
    if (current?.state === "reclaimed") {
      await finishRetainedWorkerCleanup(environments, current.environmentId);
      return current;
    }
    // Only a captured operation's successful result makes local an idempotent Stop.
    // Its real cleanup has settled, and the lifecycle and exact tuple still match.
    if (current?.state === "local" && matchesWorkerPlacementTarget(current, completedOperation)) {
      return current;
    }
    // The preparation/placement wait can span another completed failed cleanup.
    // Its old generation classifies an idempotent result, never authorizes new teardown.
    const owned = current?.state === "local" && initial?.state === "failed" ? initial : current;
    if (owned?.state === "failed" || owned?.state === "provisioning") {
      return await options.runFailedReclaimBarrier({
        ...request,
        authorize,
        reclaim: async (reauthorize) => {
          let failedPlacement = await placements.getAsync(request.sessionId);
          reauthorize?.();
          if (request.recoverToGateway) {
            beforeDrain?.();
          }
          if (owned.state === "provisioning") {
            failedPlacement = await failure.cancelProvisioning(
              failedPlacement,
              initial,
              reauthorize,
            );
            reportPlacementTransition(onTransition, failedPlacement);
          }
          // A preceding cleanup can finish while this request waits for the lifecycle fence.
          if (
            failedPlacement?.state === "local" &&
            owned.state === "failed" &&
            failedPlacement.generation === owned.generation + 1 &&
            failedPlacement.sessionKey === request.sessionKey &&
            failedPlacement.agentId === request.agentId
          ) {
            return failedPlacement;
          }
          if (failedPlacement?.state !== "failed") {
            throw new Error("Failed cloud worker placement changed during reclaim");
          }
          const cleanupError = await failure.retryFailedTeardown(failedPlacement, reauthorize);
          const failed = await placements.getAsync(request.sessionId);
          if (failed?.state !== "failed") {
            throw new Error("Failed cloud worker placement changed during reclaim");
          }
          if (
            !isFailedWorkerPlacementEnvironmentGone({
              environmentService: environments,
              placement: failed,
            })
          ) {
            throw new Error(
              cleanupError ?? "Failed cloud worker environment cleanup is still pending",
            );
          }
          const assertCurrent = request.recoverToGateway
            ? composePlacementAuthorization(reauthorize, () => beforeDrain?.())
            : undefined;
          if (assertCurrent) {
            assertCurrent();
            if (options.prepareGatewayMove) {
              await options.prepareGatewayMove({ ...request, assertCurrent });
            } else if ((await options.resolveWorkspace(request)).kind === "repository") {
              throw new Error("Repository workspace Gateway materialization is unavailable");
            }
            // Keep local admission closed until the accepted checkpoint is bound locally.
            assertCurrent();
          }
          const local = await placements.transition(
            {
              sessionId: request.sessionId,
              from: "failed",
              to: "local",
              expectedGeneration: failed.generation,
            },
            assertCurrent,
          );
          if (local.state !== "local") {
            throw new Error("Failed cloud worker reclaim did not produce a local placement");
          }
          reportPlacementTransition(onTransition, local);
          return local;
        },
      });
    }
    return await reclaimOnce(request, undefined, authorize, beforeDrain, onTransition);
  };

  const reclaim = async (
    request: WorkerPlacementReclaimRequest,
    authorize?: WorkerPlacementAuthorization,
    beforeDrain?: WorkerPlacementReclaimSourceCheck,
    serialize: (
      run: () => Promise<WorkerReclaimPlacement>,
    ) => Promise<WorkerReclaimPlacement> = async (run) => await run(),
    pendingOperations?: WorkerPlacementPendingOperations,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
  ): Promise<WorkerReclaimPlacement> => {
    const assertGatewayRecoverySource = (captured = placements.get(request.sessionId)) =>
      assertWorkerGatewayRecoverySource({
        request,
        source: captured,
        config: getRuntimeConfig(),
        environmentService: environments,
      });
    const initial = await placements.getAsync(request.sessionId);
    authorize?.();
    beforeDrain?.();
    assertGatewayRecoverySource(initial);
    if (initial) {
      reportPlacementTransition(onTransition, initial);
    }
    const checkSource = Object.assign(
      () => {
        beforeDrain?.(pendingOperations?.currentPlacement());
        assertGatewayRecoverySource();
      },
      { assertCurrent: beforeDrain?.assertCurrent },
    );
    return await options.runReclaimPreparation({
      ...request,
      authorize,
      beforeDrain: checkSource,
      pendingOperations,
      run: (reauthorize) =>
        serialize(() =>
          reclaimCurrent(
            request,
            reauthorize,
            checkSource,
            initial,
            pendingOperations?.completedPlacement(),
            onTransition,
          ),
        ),
    });
  };

  const abandonment = createWorkerPlacementMoveAbandonment(options);

  const moveService = createWorkerPlacementMoveService({
    placements,
    environments,
    runMoveBarrier: options.runMoveBarrier,
    dispatch,
    reclaimSource: (request, intent, authorize, onTransition) =>
      reclaimOnce(request, intent, authorize, undefined, onTransition),
    validateAbandonSource: abandonment.validateAbandonSource,
    abandonSource: abandonment.abandonSource,
    resolveDestination: options.resolveMoveDestination,
    prepareGatewayMove: options.prepareGatewayMove,
  });

  return {
    pause: createWorkerPlacementDiskPause({
      placements,
      environments,
      runReclaimPreparation: options.runReclaimPreparation,
    }),
    dispatch,
    forceDestroyEnvironment: abandonment.forceDestroyEnvironment,
    getEnvironmentAttachedSessionIds: (environmentId: string): readonly string[] =>
      environments.get(environmentId)?.attachedSessionIds ?? [],
    async readEnvironmentSessionIds(environmentId: string): Promise<string[]> {
      const sessionIds = (await placements.readChangeSnapshot()).map(({ sessionId }) => sessionId);
      const facts = await placements.readProjection(sessionIds, { current: true });
      return [
        ...new Set([
          ...(environments.get(environmentId)?.attachedSessionIds ?? []),
          ...[...facts.placements.values()]
            .filter((placement) => placement.environmentId === environmentId)
            .map(({ sessionId }) => sessionId),
          ...[...facts.moves.values()]
            .filter((move) => move.source.environmentId === environmentId)
            .map(({ sessionId }) => sessionId),
        ]),
      ];
    },
    move: moveService.move,
    reclaim,
    subscribeOrphanWorkspaceChanges: recovery.subscribeOrphanWorkspaceChanges,
    reconcile: recovery.reconcile,
    reconcileActive: recovery.reconcileActive,
  };
}

export type WorkerPlacementDispatchService = ReturnType<
  typeof createWorkerPlacementDispatchService
>;
