import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { GitHubCredentialReader } from "../agents/github-credential-reader.js";
import { resolveConfiguredGitHubToolIdentity } from "../agents/github-tool-identity.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
} from "../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginGatewayAccessAuthority } from "../plugins/gateway-access-policy.types.js";
import { getRepositoryIntegration } from "../plugins/repository-integration-runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { intersectOperatorScopes, roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  decodeGitHubPublicationRequester,
  encodeGitHubPublicationRequester,
  type GitHubPublicationOrigin,
  type GitHubPublicationRequesterSnapshot,
} from "../state/github-publication-requester.js";
import type { GitHubPublicationSourceSelector } from "../state/github-publication-source.types.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { prepareRequesterPolicy } from "./github-publication-requester-policy.js";
import {
  prepareGitHubPublicationSource,
  type GitHubPublicationSourceCapability,
} from "./github-publication-source.js";
import type { RepositoryCredentialSource } from "./github-user-identity.types.js";
import {
  OpenClawIdPrincipalChangedError,
  openClawIdRecoveryPrincipalSchema,
  prepareOpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { repositoryDispatchCredentialReader } from "./repository-dispatch.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { authorizeIncognitoSessionTarget } from "./session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  SessionMutationRuntimeFactsChangedError,
} from "./session-sharing-preparation.js";

type PublicationSession = { sessionKey: string; agentId: string };
type PreparedProfileIdentity = Awaited<ReturnType<typeof prepareUserProfileIdentity>>;
type PreparedPublicationSession = Awaited<ReturnType<typeof prepareSessionMutationFacts>>;

function assertPublicationIncognitoAccess(
  profileId: string,
  scopes: readonly string[],
  sessionKey: string,
): void {
  const client = createSyntheticPluginRuntimeClient({
    operatorRoleActor: { kind: "operator", profileId },
    scopes: [...scopes],
  });
  if (authorizeIncognitoSessionTarget({ client, sessionKey, target: null })) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
}

async function preparePublicationSession(
  session: PublicationSession,
  config: OpenClawConfig,
): Promise<PreparedPublicationSession> {
  try {
    return await prepareSessionMutationFacts({ cfg: config, ...session });
  } catch (error) {
    throw new GitHubPublicationRecoveryPendingError(
      "GitHub publication session authorization is unavailable; retry after session storage is ready.",
      { cause: error },
    );
  }
}

/** @deprecated Use GitHubPublicationRequesterPolicyV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
export type GitHubPublicationRequesterPolicy = Readonly<{
  snapshot: GitHubPublicationRequesterSnapshot;
  assertCurrent: () => void;
}>;

/** @deprecated Use GitHubPublicationRequesterV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
export type GitHubPublicationRequester = GitHubPublicationRequesterPolicy &
  Readonly<{
    /** An accepted row keeps its own policy while the current invocation retains its fences. */
    assertInvocationCurrent: () => void;
  }>;

/** Prepared host policy and a required live source capability for worker-owned writes. */
export type GitHubPublicationRequesterPolicyV2 = GitHubPublicationRequesterPolicy &
  Readonly<{
    version: 2;
    /** Live invocation only; durable requester snapshots cannot recreate repository admission. */
    prepareDispatchCredential?(input: {
      sessionId: string;
      requestDigest: string;
      assertCurrent: () => void;
    }): GitHubCredentialReader | undefined;
    /** Live invocation source; deliberately absent from durable requester snapshots. */
    repositoryCredentialSource?: RepositoryCredentialSource;
    signal: AbortSignal;
    prepareSource(
      selector: GitHubPublicationSourceSelector,
    ): Promise<GitHubPublicationSourceCapability>;
  }>;
export type RetainedGitHubPublicationRequester = {
  requester: GitHubPublicationRequesterPolicyV2;
  release: () => void;
};
export type GitHubPublicationRequesterV2 = GitHubPublicationRequesterPolicyV2 &
  Pick<GitHubPublicationRequester, "assertInvocationCurrent"> & {
    retainForSettlement?: () => Promise<RetainedGitHubPublicationRequester>;
  };

