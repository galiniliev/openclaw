#!/usr/bin/env node
// One-time empty-control-plane G119 node repair. Never a runtime schema fallback.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtimeCommit = "ac6601fc0d3fd97d6000c4b07d872798ce3bc31c";
// sqlite_schema SQL from pinned fdd4a988929c653a24f1ac791837d65f98f7a0ec.
const workerTableHash = "4a7fd5ecf8530c7096211fc8ba6a4f76661c9e183fb8cbfd2116e5bb91ab91b3";
const controlTables = [
  "worker_environments",
  "worker_session_placements",
  "worker_workspace_pending_results",
  "session_repository_workspaces",
];
const quote = (s) => `"${s.replaceAll('"', '""')}"`;
const hash = (s) => createHash("sha256").update(s).digest("hex");
const fileHash = (p) => hash(fs.readFileSync(p));
const json = (v) =>
  JSON.stringify(v, (_k, x) =>
    typeof x === "bigint"
      ? { integer: x.toString() }
      : x instanceof Uint8Array
        ? { bytes: Buffer.from(x).toString("base64") }
        : x,
  );
function save(p, value) {
  const fd = fs.openSync(p, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function reserveReceipt(p, value) {
  const fd = fs.openSync(p, "wx", 0o600);
  return {
    record() {
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, JSON.stringify(value, null, 2) + "\n", 0);
      fs.fsyncSync(fd);
    },
    close() {
      fs.closeSync(fd);
    },
  };
}
function identity(file) {
  const root = path.dirname(path.dirname(file));
  const config = path.join(root, "node.json");
  const credentials = path.join(root, "client/credentials.sqlite");
  let credentialRows = null;
  if (fs.existsSync(credentials)) {
    const db = new DatabaseSync(credentials, { readOnly: true });
    try {
      credentialRows = Object.fromEntries(tableNames(db).map((t) => [t, rows(db, t)]));
    } finally {
      db.close();
    }
  }
  return { nodeConfigSha256: fs.existsSync(config) ? fileHash(config) : null, credentialRows };
}
async function preserveDatabase(source, destination) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, destination);
  } finally {
    db.close();
  }
  fs.chmodSync(destination, 0o600);
  const fd = fs.openSync(destination, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function tableNames(db) {
  return db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
}
function rows(db, table, columns) {
  const names =
    columns ??
    db
      .prepare(`PRAGMA table_xinfo(${quote(table)})`)
      .all()
      .filter((c) => c.hidden === 0)
      .map((c) => c.name);
  const statement = db.prepare(`SELECT ${names.map(quote).join(",")} FROM ${quote(table)}`);
  statement.setReadBigInts(true);
  const values = [];
  for (const row of statement.iterate()) {
    if (table === "schema_meta" && row.meta_key === "primary") {
      continue;
    }
    if (table === "config_machine_state" && row.key === "state.schema.contentVersion") {
      continue;
    }
    values.push(hash(json(row)));
  }
  return {
    columns: names,
    count: values.length,
    sha256: hash(values.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n")),
  };
}
function snapshot(db) {
  const schema = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
  const tables = Object.fromEntries(tableNames(db).map((t) => [t, rows(db, t)]));
  const primary = db.prepare("SELECT * FROM schema_meta WHERE meta_key='primary'").get();
  const version = db.prepare("PRAGMA user_version").get().user_version;
  return { version, primary, tables, digest: hash(json({ schema, tables, primary, version })) };
}
function requireSource(db) {
  assert.equal(
    db.prepare("PRAGMA user_version").get().user_version,
    37,
    "Expected original state37",
  );
  const meta = db
    .prepare("SELECT role,schema_version FROM schema_meta WHERE meta_key='primary'")
    .get();
  assert(
    meta?.role === "global" && meta.schema_version === 37,
    "Original ownership/version changed",
  );
  assert.equal(
    hash(
      db
        .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='worker_environments'")
        .get()?.sql ?? "",
    ),
    workerTableHash,
    "Unrecognized legacy worker table",
  );
  const names = new Set(tableNames(db));
  for (const table of controlTables) {
    if (!names.has(table)) {
      assert.equal(table, "session_repository_workspaces", "Required control table absent");
      continue;
    }
    assert.equal(
      db.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n,
      0,
      `Nonempty ${table}: use the preserving retained-data conversion instead`,
    );
  }
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM node_worker_launches WHERE state IN ('pending','running')",
      )
      .get().n,
    0,
    "Active native launch custody must settle first",
  );
}
function verifyPreserved(db, before) {
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 41);
  const names = new Set(tableNames(db));
  for (const [table, expected] of Object.entries(before.tables)) {
    if (controlTables.includes(table)) {
      continue;
    }
    if (!names.has(table)) {
      assert.equal(expected.count, 0, `Removed nonempty ${table}`);
      continue;
    }
    const observed = rows(db, table, expected.columns);
    assert.equal(observed.count, expected.count, `Row count changed: ${table}`);
    assert.equal(observed.sha256, expected.sha256, `Original rows changed: ${table}`);
  }
  for (const table of controlTables) {
    if (names.has(table)) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n, 0);
    }
  }
  for (const table of names) {
    if (!(table in before.tables) && !controlTables.includes(table)) {
      assert.equal(rows(db, table).count, 0, `Unexpected new rows: ${table}`);
    }
  }
}
async function doctor(runtimeRoot, file) {
  const build = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "dist/build-info.json"), "utf8"));
  assert.equal(build.commit, runtimeCommit, "Use the qualified installed AC660 runtime");
  const require = createRequire(path.join(runtimeRoot, "package.json"));
  const { repairOpenClawStateDatabaseSchema } = await import(
    pathToFileURL(require.resolve("openclaw/plugin-sdk/doctor-repair-runtime")).href
  );
  const result = repairOpenClawStateDatabaseSchema({
    path: file,
    env: { ...process.env, OPENCLAW_STATE_DIR: path.dirname(path.dirname(file)) },
  });
  assert(
    !result.failure && result.warnings.length === 0,
    `Canonical Doctor refused: ${result.warnings.join("; ")}`,
  );
  return result;
}
function addColumn(file, expectedDigest) {
  const db = new DatabaseSync(file);
  try {
    db.exec("BEGIN IMMEDIATE");
    requireSource(db);
    assert.equal(
      snapshot(db).digest,
      expectedDigest,
      "Source changed since preserved qualification",
    );
    // Empty control plane only; Native launch/turn/credential data is not reinterpreted.
    db.exec("ALTER TABLE worker_environments ADD COLUMN resource_receipt_json TEXT");
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    throw error;
  } finally {
    db.close();
  }
}

