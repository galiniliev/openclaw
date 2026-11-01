import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import type { WorkerWorkspaceReconcileResult } from "./tunnel-contract.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import { withWorkspaceReconcileTiming } from "./workspace-reconcile-timing.js";

afterEach(() => {
  vi.restoreAllMocks();
  setLoggerOverride(null);
  resetLogger();
});

function fixture() {
  const log: string[] = [];
  const record = (event: string) => async () => {
    log.push(event);
  };
  const reconciliation: WorkerWorkspaceReconcileResult = {
    manifestRef: "sha256:" + "c".repeat(64),
    changed: true,
    verifyStable: record("remote"),
    verifyLocalStable: record("local"),
    applyPreparedStagedResult: record("apply-prepared"),
    publishStagedResult: record("publish"),
    discardPreparedStagedResult: record("discard-prepared"),
  };
  const finalize = (assertActive = async () => {}) =>
    verifyReconciledWorkspaceFinal(reconciliation, { assertActive, resume: async () => {} });
  return { log, reconciliation, finalize, record };
}

describe("final worker workspace fences", () => {
  it.each([false, true])(
    "fences unchanged local state during acceptance after renewal (local failure: %s)",
    async (localFailure) => {
      const log: string[] = [];
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      setLoggerOverride({ level: "info", consoleLevel: "silent" });
      const events: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => {
        if (
          event.type === "log.record" &&
          event.message === "Worker workspace reconciliation step"
        ) {
          events.push(event);
        }
      });
      const entered = createDeferred();
      const release = createDeferred();
      const finalize = withWorkspaceReconcileTiming(
        { runId: "run-reconcile", sessionId: "session-reconcile" },
        () =>
          verifyReconciledWorkspaceFinal(
            {
              manifestRef: "sha256:" + "a".repeat(64),
              changed: false,
              verifyStable: async () => {
                log.push("remote");
                clock += 7;
              },
              verifyLocalStable: async () => {},
              acceptUnchangedStagedResult: async () => {
                log.push("local");
                entered.resolve();
                await release.promise;
                if (localFailure) {
                  throw new Error("local workspace changed");
                }
                log.push("accept");
              },
              publishStagedResult: async () => {
                log.push("publish");
              },
              discardPreparedStagedResult: async () => {
                log.push("discard");
              },
            },
            {
              assertActive: async () => {
                log.push("renew");
              },
              resume: async () => {},
            },
          ),
      );
      try {
        await entered.promise;
        await yieldToEventLoop();
        expect(events.map((event) => event.attributes?.phase)).toEqual([
          "quiescence-renew",
          "remote-stability-check",
        ]);
        clock += 30;
        release.resolve();
        if (localFailure) {
          await expect(finalize).rejects.toMatchObject({
            message: "local workspace changed",
            reclaimDisposition: "retry",
          });
          expect(log).toEqual(["renew", "remote", "local", "discard"]);
        } else {
          await finalize;
          expect(log).toEqual(["renew", "remote", "local", "accept", "publish"]);
        }
        await yieldToEventLoop();
        expect(
          events.map((event) => [
            event.attributes?.phase,
            event.attributes?.durationMs,
            event.attributes?.outcome,
          ]),
        ).toEqual([
          ["quiescence-renew", 0, "success"],
          ["remote-stability-check", 7, "success"],
          ["unchanged-result-accept", 30, localFailure ? "failed" : "success"],
          [localFailure ? "candidate-discard" : "staged-result-publish", 0, "success"],
        ]);
        for (const event of events) {
          expect(event.attributes).toEqual({
            subsystem: "gateway/worker-workspace",
            runId: "run-reconcile",
            sessionId: "session-reconcile",
            phase: expect.any(String),
            parentPhase: "workspace-reconciliation",
            nonAdditive: true,
            durationMs: expect.any(Number),
            outcome: expect.any(String),
          });
        }
      } finally {
        release.resolve();
        await finalize.catch(() => undefined);
        unsubscribe();
      }
    },
  );

  it("rejects quiescence lost while the staged result is finalized", async () => {
    const { log, finalize } = fixture();
    let quiescenceChecks = 0;
    await expect(
      finalize(async () => {
        quiescenceChecks += 1;
        log.push("quiescence");
        if (quiescenceChecks === 2) {
          throw new Error("quiescence expired during finalization");
        }
      }),
    ).rejects.toMatchObject({
      message: "quiescence expired during finalization",
      reclaimDisposition: "preserve-result",
    });
    expect(log).toEqual([
      "quiescence",
      "remote",
      "apply-prepared",
      "local",
      "quiescence",
      "discard-prepared",
    ]);
  });

  it("rejects a late write enrolled by the pre-apply renewal before applying", async () => {
    let remoteChanged = false;
    const apply = vi.fn(async () => {});
    const { reconciliation, finalize } = fixture();
    reconciliation.applyPreparedStagedResult = apply;
    reconciliation.verifyStable = async () => {
      if (remoteChanged) {
        throw new Error("writer mutated before SIGSTOP");
      }
    };
    await expect(
      finalize(async () => {
        remoteChanged = true;
      }),
    ).rejects.toMatchObject({
      message: "writer mutated before SIGSTOP",
      reclaimDisposition: "retry",
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("discards a prepared result when the final remote fence fails", async () => {
    const { log, reconciliation, finalize, record } = fixture();
    let applied = false;
    reconciliation.verifyStable = async () => {
      if (applied) {
        throw new Error("late remote write");
      }
    };
    reconciliation.applyPreparedStagedResult = async () => {
      await record("apply-prepared")();
      applied = true;
    };
    await expect(finalize()).rejects.toThrow("late remote write");
    expect(log).toEqual(["apply-prepared", "local", "discard-prepared"]);
  });

  it("best-effort discards a candidate when staged finalization fails", async () => {
    const discard = vi.fn(async () => {
      throw new Error("candidate cleanup failed");
    });
    const { reconciliation, finalize } = fixture();
    reconciliation.discardPreparedStagedResult = discard;
    reconciliation.publishStagedResult = async () => {
      throw new Error("publish failed");
    };
    await expect(finalize()).rejects.toThrow("publish failed");
    expect(discard).toHaveBeenCalledOnce();
  });
});
