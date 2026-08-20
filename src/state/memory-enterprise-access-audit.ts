import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { pseudonymizeExecutionIdentityRef } from "../audit/audit-identity.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { MemoryAccessContext } from "../memory-host-sdk/host/authorization.js";
import { readCurrentMemoryEnterpriseMembershipForAudit } from "./memory-enterprise-identity.js";
import { ensureMemoryIdentitySchema } from "./memory-identity.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const SCHEMA_START = "CREATE TABLE IF NOT EXISTS memory_enterprise_access_decisions (";
const SCHEMA_END = "CREATE TABLE IF NOT EXISTS session_state_events (";
const MAX_AUDIT_DECISIONS = 100;
const OPAQUE_AUDIT_REFERENCE_RE = /^hmac-sha256:v1:[a-f0-9]{32}:[a-f0-9]{64}$/u;
const ENTERPRISE_MEMORY_AUDIT_REASON_CODES = [
  "allowed",
  "role-membership-unavailable",
  "invalid-context",
  "session-rebound",
  "delivery-rebound",
  "plan-expired",
  "identity-revoked",
  "membership-stale",
  "principal-evidence-unavailable",
  "outside-view",
  "revision-stale",
  "explicit-deny",
  "default-deny",
  "lineage-deny",
  "backend-nonconforming",
] as const;
const ensuredDatabases = new WeakSet<DatabaseSync>();

// `CREATE TRIGGER IF NOT EXISTS` cannot replace the unconditional guards that
// shipped before explicit owner deletion. Keep the evidence tables immutable;
// only the profile-scoped audit projections accept a matching transient grant.
const ENTERPRISE_AUDIT_DELETION_TRIGGER_MIGRATION_SQL = `
DROP TRIGGER IF EXISTS memory_enterprise_evidence_transition_profile_links_no_delete;
CREATE TRIGGER memory_enterprise_evidence_transition_profile_links_no_delete
BEFORE DELETE ON memory_enterprise_evidence_transition_profile_links
BEGIN
  SELECT RAISE(ABORT, 'enterprise evidence transition profile links cannot be deleted')
  WHERE NOT EXISTS (
    SELECT 1
    FROM memory_enterprise_audit_deletion_grants
    WHERE target_user_principal_id = OLD.user_principal_id
  );
END;
DROP TRIGGER IF EXISTS memory_enterprise_identity_actions_no_delete;
CREATE TRIGGER memory_enterprise_identity_actions_no_delete
BEFORE DELETE ON memory_enterprise_identity_actions
BEGIN
  SELECT RAISE(ABORT, 'enterprise identity actions cannot be deleted')
  WHERE NOT EXISTS (
    SELECT 1
    FROM memory_enterprise_audit_deletion_grants
    WHERE target_user_principal_id = OLD.target_user_principal_id
  );
END;
DROP TRIGGER IF EXISTS memory_enterprise_policy_drift_alerts_no_delete;
CREATE TRIGGER memory_enterprise_policy_drift_alerts_no_delete
BEFORE DELETE ON memory_enterprise_policy_drift_alerts
BEGIN
  SELECT RAISE(ABORT, 'enterprise policy drift alerts cannot be deleted')
  WHERE NOT EXISTS (
    SELECT 1
    FROM memory_enterprise_audit_deletion_grants
    WHERE target_user_principal_id = OLD.subject_principal_id
  );
END;
`;

export type MemoryEnterpriseAuditReasonCode =
  (typeof ENTERPRISE_MEMORY_AUDIT_REASON_CODES)[number];

function extractSchema(): string {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(SCHEMA_START);
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(SCHEMA_END, start);
  if (start < 0 || end <= start) {
    throw new Error("canonical enterprise memory access audit schema markers are missing");
  }
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end).trim();
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

function requireOpaqueAuditReference(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (!OPAQUE_AUDIT_REFERENCE_RE.test(normalized)) {
    throw new TypeError(`${label} must be a keyed opaque audit reference`);
  }
  return normalized;
}

function requireEnterpriseMemoryAuditReasonCode(value: string): MemoryEnterpriseAuditReasonCode {
  if (
    !(ENTERPRISE_MEMORY_AUDIT_REASON_CODES as readonly string[]).includes(value) ||
    value !== value.trim()
  ) {
    throw new TypeError("reasonCode is not a permitted enterprise memory audit code");
  }
  return value as MemoryEnterpriseAuditReasonCode;
}

function requireEnterpriseMemoryAuditDecision(
  value: string,
): "allowed" | "denied" | "unavailable" {
  if (value === "allowed" || value === "denied" || value === "unavailable") {
    return value;
  }
  throw new TypeError("decision must be allowed, denied, or unavailable");
}

function reduceEnterpriseAuditReference(params: {
  database: DatabaseSync;
  providerId: string;
  kind:
    | "group"
    | "membership-evidence"
    | "policy"
    | "policy-revision"
    | "principal-evidence"
    | "tenant";
  value: string;
}): string {
  return pseudonymizeExecutionIdentityRef({
    db: params.database,
    kind: "evidence",
    scope: `memory-enterprise:audit:${params.kind}:v1:${params.providerId}`,
    value: requireText(params.value, `decision.${params.kind}`),
  });
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return MAX_AUDIT_DECISIONS;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError("limit must be a positive integer");
  }
  return Math.min(limit, MAX_AUDIT_DECISIONS);
}

