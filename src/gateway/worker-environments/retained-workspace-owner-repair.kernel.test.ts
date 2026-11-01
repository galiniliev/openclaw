import { expect, it } from "vitest";
import { acquireStateDatabaseSchemaLease } from "../../infra/gateway-state-owner.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { WorkerRetainedLeaseReceipt } from "../../plugins/worker-retention.types.js";
import { ensureSessionRepositoryWorkspaceSchema } from "../../state/openclaw-state-db-schema-additive.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { getOpenClawStateFeatureSchemaSql } from "../../state/openclaw-state-feature-schema.js";
import { rebindSessionRepositoryWorkspaceOwnerInDatabase } from "../../state/session-repository-workspaces.kernel.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./placement-record.js";
import { find as findPlacement, ensureLocal, updateTransition } from "./placement-row-codec.js";
import {
  isRetainedWorkspaceOwnerRepairHold,
  parkRetainedWorkspaceOwnerInDatabase as park,
  resumeParkedRetainedWorkspaceOwnerInDatabase as resume,
  type ParkRetainedWorkspaceOwnerInput,
} from "./retained-workspace-owner-repair.kernel.js";
import { getRequiredWorkerEnvironment } from "./store-row-codec.js";
import { createWorkerEnvironmentStoreKernel } from "./store.kernel.js";

const owner = {
  agentId: "main",
  sessionId: "synthetic-session",
  sessionKey: "agent:main:synthetic",
};
const input: ParkRetainedWorkspaceOwnerInput = {
  ...owner,
  workspaceId: "11111111-1111-4111-8111-111111111111",
  environmentId: "synthetic-original-environment",
  expectedDiskAuthority: {
    environmentId: "synthetic-original-environment",
    sessionId: owner.sessionId,
    ownerEpoch: 713,
    ownerBinding: "synthetic-original-binding",
    identity: {
      leaseId: "synthetic-original-lease",
      attemptLeaseId: "synthetic-original-attempt",
      slug: "synthetic-original-slug",
      resourceId: "synthetic-original-resource",
    },
    workspaceDir: "/workspace/synthetic-original",
  },
  environmentState: "destroying",
  environmentOwnerEpoch: 0,
  leaseId: "synthetic-original-lease",
  destroyRequestedAtMs: 200,
  placementGeneration: 3,
  workspaceRevision: 3,
};
const retention = {
  policy: { mode: "session-disk" as const, computeWindowSeconds: 3600 },
  owner,
  ownerBinding: input.expectedDiskAuthority.ownerBinding,
  desiredState: "running" as const,
  receipt: null,
  operation: null,
};
type Fixture = {
  db: EngineConnection;
  transaction<T>(this: void, run: () => T): T;
  snapshot(this: void): unknown;
};

