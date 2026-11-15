import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { getRuntimeConfig } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { claimAgentRunContext, clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import {
  createWorkerWorkspaceRecoveryPreparer,
  loadWorkerPlacementSessionRuntimeModule,
} from "../server-worker-placement-session-target.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { createWorkerInferenceStore } from "./inference-store.js";
import { createWorkerInferenceManager } from "./inference.js";
import { createWorkerLiveEventReceiver } from "./live-events.js";
import { openDiskCleanupTransport } from "./placement-disk-cleanup.test-support.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { placementTurnOwner, type WorkerSessionTurnClaim } from "./placement-record.js";
import { writePlacementEnvironmentFixture } from "./placement-test-fixtures.js";
import { getWorkerTurnExecutionIdentityCapability } from "./placement-turn-claim-events.js";
import { openRepositoryCaptureTransport } from "./repository-workspace-snapshot.test-support.js";
import { createWorkerTranscriptCommitStore } from "./transcript-commit-ledger.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";
import {
  WorkerTunnelOwnerDisconnectedError,
  type WorkerTurnTunnelHandle,
} from "./tunnel-contract.js";
import {
  createWorkerSessionTurnPlacementProvider,
  database,
  ENVIRONMENT_ID,
  measureLaunchTurn,
  readLaunchToolNames,
  placements,
  SESSION_ID,
  sessionTarget,
  turn,
  workerTurnRequest,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerTurnRpc } from "./worker-turn-rpc.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";
import { useRepositoryWorkspaceResultFixture } from "./workspace-result-repository.test-support.js";

// mock-isolation: Local Git origin and provider/node/bundle fixtures; no cloud or model.
vi.mock("./repository-github-identity.js", () => ({
  prepareRepositoryGitHubIdentity: async (_agentId: string, assertCurrent: () => void) => ({
    token: undefined,
    assertSelected: assertCurrent,
    start: async (start: () => Promise<unknown>) => await start(),
  }),
}));
useRepositoryWorkspaceResultFixture();
let wire: Awaited<ReturnType<typeof openDiskCleanupTransport>>;
beforeAll(async () => {
  wire = await openDiskCleanupTransport({
    resolveCurrentPairingState: async () => ({
      identity: "disk-cleanup-pairing",
      generation: "disk-cleanup-generation",
    }),
  });
});
afterAll(async () => wire.close());

it.for(["none", "open-window", "caller", "session", "disk", "pending"] as const)(
  "new turn waits for retained runtime readiness and rechecks %s authority before claiming",
  async (fault, { signal }) => {
    const f = await openRepositoryCaptureTransport(wire, true, "remote-exec");
    const entered = createDeferred();
    const ready = createDeferred();
    const abort = new AbortController();
    const unblock = () => {
      ready.resolve();
      abort.abort(signal.reason);
    };
    signal.addEventListener("abort", unblock, { once: true });
    const input = { ...turn("retained-new-turn"), abortSignal: abort.signal };
    let pending: Promise<unknown> | undefined;
    try {
      await fs.writeFile(path.join(f.remote, "disk.txt"), "retained bytes\n");
      if (fault !== "open-window") {
        await f.pause();
      } else {
        expect(f.original.retention?.runtimeReady).toBe(true);
        expect(f.original.retention?.observation?.computeExpiresAtMs).toBeGreaterThan(Date.now());
      }
      f.events.length = 0;
      wire.commands.length = 0;
      f.preparation.build = { ...f.preparation.build, bundleHash: "c".repeat(64) };
      f.preparation.beforeBundle = async () => {
        entered.resolve();
        await ready.promise;
      };
      const originalPlacement = placements.get(SESSION_ID);
      assert(originalPlacement?.state === "active");
      const prior =
        fault === "none"
          ? await placements.claimTurn({
              ...sessionTarget,
              claimId: "prior-disk-result",
              runId: "prior-disk-result",
              owner: placementTurnOwner(originalPlacement),
            })
          : undefined;
      if (prior) {
        await placements.markWorkspaceResultPending(prior);
      }
      const waiting = createDeferred();
      const waitForClaim = placements.waitForTurnClaimRelease.bind(placements);
      vi.spyOn(placements, "waitForTurnClaimRelease").mockImplementation(async (...args) => {
        waiting.resolve();
        return await waitForClaim(...args);
      });
      const wake = vi.spyOn(f.environments, "ensureRetainedRunning");
      const claim = vi.spyOn(placements, "claimTurn");
      const runLocal = vi.fn(async () => {
        expect(f.environments.get(ENVIRONMENT_ID)?.retention?.runtimeReady).toBe(true);
        const tunnel = await f.environments.startTunnel({
          environmentId: ENVIRONMENT_ID,
          ownerEpoch: f.original.ownerEpoch,
        });
        const result = await tunnel.runWorkspaceCommand({
          argv: ["cat", path.join(f.remote, "disk.txt")],
          transportRetry: "never",
          assertCurrent: () => input.abortSignal.throwIfAborted(),
        });
        expect(result.stdout).toBe("retained bytes\n");
        return { meta: { durationMs: 1 } };
      });
      const provider = createWorkerSessionTurnPlacementProvider({
        placements,
        environments: f.environments,
        resolveWorkspace: async () => ({ kind: "repository", repository: f.repository }),
      });
      pending = provider.executeTurn(workerTurnRequest(input.runId), input, runLocal);
      void pending.catch(() => {});
      if (prior) {
        await withinTest(
          awaitGateBeforeSettlement(
            waiting.promise,
            pending,
            "turn skipped pending-result settlement",
          ),
          signal,
        );
        expect(wake).not.toHaveBeenCalled();
        await placements.acceptWorkspaceResult(prior);
        await placements.completeWorkspaceResultAndReleaseTurn(prior);
      }
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, pending, "turn refused before retained wake"),
        signal,
      );
      expect(claim).not.toHaveBeenCalled();
      expect(runLocal).not.toHaveBeenCalled();
      expect(f.events.some((event) => /workspace-command|quiescence|upload/.test(event))).toBe(
        false,
      );
      if (fault === "caller") {
        abort.abort(new Error("turn caller revoked"));
      } else if (fault === "session") {
        const archivedAt = Date.now();
        const archived = await upsertSessionEntryCore(sessionTarget, { archivedAt });
        expect(archived?.archivedAt).toBe(archivedAt);
      } else if (fault === "disk") {
        const current = f.records.get(ENVIRONMENT_ID)!;
        writePlacementEnvironmentFixture(database, {
          ...current,
          resourceReceipt: { ...current.resourceReceipt!, identity: { diskId: "replacement" } },
        });
      } else if (fault === "pending") {
        const placement = placements.get(SESSION_ID);
        assert(placement?.state === "active");
        const competing = await placements.claimTurn({
          ...sessionTarget,
          claimId: "competing-result",
          runId: "competing-result",
          owner: placementTurnOwner(placement),
        });
        await placements.markWorkspaceResultPending(competing);
      }
      ready.resolve();
      if (fault === "none" || fault === "open-window") {
        await expect(withinTest(pending, signal)).resolves.toMatchObject({
          meta: { durationMs: 1 },
        });
        expect(runLocal).toHaveBeenCalledOnce();
        expect(claim).toHaveBeenCalledOnce();
        expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect(placements.get(SESSION_ID)).toMatchObject({
          state: "active",
          turnClaim: null,
          workerBundleHash: f.preparation.build.bundleHash,
        });
        expect(await f.store.get(f.repository.workspaceId)).toEqual(f.repository);
        expect(f.events.some((event) => event.includes("upload"))).toBe(false);
      } else {
        await expect(withinTest(pending, signal)).rejects.toThrow(/revoked|changed|current|owner/);
        expect(runLocal).not.toHaveBeenCalled();
        expect(claim).toHaveBeenCalledTimes(fault === "pending" ? 1 : 0);
        expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(
          fault === "pending" ? 1 : 0,
        );
      }
      expect(wake).toHaveBeenCalledOnce();
      if (fault === "open-window") {
        expect(f.provider.setRetainedState).not.toHaveBeenCalled();
        expect(f.environments.get(ENVIRONMENT_ID)?.retention?.observation).toEqual(
          f.original.retention?.observation,
        );
      }
      expect(wire.errors).toEqual([]);
    } finally {
      unblock();
      signal.removeEventListener("abort", unblock);
      await pending?.catch(() => {});
      input.preparedRunAdmission.close();
      await f.close();
    }
  },
);

