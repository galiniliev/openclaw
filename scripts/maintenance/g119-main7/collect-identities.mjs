#!/usr/bin/env node
// Read-only correlation evidence, NOT admission or authority. No provider is loaded or invoked.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const [runtimeRoot, namespace, stateRoot, output] = process.argv.slice(2);
assert(
  runtimeRoot && namespace && stateRoot && output,
  "Usage: collect-identities.mjs RUNTIME_ROOT PG_STATE_NAMESPACE CRABBOX_STATE_ROOT NEW_PRIVATE_OUTPUT.json",
);
const url = process.env.OPENCLAW_MAINTENANCE_PG_URL;
assert(url, "Missing secret OPENCLAW_MAINTENANCE_PG_URL");
const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
const hash = (b) => createHash("sha256").update(b).digest("hex");
const record = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const pick = (x, keys) =>
  record(x)
    ? Object.fromEntries(
        keys
          .filter((k) => Object.hasOwn(x, k) && !record(x[k]) && !Array.isArray(x[k]))
          .map((k) => [k, x[k]]),
      )
    : null;
const operation = (x) => pick(x, ["id", "action", "phase", "expectedClaimRevision"]);
const window = (x) => pick(x, ["id", "authorizedAt", "expiresAt", "state"]);
const pg = createRequire(path.join(path.resolve(runtimeRoot), "package.json"))("pg");
const db = new pg.Client({
  connectionString: url,
  types: {
    getTypeParser: (oid, format) => {
      if (oid !== pg.types.builtins.INT8 || format === "binary") {
        return pg.types.getTypeParser(oid, format);
      }
      // Match Native's postgres-sync/protocol decoder without changing computed booleans.
      return (value) => {
        if (typeof value !== "string") {
          throw new TypeError("PostgreSQL int8 results must be text");
        }
        const number = Number(BigInt(value));
        if (!Number.isSafeInteger(number)) {
          throw new RangeError("PostgreSQL int8 cannot be represented safely as a number");
        }
        return number;
      };
    },
  },
});
const result = {
  version: 1,
  readOnly: true,
  qualified: false,
  observedAt: new Date().toISOString(),
  namespace,
  note: "Recorded PG/immutable-claim identity facts only. No provider observation, ownership repair, receipt fabrication or effects. Refresh after stopped-writer custody.",
  environments: [],
  workspaces: [],
  placements: [],
  relationCounts: {},
  requests: [],
  claims: [],
  problems: [],
};
await db.connect();
try {
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal((await db.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
  const meta = (
    await db.query(`SELECT store,version,store_id FROM ${quote(namespace)}.openclaw_schema_meta`)
  ).rows;
  assert.equal(meta.length, 1);
  assert.equal(meta[0].store, "state");
  assert.equal(Number(meta[0].version), 37);
  result.metadata = meta;
  const workspaces = (
    await db.query(`SELECT workspace_id,agent_id,session_key,
 disk_authority_json,
 disk_authority_json IS JSON AS valid_json,base_commit IS NOT NULL AS has_base,
 checkpoint_ref IS NOT NULL AS has_checkpoint FROM ${quote(namespace)}.session_repository_workspaces
 WHERE disk_authority_json IS NOT NULL ORDER BY workspace_id`)
  ).rows;
  // Evidence must preserve the same parsed JSON, including omitted versus null fields, as migration.
  result.workspaces = workspaces.map(({ disk_authority_json, ...row }) =>
    Object.assign(row, { authority: JSON.parse(disk_authority_json) }),
  );
  const referenced = [
    ...new Set(
      result.workspaces.map((x) => x.authority?.environmentId).filter((x) => typeof x === "string"),
    ),
  ];
  const env = (
    await db.query(
      `SELECT environment_id,provider_id,profile_id,state,lease_id,owner_epoch,node_device_id,shared_host,
 destroy_requested_at_ms,teardown_terminal_state,preparation_key IS NOT NULL AS prepared,
 bootstrap_bundle_hash,bootstrap_openclaw_version,
 CASE WHEN attached_session_ids_json IS JSON THEN attached_session_ids_json::jsonb END AS attached_session_ids,
 session_retention_json,
 session_retention_json IS JSON AS valid_json FROM ${quote(namespace)}.worker_environments
 WHERE session_retention_json IS NOT NULL OR environment_id=ANY($1::text[]) ORDER BY environment_id`,
      [referenced],
    )
  ).rows;
  result.environments = env.map(({ session_retention_json, attached_session_ids, ...row }) =>
    Object.assign(row, {
      attached_session_ids: Array.isArray(attached_session_ids)
        ? attached_session_ids.filter((x) => typeof x === "string")
        : null,
      retention: session_retention_json === null ? null : JSON.parse(session_retention_json),
    }),
  );
  const envIds = result.environments.map((x) => x.environment_id);
  const sessionIds = [
    ...new Set(
      [
        ...result.workspaces.map((x) => x.authority?.sessionId),
        ...result.environments.map((x) => x.retention?.owner?.sessionId),
      ].filter((x) => typeof x === "string"),
    ),
  ];
  result.placements = (
    await db.query(
      `SELECT session_id,agent_id,session_key,state,environment_id,transition_generation,
 active_owner_epoch,remote_workspace_dir,worker_bundle_hash,workspace_base_manifest_ref,
 turn_claim_owner IS NOT NULL AS has_turn_claim,repository_preparation FROM ${quote(namespace)}.worker_session_placements
 WHERE environment_id=ANY($1::text[]) OR session_id=ANY($2::text[]) ORDER BY session_id`,
      [envIds, sessionIds],
    )
  ).rows;
  const counts = [
    ["credentials", "worker_environment_credentials", "environment_id", "TRUE"],
    [
      "liveCredentials",
      "worker_environment_credentials",
      "environment_id",
      "expires_at_ms>floor(extract(epoch FROM statement_timestamp())*1000)::bigint",
    ],
    ["attachments", "worker_environment_session_attachments", "environment_id", "TRUE"],
    [
      "openAttachments",
      "worker_environment_session_attachments",
      "environment_id",
      "closed_at_ms IS NULL",
    ],
    ["pendingResults", "worker_workspace_pending_results", "environment_id", "TRUE"],
    ["pendingInference", "worker_inference_turns", "environment_id", "state='pending'"],
    ["placementMoves", "worker_session_placement_moves", "source_environment_id", "TRUE"],
  ];
  for (const [name, table, column, condition] of counts) {
    const exists = (
      await db.query("SELECT to_regclass($1) IS NOT NULL AS present", [
        `${quote(namespace)}.${quote(table)}`,
      ])
    ).rows[0].present;
    result.relationCounts[name] = exists
      ? (
          await db.query(
            `SELECT ${quote(column)} AS environment_id,count(*)::text AS count FROM ${quote(namespace)}.${quote(table)} WHERE ${quote(column)}=ANY($1::text[]) AND (${condition}) GROUP BY ${quote(column)} ORDER BY ${quote(column)}`,
            [envIds],
          )
        ).rows
      : null;
  }
  const toolTable = (
    await db.query("SELECT to_regclass($1) IS NOT NULL AS present", [
      `${quote(namespace)}.worker_session_tool_operations`,
    ])
  ).rows[0].present;
  result.runningTools = toolTable
    ? (
        await db.query(
          `SELECT source_session_id,count(*)::text AS count FROM ${quote(namespace)}.worker_session_tool_operations WHERE source_session_id=ANY($1::text[]) AND status='running' GROUP BY source_session_id ORDER BY source_session_id`,
          [sessionIds],
        )
      ).rows
    : null;
  await db.query("ROLLBACK");
} finally {
  await db.end();
}
const requested = new Map();
const add = (id, kind, recordId, field) => {
  if (id === null || id === undefined || id === "") {
    return;
  }
  if (
    typeof id !== "string" ||
    id !== id.trim() ||
    id === "." ||
    id === ".." ||
    /[<>:"/\\|?*\p{Cc}]/u.test(id) ||
    id.endsWith(".") ||
    Buffer.byteLength(id + ".json") > 255
  ) {
    result.problems.push({ kind, recordId, field, code: "invalid-lease-id" });
    return;
  }
  const entry = requested.get(id) ?? { leaseId: id, refs: [] };
  entry.refs.push({ kind, recordId, field });
  requested.set(id, entry);
};
for (const e of result.environments) {
  add(e.lease_id, "environment", e.environment_id, "lease_id");
  add(
    e.retention?.receipt?.identity?.leaseId,
    "environment",
    e.environment_id,
    "retention.receipt.identity.leaseId",
  );
  add(
    e.retention?.receipt?.identity?.attemptLeaseId,
    "environment",
    e.environment_id,
    "retention.receipt.identity.attemptLeaseId",
  );
}
for (const w of result.workspaces) {
  add(w.authority?.identity?.leaseId, "workspace", w.workspace_id, "authority.identity.leaseId");
  add(
    w.authority?.identity?.attemptLeaseId,
    "workspace",
    w.workspace_id,
    "authority.identity.attemptLeaseId",
  );
}
result.requests = [...requested.values()].toSorted((a, b) => a.leaseId.localeCompare(b.leaseId));
const claimsDirectory = path.join(path.resolve(stateRoot), "claims");
try {
  result.claimsDirectoryStatus = fs.statSync(claimsDirectory).isDirectory()
    ? "directory"
    : "not-directory";
} catch (error) {
  result.claimsDirectoryStatus = error?.code === "ENOENT" ? "missing" : "unreadable";
}
const same = (a, b) => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((k) => a[k] === b[k]);
for (const request of result.requests) {
  const file = path.join(claimsDirectory, request.leaseId + ".json");
  let fd;
  try {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.size > 1048576n) {
      result.claims.push({ leaseId: request.leaseId, code: "not-regular-or-oversize" });
      continue;
    }
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd, { bigint: true });
    assert(same(before, opened));
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    if (!same(opened, after) || !same(opened, current)) {
      result.claims.push({ leaseId: request.leaseId, code: "changed-during-read" });
      continue;
    }
    let claim;
    try {
      claim = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      result.claims.push({
        leaseId: request.leaseId,
        code: "invalid-json-or-utf8",
        fileSha256: hash(bytes),
      });
      continue;
    }
    if (!record(claim) || claim.leaseID !== request.leaseId) {
      result.claims.push({
        leaseId: request.leaseId,
        code: "lease-id-mismatch",
        fileSha256: hash(bytes),
      });
      continue;
    }
    const intent = claim.fixedCreateIntent;
    const projection = {
      ...pick(claim, [
        "leaseID",
        "revision",
        "slug",
        "provider",
        "cloudID",
        "cloudImmutableID",
        "providerScope",
        "repoRoot",
        "claimedAt",
        "lastUsedAt",
      ]),
      labels: pick(claim.labels, ["crabbox_lease", "crabbox_attempt", "crabbox_fingerprint"]),
      fixedCreateIntent: record(intent)
        ? {
            ...pick(intent, [
              "version",
              "fingerprint",
              "providerScope",
              "slug",
              "createdAt",
              "state",
            ]),
            attempt: pick(intent.attempt, ["nonce", "submission"]),
            retention: pick(intent.retention, ["mode", "ownerBinding", "computeWindowSeconds"]),
            journal: record(intent.journal)
              ? {
                  ...pick(intent.journal, ["version", "phase"]),
                  retention: record(intent.journal.retention)
                    ? {
                        ...pick(intent.journal.retention, ["desiredState"]),
                        operation: operation(intent.journal.retention.operation),
                        computeWindow: window(intent.journal.retention.computeWindow),
                      }
                    : null,
                }
              : null,
          }
        : null,
    };
    // Released claims intentionally clear attempt.nonce but retain immutable terminal labels.
    result.claims.push({
      leaseId: request.leaseId,
      code: "captured-unverified",
      fileSha256: hash(bytes),
      bytes: bytes.length,
      claim: projection,
    });
  } catch (error) {
    result.claims.push({
      leaseId: request.leaseId,
      code: error?.code === "ENOENT" ? "missing" : "unreadable-or-changed",
    });
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}
const bytes = Buffer.from(JSON.stringify(result, null, 2) + "\n");
const fd = fs.openSync(output, "wx", 0o600);
try {
  fs.writeFileSync(fd, bytes);
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}
const parent = fs.openSync(path.dirname(output), "r");
try {
  fs.fsyncSync(parent);
} finally {
  fs.closeSync(parent);
}
const summary = {
  outcome: "captured",
  qualified: false,
  environments: result.environments.length,
  workspaces: result.workspaces.length,
  requestedClaims: result.requests.length,
  capturedClaims: result.claims.filter((c) => c.code === "captured-unverified").length,
  problemClaims: result.claims.filter((c) => c.code !== "captured-unverified").length,
  invalidLeaseIds: result.problems.length,
  sha256: hash(bytes),
};
console.log(JSON.stringify(summary));
