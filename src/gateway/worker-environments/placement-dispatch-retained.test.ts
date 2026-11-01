import { generateKeyPairSync } from "node:crypto";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RepositoryIntegration } from "../../plugins/repository-integration.types.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { repositoryDispatchCredentialReader } from "../repository-dispatch.js";
import type { GatewayClient } from "../server-methods/types.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { requireWorkerProfile } from "./service-validation.js";
import * as support from "./service.test-support.js";
const policy = vi.hoisted(() => ({ current: undefined as RepositoryIntegration | undefined }));
vi.mock("../../plugins/repository-integration-runtime.js", () => ({
  getRepositoryIntegration: () => policy.current,
}));
// Mock only external integration policy; dispatch, authority and App issuance remain native.
vi.mock("../../state/user-profile-list.js", async (original) => ({
  ...(await original<typeof import("../../state/user-profile-list.js")>()),
  captureResidentUserProfileAccess: () => ({
    readCurrentFacts: () => ({ profileId: "person-1", emails: ["github:engineering.ghe.com:42"] }),
  }),
}));

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const host = "engineering.ghe.com";
const apiBaseUrl = `https://api.${host}`;
const permissions = { contents: "read" as const, metadata: "read" as const };
const commit = "a".repeat(40);
const tree = "b".repeat(40);
const installationBoundary = new Error("retained runtime installation reached");

