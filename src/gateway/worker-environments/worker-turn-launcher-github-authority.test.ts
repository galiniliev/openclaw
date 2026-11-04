import { generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { RepositoryIntegration } from "../../plugins/repository-integration.types.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureCanonicalUserProfileForEmail } from "../../state/user-profile-writes.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { completeTurn, localResult } from "./worker-turn-launcher-flow.test-support.js";
import * as worker from "./worker-turn-launcher.test-support.js";

const policy = vi.hoisted(() => ({ current: undefined as RepositoryIntegration | undefined }));
// mock-isolation: Repository policy and external GitHub responses are fixtures; admission,
// operator/session owners, credential issuance, the binder and placement attachment stay real.
vi.mock("../../plugins/repository-integration-runtime.js", async (original) => ({
  ...(await original<typeof import("../../plugins/repository-integration-runtime.js")>()),
  getRepositoryIntegration: () => policy.current,
}));

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});

beforeEach(worker.setupWorkerTurnLauncherTest);
afterEach(async () => {
  policy.current = undefined;
  vi.unstubAllGlobals();
  await worker.cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true });
});
afterAll(closeStateDatabaseForTest);

it.each(["prepared", "admitted", "absent", "revoked"] as const)(
  "binds the worker GitHub identity to its original operator: %s",
  async (source) => {
    await worker.seedActivePlacement();
    const profile = await ensureCanonicalUserProfileForEmail("worker-operator@example.invalid");
    using profiles = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    void profiles;
    const input = worker.turn("worker-github-authority");
    input.preparedRunAdmission.close();
    const config = {
      ...input.config,
      session: { store: worker.sessionTarget.storePath },
      tools: {
        github: {
          profileId: `ghp_${"1".repeat(32)}`,
          kind: "app-installation" as const,
          app: {
            appId: 101,
            installationId: 202,
            accountId: 303,
            repositories: [{ id: 404, fullName: "example/project" }],
            permissions: { contents: "write" as const },
            privateKey,
            keyVersion: "test-v1",
          },
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    const controller = new AbortController();
    const credentialSource = {
      id: `browser:${"a".repeat(64)}`,
      expiresAtMs: Date.now() + 7_200_000,
    };
    const operator =
      source === "absent"
        ? undefined
        : createAdmittedRunOperatorAuthority({
            profileId: profile.id,
            repositoryCredentialSource: credentialSource,
            scopes: ["operator.write"],
            signal: controller.signal,
            assertCurrent: () => controller.signal.throwIfAborted(),
          });
    const prepared = prepareAgentRunAdmission({
      cfg: config,
      operatorAuthority: operator,
      operationalRunInstance: createOperationalRunInstanceRef(input.runId),
      facts: {
        runId: input.runId,
        agentId: "main",
        ingress: { kind: "channel", boundary: "test.webchat", state: "present" },
      },
    });
    const entered = createDeferred();
    const release = createDeferred();
    const authorizations: Array<{ profileId: string; sessionKey: string }> = [];
    let issued = 0;
    // Same fixed App identity HTTP contracts used by worker-github-binding.test.ts.
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const pathname = new URL(url).pathname;
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (pathname.endsWith("/access_tokens")) {
        issued++;
        return Response.json({
          token: "synthetic-worker-app-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: { contents: "write", metadata: "read" },
        });
      }
      const responses: Record<string, unknown> = {
        "/app": { id: 101, slug: "fixture", permissions: { contents: "write", metadata: "read" } },
        "/app/installations/202": {
          id: 202,
          app_id: 101,
          account: { id: 303 },
          suspended_at: null,
          permissions: { contents: "write", metadata: "read" },
        },
        "/users/fixture%5Bbot%5D": {
          id: 9001,
          login: "fixture[bot]",
          type: "Bot",
          avatar_url: null,
        },
        "/installation/repositories": {
          total_count: 1,
          repositories: [{ id: 404, full_name: "example/project" }],
        },
      };
      if (!(pathname in responses)) {
        throw new Error(`Unexpected identity fixture request: ${pathname}`);
      }
      return Response.json(responses[pathname]);
    });
    vi.stubGlobal("fetch", fetcher);
    policy.current = {
      version: 1,
      preparedCapacity: "image",
      resolveConnectionIdentity: () => undefined,
      async withIdentity(context, run) {
        expect(getGatewayToolCallerIdentity()).toBeUndefined();
        context.assertCurrent();
        expect(context.actor.credentialSource).toEqual(credentialSource);
        expect(context.actor.profileId).toBe(profile.id);
        expect(context.actor.sessionKey).toBe(worker.SESSION_KEY);
        expect(context.operation).toMatchObject({
          purpose: "publication-preflight",
          binding: {
            kind: "session",
            agentId: "main",
            sessionId: worker.SESSION_ID,
            sessionKey: worker.SESSION_KEY,
          },
        });
        expect(context.readCurrentProfile().emails).toContain("worker-operator@example.invalid");
        authorizations.push({
          profileId: context.actor.profileId,
          sessionKey: context.actor.sessionKey,
        });
        entered.resolve();
        if (source === "revoked") {
          await release.promise;
        }
        context.assertCurrent();
        return run({
          env: context.env,
          assertCurrent: context.assertCurrent,
          readNativeCredential: async (_env, admission) => {
            context.assertCurrent();
            expect(admission).toMatchObject({ kind: "repository-admission", host: "github.com" });
            return undefined;
          },
        });
      },
    };
    const original = worker.attachedEnvironment();
    if (!original.bootstrapReceipt) {
      throw new Error("Missing fixture receipt");
    }
    const environment = {
      ...original,
      bootstrapReceipt: {
        ...original.bootstrapReceipt,
        protocolFeatures: [
          ...original.bootstrapReceipt.protocolFeatures,
          WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE,
        ],
      },
    };
    const launch = vi.fn<Parameters<typeof worker.createWorkerTurnTunnel>[0]["launchTurn"]>(
      async (request) => {
        expect(request.plan.assignment.github).toMatchObject({
          token: "synthetic-worker-app-token",
          login: "fixture[bot]",
          host: "github.com",
        });
        request.onDispatchReady?.();
        return completeTurn(request, "Worker operator retained", 51);
      },
    );
    const tunnel = worker.createWorkerTurnTunnel({
      launchTurn: launch,
      reconcileWorkspace: worker.reconcileUnchangedLocalWorkspace,
    });
    const provider = worker.createWorkerSessionTurnPlacementProvider({
      placements: worker.placements,
      environments: worker.workerTurnEnvironments(tunnel, {
        get: () => environment,
        acknowledgeCredentialDelivery: async () => true,
      }),
    });
    const runLocal = vi.fn(localResult);
    try {
      const owner =
        source === "admitted"
          ? {
              admittedRunContext: await prepared.admit("worker", worker.ENVIRONMENT_ID),
              preparedRunAdmission: undefined,
            }
          : { preparedRunAdmission: prepared, admittedRunContext: undefined };
      expect(getGatewayToolCallerIdentity()).toBeUndefined();
      const execution = provider.executeTurn(
        worker.workerTurnRequest(input.runId),
        {
          ...input,
          config,
          ...owner,
        },
        runLocal,
      );
      if (source === "revoked") {
        await awaitGateBeforeSettlement(
          entered.promise,
          execution,
          "worker exited before repository authorization",
        );
        controller.abort(new Error("Original operator revoked during preparation"));
        release.resolve();
        await expect(execution).rejects.toThrow("Original operator revoked");
      } else if (source === "absent") {
        await expect(execution).rejects.toThrow(
          "Worker GitHub execution requires the verified operator and session",
        );
      } else {
        await expect(execution).resolves.toMatchObject({
          payloads: [{ text: "Worker operator retained" }],
        });
        expect(authorizations).toEqual([{ profileId: profile.id, sessionKey: worker.SESSION_KEY }]);
        expect(launch).toHaveBeenCalledOnce();
        expect(issued).toBe(1);
      }
      await waitForSessionRunEnd(worker.SESSION_ID, null);
      if (source === "absent" || source === "revoked") {
        expect(launch).not.toHaveBeenCalled();
        expect(issued).toBe(0);
        expect(fetcher).not.toHaveBeenCalled();
      }
      expect(worker.placements.get(worker.SESSION_ID)).toMatchObject({
        state: "active",
        environmentId: worker.ENVIRONMENT_ID,
        activeOwnerEpoch: worker.OWNER_EPOCH,
        remoteWorkspaceDir: "/worker/workspace",
        turnClaim: null,
      });
      expect(runLocal).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      prepared.close();
    }
  },
);
