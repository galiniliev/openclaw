import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import * as sessionEntries from "../../config/sessions/session-accessor.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { WorkerRetentionObservation } from "../../plugins/worker-retention.types.js";
import * as cloneRuntime from "../../projects/project-clone-runtime.js";
import { registerClonedProjectRegistry } from "../../projects/project-registry.test-support.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { sendAuthorizationRequest } from "../server-methods.authorization.test-support.js";
import { createGatewayWorkerPlacementMoveBarrier } from "../server-worker-placement-move-barrier.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "../server-worker-placement-reclaim.js";
import {
  createWorkerWorkspaceRecoveryPreparer,
  loadWorkerPlacementSessionRuntimeModule,
  resolveWorkerPlacementSessionTarget,
} from "../server-worker-placement-session-target.js";
import { createRepositoryGatewayMovePreparation } from "../session-repository-materialization.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { writePlacementEnvironmentFixture } from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createWorkerEnvironmentService } from "./service.js";
import { createProvider } from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import {
  attachedEnvironment,
  SESSION_ID,
  sessionTarget,
} from "./worker-turn-launcher.test-support.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";
import { useRepositoryWorkspaceResultFixture } from "./workspace-result-repository.test-support.js";

// mock-isolation: Git and node transfer use a local origin, never a live GitHub identity.
const github = vi.hoisted(() => ({ real: false, calls: 0 }));
vi.mock("./repository-github-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./repository-github-identity.js")>();
  return {
    ...actual,
    prepareRepositoryGitHubIdentity: async (
      ...args: Parameters<typeof actual.prepareRepositoryGitHubIdentity>
    ) => {
      github.calls++;
      return github.real
        ? actual.prepareRepositoryGitHubIdentity(...args)
        : {
            token: undefined,
            assertSelected: args[1],
            start: async (start: () => Promise<unknown>) => await start(),
          };
    },
  };
});
const { fixture } = useRepositoryWorkspaceResultFixture();
const url = "https://github.com/synthetic/disk-move-fixture.git";