/** Canonical lazy shared schema for redacted enterprise memory decisions. */
export const MEMORY_ENTERPRISE_ACCESS_AUDIT_SCHEMA_SQL = extractSchema();

/**
 * An audit event contains only canonical ids and versioned opaque references.
 * Verifiers must HMAC tenant and rule material before calling this boundary.
 */
export type MemoryEnterpriseAccessDecisionAuditEntry = Readonly<{
  eventId: string;
  providerId: string;
  tenantRef: string;
  actorPrincipalId: string;
  subjectPrincipalId: string;
  operation: string;
  decision: "allowed" | "denied" | "unavailable";
  reasonCode: MemoryEnterpriseAuditReasonCode;
  ruleRef: string;
  policyRevision: string;
  principalEvidenceRevision: string;
  membershipEvidenceRevision: string | null;
  occurredAt: number;
  receivedAt: number;
}>;

export type MemoryEnterpriseAccessDecisionAuditQuery = Readonly<{
  providerId?: string;
  tenantRef?: string;
  subjectPrincipalId?: string;
  limit?: number;
}>;

export type MemoryEnterprisePolicyDriftAlert = Readonly<{
  alertId: string;
  providerId: string;
  tenantRef: string;
  subjectPrincipalId: string;
  ruleRef: string;
  policyId: string;
  operation: string;
  previousPolicyRevision: string;
  previousDecision: "allowed" | "denied";
  policyRevision: string;
  decision: "allowed" | "denied";
  detectedAt: number;
}>;

export type MemoryEnterprisePolicyDriftAlertQuery = Readonly<{
  providerId?: string;
  subjectPrincipalId?: string;
  limit?: number;
}>;

/** Redacted core-owned denial before a memory context reaches the backend. */
export type MemoryEnterpriseEvidenceDenialAuditEntry = Readonly<{
  eventId: string;
  providerId: string;
  tenantRef: string;
  subjectPrincipalId: string;
  reasonCode:
    | "membership-stale"
    | "principal-evidence-unavailable"
    | "role-membership-unavailable";
  groupRef: string;
  principalEvidenceRevision: string;
  membershipEvidenceRevision: string | null;
  occurredAt: number;
  receivedAt: number;
}>;

export type MemoryEnterpriseEvidenceDenialAuditQuery = Readonly<{
  providerId?: string;
  subjectPrincipalId?: string;
  limit?: number;
}>;

export type MemoryEnterpriseEvidenceAdmissionDenial = Readonly<{
  providerId: string;
  tenant: string;
  subjectPrincipalId: string;
  groupId: string;
  reasonCode: MemoryEnterpriseEvidenceDenialAuditEntry["reasonCode"];
  principalEvidenceRevision: string;
  membershipEvidenceRevision?: string;
}>;

/** Count-only result for one explicit profile audit-projection deletion. */
export type MemoryEnterpriseAuditDeletionResult = Readonly<{
  accessDecisionCount: number;
  policyObservationCount: number;
  policyDriftAlertCount: number;
  evidenceTransitionProfileLinkCount: number;
  identityActionCount: number;
}>;

/**
 * The selected memory backend may report a role-store policy outcome, but its
 * identifiers are private input. Core reduces them before durable audit writes.
 */
export type MemoryEnterpriseRoleAccessDecision = Readonly<{
  groupId: string;
  policyId: string;
  decision: "allowed" | "denied" | "unavailable";
  reasonCode: MemoryEnterpriseAuditReasonCode;
  policyRevision: string;
}>;