/** A System-backed tool bridge cannot widen the selected person's action capability. */
export function captureGitHubPublicationActionAuthority(
  requester: GitHubPublicationRequesterPolicyV2,
) {
  const caller = getGatewayToolCallerIdentity();
  const selection = caller ? resolveGatewayToolOperatorSelection() : undefined;
  const scopes = caller
    ? intersectOperatorScopes(requester.snapshot.scopes, selection?.operatorAuthority?.scopes ?? [])
    : requester.snapshot.scopes;
  const operatorWrite = roleScopesAllow({
    role: "operator",
    requestedScopes: ["operator.write"],
    allowedScopes: scopes,
  });
  const assertCurrent = () => {
    requester.assertCurrent();
    selection?.assertCurrent();
  };
  assertCurrent();
  return {
    operatorWrite,
    assertCurrent,
    assertOperatorWrite: () => {
      assertCurrent();
      if (!operatorWrite) {
        throw new Error("GitHub pull request assistance requires full operator write permission.");
      }
    },
  };
}

const workerRequesters = resolveGlobalSingleton(
  Symbol.for("openclaw.githubPublicationWorkerRequesters"),
  () => new WeakMap<GitHubPublicationRequesterPolicy, PublicationSession>(),
);

/** Classify before invoking any released assertion; a failed worker command never selects legacy. */
export function isGitHubPublicationRequesterV2(
  requester: GitHubPublicationRequesterPolicy,
): requester is GitHubPublicationRequesterPolicyV2 {
  return workerRequesters.has(requester);
}

/** Refresh only typed runtime invalidation, before a receipt mutation has been submitted. */
async function withCurrentPublicationSessionFacts<T>(
  prepare: () => Promise<T>,
  refresh: () => Promise<void>,
): Promise<T> {
  try {
    return await prepare();
  } catch (error) {
    if (
      !(
        error instanceof GitHubPublicationRecoveryPendingError &&
        error.cause instanceof SessionMutationRuntimeFactsChangedError
      )
    ) {
      throw error;
    }
    await refresh();
    return await prepare();
  }
}

function prepareRequesterSource(
  requester: GitHubPublicationRequesterPolicyV2,
  selector: GitHubPublicationSourceSelector,
  sourcePath: string | undefined,
  policyAuthority: PluginGatewayAccessAuthority | undefined,
): Promise<GitHubPublicationSourceCapability> {
  if (!sourcePath) {
    throw new GitHubPublicationRecoveryPendingError(
      "GitHub publication source is unavailable; retry after session storage is ready.",
    );
  }
  const { snapshot, signal } = requester;
  return prepareGitHubPublicationSource({
    sourcePath,
    selector: {
      ...selector,
      ...(snapshot.actor.kind === "operator"
        ? {
            profileId: snapshot.actor.profileId,
            aliasBindingIds: snapshot.grant?.aliasBindingIds,
          }
        : {}),
    },
    signal: AbortSignal.any([signal, ...(policyAuthority ? [policyAuthority.signal] : [])]),
    assertCurrent: requester.assertCurrent,
  });
}

