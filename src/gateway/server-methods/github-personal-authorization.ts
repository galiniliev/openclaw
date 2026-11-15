import {
  assertAdmittedRunOperatorAuthority,
  getAdmittedRunSource,
} from "../../agents/admitted-run-context.js";
import { requesterCreatorProfileId } from "../../agents/requester-origin.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  resolveGatewayPersonalToolParticipant,
} from "../../agents/tools/gateway-caller-context.js";
import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActiveAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { prepareUserProfileRolePolicyAuthority } from "../../state/user-channel-identity-operations.js";
import { captureResidentUserProfileAccess } from "../../state/user-profile-list.js";
import type { PersonalGitHubAction } from "../github-personal-oauth.js";
import type { PersonalGitHubSessionActionV2 } from "../github-personal-publication.js";
import {
  currentGitHubPublicationConfig,
  prepareGitHubPublicationSession,
} from "../github-publication-availability.js";
import { GitHubPublicationSessionChangedError } from "../github-publication-failure.js";
import { prepareGitHubPublicationRequesterV2 } from "../github-publication-requester.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import type { SessionMutationTarget } from "../session-mutation-authorization-error.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { prepareSessionSharingRead } from "../session-sharing-target-read.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import {
  hasCurrentPersonalGatewaySource,
  isSyntheticGatewayCaller,
} from "./gateway-personal-caller.js";
import {
  currentPersonalProfileClient,
  currentPersonalProfileClientWithSource,
  preparePersonalProfileAction,
} from "./personal-profile-authorization.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type Request = Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">;

type PersonalPublicationToolSource = PersonalGitHubAction & { signal: AbortSignal };

/** Publication alone may use the host's current single-human tool participant. */
function capturePersonalPublicationToolSource(
  options: Request,
): PersonalPublicationToolSource | undefined {
  if (!isSyntheticGatewayCaller(options.client)) {
    return undefined;
  }
  const client = options.client;
  const caller = getGatewayToolCallerIdentity();
  const runtime = client?.internal?.agentRuntimeIdentity;
  const participant = resolveGatewayPersonalToolParticipant(runtime, {
    requireSingleParticipant: true,
  });
  if (!participant) {
    return undefined;
  }
  const authority = client?.internal?.operatorRunAuthority;
  const assertTool = captureGatewayToolCallerAssertion();
  const run = runtime?.operationalRunInstance ?? caller?.operationalRunInstance;
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    participant.assertCurrent();
    assertAdmittedRunOperatorAuthority(authority);
    assertAdmittedRunOperatorAuthority(participant.operatorAuthority);
    authority.assertCurrent();
    assertTool?.();
    if (
      !client ||
      client.invalidated ||
      client.connectionSignal?.aborted ||
      (!runtime && !assertTool) ||
      getAdmittedRunSource(
        run ? getActiveAgentRunDelegatedAuthority(run) : caller?.approvalAuthority,
      ) ||
      runtime?.cronCreatorAuthorityGrant ||
      caller?.cronCreatorAuthorityGrant ||
      authority.source !== participant.operatorAuthority.source ||
      authority.profileId !== participant.profileId ||
      client.internal?.operatorRunAuthority !== authority ||
      requesterCreatorProfileId(participant.requesterOrigin) !== participant.profileId
    ) {
      throw new Error(
        "Publish as me requires the current requesting human; ask in a new signed-in turn.",
      );
    }
  };
  assertCurrent();
  return {
    owner: participant.profileId,
    assertCurrent,
    signal: AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      ...(authority?.signal ? [authority.signal] : []),
      ...(client?.connectionSignal ? [client.connectionSignal] : []),
    ]),
  };
}

function currentGitHubClient(
  options: Request,
  scope: Parameters<typeof currentPersonalProfileClient>[1],
  owner?: Parameters<typeof currentPersonalProfileClient>[2],
  toolSource?: PersonalPublicationToolSource,
) {
  return toolSource
    ? currentPersonalProfileClientWithSource(options, scope, owner, toolSource.assertCurrent)
    : currentPersonalProfileClient(options, scope, owner);
}

type PersonalEligibility =
  | { kind: "eligible"; action: PersonalGitHubAction }
  | { kind: "absent" | "ineligible" };

