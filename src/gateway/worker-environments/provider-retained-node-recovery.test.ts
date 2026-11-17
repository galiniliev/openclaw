import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import type { WorkerRetentionObservation } from "../../plugins/worker-retention.types.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import { workspaceTransfer } from "./node-worker-tunnel.test-support.js";
import { openDiskCleanupTransport } from "./placement-disk-cleanup.test-support.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { workerCredential, workerReadyPatch } from "./store.test-support.js";

support.setupWorkerEnvironmentServiceSuite();
let wire: Awaited<ReturnType<typeof openDiskCleanupTransport>>;
beforeAll(async () => {
  wire = await openDiskCleanupTransport({
    resolveCurrentPairingState: async () => ({
      identity: "disk-cleanup-pairing",
      generation: "disk-cleanup-generation",
    }),
  });
});
afterAll(async () => wire.close());

it.each(["none", "uncertain pause", "active turn"] as const)(
  "recovers the original stopped disk through a restored node owner: %s",
  async (fault) => {
    const { store, stateDb, root } = support.testState;
    const environmentId = "retained-restarted";
    const policy = { version: 1 as const, ownerBinding: "a".repeat(64), computeWindowSeconds: 600 };
    const receipt = {
      version: 1 as const,
      leaseId: "retained-original",
      identity: { disk: "original" },
    };
    const currentBuild = {
      ...support.BUNDLE_ARTIFACT,
      bundleHash: "c".repeat(64),
      protocolFeatures: [],
    };
    await store.createIntent({
      environmentId,
      providerId: "fake",
      profileId: "development",
      provisionOperationId: "original-provision",
      retention: policy,
      profileSnapshot: {
        settings: {},
        install: "bundle",
        executionMode: "worker-turn",
        runtimePreparation: {
          source: "empty",
          contractVersion: 2,
          key: "a".repeat(64),
          cacheKey: "b".repeat(64),
          target: { machineClass: "small", platform: "linux" },
          artifacts: {
            nodeBootstrapSha256: "d".repeat(64),
            enabledPluginIds: [],
            workerBundleHash: support.BOOTSTRAP_RECEIPT.bundleHash,
            workerArchiveSha256: "e".repeat(64),
            openclawVersion: support.BOOTSTRAP_RECEIPT.openclawVersion,
            protocolFeatures: [],
          },
        },
      },
    });
    await store.transition({ environmentId, from: "requested", to: "provisioning" });
    await store.recordResourceReceipt({
      environmentId,
      provisionOperationId: "original-provision",
      receipt,
      assertCurrent() {},
    });
    await store.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        ...workerReadyPatch(receipt.leaseId, wire.nodeId),
        bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
      },
    });
    const original = await store.transition({
      environmentId,
      from: "ready",
      to: "attached",
      patch: {
        attachedSessionIds: [REQUEST.sessionId],
        credential: workerCredential(undefined, REQUEST.sessionId),
      },
    });
    const placements = createWorkerSessionPlacementStore({
      database: stateDb,
      now: () => support.testState.nowMs,
    });
    await seedActivePlacement(placements, { environmentId, ownerEpoch: original.ownerEpoch });
    if (fault === "active turn") {
      await placements.claimTurn({
        ...REQUEST,
        claimId: "active-original",
        runId: "active-original",
        owner: { kind: "worker", environmentId, ownerEpoch: original.ownerEpoch },
      });
    }
    let observation: WorkerRetentionObservation = {
      claimRevision: "original-revision",
      state: "expired",
      computeExpiresAtMs: 999,
    };
    const pending = {
      id: "original-pause",
      action: "pause" as const,
      expectedClaimRevision: observation.claimRevision,
    };
    await store.recordRetentionObservation({
      environmentId,
      expectedOwnerEpoch: original.ownerEpoch,
      observation,
    });
    await store.beginRetentionOperation({
      environmentId,
      expectedOwnerEpoch: original.ownerEpoch,
      operation: pending,
    });
    const workspace = new NodeWorkerWorkspaceRuntime({
      root: path.join(root, "node"),
      env: { PATH: process.env.PATH },
    });
    const events: string[] = [];
    wire.bind({ workspace, events, beforeStop: async () => {} });
    wire.disconnect();
    let connected = false;
    // No tunnel entries exist after restart. stop() must restore the durable owner
    // and really try supervisor stop/drain; only the provider is a fixture.
    const transferClose = vi.fn(async () => {});
    const tunnels = createNodeWorkerTunnelManager({
      gatewayDeviceId: "retained-gateway",
      getEnvironment: store.get,
      listEnvironments: store.list,
      getTransport: () => wire.transport,
      validateWorkerTurn: () => false,
      launchNodeWorker: async () => {
        throw new Error("must not launch a turn");
      },
      workspaceTransfer: workspaceTransfer({ close: transferClose, closeAll: async () => {} }),
    });
    const provider = support.createProvider({
      requiresNodeEnrollment: true,
      supportsResourceReceipts: true,
      supportedExecutionModes: ["worker-turn"],
      provision: vi.fn(async () => {
        throw new Error("must not allocate");
      }),
      destroy: vi.fn(async () => {
        throw new Error("must not delete");
      }),
      inspect: async () => ({
        status: observation.state === "running" ? "active" : "dormant",
        ...(observation.state === "running" ? { sharedHost: false } : {}),
        resourceReceipt: receipt,
        retention: observation,
      }),
      setRetainedState: vi.fn(async (lease) => {
        lease.assertCurrent();
        expect(lease.resourceReceipt).toEqual(receipt);
        expect(lease.retention).toEqual(policy);
        if (lease.operation.action === "pause") {
          if (!events.includes("pause")) {
            expect(lease.operation).toEqual(pending);
          }
          if (fault === "uncertain pause") {
            throw new Error("provider pause unconfirmed");
          }
        }
        events.push(lease.operation.action);
        observation = {
          claimRevision: lease.operation.action,
          state: lease.operation.action === "pause" ? "suspended" : "running",
          computeExpiresAtMs: support.testState.nowMs + 600_000,
          operation: { ...lease.operation, phase: "observed" },
        };
        return observation;
      }),
      resumeNode: vi.fn(async (request) => {
        request.assertCurrent();
        expect(request).toMatchObject({
          leaseId: receipt.leaseId,
          deviceId: wire.nodeId,
          runtime: { workerBundle: { bundleHash: currentBuild.bundleHash } },
        });
        events.push("current-node");
        wire.reconnect();
        connected = true;
      }),
    });
    const service = support.createService(provider, {
      nodeTunnelManager: tunnels,
      placementStore: createWorkerSessionPlacementGate(placements),
      prepareInstallation: async () => currentBuild,
      prepareNodeRuntime: async (_record, _artifact, _signal, assertCurrent) => {
        assertCurrent?.();
        return {
          nodeBootstrap: support.NODE_BOOTSTRAP,
          workerBundle: {
            url: "https://gateway.example.test/worker",
            token: "synthetic-runtime-token",
            bundleHash: currentBuild.bundleHash,
            protocolFeatures: [],
            sha256: currentBuild.tarballSha256,
            bytes: currentBuild.tarballBytes,
            packageRelativePath: `worker-artifacts/${currentBuild.tarballSha256}.tgz`,
          },
        };
      },
      waitForRetainedNode: async (_id, request) => {
        request.assertCurrent();
        expect(await wire.transport.getCurrentNode(wire.nodeId)).toBeDefined();
        events.push("connected");
      },
      ensureNodeWorkerBundle: async (request) => {
        request.assertCurrent?.();
        events.push("bundle");
        return currentBuild;
      },
    });
    try {
      const waking = service.ensureRetainedRunning({
        environmentId,
        expectedOwnerEpoch: original.ownerEpoch,
        assertCurrent() {},
      });
      if (fault === "none") {
        await expect(waking).resolves.toBeUndefined();
        expect(events.indexOf("pause")).toBeLessThan(events.indexOf("resume"));
        expect(events.indexOf("current-node")).toBeLessThan(events.indexOf("bundle"));
        expect(service.get(environmentId)).toMatchObject({
          leaseId: receipt.leaseId,
          ownerEpoch: original.ownerEpoch,
          nodeDeviceId: wire.nodeId,
          resourceReceipt: receipt,
          retention: { runtimeReady: true, operation: null },
          bootstrapReceipt: { bundleHash: currentBuild.bundleHash },
        });
        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          state: "active",
          turnClaim: null,
          workerBundleHash: currentBuild.bundleHash,
        });
      } else {
        await expect(waking).rejects.toThrow(
          fault === "uncertain pause" ? "provider pause unconfirmed" : "current turn",
        );
        expect(provider.resumeNode).not.toHaveBeenCalled();
        expect(service.get(environmentId)?.retention?.runtimeReady).toBe(false);
        if (fault === "uncertain pause") {
          expect(service.get(environmentId)?.retention?.operation).toEqual(pending);
          expect(events).not.toContain("resume");
        }
      }
      expect(provider.provision).not.toHaveBeenCalled();
      expect(provider.destroy).not.toHaveBeenCalled();
      expect(wire.errors).toEqual([]);
    } finally {
      if (!connected) {
        wire.reconnect();
      }
      await service.stop();
      await workspace.processes.close();
      await workspace.quiescence.close();
    }
  },
);
