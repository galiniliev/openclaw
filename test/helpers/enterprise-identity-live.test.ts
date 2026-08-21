import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnterpriseIdentityProviderAdapter } from "../../src/plugins/enterprise-identity-provider-types.js";
import {
  isEnterpriseIdentityLiveTestEnabled,
  readLiveEnterpriseIdentityToken,
  verifyLiveEnterpriseIdentityProvider,
} from "./enterprise-identity-live.js";

const adapter: EnterpriseIdentityProviderAdapter = {
  providerPrefix: "test-provider",
  authorities: [
    {
      issuer: "https://identity.example/tenant",
      tenantId: "tenant",
      audiences: ["live-client"],
      jwksUri: "https://identity.example/tenant/keys",
      algorithm: "RS256",
      tenantBinding: { kind: "issuer", tenantId: "tenant" },
      assurance: { maxAuthenticationAgeMs: 60_000 },
      authorizationCodeFlow: {
        clientId: "live-client",
        authorizationEndpoint: "https://identity.example/tenant/authorize",
        tokenEndpoint: "https://identity.example/tenant/token",
        redirectUri: "https://gateway.example/memory/oidc/callback",
        scopes: ["openid"],
      },
      membership: {
        kind: "oidc-claim",
        claim: "groups",
        required: true,
        roleGroupIds: ["role-id"],
        maxGroups: 1,
      },
      maxSnapshotAgeMs: 60_000,
    },
  ],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("enterprise identity live-test helper", () => {
  it("requires both the global and enterprise-specific live gates", () => {
    vi.stubEnv("OPENCLAW_LIVE_TEST", "");
    vi.stubEnv("MEMORY_ENTERPRISE_IDENTITY_LIVE_TEST", "1");
    expect(isEnterpriseIdentityLiveTestEnabled()).toBe(false);

    vi.stubEnv("OPENCLAW_LIVE_TEST", "1");
    vi.stubEnv("MEMORY_ENTERPRISE_IDENTITY_LIVE_TEST", "1");
    expect(isEnterpriseIdentityLiveTestEnabled()).toBe(true);
  });

  it("requires a complete nonce-bound token proof when any token input is present", () => {
    vi.stubEnv("OPENCLAW_LIVE_MEMORY_TEST_ID_TOKEN", "bearer-token");
    expect(() => readLiveEnterpriseIdentityToken("OPENCLAW_LIVE_MEMORY_TEST")).toThrow(
      "OPENCLAW_LIVE_MEMORY_TEST_NONCE",
    );
  });

  it("probes only official discovery and JWKS when no bearer token is provided", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          issuer: "https://identity.example/tenant",
          jwks_uri: "https://identity.example/tenant/keys",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ keys: [{ kty: "RSA", use: "sig" }] }),
      });
    vi.stubGlobal("fetch", fetch);

    await expect(
      verifyLiveEnterpriseIdentityProvider({
        adapter,
        expectedRoleGroup: "role-id",
      }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://identity.example/tenant/.well-known/openid-configuration",
      expect.any(Object),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://identity.example/tenant/keys",
      expect.any(Object),
    );
  });
});
