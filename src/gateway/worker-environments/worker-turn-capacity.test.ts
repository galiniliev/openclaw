import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { transitionMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import { commitMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import * as recoveryStore from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { createMainSessionRecoveryStoreFixture } from "../../agents/main-session-recovery/main-session-recovery-store.test-support.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { isAgentRunWaitingForCapacity } from "../../infra/agent-run-capacity-wait.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import * as backoff from "../../infra/backoff.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { bindDeviceWorkerAvailability, type DeviceWorkerAvailability } from "./device-provider.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import { waitForRecoveryWorkerCapacity } from "./worker-turn-capacity.js";

describe("recovery physical node capacity", () => {
  const fixture = createMainSessionRecoveryStoreFixture();
  const runId = "capacity-recovery";
  const sessionId = "capacity-session";
  const sessionKey = "agent:main:capacity";
  let storePath: string;
  let releaseContext: () => void;
  const node: NodeWorkerSupervisorNodeProof = {
    nodeId: "node-capacity",
    connId: "connection-capacity",
    pairingIdentity: "identity-capacity",
    pairingGeneration: "pairing-capacity",
    clientId: "node-host",
    clientMode: "node",
    protocolFeature: "node-worker-supervisor-v6",
    workerHost: { enabled: true, capacity: { total: 1, available: 0 } },
    commands: [],
  };
  const claim: WorkerSessionTurnClaim = {
    sessionId,
    runId,
    claimId: "exact-claim",
    placementGeneration: 4,
    owner: { kind: "worker", environmentId: "exact-environment", ownerEpoch: 3 },
  };
  const refusal = {
    launchId: "rejected-launch",
    planHash: "a".repeat(64),
    environmentId: "exact-environment",
    sessionId,
    ownerEpoch: 3,
    placementGeneration: 4,
    runId,
    nodeDeviceId: node.nodeId,
    connId: node.connId,
    pairingGeneration: node.pairingGeneration,
  };
  beforeEach(async () => {
    storePath = fixture.fixtureStore();
    const generation = getAgentEventLifecycleGeneration();
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId,
        updatedAt: 100,
        status: "running",
        lifecycleRunId: runId,
        mainRestartRecovery: { cycleId: "cycle-capacity", revision: 1, chargedAttempts: 2 },
        restartRecoveryRuns: [{ runId, lifecycleGeneration: generation }],
      },
    );
    const context = claimAgentRunContext(
      runId,
      {
        sessionId,
        sessionKey,
        lifecycleGeneration: generation,
        projectSessionActive: true,
      },
      { trackOwner: true, ownsContext: true, protectFromSweep: true },
    );
    releaseContext = () => releaseAgentRunContext(runId, context);
  });
  afterEach(async () => {
    releaseContext();
    vi.restoreAllMocks();
    await fixture.resetCase();
  });

  async function start(
    availability: () => Promise<DeviceWorkerAvailability>,
    assertCurrent = () => {},
    signal?: AbortSignal,
  ) {
    const environments = {};
    bindDeviceWorkerAvailability(environments, availability);
    // Only the capacity owner's required turn facts are consumed here.
    const turn = {
      sessionTarget: { agentId: "main", sessionId, sessionKey, storePath },
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      abortSignal: signal,
    };
    const intent = await waitForRecoveryWorkerCapacity({
      environments,
      placements: {
        prepareTurnClaimAuthority: async () => ({
          claim,
          identity: { agentId: "main", sessionKey },
          isCurrent: () => true,
          onRevoked: () => () => {},
          release: () => {},
        }),
      },
      refusal,
      claim,
      turn,
      assertCurrent,
    });
    if (intent) {
      await intent.release();
    }
    return Boolean(intent);
  }

  it("keeps one durable visible claim across long waits and continues once after capacity returns", async () => {
    const sleeping = createDeferred();
    const release = createDeferred();
    vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async (ms) => {
      expect(ms).toBe(5_000);
      sleeping.resolve();
      await release.promise;
    });
    let available = 0;
    const operation = start(async () => ({
      available: true,
      node: { ...node, workerHost: { ...node.workerHost, capacity: { total: 1, available } } },
    }));
    await sleeping.promise;
    const waiting = loadSessionEntry({ sessionKey, storePath })!;
    expect(waiting.mainRestartRecovery).toMatchObject({
      chargedAttempts: 2,
      capacityWait: {
        runId,
        worker: { claimId: claim.claimId, ownerEpoch: 3, placementGeneration: 4 },
      },
    });
    expect(waiting.mainRestartRecovery?.tombstone).toBeUndefined();
    expect(isAgentRunWaitingForCapacity(runId)).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 7 * 24 * 60 * 60_000);
    available = 1;
    release.resolve();
    await operation;
    expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery).toMatchObject({
      chargedAttempts: 2,
    });
    expect(
      loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.capacityWait,
    ).toBeUndefined();
    expect(isAgentRunWaitingForCapacity(runId)).toBe(false);
  });

  it.each([
    "pause",
    "manual",
    "archive",
    "revision",
    "cancel",
    "actor",
    "claim",
    "connection",
  ] as const)("rejects late capacity after %s changes", async (change) => {
    const sleeping = createDeferred();
    const release = createDeferred();
    vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
      sleeping.resolve();
      await release.promise;
    });
    let changed = false;
    const controller = new AbortController();
    const operation = start(
      async () => ({
        available: true,
        node: changed
          ? {
              ...node,
              connId: change === "connection" ? "replacement" : node.connId,
              workerHost: { ...node.workerHost, capacity: { total: 1, available: 1 } },
            }
          : node,
      }),
      () => {
        if (changed && (change === "actor" || change === "claim")) {
          throw new Error(`${change} authority closed`);
        }
      },
      controller.signal,
    );
    const outcome = operation.catch((error: unknown) => error);
    await sleeping.promise;
    if (change === "pause") {
      const current = loadSessionEntry({ sessionKey, storePath })!;
      current.mainRestartRecovery!.pause = {
        reason: "unverifiable-external-effect",
        pausedAtMs: 200,
      };
      await replaceSessionEntry({ sessionKey, storePath }, current);
    }
    if (change === "manual" || change === "archive" || change === "revision") {
      const current = loadSessionEntry({ sessionKey, storePath })!;
      if (change === "archive") {
        current.archivedAt = 200;
      } else if (change === "revision") {
        current.lifecycleRevision = "replacement-lifecycle";
      } else {
        current.goal = {
          schemaVersion: 1,
          id: "goal-manual",
          objective: "Hold this session",
          status: "paused",
          createdAt: 100,
          updatedAt: 200,
          tokenStart: 0,
          tokensUsed: 0,
          continuationTurns: 0,
        };
        current.goalPauseOrigin = "manual";
      }
      await replaceSessionEntry({ sessionKey, storePath }, current);
    }
    if (change === "cancel") {
      controller.abort(new Error("cancelled"));
    }
    changed = true;
    release.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.chargedAttempts).toBe(
      2,
    );
  });

  it("refuses a pause arriving at the final wait-clear write before returning to execution", async () => {
    vi.spyOn(backoff, "sleepWithAbort").mockResolvedValue(undefined);
    let reads = 0;
    const commit = recoveryStore.commitMainSessionRecovery;
    vi.spyOn(recoveryStore, "commitMainSessionRecovery").mockImplementation(async (params) => {
      if (
        params.command.kind === "finish_worker_capacity" ||
        params.command.kind === "cancel_capacity_wait"
      ) {
        const current = loadSessionEntry({ sessionKey, storePath })!;
        current.mainRestartRecovery!.pause = {
          reason: "unverifiable-external-effect",
          pausedAtMs: 200,
        };
        await replaceSessionEntry({ sessionKey, storePath }, current);
      }
      return await commit(params);
    });
    await expect(
      start(async () => ({
        available: true,
        node:
          ++reads === 1
            ? node
            : {
                ...node,
                workerHost: { ...node.workerHost, capacity: { total: 1, available: 1 } },
              },
      })),
    ).rejects.toThrow("recovery intent changed");
    expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.pause).toBeDefined();
  });

  it("does not classify unknown availability as capacity or reserve a new operation", async () => {
    const sleep = vi.spyOn(backoff, "sleepWithAbort");
    await expect(
      start(async () => ({ available: false, unavailableReason: "disconnected" })),
    ).rejects.toThrow("runner is offline");
    expect(sleep).not.toHaveBeenCalled();
    expect(
      loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.capacityWait,
    ).toBeUndefined();
  });

  it("refunds only the exact never-started wait during restart marking", async () => {
    const current = loadSessionEntry({ sessionKey, storePath })!;
    current.mainRestartRecovery!.acknowledgedPause = {
      reason: "unverifiable-external-effect",
      pausedAtMs: 90,
    };
    await replaceSessionEntry({ sessionKey, storePath }, current);
    const sleeping = createDeferred();
    const release = createDeferred();
    vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
      sleeping.resolve();
      await release.promise;
    });
    let closed = false;
    const operation = start(
      async () => ({ available: true, node }),
      () => {
        if (closed) {
          throw new Error("retired");
        }
      },
    ).catch((error: unknown) => error);
    await sleeping.promise;
    await commitMainSessionRecovery({
      target: { sessionKey, storePath },
      command: {
        kind: "mark_interrupted",
        cycleId: "unused",
        now: 500,
        resetRuntime: true,
      },
    });
    expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery).toMatchObject({
      cycleId: "cycle-capacity",
      chargedAttempts: 1,
    });
    await commitMainSessionRecovery({
      target: { sessionKey, storePath },
      command: {
        kind: "mark_interrupted",
        cycleId: "unused",
        now: 600,
        resetRuntime: true,
      },
    });
    expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.chargedAttempts).toBe(
      1,
    );
    closed = true;
    release.resolve();
    expect(await operation).toBeInstanceOf(Error);
  });

  it("reopens the durable physical wait from the accepted snapshot without charging it", async () => {
    const sleeping = createDeferred();
    const release = createDeferred();
    vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
      sleeping.resolve();
      await release.promise;
    });
    let retired = false;
    const operation = start(
      async () => ({ available: true, node }),
      () => {
        if (retired) {
          throw new Error("retired");
        }
      },
    ).catch((error: unknown) => error);
    await sleeping.promise;
    const snapshot = loadSessionEntry({ sessionKey, storePath })!;
    retired = true;
    release.resolve();
    expect(await operation).toBeInstanceOf(Error);
    releaseContext();
    // Restored state contains the final accepted pre-execution wait, not the old process cleanup.
    await replaceSessionEntry({ sessionKey, storePath }, snapshot);
    await cleanupSessionStateForTest({ stateDir: path.dirname(storePath) });
    const reopened = loadSessionEntry({ sessionKey, storePath })!;
    expect(reopened.mainRestartRecovery?.capacityWait).toEqual(
      snapshot.mainRestartRecovery?.capacityWait,
    );
    expect(reopened.mainRestartRecovery?.chargedAttempts).toBe(2);
    await commitMainSessionRecovery({
      target: { sessionKey, storePath },
      command: {
        kind: "mark_interrupted",
        cycleId: "unused",
        now: Date.now(),
        resetRuntime: true,
      },
    });
    expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery?.chargedAttempts).toBe(
      1,
    );
  });

  it.each(["started", "different-run", "different-attempt"] as const)(
    "never refunds a %s capacity marker",
    (change) => {
      const entry: InternalSessionEntry = {
        sessionId,
        status: "running",
        updatedAt: 100,
        lifecycleRunId: change === "different-run" ? "another-run" : runId,
        mainRestartRecovery: {
          cycleId: "cycle-capacity",
          revision: 1,
          chargedAttempts: 2,
          ...(change === "started" ? { startedAttempt: 2 } : {}),
          capacityWait: {
            runId,
            lifecycleGeneration: "old-generation",
            sinceMs: 100,
            worker: {
              environmentId: "exact-environment",
              ownerEpoch: 3,
              placementGeneration: 4,
              claimId: claim.claimId,
              nodeDeviceId: node.nodeId,
              connId: node.connId,
              pairingGeneration: node.pairingGeneration,
              launchId: refusal.launchId,
              planHash: refusal.planHash,
              attempt: change === "different-attempt" ? 1 : 2,
            },
          },
        },
      };
      transitionMainSessionRecovery(entry, {
        kind: "mark_interrupted",
        cycleId: "unused",
        now: 200,
      });
      expect(entry.mainRestartRecovery?.chargedAttempts).toBe(2);
    },
  );
});
