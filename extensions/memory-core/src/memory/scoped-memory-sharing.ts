import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AudienceRef } from "openclaw/plugin-sdk/memory-authorization";
import { resolveMemoryPostboxTurnCapability } from "openclaw/plugin-sdk/memory-postbox-runtime";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  resolveScopedMemoryArtifactBase,
  type ScopedMemoryDatabase,
  withScopedMemoryDatabase,
} from "./scoped-memory-db.js";
import {
  evaluateBuiltinScopedMemoryPolicy,
  evaluateBuiltinScopedMemoryPolicyInDatabase,
} from "./scoped-memory-policy.js";
import {
  chunkScopedMemoryMarkdown,
  isBuiltinScopedMemoryRevisionLineageCurrentInDatabase,
  resolveBuiltinScopedMemoryArtifactPath,
  type BuiltinScopedMemoryDerivedSource,
} from "./scoped-memory-resources.js";
import {
  createScopedMemorySourcePolicySetId,
  normalizeScopedMemoryRequiredText,
  type BuiltinScopedMemoryStore,
} from "./scoped-memory-store.js";
import {
  finalizeScopedMemoryWriteArtifact,
  hashScopedMemoryWriteContent,
  quarantineScopedMemoryWriteArtifact,
  readVerifiedScopedMemoryWriteArtifact,
  requireOneScopedMemoryWriteRow,
  stageScopedMemoryWriteArtifact,
} from "./scoped-memory-write-artifact.js";

const POSTBOX_HANDLE_TTL_MS = 10 * 60 * 1000;
const POSTBOX_RATE_WINDOW_MS = 60 * 60 * 1000;
const POSTBOX_MAX_DEPOSITS_PER_WINDOW = 12;
const POSTBOX_MAX_CONTENT_BYTES = 16 * 1024;

type ProjectionAudience = Readonly<{
  kind: "conversation" | "role" | "agent-shared";
  id: string;
}>;

export type BuiltinMemoryProjection = Readonly<{
  projectionId: string;
  copyRevisionId: string;
  sourceRevisionId: string;
  target: ProjectionAudience;
  expiresAt?: number;
  /** Present only for a refresh: the old copy's prior exposure ids under the replacement fence. */
  replacedExposureSetIds?: readonly string[];
}>;

export type BuiltinMemoryProjectionPreview = Readonly<{
  sourceRevisionId: string;
  target: ProjectionAudience;
  purpose: string;
  preview: string;
  expiry: "expires" | "no-expiry";
}>;

export type BuiltinMemoryPostboxDeposit = Readonly<{ accepted: boolean }>;

export type BuiltinMemoryPostboxInspection = Readonly<{
  itemId: string;
  content: string;
  sourceChannelRef: string;
  createdAt: number;
}>;

export type BuiltinMemoryProjectionImpact = Readonly<{
  projectionId: string;
  exposureSetIds: readonly string[];
}>;

export type BuiltinMemorySharingStatus = Readonly<{
  postboxMode: "off" | "review-required";
  projections: readonly Readonly<{
    projectionId: string;
    target: ProjectionAudience;
    purpose: string;
    preview: string;
    state: "active" | "revoked" | "expired";
    expiresAt: number | null;
  }>[];
  postboxItems: readonly Readonly<{
    itemId: string;
    state: "postbox" | "reviewed" | "rejected" | "purged";
    sourceChannelRef: string;
    createdAt: number;
  }>[];
}>;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value: string, label: string): string {
  return normalizeScopedMemoryRequiredText(value, label);
}

function targetAudience(params: {
  kind: ProjectionAudience["kind"];
  id: string;
}): ProjectionAudience {
  if (params.kind !== "conversation" && params.kind !== "role" && params.kind !== "agent-shared") {
    throw new Error("memory projection target is unavailable");
  }
  return Object.freeze({ kind: params.kind, id: normalize(params.id, "projection target id") });
}

function assertStoreOperation(params: {
  agentId: string;
  storeId: string;
  principalId: string;
  audience: AudienceRef;
  operation: "project" | "publish" | "policy-admin";
}): void {
  const decision = evaluateBuiltinScopedMemoryPolicy({
    agentId: params.agentId,
    storeId: params.storeId,
    principalIds: [params.principalId],
    deliveryAudiences: [params.audience],
    operation: params.operation,
  });
  if (!decision.allowed) {
    throw new Error("memory sharing authorization is unavailable");
  }
}

function readTargetStore(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  agentId: string;
  target: ProjectionAudience;
}) {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  return executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_projection_targets as target")
      .innerJoin("memory_stores as store", "store.store_id", "target.store_id")
      .innerJoin("memory_storage_roots as root", "root.storage_root_id", "store.storage_root_id")
      .innerJoin("memory_policies as policy", "policy.policy_id", "store.policy_id")
      .select([
        "store.store_id",
        "store.policy_id",
        "policy.current_revision_id",
        "policy.revocation_epoch",
        "root.path_key",
      ])
      .where("target.agent_id", "=", params.agentId)
      .where("target.audience_kind", "=", params.target.kind)
      .where("target.audience_id", "=", params.target.id)
      .where("store.agent_id", "=", params.agentId)
      .where("store.audience_kind", "=", params.target.kind)
      .where("store.audience_id", "=", params.target.id)
      .where("store.lifecycle_state", "=", "active")
      .where("root.backend_kind", "=", "builtin")
      .where("root.lifecycle_state", "=", "active")
      .where("policy.lifecycle_state", "=", "active"),
  );
}

/** The private postbox target is selected from core-verified source identity, never tool input. */
function readPostboxTargetStore(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  agentId: string;
  targetPrincipalId: string;
}) {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  const candidates = executeSqliteQuerySync(
    params.database,
    db
      .selectFrom("memory_stores")
      .select(["store_id", "audience_kind", "audience_id"])
      .where("agent_id", "=", params.agentId)
      .where("audience_kind", "=", "user")
      .where("audience_id", "=", params.targetPrincipalId)
      .where("lifecycle_state", "=", "active"),
  ).rows;
  const eligible = candidates.filter(
    (store) =>
      evaluateBuiltinScopedMemoryPolicy({
        agentId: params.agentId,
        storeId: store.store_id,
        principalIds: [params.targetPrincipalId],
        deliveryAudiences: [{ kind: "user", id: params.targetPrincipalId }],
        operation: "policy-admin",
      }).allowed,
  );
  // A verified principal may own more than one user store. Selecting a first
  // row would make quarantine depend on database order; ambiguous targets fail closed.
  return eligible.length === 1 ? eligible[0] : undefined;
}

function readSource(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  agentId: string;
  revisionId: string;
}) {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  const source = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_resource_revisions as revision")
      .innerJoin("memory_resources as resource", "resource.resource_id", "revision.resource_id")
      .innerJoin("memory_stores as store", "store.store_id", "resource.store_id")
      .select(["store.store_id", "store.audience_kind", "store.audience_id"])
      .where("revision.revision_id", "=", params.revisionId)
      .where("resource.agent_id", "=", params.agentId),
  );
  if (!source) {
    throw new Error("memory projection source is unavailable");
  }
  return source;
}

function readSourceRequirements(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  revisionId: string;
}): BuiltinScopedMemoryDerivedSource {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  const policyRequirements = executeSqliteQuerySync(
    params.database,
    db
      .selectFrom("memory_revision_policy_requirements")
      .select(["policy_id", "expected_revision_id", "expected_revocation_epoch"])
      .where("revision_id", "=", params.revisionId)
      .orderBy("policy_id"),
  ).rows.map((row) =>
    Object.freeze({
      policyId: row.policy_id,
      expectedRevisionId: row.expected_revision_id,
      expectedRevocationEpoch: row.expected_revocation_epoch,
    }),
  );
  if (policyRequirements.length === 0) {
    throw new Error("memory projection source is unavailable");
  }
  return Object.freeze({
    revisionId: params.revisionId,
    policyRequirements: Object.freeze(policyRequirements),
  });
}

/**
 * An owner/admin configures the one physical projection store for one named audience.
 * User audiences are deliberately excluded, so this cannot become a private-store grant API.
 */
export function registerBuiltinMemoryProjectionTarget(params: {
  agentId: string;
  target: ProjectionAudience;
  store: BuiltinScopedMemoryStore;
  operatorPrincipalId: string;
  nowMs?: number;
}): void {
  registerBuiltinMemoryProjectionTargetStore({
    agentId: params.agentId,
    target: params.target,
    storeId: params.store.storeId,
    operatorPrincipalId: params.operatorPrincipalId,
    nowMs: params.nowMs,
  });
}

/** Register a pre-existing non-private store as the sole reviewed-copy target for its audience. */
export function registerBuiltinMemoryProjectionTargetStore(params: {
  agentId: string;
  target: ProjectionAudience;
  storeId: string;
  operatorPrincipalId: string;
  nowMs?: number;
}): void {
  const target = targetAudience(params.target);
  const storeId = normalize(params.storeId, "projection target store id");
  const operatorPrincipalId = normalize(params.operatorPrincipalId, "operator principal id");
  const nowMs = params.nowMs ?? Date.now();
  withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    runSqliteImmediateTransactionSync(database, () => {
      const store = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_stores")
          .select(["store_id", "audience_kind", "audience_id"])
          .where("store_id", "=", storeId)
          .where("agent_id", "=", params.agentId)
          .where("lifecycle_state", "=", "active"),
      );
      if (!store || store.audience_kind !== target.kind || store.audience_id !== target.id) {
        throw new Error("memory projection target is unavailable");
      }
      assertStoreOperation({
        agentId: params.agentId,
        storeId,
        principalId: operatorPrincipalId,
        audience: target,
        operation: "policy-admin",
      });
      executeSqliteQuerySync(
        database,
        db
          .insertInto("memory_projection_targets")
          .values({
            agent_id: params.agentId,
            audience_kind: target.kind,
            audience_id: target.id,
            store_id: storeId,
            configured_by_principal_id: operatorPrincipalId,
            created_at: nowMs,
          })
          .onConflict((conflict) =>
            conflict.columns(["agent_id", "audience_kind", "audience_id"]).doUpdateSet({
              store_id: storeId,
              configured_by_principal_id: operatorPrincipalId,
              created_at: nowMs,
            }),
          ),
      );
    });
  });
}

type ProjectionWriteIntent = Readonly<{
  projectionId: string;
  target: ProjectionAudience;
  targetStoreId: string;
  sourceRevisionId: string;
  publisherPrincipalId: string;
  reviewedByPrincipalId: string;
  purpose: string;
  preview: string;
  expiry:
    | Readonly<{ kind: "expires"; expiresAt: number }>
    | Readonly<{ kind: "no-expiry"; auditReason: string }>;
  replaceActiveProjectionId?: string;
}>;

type ProjectionWriteInterruptPoint = "after-pending-commit" | "after-artifact-rename";

class ProjectionWriteInterruptedForTest extends Error {}

let projectionWriteInterruptForTest: ProjectionWriteInterruptPoint | undefined;

