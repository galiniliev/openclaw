import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { pseudonymizeExecutionIdentityRef } from "../audit/audit-identity.js";
import {
  consumeAdmittedNativeChannelMemoryEvidence,
  type AdmittedNativeChannelMemoryEvidence,
} from "../channels/message-access/memory-native-channel-evidence-admission.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { ensureMemoryIdentitySchema } from "./memory-identity.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

/**
 * A channel turn refreshes this short-lived receipt before its conversation
 * store can mount. No background refresh is permitted: a transport or adapter
 * outage therefore removes future channel access at this bound.
 */
export const NATIVE_CHANNEL_MEMORY_EVIDENCE_TTL_MS = 15 * 60 * 1000;

const SCHEMA_START = "CREATE TABLE IF NOT EXISTS memory_native_channel_evidence (";
const SCHEMA_END = "-- A pairing receipt is short-lived, internal evidence";
const ensuredDatabases = new WeakSet<DatabaseSync>();

type NativeChannelEvidenceDatabase = {
  audit_identity_keys: {
    id: number;
    key_id: string;
    key: Uint8Array;
    created_at: number;
  };
  memory_native_channel_evidence: {
    evidence_id: string;
    agent_id: string;
    conversation_principal_id: string;
    channel: string;
    account_id: string;
    conversation_ref: string;
    native_channel_ref: string;
    adapter_id: string;
    assurance: "adapter-attested";
    verification_method: string;
    adapter_evidence_revision: string;
    evidence_revision: string;
    observed_at: number;
    expires_at: number;
    revoked_at: number | null;
    created_at: number;
  };
  memory_native_channel_evidence_denials: {
    event_id: string;
    agent_id: string;
    conversation_principal_id: string;
    channel: string;
    account_id: string;
    conversation_ref: string;
    native_channel_ref: string;
    receipt_ref: string | null;
    reason_code: "missing" | "expired" | "revoked";
    occurred_at: number;
    received_at: number;
  };
};

export type MemoryNativeChannelEvidence = Readonly<{
  evidenceId: string;
  evidenceRevision: string;
  observedAt: number;
  expiresAt: number;
}>;

export type MemoryNativeChannelEvidenceInspection =
  | Readonly<{ kind: "current"; evidence: MemoryNativeChannelEvidence }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "expired"; evidenceId: string }>
  | Readonly<{ kind: "revoked"; evidenceId: string }>;

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

function extractSchema(): string {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(SCHEMA_START);
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(SCHEMA_END, start);
  if (start < 0 || end <= start) {
    throw new Error("canonical native channel memory evidence schema markers are missing");
  }
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end).trim();
}

/** Canonical lazy DDL for the current native conversation receipt table. */
export const MEMORY_NATIVE_CHANNEL_EVIDENCE_SCHEMA_SQL = extractSchema();

function ensureMemoryNativeChannelEvidenceSchema(
  options: OpenClawStateDatabaseOptions = {},
): void {
  ensureMemoryIdentitySchema(options);
  const database = openOpenClawStateDatabase(options).db;
  if (ensuredDatabases.has(database)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => db.exec(MEMORY_NATIVE_CHANNEL_EVIDENCE_SCHEMA_SQL),
    options,
    { operationLabel: "memory-native-channel-evidence.schema.ensure" },
  );
  ensuredDatabases.add(database);
}

function normalizeChannel(value: string): string {
  return requireText(value, "channel").toLowerCase();
}

function requireTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function nativeChannelRef(params: {
  database: DatabaseSync;
  agentId: string;
  channel: string;
  accountId: string;
  nativeChannelId: string;
}): string {
  return pseudonymizeExecutionIdentityRef({
    db: params.database,
    kind: "principal",
    scope: `memory-native-channel:v1:${params.agentId}\u0000${params.channel}\u0000${params.accountId}`,
    value: params.nativeChannelId,
  });
}

function conversationRef(params: {
  database: DatabaseSync;
  agentId: string;
  channel: string;
  accountId: string;
  conversationId: string;
}): string {
  return pseudonymizeExecutionIdentityRef({
    db: params.database,
    kind: "principal",
    scope: `memory-native-conversation:v1:${params.agentId}\u0000${params.channel}\u0000${params.accountId}`,
    value: params.conversationId,
  });
}

function receiptRef(params: { database: DatabaseSync; agentId: string; evidenceId: string }): string {
  return pseudonymizeExecutionIdentityRef({
    db: params.database,
    kind: "evidence",
    scope: `memory-native-channel-receipt:v1:${params.agentId}`,
    value: params.evidenceId,
  });
}

/**
 * The session-subject owner consumes one loader-issued conversation proof only
 * after it has reread the committed session/conversation mapping. Sender ids,
 * route keys, and session_members never enter this table or its lookup.
 */
