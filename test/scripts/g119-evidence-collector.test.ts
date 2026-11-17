import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const collector = join(process.cwd(), "scripts/maintenance/g119-main7/collect-identities.mjs");

function capture(timestamp: string | null = "1795000000000") {
  const root = tempDirs.make("g119-evidence-collector-");
  const runtime = join(root, "runtime");
  const state = join(root, "crabbox");
  const output = join(root, "evidence.json");
  mkdirSync(join(runtime, "node_modules/pg"), { recursive: true });
  mkdirSync(join(state, "claims"), { recursive: true });
  writeFileSync(join(runtime, "package.json"), "{}");
  const retention = {
    policy: { mode: "session-disk", computeWindowSeconds: 60 },
    owner: { sessionId: "fixture-session", sessionKey: "fixture-key", agentId: "main" },
    ownerBinding: "fixture-binding",
    desiredState: "running",
    operation: null,
    receipt: { identity: { leaseId: "cbx_fixture" } },
    recordedFact: { optional: null },
  };
  const explicitNull = { ...retention, receipt: { ...retention.receipt, operation: null } };
  const authority = {
    environmentId: "fixture-env",
    sessionId: "fixture-session",
    ownerEpoch: 1,
    ownerBinding: "fixture-binding",
    workspaceDir: "/workspace/fixture",
    identity: { leaseId: "cbx_fixture", resourceId: "fixture-resource" },
    recordedFact: ["preserve", null],
  };
  const claim = JSON.stringify({ leaseID: "cbx_fixture", provider: "azure-sandbox" });
  const claimPath = join(state, "claims/cbx_fixture.json");
  writeFileSync(claimPath, claim);
  writeFileSync(
    join(runtime, "fixture.json"),
    JSON.stringify({ retention, explicitNull, authority, timestamp }),
  );
  // Fixed external PG wire values; the real CLI owns JSON projection and file evidence.
  writeFileSync(
    join(runtime, "node_modules/pg/index.js"),
    `const fixture = require('../../fixture.json');
const types = { builtins: { INT8: 20 }, getTypeParser() { return value => value; } };
class Client {
  constructor(options) { this.int8 = options.types?.getTypeParser(20, 'text') ?? (value => value); }
  async connect() {}
  async end() {}
  async query(sql) {
    let rows = [];
    if (sql === 'SHOW transaction_read_only') rows = [{ transaction_read_only: 'on' }];
    else if (sql.includes('.openclaw_schema_meta')) rows = [{ store: 'state', version: '37', store_id: 'fixture-store' }];
    else if (sql.includes(' AS present')) rows = [{ present: false }];
    else if (sql.includes('.session_repository_workspaces')) rows = [{ workspace_id: 'fixture-workspace', agent_id: 'main', session_key: 'fixture-key', valid_json: true, has_base: true, has_checkpoint: true,
      ...(sql.includes(' AS authority') ? { authority: fixture.authority } : { disk_authority_json: JSON.stringify(fixture.authority) }) }];
    else if (sql.includes('.worker_environments')) rows = [fixture.retention, fixture.explicitNull].map((retention, index) => ({
      environment_id: index ? 'fixture-null-operation' : 'fixture-env', provider_id: 'crabbox', profile_id: 'fixture-profile', state: 'orphaned', lease_id: 'cbx_fixture', owner_epoch: this.int8('0'), shared_host: null,
      destroy_requested_at_ms: fixture.timestamp === null ? null : this.int8(fixture.timestamp), teardown_terminal_state: 'destroyed', node_device_id: null, bootstrap_bundle_hash: null, bootstrap_openclaw_version: null,
      attached_session_ids: [], valid_json: true, prepared: false,
      ...(sql.includes(' AS retention') ? { retention } : { session_retention_json: JSON.stringify(retention) }) }));
    else if (sql.includes('.worker_session_placements')) rows = [{ session_id: 'fixture-session', has_turn_claim: false }];
    return { rows };
  }
}
module.exports = { Client, types };
`,
  );
  const result = spawnSync(process.execPath, [collector, runtime, "fixture_state", state, output], {
    env: { ...process.env, OPENCLAW_MAINTENANCE_PG_URL: "postgres://fixture.invalid/unused" },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { result, output, retention, explicitNull, authority, claim, claimPath };
}

describe("G119 read-only evidence collection", () => {
  it("preserves full JSON, absent versus null receipt fields, and numeric Native timestamps", () => {
    const fixture = capture();
    expect(fixture.result.status, fixture.result.stderr).toBe(0);
    const evidence = JSON.parse(readFileSync(fixture.output, "utf8"));
    expect(evidence.environments.map((row: { retention: unknown }) => row.retention)).toEqual([
      fixture.retention,
      fixture.explicitNull,
    ]);
    expect(Object.hasOwn(evidence.environments[0].retention.receipt, "operation")).toBe(false);
    expect(evidence.workspaces[0].authority).toEqual(fixture.authority);
    expect(evidence.environments[0].destroy_requested_at_ms).toBe(1795000000000);
    expect(evidence.placements[0].has_turn_claim).toBe(false);
    expect(evidence.claims[0].fileSha256).toBe(
      createHash("sha256").update(fixture.claim).digest("hex"),
    );
    expect(readFileSync(fixture.claimPath, "utf8")).toBe(fixture.claim);
  });

  it.each([null, "9007199254740991", "-9007199254740991"])(
    "retains null or the exact safe int8 timestamp %s",
    (timestamp) => {
      const fixture = capture(timestamp);
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      const evidence = JSON.parse(readFileSync(fixture.output, "utf8"));
      expect(evidence.environments[0].destroy_requested_at_ms).toBe(
        timestamp === null ? null : Number(timestamp),
      );
    },
  );

  it.each(["9007199254740992", "-9007199254740992"])(
    "refuses unsafe int8 timestamp %s before publishing evidence",
    (timestamp) => {
      const fixture = capture(timestamp);
      expect(fixture.result.status).not.toBe(0);
      expect(fixture.result.stderr).toContain("cannot be represented safely as a number");
      expect(existsSync(fixture.output)).toBe(false);
      expect(readFileSync(fixture.claimPath, "utf8")).toBe(fixture.claim);
    },
  );
});
