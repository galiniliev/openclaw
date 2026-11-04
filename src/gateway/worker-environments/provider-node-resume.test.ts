import { describe, expect, it, vi } from "vitest";
import type { WorkerProvider } from "../../plugins/types.js";
import { createWorkerRuntimeRefreshWaiter } from "../server-worker-placement-runtime-refresh.js";
import { DEFAULT_NODE_TOOLCHAIN_SETUP_SH } from "./node-toolchain.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { placementTurnOwner } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementRecord,
} from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createWorkerPreparationIdentity } from "./preparation-identity.js";
import * as support from "./service.test-support.js";

describe("foreground enrolled-node recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["dead", "connected", "claimed", "authority-closed", "unprepared", "reclaim"] as const)(
    "uses the retained node and lease only with current admission or reclaim authority: %s",
    async (scenario) => {
      const environmentId = "node-resume-environment";
      const settings = { region: "test" };
      const preparation = createWorkerPreparationIdentity({
        namespace: "node-resume-fixture",
        providerId: "fake",
        profileId: "development",
        profileSnapshot: { settings },
        imageReserve: true,
        target: { machineClass: "test", platform: "linux" },
        artifacts: {
          nodeBootstrapSha256: "a".repeat(64),
          enabledPluginIds: [],
          workerBundleHash: support.BOOTSTRAP_RECEIPT.bundleHash,
          workerArchiveSha256: "b".repeat(64),
          openclawVersion: support.BOOTSTRAP_RECEIPT.openclawVersion,
          protocolFeatures: support.BOOTSTRAP_RECEIPT.protocolFeatures,
        },
      });
      await support.testState.store.createIntent({
        environmentId,
        providerId: "fake",
        profileId: "development",
        profileSnapshot: {
          settings,
          ...(scenario === "unprepared"
            ? {}
            : { runtimePreparation: { ...preparation, source: "image" } }),
        },
        provisionOperationId: "node-resume-fixture",
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
          leaseId: "retained-lease",
          nodeDeviceId: "retained-node",
          sharedHost: false,
        },
      });
      const environment = await support.testState.store.transition({
        environmentId,
        from: "ready",
        to: "attached",
        patch: support.attachedPatch(environmentId, REQUEST.sessionId),
      });
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const placement = await seedActivePlacement(placements, {
        environmentId,
        ownerEpoch: environment.ownerEpoch,
        executionMode: "remote-exec",
      });
      if (placement.state !== "active") {
        throw new Error("Expected an active fixture");
      }
      let connected = scenario === "connected";
      let current = true;
      const resumeNode = vi.fn<NonNullable<WorkerProvider["resumeNode"]>>(async (request) => {
        expect(request).toMatchObject({
          leaseId: "retained-lease",
          deviceId: "retained-node",
          profile: settings,
          nodeBootstrapSha256: "a".repeat(64),
          linuxToolchainSetup: DEFAULT_NODE_TOOLCHAIN_SETUP_SH,
        });
        request.assertCurrent();
        connected = true;
      });
      const provision = vi.fn();
      const destroy = vi.fn();
      const service = support.createService(
        support.createProvider({ resumeNode, provision, destroy }),
        { placementStore: createWorkerSessionPlacementGate(placements) },
      );
      const waiter = createWorkerRuntimeRefreshWaiter({
        environments: service,
        isStopping: () => false,
      });
      const admitted = vi.fn<Parameters<typeof waiter.bind>[0]>(async (_nodeId, request) => {
        request.assertCurrent();
        if (!connected) {
          throw new Error("Node reconnect still pending");
        }
      });
      waiter.bind(admitted, async () => {
        if (scenario === "authority-closed") {
          current = false;
        }
        return connected;
      });
      if (scenario === "claimed") {
        await placements.claimTurn({
          sessionId: placement.sessionId,
          sessionKey: placement.sessionKey,
          agentId: placement.agentId,
          claimId: "other-claim",
          runId: "other-run",
          owner: placementTurnOwner(placement),
        });
      }
      let recoveryPlacement: Extract<
        WorkerSessionPlacementRecord,
        { state: "active" | "draining" }
      > = placement;
      if (scenario === "reclaim") {
        const draining = await placements.startDrain({
          sessionId: placement.sessionId,
          environmentId,
          ownerEpoch: placement.activeOwnerEpoch,
          expectedGeneration: placement.generation,
        });
        if (draining.state !== "draining") {
          throw new Error("Expected a draining reclaim owner");
        }
        const claim = await placements.claimReclaimWorkspaceResult({
          sessionId: placement.sessionId,
          sessionKey: placement.sessionKey,
          agentId: placement.agentId,
          claimId: "reclaim-node-resume",
          runId: "reclaim-node-resume",
          owner: placementTurnOwner(draining),
        });
        await placements.handoffWorkspaceResultRecovery(claim);
        recoveryPlacement = draining;
      }
      const before = placements.get(placement.sessionId);
      const pendingBefore = await placements.listPendingWorkspaceResultsAsync();
      const beforeEnvironment = support.testState.store.get(environmentId);
      const recovering = waiter.wait({
        placement: recoveryPlacement,
        signal: new AbortController().signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("Foreground authority closed");
          }
        },
      });
      if (scenario === "unprepared") {
        await expect(recovering).rejects.toThrow("Node reconnect still pending");
        expect(resumeNode).not.toHaveBeenCalled();
        expect(admitted).toHaveBeenCalledOnce();
      } else if (scenario === "claimed" || scenario === "authority-closed") {
        await expect(recovering).rejects.toThrow(
          scenario === "claimed" ? "current turn" : "Foreground authority closed",
        );
        expect(resumeNode).not.toHaveBeenCalled();
        expect(admitted).not.toHaveBeenCalled();
      } else {
        await recovering;
        expect(resumeNode).toHaveBeenCalledTimes(
          scenario === "dead" || scenario === "reclaim" ? 1 : 0,
        );
        expect(admitted).toHaveBeenCalledOnce();
      }
      expect(support.testState.store.get(environmentId)).toEqual(beforeEnvironment);
      expect(placements.get(placement.sessionId)).toEqual(before);
      expect(provision).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual(pendingBefore);
    },
  );
});