export function persistAdmittedNativeChannelMemoryEvidence(params: {
  admission: AdmittedNativeChannelMemoryEvidence;
  agentId: string;
  conversationPrincipalId: string;
  channel: string;
  accountId: string;
  conversationId: string;
  nativeChannelId: string;
  observedAt?: number;
  expiresAt?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryNativeChannelEvidence {
  const admission = consumeAdmittedNativeChannelMemoryEvidence(params.admission);
  if (!admission) {
    throw new Error("native channel memory evidence requires an admitted channel proof");
  }
  const agentId = requireText(params.agentId, "agentId");
  const conversationPrincipalId = requireText(
    params.conversationPrincipalId,
    "conversationPrincipalId",
  );
  const channel = normalizeChannel(params.channel);
  const accountId = normalizeAccountId(requireText(params.accountId, "accountId"));
  const conversationId = requireText(params.conversationId, "conversationId");
  const nativeChannelId = requireText(params.nativeChannelId, "nativeChannelId");
  if (
    admission.channel !== channel ||
    admission.accountId !== accountId ||
    admission.nativeChannelId !== nativeChannelId
  ) {
    throw new Error("native channel memory evidence does not match the persisted conversation");
  }
  const observedAt = requireTimestamp(params.observedAt ?? Date.now(), "observedAt");
  const expiresAt = requireTimestamp(
    params.expiresAt ?? observedAt + NATIVE_CHANNEL_MEMORY_EVIDENCE_TTL_MS,
    "expiresAt",
  );
  if (expiresAt <= observedAt) {
    throw new TypeError("expiresAt must be after observedAt");
  }
  const options = params.options ?? {};
  ensureMemoryNativeChannelEvidenceSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      const db = getNodeSqliteKysely<NativeChannelEvidenceDatabase>(database);
      const persistedConversationRef = conversationRef({
        database,
        agentId,
        channel,
        accountId,
        conversationId,
      });
      const persistedNativeChannelRef = nativeChannelRef({
        database,
        agentId,
        channel,
        accountId,
        nativeChannelId,
      });
      // This table is a current transport receipt, not an audit ledger. Replace
      // the exact address on refresh so active group traffic cannot accumulate
      // one durable row per message while the new revision invalidates old plans.
      executeSqliteQuerySync(
        database,
        db
          .deleteFrom("memory_native_channel_evidence")
          .where("agent_id", "=", agentId)
          .where("conversation_principal_id", "=", conversationPrincipalId)
          .where("channel", "=", channel)
          .where("account_id", "=", accountId)
          .where("conversation_ref", "=", persistedConversationRef)
          .where("native_channel_ref", "=", persistedNativeChannelRef),
      );
      const evidence = {
        evidence_id: generateSecureUuid(),
        agent_id: agentId,
        conversation_principal_id: conversationPrincipalId,
        channel,
        account_id: accountId,
        conversation_ref: persistedConversationRef,
        native_channel_ref: persistedNativeChannelRef,
        adapter_id: admission.adapterId,
        assurance: "adapter-attested" as const,
        verification_method: admission.verificationMethod,
        adapter_evidence_revision: admission.evidenceRevision,
        evidence_revision: generateSecureUuid(),
        observed_at: observedAt,
        expires_at: expiresAt,
        revoked_at: null,
        created_at: observedAt,
      };
      executeSqliteQueryTakeFirstSync(
        database,
        db
          .insertInto("memory_native_channel_evidence")
          .values(evidence)
          .returning([
            "evidence_id",
            "evidence_revision",
            "observed_at",
            "expires_at",
          ]),
      );
      return Object.freeze({
        evidenceId: evidence.evidence_id,
        evidenceRevision: evidence.evidence_revision,
        observedAt: evidence.observed_at,
        expiresAt: evidence.expires_at,
      });
    },
    options,
    { operationLabel: "memory-native-channel-evidence.persist" },
  );
}

/** Revoke one current receipt immediately; a later fresh adapter proof may re-admit the address. */
export function revokeMemoryNativeChannelEvidence(params: {
  evidenceId: string;
  revokedAt?: number;
  options?: OpenClawStateDatabaseOptions;
}): boolean {
  const options = params.options ?? {};
  const evidenceId = requireText(params.evidenceId, "evidenceId");
  const revokedAt = requireTimestamp(params.revokedAt ?? Date.now(), "revokedAt");
  ensureMemoryNativeChannelEvidenceSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      const db = getNodeSqliteKysely<NativeChannelEvidenceDatabase>(database);
      const result = executeSqliteQuerySync(
        database,
        db
          .updateTable("memory_native_channel_evidence")
          .set({ revoked_at: revokedAt })
          .where("evidence_id", "=", evidenceId)
          .where("revoked_at", "is", null),
      );
      return result.numAffectedRows === 1n;
    },
    options,
    { operationLabel: "memory-native-channel-evidence.revoke" },
  );
}

