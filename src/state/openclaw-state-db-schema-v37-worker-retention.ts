import type { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";

export const WORKER_RETENTION_COLUMNS = [
  ["worker_environments", "session_retention_json"],
  ["worker_session_placements", "confirmed_loss_recovery_json"],
  ["session_repository_workspaces", "recovery_json"],
  ["session_repository_workspaces", "disk_authority_json"],
  ["worker_workspace_pending_results", "disk_authority_json"],
] as const;

export const stateWorkerRetentionMigration = {
  version: 37,
  tables: [...new Set(WORKER_RETENTION_COLUMNS.map(([table]) => table))],
  columns: WORKER_RETENTION_COLUMNS.map(([table, column]) => `${table}.${column}`),
  migrate(db: DatabaseSync, previousVersion: number): boolean {
    if (previousVersion >= 37) {
      return false;
    }
    let changed = false;
    for (const [table, column] of WORKER_RETENTION_COLUMNS) {
      changed = ensureColumn(db, table, `${column} TEXT`) || changed;
    }
    return changed;
  },
  applied: "Retained session-private disks, recovery evidence, and workspace result custody (v37)",
};

/** Predecessor DDL for migration admission and verified SQLite/PostgreSQL backups. */
export function withLegacyWorkerRetention(schema: string): string {
  return schema.replace(
    /\n {2}"?(?:session_retention_json|confirmed_loss_recovery_json|recovery_json|disk_authority_json)"?[^\n]*,(?=\n)/gu,
    "",
  );
}
