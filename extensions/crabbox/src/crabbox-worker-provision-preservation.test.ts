import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, vi } from "vitest";
import { failProvisionAfterCleanup } from "./crabbox-worker-provision-commands.js";

it.each([false, true])(
  "keeps admitted retained disks and cleans only new allocations (admitted=%s)",
  async (admitted) => {
    const failure = new Error("Node enrollment failed");
    const stopLease = vi.fn(async () => {});
    const result = await failProvisionAfterCleanup(
      {
        binary: "/synthetic/crabbox",
        provider: "azure-sandbox",
        id: "cbx_0123456789ab",
        preserveRetainedLease: admitted,
        stopLease,
      },
      failure,
    ).catch((error: unknown) => error);
    if (admitted) {
      expect(result).toBe(failure);
      expect(stopLease).not.toHaveBeenCalled();
    } else {
      expect(WorkerProviderError.isCleanupComplete(result)).toBe(true);
      expect(stopLease).toHaveBeenCalledOnce();
    }
  },
);