async function quiesce(file, runtimeRoot, pidText, startTicks, output) {
  assert.equal(process.platform, "linux", "Exact process retirement is Linux-only");
  assert(/^[1-9][0-9]*$/u.test(pidText) && /^[0-9]+$/u.test(startTicks));
  const pid = Number(pidText),
    stateRoot = path.dirname(path.dirname(file));
  const runtimeDirectory = path.dirname(path.dirname(runtimeRoot));
  const build = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "dist/build-info.json"), "utf8"));
  assert.equal(build.commit, runtimeCommit);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    requireSource(db);
  } finally {
    db.close();
  }
  assert.equal(fs.readFileSync(path.join(stateRoot, "node.pid"), "utf8").trim(), pidText);
  const stat = () => {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return text
      .slice(text.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
  };
  const actual = stat();
  const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  // Same Linux retirement contract as Crabbox's node-process owner: exact group,
  // UID, runtime cwd, invocation and state, followed by start-time recheck.
  assert.equal(Number(actual[2]), pid, "Node does not own its process group");
  assert.equal(actual[19], startTicks, "Node process was replaced");
  assert.equal(fs.statSync(`/proc/${pid}`).uid, process.getuid());
  assert.equal(fs.realpathSync(`/proc/${pid}/cwd`), fs.realpathSync(runtimeDirectory));
  assert(env.includes(`OPENCLAW_STATE_DIR=${stateRoot}`), "Node state scope changed");
  assert(
    args[1] === path.join(runtimeRoot, "openclaw.mjs") ||
      ["openclaw", "openclaw-connect", "openclaw-node"].includes(args[0]),
    "Node invocation changed",
  );
  assert.equal(stat()[19], startTicks);
  // Reserve the operation receipt before signaling; failed retirement never admits repair.
  const result = { status: "retirement-requested", file, pid, startTicks, runtimeRoot };
  const receipt = reserveReceipt(output, result);
  try {
    receipt.record();
    process.kill(-pid, "SIGTERM");
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
        result.status = "node-process-group-exited";
        receipt.record();
        console.log(json({ status: result.status, pid, startTicks, receipt: output }));
        return;
      }
      assert(Date.now() < deadline, "Node group exit unconfirmed; repair remains held");
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  } catch (error) {
    result.error = String(error);
    receipt.record();
    throw error;
  } finally {
    receipt.close();
  }
}

