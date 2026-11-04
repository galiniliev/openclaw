import type {
  WorkerWorkspaceQuiescence,
  WorkerWorkspaceReconcileResult,
} from "./tunnel-contract.js";
import { measureReconcileStep } from "./workspace-reconcile-timing.js";
import type { WorkerWorkspaceApplyResult } from "./workspace-reconcile.js";

export class WorkerWorkspaceFinalFenceError extends Error {
  readonly reclaimDisposition: "retry" | "preserve-result";

  constructor(cause: unknown, reclaimDisposition: "retry" | "preserve-result") {
    super(cause instanceof Error ? cause.message : "Worker workspace quiescence failed", { cause });
    this.name = "WorkerWorkspaceFinalFenceError";
    this.reclaimDisposition = reclaimDisposition;
  }
}

/** Rechecks both owners after renewing the remote quiescence lease. */
export async function verifyReconciledWorkspaceFinal(
  reconciliation: WorkerWorkspaceReconcileResult,
  quiescence: WorkerWorkspaceQuiescence,
): Promise<WorkerWorkspaceApplyResult | undefined> {
  const acceptUnchanged = reconciliation.acceptUnchangedStagedResult;
  let disposition: WorkerWorkspaceFinalFenceError["reclaimDisposition"] = "retry";
  const fence = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      throw new WorkerWorkspaceFinalFenceError(error, disposition);
    }
  };
  try {
    // A late writer can mutate before renewal enrolls and SIGSTOPs it.
    await fence(() => measureReconcileStep("quiescence-renew", () => quiescence.assertActive()));
    await fence(() =>
      measureReconcileStep("remote-stability-check", () => reconciliation.verifyStable()),
    );
    if (acceptUnchanged) {
      await fence(() => measureReconcileStep("unchanged-result-accept", acceptUnchanged));
    } else {
      if (reconciliation.applyPreparedStagedResult) {
        await measureReconcileStep(
          "staged-result-apply",
          async () => await reconciliation.applyPreparedStagedResult?.(),
        );
      }
      await measureReconcileStep("local-stability-check", () => reconciliation.verifyLocalStable());
      // Applied results must survive a lost lease or final verification failure.
      disposition = "preserve-result";
      await fence(() => measureReconcileStep("quiescence-renew", () => quiescence.assertActive()));
      await fence(() =>
        measureReconcileStep("remote-stability-check", () => reconciliation.verifyStable()),
      );
      await fence(() =>
        measureReconcileStep("local-stability-check", () => reconciliation.verifyLocalStable()),
      );
    }
    await measureReconcileStep("staged-result-publish", () => reconciliation.publishStagedResult());
    const applied = reconciliation.getAppliedWorkspaceResult?.();
    return applied;
  } catch (error) {
    await measureReconcileStep("candidate-discard", () =>
      reconciliation.discardPreparedStagedResult(),
    ).catch(() => undefined);
    throw error;
  }
}