/** Test-only process interruption: durable state intentionally remains for startup recovery. */
export function setBuiltinMemoryProjectionWriteInterruptForTest(
  point: ProjectionWriteInterruptPoint | undefined,
): void {
  projectionWriteInterruptForTest = point;
}

function interruptProjectionWriteForTest(point: ProjectionWriteInterruptPoint): void {
  if (projectionWriteInterruptForTest === point) {
    throw new ProjectionWriteInterruptedForTest(point);
  }
}

function readProjectionWriteIntent(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  intentId: string;
}) {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  const write = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_write_intents")
      .selectAll()
      .where("intent_id", "=", params.intentId)
      .where("mutation_kind", "=", "project"),
  );
  const projection = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_projection_write_intents")
      .selectAll()
      .where("intent_id", "=", params.intentId),
  );
  return write && projection ? Object.freeze({ write, projection }) : undefined;
}

function assertProjectionWriteCurrent(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  agentId: string;
  intent: ProjectionWriteIntent;
  pendingRevisionId?: string;
  nowMs: number;
}) {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  const source = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_resource_revisions as revision")
      .innerJoin("memory_resources as resource", "resource.resource_id", "revision.resource_id")
      .innerJoin("memory_stores as store", "store.store_id", "resource.store_id")
      .innerJoin("memory_policies as policy", "policy.policy_id", "store.policy_id")
      .innerJoin(
        "memory_policy_revisions as policy_revision",
        "policy_revision.revision_id",
        "policy.current_revision_id",
      )
      .select([
        "store.store_id",
        "store.audience_kind",
        "store.audience_id",
        "revision.lifecycle_state as revision_state",
        "revision.policy_revision_id",
        "revision.policy_revocation_epoch",
        "policy.current_revision_id",
        "policy.revocation_epoch",
        "policy.lifecycle_state as policy_lifecycle_state",
        "policy_revision.lifecycle_state as policy_revision_state",
      ])
      .where("revision.revision_id", "=", params.intent.sourceRevisionId)
      .where("resource.agent_id", "=", params.agentId),
  );
  if (
    !source ||
    source.revision_state !== "active" ||
    source.policy_lifecycle_state !== "active" ||
    source.policy_revision_state !== "active" ||
    source.policy_revision_id !== source.current_revision_id ||
    source.policy_revocation_epoch !== source.revocation_epoch ||
    !isBuiltinScopedMemoryRevisionLineageCurrentInDatabase({
      database: params.database,
      revisionId: params.intent.sourceRevisionId,
    })
  ) {
    throw new Error("memory projection source is unavailable");
  }
  const sourceAudience: AudienceRef = { kind: source.audience_kind, id: source.audience_id };
  if (
    !evaluateBuiltinScopedMemoryPolicyInDatabase({
      database: params.database,
      agentId: params.agentId,
      storeId: source.store_id,
      principalIds: [params.intent.publisherPrincipalId],
      deliveryAudiences: [sourceAudience],
      operation: "project",
      nowMs: params.nowMs,
    }).allowed
  ) {
    throw new Error("memory sharing authorization is unavailable");
  }
  const targetStore = readTargetStore({
    database: params.database,
    agentId: params.agentId,
    target: params.intent.target,
  });
  if (
    !targetStore?.path_key ||
    (params.intent.targetStoreId && targetStore.store_id !== params.intent.targetStoreId)
  ) {
    throw new Error("memory projection target is unavailable");
  }
  if (
    !evaluateBuiltinScopedMemoryPolicyInDatabase({
      database: params.database,
      agentId: params.agentId,
      storeId: targetStore.store_id,
      principalIds: [params.intent.publisherPrincipalId],
      deliveryAudiences: [params.intent.target],
      operation: "publish",
      nowMs: params.nowMs,
    }).allowed
  ) {
    throw new Error("memory sharing authorization is unavailable");
  }
  if (
    params.intent.reviewedByPrincipalId !== params.intent.publisherPrincipalId &&
    !evaluateBuiltinScopedMemoryPolicyInDatabase({
      database: params.database,
      agentId: params.agentId,
      storeId: targetStore.store_id,
      principalIds: [params.intent.reviewedByPrincipalId],
      deliveryAudiences: [params.intent.target],
      operation: "policy-admin",
      nowMs: params.nowMs,
    }).allowed
  ) {
    throw new Error("memory sharing authorization is unavailable");
  }
  if (params.intent.expiry.kind === "expires" && params.intent.expiry.expiresAt <= params.nowMs) {
    throw new Error("memory projection expiry is unavailable");
  }
  if (params.intent.replaceActiveProjectionId) {
    const replaced = executeSqliteQueryTakeFirstSync(
      params.database,
      db
        .selectFrom("memory_projections")
        .selectAll()
        .where("agent_id", "=", params.agentId)
        .where("projection_id", "=", params.intent.replaceActiveProjectionId),
    );
    if (
      !replaced ||
      replaced.state !== "active" ||
      replaced.target_store_id !== targetStore.store_id ||
      replaced.target_audience_kind !== params.intent.target.kind ||
      replaced.target_audience_id !== params.intent.target.id
    ) {
      throw new Error("memory projection is unavailable");
    }
  }
  if (params.pendingRevisionId) {
    const pending = executeSqliteQueryTakeFirstSync(
      params.database,
      db
        .selectFrom("memory_resource_revisions as revision")
        .innerJoin("memory_resources as resource", "resource.resource_id", "revision.resource_id")
        .select([
          "resource.store_id",
          "revision.lifecycle_state",
          "revision.policy_revision_id",
          "revision.policy_revocation_epoch",
        ])
        .where("revision.revision_id", "=", params.pendingRevisionId)
        .where("resource.agent_id", "=", params.agentId),
    );
    if (
      !pending ||
      pending.store_id !== targetStore.store_id ||
      pending.lifecycle_state !== "pending" ||
      pending.policy_revision_id !== targetStore.current_revision_id ||
      pending.policy_revocation_epoch !== targetStore.revocation_epoch
    ) {
      throw new Error("memory projection is unavailable");
    }
  }
  return targetStore;
}

function quarantineProjectionWrite(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  intentId: string;
  revisionId: string;
  nowMs: number;
  reasonCode: string;
}): void {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  runSqliteImmediateTransactionSync(params.database, () => {
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_resource_revisions")
        .set({ lifecycle_state: "quarantined", retired_at: params.nowMs })
        .where("revision_id", "=", params.revisionId)
        .where("lifecycle_state", "in", ["pending", "active"]),
    );
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_write_intents")
        .set({ state: "quarantined", updated_at: params.nowMs })
        .where("intent_id", "=", params.intentId)
        .where("state", "in", ["pending", "renamed", "active"]),
    );
    // An active projection is committed with its revision. If later artifact verification fails,
    // retire that status record too rather than advertise a copy readers cannot obtain.
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_projections")
        .set({ state: "revoked", revoked_at: params.nowMs })
        .where("copy_revision_id", "=", params.revisionId)
        .where("state", "=", "active"),
    );
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_audit_outbox")
        .set({ decision: "quarantined", reason_code: params.reasonCode, updated_at: params.nowMs })
        .where("intent_id", "=", params.intentId)
        .where("state", "=", "pending"),
    );
  });
}

function activateProjectionWrite(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  agentId: string;
  intentId: string;
  nowMs: number;
}): BuiltinMemoryProjection {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  let output: BuiltinMemoryProjection | undefined;
  runSqliteImmediateTransactionSync(params.database, () => {
    const pending = readProjectionWriteIntent({
      database: params.database,
      intentId: params.intentId,
    });
    if (
      !pending ||
      pending.write.agent_id !== params.agentId ||
      !pending.write.pending_revision_id ||
      !pending.write.resource_id ||
      (pending.write.state !== "pending" && pending.write.state !== "renamed")
    ) {
      throw new Error("memory projection is unavailable");
    }
    const intent: ProjectionWriteIntent = Object.freeze({
      projectionId: pending.projection.projection_id,
      target: Object.freeze({
        kind: pending.projection.target_audience_kind,
        id: pending.projection.target_audience_id,
      }),
      targetStoreId: pending.projection.target_store_id,
      sourceRevisionId: pending.projection.source_revision_id,
      publisherPrincipalId: pending.projection.publisher_principal_id,
      reviewedByPrincipalId: pending.projection.reviewed_by_principal_id,
      purpose: pending.projection.purpose,
      preview: pending.projection.preview,
      expiry:
        pending.projection.expiry_kind === "expires"
          ? Object.freeze({ kind: "expires", expiresAt: pending.projection.expires_at! })
          : Object.freeze({
              kind: "no-expiry",
              auditReason: pending.projection.expiry_audit_reason!,
            }),
      ...(pending.projection.replace_active_projection_id
        ? { replaceActiveProjectionId: pending.projection.replace_active_projection_id }
        : {}),
    });
    assertProjectionWriteCurrent({
      database: params.database,
      agentId: params.agentId,
      intent,
      pendingRevisionId: pending.write.pending_revision_id,
      nowMs: params.nowMs,
    });
    let replacedExposureSetIds: readonly string[] | undefined;
    if (intent.replaceActiveProjectionId) {
      const replaced = executeSqliteQueryTakeFirstSync(
        params.database,
        db
          .selectFrom("memory_projections")
          .selectAll()
          .where("agent_id", "=", params.agentId)
          .where("projection_id", "=", intent.replaceActiveProjectionId),
      );
      if (!replaced) {
        throw new Error("memory projection is unavailable");
      }
      replacedExposureSetIds = tombstoneProjectionCopy({
        database: params.database,
        projection: replaced,
        state: "revoked",
        nowMs: params.nowMs,
      });
    }
    requireOneScopedMemoryWriteRow(
      executeSqliteQuerySync(
        params.database,
        db
          .updateTable("memory_resource_revisions")
          .set({ lifecycle_state: "active", activated_at: params.nowMs })
          .where("revision_id", "=", pending.write.pending_revision_id)
          .where("lifecycle_state", "=", "pending"),
      ),
      "projection activation revision",
    );
    executeSqliteQuerySync(
      params.database,
      db.insertInto("memory_projections").values({
        projection_id: intent.projectionId,
        agent_id: params.agentId,
        target_store_id: intent.targetStoreId,
        target_audience_kind: intent.target.kind,
        target_audience_id: intent.target.id,
        source_revision_id: intent.sourceRevisionId,
        copy_revision_id: pending.write.pending_revision_id,
        publisher_principal_id: intent.publisherPrincipalId,
        reviewed_by_principal_id: intent.reviewedByPrincipalId,
        purpose: intent.purpose,
        preview: intent.preview,
        expiry_kind: intent.expiry.kind,
        expiry_audit_reason: intent.expiry.kind === "no-expiry" ? intent.expiry.auditReason : null,
        expires_at: intent.expiry.kind === "expires" ? intent.expiry.expiresAt : null,
        revocation_behavior: "tombstone-copy",
        state: "active",
        created_at: params.nowMs,
        revoked_at: null,
      }),
    );
    requireOneScopedMemoryWriteRow(
      executeSqliteQuerySync(
        params.database,
        db
          .updateTable("memory_write_intents")
          .set({ state: "active", activated_at: params.nowMs, updated_at: params.nowMs })
          .where("intent_id", "=", params.intentId)
          .where("state", "in", ["pending", "renamed"]),
      ),
      "projection activation intent",
    );
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_audit_outbox")
        .set({
          decision: "committed",
          reason_code: "projection-committed",
          updated_at: params.nowMs,
        })
        .where("intent_id", "=", params.intentId)
        .where("state", "=", "pending"),
    );
    output = Object.freeze({
      projectionId: intent.projectionId,
      copyRevisionId: pending.write.pending_revision_id,
      sourceRevisionId: intent.sourceRevisionId,
      target: intent.target,
      ...(intent.expiry.kind === "expires" ? { expiresAt: intent.expiry.expiresAt } : {}),
      ...(replacedExposureSetIds ? { replacedExposureSetIds } : {}),
    });
  });
  if (!output) {
    throw new Error("memory projection is unavailable");
  }
  return output;
}