function admitFreshOwner(value: Fixture) {
  const { db, transaction } = value;
  transaction(() => park(db, input, 300));
  const fresh = transaction(() =>
    resume(
      db,
      {
        environmentId: input.environmentId,
        expectedOwnerEpoch: 0,
        owner,
        expectedDiskAuthority: input.expectedDiskAuthority,
      },
      400,
    ),
  );
  const diskAuthority = { ...input.expectedDiskAuthority, ownerEpoch: fresh.ownerEpoch };
  const receipt: WorkerRetainedLeaseReceipt = {
    schema: "synthetic-retention.v1",
    mode: "session-disk",
    ownerBinding: input.expectedDiskAuthority.ownerBinding,
    identity: input.expectedDiskAuthority.identity,
    claimRevision: "synthetic-observed-revision",
    computeWindowSeconds: 3600,
    desiredState: "running",
    observedState: "running",
    policyVerified: true,
    stopPending: false,
    computeWindow: {
      id: "synthetic-authorized-window",
      authorizedAt: new Date(500).toISOString(),
      expiresAt: new Date(10_000).toISOString(),
      state: "active",
    },
  };
  const placement = transaction(() => {
    // Fixture observation represents completed provider/node admission, never an allocation.
    db.prepare(`UPDATE worker_environments SET state='attached',lease_id=?,node_device_id='synthetic-node',
      bootstrap_bundle_hash=?,bootstrap_openclaw_version='2026.1.1',bootstrap_protocol_features_json='[]',
      bootstrap_install_kind='bundle',attached_session_ids_json=?,session_retention_json=? WHERE environment_id=?`).run(
      input.leaseId,
      "a".repeat(64),
      JSON.stringify([owner.sessionId]),
      JSON.stringify({ ...retention, receipt }),
      input.environmentId,
    );
    const local = findPlacement(db, owner.sessionId)!;
    const requested = updateTransition(db, local, "requested", {}, 500);
    const provisioning = updateTransition(
      db,
      requested,
      "provisioning",
      { environmentId: input.environmentId },
      510,
    );
    return updateTransition(db, provisioning, "syncing", { workerBundleHash: "a".repeat(64) }, 520);
  });
  return {
    receipt,
    request: {
      workspaceId: input.workspaceId,
      expectedRevision: input.workspaceRevision,
      expectedDiskAuthority: input.expectedDiskAuthority,
      diskAuthority,
      placementGeneration: placement.generation,
    },
  };
}
async function fixture(run: (value: Fixture) => void) {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    const lease = acquireStateDatabaseSchemaLease(resolveOpenClawStateSqlitePath(state.env));
    try {
      lease.run(() => {
        const database = openOpenClawStateDatabase({ env: state.env });
        const transaction = <T>(operation: () => T) =>
          runOpenClawStateWriteTransaction(operation, { database, env: state.env });
        transaction(() => {
          const environments = createWorkerEnvironmentStoreKernel(database, () => 100);
          environments.createIntent({
            environmentId: input.environmentId,
            providerId: "crabbox",
            profileId: "synthetic-profile",
            profileSnapshot: {
              settings: { provider: "azure-sandbox", sourceTuple: "synthetic-frozen-tuple" },
              lifetime: { idleMinutes: 10 },
            },
            retention,
            provisionOperationId: "synthetic-original-provision-operation",
          });
          database.db
            .prepare(`UPDATE worker_environments SET state='destroying',
            lease_id=?, shared_host=0, destroy_requested_at_ms=200,
            teardown_terminal_state='destroyed' WHERE environment_id=?`)
            .run(input.leaseId, input.environmentId);
          ensureSessionRepositoryWorkspaceSchema(database.db);
          executeSqliteQuerySync(
            database.db,
            getNodeSqliteKysely<DB>(database.db)
              .insertInto("session_repository_workspaces")
              .values({
                workspace_id: input.workspaceId,
                agent_id: owner.agentId,
                session_key: owner.sessionKey,
                url: "https://example.test/synthetic.git",
                requested_ref: "main",
                run_setup_script: 0,
                base_commit: "a".repeat(40),
                base_manifest_hash: `sha256:${"b".repeat(64)}`,
                branch: "synthetic/retained",
                checkpoint_ref: "refs/openclaw/worker-results/synthetic",
                manifest_hash: `sha256:${"c".repeat(64)}`,
                revision: 3,
                created_at_ms: 100,
                updated_at_ms: 200,
                disk_authority_json: JSON.stringify(input.expectedDiskAuthority),
                recovery_json: null,
              }),
          );
          let placement = ensureLocal(database.db, owner, 100);
          placement = updateTransition(database.db, placement, "requested", {}, 110);
          placement = updateTransition(
            database.db,
            placement,
            "provisioning",
            { environmentId: input.environmentId },
            120,
          );
          updateTransition(
            database.db,
            placement,
            "failed",
            { recoveryError: "synthetic preallocation failure", terminalReason: "dispatch failed" },
            200,
          );
          // Use the canonical feature definitions for optional lifecycle blocker fixtures.
          database.db.exec(getOpenClawStateFeatureSchemaSql("worker_session_placement_moves"));
          database.db.exec(getOpenClawStateFeatureSchemaSql("worker_workspace_pending_results"));
          database.db.exec(getOpenClawStateFeatureSchemaSql("worker_workspace_reconciliations"));
        });
        run({
          db: database.db,
          transaction,
          snapshot: () => ({
            environments: database.db
              .prepare("SELECT * FROM worker_environments ORDER BY environment_id")
              .all(),
            placements: database.db
              .prepare("SELECT * FROM worker_session_placements ORDER BY session_id")
              .all(),
            workspace: database.db.prepare("SELECT * FROM session_repository_workspaces").all(),
            credentials: database.db.prepare("SELECT * FROM worker_environment_credentials").all(),
          }),
        });
      });
    } finally {
      await closeOpenClawStateDatabaseAsync();
      lease.release();
    }
  });
}

