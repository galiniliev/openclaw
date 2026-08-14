import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  resolveScopedMemoryArtifactBase,
  type ScopedMemoryDatabase,
  type ScopedMemoryLifecycleState,
  withScopedMemoryDatabase,
} from "./scoped-memory-db.js";
import {
  createScopedMemorySourcePolicySetId,
  normalizeScopedMemoryRequiredText,
  type BuiltinScopedMemoryStore,
  type ScopedMemoryActor,
} from "./scoped-memory-store.js";

const ARTIFACT_NAME_PATTERN =
  /^r1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/u;
const LOGICAL_LOCATOR_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)[^\0\\]+$/u;

export type BuiltinScopedMemoryRevision = Readonly<{
  resourceId: string;
  revisionId: string;
  policyRevisionId: string;
  policyRevocationEpoch: number;
  sourcePolicySetId: string;
  artifactLocator: string;
}>;

/** Content verified against the active immutable catalog record, before any future exposure. */
export type BuiltinScopedMemoryRevisionSnapshot = Readonly<{
  resourceId: string;
  revisionId: string;
  storeId: string;
  logicalLocator: string;
  source: "memory" | "sessions";
  content: string;
  contentHash: string;
  contentBytes: number;
  policyRevisionId: string;
  policyRevocationEpoch: number;
}>;

export type ScopedMemoryChunk = Readonly<{
  ordinal: number;
  startLine: number;
  endLine: number;
  text: string;
}>;

/** Immutable source evidence carried into an explicitly reviewed derived resource. */
export type BuiltinScopedMemoryDerivedSource = Readonly<{
  revisionId: string;
  policyRequirements: readonly Readonly<{
    policyId: string;
    expectedRevisionId: string;
    expectedRevocationEpoch: number;
  }>[];
}>;

export type BuiltinScopedMemoryRevisionCommit = Readonly<{
  database: DatabaseSync;
  revision: BuiltinScopedMemoryRevision;
  nowMs: number;
}>;

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeLogicalLocator(locator: string): string {
  const normalized = normalizeScopedMemoryRequiredText(locator, "logical locator").replaceAll(
    "\\",
    "/",
  );
  if (!LOGICAL_LOCATOR_PATTERN.test(normalized)) {
    throw new Error("logical locator is invalid");
  }
  return normalized;
}

function createArtifactLocator(revisionId: string): string {
  return `r1_${revisionId}.md`;
}

function resolveArtifactDirectory(params: { databasePath: string; pathKey: string }): string {
  const base = path.resolve(resolveScopedMemoryArtifactBase(params.databasePath));
  if (!/^s1_[A-Za-z0-9_-]{24,}$/u.test(params.pathKey)) {
    throw new Error("scoped-memory path key is invalid");
  }
  const directory = path.resolve(base, params.pathKey);
  if (path.dirname(directory) !== base) {
    throw new Error("scoped-memory storage root is invalid");
  }
  return directory;
}

/** Resolve a canonical artifact path without allowing logical locators to affect the filesystem. */
export function resolveBuiltinScopedMemoryArtifactPath(params: {
  databasePath: string;
  pathKey: string;
  artifactLocator: string;
}): string {
  if (!ARTIFACT_NAME_PATTERN.test(params.artifactLocator)) {
    throw new Error("artifact locator is invalid");
  }
  const directory = resolveArtifactDirectory(params);
  const artifactPath = path.resolve(directory, params.artifactLocator);
  if (path.dirname(artifactPath) !== directory) {
    throw new Error("artifact locator escaped its storage root");
  }
  return artifactPath;
}

/** Deterministic Markdown chunks retained as scoped derived state beside the canonical artifact. */
export function chunkScopedMemoryMarkdown(content: string): readonly ScopedMemoryChunk[] {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const chunks: ScopedMemoryChunk[] = [];
  const chunkSize = 48;
  for (let start = 0; start < lines.length; start += chunkSize) {
    const selected = lines
      .slice(start, start + chunkSize)
      .join("\n")
      .trim();
    if (!selected) {
      continue;
    }
    chunks.push(
      Object.freeze({
        ordinal: chunks.length,
        startLine: start + 1,
        endLine: Math.min(lines.length, start + chunkSize),
        text: selected,
      }),
    );
  }
  return Object.freeze(chunks);
}