function indexSharingWrite(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  intentId: string;
  revisionId: string;
  content: string;
  nowMs: number;
}): void {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  runSqliteImmediateTransactionSync(params.database, () => {
    const existing = executeSqliteQueryTakeFirstSync(
      params.database,
      db
        .selectFrom("memory_scoped_chunks")
        .select("chunk_id")
        .where("revision_id", "=", params.revisionId)
        .limit(1),
    );
    if (!existing) {
      const chunks = chunkScopedMemoryMarkdown(params.content);
      if (chunks.length > 0) {
        executeSqliteQuerySync(
          params.database,
          db.insertInto("memory_scoped_chunks").values(
            chunks.map((chunk) => ({
              chunk_id: randomUUID(),
              revision_id: params.revisionId,
              chunk_ordinal: chunk.ordinal,
              start_line: chunk.startLine,
              end_line: chunk.endLine,
              text: chunk.text,
              content_hash: hashScopedMemoryWriteContent(chunk.text),
              model: "builtin-markdown-v1",
              updated_at: params.nowMs,
            })),
          ),
        );
      }
    }
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_write_intents")
        .set({ indexed_at: params.nowMs, updated_at: params.nowMs })
        .where("intent_id", "=", params.intentId)
        .where("state", "=", "active"),
    );
  });
}

function markSharingWriteRenamed(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  intentId: string;
  nowMs: number;
}): void {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  runSqliteImmediateTransactionSync(params.database, () => {
    requireOneScopedMemoryWriteRow(
      executeSqliteQuerySync(
        params.database,
        db
          .updateTable("memory_write_intents")
          .set({ state: "renamed", updated_at: params.nowMs })
          .where("intent_id", "=", params.intentId)
          .where("state", "=", "pending"),
      ),
      "sharing artifact rename",
    );
  });
}

/**
 * Projection recovery owns the source, publisher, reviewer, and refresh fences that generic
 * write recovery cannot reconstruct. It runs before any plan is issued, so a pending copy never
 * becomes observable until it has either activated atomically or been quarantined.
 */
export function recoverBuiltinMemoryProjectionWrites(agentId: string): void {
  withScopedMemoryDatabase(agentId, (database, databasePath) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const candidates = executeSqliteQuerySync(
      database,
      db
        .selectFrom("memory_write_intents as intent")
        .innerJoin("memory_stores as store", "store.store_id", "intent.store_id")
        .innerJoin("memory_storage_roots as root", "root.storage_root_id", "store.storage_root_id")
        .select([
          "intent.intent_id",
          "intent.pending_revision_id",
          "intent.staged_locator",
          "intent.final_locator",
          "intent.content_hash",
          "intent.content_bytes",
          "intent.state",
          "intent.indexed_at",
          "root.path_key",
        ])
        .where("intent.agent_id", "=", agentId)
        .where("intent.mutation_kind", "=", "project")
        .where("intent.state", "in", ["pending", "renamed", "active"])
        .orderBy("intent.created_at")
        .orderBy("intent.intent_id"),
    ).rows;
    for (const candidate of candidates) {
      // Fully activated copies are recovered already. Keep the active row only for the narrow
      // crash window before indexing; expiry/revocation owns all later lifecycle transitions.
      if (candidate.state === "active" && candidate.indexed_at !== null) {
        continue;
      }
      const nowMs = Date.now();
      const pending = readProjectionWriteIntent({ database, intentId: candidate.intent_id });
      if (
        !pending ||
        pending.write.agent_id !== agentId ||
        !candidate.path_key ||
        !candidate.pending_revision_id ||
        !candidate.final_locator ||
        !candidate.content_hash ||
        candidate.content_bytes === null
      ) {
        quarantineProjectionWrite({
          database,
          intentId: candidate.intent_id,
          revisionId: candidate.pending_revision_id ?? "",
          nowMs,
          reasonCode: "projection-recovery-incomplete-intent",
        });
        continue;
      }
      const directory = path.join(
        resolveScopedMemoryArtifactBase(databasePath),
        candidate.path_key,
      );
      const finalPath = resolveBuiltinScopedMemoryArtifactPath({
        databasePath,
        pathKey: candidate.path_key,
        artifactLocator: candidate.final_locator,
      });
      const stagePath = candidate.staged_locator
        ? path.join(directory, candidate.staged_locator)
        : undefined;
      try {
        if (
          candidate.state === "pending" &&
          !fs.existsSync(finalPath) &&
          stagePath &&
          fs.existsSync(stagePath)
        ) {
          finalizeScopedMemoryWriteArtifact({ directory, stagePath, finalPath });
          markSharingWriteRenamed({ database, intentId: candidate.intent_id, nowMs });
          candidate.state = "renamed";
        }
        const content = readVerifiedScopedMemoryWriteArtifact({
          pathname: finalPath,
          contentHash: candidate.content_hash,
          contentBytes: candidate.content_bytes,
        });
        if (content === undefined) {
          throw new Error("memory projection recovery artifact is unavailable");
        }
        if (candidate.state === "pending" || candidate.state === "renamed") {
          activateProjectionWrite({ database, agentId, intentId: candidate.intent_id, nowMs });
          candidate.state = "active";
        }
        const activeProjection = executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("memory_projections")
            .select(["copy_revision_id", "state"])
            .where("agent_id", "=", agentId)
            .where("projection_id", "=", pending.projection.projection_id),
        );
        if (
          !activeProjection ||
          activeProjection.copy_revision_id !== candidate.pending_revision_id ||
          activeProjection.state !== "active"
        ) {
          throw new Error("memory projection recovery activation is unavailable");
        }
        if (candidate.indexed_at === null) {
          // Indexing is post-activation bookkeeping. Recovery can rebuild it, while throwing an
          // activation failure here would falsely tell the caller that a visible copy was absent.
          try {
            indexSharingWrite({
              database,
              intentId: candidate.intent_id,
              revisionId: candidate.pending_revision_id,
              content,
              nowMs,
            });
          } catch {
            // The next authorization pass retries index construction from the verified artifact.
          }
        }
      } catch {
        quarantineProjectionWrite({
          database,
          intentId: candidate.intent_id,
          revisionId: candidate.pending_revision_id,
          nowMs,
          reasonCode: "projection-recovery-validation-failed",
        });
        quarantineScopedMemoryWriteArtifact({ directory, pathname: finalPath });
        if (stagePath) {
          quarantineScopedMemoryWriteArtifact({ directory, pathname: stagePath });
        }
      }
    }
  });
}

