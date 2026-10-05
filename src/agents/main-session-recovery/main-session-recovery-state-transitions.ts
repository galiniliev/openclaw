import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../../config/sessions.js";
import {
  accountSessionGoalUsage,
  buildUpdatedSessionGoalStatus,
} from "../../config/sessions/goals-transitions.js";
import type {
  MainSessionRecoveryCommand,
  MainSessionRecoveryConflict,
  MainSessionRecoveryObservation,
  MainSessionRecoveryTransitionResult,
} from "./main-session-recovery-types.js";

export function updateRecoveryState(
  entry: SessionEntry,
  state: MainRestartRecoveryState,
  patch: Omit<Partial<MainRestartRecoveryState>, "revision">,
): MainRestartRecoveryState {
  return (entry.mainRestartRecovery = { ...state, revision: state.revision + 1, ...patch });
}

/** Goal intent is bound to its original session lifecycle, not a later goal or manual pause. */
export function isCapturedMainRestartGoalCurrent(entry: SessionEntry): boolean {
  const captured = entry.restartRecoveryGoal;
  return (
    captured !== undefined &&
    captured.sessionId === entry.sessionId &&
    captured.lifecycleRevision === entry.lifecycleRevision &&
    captured.id === entry.goal?.id &&
    (entry.goal.status === "active" ||
      (entry.goal.status === "paused" && entry.goalPauseOrigin === "terminal-error")) &&
    entry.archivedAt === undefined
  );
}

/** A goal added or paused during drain also fences a previously goal-less accepted turn. */
export function isMainSessionRecoveryIntentCurrent(entry: SessionEntry): boolean {
  return (
    entry.archivedAt === undefined &&
    (!entry.goal ||
      entry.goal.status === "active" ||
      (entry.goal.status === "paused" && entry.goalPauseOrigin === "terminal-error")) &&
    (!entry.restartRecoveryGoal || isCapturedMainRestartGoalCurrent(entry))
  );
}

export function matchesObservation(
  entry: SessionEntry,
  observation: MainSessionRecoveryObservation,
): MainSessionRecoveryConflict | null {
  if (entry.sessionId !== observation.sessionId) {
    return "session_replaced";
  }
  if (entry.mainRestartRecovery?.cycleId !== observation.cycleId) {
    return "stale_cycle";
  }
  return entry.mainRestartRecovery.revision === observation.revision ? null : "stale_revision";
}

export function refundMainSessionRecoveryWorkerWait(entry: SessionEntry): void {
  const state = entry.mainRestartRecovery;
  const wait = state?.capacityWait;
  if (
    state &&
    wait?.worker &&
    wait.worker.launchId &&
    wait.worker.planHash &&
    state.chargedAttempts === wait.worker.attempt &&
    state.startedAttempt !== wait.worker.attempt &&
    entry.lifecycleRunId === wait.runId
  ) {
    // This exact admitted attempt never crossed execution. A restored wait
    // cannot spend the failure budget merely because its Gateway retired.
    updateRecoveryState(entry, state, { chargedAttempts: Math.max(0, state.chargedAttempts - 1) });
  }
}

/** Automatic recovery keeps the existing window; only an explicit resume resets it. */
export function activateCapturedMainRestartGoal(
  entry: SessionEntry,
  state: MainRestartRecoveryState,
  now: number,
): boolean {
  if (!entry.restartRecoveryGoal || !entry.goal) {
    return true;
  }
  const previousLimitedAt = entry.goal.budgetLimitedAt;
  entry.goal = accountSessionGoalUsage(
    { ...entry, goal: { ...entry.goal, status: "active", updatedAt: now } },
    now,
  );
  entry.goalPauseOrigin = undefined;
  if (entry.goal?.status === "budget_limited") {
    entry.goal.budgetLimitedAt = previousLimitedAt ?? entry.goal.budgetLimitedAt;
    updateRecoveryState(entry, state, {
      chargedAttempts: Math.max(0, state.chargedAttempts - 1),
      reservation: undefined,
    });
    return false;
  }
  return true;
}

