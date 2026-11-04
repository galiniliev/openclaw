import { describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_EXEC_APPROVAL_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-exec-approval.js";
import { WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import type { WorkerProvider } from "../../plugins/types.js";
import type { WorkerSessionDiskRetention } from "../../plugins/worker-retention.types.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  createSessionRepositoryWorkspaceInDatabase,
  bindSessionRepositoryWorkspaceBaseInDatabase,
  findSessionRepositoryWorkspaceInDatabase,
} from "../../state/session-repository-workspaces.kernel.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createRecoveryService } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  advancePlacementFixtureToActive,
  writePlacementEnvironmentFixture,
} from "./placement-test-fixtures.js";
import * as support from "./service.test-support.js";
import { WorkerWorkspaceReconciliationError } from "./worker-turn-failure.js";

const heldOwner = { sessionId: "held-session", sessionKey: "agent:main:held", agentId: "main" };

async function fixture() {
  const protocolFeatures = [
    WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
    WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
    WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE,
    WORKER_EXEC_APPROVAL_PROTOCOL_FEATURE,
  ];
  support.testState.prepareInstallation = vi.fn<typeof support.testState.prepareInstallation>(
    async (install) => ({
      ...(install === "bundle" ? support.BUNDLE_ARTIFACT : support.NPM_ARTIFACT),
      protocolFeatures,
    }),
  );
  const retention: WorkerSessionDiskRetention = {
    owner: heldOwner,
    ownerBinding: "a".repeat(64),
    policy: { mode: "session-disk", computeWindowSeconds: 60 },
    desiredState: "running",
    operation: null,
    receipt: {
      schema: "crabbox.session-disk.v1",
      mode: "session-disk",
      ownerBinding: "a".repeat(64),
      identity: {
        leaseId: "cbx_0123456789ab",
        attemptLeaseId: "cbx_0123456789ab",
        slug: "held",
        resourceId: "owned-disk",
      },
      claimRevision: "original-revision",
      computeWindowSeconds: 60,
      desiredState: "running",
      computeWindow: {
        id: "original-window",
        authorizedAt: new Date(1000).toISOString(),
        expiresAt: new Date(61000).toISOString(),
        state: "active",
      },
      policyVerified: true,
      observedState: "Running",
      stopPending: false,
    },
  };
  const inspect = vi.fn<NonNullable<WorkerProvider["retainedLease"]>["inspect"]>(async () => {
    throw new Error("strict claim identifier mismatch");
  });
  const retainedLease: NonNullable<WorkerProvider["retainedLease"]> = {
    inspect,
    pause: vi.fn(),
    resume: vi.fn(),
    destroy: vi.fn(),
  };
  const provider = support.createProvider({
    supportedExecutionModes: ["worker-turn"],
    inspect: vi.fn<WorkerProvider["inspect"]>(async () => ({
      status: "active",
      sharedHost: false,
    })),
    provision: vi.fn(),
    destroy: vi.fn(),
    retainedLease,
  });
  const environments = support.createService(provider);
  const placements = createWorkerSessionPlacementStore({
    database: support.testState.stateDb,
    now: () => support.testState.nowMs,
  });
  const seed = async (sessionId: string, retained?: WorkerSessionDiskRetention) => {
    const environmentId = `environment-${sessionId}`;
    const store = support.testState.store;
    await store.createIntent({
      environmentId,
      providerId: provider.id,
      profileId: "development",
      profileSnapshot: { settings: {}, executionMode: "worker-turn" },
      provisionOperationId: `create-${sessionId}`,
      ...(retained ? { retention: retained } : {}),
    });
    await store.transition({ environmentId, from: "requested", to: "provisioning" });
    await store.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        ...support.readyPatch(environmentId, { ...support.BOOTSTRAP_RECEIPT, protocolFeatures }),
        leaseId: retained?.receipt?.identity.leaseId ?? `lease-${sessionId}`,
        nodeDeviceId: `node-${sessionId}`,
        sharedHost: false,
      },
    });
    const environment = await store.transition({
      environmentId,
      from: "ready",
      to: "attached",
      patch: support.attachedPatch(environmentId, sessionId),
    });
    const identity = {
      ...REQUEST,
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      ...(retained ? heldOwner : {}),
    };
    const placement = await advancePlacementFixtureToActive(
      placements,
      support.testState.stateDb,
      identity,
      { environmentId, ownerEpoch: environment.ownerEpoch, seedEnvironment: false },
    );
    return { environment, placement, identity };
  };
  const held = await seed(heldOwner.sessionId, retention);
  const healthy = await seed("healthy-session");
  return { environments, placements, provider, inspect, retainedLease, retention, held, healthy };
}