it.for([
  "completed",
  "cancelled process",
  "aborted caller",
  "unknown process",
  "foreign claim",
  "changed disk",
] as const)(
  "keeps retained repository custody through %s and the next admitted turn",
  async (outcome, { signal }) => {
    const f = await openRepositoryCaptureTransport(wire, true, "worker-turn");
    await fs.writeFile(path.join(f.remote, "private.txt"), "preserved private work\n");
    await requireWorkspaceResultGit(f.remote, ["add", "private.txt"]);
    await requireWorkspaceResultGit(f.remote, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "private retained work",
    ]);
    const privateHead = await requireWorkspaceResultGit(f.remote, ["rev-parse", "HEAD"]);
    const stopEntered = createDeferred();
    const releaseStop = createDeferred();
    if (outcome === "unknown process") {
      wire.bind({
        workspace: f.workspace,
        events: f.events,
        beforeStop: async () => {
          stopEntered.resolve();
          await releaseStop.promise;
        },
      });
    }
    const destroy = vi.spyOn(f.environments, "destroy");
    const inference = createWorkerInferenceManager({
      store: createWorkerInferenceStore({ path: database.path }),
      execute: async () => {
        throw new Error("Unexpected model request");
      },
    });
    const abort = new AbortController();
    const preparedInput = turn("retained-transcript-first");
    const input =
      outcome === "aborted caller"
        ? { ...preparedInput, abortSignal: abort.signal }
        : preparedInput;
    const transcript = createWorkerTranscriptCommitter({
      getConfig: () => input.config,
      store: createWorkerTranscriptCommitStore({ database }),
    });
    const liveEvents = createWorkerLiveEventReceiver();
    const rpc = createWorkerTurnRpc({
      store: f.records,
      placementStore: f.placementGate,
      prepareInstallation: async () => ({
        ...f.preparation.build,
        install: "bundle",
        tarballBytes: 1,
        tarballSha256: "b".repeat(64),
        tarballPath: "unused-fixture-bundle",
      }),
      applyTranscriptCommit: transcript.commit,
      liveEvents,
      inference,
      isStopping: () => false,
      now: Date.now,
      withLock: async (_environmentId, run) => await run(),
    });
    let commits = 0;
    let foreignClaim: WorkerSessionTurnClaim | undefined;
    let previousIdentity: WorkerConnectionIdentity | undefined;
    const launchTurn: WorkerTurnTunnelHandle["launchTurn"] = async (request) => {
      request.onDispatchReady?.();
      const admitted = await rpc.admitWorker({
        ...request.plan.admission,
        runId: request.plan.assignment.runId,
      });
      assert(admitted.ok, "Worker connection must retain the actual launcher-owned claim");
      const liveSeq = request.plan.assignment.liveEvents.nextSeq;
      if (previousIdentity) {
        expect(
          liveEvents.rotateCredential({
            environmentId: admitted.identity.environmentId,
            sessionId: SESSION_ID,
            runEpoch: admitted.identity.ownerEpoch,
            previousCredentialHash: previousIdentity.credentialHash,
            credentialHash: admitted.identity.credentialHash,
            newProcessTurn: true,
            ackedSeq: liveSeq - 1,
          }),
        ).toBe(true);
      }
      previousIdentity = admitted.identity;
      await expect(
        rpc.pushLiveEvent(admitted.identity, {
          runId: request.plan.assignment.runId,
          runEpoch: f.original.ownerEpoch,
          seq: liveSeq,
          lastAckedSeq: liveSeq - 1,
          event: { kind: "lifecycle", payload: { phase: "start", startedAt: Date.now() } },
        }),
      ).resolves.toEqual({ ok: true, result: { ackedSeq: liveSeq } });
      const seq = request.plan.assignment.transcript.nextSeq;
      const first = await rpc.commitTranscript(admitted.identity, {
        runEpoch: f.original.ownerEpoch,
        seq,
        baseLeafId: request.plan.assignment.transcript.baseLeafId,
        messages: [
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "Retained checkpoint." }],
            timestamp: Date.now(),
          }),
        ],
      });
      assert(first.ok, "First transcript must commit through its actual receipt authority");
      commits++;
      const receipt = getWorkerTurnExecutionIdentityCapability(placements, request.turnClaim);
      assert(receipt, "Successful ACK must preserve the same claim incarnation");
      expect(() => receipt.receiptAuthority()).not.toThrow();
      const committed = await rpc.commitTranscript(admitted.identity, {
        runEpoch: f.original.ownerEpoch,
        seq: seq + 1,
        baseLeafId: first.result.newLeafId,
        messages: [
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "Retained work completed." }],
            timestamp: Date.now(),
          }),
        ],
      });
      assert(committed.ok, "First transcript must commit through its actual receipt authority");
      commits++;
      if (outcome !== "completed" && request.plan.assignment.runId === input.runId) {
        if (outcome === "foreign claim") {
          await placements.releaseTurnIfOwned(request.turnClaim);
          foreignClaim = await placements.claimTurn({
            ...sessionTarget,
            claimId: "successor-claim",
            runId: "successor-run",
            owner: request.turnClaim.owner,
          });
        } else if (outcome === "changed disk") {
          const current = f.records.get(ENVIRONMENT_ID);
          assert(current?.resourceReceipt);
          writePlacementEnvironmentFixture(database, {
            ...current,
            resourceReceipt: {
              ...current.resourceReceipt,
              identity: { diskId: "replacement-disk" },
            },
          });
        } else if (outcome === "unknown process") {
          throw new WorkerTunnelOwnerDisconnectedError("Worker process outcome is unconfirmed");
        } else if (outcome === "aborted caller") {
          abort.abort(new Error("synthetic caller cancelled"));
        }
        return createCommandResult({
          code: 1,
          stderr: "node worker failed with exit code 1: worker turn cancelled",
        });
      }
      await expect(
        rpc.pushLiveEvent(admitted.identity, {
          runId: request.plan.assignment.runId,
          runEpoch: f.original.ownerEpoch,
          seq: liveSeq + 1,
          lastAckedSeq: liveSeq,
          event: { kind: "lifecycle", payload: { phase: "finishing", endedAt: Date.now() } },
        }),
      ).resolves.toEqual({ ok: true, result: { ackedSeq: liveSeq + 1 } });
      return createCommandResult({
        stdout: JSON.stringify({
          status: "completed",
          transcriptLeafId: committed.result.newLeafId,
          transcriptNextSeq: seq + 2,
        }),
      });
    };
    const resolveWorkspace = async () => {
      const repository = await f.store.get(f.repository.workspaceId);
      assert(repository);
      return { kind: "repository" as const, repository };
    };
    const recovery = await createHarness(database, placements, {
      environmentService: f.environments,
      resolveWorkspace,
      withPreparedRecovery: createWorkerWorkspaceRecoveryPreparer({
        loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
        getConfig: getRuntimeConfig,
      }),
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      placements,
      environments: {
        ...f.environments,
        createGatewayTools: async ({ prepareTools }) => prepareTools?.([]) ?? [],
        startTunnel: async (request) => ({
          ...(await f.environments.startTunnel(request)),
          readLaunchToolNames,
          measureLaunchTurn,
          launchTurn,
        }),
      },
      resolveWorkspace,
      reconcileActivePlacement: async (id) => recovery.service.reconcileActive(id),
    });
    try {
      await inference.ready();
      for (const runId of ["retained-transcript-first", "retained-transcript-next"]) {
        const selected = runId === input.runId ? input : turn(runId);
        const generation = getAgentEventLifecycleGeneration();
        claimAgentRunContext(runId, { ...sessionTarget, lifecycleGeneration: generation });
        try {
          const execution = provider.executeTurn(workerTurnRequest(runId), selected, async () => {
            throw new Error("Retained OpenClaw must execute on its original worker");
          });
          if (outcome !== "completed" && runId === input.runId) {
            const failed = execution.catch((error: unknown) => error);
            if (outcome === "unknown process") {
              await withinTest(
                awaitGateBeforeSettlement(
                  stopEntered.promise,
                  failed,
                  "Unconfirmed retained worker was released before stop acknowledgement",
                ),
                signal,
              );
              expect(placements.get(SESSION_ID)?.turnClaim?.runId).toBe(runId);
              expect(await placements.listPendingWorkspaceResultsAsync()).toMatchObject([
                { runId, workspaceAcceptedAtMs: null },
              ]);
              assert(previousIdentity?.turnClaim);
              expect(f.placementGate.validateWorkerTurn(previousIdentity.turnClaim)).toBe(false);
              releaseStop.resolve();
            }
            await expect(failed).resolves.toBeInstanceOf(Error);
            if (outcome === "cancelled process") {
              expect(String(await failed)).toContain("worker turn cancelled");
            }
          } else {
            await expect(execution).resolves.toMatchObject({
              payloads: [{ text: "Retained work completed." }],
            });
          }
          await waitForSessionRunEnd(SESSION_ID, null);
        } finally {
          clearAgentRunContext(runId, generation);
          selected.preparedRunAdmission.close();
        }
        expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect(await fs.readFile(path.join(f.remote, "private.txt"), "utf8")).toBe(
          "preserved private work\n",
        );
        expect(await requireWorkspaceResultGit(f.remote, ["rev-parse", "HEAD"])).toBe(privateHead);
        expect(destroy).not.toHaveBeenCalled();
        if (outcome === "foreign claim" || outcome === "changed disk") {
          expect(placements.get(SESSION_ID)?.turnClaim?.claimId).toBe(
            foreignClaim?.claimId ?? previousIdentity?.turnClaim?.claimId,
          );
          expect(f.events).toEqual([]);
          break;
        }
        expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
        expect(f.environments.get(ENVIRONMENT_ID)).toMatchObject({
          leaseId: f.original.leaseId,
          ownerEpoch: f.original.ownerEpoch,
          resourceReceipt: f.original.resourceReceipt,
          nodeDeviceId: f.original.nodeDeviceId,
        });
        expect(await f.store.get(f.repository.workspaceId)).toEqual(f.repository);
      }
      expect(commits).toBe(outcome === "foreign claim" || outcome === "changed disk" ? 2 : 4);
      expect(wire.errors).toEqual([]);
    } finally {
      releaseStop.resolve();
      input.preparedRunAdmission.close();
      liveEvents.clear();
      await inference.stop();
      await f.close();
    }
  },
);
