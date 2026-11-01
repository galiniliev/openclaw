import { isDeepStrictEqual } from "node:util";
import type { Selectable } from "kysely";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { parseEnterpriseGitHubPrincipal } from "../shared/enterprise-github-principal.js";
import { assertSkillLibraryNameAvailable } from "../skills/library/store.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { readRetainedWorkspaceAuthority } from "../state/retained-workspace-authority.js";
import { readRepositoryWorkspaceRecovery } from "../state/session-repository-workspaces.recovery.js";
import { userProfilesDb, type UserProfileRow } from "../state/user-profiles-internal.js";
import { mergeUserProfiles } from "../state/user-profiles-merge.js";

export type PreparedSessionDependencyRows = {
  sourceProfile: UserProfileRow;
  skillEntry: Selectable<DB["skill_library_entries"]>;
  skillRevision: Selectable<DB["skill_library_revisions"]>;
  workspace: Selectable<DB["session_repository_workspaces"]>;
};

export type RestoreSelection = {
  sourceProfileId: string;
  currentProfileId: string;
  expectedIdentity: { provider: string; subject: string };
  skillId: string;
  skillRevision: string;
  workspaceId: string;
  agentId: string;
  sessionKey: string;
};

function refuse(reason: string): never {
  throw new Error(`Session dependency restoration refused: ${reason}.`);
}

function samePortrait(left: UserProfileRow, right: UserProfileRow): boolean {
  return (
    left.id === right.id &&
    left.display_name === right.display_name &&
    left.avatar_mime === right.avatar_mime &&
    left.avatar_sha256 === right.avatar_sha256 &&
    left.created_at === right.created_at &&
    (left.primary_github_account_id ?? null) === null &&
    (left.role ?? null) === null &&
    (left.avatar === null
      ? right.avatar === null
      : right.avatar !== null && Buffer.from(left.avatar).equals(Buffer.from(right.avatar)))
  );
}

