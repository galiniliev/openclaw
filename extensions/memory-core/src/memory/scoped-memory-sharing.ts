import { createHash, randomUUID } from "node:crypto";
import type { AudienceRef } from "openclaw/plugin-sdk/memory-authorization";
import { resolveMemoryPostboxTurnCapability } from "openclaw/plugin-sdk/memory-postbox-runtime";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { type ScopedMemoryDatabase, withScopedMemoryDatabase } from "./scoped-memory-db.js";
import { evaluateBuiltinScopedMemoryPolicy } from "./scoped-memory-policy.js";
import {
  createBuiltinScopedMemoryResource,
  readBuiltinScopedMemoryRevisionSnapshot,
  type BuiltinScopedMemoryDerivedSource,
  type BuiltinScopedMemoryRevision,
} from "./scoped-memory-resources.js";
import {
  createScopedMemorySourcePolicySetId,
  normalizeScopedMemoryRequiredText,
  type BuiltinScopedMemoryStore,
} from "./scoped-memory-store.js";

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
}>;

export type BuiltinMemoryPostboxDeposit = Readonly<{ accepted: boolean }>;

export type BuiltinMemoryProjectionImpact = Readonly<{
  projectionId: string;
  exposureSetIds: readonly string[];
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
      .innerJoin("memory_policies as policy", "policy.policy_id", "store.policy_id")
      .select([
        "store.store_id",
        "store.policy_id",
        "policy.current_revision_id",
        "policy.revocation_epoch",
      ])
      .where("target.agent_id", "=", params.agentId)
      .where("target.audience_kind", "=", params.target.kind)
      .where("target.audience_id", "=", params.target.id)
      .where("store.agent_id", "=", params.agentId)
      .where("store.audience_kind", "=", params.target.kind)
      .where("store.audience_id", "=", params.target.id)
      .where("store.lifecycle_state", "=", "active")
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
  return executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_stores")
      .select(["store_id", "audience_kind", "audience_id"])
      .where("agent_id", "=", params.agentId)
      .where("audience_kind", "=", "user")
      .where("audience_id", "=", params.targetPrincipalId)
      .where("lifecycle_state", "=", "active"),
  );
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
  const target = targetAudience(params.target);
  const operatorPrincipalId = normalize(params.operatorPrincipalId, "operator principal id");
  const nowMs = params.nowMs ?? Date.now();
  assertStoreOperation({
    agentId: params.agentId,
    storeId: params.store.storeId,
    principalId: operatorPrincipalId,
    audience: target,
    operation: "policy-admin",
  });
  withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    runSqliteImmediateTransactionSync(database, () => {
      const store = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_stores")
          .select(["store_id", "audience_kind", "audience_id"])
          .where("store_id", "=", params.store.storeId)
          .where("agent_id", "=", params.agentId)
          .where("lifecycle_state", "=", "active"),
      );
      if (!store || store.audience_kind !== target.kind || store.audience_id !== target.id) {
        throw new Error("memory projection target is unavailable");
      }
      executeSqliteQuerySync(
        database,
        db
          .insertInto("memory_projection_targets")
          .values({
            agent_id: params.agentId,
            audience_kind: target.kind,
            audience_id: target.id,
            store_id: params.store.storeId,
            configured_by_principal_id: operatorPrincipalId,
            created_at: nowMs,
          })
          .onConflict((conflict) =>
            conflict.columns(["agent_id", "audience_kind", "audience_id"]).doUpdateSet({
              store_id: params.store.storeId,
              configured_by_principal_id: operatorPrincipalId,
              created_at: nowMs,
            }),
          ),
      );
    });
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
  nowMs?: number;
}): BuiltinMemoryProjection {
  const target = targetAudience(params.target);
  const sourceRevisionId = normalize(params.sourceRevisionId, "source revision id");
  const publisherPrincipalId = normalize(params.publisherPrincipalId, "publisher principal id");
  const reviewedByPrincipalId = normalize(params.reviewedByPrincipalId, "reviewer principal id");
  const purpose = normalize(params.purpose, "projection purpose");
  const preview = normalize(params.preview, "projection preview");
  const nowMs = params.nowMs ?? Date.now();
  const expiry =
    params.expiry.kind === "expires"
      ? (() => {
          if (!Number.isSafeInteger(params.expiry.expiresAt) || params.expiry.expiresAt <= nowMs) {
            throw new Error("memory projection expiry is unavailable");
          }
          return { kind: "expires" as const, expiresAt: params.expiry.expiresAt };
        })()
      : {
          kind: "no-expiry" as const,
          auditReason: normalize(params.expiry.auditReason, "no-expiry audit reason"),
        };
  return withScopedMemoryDatabase(params.agentId, (database) => {
    const source = readSource({ database, agentId: params.agentId, revisionId: sourceRevisionId });
    const sourceAudience: AudienceRef = { kind: source.audience_kind, id: source.audience_id };
    assertStoreOperation({
      agentId: params.agentId,
      storeId: source.store_id,
      principalId: publisherPrincipalId,
      audience: sourceAudience,
      operation: "project",
    });
    const snapshot = readBuiltinScopedMemoryRevisionSnapshot({
      agentId: params.agentId,
      storeIds: [source.store_id],
      revisionId: sourceRevisionId,
    });
    if (!snapshot) {
      throw new Error("memory projection source is unavailable");
    }
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
    if (reviewedByPrincipalId !== publisherPrincipalId) {
      assertStoreOperation({
        agentId: params.agentId,
        storeId: targetStore.store_id,
        principalId: reviewedByPrincipalId,
        audience: target,
        operation: "policy-admin",
      });
    }
    const sourceEvidence = readSourceRequirements({ database, revisionId: sourceRevisionId });
    const projectionId = `mproj1_${randomUUID()}`;
    const store: BuiltinScopedMemoryStore = Object.freeze({
      storageRootId: "projection-target",
      storeId: targetStore.store_id,
      policyId: targetStore.policy_id,
      policyRevisionId: targetStore.current_revision_id,
      policyRevocationEpoch: targetStore.revocation_epoch,
      sourcePolicySetId: createScopedMemorySourcePolicySetId(targetStore.current_revision_id),
    });
    const copy = createBuiltinScopedMemoryResource({
      agentId: params.agentId,
      store,
      logicalLocator: `projections/${projectionId}.md`,
      content: params.content,
      ...(expiry.kind === "expires" ? { expiresAt: expiry.expiresAt } : {}),
      actor: { kind: "human", id: publisherPrincipalId },
      nowMs,
      derivedSources: [sourceEvidence],
      commitAdditionalState: ({ database: transactionDatabase, revision }) => {
        const db = getNodeSqliteKysely<ScopedMemoryDatabase>(transactionDatabase);
        executeSqliteQuerySync(
          transactionDatabase,
          db.insertInto("memory_projections").values({
            projection_id: projectionId,
            agent_id: params.agentId,
            target_store_id: targetStore.store_id,
            target_audience_kind: target.kind,
            target_audience_id: target.id,
            source_revision_id: sourceRevisionId,
            copy_revision_id: revision.revisionId,
            publisher_principal_id: publisherPrincipalId,
            reviewed_by_principal_id: reviewedByPrincipalId,
            purpose,
            preview,
            expiry_kind: expiry.kind === "expires" ? "expires" : "no-expiry",
            expiry_audit_reason: expiry.kind === "no-expiry" ? expiry.auditReason : null,
            expires_at: expiry.kind === "expires" ? expiry.expiresAt : null,
            revocation_behavior: "tombstone-copy",
            state: "active",
            created_at: nowMs,
            revoked_at: null,
          }),
        );
      },
    });
    return Object.freeze({
      projectionId,
      copyRevisionId: copy.revisionId,
      sourceRevisionId,
      target,
      ...(expiry.kind === "expires" ? { expiresAt: expiry.expiresAt } : {}),
    });
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

/** Refresh explicitly creates a new reviewed copy, then revokes the previous copy and reports its impact. */
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
    nowMs: params.nowMs,
  });
  const replacedExposureSetIds = revokeBuiltinMemoryProjection({
    agentId: params.agentId,
    projectionId,
    operatorPrincipalId: publisherPrincipalId,
    nowMs: params.nowMs,
  });
  return Object.freeze({ projection, replacedExposureSetIds });
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
  sessionId?: string;
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
      sourceSessionId: params.sessionId ?? params.sessionKey,
      sourceChannelRef: source.sourceChannelRef,
      sourceMessageRef: source.sourceMessageRef,
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

/** Owner/admin review changes quarantine state only; it never promotes postbox content into recall. */
export function reviewBuiltinMemoryPostboxItem(params: {
  agentId: string;
  itemId: string;
  operatorPrincipalId: string;
  decision: "approve" | "reject" | "purge";
  nowMs?: number;
}): void {
  const nowMs = params.nowMs ?? Date.now();
  withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
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
        .where("item.item_id", "=", params.itemId)
        .where("item.agent_id", "=", params.agentId),
    );
    if (!item || item.audience_kind !== "user") {
      throw new Error("memory postbox item is unavailable");
    }
    assertStoreOperation({
      agentId: params.agentId,
      storeId: item.target_store_id,
      principalId: normalize(params.operatorPrincipalId, "operator principal id"),
      audience: { kind: item.audience_kind, id: item.audience_id },
      operation: "policy-admin",
    });
    const state =
      params.decision === "approve"
        ? "reviewed"
        : params.decision === "reject"
          ? "rejected"
          : "purged";
    executeSqliteQuerySync(
      database,
      db
        .updateTable("memory_postbox_items")
        .set({
          state,
          reviewed_by_principal_id: normalize(params.operatorPrincipalId, "operator principal id"),
          reviewed_at: nowMs,
          ...(state === "purged" ? { purged_at: nowMs } : {}),
        })
        .where("item_id", "=", item.item_id)
        .where("state", "=", "postbox"),
    );
  });
}
