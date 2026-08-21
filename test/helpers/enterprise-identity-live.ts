import type { EnterpriseIdentityProviderAdapter } from "../../src/plugins/enterprise-identity-provider-types.js";
import {
  clearEnterpriseOidcJwksCacheForTest,
  verifyEnterpriseOidcIdentity,
} from "../../src/state/memory-enterprise-verifier.js";
import { isTruthyEnvValue } from "../../src/plugin-sdk/test-live.js";

export type LiveEnterpriseRoleExpectation = "present" | "absent";

export type LiveEnterpriseIdentityToken = Readonly<{
  token: string;
  nonce: string;
  expectedRole: LiveEnterpriseRoleExpectation;
}>;

export function isEnterpriseIdentityLiveTestEnabled(): boolean {
  return (
    isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST) &&
    isTruthyEnvValue(process.env.MEMORY_ENTERPRISE_IDENTITY_LIVE_TEST)
  );
}

export function requireLiveEnterpriseEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`live enterprise identity test requires ${name}`);
  }
  return value;
}

/**
 * A live token is always paired with the nonce from the same short-lived
 * authorization-code flow. Keeping both out of test output avoids turning
 * provider proof into a bearer-token leak.
 */
export function readLiveEnterpriseIdentityToken(prefix: string): LiveEnterpriseIdentityToken | undefined {
  const token = process.env[`${prefix}_ID_TOKEN`]?.trim();
  const nonce = process.env[`${prefix}_NONCE`]?.trim();
  const expectedRole = process.env[`${prefix}_EXPECT_ROLE_MEMBERSHIP`]?.trim();
  if (!token && !nonce && !expectedRole) {
    return undefined;
  }
  if (!token || !nonce || (expectedRole !== "present" && expectedRole !== "absent")) {
    throw new Error(
      `live enterprise identity token proof requires ${prefix}_ID_TOKEN, ${prefix}_NONCE, and ${prefix}_EXPECT_ROLE_MEMBERSHIP=present|absent`,
    );
  }
  return { token, nonce, expectedRole };
}

/**
 * Proves an adapter's exact published discovery and signing-key endpoints
 * before optionally sending one freshly issued token through core verification.
 * No token, claim, user, group, or response body reaches test output.
 */
export async function verifyLiveEnterpriseIdentityProvider(params: {
  adapter: EnterpriseIdentityProviderAdapter;
  token?: LiveEnterpriseIdentityToken;
  expectedRoleGroup: string;
}): Promise<void> {
  const authority = params.adapter.authorities[0];
  if (!authority) {
    throw new Error("live enterprise identity adapter did not declare an authority");
  }
  const discovery = await fetch(`${authority.issuer}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!discovery.ok) {
    throw new Error("official enterprise identity discovery endpoint was unavailable");
  }
  const metadata: unknown = await discovery.json();
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("official enterprise identity discovery document was invalid");
  }
  const record = metadata as Record<string, unknown>;
  const acceptedIssuers = new Set([authority.issuer, ...(authority.acceptedIssuerAliases ?? [])]);
  if (typeof record.issuer !== "string" || !acceptedIssuers.has(record.issuer)) {
    throw new Error("official enterprise identity discovery issuer did not match the adapter");
  }
  if (record.jwks_uri !== authority.jwksUri) {
    throw new Error("official enterprise identity discovery JWKS URI did not match the adapter");
  }
  const jwks = await fetch(authority.jwksUri, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!jwks.ok) {
    throw new Error("official enterprise identity JWKS endpoint was unavailable");
  }
  const payload: unknown = await jwks.json();
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { keys?: unknown }).keys) ||
    !(payload as { keys: unknown[] }).keys.some(
      (key) =>
        key &&
        typeof key === "object" &&
        !Array.isArray(key) &&
        (key as { kty?: unknown }).kty === "RSA" &&
        (key as { use?: unknown }).use !== "enc",
    )
  ) {
    throw new Error("official enterprise identity JWKS did not expose an RSA signing key");
  }
  if (!params.token) {
    return;
  }
  clearEnterpriseOidcJwksCacheForTest();
  try {
    const verification = await verifyEnterpriseOidcIdentity({
      adapter: params.adapter,
      token: params.token.token,
      expectedNonce: params.token.nonce,
    });
    if (verification.kind !== "verified") {
      throw new Error(`core rejected the live enterprise identity token: ${verification.reason}`);
    }
    if (verification.identity.expiresAt <= Date.now()) {
      throw new Error("core accepted an expired live enterprise identity token");
    }
    const hasExpectedRole = verification.identity.groups.includes(params.expectedRoleGroup);
    if (
      (params.token.expectedRole === "present" && !hasExpectedRole) ||
      (params.token.expectedRole === "absent" && hasExpectedRole)
    ) {
      throw new Error("live enterprise identity role membership did not match the requested proof");
    }
  } finally {
    clearEnterpriseOidcJwksCacheForTest();
  }
}
