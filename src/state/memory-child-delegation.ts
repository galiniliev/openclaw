import { createHash } from "node:crypto";
import type {
  MemoryAccessContext,
  MemoryActorEvidence,
  SessionMemorySubject,
  VerifiedPrincipalRef,
} from "../memory-host-sdk/host/authorization.js";
import type { CurrentMemorySessionContext } from "./memory-session-subject.js";
import {
  createCurrentMemorySessionContext,
} from "./memory-session-subject.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db.js";
import { AGENT_SESSION_MEMORY_SCHEMA_SQL } from "./openclaw-agent-session-memory-schema.js";

export type MemoryChildDelegationFacts = Readonly<{
  subject: SessionMemorySubject;
  actor: MemoryActorEvidence;
  verifiedPrincipals: readonly VerifiedPrincipalRef[];
  collaboration: MemoryAccessContext["collaboration"];
  delivery: MemoryAccessContext["delivery"];
}>;

export type StagedMemoryChildDelegation = Readonly<{
  delegationId: string;
  childSessionKey: string;
  childSessionId: string;
  childSessionIdentityRevision: string;
}>;

export type ActiveMemoryChildDelegation = Readonly<{
  delegation: NonNullable<MemoryAccessContext["delegation"]>;
  facts: MemoryChildDelegationFacts;
}>;

type DelegationRow = {
  delegation_id: string;
  agent_id: string;
  parent_session_key: string;
  parent_session_id: string;
  parent_session_identity_revision: string;
  parent_subject_revision: string;
  parent_authority_revision: string;
  child_session_key: string;
  child_session_id: string;
  child_session_identity_revision: string;
  child_subject_revision: string;
  capability_snapshot_id: string;
  delegation_json: string;
  parent_facts_json: string;
  state: "pending" | "active" | "revoked";
  expires_at: number;
};

function ensureSchema(database: { db: { exec(sql: string): void } }): void {
  database.db.exec(AGENT_SESSION_MEMORY_SCHEMA_SQL); // sqlite-allow-raw -- Feature-local additive lazy ensure.
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function taskCapabilitySnapshot(params: {
  database: { prepare(sql: string): { get(...values: unknown[]): unknown } };
  childSessionKey: string;
  childSessionId: string;
  childSessionIdentityRevision: string;
}): string | undefined {
  const row = params.database
    .prepare(
      `SELECT sn.current_session_id, sn.entry_json, ss.session_identity_revision
         FROM session_nodes AS sn
         JOIN session_memory_subject_snapshots AS ss ON ss.session_id = sn.current_session_id
        WHERE sn.session_key = ?`,
    )
    .get(params.childSessionKey) as
    | {
        current_session_id: string;
        entry_json: string;
        session_identity_revision: string;
      }
    | undefined;
  if (
    !row ||
    row.current_session_id !== params.childSessionId ||
    row.session_identity_revision !== params.childSessionIdentityRevision
  ) {
    return undefined;
  }
  let entry: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.entry_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    entry = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const allow = Array.isArray(entry.inheritedToolAllow)
    ? entry.inheritedToolAllow.filter((value): value is string => typeof value === "string").toSorted()
    : [];
  const deny = Array.isArray(entry.inheritedToolDeny)
    ? entry.inheritedToolDeny.filter((value): value is string => typeof value === "string").toSorted()
    : [];
  return `mcap1_${createHash("sha256")
    .update(
      stableJson({
        childSessionId: row.current_session_id,
        childSessionIdentityRevision: row.session_identity_revision,
        inheritedToolPolicyVersion: entry.inheritedToolPolicyVersion,
        allow,
        deny,
      }),
    )
    .digest("base64url")}`;
}

/** Server-derived ceiling from the persisted child session entry, never task wording. */
export function readMemoryChildTaskCapabilitySnapshot(params: {
  child: CurrentMemorySessionContext;
  options: OpenClawAgentDatabaseOptions;
}): string | undefined {
  const database = openOpenClawAgentDatabase(params.options);
  ensureSchema(database);
  return taskCapabilitySnapshot({
    database: database.db,
    childSessionKey: params.child.sessionKey,
    childSessionId: params.child.sessionId,
    childSessionIdentityRevision: params.child.sessionIdentityRevision,
  });
}

function isParentCurrent(params: {
  row: DelegationRow;
  options: OpenClawAgentDatabaseOptions;
}): CurrentMemorySessionContext | undefined {
  const parent = createCurrentMemorySessionContext({
    sessionKey: params.row.parent_session_key,
    sessionId: params.row.parent_session_id,
    options: params.options,
  });
  if (parent.kind !== "current") {
    return undefined;
  }
  const context = parent.context;
  return context.sessionIdentityRevision === params.row.parent_session_identity_revision &&
    context.subjectRevision === params.row.parent_subject_revision &&
    context.authorityRevision === params.row.parent_authority_revision
    ? context
    : undefined;
}

function parseGrant(row: DelegationRow): ActiveMemoryChildDelegation | undefined {
  try {
    const delegation: unknown = JSON.parse(row.delegation_json);
    const facts: unknown = JSON.parse(row.parent_facts_json);
    if (!delegation || typeof delegation !== "object" || !facts || typeof facts !== "object") {
      return undefined;
    }
    return Object.freeze({
      delegation: delegation as NonNullable<MemoryAccessContext["delegation"]>,
      facts: facts as MemoryChildDelegationFacts,
    });
  } catch {
    return undefined;
  }
}

function readStoreCapToken(serializedDelegation: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(serializedDelegation);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const storeCapToken = (parsed as { storeCapToken?: unknown }).storeCapToken;
    return typeof storeCapToken === "string" && storeCapToken.trim() ? storeCapToken : undefined;
  } catch {
    return undefined;
  }
}

