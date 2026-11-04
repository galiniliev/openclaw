import { AsyncLocalStorage } from "node:async_hooks";
import { createSubsystemLogger } from "../../logging/subsystem.js";

type ReconcileTiming = { runId: string; sessionId: string; phase: string };
const timing = new AsyncLocalStorage<ReconcileTiming>();
const log = createSubsystemLogger("gateway/worker-workspace");

type ReconcileStep =
  | "claim-prepare"
  | "session-open"
  | "operation-queue"
  | "quiescence-acquire"
  | "capture-and-prepare"
  | "node-upload"
  | "node-download"
  | "local-recovery-prepare"
  | "local-result-prepare"
  | "remote-manifest-capture"
  | "final-verification"
  | "quiescence-renew"
  | "remote-stability-check"
  | "local-stability-check"
  | "unchanged-result-accept"
  | "staged-result-apply"
  | "staged-result-publish"
  | "candidate-discard"
  | "journal-load"
  | "journal-begin"
  | "journal-commit"
  | "journal-abort"
  | "publication-capture"
  | "publication-prepare"
  | "durable-result-accept"
  | "conflict-handling"
  | "publication-dispatch"
  | "staged-settlement"
  | "turn-tools-close"
  | "staged-cleanup-move"
  | "quiescence-release"
  | "claim-release"
  | "staged-cleanup-delete"
  | "repository-checkpoint-prepare"
  | "local-canonical-inventory"
  | "local-manifest-inspect";

/** Correlation only: no execution authority or resource lifetime is retained here. */
export function withWorkspaceReconcileTiming<T>(
  identity: { runId: string; sessionId: string },
  run: () => Promise<T>,
): Promise<T> {
  return timing.run({ ...identity, phase: "workspace-reconciliation" }, run);
}

/** Queue owners finish at entry, not after the queued operation has completed. */
export function startReconcileStep(phase: ReconcileStep) {
  const context = timing.getStore();
  if (!context) {
    return (_outcome: "success" | "failed") => {};
  }
  const started = performance.now();
  let recorded = false;
  return (outcome: "success" | "failed") => {
    if (recorded) {
      return;
    }
    recorded = true;
    try {
      log.info("Worker workspace reconciliation step", {
        runId: context.runId,
        sessionId: context.sessionId,
        phase,
        parentPhase: context.phase,
        nonAdditive: true,
        durationMs: Math.round(performance.now() - started),
        outcome,
      });
    } catch {
      // Measurement cannot replace a result, error, cancellation, or cleanup obligation.
    }
  };
}

/** Inclusive spans may nest or overlap (upload and local preparation run in parallel). */
export async function measureReconcileStep<T>(
  phase: ReconcileStep,
  run: () => Promise<T>,
): Promise<T> {
  const context = timing.getStore();
  if (!context) {
    return run();
  }
  const finish = startReconcileStep(phase);
  let outcome: "success" | "failed" = "failed";
  try {
    const result = await timing.run({ ...context, phase }, run);
    outcome = "success";
    return result;
  } finally {
    finish(outcome);
  }
}
