import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createPlacementFailureActions } from "./placement-dispatch-failure.js";
import { recoverPendingWorkspaceResults } from "./placement-dispatch-pending-results.js";
import type { PlacementRecoveryDeps } from "./placement-recovery-contract.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { prepareRetainedWorkspace } from "./retained-workspace.js";
import { sessionTarget } from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceRecoveryFixture } from "./workspace-recovery.test-support.js";
import { useRepositoryWorkspaceResultFixture } from "./workspace-result-repository.test-support.js";

// mock-isolation: Synthetic local origin needs no GitHub identity or credentials.
vi.mock("./repository-github-identity.js", () => ({
  prepareRepositoryGitHubIdentity: async (_agentId: string, assertCurrent: () => void) => ({
    assertSelected: assertCurrent,
    start: async (start: () => Promise<unknown>) => start(),
  }),
}));

describe("retained disk workspace result", () => {
  const { fixture } = useRepositoryWorkspaceResultFixture();

  it("keeps edits, Git state and build outputs on the same disk across two settled turns without a Gateway mirror", async () => {
    const f = await fixture("worker-turn", false, false, true);
    expect(f.initialCheckpointRef).toBeNull();
    const capture = vi.spyOn(f.tunnel, "reconcileWorkspace");
    const quiesce = vi.spyOn(f.tunnel, "quiesceWorkspace");
    const before = await f.store.get(f.repository.workspaceId);
    await f.write("private.txt", "uncommitted work\n");
    await f.write(".gitignore", "node_modules/\ndist/\n");
    await fs.mkdir(path.join(f.remote, "dist"));
    await fs.writeFile(path.join(f.remote, "dist", "build.txt"), "keep build outputs");
    await fs.mkdir(path.join(f.remote, "node_modules"));
    await fs.writeFile(path.join(f.remote, "node_modules", "installed.txt"), "keep dependencies");
    await requireGit(f.remote, ["add", "private.txt"]);
    const gitBefore = await requireGit(f.remote, ["status", "--porcelain=v1"]);
    for (const id of ["first-turn", "second-turn"]) {
      const turn = await f.beginTurn(id);
      expect(f.placements.preparedWorkspaceResult(turn.turnClaim)?.diskAuthority).toMatchObject({
        identity: { resourceId: "synthetic-session-disk" },
        workspaceDir: f.remote,
      });
      await f.finishTurn(turn);
      await f.expectSettled();
    }
    expect(capture).not.toHaveBeenCalled();
    expect(quiesce).not.toHaveBeenCalled();
    expect(await f.store.get(f.repository.workspaceId)).toEqual(before);
    expect(await fs.readFile(path.join(f.remote, "private.txt"), "utf8")).toBe(
      "uncommitted work\n",
    );
    expect(await fs.readFile(path.join(f.remote, "node_modules", "installed.txt"), "utf8")).toBe(
      "keep dependencies",
    );
    expect(await fs.readFile(path.join(f.remote, "dist", "build.txt"), "utf8")).toBe(
      "keep build outputs",
    );
    expect(await requireGit(f.remote, ["status", "--porcelain=v1"])).toBe(gitBefore);
  });

  it("keeps an already pending mirror result in its original mode after disk admission", async () => {
    const f = await fixture("worker-turn");
    const owned = await f.beginTurn("old-mirror-result");
    f.retainDisk();
    await prepareRetainedWorkspace({
      workspace: await f.resolveWorkspace(),
      placement: owned.placement,
      getEnvironment: () => f.environment,
      assertCurrent: () => {
        if (!f.placements.validateTurnClaim(owned.turnClaim)) {
          throw new Error("stale fixture claim");
        }
      },
    });
    expect((await f.store.get(f.repository.workspaceId))?.diskAuthority).toBeDefined();
    expect(
      (await f.placements.listPendingWorkspaceResultsAsync())[0]?.diskAuthority,
    ).toBeUndefined();
    const capture = vi.spyOn(f.tunnel, "reconcileWorkspace");
    await f.write("old-result.txt", "must still cross the mirror boundary");
    await f.finishTurn(owned);
    expect(capture).toHaveBeenCalledOnce();
    await f.expectSettled();
  });

  it("captures a fresh immutable checkpoint only for explicit publication", async () => {
    const f = await fixture("worker-turn", false, false, true);
    await f.write("publish.txt", "requested publication bytes");
    f.environment.retention!.desiredState = "suspended";
    f.environment.retention!.receipt!.observedState = "stopped";
    f.environment.retention!.receipt!.computeWindow.state = "closed";
    const capture = vi.spyOn(f.tunnel, "reconcileWorkspace");
    await f.mutations.captureCheckpoint(sessionTarget, () => {});
    expect(f.environments.inspectTurnLease).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
    const recorded = await f.store.get(f.repository.workspaceId);
    expect(recorded?.checkpointRef).toMatch(/^refs\/openclaw\/worker-results\//);
    expect(recorded?.diskAuthority?.identity.resourceId).toBe("synthetic-session-disk");
    await f.finishTurn(await f.beginTurn("after-publication"));
    expect(capture).toHaveBeenCalledOnce();
    await f.expectSettled();
  });

  it.each(["connected", "resumed", "unavailable", "cleanup-unknown", "disk-changed"] as const)(
    "reopens disk-result custody without transfers or replay after native recovery: %s",
    async (scenario) => {
      const f = await fixture("worker-turn", false, false, true);
      f.environment.nodeDeviceId = "retained-recovery-node";
      const owned = await f.beginTurn("interrupted-turn");
      await f.write("survives-restart.txt", "same preserved disk");
      await f.placements.handoffWorkspaceResultRecovery(owned.turnClaim);
      await closeStateDatabaseForTest();
      const restarted = createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase(),
      });
      const gate = createWorkerSessionPlacementGate(restarted);
      let connected = scenario === "connected";
      const stop = vi.fn(async () => {
        if (!connected) {
          throw new Error("device worker node is not currently connected");
        }
        if (scenario === "cleanup-unknown") {
          throw new Error("native process cleanup is unconfirmed");
        }
      });
      const waitForRecoveryNode = vi.fn<NonNullable<PlacementRecoveryDeps["waitForRecoveryNode"]>>(
        async (placement, assertCurrent) => {
          assertCurrent();
          // Exercise the real resumer's placement gate: a live turn cannot be revived.
          const authority = await gate.prepareWorkerRuntimeRefresh({
            sessionId: placement.sessionId,
            environmentId: placement.environmentId,
            ownerEpoch: placement.activeOwnerEpoch,
          });
          try {
            authority.assertCurrent();
            assertCurrent();
            if (scenario === "unavailable") {
              throw new Error("Retained supervisor reconnect is still pending");
            }
            connected = true;
            if (scenario === "disk-changed") {
              f.environment.retention!.ownerBinding = "different-disk-owner";
            }
            assertCurrent();
          } finally {
            authority.release();
          }
        },
      );
      const environments = {
        ...f.environments,
        stopTunnel: stop,
        fenceWorkerTurnForRecovery: gate.fenceWorkerTurnForRecovery,
      };
      const capture = vi.spyOn(f.tunnel, "reconcileWorkspace");
      const quiesce = vi.spyOn(f.tunnel, "quiesceWorkspace");
      await recoverPendingWorkspaceResults(
        {
          placements: restarted,
          environments,
          hasCurrentRunner: () => connected,
          waitForRecoveryNode,
          failure: createPlacementFailureActions({ placements: restarted, environments }),
          workspaceOperations: f.workspaceOperations,
          ...createWorkerWorkspaceRecoveryFixture({ resolveWorkspace: f.resolveWorkspace }),
        },
        await restarted.readProjection([owned.placement.sessionId], { current: true }),
      );
      expect(waitForRecoveryNode).toHaveBeenCalledTimes(scenario === "connected" ? 0 : 1);
      expect(stop).toHaveBeenCalledTimes(
        scenario === "unavailable" || scenario === "disk-changed" ? 0 : 1,
      );
      expect(capture).not.toHaveBeenCalled();
      expect(quiesce).not.toHaveBeenCalled();
      expect(environments.createWithRequest).not.toHaveBeenCalled();
      expect(environments.destroy).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(f.remote, "survives-restart.txt"), "utf8")).toBe(
        "same preserved disk",
      );
      const pending = await restarted.listPendingWorkspaceResultsAsync();
      if (scenario === "connected" || scenario === "resumed") {
        expect(pending).toEqual([]);
        expect(restarted.get(owned.placement.sessionId)).toMatchObject({
          state: "active",
          environmentId: owned.placement.environmentId,
          activeOwnerEpoch: owned.placement.activeOwnerEpoch,
          remoteWorkspaceDir: f.remote,
          turnClaim: null,
        });
      } else {
        expect(pending).toMatchObject([
          { claimId: "interrupted-turn", workspaceAcceptedAtMs: null },
        ]);
        expect(restarted.get(owned.placement.sessionId)?.turnClaim?.claimId).toBe(
          "interrupted-turn",
        );
      }
    },
  );

  it.each(["missing", "wrong-disk", "wrong-owner"] as const)(
    "holds the exact result when the disk is %s",
    async (scenario) => {
      const f = await fixture("worker-turn", false, false, true);
      const turn = await f.beginTurn("held-turn");
      const receipt = f.environment.retention!.receipt!;
      if (scenario === "missing") {
        receipt.observedState = "missing";
      } else if (scenario === "wrong-disk") {
        receipt.identity = { ...receipt.identity, resourceId: "foreign-disk" };
      } else {
        f.environment.retention!.ownerBinding = "foreign-owner";
      }
      const capture = vi.spyOn(f.tunnel, "reconcileWorkspace");
      await expect(f.finishTurn(turn)).rejects.toThrow(/disk.*owner|disk.*missing/);
      expect(capture).not.toHaveBeenCalled();
      expect(await f.placements.listPendingWorkspaceResultsAsync()).toMatchObject([
        { workspaceAcceptedAtMs: null, claimId: "held-turn" },
      ]);
      expect(f.placements.get(turn.placement.sessionId)?.turnClaim?.claimId).toBe("held-turn");
    },
  );

  it("preserves ordinary repository checkpoint settlement", async () => {
    const f = await fixture("worker-turn");
    const capture = vi.spyOn(f.tunnel, "reconcileWorkspace");
    await f.write("ordinary.txt", "mirror this explicit ordinary worker");
    await f.finishTurn(await f.beginTurn("ordinary-turn"));
    await f.expectSettled();
    expect(capture).toHaveBeenCalledOnce();
    expect((await f.store.get(f.repository.workspaceId))?.checkpointRef).not.toBe(
      f.initialCheckpointRef,
    );
  });
});
