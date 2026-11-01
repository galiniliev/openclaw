import {
  resolveConfiguredGitHubToolIdentity,
  type PreparedGitHubPublicationIdentity,
} from "../agents/github-tool-identity.js";
import { getRepositoryIntegration } from "../plugins/repository-integration-runtime.js";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import type { GitHubPublicationRequesterSnapshot } from "../state/github-publication-requester.js";
import {
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  currentGitHubPublicationConfig,
} from "./github-publication-availability.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { matchesGitHubPublicationIdentityRow } from "./github-publication-receipt.js";
import type { RepositoryCredentialSource } from "./github-user-identity.types.js";

export class GitHubPublicationAuthorityLostError extends Error {}

export type GitHubPublicationIdentityOwner = {
  prepare: () => Promise<PreparedGitHubPublicationIdentity>;
  isCurrent: (identity: PreparedGitHubPublicationIdentity) => boolean;
};

/** Credentials are a fixed snapshot; live workspace, action, and execution owners authorize use. */
export function createGitHubPublicationExecutionIdentity(params: {
  row: Parameters<typeof matchesGitHubPublicationIdentityRow>[0];
  identity?: GitHubPublicationIdentityOwner;
  validateAuthority: () => boolean;
  assertWorkspace: () => void;
}) {
  let active: PreparedGitHubPublicationIdentity | undefined;
  let closed = false;
  const assertAuthority = () => {
    if (closed || !params.validateAuthority()) {
      throw new GitHubPublicationAuthorityLostError(
        "GitHub publication session authority changed.",
      );
    }
    params.assertWorkspace();
    if (
      active &&
      !(params.identity
        ? params.identity.isCurrent(active)
        : matchesCurrentGitHubPublicationIdentity({
            agentId: params.row.agent_id,
            identity: active,
          }))
    ) {
      throw new Error("GitHub publication identity changed.");
    }
  };
  const assertCurrent = () => {
    assertAuthority();
    if (active?.accessExpiresAtMs !== undefined && active.accessExpiresAtMs <= Date.now()) {
      throw new Error(
        "GitHub publication credential expired; refresh the identity before retrying.",
      );
    }
  };
  return {
    assertCurrent,
    async [Symbol.asyncDispose]() {
      closed = true;
      const previous = active;
      active = undefined;
      await previous?.revoke?.();
    },
    refreshIdentity: async (): Promise<PreparedGitHubPublicationIdentity> => {
      assertAuthority();
      const identity = await (params.identity?.prepare() ??
        prepareCurrentGitHubPublicationIdentity(params.row.agent_id));
      let admitted = false;
      try {
        assertAuthority();
        if (!matchesGitHubPublicationIdentityRow(params.row, identity)) {
          throw new Error("GitHub publication identity changed.");
        }
        const previous = active;
        if (identity.accessExpiresAtMs !== undefined && identity.accessExpiresAtMs <= Date.now()) {
          throw new Error("GitHub publication credential expired.");
        }
        active = identity;
        admitted = true;
        if (previous !== identity) {
          await previous?.revoke?.();
        }
        assertCurrent();
        return identity;
      } finally {
        if (!admitted) {
          if (active === identity) {
            active = undefined;
          }
          await identity.revoke?.();
        }
      }
    },
  };
}

/** Original actor and accepted receipt facts accompany every fresh execution grant. */
export async function prepareGitHubPublicationExecutionIdentity(params: {
  row: Pick<
    GitHubPublicationExecutionRow,
    "agent_id" | "session_key" | "session_id" | "request_id" | "request_digest"
  >;
  actor: GitHubPublicationRequesterSnapshot["actor"] | undefined;
  credentialSource?: RepositoryCredentialSource;
  lifecycleRevision: string | null;
  executionKind: "worktree" | "repository";
  ownerId: string;
  assertCurrent: () => void;
}) {
  const { row, actor, assertCurrent } = params;
  const config = currentGitHubPublicationConfig();
  const selected =
    resolveConfiguredGitHubToolIdentity({ config, agentId: row.agent_id, scope: "agent" }) ??
    resolveConfiguredGitHubToolIdentity({ config, agentId: row.agent_id, scope: "system" });
  try {
    return await prepareCurrentGitHubPublicationIdentity(
      row.agent_id,
      actor?.kind === "operator"
        ? {
            profileId: actor.profileId,
            credentialSource: params.credentialSource,
            sessionKey: row.session_key,
            assertCurrent,
          }
        : undefined,
      {
        claim: {
          purpose: "publication-execution",
          binding: {
            kind: "publication",
            agentId: row.agent_id,
            sessionKey: row.session_key,
            sessionId: row.session_id,
            lifecycleRevision: params.lifecycleRevision,
            executionKind: params.executionKind,
            requestId: row.request_id,
            ownerId: params.ownerId,
            requestDigest: row.request_digest,
          },
        },
        assertCurrent,
      },
    );
  } catch (error) {
    assertCurrent();
    if (selected?.kind === "app-installation" && getRepositoryIntegration(config)) {
      // Accepted work waits for its original policy owner; auth failure never authorizes replay.
      throw new GitHubPublicationRecoveryPendingError(
        "Repository integration identity is unavailable. Retry from the original signed-in account; accepted work is retained.",
      );
    }
    throw error;
  }
}

/** Credential selection and currency use the same accepted publication agent. */
export function createGitHubPublicationExecutionIdentityOwner(
  readParams: () => Parameters<typeof prepareGitHubPublicationExecutionIdentity>[0],
): GitHubPublicationIdentityOwner {
  return {
    prepare: () => prepareGitHubPublicationExecutionIdentity(readParams()),
    isCurrent: (identity) =>
      matchesCurrentGitHubPublicationIdentity({ agentId: readParams().row.agent_id, identity }),
  };
}