async function preflight(file, runtimeRoot, output) {
  fs.mkdirSync(output, { mode: 0o700 });
  const source = new DatabaseSync(file, { readOnly: true });
  const saved = path.join(output, "source.sqlite");
  try {
    requireSource(source);
  } finally {
    source.close();
  }
  await preserveDatabase(file, saved);
  const original = new DatabaseSync(saved, { readOnly: true });
  let before;
  try {
    requireSource(original);
    before = snapshot(original);
  } finally {
    original.close();
  }
  const rehearsal = path.join(output, "rehearsal", "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(rehearsal), { recursive: true, mode: 0o700 });
  fs.copyFileSync(saved, rehearsal, fs.constants.COPYFILE_EXCL);
  const stateRoot = path.dirname(path.dirname(file));
  const rehearsalRoot = path.dirname(path.dirname(rehearsal));
  const identityBackups = [];
  for (const relative of ["node.json", "client/credentials.sqlite"]) {
    const originalPath = path.join(stateRoot, relative);
    if (!fs.existsSync(originalPath)) {
      continue;
    }
    const savedPath = path.join(output, relative);
    const copiedPath = path.join(rehearsalRoot, relative);
    fs.mkdirSync(path.dirname(savedPath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(copiedPath), { recursive: true, mode: 0o700 });
    if (relative.endsWith(".sqlite")) {
      await preserveDatabase(originalPath, savedPath);
    } else {
      fs.copyFileSync(originalPath, savedPath, fs.constants.COPYFILE_EXCL);
    }
    fs.chmodSync(savedPath, 0o600);
    fs.copyFileSync(savedPath, copiedPath, fs.constants.COPYFILE_EXCL);
    identityBackups.push({ path: savedPath, sha256: fileHash(savedPath) });
  }
  const originalIdentity = identity(file);
  assert.equal(json(identity(rehearsal)), json(originalIdentity), "Identity backup changed");
  addColumn(rehearsal, before.digest);
  const result = await doctor(runtimeRoot, rehearsal);
  const repaired = new DatabaseSync(rehearsal, { readOnly: true });
  try {
    verifyPreserved(repaired, before);
  } finally {
    repaired.close();
  }
  assert.equal(
    json(identity(rehearsal)),
    json(originalIdentity),
    "Rehearsal changed private identity",
  );
  const receipt = {
    format: "g119-empty-node-state-repair-v1",
    status: "preflight-qualified",
    file,
    runtimeRoot,
    runtimeCommit,
    toolSha256: fileHash(fileURLToPath(import.meta.url)),
    backup: saved,
    backupSha256: fileHash(saved),
    before,
    identity: originalIdentity,
    identityBackups,
    rehearsal: result,
    requiredBeforeApply:
      "Root must stop the exact enrolled node and every writer, and verify durable NFS copies of source.sqlite and identityBackups with these SHA256s. No Sandbox stop/destroy/reclaim or task replay.",
  };
  const receiptPath = path.join(output, "preflight.json");
  save(receiptPath, receipt);
  console.log(
    json({
      status: receipt.status,
      receiptPath,
      backup: saved,
      backupSha256: receipt.backupSha256,
    }),
  );
}
async function apply(preflightPath, output) {
  const plan = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
  assert.equal(plan.format, "g119-empty-node-state-repair-v1");
  assert.equal(plan.status, "preflight-qualified");
  assert.equal(plan.runtimeCommit, runtimeCommit);
  assert.equal(
    plan.toolSha256,
    fileHash(fileURLToPath(import.meta.url)),
    "Preflight used different tool bytes",
  );
  assert.equal(fileHash(plan.backup), plan.backupSha256, "Preserved backup changed");
  for (const saved of plan.identityBackups) {
    assert.equal(fileHash(saved.path), saved.sha256);
  }
  assert.equal(
    json(identity(plan.file)),
    json(plan.identity),
    "Private identity changed since preflight",
  );
  const pidText = fs
    .readFileSync(path.join(path.dirname(path.dirname(plan.file)), "node.pid"), "utf8")
    .trim();
  assert(/^[1-9][0-9]*$/u.test(pidText), "Saved node PID is unavailable");
  try {
    process.kill(Number(pidText), 0);
    throw new Error("Node process is still alive; quiesce before applying");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
  const result = {
    format: plan.format,
    status: "started",
    file: plan.file,
    backup: plan.backup,
    backupSha256: plan.backupSha256,
    preflightSha256: fileHash(preflightPath),
  };
  const receipt = reserveReceipt(output, result);
  try {
    receipt.record();
    addColumn(plan.file, plan.before.digest);
    result.status = "additive-bridge-committed";
    receipt.record();
    result.doctor = await doctor(plan.runtimeRoot, plan.file);
    const db = new DatabaseSync(plan.file, { readOnly: true });
    try {
      verifyPreserved(db, plan.before);
      result.after = snapshot(db);
    } finally {
      db.close();
    }
    assert.equal(
      json(identity(plan.file)),
      json(plan.identity),
      "Private identity changed during repair",
    );
    result.status = "completed";
    receipt.record();
    console.log(json({ status: result.status, receipt: output }));
  } catch (error) {
    result.error = String(error);
    receipt.record();
    throw error;
  } finally {
    receipt.close();
  }
}

async function main() {
  process.umask(0o077);
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "quiesce" && args.length === 5) {
    return quiesce(
      path.resolve(args[0]),
      path.resolve(args[1]),
      args[2],
      args[3],
      path.resolve(args[4]),
    );
  }
  if (mode === "preflight" && args.length === 3) {
    return preflight(...args.map((x) => path.resolve(x)));
  }
  if (mode === "apply" && args.length === 2) {
    return apply(...args.map((x) => path.resolve(x)));
  }
  throw new Error(
    "Usage: repair-node-state.mjs quiesce DATABASE INSTALLED_RUNTIME PID START_TICKS NEW_RECEIPT | preflight DATABASE INSTALLED_RUNTIME NEW_PROOF_DIR | apply PREFLIGHT_JSON NEW_RECEIPT_JSON",
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
