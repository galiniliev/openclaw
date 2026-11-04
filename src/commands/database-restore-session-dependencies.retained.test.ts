import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { prepareSkillLibraryBundle } from "../skills/library/bundle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSessionDependencyArtifacts } from "./database-restore-session-dependencies.artifacts.js";
import { readSessionDependencyInput } from "./database-restore-session-dependencies.input.js";
import {
  assertRetainedDependencySession,
  currentRetainedDependencyProfile,
} from "./database-restore-session-dependencies.retained.js";

const ids = {
  source: "11111111-1111-4111-8111-111111111111",
  current: "22222222-2222-4222-8222-222222222222",
  skill: "33333333-3333-4333-8333-333333333333",
  workspace: "44444444-4444-4444-8444-444444444444",
  session: "55555555-5555-4555-8555-555555555555",
  resource: "66666666-6666-4666-8666-666666666666",
  subscription: "77777777-7777-4777-8777-777777777777",
};
const owner = {
  agentId: "main",
  sessionKey: "agent:main:synthetic-retained",
  sessionId: ids.session,
};
const policy = { mode: "session-disk" as const, computeWindowSeconds: 14400 };
const authority = {
  environmentId: "worker:synthetic-retained",
  sessionId: ids.session,
  ownerEpoch: 713,
  ownerBinding: "f".repeat(64),
  identity: {
    leaseId: "cbx_123456abcdef",
    attemptLeaseId: "cbx_123456abcdef",
    slug: "synthetic-original",
    resourceId: ids.resource,
  },
  workspaceDir: "/root/original-retained/workspace",
};
const expected = {
  sessionId: ids.session,
  environmentId: authority.environmentId,
  sourceOwnerEpoch: 713,
  sourcePlacementGeneration: 5,
  workspaceRevision: 2,
  leaseId: authority.identity.leaseId,
  ownerBinding: authority.ownerBinding,
  resourceId: ids.resource,
  workspaceDir: authority.workspaceDir,
  profileId: "current",
  providerScope: `azure-sandbox:westus3:${ids.subscription}:workers:group`,
};
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