type OptionsSessionFlight = {
  pending: ReturnType<typeof prepareGitHubPublicationSession>;
  readers: number;
};
const optionsSessionFlights = new WeakMap<OpenClawConfig, Map<string, OptionsSessionFlight>>();

/** Share only pending durable preparation; every caller retains its own live authority. */
async function prepareOptionsSession(
  sessionKey: string,
  agentId: string | undefined,
  assertCurrent: () => void,
) {
  assertCurrent();
  const cfg = currentGitHubPublicationConfig();
  // Memory actors belong to the caller's storage context.
  if (isIncognitoSessionKey(sessionKey)) {
    return prepareGitHubPublicationSession(sessionKey, { agentId, cfg, assertCurrent });
  }
  let flights = optionsSessionFlights.get(cfg);
  if (!flights) {
    flights = new Map();
    optionsSessionFlights.set(cfg, flights);
  }
  const key = JSON.stringify([getRuntimeConfigSnapshotMetadata()?.revision, agentId, sessionKey]);
  let flight = flights.get(key);
  if (!flight) {
    flight = {
      pending: prepareGitHubPublicationSession(sessionKey, { agentId, cfg }).finally(() => {
        flights.delete(key);
      }),
      readers: 0,
    };
    flights.set(key, flight);
  }
  const selected = flight;
  selected.readers++;
  const session = await selected.pending;
  let active = true;
  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    if (--selected.readers === 0) {
      session.release();
    }
  };
  try {
    assertCurrent();
    return {
      readCurrent: () => {
        if (!active) {
          throw new GitHubPublicationSessionChangedError();
        }
        return session.readCurrent();
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Shared reads do not require a person; absence never substitutes for failed authentication. */
export async function prepareGitHubPublicationOptionsRead(
  options: Request &
    Pick<
      GatewayRequestHandlerOptions,
      "req" | "hasCurrentClientAuthority" | "sessionMutationCommitGuard"
    >,
  { sessionKey, agentId: requestedAgentId }: SessionMutationTarget,
  signal?: AbortSignal,
  purpose: "options" | "shared-observation" = "options",
) {
  const toolSource =
    purpose === "options" ? capturePersonalPublicationToolSource(options) : undefined;
  const authority = readGatewayRequestMutationAuthority(options);
  const client = options.client;
  const profileReference = client?.authenticatedUserProfile?.profileId;
  const userId = client?.authenticatedUserId;
  const access = client?.internal?.operatorAccessAuthority;
  const credentialSource = client?.authenticatedRepositoryCredentialSource;
  const assertConnection = () => {
    signal?.throwIfAborted();
    authority.assertCurrent();
    if (
      client?.authenticatedUserProfile?.profileId !== profileReference ||
      client?.authenticatedUserId !== userId ||
      client?.internal?.operatorAccessAuthority !== access ||
      client?.authenticatedRepositoryCredentialSource !== credentialSource
    ) {
      throw new Error("GitHub profile changed; retry publication options.");
    }
  };
  assertConnection();
  currentGitHubClient(options, "operator.sessions.read", undefined, toolSource);
  const personalProfile = toolSource?.owner ?? profileReference;
  const profile = personalProfile
    ? await prepareUserProfileRolePolicyAuthority(personalProfile)
    : undefined;
  assertConnection();
  if (profileReference && !profile) {
    throw new Error("Authenticated profile verification is unavailable; retry the request.");
  }
  const currentClient = () => {
    assertConnection();
    if (profile && !profile.isCurrent()) {
      throw new Error("GitHub profile changed; retry publication options.");
    }
    return currentGitHubClient(options, "operator.sessions.read", profile, toolSource);
  };
  const eligibleClient = currentClient();
  const personal: PersonalEligibility =
    purpose === "shared-observation" ||
    !eligibleClient ||
    (!toolSource && !hasCurrentPersonalGatewaySource(options.client, options.context)) ||
    !operatorScopeSatisfied("operator.read", eligibleClient.connect.scopes ?? [])
      ? { kind: "ineligible" }
      : !profile
        ? { kind: "absent" }
        : {
            kind: "eligible",
            action: toolSource
              ? {
                  ...toolSource,
                  assertCurrent: () => {
                    toolSource.assertCurrent();
                    currentClient();
                  },
                }
              : preparePersonalGitHubAction(options, signal),
          };
  const preparedSession =
    purpose === "shared-observation"
      ? await prepareGitHubPublicationSession(sessionKey, {
          agentId: requestedAgentId,
          assertCurrent: currentClient,
          // Workspace changes belong to source observation, not disclosure authority.
          fields: [
            "sessionId",
            "lifecycleRevision",
            "owner",
            "createdActor",
            "visibility",
            "incognito",
          ],
        })
      : await prepareOptionsSession(sessionKey, requestedAgentId, currentClient);
  let sharing: Awaited<ReturnType<typeof prepareSessionSharingRead>> | undefined;
  const release = () => {
    sharing?.release();
    preparedSession.release();
  };
  try {
    const initialCfg = options.context.getRuntimeConfig();
    if (operatorSessionCap(currentClient(), initialCfg) === "invited") {
      const loaded = preparedSession.readCurrent();
      sharing = await prepareSessionSharingRead({
        cfg: initialCfg,
        sessionKey,
        agentId: loaded.agentId,
      });
    }
    const readSession = () => {
      const current = currentClient();
      const loaded = preparedSession.readCurrent();
      const cfg = options.context.getRuntimeConfig();
      const sharingRead = sharing?.readCurrent(cfg);
      const target = sharingRead?.target;
      // Separately prepared membership must authorize the retained publication target.
      if (
        sharingRead &&
        (!target ||
          target.agentId !== loaded.agentId ||
          target.canonicalKey !== loaded.canonicalKey ||
          target.storePath !== loaded.storePath ||
          target.entry.sessionId !== loaded.entry?.sessionId ||
          target.entry.lifecycleRevision !== loaded.entry?.lifecycleRevision)
      ) {
        throw new GitHubPublicationSessionChangedError();
      }
      const filter = createSessionListEntryFilter({
        cfg,
        client: current,
        membership: sharingRead?.membership,
      });
      return loaded.entry && filter?.(loaded.canonicalKey, loaded.entry) !== false
        ? {
            sessionId: loaded.entry.sessionId,
            sessionKey: loaded.canonicalKey,
            agentId: loaded.agentId,
            lifecycleRevision: loaded.entry.lifecycleRevision ?? null,
            archivedAt: loaded.entry.archivedAt ?? null,
          }
        : null;
    };
    const session = readSession();
    if (!session) {
      throw new Error("GitHub publication session was not found.");
    }
    // Archive and access changes invalidate the prepared response through write receipts.
    const readCurrent = () => {
      const current = readSession();
      if (
        !current ||
        current.sessionId !== session.sessionId ||
        current.lifecycleRevision !== session.lifecycleRevision
      ) {
        throw new Error("GitHub publication session access changed; select the session again.");
      }
      return current;
    };
    return {
      personal,
      session,
      release,
      [Symbol.dispose]: release,
      sessionScoped: authority.sessionScope === "operator.sessions.read",
      currentSession: readCurrent,
      currentSessionRead: () => {
        readCurrent();
        return preparedSession.readCurrent();
      },
      // Callbacks may refresh live facts, but must not replace the response's archive snapshot.
      assertSessionUnchanged: (snapshot: ReturnType<typeof readCurrent>): void => {
        const current = readCurrent();
        if (current.archivedAt !== snapshot.archivedAt) {
          throw new Error("GitHub publication session access changed; select the session again.");
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Authority stays in this direct connection closure; a profile or request id alone grants nothing. */
function preparePersonalGitHubAction(options: Request, signal?: AbortSignal): PersonalGitHubAction {
  const { client, context } = options;
  const resolveOwner = () => {
    signal?.throwIfAborted();
    if (!hasCurrentPersonalGatewaySource(client, context) || options.signal?.aborted) {
      throw new Error("My GitHub requires a current authenticated human Gateway connection.");
    }
    const profile = client.authenticatedUserProfile?.profileId;
    if (!profile) {
      throw new Error("My GitHub requires a verified durable user profile; sign in and try again.");
    }
    const current = captureResidentUserProfileAccess(profile).assertCurrent();
    if (current.merged_into) {
      throw new Error("My GitHub requires a verified durable user profile; sign in and try again.");
    }
    currentGitHubClient(options, "operator.read", {
      profileId: current.id,
      role: current.role ?? null,
      githubLogin: current.githubLogin,
    });
    return current.id;
  };
  const owner = resolveOwner();
  return {
    owner,
    assertCurrent: () => {
      if (resolveOwner() !== owner) {
        throw new Error("My GitHub owner changed; retry from your current profile.");
      }
    },
  };
}

async function bindPersonalGitHubSessionAction(
  options: Request,
  action: PersonalGitHubAction,
  target: SessionMutationTarget,
  toolSource?: PersonalPublicationToolSource,
) {
  const prepared = await prepareGitHubPublicationSession(target.sessionKey, {
    agentId: target.agentId,
    assertCurrent: action.assertCurrent,
    fields: [
      "sessionId",
      "lifecycleRevision",
      "archivedAt",
      "owner",
      "createdActor",
      "visibility",
      "incognito",
      ...(toolSource ? ["worktree" as const] : []),
    ],
  });
  let releaseAuthorization = () => {};
  try {
    const initial = prepared.readCurrent();
    if (!initial.entry?.sessionId) {
      throw new Error("GitHub publication session was not found.");
    }
    const { authorization, error } = await resolveSessionMutationAuthorizationAsync({
      client: currentGitHubClient(options, "operator.write", action.owner, toolSource),
      method: "sessions.github.publish",
      requestParams: { sessionKey: initial.canonicalKey, agentId: initial.agentId },
      context: options.context,
      assertInvocationCurrent: action.assertCurrent,
    });
    releaseAuthorization = () => authorization?.release?.();
    if (error) {
      throw new Error(error.message);
    }
    const assertCurrent = () => {
      action.assertCurrent();
      currentGitHubClient(options, "operator.write", action.owner, toolSource);
      const current = prepared.readCurrent();
      if (toolSource && current.entry?.worktree?.githubPullRequest) {
        throw new Error(
          "This workspace is bound to an existing PR; keep its original publisher and use the existing PR actions.",
        );
      }
      if (current.entry?.archivedAt !== undefined) {
        throw new GitHubPublicationSessionChangedError();
      }
      authorization?.assertCurrent();
    };
    assertCurrent();
    return {
      action: {
        ...action,
        assertCurrent,
        sessionId: initial.entry.sessionId,
        lifecycleRevision: initial.entry.lifecycleRevision ?? null,
        sessionKey: initial.canonicalKey,
        agentId: initial.agentId,
      },
      release: () => {
        releaseAuthorization();
        prepared.release();
      },
    };
  } catch (error) {
    releaseAuthorization();
    prepared.release();
    throw error;
  }
}

/** Retain the authenticated policy owner for worker commits as well as immediate effects. */
export async function preparePersonalGitHubSessionActionV2(
  options: Request & Parameters<typeof prepareGitHubPublicationRequesterV2>[0],
  target: SessionMutationTarget,
): Promise<{ action: PersonalGitHubSessionActionV2; release: () => void }> {
  const toolSource = capturePersonalPublicationToolSource(options);
  const personal = toolSource ?? (await preparePersonalProfileAction(options, "operator.write"));
  const bound = await bindPersonalGitHubSessionAction(options, personal, target, toolSource);
  const { action } = bound;
  try {
    const admitted = await prepareGitHubPublicationRequesterV2(options, action);
    try {
      action.assertCurrent();
      return {
        action: {
          ...action,
          version: 2,
          requester: admitted.requester,
          ...(toolSource
            ? {
                expectedRunId:
                  getGatewayToolCallerIdentity()?.operationalRunInstance?.runId ??
                  options.client?.internal?.agentRuntimeIdentity?.operationalRunInstance.runId,
              }
            : {}),
          signal: admitted.requester.signal,
          prepareDispatchCredential: admitted.requester.prepareDispatchCredential,
          prepareSource: (selector) => {
            action.assertCurrent();
            return admitted.requester.prepareSource({
              ...selector,
              personalOwnerProfileId: action.owner,
            });
          },
        },
        release: () => {
          admitted.release();
          bound.release();
        },
      };
    } catch (error) {
      admitted.release();
      throw error;
    }
  } catch (error) {
    bound.release();
    throw error;
  }
}
