import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ColumnType } from "kysely";
import { ensureOpenClawAgentScopedMemorySchema } from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";

export type ScopedMemoryLifecycleState = "pending" | "active" | "quarantined" | "tombstoned";
export type ScopedMemoryScopeKind =
  | "user"
  | "conversation"
  | "role"
  | "agent-shared"
  | "agent"
  | "internal";
export type ScopedMemoryActorKind = "human" | "agent" | "service" | "system" | "unattributed";

export type MemoryStorageRootRow = {
  storage_root_id: string;
  agent_id: string;
  backend_kind: "builtin" | "alternate";
  opaque_locator: string;
  path_key_version: number;
  path_key: string | null;
  authority_kind: ScopedMemoryScopeKind;
  authority_owner_id: string;
  default_capabilities_json: string;
  lifecycle_state: ScopedMemoryLifecycleState;
  created_at: number;
  updated_at: number;
};

export type MemoryStoreRow = {
  store_id: string;
  agent_id: string;
  storage_root_id: string;
  policy_id: string;
  scope_kind: ScopedMemoryScopeKind;
  audience_kind: ScopedMemoryScopeKind;
  audience_id: string;
  lifecycle_state: ScopedMemoryLifecycleState;
  created_at: number;
  updated_at: number;
};

type MemoryPolicyRow = {
  policy_id: string;
  agent_id: string;
  current_revision_id: string;
  revocation_epoch: number;
  lifecycle_state: "active" | "revoked";
  created_at: number;
  updated_at: number;
};

type MemoryPolicyRevisionRow = {
  revision_id: string;
  policy_id: string;
  revision_number: number;
  revocation_epoch: number;
  lifecycle_state: "active" | "superseded" | "revoked";
  actor_kind: ScopedMemoryActorKind;
  actor_id: string | null;
  reason: string;
  created_at: number;
};

export type MemoryPolicyEntryRow = {
  entry_id: string;
  policy_revision_id: string;
  entry_kind: "placement" | "exception" | "publish";
  effect: "allow" | "deny";
  principal_id: string;
  audience_kind: ScopedMemoryScopeKind | "*";
  audience_id: string;
  operation: import("openclaw/plugin-sdk/memory-authorization").MemoryOperation;
  grantor_principal_id: string;
  reason: string;
  expires_at: number | null;
  created_at: number;
};

export type MemoryResourceRow = {
  resource_id: string;
  agent_id: string;
  store_id: string;
  logical_locator: string;
  source: "memory" | "sessions";
  created_at: number;
};

export type MemoryResourceRevisionRow = {
  revision_id: string;
  resource_id: string;
  revision_number: number;
  artifact_locator: string;
  content_hash: string;
  content_bytes: number;
  policy_revision_id: string;
  policy_revocation_epoch: number;
  source_policy_set_id: string;
  lifecycle_state: ScopedMemoryLifecycleState;
  actor_kind: ScopedMemoryActorKind;
  actor_id: string | null;
  expires_at: number | null;
  created_at: number;
  activated_at: number | null;
  retired_at: number | null;
};

export type MemoryRevisionPolicyRequirementRow = {
  revision_id: string;
  policy_id: string;
  expected_revision_id: string;
  expected_revocation_epoch: number;
  requirement_kind: "output-policy" | "source-policy";
  created_at: number;
};

export type MemoryLineageEdgeRow = {
  child_revision_id: string;
  parent_kind:
    | "resource-revision"
    | "transcript-policy-set"
    | "compaction-policy"
    | "checkpoint"
    | "export"
    | "child-artifact";
  parent_id: string;
  relation_kind:
    | "derived-from"
    | "compacted-from"
    | "flushed-from"
    | "dreamed-from"
    | "promoted-from"
    | "exported-from"
    | "child-produced";
  created_at: number;
};

type MemoryPolicySetMemberRow = {
  policy_set_id: string;
  policy_id: string;
  expected_revision_id: string;
  expected_revocation_epoch: number;
  audience_intersection_json: string;
  retention_state: string;
  created_at: number;
};

type MemoryCompactionPolicyRow = {
  compaction_policy_id: string;
  session_id: string;
  source_policy_set_id: string;
  retention_state: "retained" | "quarantined";
  created_at: number;
};

type MemoryCompactionPolicySourceRow = {
  compaction_policy_id: string;
  source_session_id: string;
  source_event_seq: number;
  source_policy_set_id: string;
  delivery_audiences_json: string;
  created_at: number;
};

type SessionMemorySubjectSnapshotRow = {
  session_id: string;
  session_identity_revision: string;
  subject_revision: string;
};

type TranscriptEventMemoryPolicyRow = {
  session_id: string;
  event_seq: number;
  authorization_status: string;
  source_policy_set_id: string | null;
  run_exposure_set_id: string | null;
  delivery_audiences_json: string | null;
  session_identity_revision: string | null;
  subject_revision: string | null;
};

type TranscriptEventMemoryPolicyDetailRow = {
  session_id: string;
  event_seq: number;
  retention_state: string;
  normalized_audience_intersection_json: string;
  finalized_delivery_audiences_json: string;
};

