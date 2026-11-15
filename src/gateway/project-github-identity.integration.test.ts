import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RepositoryIntegration } from "../plugins/repository-integration.types.js";
import type { GatewayClient } from "./server-methods/types.js";
import { prepareSessionProjectGitAccess } from "./session-project-git-access.js";

const catalog = vi.hoisted(() => ({ emails: ["github:engineering.ghe.com:42"] }));
// Resident catalog facts replace storage only; all admission decisions remain production code.
vi.mock("../state/user-profile-list.js", async (original) => ({
  ...(await original<typeof import("../state/user-profile-list.js")>()),
  captureResidentUserProfileAccess: () => ({
    readCurrentFacts: () => ({
      profileId: "person-1",
      emails: catalog.emails,
      assignedRole: "engineer",
    }),
  }),
}));

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const host = "engineering.ghe.com";
const apiBaseUrl = `https://api.${host}`;
const permissions = { contents: "read" as const, metadata: "read" as const };
function client(): GatewayClient {
  return {
    connId: "human-connection",
    authenticatedGitHubAccountId: 42,
    authenticatedUserId: `github:${host}:42`,
    authenticatedUserProfile: {
      profileId: "person-1",
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "cli", version: "test", platform: "test", mode: "cli" },
      role: "operator",
      scopes: ["operator.read"],
    },
    internal: { authenticatedOperator: true },
  };
}

let config: OpenClawConfig;
let active: boolean;
let deny: boolean;
let providerRetired: boolean;
let beforeAdmission: (() => void) | undefined;
let onRequest: ((path: string) => void) | undefined;
let requests: string[];
let cleanupFails: boolean;
const admissions: unknown[] = [];
const operations: unknown[] = [];
const assertActive = () => {
  if (!active) {
    throw new Error("Session authority retired");
  }
};
const provider: RepositoryIntegration = {
  version: 1,
  preparedCapacity: "image",
  resolveConnectionIdentity: () => undefined,
  async withIdentity(context, run) {
    context.assertCurrent();
    operations.push(context.operation);
    const profile = context.readCurrentProfile();
    expect(Object.keys(profile)).toEqual(["emails", "assignedRole"]);
    expect(profile.assignedRole).toBe("engineer");
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.emails)).toBe(true);
    expect(Object.isFrozen(context.actor.authorization)).toBe(true);
    expect(Object.isFrozen(context.operation.binding)).toBe(true);
    return await run({
      env: context.env,
      assertCurrent: () => {
        context.assertCurrent();
        if (providerRetired) {
          throw new Error("Policy retired");
        }
      },
      readNativeCredential: async (_env, admission) => {
        expect(admission?.selection.app).not.toHaveProperty("privateKey");
        expect(admission?.selection.app).not.toHaveProperty("keyVersion");
        admissions.push(admission);
        beforeAdmission?.();
        if (deny) {
          throw new Error("Repository admission denied");
        }
        return undefined;
      },
    });
  },
};
vi.mock("../plugins/repository-integration-runtime.js", () => ({
  getRepositoryIntegration: () => provider,
}));

beforeEach(() => {
  active = true;
  deny = false;
  providerRetired = false;
  admissions.length = 0;
  operations.length = 0;
  beforeAdmission = undefined;
  cleanupFails = false;
  requests = [];
  onRequest = undefined;
  catalog.emails = [`github:${host}:42`];
  config = {
    gateway: { github: { host, apiBaseUrl } },
    tools: {
      github: {
        kind: "app-installation",
        profileId: "ghp_00000000000000000000000000000001",
        app: {
          appId: 101,
          installationId: 202,
          accountId: 303,
          repositories: [{ id: 404, fullName: "example/project" }],
          permissions,
          privateKey,
          keyVersion: "synthetic-v1",
        },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = url.startsWith(apiBaseUrl) ? url.slice(apiBaseUrl.length) : new URL(url).pathname;
    requests.push(`${init.method} ${path}`);
    onRequest?.(path);
    if (init.method === "DELETE") {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-app-token");
      return new Response(null, { status: cleanupFails ? 503 : 204 });
    }
    const bodies: Record<string, unknown> = {
      "/app": { id: 101, slug: "factory", permissions },
      "/app/installations/202": {
        id: 202,
        app_id: 101,
        account: { id: 303 },
        suspended_at: null,
        permissions,
      },
      "/app/installations/202/access_tokens": {
        token: "synthetic-app-token",
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        permissions,
      },
      "/users/factory%5Bbot%5D": { id: 9001, login: "factory[bot]", type: "Bot", avatar_url: null },
      "/installation/repositories?per_page=100": {
        total_count: 1,
        repositories: [{ id: 404, full_name: "example/project" }],
      },
      "/repos/example/project/issues/1": { title: "Private issue" },
    };
    if (!(path in bodies)) {
      throw new Error(`Unexpected external request: ${path}`);
    }
    if (path.endsWith("/access_tokens")) {
      if (typeof init.body !== "string") {
        throw new Error("Missing App token request body");
      }
      expect(JSON.parse(init.body)).toEqual({ repository_ids: [404], permissions });
    }
    if (path === "/repos/example/project/issues/1") {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-app-token");
    }
    return Response.json(bodies[path]);
  });
});

afterEach(() => {
  setRuntimeConfigSnapshot({});
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "precreation App identity retains policy admission without a broker token (denied=%s)",
  async (denied) => {
    deny = denied;
    const caller = client();
    caller.connect.scopes = ["operator.write"];
    const pending = prepareSessionProjectGitAccess({
      cfg: config,
      context: { getRuntimeConfig: () => config },
      client: caller,
      agentId: "main",
      sessionKey: "agent:main:dashboard:precreation",
      gitUrl: `https://${host}/example/project.git`,
      assertCurrent: assertActive,
    });
    if (denied) {
      await expect(pending).rejects.toThrow("Repository admission denied");
      expect(requests).toEqual([]);
      return;
    }
    const access = await pending;
    try {
      expect(operations[0]).toMatchObject({
        purpose: "session-create-project",
        binding: {
          kind: "session-create",
          agentId: "main",
          sessionKey: "agent:main:dashboard:precreation",
        },
      });
      expect(operations[0]).not.toHaveProperty("binding.sessionId");
      expect(admissions).toHaveLength(1);
      expect(access?.token).toBe("synthetic-app-token");
      expect(access?.gitNetwork?.env?.GIT_CONFIG_KEY_0).toBe(`http.https://${host}/.extraHeader`);
      expect(requests).toContain("POST /app/installations/202/access_tokens");
      await access?.gitNetwork?.startRun?.(() => undefined);
      active = false;
      expect(() => access?.assertCurrent()).toThrow("retired");
    } finally {
      await access?.[Symbol.asyncDispose]();
    }
    expect(requests.at(-1)).toBe("DELETE /installation/token");
  },
);
