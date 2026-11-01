import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  restoreMissingRetainedWorkspaceOwnerInDatabase,
  RESTORED_RETAINED_WORKSPACE_OWNER_HOLD,
} from "../gateway/worker-environments/retained-workspace-owner-repair.kernel.js";
import { getRequiredWorkerEnvironment } from "../gateway/worker-environments/store-row-codec.js";
import { createWorkerEnvironmentStoreKernel } from "../gateway/worker-environments/store.kernel.js";
import { acquireStateDatabaseSchemaLease } from "../infra/gateway-state-owner.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { ensureSkillLibrarySchema, selectSkillLibraryOwner } from "../skills/library/store.js";
import { ensureSessionRepositoryWorkspaceSchema } from "../state/openclaw-state-db-schema-additive.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { selectUserProfileIdentityInDatabase } from "../state/user-profile-identity.read.js";
import { selectResolvedUserProfileById, userProfilesDb } from "../state/user-profiles-internal.js";
import { ensureUserProfilesSchema } from "../state/user-profiles-schema.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  restoreSessionDependencyRows,
  type PreparedSessionDependencyRows,
  type RestoreSelection,
} from "./database-restore-session-dependencies.kernel.js";

const selection: RestoreSelection = {
  sourceProfileId: "11111111-1111-4111-8111-111111111111",
  currentProfileId: "22222222-2222-4222-8222-222222222222",
  expectedIdentity: { provider: "github:enterprise.example.test", subject: "12345" },
  skillId: "33333333-3333-4333-8333-333333333333",
  skillRevision: "a".repeat(64),
  workspaceId: "44444444-4444-4444-8444-444444444444",
  agentId: "main",
  sessionKey: "agent:main:synthetic-restored-session",
};
const avatar = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
  "base64",
);

function sourceRows(): PreparedSessionDependencyRows {
  return {
    sourceProfile: {
      id: selection.sourceProfileId,
      display_name: "Historical display",
      avatar,
      avatar_mime: "image/png",
      avatar_sha256: createHash("sha256").update(avatar).digest("hex"),
      merged_into: null,
      // These source authority fields must never be imported.
      role: "admin",
      primary_github_account_id: 67890,
      created_at: 10,
      updated_at: 20,
    },
    skillEntry: {
      skill_id: selection.skillId,
      owner_profile_id: selection.sourceProfileId,
      author_profile_id: selection.sourceProfileId,
      slug: "synthetic-restored-skill",
      current_revision: selection.skillRevision,
      shared: 0,
      enabled: 1,
      removed: 0,
      created_at: 30,
      updated_at: 40,
    },
    skillRevision: {
      skill_id: selection.skillId,
      revision: selection.skillRevision,
      description: "Synthetic retained revision",
      files_json: "[]",
      created_at: 30,
    },
    workspace: {
      workspace_id: selection.workspaceId,
      agent_id: selection.agentId,
      session_key: selection.sessionKey,
      url: "https://enterprise.example.test/example/synthetic.git",
      requested_ref: "main",
      run_setup_script: 0,
      base_commit: "b".repeat(40),
      base_manifest_hash: `sha256:${"c".repeat(64)}`,
      branch: "synthetic/restored-workspace",
      checkpoint_ref: "refs/openclaw/worker-results/synthetic-retained",
      manifest_hash: `sha256:${"d".repeat(64)}`,
      revision: 3,
      created_at_ms: 50,
      updated_at_ms: 60,
      recovery_json: null,
      disk_authority_json: null,
    },
  };
}

type Fixture = {
  database: ReturnType<typeof openOpenClawStateDatabase>;
  db: EngineConnection;
  rows: PreparedSessionDependencyRows;
  transaction<T>(this: void, run: () => T): T;
  snapshot(this: void): unknown;
};

