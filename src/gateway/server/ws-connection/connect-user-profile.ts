import type { IncomingHttpHeaders } from "node:http";
import { resolveHostAccountName } from "../../../infra/host-account-name.js";
import { prepareUserProfileRoleAuthority } from "../../../state/user-channel-identity-operations.js";
import { delegatedProfileProvider } from "../../../state/user-profile-delegation.js";
import { openClawIdProfileProvider } from "../../../state/user-profile-openclaw-id.types.js";
import {
  prepareExistingUserProfileAuthentication,
  type ExistingUserProfileAuthentication,
} from "../../../state/user-profile-reads.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  ensureCanonicalDelegatedUserProfile,
  ensureCanonicalUserProfileForOpenClawIdIdentity,
  ensureCanonicalUserProfileForTailscaleIdentity,
} from "../../../state/user-profile-writes.js";
import { classifyTailscaleLogin } from "../../../state/user-profiles-tailscale-login.js";
import { adoptTailscaleProfileAvatar } from "../../../state/user-profiles.js";
import { prepareGatewayRecipientProfile } from "../../expected-profile.js";
import type { createAuthenticatedGitHubIdentitySync } from "../../github-user-identity.js";
import {
  attachGatewayLocalUserIngress,
  type prepareGatewayLocalUserIngress,
} from "../../local-user-ingress.js";
import { hasGatewayOperatorAccessPolicies } from "../../operator-access-policy.js";
import { isNamedOperatorRoleEnforcementEnabled } from "../../operator-role-enforcement.js";
import { WEBSOCKET_OPEN_READY_STATE } from "../../server-constants.js";
import { syncTrustedProxyGitCoauthor } from "../../trusted-proxy-git-coauthor.js";
import { formatForLog } from "../../ws-log.js";
import type { GatewayWsClient } from "../ws-types.js";
import {
  rejectUnavailableProfileConnect,
  resolveGatewayConnectPolicyFailure,
  isGatewayConnectReadOnly,
  runWhenGatewayConnectMutable,
} from "./connect-admission.js";
import {
  bindGatewayConnectOperatorAccess,
  prepareGatewayConnectOperatorAccess,
} from "./connect-operator-access.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

type PreparedConnectProfile = Awaited<ReturnType<typeof resolveAuthenticatedProfile>>;

/** Provider identity enrichment remains owned by the admitted profile lifecycle. */
export function scheduleGatewayConnectProfileSync(params: {
  context: GatewayConnectPhaseContext;
  state: DeviceAuthorizedGatewayConnect;
  client: GatewayWsClient;
  lifecycle: ReturnType<typeof createGatewayConnectProfileLifecycle>;
  prepareIngress: (
    profile: PreparedConnectProfile["profile"],
  ) => ReturnType<typeof prepareGatewayLocalUserIngress>;
}): void {
  if (isGatewayConnectReadOnly()) {
    runWhenGatewayConnectMutable(params.context, params.state, () =>
      scheduleGatewayConnectProfileSync(params),
    );
    return;
  }
  const { context, state, client, lifecycle, prepareIngress } = params;
  const { connId, logGateway } = context.handler;
  const { runDetachedConnectWork } = context;
  const { authResult } = state;
  const adoptProfileAvatar = async (profileId: string, profilePic: string) => {
    const updated = await adoptTailscaleProfileAvatar(profileId, profilePic);
    if (updated.avatarMime) {
      await lifecycle.attach(updated.id, updated.updatedAt, prepareIngress);
    }
  };
  if (client.authenticatedGitHubIdentitySync) {
    runDetachedConnectWork(
      async () => {
        const result = await client.authenticatedGitHubIdentitySync!();
        const profile = client.authenticatedUserProfile;
        const profilePic = authResult.tailscaleIdentity?.profilePic;
        if (!profile?.hasAvatar && profilePic) {
          try {
            await adoptProfileAvatar(result.profileId, profilePic);
          } catch (error) {
            logGateway.warn(
              `Tailscale avatar adoption failed conn=${connId}: ${formatForLog(error)}`,
            );
          }
        }
      },
      (error) => {
        logGateway.warn(`GitHub identity sync failed conn=${connId}: ${formatForLog(error)}`);
      },
    );
  }
  const tailscaleProfilePic = authResult.tailscaleIdentity?.profilePic;
  const tailscaleProfileId = client.authenticatedUserProfile?.profileId;
  if (
    !client.authenticatedGitHubIdentitySync &&
    tailscaleProfileId &&
    !client.authenticatedUserProfile?.hasAvatar &&
    tailscaleProfilePic
  ) {
    runDetachedConnectWork(
      () => adoptProfileAvatar(tailscaleProfileId, tailscaleProfilePic),
      (error) =>
        logGateway.warn(`Tailscale avatar adoption failed conn=${connId}: ${formatForLog(error)}`),
    );
  }
}