it("parks exact unadmitted teardown without changing original disk, lease, retention or source tuple; exact retry is read-only", async () => {
  await fixture(({ db, transaction, snapshot }) => {
    const original = getRequiredWorkerEnvironment(db, input.environmentId);
    const workspace = db.prepare("SELECT * FROM session_repository_workspaces").get();
    expect(transaction(() => park(db, input, 300))).toMatchObject({
      changed: true,
      environmentState: "orphaned",
      environmentOwnerEpoch: 0,
      placementGeneration: 4,
      cleanupCanceled: true,
      leaseId: input.leaseId,
    });
    const parked = getRequiredWorkerEnvironment(db, input.environmentId);
    expect(parked).toMatchObject({
      state: "orphaned",
      leaseId: original.leaseId,
      ownerEpoch: 0,
      retention: original.retention,
      profileSnapshot: original.profileSnapshot,
      provisionOperationId: original.provisionOperationId,
      destroyRequestedAtMs: null,
      teardownTerminalState: null,
      bootstrapReceipt: null,
    });
    expect(isRetainedWorkspaceOwnerRepairHold(parked.lastError)).toBe(true);
    expect(findPlacement(db, owner.sessionId)).toMatchObject({
      state: "local",
      generation: 4,
      environmentId: null,
      turnClaim: null,
    });
    expect(db.prepare("SELECT * FROM session_repository_workspaces").get()).toEqual(workspace);
    const accepted = snapshot();
    expect(transaction(() => park(db, input, 400)).changed).toBe(false);
    expect(snapshot()).toEqual(accepted);
    expect(() => transaction(() => park(db, { ...input, destroyRequestedAtMs: 201 }, 400))).toThrow(
      "teardown or failed placement changed",
    );
    expect(snapshot()).toEqual(accepted);
  });
});

it.each([0, 900])(
  "resumes only the original parked intent with a fresh epoch above original/global custody (%s)",
  async (floor) => {
    await fixture(({ db, transaction }) => {
      transaction(() => park(db, input, 300));
      if (floor) {
        transaction(() => {
          db.prepare(`INSERT INTO worker_transcript_commit_heads(session_id,run_epoch,environment_id,next_seq,updated_at_ms)
        VALUES ('synthetic-historical',?,'synthetic-other',1,300)`).run(floor);
        });
      }
      const original = getRequiredWorkerEnvironment(db, input.environmentId);
      const result = transaction(() =>
        resume(
          db,
          {
            environmentId: input.environmentId,
            expectedOwnerEpoch: 0,
            owner,
            expectedDiskAuthority: input.expectedDiskAuthority,
          },
          400,
        ),
      );
      expect(result).toMatchObject({
        environmentId: original.environmentId,
        state: "requested",
        leaseId: null,
        provisionOperationId: original.provisionOperationId,
        retention: original.retention,
        ownerEpoch: Math.max(713, floor) + 1,
        bootstrapReceipt: null,
        destroyRequestedAtMs: null,
        lastError: null,
      });
      expect(
        db.prepare("SELECT disk_authority_json FROM session_repository_workspaces").get(),
      ).toEqual({ disk_authority_json: JSON.stringify(input.expectedDiskAuthority) });
      expect(() =>
        transaction(() =>
          resume(
            db,
            {
              environmentId: input.environmentId,
              expectedOwnerEpoch: 0,
              owner,
              expectedDiskAuthority: input.expectedDiskAuthority,
            },
            500,
          ),
        ),
      ).toThrow();
    });
  },
);

