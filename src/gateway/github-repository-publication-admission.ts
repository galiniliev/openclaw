import { randomUUID } from "node:crypto";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import {
  deriveGitHubPublicationTaskId,
  type GitHubPublicationOrigin,
} from "../state/github-publication-requester.js";
import type { SessionRepositoryWorkspaceRecord } from "../state/session-repository-workspaces.types.js";
import type { PersonalGitHubSessionActionV2 } from "./github-personal-publication.js";
import type { projectGitHubPublicationResult } from "./github-publication-receipt.js";
import type { GitHubPublicationRequesterPolicyV2 } from "./github-publication-requester.js";
import type { PublicationSessionIdentity as SessionIdentity } from "./github-publication-session.types.js";
import {
  readRepositoryGitHubPublicationBranchAsync,
  bindRepositoryGitHubPublicationCheckpointAsync,
} from "./github-publication-store-async.js";
import type { createRepositoryGitHubPublicationExecution } from "./github-repository-publication-execution.js";
import {
  captureCheckpoint,
  prepareRepositoryOwner,
  type RepositoryDiskPublicationSource,
} from "./github-repository-publication-workspace.js";
import { repositoryGitHubPublicationDigest } from "./github-repository-publication.kernel.js";
import type { prepareRepositoryGitHubPublicationTarget } from "./github-repository-target.js";
import type { WorkerSessionTurnClaim } from "./worker-environments/placement-store.js";

/** Admission shares the existing checkpoint, disk custody, and immutable request owners. */
export function createRepositoryPublicationAdmission(
  params: Pick<
    Parameters<typeof createRepositoryGitHubPublicationExecution>[0],
    "prepareSource" | "assertCurrent"
  > & {
    disk?: RepositoryDiskPublicationSource;
    projectResult: (
      row: RepositoryGitHubPublicationRow,
    ) => ReturnType<typeof projectGitHubPublicationResult>;
  },
) {
  const { prepareSource, projectResult: projectGitHubPublicationResult } = params;
  const makeRow = async (input: {
    session: SessionIdentity;
    workspace: SessionRepositoryWorkspaceRecord;
    request: { idempotencyKey: string; title?: string; body?: string; draft?: boolean };
    identity: PreparedGitHubPublicationIdentity;
    target: Awaited<ReturnType<typeof prepareRepositoryGitHubPublicationTarget>>;
    action?: PersonalGitHubSessionActionV2;
    generation?: string;
    claim?: WorkerSessionTurnClaim;
    requesterAuthorityJson: string | null;
    origin?: GitHubPublicationOrigin;
  }): Promise<RepositoryGitHubPublicationRow> => {
    const { head: previous } = await readRepositoryGitHubPublicationBranchAsync({
      workspaceId: input.workspace.workspaceId,
      branch: input.workspace.branch,
      pushRepository: input.target.pushRepository,
    });
    if (
      input.action &&
      previous?.pull_request_url &&
      (previous.owner_profile_id !== input.action.owner ||
        previous.identity_account_id !== input.identity.account.accountId)
    ) {
      throw new Error("This branch already has a PR; preserve its original publisher.");
    }
    const now = Date.now();
    const row: RepositoryGitHubPublicationRow = {
      request_id: input.origin
        ? deriveGitHubPublicationTaskId(input.origin, input.request.idempotencyKey)
        : randomUUID(),
      idempotency_key: input.request.idempotencyKey,
      request_digest: "",
      session_id: input.session.sessionId,
      session_lifecycle_revision: input.session.lifecycleRevision ?? null,
      session_key: input.session.sessionKey,
      agent_id: input.session.agentId,
      workspace_id: input.workspace.workspaceId,
      owner_profile_id: input.action?.owner ?? null,
      connection_generation: input.generation ?? null,
      identity_source: input.identity.source,
      identity_profile_id: input.identity.profileId ?? null,
      identity_account_id: input.identity.account.accountId,
      identity_login: input.identity.account.login,
      requester_authority_json: input.requesterAuthorityJson,
      title: input.request.title ?? null,
      body: input.request.body ?? null,
      draft: input.request.draft ? 1 : 0,
      push_repository: previous?.push_repository ?? input.target.pushRepository,
      repository: previous?.repository ?? input.target.repository,
      base_branch: previous?.base_branch ?? input.target.baseBranch,
      branch: input.workspace.branch,
      previous_head_commit: previous?.pushed_head_commit ?? null,
      claim_id: input.claim?.claimId ?? null,
      run_id: input.claim?.runId ?? null,
      environment_id: input.claim?.owner.environmentId ?? null,
      owner_epoch: input.claim?.owner.ownerEpoch ?? null,
      placement_generation: input.claim?.placementGeneration ?? null,
      checkpoint_ref: null,
      checkpoint_digest: null,
      source_head_commit: null,
      source_index_tree: null,
      workspace_tree: null,
      status: "requested",
      execution_id: null,
      gateway_instance_id: null,
      head_commit: null,
      pushed_head_commit: null,
      pull_request_url: null,
      last_effect: null,
      effect_state: null,
      error_code: null,
      next_action: null,
      created_at_ms: now,
      updated_at_ms: now,
      reported_at_ms: null,
    };
    row.request_digest = repositoryGitHubPublicationDigest(row);
    return row;
  };
  const bindIdleCheckpoint = async (
    row: RepositoryGitHubPublicationRow,
    requester: Pick<GitHubPublicationRequesterPolicyV2, "assertCurrent" | "prepareSource">,
    assertReservation: () => void,
  ) => {
    const assertCurrent = () => {
      assertReservation();
      requester.assertCurrent();
    };
    assertCurrent();
    if (row.checkpoint_ref) {
      return row;
    }
    const session = {
      sessionId: row.session_id,
      sessionKey: row.session_key,
      agentId: row.agent_id,
      lifecycleRevision: row.session_lifecycle_revision,
    };
    const owner = await prepareRepositoryOwner(session);
    using _ = { [Symbol.dispose]: () => owner.release() };
    assertCurrent();
    const workspace = owner().workspace;
    if (row.owner_profile_id === null && !workspace.diskAuthority && !workspace.checkpointRef) {
      return projectGitHubPublicationResult(row);
    }
    const authority = {
      assertAction: assertCurrent,
      assertCustody: params.assertCurrent,
      prepareSource: () =>
        prepareSource(requester, {
          ...session,
          repositoryWorkspaceId: row.workspace_id,
          repositoryBranch: row.branch,
          ...(row.owner_profile_id === null
            ? {}
            : { personalOwnerProfileId: row.owner_profile_id }),
        }),
    };
    return await captureCheckpoint(
      row,
      assertCurrent,
      (facts, prepared) =>
        bindRepositoryGitHubPublicationCheckpointAsync(row, facts, prepared.authority),
      authority,
      params.disk,
    );
  };
  return { makeRow, bindIdleCheckpoint };
}