/** One connection retains its profile authority through admission and later identity refreshes. */
export function createGatewayConnectProfileLifecycle(
  context: GatewayConnectPhaseContext,
  state: DeviceAuthorizedGatewayConnect,
) {
  const { handler } = context;
  let client: GatewayWsClient | undefined;
  const clientCurrent = () =>
    !handler.isClosed() &&
    handler.socket.readyState === WEBSOCKET_OPEN_READY_STATE &&
    (!client || (handler.getClient() === client && !client.invalidated));
  const assertCurrent = () => {
    handler.connectionWork.signal.throwIfAborted();
    if (!clientCurrent() || resolveGatewayConnectPolicyFailure(context, state)) {
      throw new Error("Gateway profile acquisition authority expired");
    }
  };
  return {
    assertCurrent,
    isCurrent: (prepared: PreparedConnectProfile | undefined) => {
      try {
        prepared?.assertIdentityCurrent?.();
      } catch {
        return false;
      }
      return (
        (!prepared || prepared.authority.isCurrent()) &&
        !resolveGatewayConnectPolicyFailure(context, state)
      );
    },
    bind: (registered: GatewayWsClient) => {
      client = registered;
    },
    async attach(
      profileId: string,
      updatedAt: number,
      prepareIngress: (
        profile: PreparedConnectProfile["profile"],
      ) => ReturnType<typeof prepareGatewayLocalUserIngress>,
    ) {
      if (!client || !clientCurrent()) {
        return;
      }
      const registered = client;
      assertCurrent();
      const prepared = await resolveAuthenticatedProfile(profileId, updatedAt, assertCurrent);
      assertCurrent();
      if (client !== registered || !prepared.authority.isCurrent()) {
        throw new Error("Gateway profile changed before attachment");
      }
      const { profile } = prepared;
      registered.preparedRecipientProfileId = undefined;
      if (registered.authenticatedUserProfile) {
        Object.assign(registered.authenticatedUserProfile, profile);
      } else {
        registered.authenticatedUserProfile = profile;
      }
      // Deferred attachment must prepare access without replacing an admitted grant.
      if (registered.internal?.operatorAccessAuthority === undefined) {
        prepareGatewayConnectOperatorAccess(registered);
        if (!bindGatewayConnectOperatorAccess(context, registered)) {
          return;
        }
      }
      prepareGatewayRecipientProfile(registered, { identity: prepared.recipient });
      attachGatewayLocalUserIngress(registered, prepareIngress(profile));
      const { profileId: id, ...display } = profile;
      handler.buildRequestContext().refreshConnectedUserProfile?.({ id, ...display });
    },
  };
}

async function resolveAuthenticatedProfile(
  profileId: string,
  updatedAt: number,
  assertCurrent?: () => void,
  recordTiming?: GatewayConnectPhaseContext["recordAttachTiming"],
  assertIdentityCurrent?: () => void,
) {
  assertCurrent?.();
  assertIdentityCurrent?.();
  const authorityStartedAt = performance.now();
  const authority = await prepareUserProfileRoleAuthority(profileId);
  recordTiming?.("profileAuthorityMs", authorityStartedAt);
  assertCurrent?.();
  assertIdentityCurrent?.();
  if (!authority?.isCurrent()) {
    throw new Error("Gateway profile changed during acquisition");
  }
  const projectionStartedAt = performance.now();
  const { id, displayName, avatarRevision, hasAvatar } = authority.display;
  const prepared = {
    ...(assertIdentityCurrent ? { assertIdentityCurrent } : {}),
    profile: { profileId: id, displayName, avatarRevision, hasAvatar, updatedAt },
    authority,
    recipient: {
      profileId: authority.profileId,
      role: authority.role,
      githubLogin: authority.githubLogin ?? null,
      aliases: new Set(authority.aliases),
    },
  };
  recordTiming?.("profileProjectionMs", projectionStartedAt);
  return prepared;
}