describe("retained startup observation containment", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("propagates native receipt persistence failures instead of holding them as provider outages", async () => {
    const f = await fixture();
    const failure = new Error("shared database write unavailable");
    f.inspect.mockResolvedValueOnce({ ...f.retention.receipt!, claimRevision: "new-revision" });
    vi.spyOn(support.testState.store, "recordRetention").mockRejectedValueOnce(failure);
    const recovery = await createRecoveryService(f.placements, f.environments);
    await expect(recovery.reconcile("startup")).rejects.toBe(failure);
  });

  it("propagates an inspection failure when Gateway shutdown begins during observation", async () => {
    const f = await fixture();
    let closing = false;
    f.inspect.mockImplementationOnce(async () => {
      closing = true;
      throw new Error("strict claim identifier mismatch");
    });
    const recovery = await createRecoveryService(f.placements, f.environments, () => closing);
    await expect(recovery.reconcile("startup")).rejects.toThrow("strict claim identifier mismatch");
  });

  it.each(["active", "pending-result", "move-source"] as const)(
    "contains retained startup inspection failure without changing %s recovery ownership",
    async (scenario) => {
      const f = await fixture();
      if (scenario === "pending-result") {
        const claim = await f.placements.claimTurn({
          ...f.held.identity,
          claimId: "old-claim",
          runId: "old-run",
          owner: {
            kind: "worker",
            environmentId: f.held.environment.environmentId,
            ownerEpoch: f.held.environment.ownerEpoch,
          },
        });
        await f.placements.markWorkspaceResultPending(claim);
        await f.placements.handoffWorkspaceResultRecovery(claim);
      }
      if (scenario === "move-source") {
        const source = f.held.placement;
        if (source.state !== "active") {
          throw new Error("Expected active source fixture");
        }
        const begun = await f.placements.beginPlacementMove({
          sessionId: source.sessionId,
          source: {
            generation: source.generation,
            environmentId: source.environmentId,
            ownerEpoch: source.activeOwnerEpoch,
          },
          target: { kind: "profile", profileId: "development" },
        });
        const reconciling = await f.placements.startReconcile({
          sessionId: source.sessionId,
          environmentId: source.environmentId,
          ownerEpoch: source.activeOwnerEpoch,
          expectedGeneration: begun.placement.generation,
        });
        await f.placements.completePlacementMoveSourceToLocal({
          sessionId: source.sessionId,
          operationId: begun.intent.operationId,
          expectedGeneration: reconciling.generation,
        });
        expect(await f.placements.readRecoveryCandidates()).toContainEqual(
          expect.objectContaining({
            sessionId: source.sessionId,
            environmentId: null,
            moveSourceEnvironmentId: source.environmentId,
          }),
        );
      }
      const before = await f.placements.readProjection([heldOwner.sessionId], { current: true });
      const environmentBefore = support.testState.store.get(f.held.environment.environmentId);
      const adopt = vi.spyOn(f.placements, "adoptActive");
      const stop = vi.spyOn(f.environments, "stopTunnel");
      const recovery = await createRecoveryService(f.placements, f.environments);

      await expect(recovery.reconcile("startup")).resolves.toBeUndefined();

      expect(f.inspect).toHaveBeenCalledOnce();
      expect(await f.placements.readProjection([heldOwner.sessionId], { current: true })).toEqual(
        before,
      );
      expect(support.testState.store.get(f.held.environment.environmentId)).toEqual(
        environmentBefore,
      );
      expect(adopt.mock.calls.map(([request]) => request.sessionId)).toEqual(["healthy-session"]);
      expect(stop).not.toHaveBeenCalled();
      expect(f.provider.provision).not.toHaveBeenCalled();
      expect(f.provider.destroy).not.toHaveBeenCalled();
      expect(f.retainedLease.pause).not.toHaveBeenCalled();
      expect(f.retainedLease.resume).not.toHaveBeenCalled();
      expect(f.retainedLease.destroy).not.toHaveBeenCalled();
      await expect(
        f.environments.inspectTurnLease({
          environmentId: f.held.environment.environmentId,
          ownerEpoch: f.held.environment.ownerEpoch,
          leaseId: f.held.environment.leaseId!,
          assertCurrent: () => {},
        }),
      ).rejects.toThrow("strict claim identifier mismatch");
    },
  );

  it.each([
    "orphaned",
    "owner-mismatch",
    "claimed",
    "pending-result",
    "non-retained",
    "storage-failure",
    "shutdown",
  ] as const)(
    "contains disk-authoritative mirror refusal and preserves %s recovery facts",
    async (scenario) => {
      const f = await fixture();
      f.inspect.mockResolvedValue(f.retention.receipt!);
      const repository = runOpenClawStateWriteTransaction(
        ({ db }) => {
          const created = createSessionRepositoryWorkspaceInDatabase(
            db,
            {
              ...heldOwner,
              url: "https://example.test/retained.git",
            },
            1000,
          ).workspace!;
          return bindSessionRepositoryWorkspaceBaseInDatabase(
            db,
            {
              workspaceId: created.workspaceId,
              expectedRevision: created.revision,
              baseCommit: "b".repeat(40),
              ...(scenario === "non-retained"
                ? {}
                : {
                    diskAuthority: {
                      environmentId: f.held.environment.environmentId,
                      sessionId: heldOwner.sessionId,
                      ownerEpoch: f.held.environment.ownerEpoch,
                      ownerBinding: f.retention.ownerBinding,
                      identity: f.retention.receipt!.identity,
                      workspaceDir: "/original/workspace",
                    },
                  }),
            },
            1000,
          ).workspace!;
        },
        { database: support.testState.stateDb },
      );
      if (scenario === "claimed" || scenario === "pending-result") {
        const claim = await f.placements.claimTurn({
          ...heldOwner,
          claimId: "original-claim",
          runId: "original-run",
          owner: {
            kind: "worker",
            environmentId: f.held.environment.environmentId,
            ownerEpoch: f.held.environment.ownerEpoch,
          },
        });
        if (scenario === "pending-result") {
          await f.placements.markWorkspaceResultPending(claim);
          await f.placements.handoffWorkspaceResultRecovery(claim);
        }
      }
      writePlacementEnvironmentFixture(support.testState.stateDb, {
        environmentId: f.held.environment.environmentId,
        state: scenario === "owner-mismatch" ? "attached" : "orphaned",
        ownerEpoch: f.held.environment.ownerEpoch + 1,
        attachedSessionIds: scenario === "owner-mismatch" ? [heldOwner.sessionId] : [],
      });
      const before = await f.placements.readProjection([heldOwner.sessionId], { current: true });
      const environmentBefore = support.testState.store.get(f.held.environment.environmentId);
      const adopt = vi.spyOn(f.placements, "adoptActive");
      const stop = vi.spyOn(f.environments, "stopTunnel");
      let closing = false;
      const readError = new Error("native workspace read unavailable");
      const recovery = await createRecoveryService(
        f.placements,
        f.environments,
        () => closing,
        async (identity) => {
          if (identity.sessionId !== heldOwner.sessionId) {
            return { kind: "local", path: "/gateway/workspace" };
          }
          if (scenario === "storage-failure") {
            throw readError;
          }
          closing = scenario === "shutdown";
          return { kind: "repository", repository };
        },
      );
      if (scenario === "storage-failure" || scenario === "shutdown") {
        const result = expect(recovery.reconcile("startup")).rejects;
        if (scenario === "storage-failure") {
          await result.toBe(readError);
        } else {
          await result.toBeInstanceOf(WorkerWorkspaceReconciliationError);
        }
        expect(await f.placements.readProjection([heldOwner.sessionId], { current: true })).toEqual(
          before,
        );
        return;
      }
      await expect(recovery.reconcile("startup")).resolves.toBeUndefined();
      expect(adopt.mock.calls.map(([request]) => request.sessionId)).toEqual(["healthy-session"]);
      if (scenario === "non-retained") {
        expect(await f.placements.getAsync(heldOwner.sessionId)).toMatchObject({ state: "failed" });
      } else {
        expect(await f.placements.readProjection([heldOwner.sessionId], { current: true })).toEqual(
          before,
        );
        expect(
          findSessionRepositoryWorkspaceInDatabase(support.testState.stateDb.db, heldOwner),
        ).toEqual(repository);
        if (scenario === "orphaned" || scenario === "owner-mismatch" || scenario === "claimed") {
          await expect(recovery.reconcile()).rejects.toBeInstanceOf(
            WorkerWorkspaceReconciliationError,
          );
        }
      }
      expect(support.testState.store.get(f.held.environment.environmentId)).toEqual(
        environmentBefore,
      );
      expect(stop).not.toHaveBeenCalled();
      expect(f.provider.provision).not.toHaveBeenCalled();
      expect(f.provider.destroy).not.toHaveBeenCalled();
      expect(f.retainedLease.resume).not.toHaveBeenCalled();
      expect(f.retainedLease.destroy).not.toHaveBeenCalled();
    },
  );
});