/** Classifies an exact persisted conversation receipt before every memory operation. */
export function inspectMemoryNativeChannelEvidence(params: {
  agentId: string;
  conversationPrincipalId: string;
  channel: string;
  accountId: string;
  conversationId: string;
  nativeChannelId: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryNativeChannelEvidenceInspection {
  const agentId = requireText(params.agentId, "agentId");
  const conversationPrincipalId = requireText(
    params.conversationPrincipalId,
    "conversationPrincipalId",
  );
  const channel = normalizeChannel(params.channel);
  const accountId = normalizeAccountId(requireText(params.accountId, "accountId"));
  const conversationId = requireText(params.conversationId, "conversationId");
  const nativeChannelId = requireText(params.nativeChannelId, "nativeChannelId");
  const now = requireTimestamp(params.now ?? Date.now(), "now");
  const options = params.options ?? {};
  ensureMemoryNativeChannelEvidenceSchema(options);
  const database = openOpenClawStateDatabase(options);
  const db = getNodeSqliteKysely<NativeChannelEvidenceDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("memory_native_channel_evidence")
      .select([
        "evidence_id",
        "evidence_revision",
        "observed_at",
        "expires_at",
        "revoked_at",
      ])
      .where("agent_id", "=", agentId)
      .where("conversation_principal_id", "=", conversationPrincipalId)
      .where("channel", "=", channel)
      .where("account_id", "=", accountId)
      .where(
        "conversation_ref",
        "=",
        conversationRef({
          database: database.db,
          agentId,
          channel,
          accountId,
          conversationId,
        }),
      )
      .where(
        "native_channel_ref",
        "=",
        nativeChannelRef({
          database: database.db,
          agentId,
          channel,
          accountId,
          nativeChannelId,
        }),
      )
      .orderBy("observed_at", "desc")
      .orderBy("evidence_id", "desc"),
  );
  if (!row) {
    return { kind: "missing" };
  }
  if (row.revoked_at !== null) {
    return Object.freeze({ kind: "revoked", evidenceId: row.evidence_id });
  }
  if (row.observed_at > now || row.expires_at <= now) {
    return Object.freeze({ kind: "expired", evidenceId: row.evidence_id });
  }
  return Object.freeze({
    kind: "current",
    evidence: Object.freeze({
      evidenceId: row.evidence_id,
      evidenceRevision: row.evidence_revision,
      observedAt: row.observed_at,
      expiresAt: row.expires_at,
    }),
  });
}

/** Rechecks an exact persisted conversation address before every memory operation. */
export function readCurrentMemoryNativeChannelEvidence(params: {
  agentId: string;
  conversationPrincipalId: string;
  channel: string;
  accountId: string;
  conversationId: string;
  nativeChannelId: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryNativeChannelEvidence | undefined {
  const inspection = inspectMemoryNativeChannelEvidence(params);
  return inspection.kind === "current" ? inspection.evidence : undefined;
}

/**
 * Record a deduplicated receipt denial at the session-context owner. This
 * receives a persisted conversation address, never a sender, route key, or
 * `session_members` value.
 */
export function recordMemoryNativeChannelEvidenceDenial(params: {
  agentId: string;
  conversationPrincipalId: string;
  channel: string;
  accountId: string;
  conversationId: string;
  nativeChannelId: string;
  inspection: Exclude<MemoryNativeChannelEvidenceInspection, { kind: "current" }>;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): void {
  const agentId = requireText(params.agentId, "agentId");
  const conversationPrincipalId = requireText(
    params.conversationPrincipalId,
    "conversationPrincipalId",
  );
  const channel = normalizeChannel(params.channel);
  const accountId = normalizeAccountId(requireText(params.accountId, "accountId"));
  const conversationId = requireText(params.conversationId, "conversationId");
  const nativeChannelId = requireText(params.nativeChannelId, "nativeChannelId");
  const now = requireTimestamp(params.now ?? Date.now(), "now");
  const options = params.options ?? {};
  ensureMemoryNativeChannelEvidenceSchema(options);
  runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      const db = getNodeSqliteKysely<NativeChannelEvidenceDatabase>(database);
      const persistedConversationRef = conversationRef({
        database,
        agentId,
        channel,
        accountId,
        conversationId,
      });
      const persistedNativeChannelRef = nativeChannelRef({
        database,
        agentId,
        channel,
        accountId,
        nativeChannelId,
      });
      const persistedReceiptRef =
        params.inspection.kind === "missing"
          ? null
          : receiptRef({ database, agentId, evidenceId: params.inspection.evidenceId });
      const eventId = `mncd1_${createHash("sha256")
        .update(
          [
            agentId,
            conversationPrincipalId,
            channel,
            accountId,
            persistedConversationRef,
            persistedNativeChannelRef,
            params.inspection.kind,
            persistedReceiptRef ?? "",
          ].join("\0"),
        )
        .digest("base64url")}`;
      executeSqliteQuerySync(
        database,
        db
          .insertInto("memory_native_channel_evidence_denials")
          .values({
            event_id: eventId,
            agent_id: agentId,
            conversation_principal_id: conversationPrincipalId,
            channel,
            account_id: accountId,
            conversation_ref: persistedConversationRef,
            native_channel_ref: persistedNativeChannelRef,
            receipt_ref: persistedReceiptRef,
            reason_code: params.inspection.kind,
            occurred_at: now,
            received_at: Date.now(),
          })
          .onConflict((conflict) => conflict.column("event_id").doNothing()),
      );
    },
    options,
    { operationLabel: "memory-native-channel-evidence.denial.write" },
  );
}