async function withFixture(run: (fixture: Fixture) => void): Promise<void> {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    const lease = acquireStateDatabaseSchemaLease(resolveOpenClawStateSqlitePath(state.env));
    try {
      lease.run(() => {
        const database = openOpenClawStateDatabase({ env: state.env });
        const options = { env: state.env, database };
        ensureUserProfilesSchema(options, database);
        ensureSkillLibrarySchema(options, () => lease.assertCurrent());
        const transaction = <T>(operation: () => T) =>
          runOpenClawStateWriteTransaction(operation, options);
        transaction(() => {
          ensureSessionRepositoryWorkspaceSchema(database.db);
          const profiles = userProfilesDb(database.db);
          executeSqliteQuerySync(
            database.db,
            profiles.insertInto("user_profiles").values({
              id: selection.currentProfileId,
              display_name: "Current display",
              avatar: null,
              avatar_mime: null,
              avatar_sha256: null,
              primary_github_account_id: null,
              role: "maintainer",
              merged_into: null,
              created_at: 100,
              updated_at: 200,
            }),
          );
          executeSqliteQuerySync(
            database.db,
            profiles.insertInto("user_profile_identities").values({
              ...selection.expectedIdentity,
              profile_id: selection.currentProfileId,
              canonical_login: "synthetic-user",
              verified_email_json: null,
              authorization_id: "synthetic-existing-authorization",
              authorization_basis_json: null,
              created_at: 100,
            }),
          );
          executeSqliteQuerySync(
            database.db,
            profiles.insertInto("user_profile_emails").values({
              email: `${selection.expectedIdentity.provider}:${selection.expectedIdentity.subject}`,
              profile_id: selection.currentProfileId,
              binding_id: "synthetic-existing-binding",
              created_at: 100,
            }),
          );
        });
        run({
          database,
          db: database.db,
          rows: sourceRows(),
          transaction,
          // Independent SQL oracle covers rollback across all restored domains.
          snapshot: () => ({
            profiles: database.db.prepare("SELECT * FROM user_profiles ORDER BY id").all(),
            identities: database.db
              .prepare("SELECT * FROM user_profile_identities ORDER BY provider, subject")
              .all(),
            aliases: database.db.prepare("SELECT * FROM user_profile_emails ORDER BY email").all(),
            skills: database.db
              .prepare("SELECT * FROM skill_library_entries ORDER BY skill_id")
              .all(),
            revisions: database.db
              .prepare("SELECT * FROM skill_library_revisions ORDER BY skill_id, revision")
              .all(),
            workspaces: database.db
              .prepare("SELECT * FROM session_repository_workspaces ORDER BY workspace_id")
              .all(),
          }),
        });
      });
    } finally {
      await closeOpenClawStateDatabaseAsync();
      lease.release();
    }
  });
}

it("merges only the selected historical metadata and retains exact dependency identities on an idempotent retry", async () => {
  await withFixture(({ db, rows, transaction, snapshot }) => {
    const identityBefore = db.prepare("SELECT * FROM user_profile_identities").all();
    const aliasesBefore = db.prepare("SELECT * FROM user_profile_emails").all();
    expect(transaction(() => restoreSessionDependencyRows(db, rows, selection))).toEqual({
      profileMerged: true,
      skillRestored: true,
      workspaceRestored: true,
    });
    const resolved = selectResolvedUserProfileById(db, selection.sourceProfileId);
    expect(resolved).toMatchObject({
      id: selection.currentProfileId,
      display_name: "Current display",
      role: "maintainer",
      avatar_mime: "image/png",
      avatar_sha256: rows.sourceProfile.avatar_sha256,
      primary_github_account_id: null,
      created_at: 100,
    });
    expect(Buffer.from(resolved!.avatar!)).toEqual(avatar);
    expect(selectUserProfileIdentityInDatabase(db, selection.sourceProfileId)).toMatchObject({
      profileId: selection.currentProfileId,
      aliases: new Set([selection.sourceProfileId, selection.currentProfileId]),
    });
    expect(
      db
        .prepare(
          "SELECT display_name, role, primary_github_account_id, merged_into, created_at FROM user_profiles WHERE id = ?",
        )
        .get(selection.sourceProfileId),
    ).toEqual({
      display_name: "Historical display",
      role: null,
      primary_github_account_id: null,
      merged_into: selection.currentProfileId,
      created_at: 10,
    });
    expect(db.prepare("SELECT * FROM user_profile_identities").all()).toEqual(
      identityBefore.map((row) =>
        Object.assign({}, row, {
          // The canonical merge preserves the identity binding and revokes its
          // previous recovery authority; restoration must never reinstate it.
          authorization_id: null,
          authorization_basis_json: null,
        }),
      ),
    );
    expect(db.prepare("SELECT * FROM user_profile_emails").all()).toEqual(aliasesBefore);
    expect(selectSkillLibraryOwner(db, rows.skillEntry.owner_profile_id!)?.id).toBe(
      selection.currentProfileId,
    );
    expect(db.prepare("SELECT * FROM skill_library_entries").get()).toEqual(rows.skillEntry);
    expect(db.prepare("SELECT * FROM skill_library_revisions").get()).toEqual(rows.skillRevision);
    expect(db.prepare("SELECT * FROM session_repository_workspaces").get()).toEqual(rows.workspace);
    const accepted = snapshot();
    expect(transaction(() => restoreSessionDependencyRows(db, rows, selection))).toEqual({
      profileMerged: false,
      skillRestored: false,
      workspaceRestored: false,
    });
    expect(snapshot()).toEqual(accepted);
  });
});

