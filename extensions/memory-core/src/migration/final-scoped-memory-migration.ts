import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  resolveOpenClawAgentSqlitePath,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withScopedMemoryDatabase, type ScopedMemoryDatabase } from "../memory/scoped-memory-db.js";
import { evaluateBuiltinScopedMemoryPolicy } from "../memory/scoped-memory-policy.js";
import {
  createBuiltinScopedMemoryResource,
  createBuiltinScopedMemoryResourceRevision,
  chunkScopedMemoryMarkdown,
  readBuiltinScopedMemoryRevisionSnapshot,
  resolveBuiltinScopedMemoryArtifactPath,
} from "../memory/scoped-memory-resources.js";
import {
  createBuiltinScopedMemoryStore,
  type BuiltinScopedMemoryStore,
} from "../memory/scoped-memory-store.js";

const SOURCE_KIND = "memory-isolation-legacy-source";
const EVIDENCE_VERSION = 1;
const EMPTY_LEGACY_CORPUS_SOURCE_KIND = "memory-isolation-empty-legacy-corpus";
const EMPTY_LEGACY_CORPUS_VERSION = 1;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type FinalScopedMemoryMigrationActor = Readonly<{
  role: "owner" | "admin";
  principalId: string;
}>;

export type FinalScopedMemoryMigrationDecision =
  | Readonly<{ sourceId: string; sourceHash: string; placement: "quarantine" }>
  | Readonly<{
      sourceId: string;
      sourceHash: string;
      placement: "user-private";
      principalId: string;
    }>;

/** Core creates this archive grant only after it validates the final marker and every source row. */
export type FinalScopedMemoryMigrationCutover = Readonly<{
  migrationId: string;
  planHash: string;
  sources: readonly Readonly<{ sourceKind: string; sourceHash: string }>[];
}>;

export type FinalScopedMemoryMigrationSource = Readonly<{
  sourceId: string;
  sourceKind: string;
  content: string;
  /** Never persisted. It exists only long enough for the owner-controlled archive step. */
  sourcePath?: string;
}>;

export type FinalScopedMemoryMigrationPlan = Readonly<{
  migrationId: string;
  planHash: string;
  sources: readonly Readonly<{
    sourceId: string;
    sourceKind: string;
    sourceHash: string;
    contentHash: string;
    bytes: number;
    placement: "quarantine" | "user-private";
  }>[];
}>;

export type FinalScopedMemoryMigrationResult = Readonly<{
  migrationId: string;
  planHash: string;
  verifiedSources: readonly Readonly<{ sourceKind: string; sourceHash: string }>[];
}>;

type PreparedSource = Readonly<{
  sourceId: string;
  sourceKind: string;
  sourceHash: string;
  content: string;
  contentHash: string;
  bytes: number;
  sourcePath?: string;
  decision: Readonly<{
    placement: "quarantine" | "user-private";
    principalId?: string;
  }>;
}>;

type ReviewedDecision = PreparedSource["decision"] & Readonly<{ sourceHash: string }>;

type Destination = Readonly<{
  storeId: string;
  resourceId: string;
  revisionId: string;
  lifecycleState: "active" | "quarantined";
}>;

type SourceEvidence = Readonly<{
  migrationId: string;
  source: Readonly<{
    id: string;
    kind: string;
    hash: string;
    contentHash: string;
    bytes: number;
  }>;
  decision: Readonly<{
    placement: "quarantine" | "approved";
    actorRole: "owner" | "admin";
    actorId: string;
  }>;
  backup: Readonly<{
    artifactHash: string;
    contentHash: string;
    verifiedAt: number;
  }>;
  destination: Readonly<{
    storeId: string;
    resourceId: string;
    revisionId: string;
    contentHash: string;
    lifecycleState: "active" | "quarantined";
  }>;
  archive: Readonly<{
    state: "pending" | "archiving" | "archived";
    artifactHash?: string;
  }>;
}>;

type LegacyIndexDatabase = ScopedMemoryDatabase & {
  memory_index_chunks: Readonly<{ id: string; path: string; source: string }>;
  memory_index_sources: Readonly<{ path: string; source: string }>;
};

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function scopedResourceContentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("\0")) {
    throw new Error(`memory isolation migration ${label} is required`);
  }
  return normalized;
}