type MemoryEnterpriseAccessAuditDatabase = {
  memory_principals: {
    principal_id: string;
    principal_kind: "user" | "enterprise" | "service" | "agent" | "system" | "conversation";
    state: "active" | "revoked";
  };
  memory_enterprise_audit_deletion_grants: {
    target_user_principal_id: string;
    actor_principal_id: string;
    granted_at: number;
  };
  memory_enterprise_access_decisions: {
    event_id: string;
    provider_id: string;
    tenant_ref: string;
    actor_principal_id: string;
    subject_principal_id: string;
    operation: string;
    decision: "allowed" | "denied" | "unavailable";
    reason_code: string;
    rule_ref: string;
    policy_revision: string;
    principal_evidence_revision: string;
    membership_evidence_revision: string | null;
    occurred_at: number;
    received_at: number;
  };
  memory_enterprise_evidence_denials: {
    event_id: string;
    provider_id: string;
    tenant_ref: string;
    subject_principal_id: string;
    reason_code: "membership-stale" | "principal-evidence-unavailable" | "role-membership-unavailable";
    group_ref: string;
    principal_evidence_revision: string;
    membership_evidence_revision: string | null;
    occurred_at: number;
    received_at: number;
  };
  memory_enterprise_evidence_transition_profile_links: {
    transition_id: string;
    user_principal_id: string;
  };
  memory_enterprise_identity_actions: {
    action_id: string;
    target_user_principal_id: string;
  };
  memory_enterprise_role_policy_observations: {
    provider_id: string;
    tenant_ref: string;
    subject_principal_id: string;
    rule_ref: string;
    policy_id: string;
    operation: string;
    policy_revision: string;
    decision: "allowed" | "denied" | "unavailable";
    observed_at: number;
  };
  memory_enterprise_policy_drift_alerts: {
    alert_id: string;
    provider_id: string;
    tenant_ref: string;
    subject_principal_id: string;
    rule_ref: string;
    policy_id: string;
    operation: string;
    previous_policy_revision: string;
    previous_decision: "allowed" | "denied";
    policy_revision: string;
    decision: "allowed" | "denied";
    detected_at: number;
  };
};

function toEntry(
  row: MemoryEnterpriseAccessAuditDatabase["memory_enterprise_access_decisions"],
): MemoryEnterpriseAccessDecisionAuditEntry {
  return Object.freeze({
    eventId: row.event_id,
    providerId: row.provider_id,
    tenantRef: row.tenant_ref,
    actorPrincipalId: row.actor_principal_id,
    subjectPrincipalId: row.subject_principal_id,
    operation: row.operation,
    decision: row.decision,
    reasonCode: requireEnterpriseMemoryAuditReasonCode(row.reason_code),
    ruleRef: row.rule_ref,
    policyRevision: row.policy_revision,
    principalEvidenceRevision: row.principal_evidence_revision,
    membershipEvidenceRevision: row.membership_evidence_revision,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
  });
}

function toPolicyDriftAlert(
  row: MemoryEnterpriseAccessAuditDatabase["memory_enterprise_policy_drift_alerts"],
): MemoryEnterprisePolicyDriftAlert {
  return Object.freeze({
    alertId: row.alert_id,
    providerId: row.provider_id,
    tenantRef: row.tenant_ref,
    subjectPrincipalId: row.subject_principal_id,
    ruleRef: row.rule_ref,
    policyId: row.policy_id,
    operation: row.operation,
    previousPolicyRevision: row.previous_policy_revision,
    previousDecision: row.previous_decision,
    policyRevision: row.policy_revision,
    decision: row.decision,
    detectedAt: row.detected_at,
  });
}

function toEvidenceDenial(
  row: MemoryEnterpriseAccessAuditDatabase["memory_enterprise_evidence_denials"],
): MemoryEnterpriseEvidenceDenialAuditEntry {
  return Object.freeze({
    eventId: row.event_id,
    providerId: row.provider_id,
    tenantRef: row.tenant_ref,
    subjectPrincipalId: row.subject_principal_id,
    reasonCode: row.reason_code,
    groupRef: row.group_ref,
    principalEvidenceRevision: row.principal_evidence_revision,
    membershipEvidenceRevision: row.membership_evidence_revision,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
  });
}

/** Install the additive audit ledger only when an enterprise decision is retained. */
export function ensureMemoryEnterpriseAccessAuditSchema(database: DatabaseSync): void {
  if (ensuredDatabases.has(database)) {
    return;
  }
  const ensure = () => {
    database.exec(MEMORY_ENTERPRISE_ACCESS_AUDIT_SCHEMA_SQL); // sqlite-allow-raw -- canonical additive DDL.
    database.exec(ENTERPRISE_AUDIT_DELETION_TRIGGER_MIGRATION_SQL); // sqlite-allow-raw -- guarded audit-projection trigger migration.
  };
  if (database.isTransaction) {
    ensure();
  } else {
    runSqliteImmediateTransactionSync(database, ensure);
  }
  ensuredDatabases.add(database);
}