export function transitionMainSessionRecoveryCapacityWait(
  entry: SessionEntry,
  command: Extract<
    MainSessionRecoveryCommand,
    {
      kind:
        | "wait_capacity"
        | "wait_worker_capacity"
        | "finish_worker_capacity"
        | "validate_worker_recovery"
        | "cancel_capacity_wait";
    }
  >,
): MainSessionRecoveryTransitionResult {
  const state = entry.mainRestartRecovery;
  if (command.kind === "cancel_capacity_wait") {
    const wait = command.wait;
    if (entry.sessionId !== wait.sessionId || state?.cycleId !== wait.cycleId) {
      return { kind: "rejected", reason: "stale_cycle" };
    }
    if (!state.capacityWait) {
      return { kind: "no_change" };
    }
    if (
      state.capacityWait.runId !== wait.runId ||
      state.capacityWait.lifecycleGeneration !== wait.lifecycleGeneration ||
      JSON.stringify(state.capacityWait.worker) !== JSON.stringify(wait.worker)
    ) {
      return { kind: "rejected", reason: "stale_reservation" };
    }
    updateRecoveryState(entry, state, { capacityWait: undefined });
    return { kind: "applied" };
  }
  if (
    command.kind === "wait_worker_capacity" ||
    command.kind === "finish_worker_capacity" ||
    command.kind === "validate_worker_recovery"
  ) {
    if (
      entry.sessionId !== command.sessionId ||
      state?.cycleId !== command.cycleId ||
      state.chargedAttempts !== command.worker.attempt ||
      (command.kind !== "validate_worker_recovery" &&
        state.startedAttempt === command.worker.attempt) ||
      entry.lifecycleRunId !== command.runId ||
      entry.lifecycleRevision !== command.lifecycleRevision ||
      entry.archivedAt !== undefined ||
      (entry.goal?.status === "paused" && entry.goalPauseOrigin !== "terminal-error") ||
      entry.status !== "running" ||
      entry.abortedLastRun === true ||
      state.reservation ||
      state.foregroundClaims ||
      state.tombstone ||
      !entry.restartRecoveryRuns?.some(
        (run) =>
          run.runId === command.runId && run.lifecycleGeneration === command.lifecycleGeneration,
      )
    ) {
      return { kind: "rejected", reason: "stale_reservation" };
    }
    if (command.kind === "validate_worker_recovery") {
      return { kind: "no_change" };
    }
    const exactWait =
      state.capacityWait?.runId === command.runId &&
      state.capacityWait.lifecycleGeneration === command.lifecycleGeneration &&
      JSON.stringify(state.capacityWait.worker) === JSON.stringify(command.worker);
    if (command.kind === "finish_worker_capacity") {
      if (!exactWait) {
        return { kind: "rejected", reason: "stale_reservation" };
      }
      updateRecoveryState(entry, state, { capacityWait: undefined });
      return { kind: "applied" };
    }
    if (exactWait) {
      return { kind: "no_change" };
    }
    updateRecoveryState(entry, state, {
      capacityWait: {
        runId: command.runId,
        lifecycleGeneration: command.lifecycleGeneration,
        sinceMs: command.now,
        worker: command.worker,
      },
    });
    return { kind: "applied" };
  }
  const conflict = matchesObservation(entry, command.observation);
  if (conflict) {
    return { kind: "rejected", reason: conflict };
  }
  if (
    !state ||
    entry.status !== "running" ||
    entry.abortedLastRun !== true ||
    state.reservation ||
    state.foregroundClaims ||
    state.tombstone
  ) {
    return { kind: "rejected", reason: "not_interrupted" };
  }
  updateRecoveryState(entry, state, {
    capacityWait: {
      runId: command.runId,
      lifecycleGeneration: command.lifecycleGeneration,
      sinceMs: command.now,
    },
  });
  return { kind: "applied" };
}

export function transitionMainSessionRecoveryReservationCleanup(
  entry: SessionEntry,
  command: Extract<
    MainSessionRecoveryCommand,
    { kind: "cancel_reservation" | "abandon_reservation" }
  >,
): MainSessionRecoveryTransitionResult {
  const state = entry.mainRestartRecovery;
  const reserved = state?.reservation;
  if (
    !state ||
    entry.sessionId !== command.reservation.sessionId ||
    state.cycleId !== command.reservation.cycleId ||
    reserved?.runId !== command.reservation.runId ||
    reserved.attempt !== command.reservation.attempt ||
    reserved.lifecycleGeneration !== command.reservation.lifecycleGeneration
  ) {
    return { kind: "rejected", reason: "stale_reservation" };
  }
  updateRecoveryState(entry, state, {
    chargedAttempts:
      command.kind === "cancel_reservation"
        ? Math.max(0, command.reservation.attempt - 1)
        : state.chargedAttempts,
    reservation: undefined,
  });
  return { kind: "applied" };
}

/** Pure transitions selected by the canonical recovery reducer after its hold guard. */
export function transitionMainSessionRecoveryPause(
  entry: SessionEntry,
  command: Extract<MainSessionRecoveryCommand, { kind: "pause" | "acknowledge_pause" }>,
): MainSessionRecoveryTransitionResult {
  const conflict = matchesObservation(entry, command.observation);
  if (conflict) {
    return { kind: "rejected", reason: conflict };
  }
  const state = entry.mainRestartRecovery!;
  if (command.kind === "acknowledge_pause") {
    if (!state.pause || state.reservation || state.foregroundClaims) {
      return { kind: "rejected", reason: "foreground_active" };
    }
    if (
      state.pause.goalId &&
      entry.goal?.id === state.pause.goalId &&
      entry.goal.status === "paused" &&
      entry.goalPauseOrigin === "recovery-hold" &&
      entry.goal.updatedAt === state.pause.pausedAtMs
    ) {
      entry.goal = buildUpdatedSessionGoalStatus(entry, { status: "active" }, command.now);
      entry.goalPauseOrigin = undefined;
    }
    updateRecoveryState(entry, state, { acknowledgedPause: state.pause, pause: undefined });
    entry.lastRunError = undefined;
    entry.updatedAt = command.now;
    return { kind: "applied" };
  }
  if (entry.status !== "running" || entry.abortedLastRun !== true) {
    return { kind: "rejected", reason: "not_interrupted" };
  }
  if (state.reservation || state.foregroundClaims) {
    return {
      kind: "rejected",
      reason: state.reservation ? "reservation_active" : "foreground_active",
    };
  }
  const goalId = entry.goal?.status === "active" ? entry.goal.id : undefined;
  if (goalId) {
    entry.goal = buildUpdatedSessionGoalStatus(
      entry,
      {
        status: "paused",
        note: "An interrupted external action has no verified outcome. Review it before continuing.",
      },
      command.now,
    );
  }
  updateRecoveryState(entry, state, {
    pause: { ...command.effect, pausedAtMs: command.now, ...(goalId ? { goalId } : {}) },
  });
  if (goalId) {
    entry.goalPauseOrigin = "recovery-hold";
  }
  entry.lastRunError =
    "Paused: an interrupted external action has no verified outcome. Review it and choose whether to continue before starting any work.";
  entry.updatedAt = command.now;
  return { kind: "applied" };
}