/** A reviewed declassification copy with one named non-private audience and immutable source lineage. */
export function createBuiltinMemoryProjection(params: {
  agentId: string;
  sourceRevisionId: string;
  target: ProjectionAudience;
  publisherPrincipalId: string;
  reviewedByPrincipalId: string;
  purpose: string;
  preview: string;
  content: string;
  expiry:
    | Readonly<{ kind: "expires"; expiresAt: number }>
    | Readonly<{ kind: "no-expiry"; auditReason: string }>;
  /** Refresh-only: atomically tombstone this still-active copy while committing the replacement. */
  replaceActiveProjectionId?: string;
  nowMs?: number;
}): BuiltinMemoryProjection {
  if (!params.content.trim()) {
    throw new Error("memory projection content is unavailable");
  }
  const target = targetAudience(params.target);
  const sourceRevisionId = normalize(params.sourceRevisionId, "source revision id");
  const publisherPrincipalId = normalize(params.publisherPrincipalId, "publisher principal id");
  const reviewedByPrincipalId = normalize(params.reviewedByPrincipalId, "reviewer principal id");
  const replaceActiveProjectionId = params.replaceActiveProjectionId
    ? normalize(params.replaceActiveProjectionId, "projection id")
    : undefined;
  const purpose = normalize(params.purpose, "projection purpose");
  const preview = normalize(params.preview, "projection preview");
  const nowMs = params.nowMs ?? Date.now();
  const expiry =
    params.expiry.kind === "expires"
      ? (() => {
          if (!Number.isSafeInteger(params.expiry.expiresAt) || params.expiry.expiresAt <= nowMs) {
            throw new Error("memory projection expiry is unavailable");
          }
          return Object.freeze({ kind: "expires" as const, expiresAt: params.expiry.expiresAt });
        })()
      : Object.freeze({
          kind: "no-expiry" as const,
          auditReason: normalize(params.expiry.auditReason, "no-expiry audit reason"),
        });
  const projectionId = `mproj1_${randomUUID()}`;
  const intent: ProjectionWriteIntent = Object.freeze({
    projectionId,
    target,
    targetStoreId: "",
    sourceRevisionId,
    publisherPrincipalId,
    reviewedByPrincipalId,
    purpose,
    preview,
    expiry,
    ...(replaceActiveProjectionId ? { replaceActiveProjectionId } : {}),
  });
  return withScopedMemoryDatabase(params.agentId, (database, databasePath) => {
    const plannedTarget = assertProjectionWriteCurrent({
      database,
      agentId: params.agentId,
      intent,
      nowMs,
    });
    const boundIntent = Object.freeze({ ...intent, targetStoreId: plannedTarget.store_id });
    const sourceEvidence = readSourceRequirements({ database, revisionId: sourceRevisionId });
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const revisionId = randomUUID();
    const resourceId = randomUUID();
    const intentId = randomUUID();
    const finalLocator = `r1_${revisionId}.md`;
    const stageLocator = `mpst1_${intentId}.tmp`;
    const directory = path.join(
      resolveScopedMemoryArtifactBase(databasePath),
      plannedTarget.path_key!,
    );
    const stagePath = stageScopedMemoryWriteArtifact({
      directory,
      stageLocator,
      content: params.content,
    });
    const finalPath = resolveBuiltinScopedMemoryArtifactPath({
      databasePath,
      pathKey: plannedTarget.path_key!,
      artifactLocator: finalLocator,
    });
    const contentHash = hashScopedMemoryWriteContent(params.content);
    const contentBytes = Buffer.byteLength(params.content);
    let pendingCommitted = false;
    let activated = false;
    try {
      runSqliteImmediateTransactionSync(database, () => {
        const targetStore = assertProjectionWriteCurrent({
          database,
          agentId: params.agentId,
          intent: boundIntent,
          nowMs,
        });
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_resources").values({
            resource_id: resourceId,
            agent_id: params.agentId,
            store_id: targetStore.store_id,
            logical_locator: `projections/${projectionId}.md`,
            source: "memory",
            created_at: nowMs,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_resource_revisions").values({
            revision_id: revisionId,
            resource_id: resourceId,
            revision_number: 1,
            artifact_locator: finalLocator,
            content_hash: contentHash,
            content_bytes: contentBytes,
            policy_revision_id: targetStore.current_revision_id,
            policy_revocation_epoch: targetStore.revocation_epoch,
            source_policy_set_id: createScopedMemorySourcePolicySetId(
              targetStore.current_revision_id,
            ),
            lifecycle_state: "pending",
            actor_kind: "human",
            actor_id: publisherPrincipalId,
            expires_at: expiry.kind === "expires" ? expiry.expiresAt : null,
            created_at: nowMs,
            activated_at: null,
            retired_at: null,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_revision_policy_requirements").values({
            revision_id: revisionId,
            policy_id: targetStore.policy_id,
            expected_revision_id: targetStore.current_revision_id,
            expected_revocation_epoch: targetStore.revocation_epoch,
            requirement_kind: "output-policy",
            created_at: nowMs,
          }),
        );
        for (const requirement of sourceEvidence.policyRequirements) {
          executeSqliteQuerySync(
            database,
            db
              .insertInto("memory_revision_policy_requirements")
              .values({
                revision_id: revisionId,
                policy_id: requirement.policyId,
                expected_revision_id: requirement.expectedRevisionId,
                expected_revocation_epoch: requirement.expectedRevocationEpoch,
                requirement_kind: "source-policy",
                created_at: nowMs,
              })
              .onConflict((conflict) => conflict.columns(["revision_id", "policy_id"]).doNothing()),
          );
        }
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_lineage_edges").values({
            child_revision_id: revisionId,
            parent_kind: "resource-revision",
            parent_id: sourceEvidence.revisionId,
            relation_kind: "derived-from",
            created_at: nowMs,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_write_intents").values({
            intent_id: intentId,
            idempotency_key: `projection:${projectionId}`,
            mutation_id: projectionId,
            agent_id: params.agentId,
            request_id: projectionId,
            run_id: `sharing-control:${publisherPrincipalId}`,
            context_fingerprint: projectionId,
            plan_id: "sharing-control",
            mutation_kind: "project",
            store_id: targetStore.store_id,
            resource_id: resourceId,
            pending_revision_id: revisionId,
            staged_locator: stageLocator,
            final_locator: finalLocator,
            content_hash: contentHash,
            content_bytes: contentBytes,
            state: "pending",
            created_at: nowMs,
            updated_at: nowMs,
            activated_at: null,
            indexed_at: null,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_projection_write_intents").values({
            intent_id: intentId,
            agent_id: params.agentId,
            projection_id: projectionId,
            target_store_id: targetStore.store_id,
            target_audience_kind: target.kind,
            target_audience_id: target.id,
            source_revision_id: sourceRevisionId,
            publisher_principal_id: publisherPrincipalId,
            reviewed_by_principal_id: reviewedByPrincipalId,
            purpose,
            preview,
            expiry_kind: expiry.kind,
            expiry_audit_reason: expiry.kind === "no-expiry" ? expiry.auditReason : null,
            expires_at: expiry.kind === "expires" ? expiry.expiresAt : null,
            replace_active_projection_id: replaceActiveProjectionId ?? null,
            created_at: nowMs,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_audit_outbox").values({
            event_id: randomUUID(),
            intent_id: intentId,
            agent_id: params.agentId,
            request_id: projectionId,
            run_id: `sharing-control:${publisherPrincipalId}`,
            actor_ref: `sha256:${hash(`human\0${publisherPrincipalId}`)}`,
            subject_ref: `sha256:${hash(JSON.stringify(target))}`,
            operation: "project",
            resource_revision_id: revisionId,
            content_hash: contentHash,
            decision: "pending",
            reason_code: "projection-pending",
            state: "pending",
            attempts: 0,
            created_at: nowMs,
            updated_at: nowMs,
            delivered_at: null,
          }),
        );
      });
      pendingCommitted = true;
      interruptProjectionWriteForTest("after-pending-commit");
      finalizeScopedMemoryWriteArtifact({ directory, stagePath, finalPath });
      markSharingWriteRenamed({ database, intentId, nowMs });
      interruptProjectionWriteForTest("after-artifact-rename");
      const verified = readVerifiedScopedMemoryWriteArtifact({
        pathname: finalPath,
        contentHash,
        contentBytes,
      });
      if (verified === undefined) {
        throw new Error("memory projection finalized artifact is unavailable");
      }
      const projection = activateProjectionWrite({
        database,
        agentId: params.agentId,
        intentId,
        nowMs,
      });
      activated = true;
      try {
        indexSharingWrite({ database, intentId, revisionId, content: verified, nowMs });
      } catch {
        // The active copy is durable and readable. Startup recovery retries only this derived index.
      }
      return projection;
    } catch (error) {
      if (!pendingCommitted) {
        try {
          fs.unlinkSync(stagePath);
        } catch {}
      } else if (!(error instanceof ProjectionWriteInterruptedForTest) && !activated) {
        quarantineProjectionWrite({
          database,
          intentId,
          revisionId,
          nowMs,
          reasonCode: "projection-activation-failed",
        });
        quarantineScopedMemoryWriteArtifact({ directory, pathname: stagePath });
        quarantineScopedMemoryWriteArtifact({ directory, pathname: finalPath });
      }
      throw error;
    }
  });
}

/** Validate a proposed reviewed copy without reading its source content or mutating sharing state. */
export function previewBuiltinMemoryProjection(params: {
  agentId: string;
  sourceRevisionId: string;
  target: ProjectionAudience;
  publisherPrincipalId: string;
  purpose: string;
  preview: string;
  expiry:
    | Readonly<{ kind: "expires"; expiresAt: number }>
    | Readonly<{ kind: "no-expiry"; auditReason: string }>;
  nowMs?: number;
}): BuiltinMemoryProjectionPreview {
  const target = targetAudience(params.target);
  const sourceRevisionId = normalize(params.sourceRevisionId, "source revision id");
  const publisherPrincipalId = normalize(params.publisherPrincipalId, "publisher principal id");
  const purpose = normalize(params.purpose, "projection purpose");
  const preview = normalize(params.preview, "projection preview");
  const nowMs = params.nowMs ?? Date.now();
  if (
    (params.expiry.kind === "expires" &&
      (!Number.isSafeInteger(params.expiry.expiresAt) || params.expiry.expiresAt <= nowMs)) ||
    (params.expiry.kind === "no-expiry" && !params.expiry.auditReason.trim())
  ) {
    throw new Error("memory projection expiry is unavailable");
  }
  return withScopedMemoryDatabase(params.agentId, (database) => {
    const source = readSource({ database, agentId: params.agentId, revisionId: sourceRevisionId });
    assertStoreOperation({
      agentId: params.agentId,
      storeId: source.store_id,
      principalId: publisherPrincipalId,
      audience: { kind: source.audience_kind, id: source.audience_id },
      operation: "project",
    });
    const targetStore = readTargetStore({ database, agentId: params.agentId, target });
    if (!targetStore) {
      throw new Error("memory projection target is unavailable");
    }
    assertStoreOperation({
      agentId: params.agentId,
      storeId: targetStore.store_id,
      principalId: publisherPrincipalId,
      audience: target,
      operation: "publish",
    });
    return Object.freeze({
      sourceRevisionId,
      target,
      purpose,
      preview,
      expiry: params.expiry.kind,
    });
  });
}

/** Return only redacted prior-exposure ids after checking publisher or target policy administration. */
export function inspectBuiltinMemoryProjectionImpact(params: {
  agentId: string;
  projectionId: string;
  operatorPrincipalId: string;
}): BuiltinMemoryProjectionImpact {
  const projectionId = normalize(params.projectionId, "projection id");
  const operatorPrincipalId = normalize(params.operatorPrincipalId, "operator principal id");
  return withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const projection = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_projections")
        .select([
          "projection_id",
          "copy_revision_id",
          "publisher_principal_id",
          "target_store_id",
          "target_audience_kind",
          "target_audience_id",
        ])
        .where("agent_id", "=", params.agentId)
        .where("projection_id", "=", projectionId),
    );
    if (!projection) {
      throw new Error("memory projection is unavailable");
    }
    const target = targetAudience({
      kind: projection.target_audience_kind,
      id: projection.target_audience_id,
    });
    if (projection.publisher_principal_id !== operatorPrincipalId) {
      assertStoreOperation({
        agentId: params.agentId,
        storeId: projection.target_store_id,
        principalId: operatorPrincipalId,
        audience: target,
        operation: "policy-admin",
      });
    }
    const exposureSetIds = executeSqliteQuerySync(
      database,
      db
        .selectFrom("memory_run_exposure_resources")
        .select("exposure_set_id")
        .where("resource_revision_id", "=", projection.copy_revision_id)
        .orderBy("exposure_set_id"),
    ).rows.map((row) => row.exposure_set_id);
    return Object.freeze({ projectionId, exposureSetIds: Object.freeze(exposureSetIds) });
  });
}

/** Tombstones one copy and reads its recorded impact under the caller's write fence. */
function tombstoneProjectionCopy(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  projection: {
    projection_id: string;
    copy_revision_id: string;
    state: string;
  };
  state: "revoked" | "expired";
  nowMs: number;
}): readonly string[] {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  if (params.projection.state === "active") {
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_resource_revisions")
        .set({ lifecycle_state: "tombstoned", retired_at: params.nowMs })
        .where("revision_id", "=", params.projection.copy_revision_id)
        .where("lifecycle_state", "=", "active"),
    );
    executeSqliteQuerySync(
      params.database,
      db
        .deleteFrom("memory_scoped_chunks")
        .where("revision_id", "=", params.projection.copy_revision_id),
    );
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_projections")
        .set({ state: params.state, revoked_at: params.nowMs })
        .where("projection_id", "=", params.projection.projection_id)
        .where("state", "=", "active"),
    );
  }
  // The tombstone and impact read share one write fence. A pre-output exposure either commits
  // before this point and is reported, or sees the tombstone and cannot expose the copy.
  return Object.freeze(
    executeSqliteQuerySync(
      params.database,
      db
        .selectFrom("memory_run_exposure_resources")
        .select("exposure_set_id")
        .where("resource_revision_id", "=", params.projection.copy_revision_id)
        .orderBy("exposure_set_id"),
    ).rows.map((row) => row.exposure_set_id),
  );
}