function requireEnterpriseAuditDeletionPrincipalsInTransaction(params: {
  database: DatabaseSync;
  userPrincipalId: string;
  actorPrincipalId: string;
}): void {
  const db = getNodeSqliteKysely<MemoryEnterpriseAccessAuditDatabase>(params.database);
  const target = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_principals")
      .select(["principal_kind", "state"])
      .where("principal_id", "=", params.userPrincipalId),
  );
  if (target?.principal_kind !== "user" || target.state !== "active") {
    throw new Error("enterprise audit deletion requires an active Gateway user principal target");
  }
  const actor = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_principals")
      .select(["principal_kind", "state"])
      .where("principal_id", "=", params.actorPrincipalId),
  );
  if (
    actor?.state !== "active" ||
    (actor.principal_kind !== "user" && actor.principal_kind !== "system")
  ) {
    throw new Error("enterprise audit deletion requires an active Gateway user or system actor");
  }
}

/**
 * Explicitly remove one profile's redacted enterprise-audit projection. The
 * linked identity, immutable evidence, prior generic exposure records, and
 * private memory remain intact, so deletion cannot accidentally restore access.
 */
export function deleteMemoryEnterpriseAuditForUserPrincipal(params: {
  userPrincipalId: string;
  actorPrincipalId: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryEnterpriseAuditDeletionResult {
  const options = params.options ?? {};
  const userPrincipalId = requireText(params.userPrincipalId, "userPrincipalId");
  const actorPrincipalId = requireText(params.actorPrincipalId, "actorPrincipalId");
  const now = Number.isSafeInteger(params.now ?? Date.now()) ? (params.now ?? Date.now()) : NaN;
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("now must be a non-negative safe integer");
  }
  // The grant has foreign keys to the canonical principal table. Create that
  // narrow identity shape first, rather than assuming this optional feature ran.
  ensureMemoryIdentitySchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      ensureMemoryEnterpriseAccessAuditSchema(database);
      requireEnterpriseAuditDeletionPrincipalsInTransaction({
        database,
        userPrincipalId,
        actorPrincipalId,
      });
      const db = getNodeSqliteKysely<MemoryEnterpriseAccessAuditDatabase>(database);
      executeSqliteQuerySync(
        database,
        db.insertInto("memory_enterprise_audit_deletion_grants").values({
          target_user_principal_id: userPrincipalId,
          actor_principal_id: actorPrincipalId,
          granted_at: now,
        }),
      );
      const accessDecisionCount = Number(
        executeSqliteQuerySync(
          database,
          db
            .deleteFrom("memory_enterprise_access_decisions")
            .where("subject_principal_id", "=", userPrincipalId),
        ).numAffectedRows,
      );
      const policyObservationCount = Number(
        executeSqliteQuerySync(
          database,
          db
            .deleteFrom("memory_enterprise_role_policy_observations")
            .where("subject_principal_id", "=", userPrincipalId),
        ).numAffectedRows,
      );
      const policyDriftAlertCount = Number(
        executeSqliteQuerySync(
          database,
          db
            .deleteFrom("memory_enterprise_policy_drift_alerts")
            .where("subject_principal_id", "=", userPrincipalId),
        ).numAffectedRows,
      );
      // Evidence denials are also a redacted profile projection. They share
      // this explicit deletion path but not its public count-only contract.
      executeSqliteQuerySync(
        database,
        db
          .deleteFrom("memory_enterprise_evidence_denials")
          .where("subject_principal_id", "=", userPrincipalId),
      );
      const evidenceTransitionProfileLinkCount = Number(
        executeSqliteQuerySync(
          database,
          db
            .deleteFrom("memory_enterprise_evidence_transition_profile_links")
            .where("user_principal_id", "=", userPrincipalId),
        ).numAffectedRows,
      );
      const identityActionCount = Number(
        executeSqliteQuerySync(
          database,
          db
            .deleteFrom("memory_enterprise_identity_actions")
            .where("target_user_principal_id", "=", userPrincipalId),
        ).numAffectedRows,
      );
      const removedGrant = executeSqliteQuerySync(
        database,
        db
          .deleteFrom("memory_enterprise_audit_deletion_grants")
          .where("target_user_principal_id", "=", userPrincipalId)
          .where("actor_principal_id", "=", actorPrincipalId),
      );
      if (removedGrant.numAffectedRows !== 1n) {
        throw new Error("enterprise audit deletion grant changed during projection purge");
      }
      return Object.freeze({
        accessDecisionCount,
        policyObservationCount,
        policyDriftAlertCount,
        evidenceTransitionProfileLinkCount,
        identityActionCount,
      });
    },
    options,
    { operationLabel: "memory-enterprise-audit.profile.delete" },
  );
}