it.each([
  "disk-only",
  "legacy",
  "mixed",
  "shared",
  "wrong-owner",
  "wrong-resource",
  "checkpoint-missing",
  "v1-null",
] as const)(
  "qualifies the sealed retained source through the public input/artifact owner (%s)",
  async (scenario) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const directory = path.join(state.env.OPENCLAW_STATE_DIR!, "recovery-input");
      fs.mkdirSync(path.join(directory, "skill-revision"), { recursive: true });
      const content =
        "---\nname: synthetic-skill\ndescription: Retained recovery fixture\n---\nFixture.\n";
      const skill = prepareSkillLibraryBundle([{ path: "SKILL.md", content, encoding: "utf8" }]);
      fs.writeFileSync(path.join(directory, "skill-revision/SKILL.md"), content);
      const sourcePath = path.join(directory, "shared.sqlite");
      {
        using source = openNodeSqliteDatabase(sourcePath);
        const insert = (table: string, row: Record<string, string | number | null>) => {
          const columns = Object.keys(row)
            .map((name) => `"${name}"`)
            .join(",");
          source.exec(`CREATE TABLE "${table}" (${columns})`);
          source
            .prepare(
              `INSERT INTO "${table}" (${columns}) VALUES (${Object.keys(row)
                .map(() => "?")
                .join(",")})`,
            )
            .run(...Object.values(row));
        };
        insert("user_profiles", {
          id: ids.source,
          display_name: null,
          avatar: null,
          avatar_mime: null,
          avatar_sha256: null,
          merged_into: null,
          created_at: 1,
          updated_at: 2,
        });
        insert("user_profile_identities", {
          provider: "github:microsoft.ghe.com",
          subject: "12345",
          profile_id: ids.source,
        });
        insert("user_profile_emails", {
          email: "github:microsoft.ghe.com:12345",
          profile_id: ids.source,
        });
        insert("skill_library_entries", {
          skill_id: ids.skill,
          owner_profile_id: ids.source,
          author_profile_id: ids.source,
          slug: "synthetic-skill",
          current_revision: skill.revision,
          shared: 0,
          enabled: 1,
          removed: 0,
          created_at: 1,
          updated_at: 2,
        });
        insert("skill_library_revisions", {
          skill_id: ids.skill,
          revision: skill.revision,
          description: skill.description,
          files_json: JSON.stringify(
            skill.files.map(({ path: relativePath, sha256, sizeBytes, executable }) => ({
              path: relativePath,
              sha256,
              sizeBytes,
              executable,
            })),
          ),
          created_at: 1,
        });
        const checkpoint = scenario === "legacy" || scenario === "checkpoint-missing";
        insert("session_repository_workspaces", {
          workspace_id: ids.workspace,
          agent_id: owner.agentId,
          session_key: owner.sessionKey,
          url: "https://enterprise.example.test/fixture/repository.git",
          requested_ref: null,
          run_setup_script: 1,
          base_commit: "a".repeat(40),
          base_manifest_hash: `sha256:${"b".repeat(64)}`,
          branch: "fixture/retained",
          checkpoint_ref: checkpoint ? "refs/openclaw/worker-results/fixture" : null,
          manifest_hash: checkpoint || scenario === "mixed" ? `sha256:${"c".repeat(64)}` : null,
          revision: 2,
          created_at_ms: 1,
          updated_at_ms: 2,
          recovery_json: null,
          disk_authority_json: scenario === "legacy" ? null : JSON.stringify(authority),
        });
        insert("worker_session_placements", {
          session_id: ids.session,
          agent_id: owner.agentId,
          session_key: owner.sessionKey,
          state: "active",
          environment_id: authority.environmentId,
          transition_generation: 5,
          active_owner_epoch: 713,
          remote_workspace_dir: authority.workspaceDir,
        });
        const receipt = {
          schema: "crabbox.session-disk.v1",
          mode: "session-disk",
          ownerBinding: authority.ownerBinding,
          identity: authority.identity,
          claimRevision: "historical-claim",
          computeWindowSeconds: 14400,
          desiredState: "running",
          observedState: "Stopped",
          policyVerified: true,
          stopPending: false,
          computeWindow: {
            id: "expired-original-window",
            authorizedAt: "2026-10-25T00:00:00Z",
            expiresAt: "2026-10-25T04:00:00Z",
            state: "active",
          },
        };
        insert("worker_environments", {
          environment_id: authority.environmentId,
          provider_id: "crabbox",
          state: "attached",
          owner_epoch: 713,
          lease_id: authority.identity.leaseId,
          shared_host: scenario === "shared" ? 1 : 0,
          provision_operation_id: "provision:original-sealed-operation",
          destroy_requested_at_ms: null,
          profile_snapshot_json: JSON.stringify({
            settings: { provider: "azure-sandbox", unusedPrivateValue: "never-import" },
          }),
          attached_session_ids_json: JSON.stringify([ids.session]),
          session_retention_json: JSON.stringify({
            owner: scenario === "wrong-owner" ? { ...owner, sessionId: ids.current } : owner,
            ownerBinding: authority.ownerBinding,
            policy,
            desiredState: "running",
            receipt,
            operation: null,
          }),
        });
      }
      const request = {
        version: scenario === "v1-null" ? 1 : 3,
        action: "restore-missing-bindings",
        sourceSha256: sha(fs.readFileSync(sourcePath)),
        sourceProfileId: ids.source,
        currentProfileId: ids.current,
        expectedIdentity: { provider: "github:microsoft.ghe.com", subject: "12345" },
        skillId: ids.skill,
        skillRevision: skill.revision,
        workspaceId: ids.workspace,
        agentId: owner.agentId,
        sessionKey: owner.sessionKey,
        expected: {
          ...expected,
          resourceId: scenario === "wrong-resource" ? ids.current : ids.resource,
        },
      };
      // V1 remains its original shape and cannot accept a nullable checkpoint.
      const selected =
        scenario === "v1-null"
          ? {
              version: 1,
              sourceSha256: request.sourceSha256,
              sourceProfileId: ids.source,
              currentProfileId: ids.current,
              expectedIdentity: request.expectedIdentity,
              skillId: ids.skill,
              skillRevision: skill.revision,
              workspaceId: ids.workspace,
              agentId: owner.agentId,
              sessionKey: owner.sessionKey,
            }
          : request;
      const bytes = Buffer.from(JSON.stringify(selected));
      fs.writeFileSync(path.join(directory, "request.json"), bytes);
      const read = () => readSessionDependencyInput(directory, sha(bytes));
      if (!["disk-only", "legacy", "checkpoint-missing"].includes(scenario)) {
        await expect(read()).rejects.toThrow();
        return;
      }
      const input = await read();
      expect(input.retained).toEqual({
        authority,
        policy,
        sourcePlacementGeneration: 5,
        provisionOperationId: "provision:original-sealed-operation",
      });
      expect(JSON.parse(input.rows.workspace.disk_authority_json!)).toEqual(authority);
      if (scenario === "disk-only") {
        expect((await prepareSessionDependencyArtifacts(input)).checkpointRef).toBeNull();
        expect(fs.existsSync(path.join(directory, "workspace.git"))).toBe(false);
      } else if (scenario === "checkpoint-missing") {
        await expect(prepareSessionDependencyArtifacts(input)).rejects.toThrow();
      }
    });
  },
);

it.each(["current", "deleted", "archived", "rebound", "different-workspace"] as const)(
  "fences actual target session disposition (%s)",
  (scenario) => {
    const request = { workspaceId: ids.workspace, expected };
    const entry =
      scenario === "deleted"
        ? undefined
        : {
            sessionId: scenario === "rebound" ? ids.current : ids.session,
            updatedAt: 1,
            ...(scenario === "archived" ? { archivedAt: 100 } : {}),
            repositoryWorkspaceId: scenario === "different-workspace" ? ids.current : ids.workspace,
          };
    if (scenario === "current") {
      expect(() => assertRetainedDependencySession(entry, request)).not.toThrow();
    } else {
      expect(() => assertRetainedDependencySession(entry, request)).toThrow(
        /deleted, archived or rebound/,
      );
    }
  },
);

it("requires the current configured profile and canonical explicit route", () => {
  const config = {
    cloudWorkers: {
      profiles: {
        current: {
          provider: "crabbox",
          settings: { provider: "azure-sandbox" },
          retention: policy,
        },
      },
    },
  };
  const env = {
    CRABBOX_AZURE_SANDBOX_REGION: "westus3",
    CRABBOX_AZURE_SANDBOX_SUBSCRIPTION_ID: ids.subscription,
    CRABBOX_AZURE_SANDBOX_RESOURCE_GROUP: "workers",
    CRABBOX_AZURE_SANDBOX_GROUP: "group",
  };
  const source = {
    authority,
    policy,
    sourcePlacementGeneration: 5,
    provisionOperationId: "provision:original-sealed-operation",
  };
  expect(currentRetainedDependencyProfile(config, env, expected, source)).toMatchObject({
    retention: policy,
  });
  expect(() =>
    currentRetainedDependencyProfile(
      config,
      { ...env, CRABBOX_AZURE_SANDBOX_GROUP: "foreign" },
      expected,
      source,
    ),
  ).toThrow(/route differs/);
});
