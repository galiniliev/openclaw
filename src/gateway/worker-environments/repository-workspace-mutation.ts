import { randomUUID } from "node:crypto";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { GitHubCredentialReader } from "../../agents/github-credential-reader.js";
import { retainPreparedSessionSharingFacts } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { projectSessionSharingEntry } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { captureSessionEntryCurrentRead } from "../../config/sessions/session-entry-current-runtime.js";
import type { SessionEntryCurrentFacts } from "../../config/sessions/session-entry-current.types.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { GitHubPublicationRecoveryPendingError } from "../github-publication-git-index.js";
import { StaleWorkerBuildError } from "./admission.js";
import {
  AUTHENTICATED_GIT_JS,
  WORKER_REPOSITORY_GIT_ARGS,
} from "./node-worker-repository-preparation.js";
import {
  placementTurnOwner,
  type WorkerSessionPlacementIdentity,
  type WorkerSessionPlacementRecord,
} from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { isCurrentActiveWorkerEnvironment } from "./placement-target.js";
import type { PlacementTurnClaimCurrentCheck } from "./placement-turn-claims.types.js";
import { WorkerRuntimeRefreshPendingError } from "./provider-runtime-refresh.js";
import { prepareRepositoryGitHubIdentity } from "./repository-github-identity.js";
import {
  assertRetainedWorkspaceDisk,
  prepareRetainedWorkspaceTransfer,
} from "./retained-workspace.js";
import type { WorkerEnvironmentService } from "./service.js";
import { stageSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";
import {
  createWorkerWorkspaceReconcileRequest,
  type WorkerSessionWorkspace,
} from "./session-workspace.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import {
  createWorkspaceResultJournal,
  settleStagedWorkspaceResult,
} from "./workspace-result-settlement.js";
import { workerWorkspaceResultRef } from "./workspace-result-staging.js";

