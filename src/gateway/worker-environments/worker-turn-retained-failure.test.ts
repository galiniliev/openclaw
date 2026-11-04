import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { placementTurnOwner } from "./placement-record.js";
import { failHandedOffTurn } from "./worker-turn-failure.js";
import {
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  placements,
  seedActivePlacement,
  setupWorkerTurnLauncherTest,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";

afterAll(closeStateDatabaseForTest);

describe("retained worker turn failure recovery", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));

  it.each(["worker-turn", "remote-exec"] as const)(
    "preserves retained native state after an opaque %s transport failure",
    async (executionMode) => {
      await seedActivePlacement(executionMode);
      const active = placements.get(SESSION_ID);
      if (active?.state !== "active") {
        throw new Error("expected active retained placement");
      }
      const turnClaim = await placements.claimTurn({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        claimId: "retained-transport-claim",
        runId: "retained-transport-run",
        owner: placementTurnOwner(active),
      });
      const destroy = vi.fn(async () => attachedEnvironment());
      const stopTunnel = vi.fn(async () => {});
      const environment = {
        ...attachedEnvironment(),
        retention: {
          policy: { mode: "session-disk" as const, computeWindowSeconds: 14_400 },
          owner: { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main" },
          ownerBinding: "a".repeat(64),
          desiredState: "running" as const,
          receipt: {
            schema: "crabbox.session-disk.v1" as const,
            mode: "session-disk" as const,
            ownerBinding: "a".repeat(64),
            identity: {
              leaseId: "cbx_0123456789ab",
              attemptLeaseId: "cbx_0123456789ab",
              slug: "retained",
              resourceId: "original-resource",
            },
            claimRevision: "revision-stopped",
            computeWindowSeconds: 14_400,
            desiredState: "running" as const,
            computeWindow: {
              id: "cbx_0123456789ab",
              authorizedAt: new Date(Date.now() - 1_000).toISOString(),
              expiresAt: new Date(Date.now() + 14_399_000).toISOString(),
              state: "active" as const,
            },
            policyVerified: true,
            observedState: "Stopped",
            stopPending: false,
          },
          operation: null,
        },
      };

      await failHandedOffTurn({
        environments: { ...unusedEnvironments(), get: () => environment, destroy, stopTunnel },
        placements,
        placement: active,
        turnClaim,
        error: new Error(
          "Codex app-server closed: synthetic exit1; node invoke produced no progress",
        ),
      });

      expect(destroy).not.toHaveBeenCalled();
      expect(stopTunnel).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({
        state: "active",
        generation: active.generation,
        environmentId: active.environmentId,
        activeOwnerEpoch: active.activeOwnerEpoch,
      });
      expect(await placements.listPendingWorkspaceResultsAsync()).toMatchObject([
        {
          sessionId: SESSION_ID,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          claimId: turnClaim.claimId,
          runId: turnClaim.runId,
          recoveryRequestedAtMs: expect.any(Number),
        },
      ]);
    },
  );
});
