import type { GitHubCredentialReader } from "../../agents/github-credential-reader.js";
import { getRuntimeConfig } from "../../config/config.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import { prepareRepositoryGitHubIdentity } from "./repository-github-identity.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";
import { prepareMissingSessionRepositoryCheckpoint } from "./session-repository-checkpoint-recovery.js";
import {
  stageSessionRepositoryCheckpoint,
  withSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type {
  PreparedRepositoryWorkspace,
  WorkerTunnelHandle,
  WorkerWorkspaceSyncRequest,
} from "./tunnel-contract.js";

/** Pin branch-only legacy resets before selecting replacement capacity. */
export async function prepareRepositoryRecovery(
  workspace: WorkerSessionWorkspace,
  request: WorkerPlacementDispatchRequest,
  params: {
    assertCurrent: () => void;
    signal?: AbortSignal;
    retainCredentialCleanup: (revoke: () => Promise<void>) => void;
  },
): Promise<WorkerSessionWorkspace> {
  if (
    workspace.kind !== "repository" ||
    request.deviceId ||
    workspace.repository.baseCommit ||
    workspace.repository.checkpointRef ||
    workspace.repository.requestedRef !== `refs/heads/${workspace.repository.branch}`
  ) {
    return workspace;
  }
  // Older lost-worker resets retained only the generated branch. Never substitute
  // a default branch when the original source and unpublished checkpoint are unknown.
  const repository = workspace.repository;
  const source = await prepareRepositoryWorkerProjectSource({
    namespace: "repository-ref-recovery",
    getConfig: getRuntimeConfig,
    assertCurrent: params.assertCurrent,
    signal: params.signal,
    readNativeCredential: request.readNativeCredential,
    retainCredentialCleanup: params.retainCredentialCleanup,
    repository: {
      agentId: request.agentId,
      url: repository.url,
      ref: `refs/heads/${repository.branch}`,
      requirePublishedRef: true,
    },
  });
  const assertCurrent = () => {
    params.assertCurrent();
    source.assertCurrent();
  };
  assertCurrent();
  return {
    kind: "repository",
    repository: await getSessionRepositoryWorkspaceStore().resetToBranch({
      workspaceId: repository.workspaceId,
      expectedRevision: repository.revision,
      sourceCommit: source.project.baseCommit,
      assertCurrent,
    }),
  };
}

/** Prepare source on the worker and durably accept its initial state before activation. */
export async function syncSessionRepositoryWorkspace(params: {
  repository: SessionRepositoryWorkspaceRecord;
  tunnel: WorkerTunnelHandle;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  generation: number;
  gitAuthor?: { name?: string; email?: string };
  runSetupScript?: boolean;
  setupDisabled?: boolean;
  readNativeCredential?: GitHubCredentialReader;
  retainCredentialCleanup?: (revoke: () => Promise<void>) => void;
  preparedRepository?: PreparedRepositoryWorkspace;
  prepareCheckpointRecovery?: () => Promise<() => void>;
  assertCurrent: () => void;
  markPhase?: (phase: string) => void;
}) {
  const store = getSessionRepositoryWorkspaceStore();
  let repository = params.repository;
  if (repository.diskAuthority) {
    throw new Error(
      "Repository disk is already authoritative; resume the original resource instead of restoring a mirror",
    );
  }
  const prepared = params.preparedRepository;
  if (prepared && repository.baseCommit && prepared.baseCommit !== repository.baseCommit) {
    throw new Error("Prepared repository does not match the pinned session commit");
  }
  if (
    prepared &&
    repository.baseManifestHash &&
    prepared.sourceManifestRef !== repository.baseManifestHash
  ) {
    throw new Error("Prepared repository does not match the pinned source manifest");
  }
  if (
    !prepared &&
    !repository.checkpointRef &&
    repository.runSetupScript &&
    !params.setupDisabled &&
    params.runSetupScript !== true
  ) {
    throw new Error(
      "Repository setup requires administrator authorization; retry dispatch as an administrator.",
    );
  }
  params.assertCurrent();
  const github = prepared
    ? undefined
    : await prepareRepositoryGitHubIdentity(params.agentId, params.assertCurrent, {
        repositoryUrl: repository.url,
        readNativeCredential: params.readNativeCredential,
        retainCredentialCleanup: params.retainCredentialCleanup,
      });
  const assertGitHubCurrent = github?.assertSelected ?? params.assertCurrent;
  assertGitHubCurrent();
  const missingCheckpoint = repository.checkpointRef
    ? await prepareMissingSessionRepositoryCheckpoint({
        workspaceId: repository.workspaceId,
        expectedRevision: repository.revision,
        assertCurrent: assertGitHubCurrent,
      })
    : undefined;
  let assertRecoveryCurrent: (() => void) | undefined;
  if (missingCheckpoint) {
    if (!params.prepareCheckpointRecovery) {
      throw new Error(
        "Restore the missing repository checkpoint from backup or retry through an authorized worker dispatch; recovery ownership is unavailable.",
      );
    }
    assertRecoveryCurrent = await params.prepareCheckpointRecovery();
  }
  const assertCurrent = () => {
    assertGitHubCurrent();
    missingCheckpoint?.assertCurrent();
    assertRecoveryCurrent?.();
  };
  assertCurrent();
  const source: Extract<WorkerWorkspaceSyncRequest["source"], { kind: "repository" }> = {
    kind: "repository",
    url: repository.url,
    ref: missingCheckpoint?.baseCommit ?? repository.requestedRef ?? undefined,
    branch: repository.branch,
    baseCommit: repository.baseCommit ?? prepared?.baseCommit,
    ...(prepared ? { prepared } : {}),
    runSetupScript:
      !prepared &&
      !repository.checkpointRef &&
      repository.runSetupScript &&
      !params.setupDisabled &&
      params.runSetupScript === true,
    ...(github?.token ? { gitToken: github.token } : {}),
  };
  const sync = async (checkpoint?: typeof source.checkpoint) => {
    assertCurrent();
    const start = () =>
      params.tunnel.syncWorkspace({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        generation: params.generation,
        gitAuthor: params.gitAuthor,
        source: { ...source, ...(checkpoint ? { checkpoint } : {}) },
        authorize: assertCurrent,
      });
    return github ? await github.start(start) : await start();
  };
  params.markPhase?.("repositorySync");
  const synced =
    repository.checkpointRef && !missingCheckpoint
      ? await withSessionRepositoryCheckpoint({ workspaceId: repository.workspaceId }, sync)
      : await sync();
  assertCurrent();
  if (synced.mode !== "repository") {
    throw new Error("Repository preparation did not return a repository workspace");
  }
  if (
    prepared &&
    (synced.baseCommit !== prepared.baseCommit ||
      synced.baseManifestRef !== prepared.sourceManifestRef ||
      synced.remoteWorkspaceDir !== prepared.workspaceDir)
  ) {
    throw new Error("Repository preparation changed its attested prepared workspace");
  }
  if (!repository.baseCommit || !repository.baseManifestHash) {
    repository = await store.bindBase({
      workspaceId: repository.workspaceId,
      expectedRevision: repository.revision,
      baseCommit: synced.baseCommit,
      baseManifestHash: synced.baseManifestRef,
      assertCurrent,
    });
    assertCurrent();
  } else if (
    repository.baseCommit !== synced.baseCommit ||
    repository.baseManifestHash !== synced.baseManifestRef
  ) {
    throw new Error("Repository preparation changed the pinned source baseline");
  }
  if (missingCheckpoint && synced.manifestRef !== missingCheckpoint.manifestRef) {
    throw new Error(
      "Repository source does not match the missing checkpoint; restore its artifact from backup.",
    );
  }
  if (repository.checkpointRef && !missingCheckpoint) {
    if (synced.manifestRef !== repository.manifestHash) {
      throw new Error("Repository preparation did not restore the accepted checkpoint");
    }
    return synced;
  }
  params.markPhase?.("repositoryQuiesce");
  const quiescence = await params.tunnel.quiesceWorkspace(synced.remoteWorkspaceDir);
  let reconciliation: Awaited<ReturnType<WorkerTunnelHandle["reconcileWorkspace"]>> | undefined;
  try {
    assertCurrent();
    params.markPhase?.("repositoryReconcile");
    reconciliation = await params.tunnel.reconcileWorkspace({
      remoteWorkspaceDir: synced.remoteWorkspaceDir,
      baseManifestRef: synced.baseManifestRef,
      source: {
        kind: "repository",
        markPhase: params.markPhase,
        authorize: assertCurrent,
        referenceManifestRef: synced.manifestRef,
        prepareCheckpoint: (payload) => {
          assertCurrent();
          if (
            missingCheckpoint &&
            (payload.baseManifestRef !== missingCheckpoint.manifestRef ||
              payload.currentManifestRef !== missingCheckpoint.manifestRef)
          ) {
            throw new Error(
              "Repository source does not match the missing checkpoint; restore its artifact from backup.",
            );
          }
          return stageSessionRepositoryCheckpoint({
            ...payload,
            ...(missingCheckpoint
              ? { checkpointRef: missingCheckpoint.checkpointRef, missingCheckpoint: true as const }
              : {}),
            workspaceId: repository.workspaceId,
            expectedRevision: repository.revision,
            assertCurrent,
          });
        },
      },
    });
    params.markPhase?.("repositoryQuiescenceRenewal");
    await quiescence.assertActive();
    params.markPhase?.("repositoryVerification");
    await reconciliation.verifyStable();
    params.markPhase?.("repositoryLocalVerification");
    await reconciliation.verifyLocalStable();
    assertCurrent();
    params.markPhase?.("repositoryAcceptance");
    await reconciliation.publishStagedResult();
    assertCurrent();
    return { ...synced, manifestRef: reconciliation.manifestRef };
  } finally {
    params.markPhase?.("repositoryCleanup");
    try {
      await reconciliation?.discardPreparedStagedResult();
    } finally {
      await quiescence.resume();
    }
  }
}