function opaqueId(value: string): string {
  return `m6_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function normalizeActor(actor: FinalScopedMemoryMigrationActor): FinalScopedMemoryMigrationActor {
  return Object.freeze({
    role: actor.role,
    principalId: requiredText(actor.principalId, "actor principal id"),
  });
}

function normalizeSource(
  source: FinalScopedMemoryMigrationSource,
): FinalScopedMemoryMigrationSource {
  const sourceId = requiredText(source.sourceId, "source id");
  const sourceKind = requiredText(source.sourceKind, "source kind");
  if (source.content.length === 0 || Buffer.byteLength(source.content) > MAX_SOURCE_BYTES) {
    throw new Error("memory isolation migration source is empty or exceeds the backup limit");
  }
  return Object.freeze({
    sourceId,
    sourceKind,
    content: source.content,
    ...(source.sourcePath ? { sourcePath: source.sourcePath } : {}),
  });
}

function normalizeDecisions(
  actor: FinalScopedMemoryMigrationActor,
  decisions: readonly FinalScopedMemoryMigrationDecision[],
): Map<string, ReviewedDecision> {
  const normalized = new Map<string, ReviewedDecision>();
  for (const decision of decisions) {
    const sourceId = requiredText(decision.sourceId, "decision source id");
    const sourceHash = requiredText(decision.sourceHash, "decision source hash");
    if (!SHA256_PATTERN.test(sourceHash)) {
      throw new Error("memory isolation migration decision source hash is invalid");
    }
    if (normalized.has(sourceId)) {
      throw new Error("memory isolation migration contains duplicate placement decisions");
    }
    if (decision.placement === "quarantine") {
      normalized.set(sourceId, Object.freeze({ sourceHash, placement: "quarantine" }));
      continue;
    }
    const principalId = requiredText(decision.principalId, "private placement principal id");
    if (actor.role === "owner" && actor.principalId !== principalId) {
      throw new Error(
        "memory isolation migration owners may place only into their own private store",
      );
    }
    normalized.set(sourceId, Object.freeze({ sourceHash, placement: "user-private", principalId }));
  }
  return normalized;
}

function prepareSources(params: {
  actor: FinalScopedMemoryMigrationActor;
  sources: readonly FinalScopedMemoryMigrationSource[];
  decisions: readonly FinalScopedMemoryMigrationDecision[];
}): readonly PreparedSource[] {
  const decisions = normalizeDecisions(params.actor, params.decisions);
  const prepared = params.sources
    .map(normalizeSource)
    .map((source) => {
      const contentHash = sha256(source.content);
      const sourceHash = sha256(`${source.sourceId}\0${source.sourceKind}\0${contentHash}`);
      const reviewed = decisions.get(source.sourceId);
      if (reviewed && reviewed.sourceHash !== sourceHash) {
        throw new Error(
          "memory isolation migration decision does not match the discovered source hash",
        );
      }
      return Object.freeze({
        sourceId: source.sourceId,
        sourceKind: source.sourceKind,
        sourceHash,
        content: source.content,
        contentHash,
        bytes: Buffer.byteLength(source.content),
        ...(source.sourcePath ? { sourcePath: source.sourcePath } : {}),
        decision: reviewed ?? Object.freeze({ placement: "quarantine" as const }),
      });
    })
    .toSorted((left, right) => left.sourceId.localeCompare(right.sourceId));
  if (new Set(prepared.map((source) => source.sourceId)).size !== prepared.length) {
    throw new Error("memory isolation migration has duplicate source ids");
  }
  for (const sourceId of decisions.keys()) {
    if (!prepared.some((source) => source.sourceId === sourceId)) {
      throw new Error("memory isolation migration decision names an undiscovered source");
    }
  }
  return Object.freeze(prepared);
}

function createPlan(params: {
  migrationId: string;
  sources: readonly PreparedSource[];
}): FinalScopedMemoryMigrationPlan {
  const payload = JSON.stringify({
    version: EVIDENCE_VERSION,
    migrationId: params.migrationId,
    sources: params.sources.map((source) => ({
      sourceId: source.sourceId,
      sourceKind: source.sourceKind,
      sourceHash: source.sourceHash,
      contentHash: source.contentHash,
      bytes: source.bytes,
      placement: source.decision.placement,
      ...(source.decision.principalId
        ? { principalRef: opaqueId(source.decision.principalId) }
        : {}),
    })),
  });
  return Object.freeze({
    migrationId: params.migrationId,
    planHash: sha256(payload),
    sources: Object.freeze(
      params.sources.map((source) =>
        Object.freeze({
          sourceId: source.sourceId,
          sourceKind: source.sourceKind,
          sourceHash: source.sourceHash,
          contentHash: source.contentHash,
          bytes: source.bytes,
          placement: source.decision.placement,
        }),
      ),
    ),
  });
}

function createProgressClassification(params: {
  migrationId: string;
  source: PreparedSource;
  actor: FinalScopedMemoryMigrationActor;
  phase: "previewed" | "backed-up" | "copied" | "indexed";
}): string {
  return JSON.stringify({
    mode: "memory-isolation-source-progress",
    version: EVIDENCE_VERSION,
    migrationId: params.migrationId,
    source: {
      id: params.source.sourceId,
      kind: params.source.sourceKind,
      hash: params.source.sourceHash,
      contentHash: params.source.contentHash,
      bytes: params.source.bytes,
    },
    decision: {
      placement: params.source.decision.placement === "quarantine" ? "quarantine" : "approved",
      actorRole: params.actor.role,
      actorId: opaqueId(params.actor.principalId),
    },
    phase: params.phase,
  });
}

function createEvidenceClassification(evidence: SourceEvidence): string {
  return JSON.stringify({
    mode: "memory-isolation-source",
    version: EVIDENCE_VERSION,
    migrationId: evidence.migrationId,
    source: evidence.source,
    decision: evidence.decision,
    backup: evidence.backup,
    destination: evidence.destination,
    verification: {
      hash: true,
      mount: true,
      denial: true,
      catalog: true,
      index: true,
    },
    archive: evidence.archive,
  });
}

function parseArchiveEvidence(value: string): SourceEvidence | undefined {
  try {
    const record = asOptionalRecord(JSON.parse(value));
    const source = asOptionalRecord(record?.source);
    const archive = asOptionalRecord(record?.archive);
    if (
      record?.mode !== "memory-isolation-source" ||
      record.version !== EVIDENCE_VERSION ||
      typeof record.migrationId !== "string" ||
      !source ||
      !archive ||
      typeof source.id !== "string" ||
      typeof source.kind !== "string" ||
      typeof source.hash !== "string" ||
      typeof source.contentHash !== "string" ||
      (archive.state !== "pending" &&
        archive.state !== "archiving" &&
        archive.state !== "archived") ||
      (archive.artifactHash !== undefined && typeof archive.artifactHash !== "string")
    ) {
      return undefined;
    }
    const evidence = record as unknown as SourceEvidence;
    return createEvidenceClassification(evidence) === value ? evidence : undefined;
  } catch {
    return undefined;
  }
}

function sourceMigrationId(params: { migrationId: string; sourceId: string }): string {
  return `memory-isolation-source:${opaqueId(`${params.migrationId}\0${params.sourceId}`)}`;
}

/**
 * A clean pilot agent still needs durable proof that Doctor reviewed an empty corpus. Without
 * this receipt, an empty final marker could bind any caller-supplied digest to no source rows.
 */
function createEmptyLegacyCorpusClassification(params: {
  migrationId: string;
  planHash: string;
}): string {
  return JSON.stringify({
    mode: "memory-isolation-empty-legacy-corpus",
    version: EMPTY_LEGACY_CORPUS_VERSION,
    migrationId: params.migrationId,
    planHash: params.planHash,
  });
}

function writeVerifiedEmptyLegacyCorpusReceipt(params: {
  agentId: string;
  migrationId: string;
  planHash: string;
  nowMs: number;
}): void {
  const classificationJson = createEmptyLegacyCorpusClassification(params);
  const sourceHash = sha256(classificationJson);
  withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const existing = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_migrations")
        .select([
          "migration_id",
          "source_hash",
          "phase",
          "classification_json",
          "plan_hash",
          "verified_at",
          "cutover_at",
        ])
        .where("source_kind", "=", EMPTY_LEGACY_CORPUS_SOURCE_KIND)
        .where("source_hash", "=", sourceHash),
    );
    if (!existing) {
      executeSqliteQuerySync(
        database,
        db.insertInto("memory_migrations").values({
          migration_id: params.migrationId,
          source_kind: EMPTY_LEGACY_CORPUS_SOURCE_KIND,
          source_hash: sourceHash,
          phase: "verified",
          classification_json: classificationJson,
          plan_hash: params.planHash,
          verified_at: params.nowMs,
          cutover_at: null,
          updated_at: params.nowMs,
        }),
      );
      return;
    }
    if (
      existing.migration_id !== params.migrationId ||
      existing.plan_hash !== params.planHash ||
      existing.classification_json !== classificationJson ||
      existing.phase !== "verified" ||
      existing.verified_at === null ||
      existing.cutover_at !== null
    ) {
      throw new Error(
        "memory isolation empty legacy corpus receipt is already owned by another plan",
      );
    }
  });
}

function isVerifiedEmptyLegacyCorpusReceipt(params: {
  migrationId: string;
  planHash: string;
  row: Readonly<{
    migration_id: string;
    source_kind: string;
    source_hash: string;
    phase: string;
    classification_json: string;
    plan_hash: string;
    verified_at: number | null;
    cutover_at: number | null;
  }>;
  phase: "verified" | "cutover";
}): boolean {
  const classificationJson = createEmptyLegacyCorpusClassification(params);
  return (
    params.row.migration_id === params.migrationId &&
    params.row.source_kind === EMPTY_LEGACY_CORPUS_SOURCE_KIND &&
    params.row.source_hash === sha256(classificationJson) &&
    params.row.phase === params.phase &&
    params.row.classification_json === classificationJson &&
    params.row.plan_hash === params.planHash &&
    params.row.verified_at !== null &&
    (params.phase === "verified" ? params.row.cutover_at === null : params.row.cutover_at !== null)
  );
}

function writeMigrationPhase(params: {
  agentId: string;
  migrationId: string;
  source: PreparedSource;
  planHash: string;
  phase: "previewed" | "backed-up" | "copied" | "indexed" | "verified";
  classificationJson: string;
  verifiedAt?: number;
  nowMs: number;
}): void {
  withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const existing = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_migrations")
        .select(["migration_id", "plan_hash", "phase"])
        .where("source_kind", "=", params.source.sourceKind)
        .where("source_hash", "=", params.source.sourceHash),
    );
    const migrationId = sourceMigrationId({
      migrationId: params.migrationId,
      sourceId: params.source.sourceId,
    });
    if (!existing) {
      executeSqliteQuerySync(
        database,
        db.insertInto("memory_migrations").values({
          migration_id: migrationId,
          source_kind: params.source.sourceKind,
          source_hash: params.source.sourceHash,
          phase: params.phase,
          classification_json: params.classificationJson,
          plan_hash: params.planHash,
          verified_at: params.verifiedAt ?? null,
          cutover_at: null,
          updated_at: params.nowMs,
        }),
      );
      return;
    }
    if (existing.migration_id !== migrationId || existing.plan_hash !== params.planHash) {
      throw new Error("memory isolation migration source is already owned by another plan");
    }
    if (existing.phase === "cutover") {
      throw new Error("memory isolation migration source has already cut over");
    }
    executeSqliteQuerySync(
      database,
      db
        .updateTable("memory_migrations")
        .set({
          phase: params.phase,
          classification_json: params.classificationJson,
          verified_at: params.verifiedAt ?? null,
          updated_at: params.nowMs,
        })
        .where("source_kind", "=", params.source.sourceKind)
        .where("source_hash", "=", params.source.sourceHash),
    );
  });
}

function readExistingPlanState(params: {
  agentId: string;
  migrationId: string;
  plan: FinalScopedMemoryMigrationPlan;
  sources: readonly PreparedSource[];
}): "new" | "resuming" | "verified" {
  return withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const rows = params.sources.map((source) =>
      executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_migrations")
          .select(["migration_id", "plan_hash", "phase"])
          .where("source_kind", "=", source.sourceKind)
          .where("source_hash", "=", source.sourceHash),
      ),
    );
    if (rows.every((row) => !row)) {
      return "new";
    }
    let complete = true;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const source = params.sources[index]!;
      if (!row) {
        complete = false;
        continue;
      }
      if (
        row.migration_id !==
          sourceMigrationId({
            migrationId: params.migrationId,
            sourceId: source.sourceId,
          }) ||
        row.plan_hash !== params.plan.planHash
      ) {
        throw new Error("memory isolation migration source is already owned by another plan");
      }
      if (row.phase !== "verified" && row.phase !== "cutover") {
        complete = false;
      }
    }
    return complete ? "verified" : "resuming";
  });
}

function backupDirectory(params: { agentId: string; migrationId: string }): string {
  const databasePath = resolveOpenClawAgentSqlitePath({ agentId: params.agentId });
  return path.join(
    path.dirname(databasePath),
    "memory-migration-backups",
    "v1",
    opaqueId(params.migrationId),
  );
}

function writeVerifiedBackup(params: {
  agentId: string;
  migrationId: string;
  source: PreparedSource;
}): string {
  const directory = backupDirectory(params);
  const target = path.join(directory, `${params.source.sourceId}.backup`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let existing: string | undefined;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("memory isolation backup target is unsafe");
    }
    existing = fs.readFileSync(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (existing === undefined) {
    const temporary = path.join(directory, `${params.source.sourceId}.${process.pid}.tmp`);
    fs.writeFileSync(temporary, params.source.content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, target);
  } else if (existing !== params.source.content) {
    throw new Error("memory isolation backup does not match the reviewed source");
  }
  const verified = fs.readFileSync(target, "utf8");
  const verifiedHash = sha256(verified);
  if (verifiedHash !== params.source.contentHash) {
    throw new Error("memory isolation backup hash verification failed");
  }
  return verifiedHash;
}

function createDestination(params: {
  agentId: string;
  source: PreparedSource;
  actor: FinalScopedMemoryMigrationActor;
  nowMs: number;
}): Destination {
  const expectedLifecycle =
    params.source.decision.placement === "quarantine" ? "quarantined" : "active";
  const logicalLocator = `migration/${params.source.sourceId}`;
  const existing = withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const resources = executeSqliteQuerySync(
      database,
      db
        .selectFrom("memory_resources as resource")
        .innerJoin("memory_stores as store", "store.store_id", "resource.store_id")
        .select(["resource.resource_id", "resource.store_id"])
        .where("resource.agent_id", "=", params.agentId)
        .where("resource.logical_locator", "=", logicalLocator)
        .where("resource.source", "=", "memory"),
    ).rows;
    if (resources.length > 1) {
      throw new Error("memory isolation migration recovery found multiple destination resources");
    }
    const resource = resources[0];
    if (!resource) {
      return undefined;
    }
    const revisions = executeSqliteQuerySync(
      database,
      db
        .selectFrom("memory_resource_revisions")
        .select(["revision_id", "content_hash", "lifecycle_state"])
        .where("resource_id", "=", resource.resource_id)
        .where("lifecycle_state", "in", ["active", "quarantined"]),
    ).rows;
    if (revisions.length > 1) {
      throw new Error(
        "memory isolation migration recovery found multiple active destination revisions",
      );
    }
    const revision = revisions[0];
    if (
      revision &&
      (revision.content_hash !== scopedResourceContentHash(params.source.content) ||
        revision.lifecycle_state !== expectedLifecycle)
    ) {
      throw new Error(
        "memory isolation migration recovery destination does not match reviewed source",
      );
    }
    return Object.freeze({
      resourceId: resource.resource_id,
      storeId: resource.store_id,
      revision,
    });
  });
  if (existing?.revision) {
    return Object.freeze({
      storeId: existing.storeId,
      resourceId: existing.resourceId,
      revisionId: existing.revision.revision_id,
      lifecycleState: expectedLifecycle,
    });
  }
  if (existing) {
    const revision = createBuiltinScopedMemoryResourceRevision({
      agentId: params.agentId,
      resourceId: existing.resourceId,
      content: params.source.content,
      lifecycleState: expectedLifecycle,
      actor: {
        kind: params.actor.role === "admin" ? "service" : "human",
        id:
          params.source.decision.placement === "quarantine"
            ? undefined
            : params.source.decision.principalId,
      },
      nowMs: params.nowMs,
    });
    return Object.freeze({
      storeId: existing.storeId,
      resourceId: existing.resourceId,
      revisionId: revision.revisionId,
      lifecycleState: expectedLifecycle,
    });
  }
  const isQuarantine = params.source.decision.placement === "quarantine";
  const ownerId = isQuarantine
    ? "memory-isolation-quarantine"
    : (params.source.decision.principalId as string);
  const store = createBuiltinScopedMemoryStore({
    agentId: params.agentId,
    scopeKind: isQuarantine ? "internal" : "user",
    audienceKind: isQuarantine ? "internal" : "user",
    audienceId: isQuarantine ? opaqueId(`quarantine\0${params.source.sourceId}`) : ownerId,
    authorityKind: isQuarantine ? "internal" : "user",
    authorityOwnerId: ownerId,
    defaultCapabilities: isQuarantine ? [] : ["retrieve", "read", "status", "export"],
    actor: {
      kind: params.actor.role === "admin" ? "service" : "human",
      id: isQuarantine ? undefined : ownerId,
    },
    reason: isQuarantine
      ? "ambiguous legacy memory quarantined during final cutover"
      : "owner-approved private legacy migration",
    nowMs: params.nowMs,
  });
  const revision = createBuiltinScopedMemoryResource({
    agentId: params.agentId,
    store,
    logicalLocator: `migration/${params.source.sourceId}`,
    content: params.source.content,
    lifecycleState: isQuarantine ? "quarantined" : "active",
    actor: {
      kind: params.actor.role === "admin" ? "service" : "human",
      id: isQuarantine ? undefined : ownerId,
    },
    nowMs: params.nowMs,
  });
  return Object.freeze({
    storeId: store.storeId,
    resourceId: revision.resourceId,
    revisionId: revision.revisionId,
    lifecycleState: isQuarantine ? "quarantined" : "active",
  });
}

function verifyDestination(params: {
  agentId: string;
  source: PreparedSource;
  destination: Destination;
  actor: FinalScopedMemoryMigrationActor;
  nowMs: number;
}): void {
  const expectedChunks = chunkScopedMemoryMarkdown(params.source.content);
  const chunks = withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    return executeSqliteQuerySync(
      database,
      db
        .selectFrom("memory_scoped_chunks")
        .select(["chunk_ordinal", "text"])
        .where("revision_id", "=", params.destination.revisionId)
        .orderBy("chunk_ordinal"),
    ).rows;
  });
  if (
    chunks.length !== expectedChunks.length ||
    chunks.some(
      (chunk, index) =>
        chunk.chunk_ordinal !== expectedChunks[index]?.ordinal ||
        chunk.text !== expectedChunks[index]?.text,
    )
  ) {
    throw new Error("memory isolation scoped index verification failed");
  }
  if (params.destination.lifecycleState === "active") {
    const snapshot = readBuiltinScopedMemoryRevisionSnapshot({
      agentId: params.agentId,
      storeIds: [params.destination.storeId],
      revisionId: params.destination.revisionId,
      nowMs: params.nowMs,
    });
    if (!snapshot || sha256(snapshot.content) !== params.source.contentHash) {
      throw new Error("memory isolation scoped copy hash or mount verification failed");
    }
    const owner = params.source.decision.principalId as string;
    const admitted = evaluateBuiltinScopedMemoryPolicy({
      agentId: params.agentId,
      storeId: params.destination.storeId,
      principalIds: [owner],
      deliveryAudiences: [{ kind: "user", id: owner }],
      operation: "read",
      nowMs: params.nowMs,
    });
    const denied = evaluateBuiltinScopedMemoryPolicy({
      agentId: params.agentId,
      storeId: params.destination.storeId,
      principalIds: ["unrelated-principal"],
      deliveryAudiences: [{ kind: "user", id: owner }],
      operation: "read",
      nowMs: params.nowMs,
    });
    if (!admitted.allowed || denied.allowed) {
      throw new Error("memory isolation scoped private denial matrix verification failed");
    }
    return;
  }
  const quarantined = evaluateBuiltinScopedMemoryPolicy({
    agentId: params.agentId,
    storeId: params.destination.storeId,
    principalIds: [params.actor.principalId],
    deliveryAudiences: [
      { kind: "internal", id: opaqueId(`quarantine\0${params.source.sourceId}`) },
    ],
    operation: "read",
    nowMs: params.nowMs,
  });
  if (quarantined.allowed) {
    throw new Error("memory isolation quarantine denial matrix verification failed");
  }
  withScopedMemoryDatabase(params.agentId, (database, databasePath) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const revision = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_resource_revisions as revision")
        .innerJoin("memory_resources as resource", "resource.resource_id", "revision.resource_id")
        .innerJoin("memory_stores as store", "store.store_id", "resource.store_id")
        .innerJoin("memory_storage_roots as root", "root.storage_root_id", "store.storage_root_id")
        .select([
          "revision.content_hash",
          "revision.content_bytes",
          "revision.artifact_locator",
          "root.path_key",
        ])
        .where("revision.revision_id", "=", params.destination.revisionId)
        .where("resource.agent_id", "=", params.agentId),
    );
    if (!revision?.path_key) {
      throw new Error("memory isolation quarantine catalog verification failed");
    }
    const artifact = resolveBuiltinScopedMemoryArtifactPath({
      databasePath,
      pathKey: revision.path_key,
      artifactLocator: revision.artifact_locator,
    });
    if (
      fs.lstatSync(artifact).isSymbolicLink() ||
      sha256(fs.readFileSync(artifact, "utf8")) !== params.source.contentHash ||
      revision.content_bytes !== params.source.bytes
    ) {
      throw new Error("memory isolation quarantine hash or mount verification failed");
    }
  });
}

function createEvidence(params: {
  migrationId: string;
  source: PreparedSource;
  actor: FinalScopedMemoryMigrationActor;
  backupHash: string;
  destination: Destination;
  nowMs: number;
}): SourceEvidence {
  return Object.freeze({
    migrationId: params.migrationId,
    source: Object.freeze({
      id: params.source.sourceId,
      kind: params.source.sourceKind,
      hash: params.source.sourceHash,
      contentHash: params.source.contentHash,
      bytes: params.source.bytes,
    }),
    decision: Object.freeze({
      placement: params.source.decision.placement === "quarantine" ? "quarantine" : "approved",
      actorRole: params.actor.role,
      actorId: opaqueId(params.actor.principalId),
    }),
    backup: Object.freeze({
      artifactHash: params.backupHash,
      contentHash: params.source.contentHash,
      verifiedAt: params.nowMs,
    }),
    destination: Object.freeze({
      storeId: params.destination.storeId,
      resourceId: params.destination.resourceId,
      revisionId: params.destination.revisionId,
      contentHash: params.source.contentHash,
      lifecycleState: params.destination.lifecycleState,
    }),
    archive: Object.freeze({ state: "pending" }),
  });
}

/**
 * Build an owner-reviewable migration plan. Discovery is structural only; every source without an
 * explicit private-owner decision is quarantined, never classified by its contents or filename.
 */
export function planFinalScopedMemoryMigration(params: {
  migrationId: string;
  actor: FinalScopedMemoryMigrationActor;
  sources: readonly FinalScopedMemoryMigrationSource[];
  decisions?: readonly FinalScopedMemoryMigrationDecision[];
}): FinalScopedMemoryMigrationPlan {
  const migrationId = requiredText(params.migrationId, "id");
  const actor = normalizeActor(params.actor);
  const sources = prepareSources({
    actor,
    sources: params.sources,
    decisions: params.decisions ?? [],
  });
  return createPlan({ migrationId, sources });
}

/**
 * Create backup, scoped catalog/resource/chunks, and canonical verified evidence. Core owns the
 * following atomic final marker; this function intentionally cannot activate enforced runtime.
 */
export function applyFinalScopedMemoryMigration(params: {
  agentId: string;
  migrationId: string;
  actor: FinalScopedMemoryMigrationActor;
  sources: readonly FinalScopedMemoryMigrationSource[];
  decisions?: readonly FinalScopedMemoryMigrationDecision[];
  /** The exact dry-run digest the owner/admin reviewed. Apply never self-approves newly scanned bytes. */
  expectedPlanHash?: string;
  nowMs?: number;
}): FinalScopedMemoryMigrationResult {
  const agentId = normalizeAgentId(params.agentId);
  const migrationId = requiredText(params.migrationId, "id");
  const actor = normalizeActor(params.actor);
  const nowMs = params.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("memory isolation migration time is invalid");
  }
  const sources = prepareSources({
    actor,
    sources: params.sources,
    decisions: params.decisions ?? [],
  });
  const plan = createPlan({ migrationId, sources });
  const expectedPlanHash = requiredText(params.expectedPlanHash ?? "", "reviewed plan hash");
  if (!SHA256_PATTERN.test(expectedPlanHash) || expectedPlanHash !== plan.planHash) {
    throw new Error("memory isolation migration no longer matches the reviewed dry-run plan");
  }
  if (sources.length === 0) {
    writeVerifiedEmptyLegacyCorpusReceipt({
      agentId,
      migrationId,
      planHash: plan.planHash,
      nowMs,
    });
    return Object.freeze({
      migrationId,
      planHash: plan.planHash,
      verifiedSources: Object.freeze([]),
    });
  }
  if (readExistingPlanState({ agentId, migrationId, plan, sources }) === "verified") {
    return Object.freeze({
      migrationId,
      planHash: plan.planHash,
      verifiedSources: Object.freeze(
        sources.map((source) =>
          Object.freeze({ sourceKind: source.sourceKind, sourceHash: source.sourceHash }),
        ),
      ),
    });
  }
  for (const source of sources) {
    writeMigrationPhase({
      agentId,
      migrationId,
      source,
      planHash: plan.planHash,
      phase: "previewed",
      classificationJson: createProgressClassification({
        migrationId,
        source,
        actor,
        phase: "previewed",
      }),
      nowMs,
    });
    const backupHash = writeVerifiedBackup({ agentId, migrationId, source });
    writeMigrationPhase({
      agentId,
      migrationId,
      source,
      planHash: plan.planHash,
      phase: "backed-up",
      classificationJson: createProgressClassification({
        migrationId,
        source,
        actor,
        phase: "backed-up",
      }),
      nowMs,
    });
    const destination = createDestination({ agentId, source, actor, nowMs });
    writeMigrationPhase({
      agentId,
      migrationId,
      source,
      planHash: plan.planHash,
      phase: "copied",
      classificationJson: createProgressClassification({
        migrationId,
        source,
        actor,
        phase: "copied",
      }),
      nowMs,
    });
    writeMigrationPhase({
      agentId,
      migrationId,
      source,
      planHash: plan.planHash,
      phase: "indexed",
      classificationJson: createProgressClassification({
        migrationId,
        source,
        actor,
        phase: "indexed",
      }),
      nowMs,
    });
    verifyDestination({ agentId, source, destination, actor, nowMs });
    const evidence = createEvidence({ migrationId, source, actor, backupHash, destination, nowMs });
    writeMigrationPhase({
      agentId,
      migrationId,
      source,
      planHash: plan.planHash,
      phase: "verified",
      classificationJson: createEvidenceClassification(evidence),
      verifiedAt: nowMs,
      nowMs,
    });
  }
  return Object.freeze({
    migrationId,
    planHash: plan.planHash,
    verifiedSources: Object.freeze(
      sources.map((source) =>
        Object.freeze({ sourceKind: source.sourceKind, sourceHash: source.sourceHash }),
      ),
    ),
  });
}

/** Tombstone copied resources before final cutover. Backups and original legacy sources remain intact. */
export function rollbackFinalScopedMemoryMigration(params: {
  agentId: string;
  migrationId: string;
  result: FinalScopedMemoryMigrationResult;
  nowMs?: number;
}): void {
  const agentId = normalizeAgentId(params.agentId);
  const migrationId = requiredText(params.migrationId, "id");
  if (migrationId !== params.result.migrationId) {
    throw new Error("memory isolation rollback migration id does not match the verified plan");
  }
  const nowMs = params.nowMs ?? Date.now();
  const sources = [...params.result.verifiedSources].toSorted((left, right) =>
    `${left.sourceKind}\0${left.sourceHash}`.localeCompare(
      `${right.sourceKind}\0${right.sourceHash}`,
    ),
  );
  if (
    sources.length === 0 ||
    sources.some(
      (source, index) =>
        !SHA256_PATTERN.test(source.sourceHash) ||
        (index > 0 &&
          source.sourceKind === sources[index - 1]?.sourceKind &&
          source.sourceHash === sources[index - 1]?.sourceHash),
    )
  ) {
    throw new Error("memory isolation rollback sources are invalid");
  }
  withScopedMemoryDatabase(agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    runSqliteImmediateTransactionSync(database, () => {
      for (const source of sources) {
        const row = executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("memory_migrations")
            .select(["classification_json", "phase", "plan_hash", "cutover_at"])
            .where("source_kind", "=", source.sourceKind)
            .where("source_hash", "=", source.sourceHash),
        );
        const evidence = row ? parseArchiveEvidence(row.classification_json) : undefined;
        if (
          !row ||
          row.plan_hash !== params.result.planHash ||
          row.cutover_at !== null ||
          (row.phase !== "verified" && row.phase !== "backed-up") ||
          !evidence ||
          evidence.migrationId !== migrationId ||
          evidence.source.kind !== source.sourceKind ||
          evidence.source.hash !== source.sourceHash
        ) {
          throw new Error("memory isolation rollback requires a fully verified pre-cutover plan");
        }
        const retired = executeSqliteQuerySync(
          database,
          db
            .updateTable("memory_resource_revisions as revision")
            .set({ lifecycle_state: "tombstoned", retired_at: nowMs })
            .where("revision.revision_id", "=", evidence.destination.revisionId)
            .where(
              "revision.resource_id",
              "in",
              db
                .selectFrom("memory_resources")
                .select("resource_id")
                .where("agent_id", "=", agentId),
            )
            .where("revision.lifecycle_state", "in", ["active", "quarantined"]),
        );
        if (retired.numAffectedRows === 0n) {
          const revision = executeSqliteQueryTakeFirstSync(
            database,
            db
              .selectFrom("memory_resource_revisions")
              .select("lifecycle_state")
              .where("revision_id", "=", evidence.destination.revisionId),
          );
          if (revision?.lifecycle_state !== "tombstoned") {
            throw new Error("memory isolation rollback source has no recoverable scoped revision");
          }
        } else if (retired.numAffectedRows !== 1n) {
          throw new Error(
            "memory isolation rollback source changed before its scoped revision was retired",
          );
        }
        executeSqliteQuerySync(
          database,
          db
            .updateTable("memory_migrations")
            .set({ phase: "backed-up", verified_at: null, updated_at: nowMs })
            .where("source_kind", "=", source.sourceKind)
            .where("source_hash", "=", source.sourceHash)
            .where("phase", "=", "verified"),
        );
      }
    });
  });
}

/**
 * Doctor recovery has no source bytes to rediscover. It therefore reads only the durable verified
 * manifest, retires exactly those copied revisions, and leaves both backups and legacy files intact.
 */
export function rollbackFinalScopedMemoryMigrationByPlan(params: {
  agentId: string;
  migrationId: string;
  planHash: string;
  nowMs?: number;
}): void {
  const agentId = normalizeAgentId(params.agentId);
  const migrationId = requiredText(params.migrationId, "id");
  const planHash = requiredText(params.planHash, "reviewed plan hash");
  if (!SHA256_PATTERN.test(planHash)) {
    throw new Error("memory isolation rollback plan hash is invalid");
  }
  const verifiedSources = withScopedMemoryDatabase(agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const rows = executeSqliteQuerySync(
      database,
      db
        .selectFrom("memory_migrations")
        .select([
          "migration_id",
          "source_kind",
          "source_hash",
          "phase",
          "classification_json",
          "plan_hash",
          "verified_at",
          "cutover_at",
        ])
        .where("plan_hash", "=", planHash),
    ).rows;
    if (rows.length === 0) {
      throw new Error("memory isolation rollback plan is unavailable");
    }
    if (rows.length === 1 && rows[0]?.source_kind === EMPTY_LEGACY_CORPUS_SOURCE_KIND) {
      const receipt = rows[0];
      if (
        !isVerifiedEmptyLegacyCorpusReceipt({
          migrationId,
          planHash,
          row: receipt,
          phase: "verified",
        })
      ) {
        throw new Error("memory isolation rollback requires a fully verified pre-cutover plan");
      }
      const deleted = executeSqliteQuerySync(
        database,
        db
          .deleteFrom("memory_migrations")
          .where("source_kind", "=", receipt.source_kind)
          .where("source_hash", "=", receipt.source_hash)
          .where("phase", "=", "verified")
          .where("plan_hash", "=", planHash),
      );
      if (deleted.numAffectedRows !== 1n) {
        throw new Error("memory isolation rollback empty corpus receipt changed concurrently");
      }
      return [];
    }
    return rows.map((row) => {
      const evidence = parseArchiveEvidence(row.classification_json);
      if (
        (row.phase !== "verified" && row.phase !== "backed-up") ||
        row.cutover_at !== null ||
        !evidence ||
        evidence.migrationId !== migrationId ||
        evidence.source.kind !== row.source_kind ||
        evidence.source.hash !== row.source_hash
      ) {
        throw new Error("memory isolation rollback requires a fully verified pre-cutover plan");
      }
      return Object.freeze({ sourceKind: row.source_kind, sourceHash: row.source_hash });
    });
  });
  if (verifiedSources.length === 0) {
    return;
  }
  rollbackFinalScopedMemoryMigration({
    agentId,
    migrationId,
    result: Object.freeze({
      migrationId,
      planHash,
      verifiedSources: Object.freeze(verifiedSources),
    }),
    ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
  });
}

function archiveDirectory(params: { agentId: string; migrationId: string }): string {
  const databasePath = resolveOpenClawAgentSqlitePath({ agentId: params.agentId });
  return path.join(
    path.dirname(databasePath),
    "memory-migration-archive",
    "v1",
    opaqueId(params.migrationId),
  );
}

function sourceHashForArchive(source: FinalScopedMemoryMigrationSource): {
  sourceId: string;
  sourceKind: string;
  sourceHash: string;
  contentHash: string;
  content: string;
  sourcePath: string;
} {
  const normalized = normalizeSource(source);
  if (!normalized.sourcePath) {
    throw new Error("memory isolation archival requires the original legacy source path");
  }
  const contentHash = sha256(normalized.content);
  return {
    sourceId: normalized.sourceId,
    sourceKind: normalized.sourceKind,
    sourceHash: sha256(`${normalized.sourceId}\0${normalized.sourceKind}\0${contentHash}`),
    contentHash,
    content: normalized.content,
    sourcePath: normalized.sourcePath,
  };
}

function resolveLegacyIndexSource(sourceKind: string): "memory" | "sessions" {
  switch (sourceKind) {
    case "legacy-workspace-markdown":
    case "legacy-memory-markdown":
      return "memory";
    case "legacy-transcript":
      return "sessions";
    default:
      throw new Error("memory isolation archival source kind is not supported");
  }
}

function hasLegacyIndexTable(database: DatabaseSync, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?")
      .get(table),
  );
}

/**
 * The legacy FTS/vector tables are SQLite virtual-table primitives, not Kysely schema tables.
 * Remove every exact path/source projection before deleting the canonical legacy rows.
 */
function deleteLegacyIndexArtifacts(params: {
  database: DatabaseSync;
  db: ReturnType<typeof getNodeSqliteKysely<LegacyIndexDatabase>>;
  path: string;
  source: "memory" | "sessions";
}): void {
  const chunks = executeSqliteQuerySync(
    params.database,
    params.db
      .selectFrom("memory_index_chunks")
      .select("id")
      .where("path", "=", params.path)
      .where("source", "=", params.source),
  ).rows;
  if (hasLegacyIndexTable(params.database, "memory_index_chunks_fts")) {
    params.database
      .prepare("DELETE FROM memory_index_chunks_fts WHERE path = ? AND source = ?")
      .run(params.path, params.source);
  }
  if (hasLegacyIndexTable(params.database, "memory_index_paths_fts")) {
    params.database
      .prepare("DELETE FROM memory_index_paths_fts WHERE path = ? AND source = ?")
      .run(params.path, params.source);
  }
  for (const chunk of chunks) {
    if (hasLegacyIndexTable(params.database, "memory_index_chunks_vec")) {
      params.database.prepare("DELETE FROM memory_index_chunks_vec WHERE id = ?").run(chunk.id);
    }
    params.database
      .prepare("DELETE FROM memory_index_chunk_recall_metadata WHERE chunk_id = ?")
      .run(chunk.id);
    params.database
      .prepare("DELETE FROM memory_index_chunk_provenance WHERE chunk_id = ?")
      .run(chunk.id);
  }
  executeSqliteQuerySync(
    params.database,
    params.db
      .deleteFrom("memory_index_chunks")
      .where("path", "=", params.path)
      .where("source", "=", params.source),
  );
  executeSqliteQuerySync(
    params.database,
    params.db
      .deleteFrom("memory_index_sources")
      .where("path", "=", params.path)
      .where("source", "=", params.source),
  );
}

function normalizeArchiveCutover(
  cutover: FinalScopedMemoryMigrationCutover,
): FinalScopedMemoryMigrationCutover {
  const migrationId = requiredText(cutover.migrationId, "cutover migration id");
  const planHash = requiredText(cutover.planHash, "cutover plan hash");
  if (!SHA256_PATTERN.test(planHash)) {
    throw new Error("memory isolation archival cutover grant is invalid");
  }
  const sources = cutover.sources
    .map((source) =>
      Object.freeze({
        sourceKind: requiredText(source.sourceKind, "cutover source kind"),
        sourceHash: requiredText(source.sourceHash, "cutover source hash"),
      }),
    )
    .toSorted((left, right) =>
      `${left.sourceKind}\0${left.sourceHash}`.localeCompare(
        `${right.sourceKind}\0${right.sourceHash}`,
      ),
    );
  if (
    sources.some(
      (source, index) =>
        !SHA256_PATTERN.test(source.sourceHash) ||
        (index > 0 &&
          source.sourceKind === sources[index - 1]?.sourceKind &&
          source.sourceHash === sources[index - 1]?.sourceHash),
    )
  ) {
    throw new Error("memory isolation archival cutover sources are invalid");
  }
  return Object.freeze({ migrationId, planHash, sources: Object.freeze(sources) });
}

function verifyArchiveCutoverGrant(params: {
  agentId: string;
  cutover: FinalScopedMemoryMigrationCutover;
}): ReadonlySet<string> {
  const cutover = normalizeArchiveCutover(params.cutover);
  const expected = new Set(
    cutover.sources.map((source) => `${source.sourceKind}\0${source.sourceHash}`),
  );
  withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const rows = executeSqliteQuerySync(
      database,
      db
        .selectFrom("memory_migrations")
        .select([
          "migration_id",
          "source_kind",
          "source_hash",
          "phase",
          "plan_hash",
          "classification_json",
          "verified_at",
          "cutover_at",
        ])
        .where("plan_hash", "=", cutover.planHash)
        .where("source_kind", "!=", "memory-isolation-final-cutover"),
    ).rows;
    if (cutover.sources.length === 0) {
      const receipt = rows.length === 1 ? rows[0] : undefined;
      if (
        !receipt ||
        !isVerifiedEmptyLegacyCorpusReceipt({
          migrationId: cutover.migrationId,
          planHash: cutover.planHash,
          row: receipt,
          phase: "cutover",
        })
      ) {
        throw new Error("memory isolation archival cutover grant does not match the durable plan");
      }
      return;
    }
    if (rows.length !== expected.size) {
      throw new Error("memory isolation archival cutover grant does not match the durable plan");
    }
    for (const row of rows) {
      const evidence = parseArchiveEvidence(row.classification_json);
      if (
        row.phase !== "cutover" ||
        !expected.delete(`${row.source_kind}\0${row.source_hash}`) ||
        !evidence ||
        evidence.migrationId !== cutover.migrationId ||
        evidence.source.kind !== row.source_kind ||
        evidence.source.hash !== row.source_hash
      ) {
        throw new Error("memory isolation archival cutover grant does not match the durable plan");
      }
    }
  });
  if (expected.size > 0) {
    throw new Error("memory isolation archival cutover grant does not match the durable plan");
  }
  return new Set(cutover.sources.map((source) => `${source.sourceKind}\0${source.sourceHash}`));
}

/** A source omitted from discovery must never let Doctor report a partial archive as complete. */
function assertArchiveCutoverComplete(params: {
  agentId: string;
  cutover: FinalScopedMemoryMigrationCutover;
}): void {
  const cutover = normalizeArchiveCutover(params.cutover);
  const expected = verifyArchiveCutoverGrant({ agentId: params.agentId, cutover });
  if (cutover.sources.length === 0) {
    return;
  }
  withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const rows = executeSqliteQuerySync(
      database,
      db
        .selectFrom("memory_migrations")
        .select(["source_kind", "source_hash", "classification_json"])
        .where("plan_hash", "=", cutover.planHash)
        .where("source_kind", "!=", "memory-isolation-final-cutover"),
    ).rows;
    if (rows.length !== expected.size) {
      throw new Error("memory isolation archival cutover grant does not match the durable plan");
    }
    for (const row of rows) {
      const evidence = parseArchiveEvidence(row.classification_json);
      if (
        !expected.delete(`${row.source_kind}\0${row.source_hash}`) ||
        !evidence ||
        evidence.migrationId !== cutover.migrationId ||
        evidence.archive.state !== "archived"
      ) {
        throw new Error(
          "memory isolation archival is incomplete; restore the missing legacy source from its verified backup before retrying",
        );
      }
    }
  });
  if (expected.size > 0) {
    throw new Error(
      "memory isolation archival is incomplete; restore the missing legacy source from its verified backup before retrying",
    );
  }
}

function ensureArchivedSource(params: {
  source: ReturnType<typeof sourceHashForArchive>;
  target: string;
}): void {
  const current = fs.lstatSync(params.source.sourcePath);
  if (current.isSymbolicLink() || !current.isFile()) {
    throw new Error("memory isolation archive source is unsafe");
  }
  if (sha256(fs.readFileSync(params.source.sourcePath, "utf8")) !== params.source.contentHash) {
    throw new Error("memory isolation archive source changed after verification");
  }
  if (fs.existsSync(params.target)) {
    if (sha256(fs.readFileSync(params.target, "utf8")) !== params.source.contentHash) {
      throw new Error("memory isolation archive contains different source bytes");
    }
    fs.unlinkSync(params.source.sourcePath);
    return;
  }
  try {
    fs.renameSync(params.source.sourcePath, params.target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
    fs.writeFileSync(params.target, params.source.content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.unlinkSync(params.source.sourcePath);
  }
  if (sha256(fs.readFileSync(params.target, "utf8")) !== params.source.contentHash) {
    throw new Error("memory isolation archive hash verification failed");
  }
}

function finalizeInterruptedArchives(params: {
  agentId: string;
  cutover: FinalScopedMemoryMigrationCutover;
  nowMs: number;
}): void {
  const cutover = normalizeArchiveCutover(params.cutover);
  const directory = archiveDirectory({ agentId: params.agentId, migrationId: cutover.migrationId });
  const rows = withScopedMemoryDatabase(params.agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    return executeSqliteQuerySync(
      database,
      db
        .selectFrom("memory_migrations")
        .select(["source_kind", "source_hash", "classification_json"])
        .where("plan_hash", "=", cutover.planHash)
        .where("phase", "=", "cutover"),
    ).rows;
  });
  for (const row of rows) {
    const evidence = parseArchiveEvidence(row.classification_json);
    if (evidence?.migrationId !== cutover.migrationId || evidence.archive.state !== "archiving") {
      continue;
    }
    const target = path.join(directory, `${evidence.source.id}.archive`);
    if (!fs.existsSync(target)) {
      throw new Error(
        "memory isolation archival is incomplete; the retained source artifact is missing",
      );
    }
    if (sha256(fs.readFileSync(target, "utf8")) !== evidence.source.contentHash) {
      throw new Error("memory isolation archival recovery hash verification failed");
    }
    const archivedEvidence: SourceEvidence = Object.freeze({
      ...evidence,
      archive: Object.freeze({ state: "archived", artifactHash: evidence.source.contentHash }),
    });
    const classificationJson = createEvidenceClassification(archivedEvidence);
    withScopedMemoryDatabase(params.agentId, (database) => {
      const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
      const updated = executeSqliteQuerySync(
        database,
        db
          .updateTable("memory_migrations")
          .set({ classification_json: classificationJson, updated_at: params.nowMs })
          .where("source_kind", "=", row.source_kind)
          .where("source_hash", "=", row.source_hash)
          .where("phase", "=", "cutover")
          .where("classification_json", "=", row.classification_json),
      );
      if (updated.numAffectedRows !== 1n) {
        throw new Error("memory isolation archival recovery changed concurrently");
      }
    });
  }
}

/**
 * Archive only after core has atomically cut over. The verified backup remains untouched; the
 * original source is moved under an opaque retention root and its legacy index rows are removed.
 */
export function archiveFinalScopedMemoryMigration(params: {
  agentId: string;
  migrationId: string;
  cutover: FinalScopedMemoryMigrationCutover;
  sources: readonly FinalScopedMemoryMigrationSource[];
  nowMs?: number;
}): void {
  const agentId = normalizeAgentId(params.agentId);
  const migrationId = requiredText(params.migrationId, "id");
  const cutover = normalizeArchiveCutover(params.cutover);
  if (cutover.migrationId !== migrationId) {
    throw new Error(
      "memory isolation archival migration id does not match the verified final cutover",
    );
  }
  const nowMs = params.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("memory isolation archive time is invalid");
  }
  const expectedSources = verifyArchiveCutoverGrant({ agentId, cutover });
  // A prior crash can have moved a source after durable archiving state was written. Finalize
  // that exact artifact before rediscovery so a retry does not require its vanished source path.
  finalizeInterruptedArchives({ agentId, cutover, nowMs });
  for (const sourceInput of params.sources) {
    const source = sourceHashForArchive(sourceInput);
    if (!expectedSources.has(`${source.sourceKind}\0${source.sourceHash}`)) {
      throw new Error("memory isolation archival source is not part of the verified final cutover");
    }
    const row = withScopedMemoryDatabase(agentId, (database) => {
      const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
      return executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_migrations")
          .select(["phase", "classification_json"])
          .where("source_kind", "=", source.sourceKind)
          .where("source_hash", "=", source.sourceHash),
      );
    });
    if (!row) {
      throw new Error(
        "memory isolation archival source is missing from the verified final cutover",
      );
    }
    if (row.phase !== "cutover") {
      throw new Error("memory isolation archives only after the final cutover marker");
    }
    const evidence = parseArchiveEvidence(row.classification_json);
    if (
      !evidence ||
      evidence.migrationId !== migrationId ||
      evidence.source?.id !== source.sourceId ||
      evidence.source.kind !== source.sourceKind ||
      evidence.source.hash !== source.sourceHash ||
      evidence.source.contentHash !== source.contentHash
    ) {
      throw new Error("memory isolation archival evidence does not match the verified source");
    }
    if (evidence.archive?.state === "archived") {
      continue;
    }
    const directory = archiveDirectory({ agentId, migrationId });
    const target = path.join(directory, `${source.sourceId}.archive`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let archivingJson = row.classification_json;
    if (evidence.archive?.state === "pending") {
      const archivingEvidence: SourceEvidence = Object.freeze({
        ...evidence,
        archive: Object.freeze({ state: "archiving" }),
      });
      archivingJson = createEvidenceClassification(archivingEvidence);
      const legacyIndexSource = resolveLegacyIndexSource(source.sourceKind);
      withScopedMemoryDatabase(agentId, (database) => {
        const db = getNodeSqliteKysely<LegacyIndexDatabase>(database);
        runSqliteImmediateTransactionSync(database, () => {
          const updated = executeSqliteQuerySync(
            database,
            db
              .updateTable("memory_migrations")
              .set({ classification_json: archivingJson, updated_at: nowMs })
              .where("source_kind", "=", source.sourceKind)
              .where("source_hash", "=", source.sourceHash)
              .where("phase", "=", "cutover")
              .where("classification_json", "=", row.classification_json),
          );
          if (updated.numAffectedRows !== 1n) {
            throw new Error("memory isolation source changed before archival began");
          }
          deleteLegacyIndexArtifacts({
            database,
            db,
            path: source.sourcePath,
            source: legacyIndexSource,
          });
        });
      });
    } else if (evidence.archive?.state !== "archiving") {
      throw new Error("memory isolation archival recovery did not complete");
    }
    ensureArchivedSource({ source, target });
    const archivedEvidence: SourceEvidence = Object.freeze({
      ...evidence,
      archive: Object.freeze({ state: "archived", artifactHash: source.contentHash }),
    });
    const classificationJson = createEvidenceClassification(archivedEvidence);
    withScopedMemoryDatabase(agentId, (database) => {
      const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
      const updated = executeSqliteQuerySync(
        database,
        db
          .updateTable("memory_migrations")
          .set({ classification_json: classificationJson, updated_at: nowMs })
          .where("source_kind", "=", source.sourceKind)
          .where("source_hash", "=", source.sourceHash)
          .where("phase", "=", "cutover")
          .where("classification_json", "=", archivingJson),
      );
      if (updated.numAffectedRows !== 1n) {
        throw new Error("memory isolation source changed before archival metadata committed");
      }
    });
  }
  finalizeInterruptedArchives({ agentId, cutover, nowMs });
  assertArchiveCutoverComplete({ agentId, cutover });
}

export type FinalScopedMemoryDowngradeExport = Readonly<{
  outputDir: string;
  exportedResources: number;
  excludedQuarantineResources: number;
  warning: string;
}>;

/**
 * Export is deliberately the only post-cutover downgrade aid. It never clears the marker or
 * restores legacy runtime reads, and the manifest states that audience/policy metadata is absent.
 */
export function exportFinalScopedMemoryMigration(params: {
  agentId: string;
  migrationId: string;
  outputDir: string;
  cutover: FinalScopedMemoryMigrationCutover;
  nowMs?: number;
}): FinalScopedMemoryDowngradeExport {
  const agentId = normalizeAgentId(params.agentId);
  const migrationId = requiredText(params.migrationId, "id");
  const cutover = normalizeArchiveCutover(params.cutover);
  if (cutover.migrationId !== migrationId) {
    throw new Error(
      "memory isolation downgrade export migration id does not match the verified final cutover",
    );
  }
  verifyArchiveCutoverGrant({ agentId, cutover });
  const outputDir = path.resolve(requiredText(params.outputDir, "export directory"));
  const nowMs = params.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("memory isolation export time is invalid");
  }
  try {
    fs.mkdirSync(outputDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("memory isolation downgrade export directory must not already exist");
    }
    throw error;
  }
  try {
    const resources = withScopedMemoryDatabase(agentId, (database) => {
      const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
      return executeSqliteQuerySync(
        database,
        db
          .selectFrom("memory_resource_revisions as revision")
          .innerJoin("memory_resources as resource", "resource.resource_id", "revision.resource_id")
          .select(["resource.store_id", "revision.revision_id", "revision.lifecycle_state"])
          .where("resource.agent_id", "=", agentId)
          .where("revision.lifecycle_state", "in", ["active", "quarantined"])
          .orderBy("revision.revision_id"),
      ).rows;
    });
    const exported: Array<{
      revisionId: string;
      contentHash: string;
      bytes: number;
      file: string;
    }> = [];
    let excludedQuarantineResources = 0;
    for (const resource of resources) {
      if (resource.lifecycle_state === "quarantined") {
        excludedQuarantineResources += 1;
        continue;
      }
      const snapshot = readBuiltinScopedMemoryRevisionSnapshot({
        agentId,
        storeIds: [resource.store_id],
        revisionId: resource.revision_id,
        nowMs,
      });
      if (!snapshot) {
        throw new Error(
          "memory isolation downgrade export could not verify an active scoped resource",
        );
      }
      const file = `${snapshot.revisionId}.md`;
      const target = path.join(outputDir, file);
      fs.writeFileSync(target, snapshot.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      if (sha256(fs.readFileSync(target, "utf8")) !== sha256(snapshot.content)) {
        throw new Error("memory isolation downgrade export hash verification failed");
      }
      exported.push({
        revisionId: snapshot.revisionId,
        contentHash: sha256(snapshot.content),
        bytes: snapshot.contentBytes,
        file,
      });
    }
    const warning =
      "This explicit downgrade export intentionally omits audience, policy, identity, lineage, and audit metadata. It cannot re-enable legacy runtime reads automatically.";
    fs.writeFileSync(
      path.join(outputDir, "manifest.json"),
      `${JSON.stringify(
        {
          version: 1,
          migrationId,
          createdAt: nowMs,
          warning,
          exported,
          excludedQuarantineResources,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    return Object.freeze({
      outputDir,
      exportedResources: exported.length,
      excludedQuarantineResources,
      warning,
    });
  } catch (error) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Discover only known legacy sources. This decides nothing about audience or ownership: callers
 * must provide an owner/admin decision, and the default remains quarantine.
 */
export function discoverFinalScopedMemoryMigrationSources(params: {
  agentId: string;
  workspaceDir: string;
  stateDir: string;
}): readonly FinalScopedMemoryMigrationSource[] {
  const agentId = normalizeAgentId(params.agentId);
  const candidates: Array<{ sourceKind: string; pathname: string }> = [];
  const addRegularFiles = (
    sourceKind: string,
    directory: string,
    predicate: (name: string) => boolean,
  ) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !predicate(entry.name)) {
        continue;
      }
      candidates.push({ sourceKind, pathname: path.join(directory, entry.name) });
    }
  };
  const addRegularFilesRecursively = (
    sourceKind: string,
    directory: string,
    predicate: (name: string) => boolean,
  ) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        addRegularFilesRecursively(sourceKind, pathname, predicate);
      } else if (entry.isFile() && !entry.isSymbolicLink() && predicate(entry.name)) {
        candidates.push({ sourceKind, pathname });
      }
    }
  };
  addRegularFiles("legacy-workspace-markdown", params.workspaceDir, (name) => name.endsWith(".md"));
  addRegularFilesRecursively(
    "legacy-memory-markdown",
    path.join(params.workspaceDir, "memory"),
    (name) => name.endsWith(".md"),
  );
  addRegularFiles(
    "legacy-transcript",
    path.join(params.stateDir, "agents", agentId, "sessions"),
    (name) => name.endsWith(".jsonl"),
  );
  return Object.freeze(
    candidates.map((candidate) => {
      const content = fs.readFileSync(candidate.pathname, "utf8");
      const sourceId = opaqueId(`${agentId}\0${candidate.sourceKind}\0${candidate.pathname}`);
      return normalizeSource({
        sourceId,
        sourceKind: candidate.sourceKind,
        content,
        sourcePath: candidate.pathname,
      });
    }),
  );
}

export const finalScopedMemoryMigrationTestApi = {
  createEvidenceClassification,
  discoverFinalScopedMemoryMigrationSources,
  sha256,
  SOURCE_KIND,
  SHA256_PATTERN,
};