/** Persist a pending child grant only after both session generations are durable. */
export function stageMemoryChildDelegation(params: {
  delegationId: string;
  parent: CurrentMemorySessionContext;
  child: CurrentMemorySessionContext;
  delegation: NonNullable<MemoryAccessContext["delegation"]>;
  facts: MemoryChildDelegationFacts;
  expiresAt: number;
  options: OpenClawAgentDatabaseOptions;
}): StagedMemoryChildDelegation | undefined {
  if (
    params.parent.agentId !== params.child.agentId ||
    !params.child.isChildSession ||
    !Number.isFinite(params.expiresAt) ||
    params.expiresAt <= Date.now()
  ) {
    return undefined;
  }
  return runOpenClawAgentWriteTransaction(
    (database) => {
      ensureSchema(database);
      const snapshot = taskCapabilitySnapshot({
        database: database.db,
        childSessionKey: params.child.sessionKey,
        childSessionId: params.child.sessionId,
        childSessionIdentityRevision: params.child.sessionIdentityRevision,
      });
      if (!snapshot || snapshot !== params.delegation.capabilitySnapshotId) {
        return undefined;
      }
      const lineage = database.db
        .prepare(
          `SELECT spawned_by FROM session_nodes
            WHERE session_key = ? AND current_session_id = ?`,
        )
        .get(params.child.sessionKey, params.child.sessionId) as { spawned_by: string | null } | undefined;
      if (lineage?.spawned_by !== params.parent.sessionKey) {
        return undefined;
      }
      database.db
        .prepare(
          `INSERT INTO memory_child_delegations (
             delegation_id, agent_id,
             parent_session_key, parent_session_id, parent_session_identity_revision,
             parent_subject_revision, parent_authority_revision,
             child_session_key, child_session_id, child_session_identity_revision,
             child_subject_revision, capability_snapshot_id,
             delegation_json, parent_facts_json, state, expires_at, created_at,
             activated_at, revoked_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)`,
        )
        .run(
          params.delegationId,
          params.parent.agentId,
          params.parent.sessionKey,
          params.parent.sessionId,
          params.parent.sessionIdentityRevision,
          params.parent.subjectRevision,
          params.parent.authorityRevision,
          params.child.sessionKey,
          params.child.sessionId,
          params.child.sessionIdentityRevision,
          params.child.subjectRevision,
          snapshot,
          stableJson(params.delegation),
          stableJson(params.facts),
          params.expiresAt,
          Date.now(),
        );
      return Object.freeze({
        delegationId: params.delegationId,
        childSessionKey: params.child.sessionKey,
        childSessionId: params.child.sessionId,
        childSessionIdentityRevision: params.child.sessionIdentityRevision,
      });
    },
    params.options,
    { operationLabel: "memory-child-delegation.stage" },
  );
}

export function activateMemoryChildDelegation(params: {
  delegation: StagedMemoryChildDelegation;
  options: OpenClawAgentDatabaseOptions;
}): boolean {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      ensureSchema(database);
      const result = database.db
        .prepare(
          `UPDATE memory_child_delegations
              SET state = 'active', activated_at = ?
            WHERE delegation_id = ?
              AND child_session_id = ?
              AND child_session_identity_revision = ?
              AND state = 'pending'
              AND expires_at > ?`,
        )
        .run(
          Date.now(),
          params.delegation.delegationId,
          params.delegation.childSessionId,
          params.delegation.childSessionIdentityRevision,
          Date.now(),
        ) as { changes?: number };
      return result.changes === 1;
    },
    params.options,
    { operationLabel: "memory-child-delegation.activate" },
  );
}

