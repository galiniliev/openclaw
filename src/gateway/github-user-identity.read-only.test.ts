import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setDatabaseEngineReadOnlyAdmission } from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  listResidentUserProfileDisplayFacts,
  prepareUserProfileCatalog,
} from "../state/user-profile-list.js";
import { ensureCanonicalEnterpriseGitHubProfile } from "../state/user-profile-writes.js";
import { setUserProfileRole, syncGitHubIdentity } from "../state/user-profile-writes.worker.js";
import {
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";
import {
  accessOrigin,
  accessRequest,
  githubCfg,
  identityResponse,
  oidcIdentity,
} from "./github-user-identity.oidc.test-support.js";
import { resolveGatewayConnectProfileAdmission } from "./server/ws-connection/connect-user-profile.js";

type Admission = Parameters<typeof resolveGatewayConnectProfileAdmission>[0];
const roles: NonNullable<OpenClawConfig["gateway"]>["roles"] = {
  default: "guest",
  definitions: {
    guest: { agents: [], scopes: [], sessions: { others: "none" } },
    reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
  },
};

function admissionContext(config: OpenClawConfig): Admission["context"] {
  return {
    configSnapshot: config,
    handler: {
      connId: "readonly-profile",
      logWsControl: createSubsystemLogger("test/profile"),
      close: vi.fn(),
    },
    markHandshakeFailure: vi.fn(),
    sendHandshakeErrorResponse: vi.fn(),
    releasePendingNodePairingCleanup: async () => {},
  };
}

afterEach(() => {
  resetDatabaseEngineSelectionForTest();
  vi.restoreAllMocks();
});

it("resolves readonly authenticated provider bindings without email collisions or enrichment", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const github = syncGitHubIdentity({
      identity: { accountId: 42, login: "person" },
      authenticationAlias: { kind: "github-login", login: "person" },
    });
    const provider = ensureProfileForTailscaleIdentity({ login: "person@google" });
    const email = ensureProfileForEmail("person@example.test");
    const enterprise = await ensureCanonicalEnterpriseGitHubProfile(
      "github:ghe.example.test:42",
      "Enterprise Person",
      {},
      { login: "enterprise-person", email: "enterprise@example.test" },
    );
    const lookalike = ensureProfileForEmail("person@github");
    ensureProfileForEmail("person@google");
    setUserProfileRole(lookalike.id, "guest");
    for (const profile of [github, provider, email, enterprise]) {
      setUserProfileRole(profile.id, "reader");
    }
    using catalog = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    void catalog;
    const before = listResidentUserProfileDisplayFacts();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No identity network access"));
    const cases: Array<{
      user: string;
      method: "tailscale" | "trusted-proxy";
      profileId: string;
      hasRoles?: boolean;
      sync?: boolean;
      enterprise?: boolean;
      repositoryIdentity?: Parameters<
        typeof createAuthenticatedGitHubIdentitySync
      >[0]["repositoryIdentity"];
    }> = [
      {
        user: "person@github",
        method: "tailscale",
        profileId: github.id,
        sync: true,
        hasRoles: true,
      },
      { user: "person@github", method: "tailscale", profileId: github.id, sync: true },
      { user: "person@google", method: "tailscale", profileId: provider.id, hasRoles: true },
      { user: "person@example.test", method: "trusted-proxy", profileId: email.id, hasRoles: true },
      {
        user: "github:ghe.example.test:42",
        method: "trusted-proxy",
        profileId: enterprise.id,
        hasRoles: true,
        enterprise: true,
        sync: true,
      },
      {
        user: "integration-person",
        method: "trusted-proxy",
        profileId: enterprise.id,
        sync: true,
        repositoryIdentity: {
          accountId: 42,
          profile: {
            principal: "github:ghe.example.test:42",
            login: "enterprise-person",
            email: "enterprise@example.test",
          },
        },
      },
    ];
    setDatabaseEngineReadOnlyAdmission(true);
    try {
      for (const scenario of cases) {
        const config: OpenClawConfig = {
          gateway: {
            github: { host: "ghe.example.test" },
            ...(scenario.hasRoles ? { roles } : {}),
            auth: {
              mode: "trusted-proxy",
              trustedProxy: { userHeader: scenario.enterprise ? "x-factory-principal" : "x-user" },
            },
          },
        };
        const result = await resolveGatewayConnectProfileAdmission({
          context: admissionContext(config),
          state: {
            role: "operator",
            authMethod: scenario.method,
            authResult: {
              ok: true,
              method: scenario.method,
              user: scenario.user,
              ...(scenario.method === "tailscale"
                ? { tailscaleIdentity: { login: scenario.user } }
                : {}),
            },
          },
          ownerProfileExpected: false,
          authenticatedUserId: scenario.user,
          resolveAuthenticatedGitHubIdentity: scenario.sync
            ? createAuthenticatedGitHubIdentitySync({
                authResult: {
                  ok: true,
                  method: scenario.method,
                  user: scenario.user,
                  ...(scenario.method === "tailscale"
                    ? { tailscaleIdentity: { login: scenario.user } }
                    : {}),
                },
                authConfig: config.gateway?.auth,
                config,
                requestHeaders: {
                  "x-factory-github-login": "enterprise-person",
                  "x-factory-github-email": "enterprise@example.test",
                },
                repositoryIdentity: scenario.repositoryIdentity,
              })
            : undefined,
        });
        expect(result.ok, scenario.user).toBe(true);
        if (!result.ok) {
          throw new Error("Readonly profile admission failed");
        }
        expect(result.prepared?.profile.profileId, scenario.user).toBe(scenario.profileId);
        expect(result.prepared?.authority.role).toBe("reader");
        expect(() => result.prepared?.assertIdentityCurrent?.()).not.toThrow();
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(listResidentUserProfileDisplayFacts()).toEqual(before);
    } finally {
      resetDatabaseEngineSelectionForTest();
    }
  });
});

