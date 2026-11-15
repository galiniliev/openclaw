import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { resolveRepository } from "../agents/worktrees/repository-paths.js";
import type { CreateManagedWorktreeParams } from "../agents/worktrees/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectCheckoutGitEnvironment } from "../projects/project-clone-runtime.js";
import { parseConfiguredProjectGitUrl } from "../projects/project-git-url.runtime.js";
import { githubApiToken } from "./github-public-api.js";
import { prepareGatewayProjectGitHubIdentity } from "./project-github-identity.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

/** Creation and deferred preparation borrow the same request-owned Git identity. */
export async function prepareSessionProjectGitAccess(params: {
  cfg: OpenClawConfig;
  context: Pick<GatewayRequestContext, "getRuntimeConfig">;
  client?: GatewayClient | null;
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  /** Already normalized clone intent, when creation also materializes a project. */
  gitUrl?: string;
  workspace?: string;
  projectId?: string;
  baseRef?: string;
  checkoutCommit?: string;
  assertCurrent: () => void;
}) {
  params.assertCurrent();
  const url =
    params.gitUrl ??
    (params.workspace && params.projectId && !params.baseRef && !params.checkoutCommit
      ? parseConfiguredProjectGitUrl((await resolveRepository(params.workspace)).originUrl)?.url
      : undefined);
  params.assertCurrent();
  if (!url) {
    return undefined;
  }
  const configuredToken = githubApiToken(process.env, params.cfg);
  const identity = await prepareGatewayProjectGitHubIdentity({
    agentId: params.agentId,
    config: params.cfg,
    context: params.context,
    client: params.client,
    assertActive: params.assertCurrent,
    requestedRepository: new URL(url).pathname.slice(1).replace(/\.git$/u, ""),
    repositoryCredential: {
      assertCurrent: params.assertCurrent,
      claim: {
        purpose: "session-create-project",
        binding: {
          kind: "session-create",
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          requestDigest: sha256Hex(url),
        },
      },
    },
  });
  const token = identity?.token ?? configuredToken;
  const gitNetwork: CreateManagedWorktreeParams["gitNetwork"] = token
    ? {
        env: projectCheckoutGitEnvironment(url, token, process.env),
        startRun: identity?.start,
      }
    : undefined;
  return {
    token,
    gitNetwork,
    startRun: identity?.start,
    assertCurrent: () => {
      params.assertCurrent();
      identity?.assertSelected();
    },
    [Symbol.asyncDispose]: async () => {
      await identity?.revoke?.();
    },
  };
}