/** Idempotently retain a redacted decision after policy evaluation completes. */
export function writeMemoryEnterpriseAccessDecisionAudit(
  entry: MemoryEnterpriseAccessDecisionAuditEntry,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const checked = {
    eventId: requireText(entry.eventId, "eventId"),
    providerId: requireText(entry.providerId, "providerId"),
    actorPrincipalId: requireText(entry.actorPrincipalId, "actorPrincipalId"),
    subjectPrincipalId: requireText(entry.subjectPrincipalId, "subjectPrincipalId"),
    operation: requireText(entry.operation, "operation"),
    reasonCode: requireEnterpriseMemoryAuditReasonCode(entry.reasonCode),
    tenantRef: requireOpaqueAuditReference(entry.tenantRef, "tenantRef"),
    ruleRef: requireOpaqueAuditReference(entry.ruleRef, "ruleRef"),
    policyRevision: requireOpaqueAuditReference(entry.policyRevision, "policyRevision"),
    principalEvidenceRevision: requireOpaqueAuditReference(
      entry.principalEvidenceRevision,
      "principalEvidenceRevision",
    ),
    membershipEvidenceRevision:
      entry.membershipEvidenceRevision === null
        ? null
        : requireOpaqueAuditReference(
            entry.membershipEvidenceRevision,
            "membershipEvidenceRevision",
          ),
  };
  runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      ensureMemoryEnterpriseAccessAuditSchema(database);
      insertMemoryEnterpriseAccessDecisionAuditInTransaction(
        database,
        Object.freeze({
          ...checked,
          decision: entry.decision,
          occurredAt: entry.occurredAt,
          receivedAt: entry.receivedAt,
        }),
      );
    },
    options,
    { operationLabel: "memory-enterprise-audit.decision.write" },
  );
}

function requireEnterpriseEvidenceDenialReason(
  value: string,
): MemoryEnterpriseEvidenceDenialAuditEntry["reasonCode"] {
  if (
    value === "membership-stale" ||
    value === "principal-evidence-unavailable" ||
    value === "role-membership-unavailable"
  ) {
    return value;
  }
  throw new TypeError("reasonCode is not a permitted enterprise evidence denial code");
}

/**
 * Retain a deduplicated, redacted evidence denial before policy selection. The
 * untrusted-looking provider values remain process-local until this state
 * transaction reduces them; no selected plugin receives a rejected context.
 */
export function recordMemoryEnterpriseEvidenceAdmissionDenials(params: {
  denials: readonly MemoryEnterpriseEvidenceAdmissionDenial[];
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): void {
  if (params.denials.length === 0) {
    return;
  }
  const now = params.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("now must be a non-negative safe integer");
  }
  const unique = new Map<string, MemoryEnterpriseEvidenceAdmissionDenial>();
  for (const input of params.denials) {
    const denial = Object.freeze({
      providerId: requireText(input.providerId, "denial.providerId"),
      tenant: requireText(input.tenant, "denial.tenant"),
      subjectPrincipalId: requireText(input.subjectPrincipalId, "denial.subjectPrincipalId"),
      groupId: requireText(input.groupId, "denial.groupId"),
      reasonCode: requireEnterpriseEvidenceDenialReason(input.reasonCode),
      principalEvidenceRevision: requireText(
        input.principalEvidenceRevision,
        "denial.principalEvidenceRevision",
      ),
      ...(input.membershipEvidenceRevision
        ? {
            membershipEvidenceRevision: requireText(
              input.membershipEvidenceRevision,
              "denial.membershipEvidenceRevision",
            ),
          }
        : {}),
    });
    unique.set(
      [
        denial.providerId,
        denial.tenant,
        denial.subjectPrincipalId,
        denial.groupId,
        denial.reasonCode,
        denial.principalEvidenceRevision,
        denial.membershipEvidenceRevision ?? "",
      ].join("\0"),
      denial,
    );
  }
  runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      ensureMemoryEnterpriseAccessAuditSchema(database);
      const db = getNodeSqliteKysely<MemoryEnterpriseAccessAuditDatabase>(database);
      for (const denial of unique.values()) {
        const tenantRef = reduceEnterpriseAuditReference({
          database,
          providerId: denial.providerId,
          kind: "tenant",
          value: denial.tenant,
        });
        const groupRef = reduceEnterpriseAuditReference({
          database,
          providerId: denial.providerId,
          kind: "group",
          value: denial.groupId,
        });
        const principalEvidenceRevision = reduceEnterpriseAuditReference({
          database,
          providerId: denial.providerId,
          kind: "principal-evidence",
          value: denial.principalEvidenceRevision,
        });
        const membershipEvidenceRevision = denial.membershipEvidenceRevision
          ? reduceEnterpriseAuditReference({
              database,
              providerId: denial.providerId,
              kind: "membership-evidence",
              value: denial.membershipEvidenceRevision,
            })
          : null;
        const eventId = auditEventId([
          "evidence-denial",
          denial.providerId,
          denial.subjectPrincipalId,
          tenantRef,
          groupRef,
          denial.reasonCode,
          principalEvidenceRevision,
          membershipEvidenceRevision ?? "",
        ]);
        executeSqliteQuerySync(
          database,
          db
            .insertInto("memory_enterprise_evidence_denials")
            .values({
              event_id: eventId,
              provider_id: denial.providerId,
              tenant_ref: tenantRef,
              subject_principal_id: denial.subjectPrincipalId,
              reason_code: denial.reasonCode,
              group_ref: groupRef,
              principal_evidence_revision: principalEvidenceRevision,
              membership_evidence_revision: membershipEvidenceRevision,
              occurred_at: now,
              received_at: Date.now(),
            })
            .onConflict((conflict) => conflict.column("event_id").doNothing()),
        );
      }
    },
    params.options ?? {},
    { operationLabel: "memory-enterprise-audit.evidence-denial.write" },
  );
}

