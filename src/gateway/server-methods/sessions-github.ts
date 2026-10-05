import {
  ErrorCodes,
  type GatewayCoreRequestParams,
  errorShape,
  validateSessionGitHubPublishParams,
  validateSessionGitHubPullRequestReadParams,
  validateSessionGitHubOptionsParams,
  validateSessionGitHubStatusParams,
  validateSessionGitHubConfirmParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveGitHubHost } from "../../agents/github-host-runtime.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { OpenClawStateLeaseAcquisitionError } from "../../state/openclaw-state-lease-error.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { prepareControlUiSessionPrRead } from "../control-ui-session-pr-read.js";
import {
  factoryPublicationPreflightCredential,
  prepareCurrentGitHubPublicationOptionsIdentity,
  hasSupportedGitHubPublicationTarget,
  type PublicationSessionIdentity,
} from "../github-publication-availability.js";
import { GitHubPublicationKnownFailure } from "../github-publication-failure.js";
import { isGitHubPublicationSuperseded } from "../github-publication-relevance.js";
import { captureGitHubPublicationRequester } from "../github-publication-requester.js";
import { readBoundGitHubPullRequest } from "../github-pull-request-read.js";
import { parseGitHubRemoteUrl } from "../github-remote.js";
import { prepareGatewayProjectGitHubIdentity } from "../project-github-identity.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { SessionWorkspaceReservationBusyError } from "../worker-environments/placement-workspace-reservation.kernel.js";
import {
  prepareGitHubPublicationOptionsRead,
  preparePersonalGitHubSessionAction,
} from "./github-personal-authorization.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

type SessionGitHubMethod = Extract<keyof GatewayCoreRequestParams, `sessions.github.${string}`>;
const sessionGitHubFailureMessages = {
  "sessions.github.publish": "GitHub publication request failed",
  "sessions.github.pullRequest.read": "GitHub pull request read failed",
  "sessions.github.options": "GitHub publication options are unavailable.",
  "sessions.github.status": "GitHub publication status is unavailable.",
  "sessions.github.confirm": "GitHub publication confirmation failed.",
};

