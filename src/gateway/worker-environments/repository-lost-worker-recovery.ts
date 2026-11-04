import { getRuntimeConfig } from "../../config/config.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";
import { inspectSessionRepositoryCheckpointAbsence } from "./session-repository-checkpoint-owner.js";

const log = createSubsystemLogger("gateway/worker-environments");

/** Called only by the exact failed-placement owner after physical cleanup is proven. */
export async function prepareLostRepositoryWorkspaceSource(params: {
  repository: SessionRepositoryWorkspaceRecord;
  request: Pick<
    WorkerPlacementDispatchRequest,
    "agentId" | "sessionId" | "sessionKey" | "readNativeCredential"
  >;
  retained: boolean;
  environmentId: string;
  ownerEpoch: number;
  placements: Pick<
    WorkerSessionPlacementStore,
    "readProjection" | "listPendingWorkspaceResultsAsync" | "abandonWorkspaceResult"
  >;
  assertCurrent: () => void;
  signal?: AbortSignal;
  retainCredentialCleanup: (revoke: () => Promise<void>) => void;
}) {
  const { repository, request, placements, assertCurrent } = params;
  assertCurrent();
  if (repository.diskAuthority) {
    throw new Error(
      "Retained workspace disk is authoritative and unavailable; recovery is held without source replacement",
    );
  }
  if (
    params.retained &&
    repository.recovery &&
    !repository.checkpointRef &&
    !repository.baseCommit &&
    repository.requestedRef === repository.recovery.sourceCommit
  ) {
    // The earlier source admission is durable. Ordinary preparation rechecks
    // access to that pinned commit; retry never chooses a different branch.
    return undefined;
  }
  const missing =
    params.retained && repository.checkpointRef
      ? await inspectSessionRepositoryCheckpointAbsence({
          workspaceId: repository.workspaceId,
          expectedRevision: repository.revision,
          assertCurrent,
        })
      : undefined;
  assertCurrent();
  // Retained recovery prefers accepted bytes. Exact base-only artifacts can be
  // reconstructed by startup without replacing their checkpoint identity.
  if (
    params.retained &&
    repository.checkpointRef &&
    (!missing || repository.manifestHash === repository.baseManifestHash)
  ) {
    return undefined;
  }
  if (params.retained) {
    const facts = await placements.readProjection([request.sessionId], { current: true });
    assertCurrent();
    if (
      facts.pendingResults.has(request.sessionId) ||
      facts.moves.has(request.sessionId) ||
      facts.workspaceJournalOwnerSessionIds.has(request.sessionId) ||
      facts.workspaceResultReconcilingSessionIds.has(request.sessionId) ||
      facts.workspaceRecoveryPendingSessionIds.has(request.sessionId)
    ) {
      throw new Error("Lost retained workspace still has unsettled recovery ownership");
    }
  }
  const fallbackCommit =
    repository.baseCommit ??
    (repository.requestedRef && /^[a-f0-9]{40}$/u.test(repository.requestedRef)
      ? repository.requestedRef
      : undefined);
  const source = await prepareRepositoryWorkerProjectSource({
    namespace: "repository-ref-recovery",
    getConfig: getRuntimeConfig,
    assertCurrent,
    signal: params.signal,
    readNativeCredential: request.readNativeCredential,
    retainCredentialCleanup: params.retainCredentialCleanup,
    repository: {
      agentId: request.agentId,
      url: repository.url,
      ref: `refs/heads/${repository.branch}`,
      ...(fallbackCommit ? { fallbackCommit } : {}),
    },
  });
  const assertReplacementSource = () => {
    assertCurrent();
    source.assertCurrent();
  };
  assertReplacementSource();
  for (const pending of await placements.listPendingWorkspaceResultsAsync(request.sessionId)) {
    assertReplacementSource();
    // Retained cleanup never discards unknown-effect work to make hydration fit.
    if (
      params.retained ||
      pending.environmentId !== params.environmentId ||
      pending.ownerEpoch !== params.ownerEpoch
    ) {
      throw new Error("Lost worker repository recovery has another result owner");
    }
    await placements.abandonWorkspaceResult(pending, assertReplacementSource);
  }
  const restored = await getSessionRepositoryWorkspaceStore().resetToBranch({
    workspaceId: repository.workspaceId,
    expectedRevision: repository.revision,
    sourceCommit: source.project.baseCommit,
    recovery: {
      reason: missing ? "missing-checkpoint-artifact" : "missing-worker",
      source: source.recoverySource ?? "published-branch",
    },
    assertCurrent: assertReplacementSource,
  });
  if (missing) {
    log.warn(
      "Repository checkpoint artifact is missing. Restored the available authorized source; unpublished private contents are unavailable. Original checkpoint provenance is retained.",
    );
  } else if (source.recoverySource === "recorded-base") {
    log.warn(
      "Published session branch is absent; restoring the recorded base. Unpushed changes on the lost worker are unavailable.",
    );
  }
  // A passive next-turn notice does not launch inference or replay the failed input.
  // Durable source facts above remain authoritative if this best-effort queue is lost.
  enqueueSystemEvent(
    `Workspace recovery restored ${source.recoverySource === "recorded-base" ? "the recorded base" : "the published session branch"}. Unpublished private files on the lost worker are unavailable; conversation history is retained. This is a partial workspace recovery, not recovery of the lost checkpoint.`,
    {
      sessionKey: request.sessionKey,
      contextKey: `workspace-recovery:${repository.workspaceId}:${restored.revision}`,
    },
  );
  assertCurrent();
  return restored;
}