export function createRepositoryWorkspaceMutationService(options: {
  placements: WorkerSessionPlacementStore;
  environments: Pick<WorkerEnvironmentService, "get" | "startTunnel"> &
    Partial<Pick<WorkerEnvironmentService, "inspectTurnLease">>;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  resolveWorkspace: (identity: WorkerSessionPlacementIdentity) => Promise<WorkerSessionWorkspace>;
  refreshPublicationRuntime?: (
    placement: Extract<WorkerSessionPlacementRecord, { state: "active" }>,
    assertCurrent: () => void,
    readNativeCredential?: GitHubCredentialReader,
  ) => Promise<void>;
  preparePublicationWorker?: (
    identity: WorkerSessionPlacementIdentity,
    input: import("../repository-publication-checkpoint.js").RepositoryPublicationIntegrationInput,
  ) => Promise<Extract<WorkerSessionPlacementRecord, { state: "active" }>>;
}) {
  const { placements, environments } = options;
  const refreshRepositoryRefs = async (
    identity: WorkerSessionPlacementIdentity,
    readNativeCredential?: GitHubCredentialReader,
  ): Promise<void> => {
    const workspace = await options.resolveWorkspace(identity);
    if (workspace.kind !== "repository") {
      return;
    }
    const placement = await placements.getAsync(identity.sessionId);
    if (placement?.state !== "active") {
      return;
    }
    const assertCurrent = () => {
      getGatewayRestartDrainSignal().throwIfAborted();
      const current = placements.get(identity.sessionId);
      if (
        current?.state !== "active" ||
        current.generation !== placement.generation ||
        current.environmentId !== placement.environmentId ||
        current.activeOwnerEpoch !== placement.activeOwnerEpoch ||
        current.sessionKey !== identity.sessionKey ||
        current.agentId !== identity.agentId
      ) {
        throw new Error("Repository ref refresh placement changed.");
      }
    };
    const cleanup: Array<() => Promise<void>> = [];
    const processId = `repository-main-fetch-${placement.generation}`;
    let tunnel: Awaited<ReturnType<typeof environments.startTunnel>> | undefined;
    try {
      const github = await prepareRepositoryGitHubIdentity(identity.agentId, assertCurrent, {
        repositoryUrl: workspace.repository.url,
        readNativeCredential,
        retainCredentialCleanup: (revoke) => cleanup.push(revoke),
      });
      assertCurrent();
      tunnel = await environments.startTunnel({
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
      });
      assertCurrent();
      const ownedTunnel = tunnel;
      await github.start(async () => {
        let result = await ownedTunnel.runWorkspaceCommand({
          argv: [
            "node",
            "-e",
            AUTHENTICATED_GIT_JS,
            "--",
            ...WORKER_REPOSITORY_GIT_ARGS,
            "fetch",
            "--no-tags",
            "--no-auto-maintenance",
            "--no-write-fetch-head",
            "--no-recurse-submodules",
            "--",
            workspace.repository.url,
            "+refs/heads/main:refs/remotes/origin/main",
          ],
          input: JSON.stringify({
            origin: workspace.repository.url,
            token: github.token,
            disableLazyFetch: true,
          }),
          process: { action: "start", processId },
          transportRetry: "never",
          assertCurrent,
        });
        while (result.code === null && result.signal === null && !result.killed) {
          await sleepWithAbort(250, getGatewayRestartDrainSignal());
          assertCurrent();
          result = await ownedTunnel.runWorkspaceCommand({
            argv: ["openclaw-internal-workspace-process"],
            process: { action: "status", processId },
            transportRetry: "never",
            assertCurrent,
          });
        }
        if (result.code !== 0) {
          throw new Error(
            "Background repository main fetch failed; publication will refresh its base independently.",
          );
        }
      });
    } finally {
      // Stop is cleanup of this admitted process, never permission to start another Git action.
      await tunnel
        ?.runWorkspaceCommand({
          argv: ["openclaw-internal-workspace-process"],
          process: { action: "stop", processId },
          transportRetry: "never",
        })
        .catch(() => undefined);
      for (const revoke of cleanup) {
        await revoke();
      }
    }
  };
  return {
    refreshRepositoryRefs(
      request: WorkerSessionPlacementIdentity & { readNativeCredential?: GitHubCredentialReader },
    ): void {
      runInDetachedAsyncContext(() => {
        void refreshRepositoryRefs(request, request.readNativeCredential).catch(() => {
          createSubsystemLogger("gateway/worker-workspace").warn(
            "Background repository main refresh was unavailable; session startup continues and publication will refresh its base.",
          );
        });
      });
    },
    async integratePublication(
      identity: WorkerSessionPlacementIdentity,
      input: import("../repository-publication-checkpoint.js").RepositoryPublicationIntegrationInput,
    ) {
      let placement = await placements.getAsync(identity.sessionId);
      input.assertCurrent();
      if (placement?.state !== "active" && options.preparePublicationWorker) {
        placement = await options.preparePublicationWorker(identity, input);
        input.assertCurrent();
      }
      if (placement?.state !== "active") {
        throw new Error(
          "Publication worker preparation is unavailable; retry the same request after worker recovery.",
        );
      }
      const assertCurrent = () => {
        input.assertCurrent();
        const current = placements.get(identity.sessionId);
        if (
          current?.state !== "active" ||
          current.generation !== placement.generation ||
          current.environmentId !== placement.environmentId ||
          current.activeOwnerEpoch !== placement.activeOwnerEpoch ||
          current.sessionKey !== identity.sessionKey ||
          current.agentId !== identity.agentId
        ) {
          throw new Error("Publication integration lost its worker placement.");
        }
      };
      let openingTunnel = true;
      const integrate = async () => {
        const tunnel = await environments.startTunnel({
          environmentId: placement.environmentId,
          ownerEpoch: placement.activeOwnerEpoch,
          authorize: assertCurrent,
        });
        // A disconnected open has no publication effects; transport failures cannot be replayed.
        openingTunnel = false;
        assertCurrent();
        if (!tunnel.integratePublication) {
          throw new StaleWorkerBuildError(
            "Worker publication integration requires its current runtime.",
          );
        }
        return await tunnel.integratePublication({ ...input, assertCurrent });
      };
      try {
        return await integrate();
      } catch (error) {
        if (
          !(
            error instanceof StaleWorkerBuildError ||
            error instanceof WorkerRuntimeRefreshPendingError ||
            (openingTunnel && error instanceof WorkerTunnelOwnerDisconnectedError)
          ) ||
          !options.refreshPublicationRuntime
        ) {
          throw error;
        }
        await options.refreshPublicationRuntime(
          placement,
          assertCurrent,
          input.readNativeCredential,
        );
        assertCurrent();
        try {
          return await integrate();
        } catch (refreshError) {
          if (
            refreshError instanceof StaleWorkerBuildError ||
            refreshError instanceof WorkerRuntimeRefreshPendingError
          ) {
            throw new GitHubPublicationRecoveryPendingError(
              "Publication is waiting for the normal worker runtime upgrade. Retry the same request after worker recovery; its accepted checkpoint is retained.",
              { cause: refreshError },
            );
          }
          throw refreshError;
        }
      }
    },
    async captureCheckpoint(
      identity: WorkerSessionPlacementIdentity,
      assertCallerCurrent: () => void,
    ): Promise<void> {
      assertCallerCurrent();
      const workspace = await options.resolveWorkspace(identity);
      assertCallerCurrent();
      if (workspace.kind !== "repository" || !workspace.repository.diskAuthority) {
        return;
      }
      const placement = await placements.getAsync(identity.sessionId);
      if (placement?.state !== "active") {
        throw new Error("Retained repository publication requires its original active disk");
      }
      const disk = workspace.repository.diskAuthority;
      const assertSourceCurrent = () => {
        assertCallerCurrent();
        const current = placements.get(identity.sessionId);
        if (
          current?.state !== "active" ||
          current.generation !== placement.generation ||
          current.sessionKey !== identity.sessionKey ||
          current.agentId !== identity.agentId
        ) {
          throw new Error("Repository publication lost its exact placement owner");
        }
      };
      const assertCurrent = () => {
        assertSourceCurrent();
        assertRetainedWorkspaceDisk(disk, environments.get(placement.environmentId), placement);
      };
      await options.workspaceOperations.run(placement.environmentId, async () => {
        await prepareRetainedWorkspaceTransfer({
          authority: disk,
          placement,
          environments,
          assertCurrent: assertSourceCurrent,
        });
        assertCurrent();
        const repository = await getSessionRepositoryWorkspaceStore().get(
          workspace.repository.workspaceId,
        );
        assertCurrent();
        if (!repository?.baseManifestHash) {
          throw new Error("Repository publication has no admitted source baseline");
        }
        const tunnel = await environments.startTunnel({
          environmentId: placement.environmentId,
          ownerEpoch: placement.activeOwnerEpoch,
        });
        assertCurrent();
        const quiescence = await tunnel.quiesceWorkspace(placement.remoteWorkspaceDir);
        let result: Awaited<ReturnType<typeof tunnel.reconcileWorkspace>> | undefined;
        try {
          assertCurrent();
          result = await tunnel.reconcileWorkspace({
            remoteWorkspaceDir: placement.remoteWorkspaceDir,
            baseManifestRef: repository.baseManifestHash,
            source: {
              kind: "repository",
              authorize: assertCurrent,
              referenceManifestRef: repository.manifestHash ?? repository.baseManifestHash,
              acceptedManifestRef: repository.manifestHash ?? repository.baseManifestHash,
              prepareCheckpoint: (payload) =>
                stageSessionRepositoryCheckpoint({
                  ...payload,
                  workspaceId: repository.workspaceId,
                  expectedRevision: repository.revision,
                  assertCurrent,
                }),
            },
          });
          await verifyReconciledWorkspaceFinal(result, quiescence);
          assertCurrent();
        } finally {
          try {
            await result?.discardPreparedStagedResult();
          } finally {
            await quiescence.resume();
          }
        }
      });
    },
    async mutate<T>(
      params: WorkerSessionPlacementIdentity & {
        assertCurrent: () => void;
        assertEntryCurrent?: (entry: SessionEntryCurrentFacts | undefined) => void;
        mutate: (assertCurrent: () => void) => Promise<{ changed: boolean; value: T }>;
      },
    ): Promise<T> {
      const scope = {
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        storePath: resolveSessionStorePathForScope(params),
      };
      const source = captureSessionEntryMetadataRead(scope, params.assertCurrent);
      const assertCallerCurrent = () => {
        source?.assertCurrent();
        params.assertCurrent();
      };
      const placement = await placements.getAsync(params.sessionId);
      assertCallerCurrent();
      if (placement?.state !== "active") {
        throw new Error("Repository workspace editing requires an active cloud placement");
      }
      return await options.workspaceOperations.run(placement.environmentId, async () => {
        let facts: ReturnType<typeof retainPreparedSessionSharingFacts> | undefined;
        let active = true;
        let unregister = () => {};
        const release = () => {
          active = false;
          facts?.release();
          unregister();
        };
        using retained = {
          [Symbol.dispose]: release,
          assertCurrent() {
            if (!active) {
              throw new Error("Repository workspace session source is unavailable");
            }
          },
        };
        assertCallerCurrent();
        const workspace = await options.resolveWorkspace(params);
        if (workspace.kind !== "repository") {
          throw new Error("Session no longer owns a cloud repository workspace");
        }
        const environment = environments.get(placement.environmentId);
        if (!isCurrentActiveWorkerEnvironment(placement, environment)) {
          throw new Error("Repository workspace environment is no longer current");
        }
        const assertEntryCurrent = (entry: SessionEntryCurrentFacts | undefined) => {
          params.assertEntryCurrent?.(entry);
          if (
            entry?.sessionId !== params.sessionId ||
            entry.repositoryWorkspaceId !== workspace.repository.workspaceId ||
            workspace.repository.agentId !== params.agentId ||
            workspace.repository.sessionKey !== params.sessionKey
          ) {
            throw new Error("Repository workspace edit lost its exact session placement owner");
          }
        };
        const currentEntry = await withSessionEntryReadOnlyInWorker(
          scope,
          assertCallerCurrent,
          async (read, owner) => {
            if (!read.ok) {
              throw toErrorObject(read.error, "Repository workspace session read failed");
            }
            assertEntryCurrent(read.value);
            if (owner.kind === "file") {
              if (!facts) {
                throw new Error("Repository workspace session source is unavailable");
              }
              facts.initialize({
                entry: read.value && projectSessionSharingEntry(read.value),
                membership: new Set(),
              });
            }
            return captureSessionEntryCurrentRead(scope, owner);
          },
          (database, identity) => {
            facts = retainPreparedSessionSharingFacts({
              databaseIdentity: identity.key,
              sessionKey: scope.sessionKey,
              acquiring: true,
            });
            unregister = registerOpenClawAgentDatabaseAsyncResource({
              ...database,
              revoke: release,
              close: async () => release(),
            });
          },
        );
        const assertPlacementCurrent = (current: WorkerSessionPlacementRecord | undefined) => {
          const currentEnvironment = environments.get(placement.environmentId);
          if (
            current?.state !== "active" ||
            current.agentId !== params.agentId ||
            current.sessionKey !== params.sessionKey ||
            current.generation !== placement.generation ||
            current.environmentId !== placement.environmentId ||
            current.activeOwnerEpoch !== placement.activeOwnerEpoch ||
            current.remoteWorkspaceDir !== placement.remoteWorkspaceDir ||
            !isCurrentActiveWorkerEnvironment(current, currentEnvironment) ||
            currentEnvironment?.leaseId !== environment?.leaseId
          ) {
            throw new Error("Repository workspace edit lost its exact session placement owner");
          }
        };
        const assertWorkerCurrent = () => {
          assertCallerCurrent();
          currentEntry.assertSourceCurrent();
          retained.assertCurrent();
          assertEntryCurrent(
            currentEntry.kind === "file" ? facts?.readCurrent()?.entry : currentEntry.readCurrent(),
          );
        };
        const currentCheck: PlacementTurnClaimCurrentCheck = {
          ...(currentEntry.kind === "file"
            ? { sessionEntry: { source: currentEntry.source, assertCurrent: assertEntryCurrent } }
            : {}),
          assertPlacementCurrent,
        };
        const assertOwner = () => {
          assertWorkerCurrent();
          assertPlacementCurrent(placements.get(params.sessionId));
        };
        assertOwner();
        const claim = await placements.claimWorkspaceMutationResult(
          {
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            claimId: `workspace-mutation-${randomUUID()}`,
            owner: placementTurnOwner(placement),
          },
          assertWorkerCurrent,
          currentCheck,
        );
        const assertCurrent = () => {
          assertOwner();
          if (!placements.validateWorkspaceResultClaim(claim)) {
            throw new Error("Repository workspace edit lost its result custody");
          }
        };
        try {
          assertCurrent();
          const result = await params.mutate(assertCurrent);
          assertCurrent();
          if (!result.changed) {
            await placements.acceptWorkspaceResult(claim, assertWorkerCurrent, currentCheck);
            await placements.completeWorkspaceResultAndReleaseTurn(
              claim,
              assertWorkerCurrent,
              currentCheck,
            );
            return result.value;
          }
          const tunnel = await environments.startTunnel({
            environmentId: placement.environmentId,
            ownerEpoch: placement.activeOwnerEpoch,
          });
          assertCurrent();
          if (
            tunnel.environmentId !== placement.environmentId ||
            tunnel.ownerEpoch !== placement.activeOwnerEpoch
          ) {
            throw new Error("Repository workspace capture tunnel owner changed");
          }
          const quiescence = await tunnel.quiesceWorkspace(placement.remoteWorkspaceDir);
          let resumed = false;
          try {
            assertCurrent();
            const stagedResultRef = workerWorkspaceResultRef(claim.claimId);
            const journal = createWorkspaceResultJournal({
              placement,
              placements,
              turnClaim: claim,
              assertCurrent: assertWorkerCurrent,
              current: currentCheck,
            });
            const reconciliation = await tunnel.reconcileWorkspace(
              createWorkerWorkspaceReconcileRequest({
                workspace,
                remoteWorkspaceDir: placement.remoteWorkspaceDir,
                baseManifestRef: placement.workspaceBaseManifestRef,
                journal: journal.adapter,
                stagedResult: {
                  ref: stagedResultRef,
                  record: (ref, workspaceId) =>
                    placements.recordStagedWorkspaceResult(
                      claim,
                      ref,
                      workspaceId,
                      assertWorkerCurrent,
                      currentCheck,
                    ),
                },
                assertCurrent,
              }),
            );
            await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
            assertCurrent();
            if (!journal.wasAccepted()) {
              throw new Error("Repository workspace edit was not durably accepted");
            }
            await placements.acceptWorkspaceResult(claim, assertWorkerCurrent, currentCheck);
            await settleStagedWorkspaceResult({
              assertCurrent,
              placements,
              turnClaim: claim,
              workspace,
              stagedResultRef,
              conflictRetained: false,
              complete: () =>
                placements.completeWorkspaceResultAndReleaseTurn(
                  claim,
                  assertWorkerCurrent,
                  currentCheck,
                ),
              beforeComplete: async () => {
                await quiescence.resume();
                resumed = true;
                assertCurrent();
              },
            });
            return result.value;
          } finally {
            if (!resumed) {
              await quiescence.resume();
            }
          }
        } catch (error) {
          // The remote write may have completed before transport or capture failed.
          // Retain its custody so ordinary result recovery can capture it safely.
          if (placements.validateWorkspaceResultClaim(claim)) {
            await placements.handoffWorkspaceResultRecovery(claim);
          }
          throw error;
        }
      });
    },
  };
}
