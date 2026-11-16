#!/usr/bin/env node
// Explicit opt-in integration rehearsal. Creates new namespaces only on a DISPOSABLE PG17.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { rehearseRetainedBindings } from "./rehearse-retained.mjs";

const [artifact, runtimeRoot, directory] = process.argv
  .slice(2)
  .map((value) => path.resolve(value));
const connection = process.env.OPENCLAW_MAINTENANCE_REHEARSAL_PG_URL;
assert(
  connection && artifact && runtimeRoot && directory,
  "Use REHEARSAL_PG_URL and rehearse.mjs ARTIFACT RUNTIME NEW_DIRECTORY; disposable PG17 only",
);
fs.mkdirSync(directory, { mode: 0o700 });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const sdk = await import(
  pathToFileURL(path.join(runtimeRoot, "dist/plugin-sdk/database-engine-worker-runtime.js")).href
);
const { Client } = createRequire(path.join(runtimeRoot, "package.json"))("pg");
const schemas = JSON.parse(fs.readFileSync(path.join(artifact, "schemas.json")));
const seed = (name) => fs.readFileSync(new URL(`./fixtures/${name}.sql`, import.meta.url), "utf8");
const client = new Client({ connectionString: connection });
await client.connect();
assert.equal(
  Math.floor(
    Number((await client.query("SHOW server_version_num")).rows[0].server_version_num) / 10000,
  ),
  17,
);
// The disposable server needs the same supported keyword-search prerequisites as production.
await client.query(
  "CREATE EXTENSION IF NOT EXISTS unaccent; CREATE EXTENSION IF NOT EXISTS pg_trgm;",
);
const cases = [];