/** Tombstoning the reviewed copy removes future reads and returns every prior recorded exposure. */
export function revokeBuiltinMemoryProjection(params: {
  agentId: string;
  projectionId: string;
  operatorPrincipalId: string;
  nowMs?: number;
}): readonly string[] {
  const projectionId = normalize(params.projectionId, "projection id");
  const operatorPrincipalId = normalize(params.operatorPrincipalId, "operator principal id");
  const nowMs = params.nowMs ?? Date.now();
  return withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const projection = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_projections")
        .selectAll()
        .where("projection_id", "=", projectionId)
        .where("agent_id", "=", params.agentId),
    );
    if (!projection) {
      throw new Error("memory projection is unavailable");
    }
    const audience: ProjectionAudience = {
      kind: projection.target_audience_kind,
      id: projection.target_audience_id,
    };
    if (projection.publisher_principal_id !== operatorPrincipalId) {
      assertStoreOperation({
        agentId: params.agentId,
        storeId: projection.target_store_id,
        principalId: operatorPrincipalId,
        audience,
        operation: "policy-admin",
      });
    }
    let exposures: readonly string[] = [];
    runSqliteImmediateTransactionSync(database, () => {
      exposures = tombstoneProjectionCopy({
        database,
        projection,
        state: "revoked",
        nowMs,
      });
    });
    return exposures;
  });
}

/** Expiry is a durable transition, so later inspection and impact queries do not infer it from a clock. */
export function expireBuiltinMemoryProjections(params: {
  agentId: string;
  nowMs?: number;
}): readonly BuiltinMemoryProjectionImpact[] {
  const nowMs = params.nowMs ?? Date.now();
  return withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    let impacts: readonly BuiltinMemoryProjectionImpact[] = [];
    runSqliteImmediateTransactionSync(database, () => {
      const expiring = executeSqliteQuerySync(
        database,
        db
          .selectFrom("memory_projections")
          .select(["projection_id", "copy_revision_id", "state"])
          .where("agent_id", "=", params.agentId)
          .where("state", "=", "active")
          .where("expiry_kind", "=", "expires")
          .where("expires_at", "<=", nowMs)
          .orderBy("projection_id"),
      ).rows;
      impacts = Object.freeze(
        expiring.map((projection) =>
          Object.freeze({
            projectionId: projection.projection_id,
            exposureSetIds: tombstoneProjectionCopy({
              database,
              projection,
              state: "expired",
              nowMs,
            }),
          }),
        ),
      );
    });
    return impacts;
  });
}

/** Refresh commits the new reviewed copy and old-copy tombstone under one revision transaction. */
export function refreshBuiltinMemoryProjection(params: {
  agentId: string;
  projectionId: string;
  sourceRevisionId: string;
  publisherPrincipalId: string;
  reviewedByPrincipalId: string;
  purpose: string;
  preview: string;
  content: string;
  expiry:
    | Readonly<{ kind: "expires"; expiresAt: number }>
    | Readonly<{ kind: "no-expiry"; auditReason: string }>;
  nowMs?: number;
}): Readonly<{ projection: BuiltinMemoryProjection; replacedExposureSetIds: readonly string[] }> {
  const projectionId = normalize(params.projectionId, "projection id");
  const publisherPrincipalId = normalize(params.publisherPrincipalId, "publisher principal id");
  const existing = withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const projection = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_projections")
        .selectAll()
        .where("agent_id", "=", params.agentId)
        .where("projection_id", "=", projectionId),
    );
    if (!projection || projection.state !== "active") {
      throw new Error("memory projection is unavailable");
    }
    const target = targetAudience({
      kind: projection.target_audience_kind,
      id: projection.target_audience_id,
    });
    if (projection.publisher_principal_id !== publisherPrincipalId) {
      assertStoreOperation({
        agentId: params.agentId,
        storeId: projection.target_store_id,
        principalId: publisherPrincipalId,
        audience: target,
        operation: "policy-admin",
      });
    }
    return Object.freeze({ target, projection });
  });
  const projection = createBuiltinMemoryProjection({
    agentId: params.agentId,
    sourceRevisionId: params.sourceRevisionId,
    target: existing.target,
    publisherPrincipalId,
    reviewedByPrincipalId: params.reviewedByPrincipalId,
    purpose: params.purpose,
    preview: params.preview,
    content: params.content,
    expiry: params.expiry,
    replaceActiveProjectionId: projectionId,
    nowMs: params.nowMs,
  });
  return Object.freeze({
    projection,
    replacedExposureSetIds: projection.replacedExposureSetIds ?? [],
  });
}

/** Postbox stays off until an authenticated owner/admin explicitly enables review-required deposits. */
export function setBuiltinMemoryPostboxMode(params: {
  agentId: string;
  targetStoreId: string;
  operatorPrincipalId: string;
  mode: "off" | "review-required";
  nowMs?: number;
}): void {
  const nowMs = params.nowMs ?? Date.now();
  withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const store = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_stores")
        .select(["audience_kind", "audience_id"])
        .where("store_id", "=", params.targetStoreId)
        .where("agent_id", "=", params.agentId),
    );
    if (!store || store.audience_kind !== "user") {
      throw new Error("memory postbox target is unavailable");
    }
    assertStoreOperation({
      agentId: params.agentId,
      storeId: params.targetStoreId,
      principalId: normalize(params.operatorPrincipalId, "operator principal id"),
      audience: { kind: store.audience_kind, id: store.audience_id },
      operation: "policy-admin",
    });
    executeSqliteQuerySync(
      database,
      db
        .insertInto("memory_postbox_settings")
        .values({
          agent_id: params.agentId,
          target_store_id: params.targetStoreId,
          mode: params.mode,
          updated_by_principal_id: normalize(params.operatorPrincipalId, "operator principal id"),
          updated_at: nowMs,
        })
        .onConflict((conflict) =>
          conflict.columns(["agent_id", "target_store_id"]).doUpdateSet({
            mode: params.mode,
            updated_by_principal_id: normalize(params.operatorPrincipalId, "operator principal id"),
            updated_at: nowMs,
          }),
        ),
    );
  });
}

/** The target quarantine is derived from the authenticated owner's principal, never RPC input. */
export function setBuiltinMemoryPostboxModeForPrincipal(params: {
  agentId: string;
  principalId: string;
  mode: "off" | "review-required";
  nowMs?: number;
}): void {
  const targetStoreId = withScopedMemoryDatabase(
    params.agentId,
    (database) =>
      readPostboxTargetStore({
        database,
        agentId: params.agentId,
        targetPrincipalId: normalize(params.principalId, "operator principal id"),
      })?.store_id,
  );
  if (!targetStoreId) {
    throw new Error("memory postbox target is unavailable");
  }
  setBuiltinMemoryPostboxMode({
    agentId: params.agentId,
    targetStoreId,
    operatorPrincipalId: params.principalId,
    mode: params.mode,
    nowMs: params.nowMs,
  });
}

/** Redacted owner inspection: no source revision, private copy, or postbox body leaves this path. */
export function inspectBuiltinMemorySharingStatus(params: {
  agentId: string;
  operatorPrincipalId: string;
}): BuiltinMemorySharingStatus {
  const operatorPrincipalId = normalize(params.operatorPrincipalId, "operator principal id");
  return withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const target = readPostboxTargetStore({
      database,
      agentId: params.agentId,
      targetPrincipalId: operatorPrincipalId,
    });
    if (!target) {
      throw new Error("memory sharing is unavailable");
    }
    assertStoreOperation({
      agentId: params.agentId,
      storeId: target.store_id,
      principalId: operatorPrincipalId,
      audience: { kind: "user", id: operatorPrincipalId },
      operation: "policy-admin",
    });
    const settings = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_postbox_settings")
        .select("mode")
        .where("agent_id", "=", params.agentId)
        .where("target_store_id", "=", target.store_id),
    );
    const projections = executeSqliteQuerySync(
      database,
      db
        .selectFrom("memory_projections")
        .select([
          "projection_id",
          "target_audience_kind",
          "target_audience_id",
          "purpose",
          "preview",
          "state",
          "expires_at",
        ])
        .where("agent_id", "=", params.agentId)
        .where("publisher_principal_id", "=", operatorPrincipalId)
        .orderBy("created_at", "desc"),
    ).rows.map((projection) =>
      Object.freeze({
        projectionId: projection.projection_id,
        target: Object.freeze({
          kind: targetAudience({
            kind: projection.target_audience_kind,
            id: projection.target_audience_id,
          }).kind,
          id: projection.target_audience_id,
        }),
        purpose: projection.purpose,
        preview: projection.preview,
        state: projection.state,
        expiresAt: projection.expires_at,
      }),
    );
    const postboxItems = executeSqliteQuerySync(
      database,
      db
        .selectFrom("memory_postbox_items")
        .select(["item_id", "state", "source_channel_ref", "created_at"])
        .where("agent_id", "=", params.agentId)
        .where("target_store_id", "=", target.store_id)
        .orderBy("created_at", "desc"),
    ).rows.map((item) =>
      Object.freeze({
        itemId: item.item_id,
        state: item.state,
        sourceChannelRef: item.source_channel_ref,
        createdAt: item.created_at,
      }),
    );
    return Object.freeze({
      postboxMode: settings?.mode ?? "off",
      projections: Object.freeze(projections),
      postboxItems: Object.freeze(postboxItems),
    });
  });
}

/** Only core/channel ingress may mint this opaque handle from current verified sender evidence. */
function issueBuiltinMemoryPostboxSourceHandle(params: {
  agentId: string;
  sourceSessionId: string;
  sourceChannelRef: string;
  sourceMessageRef: string;
  senderEvidenceRef: string;
  targetStoreId: string;
  nowMs?: number;
}): string {
  const nowMs = params.nowMs ?? Date.now();
  const sourceHandleId = `mpostsrc1_${randomUUID()}`;
  return withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const store = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_stores")
        .select("audience_kind")
        .where("store_id", "=", params.targetStoreId)
        .where("agent_id", "=", params.agentId)
        .where("lifecycle_state", "=", "active"),
    );
    if (store?.audience_kind !== "user") {
      throw new Error("memory postbox target is unavailable");
    }
    executeSqliteQuerySync(
      database,
      db.insertInto("memory_postbox_source_handles").values({
        source_handle_id: sourceHandleId,
        agent_id: params.agentId,
        source_session_id: normalize(params.sourceSessionId, "source session id"),
        source_channel_ref: normalize(params.sourceChannelRef, "source channel ref"),
        source_message_ref: normalize(params.sourceMessageRef, "source message ref"),
        sender_evidence_ref: normalize(params.senderEvidenceRef, "sender evidence ref"),
        target_store_id: params.targetStoreId,
        expires_at: nowMs + POSTBOX_HANDLE_TTL_MS,
        used_at: null,
        created_at: nowMs,
      }),
    );
    return sourceHandleId;
  });
}

/**
 * Redeems the core-issued turn token before minting the persisted one-use handle. The selected
 * memory plugin resolves the core-selected private subject to its quarantine store; tool input cannot.
 */
