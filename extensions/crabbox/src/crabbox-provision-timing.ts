import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const log = createSubsystemLogger("crabbox/provisioning");
const PROVIDER_PHASE =
  /^provider\.sandbox\.(?:credential|create|inspect|list|resume|other_request|poll_wait\.(?:creating|starting|resuming|stopping|suspending|inactive))$/u;
const RUNNER_PHASES = new Set([
  "provider.borrow",
  "provider.acquire",
  "provider.create",
  "provider.resume",
  "connect.ssh",
  "workspace.seed",
  "workspace.overlay",
  "workspace.sync",
  "command",
  "artifacts",
  "unattributed",
  "bootstrap.runtime.transfer",
  "bootstrap.worker.transfer",
  "bootstrap.extraction",
  "bootstrap.verification",
  "bootstrap.verification.identity",
  "bootstrap.worker.verification",
  "bootstrap.activation",
]);
const duration = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export type CrabboxSnapshotPhase =
  | "snapshot.capture.source"
  | "snapshot.capture.request"
  | "snapshot.capture.readiness"
  | "snapshot.capture.publish"
  | "snapshot.inspect.request"
  | "snapshot.recovery.lookup"
  | "snapshot.delete.request"
  | "snapshot.delete.readiness"
  | "snapshot.fork.provider"
  | "snapshot.fork.readiness"
  | "snapshot.client.total";

export function reportCrabboxSnapshotPhase(
  identity: { operationId: string; environmentId?: string },
  phase: CrabboxSnapshotPhase,
  observation: {
    durationMs: number;
    outcome: "success" | "failed";
    opaque?: boolean;
    nonAdditive?: boolean;
  },
): void {
  try {
    log.info("Crabbox snapshot timing", { ...identity, phase, ...observation });
  } catch {
    // Timing cannot change image publication or retain/release an operation.
  }
}

/** Consume only timing observations, never allocation receipts or raw diagnostic fields. */
export function reportCrabboxProvisionTiming(
  result: SpawnResult,
  identity: { operationId: string; environmentId?: string },
): void {
  // The command owner already bounds stderr. Keep parsing bounded independently,
  // including malformed/truncated reports, and never inspect stdout rejections.
  const lines = result.stderr.slice(-64 * 1024).split(/\r?\n/u);
  for (const line of lines.slice(-128).toReversed()) {
    if (!line.startsWith("{") || line.length > 32 * 1024) {
      continue;
    }
    let report: unknown;
    try {
      report = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(report) || !Array.isArray(report.runnerPhases)) {
      continue;
    }
    const outcome = result.termination === "exit" && result.code === 0 ? "success" : "failed";
    const phases = report.runnerPhases.slice(0, 64).flatMap((phase: unknown) =>
      isRecord(phase) &&
      typeof phase.name === "string" &&
      (RUNNER_PHASES.has(phase.name) || PROVIDER_PHASE.test(phase.name)) &&
      duration(phase.ms)
        ? [
            {
              phase: phase.name,
              durationMs: phase.ms,
              ...(phase.opaque === true ? { opaque: true } : {}),
              ...(phase.overlapping === true ? { overlapping: true } : {}),
            },
          ]
        : [],
    );
    const counts = Array.isArray(report.creationEvents)
      ? report.creationEvents
          .slice(0, 128)
          .flatMap((event: unknown) =>
            isRecord(event) &&
            event.phase === "provider_step" &&
            event.source === "client" &&
            typeof event.step === "string" &&
            PROVIDER_PHASE.test(event.step) &&
            duration(event.durationMs) &&
            typeof event.count === "number" &&
            Number.isSafeInteger(event.count) &&
            event.count >= 0
              ? [{ phase: event.step, durationMs: event.durationMs, count: event.count }]
              : [],
          )
      : [];
    try {
      log.info("Crabbox provisioning timing", {
        ...identity,
        outcome,
        runnerPhases: phases,
        creationEvents: counts,
      });
    } catch {
      // Observability must not change allocation, cancellation, or cleanup custody.
    }
    return;
  }
}
