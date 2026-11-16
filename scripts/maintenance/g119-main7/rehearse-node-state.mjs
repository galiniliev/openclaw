#!/usr/bin/env node
// Operator rehearsal: pinned historical schema objects and installed AC660 are prerequisites.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CLIENT_CREDENTIAL_SCHEMA_SQL } from "../../../src/infra/client-credential-schema.ts";

const [runtimeArg, outputArg, legacySchema] = process.argv.slice(2);
assert(runtimeArg && outputArg, "Usage: rehearse-node-state.mjs INSTALLED_RUNTIME NEW_OUTPUT");
const runtime = path.resolve(runtimeArg),
  output = path.resolve(outputArg);
fs.mkdirSync(output, { mode: 0o700 });
const tool = fileURLToPath(new URL("./repair-node-state.mjs", import.meta.url));
const sql = legacySchema
  ? fs.readFileSync(legacySchema, "utf8")
  : execFileSync(
      "git",
      ["show", "fdd4a988929c653a24f1ac791837d65f98f7a0ec:src/state/openclaw-state-schema.sql"],
      { encoding: "utf8" },
    );
const hash = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
assert.equal(
  createHash("sha256").update(sql).digest("hex"),
  "bb18eb83bc81f6551f45f7c867b5ac5b3242ee1046c7f5955645a389618ac166",
  "Historical schema changed",
);
function fixture(name, fault) {
  const root = path.join(output, name);
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  const file = path.join(root, "state/openclaw.sqlite");
  const db = new DatabaseSync(file);
  db.exec(sql);
  db.exec("PRAGMA user_version=37");
  db.prepare("INSERT INTO schema_meta VALUES('primary','global',37,NULL,'2026.10.9',1,1)").run();
  // The actual guest has no repository table; its absence must survive admission.
  db.exec("DROP TABLE IF EXISTS session_repository_workspaces");
  for (let i = 0; i < 4; i++) {
    db.prepare(`INSERT INTO node_worker_launches
      (launch_id,plan_hash,gateway_namespace,environment_id,session_id,owner_epoch,
       placement_generation,run_id,state,supervisor_pid,supervisor_start_time,error_text,
       completed_at_ms,created_at_ms,updated_at_ms)
      VALUES (?,?,'gateway','original-environment','original-session',7,2,?,'interrupted',12345,0,'cold boot',2,1,2)`).run(
      `launch-${i}`,
      "a".repeat(64),
      `run-${i}`,
    );
    db.prepare(`INSERT INTO node_worker_turns
      (turn_id,owner_launch_id,plan_hash,run_id,state,error_text,completed_at_ms,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,'interrupted','cold boot',2,1,2)`).run(
      `turn-${i}`,
      `launch-${i}`,
      "a".repeat(64),
      `run-${i}`,
    );
  }
  if (fault === "active") {
    db.prepare(
      "UPDATE node_worker_launches SET state='running',worker_pid=12346,worker_start_time=0,error_text=NULL,completed_at_ms=NULL WHERE launch_id='launch-0'",
    ).run();
  }
  if (fault === "control") {
    db.prepare(`INSERT INTO worker_environments
    (environment_id,provider_id,profile_id,profile_snapshot_json,provision_operation_id,state,created_at_ms,updated_at_ms,state_changed_at_ms)
    VALUES ('private','fixture','fixture','{}','original-operation','idle',1,1,1)`).run();
  }
  db.close();
  fs.writeFileSync(path.join(root, "node.json"), '{"nodeId":"original-node"}\n');
  fs.mkdirSync(path.join(root, "client"));
  const credentials = new DatabaseSync(path.join(root, "client/credentials.sqlite"));
  credentials.exec(CLIENT_CREDENTIAL_SCHEMA_SQL);
  credentials.exec("PRAGMA user_version=1");
  credentials
    .prepare(
      "INSERT INTO device_identities VALUES('current','original-node','synthetic-public','synthetic-private',1,1)",
    )
    .run();
  credentials
    .prepare(
      "INSERT INTO device_auth_tokens VALUES('original-node','node','synthetic-token','[]',1)",
    )
    .run();
  credentials.close();
  return file;
}
function run(args, expected = 0) {
  const result = spawnSync(process.execPath, [tool, ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, expected, result.stderr + result.stdout);
  return result;
}
for (const fault of ["active", "control"]) {
  const file = fixture(fault, fault),
    before = hash(file);
  run(["preflight", file, runtime, path.join(output, `${fault}-proof`)], 1);
  assert.equal(hash(file), before, "Rejected source was modified");
}
const repairedFile = fixture("repair");
const original = hash(repairedFile);
const proof = path.join(output, "qualified");
run(["preflight", repairedFile, runtime, proof]);
assert.equal(hash(repairedFile), original, "Preflight changed source");
const plan = JSON.parse(fs.readFileSync(path.join(proof, "preflight.json"), "utf8"));
assert.equal(plan.before.tables.node_worker_launches.count, 4);
assert.equal(plan.before.tables.node_worker_turns.count, 4);
const receipt = path.join(output, "apply.json");
const pidFile = path.join(path.dirname(path.dirname(repairedFile)), "node.pid");
fs.writeFileSync(pidFile, String(process.pid));
const liveRefusal = run(["apply", path.join(proof, "preflight.json"), receipt], 1);
assert.match(liveRefusal.stderr, /Node process is still alive/u);
assert.equal(hash(repairedFile), original, "Live-node refusal changed source");
assert(!fs.existsSync(receipt), "Live-node refusal reserved apply output");
const dead = spawnSync(process.execPath, ["-e", ""], { timeout: 10_000 });
assert.equal(dead.status, 0);
assert.throws(() => process.kill(dead.pid, 0), { code: "ESRCH" });
fs.writeFileSync(pidFile, String(dead.pid));
run(["apply", path.join(proof, "preflight.json"), receipt]);
assert.equal(JSON.parse(fs.readFileSync(receipt, "utf8")).status, "completed");
const checkedDatabase = new DatabaseSync(repairedFile, { readOnly: true });
assert.equal(checkedDatabase.prepare("PRAGMA user_version").get().user_version, 41);
assert.equal(
  checkedDatabase
    .prepare("SELECT count(*) AS n FROM node_worker_launches WHERE state='interrupted'")
    .get().n,
  4,
);
assert.equal(checkedDatabase.prepare("SELECT count(*) AS n FROM node_worker_turns").get().n, 4);
checkedDatabase.close();
run(["apply", path.join(proof, "preflight.json"), receipt], 1);
if (process.platform === "linux") {
  const owned = fixture("quiesce");
  const stateRoot = path.dirname(path.dirname(owned));
  const child = spawn(
    process.execPath,
    ["-e", "process.title='openclaw-node';process.send('ready');setInterval(()=>{},1000)"],
    {
      cwd: path.dirname(path.dirname(runtime)),
      env: { ...process.env, OPENCLAW_STATE_DIR: stateRoot },
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  try {
    await once(child, "message");
    child.disconnect();
    fs.writeFileSync(path.join(stateRoot, "node.pid"), String(child.pid));
    const text = fs.readFileSync(`/proc/${child.pid}/stat`, "utf8");
    const ticks = text
      .slice(text.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u)[19];
    run(
      [
        "quiesce",
        owned,
        runtime,
        String(child.pid),
        String(BigInt(ticks) + 1n),
        path.join(output, "wrong-process.json"),
      ],
      1,
    );
    process.kill(child.pid, 0);
    const other = fixture("wrong-state");
    fs.writeFileSync(path.join(path.dirname(path.dirname(other)), "node.pid"), String(child.pid));
    run(
      ["quiesce", other, runtime, String(child.pid), ticks, path.join(output, "wrong-state.json")],
      1,
    );
    process.kill(child.pid, 0);
    const stopping = spawn(
      process.execPath,
      [
        tool,
        "quiesce",
        owned,
        runtime,
        String(child.pid),
        ticks,
        path.join(output, "quiesce.json"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let detail = "";
    stopping.stderr.on("data", (value) => {
      detail += value;
    });
    const [code] = await once(stopping, "close");
    assert.equal(code, 0, detail);
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
}
const summary = {
  status: "passed",
  node: process.version,
  checks: [
    "real public installed Doctor",
    "exact legacy37 and absent repository table",
    "preflight leaves source unchanged",
    "37 to41 with original launch and turn row bags",
    "node identity and client credential rows unchanged",
    "active native launch refused",
    "nonempty control plane refused",
    "existing output not overwritten",
    "live saved node PID refuses apply unchanged",
    ...(process.platform === "linux"
      ? ["real exact process group retired; replaced PID and wrong state refused"]
      : []),
  ],
  scriptSha256: hash(tool),
  receipt,
};
fs.writeFileSync(path.join(output, "rehearsal.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
