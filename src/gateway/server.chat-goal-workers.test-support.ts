import { randomUUID } from "node:crypto";
import { it, expect, vi, type MockInstance, type Mock } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { runEmbeddedAgent as executeEmbeddedAgent } from "../agents/embedded-agent.js";
import { registerAgentHarness, getRegisteredAgentHarness } from "../agents/harness/registry.js";
import * as runtimePlugins from "../agents/runtime-plugins.js";
import { installSessionPlacementAdmissionProvider } from "../agents/session-placement-admission.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import {
  createGoalChatStartRequest,
  readGoalChatUserMessages,
} from "./server.chat-goal.test-support.js";
import { prepareGatewayReplyRuntimeForTest } from "./test-helpers.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { withWorkerTurnTranscriptDatabase } from "./worker-environments/worker-turn-transcript-target.js";

type Scope = { agentId: string; sessionKey: string; sessionId: string; storePath: string };

/** Provider/model transport is simulated; RPC, queue, sharing and SQLite writers are real. */
export function registerWorkerGoalChatCases(
  scope: () => Scope,
  runEmbeddedAgent: MockInstance<typeof executeEmbeddedAgent>,
  rpc: (
    method: "chat.send" | "sessions.goal.update",
    params: Record<string, unknown>,
    onResponse?: RespondFn,
    client?: GatewayClient,
  ) => Promise<Mock<RespondFn>>,
  getContext: () => GatewayRequestContext,
  client: GatewayClient,
) {
  const userMessages = () => readGoalChatUserMessages(scope());
  it.each(["continue", "preparation-failed", "revoked"] as const)(
    "admits native worker Goal input and continuation through current placement (%s)",
    async (mode) => {
      const { sessionKey, sessionId, storePath } = scope();
      const context = getContext();
      const waitForDispatchEnd = async () => {
        await getSessionWorkAdmissionRelease({
          scope: storePath,
          identities: [sessionKey, sessionId],
        });
        expect(context.chatAbortControllers.size).toBe(0);
      };
      registerAgentHarness({
        id: "codex",
        label: "Codex fixture",
        cloudPlacement: { mode: "remote-exec" },
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: async () => {
          throw new Error("provider transport is simulated");
        },
      });
      const registered = getRegisteredAgentHarness("codex")!;
      getTestPluginRegistry().agentHarnesses.push({
        pluginId: "codex",
        source: "fixture",
        harness: registered.harness,
      });
      const loadNative = vi
        .spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle")
        .mockReturnValue(getTestPluginRegistry());
      const baseline = getRuntimeConfig();
      const config: OpenClawConfig = {
        ...baseline,
        plugins: {
          ...baseline.plugins,
          entries: { ...baseline.plugins?.entries, codex: { enabled: true } },
        },
        agents: {
          ...baseline.agents,
          entries: {
            ...baseline.agents?.entries,
            main: { ...baseline.agents?.entries?.main, nativeRuntimeConsent: ["codex"] },
          },
        },
      };
      await prepareGatewayReplyRuntimeForTest({ force: true, config });
      await patchSessionEntryCore(scope(), () => ({
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      }));
      expect(getRegisteredAgentHarness("codex")?.harness.cloudPlacement?.mode).toBe("remote-exec");
      const placements = createWorkerSessionPlacementStore();
      context.workerSessionPlacementService = placements;
      const placement = await placements.startDispatch({
        agentId: "main",
        sessionKey,
        sessionId,
        executionMode: "remote-exec",
      });
      const releasePlacement = installSessionPlacementAdmissionProvider({
        withRequiredSession: async (_identity, task, assertCurrent) => {
          assertCurrent?.();
          return task(() => assertCurrent?.());
        },
        usesWorkerInference: async () => true,
        resolveRuntimeOverride: async () => "codex",
        assertCompactionSuccessorAllowed: () => {
          throw new Error("unexpected compaction successor");
        },
        executeLocalTurn: async (_claim, run) => run(),
        executeTurn: async (_claim, _params, run) => run(),
      });
      const prepared = createDeferred();
      const promote = createDeferred();
      const objective = "Finish a native worker checklist";
      const request = createGoalChatStartRequest(scope(), objective, randomUUID());
      const profile = ensureProfileForEmail("worker-goal@example.test");
      const operator = {
        ...client,
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
        internal: {
          authenticatedControlUi: true,
          authenticatedOperator: true,
          isLocalClient: true,
        },
      } satisfies GatewayClient;
      runEmbeddedAgent.mockImplementation(async (params) => {
        prepared.resolve();
        await promote.promise;
        if (mode === "preparation-failed") {
          throw new Error("Worker setup declined input");
        }
        if (mode === "revoked") {
          operator.invalidated = true;
        }
        const calls = runEmbeddedAgent.mock.calls.length;
        if (calls > 4) {
          throw new Error("Completed Goal continued again");
        }
        const target = { agentId: "main", sessionKey, sessionId: params.sessionId, storePath };
        // The physical worker is simulated; promotion uses the same prepared transcript
        // owner as canonical remote-exec, after setup has accepted this exact placement.
        await withWorkerTurnTranscriptDatabase(
          { ...target, sessionTarget: target },
          {
            assertCurrent: () => params.abortSignal?.throwIfAborted(),
            prepareAuthority: async () => ({ isCurrent: () => true, release: () => {} }),
          },
          async () => {
            await params.userTurnTranscriptRecorder?.persistApproved();
          },
        );
        if (calls === 1 || calls === 4) {
          await patchSessionEntryCore(scope(), (entry) => ({
            goal: entry.goal && { ...entry.goal, status: calls === 1 ? "paused" : "complete" },
          }));
        }
        return {
          payloads: [{ text: "Checkpoint reached." }],
          meta: {
            durationMs: 1,
            stopReason: "end_turn",
            agentMeta: {
              sessionId: params.sessionId,
              provider: "test",
              model: "test",
              agentHarnessId: "codex",
              usage: { input: 2, output: 1 },
              lastCallUsage: { input: calls * 10, output: 1 },
            },
          },
        };
      });
      const starting = rpc("chat.send", request, undefined, operator);
      try {
        await awaitGateBeforeSettlement(
          prepared.promise,
          starting,
          "Worker Goal returned before runtime admission",
        );
        expect(loadSessionEntry(scope())?.goal).toBeUndefined();
        expect(userMessages()).toEqual([]);
        if (mode === "continue") {
          const duplicate = await rpc("chat.send", request, undefined, operator);
          expect(duplicate.mock.calls[0]?.[0]).toBe(false);
          expect(duplicate.mock.calls[0]?.[2]).toMatchObject({
            code: "UNAVAILABLE",
            retryable: true,
          });
          expect(runEmbeddedAgent).toHaveBeenCalledOnce();
        }
        promote.resolve();
        const started = await starting;
        if (mode !== "continue") {
          expect(started.mock.calls[0]?.[0]).toBe(false);
          await waitForDispatchEnd();
          expect(loadSessionEntry(scope())?.goal).toBeUndefined();
          expect(userMessages()).toEqual([]);
          return;
        }
        expect(started.mock.calls[0]).toEqual([
          true,
          expect.objectContaining({
            status: "started",
            action: "start",
            goalId: expect.any(String),
          }),
          undefined,
          expect.anything(),
        ]);
        await waitForDispatchEnd();
        const first = loadSessionEntry(scope())!.goal!;
        expect(first.status).toBe("paused");
        expect(first.continuationTurns).toBe(0);
        expect(userMessages()).toHaveLength(1);
        const resumed = await rpc(
          "sessions.goal.update",
          {
            sessionKey,
            sessionId,
            goalId: first.id,
            action: "resume",
            operationId: "resume-native-goal",
            issuedAtMs: Date.now(),
          },
          undefined,
          operator,
        );
        expect(resumed.mock.calls[0]).toEqual([
          true,
          expect.objectContaining({ action: "resume", goalId: first.id }),
          undefined,
          expect.anything(),
        ]);
        expect((await waitForGatewayActiveWork(30_000)).drained).toBe(true);
        expect(loadSessionEntry(scope())?.goal).toMatchObject({
          id: first.id,
          status: "complete",
          continuationTurns: 2,
        });
        expect(runEmbeddedAgent.mock.calls[2]?.[0].inputProvenance).toEqual({
          kind: "internal_system",
          sourceTool: "session_goal_continue",
        });
        expect(loadSessionEntry(scope())?.goal?.tokensUsed).toBeGreaterThan(0);
        expect(runEmbeddedAgent).toHaveBeenCalledTimes(4);
        expect(userMessages()).toHaveLength(2);
        context.dedupe.clear();
        const replay = await rpc("chat.send", request, undefined, operator);
        expect(replay.mock.calls[0]?.[1]).toMatchObject({ replayed: true, goalId: first.id });
        expect(runEmbeddedAgent).toHaveBeenCalledTimes(4);
      } finally {
        promote.resolve();
        await starting;
        releasePlacement();
        loadNative.mockRestore();
        await placements.retireSessionPlacementAsync({
          sessionId,
          expectedState: "requested",
          expectedGeneration: placement.generation,
        });
      }
    },
  );
  it.each([
    { caseName: "the existing session is busy", busy: true, entry: {} },
    {
      caseName: "the session used the native Codex harness",
      entry: { agentHarnessId: "codex" },
    },
  ])("leaves no Goal or turn when $caseName", async ({ entry, busy }) => {
    const { sessionKey, sessionId } = scope();
    await patchSessionEntryCore(scope(), () => entry);
    const runId = "existing-goal-session-run";
    if (busy) {
      registerAgentRunContext(runId, {
        sessionKey,
        sessionId,
        agentId: "main",
        projectSessionActive: true,
      });
    }
    try {
      const result = await rpc(
        "chat.send",
        createGoalChatStartRequest(scope(), "Finish the release checklist", randomUUID()),
      );
      expect(result).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message:
            "Error: Goal start or resume requires an idle built-in local session with recoverable history or a supported Codex cloud-worker session.",
        }),
      );
      expect(loadSessionEntry(scope())?.goal).toBeUndefined();
      expect(userMessages()).toEqual([]);
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    } finally {
      clearAgentRunContext(runId);
    }
  });
}