function auditEventId(parts: readonly string[]): string {
  return `mea1_${createHash("sha256").update(parts.join("\0")).digest("base64url")}`;
}

function insertMemoryEnterpriseAccessDecisionAuditInTransaction(
  database: DatabaseSync,
  entry: MemoryEnterpriseAccessDecisionAuditEntry,
): void {
  const db = getNodeSqliteKysely<MemoryEnterpriseAccessAuditDatabase>(database);
  executeSqliteQuerySync(
    database,
    db
      .insertInto("memory_enterprise_access_decisions")
      .values({
        event_id: entry.eventId,
        provider_id: entry.providerId,
        tenant_ref: entry.tenantRef,
        actor_principal_id: entry.actorPrincipalId,
        subject_principal_id: entry.subjectPrincipalId,
        operation: entry.operation,
        decision: entry.decision,
        reason_code: entry.reasonCode,
        rule_ref: entry.ruleRef,
        policy_revision: entry.policyRevision,
        principal_evidence_revision: entry.principalEvidenceRevision,
        membership_evidence_revision: entry.membershipEvidenceRevision,
        occurred_at: entry.occurredAt,
        received_at: entry.receivedAt,
      })
      .onConflict((conflict) => conflict.column("event_id").doNothing()),
  );
}

// The selected memory plugin owns policy evaluation. This ledger compares only
// core-reduced revision/decision pairs so alert suppression stays atomic with
// redacted audit persistence; it cannot select a policy or store.
function recordMemoryEnterprisePolicyDriftInTransaction(params: {
  database: DatabaseSync;
  entry: MemoryEnterpriseAccessDecisionAuditEntry;
  policyId: string;
}): void {
  const { database, entry } = params;
  const db = getNodeSqliteKysely<MemoryEnterpriseAccessAuditDatabase>(database);
  const policyId = requireText(params.policyId, "policyId");
  const baseline = executeSqliteQuerySync(
    database,
    db
      .selectFrom("memory_enterprise_role_policy_observations")
      .select(["policy_revision", "decision"])
      .where("provider_id", "=", entry.providerId)
      .where("tenant_ref", "=", entry.tenantRef)
      .where("subject_principal_id", "=", entry.subjectPrincipalId)
      .where("rule_ref", "=", entry.ruleRef)
      .where("policy_id", "=", policyId)
      .where("operation", "=", entry.operation)
      .limit(1),
  ).rows[0];
  if (!baseline) {
    executeSqliteQuerySync(
      database,
      db.insertInto("memory_enterprise_role_policy_observations").values({
        provider_id: entry.providerId,
        tenant_ref: entry.tenantRef,
        subject_principal_id: entry.subjectPrincipalId,
        rule_ref: entry.ruleRef,
        policy_id: policyId,
        operation: entry.operation,
        policy_revision: entry.policyRevision,
        decision: entry.decision,
        observed_at: entry.occurredAt,
      }),
    );
    return;
  }
  if (baseline.policy_revision === entry.policyRevision) {
    return;
  }
  if (
    (baseline.decision === "allowed" || baseline.decision === "denied") &&
    (entry.decision === "allowed" || entry.decision === "denied") &&
    baseline.decision !== entry.decision
  ) {
    executeSqliteQuerySync(
      database,
      db
        .insertInto("memory_enterprise_policy_drift_alerts")
        .values({
          alert_id: auditEventId([
            "policy-drift",
            entry.providerId,
            entry.tenantRef,
            entry.subjectPrincipalId,
            entry.ruleRef,
            policyId,
            entry.operation,
            baseline.policy_revision,
            baseline.decision,
            entry.policyRevision,
            entry.decision,
          ]),
          provider_id: entry.providerId,
          tenant_ref: entry.tenantRef,
          subject_principal_id: entry.subjectPrincipalId,
          rule_ref: entry.ruleRef,
          policy_id: policyId,
          operation: entry.operation,
          previous_policy_revision: baseline.policy_revision,
          previous_decision: baseline.decision,
          policy_revision: entry.policyRevision,
          decision: entry.decision,
          detected_at: entry.occurredAt,
        })
        .onConflict((conflict) => conflict.column("alert_id").doNothing()),
    );
  }
  executeSqliteQuerySync(
    database,
    db
      .updateTable("memory_enterprise_role_policy_observations")
      .set({
        policy_revision: entry.policyRevision,
        decision: entry.decision,
        observed_at: entry.occurredAt,
      })
      .where("provider_id", "=", entry.providerId)
      .where("tenant_ref", "=", entry.tenantRef)
      .where("subject_principal_id", "=", entry.subjectPrincipalId)
      .where("rule_ref", "=", entry.ruleRef)
      .where("policy_id", "=", policyId)
      .where("operation", "=", entry.operation),
  );
}

