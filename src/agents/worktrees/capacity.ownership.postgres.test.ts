import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { expect, it } from "vitest";
import { withEngineStoreAdmission as admit } from "../../infra/database-engine/admission-scope.js";
import { installDatabaseEngineSelection } from "../../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../../infra/database-engine/context.test-support.js";
import { getPostgresPhysicalFacts } from "../../infra/database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "../../infra/database-engine/registry.js";
import { withExistingOpenClawStateSchema as withSchema } from "../../state/openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  cleanupPostgresStateFixture,
  installPostgresStateFixture,
} from "../../state/openclaw-state-db.postgres-fixture.test-support.js";
import { withWorktreeMutationLease } from "./allocation.js";
import { WORKTREE_CAPACITY_RESERVATION_SCOPE } from "./capacity-contract.js";
import { createWorktreeDiskAdmission } from "./capacity.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

for (const engine of ["sqlite", "postgres"] as const) {
  it.skipIf(engine === "postgres" && !connection)(
    `preserves the capacity reservation's target owner through insert and update (${engine})`,
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-capacity-owner-"));
      const env = { ...process.env, OPENCLAW_STATE_DIR: root };
      const options = { env };
      const client =
        engine === "postgres" ? new pg.Client({ connectionString: connection }) : undefined;
      let pathname = "";
      let namespace: string | undefined;
      try {
        if (engine === "postgres") {
          installPostgresStateFixture(
            connection!,
            `capacity_owner_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          );
          await client!.connect();
        } else {
          installDatabaseEngineSelection({
            effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine } }),
          });
        }
        const database = admit(() => openOpenClawStateDatabase(options));
        pathname = database.path;
        namespace = getPostgresPhysicalFacts(database.db)?.namespace;
        const debts = () =>
          admit(() =>
            database.db
              .prepare("SELECT lease_key, owner, payload_json FROM state_leases WHERE scope = ?")
              .all(WORKTREE_CAPACITY_RESERVATION_SCOPE),
          );
        const setOwner = (owner: string) =>
          admit(() =>
            runOpenClawStateWriteTransaction(
              ({ db }) =>
                db
                  .prepare("UPDATE state_leases SET owner = ? WHERE scope = ?")
                  .run(owner, WORKTREE_CAPACITY_RESERVATION_SCOPE),
              options,
            ),
          );
        await withSchema({ path: pathname }, () =>
          withWorktreeMutationLease({ env, id: "capacity-owner" }, async (guard) => {
            const capacity = createWorktreeDiskAdmission({
              env,
              workerAuthority: guard.workerAuthority,
              assertCurrent: guard.commitGuard,
            });
            let originalOwner: string | undefined;
            try {
              const reserve = (bytes: number) =>
                capacity.requireDiskSpace([{ path: root, bytes }], "owner regression", true);
              await reserve(1);
              const [inserted] = debts();
              expect(debts()).toHaveLength(1);
              expect(inserted?.owner).toBe(inserted?.lease_key);
              if (typeof inserted?.owner !== "string") {
                throw new Error("Missing fixture reservation owner");
              }
              originalOwner = inserted.owner;
              await reserve(2);
              const [updated] = debts();
              expect(updated?.owner).toBe(originalOwner);
              expect(updated?.payload_json).not.toBe(inserted?.payload_json);

              // Keep the live process payload; only the target row's authority changes.
              setOwner("replacement-capacity-owner");
              const replacement = debts();
              await expect(reserve(3)).rejects.toThrow(
                "Managed worktree capacity reservation changed",
              );
              expect(debts()).toEqual(replacement);
            } finally {
              if (originalOwner) {
                setOwner(originalOwner);
              }
              await capacity.release();
            }
            expect(debts()).toEqual([]);
          }),
        );
      } finally {
        await closeOpenClawStateDatabaseAsync();
        if (client) {
          await cleanupPostgresStateFixture(client, pathname, namespace);
        } else {
          resetDatabaseEngineSelectionForTest();
        }
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
}
