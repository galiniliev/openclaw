import type { DatabaseSync } from "node:sqlite";
import type { StoreSchema } from "../infra/database-engine/contract.js";
import type { PostgresCatalogFact } from "../infra/database-engine/postgres-catalog.js";
import { withLegacyPostgresIndexOrdering } from "../infra/database-engine/postgres-index-ordering.js";
import { splitSqlList } from "../infra/sqlite-schema-sql.js";
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

type RetentionLayout = "qualified-v33" | "appended-v37";
type RetentionLayouts = ReadonlyMap<string, RetentionLayout>;
type ColumnFact = PostgresCatalogFact & {
  value: {
    name: string;
    position: number;
    type: string;
    nullable: boolean;
    identity: boolean;
    default: string | null;
  };
};
const isColumn = (fact: PostgresCatalogFact): fact is ColumnFact => fact.kind === "column";

/** The qualified retention-bearing v33 preceded the main-line v37 migration. */
export function stateWorkerRetentionLayouts(
  version: number,
  catalog: readonly PostgresCatalogFact[],
): RetentionLayouts {
  const layouts = new Map<string, RetentionLayout>();
  if (version < 33 || version > 37) {
    return layouts;
  }
  const columns = catalog.filter(isColumn);
  const qualified = columns.some(
    (fact) =>
      (fact.table === "worker_session_placements" &&
        fact.value.name === "repository_preparation") ||
      (version < 37 &&
        WORKER_RETENTION_COLUMNS.some(
          ([table, column]) => fact.table === table && fact.value.name === column,
        )),
  );
  for (const table of stateWorkerRetentionMigration.tables) {
    if (qualified) {
      layouts.set(table, "qualified-v33");
    } else if (version === 37) {
      const tableColumns = columns.filter((fact) => fact.table === table);
      if (
        tableColumns.some(
          (fact) =>
            fact.value.position === tableColumns.length &&
            WORKER_RETENTION_COLUMNS.some(
              ([owner, column]) => owner === table && column === fact.value.name,
            ),
        )
      ) {
        layouts.set(table, "appended-v37");
      }
    }
  }
  return layouts;
}

function retentionColumnOrder(
  table: string,
  names: readonly string[],
  layout: RetentionLayout,
): string[] {
  const retained: string[] = WORKER_RETENTION_COLUMNS.filter(([owner]) => owner === table).map(
    ([, column]) => column,
  );
  if (layout === "qualified-v33" && table === "worker_session_placements") {
    retained.unshift("repository_preparation");
  }
  const ordered = names.filter((name) => !retained.includes(name));
  const predecessorBefore: Record<string, string> = {
    worker_session_placements: "remote_workspace_dir",
    session_repository_workspaces: "revision",
    worker_workspace_pending_results: "created_at_ms",
  };
  const before = layout === "qualified-v33" ? predecessorBefore[table] : undefined;
  const index = before ? ordered.indexOf(before) : ordered.length;
  ordered.splice(index < 0 ? ordered.length : index, 0, ...retained);
  return ordered;
}

/** Reconstruct only the declared historical fields/order; never copy unknown source DDL. */
export function withStateWorkerRetentionLayout(sql: string, layouts: RetentionLayouts): string {
  return sql.replace(
    /CREATE TABLE(?: IF NOT EXISTS)? ("?)(\w+)\1 \(\n([\s\S]*?)\n\)( STRICT(?:, WITHOUT ROWID)?)?;/gu,
    (statement: string, quoted: string, table: string, body: string) => {
      const layout = layouts.get(table);
      if (!layout) {
        return statement;
      }
      // SQLite column CHECKs can span lines and contain commas. Move complete
      // declarations so their predicates remain attached to their columns.
      const lines = splitSqlList(body).map((item) => item.trim());
      const declarations = new Map<string, string>();
      const tail: string[] = [];
      for (const line of lines) {
        const name = line.match(/^"?(\w+)"? (?:text|bigint|bytea|TEXT|INTEGER|BLOB)\b/u)?.[1];
        if (name) {
          declarations.set(name, `  ${line}`);
        } else {
          tail.push(`  ${line}`);
        }
      }
      const ordered = retentionColumnOrder(table, [...declarations.keys()], layout);
      const fields = ordered.map(
        (name) =>
          declarations.get(name) ??
          `  ${quoted}${name}${quoted} ${quoted ? 'text COLLATE "C"' : "TEXT"}`,
      );
      return statement.replace(body, [...fields, ...tail].join(",\n"));
    },
  );
}

/** Portable catalogs and backup columns consume the same owner-declared layout. */
export function stateWorkerRetentionCatalog(
  catalog: readonly PostgresCatalogFact[],
  layouts: RetentionLayouts,
): PostgresCatalogFact[] {
  const projected = [...catalog];
  for (const [table, layout] of layouts) {
    const columns = catalog
      .filter(isColumn)
      .filter((fact) => fact.table === table)
      .toSorted((a, b) => a.value.position - b.value.position);
    if (!columns.length) {
      continue;
    }
    const order = retentionColumnOrder(
      table,
      columns.map((fact) => fact.value.name),
      layout,
    );
    if (
      order.includes("repository_preparation") &&
      !columns.some((fact) => fact.value.name === "repository_preparation")
    ) {
      projected.push({
        table,
        kind: "column",
        value: {
          name: "repository_preparation",
          type: "text",
          nullable: true,
          identity: false,
          default: null,
          position: 0,
        },
      });
    }
    for (const [index, fact] of projected.entries()) {
      if (fact.table === table && isColumn(fact)) {
        projected[index] = {
          ...fact,
          value: { ...fact.value, position: order.indexOf(fact.value.name) + 1 },
        };
      }
    }
  }
  return projected;
}

export function statePostgresRetentionSchema(
  schema: StoreSchema,
  catalog: readonly PostgresCatalogFact[],
): StoreSchema {
  const layouts = stateWorkerRetentionLayouts(schema.version, catalog);
  const sourceSql = (sql: string) => {
    const retained = withStateWorkerRetentionLayout(sql, layouts);
    // That predecessor used v32/v33 for retention, before main's index-ordering cutover.
    return schema.version === 33 && layouts.size
      ? withLegacyPostgresIndexOrdering(retained)
      : retained;
  };
  const { postgresSchemaForCatalog: _resolver, ...definition } = schema;
  return {
    ...definition,
    postgres: schema.postgres && sourceSql(schema.postgres),
    postgresFragments: schema.postgresFragments?.map((fragment) => ({
      ...fragment,
      sql: sourceSql(fragment.sql),
    })),
  };
}