/** Capture from the admitted caller, never request arguments, publisher, or session attribution. */
export async function prepareGitHubPublicationRequesterV2(
  options: Parameters<typeof captureGatewayOperatorRunAuthority>[0] &
    Pick<GatewayRequestHandlerOptions, "signal" | "sessionMutationAuthorization">,
  session: PublicationSession,
): Promise<{ requester: GitHubPublicationRequesterV2; release: () => void }> {
  options.signal?.throwIfAborted();
  options.sessionMutationAuthorization?.assertCurrent();
  const source = await captureGatewayOperatorRunAuthority(options);
  let identity: PreparedProfileIdentity | undefined;
  let sessionFacts: PreparedPublicationSession | undefined;
  const lifetime = new AbortController();
  const release = () => {
    lifetime.abort(new GitHubPublicationRequesterUnavailableError());
    sessionFacts?.release();
    identity?.release();
    source?.release();
  };
  try {
    const actor = source
      ? { kind: "operator" as const, profileId: source.authority.profileId }
      : resolveGatewayOperatorRoleActor(options.client);
    const system =
      actor?.kind === "system" ||
      options.client?.authenticatedUserProfile?.profileId === GATEWAY_OWNER_PROFILE_ID;
    if (
      (!source && !system) ||
      options.client?.connect.role !== "operator" ||
      (source && source.authority.gatewayAccessGrant === undefined)
    ) {
      throw new GitHubPublicationRequesterUnavailableError();
    }
    let grant: GitHubPublicationRequesterSnapshot["grant"] = null;
    if (source) {
      assertPublicationIncognitoAccess(
        source.authority.profileId,
        source.authority.scopes,
        session.sessionKey,
      );
      identity = await prepareUserProfileIdentity(source.authority.profileId);
      sessionFacts = await preparePublicationSession(
        session,
        (options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig)(),
      );
      if (source.authority.gatewayAccessGrant) {
        grant = Object.freeze({
          ...source.authority.gatewayAccessGrant,
          aliasBindingIds: identity.emailBindingIds,
        });
      }
    }
    const principal =
      source?.authority.openclawIdPrincipal?.kind === "member"
        ? openClawIdRecoveryPrincipalSchema.parse(source.authority.openclawIdPrincipal)
        : undefined;
    const snapshot: GitHubPublicationRequesterSnapshot = Object.freeze({
      version: 1,
      actor: Object.freeze(
        source
          ? { kind: "operator" as const, profileId: source.authority.profileId }
          : { kind: "system" as const },
      ),
      scopes: Object.freeze([...(source?.authority.scopes ?? options.client.connect.scopes ?? [])]),
      ...(principal
        ? {
            openclawIdPrincipal: Object.freeze({
              ...principal,
              authority: Object.freeze(principal.authority),
            }),
          }
        : {}),
      grant,
    });
    let policyAuthority: PluginGatewayAccessAuthority | undefined;
    const assertPolicy = prepareRequesterPolicy(
      snapshot,
      session,
      options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig,
      identity,
      () => sessionFacts,
      (authority) => {
        policyAuthority = authority;
      },
    );
    const signal = AbortSignal.any([
      lifetime.signal,
      ...(options.signal ? [options.signal] : []),
      ...(source?.authority.signal ? [source.authority.signal] : []),
    ]);
    const assertInvocationCurrent = () => {
      try {
        signal.throwIfAborted();
        if (options.hasCurrentClientAuthority?.() === false) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        options.sessionMutationAuthorization?.assertCurrent();
        source?.authority.assertCurrent();
      } catch {
        throw new GitHubPublicationRequesterUnavailableError();
      }
    };
    const requester: GitHubPublicationRequesterV2 = Object.freeze({
      version: 2 as const,
      async retainForSettlement() {
        requester.assertCurrent();
        using settlementLifetime = new DisposableStack();
        const retained = await captureGatewayOperatorRunAuthority({
          ...options,
          independentContinuation: true,
        });
        settlementLifetime.defer(() => retained?.release());
        requester.assertCurrent();
        if (
          !retained ||
          snapshot.actor.kind !== "operator" ||
          retained.authority.profileId !== snapshot.actor.profileId
        ) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        const policy = await restoreGitHubPublicationRequester(
          encodeGitHubPublicationRequester({ ...snapshot, version: 2 }),
          session,
          options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig,
        );
        settlementLifetime.defer(() => policy.release());
        requester.assertCurrent();
        const assertCurrent = () => {
          policy.assertCurrent();
          retained.authority.assertCurrent();
        };
        assertCurrent();
        const held: GitHubPublicationRequesterPolicyV2 = {
          ...policy,
          assertCurrent,
          repositoryCredentialSource: retained.authority.repositoryCredentialSource,
          prepareDispatchCredential: (input) =>
            repositoryDispatchCredentialReader({
              client: null,
              operatorAuthority: retained.authority,
              agentId: session.agentId,
              sessionKey: session.sessionKey,
              sessionId: input.sessionId,
              requestDigest: input.requestDigest,
              assertCurrent: () => {
                assertCurrent();
                input.assertCurrent();
              },
            }),
        };
        workerRequesters.set(held, Object.freeze({ ...session }));
        const custody = settlementLifetime.move();
        return { requester: held, release: () => custody.dispose() };
      },
      prepareDispatchCredential: (input: {
        sessionId: string;
        requestDigest: string;
        assertCurrent: () => void;
      }) =>
        repositoryDispatchCredentialReader({
          client: options.client,
          agentId: session.agentId,
          sessionKey: session.sessionKey,
          sessionId: input.sessionId,
          requestDigest: input.requestDigest,
          hasCurrentClientAuthority: options.hasCurrentClientAuthority,
          assertCurrent: () => {
            requester.assertCurrent();
            input.assertCurrent();
          },
        }),
      repositoryCredentialSource: source?.authority.repositoryCredentialSource,
      signal,
      snapshot,
      assertInvocationCurrent,
      assertCurrent: () => {
        assertInvocationCurrent();
        assertPolicy();
        assertInvocationCurrent();
      },
      async prepareSource(selector: GitHubPublicationSourceSelector) {
        if (selector.agentId !== session.agentId || selector.sessionKey !== session.sessionKey) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        return await withCurrentPublicationSessionFacts(
          async () => {
            requester.assertCurrent();
            sessionFacts ??= await preparePublicationSession(
              session,
              (options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig)(),
            );
            requester.assertCurrent();
            const { sourcePath } = sessionFacts.readCurrent(
              (options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig)(),
            );
            return await prepareRequesterSource(requester, selector, sourcePath, policyAuthority);
          },
          async () => {
            signal.throwIfAborted();
            const fresh = await preparePublicationSession(
              session,
              (options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig)(),
            );
            sessionFacts?.release();
            sessionFacts = fresh;
          },
        );
      },
    });
    workerRequesters.set(requester, Object.freeze({ ...session }));
    requester.assertCurrent();
    return { requester, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Host-owned source custody retains the initiating conversation's admitted authority. */
export async function prepareGitHubPublicationTaskRequester(
  original: GitHubPublicationRequesterV2,
  sourceSession: PublicationSession,
  origin: GitHubPublicationOrigin,
  getCommittedRuntimeConfig: () => OpenClawConfig,
): Promise<{ requester: GitHubPublicationRequesterV2; release: () => void }> {
  original.assertCurrent();
  const bound = workerRequesters.get(original);
  if (
    !bound ||
    bound.agentId !== origin.agentId ||
    bound.sessionKey !== origin.sessionKey ||
    sourceSession.agentId !== origin.agentId
  ) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
  const restored = await restoreGitHubPublicationRequester(
    encodeGitHubPublicationRequester({ ...original.snapshot, origin }),
    sourceSession,
    getCommittedRuntimeConfig,
    original,
  );
  const requester: GitHubPublicationRequesterV2 = Object.freeze({
    version: 2,
    snapshot: restored.snapshot,
    signal: restored.signal,
    assertInvocationCurrent: original.assertInvocationCurrent,
    assertCurrent: restored.assertCurrent,
    prepareSource: restored.prepareSource,
  });
  workerRequesters.set(requester, Object.freeze({ ...sourceSession }));
  return { requester, release: restored.release };
}

/** Restoration rechecks the original immutable basis; a new role or invitation cannot replace it. */
export async function restoreGitHubPublicationRequester(
  json: string | null | undefined,
  session: PublicationSession,
  getCommittedRuntimeConfig: () => OpenClawConfig,
  invocation?: Pick<GitHubPublicationRequesterV2, "signal" | "assertInvocationCurrent">,
): Promise<GitHubPublicationRequesterPolicyV2 & { release: () => void }> {
  const snapshot = decodeGitHubPublicationRequester(json);
  if (!snapshot) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
  if (snapshot.openclawIdPrincipal) {
    try {
      await prepareOpenClawIdTunnelPrincipal(snapshot.openclawIdPrincipal);
    } catch (error) {
      if (error instanceof OpenClawIdPrincipalChangedError) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication membership is unavailable; retry recovery after membership storage is ready.",
        { cause: error },
      );
    }
  }
  let identity: PreparedProfileIdentity | undefined;
  let sessionFacts: PreparedPublicationSession | undefined;
  let originFacts: PreparedPublicationSession | undefined;
  const lifetime = new AbortController();
  if (snapshot.actor.kind === "operator") {
    assertPublicationIncognitoAccess(snapshot.actor.profileId, snapshot.scopes, session.sessionKey);
    if (snapshot.origin) {
      assertPublicationIncognitoAccess(
        snapshot.actor.profileId,
        snapshot.scopes,
        snapshot.origin.sessionKey,
      );
    }
    try {
      identity = await prepareUserProfileIdentity(snapshot.actor.profileId);
      sessionFacts = await preparePublicationSession(session, getCommittedRuntimeConfig());
    } catch (error) {
      identity?.release();
      if (error instanceof GitHubPublicationRecoveryPendingError) {
        throw error;
      }
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication requester identity is unavailable; retry recovery after profile storage is ready.",
        { cause: error },
      );
    }
  }
  const release = () => {
    lifetime.abort(new GitHubPublicationRequesterUnavailableError());
    sessionFacts?.release();
    originFacts?.release();
    identity?.release();
  };
  try {
    if (snapshot.origin) {
      originFacts = await preparePublicationSession(snapshot.origin, getCommittedRuntimeConfig());
    }
    let policyAuthority: PluginGatewayAccessAuthority | undefined;
    const assertPolicy = prepareRequesterPolicy(
      snapshot,
      session,
      getCommittedRuntimeConfig,
      identity,
      () => sessionFacts,
      (authority) => {
        policyAuthority = authority;
      },
      () => originFacts,
    );
    const signal = AbortSignal.any([lifetime.signal, ...(invocation ? [invocation.signal] : [])]);
    const requester: GitHubPublicationRequesterPolicyV2 & { release: () => void } = Object.freeze({
      version: 2 as const,
      signal,
      snapshot,
      assertCurrent() {
        signal.throwIfAborted();
        invocation?.assertInvocationCurrent();
        assertPolicy();
        invocation?.assertInvocationCurrent();
      },
      async prepareSource(selector: GitHubPublicationSourceSelector) {
        if (selector.agentId !== session.agentId || selector.sessionKey !== session.sessionKey) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        return await withCurrentPublicationSessionFacts(
          async () => {
            requester.assertCurrent();
            sessionFacts ??= await preparePublicationSession(session, getCommittedRuntimeConfig());
            requester.assertCurrent();
            const { sourcePath } = sessionFacts.readCurrent(getCommittedRuntimeConfig());
            return await prepareRequesterSource(requester, selector, sourcePath, policyAuthority);
          },
          async () => {
            signal.throwIfAborted();
            const fresh = await preparePublicationSession(session, getCommittedRuntimeConfig());
            try {
              const freshOrigin = snapshot.origin
                ? await preparePublicationSession(snapshot.origin, getCommittedRuntimeConfig())
                : undefined;
              sessionFacts?.release();
              originFacts?.release();
              sessionFacts = fresh;
              originFacts = freshOrigin;
            } catch (error) {
              fresh.release();
              throw error;
            }
          },
        );
      },
      release,
    });
    workerRequesters.set(requester, Object.freeze({ ...session }));
    requester.assertCurrent();
    return requester;
  } catch (error) {
    release();
    throw error;
  }
}

/** Reuse an exact live invocation; durable restoration cannot manufacture its credential source. */
export async function prepareGitHubPublicationExecutionRequester(
  json: string | null | undefined,
  session: PublicationSession,
  getCommittedRuntimeConfig: () => OpenClawConfig,
  current?: GitHubPublicationRequesterPolicyV2,
): Promise<{ requester: GitHubPublicationRequesterPolicyV2; release: () => void }> {
  const config = getCommittedRuntimeConfig();
  const selected =
    resolveConfiguredGitHubToolIdentity({ config, agentId: session.agentId, scope: "agent" }) ??
    resolveConfiguredGitHubToolIdentity({ config, agentId: session.agentId, scope: "system" });
  if (
    Boolean(getRepositoryIntegration(config)) &&
    selected?.kind === "app-installation" &&
    current?.repositoryCredentialSource &&
    isGitHubPublicationRequesterV2(current) &&
    encodeGitHubPublicationRequester(current.snapshot) === json
  ) {
    current.assertCurrent();
    return { requester: current, release: () => {} };
  }
  const restored = await restoreGitHubPublicationRequester(
    json,
    session,
    getCommittedRuntimeConfig,
  );
  return { requester: restored, release: restored.release };
}
