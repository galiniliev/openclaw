#!/usr/bin/env node
// One-time G119 dialect conversion. This is deliberately not a runtime admission fallback.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadRetainedEvidence, prepareRetainedProjection } from "./bindings.mjs";

const runtimeCommit = "c60205cbe0d4d1f13471eeedd807058aa19525a2";
const schemaCommit = "88e813334f08ac0abb4171f199819d15271f40e2";
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const changedStateTables = [
  "worker_environments",
  "worker_session_placements",
  "worker_workspace_pending_results",
  "session_repository_workspaces",
];
const receiptFields = ["operation_digest", "request_fingerprint", "session_id", "expires_at"];
const selectedRetirements = (entries, store) =>
  entries.filter((entry) => entry.namespace === store.namespace && entry.storeId === store.storeId);

function readRetirements(input) {
  if (!input.retirementManifest) {
    return [];
  }
  const bytes = fs.readFileSync(input.retirementManifest.path);
  assert.equal(
    sha256(bytes),
    input.retirementManifest.sha256,
    "Approved retirement manifest changed",
  );
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.entries.length, 5, "This task authorizes exactly five legacy retirements");
  const unique = new Set();
  return manifest.entries.map((entry) => {
    assert(
      input.stores.some(
        (store) =>
          store.family === "agent" &&
          store.namespace === entry.namespace &&
          store.storeId === entry.storeId,
      ),
      "Retirement outside selected agent stores",
    );
    for (const field of receiptFields.slice(0, 3)) {
      assert(typeof entry[field] === "string" && entry[field].length > 0);
    }
    assert(
      /^[a-f0-9]{64}$/u.test(entry.operation_digest) &&
        /^[a-f0-9]{64}$/u.test(entry.request_fingerprint),
    );
    assert(
      /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        entry.session_id,
      ),
    );
    const expires_at = Number(entry.expires_at);
    assert(
      Number.isSafeInteger(expires_at) && expires_at > 0,
      "Retirement expiry must be epoch milliseconds",
    );
    const key = JSON.stringify([entry.namespace, entry.storeId, entry.operation_digest]);
    assert(!unique.has(key), "Duplicate retirement");
    unique.add(key);
    return {
      namespace: entry.namespace,
      storeId: entry.storeId,
      operation_digest: entry.operation_digest,
      request_fingerprint: entry.request_fingerprint,
      session_id: entry.session_id,
      expires_at,
    };
  });
}

