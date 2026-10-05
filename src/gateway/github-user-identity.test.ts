import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "../state/user-profile-writes.worker.js";
import {
  ensureProfileForTailscaleIdentity,
  ensureFactoryGitHubProfile,
  ensureProfileForEmail,
  getUserProfileDisplay,
  getUserProfileListItem,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildAuthenticatedPresenceUser } from "./authenticated-presence-user.js";
import type { ControlUiGitHubError } from "./github-public-api.js";
import {
  createAuthenticatedGitHubIdentitySync,
  resolveTrustedFactoryGitHubAccountId,
  resolveTrustedFactoryGitHubMetadata,
} from "./github-user-identity.js";

const reader = vi.hoisted(() => ({ active: false }));
vi.mock("../process/gateway-work-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/gateway-work-admission.js")>()),
  isGatewayReadonlyWork: () => reader.active,
}));

it("attests a Factory account id only from the admitted trusted-proxy principal", () => {
  const authConfig = {
    mode: "trusted-proxy" as const,
    trustedProxy: { userHeader: "x-factory-principal" },
  };
  const authResult = {
    ok: true as const,
    method: "trusted-proxy" as const,
    user: "github:microsoft.ghe.com:101",
  };
  expect(resolveTrustedFactoryGitHubAccountId({ authConfig, authResult })).toBe(101);
  expect(
    resolveTrustedFactoryGitHubAccountId({
      authConfig,
      authResult: { ...authResult, method: "password" },
    }),
  ).toBeUndefined();
  expect(
    resolveTrustedFactoryGitHubAccountId({
      authConfig,
      authResult: { ...authResult, user: "github:microsoft.ghe.com:101.evil" },
    }),
  ).toBeUndefined();
  expect(
    resolveTrustedFactoryGitHubAccountId({
      authConfig: { ...authConfig, trustedProxy: { userHeader: "x-other" } },
      authResult,
    }),
  ).toBeUndefined();
});

it("accepts bounded Factory metadata only beside its verified principal", () => {
  const authConfig = {
    mode: "trusted-proxy" as const,
    trustedProxy: { userHeader: "x-factory-principal" },
  };
  const authResult = {
    ok: true as const,
    method: "trusted-proxy" as const,
    user: "github:microsoft.ghe.com:101",
  };
  const requestHeaders = {
    "x-factory-github-login": "first-admin",
    "x-factory-github-name": "First Admin",
    "x-factory-github-email": "first-admin@example.test",
    "x-factory-github-avatar-url": "https://microsoft.ghe.com/avatars/u/101",
  };
  expect(resolveTrustedFactoryGitHubMetadata({ authConfig, authResult, requestHeaders })).toEqual({
    accountId: 101,
    email: "first-admin@example.test",
    login: "first-admin",
    name: "First Admin",
    avatarUrl: "https://microsoft.ghe.com/avatars/u/101",
  });
  expect(
    resolveTrustedFactoryGitHubMetadata({
      authConfig,
      authResult: { ...authResult, method: "password" },
      requestHeaders,
    }),
  ).toBeUndefined();
  expect(
    resolveTrustedFactoryGitHubMetadata({
      authConfig,
      authResult: { ...authResult, user: "github:microsoft.ghe.com:202" },
      requestHeaders,
    })?.avatarUrl,
  ).toBeUndefined();
  expect(
    resolveTrustedFactoryGitHubMetadata({
      authConfig,
      authResult,
      requestHeaders: { ...requestHeaders, "x-factory-github-login": "not a login" },
    }),
  ).toBeUndefined();
});