function writeImmutableArtifact(params: { artifactPath: string; content: string }): void {
  fs.mkdirSync(path.dirname(params.artifactPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(params.artifactPath, params.content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function removeArtifact(pathname: string): void {
  try {
    fs.unlinkSync(pathname);
  } catch {}
}

type RevisionPolicyRequirement = Readonly<{
  policyId: string;
  expectedRevisionId: string;
  expectedRevocationEpoch: number;
}>;

function readRevisionPolicyRequirements(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  revisionId: string;
}): readonly RevisionPolicyRequirement[] {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  return Object.freeze(
    executeSqliteQuerySync(
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
    ),
  );
}

/** A policy-set parent remains current only while every captured policy revision does. */
function isPolicySetCurrent(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  policySetId: string;
}): boolean {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  const members = executeSqliteQuerySync(
    params.database,
    db
      .selectFrom("memory_policy_set_members")
      .select(["policy_id", "expected_revision_id", "expected_revocation_epoch", "retention_state"])
      .where("policy_set_id", "=", params.policySetId)
      .orderBy("policy_id"),
  ).rows;
  if (members.length === 0 || members.some((member) => member.retention_state !== "retained")) {
    return false;
  }
  return members.every((member) => {
    const current = executeSqliteQueryTakeFirstSync(
      params.database,
      db
        .selectFrom("memory_policies as policy")
        .innerJoin(
          "memory_policy_revisions as revision",
          "revision.revision_id",
          "policy.current_revision_id",
        )
        .select([
          "policy.lifecycle_state as policy_lifecycle_state",
          "policy.revocation_epoch",
          "revision.lifecycle_state as revision_lifecycle_state",
        ])
        .where("policy.policy_id", "=", member.policy_id)
        .where("policy.current_revision_id", "=", member.expected_revision_id)
        .where("policy.revocation_epoch", "=", member.expected_revocation_epoch),
    );
    return (
      current?.policy_lifecycle_state === "active" && current.revision_lifecycle_state === "active"
    );
  });
}

function readCompactionPolicyAudience(
  deliveryAudiencesJson: string,
): Readonly<{ kind: string; id: string }> | undefined {
  try {
    const audiences: unknown = JSON.parse(deliveryAudiencesJson);
    if (!Array.isArray(audiences) || audiences.length !== 1) {
      return undefined;
    }
    const audience = audiences[0];
    if (
      typeof audience === "object" &&
      audience !== null &&
      "kind" in audience &&
      "id" in audience &&
      typeof audience.kind === "string" &&
      typeof audience.id === "string" &&
      audience.kind.length > 0 &&
      audience.id.length > 0
    ) {
      return Object.freeze({ kind: audience.kind, id: audience.id });
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compaction source rows are immutable evidence, so transcript reset and archive cannot make a
 * valid summary unreadable. Policy-set membership is still rechecked on every read: revocation
 * changes the active policy revision and immediately invalidates all descendants.
 */
function isCompactionPolicyCurrent(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  compactionPolicyId: string;
  revisionId: string;
}): boolean {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  const policy = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_compaction_policies")
      .select(["session_id", "source_policy_set_id", "retention_state"])
      .where("compaction_policy_id", "=", params.compactionPolicyId),
  );
  if (!policy || policy.retention_state !== "retained") {
    return false;
  }
  const sources = executeSqliteQuerySync(
    params.database,
    db
      .selectFrom("memory_compaction_policy_sources")
      .select(["source_session_id", "source_policy_set_id", "delivery_audiences_json"])
      .where("compaction_policy_id", "=", params.compactionPolicyId)
      .orderBy("source_event_seq"),
  ).rows;
  if (
    sources.length === 0 ||
    sources.some(
      (source) =>
        source.source_session_id !== policy.session_id ||
        source.source_policy_set_id !== policy.source_policy_set_id ||
        !readCompactionPolicyAudience(source.delivery_audiences_json),
    )
  ) {
    return false;
  }
  const target = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_resource_revisions as revision")
      .innerJoin("memory_resources as resource", "resource.resource_id", "revision.resource_id")
      .innerJoin("memory_stores as store", "store.store_id", "resource.store_id")
      .select(["store.audience_kind", "store.audience_id"])
      .where("revision.revision_id", "=", params.revisionId),
  );
  if (
    !target ||
    !isPolicySetCurrent({ database: params.database, policySetId: policy.source_policy_set_id })
  ) {
    return false;
  }
  return sources.every((source) => {
    const audience = readCompactionPolicyAudience(source.delivery_audiences_json);
    return audience?.kind === target.audience_kind && audience.id === target.audience_id;
  });
}

/** Requirements and parent revisions are checked for every future exposure, not only at write time. */
function isRevisionLineageCurrent(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  revisionId: string;
  visited: Set<string>;
}): boolean {
  if (params.visited.has(params.revisionId)) {
    return false;
  }
  params.visited.add(params.revisionId);
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  const requirements = readRevisionPolicyRequirements(params);
  if (requirements.length === 0) {
    return false;
  }
  for (const requirement of requirements) {
    const current = executeSqliteQueryTakeFirstSync(
      params.database,
      db
        .selectFrom("memory_policies as policy")
        .innerJoin(
          "memory_policy_revisions as revision",
          "revision.revision_id",
          "policy.current_revision_id",
        )
        .select([
          "policy.current_revision_id",
          "policy.revocation_epoch",
          "policy.lifecycle_state as policy_lifecycle_state",
          "revision.lifecycle_state as revision_lifecycle_state",
        ])
        .where("policy.policy_id", "=", requirement.policyId),
    );
    if (
      !current ||
      current.policy_lifecycle_state !== "active" ||
      current.revision_lifecycle_state !== "active" ||
      current.current_revision_id !== requirement.expectedRevisionId ||
      current.revocation_epoch !== requirement.expectedRevocationEpoch
    ) {
      return false;
    }
  }
  const parents = executeSqliteQuerySync(
    params.database,
    db
      .selectFrom("memory_lineage_edges")
      .select(["parent_kind", "parent_id"])
      .where("child_revision_id", "=", params.revisionId)
      .orderBy("parent_kind")
      .orderBy("parent_id"),
  ).rows;
  for (const parent of parents) {
    if (parent.parent_kind === "transcript-policy-set") {
      // Transcript sources materialize their stable policy requirements and every exposed resource
      // parent on the child revision. Those checks above and below are the durable invalidation path.
      continue;
    }
    if (parent.parent_kind === "compaction-policy") {
      if (
        !isCompactionPolicyCurrent({
          database: params.database,
          compactionPolicyId: parent.parent_id,
          revisionId: params.revisionId,
        })
      ) {
        return false;
      }
      continue;
    }
    // Other Phase 2C producers add their own immutable parent types. A resource parent is already
    // selectable today, so it must recurse rather than merely checking its direct lifecycle row.
    if (parent.parent_kind !== "resource-revision") {
      return false;
    }
    const revision = executeSqliteQueryTakeFirstSync(
      params.database,
      db
        .selectFrom("memory_resource_revisions")
        .select("lifecycle_state")
        .where("revision_id", "=", parent.parent_id),
    );
    if (
      revision?.lifecycle_state !== "active" ||
      !isRevisionLineageCurrent({
        database: params.database,
        revisionId: parent.parent_id,
        visited: params.visited,
      })
    ) {
      return false;
    }
  }
  return true;
}

/** Recovery paths use the same recursive check as normal reads before activating a pending revision. */
export function isBuiltinScopedMemoryRevisionLineageCurrent(params: {
  agentId: string;
  revisionId: string;
}): boolean {
  const agentId = normalizeAgentId(params.agentId);
  const revisionId = normalizeScopedMemoryRequiredText(params.revisionId, "revisionId");
  return withScopedMemoryDatabase(agentId, (database) =>
    isRevisionLineageCurrent({ database, revisionId, visited: new Set() }),
  );
}

/**
 * Resolve a revision only while its immutable catalog evidence is current.
 * The Phase 1C runtime supplies the authorized store view; this foundation
 * never treats a logical locator or filesystem path as an authorization grant.
 */
export function readBuiltinScopedMemoryRevisionSnapshot(params: {
  agentId: string;
  storeIds: readonly string[];
  revisionId: string;
  nowMs?: number;
}): BuiltinScopedMemoryRevisionSnapshot | undefined {
  const agentId = normalizeAgentId(params.agentId);
  const revisionId = normalizeScopedMemoryRequiredText(params.revisionId, "revisionId");
  const storeIds = [
    ...new Set(
      params.storeIds.map((storeId) => normalizeScopedMemoryRequiredText(storeId, "storeId")),
    ),
  ];
  if (storeIds.length === 0) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  return withScopedMemoryDatabase(agentId, (database, databasePath) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const revision = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_resource_revisions as revision")
        .innerJoin("memory_resources as resource", "resource.resource_id", "revision.resource_id")
        .innerJoin("memory_stores as store", "store.store_id", "resource.store_id")
        .innerJoin("memory_storage_roots as root", "root.storage_root_id", "store.storage_root_id")
        .innerJoin("memory_policies as policy", "policy.policy_id", "store.policy_id")
        .innerJoin(
          "memory_policy_revisions as policy_revision",
          "policy_revision.revision_id",
          "policy.current_revision_id",
        )
        .select([
          "resource.resource_id",
          "resource.store_id",
          "resource.logical_locator",
          "resource.source",
          "revision.revision_id",
          "revision.artifact_locator",
          "revision.content_hash",
          "revision.content_bytes",
          "revision.policy_revision_id",
          "revision.policy_revocation_epoch",
          "revision.source_policy_set_id",
          "revision.lifecycle_state as revision_lifecycle_state",
          "revision.expires_at",
          "store.lifecycle_state as store_lifecycle_state",
          "root.path_key",
          "root.backend_kind",
          "root.lifecycle_state as root_lifecycle_state",
          "policy.current_revision_id",
          "policy.revocation_epoch",
          "policy.lifecycle_state as policy_lifecycle_state",
          "policy_revision.lifecycle_state as policy_revision_lifecycle_state",
          "policy_revision.revocation_epoch as current_policy_revocation_epoch",
        ])
        .where("revision.revision_id", "=", revisionId),
    );
    if (
      !revision?.path_key ||
      !storeIds.includes(revision.store_id) ||
      revision.revision_lifecycle_state !== "active" ||
      revision.store_lifecycle_state !== "active" ||
      revision.root_lifecycle_state !== "active" ||
      revision.backend_kind !== "builtin" ||
      revision.policy_lifecycle_state !== "active" ||
      revision.policy_revision_lifecycle_state !== "active" ||
      revision.policy_revision_id !== revision.current_revision_id ||
      revision.policy_revocation_epoch !== revision.revocation_epoch ||
      revision.current_policy_revocation_epoch !== revision.revocation_epoch ||
      revision.source_policy_set_id !==
        createScopedMemorySourcePolicySetId(revision.current_revision_id) ||
      !isRevisionLineageCurrent({ database, revisionId, visited: new Set() }) ||
      (revision.expires_at !== null && revision.expires_at <= nowMs)
    ) {
      return undefined;
    }
    const artifactPath = resolveBuiltinScopedMemoryArtifactPath({
      databasePath,
      pathKey: revision.path_key,
      artifactLocator: revision.artifact_locator,
    });
    let content: string;
    try {
      // Scoped artifact roots are owner-only. Refuse a symlink rather than letting a compromised
      // artifact entry make a future authorized read cross the selected store boundary.
      if (fs.lstatSync(artifactPath).isSymbolicLink()) {
        return undefined;
      }
      content = fs.readFileSync(artifactPath, "utf8");
    } catch {
      return undefined;
    }
    if (
      Buffer.byteLength(content) !== revision.content_bytes ||
      contentHash(content) !== revision.content_hash
    ) {
      return undefined;
    }
    return Object.freeze({
      resourceId: revision.resource_id,
      revisionId: revision.revision_id,
      storeId: revision.store_id,
      logicalLocator: revision.logical_locator,
      source: revision.source,
      content,
      contentHash: revision.content_hash,
      contentBytes: revision.content_bytes,
      policyRevisionId: revision.policy_revision_id,
      policyRevocationEpoch: revision.policy_revocation_epoch,
    });
  });
}