/** Caller owns the canonical synchronous state write transaction and final commit admission. */
export function restoreSessionDependencyRows(
  db: EngineConnection,
  rows: PreparedSessionDependencyRows,
  selection: RestoreSelection,
  options: { verifyOnly?: true } = {},
) {
  const { sourceProfileId, currentProfileId, expectedIdentity } = selection;
  if (
    sourceProfileId === currentProfileId ||
    [sourceProfileId, currentProfileId].includes(GATEWAY_OWNER_PROFILE_ID) ||
    !parseEnterpriseGitHubPrincipal(`${expectedIdentity.provider}:${expectedIdentity.subject}`)
  ) {
    refuse("the selected profile identities are not an exact Enterprise merge pair");
  }
  if (
    ![
      "user_profiles",
      "user_profile_identities",
      "user_profile_emails",
      "skill_library_entries",
      "skill_library_revisions",
      "session_repository_workspaces",
    ].every((table) => tableExists(db, table))
  ) {
    refuse("canonical profile, skill-library and repository-workspace schemas must be prepared");
  }
  const profiles = userProfilesDb(db);
  const current = executeSqliteQueryTakeFirstSync(
    db,
    profiles.selectFrom("user_profiles").selectAll().where("id", "=", currentProfileId),
  );
  const identity = executeSqliteQueryTakeFirstSync(
    db,
    profiles
      .selectFrom("user_profile_identities")
      .select("profile_id")
      .where("provider", "=", expectedIdentity.provider)
      .where("subject", "=", expectedIdentity.subject),
  );
  const alias = executeSqliteQueryTakeFirstSync(
    db,
    profiles
      .selectFrom("user_profile_emails")
      .select("profile_id")
      .where("email", "=", `${expectedIdentity.provider}:${expectedIdentity.subject}`),
  );
  if (
    !current ||
    current.merged_into !== null ||
    identity?.profile_id !== currentProfileId ||
    alias?.profile_id !== currentProfileId
  ) {
    refuse("the current unmerged profile does not own the exact existing identity and alias");
  }
  const source = rows.sourceProfile;
  if (source.id !== sourceProfileId || source.merged_into !== null) {
    refuse("the source profile is not the selected original profile");
  }
  const portrait: UserProfileRow = {
    id: sourceProfileId,
    display_name: source.display_name,
    avatar: source.avatar,
    avatar_mime: source.avatar_mime,
    avatar_sha256: source.avatar_sha256,
    created_at: source.created_at,
    updated_at: source.updated_at,
    merged_into: null,
    role: null,
    primary_github_account_id: null,
  };
  const previous = executeSqliteQueryTakeFirstSync(
    db,
    profiles.selectFrom("user_profiles").selectAll().where("id", "=", sourceProfileId),
  );
  if (
    previous &&
    (!samePortrait(previous, portrait) ||
      (previous.merged_into !== null && previous.merged_into !== currentProfileId) ||
      (previous.merged_into === null && previous.updated_at !== portrait.updated_at))
  ) {
    refuse("the existing source profile has conflicting metadata or a different merge head");
  }
  const entry = rows.skillEntry;
  const revision = rows.skillRevision;
  const workspace = rows.workspace;
  if (
    entry.skill_id !== selection.skillId ||
    revision.skill_id !== selection.skillId ||
    entry.current_revision !== selection.skillRevision ||
    revision.revision !== selection.skillRevision ||
    entry.owner_profile_id !== sourceProfileId ||
    ![sourceProfileId, currentProfileId].includes(entry.author_profile_id)
  ) {
    refuse("the skill and revision do not match the selected profile-owned dependency");
  }
  if (
    workspace.workspace_id !== selection.workspaceId ||
    workspace.agent_id !== selection.agentId ||
    workspace.session_key !== selection.sessionKey
  ) {
    refuse("the repository workspace does not match the selected session owner");
  }
  if (workspace.recovery_json !== null) {
    readRepositoryWorkspaceRecovery(workspace.recovery_json);
  }
  if (workspace.disk_authority_json !== null) {
    readRetainedWorkspaceAuthority(workspace.disk_authority_json);
  }
  const catalog =
    getNodeSqliteKysely<
      Pick<
        DB,
        "skill_library_entries" | "skill_library_revisions" | "session_repository_workspaces"
      >
    >(db);
  const existingEntry = executeSqliteQueryTakeFirstSync(
    db,
    catalog.selectFrom("skill_library_entries").selectAll().where("skill_id", "=", entry.skill_id),
  );
  const existingRevision = executeSqliteQueryTakeFirstSync(
    db,
    catalog
      .selectFrom("skill_library_revisions")
      .selectAll()
      .where("skill_id", "=", revision.skill_id)
      .where("revision", "=", revision.revision),
  );
  const existingWorkspace = executeSqliteQueryTakeFirstSync(
    db,
    catalog
      .selectFrom("session_repository_workspaces")
      .selectAll()
      .where("workspace_id", "=", workspace.workspace_id),
  );
  const occupiedOwner = executeSqliteQueryTakeFirstSync(
    db,
    catalog
      .selectFrom("session_repository_workspaces")
      .select("workspace_id")
      .where("agent_id", "=", selection.agentId)
      .where("session_key", "=", selection.sessionKey),
  );
  if (
    (existingEntry && !isDeepStrictEqual({ ...existingEntry }, { ...entry })) ||
    (existingRevision && !isDeepStrictEqual({ ...existingRevision }, { ...revision })) ||
    (existingWorkspace && !isDeepStrictEqual({ ...existingWorkspace }, { ...workspace })) ||
    (occupiedOwner && occupiedOwner.workspace_id !== workspace.workspace_id)
  ) {
    refuse("existing skill, revision or repository workspace differs from the selected source");
  }
  if (options.verifyOnly) {
    if (
      previous?.merged_into !== currentProfileId ||
      !existingEntry ||
      !existingRevision ||
      !existingWorkspace
    ) {
      refuse("selected dependencies must already be restored before retained-owner repair");
    }
    return { profileMerged: false, skillRestored: false, workspaceRestored: false };
  }
  const profileMerged = previous?.merged_into !== currentProfileId;
  if (profileMerged) {
    const sourceIdentity = executeSqliteQueryTakeFirstSync(
      db,
      profiles
        .selectFrom("user_profile_identities")
        .select("subject")
        .where("profile_id", "=", sourceProfileId),
    );
    const sourceAlias = executeSqliteQueryTakeFirstSync(
      db,
      profiles
        .selectFrom("user_profile_emails")
        .select("email")
        .where("profile_id", "=", sourceProfileId),
    );
    const sourceMerge = executeSqliteQueryTakeFirstSync(
      db,
      profiles.selectFrom("user_profiles").select("id").where("merged_into", "=", sourceProfileId),
    );
    if (sourceIdentity || sourceAlias || sourceMerge) {
      refuse("the source profile has unselected existing identity or merge bindings");
    }
    if (!previous) {
      executeSqliteQuerySync(db, profiles.insertInto("user_profiles").values(portrait));
    }
    mergeUserProfiles(db, sourceProfileId, currentProfileId, Date.now());
  }
  if (!existingEntry) {
    assertSkillLibraryNameAvailable(db, currentProfileId, entry.slug, entry.skill_id);
    executeSqliteQuerySync(db, catalog.insertInto("skill_library_entries").values(entry));
  }
  if (!existingRevision) {
    executeSqliteQuerySync(db, catalog.insertInto("skill_library_revisions").values(revision));
  }
  if (!existingWorkspace) {
    executeSqliteQuerySync(
      db,
      catalog.insertInto("session_repository_workspaces").values(workspace),
    );
  }
  return {
    profileMerged,
    skillRestored: !existingEntry || !existingRevision,
    workspaceRestored: !existingWorkspace,
  };
}
