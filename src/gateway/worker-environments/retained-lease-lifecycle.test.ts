import { describe, expect, it, vi } from "vitest";
import type { WorkerProvider } from "../../plugins/types.js";
import type {
  WorkerRetainedLeaseReceipt,
  WorkerSessionDiskRetention,
} from "../../plugins/worker-retention.types.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import { createWorkerRetainedLeaseLifecycle } from "./retained-lease-lifecycle.js";
import * as support from "./service.test-support.js";

const owner = { sessionId: "retained-session", sessionKey: "agent:main:retained", agentId: "main" };
const binding = "a".repeat(64);
const initial: WorkerRetainedLeaseReceipt = {
  schema: "crabbox.session-disk.v1",
  mode: "session-disk",
  ownerBinding: binding,
  identity: {
    leaseId: "cbx_0123456789ab",
    attemptLeaseId: "cbx_0123456789ab",
    slug: "retained",
    resourceId: "resource-owned",
  },
  claimRevision: "revision-create",
  computeWindowSeconds: 60,
  desiredState: "running",
  computeWindow: {
    id: "cbx_0123456789ab",
    authorizedAt: new Date(1000).toISOString(),
    expiresAt: new Date(61000).toISOString(),
    state: "active",
  },
  policyVerified: true,
  observedState: "Running",
  stopPending: false,
};

async function fixture() {
  let observed = structuredClone(initial);
  const effects: Array<{ action: string; id: string; expected: string }> = [];
  let failPause = false;
  const retainedLease: NonNullable<WorkerProvider["retainedLease"]> = {
    inspect: vi.fn(async () => structuredClone(observed)),
    pause: vi.fn(async (request) => {
      // Exercise the real writer before the external effect, including after reopen.
      expect(support.testState.store.get("retained-environment")?.retention?.operation?.id).toBe(
        request.operationId,
      );
      effects.push({
        action: "pause",
        id: request.operationId,
        expected: request.retention.operation!.expectedClaimRevision,
      });
      if (failPause) {
        failPause = false;
        throw new Error("provider outcome unknown");
      }
      observed = {
        ...observed,
        claimRevision: "revision-paused",
        desiredState: "suspended",
        observedState: "Stopped",
        computeWindow: { ...observed.computeWindow, state: "closed" },
        operation: {
          id: request.operationId,
          action: "pause",
          phase: "observed",
          expectedClaimRevision: request.retention.operation!.expectedClaimRevision,
        },
      };
      return structuredClone(observed);
    }),
    resume: vi.fn(async (request) => {
      effects.push({
        action: "resume",
        id: request.operationId,
        expected: request.retention.operation!.expectedClaimRevision,
      });
      observed = {
        ...observed,
        claimRevision: "revision-resumed",
        desiredState: "running",
        observedState: "Running",
        computeWindow: {
          id: request.operationId,
          authorizedAt: new Date(support.testState.nowMs).toISOString(),
          expiresAt: new Date(support.testState.nowMs + 60000).toISOString(),
          state: "active",
        },
        operation: {
          id: request.operationId,
          action: "resume",
          phase: "observed",
          expectedClaimRevision: request.retention.operation!.expectedClaimRevision,
        },
      };
      return structuredClone(observed);
    }),
    destroy: vi.fn(async () => {}),
  };
  const provider = support.createProvider({ retainedLease });
  const retention: WorkerSessionDiskRetention = {
    owner,
    ownerBinding: binding,
    desiredState: "running",
    policy: { mode: "session-disk", computeWindowSeconds: 60 },
    receipt: initial,
    operation: null,
  };
  const store = support.testState.store;
  await store.createIntent({
    environmentId: "retained-environment",
    providerId: provider.id,
    profileId: "development",
    profileSnapshot: { settings: {} },
    provisionOperationId: "retained-create",
    retention,
  });
  await store.transition({
    environmentId: "retained-environment",
    from: "requested",
    to: "provisioning",
  });
  await store.transition({
    environmentId: "retained-environment",
    from: "provisioning",
    to: "ready",
    patch: {
      ...support.readyPatch("retained-environment"),
      leaseId: initial.identity.leaseId,
      nodeDeviceId: "retained-node",
      sharedHost: false,
    },
  });
  await store.transition({
    environmentId: "retained-environment",
    from: "ready",
    to: "attached",
    patch: support.attachedPatch("retained-environment", owner.sessionId),
  });
  const controller = () =>
    createWorkerRetainedLeaseLifecycle({
      store: support.testState.store,
      providerFor: () => provider,
      signal: new AbortController().signal,
      now: () => support.testState.nowMs,
    });
  const record = () => support.testState.store.get("retained-environment")!;
  return {
    controller,
    record,
    provider,
    retainedLease,
    effects,
    failNextPause: () => {
      failPause = true;
    },
    setObserved: (value: WorkerRetainedLeaseReceipt) => {
      observed = value;
    },
  };
}