function createRevision(params: {
  agentId: string;
  resourceId: string;
  content: string;
  lifecycleState: ScopedMemoryLifecycleState;
  expiresAt: number | null;
  actor: ScopedMemoryActor;
  nowMs: number;
  derivedSources?: readonly BuiltinScopedMemoryDerivedSource[];
  /** Runs inside the immutable revision transaction, before the revision becomes readable. */
  commitAdditionalState?: (params: BuiltinScopedMemoryRevisionCommit) => void;
}): BuiltinScopedMemoryRevision {
  const content = params.content;
  if (!content.trim()) {
    throw new Error("scoped memory content is required");
  }
  if (params.lifecycleState === "tombstoned") {
    throw new Error("new scoped-memory revisions cannot start tombstoned");
  }
  if (
    params.expiresAt !== null &&
    (!Number.isSafeInteger(params.expiresAt) || params.expiresAt < 0)
  ) {
    throw new Error("scoped-memory expiry is invalid");
  }
  const revisionId = randomUUID();
  const artifactLocator = createArtifactLocator(revisionId);
  return withScopedMemoryDatabase(params.agentId, (database, databasePath) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const resource = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_resources as resource")
        .innerJoin("memory_stores as store", "store.store_id", "resource.store_id")
        .innerJoin("memory_storage_roots as root", "root.storage_root_id", "store.storage_root_id")
        .select(["resource.resource_id", "root.path_key"])
        .where("resource.resource_id", "=", params.resourceId)
        .where("resource.agent_id", "=", params.agentId)
        .where("store.lifecycle_state", "=", "active")
        .where("root.lifecycle_state", "=", "active"),
    );
    if (!resource?.path_key) {
      throw new Error("scoped-memory resource storage root is unavailable");
    }
    const artifactPath = resolveBuiltinScopedMemoryArtifactPath({
      databasePath,
      pathKey: resource.path_key,
      artifactLocator,
    });
    writeImmutableArtifact({ artifactPath, content });
    try {
      let output: BuiltinScopedMemoryRevision | undefined;
      runSqliteImmediateTransactionSync(database, () => {
        const current = executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("memory_resources as resource")
            .innerJoin("memory_stores as store", "store.store_id", "resource.store_id")
            .innerJoin("memory_policies as policy", "policy.policy_id", "store.policy_id")
            .innerJoin(
              "memory_policy_revisions as policy_revision",
              "policy_revision.revision_id",
              "policy.current_revision_id",
            )
            .select([
              "resource.resource_id",
              "policy.policy_id",
              "policy.current_revision_id",
              "policy.revocation_epoch",
              "policy_revision.revision_number",
            ])
            .where("resource.resource_id", "=", params.resourceId)
            .where("resource.agent_id", "=", params.agentId)
            .where("store.lifecycle_state", "=", "active")
            .where("policy.lifecycle_state", "=", "active")
            .where("policy_revision.lifecycle_state", "=", "active"),
        );
        if (!current) {
          throw new Error("scoped-memory resource policy is unavailable");
        }
        const previous = executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("memory_resource_revisions")
            .select("revision_number")
            .where("resource_id", "=", params.resourceId)
            .orderBy("revision_number", "desc")
            .limit(1),
        );
        if (params.lifecycleState === "active") {
          executeSqliteQuerySync(
            database,
            db
              .updateTable("memory_resource_revisions")
              .set({ lifecycle_state: "tombstoned", retired_at: params.nowMs })
              .where("resource_id", "=", params.resourceId)
              .where("lifecycle_state", "=", "active"),
          );
        }
        const revisionNumber = (previous?.revision_number ?? 0) + 1;
        const hash = contentHash(content);
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_resource_revisions").values({
            revision_id: revisionId,
            resource_id: params.resourceId,
            revision_number: revisionNumber,
            artifact_locator: artifactLocator,
            content_hash: hash,
            content_bytes: Buffer.byteLength(content),
            policy_revision_id: current.current_revision_id,
            policy_revocation_epoch: current.revocation_epoch,
            source_policy_set_id: createScopedMemorySourcePolicySetId(current.current_revision_id),
            lifecycle_state: params.lifecycleState,
            actor_kind: params.actor.kind,
            actor_id: params.actor.id ?? null,
            expires_at: params.expiresAt,
            created_at: params.nowMs,
            activated_at: params.lifecycleState === "active" ? params.nowMs : null,
            retired_at: null,
          }),
        );
        for (const source of params.derivedSources ?? []) {
          for (const requirement of source.policyRequirements) {
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
                  created_at: params.nowMs,
                })
                .onConflict((conflict) =>
                  conflict.columns(["revision_id", "policy_id"]).doNothing(),
                ),
            );
          }
          executeSqliteQuerySync(
            database,
            db.insertInto("memory_lineage_edges").values({
              child_revision_id: revisionId,
              parent_kind: "resource-revision",
              parent_id: source.revisionId,
              relation_kind: "derived-from",
              created_at: params.nowMs,
            }),
          );
        }
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_revision_policy_requirements").values({
            revision_id: revisionId,
            policy_id: current.policy_id,
            expected_revision_id: current.current_revision_id,
            expected_revocation_epoch: current.revocation_epoch,
            requirement_kind: "output-policy",
            created_at: params.nowMs,
          }),
        );
        const chunks = chunkScopedMemoryMarkdown(content);
        if (chunks.length > 0) {
          executeSqliteQuerySync(
            database,
            db.insertInto("memory_scoped_chunks").values(
              chunks.map((chunk) => ({
                chunk_id: randomUUID(),
                revision_id: revisionId,
                chunk_ordinal: chunk.ordinal,
                start_line: chunk.startLine,
                end_line: chunk.endLine,
                text: chunk.text,
                content_hash: hash,
                model: "fts-only",
                updated_at: params.nowMs,
              })),
            ),
          );
        }
        output = Object.freeze({
          resourceId: params.resourceId,
          revisionId,
          policyRevisionId: current.current_revision_id,
          policyRevocationEpoch: current.revocation_epoch,
          sourcePolicySetId: createScopedMemorySourcePolicySetId(current.current_revision_id),
          artifactLocator,
        });
        params.commitAdditionalState?.({ database, revision: output, nowMs: params.nowMs });
      });
      if (!output) {
        throw new Error("scoped-memory revision was not created");
      }
      return output;
    } catch (error) {
      removeArtifact(artifactPath);
      throw error;
    }
  });
}