it("refuses absent or unverified readonly bindings without creating or substituting a profile", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    ensureProfileForEmail("missing@github");
    ensureProfileForEmail("access@example.test");
    using catalog = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    void catalog;
    const before = listResidentUserProfileDisplayFacts();
    const sync = vi.fn<NonNullable<Admission["resolveAuthenticatedGitHubIdentity"]>>(async () => {
      throw new Error("Mutable identity synchronization must not run");
    });
    setDatabaseEngineReadOnlyAdmission(true);
    try {
      for (const user of ["missing@github", "absent@example.test", "access@example.test"]) {
        const context = admissionContext({ gateway: { roles } });
        const github = user.endsWith("@github");
        const method = github ? "tailscale" : "trusted-proxy";
        const result = await resolveGatewayConnectProfileAdmission({
          context,
          state: {
            role: "operator",
            authMethod: method,
            authResult: {
              ok: true,
              method,
              user,
              ...(github ? { tailscaleIdentity: { login: user } } : {}),
            },
          },
          ownerProfileExpected: false,
          authenticatedUserId: user,
          resolveAuthenticatedGitHubIdentity: user === "absent@example.test" ? undefined : sync,
        });
        expect(result.ok, user).toBe(false);
        expect(context.sendHandshakeErrorResponse).toHaveBeenCalledOnce();
      }
      expect(sync).not.toHaveBeenCalled();
      expect(listResidentUserProfileDisplayFacts()).toEqual(before);
    } finally {
      resetDatabaseEngineSelectionForTest();
    }
  });
});

it("verifies readonly Cloudflare identities without GitHub enrichment or profile writes", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const github = syncGitHubIdentity({
      identity: { accountId: 101, login: "ada" },
      authenticationAlias: { kind: "email", email: "ada@example.test" },
    });
    const email = ensureProfileForEmail("email@example.test");
    using catalog = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    void catalog;
    const before = listResidentUserProfileDisplayFacts();
    const cases = [
      {
        user: "ada@example.test",
        payload: { id: 101, email: "ada@example.test", idp: { type: "github" } },
        expected: github.id,
      },
      { user: "ada@example.test", payload: oidcIdentity(), expected: github.id },
      {
        user: "email@example.test",
        payload: { email: "email@example.test", idp: { type: "oidc" } },
        expected: email.id,
      },
      {
        user: "ada@example.test",
        payload: { id: 101, email: "other@example.test", idp: { type: "github" } },
        expected: undefined,
      },
    ];
    setDatabaseEngineReadOnlyAdmission(true);
    try {
      for (const scenario of cases) {
        const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
          expect(url).toBe(`${accessOrigin}/cdn-cgi/access/get-identity`);
          return identityResponse(scenario.payload);
        });
        const request = accessRequest(scenario.user, githubCfg);
        try {
          const result = await resolveGatewayConnectProfileAdmission({
            context: admissionContext(githubCfg),
            state: {
              authResult: request.authResult,
              authMethod: "trusted-proxy",
              role: "operator",
            },
            ownerProfileExpected: false,
            authenticatedUserId: scenario.user,
            resolveAuthenticatedGitHubIdentity: createAuthenticatedGitHubIdentitySync({
              authResult: request.authResult,
              authConfig: githubCfg.gateway?.auth,
              requestHeaders: request.req.headers,
            }),
          });
          expect(result.ok).toBe(scenario.expected !== undefined);
          if (result.ok) {
            expect(result.prepared?.profile.profileId).toBe(scenario.expected);
          }
          expect(fetch).toHaveBeenCalledOnce();
          expect(listResidentUserProfileDisplayFacts()).toEqual(before);
        } finally {
          request.req.destroy();
          fetch.mockRestore();
        }
      }
    } finally {
      resetDatabaseEngineSelectionForTest();
    }
  });
});