type TranscriptEventRow = {
  session_id: string;
  seq: number;
};

type MemoryRunExposureResourceRow = {
  exposure_set_id: string;
  resource_revision_id: string;
  policy_set_id: string;
  created_at: number;
};

export type MemoryResourceSubjectRow = {
  revision_id: string;
  subject_kind: "person" | "project" | "conversation" | "topic";
  subject_id: string;
  evidence_revision: string;
  lifecycle_state: "current" | "superseded";
  created_at: number;
};

export type MemoryScopedChunkRow = {
  chunk_key: ColumnType<number, number | undefined, number>;
  chunk_id: string;
  revision_id: string;
  chunk_ordinal: number;
  start_line: number;
  end_line: number;
  text: string;
  content_hash: string;
  model: string;
  updated_at: number;
};

export type MemoryScopedChunkVectorRow = {
  chunk_id: string;
  model: string;
  dims: number;
  embedding: string;
  updated_at: number;
};

/** A durable write intent exists before its revision can become readable. */
export type MemoryWriteIntentRow = {
  intent_id: string;
  idempotency_key: string;
  mutation_id: string;
  agent_id: string;
  request_id: string;
  run_id: string;
  context_fingerprint: string;
  plan_id: string;
  mutation_kind: string;
  store_id: string;
  resource_id: string | null;
  pending_revision_id: string | null;
  staged_locator: string | null;
  final_locator: string | null;
  content_hash: string | null;
  content_bytes: number | null;
  state: "pending" | "renamed" | "active" | "quarantined" | "tombstoned";
  created_at: number;
  updated_at: number;
  activated_at: number | null;
  indexed_at: number | null;
};

/** Local, idempotent audit delivery queue. Memory content is deliberately absent. */
export type MemoryAuditOutboxRow = {
  event_id: string;
  intent_id: string;
  agent_id: string;
  request_id: string;
  run_id: string;
  actor_ref: string;
  subject_ref: string;
  operation: string;
  resource_revision_id: string | null;
  content_hash: string | null;
  decision: "pending" | "committed" | "quarantined" | "tombstoned";
  reason_code: string;
  state: "pending" | "delivered";
  attempts: number;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
};

export type MemoryMigrationRow = {
  migration_id: string;
  source_kind: string;
  source_hash: string;
  phase: "previewed" | "backed-up" | "copied" | "indexed" | "verified" | "cutover";
  classification_json: string;
  plan_hash: string;
  verified_at: number | null;
  cutover_at: number | null;
  updated_at: number;
};

export type ScopedMemoryDatabase = {
  memory_storage_roots: MemoryStorageRootRow;
  memory_stores: MemoryStoreRow;
  memory_policies: MemoryPolicyRow;
  memory_policy_revisions: MemoryPolicyRevisionRow;
  memory_policy_entries: MemoryPolicyEntryRow;
  memory_resources: MemoryResourceRow;
  memory_resource_revisions: MemoryResourceRevisionRow;
  memory_revision_policy_requirements: MemoryRevisionPolicyRequirementRow;
  memory_lineage_edges: MemoryLineageEdgeRow;
  memory_child_delegation_capabilities: {
    delegation_id: string;
    agent_id: string;
    child_session_id: string;
    child_session_identity_revision: string;
    child_subject_revision: string;
    root_principal_id: string;
    parent_memory_plan_id: string;
    capability_snapshot_id: string;
    allowed_operations_json: string;
    maximum_audiences_json: string;
    token_hash: string;
    expires_at: number;
    revoked_at: number | null;
    created_at: number;
  };
  memory_policy_set_members: MemoryPolicySetMemberRow;
  memory_compaction_policies: MemoryCompactionPolicyRow;
  memory_compaction_policy_sources: MemoryCompactionPolicySourceRow;
  session_memory_subject_snapshots: SessionMemorySubjectSnapshotRow;
  transcript_event_memory_policies: TranscriptEventMemoryPolicyRow;
  transcript_event_memory_policy_details: TranscriptEventMemoryPolicyDetailRow;
  transcript_events: TranscriptEventRow;
  memory_run_exposure_resources: MemoryRunExposureResourceRow;
  memory_resource_subjects: MemoryResourceSubjectRow;
  memory_scoped_chunks: MemoryScopedChunkRow;
  memory_scoped_chunk_vectors: MemoryScopedChunkVectorRow;
  memory_write_intents: MemoryWriteIntentRow;
  memory_audit_outbox: MemoryAuditOutboxRow;
  memory_migrations: MemoryMigrationRow;
};

/** Open the canonical agent database and lazily add only the scoped-memory group. */
export function withScopedMemoryDatabase<T>(
  agentId: string,
  callback: (db: DatabaseSync, databasePath: string) => T,
): T {
  const database = openOpenClawAgentDatabase({ agentId });
  ensureOpenClawAgentScopedMemorySchema(database.db);
  return callback(database.db, database.path);
}

/** Filesystem owner for opaque builtin memory-store directories. */
export function resolveScopedMemoryArtifactBase(databasePath: string): string {
  return path.join(path.dirname(databasePath), "memory-scopes", "v1");
}