it.each([
  "complete",
  "uncaptured",
  "uncaptured-recovery",
  "local-app",
  "local-app-recovery",
  "local-app-missing-base",
  "local-app-missing-object",
  "paused",
  "paused-refresh",
  "paused-recovery",
  "paused-recovery-revoked",
  "intent",
  "imported",
  "before-export",
  "captured",
  "bound",
  "before-cleanup",
  "after-cleanup",
  "released",
  "reconciling",
  "revoked",
  "incognito",
  "incognito-revoked",
] as const)("sessions.move preserves disk custody through %s", async (scenario) => {
  const incognito = scenario.startsWith("incognito");
  const paused = scenario.startsWith("paused");
  const uncaptured = scenario.startsWith("uncaptured");
  const localApp = scenario.startsWith("local-app");
  const missingLocal =
    scenario === "local-app-missing-base" || scenario === "local-app-missing-object";
  const boundary =
    scenario === "local-app-recovery"
      ? "captured"
      : missingLocal
        ? "missing-local"
        : scenario.startsWith("paused-recovery") || scenario === "uncaptured-recovery"
          ? "before-export"
          : scenario === "incognito" || paused || uncaptured || localApp
            ? "complete"
            : scenario === "incognito-revoked"
              ? "revoked"
              : scenario;
  github.real = false;
  const f = await fixture(
    localApp ? "worker-turn" : "remote-exec",
    scenario === "local-app-missing-object",
    incognito,
    url,
  );
  let repository = await f.bindDisk();
  if (uncaptured) {
    // Same retained-recovery shape as worker-turn-repository-disk.test.ts: the
    // pinned baseline and original disk survive without a current mirror.
    runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("session_repository_workspaces")
          .set({ checkpoint_ref: null, manifest_hash: null })
          .where("workspace_id", "=", repository.workspaceId),
      );
    });
    repository = (await f.store.get(repository.workspaceId))!;
    expect(repository).toMatchObject({ checkpointRef: null, manifestHash: null });
    expect(repository.baseCommit).toBeTruthy();
    expect(repository.baseManifestHash).toBeTruthy();
  }
  assert(repository.diskAuthority);
  await registerClonedProjectRegistry({ path: f.origin, name: "Fixture", originUrl: url });
  const remoteHead = vi
    .spyOn(cloneRuntime, "readProjectCheckoutRemoteHead")
    .mockResolvedValue(undefined);
  const fetch = vi.spyOn(cloneRuntime, "ensureProjectCheckoutCommit");
  const clone = vi.spyOn(cloneRuntime, "cloneProjectCheckout");
  await f.write("committed.txt", "private disk history\n");
  await requireWorkspaceResultGit(f.remote, ["add", "committed.txt"]);
  await requireWorkspaceResultGit(f.remote, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "private disk commit",
  ]);
  const head = await requireWorkspaceResultGit(f.remote, ["rev-parse", "HEAD"]);
  await f.write("only-on-disk.txt", "fresh disk result\n");
  let missingObject: { path: string; bytes: Buffer } | undefined;
  if (missingLocal) {
    const object =
      scenario === "local-app-missing-base"
        ? repository.baseCommit!
        : await requireWorkspaceResultGit(f.origin, [
            "rev-parse",
            `${repository.baseCommit}:.openclaw/worktree-setup.sh`,
          ]);
    const objectPath = path.join(f.origin, ".git", "objects", object.slice(0, 2), object.slice(2));
    missingObject = { path: objectPath, bytes: await fs.readFile(objectPath) };
    await fs.rm(objectPath);
  }
  if (localApp) {
    setRuntimeConfigSnapshot({
      ...getRuntimeConfig(),
      tools: {
        github: {
          kind: "app-installation",
          profileId: "ghp_00000000000000000000000000000001",
          app: {
            appId: 10,
            installationId: 20,
            accountId: 42,
            repositories: [{ id: 40, fullName: "synthetic/disk-move-fixture" }],
            permissions: { contents: "write", metadata: "read", pull_requests: "write" },
            privateKey: "synthetic",
            keyVersion: "synthetic-v1",
          },
        },
      },
    });
    github.real = true;
    github.calls = 0;
  }
  let ownClaimWaits = 0;
  const wait = f.placements.waitForTurnClaimRelease.bind(f.placements);
  if (localApp) {
    vi.spyOn(f.placements, "waitForTurnClaimRelease").mockImplementation(async (...args) => {
      if (f.placements.get(SESSION_ID)?.turnClaim?.claimId.startsWith("reclaim-")) {
        ownClaimWaits++;
        throw new Error("Attempted to wait for the recovery owner's own reclaim claim");
      }
      return wait(...args);
    });
  }
  const records = await createWorkerEnvironmentStore({ database: openOpenClawStateDatabase() });
  const original = records.get(repository.diskAuthority.environmentId)!;
  let observation: WorkerRetentionObservation = {
    claimRevision: "paused-move",
    state: "suspended",
    computeExpiresAtMs: Date.now() - 1,
  };
  const admittedBuild = attachedEnvironment().bootstrapReceipt!;
  const currentBuild = {
    ...admittedBuild,
    ...(scenario === "paused-refresh" ? { bundleHash: "c".repeat(64) } : {}),
  };
  writePlacementEnvironmentFixture(
    openOpenClawStateDatabase(),
    {
      ...original,
      ...(paused
        ? {
            bootstrapReceipt: admittedBuild,
            retention: {
              policy: {
                version: 1 as const,
                ownerBinding: "a".repeat(64),
                computeWindowSeconds: 600,
              },
              observation,
              operation: null,
              runtimeReady: false,
            },
          }
        : {}),
      nodeDeviceId: "repository-node-fixture",
      sharedHost: false,
    },
    { replaceBootstrapReceipt: true },
  );
  const destroy = vi.fn(
    async (lease: Parameters<ReturnType<typeof createProvider>["destroy"]>[0]) => {
      lease.assertCurrent?.();
      expect(lease.resourceReceipt).toEqual(repository.diskAuthority!.resourceReceipt);
      const entry = sessionEntries.loadSessionEntry(sessionTarget)!;
      expect(entry.repositoryWorkspaceId).toBeUndefined();
      expect(await fs.readFile(path.join(entry.spawnedCwd!, "only-on-disk.txt"), "utf8")).toBe(
        "fresh disk result\n",
      );
      expect((await f.store.get(repository.workspaceId))?.diskAuthority).toBeUndefined();
      await fs.rm(f.remote, { recursive: true });
    },
  );
  const provider = createProvider({
    id: original.providerId,
    supportsResourceReceipts: true,
    inspect: async () => ({
      status: "active",
      resourceReceipt: repository.diskAuthority!.resourceReceipt,
      ...(paused ? { retention: observation } : {}),
    }),
    setRetainedState: async (lease) => {
      lease.assertCurrent();
      observation = {
        claimRevision: lease.operation.id,
        state: lease.operation.action === "pause" ? "suspended" : "running",
        computeExpiresAtMs: Date.now() + 600_000,
        operation: { ...lease.operation, phase: "observed" },
      };
      return observation;
    },
    destroy,
  });
  const environments = createWorkerEnvironmentService({
    scheduler: createTestGatewayScheduler(),
    store: records,
    getConfig: getRuntimeConfig,
    resolveProvider: (id) => (id === provider.id ? provider : undefined),
    // Synthetic provider/node admission, composed with the real retained lifecycle and Move owner.
    placementStore: createWorkerSessionPlacementGate(f.placements),
    waitForRetainedNode: async (node, request) => {
      expect(node).toBe("repository-node-fixture");
      request.assertCurrent();
    },
    ensureNodeWorkerBundle: async (request) => {
      if (scenario === "paused-recovery-revoked" && currentBuild.bundleHash === "d".repeat(64)) {
        await sessionEntries.upsertSessionEntryCore(sessionTarget, {
          lifecycleRevision: "successor",
        });
      }
      request.assertCurrent?.();
      return currentBuild;
    },
    prepareInstallation: async () => ({
      ...currentBuild,
      install: "bundle",
      tarballBytes: 1,
      tarballSha256: "b".repeat(64),
      tarballPath: "unused-fixture-bundle",
    }),
    bootstrapWorker: async () => {
      throw new Error("unexpected bootstrap");
    },
  });
  // Only the external node transport is supplied by the local real Git/HTTP fixture.
  vi.spyOn(environments, "startTunnel").mockImplementation(f.environments.startTunnel);
  const wake = vi.spyOn(environments, "ensureRetainedRunning");
  const quiesce = vi.spyOn(f.tunnel, "quiesceWorkspace");
  const interruption = new Error("interrupted at " + boundary);
  if (boundary === "before-export") {
    quiesce.mockRejectedValueOnce(interruption);
  }
  if (boundary === "captured" || boundary === "revoked") {
    const record = f.placements.recordStagedWorkspaceResult.bind(f.placements);
    vi.spyOn(f.placements, "recordStagedWorkspaceResult").mockImplementationOnce(
      async (...args) => {
        const result = await record(...args);
        if (boundary === "revoked") {
          await sessionEntries.upsertSessionEntryCore(sessionTarget, {
            lifecycleRevision: "successor",
          });
          return result;
        }
        throw interruption;
      },
    );
  }
  if (boundary === "imported") {
    // Simulate process loss after import: no session commit and no finally rollback.
    vi.spyOn(sessionEntries, "patchSessionEntryCore").mockRejectedValueOnce(interruption);
    vi.spyOn(managedWorktrees, "rollbackPreparation").mockResolvedValueOnce(undefined);
  }
  if (boundary === "bound") {
    const patch = sessionEntries.patchSessionEntryCore;
    vi.spyOn(sessionEntries, "patchSessionEntryCore").mockImplementationOnce(async (...args) => {
      await patch(...args);
      throw interruption;
    });
  }
  if (boundary === "before-cleanup" || boundary === "after-cleanup") {
    const reclaim = environments.reclaim;
    vi.spyOn(environments, "reclaim").mockImplementationOnce(async (...args) => {
      if (boundary === "after-cleanup") {
        await reclaim(...args);
      }
      throw interruption;
    });
  }
  if (boundary === "released") {
    const release = f.placements.completeWorkspaceResultAndReleaseTurn.bind(f.placements);
    vi.spyOn(f.placements, "completeWorkspaceResultAndReleaseTurn").mockImplementationOnce(
      async (...args) => {
        await release(...args);
        throw interruption;
      },
    );
  }
  if (boundary === "reconciling") {
    const reconcile = f.placements.startReconcile;
    vi.spyOn(f.placements, "startReconcile").mockImplementationOnce(async (...args) => {
      await reconcile(...args);
      throw interruption;
    });
  }
  const resolveWorkspace = async () => {
    using resolved = await resolveWorkerPlacementSessionTarget({
      sessionRuntime: await loadWorkerPlacementSessionRuntimeModule(),
      config: getRuntimeConfig(),
      ...sessionTarget,
      errorMessage: "fixture workspace changed",
    });
    return resolved.workspace;
  };
  let interruptedIntent = false;
  const makeOptions = (placements: typeof f.placements) => {
    const barriers = createGatewayWorkerPlacementReclaimBarriers({
      placements,
      loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
      cancelSessionWork: async ({ assertCurrent }) => assertCurrent(),
      revokeSessionAuthority() {},
    });
    return {
      ...barriers,
      environmentService: environments,
      resolveWorkspace,
      prepareGatewayMove: createRepositoryGatewayMovePreparation({
        placements,
        environments,
        getConfig: getRuntimeConfig,
      }),
      runMoveBarrier: async (
        request: Parameters<ReturnType<typeof createGatewayWorkerPlacementMoveBarrier>>[0],
      ) => {
        const begun = await createGatewayWorkerPlacementMoveBarrier({
          placements,
          loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
          revokeSessionAuthority() {},
        })(request);
        if (boundary === "intent" && !interruptedIntent) {
          interruptedIntent = true;
          throw interruption;
        }
        return begun;
      },
      withPreparedRecovery: createWorkerWorkspaceRecoveryPreparer({
        loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
        getConfig: getRuntimeConfig,
      }),
    };
  };
  const options = makeOptions(f.placements);
  const h = await createHarness(openOpenClawStateDatabase(), f.placements, options);
  const active = f.placements.get(SESSION_ID)!;
  try {
    const respond = await sendAuthorizationRequest(
      "sessions.move",
      {
        key: sessionTarget.sessionKey,
        expected: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        target: { kind: "gateway" },
      },
      {
        scopes: ["operator.admin"],
        context: {
          getRuntimeConfig,
          workerPlacementDispatchService: h.service,
          workerSessionPlacementService: f.placements,
          workerEnvironmentService: environments,
          broadcast: vi.fn(),
        },
      },
    );
    // Optional RPC metadata is not part of the success/result/error contract.
    const responses = respond.mock.calls.map((call) => call.slice(0, 3));
    if (missingLocal) {
      expect(responses).toMatchObject([[false, undefined, { code: "UNAVAILABLE" }]]);
      expect(github.calls).toBe(0);
      const pending = (await f.placements.listPendingWorkspaceResultsAsync())[0]!;
      expect(pending.stagedResultRef).toBeTruthy();
      expect(pending.workspaceAcceptedAtMs).toBeNull();
      await h.service.reconcileActive(repository.diskAuthority.environmentId);
      expect(ownClaimWaits).toBe(0);
      expect((await f.placements.listPendingWorkspaceResultsAsync())[0]).toMatchObject({
        claimId: pending.claimId,
        runId: pending.runId,
        workspaceAcceptedAtMs: null,
      });
      expect(destroy).not.toHaveBeenCalled();
      assert(missingObject);
      await fs.writeFile(missingObject.path, missingObject.bytes);
      await h.service.reconcileActive(repository.diskAuthority.environmentId);
    } else if (boundary === "complete") {
      expect(responses).toEqual([
        [
          true,
          expect.objectContaining({ placement: expect.objectContaining({ state: "local" }) }),
          undefined,
        ],
      ]);
    } else {
      expect(responses).toEqual([
        [
          false,
          undefined,
          expect.objectContaining({
            message: expect.stringContaining(boundary === "revoked" ? "changed" : "interrupted at"),
          }),
        ],
      ]);
      if (
        ["intent", "imported", "before-export", "captured", "bound", "revoked"].includes(boundary)
      ) {
        expect(destroy).not.toHaveBeenCalled();
        expect((await f.store.get(repository.workspaceId))?.diskAuthority).toEqual(
          repository.diskAuthority,
        );
        expect(await fs.readFile(path.join(f.remote, "only-on-disk.txt"), "utf8")).toBe(
          "fresh disk result\n",
        );
      }
      if (boundary === "revoked") {
        return;
      }
      if (scenario.startsWith("paused-recovery")) {
        currentBuild.bundleHash = "d".repeat(64);
        observation = { ...observation, state: "suspended", computeExpiresAtMs: Date.now() - 1 };
        const retained = records.get(original.environmentId)!;
        assert(retained.retention);
        writePlacementEnvironmentFixture(openOpenClawStateDatabase(), {
          ...retained,
          retention: { ...retained.retention, observation, runtimeReady: false },
        });
      }
      const previousCaptures = quiesce.mock.calls.length;
      if (localApp) {
        await h.service.reconcileActive(repository.diskAuthority.environmentId);
        expect(ownClaimWaits).toBe(0);
      } else {
        const restartedStore = createWorkerSessionPlacementStore({
          database: openOpenClawStateDatabase(),
        });
        await restartedStore.clearLocalTurnClaimsAfterRestartAsync();
        const restarted = await createHarness(
          openOpenClawStateDatabase(),
          restartedStore,
          makeOptions(restartedStore),
        );
        await restarted.service.reconcileActive(repository.diskAuthority.environmentId);
        if (scenario === "paused-recovery-revoked") {
          expect(records.get(original.environmentId)?.bootstrapReceipt?.bundleHash).toBe(
            admittedBuild.bundleHash,
          );
          expect(records.get(original.environmentId)?.retention?.runtimeReady).toBe(false);
          expect(destroy).not.toHaveBeenCalled();
          expect(quiesce).toHaveBeenCalledTimes(previousCaptures);
          expect((await f.store.get(repository.workspaceId))?.diskAuthority).toEqual(
            repository.diskAuthority,
          );
          expect(await restartedStore.getAsync(SESSION_ID)).toMatchObject({ state: "draining" });
          return;
        }
        if (
          ["bound", "before-cleanup", "after-cleanup", "released", "reconciling"].includes(boundary)
        ) {
          expect(quiesce).toHaveBeenCalledTimes(previousCaptures);
        }
      }
    }
    expect(
      await f.placements.getAsync(SESSION_ID),
      JSON.stringify(await sessionEntries.loadTranscriptEvents(sessionTarget)),
    ).toMatchObject({
      state: "local",
      turnClaim: null,
    });
    expect(await f.placements.getPlacementMoveAsync(SESSION_ID)).toBeUndefined();
    expect(await f.placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    const local = sessionEntries.loadSessionEntry(sessionTarget)!;
    expect(local.repositoryWorkspaceId).toBeUndefined();
    expect(await fs.readFile(path.join(local.spawnedCwd!, "only-on-disk.txt"), "utf8")).toBe(
      "fresh disk result\n",
    );
    expect(await requireWorkspaceResultGit(local.spawnedCwd!, ["rev-parse", "HEAD"])).toBe(head);
    expect((await f.store.get(repository.workspaceId))?.diskAuthority).toBeUndefined();
    expect(destroy).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledTimes(scenario === "paused-recovery" ? 2 : paused ? 1 : 0);
    if (paused) {
      expect(wake.mock.invocationCallOrder[0]).toBeLessThan(quiesce.mock.invocationCallOrder[0]!);
      expect(records.get(original.environmentId)?.bootstrapReceipt?.bundleHash).toBe(
        currentBuild.bundleHash,
      );
    }
    expect(records.get(original.environmentId)?.state).toBe("destroyed");
    if (localApp) {
      expect(github.calls).toBe(0);
      expect(remoteHead).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(clone).not.toHaveBeenCalled();
      expect(ownClaimWaits).toBe(0);
      expect(local.sessionId).toBe(SESSION_ID);
    }
  } finally {
    await environments.stop();
    await records.close();
  }
});
