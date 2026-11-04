import path from "node:path";
import { describe, expect, vi } from "vitest";
import { createCommandTest } from "../../../test/helpers/command-fixture.js";
import type { WorkerSessionDiskRetention } from "../../plugins/worker-retention.types.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { placementTurnOwner } from "./placement-record.js";
import type { PlacementRecoveryDeps } from "./placement-recovery-contract.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";

const it = createCommandTest();

describe("disconnected retained final-save recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.for([
    { outcome: "resumed", purpose: "reclaim" },
    { outcome: "unavailable", purpose: "reclaim" },
    { outcome: "ordinary-node", purpose: "reclaim" },
    { outcome: "resumed", purpose: "worker-turn" },
    { outcome: "unavailable", purpose: "worker-turn" },
    { outcome: "resumed", purpose: "remote-exec" },
    { outcome: "unavailable", purpose: "remote-exec" },
  ] as const)(
    "settles only the original result after same-worker preparation: $outcome $purpose",
    async ({ outcome, purpose }, { command }) => {
      const workspacePath = path.join(support.testState.root, "retained-final-save");
      expect((await command.run("git", ["init", "--quiet", workspacePath])).status).toBe(0);
      const store = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      let connected = false;
      // The node reconnect boundary is external I/O. Receipt persistence,
      // reconciliation, final verification and claim closure remain real.
      const waitForRecoveryNode = vi.fn<NonNullable<PlacementRecoveryDeps["waitForRecoveryNode"]>>(
        async (_placement, assertCurrent) => {
          assertCurrent();
          if (outcome === "unavailable") {
            throw new Error("Retained supervisor reconnect is still pending");
          }
          connected = true;
        },
      );
      const harness = await createHarness(support.testState.stateDb, store, {
        workspacePath,
        hasCurrentRunner: () => connected,
        waitForRecoveryNode,
      });
      const draining =
        purpose === "reclaim"
          ? await harness.placements.seedDraining(2)
          : await harness.placements.seedActive(2, purpose);
      if (draining.state !== "draining" && draining.state !== "active") {
        throw new Error("Expected original result owner fixture");
      }
      harness.markEnvironmentOwnerEpoch(draining.activeOwnerEpoch);
      harness.markEnvironmentNodeDeviceId("retained-final-save-node");
      const retention: WorkerSessionDiskRetention = {
        policy: { mode: "session-disk", computeWindowSeconds: 14400 },
        owner: REQUEST,
        ownerBinding: "a".repeat(64),
        desiredState: "suspended",
        receipt: null,
        operation: null,
      };
      const readEnvironment = vi.mocked(harness.environments.get).getMockImplementation();
      if (!readEnvironment) {
        throw new Error("Environment fixture implementation is missing");
      }
      vi.mocked(harness.environments.get).mockImplementation((id) => {
        const record = readEnvironment(id);
        return record && outcome !== "ordinary-node" ? { ...record, retention } : record;
      });
      expect(harness.environments.get(draining.environmentId)?.retention).toEqual(
        outcome === "ordinary-node" ? undefined : retention,
      );
      const identity = {
        ...REQUEST,
        claimId: purpose === "reclaim" ? "reclaim-retained-final-save" : "interrupted-turn",
        runId: purpose === "reclaim" ? "reclaim-retained-final-save" : "original-run",
        owner: placementTurnOwner(draining),
      };
      const claim =
        purpose === "reclaim"
          ? await store.claimReclaimWorkspaceResult(identity)
          : await store.claimTurn(identity);
      if (purpose === "reclaim") {
        await store.handoffWorkspaceResultRecovery(claim);
      } else {
        await store.retainInterruptedTurnWorkspace(claim, () => {});
      }
      const originalPending = await store.listPendingWorkspaceResultsAsync();

      await harness.service.reconcileActive();

      if (outcome === "resumed") {
        expect(waitForRecoveryNode).toHaveBeenCalledOnce();
        expect(store.get(REQUEST.sessionId)).toMatchObject({
          state: purpose === "reclaim" ? "reclaimed" : "active",
          environmentId: draining.environmentId,
          activeOwnerEpoch: draining.activeOwnerEpoch,
          turnClaim: null,
        });
        expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect(harness.log.indexOf("workspace:verify-local")).toBeGreaterThanOrEqual(0);
        if (purpose === "reclaim") {
          expect(harness.log.indexOf("workspace:verify-local")).toBeLessThan(
            harness.log.indexOf("teardown:destroy"),
          );
        } else {
          expect(harness.environments.destroy).not.toHaveBeenCalled();
        }
      } else {
        expect(waitForRecoveryNode).toHaveBeenCalledTimes(outcome === "unavailable" ? 1 : 0);
        expect(store.get(REQUEST.sessionId)).toMatchObject({
          state: purpose === "reclaim" ? "draining" : "active",
          activeOwnerEpoch: draining.activeOwnerEpoch,
          turnClaim: { claimId: claim.claimId },
        });
        expect(await store.listPendingWorkspaceResultsAsync()).toEqual(originalPending);
        expect(harness.environments.destroy).not.toHaveBeenCalled();
      }
      expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
    },
  );
});
