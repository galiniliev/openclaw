import { isDeepStrictEqual } from "node:util";
import type { GitHubCredentialReader } from "../../agents/github-credential-reader.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { RetainedWorkspaceAuthority } from "../../state/retained-workspace-authority.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import { prepareRepositoryGitHubIdentity } from "./repository-github-identity.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";
import { prepareMissingSessionRepositoryCheckpoint } from "./session-repository-checkpoint-owner.js";
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
  recovery?: true;
  readNativeCredential?: GitHubCredentialReader;
  retainCredentialCleanup?: (revoke: () => Promise<void>) => void;
  preparedRepository?: PreparedRepositoryWorkspace;
  retainedDisk?: (workspaceDir: string) => RetainedWorkspaceAuthority | undefined;
  /** The dispatch owner excludes unresolved work before reconstructing source-only artifacts. */
  prepareCheckpointRecovery?: () => Promise<() => void>;
  assertCurrent: () => void;
  markPhase?: (phase: string) => void;
}) {
  const store = getSessionRepositoryWorkspaceStore();
  let repository = params.repository;
  const prepared = params.preparedRepository;
  if (repository.diskAuthority) {
    params.assertCurrent();
    const current = params.retainedDisk?.(repository.diskAuthority.workspaceDir);
    if (!current) {
      throw new Error("Retained workspace disk authority changed; mirror restore is refused");
    }
    if (!isDeepStrictEqual(current, repository.diskAuthority)) {
      repository = await store.rebindRetainedOwner({
        workspaceId: repository.workspaceId,
        expectedRevision: repository.revision,
        expectedDiskAuthority: repository.diskAuthority,
        diskAuthority: current,
        placementGeneration: params.generation,
        assertCurrent: params.assertCurrent,
      });
      params.assertCurrent();
    }
    if (!repository.baseCommit || !repository.baseManifestHash) {
      throw new Error("Retained workspace disk authority changed; mirror restore is refused");
    }
    return {
      mode: "repository" as const,
      remoteWorkspaceDir: current.workspaceDir,
      baseCommit: repository.baseCommit,
      baseManifestRef: repository.baseManifestHash,
      manifestRef: repository.baseManifestHash,
    };
  }
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
  const assertCurrent = github?.assertSelected ?? params.assertCurrent;
  assertCurrent();
  const missingCheckpoint = repository.checkpointRef
    ? await prepareMissingSessionRepositoryCheckpoint({
        workspaceId: repository.workspaceId,
        expectedRevision: repository.revision,
        assertCurrent,
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
  const assertSourceCurrent = missingCheckpoint
    ? () => {
        assertCurrent();
        missingCheckpoint.assertCurrent();
        assertRecoveryCurrent?.();
      }
    : assertCurrent;
  assertSourceCurrent();
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
      params.runSetupScript === true,
    ...(github?.token ? { gitToken: github.token } : {}),
  };
  const sync = async (checkpoint?: typeof source.checkpoint) => {
    assertSourceCurrent();
    const start = () =>
      params.tunnel.syncWorkspace({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        generation: params.generation,
        gitAuthor: params.gitAuthor,
        source: { ...source, ...(checkpoint ? { checkpoint } : {}) },
        authorize: () => {
          assertSourceCurrent();
          github?.assertSelected();
        },
      });
    return github ? await github.start(start) : await start();
  };
  params.markPhase?.("repositorySync");
  const synced =
    repository.checkpointRef && !missingCheckpoint
      ? await withSessionRepositoryCheckpoint({ workspaceId: repository.workspaceId }, sync)
      : await sync();
  assertSourceCurrent();
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
      assertCurrent: assertSourceCurrent,
    });
    assertSourceCurrent();
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
  const diskAuthority = params.retainedDisk?.(synced.remoteWorkspaceDir);
  if (diskAuthority) {
    await store.bindBase({
      workspaceId: repository.workspaceId,
      expectedRevision: repository.revision,
      baseCommit: synced.baseCommit,
      baseManifestHash: synced.baseManifestRef,
      diskAuthority,
      assertCurrent: assertSourceCurrent,
    });
    assertSourceCurrent();
    return synced;
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
    assertSourceCurrent();
    params.markPhase?.("repositoryReconcile");
    reconciliation = await params.tunnel.reconcileWorkspace({
      remoteWorkspaceDir: synced.remoteWorkspaceDir,
      baseManifestRef: synced.baseManifestRef,
      source: {
        kind: "repository",
        markPhase: params.markPhase,
        authorize: assertSourceCurrent,
        referenceManifestRef: synced.manifestRef,
        prepareCheckpoint: (payload) => {
          assertSourceCurrent();
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
            assertCurrent: assertSourceCurrent,
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
    assertSourceCurrent();
    params.markPhase?.("repositoryAcceptance");
    await reconciliation.publishStagedResult();
    assertSourceCurrent();
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