export function depositBuiltinMemoryPostboxFromTurnCapability(params: {
  agentId: string;
  runId: string;
  sessionKey: string;
  sessionId: string;
  turnCapability: string;
  content: string;
  nowMs?: number;
}): BuiltinMemoryPostboxDeposit {
  const source = resolveMemoryPostboxTurnCapability({
    token: params.turnCapability,
    agentId: params.agentId,
    runId: params.runId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    nowMs: params.nowMs,
  });
  if (!source) {
    return Object.freeze({ accepted: false });
  }
  try {
    const targetStoreId = withScopedMemoryDatabase(params.agentId, (database) => {
      const target = readPostboxTargetStore({
        database,
        agentId: params.agentId,
        targetPrincipalId: source.targetPrincipalId,
      });
      return target?.store_id;
    });
    if (!targetStoreId) {
      return Object.freeze({ accepted: false });
    }
    const sourceHandleId = issueBuiltinMemoryPostboxSourceHandle({
      agentId: params.agentId,
      sourceSessionId: params.sessionId,
      // These facts are carried by the private ingress marker; never reconstruct route or sender
      // identity from model-visible or reply-context strings.
      sourceChannelRef: source.sourceChannelRef,
      sourceMessageRef: source.sourceTurnId,
      senderEvidenceRef: source.senderEvidenceRef,
      targetStoreId,
      nowMs: params.nowMs,
    });
    return depositBuiltinMemoryPostbox({
      agentId: params.agentId,
      sourceHandleId,
      content: params.content,
      nowMs: params.nowMs,
    });
  } catch {
    return Object.freeze({ accepted: false });
  }
}

/** The source can only receive accepted/generic-refusal; there is no read, list, or exact-get continuation. */
export function depositBuiltinMemoryPostbox(params: {
  agentId: string;
  sourceHandleId: string;
  content: string;
  nowMs?: number;
}): BuiltinMemoryPostboxDeposit {
  const nowMs = params.nowMs ?? Date.now();
  if (!params.content.trim() || Buffer.byteLength(params.content) > POSTBOX_MAX_CONTENT_BYTES) {
    return Object.freeze({ accepted: false });
  }
  return withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    let accepted = false;
    runSqliteImmediateTransactionSync(database, () => {
      const handle = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_postbox_source_handles")
          .selectAll()
          .where("source_handle_id", "=", params.sourceHandleId)
          .where("agent_id", "=", params.agentId),
      );
      const settings = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_postbox_settings")
          .select("mode")
          .where("agent_id", "=", params.agentId)
          .where("target_store_id", "=", handle?.target_store_id ?? ""),
      );
      if (
        !handle ||
        handle.used_at !== null ||
        handle.expires_at <= nowMs ||
        settings?.mode !== "review-required"
      ) {
        return;
      }
      const rate = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_postbox_rate_limits")
          .selectAll()
          .where("agent_id", "=", params.agentId)
          .where("source_channel_ref", "=", handle.source_channel_ref)
          .where("target_store_id", "=", handle.target_store_id),
      );
      const withinWindow = rate && rate.window_started_at + POSTBOX_RATE_WINDOW_MS > nowMs;
      const count = withinWindow ? rate.deposit_count : 0;
      if (count >= POSTBOX_MAX_DEPOSITS_PER_WINDOW) {
        return;
      }
      const used = executeSqliteQuerySync(
        database,
        db
          .updateTable("memory_postbox_source_handles")
          .set({ used_at: nowMs })
          .where("source_handle_id", "=", handle.source_handle_id)
          .where("used_at", "is", null)
          .where("expires_at", ">", nowMs),
      );
      if (used.numAffectedRows !== 1n) {
        throw new Error("memory postbox source is unavailable");
      }
      executeSqliteQuerySync(
        database,
        db
          .insertInto("memory_postbox_rate_limits")
          .values({
            agent_id: params.agentId,
            source_channel_ref: handle.source_channel_ref,
            target_store_id: handle.target_store_id,
            window_started_at: withinWindow ? rate.window_started_at : nowMs,
            deposit_count: count + 1,
            updated_at: nowMs,
          })
          .onConflict((conflict) =>
            conflict.columns(["agent_id", "source_channel_ref", "target_store_id"]).doUpdateSet({
              window_started_at: withinWindow ? rate.window_started_at : nowMs,
              deposit_count: count + 1,
              updated_at: nowMs,
            }),
          ),
      );
      executeSqliteQuerySync(
        database,
        db.insertInto("memory_postbox_items").values({
          item_id: `mpost1_${randomUUID()}`,
          agent_id: params.agentId,
          source_handle_id: handle.source_handle_id,
          target_store_id: handle.target_store_id,
          source_channel_ref: handle.source_channel_ref,
          sender_evidence_ref: handle.sender_evidence_ref,
          content: params.content,
          content_hash: hash(params.content),
          state: "postbox",
          reviewed_by_principal_id: null,
          reviewed_at: null,
          created_at: nowMs,
          purged_at: null,
        }),
      );
      accepted = true;
    });
    return Object.freeze({ accepted });
  });
}

type PostboxReviewWriteIntent = Readonly<{
  itemId: string;
  targetStoreId: string;
  reviewedByPrincipalId: string;
  reviewedContentHash: string;
}>;

type PostboxReviewWriteInterruptPoint = "after-pending-commit" | "after-artifact-rename";

class PostboxReviewWriteInterruptedForTest extends Error {}

let postboxReviewWriteInterruptForTest: PostboxReviewWriteInterruptPoint | undefined;

/** Test-only interruption leaves the pending approval for startup recovery. */
export function setBuiltinMemoryPostboxReviewWriteInterruptForTest(
  point: PostboxReviewWriteInterruptPoint | undefined,
): void {
  postboxReviewWriteInterruptForTest = point;
}

function interruptPostboxReviewWriteForTest(point: PostboxReviewWriteInterruptPoint): void {
  if (postboxReviewWriteInterruptForTest === point) {
    throw new PostboxReviewWriteInterruptedForTest(point);
  }
}

function readPostboxReviewWriteIntent(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  intentId: string;
}) {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  const write = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_write_intents")
      .selectAll()
      .where("intent_id", "=", params.intentId)
      .where("mutation_kind", "=", "admin-reclassify"),
  );
  const review = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_postbox_review_write_intents")
      .selectAll()
      .where("intent_id", "=", params.intentId),
  );
  return write && review ? Object.freeze({ write, review }) : undefined;
}

/** Revalidate the owner authority and current target policy before postbox promotion. */
function assertPostboxReviewWriteCurrent(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  agentId: string;
  intent: PostboxReviewWriteIntent;
  pendingRevisionId?: string;
  nowMs: number;
}) {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  const item = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_postbox_items as item")
      .innerJoin("memory_stores as store", "store.store_id", "item.target_store_id")
      .innerJoin("memory_storage_roots as root", "root.storage_root_id", "store.storage_root_id")
      .innerJoin("memory_policies as policy", "policy.policy_id", "store.policy_id")
      .innerJoin(
        "memory_policy_revisions as policy_revision",
        "policy_revision.revision_id",
        "policy.current_revision_id",
      )
      .select([
        "item.item_id",
        "item.content",
        "item.state",
        "item.target_store_id",
        "store.audience_kind",
        "store.audience_id",
        "store.policy_id",
        "store.lifecycle_state as store_state",
        "root.backend_kind",
        "root.path_key",
        "root.lifecycle_state as root_state",
        "policy.current_revision_id",
        "policy.revocation_epoch",
        "policy.lifecycle_state as policy_lifecycle_state",
        "policy_revision.lifecycle_state as policy_revision_state",
      ])
      .where("item.item_id", "=", params.intent.itemId)
      .where("item.agent_id", "=", params.agentId),
  );
  if (
    !item ||
    item.state !== "postbox" ||
    (params.intent.targetStoreId !== "" && item.target_store_id !== params.intent.targetStoreId) ||
    item.audience_kind !== "user" ||
    item.store_state !== "active" ||
    item.backend_kind !== "builtin" ||
    item.root_state !== "active" ||
    !item.path_key ||
    item.policy_lifecycle_state !== "active" ||
    item.policy_revision_state !== "active"
  ) {
    throw new Error("memory postbox item is unavailable");
  }
  const pathKey = item.path_key;
  if (
    !evaluateBuiltinScopedMemoryPolicyInDatabase({
      database: params.database,
      agentId: params.agentId,
      storeId: item.target_store_id,
      principalIds: [params.intent.reviewedByPrincipalId],
      deliveryAudiences: [{ kind: "user", id: item.audience_id }],
      operation: "policy-admin",
      nowMs: params.nowMs,
    }).allowed
  ) {
    throw new Error("memory sharing authorization is unavailable");
  }
  if (params.pendingRevisionId) {
    const pending = executeSqliteQueryTakeFirstSync(
      params.database,
      db
        .selectFrom("memory_resource_revisions as revision")
        .innerJoin("memory_resources as resource", "resource.resource_id", "revision.resource_id")
        .select([
          "resource.store_id",
          "revision.lifecycle_state",
          "revision.policy_revision_id",
          "revision.policy_revocation_epoch",
        ])
        .where("revision.revision_id", "=", params.pendingRevisionId)
        .where("resource.agent_id", "=", params.agentId),
    );
    if (
      !pending ||
      pending.store_id !== item.target_store_id ||
      pending.lifecycle_state !== "pending" ||
      pending.policy_revision_id !== item.current_revision_id ||
      pending.policy_revocation_epoch !== item.revocation_epoch
    ) {
      throw new Error("memory postbox item is unavailable");
    }
  }
  return Object.freeze({ ...item, path_key: pathKey });
}

/** A failed review never strands the quarantined deposit in an invisible reviewed state. */
function quarantinePostboxReviewWrite(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  intentId: string;
  revisionId: string;
  itemId: string;
  nowMs: number;
  reasonCode: string;
}): void {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  runSqliteImmediateTransactionSync(params.database, () => {
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_resource_revisions")
        .set({ lifecycle_state: "quarantined", retired_at: params.nowMs })
        .where("revision_id", "=", params.revisionId)
        .where("lifecycle_state", "in", ["pending", "active"]),
    );
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_write_intents")
        .set({ state: "quarantined", updated_at: params.nowMs })
        .where("intent_id", "=", params.intentId)
        .where("state", "in", ["pending", "renamed", "active"]),
    );
    executeSqliteQuerySync(
      params.database,
      db
        .deleteFrom("memory_postbox_reviewed_copies")
        .where("item_id", "=", params.itemId)
        .where("revision_id", "=", params.revisionId),
    );
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_postbox_items")
        .set({ state: "postbox", reviewed_by_principal_id: null, reviewed_at: null })
        .where("item_id", "=", params.itemId)
        .where("state", "=", "reviewed"),
    );
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_audit_outbox")
        .set({ decision: "quarantined", reason_code: params.reasonCode, updated_at: params.nowMs })
        .where("intent_id", "=", params.intentId)
        .where("state", "=", "pending"),
    );
  });
}