/**
 * Core derives every durable field from the current verified context and
 * identity store. A backend can report a role-policy outcome but cannot name
 * a tenant, subject, or redacted audit reference of its choosing.
 */
export function recordMemoryEnterpriseRoleAccessDecisions(params: {
  context: MemoryAccessContext;
  decisions: readonly MemoryEnterpriseRoleAccessDecision[];
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): void {
  if (params.context.subject.kind !== "user" || params.decisions.length === 0) {
    return;
  }
  const subjectPrincipalId = params.context.subject.principalId;
  const now = params.now ?? Date.now();
  const actorPrincipalId =
    params.context.actor.kind === "principal"
      ? params.context.actor.principalId
      : subjectPrincipalId;
  const unique = new Map<string, MemoryEnterpriseRoleAccessDecision>();
  for (const decision of params.decisions) {
    const groupId = requireText(decision.groupId, "decision.groupId");
    const policyId = requireText(decision.policyId, "decision.policyId");
    const auditDecision = requireEnterpriseMemoryAuditDecision(decision.decision);
    const reasonCode = requireEnterpriseMemoryAuditReasonCode(decision.reasonCode);
    const policyRevision = requireText(decision.policyRevision, "decision.policyRevision");
    unique.set(
      `${groupId}\0${policyId}\0${auditDecision}\0${reasonCode}\0${policyRevision}`,
      Object.freeze({ groupId, policyId, decision: auditDecision, reasonCode, policyRevision }),
    );
  }
  const entries: Array<
    Readonly<{
      providerId: string;
      tenantRef: string;
      ruleRef: string;
      principalEvidenceRevision: string;
      membershipEvidenceRevision: string;
      decision: MemoryEnterpriseRoleAccessDecision;
    }>
  > = [];
  for (const decision of unique.values()) {
    for (const membership of params.context.verifiedMemberships) {
      if (
        membership.principalId !== subjectPrincipalId ||
        membership.groupId !== decision.groupId ||
        Date.parse(membership.observedAt) > now ||
        Date.parse(membership.expiresAt) <= now
      ) {
        continue;
      }
      const snapshot = readCurrentMemoryEnterpriseMembershipForAudit({
        principalId: membership.sourcePrincipalId,
        providerId: membership.provider,
        group: membership.groupId,
        now,
        options: params.options,
      });
      if (
        !snapshot ||
        snapshot.evidenceRevision !== membership.evidenceRevision ||
        snapshot.expiresAt <= now
      ) {
        continue;
      }
      entries.push(
        Object.freeze({
          providerId: membership.provider,
          tenantRef: snapshot.tenantRef,
          // The reduced group ref identifies the authorization rule without
          // retaining a role display name or any memory resource identifier.
          ruleRef: snapshot.groupRef,
          principalEvidenceRevision: membership.evidenceRevision,
          membershipEvidenceRevision: snapshot.evidenceRevision,
          decision,
        }),
      );
    }
  }
  if (entries.length === 0) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      ensureMemoryEnterpriseAccessAuditSchema(database);
      for (const input of entries) {
        // This callback is durable-write authority, not a redaction boundary:
        // reduce every backend-controlled reference before it can reach SQLite
        // or the owner/admin export surface.
        const policyId = reduceEnterpriseAuditReference({
          database,
          providerId: input.providerId,
          kind: "policy",
          value: input.decision.policyId,
        });
        const policyRevision = reduceEnterpriseAuditReference({
          database,
          providerId: input.providerId,
          kind: "policy-revision",
          value: input.decision.policyRevision,
        });
        const principalEvidenceRevision = reduceEnterpriseAuditReference({
          database,
          providerId: input.providerId,
          kind: "principal-evidence",
          value: input.principalEvidenceRevision,
        });
        const membershipEvidenceRevision = reduceEnterpriseAuditReference({
          database,
          providerId: input.providerId,
          kind: "membership-evidence",
          value: input.membershipEvidenceRevision,
        });
        const entry = Object.freeze({
          eventId: auditEventId([
            params.context.requestId,
            params.context.operation,
            subjectPrincipalId,
            input.providerId,
            input.ruleRef,
            input.decision.decision,
            input.decision.reasonCode,
            policyId,
            policyRevision,
            principalEvidenceRevision,
            membershipEvidenceRevision,
          ]),
          providerId: input.providerId,
          tenantRef: input.tenantRef,
          actorPrincipalId,
          subjectPrincipalId,
          operation: params.context.operation,
          decision: input.decision.decision,
          reasonCode: input.decision.reasonCode,
          ruleRef: input.ruleRef,
          policyRevision,
          principalEvidenceRevision,
          membershipEvidenceRevision,
          occurredAt: now,
          receivedAt: Date.now(),
        } satisfies MemoryEnterpriseAccessDecisionAuditEntry);
        insertMemoryEnterpriseAccessDecisionAuditInTransaction(database, entry);
        recordMemoryEnterprisePolicyDriftInTransaction({ database, entry, policyId });
      }
    },
    params.options ?? {},
    { operationLabel: "memory-enterprise-audit.role-decision.write" },
  );
}