const blockers = [
  [
    "admitted epoch",
    (db: EngineConnection) => db.prepare("UPDATE worker_environments SET owner_epoch=1").run(),
  ],
  [
    "partial bootstrap",
    (db: EngineConnection) =>
      db.prepare("UPDATE worker_environments SET bootstrap_install_kind='bundle'").run(),
  ],
  [
    "partial transport",
    (db: EngineConnection) =>
      db.prepare("UPDATE worker_environments SET ssh_host='synthetic-host'").run(),
  ],
  [
    "explicit discard",
    (db: EngineConnection) =>
      db
        .prepare("UPDATE worker_environments SET last_error=?")
        .run(FORCED_WORKER_ABANDONMENT_ERROR),
  ],
  [
    "retention operation",
    (db: EngineConnection) =>
      db.prepare("UPDATE worker_environments SET session_retention_json=?").run(
        JSON.stringify({
          ...retention,
          operation: {
            id: "synthetic-pause",
            action: "pause",
            expectedClaimRevision: "synthetic-revision",
          },
        }),
      ),
  ],
  [
    "credentials",
    (db: EngineConnection) =>
      db
        .prepare(`INSERT INTO worker_environment_credentials
    (environment_id,credential_hash,bundle_hash,session_id,rpc_set_version,owner_epoch,expires_at_ms,delivered_at_ms)
    VALUES (?,?,?,NULL,1,1,1000,NULL)`)
        .run(input.environmentId, "d".repeat(64), "e".repeat(64)),
  ],
  [
    "turn claim",
    (db: EngineConnection) =>
      db
        .prepare(`UPDATE worker_session_placements SET
    turn_claim_owner='local',turn_claim_id='synthetic-claim',turn_claim_run_id='synthetic-run',turn_claim_generation=3`)
        .run(),
  ],
  [
    "attachment",
    (db: EngineConnection) =>
      db
        .prepare(`INSERT INTO worker_environment_session_attachments
      (session_id,session_key,agent_id,session_lifecycle_revision,environment_id,generation,created_at_ms,last_used_at_ms,closed_at_ms)
      VALUES (?,?,'main',NULL,?,1,100,200,NULL)`)
        .run(owner.sessionId, owner.sessionKey, input.environmentId),
  ],
  [
    "placement move",
    (db: EngineConnection) =>
      db
        .prepare(`INSERT INTO worker_session_placement_moves
    (session_id,operation_id,source_environment_id,source_owner_epoch,source_generation,target_kind,target_id,target_machine_class,target_os,abandon_source,created_at_ms,updated_at_ms,last_error)
    VALUES (?,'synthetic-move',?,713,3,'gateway',NULL,NULL,NULL,0,200,200,NULL)`)
        .run(owner.sessionId, input.environmentId),
  ],
  [
    "pending result",
    (db: EngineConnection) =>
      db
        .prepare(`INSERT INTO worker_workspace_pending_results
    (session_id,environment_id,owner_epoch,placement_generation,claim_id,run_id,gateway_instance_id,created_at_ms)
    VALUES (?, ?,713,3,'synthetic-claim','synthetic-run','synthetic-gateway',200)`)
        .run(owner.sessionId, input.environmentId),
  ],
  [
    "reconciliation journal",
    (db: EngineConnection) =>
      db
        .prepare(`INSERT INTO worker_workspace_reconciliations
      (session_id,environment_id,owner_epoch,placement_generation,base_manifest_ref,current_manifest_ref,plan_json,base_pack,created_at_ms)
      VALUES (?,?,713,3,?,?,'{}',?,200)`)
        .run(
          owner.sessionId,
          input.environmentId,
          `sha256:${"a".repeat(64)}`,
          `sha256:${"b".repeat(64)}`,
          Buffer.alloc(0),
        ),
  ],
] as const;
it.each(blockers)(
  "refuses %s without modifying the parked-owner preimage",
  async (_name, mutate) => {
    await fixture(({ db, transaction, snapshot }) => {
      transaction(() => mutate(db));
      const before = snapshot();
      expect(() => transaction(() => park(db, input, 300))).toThrow();
      expect(snapshot()).toEqual(before);
    });
  },
);