function defineSessionGitHubMethod<Method extends SessionGitHubMethod>(
  ...[method, validate, handler]: Parameters<typeof defineValidatedGatewayMethod<Method>>
) {
  return defineValidatedGatewayMethod(method, validate, async (options) => {
    const { agentId, sessionKey } = options.params;
    const key = sessionKey ?? getGatewayToolCallerIdentity()?.sessionKey;
    // Explicit public owners follow request admission, not private deleted-session remapping.
    if (agentId !== undefined && key) {
      const owner = resolveRequestedSessionAgentId(
        options.context.getRuntimeConfig(),
        key,
        agentId,
      );
      if (!owner.ok) {
        options.respond(false, undefined, owner.error);
        return;
      }
    }
    try {
      return await handler(options);
    } catch (error) {
      const publishing = method === "sessions.github.publish";
      if (publishing && error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      const acquisition =
        error instanceof OpenClawStateLeaseAcquisitionError ? error.outcome : undefined;
      const busy = error instanceof SessionWorkspaceReservationBusyError;
      const forbidden = acquisition ? acquisition.kind === "held" : !publishing && !busy;
      options.respond(
        false,
        undefined,
        errorShape(
          forbidden ? ErrorCodes.FORBIDDEN : ErrorCodes.UNAVAILABLE,
          error instanceof Error ? error.message : sessionGitHubFailureMessages[method],
          acquisition
            ? {
                retryable: acquisition.kind === "store-unavailable",
                details: { leaseAcquisition: acquisition },
              }
            : busy
              ? { retryable: true }
              : publishing &&
                  error instanceof GitHubPublicationKnownFailure &&
                  "idempotencyKey" in options.params &&
                  error.rejection?.idempotencyKey === options.params.idempotencyKey
                ? { details: error.rejection }
                : undefined,
        ),
      );
    }
  });
}

async function isSessionPublicationSuperseded(
  options: Pick<GatewayRequestHandlerOptions, "client" | "context">,
  session: PublicationSessionIdentity,
  snapshot: Parameters<typeof isGitHubPublicationSuperseded>[0],
  assertCurrent: () => void,
): Promise<boolean> {
  const { client, context } = options;
  const prOwner = context.controlUiSessionPullRequests;
  if (!client || !prOwner) {
    return false;
  }
  const readTarget = await prepareControlUiSessionPrRead({
    client,
    sessionKey: session.sessionKey,
    agentId: session.agentId,
    getRuntimeConfig: context.getRuntimeConfig,
    getSessionRowProjection: () => getSessionRowProjection(context),
    isCurrentClient: () => {
      assertCurrent();
      return true;
    },
  });
  assertCurrent();
  const target = await readTarget?.();
  assertCurrent();
  if (!target) {
    return false;
  }
  const assertReadCurrent = () => {
    assertCurrent();
    target.assertCurrent?.();
  };
  const published = await prOwner.read(target, assertReadCurrent, "publication");
  assertReadCurrent();
  return published.status === "ready" && !published.rateLimited
    ? isGitHubPublicationSuperseded(snapshot, published.pullRequests, {
        assertCurrent: assertReadCurrent,
      })
    : false;
}

export const sessionsGitHubHandlers: GatewayRequestHandlers = {
  "sessions.github.pullRequest.read": defineSessionGitHubMethod(
    "sessions.github.pullRequest.read",
    validateSessionGitHubPullRequestReadParams,
    async (options) => {
      const caller = getGatewayToolCallerIdentity();
      if (
        !caller?.sessionKey ||
        !caller.agentId ||
        caller.sessionKey !== options.params.sessionKey ||
        (options.params.agentId &&
          normalizeAgentId(options.params.agentId) !== normalizeAgentId(caller.agentId))
      ) {
        throw new Error("GitHub pull request reads require the current repository session.");
      }
      const assertCallerCurrent = captureGatewayToolCallerAssertion();
      if (!assertCallerCurrent) {
        throw new Error("GitHub pull request reads require an admitted Gateway run.");
      }
      assertCallerCurrent("sessions.github.pullRequest.read");
      const admitted = loadGatewaySessionEntryReadOnly(caller.sessionKey, {
        agentId: caller.agentId,
      });
      const admittedWorkspaceId = admitted.entry?.repositoryWorkspaceId;
      if (!admittedWorkspaceId) {
        throw new Error("The repository session is no longer bound to this run.");
      }
      const preparedWorkspace =
        await getSessionRepositoryWorkspaceStore().prepare(admittedWorkspaceId);
      const currentRepository = () => {
        assertCallerCurrent("sessions.github.pullRequest.read");
        const loaded = loadGatewaySessionEntryReadOnly(caller.sessionKey, {
          agentId: caller.agentId,
        });
        const workspaceId = loaded.entry?.repositoryWorkspaceId;
        const workspace =
          workspaceId === admittedWorkspaceId ? preparedWorkspace.current() : undefined;
        if (
          loaded.canonicalKey !== caller.sessionKey ||
          loaded.agentId !== caller.agentId ||
          !loaded.entry?.sessionId ||
          !workspace ||
          workspace.agentId !== caller.agentId ||
          workspace.sessionKey !== caller.sessionKey
        ) {
          throw new Error("The repository session is no longer bound to this run.");
        }
        const target = parseGitHubRemoteUrl(workspace.url, resolveGitHubHost());
        if (!target) {
          throw new Error("The repository session is not bound to the configured GitHub host.");
        }
        return { workspaceId, workspace, target };
      };
      const initial = currentRepository();
      const assertRepositoryCurrent = () => {
        const current = currentRepository();
        if (
          current.workspaceId !== initial.workspaceId ||
          current.workspace.url !== initial.workspace.url
        ) {
          throw new Error("The repository session changed while reading the pull request.");
        }
      };
      const identity = await prepareGatewayProjectGitHubIdentity({
        agentId: caller.agentId,
        assertActive: assertRepositoryCurrent,
        config: options.context.getRuntimeConfig(),
        context: options.context,
      });
      if (!identity) {
        throw new Error("Authenticated repository reads are unavailable on this Gateway.");
      }
      const result = await identity.start(() =>
        readBoundGitHubPullRequest({
          target: { ...initial.target, number: options.params.pullRequest },
          identity,
        }),
      );
      identity.assertSelected();
      const current = currentRepository();
      if (
        current.workspaceId !== initial.workspaceId ||
        current.workspace.url !== initial.workspace.url ||
        current.workspace.sessionKey !== initial.workspace.sessionKey
      ) {
        throw new Error("The repository session changed while reading the pull request.");
      }
      options.respond(true, result);
    },
  ),
  "sessions.github.publish": defineSessionGitHubMethod(
    "sessions.github.publish",
    validateSessionGitHubPublishParams,
    async (options) => {
      const { params, respond, context, sessionMutationAuthorization } = options;

      const coordinator = context.githubPublicationService;
      if (!coordinator) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "GitHub publication is unavailable on this Gateway"),
        );
        return;
      }
      const caller = getGatewayToolCallerIdentity();
      const sessionKey = caller?.sessionKey ?? params.sessionKey;
      if (
        !sessionKey ||
        (caller && params.sessionKey && params.sessionKey !== caller.sessionKey) ||
        (caller &&
          params.agentId &&
          normalizeAgentId(params.agentId) !== normalizeAgentId(caller.agentId))
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "GitHub publication session is invalid"),
        );
        return;
      }
      const agentId = caller?.agentId ?? params.agentId;
      if (params.selection?.source === "personal") {
        if (!params.sessionKey) {
          throw new Error("My GitHub publication requires an explicit session.");
        }
        const action = preparePersonalGitHubSessionAction(options, {
          sessionKey: params.sessionKey,
          agentId,
        });
        const result = await coordinator.requestPersonalForSession(params, action);
        action.assertCurrent();
        respond(true, result);
        return;
      }
      const loaded = loadGatewaySessionEntryReadOnly(sessionKey, agentId ? { agentId } : undefined);
      if (!loaded.entry?.sessionId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "GitHub publication session was not found"),
        );
        return;
      }
      sessionMutationAuthorization?.assertCurrent();
      const session = {
        sessionKey: loaded.canonicalKey,
        agentId: caller?.agentId ?? loaded.agentId,
      };
      const admitted = await captureGitHubPublicationRequester(options, session);
      try {
        const result = await coordinator.requestForSession({
          ...params,
          ...session,
          requester: admitted.requester,
          ...(caller?.operationalRunInstance?.runId
            ? { expectedRunId: caller.operationalRunInstance.runId }
            : {}),
        });
        sessionMutationAuthorization?.assertCurrent();
        respond(true, result);
      } finally {
        admitted.release();
      }
    },
  ),
  "sessions.github.options": defineSessionGitHubMethod(
    "sessions.github.options",
    validateSessionGitHubOptionsParams,
    async (options) => {
      const read = await prepareGitHubPublicationOptionsRead(options, options.params);
      const coordinator = options.context.githubPublicationService;
      if (!coordinator) {
        options.respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "GitHub publication state is unavailable; retry after Gateway startup.",
          ),
        );
        return;
      }
      let shared = null;
      try {
        const admitted =
          process.env.FACTORY_AUTH_MODE === "github"
            ? await captureGitHubPublicationRequester(options, read.session)
            : undefined;
        try {
          const profileId =
            admitted?.requester.snapshot.actor.kind === "operator"
              ? admitted.requester.snapshot.actor.profileId
              : options.client?.authenticatedUserProfile?.profileId;
          const identity = await prepareCurrentGitHubPublicationOptionsIdentity(
            read.session.agentId,
            profileId
              ? {
                  profileId,
                  sessionKey: read.session.sessionKey,
                  assertCurrent: () => {
                    admitted?.requester.assertCurrent();
                    read.currentSession();
                  },
                }
              : undefined,
            admitted
              ? factoryPublicationPreflightCredential({
                  ...read.session,
                  assertCurrent: () => {
                    admitted.requester.assertCurrent();
                    read.currentSession();
                  },
                })
              : undefined,
          );
          shared = {
            source: identity.source,
            accountId: identity.account.accountId,
            login: identity.account.login,
          };
        } finally {
          admitted?.release();
        }
      } catch {
        /* An unavailable shared account must not hide the caller's personal option. */
      }
      read.currentSession();
      const service = options.context.githubOAuthService?.personal;
      if (read.personal.kind === "eligible" && !service) {
        throw new Error("GitHub connections are unavailable; retry after Gateway startup.");
      }
      const action = read.personal.kind === "eligible" ? read.personal.action : null;
      let personal = action ? await service!.status(action) : null;
      const session = read.currentSession();
      const assertResponseCurrent = () => read.assertSessionUnchanged(session);
      const pendingPersonal = action ? await coordinator.personalPending(action, session) : null;
      assertResponseCurrent();
      if (action && personal) {
        personal = service!.revalidateStatus(action, personal);
      }
      const latestShared = await coordinator.latestShared(
        session,
        options.params.idempotencyKey,
        (snapshot) =>
          isSessionPublicationSuperseded(options, session, snapshot, assertResponseCurrent),
      );
      assertResponseCurrent();
      if (action && personal) {
        personal = service!.revalidateStatus(action, personal);
      }
      if (shared && read.sessionScoped) {
        if (!(await hasSupportedGitHubPublicationTarget(session, assertResponseCurrent))) {
          shared = null;
        }
        assertResponseCurrent();
      }
      options.respond(true, { personal, shared, pendingPersonal, latestShared });
    },
  ),
  "sessions.github.status": defineSessionGitHubMethod(
    "sessions.github.status",
    validateSessionGitHubStatusParams,
    async (options) => {
      const read = await prepareGitHubPublicationOptionsRead(options, options.params);
      const service = options.context.githubPublicationService;
      if (!service) {
        options.respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "GitHub publication state is unavailable; retry after Gateway startup.",
          ),
        );
        return;
      }
      const prepared =
        read.personal.kind === "eligible"
          ? await service.preparePersonalStatus(options.params.requestId)
          : undefined;
      const session = read.currentSession();
      const shared = await service.sharedStatus(session, options.params.requestId);
      if (shared) {
        read.assertSessionUnchanged(session);
        options.respond(true, shared);
        return;
      }
      if (read.personal.kind !== "eligible") {
        throw new Error("GitHub publication was not found for this session and caller.");
      }
      const result = service.personalStatus(
        read.personal.action,
        session,
        options.params.requestId,
        prepared,
      );
      read.assertSessionUnchanged(session);
      options.respond(true, result);
    },
  ),
  "sessions.github.confirm": defineSessionGitHubMethod(
    "sessions.github.confirm",
    validateSessionGitHubConfirmParams,
    async (options) => {
      const action = preparePersonalGitHubSessionAction(options, options.params);
      const service = options.context.githubPublicationService;
      if (!service) {
        throw new Error("GitHub publication is unavailable.");
      }
      const result = await service.confirmPersonal(options.params, action);
      action.assertCurrent();
      options.respond(true, result);
    },
  ),
};