it("refuses an updated existing revision without regressing any current rows", async () => {
  await withFixture(({ db, rows, transaction, snapshot }) => {
    transaction(() =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .insertInto("skill_library_revisions")
          .values({ ...rows.skillRevision, description: "Current newer description" }),
      ),
    );
    const before = snapshot();
    expect(() => transaction(() => restoreSessionDependencyRows(db, rows, selection))).toThrow(
      "differs from the selected source",
    );
    expect(snapshot()).toEqual(before);
  });
});

it("rolls back profile merge and avatar publication when a later canonical skill-name conflict refuses the restore", async () => {
  await withFixture(({ db, rows, transaction, snapshot }) => {
    transaction(() =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .insertInto("skill_library_entries")
          .values({
            ...rows.skillEntry,
            skill_id: "55555555-5555-4555-8555-555555555555",
            owner_profile_id: selection.currentProfileId,
          }),
      ),
    );
    const before = snapshot();
    expect(() => transaction(() => restoreSessionDependencyRows(db, rows, selection))).toThrow(
      "already exists in this library",
    );
    expect(snapshot()).toEqual(before);
    expect(selectResolvedUserProfileById(db, selection.sourceProfileId)).toBeUndefined();
  });
});

it("refuses an identity binding to a different profile before importing historical dependencies", async () => {
  await withFixture(({ db, rows, transaction, snapshot }) => {
    transaction(() =>
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .updateTable("user_profile_emails")
          .set({ profile_id: "66666666-6666-4666-8666-666666666666" }),
      ),
    );
    const before = snapshot();
    expect(() => transaction(() => restoreSessionDependencyRows(db, rows, selection))).toThrow(
      "does not own the exact existing identity and alias",
    );
    expect(snapshot()).toEqual(before);
  });
});
it("verifies already-restored dependencies without merging again or revoking current authorization", async () => {
  await withFixture(({ db, rows, transaction, snapshot }) => {
    const before = snapshot();
    expect(() =>
      transaction(() => restoreSessionDependencyRows(db, rows, selection, { verifyOnly: true })),
    ).toThrow("must already be restored");
    expect(snapshot()).toEqual(before);
    transaction(() => restoreSessionDependencyRows(db, rows, selection));
    db.prepare("UPDATE user_profile_identities SET authorization_id = ? WHERE profile_id = ?").run(
      "synthetic-new-authorization",
      selection.currentProfileId,
    );
    const restored = snapshot();
    expect(
      transaction(() => restoreSessionDependencyRows(db, rows, selection, { verifyOnly: true })),
    ).toEqual({ profileMerged: false, skillRestored: false, workspaceRestored: false });
    expect(snapshot()).toEqual(restored);
  });
});