/** Create the stable resource and first immutable revision under its store policy. */
export function createBuiltinScopedMemoryResource(params: {
  agentId: string;
  store: BuiltinScopedMemoryStore;
  logicalLocator: string;
  content: string;
  lifecycleState?: Exclude<ScopedMemoryLifecycleState, "tombstoned">;
  expiresAt?: number;
  actor: ScopedMemoryActor;
  nowMs?: number;
  derivedSources?: readonly BuiltinScopedMemoryDerivedSource[];
  /** Owner-only metadata that must commit atomically with the readable revision. */
  commitAdditionalState?: (params: BuiltinScopedMemoryRevisionCommit) => void;
}): BuiltinScopedMemoryRevision {
  const agentId = normalizeAgentId(params.agentId);
  const logicalLocator = normalizeLogicalLocator(params.logicalLocator);
  const nowMs = params.nowMs ?? Date.now();
  const resourceId = randomUUID();
  return withScopedMemoryDatabase(agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    runSqliteImmediateTransactionSync(database, () => {
      const store = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_stores")
          .select("store_id")
          .where("store_id", "=", params.store.storeId)
          .where("agent_id", "=", agentId)
          .where("lifecycle_state", "=", "active"),
      );
      if (!store) {
        throw new Error("scoped-memory store is unavailable");
      }
      executeSqliteQuerySync(
        database,
        db.insertInto("memory_resources").values({
          resource_id: resourceId,
          agent_id: agentId,
          store_id: store.store_id,
          logical_locator: logicalLocator,
          source: "memory",
          created_at: nowMs,
        }),
      );
    });
    return createRevision({
      agentId,
      resourceId,
      content: params.content,
      lifecycleState: params.lifecycleState ?? "active",
      expiresAt: params.expiresAt ?? null,
      actor: params.actor,
      nowMs,
      ...(params.derivedSources ? { derivedSources: params.derivedSources } : {}),
      ...(params.commitAdditionalState ? { commitAdditionalState: params.commitAdditionalState } : {}),
    });
  });
}

