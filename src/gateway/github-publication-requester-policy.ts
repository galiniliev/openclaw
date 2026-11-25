import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginGatewayAccessAuthority } from "../plugins/gateway-access-policy.types.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import type { GitHubPublicationRequesterSnapshot } from "../state/github-publication-requester.js";
import { UserProfileMutationUnsettledError } from "../state/user-profile-events.js";
import type { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import type { UserProfileAccessFacts } from "../state/user-profiles.types.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  openclawIdTunnelRolePolicy,
} from "./openclaw-id/tunnel-principal.js";
import {
  GatewayOperatorAccessDeniedError,
  resumeGatewayOperatorAccessGrant,
} from "./operator-access-policy.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { prepareSessionCreatorProfile } from "./session-creator.js";
import { authorizePreparedSessionMutation } from "./session-sharing-policy.js";
import type { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

type PublicationSession = { sessionKey: string; agentId: string };
type PreparedProfileIdentity = Awaited<ReturnType<typeof prepareUserProfileIdentity>>;
type PreparedPublicationSession = Awaited<ReturnType<typeof prepareSessionMutationFacts>>;

export function prepareRequesterPolicy(
  snapshot: GitHubPublicationRequesterSnapshot,
  session: PublicationSession,
  getCommittedRuntimeConfig: () => OpenClawConfig,
  identity: PreparedProfileIdentity | undefined,
  readSessionFacts: () => PreparedPublicationSession | undefined,
  onPolicy?: (authority: PluginGatewayAccessAuthority | undefined) => void,
  readOriginFacts?: () => PreparedPublicationSession | undefined,
) {
  const client = createSyntheticPluginRuntimeClient({
    operatorRoleActor: snapshot.actor,
    openclawIdPrincipal: snapshot.openclawIdPrincipal,
    scopes: [...snapshot.scopes],
  });
  let retainedAuthority: PluginGatewayAccessAuthority | undefined;
  const assertIdentity = () => {
    if (snapshot.actor.kind !== "operator") {
      return undefined;
    }
    try {
      if (!identity) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
      return identity.readCurrentFacts(snapshot.grant?.aliasBindingIds);
    } catch (error) {
      if (error instanceof UserProfileMutationUnsettledError) {
        throw new GitHubPublicationRecoveryPendingError(
          "GitHub publication identity authorization is unavailable; retry after the profile mutation settles.",
          { cause: error },
        );
      }
      throw new GitHubPublicationRequesterUnavailableError();
    }
  };
  const assertRole = (profile: UserProfileAccessFacts | undefined, config: OpenClawConfig) => {
    const principal = snapshot.openclawIdPrincipal;
    if (principal && !isOpenClawIdTunnelPrincipalCurrent(principal)) {
      throw new GitHubPublicationRequesterUnavailableError();
    }
    const role =
      openclawIdTunnelRolePolicy(principal) ??
      (profile
        ? resolveOperatorRolePolicyForAssignment(
            profile.profileId,
            profile.assignedRole,
            config,
            profile.githubLogin ?? null,
          )
        : undefined);
    if (
      !roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.sessions.write"],
        allowedScopes: snapshot.scopes,
      }) ||
      (role &&
        (!roleScopesAllow({
          role: "operator",
          requestedScopes: snapshot.scopes,
          allowedScopes: role.scopes,
        }) ||
          (role.accessPolicyPlugin && role.accessPolicyPlugin !== snapshot.grant?.pluginId)))
    ) {
      throw new GitHubPublicationRequesterUnavailableError();
    }
    return role;
  };
  const assertPrepared = (config: OpenClawConfig) => {
    const current = assertIdentity();
    const role = assertRole(current?.profile, config);
    const targets = [
      { session, prepared: readSessionFacts(), origin: undefined },
      ...(snapshot.origin
        ? [{ session: snapshot.origin, prepared: readOriginFacts?.(), origin: snapshot.origin }]
        : []),
    ];
    for (const target of targets) {
      if (!current && !target.origin) {
        continue;
      }
      let facts;
      try {
        if (!target.prepared) {
          throw new Error("Prepared publication session is missing");
        }
        facts = target.prepared.readCurrent(config);
      } catch (error) {
        throw new GitHubPublicationRecoveryPendingError(
          "GitHub publication session authorization is unavailable; retry after session storage is ready.",
          { cause: error },
        );
      }
      if (
        target.origin &&
        (facts.target.entry.sessionId !== target.origin.sessionId ||
          (facts.target.entry.lifecycleRevision ?? null) !== target.origin.lifecycleRevision)
      ) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
      if (!current) {
        continue;
      }
      // Publication's creator restriction must preserve independently admitted capabilities.
      if (
        snapshot.actor.kind === "operator" &&
        !roleScopesAllow({
          role: "operator",
          requestedScopes: ["operator.write"],
          allowedScopes: snapshot.scopes,
        }) &&
        !prepareSessionCreatorProfile(
          snapshot.actor.profileId,
          current.aliases,
        )(facts.target.entry.createdActor)
      ) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
      if (
        authorizePreparedSessionMutation({ cfg: config, client, ...target.session }, facts, {
          policy: role,
          aliases: current.aliases,
          // Publication mutates a session without starting an agent run.
          authorizesAgentRun: false,
        })
      ) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
    }
    return current?.profile;
  };
  return () => {
    const config = getCommittedRuntimeConfig();
    const profile = assertPrepared(config);
    if (profile) {
      try {
        const authority = resumeGatewayOperatorAccessGrant(profile, config, snapshot.grant, {
          retained: retainedAuthority,
          openclawIdPrincipal: snapshot.openclawIdPrincipal,
        });
        retainedAuthority = authority;
        onPolicy?.(authority);
      } catch (error) {
        if (error instanceof GatewayOperatorAccessDeniedError) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        throw error;
      }
      // A policy callback can synchronously change identity, role, or committed config.
      assertPrepared(getCommittedRuntimeConfig());
    }
  };
}