it.each(["restore", "occupied", "changed-retry"] as const)(
  "restores only a missing dormant retained owner (%s)",
  async (scenario) => {
    await withFixture(({ database, db, rows, transaction }) => {
      const authority = {
        environmentId: "synthetic-retained-environment",
        sessionId: "55555555-5555-4555-8555-555555555555",
        ownerEpoch: 713,
        ownerBinding: "f".repeat(64),
        identity: {
          leaseId: "cbx_123456abcdef",
          attemptLeaseId: "cbx_123456abcdef",
          slug: "synthetic-retained",
          resourceId: "66666666-6666-4666-8666-666666666666",
        },
        workspaceDir: "/root/original-retained/workspace",
      };
      const owner = {
        agentId: selection.agentId,
        sessionKey: selection.sessionKey,
        sessionId: authority.sessionId,
      };
      const profileSnapshot = {
        settings: { provider: "azure-sandbox" },
        retention: { mode: "session-disk" as const, computeWindowSeconds: 14400 },
      };
      rows.workspace.disk_authority_json = JSON.stringify(authority);
      const environments = createWorkerEnvironmentStoreKernel(database, () => 300);
      transaction(() => restoreSessionDependencyRows(db, rows, selection));
      const input = {
        owner,
        authority,
        policy: profileSnapshot.retention,
        profileId: "qualified-current",
        profileSnapshot,
        sourcePlacementGeneration: 5,
        providerScope: "azure-sandbox:westus3:77777777-7777-4777-8777-777777777777:workers:group",
        provisionOperationId: "provision:original-sealed-operation",
      };
      const restore = () =>
        transaction(() =>
          restoreMissingRetainedWorkspaceOwnerInDatabase(db, input, environments.createIntent, 300),
        );
      if (scenario === "occupied") {
        transaction(() =>
          environments.createIntent({
            environmentId: authority.environmentId,
            providerId: "crabbox",
            profileId: input.profileId,
            profileSnapshot,
            provisionOperationId: "another-live-intent",
          }),
        );
        expect(restore).toThrow(/exact unadmitted owner|occupied or changed/);
        expect(getRequiredWorkerEnvironment(db, authority.environmentId).state).toBe("requested");
        return;
      }
      const result = restore();
      expect(result).toMatchObject({
        version: 2,
        status: "restored-dormant",
        environmentOwnerEpoch: 0,
        executionReady: false,
        computeAuthorized: false,
        cleanupDisarmed: true,
        identity: authority.identity,
      });
      const dormant = getRequiredWorkerEnvironment(db, authority.environmentId);
      expect(dormant).toMatchObject({
        state: "orphaned",
        ownerEpoch: 0,
        leaseId: authority.identity.leaseId,
        sharedHost: false,
        lastError: RESTORED_RETAINED_WORKSPACE_OWNER_HOLD,
        nodeSetupId: null,
        nodeDeviceId: null,
        sshEndpoint: null,
        bootstrapReceipt: null,
        lastActivatedAtMs: null,
        attachedSessionIds: [],
        destroyRequestedAtMs: null,
        provisionOperationId: input.provisionOperationId,
        retention: {
          owner,
          ownerBinding: authority.ownerBinding,
          desiredState: "suspended",
          receipt: null,
          operation: null,
        },
      });
      expect(db.prepare("SELECT count(*) AS n FROM worker_session_placements").get()).toMatchObject(
        { n: 0 },
      );
      expect(
        db.prepare("SELECT count(*) AS n FROM worker_environment_credentials").get(),
      ).toMatchObject({ n: 0 });
      if (scenario === "changed-retry") {
        expect(() =>
          transaction(() =>
            restoreMissingRetainedWorkspaceOwnerInDatabase(
              db,
              { ...input, profileId: "different-current-profile" },
              environments.createIntent,
              400,
            ),
          ),
        ).toThrow(/occupied or changed/);
      } else {
        expect(restore()).toMatchObject({ status: "already-restored-dormant" });
      }
      expect(getRequiredWorkerEnvironment(db, authority.environmentId)).toEqual(dormant);
    });
  },
);