/** Role and access policies need verified identity before admission; attribution alone may defer it. */
export async function resolveGatewayConnectProfileAdmission(params: {
  context: Pick<
    GatewayConnectPhaseContext,
    "configSnapshot" | "recordAttachTiming" | "setConnectPhase"
  > &
    Parameters<typeof rejectUnavailableProfileConnect>[0] & {
      handler: Pick<GatewayConnectPhaseContext["handler"], "connId" | "logWsControl">;
    };
  state: Pick<DeviceAuthorizedGatewayConnect, "authResult" | "role" | "authMethod">;
  ownerProfileExpected: boolean;
  /** The profile an OpenClaw ID owner device's linked account names (OCF-510). */
  linkedOwnerProfile?: { profileId: string; updatedAt: number } | null;
  authenticatedUserId: string | undefined;
  requestHeaders?: IncomingHttpHeaders;
  resolveAuthenticatedGitHubIdentity: ReturnType<typeof createAuthenticatedGitHubIdentitySync>;
  assertCurrent?: () => void;
}): Promise<{ ok: true; prepared?: PreparedConnectProfile } | { ok: false }> {
  const { context, state, ownerProfileExpected, authenticatedUserId } = params;
  if (params.linkedOwnerProfile) {
    // Attribution only: a profile that vanished since the lookup returns the owner device
    // to the shared owner rather than refusing its certificate.
    try {
      const prepared = await resolveAuthenticatedProfile(
        params.linkedOwnerProfile.profileId,
        params.linkedOwnerProfile.updatedAt,
        params.assertCurrent,
        context.recordAttachTiming,
      );
      params.assertCurrent?.();
      return { ok: true, prepared };
    } catch (error) {
      context.handler.logWsControl.warn(
        `linked owner profile resolution failed conn=${context.handler.connId}: ${formatForLog(error)}`,
      );
      return await resolveGatewayConnectProfileAdmission({
        ...params,
        linkedOwnerProfile: null,
        ownerProfileExpected: true,
      });
    }
  }
  const readOnly = isGatewayConnectReadOnly();
  const profileRequired =
    Boolean(state.authResult.delegation) ||
    isNamedOperatorRoleEnforcementEnabled(context.configSnapshot) ||
    hasGatewayOperatorAccessPolicies(context.configSnapshot, {
      openclawIdPrincipal:
        state.authMethod === "trusted-proxy" ? state.authResult.openclawId : undefined,
    });
  if (
    !ownerProfileExpected &&
    (!authenticatedUserId ||
      (!readOnly &&
        params.resolveAuthenticatedGitHubIdentity &&
        !profileRequired &&
        !context.configSnapshot.gateway?.auth?.trustedProxy?.gitCoauthor))
  ) {
    return { ok: true };
  }
  try {
    params.assertCurrent?.();
    const options = { assertCurrent: params.assertCurrent };
    const ensureStartedAt = performance.now();
    context.setConnectPhase?.("profile-ensure");
    let assertIdentityCurrent: (() => void) | undefined;
    const readExistingProfile = async () => {
      let selector: ExistingUserProfileAuthentication;
      const tailscale = state.authResult.tailscaleIdentity
        ? classifyTailscaleLogin(state.authResult.tailscaleIdentity.login)
        : undefined;
      if (state.authResult.delegation) {
        selector = {
          kind: "provider",
          provider: delegatedProfileProvider,
          subject: state.authResult.delegation.identity.subject,
        };
      } else if (
        state.authMethod === "trusted-proxy" &&
        state.authResult.openclawId?.kind === "member"
      ) {
        selector = {
          kind: "provider",
          provider: openClawIdProfileProvider,
          subject: state.authResult.openclawId.accountId,
        };
      } else if (ownerProfileExpected) {
        selector = { kind: "owner" };
      } else if (params.resolveAuthenticatedGitHubIdentity?.existingAuthentication) {
        selector = await params.resolveAuthenticatedGitHubIdentity.existingAuthentication();
      } else if (tailscale?.kind === "provider") {
        selector =
          tailscale.provider === "github"
            ? { kind: "github", binding: { login: tailscale.subject } }
            : { kind: "provider", provider: tailscale.provider, subject: tailscale.subject };
      } else if (params.resolveAuthenticatedGitHubIdentity) {
        throw new Error(
          "Gateway rolling read phase requires an existing verified provider binding",
        );
      } else {
        selector = { kind: "email", email: authenticatedUserId! };
      }
      const existing = await prepareExistingUserProfileAuthentication(selector);
      existing.assertCurrent();
      if (!existing.profile) {
        throw new Error("Gateway rolling read phase cannot create or reconcile a user profile");
      }
      assertIdentityCurrent = existing.assertCurrent;
      return existing.profile;
    };
    const member =
      state.authMethod === "trusted-proxy" && state.authResult.openclawId?.kind === "member"
        ? state.authResult.openclawId
        : undefined;
    const profile = readOnly
      ? await readExistingProfile()
      : state.authResult.delegation
        ? await ensureCanonicalDelegatedUserProfile(state.authResult.delegation.identity, options)
        : ownerProfileExpected
          ? await ensureCanonicalGatewayOwnerProfile(resolveHostAccountName, options)
          : member
            ? await ensureCanonicalUserProfileForOpenClawIdIdentity(
                { accountId: member.accountId },
                options,
              )
            : params.resolveAuthenticatedGitHubIdentity
              ? await params.resolveAuthenticatedGitHubIdentity()
              : state.authResult.tailscaleIdentity
                ? await ensureCanonicalUserProfileForTailscaleIdentity(
                    state.authResult.tailscaleIdentity,
                    options,
                  )
                : await ensureCanonicalUserProfileForEmail(authenticatedUserId!, options);
    params.assertCurrent?.();
    params.context.recordAttachTiming?.("profileEnsureMs", ensureStartedAt);
    if (
      !readOnly &&
      !ownerProfileExpected &&
      context.configSnapshot.gateway?.auth?.trustedProxy?.gitCoauthor
    ) {
      await syncTrustedProxyGitCoauthor({
        authConfig: context.configSnapshot.gateway?.auth,
        authResult: state.authResult,
        headers: params.requestHeaders ?? {},
        profileId: "profileId" in profile ? profile.profileId : profile.id,
        assertCurrent: params.assertCurrent,
      });
    }
    context.setConnectPhase?.("profile-authority");
    const prepared = await resolveAuthenticatedProfile(
      "profileId" in profile ? profile.profileId : profile.id,
      profile.updatedAt,
      params.assertCurrent,
      context.recordAttachTiming,
      assertIdentityCurrent,
    );
    params.assertCurrent?.();
    assertIdentityCurrent?.();
    if (!prepared.authority.isCurrent()) {
      throw new Error("Gateway profile changed during acquisition");
    }
    return { ok: true, prepared };
  } catch (error) {
    if (readOnly || isGatewayConnectReadOnly()) {
      await rejectUnavailableProfileConnect(context, error);
      return { ok: false };
    }
    context.handler.logWsControl.warn(
      `user profile resolution failed conn=${context.handler.connId} user=${formatForLog(authenticatedUserId)}: ${formatForLog(error)}`,
    );
    if (
      !ownerProfileExpected &&
      profileRequired &&
      state.role === "operator" &&
      state.authMethod !== "token" &&
      state.authMethod !== "password"
    ) {
      await rejectUnavailableProfileConnect(context, error);
      return { ok: false };
    }
    return { ok: true };
  }
}