async function fixture(name, allStateFragments = false) {
  const root = path.join(directory, name);
  fs.mkdirSync(root);
  const stores = [];
  for (const [family, rich] of [
    ["state", false],
    ["agent", false],
    ["agent", true],
  ]) {
    const anchorPath = path.join(root, `${family}-${stores.length}.sqlite`);
    const anchor = new DatabaseSync(anchorPath);
    const source = schemas.source[family];
    if (rich) {
      const historical = JSON.parse(
        fs.readFileSync(path.join(artifact, "fixture-agent39-rich.json")),
      );
      const storeId = randomUUID();
      const namespace = `rehearsal_agent_${storeId.replaceAll("-", "").slice(0, 16)}`;
      anchor.exec(
        "CREATE TABLE openclaw_engine_anchor(store_id TEXT NOT NULL,engine TEXT NOT NULL CHECK(engine='postgres'),schema TEXT NOT NULL)",
      );
      anchor
        .prepare("INSERT INTO openclaw_engine_anchor VALUES(?, 'postgres', ?)")
        .run(storeId, namespace);
      await client.query("BEGIN");
      try {
        await client.query(`CREATE SCHEMA ${quote(namespace)}; SET LOCAL search_path=${quote(namespace)};
          CREATE TABLE openclaw_schema_meta(store TEXT PRIMARY KEY, version BIGINT NOT NULL,store_id TEXT NOT NULL,
            fingerprint TEXT,ddl_hash TEXT,server_major BIGINT,search_extensions TEXT);
          ${historical.sql.replaceAll("openclaw_schema", namespace)}
${seed(family)}`);
        await client.query(
          `INSERT INTO ${quote(namespace)}.openclaw_schema_meta(store,version,store_id,search_extensions)
          VALUES('agent',39,$1,$2)`,
          [storeId, JSON.stringify(historical.extensions)],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    sdk.withEngineStoreAdmission(() => {
      const schema = {
        ...source,
        ...(family === "state"
          ? {
              postgresFragments: source.postgresFragments.map((fragment) =>
                Object.assign({}, fragment, {
                  activation:
                    allStateFragments ||
                    fragment.tables.some((table) =>
                      [
                        "session_repository_workspaces",
                        "github_repository_publication_requests",
                      ].includes(table),
                    )
                      ? "version-additive"
                      : fragment.activation,
                }),
              ),
            }
          : {}),
      };
      // A fresh historical rich fixture starts unsealed. Native performs its full scratch-DDL
      // comparison and publishes the original seal; no existing seal is reset or copied.
      const db = sdk.openEngineStore({
        anchor,
        schema,
        input: {
          connection,
          schemaPrefix: `rehearsal_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        },
        existingOnly: rich,
        inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: rich }),
        prepareAnchor: () => {},
        openSqlite: () => {
          throw new Error("PG only");
        },
        ...(rich
          ? {}
          : {
              admitPostgres(database, fresh) {
                assert(fresh);
                database.exec(seed(family));
              },
            }),
      });
      db.close();
    });
    const identity = anchor.prepare("SELECT * FROM openclaw_engine_anchor").get();
    anchor.close();
    stores.push({ family, anchorPath, storeId: identity.store_id, namespace: identity.schema });
  }
  const before = await snapshot(stores);
  const backupPath = path.join(root, "synthetic-source-backup.json");
  const bytes = Buffer.from(`${JSON.stringify(before)}\n`);
  fs.writeFileSync(backupPath, bytes, { mode: 0o600 });
  const input = {
    version: 1,
    runtimeRoot,
    stores,
    backupManifest: { path: backupPath, sha256: sha(bytes) },
  };
  return { root, input, before };
}

async function snapshot(stores) {
  const result = [];
  for (const store of stores) {
    const tables = (
      await client.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [
        store.namespace,
      ])
    ).rows;
    const rows = {};
    for (const { tablename } of tables) {
      rows[tablename] = (
        await client.query(
          `SELECT row_to_json(row)::text AS row FROM ${quote(store.namespace)}.${quote(tablename)} row ORDER BY row_to_json(row)::text COLLATE "C"`,
        )
      ).rows.map(({ row }) => row);
    }
    result.push(rows);
  }
  return result;
}

function run(scenario, label, mode, stores = scenario.input.stores) {
  const inputPath = path.join(scenario.root, `${label}-input.json`);
  fs.writeFileSync(inputPath, JSON.stringify({ ...scenario.input, stores }));
  const output = path.join(scenario.root, label);
  const child = spawnSync(
    process.execPath,
    [path.join(artifact, "migrate.mjs"), mode, inputPath, output],
    {
      env: { ...process.env, OPENCLAW_MAINTENANCE_PG_URL: connection },
      encoding: "utf8",
      timeout: 120000,
    },
  );
  fs.writeFileSync(path.join(scenario.root, `${label}.log`), child.stdout + child.stderr);
  return { status: child.status, output };
}

async function retirementFixture(name, extra = false) {
  const scenario = await fixture(name);
  const store = scenario.input.stores[2];
  const receipts = [];
  for (let index = 1; index <= (extra ? 6 : 5); index++) {
    const sessionId = `01a1dc80-f000-7000-8000-00000000000${index}`;
    const row = {
      operation_digest: sha(`old-operation-${index}`),
      request_fingerprint: sha(`old-fingerprint-${index}`),
      session_id: sessionId,
      expires_at: 1797292800000,
    };
    await client.query(
      `INSERT INTO ${quote(store.namespace)}.session_creation_operations
      VALUES($1,$2,$3,$4)`,
      Object.values(row),
    );
    await client.query(
      `INSERT INTO ${quote(store.namespace)}.session_nodes
      (session_key,current_session_id,entry_json,updated_at,entry_valid)
      VALUES($1,$2,$3,1794700800000,1)`,
      [
        `agent:main:dashboard:${sessionId}`,
        sessionId,
        JSON.stringify({ sessionId, updatedAt: 1794700800000 }),
      ],
    );
    if (index <= 5) {
      receipts.push({ namespace: store.namespace, storeId: store.storeId, ...row });
    }
  }
  scenario.before = await snapshot(scenario.input.stores);
  const backup = Buffer.from(JSON.stringify(scenario.before));
  fs.writeFileSync(scenario.input.backupManifest.path, backup);
  scenario.input.backupManifest.sha256 = sha(backup);
  const manifestPath = path.join(scenario.root, "approved-retirements.private.json");
  const bytes = Buffer.from(JSON.stringify({ version: 1, entries: receipts }));
  fs.writeFileSync(manifestPath, bytes, { mode: 0o600 });
  scenario.input.retirementManifest = { path: manifestPath, sha256: sha(bytes) };
  return { scenario, receipts };
}

try {
  // A valid receipt in the LAST store must prevent the earlier shared state from committing.
  const valid = await fixture("valid-receipt");
  await client.query(`SET search_path=${quote(valid.input.stores[2].namespace)}`);
  await client.query(seed("valid-receipt"));
  const validBefore = await snapshot(valid.input.stores);
  const blocked = run(valid, "refused", "--apply");
  assert.equal(blocked.status, 1);
  assert.match(
    JSON.parse(fs.readFileSync(path.join(blocked.output, "failure.json"))).error,
    /Unexpired legacy/,
  );
  assert.deepEqual(await snapshot(valid.input.stores), validBefore);
  cases.push("valid receipt blocks all stores without effects");

  const drift = await fixture("unknown-catalog");
  await client.query(
    `CREATE INDEX fixture_unknown_index ON ${quote(drift.input.stores[2].namespace)}.session_nodes(display_name)`,
  );
  const driftBefore = await snapshot(drift.input.stores);
  const refused = run(drift, "refused", "--apply");
  assert.equal(refused.status, 1);
  assert.match(
    JSON.parse(fs.readFileSync(path.join(refused.output, "failure.json"))).error,
    /schema drift/,
  );
  assert.deepEqual(await snapshot(drift.input.stores), driftBefore);
  cases.push("unknown final-store catalog blocks all stores without effects");

  const happy = await fixture("preservation-and-resume", true);
  const anchors = happy.input.stores.map((store) => sha(fs.readFileSync(store.anchorPath)));
  const checked = run(happy, "preflight", "--preflight");
  assert.equal(checked.status, 0);
  assert.deepEqual(await snapshot(happy.input.stores), happy.before);
  // A real committed first store models a stopped job. The next invocation must admit it as current.
  assert.equal(run(happy, "first-store", "--apply", [happy.input.stores[0]]).status, 0);
  const applied = run(happy, "resume-all", "--apply");
  assert.equal(applied.status, 0);
  const after = await snapshot(happy.input.stores);
  for (const [index, original] of happy.before.entries()) {
    const current = after[index];
    for (const [table, rows] of Object.entries(original)) {
      if (
        [
          "schema_meta",
          "openclaw_schema_meta",
          "config_machine_state",
          "session_creation_operations",
        ].includes(table)
      ) {
        continue;
      }
      if (
        [
          "worker_environments",
          "worker_session_placements",
          "worker_workspace_pending_results",
          "session_repository_workspaces",
        ].includes(table)
      ) {
        const projected = current[table].map((row) => {
          const value = JSON.parse(row);
          delete value.resource_receipt_json;
          delete value.retention_json;
          delete value.provision_source_json;
          delete value.repository_disk_authority_json;
          if (table === "worker_environments") {
            value.session_retention_json = null;
          }
          if (table === "worker_session_placements") {
            value.repository_preparation = null;
          }
          if (table === "worker_workspace_pending_results") {
            value.disk_authority_json = null;
          }
          return Object.fromEntries(
            Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)),
          );
        });
        const expected = rows.map((row) =>
          Object.fromEntries(
            Object.entries(JSON.parse(row)).toSorted(([a], [b]) => a.localeCompare(b)),
          ),
        );
        assert.deepEqual(projected, expected, `Preserved custody and provenance in ${table}`);
      } else {
        assert.deepEqual(current[table], rows, `Preserved ${table}`);
      }
    }
    const meta = current.openclaw_schema_meta.map(JSON.parse);
    assert.equal(Number(meta[0].version), index === 0 ? 41 : 42);
    assert.equal(meta[0].store_id, happy.input.stores[index].storeId);
    const applicationMeta = JSON.parse(current.schema_meta[0]);
    assert.equal(Number(applicationMeta.schema_version), index === 0 ? 41 : 42);
    assert.equal(applicationMeta.app_version, "2026.11.3");
    for (const key of ["meta_key", "role", "agent_id", "created_at"]) {
      assert.deepEqual(applicationMeta[key], JSON.parse(original.schema_meta[0])[key]);
    }
    if (index === 0) {
      assert.equal(
        current.config_machine_state
          .map(JSON.parse)
          .find((row) => row.state_key === "state.schema.contentVersion").value_json,
        "41",
      );
    }
    if (index !== 0) {
      assert.deepEqual(current.session_creation_operations, []);
      const sequence = await client.query(
        `SELECT last_value FROM ${quote(happy.input.stores[index].namespace)}.memory_index_sources_id_seq`,
      );
      // The fixture uses explicit IDs, so test the unchanged allocation state, not max(id).
      assert.equal(Number(sequence.rows[0].last_value), 1);
    }
  }
  assert.deepEqual(
    happy.input.stores.map((store) => sha(fs.readFileSync(store.anchorPath))),
    anchors,
  );
  assert.equal(run(happy, "all-current", "--apply").status, 0);
  assert.deepEqual(await snapshot(happy.input.stores), after);
  cases.push(
    "three dialects preserve nonempty custody, personal publication, sessions, transcripts, memory and anchors",
  );
  cases.push(
    "naturally expired receipts removed; partial and completed runs resume through canonical admission",
  );
  const extra = await retirementFixture("extra-live-receipt", true);
  const rejectedExtra = run(extra.scenario, "refused", "--apply");
  assert.equal(rejectedExtra.status, 1);
  assert.match(
    JSON.parse(fs.readFileSync(path.join(rejectedExtra.output, "failure.json"))).error,
    /Unexpired legacy/,
  );
  assert.deepEqual(await snapshot(extra.scenario.input.stores), extra.scenario.before);

  const approved = await retirementFixture("approved-five");
  const mismatched = structuredClone(approved.receipts);
  mismatched[0].request_fingerprint = sha("wrong-fingerprint");
  const mismatchedBytes = Buffer.from(JSON.stringify({ version: 1, entries: mismatched }));
  const correctBytes = fs.readFileSync(approved.scenario.input.retirementManifest.path);
  fs.writeFileSync(approved.scenario.input.retirementManifest.path, mismatchedBytes);
  approved.scenario.input.retirementManifest.sha256 = sha(mismatchedBytes);
  const mismatch = run(approved.scenario, "mismatch", "--apply");
  assert.equal(mismatch.status, 1);
  assert.match(
    JSON.parse(fs.readFileSync(path.join(mismatch.output, "failure.json"))).error,
    /complete original receipt/,
  );
  assert.deepEqual(await snapshot(approved.scenario.input.stores), approved.scenario.before);
  fs.writeFileSync(approved.scenario.input.retirementManifest.path, correctBytes);
  approved.scenario.input.retirementManifest.sha256 = sha(correctBytes);
  const retired = run(approved.scenario, "retired", "--apply");
  assert.equal(retired.status, 0);
  const archive = JSON.parse(
    fs.readFileSync(path.join(retired.output, "approved-retirements.private.json")),
  );
  assert.deepEqual(archive.entries, approved.receipts);
  const retirementAfter = await snapshot(approved.scenario.input.stores);
  assert.deepEqual(retirementAfter[2].session_creation_operations, []);
  assert.deepEqual(retirementAfter[2].session_nodes, approved.scenario.before[2].session_nodes);
  assert.equal(run(approved.scenario, "resume-retired", "--apply").status, 0);
  assert.deepEqual(await snapshot(approved.scenario.input.stores), retirementAfter);
  cases.push(
    "exact five live receipts archived and retired; changed tuple or sixth live receipt blocks all stores; sessions and resume preserved",
  );
  await rehearseRetainedBindings({
    fixture,
    client,
    snapshot,
    run,
    directory,
    artifact,
    runtimeRoot,
    cases,
    sha,
    quote,
  });
  const receipt = {
    outcome: "success",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    postgres: 17,
    cases,
    scope:
      "Schema, five-receipt retirement and retained JSON conversion through actual Native PG17 admission. Synthetic evidence only; no Gateway/model/cloud proof.",
  };
  fs.writeFileSync(path.join(directory, "rehearsal.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
} finally {
  await client.end();
}
