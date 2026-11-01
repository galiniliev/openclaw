import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const predecessor = readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-state-schema-v35.sql", import.meta.url),
  "utf8",
);
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it.each([false, true])(
  "preserves worker custody through retention migration (refuse publication: %s)",
  async (refuse) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("worker-retention-migration-") };
    const pathname = resolveOpenClawStateSqlitePath(env);
    mkdirSync(path.dirname(pathname), { recursive: true });
    {
      using db = new DatabaseSync(pathname);
      db.exec(predecessor);
      db.exec(`PRAGMA user_version = 35;
      INSERT INTO schema_meta VALUES ('primary', 'global', 35, NULL, 'fixture-v35', 100, 100);
      INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '35', 100);
      INSERT INTO worker_environments (
        environment_id, provider_id, profile_id, profile_snapshot_json,
        provision_operation_id, lease_id, state, owner_epoch,
        created_at_ms, updated_at_ms, state_changed_at_ms
      ) VALUES ('worker', 'fixture', 'profile', '{}', 'provision', 'lease', 'ready', 7, 100, 100, 100);`);
      if (refuse) {
        db.exec(`CREATE TRIGGER refuse_retention_version BEFORE UPDATE ON schema_meta
        BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;`);
      }
    }
    const open = () => openOpenClawStateDatabase({ env, path: pathname });
    if (refuse) {
      expect(open).toThrow(/fixture publication refusal/);
    } else {
      const { db } = open();
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 37 });
      expect(db.prepare("SELECT session_retention_json FROM worker_environments").get()).toEqual({
        session_retention_json: null,
      });
      expect(
        db.prepare("SELECT confirmed_loss_recovery_json FROM worker_session_placements").all(),
      ).toEqual([]);
      expect(
        db
          .prepare("SELECT recovery_json, disk_authority_json FROM session_repository_workspaces")
          .all(),
      ).toEqual([]);
      expect(
        db.prepare("SELECT disk_authority_json FROM worker_workspace_pending_results").all(),
      ).toEqual([]);
    }
    await closeOpenClawStateDatabaseAsync();
    using db = new DatabaseSync(pathname, { readOnly: true });
    expect(
      db
        .prepare(
          "SELECT environment_id, lease_id, owner_epoch, profile_snapshot_json, state FROM worker_environments",
        )
        .all(),
    ).toEqual([
      {
        environment_id: "worker",
        lease_id: "lease",
        owner_epoch: 7,
        profile_snapshot_json: "{}",
        state: "ready",
      },
    ]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: refuse ? 35 : 37 });
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM pragma_table_info('worker_environments') WHERE name = 'session_retention_json'",
        )
        .get(),
    ).toEqual({ count: refuse ? 0 : 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  },
);
