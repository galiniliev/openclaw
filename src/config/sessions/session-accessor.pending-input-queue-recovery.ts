import { isDeepStrictEqual } from "node:util";
import { buildMainSessionRecoveryClearPatch } from "../../agents/main-session-recovery/main-session-recovery-clear.js";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveSessionWorkStartError } from "./lifecycle.js";
import {
  createMainRestartRecoveryCycle,
  isCapturedMainRestartTurnCurrent,
} from "./main-session-recovery.types.js";
import { buildRestartRecoveryClaimCleanupPatch } from "./restart-recovery-state.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readPendingInputRecoveryIntent } from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { InternalSessionEntry } from "./types.js";

/** The existing row order chooses one unstarted follower only after the previous owner settles. */
export function promoteQueuedPendingInputInDatabase(
  database: OpenClawAgentDatabase,
  target: { sessionKey: string; sessionId: string },
  input: { expectedEntry: InternalSessionEntry; lifecycleGeneration: string },
): { entry: InternalSessionEntry } | undefined {
  const entry = readSessionEntryRow(database, target.sessionKey)?.entry;
  const state = entry?.mainRestartRecovery;
  const current = state?.queuedInputId
    ? executeSqliteQueryTakeFirstSync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_pending_inputs")
          .selectAll()
          .where("session_key", "=", target.sessionKey)
          .where("session_id", "=", target.sessionId)
          .where("input_id", "=", state.queuedInputId),
      )
    : undefined;
  const cancelledHead =
    current?.input_id === state?.queuedInputId && current?.state === "cancelled";
  if (
    !entry ||
    (entry.status !== "done" && !cancelledHead) ||
    !isDeepStrictEqual(entry, input.expectedEntry) ||
    entry.sessionId !== target.sessionId ||
    entry.archivedAt !== undefined ||
    state?.pause ||
    state?.tombstone ||
    state?.reservation ||
    (state?.foregroundClaims?.lifecycleGeneration === input.lifecycleGeneration &&
      state.foregroundClaims.tokens.length) ||
    !state?.queuedInputsPending ||
    resolveSessionWorkStartError(target.sessionKey, entry) ||
    (isCapturedMainRestartTurnCurrent(entry) && !cancelledHead) ||
    (entry.goal && entry.goal.status !== "active")
  ) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_pending_inputs")
      .selectAll()
      .where("session_key", "=", target.sessionKey)
      .where("session_id", "=", target.sessionId)
      .where("consumed_event_id", "is", null)
      .where("state", "!=", "cancelled")
      .orderBy("seq", "asc")
      .limit(1),
  );
  const capture = row && readPendingInputRecoveryIntent(row);
  if (!row) {
    const settled = {
      ...entry,
      mainRestartRecovery: { ...state!, queuedInputsPending: undefined },
    };
    if (cancelledHead) {
      settled.status = "done";
      Object.assign(
        settled,
        buildRestartRecoveryClaimCleanupPatch({
          entry: settled,
          recordTerminalSource: true,
          terminalRunId: current!.run_id,
          terminalSourceRunId: current!.run_id,
        }),
      );
    }
    Object.assign(settled, buildMainSessionRecoveryClearPatch(settled));
    const next = writeSessionEntry(database, target.sessionKey, settled, {
      canonicalPreviousEntry: entry,
    });
    return { entry: next };
  }
  if (row.lifecycle_generation === input.lifecycleGeneration) {
    return undefined;
  }
  const intent =
    capture?.queued &&
    capture.intent.lifecycleRevision === entry.lifecycleRevision &&
    capture.intent.repositoryWorkspaceId === entry.repositoryWorkspaceId
      ? capture.intent
      : undefined;
  const next = writeSessionEntry(
    database,
    target.sessionKey,
    {
      ...entry,
      status: "running",
      abortedLastRun: true,
      restartRecoveryGoal: undefined,
      restartRecoveryDeliveryRunId: row.run_id,
      restartRecoveryDeliverySourceRunId: row.run_id,
      restartRecoveryRuns: [{ runId: row.run_id, lifecycleGeneration: row.lifecycle_generation }],
      mainRestartRecovery: {
        ...createMainRestartRecoveryCycle(),
        ...(state?.goalIntent ? { goalIntent: state.goalIntent } : {}),
        turnIntent: intent,
        queuedInputId: row.input_id,
        queuedInputsPending: true,
      },
    },
    { canonicalPreviousEntry: entry },
  );
  return { entry: next };
}