describe("retained repository dispatch preparation", () => {
  support.setupWorkerEnvironmentServiceSuite();
  afterEach(() => {
    policy.current = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    "configured",
    "inherited",
    "revoked",
    "missing-reader",
    "outside-selection",
    "broker-denied",
    "cleanup-settlement",
    "native-app",
    "native-cleanup-settlement",
    "native-cancelled",
  ] as const)(
    "keeps retained repository dispatch outside unbound image reserves (%s)",
    async (selection) => {
      const nativeApp = selection.startsWith("native-");
      const holdCleanup =
        selection === "cleanup-settlement" || selection === "native-cleanup-settlement";
      const controller = new AbortController();
      vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
      support.testState.config.agents = { entries: { main: {} } };
      vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "synthetic-broker-password");
      support.testState.config.gateway = { github: { host, apiBaseUrl } };
      support.testState.config.tools = {
        github: {
          kind: "app-installation",
          profileId: "ghp_00000000000000000000000000000001",
          app: {
            appId: 101,
            installationId: 202,
            accountId: 303,
            repositories: [
              { id: 405, fullName: "example/other" },
              ...(selection === "outside-selection"
                ? []
                : [{ id: 404, fullName: "example/project" }]),
            ],
            permissions,
            privateKey,
            keyVersion: "synthetic-v1",
          },
        },
      };
      const profile = support.getDevelopmentProfile();
      profile.retention = { mode: "session-disk", computeWindowSeconds: 14400 };
      const repository = await getSessionRepositoryWorkspaceStore().create({
        agentId: REQUEST.agentId,
        sessionKey: REQUEST.sessionKey,
        url: `https://${host}/example/project.git`,
        requestedRef: commit,
        runSetupScript: false,
        assertCurrent: () => {},
      });
      const caller: GatewayClient = {
        connId: "human-connection",
        authenticatedGitHubAccountId: 42,
        authenticatedRepositoryCredentialSource: Object.freeze({
          id: "synthetic-original-source",
          expiresAtMs: Date.now() + 300_000,
        }),
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
          scopes: ["operator.write"],
        },
        internal: { authenticatedOperator: true },
      };
      const requestDigest = sha256Hex("retained-fixture-target");
      policy.current = {
        version: 1,
        preparedCapacity: "image",
        resolveConnectionIdentity: () => undefined,
        async withIdentity(context, run) {
          context.assertCurrent();
          expect(context.actor).toMatchObject({
            actorId: 42,
            profileId: "person-1",
            credentialSource: caller.authenticatedRepositoryCredentialSource,
          });
          expect(context.operation).toMatchObject({ purpose: "session-dispatch-project" });
          return run({
            env: context.env,
            assertCurrent: context.assertCurrent,
            readNativeCredential: async (_env, admission) => {
              context.assertCurrent();
              expect(admission).toMatchObject({ kind: "repository-admission", host });
              if (selection === "broker-denied") {
                throw new Error("Integration admission denied");
              }
              if (selection === "revoked") {
                caller.invalidated = true;
              }
              context.assertCurrent();
              return undefined;
            },
          });
        },
      };
      if (nativeApp) {
        policy.current = undefined;
      }
      const reader = repositoryDispatchCredentialReader({
        ...REQUEST,
        client: caller,
        requestDigest,
        assertCurrent: () => {},
      });
      if (nativeApp) {
        expect(reader).toBeUndefined();
      } else if (!reader) {
        throw new Error("Expected integration reader");
      }
      const readNativeCredential = vi.fn(reader);
      const cleanupEntered = createDeferred();
      const releaseCleanup = createDeferred();
      let minted = 0;
      let revoked = 0;
      const fetchMetadata = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        let result: unknown;
        expect(url.origin).toBe(apiBaseUrl);
        if (url.pathname === "/app") {
          if (selection === "native-cancelled") {
            controller.abort(new Error("Native dispatch caller closed"));
          }
          result = { id: 101, slug: "factory", permissions };
        } else if (url.pathname === "/app/installations/202") {
          result = { id: 202, app_id: 101, account: { id: 303 }, suspended_at: null, permissions };
        } else if (url.pathname === "/app/installations/202/access_tokens") {
          expect(await request.json()).toEqual({ repository_ids: [404], permissions });
          minted++;
          result = {
            token: "synthetic-app-token",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions,
          };
        } else if (url.pathname === "/installation/token" && request.method === "DELETE") {
          expect(request.headers.get("authorization")).toBe("Bearer synthetic-app-token");
          cleanupEntered.resolve();
          if (holdCleanup) {
            await releaseCleanup.promise;
          }
          revoked++;
          return new Response(null, { status: 204 });
        } else if (url.pathname === "/users/factory%5Bbot%5D") {
          result = { id: 9001, login: "factory[bot]", type: "Bot", avatar_url: null };
        } else if (url.pathname === "/installation/repositories") {
          result = { total_count: 1, repositories: [{ id: 404, full_name: "example/project" }] };
        } else if (url.pathname === "/graphql") {
          result = {
            data: {
              node: {
                __typename: "Repository",
                node_id: "R_retained_fixture",
                clone_url: repository.url,
                private: true,
                object: { __typename: "Commit", sha: commit, tree: { sha: tree } },
              },
            },
          };
        } else if (url.pathname === "/repos/example/project") {
          result = { node_id: "R_retained_fixture", clone_url: repository.url, private: true };
        } else if (url.pathname === `/repos/example/project/git/commits/${commit}`) {
          result = { sha: commit, tree: { sha: tree } };
        } else if (url.pathname === `/repos/example/project/git/trees/${tree}`) {
          result = { sha: tree, truncated: false, tree: [] };
        } else {
          throw new Error(`Unexpected fixture metadata request: ${url.pathname}`);
        }
        if (url.pathname.startsWith("/repos/") || url.pathname === "/graphql") {
          expect(url.origin).toBe(apiBaseUrl);
          expect(request.headers.get("authorization")).toBe("Bearer synthetic-app-token");
        }
        return new Response(JSON.stringify(result));
      });
      vi.stubGlobal("fetch", fetchMetadata);
      const provision = vi.fn<import("../../plugins/types.js").WorkerProvider["provision"]>(
        async (_profile, _operationId, options) => {
          const record = support.testState.store.list().find((entry) => entry.retention);
          expect(record).toMatchObject({
            retention: {
              owner: {
                sessionId: REQUEST.sessionId,
                sessionKey: REQUEST.sessionKey,
                agentId: REQUEST.agentId,
              },
              policy: { mode: "session-disk", computeWindowSeconds: 14400 },
            },
          });
          expect(record?.profileSnapshot.project).toBeUndefined();
          // This provider cannot capture retained images; private allocation never adopts a reserve.
          expect(record?.profileSnapshot.runtimePreparation).toBeUndefined();
          const enrollment = await options!.beginNodeEnrollment!();
          if (enrollment.mode !== "connect") {
            throw new Error("Expected canonical pending setup");
          }
          await completeWorkerNodeSetupForTest({
            baseDir: support.testState.root,
            store: support.testState.store,
            setupId: enrollment.setupId,
            deviceId: "retained-node",
            completedAtMs: support.testState.nowMs,
          });
          // The provider consumes its enrollment receipt before returning the paired lease.
          await expect(enrollment.waitForDeviceId()).resolves.toBe("retained-node");
          const leaseId = "cbx_0123456789ab";
          return {
            leaseId,
            sharedHost: false,
            node: { deviceId: "retained-node" },
            retainedLease: {
              schema: "crabbox.session-disk.v1",
              mode: "session-disk",
              ownerBinding: options!.retention!.ownerBinding,
              identity: {
                leaseId,
                attemptLeaseId: leaseId,
                slug: "retained-fixture",
                resourceId: "fixture-resource",
              },
              claimRevision: "revision-created",
              computeWindowSeconds: 14400,
              desiredState: "running",
              computeWindow: {
                id: leaseId,
                authorizedAt: new Date(support.testState.nowMs).toISOString(),
                expiresAt: new Date(support.testState.nowMs + 14400_000).toISOString(),
                state: "active",
              },
              policyVerified: true,
              observedState: "Running",
              stopPending: false,
            },
          };
        },
      );
      const prepareNodeArtifacts = vi.fn(async () => ({
        artifacts: {
          nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
          enabledPluginIds: [],
          workerBundleHash: support.BUNDLE_HASH,
          workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
          openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
          protocolFeatures: [],
        },
        assertCurrent: () => {},
      }));
      const unavailable = async () => {
        throw new Error("Unexpected retained lease effect");
      };
      const workerService = support.createService(
        support.createProvider({
          requiresNodeEnrollment: true,
          supportedExecutionModes: ["worker-turn", "remote-exec"],
          // This fixture models a retained runtime-only provider, not a snapshot builder.
          supportsProjectPreparation: () => false,
          runSetupCommand: unavailable,
          retainedLease: {
            inspect: unavailable,
            pause: unavailable,
            resume: unavailable,
            destroy: unavailable,
          },
          provision,
        }),
        {
          projectNamespace: "retained-dispatch",
          prepareNodeArtifacts,
          ensureNodeWorkerBundle: async ({ environmentId }) => {
            if (!environmentId) {
              throw new Error("Fixture runtime installation requires its environment owner");
            }
            expect(support.testState.store.get(environmentId)).toMatchObject({
              nodeDeviceId: "retained-node",
              retention: { receipt: { identity: { leaseId: "cbx_0123456789ab" } } },
            });
            throw installationBoundary;
          },
          prepareNodeEnrollment: async (record) => {
            const current = await support.testState.store.ensureNodeEnrollment(
              record.environmentId,
            );
            if (!current.nodeSetupId) {
              throw new Error("Expected persisted setup owner");
            }
            return {
              mode: "connect",
              setupId: current.nodeSetupId,
              setupCode: "fixture-setup-code",
              displayName: "Retained dispatch fixture",
              openclawVersion: support.NODE_BOOTSTRAP.openclawVersion,
              nodeBootstrap: support.NODE_BOOTSTRAP,
              waitForDeviceId: async () => "retained-node",
            };
          },
        },
      );
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const harness = await createHarness(support.testState.stateDb, placements, {
        environmentService: workerService,
        resolveWorkspace: async () => ({ kind: "repository", repository }),
      });
      let settled = false;
      const dispatch = harness.service
        .dispatch(
          {
            ...REQUEST,
            executionMode: selection === "inherited" ? "remote-exec" : "worker-turn",
            ...(selection === "missing-reader" || nativeApp ? {} : { readNativeCredential }),
            ...(selection === "inherited"
              ? {
                  inheritedProfile: {
                    providerId: "fake",
                    profileSnapshot: {
                      settings: requireWorkerProfile(profile.settings ?? {}),
                      retention: profile.retention,
                    },
                  },
                }
              : {}),
          },
          undefined,
          undefined,
          nativeApp ? controller.signal : undefined,
        )
        .finally(() => {
          settled = true;
        });
      const failedBeforeAllocation = [
        "revoked",
        "outside-selection",
        "broker-denied",
        "native-cancelled",
      ].includes(selection);
      const result = expect(dispatch).rejects.toThrow(
        selection === "missing-reader"
          ? "current GitHub dispatch admission"
          : failedBeforeAllocation
            ? "GitHub"
            : installationBoundary.message,
      );
      if (holdCleanup) {
        try {
          const entered = await Promise.race([
            cleanupEntered.promise.then(() => true),
            dispatch.then(
              () => false,
              () => false,
            ),
          ]);
          expect(entered).toBe(true);
          expect(settled).toBe(false);
          expect(revoked).toBe(0);
        } finally {
          releaseCleanup.resolve();
        }
      }
      await result;
      if (selection === "missing-reader") {
        expect(readNativeCredential).not.toHaveBeenCalled();
        expect(provision).not.toHaveBeenCalled();
        expect(fetchMetadata).not.toHaveBeenCalled();
      } else if (failedBeforeAllocation) {
        if (selection === "outside-selection" || nativeApp) {
          expect(readNativeCredential).not.toHaveBeenCalled();
        } else {
          expect(readNativeCredential).toHaveBeenCalled();
        }
        expect(minted).toBe(0);
        expect(revoked).toBe(0);
        expect(provision).not.toHaveBeenCalled();
        expect(prepareNodeArtifacts).not.toHaveBeenCalled();
      } else {
        if (nativeApp) {
          expect(readNativeCredential).not.toHaveBeenCalled();
        } else {
          expect(readNativeCredential).toHaveBeenCalled();
        }
        expect(provision).toHaveBeenCalledOnce();
        expect(prepareNodeArtifacts).not.toHaveBeenCalled();
        expect(fetchMetadata).toHaveBeenCalled();
        if (!nativeApp) {
          expect(readNativeCredential.mock.calls[0]?.[1]).toMatchObject({
            kind: "repository-admission",
            host,
            selection: {
              kind: "app-installation",
              app: { repositories: [{ id: 404, fullName: "example/project" }] },
            },
          });
        }
        expect(minted).toBe(1);
        expect(revoked).toBe(1);
        if (selection === "native-app") {
          const reads = fetchMetadata.mock.calls.length;
          // Pool/refill has no original dispatch owner. A configured key alone
          // must not let that background preparation mint a new App token.
          await expect(
            workerService.prepareProjectIntent(REQUEST.profileId, {
              repository: { agentId: REQUEST.agentId, url: repository.url, ref: commit },
            }),
          ).rejects.toMatchObject({ reason: "unavailable" });
          expect(fetchMetadata).toHaveBeenCalledTimes(reads);
          expect(minted).toBe(1);
          expect(revoked).toBe(1);
        }
      }
    },
  );
});