/** Activate the reviewed copy and source-item state as one write transaction. */
function activatePostboxReviewWrite(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  agentId: string;
  intentId: string;
  nowMs: number;
}): void {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  runSqliteImmediateTransactionSync(params.database, () => {
    const pending = readPostboxReviewWriteIntent({
      database: params.database,
      intentId: params.intentId,
    });
    if (
      !pending ||
      pending.write.agent_id !== params.agentId ||
      !pending.write.pending_revision_id ||
      !pending.write.resource_id ||
      !pending.write.content_hash ||
      pending.write.content_hash !== pending.review.reviewed_content_hash ||
      (pending.write.state !== "pending" && pending.write.state !== "renamed")
    ) {
      throw new Error("memory postbox item is unavailable");
    }
    const intent: PostboxReviewWriteIntent = Object.freeze({
      itemId: pending.review.item_id,
      targetStoreId: pending.review.target_store_id,
      reviewedByPrincipalId: pending.review.reviewed_by_principal_id,
      reviewedContentHash: pending.review.reviewed_content_hash,
    });
    assertPostboxReviewWriteCurrent({
      database: params.database,
      agentId: params.agentId,
      intent,
      pendingRevisionId: pending.write.pending_revision_id,
      nowMs: params.nowMs,
    });
    const existing = executeSqliteQueryTakeFirstSync(
      params.database,
      db
        .selectFrom("memory_postbox_reviewed_copies")
        .select("item_id")
        .where("item_id", "=", intent.itemId),
    );
    if (existing) {
      throw new Error("memory postbox item is unavailable");
    }
    requireOneScopedMemoryWriteRow(
      executeSqliteQuerySync(
        params.database,
        db
          .updateTable("memory_resource_revisions")
          .set({ lifecycle_state: "active", activated_at: params.nowMs })
          .where("revision_id", "=", pending.write.pending_revision_id)
          .where("lifecycle_state", "=", "pending"),
      ),
      "postbox review activation revision",
    );
    executeSqliteQuerySync(
      params.database,
      db.insertInto("memory_postbox_reviewed_copies").values({
        item_id: intent.itemId,
        agent_id: params.agentId,
        resource_id: pending.write.resource_id,
        revision_id: pending.write.pending_revision_id,
        reviewed_content_hash: intent.reviewedContentHash,
        created_at: params.nowMs,
      }),
    );
    requireOneScopedMemoryWriteRow(
      executeSqliteQuerySync(
        params.database,
        db
          .updateTable("memory_postbox_items")
          .set({
            state: "reviewed",
            reviewed_by_principal_id: intent.reviewedByPrincipalId,
            reviewed_at: params.nowMs,
          })
          .where("item_id", "=", intent.itemId)
          .where("state", "=", "postbox"),
      ),
      "postbox review activation item",
    );
    requireOneScopedMemoryWriteRow(
      executeSqliteQuerySync(
        params.database,
        db
          .updateTable("memory_write_intents")
          .set({ state: "active", activated_at: params.nowMs, updated_at: params.nowMs })
          .where("intent_id", "=", params.intentId)
          .where("state", "in", ["pending", "renamed"]),
      ),
      "postbox review activation intent",
    );
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_audit_outbox")
        .set({
          decision: "committed",
          reason_code: "postbox-review-committed",
          updated_at: params.nowMs,
        })
        .where("intent_id", "=", params.intentId)
        .where("state", "=", "pending"),
    );
  });
}

/** Recover only a verified postbox-review artifact; generic write recovery cannot move its item. */
export function recoverBuiltinMemoryPostboxReviewWrites(agentId: string): void {
  withScopedMemoryDatabase(agentId, (database, databasePath) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const candidates = executeSqliteQuerySync(
      database,
      db
        .selectFrom("memory_write_intents as intent")
        .innerJoin(
          "memory_postbox_review_write_intents as review",
          "review.intent_id",
          "intent.intent_id",
        )
        .innerJoin("memory_stores as store", "store.store_id", "intent.store_id")
        .innerJoin("memory_storage_roots as root", "root.storage_root_id", "store.storage_root_id")
        .select([
          "intent.intent_id",
          "intent.pending_revision_id",
          "intent.staged_locator",
          "intent.final_locator",
          "intent.content_hash",
          "intent.content_bytes",
          "intent.state",
          "intent.indexed_at",
          "review.item_id",
          "root.path_key",
        ])
        .where("intent.agent_id", "=", agentId)
        .where("intent.state", "in", ["pending", "renamed", "active"])
        .orderBy("intent.created_at")
        .orderBy("intent.intent_id"),
    ).rows;
    for (const candidate of candidates) {
      if (candidate.state === "active" && candidate.indexed_at !== null) {
        continue;
      }
      const nowMs = Date.now();
      const pending = readPostboxReviewWriteIntent({ database, intentId: candidate.intent_id });
      if (
        !pending ||
        pending.write.agent_id !== agentId ||
        !candidate.path_key ||
        !candidate.pending_revision_id ||
        !candidate.final_locator ||
        !candidate.content_hash ||
        candidate.content_bytes === null
      ) {
        quarantinePostboxReviewWrite({
          database,
          intentId: candidate.intent_id,
          revisionId: candidate.pending_revision_id ?? "",
          itemId: candidate.item_id,
          nowMs,
          reasonCode: "postbox-review-recovery-incomplete-intent",
        });
        continue;
      }
      const directory = path.join(
        resolveScopedMemoryArtifactBase(databasePath),
        candidate.path_key,
      );
      const finalPath = resolveBuiltinScopedMemoryArtifactPath({
        databasePath,
        pathKey: candidate.path_key,
        artifactLocator: candidate.final_locator,
      });
      const stagePath = candidate.staged_locator
        ? path.join(directory, candidate.staged_locator)
        : undefined;
      try {
        if (
          candidate.state === "pending" &&
          !fs.existsSync(finalPath) &&
          stagePath &&
          fs.existsSync(stagePath)
        ) {
          finalizeScopedMemoryWriteArtifact({ directory, stagePath, finalPath });
          markSharingWriteRenamed({ database, intentId: candidate.intent_id, nowMs });
          candidate.state = "renamed";
        }
        const content = readVerifiedScopedMemoryWriteArtifact({
          pathname: finalPath,
          contentHash: candidate.content_hash,
          contentBytes: candidate.content_bytes,
        });
        if (content === undefined) {
          throw new Error("memory postbox review recovery artifact is unavailable");
        }
        if (candidate.state === "pending" || candidate.state === "renamed") {
          activatePostboxReviewWrite({
            database,
            agentId,
            intentId: candidate.intent_id,
            nowMs,
          });
          candidate.state = "active";
        }
        const active = executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("memory_postbox_reviewed_copies as copy")
            .innerJoin("memory_postbox_items as item", "item.item_id", "copy.item_id")
            .select(["copy.revision_id", "item.state"])
            .where("copy.item_id", "=", pending.review.item_id)
            .where("copy.agent_id", "=", agentId),
        );
        if (
          !active ||
          active.revision_id !== candidate.pending_revision_id ||
          active.state !== "reviewed"
        ) {
          throw new Error("memory postbox review recovery activation is unavailable");
        }
        if (candidate.indexed_at === null) {
          try {
            indexSharingWrite({
              database,
              intentId: candidate.intent_id,
              revisionId: candidate.pending_revision_id,
              content,
              nowMs,
            });
          } catch {
            // Index construction is derived bookkeeping; the verified reviewed copy remains valid.
          }
        }
      } catch {
        quarantinePostboxReviewWrite({
          database,
          intentId: candidate.intent_id,
          revisionId: candidate.pending_revision_id,
          itemId: pending.review.item_id,
          nowMs,
          reasonCode: "postbox-review-recovery-validation-failed",
        });
        quarantineScopedMemoryWriteArtifact({ directory, pathname: finalPath });
        if (stagePath) {
          quarantineScopedMemoryWriteArtifact({ directory, pathname: stagePath });
        }
      }
    }
  });
}

