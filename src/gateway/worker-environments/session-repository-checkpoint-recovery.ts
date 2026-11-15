import fs from "node:fs/promises";
import { hasErrnoCode } from "../../infra/errors.js";
import {
  getSessionRepositoryWorkspaceStore,
  type SessionRepositoryWorkspaceStore,
} from "../../state/session-repository-workspaces.js";
import type { WorkerSessionPlacementProjection } from "./placement-read-projection.types.js";
import { checkpointRef } from "./session-repository-checkpoint-refs.js";

type CheckpointOwner = { workspaceId: string; store?: SessionRepositoryWorkspaceStore };

/** The placement owner must exclude unsettled work before reconstructing a missing artifact. */
export async function prepareCheckpointRecovery(
  placements: {
    readProjection: (
      ids: readonly string[],
      options: { current: true },
    ) => Promise<WorkerSessionPlacementProjection>;
  },
  target: { sessionId: string; generation: number },
  assertCurrent: () => void,
): Promise<() => void> {
  const facts = await placements.readProjection([target.sessionId], { current: true });
  assertCurrent();
  const placement = facts.placements.get(target.sessionId);
  if (
    placement?.state !== "syncing" ||
    placement.generation !== target.generation ||
    placement.turnClaim !== null ||
    facts.pendingResults.has(target.sessionId) ||
    facts.moves.has(target.sessionId) ||
    facts.workspaceJournalOwnerSessionIds.has(target.sessionId) ||
    facts.workspaceResultReconcilingSessionIds.has(target.sessionId) ||
    facts.workspaceRecoveryPendingSessionIds.has(target.sessionId)
  ) {
    throw new Error(
      "Restore the missing repository checkpoint before retrying; unresolved worker recovery still owns this workspace.",
    );
  }
  // Exact syncing ownership excludes later claims and obsolete worker results.
  return assertCurrent;
}

/** Only exact filesystem absence is loss; corrupt, inaccessible and unknown artifacts stay owned. */
export async function inspectSessionRepositoryCheckpointAbsence(
  params: CheckpointOwner & {
    expectedRevision: number;
    assertCurrent: () => void;
  },
) {
  const store = params.store ?? getSessionRepositoryWorkspaceStore();
  const { workspace, current } = await store.prepare(params.workspaceId);
  if (!workspace) {
    throw new Error("Repository workspace no longer exists");
  }
  const root = store.artifactPath(params.workspaceId);
  params.assertCurrent();
  try {
    await fs.lstat(root);
    return undefined;
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
  const assertCurrent = () => {
    params.assertCurrent();
    if (current()?.revision !== params.expectedRevision) {
      throw new Error("Repository workspace revision changed");
    }
  };
  assertCurrent();
  return { workspace, assertCurrent };
}

/** Exact source-only reconstruction preserves the accepted checkpoint identity. */
export async function prepareMissingSessionRepositoryCheckpoint(
  params: CheckpointOwner & {
    expectedRevision: number;
    assertCurrent: () => void;
  },
) {
  const missing = await inspectSessionRepositoryCheckpointAbsence(params);
  if (!missing) {
    return undefined;
  }
  const { workspace, assertCurrent } = missing;
  if (
    !workspace.baseCommit ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(workspace.baseCommit) ||
    !workspace.baseManifestHash ||
    workspace.manifestHash !== workspace.baseManifestHash
  ) {
    throw new Error(
      "Restore the missing repository checkpoint from backup before retrying; it may contain unpublished work.",
    );
  }
  return {
    checkpointRef: checkpointRef(workspace),
    baseCommit: workspace.baseCommit,
    manifestRef: workspace.baseManifestHash,
    assertCurrent,
  };
}
