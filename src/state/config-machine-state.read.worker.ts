import { readConfigRevisionKeyInDatabase } from "../gateway/config-revision-key.worker.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { readConfigMachineStateRowInDatabase } from "./config-machine-state-row.js";
import type { WorkerOperations } from "./worker-operation-registry.js";

export const machineStateReadOperations = {
  "machineState.configRevisionKey.read": (
    _input: Record<string, never>,
    database: EngineConnection,
  ) => ({
    type: "machineState.configRevisionKey.read" as const,
    key: readConfigRevisionKeyInDatabase(database),
    store: (() => {
      const facts = getPostgresPhysicalFacts(database);
      return facts
        ? { id: facts.storeId, namespace: facts.namespace, version: facts.version }
        : undefined;
    })(),
  }),
  "machineState.read": (input: { key: string }, database: EngineConnection) => ({
    type: "machineState.read" as const,
    row: readConfigMachineStateRowInDatabase(database, input.key),
  }),
};

export type MachineStateReadOperations = WorkerOperations<typeof machineStateReadOperations>;