it("adopts each Factory account's name without changing another profile or a chosen name", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = {
      mode: "trusted-proxy" as const,
      trustedProxy: { userHeader: "x-factory-principal" },
    };
    const sync = (id: number, login: string, name: string) =>
      createAuthenticatedGitHubIdentitySync({
        authResult: { ok: true, method: "trusted-proxy", user: `github:microsoft.ghe.com:${id}` },
        authConfig: config,
        requestHeaders: {
          "x-factory-github-login": login,
          "x-factory-github-name": name,
          "x-factory-github-email": `${login}@example.test`,
          "x-factory-github-avatar-url": `https://microsoft.ghe.com/avatars/u/${id}`,
        },
      })!();
    const first = await sync(101, "first-admin", "First Admin");
    const second = await sync(202, "second-admin", "Second Admin");
    expect(first.factory?.accountId).toBe(101);
    expect(second.factory?.accountId).toBe(202);
    expect(first.profileId).not.toBe(second.profileId);
    expect(getUserProfileListItem(first.profileId).emails).toContain("first-admin@example.test");
    expect(getUserProfileListItem(second.profileId).emails).toContain("second-admin@example.test");
    expect(getUserProfileListItem(first.profileId).displayName).toBe("First Admin");
    expect(getUserProfileListItem(second.profileId).displayName).toBe("Second Admin");
    setDisplayName(first.profileId, "Chosen Name");
    await sync(101, "renamed-first", "New GitHub Name");
    expect(getUserProfileListItem(first.profileId).displayName).toBe("Chosen Name");
    expect(getUserProfileListItem(second.profileId).displayName).toBe("Second Admin");
  });
});

it("rejects malformed Factory email without inventing an alias", () => {
  for (const email of [
    "alice",
    "a@b@c",
    "a b@example.test",
    "a@example.test,b@example.test",
    ["a@b"],
    "a@b\nInjected: yes",
    "é@example.test",
    "a".repeat(255) + "@b",
  ]) {
    const metadata = resolveTrustedFactoryGitHubMetadata({
      authConfig: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-factory-principal" } },
      authResult: { ok: true, method: "trusted-proxy", user: "github:microsoft.ghe.com:101" },
      requestHeaders: { "x-factory-github-login": "alice", "x-factory-github-email": email },
    });
    expect(metadata?.email).toBeUndefined();
  }
});

it("keeps a conflicting email, role and chosen name with their existing person", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const original = ensureProfileForEmail("existing@example.test");
    setDisplayName(original.id, "Chosen Original");
    setUserProfileRole(original.id, "admin");
    const factory = ensureFactoryGitHubProfile("github:microsoft.ghe.com:101", "Factory User");
    const before = getUserProfileListItem(original.id);
    const sync = createAuthenticatedGitHubIdentitySync({
      authConfig: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-factory-principal" } },
      authResult: { ok: true, method: "trusted-proxy", user: "github:microsoft.ghe.com:101" },
      requestHeaders: {
        "x-factory-github-login": "alice",
        "x-factory-github-email": " EXISTING@example.test ",
      },
    })!;
    await expect(sync()).rejects.toThrow("already bound to another profile");
    expect(getUserProfileListItem(original.id)).toEqual(before);
    expect(getUserProfileListItem(factory.id)).toMatchObject({
      emails: ["github:microsoft.ghe.com:101"],
      mergedInto: null,
    });
  });
});

it("reads the frozen Factory profile without adopting changed provider metadata", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const principal = "github:microsoft.ghe.com:101";
    const profile = ensureFactoryGitHubProfile(principal, "Frozen Name");
    const before = getUserProfileListItem(profile.id);
    reader.active = true;
    try {
      const sync = createAuthenticatedGitHubIdentitySync({
        authConfig: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-factory-principal" } },
        authResult: { ok: true, method: "trusted-proxy", user: principal },
        requestHeaders: {
          "x-factory-github-login": "alice",
          "x-factory-github-name": "Changed Name",
          "x-factory-github-email": "new@example.test",
        },
      })!;
      await expect(sync()).resolves.toMatchObject({ profileId: profile.id });
      expect(getUserProfileListItem(profile.id)).toEqual(before);
    } finally {
      reader.active = false;
    }
  });
});

function githubResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function githubBodyReadFailure() {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("body read failed"));
      },
    }),
    { status: 200 },
  );
}

function accessAssertion(issuer: unknown): string {
  const payload = Buffer.from(JSON.stringify({ iss: issuer })).toString("base64url");
  return `header.${payload}.signature`;
}

function tailscaleSync(login = "ada", name = "Ada") {
  return createAuthenticatedGitHubIdentitySync({
    authResult: {
      ok: true,
      method: "tailscale",
      user: `${login}@github`,
      tailscaleIdentity: { login: `${login}@github`, name },
    },
  });
}

function cloudflareSync(params: {
  principal?: string;
  assertion?: string;
  userHeader?: string;
  requiredHeaders?: string[];
}) {
  return createAuthenticatedGitHubIdentitySync({
    authResult: {
      ok: true,
      method: "trusted-proxy",
      user: params.principal ?? "ada@example.com",
    },
    authConfig: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: params.userHeader ?? "cf-access-authenticated-user-email",
        requiredHeaders: params.requiredHeaders ?? ["CF-Access-JWT-Assertion"],
      },
    },
    requestHeaders: {
      "cf-access-authenticated-user-email": params.principal ?? "ada@example.com",
      "cf-access-jwt-assertion":
        params.assertion ?? accessAssertion("https://team.cloudflareaccess.com"),
    },
  });
}

