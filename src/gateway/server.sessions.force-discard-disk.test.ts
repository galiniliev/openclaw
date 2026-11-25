import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { writePlacementEnvironmentFixture } from "./worker-environments/placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./worker-environments/placement-worker-gate.js";
import { createWorkerEnvironmentService } from "./worker-environments/service.js";
import { createProvider } from "./worker-environments/service.test-support.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test.each(["attached", "already-destroyed", "provider-failure", "multiple-owners"] as const)(
  "handles forced repository-child cleanup (%s)",
  async (mode) => {
    const { dir, storePath } = await createSessionStoreDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: dir } });
    const placements = createWorkerSessionPlacementStore({ database });
    const store = await createWorkerEnvironmentStore({ database });
    const environmentId = "worker-force-disk-child";
    const receipt = {
      version: 1 as const,
      leaseId: "lease-force-disk-child",
      identity: { machineId: "child-machine", diskId: "child-disk" },
    };
    writePlacementEnvironmentFixture(database, {
      environmentId,
      providerId: "fake",
      state: "attached",
      ownerEpoch: 1238,
      attachedSessionIds: [REQUEST.sessionId],
      nodeDeviceId: "child-node",
      sharedHost: false,
      leaseId: receipt.leaseId,
      resourceReceipt: receipt,
    });
    await store.ready();
    const active = await seedActivePlacement(placements, { environmentId, ownerEpoch: 1238 });
    const repositories = createSessionRepositoryWorkspaceStore({ path: database.path });
    let repository = await repositories.create({
      ...REQUEST,
      url: "https://example.test/repo.git",
      assertCurrent() {},
    });
    repository = await repositories.bindBase({
      workspaceId: repository.workspaceId,
      expectedRevision: repository.revision,
      baseCommit: "a".repeat(40),
      baseManifestHash: "sha256:" + "b".repeat(64),
      assertCurrent() {},
    });
    repository = await repositories.bindDisk({
      workspaceId: repository.workspaceId,
      expectedRevision: repository.revision,
      diskAuthority: { environmentId, resourceReceipt: receipt },
      assertCurrent() {},
    });
    const artifact = repositories.artifactPath(repository.workspaceId);
    await fs.mkdir(artifact, { recursive: true });
    execFileSync("git", ["init", "--bare", artifact]);
    const object = spawnSync("git", ["-C", artifact, "hash-object", "-w", "--stdin"], {
      input: "retained private Git object",
      encoding: "utf8",
    });
    expect(object.status).toBe(0);
    const objectId = object.stdout.trim();
    execFileSync("git", ["-C", artifact, "update-ref", "refs/openclaw/test-retained", objectId]);
    await writeSessionStore({
      entries: {
        [REQUEST.sessionKey]: sessionStoreEntry(REQUEST.sessionId, {
          repositoryWorkspaceId: repository.workspaceId,
        }),
        "agent:main:protected-parent": sessionStoreEntry("protected-parent"),
        "agent:main:other-associated": sessionStoreEntry("other-associated"),
      },
    });
    const cleanupError = "Crabbox inspect failed: strict claim identifier mismatch";
    const destroy = vi.fn(async () => {
      if (mode === "provider-failure" || mode === "multiple-owners") {
        throw new Error(cleanupError);
      }
    });
    const provider = createProvider({ supportsResourceReceipts: true, destroy });
    const unexpected = async (): Promise<never> => {
      throw new Error("force deletion must not provision or run inference");
    };
    const environments = createWorkerEnvironmentService({
      store,
      scheduler: createTestGatewayScheduler(),
      getConfig: () => ({}),
      resolveProvider: (id) => (id === provider.id ? provider : undefined),
      prepareInstallation: unexpected,
      bootstrapWorker: unexpected,
      placementStore: createWorkerSessionPlacementGate(placements, {
        recoveryPlacements: await placements.listAsync(),
      }),
    });
    const harness = await createHarness(database, placements, {
      environmentService: environments,
      resolveWorkspace: async () => ({
        kind: "repository",
        repository: (await repositories.get(repository.workspaceId))!,
      }),
    });
    const context = {
      workerEnvironmentService: environments,
      workerPlacementDispatchService: harness.service,
      workerSessionPlacementService: placements,
    };
    let forceFailure: unknown;
    const forceDestroy = harness.service.forceDestroyEnvironment.bind(harness.service);
    vi.spyOn(harness.service, "forceDestroyEnvironment").mockImplementation(async (...args) => {
      try {
        return await forceDestroy(...args);
      } catch (error) {
        forceFailure = error;
        throw error;
      }
    });
    try {
      const before = await directSessionReq(
        "sessions.delete",
        { key: REQUEST.sessionKey },
        { context },
      );
      expect(before).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("Move to Gateway before retirement") },
      });
      if (mode === "already-destroyed") {
        await environments.destroy(environmentId);
        expect(environments.get(environmentId)?.state).toBe("destroyed");
        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          state: "active",
          activeOwnerEpoch: active.activeOwnerEpoch,
        });
      }
      if (mode === "multiple-owners") {
        const other = await placements.startDispatch({
          sessionId: "other-associated",
          sessionKey: "agent:main:other-associated",
          agentId: "main",
        });
        await placements.transition({
          sessionId: other.sessionId,
          from: "requested",
          to: "provisioning",
          expectedGeneration: other.generation,
          patch: { environmentId },
        });
      }
      const forced = await directSessionReq(
        "environments.destroy",
        { environmentId, force: true },
        { context },
      );
      if (mode === "multiple-owners") {
        expect(forced.ok).toBe(false);
        expect(forceFailure).toMatchObject({ message: cleanupError });
        expect(placements.get(REQUEST.sessionId)?.state).toBe("failed");
        expect(placements.get("other-associated")?.state).toBe("failed");
        expect(environments.get(environmentId)).toMatchObject({
          state: "attached",
          attachedSessionIds: [REQUEST.sessionId],
          resourceReceipt: receipt,
        });
        expect(destroy).toHaveBeenCalled();
        expect(
          loadSessionEntry({ storePath, sessionKey: "agent:main:protected-parent" })?.sessionId,
        ).toBe("protected-parent");
        return;
      }
      expect(
        forced.ok,
        forceFailure instanceof Error ? forceFailure.message : JSON.stringify(forced.error),
      ).toBe(true);
      expect(environments.get(environmentId)).toMatchObject({
        state: mode === "provider-failure" ? "destroying" : "destroyed",
        attachedSessionIds: [],
      });
      expect(placements.get(REQUEST.sessionId)).toMatchObject({ state: "failed", turnClaim: null });
      expect(await repositories.get(repository.workspaceId)).toMatchObject({
        workspaceId: repository.workspaceId,
        baseCommit: repository.baseCommit,
        branch: repository.branch,
        checkpointRef: repository.checkpointRef,
      });
      expect((await repositories.get(repository.workspaceId))?.diskAuthority).toBeUndefined();
      expect(
        execFileSync("git", ["-C", artifact, "rev-parse", "refs/openclaw/test-retained"], {
          encoding: "utf8",
        }).trim(),
      ).toBe(objectId);
      const deleted = await directSessionReq(
        "sessions.delete",
        { key: REQUEST.sessionKey, expectedSessionId: REQUEST.sessionId },
        { context },
      );
      expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
      expect(deleted.payload).toMatchObject({ deleted: true });
      expect(placements.get(REQUEST.sessionId)).toBeUndefined();
      expect(loadSessionEntry({ storePath, sessionKey: REQUEST.sessionKey })).toBeUndefined();
      expect(
        loadSessionEntry({ storePath, sessionKey: "agent:main:protected-parent" })?.sessionId,
      ).toBe("protected-parent");
      if (mode === "provider-failure") {
        expect(environments.get(environmentId)).toMatchObject({
          state: "destroying",
          attachedSessionIds: [],
          leaseId: receipt.leaseId,
          resourceReceipt: receipt,
          lastError: expect.stringContaining(cleanupError),
          destroyRequestedAtMs: expect.any(Number),
        });
        expect(store.getCredential(environmentId)).toBeUndefined();
        const attempts = destroy.mock.calls.length;
        await environments.reconcileOnce(environmentId);
        expect(destroy).toHaveBeenCalledTimes(attempts + 1);
        expect(environments.get(environmentId)?.state).toBe("destroying");
        destroy.mockResolvedValueOnce(undefined);
        await environments.reconcileOnce(environmentId);
        expect(environments.get(environmentId)?.state).toBe("destroyed");
      } else {
        expect(destroy).toHaveBeenCalledOnce();
      }
    } finally {
      await environments.stop();
      vi.unstubAllEnvs();
    }
  },
);