function saveReceipt(directory, name, value) {
  const filename = path.join(directory, name);
  const descriptor = fs.openSync(filename, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const parent = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
}

function columns(sql, table) {
  const declaration = sql.match(new RegExp(`CREATE TABLE "${table}" \\([\\s\\S]*?\\n\\);`))?.[0];
  assert(declaration, `Missing declared table ${table}`);
  return {
    declaration,
    names: [
      ...declaration.matchAll(/^ {2}"(\w+)" (?:text|bigint|bytea|double precision)\b/gmu),
    ].map((match) => match[1]),
  };
}

// Every SELECT below runs after the normal Native source-schema admission. Values stay private.
function inspectSource(db, store, cutoff, retirements, retainedEvidence, validators) {
  const tables = new Set(
    db
      .prepare("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = ?")
      .all(store.namespace)
      .map((row) => row.tablename),
  );
  if (store.family === "agent") {
    const receipts = db
      .prepare("SELECT * FROM session_creation_operations ORDER BY operation_digest")
      .all();
    const selected = selectedRetirements(retirements, store);
    for (const entry of selected) {
      const actual = receipts.find((row) => row.operation_digest === entry.operation_digest);
      assert(
        actual && receiptFields.every((field) => actual[field] === entry[field]),
        "Approved retirement does not match the complete original receipt",
      );
    }
    assert(
      receipts.every(
        (row) =>
          Number.isSafeInteger(row.expires_at) &&
          (row.expires_at <= cutoff ||
            selected.some((entry) => entry.operation_digest === row.operation_digest)),
      ),
      "Unexpired legacy creation receipts outside the approved retirement set",
    );
    return {
      tables,
      digest: sha256(JSON.stringify(receipts)),
      expiredReceipts: receipts.filter((row) => row.expires_at <= cutoff).length,
      retirements: selected,
    };
  }
  const rows = {};
  for (const table of changedStateTables) {
    if (tables.has(table)) {
      rows[table] = db.prepare(`SELECT * FROM ${quote(table)} ORDER BY 1`).all();
    }
  }
  assert(
    !(rows.worker_workspace_pending_results ?? []).some((row) => row.disk_authority_json !== null),
    "Pending legacy disk custody needs its owning recovery before conversion",
  );
  assert(
    !(rows.worker_session_placements ?? []).some((row) => row.repository_preparation !== null),
    "Historical repository preparation needs its owning recovery before conversion",
  );
  const projection = prepareRetainedProjection(rows, retainedEvidence, validators);
  return { tables, digest: sha256(JSON.stringify(rows)), expiredReceipts: 0, projection };
}

function stateMigration(db, store, source, target, inspected) {
  // Read declarations only; the Native owner decides which fragments are admitted. This
  // conversion neither activates absent tables nor duplicates its dependency-selection policy.
  const sql = [target.postgres, ...target.postgresFragments.map((fragment) => fragment.sql)].join(
    "\n",
  );
  const before = [
    source.postgres,
    ...source.postgresFragments.map((fragment) => fragment.sql),
  ].join("\n");
  const rebuilding = changedStateTables.filter((table) => inspected.tables.has(table));
  const statements = [];
  // Copy first, then replace only the affected tables. No namespace swap, CASCADE, or catalog edit.
  for (const table of rebuilding) {
    statements.push(
      `CREATE TEMP TABLE ${quote(`g119_${table}`)} ON COMMIT DROP AS TABLE ${quote(table)};`,
    );
  }
  const foreignKeys = db
    .prepare(`SELECT relation.relname AS source, constraint_record.conname AS name
    FROM pg_catalog.pg_constraint constraint_record
    JOIN pg_catalog.pg_class relation ON relation.oid = constraint_record.conrelid
    JOIN pg_catalog.pg_namespace relation_namespace ON relation_namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_class referenced ON referenced.oid = constraint_record.confrelid
    JOIN pg_catalog.pg_namespace referenced_namespace ON referenced_namespace.oid = referenced.relnamespace
    WHERE constraint_record.contype = 'f' AND referenced_namespace.nspname = ?
      AND referenced.relname IN (${rebuilding.map(literal).join(",")})
      AND relation_namespace.nspname = ?`)
    .all(store.namespace, store.namespace);
  for (const key of foreignKeys) {
    statements.push(`ALTER TABLE ${quote(key.source)} DROP CONSTRAINT ${quote(key.name)};`);
  }
  // Outside dependencies remain a hard PostgreSQL refusal; they are never removed with CASCADE.
  for (const table of rebuilding.toReversed()) {
    statements.push(`DROP TABLE ${quote(table)};`);
  }
  for (const table of rebuilding) {
    const current = columns(sql, table);
    const original = columns(before, table);
    const select = current.names.map((name) => {
      // disk_authority_json keeps its name but changes its contract. Map it before
      // the generic same-name copy so old bindings never bypass Native validation.
      const projection =
        table === "worker_environments"
          ? {
              key: "environment_id",
              entries: inspected.projection.environments,
              field:
                name === "resource_receipt_json"
                  ? "resourceReceiptJson"
                  : name === "retention_json"
                    ? "retentionJson"
                    : undefined,
            }
          : table === "session_repository_workspaces" && name === "disk_authority_json"
            ? {
                key: "workspace_id",
                entries: inspected.projection.workspaces,
                field: "diskAuthorityJson",
              }
            : undefined;
      if (projection?.field) {
        const { key, entries, field } = projection;
        return entries.size
          ? `CASE ${quote(key)} ${[...entries]
              .map(([id, value]) => `WHEN ${literal(id)} THEN ${literal(value[field])}`)
              .join(" ")} ELSE NULL END`
          : "NULL";
      }
      if (original.names.includes(name)) {
        return quote(name);
      }
      if (name === "provision_source_json") {
        return `CASE WHEN (state IN ('requested', 'provisioning') AND lease_id IS NULL)
          OR (state = 'bootstrapping' AND owner_epoch = 0)
          THEN '{"kind":"unavailable"}' ELSE NULL END`;
      }
      assert(
        ["resource_receipt_json", "retention_json", "repository_disk_authority_json"].includes(
          name,
        ),
        `Unmapped canonical column ${table}.${name}`,
      );
      return "NULL";
    });
    const names = current.names.map(quote).join(",");
    statements.push(current.declaration);
    statements.push(`INSERT INTO ${quote(table)} (${names}) SELECT ${select.join(",")}
      FROM ${quote(`g119_${table}`)};`);
    // Independent PostgreSQL bag comparison detects missing/duplicated rows, including NULLs.
    statements.push(`DO $preserved$ BEGIN IF EXISTS (
      (SELECT ${select.join(",")} FROM ${quote(`g119_${table}`)} EXCEPT ALL SELECT ${names} FROM ${quote(table)})
      UNION ALL
      (SELECT ${names} FROM ${quote(table)} EXCEPT ALL SELECT ${select.join(",")} FROM ${quote(`g119_${table}`)})
      ) THEN RAISE EXCEPTION 'G119 row preservation failed'; END IF; END $preserved$;`);
  }
  for (const match of sql.matchAll(/CREATE (?:UNIQUE )?INDEX "\w+" ON "(\w+)"[^;]*;/gu)) {
    if (rebuilding.includes(match[1])) {
      statements.push(match[0]);
    }
  }
  for (const match of sql.matchAll(
    /ALTER TABLE "(\w+)" ADD FOREIGN KEY[^;]* REFERENCES "(\w+)"[^;]*;/gu,
  )) {
    if (
      inspected.tables.has(match[1]) &&
      inspected.tables.has(match[2]) &&
      (rebuilding.includes(match[1]) || rebuilding.includes(match[2]))
    ) {
      statements.push(match[0]);
    }
  }
  if (inspected.tables.has("workspace_setup_state")) {
    statements.push("ALTER TABLE workspace_setup_state ADD COLUMN bootstrap_deferred bigint;");
  }
  return statements.join("\n");
}

function bridgeSchema(db, store, schemas, inspected, cutoff) {
  const source = schemas.source[store.family];
  const target = schemas.target[store.family];
  const versionSql = (version) => `UPDATE schema_meta SET schema_version = ${version},
    app_version = '2026.11.3', updated_at = ${cutoff} WHERE meta_key = 'primary';`;
  if (store.family === "agent") {
    const approved = inspected.retirements.map(
      (entry) =>
        `(${receiptFields
          .map(
            (field) =>
              `${quote(field)} = ${field === "expires_at" ? entry[field] : literal(entry[field])}`,
          )
          .join(" AND ")})`,
    );
    const steps = target.postgresMigrations.map((step, index) => ({
      ...step,
      ...(index === 0
        ? {
            fromSchema: source,
            sql: `DELETE FROM session_creation_operations WHERE expires_at <= ${cutoff}${approved.length ? ` OR ${approved.join(" OR ")}` : ""};
          DO $empty$ BEGIN IF EXISTS (SELECT FROM session_creation_operations)
          THEN RAISE EXCEPTION 'Legacy creation receipts remain'; END IF; END $empty$;
          DROP TABLE session_creation_operations;\n${step.sql}`,
          }
        : {}),
    }));
    return { ...target, postgresMigrations: steps };
  }
  const transform = stateMigration(db, store, source, target, inspected);
  // The Native runner requires consecutive steps. All four run in ONE outer owner transaction;
  // only the final step changes DDL, and only canonical state41 can be committed.
  return {
    ...target,
    postgresMigrations: [38, 39, 40, 41].map((version) => ({
      version,
      fromSchema: source,
      schema: version === 41 ? target : source,
      sql: `${version === 41 ? transform : ""}\n${versionSql(version)}
        INSERT INTO config_machine_state(state_key,value_json,updated_at_ms)
        VALUES('state.schema.contentVersion','${version}',${cutoff})
        ON CONFLICT(state_key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at_ms=EXCLUDED.updated_at_ms;`,
    })),
  };
}

async function main() {
  const [mode, inputPath, outputDirectory] = process.argv.slice(2);
  assert(
    ["--preflight", "--apply"].includes(mode) && inputPath && outputDirectory,
    "Usage: migrate.mjs --preflight|--apply INPUT.json NEW_RECEIPT_DIRECTORY",
  );
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  const completed = [];
  try {
    const inputBytes = fs.readFileSync(inputPath);
    const input = JSON.parse(inputBytes);
    assert.equal(input.version, 1);
    assert(
      input.stores?.length && input.stores.filter((store) => store.family === "state").length === 1,
    );
    const unique = new Set();
    for (const store of input.stores) {
      assert(["state", "agent"].includes(store.family));
      assert(
        typeof store.namespace === "string" &&
          store.namespace.length > 0 &&
          !store.namespace.includes("\0"),
      );
      assert(typeof store.storeId === "string" && store.storeId.length > 0);
      assert(path.isAbsolute(store.anchorPath));
      assert(!unique.has(store.namespace));
      unique.add(store.namespace);
    }
    const retirements = readRetirements(input);
    const build = JSON.parse(
      fs.readFileSync(path.join(input.runtimeRoot, "dist/build-info.json"), "utf8"),
    );
    assert.equal(
      build.commit,
      runtimeCommit,
      "Use the qualified runtimec60205 and its matching workers",
    );
    const manifest = fs.readFileSync(input.backupManifest.path);
    assert.equal(sha256(manifest), input.backupManifest.sha256, "Fresh backup receipt changed");
    const schemasBytes = fs.readFileSync(new URL("./schemas.json", import.meta.url));
    const schemaManifest = JSON.parse(
      fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
    );
    assert.equal(schemaManifest.pins.source, "fdd4a988929c653a24f1ac791837d65f98f7a0ec");
    assert.equal(schemaManifest.pins.target, schemaCommit);
    assert.equal(schemaManifest.pins.runtime, runtimeCommit);
    assert.equal(schemaManifest.schemas.sha256, sha256(schemasBytes));
    const schemas = JSON.parse(schemasBytes);
    const connection = process.env.OPENCLAW_MAINTENANCE_PG_URL;
    assert(connection, "Missing OPENCLAW_MAINTENANCE_PG_URL secret environment variable");
    const sdk = await import(
      pathToFileURL(
        path.join(input.runtimeRoot, "dist/plugin-sdk/database-engine-worker-runtime.js"),
      ).href
    );
    const requireRuntime = createRequire(path.join(input.runtimeRoot, "package.json"));
    const validatorUrl = new URL("./validators.mjs", import.meta.url);
    assert.equal(sha256(fs.readFileSync(validatorUrl)), schemaManifest.validators.sha256);
    const { bindNativeValidators } = await import(validatorUrl.href);
    const { isRecord } = await import(
      pathToFileURL(path.join(input.runtimeRoot, "dist/plugin-sdk/string-coerce-runtime.js")).href
    );
    const validators = bindNativeValidators({ z: requireRuntime("zod").z, isRecord });
    const retainedEvidence = input.retainedEvidence
      ? await loadRetainedEvidence(
          input.retainedEvidence,
          input.stores.find((store) => store.family === "state"),
        )
      : undefined;
    const { Client } = requireRuntime("pg");
    const router = new Client({ connectionString: connection });
    const versions = new Map();
    await router.connect();
    try {
      await router.query("BEGIN READ ONLY");
      for (const store of input.stores) {
        const { rows } = await router.query(
          `SELECT version, store_id FROM ${quote(store.namespace)}.openclaw_schema_meta WHERE store=$1`,
          [store.family],
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].store_id, store.storeId);
        versions.set(store.namespace, Number(rows[0].version));
      }
    } finally {
      await router.end();
    }
    const cutoff = Date.now();
    const open = (store, schema, readOnly, operation, beforeMigrate) =>
      sdk.withEngineStoreAdmission(() => {
        const anchor = new DatabaseSync(store.anchorPath, { readOnly: true });
        let db;
        try {
          const rows = anchor
            .prepare("SELECT store_id,engine,schema FROM openclaw_engine_anchor")
            .all();
          assert.equal(rows.length, 1);
          assert.deepEqual(
            { ...rows[0] },
            { store_id: store.storeId, engine: "postgres", schema: store.namespace },
          );
          db = sdk.openEngineStore({
            anchor,
            schema,
            input: {
              connection,
              schemaPrefix: "openclaw",
              ...(readOnly ? { readOnly: true } : {}),
            },
            existingOnly: true,
            inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: true }),
            // The existing, verified anchor is already open read-only; there is no file preparation.
            prepareAnchor: () => {},
            openSqlite: () => {
              throw new Error("PostgreSQL only");
            },
            beforeMigrate,
          });
          return operation(db);
        } finally {
          db?.close();
          anchor.close();
        }
      });
    const plans = [];
    for (const store of input.stores) {
      const source = schemas.source[store.family];
      const target = schemas.target[store.family];
      const version = versions.get(store.namespace);
      assert(
        version === source.version || version === target.version,
        "Unknown predecessor version",
      );
      plans.push(
        open(store, version === target.version ? target : source, true, (db) => {
          if (version === target.version) {
            for (const entry of selectedRetirements(retirements, store)) {
              assert(
                !db
                  .prepare("SELECT 1 FROM session_creation_operations WHERE operation_digest = ?")
                  .get(entry.operation_digest),
                "Canonical store still contains an approved legacy digest; reconcile retirement",
              );
            }
            return { store, alreadyCurrent: true };
          }
          const inspected = inspectSource(
            db,
            store,
            cutoff,
            retirements,
            retainedEvidence,
            validators,
          );
          return { store, inspected, schema: bridgeSchema(db, store, schemas, inspected, cutoff) };
        }),
      );
    }
    const receipt = {
      runtimeCommit,
      cutoff,
      mode,
      inputSha256: sha256(inputBytes),
      schemasSha256: sha256(schemasBytes),
      validatorsSha256: schemaManifest.validators.sha256,
      retirementManifestSha256: input.retirementManifest?.sha256,
      stores: plans.map(({ store, inspected, alreadyCurrent }) => ({
        family: store.family,
        namespace: store.namespace,
        storeId: store.storeId,
        alreadyCurrent: alreadyCurrent === true,
        expiredReceipts: inspected?.expiredReceipts ?? 0,
        retiredReceipts: inspected?.retirements?.length ?? 0,
        retainedEnvironments: inspected?.projection?.environments.size ?? 0,
        diskBindings: inspected?.projection?.workspaces.size ?? 0,
      })),
    };
    const originals = plans.flatMap(({ inspected }) => inspected?.projection?.originals ?? []);
    if (originals.length) {
      saveReceipt(outputDirectory, "retained-originals.private.json", {
        version: 1,
        evidence: input.retainedEvidence,
        entries: originals,
      });
    }
    if (retirements.length) {
      // Named private archival artifact, durable BEFORE any store commit. On resume the input
      // retains the originals, while exact canonical admission reconciles already committed stores.
      saveReceipt(outputDirectory, "approved-retirements.private.json", {
        version: 1,
        inputManifestSha256: input.retirementManifest.sha256,
        entries: retirements,
      });
    }
    saveReceipt(outputDirectory, "preflight.json", receipt);
    if (mode === "--apply") {
      for (const plan of plans) {
        if (!plan.alreadyCurrent) {
          open(
            plan.store,
            plan.schema,
            false,
            () => {},
            (db, from) => {
              if (from !== schemas.source[plan.store.family].version) {
                return;
              }
              const locking =
                plan.store.family === "agent"
                  ? ["session_creation_operations"]
                  : changedStateTables.filter((table) => plan.inspected.tables.has(table));
              db.exec(`LOCK TABLE ${locking.map(quote).join(",")} IN ACCESS EXCLUSIVE MODE`);
              const current = inspectSource(
                db,
                plan.store,
                cutoff,
                retirements,
                retainedEvidence,
                validators,
              );
              assert.equal(
                current.digest,
                plan.inspected.digest,
                "Source changed after all-store preflight",
              );
            },
          );
        }
        // A crash after COMMIT but before this receipt is reconciled through current Native admission.
        completed.push(plan.store.namespace);
        saveReceipt(outputDirectory, `store-${completed.length}.json`, {
          namespace: plan.store.namespace,
          family: plan.store.family,
          version: schemas.target[plan.store.family].version,
          alreadyCurrent: plan.alreadyCurrent === true,
        });
      }
    }
    saveReceipt(outputDirectory, "result.json", { ...receipt, completed, outcome: "success" });
    process.stdout.write(
      `${JSON.stringify({ outcome: "success", mode, stores: plans.length, completed: completed.length })}\n`,
    );
  } catch (error) {
    saveReceipt(outputDirectory, "failure.json", {
      outcome: "failed",
      completed,
      reconciliationRequired: true,
      error: error instanceof Error ? error.stack : String(error),
    });
    // PostgreSQL diagnostics can contain row values. Keep them in the private evidence directory.
    process.stderr.write(
      "Migration refused or failed; inspect private failure.json and reconcile each store before retry.\n",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