beforeEach(() => {
  vi.stubEnv("GH_TOKEN", undefined);
  vi.stubEnv("GITHUB_TOKEN", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawStateDatabaseForTest();
});

describe("authenticated GitHub identity sync", () => {
  it.each(["tailscale", "access"] as const)(
    "verifies a fresh public %s identity without using the Enterprise repository credential",
    async (provider) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot({
          gateway: {
            github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
            controlUi: {
              github: { host: "ghe.example.test", token: "enterprise-service-token" },
            },
          },
        });
        vi.stubEnv("GH_TOKEN", "configured-service-token");
        const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const authorization = new Headers(init?.headers).get("Authorization");
          if (url.startsWith("https://team.cloudflareaccess.com/")) {
            expect(authorization).toBeNull();
            return githubResponse({
              id: 583231,
              email: "ada@example.com",
              idp: { type: "github" },
            });
          }
          expect(url).toBe(
            provider === "access"
              ? "https://api.github.com/user/583231"
              : "https://api.github.com/users/ada",
          );
          return authorization === "Bearer configured-service-token"
            ? githubResponse({ id: 583231, login: "Ada" })
            : githubResponse({}, 403, { "x-ratelimit-remaining": "0" });
        });
        const sync = provider === "access" ? cloudflareSync({}) : tailscaleSync();
        const result = await sync!();
        expect(getUserProfileListItem(result.profileId).githubIdentity).toMatchObject({
          login: "Ada",
        });
        expect(fetchMock).toHaveBeenCalledTimes(provider === "access" ? 2 : 1);
      });
    },
  );

  it.each(["success", "network failure"])(
    "preserves verified identity after stale service auth and anonymous %s",
    async (anonymousOutcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const profile = syncGitHubIdentity({
          identity: { accountId: 58493, login: "Ada" },
          authenticationAlias: { kind: "email", email: "ada@example.com" },
        });
        setRuntimeConfigSnapshot({
          gateway: { controlUi: { github: { token: "stale-service-token" } } },
        });
        const fetchMock = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(
            githubResponse({ id: 58493, email: "ada@example.com", idp: { type: "github" } }),
          )
          .mockResolvedValueOnce(githubResponse({}, 401));
        if (anonymousOutcome === "success") {
          fetchMock.mockResolvedValueOnce(githubResponse({ id: 58493, login: "Ada" }));
        } else {
          fetchMock.mockRejectedValueOnce(new Error("network unavailable"));
        }
        await expect(cloudflareSync({})!()).resolves.toMatchObject({ profileId: profile.id });
        expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(
          "Bearer stale-service-token",
        );
        expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).has("Authorization")).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(3);
      });
    },
  );

  it("does not bypass an unavailable configured credential with anonymous or cached identity", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { GH_TOKEN: "other-process-token" } },
      async () => {
        syncGitHubIdentity({
          identity: { accountId: 58493, login: "Ada" },
          authenticationAlias: { kind: "email", email: "ada@example.com" },
        });
        setRuntimeConfigSnapshot({
          gateway: {
            controlUi: {
              github: {
                token: { source: "env", provider: "default", id: "UNAVAILABLE_SERVICE_TOKEN" },
              },
            },
          },
        });
        const fetchMock = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(
            githubResponse({ id: 58493, email: "ada@example.com", idp: { type: "github" } }),
          )
          .mockResolvedValueOnce(githubResponse({}, 429));
        await expect(cloudflareSync({})!()).rejects.toBeInstanceOf(SecretSurfaceUnavailableError);
        expect(fetchMock).toHaveBeenCalledOnce();
      },
    );
  });

  describe.each(["tailscale", "access"] as const)("%s display names", (provider) => {
    it.each([
      {
        label: "GitHub priority",
        name: "  Ada Lovelace  ",
        initial: "Provider Ada",
        expected: "Ada Lovelace",
      },
      {
        label: "blank GitHub name",
        name: " \t ",
        initial: "Provider Ada",
        expected: "Provider Ada",
      },
      {
        label: "non-string GitHub name",
        name: 123,
        initial: "Provider Ada",
        expected: "Provider Ada",
      },
      { label: "no names", expected: null },
    ])("adopts $label without extra requests", async ({ name, initial, expected }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch");
        if (provider === "access") {
          fetchMock.mockResolvedValueOnce(
            githubResponse({
              id: 583231,
              email: "ada@example.com",
              name: initial,
              idp: { type: "github" },
            }),
          );
        }
        fetchMock.mockResolvedValueOnce(githubResponse({ id: 583231, login: "Ada", name }));
        const sync =
          provider === "access" ? cloudflareSync({}) : tailscaleSync("ada", initial ?? "");
        const result = await sync!();
        const display = getUserProfileDisplay(result.profileId);
        expect(display.displayName).toBe(expected);
        const presenceUser = buildAuthenticatedPresenceUser({
          authenticatedUserId: provider === "access" ? "ada@example.com" : "ada@github",
          authenticatedUserIsTailscaleProvider: provider === "tailscale",
          authenticatedUserProfile: { profileId: display.id, ...display },
        });
        expect(presenceUser?.name).toBe(expected ?? undefined);
        expect(presenceUser?.id).toBe(result.profileId);
        await sync!();
        expect(fetchMock).toHaveBeenCalledTimes(provider === "access" ? 2 : 1);
      });
    });
  });

  it("resolves the canonical public account without authentication", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForTailscaleIdentity({ login: "octocat@github" });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(githubResponse({ id: 583231, login: "OctoCat" }));

      const sync = tailscaleSync("octocat", "Octo Cat");

      await expect(sync?.()).resolves.toMatchObject({
        profileId: profile.id,
      });
      expect(getUserProfileListItem(profile.id).githubIdentity).toMatchObject({
        login: "OctoCat",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/users/octocat",
        expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }),
      );
      const headers = fetchMock.mock.calls[0]?.[1]?.headers;
      expect(headers).toMatchObject({
        Accept: "application/vnd.github+json",
        "User-Agent": "OpenClaw-Control-UI",
        "X-GitHub-Api-Version": "2022-11-28",
      });
      expect(headers).not.toHaveProperty("Authorization");
    });
  });

  it.each([
    {
      name: "not found",
      response: githubResponse({ message: "Not Found" }, 404),
      statusCode: 404,
    },
    {
      name: "rate limited",
      response: githubResponse({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0" }),
      statusCode: 429,
    },
    { name: "malformed", response: githubResponse({ id: "583231" }), statusCode: 502 },
  ])("maps a $name response", async ({ response, statusCode }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
      const sync = tailscaleSync("octocat", "Octo Cat");
      await expect(sync?.()).rejects.toMatchObject({
        statusCode,
      } satisfies Partial<ControlUiGitHubError>);
    });
  });

  it("maps network failures and rejects invalid usernames before fetch", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
      const sync = tailscaleSync("octocat", "Octo Cat");
      await expect(sync?.()).rejects.toMatchObject({
        statusCode: 502,
      } satisfies Partial<ControlUiGitHubError>);
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  it("deduplicates concurrent sync and preserves a custom edit during the lookup", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForTailscaleIdentity({ login: "ada@github" });
      setDisplayName(profile.id, "Ada");
      let resolveLookup: ((response: Response) => void) | undefined;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(
        async () =>
          await new Promise<Response>((resolve) => {
            resolveLookup = resolve;
          }),
      );

      const sync = tailscaleSync();
      const first = sync?.();
      const second = sync?.();
      expect(second).toBe(first);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      setDisplayName(profile.id, "User Chosen");
      resolveLookup?.(githubResponse({ id: 583231, login: "Ada", name: "Ada Lovelace" }));

      await expect(first).resolves.toMatchObject({ profileId: profile.id });
      expect(getUserProfileListItem(profile.id).githubIdentity).toMatchObject({ login: "Ada" });
      expect(getUserProfileDisplay(profile.id).displayName).toBe("User Chosen");
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  it("preserves verified identity after lookup failure and retries later", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForTailscaleIdentity({ login: "ada@github" });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(githubResponse({ id: 583231, login: "Ada" }))
        .mockRejectedValueOnce(new Error("network unavailable"))
        .mockResolvedValueOnce(githubResponse({ id: 583231, login: "Ada-Renamed" }));

      const firstConnection = tailscaleSync();
      await firstConnection?.();
      const failingConnection = tailscaleSync();
      await expect(failingConnection?.()).rejects.toMatchObject({ statusCode: 502 });
      expect(getUserProfileListItem(profile.id).githubIdentity).toMatchObject({ login: "Ada" });

      await failingConnection?.();
      expect(getUserProfileListItem(profile.id).githubIdentity).toMatchObject({
        login: "Ada-Renamed",
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  it("activates only the standard required-header Cloudflare Access contract", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      expect(cloudflareSync({})).toBeTypeOf("function");
      expect(cloudflareSync({ userHeader: "x-forwarded-user" })).toBeUndefined();
      expect(cloudflareSync({ requiredHeaders: ["x-forwarded-proto"] })).toBeUndefined();
    });
  });

  it("binds Cloudflare identity to email, GitHub IdP, numeric id, and canonical GitHub login", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          githubResponse({
            id: 58493,
            email: "ADA@example.com",
            name: "Ada Display Name",
            idp: { id: "github-oauth", type: "github" },
          }),
        )
        .mockResolvedValueOnce(githubResponse({ id: 58493, login: "steipete" }));

      const sync = cloudflareSync({});
      const result = await sync?.();
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "https://team.cloudflareaccess.com/cdn-cgi/access/get-identity",
        expect.objectContaining({
          headers: {
            Cookie: expect.stringMatching(/^CF_Authorization=/u),
          },
          redirect: "manual",
          signal: expect.any(AbortSignal),
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://api.github.com/user/58493",
        expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }),
      );
      expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty("Authorization");
      expect(getUserProfileListItem(result!.profileId)).toMatchObject({
        displayName: "Ada Display Name",
        emails: ["ada@example.com"],
        githubIdentity: { login: "steipete" },
      });

      clock.mockReturnValue(1_800_000_000_000 + 15 * 60_000);
      fetchMock
        .mockResolvedValueOnce(
          githubResponse({
            id: 58493,
            email: "ada@example.com",
            idp: { type: "github" },
          }),
        )
        .mockResolvedValueOnce(githubResponse({ id: 58493, login: "steipete-renamed" }));
      await expect(cloudflareSync({})?.()).resolves.toMatchObject({
        profileId: result!.profileId,
      });
      expect(getUserProfileListItem(result!.profileId).githubIdentity).toMatchObject({
        login: "steipete-renamed",
      });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  it.each([
    { name: "malformed JWT", assertion: "not-a-jwt" },
    { name: "oversized JWT", assertion: "x".repeat(16 * 1024 + 1) },
    { name: "non-HTTPS issuer", issuer: "http://team.cloudflareaccess.com" },
    { name: "credentialed issuer", issuer: "https://user@team.cloudflareaccess.com" },
    { name: "non-root issuer", issuer: "https://team.cloudflareaccess.com/path" },
    { name: "hostile suffix", issuer: "https://team.cloudflareaccess.com.evil.test" },
  ])("rejects a $name before network access", async ({ assertion, issuer }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const sync = cloudflareSync({
        assertion: assertion ?? accessAssertion(issuer),
      });
      await expect(sync?.()).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      name: "redirect",
      access: githubResponse({}, 302, { location: "https://evil.test/identity" }),
    },
    { name: "non-object response", access: githubResponse([]) },
    {
      name: "malformed JSON",
      access: new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
    },
    {
      name: "mismatched email",
      access: githubResponse({
        id: 58493,
        email: "mallory@example.com",
        idp: { type: "github" },
      }),
    },
    {
      name: "unsupported IdP",
      access: githubResponse({
        id: 58493,
        email: "ada@example.com",
        idp: { type: "google" },
      }),
    },
    {
      name: "invalid account id",
      access: githubResponse({
        id: "58493",
        email: "ada@example.com",
        idp: { type: "github" },
      }),
    },
  ])("fails safely for a $name", async ({ access }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForTailscaleIdentity({ login: "ada@passkey" });
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(access);
      const sync = cloudflareSync({});
      await expect(sync?.()).rejects.toThrow();
      expect(getUserProfileListItem(profile.id).githubIdentity).toBeNull();
    });
  });

  it("rejects a GitHub account-id mismatch without erasing prior identity", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      setRuntimeConfigSnapshot({
        gateway: { controlUi: { github: { token: "configured-service-token" } } },
      });
      const initialFetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          githubResponse({
            id: 58493,
            email: "ada@example.com",
            idp: { type: "github" },
          }),
        )
        .mockResolvedValueOnce(githubResponse({ id: 58493, login: "steipete" }));
      const first = await cloudflareSync({})?.();
      clock.mockReturnValue(1_800_000_000_000 + 15 * 60_000);
      initialFetch
        .mockResolvedValueOnce(
          githubResponse({
            id: 58493,
            email: "ada@example.com",
            idp: { type: "github" },
          }),
        )
        .mockResolvedValueOnce(githubResponse({ id: 99999, login: "mallory" }));

      await expect(cloudflareSync({})?.()).rejects.toThrow();
      expect(getUserProfileListItem(first!.profileId).githubIdentity).toMatchObject({
        login: "steipete",
      });
    });
  });

  it.each([
    {
      name: "GitHub rate limit",
      githubResult: githubResponse({ message: "rate limit" }, 403, {
        "x-ratelimit-remaining": "0",
      }),
    },
    { name: "GitHub upstream failure", githubResult: githubResponse({}, 503) },
    { name: "GitHub network failure", githubError: new Error("network unavailable") },
  ])(
    "reattaches the exact cached verified identity after a $name",
    async ({ githubResult, githubError }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
        const fetchMock = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(
            githubResponse({
              id: 58493,
              email: "ada@example.com",
              idp: { type: "github" },
            }),
          )
          .mockResolvedValueOnce(githubResponse({ id: 58493, login: "steipete" }));
        const first = await cloudflareSync({})?.();
        clock.mockReturnValue(1_800_000_000_000 + 15 * 60_000);
        fetchMock.mockResolvedValueOnce(
          githubResponse({
            id: 58493,
            email: "ada@example.com",
            idp: { type: "github" },
          }),
        );
        if (githubError) {
          fetchMock.mockRejectedValueOnce(githubError);
        } else {
          fetchMock.mockResolvedValueOnce(githubResult!);
        }

        await expect(cloudflareSync({ principal: "ADA@Example.COM" })?.()).resolves.toEqual(first);
        expect(getUserProfileListItem(first!.profileId).githubIdentity).toMatchObject({
          login: "steipete",
        });
        expect(fetchMock).toHaveBeenCalledTimes(4);
      });
    },
  );

  it.each([
    { name: "malformed GitHub response", githubStatus: 200, expectedStatus: 502, malformed: true },
    {
      name: "GitHub body read failure",
      githubStatus: 200,
      expectedStatus: 502,
      bodyReadFailure: true,
    },
    { name: "non-retryable GitHub request", githubStatus: 400, expectedStatus: 502 },
    { name: "unauthorized GitHub account", githubStatus: 401 },
    { name: "GitHub permission denial", githubStatus: 403 },
    { name: "deleted GitHub account", githubStatus: 404 },
    { name: "different cached account", githubStatus: 429, accessAccountId: 99999 },
    { name: "different cached email", githubStatus: 429, principal: "mallory@example.com" },
    {
      name: "email and account on different profiles",
      githubStatus: 429,
      accessAccountId: 99999,
      otherProfile: true,
    },
    { name: "missing cached identity", githubStatus: 429, seedCache: false },
  ])(
    "fails closed for a $name",
    async ({
      githubStatus,
      expectedStatus,
      malformed,
      bodyReadFailure,
      accessAccountId,
      principal,
      otherProfile,
      seedCache,
    }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        if (seedCache !== false) {
          syncGitHubIdentity({
            identity: { accountId: 58493, login: "steipete" },
            authenticationAlias: { kind: "email", email: "ada@example.com" },
          });
        }
        if (otherProfile) {
          syncGitHubIdentity({
            identity: { accountId: 99999, login: "mallory" },
            authenticationAlias: { kind: "email", email: "mallory@example.com" },
          });
        }
        const authenticatedEmail = principal ?? "ada@example.com";
        const fetchMock = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValueOnce(
            githubResponse({
              id: accessAccountId ?? 58493,
              email: authenticatedEmail,
              idp: { type: "github" },
            }),
          )
          .mockResolvedValueOnce(
            bodyReadFailure
              ? githubBodyReadFailure()
              : malformed
                ? new Response("{", { status: githubStatus })
                : githubResponse({}, githubStatus),
          );

        await expect(cloudflareSync({ principal: authenticatedEmail })?.()).rejects.toMatchObject({
          statusCode: expectedStatus ?? githubStatus,
        } satisfies Partial<ControlUiGitHubError>);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    },
  );

  it("redacts the Access assertion from network failures and retries on the same connection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const assertion = accessAssertion("https://team.cloudflareaccess.com");
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error(`network rejected ${assertion}`))
        .mockResolvedValueOnce(
          githubResponse({
            id: 58493,
            email: "ada@example.com",
            idp: { type: "github" },
          }),
        )
        .mockResolvedValueOnce(githubResponse({ id: 58493, login: "steipete" }));
      const sync = cloudflareSync({ assertion });

      const error = await sync?.().catch((failure: unknown) => failure);
      expect(String(error)).not.toContain(assertion);
      const result = await sync?.();
      expect(result?.profileId).toBeTypeOf("string");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