/** Stage, record, verify, and atomically promote one owner-reviewed postbox copy. */
function approveBuiltinMemoryPostboxItem(params: {
  agentId: string;
  itemId: string;
  operatorPrincipalId: string;
  reviewedContent?: string;
  nowMs: number;
}): void {
  const intentId = randomUUID();
  const resourceId = randomUUID();
  const revisionId = randomUUID();
  const initialIntent: PostboxReviewWriteIntent = Object.freeze({
    itemId: params.itemId,
    targetStoreId: "",
    reviewedByPrincipalId: params.operatorPrincipalId,
    reviewedContentHash: "",
  });
  withScopedMemoryDatabase(params.agentId, (database, databasePath) => {
    const planned = assertPostboxReviewWriteCurrent({
      database,
      agentId: params.agentId,
      intent: initialIntent,
      nowMs: params.nowMs,
    });
    const content =
      params.reviewedContent === undefined
        ? planned.content
        : normalize(params.reviewedContent, "reviewed postbox content");
    if (!content.trim() || Buffer.byteLength(content) > POSTBOX_MAX_CONTENT_BYTES) {
      throw new Error("memory postbox review is unavailable");
    }
    const contentHash = hashScopedMemoryWriteContent(content);
    const intent: PostboxReviewWriteIntent = Object.freeze({
      itemId: params.itemId,
      targetStoreId: planned.target_store_id,
      reviewedByPrincipalId: params.operatorPrincipalId,
      reviewedContentHash: contentHash,
    });
    const finalLocator = `r1_${revisionId}.md`;
    const stageLocator = `mpbrst1_${intentId}.tmp`;
    const directory = path.join(resolveScopedMemoryArtifactBase(databasePath), planned.path_key);
    const stagePath = stageScopedMemoryWriteArtifact({ directory, stageLocator, content });
    const finalPath = resolveBuiltinScopedMemoryArtifactPath({
      databasePath,
      pathKey: planned.path_key,
      artifactLocator: finalLocator,
    });
    const contentBytes = Buffer.byteLength(content);
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    let pendingCommitted = false;
    let activated = false;
    try {
      runSqliteImmediateTransactionSync(database, () => {
        const target = assertPostboxReviewWriteCurrent({
          database,
          agentId: params.agentId,
          intent,
          nowMs: params.nowMs,
        });
        const inFlight = executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("memory_postbox_review_write_intents as review")
            .innerJoin("memory_write_intents as write", "write.intent_id", "review.intent_id")
            .select("review.intent_id")
            .where("review.item_id", "=", params.itemId)
            .where("write.state", "in", ["pending", "renamed", "active"])
            .limit(1),
        );
        if (inFlight) {
          throw new Error("memory postbox item is unavailable");
        }
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_resources").values({
            resource_id: resourceId,
            agent_id: params.agentId,
            store_id: target.target_store_id,
            // A quarantined review attempt remains immutable audit evidence, so a later approval
            // needs its own locator instead of overwriting the failed attempt's resource row.
            logical_locator: `postbox-reviewed/${params.itemId}/${intentId}.md`,
            source: "memory",
            created_at: params.nowMs,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_resource_revisions").values({
            revision_id: revisionId,
            resource_id: resourceId,
            revision_number: 1,
            artifact_locator: finalLocator,
            content_hash: contentHash,
            content_bytes: contentBytes,
            policy_revision_id: target.current_revision_id,
            policy_revocation_epoch: target.revocation_epoch,
            source_policy_set_id: createScopedMemorySourcePolicySetId(target.current_revision_id),
            lifecycle_state: "pending",
            actor_kind: "human",
            actor_id: params.operatorPrincipalId,
            expires_at: null,
            created_at: params.nowMs,
            activated_at: null,
            retired_at: null,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_revision_policy_requirements").values({
            revision_id: revisionId,
            policy_id: target.policy_id,
            expected_revision_id: target.current_revision_id,
            expected_revocation_epoch: target.revocation_epoch,
            requirement_kind: "output-policy",
            created_at: params.nowMs,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_write_intents").values({
            intent_id: intentId,
            idempotency_key: `postbox-review:${params.itemId}:${intentId}`,
            mutation_id: `postbox-review:${params.itemId}:${intentId}`,
            agent_id: params.agentId,
            request_id: intentId,
            run_id: `sharing-control:${params.operatorPrincipalId}`,
            context_fingerprint: params.itemId,
            plan_id: "sharing-control",
            mutation_kind: "admin-reclassify",
            store_id: target.target_store_id,
            resource_id: resourceId,
            pending_revision_id: revisionId,
            staged_locator: stageLocator,
            final_locator: finalLocator,
            content_hash: contentHash,
            content_bytes: contentBytes,
            state: "pending",
            created_at: params.nowMs,
            updated_at: params.nowMs,
            activated_at: null,
            indexed_at: null,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_postbox_review_write_intents").values({
            intent_id: intentId,
            agent_id: params.agentId,
            item_id: params.itemId,
            target_store_id: target.target_store_id,
            reviewed_by_principal_id: params.operatorPrincipalId,
            reviewed_content_hash: contentHash,
            created_at: params.nowMs,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_audit_outbox").values({
            event_id: randomUUID(),
            intent_id: intentId,
            agent_id: params.agentId,
            request_id: intentId,
            run_id: `sharing-control:${params.operatorPrincipalId}`,
            actor_ref: `sha256:${hash(`human\0${params.operatorPrincipalId}`)}`,
            subject_ref: `sha256:${hash(JSON.stringify({ kind: "user", id: target.audience_id }))}`,
            operation: "policy-admin",
            resource_revision_id: revisionId,
            content_hash: contentHash,
            decision: "pending",
            reason_code: "postbox-review-pending",
            state: "pending",
            attempts: 0,
            created_at: params.nowMs,
            updated_at: params.nowMs,
            delivered_at: null,
          }),
        );
      });
      pendingCommitted = true;
      interruptPostboxReviewWriteForTest("after-pending-commit");
      finalizeScopedMemoryWriteArtifact({ directory, stagePath, finalPath });
      markSharingWriteRenamed({ database, intentId, nowMs: params.nowMs });
      interruptPostboxReviewWriteForTest("after-artifact-rename");
      const verified = readVerifiedScopedMemoryWriteArtifact({
        pathname: finalPath,
        contentHash,
        contentBytes,
      });
      if (verified === undefined) {
        throw new Error("memory postbox review finalized artifact is unavailable");
      }
      activatePostboxReviewWrite({
        database,
        agentId: params.agentId,
        intentId,
        nowMs: params.nowMs,
      });
      activated = true;
      try {
        indexSharingWrite({
          database,
          intentId,
          revisionId,
          content: verified,
          nowMs: params.nowMs,
        });
      } catch {
        // Startup recovery rebuilds the derived index from the verified artifact.
      }
    } catch (error) {
      if (!pendingCommitted) {
        try {
          fs.unlinkSync(stagePath);
        } catch {}
      } else if (!(error instanceof PostboxReviewWriteInterruptedForTest) && !activated) {
        quarantinePostboxReviewWrite({
          database,
          intentId,
          revisionId,
          itemId: params.itemId,
          nowMs: params.nowMs,
          reasonCode: "postbox-review-activation-failed",
        });
        quarantineScopedMemoryWriteArtifact({ directory, pathname: stagePath });
        quarantineScopedMemoryWriteArtifact({ directory, pathname: finalPath });
      }
      throw error;
    }
  });
}

/** Reject and purge fence an interrupted approval before the item leaves quarantine. */
function tombstonePendingPostboxReviewWrites(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  agentId: string;
  itemId: string;
  nowMs: number;
}): void {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  const pending = executeSqliteQuerySync(
    params.database,
    db
      .selectFrom("memory_postbox_review_write_intents as review")
      .innerJoin("memory_write_intents as write", "write.intent_id", "review.intent_id")
      .select(["write.intent_id", "write.pending_revision_id"])
      .where("review.agent_id", "=", params.agentId)
      .where("review.item_id", "=", params.itemId)
      .where("write.state", "in", ["pending", "renamed"]),
  ).rows;
  for (const write of pending) {
    if (write.pending_revision_id) {
      executeSqliteQuerySync(
        params.database,
        db
          .updateTable("memory_resource_revisions")
          .set({ lifecycle_state: "tombstoned", retired_at: params.nowMs })
          .where("revision_id", "=", write.pending_revision_id)
          .where("lifecycle_state", "=", "pending"),
      );
    }
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_write_intents")
        .set({ state: "tombstoned", updated_at: params.nowMs, activated_at: params.nowMs })
        .where("intent_id", "=", write.intent_id)
        .where("state", "in", ["pending", "renamed"]),
    );
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_audit_outbox")
        .set({
          decision: "tombstoned",
          reason_code: "postbox-review-cancelled",
          updated_at: params.nowMs,
        })
        .where("intent_id", "=", write.intent_id)
        .where("state", "=", "pending"),
    );
  }
}

/**
 * Approval is the one explicit promotion boundary: it writes an immutable owner-reviewed copy,
 * while the original channel deposit remains quarantined and immutable. Reject never promotes.
 */
export function reviewBuiltinMemoryPostboxItem(params: {
  agentId: string;
  itemId: string;
  operatorPrincipalId: string;
  decision: "approve" | "reject" | "purge";
  reviewedContent?: string;
  nowMs?: number;
}): void {
  const operatorPrincipalId = normalize(params.operatorPrincipalId, "operator principal id");
  const nowMs = params.nowMs ?? Date.now();
  const itemId = normalize(params.itemId, "postbox item id");
  if (params.decision === "reject" && params.reviewedContent !== undefined) {
    throw new Error("memory postbox review is unavailable");
  }
  if (params.decision === "approve") {
    approveBuiltinMemoryPostboxItem({
      agentId: params.agentId,
      itemId,
      operatorPrincipalId,
      ...(params.reviewedContent === undefined ? {} : { reviewedContent: params.reviewedContent }),
      nowMs,
    });
    return;
  }
  withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    runSqliteImmediateTransactionSync(database, () => {
      const item = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_postbox_items as item")
          .innerJoin("memory_stores as store", "store.store_id", "item.target_store_id")
          .select([
            "item.item_id",
            "item.state",
            "item.target_store_id",
            "store.audience_kind",
            "store.audience_id",
          ])
          .where("item.item_id", "=", itemId)
          .where("item.agent_id", "=", params.agentId),
      );
      if (!item || item.audience_kind !== "user") {
        throw new Error("memory postbox item is unavailable");
      }
      assertStoreOperation({
        agentId: params.agentId,
        storeId: item.target_store_id,
        principalId: operatorPrincipalId,
        audience: { kind: item.audience_kind, id: item.audience_id },
        operation: "policy-admin",
      });
      if (params.decision === "purge") {
        tombstonePendingPostboxReviewWrites({
          database,
          agentId: params.agentId,
          itemId: item.item_id,
          nowMs,
        });
        const approvedCopy = executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("memory_postbox_reviewed_copies")
            .select("revision_id")
            .where("item_id", "=", item.item_id)
            .where("agent_id", "=", params.agentId),
        );
        if (approvedCopy) {
          executeSqliteQuerySync(
            database,
            db
              .updateTable("memory_resource_revisions")
              .set({ lifecycle_state: "tombstoned", retired_at: nowMs })
              .where("revision_id", "=", approvedCopy.revision_id)
              .where("lifecycle_state", "=", "active"),
          );
          executeSqliteQuerySync(
            database,
            db
              .deleteFrom("memory_scoped_chunks")
              .where("revision_id", "=", approvedCopy.revision_id),
          );
        }
        const purged = executeSqliteQuerySync(
          database,
          db
            .updateTable("memory_postbox_items")
            // A purge is one irreversible transition: never tombstone its reviewed copy unless
            // this provenance row is redacted in the same transaction.
            .set({ state: "purged", content: "", content_hash: "", purged_at: nowMs })
            .where("item_id", "=", item.item_id)
            .where("state", "in", ["postbox", "reviewed", "rejected"]),
        );
        if (purged.numAffectedRows !== 1n) {
          throw new Error("memory postbox item is unavailable");
        }
        return;
      }
      tombstonePendingPostboxReviewWrites({
        database,
        agentId: params.agentId,
        itemId: item.item_id,
        nowMs,
      });
      const updated = executeSqliteQuerySync(
        database,
        db
          .updateTable("memory_postbox_items")
          .set({
            state: "rejected",
            reviewed_by_principal_id: operatorPrincipalId,
            reviewed_at: nowMs,
          })
          .where("item_id", "=", item.item_id)
          .where("state", "in", ["postbox"]),
      );
      if (updated.numAffectedRows !== 1n) {
        throw new Error("memory postbox item is unavailable");
      }
    });
  });
}

/** Only the authorized target owner/admin can read one pending quarantine body for review. */
export function inspectBuiltinMemoryPostboxItem(params: {
  agentId: string;
  itemId: string;
  operatorPrincipalId: string;
}): BuiltinMemoryPostboxInspection {
  const itemId = normalize(params.itemId, "postbox item id");
  const operatorPrincipalId = normalize(params.operatorPrincipalId, "operator principal id");
  return withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const item = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_postbox_items as item")
        .innerJoin("memory_stores as store", "store.store_id", "item.target_store_id")
        .select([
          "item.item_id",
          "item.content",
          "item.source_channel_ref",
          "item.created_at",
          "item.state",
          "item.target_store_id",
          "store.audience_kind",
          "store.audience_id",
        ])
        .where("item.item_id", "=", itemId)
        .where("item.agent_id", "=", params.agentId),
    );
    if (!item || item.state !== "postbox" || item.audience_kind !== "user") {
      throw new Error("memory postbox item is unavailable");
    }
    assertStoreOperation({
      agentId: params.agentId,
      storeId: item.target_store_id,
      principalId: operatorPrincipalId,
      audience: { kind: "user", id: item.audience_id },
      operation: "policy-admin",
    });
    return Object.freeze({
      itemId: item.item_id,
      content: item.content,
      sourceChannelRef: item.source_channel_ref,
      createdAt: item.created_at,
    });
  });
}
