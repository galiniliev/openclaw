import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import { startReconcileStep } from "./workspace-reconcile-timing.js";

export type WorkerWorkspaceOperationCoordinator = {
  run<T>(environmentId: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
};

/** Serializes local workspace mutation and forced teardown per environment. */
export function createWorkerWorkspaceOperationCoordinator(): WorkerWorkspaceOperationCoordinator {
  const queue = new KeyedAsyncQueue();
  return {
    async run<T>(
      environmentId: string,
      operation: () => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      let entered = false;
      const finishQueue = startReconcileStep("operation-queue");
      const result = queue.enqueue(environmentId, () => {
        signal?.throwIfAborted();
        entered = true;
        finishQueue("success");
        return operation();
      });
      try {
        return await raceNodeWorkerOperation(result, signal);
      } catch (error) {
        if (!entered) {
          finishQueue("failed");
        }
        // Queued cancellation can detach without removing its place in the queue.
        // Once mutation entered, its owner must join settlement before returning.
        if (entered) {
          return await result;
        }
        throw error;
      }
    },
  };
}
