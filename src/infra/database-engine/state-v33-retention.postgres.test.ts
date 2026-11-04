import { readFileSync } from "node:fs";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  admitStatePostgres,
  ensureStatePostgresFragment,
  stateEngineSchema,
} from "../../state/openclaw-state-db-engine.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import type { StoreSchema } from "./contract.js";
import { createPostgresEngineTestFixture } from "./engine-store.test-support.js";
import { materializeDatabasePort } from "./port.worker.js";
import { recordPostgresSchema } from "./postgres-schema.js";
import { loadStatePortDescriptor } from "./state-port-descriptor.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);
const historicalDdl = readFileSync(
  new URL(
    "../../../test/fixtures/postgres/openclaw-state-v33-worker-retention.sql",
    import.meta.url,
  ),
  "utf8",
);
const retainedTables = historicalDdl.match(/CREATE TABLE "[^"]+" \([\s\S]*?\n\);/gu)!;
const retainedIndexes = new Map(
  [...historicalDdl.matchAll(/(CREATE (?:UNIQUE )?INDEX ("[^"]+") ON [\s\S]*?;)/gu)].map(
    ([, sql, name]) => [name!, sql!],
  ),
);

describe.skipIf(!connection)("state v33 retention predecessor", () => {
  it.each([false, true])(
    "inspects and migrates retained custody (retention-bearing: %s)",
    async (retained) => {
      const source = stateEngineSchema.postgresMigrations!.find(
        (step) => step.version === 34,
      )!.fromSchema;
      const historicalSql = (sourceSql: string) => {
        let sql = sourceSql;
        for (const table of retainedTables) {
          const name = table.match(/^CREATE TABLE "([^"]+)"/u)![1];
          sql = sql.replace(new RegExp(`CREATE TABLE "${name}" \\([\\s\\S]*?\\n\\);`, "u"), table);
        }
        return sql.replace(
          /CREATE (?:UNIQUE )?INDEX ("[^"]+") ON [\s\S]*?;/gu,
          (statement, name: string) => retainedIndexes.get(name) ?? statement,
        );
      };
      const installed: StoreSchema = {
        id: "state",
        version: 33,
        sqlite: "",
        ...source,
        postgres: retained ? historicalSql(source.postgres) : source.postgres,
        postgresFragments: source.postgresFragments?.map((fragment) =>
          Object.assign({}, fragment, {
            sql: retained ? historicalSql(fragment.sql) : fragment.sql,
          }),
        ),
      };
      using fixture = withEngineStoreAdmission(() =>
        createPostgresEngineTestFixture({
          directory: dirs.make("state-v33-retention-"),
          connection: connection!,
          schemaPrefix: "retention_proof",
          schema: installed,
        }),
      );
      const db = withEngineStoreAdmission(() => fixture.open());
      const seal = withEngineStoreAdmission(() => {
        db.exec(`INSERT INTO schema_meta VALUES ('primary', 'global', 33, NULL, 'fixture', 1, 1);
        INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '33', 1);
        INSERT INTO worker_environments (
          environment_id, provider_id, profile_id, profile_snapshot_json,
          provision_operation_id, lease_id, state, owner_epoch,
          created_at_ms, updated_at_ms, state_changed_at_ms
        ) VALUES ('worker', 'fixture', 'profile', '{}', 'provision', 'lease', 'ready', 7, 1, 1, 1);`);
        const workspace = installed.postgresFragments!.find((fragment) =>
          fragment.tables.includes("session_repository_workspaces"),
        )!;
        db.runTransaction(() => {
          db.exec(workspace.sql);
          recordPostgresSchema(db, db.schema, installed);
        });
        db.exec(`INSERT INTO session_repository_workspaces (
          workspace_id, agent_id, session_key, url, branch, revision, created_at_ms, updated_at_ms
        ) VALUES ('00000000-0000-0000-0000-000000000001', 'main', 'agent:main:main', 'https://example.invalid/repo', 'main', 1, 1, 1);`);
        if (retained) {
          db.exec(`UPDATE worker_environments SET session_retention_json = '{"disk":"retained"}';
          INSERT INTO worker_session_placements (
            session_id, agent_id, session_key, state, repository_preparation,
            confirmed_loss_recovery_json, created_at_ms, updated_at_ms, state_changed_at_ms
          ) VALUES ('session', 'main', 'agent:main:main', 'local', 'ready', '{"loss":"confirmed"}', 1, 1, 1);
          UPDATE session_repository_workspaces SET recovery_json = '{"recovery":"retained"}', disk_authority_json = '{"authority":"workspace"}';
          INSERT INTO worker_workspace_pending_results (
            session_id, environment_id, owner_epoch, placement_generation, claim_id, run_id,
            gateway_instance_id, recovery_requested_at_ms, disk_authority_json, created_at_ms
          ) VALUES ('session', 'worker', 7, 1, 'claim', 'run', 'gateway', 1, '{"authority":"pending"}', 1);`);
        }
        return db.prepare("SELECT * FROM openclaw_schema_meta").get();
      });
      withEngineStoreAdmission(() => {
        fixture.invalidate();
        const inspected = fixture.open(stateEngineSchema, true);
        expect(db.prepare("SELECT * FROM openclaw_schema_meta").get()).toEqual(seal);
        inspected.runTransaction(() =>
          ensureStatePostgresFragment(inspected, "skill_workshop_changes"),
        );
      });
      const client = new Client({ connectionString: connection! });
      await client.connect();
      try {
        using snapshot = openNodeSqliteDatabase(":memory:");
        const backup = await materializeDatabasePort({
          source: { engine: "postgres", db: client, namespace: db.schema },
          destination: { engine: "sqlite", db: snapshot },
          descriptor: await loadStatePortDescriptor(33),
          storeId: db.storeId,
          assertCurrent() {},
        });
        expect(backup.tables).toMatchObject({
          worker_environments: { rows: 1 },
          session_repository_workspaces: { rows: 1 },
        });
        if (retained) {
          expect(
            snapshot.prepare("SELECT session_retention_json FROM worker_environments").get(),
          ).toEqual({ session_retention_json: '{"disk":"retained"}' });
          expect(
            snapshot
              .prepare(
                "SELECT repository_preparation, confirmed_loss_recovery_json FROM worker_session_placements",
              )
              .get(),
          ).toEqual({
            repository_preparation: "ready",
            confirmed_loss_recovery_json: '{"loss":"confirmed"}',
          });
          expect(
            snapshot
              .prepare(
                "SELECT recovery_json, disk_authority_json FROM session_repository_workspaces",
              )
              .get(),
          ).toEqual({
            recovery_json: '{"recovery":"retained"}',
            disk_authority_json: '{"authority":"workspace"}',
          });
          expect(
            snapshot
              .prepare("SELECT disk_authority_json FROM worker_workspace_pending_results")
              .get(),
          ).toEqual({ disk_authority_json: '{"authority":"pending"}' });
          expect(() =>
            snapshot
              .prepare(
                "INSERT INTO worker_environments (environment_id, provider_id, profile_id, profile_snapshot_json, provision_operation_id, lease_id, state, owner_epoch, created_at_ms, updated_at_ms, state_changed_at_ms, preparation_key) VALUES ('invalid', 'fixture', 'profile', '{}', 'provision', 'lease', 'ready', 7, 1, 1, 1, 'short')",
              )
              .run(),
          ).toThrow(/CHECK constraint failed/);
        }
        expect(snapshot.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        await client.end();
      }
      withEngineStoreAdmission(() => {
        fixture.invalidate();
        const migrated = fixture.open(stateEngineSchema);
        expect(migrated.prepare("SELECT version FROM openclaw_schema_meta").get()).toEqual({
          version: 37,
        });
        expect(
          migrated.prepare("SELECT session_retention_json FROM worker_environments").get(),
        ).toEqual({
          session_retention_json: retained ? '{"disk":"retained"}' : null,
        });
        expect(
          migrated
            .prepare("SELECT recovery_json, disk_authority_json FROM session_repository_workspaces")
            .get(),
        ).toEqual({
          recovery_json: retained ? '{"recovery":"retained"}' : null,
          disk_authority_json: retained ? '{"authority":"workspace"}' : null,
        });
        if (retained) {
          expect(
            migrated
              .prepare("SELECT disk_authority_json FROM worker_workspace_pending_results")
              .get(),
          ).toEqual({ disk_authority_json: '{"authority":"pending"}' });
          expect(
            migrated
              .prepare(
                "SELECT repository_preparation, confirmed_loss_recovery_json FROM worker_session_placements",
              )
              .get(),
          ).toEqual({
            repository_preparation: "ready",
            confirmed_loss_recovery_json: '{"loss":"confirmed"}',
          });
        }
        fixture.invalidate();
        const reopened = fixture.open(stateEngineSchema);
        admitStatePostgres(reopened, false);
        expect(reopened.prepare("SELECT owner_epoch FROM worker_environments").get()).toEqual({
          owner_epoch: 7,
        });
        // Drift must remain refused even when a known predecessor marker exists.
        reopened.exec("ALTER TABLE worker_environments ADD COLUMN unexpected text");
        fixture.invalidate();
        expect(() => fixture.open(stateEngineSchema)).toThrow(/schema drift/);
        // A changed server major forces reconstruction rather than the installed-seal fast path.
        reopened.exec("UPDATE openclaw_schema_meta SET server_major = 0");
        fixture.invalidate();
        expect(() => fixture.open(stateEngineSchema)).toThrow(/generated DDL/);
      });
    },
  );
});
