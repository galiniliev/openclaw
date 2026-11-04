import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import {
  createNodeRegistryRuntime,
  updateNodeRunnerInventory,
  waitForNodeWorkerSupervisor,
} from "./node-registry-private.js";
import { NodeRegistry } from "./node-registry.js";
import { createWorkerSupervisorNodeClient } from "./server-methods/nodes.runner-inventory.test-support.js";

describe("worker supervisor availability admission", () => {
  const availabilityCases = [
    "reconnect",
    "reconnect-during-read",
    "cancelled",
    "incompatible",
    "runtime-upgrade",
  ] as const;
  it.each(availabilityCases)(
    "waits for the current admitted worker supervisor and qualified runtime: %s",
    async (scenario) => {
      const { nodeRegistry, nodeWorkerSupervisorTransport } = createNodeRegistryRuntime(
        () => new NodeRegistry(),
      );
      const controller = new AbortController();
      const firstRead = createDeferred();
      const readinessChecked = createDeferred();
      let runtimeReady = scenario !== "runtime-upgrade";
      let ready = false;
      let connection = 0;
      const connect = () => {
        const connId = `reconnected-${++connection}`;
        nodeRegistry.register(createWorkerSupervisorNodeClient(connId), {
          pairingIdentity: "identity-a",
          pairingGeneration: "generation-a",
        });
        updateNodeRunnerInventory({
          registry: nodeRegistry,
          nodeId: "node-1",
          connId,
          declaration:
            scenario === "incompatible"
              ? { protocolFeatures: ["node-worker-supervisor-v5"] }
              : {
                  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
                  workerHost: { enabled: true, capacity: { total: 1, available: 1 } },
                },
        });
      };
      if (scenario === "runtime-upgrade") {
        connect();
      }
      const getCurrentNode = nodeWorkerSupervisorTransport.getCurrentNode.bind(
        nodeWorkerSupervisorTransport,
      );
      vi.spyOn(nodeWorkerSupervisorTransport, "getCurrentNode").mockImplementationOnce(async () => {
        if (scenario === "reconnect-during-read") {
          connect();
        }
        firstRead.resolve();
        return scenario === "runtime-upgrade" ? await getCurrentNode("node-1") : undefined;
      });
      const waiting = waitForNodeWorkerSupervisor(nodeRegistry, "node-1", {
        signal: controller.signal,
        assertCurrent: () => {},
        isReady: () => {
          readinessChecked.resolve();
          return runtimeReady;
        },
      });
      const result = waiting.then(
        () => {
          ready = true;
          return "ready";
        },
        (error: unknown) => error,
      );
      await firstRead.promise;
      if (scenario === "runtime-upgrade") {
        await readinessChecked.promise;
        expect(ready).toBe(false);
        runtimeReady = true;
      }
      if (scenario === "cancelled") {
        controller.abort(new Error("turn stopped"));
      } else if (scenario !== "reconnect-during-read") {
        connect();
      }
      if (scenario === "cancelled" || scenario === "incompatible") {
        expect(await result).toBeInstanceOf(Error);
      } else {
        expect(await result).toBe("ready");
        expect(nodeWorkerSupervisorTransport.hasCurrentRunner("node-1")).toBe(true);
      }
    },
  );
});