/** List at most one small page of redacted decision evidence for one subject. */
export function listMemoryEnterpriseAccessDecisionAudit(
  query: MemoryEnterpriseAccessDecisionAuditQuery,
  options: OpenClawStateDatabaseOptions = {},
): readonly MemoryEnterpriseAccessDecisionAuditEntry[] {
  const subjectPrincipalId = requireText(query.subjectPrincipalId ?? "", "subjectPrincipalId");
  const database = openOpenClawStateDatabase(options).db;
  ensureMemoryEnterpriseAccessAuditSchema(database);
  const db = getNodeSqliteKysely<MemoryEnterpriseAccessAuditDatabase>(database);
  let statement = db
    .selectFrom("memory_enterprise_access_decisions")
    .selectAll()
    .where("subject_principal_id", "=", subjectPrincipalId);
  if (query.providerId !== undefined) {
    statement = statement.where("provider_id", "=", requireText(query.providerId, "providerId"));
  }
  if (query.tenantRef !== undefined) {
    statement = statement.where("tenant_ref", "=", requireText(query.tenantRef, "tenantRef"));
  }
  const rows = executeSqliteQuerySync(
    database,
    statement
      .orderBy("occurred_at", "desc")
      .orderBy("event_id", "desc")
      .limit(boundedLimit(query.limit)),
  );
  return Object.freeze(rows.rows.map(toEntry));
}

/** List one bounded page of core-owned redacted evidence denials for a profile. */
export function listMemoryEnterpriseEvidenceDenialAudit(
  query: MemoryEnterpriseEvidenceDenialAuditQuery,
  options: OpenClawStateDatabaseOptions = {},
): readonly MemoryEnterpriseEvidenceDenialAuditEntry[] {
  const subjectPrincipalId = requireText(query.subjectPrincipalId ?? "", "subjectPrincipalId");
  const database = openOpenClawStateDatabase(options).db;
  ensureMemoryEnterpriseAccessAuditSchema(database);
  const db = getNodeSqliteKysely<MemoryEnterpriseAccessAuditDatabase>(database);
  let statement = db
    .selectFrom("memory_enterprise_evidence_denials")
    .selectAll()
    .where("subject_principal_id", "=", subjectPrincipalId);
  if (query.providerId !== undefined) {
    statement = statement.where("provider_id", "=", requireText(query.providerId, "providerId"));
  }
  const rows = executeSqliteQuerySync(
    database,
    statement
      .orderBy("occurred_at", "desc")
      .orderBy("event_id", "desc")
      .limit(boundedLimit(query.limit)),
  );
  return Object.freeze(rows.rows.map(toEvidenceDenial));
}

/** List a bounded redacted page of actual selected-plugin allow/deny policy flips. */
export function listMemoryEnterprisePolicyDriftAlerts(
  query: MemoryEnterprisePolicyDriftAlertQuery,
  options: OpenClawStateDatabaseOptions = {},
): readonly MemoryEnterprisePolicyDriftAlert[] {
  const subjectPrincipalId = requireText(query.subjectPrincipalId ?? "", "subjectPrincipalId");
  const database = openOpenClawStateDatabase(options).db;
  ensureMemoryEnterpriseAccessAuditSchema(database);
  const db = getNodeSqliteKysely<MemoryEnterpriseAccessAuditDatabase>(database);
  let statement = db
    .selectFrom("memory_enterprise_policy_drift_alerts")
    .selectAll()
    .where("subject_principal_id", "=", subjectPrincipalId);
  if (query.providerId !== undefined) {
    statement = statement.where("provider_id", "=", requireText(query.providerId, "providerId"));
  }
  const rows = executeSqliteQuerySync(
    database,
    statement
      .orderBy("detected_at", "desc")
      .orderBy("alert_id", "desc")
      .limit(boundedLimit(query.limit)),
  );
  return Object.freeze(rows.rows.map(toPolicyDriftAlert));
}
