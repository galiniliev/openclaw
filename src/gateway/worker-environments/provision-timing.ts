import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WorkerEnvironmentRecord } from "./store.js";

const log = createSubsystemLogger("gateway/worker-environments");

/** Observation only: the caller retains cancellation, settlement, and readiness ownership. */
export async function measureWorkerProvisionPhase<T>(
  record: Pick<WorkerEnvironmentRecord, "environmentId" | "provisionOperationId">,
  phase: string,
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let outcome = "failed";
  try {
    const result = await run();
    outcome = "success";
    return result;
  } finally {
    try {
      log.info("Worker provisioning phase", {
        environmentId: record.environmentId,
        operationId: record.provisionOperationId,
        phase,
        outcome,
        durationMs: Math.round(performance.now() - started),
      });
    } catch {
      // Logging cannot replace the operation's result or its original failure.
    }
  }
}