/** Add a later immutable revision; only one active revision can exist per resource. */
export function createBuiltinScopedMemoryResourceRevision(params: {
  agentId: string;
  resourceId: string;
  content: string;
  lifecycleState?: Exclude<ScopedMemoryLifecycleState, "tombstoned">;
  expiresAt?: number;
  actor: ScopedMemoryActor;
  nowMs?: number;
  derivedSources?: readonly BuiltinScopedMemoryDerivedSource[];
  commitAdditionalState?: (params: BuiltinScopedMemoryRevisionCommit) => void;
}): BuiltinScopedMemoryRevision {
  return createRevision({
    agentId: normalizeAgentId(params.agentId),
    resourceId: normalizeScopedMemoryRequiredText(params.resourceId, "resourceId"),
    content: params.content,
    lifecycleState: params.lifecycleState ?? "active",
    expiresAt: params.expiresAt ?? null,
    actor: params.actor,
    nowMs: params.nowMs ?? Date.now(),
    ...(params.derivedSources ? { derivedSources: params.derivedSources } : {}),
    ...(params.commitAdditionalState ? { commitAdditionalState: params.commitAdditionalState } : {}),
  });
}

/** Quarantine or tombstone a revision without mutating its immutable evidence. */
export function setBuiltinScopedMemoryRevisionLifecycle(params: {
  agentId: string;
  revisionId: string;
  lifecycleState: "quarantined" | "tombstoned";
  nowMs?: number;
}): void {
  const agentId = normalizeAgentId(params.agentId);
  const revisionId = normalizeScopedMemoryRequiredText(params.revisionId, "revisionId");
  const nowMs = params.nowMs ?? Date.now();
  withScopedMemoryDatabase(agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const updated = executeSqliteQuerySync(
      database,
      db
        .updateTable("memory_resource_revisions as revision")
        .set({ lifecycle_state: params.lifecycleState, retired_at: nowMs })
        .where("revision.revision_id", "=", revisionId)
        .where(
          "revision.resource_id",
          "in",
          db.selectFrom("memory_resources").select("resource_id").where("agent_id", "=", agentId),
        )
        .where("revision.lifecycle_state", "in", ["pending", "active", "quarantined"]),
    );
    if (updated.numAffectedRows !== 1n) {
      throw new Error("invalid scoped-memory revision lifecycle transition");
    }
  });
}
