import { expect, it, vi } from "vitest";
import type { GitHubCredentialReader } from "../../agents/github-credential-reader.js";
import type { WorkerProvider } from "../../plugins/types.js";
import type { WorkerRetainedLeaseReceipt } from "../../plugins/worker-retention.types.js";
import { VERSION } from "../../version.js";
import { createWorkerRuntimeRefreshWaiter } from "../server-worker-placement-runtime-refresh.js";
import { findNodeWorker } from "./node-worker-discovery.js";
import { createManager, transport, workspaceTransfer } from "./node-worker-tunnel.test-support.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createRepositoryPublicationPreparation } from "./repository-publication-worker-preparation.js";
import { createRepositoryWorkspaceMutationService } from "./repository-workspace-mutation.js";
import * as support from "./service.test-support.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

support.setupWorkerEnvironmentServiceSuite();

it.each(["reconnect", "revoked", "transport-disconnect"] as const)(
  "recovers stopped retained publication before transport without replaying it (%s)",
  async (scenario) => {
    const environmentId = "original-environment";
    let receipt: WorkerRetainedLeaseReceipt = {
      schema: "fixture.session-disk.v1",
      mode: "session-disk",
      ownerBinding: "original-owner",
      identity: {
        leaseId: "original-lease",
        attemptLeaseId: "original-lease",
        resourceId: "original-disk",
        slug: "original",
      },
      claimRevision: "stopped-revision",
      computeWindowSeconds: 3600,
      desiredState: "suspended",
      observedState: "Stopped",
      policyVerified: true,
      stopPending: false,
      computeWindow: {
        id: "expired-window",
        authorizedAt: new Date(0).toISOString(),
        expiresAt: new Date(0).toISOString(),
        state: "closed",
      },
    };
    await support.testState.store.createIntent({
      environmentId,
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" }, executionMode: "remote-exec" },
      provisionOperationId: "original-operation",
      retention: {
        owner: REQUEST,
        ownerBinding: receipt.ownerBinding,
        policy: { mode: "session-disk", computeWindowSeconds: 3600 },
        desiredState: "suspended",
        receipt,
        operation: null,
      },
    });
    await support.testState.store.transition({
      environmentId,
      from: "requested",
      to: "provisioning",
    });
    await support.testState.store.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        ...support.readyPatch(environmentId),
        bootstrapReceipt: { ...support.BOOTSTRAP_RECEIPT, installKind: "bundle" },
        leaseId: receipt.identity.leaseId,
        nodeDeviceId: "node-1",
        sharedHost: false,
      },
    });
    const record = await support.testState.store.transition({
      environmentId,
      from: "ready",
      to: "attached",
      patch: support.attachedPatch(environmentId, REQUEST.sessionId),
    });
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    await seedActivePlacement(placements, { environmentId, ownerEpoch: record.ownerEpoch });
    const originalPlacement = placements.get(REQUEST.sessionId);
    let connected = scenario === "transport-disconnect";
    let supervisorStarted = false;
    let current = true;
    let admitted = false;
    const reader: GitHubCredentialReader = Object.assign(async () => "synthetic-token", {
      admit: async () => {
        admitted = true;
        current = scenario !== "revoked";
      },
      assertCurrent: () => {
        if (!current) {
          throw new Error("Original requester revoked");
        }
      },
    });
    const resumeCompute = vi.fn<NonNullable<WorkerProvider["retainedLease"]>["resume"]>(
      async (request) => {
        request.assertCurrent();
        expect(admitted).toBe(true);
        expect(request.leaseId).toBe("original-lease");
        receipt = {
          ...receipt,
          claimRevision: "resumed-revision",
          desiredState: "running",
          observedState: "Running",
          computeWindow: {
            id: request.operationId,
            authorizedAt: new Date(1000).toISOString(),
            expiresAt: new Date(3601000).toISOString(),
            state: "active",
          },
          operation: {
            id: request.operationId,
            action: "resume",
            phase: "observed",
            expectedClaimRevision: request.retention.operation!.expectedClaimRevision,
          },
        };
        return receipt;
      },
    );
    const resumeNode = vi.fn<NonNullable<WorkerProvider["resumeNode"]>>(async (request) => {
      request.assertCurrent();
      expect(receipt.observedState).toBe("Running");
      expect(request.leaseId).toBe("original-lease");
      expect(request.deviceId).toBe("node-1");
      supervisorStarted = true;
    });
    const nodeTransport = transport();
    const getCurrentNode = nodeTransport.getCurrentNode.bind(nodeTransport);
    nodeTransport.getCurrentNode = async (id) => (connected ? getCurrentNode(id) : undefined);
    const manager = createManager(record, {
      getTransport: () => nodeTransport,
      workspaceTransfer: workspaceTransfer({
        prepareRepository: async () => {},
        closeAll: async () => {},
      }),
    });
    manager.bindWorkspaceBindingResolver(async () => ({
      sessionKey: REQUEST.sessionKey,
      remoteWorkspaceDir: "/original/workspace",
      manifestRef: `sha256:${"b".repeat(64)}`,
      source: {
        kind: "repository",
        baseCommit: "a".repeat(40),
        baseManifestRef: `sha256:${"b".repeat(64)}`,
      },
      diskAuthority: {
        environmentId,
        ownerEpoch: record.ownerEpoch,
        sessionId: REQUEST.sessionId,
        ownerBinding: receipt.ownerBinding,
        identity: receipt.identity,
        workspaceDir: "/original/workspace",
      },
    }));
    const service = support.createService(
      support.createProvider({
        resumeNode,
        retainedLease: {
          inspect: async () => receipt,
          pause: async () => {
            throw new Error("Already suspended");
          },
          resume: resumeCompute,
          destroy: async () => {
            throw new Error("Must preserve original disk");
          },
        },
      }),
      {
        placementStore: createWorkerSessionPlacementGate(placements),
        nodeTunnelManager: manager,
        prepareNodeRuntime: async () => ({
          nodeBootstrap: support.NODE_BOOTSTRAP,
          workerBundle: {
            url: "https://example.test/worker",
            token: "synthetic",
            sha256: "b".repeat(64),
            bytes: 1,
            packageRelativePath: "worker.tgz",
          },
        }),
      },
    );
    const waiter = createWorkerRuntimeRefreshWaiter({
      environments: service,
      isStopping: () => false,
    });
    waiter.bind(
      async (id, request) => {
        request.assertCurrent();
        expect(supervisorStarted).toBe(true);
        connected = true;
        await findNodeWorker({
          getTransport: () => nodeTransport,
          deviceId: id,
          signal: request.signal,
        });
      },
      async () => connected,
      () => VERSION,
    );
    const integration = vi.fn(async () => {
      if (scenario === "transport-disconnect") {
        throw new WorkerTunnelOwnerDisconnectedError("Private transport disconnected");
      }
      return {
        snapshotRoot: "accepted-checkpoint",
        snapshot: {
          version: 1 as const,
          baseCommit: "a".repeat(40),
          baseTree: "b".repeat(40),
          workspaceTree: "c".repeat(40),
          entries: [],
        },
        knownBlobs: [],
        release: async () => {},
      };
    });
    const start = manager.start.bind(manager);
    vi.spyOn(manager, "start").mockImplementation(async (request) => {
      return {
        ...(await start(request)),
        integratePublication: integration,
      };
    });
    const mutation = createRepositoryWorkspaceMutationService({
      placements,
      environments: service,
      workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
      resolveWorkspace: async () => {
        throw new Error("Must not synchronize private editing tree");
      },
      ...createRepositoryPublicationPreparation({
        placements,
        environments: service,
        ensurePlacement: async () => {
          throw new Error("Must preserve active placement");
        },
        resolveDevicePlacementRequirement: async () => {
          throw new Error("Must preserve device");
        },
        getConfig: () => support.testState.config,
        waitForNode: waiter.wait,
        reconcileActive: async () => {},
      }),
    });
    const pending = mutation.integratePublication(REQUEST, {
      snapshotRoot: "accepted-checkpoint",
      snapshotDigest: `sha256:${"d".repeat(64)}`,
      mainCommit: "a".repeat(40),
      sourceUrl: "https://github.com/example/repo.git",
      targetUrl: "https://github.com/example/repo.git",
      token: "synthetic-publication-token",
      readNativeCredential: reader,
      assertCurrent: () => {},
    });
    try {
      if (scenario === "reconnect") {
        expect((await pending).snapshotRoot).toBe("accepted-checkpoint");
        expect(resumeCompute).toHaveBeenCalledOnce();
        expect(resumeNode).toHaveBeenCalledOnce();
        expect(integration).toHaveBeenCalledOnce();
      } else {
        await expect(pending).rejects.toThrow(
          scenario === "revoked" ? "Original requester revoked" : "Private transport disconnected",
        );
        expect(resumeCompute).not.toHaveBeenCalled();
        expect(resumeNode).not.toHaveBeenCalled();
        expect(integration).toHaveBeenCalledTimes(scenario === "revoked" ? 0 : 1);
      }
      expect(placements.get(REQUEST.sessionId)).toEqual(originalPlacement);
      const after = service.get(environmentId)!;
      expect({
        leaseId: after.leaseId,
        ownerEpoch: after.ownerEpoch,
        nodeDeviceId: after.nodeDeviceId,
      }).toEqual({
        leaseId: record.leaseId,
        ownerEpoch: record.ownerEpoch,
        nodeDeviceId: record.nodeDeviceId,
      });
    } finally {
      connected = true;
      await manager.stop(environmentId, record.ownerEpoch, "provider-destroyed");
    }
  },
);