/** Idempotently close a grant on every failed launch and terminal child lifecycle. */
export function revokeMemoryChildDelegation(params: {
  delegation: StagedMemoryChildDelegation;
  options: OpenClawAgentDatabaseOptions;
}): void {
  runOpenClawAgentWriteTransaction(
    (database) => {
      ensureSchema(database);
      database.db
        .prepare(
          `UPDATE memory_child_delegations
              SET state = 'revoked', revoked_at = COALESCE(revoked_at, ?)
            WHERE delegation_id = ?
              AND child_session_id = ?
              AND child_session_identity_revision = ?
              AND state IN ('pending', 'active')`,
        )
        .run(
          Date.now(),
          params.delegation.delegationId,
          params.delegation.childSessionId,
          params.delegation.childSessionIdentityRevision,
        );
    },
    params.options,
    { operationLabel: "memory-child-delegation.revoke" },
  );
}

/**
 * Terminal lifecycle cleanup closes only the generation it registered. Returning
 * opaque tokens lets the selected backend perform defense-in-depth revocation
 * without teaching core which stores the child was allowed to read.
 */
export function revokeMemoryChildDelegationsForChildGeneration(params: {
  agentId: string;
  childSessionKey: string;
  childSessionId: string;
  childSessionIdentityRevision: string;
  options: OpenClawAgentDatabaseOptions;
}): readonly string[] {
  if (
    !params.agentId.trim() ||
    !params.childSessionKey.trim() ||
    !params.childSessionId.trim() ||
    !params.childSessionIdentityRevision.trim()
  ) {
    return [];
  }
  return runOpenClawAgentWriteTransaction(
    (database) => {
      ensureSchema(database);
      const activeRows = database.db
        .prepare(
          `SELECT delegation_json
             FROM memory_child_delegations
            WHERE agent_id = ?
              AND child_session_key = ?
              AND child_session_id = ?
              AND child_session_identity_revision = ?
              AND state IN ('pending', 'active')`,
        )
        .all(
          params.agentId,
          params.childSessionKey,
          params.childSessionId,
          params.childSessionIdentityRevision,
        ) as Array<{ delegation_json: string }>;
      if (activeRows.length === 0) {
        return [];
      }
      database.db
        .prepare(
          `UPDATE memory_child_delegations
              SET state = 'revoked', revoked_at = COALESCE(revoked_at, ?)
            WHERE agent_id = ?
              AND child_session_key = ?
              AND child_session_id = ?
              AND child_session_identity_revision = ?
              AND state IN ('pending', 'active')`,
        )
        .run(
          Date.now(),
          params.agentId,
          params.childSessionKey,
          params.childSessionId,
          params.childSessionIdentityRevision,
        );
      return activeRows.flatMap((row) => {
        const storeCapToken = readStoreCapToken(row.delegation_json);
        return storeCapToken ? [storeCapToken] : [];
      });
    },
    params.options,
    { operationLabel: "memory-child-delegation.revoke-terminal" },
  );
}

/** Resolve a child capability only if both exact session generations still prove their authority. */
export function resolveActiveMemoryChildDelegation(params: {
  child: CurrentMemorySessionContext;
  operation: MemoryAccessContext["operation"];
  options: OpenClawAgentDatabaseOptions;
}): ActiveMemoryChildDelegation | undefined {
  if (!params.child.isChildSession) {
    return undefined;
  }
  const database = openOpenClawAgentDatabase(params.options);
  ensureSchema(database);
  const row = database.db
    .prepare(
      `SELECT delegation_id, agent_id,
              parent_session_key, parent_session_id, parent_session_identity_revision,
              parent_subject_revision, parent_authority_revision,
              child_session_key, child_session_id, child_session_identity_revision,
              child_subject_revision, capability_snapshot_id,
              delegation_json, parent_facts_json, state, expires_at
         FROM memory_child_delegations
        WHERE agent_id = ?
          AND child_session_key = ?
          AND child_session_id = ?
          AND child_session_identity_revision = ?
          AND child_subject_revision = ?
          AND state = 'active'
          AND expires_at > ?`,
    )
    .get(
      params.child.agentId,
      params.child.sessionKey,
      params.child.sessionId,
      params.child.sessionIdentityRevision,
      params.child.subjectRevision,
      Date.now(),
    ) as DelegationRow | undefined;
  if (!row || !isParentCurrent({ row, options: params.options })) {
    return undefined;
  }
  const capabilitySnapshotId = taskCapabilitySnapshot({
    database: database.db,
    childSessionKey: params.child.sessionKey,
    childSessionId: params.child.sessionId,
    childSessionIdentityRevision: params.child.sessionIdentityRevision,
  });
  const lineage = database.db
    .prepare(
      `SELECT spawned_by FROM session_nodes
        WHERE session_key = ? AND current_session_id = ?`,
    )
    .get(params.child.sessionKey, params.child.sessionId) as { spawned_by: string | null } | undefined;
  const active = parseGrant(row);
  if (
    !active ||
    capabilitySnapshotId !== row.capability_snapshot_id ||
    lineage?.spawned_by !== row.parent_session_key ||
    !active.delegation.allowedOperations.includes(params.operation)
  ) {
    return undefined;
  }
  return active;
}
