import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  MAX_USER_PROFILE_AVATAR_BYTES,
  USER_PROFILE_AVATAR_MIME_TYPES,
} from "../shared/avatar-limits.js";
import { parseEnterpriseGitHubPrincipal } from "../shared/enterprise-github-principal.js";
import { captureDatabaseArtifact } from "../snapshot/database-backup.js";
import type { PreparedSessionDependencyRows } from "./database-restore-session-dependencies.kernel.js";
import {
  readRetainedDependencySource,
  RestoreMissingBindingsExpectedSchema,
} from "./database-restore-session-dependencies.retained.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().max(4096);
const time = z.number().int().nonnegative();
const flag = z.union([z.literal(0), z.literal(1)]);
const selectionFields = {
  sourceSha256: hash,
  sourceProfileId: z.uuid(),
  currentProfileId: z.uuid(),
  expectedIdentity: z.strictObject({ provider: text, subject: text }),
  skillId: z.uuid(),
  skillRevision: hash,
  workspaceId: z.uuid(),
  agentId: z.string().min(1).max(128),
  sessionKey: z.string().min(1).max(4096),
};
export const sessionDependencyRequestSchema = z.discriminatedUnion("version", [
  z.strictObject({ version: z.literal(1), ...selectionFields }),
  z.strictObject({
    version: z.literal(2),
    action: z.literal("repair-retained-owner"),
    ...selectionFields,
    expected: z.strictObject({
      sessionId: z.uuid(),
      environmentId: z.string().min(1).max(256),
      environmentState: z.literal("destroying"),
      environmentOwnerEpoch: z.literal(0),
      leaseId: z.string().min(1).max(256),
      destroyRequestedAtMs: time,
      placementGeneration: z.number().int().positive(),
      workspaceRevision: time,
    }),
  }),
  z.strictObject({
    version: z.literal(3),
    action: z.literal("restore-missing-bindings"),
    ...selectionFields,
    expected: RestoreMissingBindingsExpectedSchema,
  }),
]);
const profileSchema = z.object({
  id: z.uuid(),
  display_name: z.string().max(256).nullable(),
  avatar: z.instanceof(Uint8Array).nullable(),
  avatar_mime: z.enum(USER_PROFILE_AVATAR_MIME_TYPES).nullable(),
  avatar_sha256: hash.nullable(),
  merged_into: z.null(),
  created_at: time,
  updated_at: time,
});
const entrySchema = z.strictObject({
  skill_id: z.uuid(),
  owner_profile_id: z.uuid(),
  author_profile_id: z.uuid(),
  slug: text,
  current_revision: hash,
  shared: flag,
  enabled: flag,
  removed: flag,
  created_at: time,
  updated_at: time,
});
const revisionSchema = z.strictObject({
  skill_id: z.uuid(),
  revision: hash,
  description: text,
  files_json: z.string(),
  created_at: time,
});
const workspaceSchema = z.strictObject({
  workspace_id: z.uuid(),
  agent_id: text,
  session_key: text,
  url: text,
  requested_ref: text.nullable(),
  run_setup_script: flag,
  base_commit: z
    .string()
    .regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u)
    .nullable(),
  base_manifest_hash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .nullable(),
  branch: text,
  checkpoint_ref: z.string().regex(/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u),
  manifest_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  revision: time,
  created_at_ms: time,
  updated_at_ms: time,
  recovery_json: text.nullable(),
  disk_authority_json: z.string().nullable(),
});
const retainedWorkspaceSchema = workspaceSchema.extend({
  checkpoint_ref: workspaceSchema.shape.checkpoint_ref.nullable(),
  manifest_hash: workspaceSchema.shape.manifest_hash.nullable(),
});

