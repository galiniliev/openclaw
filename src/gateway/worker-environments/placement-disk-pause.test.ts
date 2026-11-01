import { describe, expect, it, vi } from "vitest";
import type { WorkerRetainedLeaseReceipt } from "../../plugins/worker-retention.types.js";
import { stopWorkerSessionPlacement } from "./placement-disk-pause.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";

const ownedDisk: WorkerRetainedLeaseReceipt = {
  schema: "crabbox.session-disk.v1",
  mode: "session-disk",
  ownerBinding: "a".repeat(64),
  identity: {
    leaseId: "cbx_0123456789ab",
    attemptLeaseId: "cbx_0123456789ab",
    slug: "retained",
    resourceId: "owned-resource",
  },
  claimRevision: "revision-create",
  computeWindowSeconds: 14400,
  desiredState: "running",
  computeWindow: {
    id: "cbx_0123456789ab",
    authorizedAt: new Date(1000).toISOString(),
    expiresAt: new Date(14401000).toISOString(),
    state: "active",
  },
  policyVerified: true,
  observedState: "Running",
  stopPending: false,
};

describe("Stop after retained worker provisioning failure", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each([
    "settled",
    "unknown-allocation",
    "revoked",
    "activated",
    "disk-receipt",
    "owner-changed",
    "foreign-owner",
    "gateway",
  ] as const)(
    "uses canonical failed cleanup without discarding a retained owner (%s)",
    async (outcome) => {
      const store = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const harness = await createHarness(support.testState.stateDb, store, {
        failAt: "create",
        destroyFailureCount: outcome === "unknown-allocation" ? 2 : 1,
      });
      let bindingChanged = false;
      const readEnvironment = vi.mocked(harness.environments.get).getMockImplementation()!;
      vi.mocked(harness.environments.get).mockImplementation((id) => {
        const record = readEnvironment(id);
        if (!record) {
          return record;
        }
        const retention = {
          policy: { mode: "session-disk" as const, computeWindowSeconds: 14400 },
          owner: {
            ...REQUEST,
            sessionId: outcome === "foreign-owner" ? "another-session" : REQUEST.sessionId,
          },
          ownerBinding: (bindingChanged ? "b" : "a").repeat(64),
          desiredState: "running" as const,
          receipt: outcome === "disk-receipt" ? ownedDisk : null,
          operation: null,
        };
        if (record.state === "destroyed") {
          return { ...record, retention };
        }
        // Provider allocation outcome is unresolved: no lease is NOT absence proof.
        return {
          ...record,
          state: "provisioning",
          leaseId: null,
          sshEndpoint: null,
          lastActivatedAtMs: outcome === "activated" ? 1000 : null,
          retention,
        };
      });
      await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("create failed");
      const failed = store.get(REQUEST.sessionId)!;
      expect(failed).toMatchObject({ state: "failed", activeOwnerEpoch: null, turnClaim: null });
      const before = vi.mocked(harness.environments.destroy).mock.calls.length;
      let revoked = false;
      const authorize = () => {
        if (outcome === "owner-changed") {
          bindingChanged = true;
        }
        if (revoked) {
          throw new Error("operator authority revoked");
        }
      };
      if (outcome === "revoked") {
        revoked = true;
      }
      const stop = stopWorkerSessionPlacement(
        harness.service,
        harness.environments,
        failed,
        {
          ...REQUEST,
          ...(outcome === "gateway"
            ? { recoverToGateway: { expectedGeneration: failed.generation } }
            : {}),
        },
        authorize,
      );
      if (outcome === "settled") {
        await expect(stop).resolves.toMatchObject({ state: "local" });
        expect(harness.environments.destroy).toHaveBeenCalledTimes(before + 1);
        expect(harness.environments.get(failed.environmentId!)?.state).toBe("destroyed");
      } else {
        await expect(stop).rejects.toThrow(
          outcome === "unknown-allocation"
            ? "destroy pending"
            : outcome === "revoked"
              ? "operator authority revoked"
              : "replacement is refused",
        );
        expect(store.get(REQUEST.sessionId)).toMatchObject({
          state: "failed",
          environmentId: failed.environmentId,
        });
        expect(harness.environments.destroy).toHaveBeenCalledTimes(
          before + (outcome === "unknown-allocation" ? 1 : 0),
        );
      }
      expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
    },
  );
});
