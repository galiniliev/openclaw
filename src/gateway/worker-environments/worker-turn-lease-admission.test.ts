import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { claimWorkerTurn, createRequiredWorkerTurnAdmission } from "./worker-turn-admission.js";

const identity = {
  sessionId: "lease-admission-session",
  agentId: "main",
  sessionKey: "agent:main:lease-admission",
};

describe("fresh worker lease admission", () => {
  support.setupWorkerEnvironmentServiceSuite();

  async function harness(inspect: WorkerProvider["inspect"], destroy = vi.fn(async () => {})) {
    const environmentId = "lease-admission-old";
    await support.seedAttachedIdentity(environmentId, identity.sessionId);
    const environment = support.testState.store.get(environmentId)!;
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const active = await advancePlacementFixtureToActive(
      placements,
      support.testState.stateDb,
      { ...identity, executionMode: "remote-exec" },
      { environmentId, ownerEpoch: environment.ownerEpoch, seedEnvironment: false },
    );
    const provision = vi.fn(async () => {
      throw new Error("admission must not provision");
    });
    const service = support.createService(support.createProvider({ inspect, destroy, provision }), {
      placementStore: createWorkerSessionPlacementGate(placements),
      providerCallTimeoutMs: 50,
    });
    const reconcile = vi.fn(async () => {
      expect(service.get(environmentId)).toMatchObject({ state: "failed", leaseId: null });
      const current = await placements.getAsync(identity.sessionId);
      if (current?.state !== "active") {
        throw new Error("expected retained placement");
      }
      const draining = await placements.startDrain({
        sessionId: identity.sessionId,
        environmentId,
        ownerEpoch: current.activeOwnerEpoch,
        expectedGeneration: current.generation,
      });
      const reconciling = await placements.startReconcile({
        sessionId: identity.sessionId,
        environmentId,
        ownerEpoch: current.activeOwnerEpoch,
        expectedGeneration: draining.generation,
      });
      await placements.transition({
        sessionId: identity.sessionId,
        from: "reconciling",
        to: "reclaimed",
        expectedGeneration: reconciling.generation,
      });
    });
    const admission = createRequiredWorkerTurnAdmission({
      environments: service,
      placements,
      reconcileActivePlacement: reconcile,
      waitForAdmissionNode: async () => {
        throw new Error("must not wait for vanished node");
      },
    });
    const turn = { timeoutMs: 1000 } satisfies Pick<SessionPlacementTurnParams, "timeoutMs">;
    // Admission consumes only the turn's deadline and cancellation signal.
    const recover = (assertCurrent = () => {}, signal?: AbortSignal) =>
      admission.recoverTurnPlacement(active, { ...turn, abortSignal: signal }, assertCurrent);
    return {
      service,
      placements,
      active,
      environment,
      environmentId,
      recover,
      reconcile,
      provision,
      destroy,
    };
  }

  it("settles preclaim loss without refreshing credentials or bootstrapping", async () => {
    const h = await harness(async () => ({ status: "unknown" }));
    expect(h.service.get(h.environmentId)).toMatchObject({
      state: "attached",
      leaseId: `lease:${h.environmentId}`,
    });
    expect((await h.placements.getAsync(identity.sessionId))?.turnClaim).toBeNull();
    const recovered = await h.recover();
    expect(recovered.state).toBe("reclaimed");
    expect(h.destroy).toHaveBeenCalledOnce();
    expect(h.provision).not.toHaveBeenCalled();
    expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
    expect(h.placements.get(identity.sessionId)?.turnClaim).toBeNull();
  });

  it.each(["active", "dormant"] as const)(
    "preserves a recognized %s lease without credential or runtime refresh",
    async (status) => {
      // Provider status is authoritative; SSH readiness is not part of WorkerLeaseStatus.
      const h = await harness(async () =>
        status === "active" ? { status, sharedHost: false } : { status },
      );
      expect(await h.recover()).toMatchObject({
        state: "active",
        activeOwnerEpoch: h.environment.ownerEpoch,
      });
      expect(h.destroy).not.toHaveBeenCalled();
      expect(h.reconcile).not.toHaveBeenCalled();
      expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
      expect(h.service.get(h.environmentId)?.ownerEpoch).toBe(h.environment.ownerEpoch);
    },
  );

  it.each(["error", "timeout"])(
    "holds custody without claim or allocation on inspection %s",
    async (kind) => {
      const pending = createDeferred<{ status: "active" }>();
      const h = await harness(async () => {
        if (kind === "error") {
          throw new Error("provider transport unavailable");
        }
        return pending.promise;
      });
      try {
        await expect(h.recover()).rejects.toThrow("inspection failed");
        expect(h.service.get(h.environmentId)).toMatchObject({
          state: "attached",
          leaseId: h.environment.leaseId,
        });
        expect(h.placements.get(identity.sessionId)?.turnClaim).toBeNull();
        expect(h.destroy).not.toHaveBeenCalled();
        expect(h.provision).not.toHaveBeenCalled();
      } finally {
        pending.resolve({ status: "active" });
      }
    },
  );

  it.each(["cancel", "source", "owner"])(
    "rejects %s changes during inspection before loss settlement",
    async (kind) => {
      const entered = createDeferred();
      const release = createDeferred();
      const h = await harness(async () => {
        entered.resolve();
        await release.promise;
        return { status: "unknown" };
      });
      const controller = new AbortController();
      let current = true;
      const recovery = h.recover(() => {
        if (!current) {
          throw new Error("input source revoked");
        }
      }, controller.signal);
      const rejected = expect(recovery).rejects.toThrow();
      await entered.promise;
      if (kind === "cancel") {
        controller.abort(new Error("input cancelled"));
      } else if (kind === "source") {
        current = false;
      } else {
        await support.testState.store.requestDestroy({
          environmentId: h.environmentId,
          state: "attached",
        });
      }
      release.resolve();
      await rejected;
      expect(h.destroy).not.toHaveBeenCalled();
      expect(h.provision).not.toHaveBeenCalled();
      expect(h.placements.get(identity.sessionId)?.turnClaim).toBeNull();
    },
  );

  it("preserves a pending workspace result without inspecting or claiming its lease", async () => {
    const inspect = vi.fn(async () => ({ status: "active" as const }));
    const h = await harness(inspect);
    const claimed = await claimWorkerTurn({
      placements: h.placements,
      identity,
      placement: h.active,
      runId: "previous-input",
      isCancellationRequested: () => false,
    });
    if (!claimed) {
      throw new Error("expected previous claim");
    }
    await h.placements.markWorkspaceResultPending(claimed.turnClaim);
    await expect(h.recover()).rejects.toThrow("Workspace recovery is pending");
    expect(inspect).not.toHaveBeenCalled();
    expect(await h.placements.listPendingWorkspaceResultsAsync(identity.sessionId)).toHaveLength(1);
    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.provision).not.toHaveBeenCalled();
  });

  it("does not claim or redispatch when confirmed loss cleanup is incomplete", async () => {
    const h = await harness(
      async () => ({ status: "unknown" }),
      vi.fn(async () => {
        throw new Error("destroy outcome unavailable");
      }),
    );
    await expect(h.recover()).rejects.toThrow("cleanup is incomplete");
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.provision).not.toHaveBeenCalled();
    expect(h.placements.get(identity.sessionId)?.turnClaim).toBeNull();
    expect(h.service.get(h.environmentId)?.leaseId).toBe(h.environment.leaseId);
  });
});