describe("session-private retained lease lifecycle", () => {
  support.setupWorkerEnvironmentServiceSuite();
  it.each(["cancellation", "authority"] as const)(
    "preserves native %s failures raised during provider inspection",
    async (scenario) => {
      const f = await fixture();
      const before = f.record();
      const abort = new AbortController();
      const failure = new Error(`native ${scenario} failed`);
      let assertions = 0;
      vi.mocked(f.retainedLease.inspect).mockImplementationOnce(async (request) => {
        if (scenario === "cancellation") {
          abort.abort(failure);
          throw new Error("provider inspection interrupted");
        }
        request.assertCurrent();
        return structuredClone(initial);
      });
      await expect(
        f.controller().observe(before, abort.signal, () => {
          if (scenario === "authority" && ++assertions === 1) {
            throw failure;
          }
        }),
      ).rejects.toBe(failure);
      expect(f.record()).toEqual(before);
      expect(f.effects).toEqual([]);
    },
  );
  it.each(["ready", "runtime-failure", "new-owner", "different-node"] as const)(
    "composes retained allocation with canonical node completion (%s)",
    async (outcome) => {
      let observed = initial;
      const unavailable = async () => {
        throw new Error("Unexpected lifecycle effect");
      };
      const retainedLease: NonNullable<WorkerProvider["retainedLease"]> = {
        inspect: async () => structuredClone(observed),
        pause: unavailable,
        resume: unavailable,
        destroy: vi.fn(unavailable),
      };
      support.getDevelopmentProfile().retention = {
        mode: "session-disk",
        computeWindowSeconds: 60,
      };
      const provision = vi.fn<WorkerProvider["provision"]>(
        async (_profile, _operationId, options) => {
          const record = support.testState.store.get(options!.environmentId!);
          expect(record?.retention).toMatchObject({
            owner,
            policy: { mode: "session-disk", computeWindowSeconds: 60 },
            receipt: null,
          });
          expect(options?.retention?.ownerBinding).toMatch(/^[a-f0-9]{64}$/u);
          expect(record?.retention?.ownerBinding).toBe(options?.retention?.ownerBinding);
          const enrollment = await options!.beginNodeEnrollment!();
          if (enrollment.mode !== "connect") {
            throw new Error("Expected canonical pending setup");
          }
          await completeWorkerNodeSetupForTest({
            baseDir: support.testState.root,
            store: support.testState.store,
            setupId: enrollment.setupId,
            deviceId: "retained-node",
            completedAtMs: 1000,
          });
          observed = {
            ...initial,
            ownerBinding: options!.retention!.ownerBinding,
            identity: { ...initial.identity, leaseId: "lease-1" },
            computeWindow: { ...initial.computeWindow, id: "lease-1" },
          };
          return {
            leaseId: "lease-1",
            sharedHost: false,
            node: { deviceId: outcome === "different-node" ? "wrong-node" : "retained-node" },
            retainedLease: structuredClone(observed),
          };
        },
      );
      const service = support.createService(
        support.createProvider({
          requiresNodeEnrollment: true,
          retainedLease,
          provision,
        }),
        {
          ensureNodeWorkerBundle: async ({ environmentId }) => {
            if (!environmentId) {
              throw new Error("Fixture runtime installation requires its environment owner");
            }
            if (outcome === "runtime-failure") {
              throw new Error("runtime installation failed");
            }
            if (outcome === "new-owner") {
              await support.testState.store.transition({
                environmentId,
                from: "provisioning",
                to: "ready",
                patch: {
                  ...support.readyPatch(environmentId),
                  leaseId: "lease-1",
                  nodeDeviceId: "retained-node",
                  sharedHost: false,
                },
              });
            }
            return support.BOOTSTRAP_RECEIPT;
          },
          prepareNodeEnrollment: async (record) => {
            const enrolled = await support.testState.store.ensureNodeEnrollment(
              record.environmentId,
            );
            if (!enrolled.nodeSetupId) {
              throw new Error("Expected canonical setup owner");
            }
            return {
              mode: "connect",
              setupId: enrolled.nodeSetupId,
              setupCode: "fixture-setup-code",
              displayName: "Retained test",
              openclawVersion: support.NODE_BOOTSTRAP.openclawVersion,
              nodeBootstrap: support.NODE_BOOTSTRAP,
              waitForDeviceId: async () => "retained-node",
            };
          },
        },
      );
      await expect(
        service.createWithRequest({ profileId: "development", idempotencyKey: "unowned-retained" }),
      ).rejects.toThrow("exclusive session");
      expect(provision).not.toHaveBeenCalled();
      const request = {
        profileId: "development",
        idempotencyKey: "owned-retained",
        retentionOwner: owner,
      };
      if (outcome !== "ready") {
        await expect(service.createWithRequest(request)).rejects.toThrow(
          outcome === "runtime-failure"
            ? "runtime installation failed"
            : "Prepared worker provisioning owner is no longer current",
        );
        const current = support.testState.store.list().find((entry) => entry.retention);
        if (outcome === "new-owner") {
          expect(current).toMatchObject({
            state: "ready",
            ownerEpoch: 1,
            destroyRequestedAtMs: null,
            lastError: null,
          });
          expect(retainedLease.destroy).not.toHaveBeenCalled();
        } else if (outcome === "different-node") {
          expect(current).toMatchObject({
            state: "provisioning",
            nodeDeviceId: "retained-node",
            destroyRequestedAtMs: null,
            retention: { receipt: null },
          });
          expect(retainedLease.destroy).not.toHaveBeenCalled();
        } else {
          expect(current).toMatchObject({
            state: "destroying",
            teardownTerminalState: "failed",
            lastError: "runtime installation failed",
            leaseId: "lease-1",
            nodeDeviceId: "retained-node",
          });
        }
        return;
      }
      const created = await service.createWithRequest(request);
      expect(created).toMatchObject({
        state: "ready",
        leaseId: "lease-1",
        nodeDeviceId: "retained-node",
        retention: { owner, receipt: { identity: { leaseId: "lease-1" } } },
      });
      await expect(service.createWithRequest(request)).resolves.toMatchObject({
        environmentId: created.environmentId,
      });
      expect(provision).toHaveBeenCalledOnce();
      await expect(
        service.attachSession({
          environmentId: created.environmentId,
          ownerEpoch: created.ownerEpoch,
          sessionId: "another-session",
        }),
      ).rejects.toThrow("original session owner");
      expect(support.testState.store.get(created.environmentId)?.state).toBe("ready");
      await expect(
        service.attachSession({
          environmentId: created.environmentId,
          ownerEpoch: created.ownerEpoch,
          sessionId: owner.sessionId,
        }),
      ).resolves.toMatchObject({ sessionId: owner.sessionId });
    },
  );
  it.each(["replaced", "removed"] as const)(
    "resumes the saved private disk through the service after restart with profile %s",
    async (change) => {
      const f = await fixture();
      const before = structuredClone(f.record());
      const service = support.createService(f.provider);
      await service.pauseRetained({
        environmentId: before.environmentId,
        ownerEpoch: before.ownerEpoch,
        assertCurrent: () => {},
      });
      await service.stop();
      if (change === "removed") {
        delete support.testState.config.cloudWorkers!.profiles!.development;
      } else {
        support.getDevelopmentProfile().settings = { azureSandboxDiskId: "latest-disk" };
      }
      await support.reopenWorkerEnvironmentStore();
      support.testState.nowMs = 70000;
      const restarted = support.createService(f.provider);
      const request = {
        environmentId: before.environmentId,
        ownerEpoch: before.ownerEpoch,
        leaseId: before.leaseId!,
        assertCurrent: () => {},
      };
      await expect(
        restarted.inspectTurnLease({ ...request, ownerEpoch: before.ownerEpoch + 1 }),
      ).rejects.toThrow("Retained session placement is not current");
      await expect(
        restarted.attachSession({
          environmentId: before.environmentId,
          ownerEpoch: before.ownerEpoch,
          sessionId: "wrong-session",
        }),
      ).rejects.toThrow("Cannot attach worker in state: attached");
      expect(f.effects.map((effect) => effect.action)).toEqual(["pause"]);
      await restarted.inspectTurnLease(request);
      expect(f.record()).toMatchObject({
        environmentId: before.environmentId,
        leaseId: before.leaseId,
        nodeDeviceId: before.nodeDeviceId,
        ownerEpoch: before.ownerEpoch,
        profileSnapshot: before.profileSnapshot,
        attachedSessionIds: [owner.sessionId],
      });
      expect(f.effects.map((effect) => effect.action)).toEqual(["pause", "resume"]);
      expect(f.retainedLease.resume).toHaveBeenCalledWith(
        expect.objectContaining({
          leaseId: before.leaseId,
          profile: before.profileSnapshot.settings,
          retention: expect.objectContaining({ ownerBinding: binding }),
        }),
      );
      await restarted.destroy(before.environmentId);
      expect(f.record().state).toBe("destroyed");
      expect(f.retainedLease.destroy).toHaveBeenCalledWith(
        expect.objectContaining({
          leaseId: before.leaseId,
          profile: before.profileSnapshot.settings,
        }),
      );
    },
  );

  it.each(["exact", "wrong-binding", "restart-after-unknown"] as const)(
    "retires only the saved dedicated retained resource (%s)",
    async (outcome) => {
      const f = await fixture();
      const before = f.record();
      const retirement = {
        sessionId: owner.sessionId,
        ownerEpoch: before.ownerEpoch,
        retainedOwnerBinding: outcome === "wrong-binding" ? "b".repeat(64) : binding,
        authorize: () => {},
      };
      let service = support.createService(f.provider);
      const cleanup = vi.fn(async () => {});
      if (outcome === "wrong-binding") {
        await expect(service.destroy(before.environmentId, retirement, cleanup)).rejects.toThrow(
          "owner changed before retirement",
        );
        expect(f.record().destroyRequestedAtMs).toBeNull();
        expect(f.retainedLease.destroy).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();
        await service.stop();
        return;
      }
      await expect(
        service.destroy(before.environmentId, retirement, cleanup),
      ).resolves.toMatchObject({
        environmentId: before.environmentId,
        retention: expect.objectContaining({ ownerBinding: binding }),
      });
      expect(f.record().destroyRequestedAtMs).not.toBeNull();
      expect(f.record().state).not.toBe("destroyed");
      expect(support.testState.store.getCredential(before.environmentId)).toBeUndefined();
      expect(f.retainedLease.destroy).not.toHaveBeenCalled();
      if (outcome === "restart-after-unknown") {
        vi.mocked(f.retainedLease.destroy).mockRejectedValueOnce(
          new Error("provider result unknown"),
        );
        await service.reconcileOnce();
        expect(f.record().state).not.toBe("destroyed");
        expect(f.record().retention?.ownerBinding).toBe(binding);
        await service.stop();
        await support.reopenWorkerEnvironmentStore();
        service = support.createService(f.provider);
      }
      await service.reconcileOnce();
      expect(f.record().state).toBe("destroyed");
      expect(f.retainedLease.destroy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          leaseId: initial.identity.leaseId,
          profile: before.profileSnapshot.settings,
          retention: expect.objectContaining({ ownerBinding: binding }),
        }),
      );
      expect(f.retainedLease.resume).not.toHaveBeenCalled();
      expect(f.retainedLease.pause).not.toHaveBeenCalled();
      await service.stop();
    },
  );

  it.each(["missing", "uncertain", "wrong-resource", "revoked"] as const)(
    "routes only an exact missing resource to canonical cleanup (%s)",
    async (outcome) => {
      const f = await fixture();
      const before = f.record();
      f.setObserved({
        ...initial,
        policyVerified: false,
        observedState: outcome === "uncertain" ? "Running" : "missing",
        identity: {
          ...initial.identity,
          ...(outcome === "wrong-resource" ? { resourceId: "different-resource" } : {}),
        },
      });
      const fallback = vi.fn(async () => {});
      const inspect = f.controller().inspectForTurn(
        {
          environmentId: before.environmentId,
          ownerEpoch: before.ownerEpoch,
          leaseId: before.leaseId!,
          assertCurrent: () => {
            if (outcome === "revoked") {
              throw new Error("authority revoked");
            }
          },
        },
        fallback,
      );
      if (outcome === "missing") {
        await expect(inspect).resolves.toBeUndefined();
        expect(fallback).toHaveBeenCalledOnce();
        await expect(
          f.controller().reconcile(before, new AbortController().signal, () => {}),
        ).resolves.toEqual(before);
      } else {
        await expect(inspect).rejects.toThrow();
        expect(fallback).not.toHaveBeenCalled();
      }
      expect(f.record()).toEqual(before);
      expect(f.effects).toEqual([]);
      expect(f.retainedLease.destroy).not.toHaveBeenCalled();
    },
  );

  it("keeps exact attachment through idle pause and reopens only a new authorized window", async () => {
    const f = await fixture();
    const before = f.record();
    await f.controller().pause(before, new AbortController().signal, () => {});
    expect(f.record()).toMatchObject({
      environmentId: before.environmentId,
      leaseId: before.leaseId,
      nodeDeviceId: before.nodeDeviceId,
      attachedSessionIds: [owner.sessionId],
      retention: {
        operation: null,
        receipt: {
          desiredState: "suspended",
          computeWindow: { state: "closed", expiresAt: initial.computeWindow.expiresAt },
        },
      },
    });
    await support.reopenWorkerEnvironmentStore();
    support.testState.nowMs = 70000;
    await f.controller().resumeForTurn(f.record(), new AbortController().signal, () => {});
    expect(f.effects.map((x) => x.action)).toEqual(["pause", "resume"]);
    expect(f.record().retention?.receipt?.computeWindow).toMatchObject({
      id: f.effects[1]?.id,
      authorizedAt: new Date(70000).toISOString(),
      expiresAt: new Date(130000).toISOString(),
    });
    const unchanged = f.record().retention?.receipt?.computeWindow;
    await f.controller().resumeForTurn(f.record(), new AbortController().signal, () => {});
    expect(f.record().retention?.receipt?.computeWindow).toEqual(unchanged);
    expect(f.effects).toHaveLength(2);
  });
  it("replays an uncertain pause with the original durable operation and revision after restart", async () => {
    const f = await fixture();
    f.failNextPause();
    await expect(
      f.controller().pause(f.record(), new AbortController().signal, () => {}),
    ).rejects.toThrow("outcome unknown");
    const pending = f.record().retention?.operation;
    expect(pending).toMatchObject({ action: "pause", expectedClaimRevision: "revision-create" });
    await support.reopenWorkerEnvironmentStore();
    await f.controller().pause(f.record(), new AbortController().signal, () => {});
    expect(f.effects[1]).toEqual(f.effects[0]);
    expect(f.record().retention?.operation).toBeNull();
  });
  it("retains stop intent during a status outage and settles it before fresh input after restart", async () => {
    const f = await fixture();
    vi.mocked(f.retainedLease.inspect).mockRejectedValueOnce(new Error("status unavailable"));
    await expect(
      f.controller().pause(f.record(), new AbortController().signal, () => {}),
    ).rejects.toThrow("status unavailable");
    expect(f.record().retention?.desiredState).toBe("suspended");
    expect(f.effects).toEqual([]);
    await support.reopenWorkerEnvironmentStore();
    await f.controller().resumeForTurn(f.record(), new AbortController().signal, () => {});
    expect(f.effects.map((effect) => effect.action)).toEqual(["pause", "resume"]);
    expect(f.record().retention?.desiredState).toBe("running");
  });
  it("closes expired compute before opening a distinct window for same-session input", async () => {
    const f = await fixture();
    support.testState.nowMs = 90000;
    await f.controller().resumeForTurn(f.record(), new AbortController().signal, () => {});
    expect(f.effects.map((x) => x.action)).toEqual(["pause", "resume"]);
    expect(f.effects[0]?.id).not.toBe(f.effects[1]?.id);
    expect(f.record().retention?.receipt?.identity).toEqual(initial.identity);
  });
  it.each(["missing-policy", "different-resource", "revoked"] as const)(
    "refuses %s without replacement or lifecycle effects",
    async (scenario) => {
      const f = await fixture();
      const before = f.record();
      if (scenario === "missing-policy") {
        f.setObserved({ ...initial, policyVerified: false });
      }
      if (scenario === "different-resource") {
        f.setObserved({
          ...initial,
          identity: { ...initial.identity, resourceId: "other-resource" },
        });
      }
      await expect(
        f.controller().resumeForTurn(before, new AbortController().signal, () => {
          if (scenario === "revoked") {
            throw new Error("authority revoked");
          }
        }),
      ).rejects.toThrow();
      expect(f.effects).toEqual([]);
      expect(f.record()).toEqual(before);
      expect(f.retainedLease.destroy).not.toHaveBeenCalled();
    },
  );
});