it("refuses changed disk or workspace revision and never resumes an unmarked terminal owner", async () => {
  await fixture(({ db, transaction, snapshot }) => {
    const before = snapshot();
    expect(() => transaction(() => park(db, { ...input, workspaceRevision: 4 }, 300))).toThrow();
    expect(() =>
      transaction(() =>
        park(
          db,
          {
            ...input,
            expectedDiskAuthority: { ...input.expectedDiskAuthority, ownerBinding: "different" },
          },
          300,
        ),
      ),
    ).toThrow();
    expect(snapshot()).toEqual(before);
    transaction(() => park(db, input, 300));
    transaction(() => {
      db.prepare("UPDATE worker_environments SET last_error='unrelated terminal failure'").run();
    });
    const unmarked = snapshot();
    expect(() =>
      transaction(() =>
        resume(
          db,
          {
            environmentId: input.environmentId,
            expectedOwnerEpoch: 0,
            owner,
            expectedDiskAuthority: input.expectedDiskAuthority,
          },
          400,
        ),
      ),
    ).toThrow();
    expect(snapshot()).toEqual(unmarked);
  });
});

it("transfers only the disk execution epoch after exact fresh node/retention admission", async () => {
  await fixture((value) => {
    const before = value.db.prepare("SELECT * FROM session_repository_workspaces").get();
    const { request } = admitFreshOwner(value);
    expect(
      value.transaction(() =>
        rebindSessionRepositoryWorkspaceOwnerInDatabase(value.db, request, 700),
      ),
    ).toMatchObject({
      changed: true,
      workspace: { revision: 4, diskAuthority: request.diskAuthority },
    });
    expect(value.db.prepare("SELECT * FROM session_repository_workspaces").get()).toEqual({
      ...before,
      disk_authority_json: JSON.stringify(request.diskAuthority),
      revision: 4,
      updated_at_ms: 700,
    });
  });
});

it.each(["resource", "binding", "epoch"] as const)(
  "refuses changing retained %s while rebinding an execution epoch",
  async (change) => {
    await fixture((value) => {
      const { request } = admitFreshOwner(value);
      const changed =
        change === "resource"
          ? {
              ...request.diskAuthority,
              identity: { ...request.diskAuthority.identity, resourceId: "different-resource" },
            }
          : change === "binding"
            ? { ...request.diskAuthority, ownerBinding: "different-binding" }
            : { ...request.diskAuthority, ownerEpoch: input.expectedDiskAuthority.ownerEpoch };
      const before = value.snapshot();
      expect(() =>
        value.transaction(() =>
          rebindSessionRepositoryWorkspaceOwnerInDatabase(
            value.db,
            { ...request, diskAuthority: changed },
            700,
          ),
        ),
      ).toThrow();
      expect(value.snapshot()).toEqual(before);
    });
  },
);

it.each([
  "missing",
  "native-pending",
  "provider-pending",
  "expired",
  "invalid-expiry",
  "unverified",
  "suspended",
] as const)(
  "refuses %s retained receipt at epoch transfer without changing checkpoint/source metadata",
  async (change) => {
    await fixture((value) => {
      const { request, receipt } = admitFreshOwner(value);
      const altered =
        change === "missing"
          ? null
          : change === "provider-pending"
            ? {
                ...receipt,
                operation: {
                  id: "synthetic-pending",
                  action: "resume",
                  phase: "pending",
                  expectedClaimRevision: "synthetic-revision",
                },
              }
            : change === "expired"
              ? {
                  ...receipt,
                  computeWindow: {
                    ...receipt.computeWindow,
                    expiresAt: new Date(600).toISOString(),
                  },
                }
              : change === "invalid-expiry"
                ? { ...receipt, computeWindow: { ...receipt.computeWindow, expiresAt: "invalid" } }
                : change === "unverified"
                  ? { ...receipt, policyVerified: false }
                  : change === "suspended"
                    ? { ...receipt, desiredState: "suspended" }
                    : receipt;
      value.transaction(() => {
        value.db.prepare("UPDATE worker_environments SET session_retention_json=?").run(
          JSON.stringify({
            ...retention,
            receipt: altered,
            operation:
              change === "native-pending"
                ? {
                    id: "synthetic-pending",
                    action: "resume",
                    expectedClaimRevision: "synthetic-revision",
                  }
                : null,
          }),
        );
      });
      const before = value.snapshot();
      expect(() =>
        value.transaction(() =>
          rebindSessionRepositoryWorkspaceOwnerInDatabase(value.db, request, 700),
        ),
      ).toThrow();
      expect(value.snapshot()).toEqual(before);
    });
  },
);
