import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkerProviderError } from "../../plugins/types.js";
import type {
  WorkerRetainedLeaseReceipt,
  WorkerSessionDiskRetention,
} from "../../plugins/worker-retention.types.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { placementTurnOwner } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { ensureWorkerSessionPlacement } from "./session-placement-lifecycle.js";
import { createWorkerPlacementRedispatch } from "./worker-placement-redispatch.js";
import { createRequiredWorkerTurnAdmission } from "./worker-turn-admission.js";

const RETAINED_RECEIPT: WorkerRetainedLeaseReceipt = {
  schema: "test.retained-lease.v1",
  mode: "session-disk",
  ownerBinding: "a".repeat(64),
  identity: {
    leaseId: "retained-gone",
    attemptLeaseId: "retained-attempt",
    slug: "retained",
    resourceId: "retained-resource",
  },
  claimRevision: "1",
  computeWindowSeconds: 14400,
  desiredState: "suspended",
  computeWindow: {
    id: "retained-window",
    authorizedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2026-01-01T04:00:00Z",
    state: "closed",
  },
  policyVerified: true,
  observedState: "Stopped",
  stopPending: false,
};

describe("normal retained worker replacement admission", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("admits a distinct normal attempt after post-ready initial failure and canonical teardown", async () => {
    const receipt = structuredClone(RETAINED_RECEIPT);
    const retention: WorkerSessionDiskRetention = {
      policy: { mode: "session-disk", computeWindowSeconds: 14400 },
      owner: REQUEST,
      ownerBinding: receipt.ownerBinding,
      desiredState: "running",
      receipt,
      operation: null,
    };
    const physicalCleanup = vi.fn(async () => {});
    const provision = vi.fn(async () => {
      throw new WorkerProviderError("distinct fresh allocation admitted");
    });
    const provider = support.createProvider({
      supportedExecutionModes: ["worker-turn"],
      requiresNodeEnrollment: true,
      provision,
      retainedLease: {
        inspect: async () => receipt,
        pause: vi.fn(),
        resume: vi.fn(),
        destroy: physicalCleanup,
      },
    });
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const workerService = support.createService(provider, {
      placementStore: createWorkerSessionPlacementGate(placements),
      prepareNodeEnrollment: async () => {
        throw new Error("Allocation failed before node enrollment");
      },
    });
    const harness = await createHarness(support.testState.stateDb, placements, {
      environmentService: workerService,
      failAt: "sync",
    });
    const environmentId = harness.ready.environmentId;
    const bootstrapReceipt = harness.ready.bootstrapReceipt;
    vi.mocked(support.testState.prepareInstallation).mockResolvedValue({
      ...support.BUNDLE_ARTIFACT,
      protocolFeatures: bootstrapReceipt.protocolFeatures,
    });
    const store = support.testState.store;
    await store.createIntent({
      environmentId,
      providerId: provider.id,
      profileId: "development",
      profileSnapshot: { settings: { region: "test" }, retention: retention.policy },
      provisionOperationId: "initial-retained-attempt",
      retention,
    });
    await store.transition({ environmentId, from: "requested", to: "provisioning" });
    await store.transition({
      environmentId,
      from: "provisioning",
      to: "bootstrapping",
      patch: {
        leaseId: receipt.identity.leaseId,
        sshEndpoint: support.SSH_ENDPOINT,
        sharedHost: false,
      },
    });
    await store.transition({
      environmentId,
      from: "bootstrapping",
      to: "ready",
      patch: support.readyPatch(environmentId, bootstrapReceipt),
    });
    vi.spyOn(harness.environments, "startTunnel").mockImplementation(async ({ ownerEpoch }) =>
      harness.tunnelHandle(ownerEpoch),
    );
    // Exercise fresh dispatch through its current owner; restart no longer resumes setup.
    vi.spyOn(harness.environments, "createWithRequest").mockResolvedValueOnce(
      workerService.get(environmentId)!,
    );
    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("sync failed");
    expect(placements.get(REQUEST.sessionId)).toMatchObject({
      state: "failed",
      activeOwnerEpoch: null,
      workspaceBaseManifestRef: null,
      remoteWorkspaceDir: null,
      recoveryError: expect.stringContaining("sync failed"),
    });
    const historicalEnvironment = store.get(environmentId);
    expect(historicalEnvironment).toMatchObject({
      state: "destroyed",
      lastActivatedAtMs: null,
      attachedSessionIds: [],
      retention: { owner: REQUEST, receipt },
    });
    expect(physicalCleanup).toHaveBeenCalledOnce();
    support.testState.config.cloudWorkers!.profiles!.development!.retention = retention.policy;
    const unexpected = vi.fn(async () => {
      throw new Error("Unexpected recovery path");
    });
    await expect(
      ensureWorkerSessionPlacement({
        request: REQUEST,
        placements,
        environments: workerService,
        dispatch: harness.service.dispatch,
        startDispatch: unexpected,
        waitForInitialPlacement: unexpected,
        redispatchPlacement: unexpected,
        prepareWorkspace: async (canPrepare) => {
          expect(canPrepare()).toBe(true);
        },
        assertCurrent: () => {},
        authorizeDispatch: () => {},
      }),
    ).rejects.toThrow("distinct fresh allocation admitted");
    expect(provision).toHaveBeenCalledOnce();
    expect(store.get(environmentId)).toEqual(historicalEnvironment);
    expect(placements.get(REQUEST.sessionId)?.confirmedLossRecovery).toBeUndefined();
    expect(unexpected).not.toHaveBeenCalled();
  });

  it.each([
    { scenario: "available", executionMode: "worker-turn", discovery: "background" },
    { scenario: "foreign-actor", executionMode: "worker-turn", discovery: "background" },
    { scenario: "revoked", executionMode: "worker-turn", discovery: "background" },
    { scenario: "unknown-turn", executionMode: "worker-turn", discovery: "background" },
    { scenario: "available", executionMode: "worker-turn", discovery: "admission" },
    { scenario: "available", executionMode: "remote-exec", discovery: "admission" },
    { scenario: "available", executionMode: "remote-exec", discovery: "environment" },
  ] as const)(
    "uses the accepted local mirror after proven loss ($executionMode $discovery $scenario)",
    async ({ scenario, executionMode, discovery }) => {
      const mirror = path.join(support.testState.root, "accepted-mirror");
      await fs.mkdir(mirror);
      const marker = path.join(mirror, "private.txt");
      await fs.writeFile(marker, "accepted private checkpoint\n");
      const unavailable = vi.fn(async () => {
        throw new Error("Absent worker cannot execute");
      });
      const receipt = structuredClone(RETAINED_RECEIPT);
      const retention: WorkerSessionDiskRetention = {
        policy: { mode: "session-disk", computeWindowSeconds: 14400 },
        owner: REQUEST,
        ownerBinding: receipt.ownerBinding,
        desiredState: "suspended",
        receipt,
        operation: null,
      };
      const physicalCleanup = vi.fn(async () => {});
      const provision = vi.fn(async () => {
        // This is the external allocation boundary, not an injected service.create.
        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          confirmedLossRecovery: {
            version: 1,
            predecessor: {
              environmentId,
              ownerEpoch: 401,
              retentionOwnerBinding: retention.ownerBinding,
            },
          },
        });
        expect(await fs.readFile(marker, "utf8")).toBe("accepted private checkpoint\n");
        throw new WorkerProviderError("replacement provider admitted");
      });
      const provider = support.createProvider({
        supportedExecutionModes: ["worker-turn", "remote-exec"],
        requiresNodeEnrollment: true,
        provision,
        inspect: async () => ({ status: "unknown" }),
        retainedLease: {
          inspect: async () => ({ ...receipt, observedState: "missing", policyVerified: false }),
          pause: unavailable,
          resume: unavailable,
          destroy: physicalCleanup,
        },
      });
      const workerService = support.createService(provider, { prepareNodeEnrollment: unavailable });
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const harness = await createHarness(support.testState.stateDb, placements, {
        workspacePath: mirror,
        environmentService: workerService,
        withPreparedRecovery: unavailable,
      });
      const environmentId = harness.attached.environmentId;
      const store = support.testState.store;
      await store.createIntent({
        environmentId,
        providerId: provider.id,
        profileId: "development",
        profileSnapshot: {
          settings: { region: "test" },
          install: "bundle",
          executionMode,
          retention: retention.policy,
        },
        provisionOperationId: "retained-gone-dispatch",
        retention,
      });
      await store.transition({ environmentId, from: "requested", to: "provisioning" });
      await store.transition({
        environmentId,
        from: "provisioning",
        to: "ready",
        patch: {
          ...support.readyPatch(environmentId),
          leaseId: receipt.identity.leaseId,
          nodeDeviceId: "gone-retained-node",
          sharedHost: false,
        },
      });
      await store.transition({
        environmentId,
        from: "ready",
        to: "attached",
        patch: support.attachedPatch(environmentId, REQUEST.sessionId),
      });
      const active = await harness.placements.seedActive(401, executionMode);
      if (active.state !== "active") {
        throw new Error("Expected active fixture");
      }
      if (scenario === "unknown-turn") {
        await placements.claimTurn({
          ...REQUEST,
          claimId: "unknown-claim",
          runId: "unknown-run",
          owner: placementTurnOwner(active),
        });
      }
      if (discovery !== "admission") {
        await workerService.reconcileOnce();
      }
      if (discovery === "background") {
        if (scenario !== "unknown-turn") {
          await harness.service.reconcile();
        }
      } else {
        // A distinct fresh request starts with an ACTIVE suspended owner. Provider
        // inspection and placement reconciliation must run through real admission.
        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          state: "active",
          turnClaim: null,
        });
        if (discovery === "admission") {
          expect(store.get(environmentId)?.state).toBe("attached");
        }
        const turnAdmission = createRequiredWorkerTurnAdmission({
          placements,
          environments: workerService,
          reconcileActivePlacement: (id) => harness.service.reconcileActive(id),
          waitForAdmissionNode: unavailable,
        });
        await expect(
          turnAdmission.recoverTurnPlacement(active, { timeoutMs: 30000 }, () => {}),
        ).resolves.toMatchObject({ state: "failed", activeOwnerEpoch: 401 });
      }
      expect(store.get(environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
        sharedHost: null,
        nodeDeviceId: null,
        retention,
      });
      const oldPlacement = placements.get(REQUEST.sessionId);
      const profile = support.testState.config.cloudWorkers!.profiles!.development!;
      profile.retention = retention.policy;
      profile.lostWorkerRecovery = "repository-ref";
      const redispatch = createWorkerPlacementRedispatch({
        placements,
        dispatch: harness.service.dispatch,
        resolveDevicePlacementRequirement: async () => ({
          requiredNodeCommands: [],
          consumesWorkerSlot: true,
        }),
      });
      const unexpected = vi.fn(async () => {
        throw new Error("Unexpected initial placement dispatch");
      });
      const assertCurrent = () => {
        if (scenario === "revoked") {
          throw new Error("Operator authority revoked");
        }
      };
      const admission = ensureWorkerSessionPlacement({
        request: {
          ...REQUEST,
          executionMode,
          ...(scenario === "foreign-actor" ? { agentId: "foreign" } : {}),
        },
        placements,
        environments: workerService,
        dispatch: harness.service.dispatch,
        startDispatch: unexpected,
        waitForInitialPlacement: unexpected,
        redispatchPlacement: redispatch,
        prepareWorkspace: unexpected,
        assertCurrent,
        authorizeDispatch: assertCurrent,
      });
      if (scenario === "available") {
        await expect(admission).rejects.toThrow("replacement provider admitted");
        expect(provision).toHaveBeenCalledOnce();
        const replacement = store.list().find((record) => record.environmentId !== environmentId);
        expect(replacement).toMatchObject({
          profileId: "development",
          retention: {
            owner: {
              sessionId: REQUEST.sessionId,
              sessionKey: REQUEST.sessionKey,
              agentId: REQUEST.agentId,
            },
          },
        });
        expect(replacement?.retention?.ownerBinding).not.toBe(retention.ownerBinding);
      } else {
        await expect(admission).rejects.toThrow(
          scenario === "foreign-actor"
            ? "conflicts with worker execution"
            : scenario === "revoked"
              ? "Operator authority revoked"
              : "Worker placement is not ready",
        );
        expect(provision).not.toHaveBeenCalled();
        expect(placements.get(REQUEST.sessionId)).toEqual(oldPlacement);
      }
      expect(await fs.readFile(marker, "utf8")).toBe("accepted private checkpoint\n");
      expect(physicalCleanup).toHaveBeenCalledOnce();
      expect(unavailable).not.toHaveBeenCalled();
      expect(unexpected).not.toHaveBeenCalled();
    },
  );
});
