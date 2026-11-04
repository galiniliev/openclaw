import fs from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { expect, it, vi } from "vitest";
import { prepareDoctorDatabaseMigrations } from "../../commands/doctor-schema-migrations.js";
import { repairLegacySessionEntryStates } from "../../commands/doctor-session-delivery-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { verifyMatchedPostgresBackup } from "../../snapshot/database-backup.js";
import { agentEngineSchema } from "../../state/openclaw-agent-db-engine.js";
import { stateEngineSchema } from "../../state/openclaw-state-db-engine.js";
import { acquireGatewayLock } from "../gateway-lock.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import type { StoreSchema } from "./contract.js";
import { openEngineStore } from "./open.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";

/** Reuse the real migration suite's database/transport custody for its later Doctor phase. */
export function registerDoctorSessionRepairPostgresTests(
  getFixture: () => {
    client: Client;
    connection: string;
    env: NodeJS.ProcessEnv;
    pathname: string;
    namespace: string;
    target: number;
    originalMigrations: StoreSchema["postgresMigrations"];
    prepareSource: (schema: StoreSchema) => Promise<void>;
    namespaces: Set<string>;
    config: OpenClawConfig;
  },
) {
  it.each([false, true])(
    "backs up current PostgreSQL families before post-migration session repair (backup refused: %s)",
    async (refuseBackup) => {
      const {
        client,
        connection,
        env,
        pathname,
        namespace,
        target,
        originalMigrations,
        prepareSource,
        namespaces,
        config,
      } = getFixture();
      const rows = async (sql: string) => (await client.query(sql)).rows;
      const readMeta = async () =>
        (await rows(`SELECT version, fingerprint FROM "${namespace}".openclaw_schema_meta`))[0];
      const archives = () =>
        fs.readdirSync(path.dirname(pathname)).filter((name) => name.endsWith(".postgres.bak"));
      stateEngineSchema.postgresMigrations = originalMigrations;
      const stateSource = originalMigrations!.find((step) => step.version === 34)!.fromSchema;
      await prepareSource({ ...stateEngineSchema, ...stateSource, version: 33 });
      const agentPath = path.join(
        env.OPENCLAW_STATE_DIR!,
        `session-repair-${refuseBackup}`,
        "openclaw-agent.sqlite",
      );
      fs.mkdirSync(path.dirname(agentPath), { recursive: true });
      const agentSource = agentEngineSchema.postgresMigrations!.find(
        (step) => step.version === 33,
      )!.fromSchema;
      const agentNamespace = withEngineStoreAdmission(() => {
        using anchor = openNodeSqliteDatabase(agentPath);
        const engine = openEngineStore({
          anchor,
          schema: {
            ...agentEngineSchema,
            ...agentSource,
            version: 32,
            postgresMigrations: [],
            postgresVectorDecoderVersion: agentSource.postgresVectorDecoderVersion,
            postgresVectorSearchVersion: agentSource.postgresVectorSearchVersion,
            postgresTextSearchVersion: agentSource.postgresTextSearchVersion,
          },
          input: { connection: connection!, schemaPrefix: "doctor_fixture" },
          inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
          prepareAnchor() {},
          openSqlite() {
            throw new Error("Expected PostgreSQL");
          },
        });
        try {
          return getPostgresPhysicalFacts(engine)!.namespace;
        } finally {
          engine.close();
        }
      });
      namespaces.add(agentNamespace);
      const raw =
        '{"sessionId":"repair-session","updatedAt":42,"pendingFinalDelivery":true,"pendingFinalDeliveryCreatedAt":42}';
      await client.query(`
        INSERT INTO "${agentNamespace}".schema_meta VALUES ('primary', 'agent', 32, 'main', NULL, 1, 1);
        INSERT INTO "${agentNamespace}".session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0);
        INSERT INTO "${agentNamespace}".memory_index_state VALUES (1, 0);
        INSERT INTO "${agentNamespace}".session_nodes (session_key, current_session_id, entry_json, updated_at)
          VALUES ('agent:main:repair', 'repair-session', '${raw}', 42);
        INSERT INTO "${agentNamespace}".session_windows (session_id, session_key, created_at, updated_at, transcript_updated_at)
          VALUES ('repair-session', 'agent:main:repair', 42, 42, 42);`);
      const readEntry = async () =>
        (
          await rows(
            `SELECT entry_json FROM "${agentNamespace}".session_nodes WHERE session_key = 'agent:main:repair'`,
          )
        )[0].entry_json;
      const lock = await acquireGatewayLock({
        env,
        allowInTests: true,
        role: "sqlite-maintenance",
        timeoutMs: 0,
      });
      expect(lock).not.toBeNull();
      try {
        await lock!.run(async () => {
          const migrated = await prepareDoctorDatabaseMigrations({
            env,
            pendingDatabasePaths: [pathname, agentPath],
            databasePaths: [pathname, agentPath],
            agentDatabaseTargets: [
              { agentId: "main", path: agentPath, realPath: agentPath, source: "registry" },
            ],
            pendingMigrations: [
              { kind: "state", path: pathname, foundVersion: 33, supportedVersion: target },
              {
                kind: "agent",
                path: agentPath,
                foundVersion: 32,
                supportedVersion: agentEngineSchema.version,
              },
            ],
          });
          expect(migrated.warnings).toEqual([]);
          expect((await readMeta()).version).toBe(String(target));
          expect(
            (await rows(`SELECT version FROM "${agentNamespace}".openclaw_schema_meta`))[0].version,
          ).toBe(String(agentEngineSchema.version));
          expect(await readEntry()).toBe(raw);
          const earlier = new Set(archives());
          const mkdir = fs.promises.mkdir;
          const refusal = refuseBackup
            ? vi.spyOn(fs.promises, "mkdir").mockImplementation((...args) => {
                if (String(args[0]).endsWith(".postgres.bak")) {
                  return Promise.reject(new Error("fixture exact backup refused"));
                }
                return mkdir(...args);
              })
            : undefined;
          try {
            const repair = repairLegacySessionEntryStates({
              apply: true,
              cfg: config,
              env,
              targets: [{ agentId: "main", storePath: agentPath, sqlitePath: agentPath }],
            });
            if (refuseBackup) {
              await expect(repair).rejects.toThrow(/fixture exact backup refused/);
              expect(await readEntry()).toBe(raw);
              expect(archives().filter((entry) => !earlier.has(entry))).toEqual([]);
              return;
            }
            await expect(repair).resolves.toEqual({ found: 1, repaired: 1, scannedStores: 1 });
          } finally {
            refusal?.mockRestore();
          }
          expect(JSON.parse(String(await readEntry())).pendingFinalDelivery).toEqual({
            kind: "transport-only",
            createdAt: 42,
          });
          const directory = path.join(
            path.dirname(pathname),
            archives().find((entry) => !earlier.has(entry))!,
          );
          const stateBackup = await verifyMatchedPostgresBackup(directory, "exact");
          expect(stateBackup.source).toMatchObject({ owner: "state", schemaVersion: target });
          const agentBackups = fs
            .readdirSync(path.dirname(agentPath))
            .filter((name) => name.endsWith(".postgres.bak"));
          const latest = [];
          for (const name of agentBackups) {
            const agentDirectory = path.join(path.dirname(agentPath), name);
            const manifest = await verifyMatchedPostgresBackup(agentDirectory, "exact");
            if (manifest.source.schemaVersion === agentEngineSchema.version) {
              latest.push(agentDirectory);
            }
          }
          expect(latest).toHaveLength(1);
          using image = openNodeSqliteDatabase(path.join(latest[0]!, "database.sqlite"), {
            readOnly: true,
          });
          expect(
            image
              .prepare(
                "SELECT entry_json FROM session_nodes WHERE session_key = 'agent:main:repair'",
              )
              .get()?.entry_json,
          ).toBe(raw);
          // A retry starts at current schema and must capture the newer entry, not reuse
          // either the migration predecessor or the first repair's exact backup.
          const laterRaw = JSON.stringify({
            ...JSON.parse(raw),
            pendingFinalDeliveryText: "later reply",
          });
          await client.query(
            `UPDATE "${agentNamespace}".session_nodes SET entry_json = $1 WHERE session_key = 'agent:main:repair'`,
            [laterRaw],
          );
          const earlierCurrent = new Set(fs.readdirSync(path.dirname(agentPath)));
          const noMigration = await prepareDoctorDatabaseMigrations({
            env,
            pendingDatabasePaths: [],
            databasePaths: [pathname, agentPath],
          });
          expect(noMigration.changes).toEqual([]);
          await expect(
            repairLegacySessionEntryStates({
              apply: true,
              cfg: config,
              env,
              targets: [{ agentId: "main", storePath: agentPath, sqlitePath: agentPath }],
            }),
          ).resolves.toEqual({ found: 1, repaired: 1, scannedStores: 1 });
          expect(JSON.parse(String(await readEntry())).pendingFinalDelivery).toEqual({
            kind: "replayable",
            text: "later reply",
            createdAt: 42,
          });
          const retryBackups = fs
            .readdirSync(path.dirname(agentPath))
            .filter((name) => name.endsWith(".postgres.bak") && !earlierCurrent.has(name));
          expect(retryBackups).toHaveLength(1);
          const retryDirectory = path.join(path.dirname(agentPath), retryBackups[0]!);
          const retryManifest = await verifyMatchedPostgresBackup(retryDirectory, "exact");
          expect(retryManifest.source.schemaVersion).toBe(agentEngineSchema.version);
          using retryImage = openNodeSqliteDatabase(path.join(retryDirectory, "database.sqlite"), {
            readOnly: true,
          });
          expect(
            retryImage
              .prepare(
                "SELECT entry_json FROM session_nodes WHERE session_key = 'agent:main:repair'",
              )
              .get()?.entry_json,
          ).toBe(laterRaw);
        });
      } finally {
        await lock!.release();
      }
    },
  );
}