/** A sealed, fixed-layout operator bundle selects one dependency closure, never arbitrary SQL. */
export async function readSessionDependencyInput(directory: string, requestSha256: string) {
  const root = fs.realpathSync.native(directory);
  const requestPath = path.join(root, "request.json");
  const requestBytes = await captureDatabaseArtifact(requestPath);
  if (requestBytes.sha256 !== hash.parse(requestSha256) || requestBytes.size > 16384) {
    throw new Error("Dependency request seal or size is invalid.");
  }
  const request = sessionDependencyRequestSchema.parse(
    JSON.parse(fs.readFileSync(requestPath, "utf8")),
  );
  if (
    request.sourceProfileId === request.currentProfileId ||
    !parseEnterpriseGitHubPrincipal(
      `${request.expectedIdentity.provider}:${request.expectedIdentity.subject}`,
    )
  ) {
    throw new Error("Dependency request requires two profiles for one exact Enterprise identity.");
  }
  const sourcePath = path.join(root, "shared.sqlite");
  if (["-wal", "-shm", "-journal"].some((suffix) => fs.existsSync(sourcePath + suffix))) {
    throw new Error("Dependency source must be an immutable single-file SQLite capture.");
  }
  const source = await captureDatabaseArtifact(sourcePath);
  if (source.sha256 !== request.sourceSha256) {
    throw new Error("Dependency source checksum differs from the sealed request.");
  }
  using db = openNodeSqliteDatabase(sourcePath, { readOnly: true });
  const profile = profileSchema.parse(
    db
      .prepare(
        "SELECT id,display_name,avatar,avatar_mime,avatar_sha256,merged_into,created_at,updated_at FROM user_profiles WHERE id=?",
      )
      .get(request.sourceProfileId),
  );
  const identity = db
    .prepare("SELECT profile_id FROM user_profile_identities WHERE provider=? AND subject=?")
    .get(request.expectedIdentity.provider, request.expectedIdentity.subject);
  const alias = db
    .prepare("SELECT profile_id FROM user_profile_emails WHERE email=?")
    .get(`${request.expectedIdentity.provider}:${request.expectedIdentity.subject}`);
  if (identity?.profile_id !== profile.id || alias?.profile_id !== profile.id) {
    throw new Error("Original profile is not bound to the exact selected Enterprise identity.");
  }
  if (
    profile.avatar &&
    (profile.avatar.byteLength > MAX_USER_PROFILE_AVATAR_BYTES ||
      !profile.avatar_mime ||
      createHash("sha256").update(profile.avatar).digest("hex") !== profile.avatar_sha256)
  ) {
    throw new Error("Original profile portrait does not match its stored content identity.");
  }
  if (!profile.avatar && (profile.avatar_mime !== null || profile.avatar_sha256 !== null)) {
    throw new Error("Original profile portrait metadata is inconsistent.");
  }
  const rows: PreparedSessionDependencyRows = {
    sourceProfile: profile,
    skillEntry: entrySchema.parse(
      db.prepare("SELECT * FROM skill_library_entries WHERE skill_id=?").get(request.skillId),
    ),
    skillRevision: revisionSchema.parse(
      db
        .prepare("SELECT * FROM skill_library_revisions WHERE skill_id=? AND revision=?")
        .get(request.skillId, request.skillRevision),
    ),
    workspace: (request.version === 3 ? retainedWorkspaceSchema : workspaceSchema).parse(
      db
        .prepare("SELECT * FROM session_repository_workspaces WHERE workspace_id=?")
        .get(request.workspaceId),
    ),
  };
  const retained =
    request.version === 3 ? readRetainedDependencySource(db, request, rows.workspace) : undefined;
  if (retained) {
    if (
      !rows.workspace.base_commit ||
      !rows.workspace.base_manifest_hash ||
      (rows.workspace.checkpoint_ref === null) !== (rows.workspace.manifest_hash === null)
    ) {
      throw new Error(
        "Retained workspace requires an exact base and a paired nullable checkpoint.",
      );
    }
    rows.workspace.disk_authority_json = JSON.stringify(retained.authority);
  }
  return { root, request, rows, sourceSha256: source.sha256, retained };
}
