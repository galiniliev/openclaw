import path from "node:path";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { WorkerRetainedLeaseReceipt } from "../../plugins/worker-retention.types.js";
import type { RetainedWorkspaceAuthority } from "../../state/retained-workspace-authority.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { handleGatewayRequest } from "../server-methods.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { writePlacementEnvironmentFixture } from "../worker-environments/placement-test-fixtures.js";
import {
  RETAINED_WORKSPACE_OWNER_REPAIR_HOLD,
  RESTORED_RETAINED_WORKSPACE_OWNER_HOLD,
} from "../worker-environments/retained-workspace-owner-repair.kernel.js";
import type { WorkerPlacementDispatchRequest } from "../worker-environments/service-contract.js";
import * as support from "../worker-environments/service.test-support.js";
import {
  dispatchTestSessionId as sessionId,
  dispatchTestSessionKey as sessionKey,
  getDispatchTestMocks,
  getSessionDispatchHandler,
  makeDispatchTestContext,
} from "./sessions-dispatch.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

support.setupWorkerEnvironmentServiceSuite();
const mocks = getDispatchTestMocks();
beforeEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry(), "retained-original-dispatch", "default");
});

it.each([
  "original",
  "restored-dormant",
  "no-source",
  "unmarked",
  "wrong-lease",
  "wrong-owner",
  "changed-after-read",
  "parked-unclassified",
  "pending",
  "pending-shared",
  "pending-expired",
  "pending-wrong-resource",
  "pending-unverified",
  "pending-wrong-owner",
] as const)(
  "checks the original through sessions.dispatch and real provisioning (%s)",
  async (selection) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const owner = { agentId: "main", sessionId, sessionKey };
    const pending = selection.startsWith("pending");
    const now = Date.now();
    support.testState.nowMs = now;
    const disk: RetainedWorkspaceAuthority = {
      environmentId: "original-environment",
      sessionId,
      ownerEpoch: 713,
      ownerBinding: "original-binding",
      identity: {
        leaseId: "original-lease",
        attemptLeaseId: "original-attempt",
        slug: "original-worker",
        resourceId: "original-resource",
      },
      workspaceDir: "/original/private-workspace",
    };
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    if (pending) {
      const requested = await placements.startDispatch({ ...owner, executionMode: "worker-turn" });
      const provisioning = await placements.transition({
        sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId: disk.environmentId },
      });
      await placements.fail({
        sessionId,
        expectedGeneration: provisioning.generation,
        recoveryError: "earlier enrollment failure",
      });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const requested = await placements.startDispatch({ ...owner, executionMode: "worker-turn" });
      await placements.fail({
        sessionId,
        expectedGeneration: requested.generation,
        recoveryError: "preallocation failure",
      });
    }
    let placement = await placements.startDispatch({ ...owner, executionMode: "worker-turn" });
    placement = await placements.transition({
      sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: disk.environmentId },
    });
    const failed = await placements.fail({
      sessionId,
      expectedGeneration: placement.generation,
      recoveryError: "preallocation failure",
    });
    expect(failed.generation).toBe(pending ? 10 : 7);
    const setupId = "845fb6b1-8fec-449b-a963-b5faf3195b9a";
    const receipt: WorkerRetainedLeaseReceipt | null = pending
      ? {
          schema: "crabbox.session-disk.v1",
          mode: "session-disk",
          identity: {
            ...disk.identity,
            ...(selection === "pending-wrong-resource" ? { resourceId: "another-resource" } : {}),
          },
          ownerBinding: disk.ownerBinding,
          claimRevision: "verified-current-claim",
          computeWindowSeconds: 14400,
          desiredState: "running",
          observedState: "Running",
          policyVerified: selection !== "pending-unverified",
          stopPending: false,
          computeWindow: {
            id: "original-authorized-window",
            authorizedAt: new Date(now - 1000).toISOString(),
            expiresAt: new Date(
              selection === "pending-expired" ? now - 1 : now + 14400000,
            ).toISOString(),
            state: "active",
          },
        }
      : null;
    const environment = {
      environmentId: disk.environmentId,
      ...(pending
        ? { state: "provisioning" as const, leaseId: null }
        : { state: "orphaned" as const, leaseId: disk.identity.leaseId }),
      providerId: "crabbox",
      profileId: "test",
      profileSnapshot: { settings: { provider: "azure-sandbox" }, executionMode: "worker-turn" },
      // Captured G55 pending enrollment: generation10/epoch714, setup present,
      // lease/device/transport absent and shared_host NULL until provider commit.
      sharedHost:
        selection === "pending-shared"
          ? true
          : pending || selection === "parked-unclassified"
            ? null
            : false,
      ownerEpoch: pending ? 714 : 0,
      nodeSetupId: pending ? setupId : null,
      attachedSessionIds: [],
      lastError: pending
        ? "Node enrollment deadline: device token mismatch"
        : selection === "restored-dormant"
          ? RESTORED_RETAINED_WORKSPACE_OWNER_HOLD
          : selection === "unmarked"
            ? null
            : `${RETAINED_WORKSPACE_OWNER_REPAIR_HOLD}; destroyRequestedAtMs=123`,
      retention: {
        owner:
          selection === "wrong-owner" || selection === "pending-wrong-owner"
            ? { ...owner, sessionId: "another-session" }
            : owner,
        ownerBinding: disk.ownerBinding,
        policy: { mode: "session-disk" as const, computeWindowSeconds: 14400 },
        desiredState: "running" as const,
        receipt,
        operation: null,
      },
    };
    writePlacementEnvironmentFixture(support.testState.stateDb, environment);
    const workspaces = getSessionRepositoryWorkspaceStore();
    const workspace = await workspaces.create({
      ...owner,
      url: "https://example.test/original.git",
      assertCurrent() {},
    });
    const source =
      selection === "no-source"
        ? workspace
        : await workspaces.bindBase({
            workspaceId: workspace.workspaceId,
            expectedRevision: workspace.revision,
            baseCommit: "a".repeat(40),
            baseManifestHash: `sha256:${"b".repeat(64)}`,
            diskAuthority:
              selection === "wrong-lease"
                ? { ...disk, identity: { ...disk.identity, leaseId: "another-lease" } }
                : disk,
            assertCurrent() {},
          });
    const config = {
      session: { store: path.join(support.testState.root, "sessions.json") },
      cloudWorkers: { requiredProfile: "test", profiles: { test: { provider: "crabbox" } } },
    };
    setRuntimeConfigSnapshot(config);
    replaceSessionEntrySync(
      { agentId: owner.agentId, sessionKey, storePath: config.session.store },
      {
        sessionId,
        updatedAt: 1,
        agentRuntimeOverride: "openclaw",
        providerOverride: "anthropic",
        modelOverride: "claude-test",
        repositoryWorkspaceId: source.workspaceId,
      },
    );
    mocks.resolveTarget.mockImplementation(resolveGatewaySessionStoreTargetInWorker);
    const boundary = new Error("provider-effects boundary reached");
    const inspect = vi.fn(async () => receipt!);
    const pause = vi.fn(async () => {
      throw new Error("Original compute window must not be changed");
    });
    const resume = vi.fn(async () => {
      throw new Error("Original compute window must not be changed");
    });
    const destroy = vi.fn(async () => {});
    const prepareNodeEnrollment = vi.fn(
      async (record: Awaited<ReturnType<typeof support.testState.store.createIntent>>) => {
        expect(record).toMatchObject({
          environmentId: disk.environmentId,
          ownerEpoch: 714,
          nodeSetupId: setupId,
          provisionOperationId: `provision:${disk.environmentId}`,
        });
        await support.testState.store.ensureNodeEnrollment(record.environmentId);
        return {
          mode: "connect" as const,
          setupCode: "synthetic-fresh-code",
          setupId,
          nodeBootstrap: support.NODE_BOOTSTRAP,
          openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
          displayName: "Original worker",
          waitForDeviceId: async () => {
            throw boundary;
          },
        };
      },
    );
    const provision = vi.fn<ReturnType<typeof support.createProvider>["provision"]>(
      async (_profile, operationId, options) => {
        expect(operationId).toBe(`provision:${disk.environmentId}`);
        const enrollment = await options!.beginNodeEnrollment!();
        expect(enrollment).toMatchObject({ mode: "connect", setupId });
        await enrollment.waitForDeviceId();
        throw boundary;
      },
    );
    support.testState.config = config;
    const service = pending
      ? support.createService(
          support.createProvider({
            id: "crabbox",
            supportedExecutionModes: ["worker-turn"],
            requiresNodeEnrollment: true,
            provision,
            destroy,
            retainedLease: { inspect, pause, resume, destroy },
          }),
          { prepareNodeEnrollment },
        )
      : undefined;
    const dispatch = vi.fn(async (request: WorkerPlacementDispatchRequest) => {
      expect(request.expectedPlacement).toMatchObject({
        state: "failed",
        generation: pending ? 10 : 7,
        environmentId: disk.environmentId,
        activeOwnerEpoch: null,
      });
      const requested = await placements.startDispatch({
        ...owner,
        executionMode: request.executionMode,
        expectedPlacement: request.expectedPlacement,
      });
      expect(requested).toMatchObject({
        state: "requested",
        generation: pending ? 11 : 8,
      });
      expect(requested.confirmedLossRecovery).toBeUndefined();
      await placements.transition({
        sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId: disk.environmentId },
      });
      if (service) {
        const admittedIntent = await service.prepareProjectIntent("test", {
          executionMode: "worker-turn",
          emptyWorkspace: true,
        });
        await service.createWithRequest({
          profileId: "test",
          idempotencyKey: "new-current-dispatch",
          executionMode: "worker-turn",
          retentionOwner: owner,
          retainedWorkspaceAuthority: disk,
          admittedIntent,
        });
        throw boundary;
      }
      await support.testState.store.resumeParkedRetainedWorkspaceOwner({
        environmentId: disk.environmentId,
        expectedOwnerEpoch: 0,
        owner,
        expectedDiskAuthority: disk,
      });
      throw boundary;
    });
    const context = makeDispatchTestContext({
      workerSessionPlacementService: {
        ...placements,
        canResumeRetainedOriginal: async (input) => {
          const result = await placements.canResumeRetainedOriginal(input);
          if (selection === "changed-after-read") {
            writePlacementEnvironmentFixture(support.testState.stateDb, {
              ...environment,
              ownerEpoch: 1,
            });
          }
          return result;
        },
      },
      workerEnvironmentService:
        service ??
        ({
          get: (id: string) => support.testState.store.get(id),
          supportsExecutionMode: () => true,
        } as never),
      workerPlacementDispatchService: { dispatch },
      getRuntimeConfig: () => config,
    });
    const respond = vi.fn<RespondFn>();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "original-retry",
        method: "sessions.dispatch",
        params: { key: sessionKey, agentId: "main" },
      },
      client: {
        connId: "operator",
        connect: {
          role: "operator",
          scopes: ["operator.admin"],
          client: { id: "test", version: "1", platform: "test", mode: "test" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as GatewayClient,
      isWebchatConnect: () => false,
      context,
      respond,
      extraHandlers: { "sessions.dispatch": getSessionDispatchHandler() },
    });
    if (selection === "original" || selection === "restored-dormant" || selection === "pending") {
      expect(dispatch, JSON.stringify(respond.mock.calls)).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.slice(0, 3)).toEqual([
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining(boundary.message) }),
      ]);
      expect(support.testState.store.get(disk.environmentId)).toMatchObject({
        state: pending ? "provisioning" : "requested",
        leaseId: null,
        ownerEpoch: 714,
        profileSnapshot: environment.profileSnapshot,
        provisionOperationId: `provision:${disk.environmentId}`,
      });
      if (pending) {
        expect(provision).toHaveBeenCalledOnce();
        expect(prepareNodeEnrollment).toHaveBeenCalledOnce();
        expect(inspect).toHaveBeenCalledOnce();
        expect(pause).not.toHaveBeenCalled();
        expect(resume).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();
        expect(support.testState.store.get(disk.environmentId)).toMatchObject({
          nodeSetupId: setupId,
          retention: { receipt },
        });
      }
    } else {
      expect(dispatch).toHaveBeenCalledTimes(selection === "changed-after-read" ? 1 : 0);
      expect(respond.mock.calls[0]?.slice(0, 3)).toEqual([
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining(
            selection === "changed-after-read"
              ? "still requires recovery"
              : "must be stopped before redispatch",
          ),
        }),
      ]);
      expect(await placements.getAsync(sessionId)).toEqual(failed);
      expect(support.testState.store.get(disk.environmentId)).toMatchObject({
        state: pending ? "provisioning" : "orphaned",
        ownerEpoch: pending ? 714 : selection === "changed-after-read" ? 1 : 0,
        leaseId: pending ? null : disk.identity.leaseId,
      });
    }
    expect(await workspaces.get(source.workspaceId)).toEqual(source);
  },
);
