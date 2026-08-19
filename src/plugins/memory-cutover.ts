import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { DB as OpenClawAgentDatabaseSchema } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";
import { ensureOpenClawAgentScopedMemorySchema } from "../state/openclaw-agent-scoped-memory-schema.js";
import { AGENT_SESSION_MEMORY_SCHEMA_SQL } from "../state/openclaw-agent-session-memory-schema.js";

type MemoryCutoverDatabase = Pick<
  OpenClawAgentDatabaseSchema,
  "memory_migrations" | "session_memory_subjects"
>;

export type MemoryIsolationMode = "legacy" | "shadow-read-only" | "cutover" | "unavailable";

const SHADOW_READ_ONLY_MIGRATION_ID = "memory-isolation-shadow-read-only-v1";
const SHADOW_READ_ONLY_SOURCE_KIND = "memory-isolation-shadow-read-only";
const SHADOW_READ_ONLY_SOURCE_HASH = "sha256:67d7363a5c0c72aae82474c9903b1444";
const SHADOW_READ_ONLY_CLASSIFICATION_VERSION = 2;
const FINAL_CUTOVER_MIGRATION_ID = "memory-isolation-final-cutover-v1";
const FINAL_CUTOVER_SOURCE_KIND = "memory-isolation-final-cutover";
const FINAL_CUTOVER_CLASSIFICATION_VERSION = 1;
const EMPTY_LEGACY_CORPUS_SOURCE_KIND = "memory-isolation-empty-legacy-corpus";
const EMPTY_LEGACY_CORPUS_VERSION = 1;
const PILOT_SUBJECT_KINDS = new Set(["user", "conversation", "service", "agent", "system"]);

type ShadowPilotSubject = Readonly<{
  kind: "user" | "conversation" | "service" | "agent" | "system";
  principalId: string;
}>;

type MemoryIsolationSnapshot = Readonly<{
  mode: MemoryIsolationMode;
  pilotSubject?: ShadowPilotSubject;
}>;

type MemoryIsolationMarker = Readonly<{
  migration_id: string;
  source_kind: string;
  source_hash: string;
  phase: string;
  classification_json: string;
  plan_hash: string;
  verified_at: number | null;
  cutover_at: number | null;
}>;

export type VerifiedMemoryMigrationSource = Readonly<{
  sourceKind: string;
  sourceHash: string;
}>;

type FinalCutoverManifest = Readonly<{
  migrationId: string;
  sources: readonly VerifiedMemoryMigrationSource[];
}>;

/** The only archive grant core gives a selected plugin after validating the durable final marker. */
export type VerifiedMemoryIsolationFinalCutover = Readonly<{
  migrationId: string;
  planHash: string;
  sources: readonly VerifiedMemoryMigrationSource[];
}>;

type FinalMigrationSourceEvidence = Readonly<{
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

const FINAL_SOURCE_EVIDENCE_VERSION = 1;
const SHA256_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

// The gateway reads one process-stable snapshot. Doctor mutations take effect after restart, so
// a transient authority-store failure can never reopen legacy filesystem memory in a live run.
const snapshotByAgentId = new Map<string, MemoryIsolationSnapshot>();

function hashClassification(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeFinalCutoverText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("\0")) {
    throw new Error(`memory isolation ${label} is required`);
  }
  return normalized;
}

function normalizeFinalMigrationHash(value: string, label: string): string {
  const normalized = normalizeFinalCutoverText(value, label);
  if (!SHA256_HASH_PATTERN.test(normalized)) {
    throw new Error(`memory isolation ${label} must be a sha256 digest`);
  }
  return normalized;
}

function normalizeFinalMigrationBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("memory isolation source byte count is invalid");
  }
  return value;
}

function createFinalMigrationSourceClassification(evidence: FinalMigrationSourceEvidence): string {
  return JSON.stringify({
    mode: "memory-isolation-source",
    version: FINAL_SOURCE_EVIDENCE_VERSION,
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

function parseFinalMigrationSourceEvidence(
  classificationJson: string,
): FinalMigrationSourceEvidence | undefined {
  try {
    const record = asOptionalRecord(JSON.parse(classificationJson));
    const source = asOptionalRecord(record?.source);
    const decision = asOptionalRecord(record?.decision);
    const backup = asOptionalRecord(record?.backup);
    const destination = asOptionalRecord(record?.destination);
    const verification = asOptionalRecord(record?.verification);
    const archive = asOptionalRecord(record?.archive);
    if (
      record?.mode !== "memory-isolation-source" ||
      record.version !== FINAL_SOURCE_EVIDENCE_VERSION ||
      typeof record.migrationId !== "string" ||
      !source ||
      !decision ||
      !backup ||
      !destination ||
      !verification ||
      !archive ||
      verification.hash !== true ||
      verification.mount !== true ||
      verification.denial !== true ||
      verification.catalog !== true ||
      verification.index !== true ||
      typeof source.id !== "string" ||
      typeof source.kind !== "string" ||
      typeof source.hash !== "string" ||
      typeof source.contentHash !== "string" ||
      (decision.placement !== "quarantine" && decision.placement !== "approved") ||
      (decision.actorRole !== "owner" && decision.actorRole !== "admin") ||
      typeof decision.actorId !== "string" ||
      typeof backup.artifactHash !== "string" ||
      typeof backup.contentHash !== "string" ||
      typeof backup.verifiedAt !== "number" ||
      typeof destination.storeId !== "string" ||
      typeof destination.resourceId !== "string" ||
      typeof destination.revisionId !== "string" ||
      typeof destination.contentHash !== "string" ||
      (destination.lifecycleState !== "active" && destination.lifecycleState !== "quarantined") ||
      (archive.state !== "pending" &&
        archive.state !== "archiving" &&
        archive.state !== "archived") ||
      (archive.artifactHash !== undefined && typeof archive.artifactHash !== "string")
    ) {
      return undefined;
    }
    const evidence: FinalMigrationSourceEvidence = Object.freeze({
      migrationId: normalizeFinalCutoverText(record.migrationId, "source migration id"),
      source: Object.freeze({
        id: normalizeFinalCutoverText(source.id, "source id"),
        kind: normalizeFinalCutoverText(source.kind, "source kind"),
        hash: normalizeFinalMigrationHash(source.hash, "source hash"),
        contentHash: normalizeFinalMigrationHash(source.contentHash, "source content hash"),
        bytes: normalizeFinalMigrationBytes(source.bytes),
      }),
      decision: Object.freeze({
        placement: decision.placement,
        actorRole: decision.actorRole,
        actorId: normalizeFinalCutoverText(decision.actorId, "decision actor id"),
      }),
      backup: Object.freeze({
        artifactHash: normalizeFinalMigrationHash(backup.artifactHash, "backup artifact hash"),
        contentHash: normalizeFinalMigrationHash(backup.contentHash, "backup content hash"),
        verifiedAt: normalizeFinalMigrationBytes(backup.verifiedAt),
      }),
      destination: Object.freeze({
        storeId: normalizeFinalCutoverText(destination.storeId, "destination store id"),
        resourceId: normalizeFinalCutoverText(destination.resourceId, "destination resource id"),
        revisionId: normalizeFinalCutoverText(destination.revisionId, "destination revision id"),
        contentHash: normalizeFinalMigrationHash(
          destination.contentHash,
          "destination content hash",
        ),
        lifecycleState: destination.lifecycleState,
      }),
      archive: Object.freeze({
        state: archive.state,
        ...(typeof archive.artifactHash === "string"
          ? {
              artifactHash: normalizeFinalMigrationHash(
                archive.artifactHash,
                "archive artifact hash",
              ),
            }
          : {}),
      }),
    });
    if (
      evidence.backup.artifactHash !== evidence.source.contentHash ||
      evidence.backup.contentHash !== evidence.source.contentHash ||
      evidence.destination.contentHash !== evidence.source.contentHash ||
      (evidence.archive.state === "archived" &&
        evidence.archive.artifactHash !== evidence.source.contentHash) ||
      !hasVerifiedCutoverTime(evidence.backup.verifiedAt) ||
      (evidence.decision.placement === "quarantine") !==
        (evidence.destination.lifecycleState === "quarantined")
    ) {
      return undefined;
    }
    return createFinalMigrationSourceClassification(evidence) === classificationJson
      ? evidence
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeVerifiedMigrationSources(
  sources: readonly VerifiedMemoryMigrationSource[],
): readonly VerifiedMemoryMigrationSource[] {
  const normalized = sources
    .map((source) =>
      Object.freeze({
        sourceKind: normalizeFinalCutoverText(source.sourceKind, "source kind"),
        sourceHash: normalizeFinalMigrationHash(source.sourceHash, "source hash"),
      }),
    )
    .toSorted((left, right) =>
      `${left.sourceKind}\0${left.sourceHash}`.localeCompare(
        `${right.sourceKind}\0${right.sourceHash}`,
      ),
    );
  if (
    normalized.some(
      (source, index) =>
        source.sourceKind === FINAL_CUTOVER_SOURCE_KIND ||
        source.sourceKind === EMPTY_LEGACY_CORPUS_SOURCE_KIND ||
        (index > 0 &&
          source.sourceKind === normalized[index - 1]?.sourceKind &&
          source.sourceHash === normalized[index - 1]?.sourceHash),
    )
  ) {
    throw new Error("memory isolation final cutover sources are invalid");
  }
  return Object.freeze(normalized);
}

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

function isVerifiedEmptyLegacyCorpusReceipt(params: {
  receipt: MemoryIsolationMarker;
  migrationId: string;
  planHash: string;
  phase: "verified" | "cutover";
}): boolean {
  const classificationJson = createEmptyLegacyCorpusClassification({
    migrationId: params.migrationId,
    planHash: params.planHash,
  });
  return (
    params.receipt.migration_id === params.migrationId &&
    params.receipt.source_kind === EMPTY_LEGACY_CORPUS_SOURCE_KIND &&
    params.receipt.source_hash === hashClassification(classificationJson) &&
    params.receipt.phase === params.phase &&
    params.receipt.classification_json === classificationJson &&
    params.receipt.plan_hash === params.planHash &&
    hasVerifiedCutoverTime(params.receipt.verified_at) &&
    (params.phase === "verified"
      ? params.receipt.cutover_at === null
      : hasVerifiedCutoverTime(params.receipt.cutover_at))
  );
}

function createFinalCutoverClassification(manifest: FinalCutoverManifest): string {
  return JSON.stringify({
    mode: "final-cutover",
    version: FINAL_CUTOVER_CLASSIFICATION_VERSION,
    migrationId: manifest.migrationId,
    sources: manifest.sources,
  });
}

function parseFinalCutoverManifest(classificationJson: string): FinalCutoverManifest | undefined {
  try {
    const record = asOptionalRecord(JSON.parse(classificationJson));
    if (
      record?.mode !== "final-cutover" ||
      record.version !== FINAL_CUTOVER_CLASSIFICATION_VERSION ||
      typeof record.migrationId !== "string" ||
      !Array.isArray(record.sources)
    ) {
      return undefined;
    }
    return Object.freeze({
      migrationId: normalizeFinalCutoverText(record.migrationId, "migration id"),
      sources: normalizeVerifiedMigrationSources(
        record.sources.map((source) => {
          const sourceRecord = asOptionalRecord(source);
          if (
            !sourceRecord ||
            typeof sourceRecord.sourceKind !== "string" ||
            typeof sourceRecord.sourceHash !== "string"
          ) {
            throw new Error("memory isolation final cutover source is invalid");
          }
          return {
            sourceKind: sourceRecord.sourceKind,
            sourceHash: sourceRecord.sourceHash,
          };
        }),
      ),
    });
  } catch {
    return undefined;
  }
}

function hasVerifiedCutoverTime(value: number | null): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isVerifiedFinalCutoverMarker(params: {
  database: DatabaseSync;
  marker: MemoryIsolationMarker;
}): boolean {
  const manifest = parseFinalCutoverManifest(params.marker.classification_json);
  if (
    !manifest ||
    params.marker.classification_json !== createFinalCutoverClassification(manifest) ||
    params.marker.migration_id !== FINAL_CUTOVER_MIGRATION_ID ||
    params.marker.source_kind !== FINAL_CUTOVER_SOURCE_KIND ||
    params.marker.source_hash !== hashClassification(params.marker.classification_json) ||
    !SHA256_HASH_PATTERN.test(params.marker.plan_hash) ||
    params.marker.phase !== "cutover" ||
    !hasVerifiedCutoverTime(params.marker.verified_at) ||
    !hasVerifiedCutoverTime(params.marker.cutover_at)
  ) {
    return false;
  }
  const memoryDb = getNodeSqliteKysely<MemoryCutoverDatabase>(params.database);
  const rows = executeSqliteQuerySync(
    params.database,
    memoryDb
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
      .where("plan_hash", "=", params.marker.plan_hash),
  ).rows;
  const expected = new Set(
    manifest.sources.map((source) => `${source.sourceKind}\0${source.sourceHash}`),
  );
  const requiresEmptyCorpusReceipt = manifest.sources.length === 0;
  if (rows.length !== expected.size + 1 + (requiresEmptyCorpusReceipt ? 1 : 0)) {
    return false;
  }
  let manifestFound = false;
  let emptyCorpusReceiptFound = false;
  for (const row of rows) {
    if (row.source_kind === FINAL_CUTOVER_SOURCE_KIND) {
      if (
        manifestFound ||
        row.source_hash !== params.marker.source_hash ||
        row.phase !== "cutover" ||
        !hasVerifiedCutoverTime(row.verified_at) ||
        !hasVerifiedCutoverTime(row.cutover_at)
      ) {
        return false;
      }
      manifestFound = true;
      continue;
    }
    if (row.source_kind === EMPTY_LEGACY_CORPUS_SOURCE_KIND) {
      if (
        emptyCorpusReceiptFound ||
        !requiresEmptyCorpusReceipt ||
        !isVerifiedEmptyLegacyCorpusReceipt({
          receipt: row,
          migrationId: manifest.migrationId,
          planHash: params.marker.plan_hash,
          phase: "cutover",
        })
      ) {
        return false;
      }
      emptyCorpusReceiptFound = true;
      continue;
    }
    if (
      row.phase !== "cutover" ||
      !expected.delete(`${row.source_kind}\0${row.source_hash}`) ||
      !hasVerifiedCutoverTime(row.verified_at) ||
      !hasVerifiedCutoverTime(row.cutover_at)
    ) {
      return false;
    }
    const evidence = parseFinalMigrationSourceEvidence(row.classification_json);
    if (
      !evidence ||
      evidence.migrationId !== manifest.migrationId ||
      evidence.source.kind !== row.source_kind ||
      evidence.source.hash !== row.source_hash
    ) {
      return false;
    }
  }
  return (
    manifestFound && expected.size === 0 && emptyCorpusReceiptFound === requiresEmptyCorpusReceipt
  );
}

function parseShadowPilotSubject(classificationJson: string): ShadowPilotSubject | undefined {
  try {
    const parsed = JSON.parse(classificationJson) as {
      mode?: unknown;
      version?: unknown;
      subject?: { kind?: unknown; principalId?: unknown };
    };
    if (
      parsed.mode !== "shadow-read-only" ||
      parsed.version !== SHADOW_READ_ONLY_CLASSIFICATION_VERSION ||
      !PILOT_SUBJECT_KINDS.has(String(parsed.subject?.kind)) ||
      typeof parsed.subject?.principalId !== "string" ||
      !parsed.subject.principalId.trim()
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: parsed.subject.kind as ShadowPilotSubject["kind"],
      principalId: parsed.subject.principalId.trim(),
    });
  } catch {
    return undefined;
  }
}

function createShadowClassification(subject: ShadowPilotSubject): string {
  return JSON.stringify({
    mode: "shadow-read-only",
    version: SHADOW_READ_ONLY_CLASSIFICATION_VERSION,
    subject,
  });
}

function isVerifiedShadowReadOnlyMarker(
  marker: MemoryIsolationMarker,
): ShadowPilotSubject | undefined {
  const pilotSubject = parseShadowPilotSubject(marker.classification_json);
  return marker.migration_id === SHADOW_READ_ONLY_MIGRATION_ID &&
    marker.source_kind === SHADOW_READ_ONLY_SOURCE_KIND &&
    marker.source_hash === SHADOW_READ_ONLY_SOURCE_HASH &&
    marker.phase === "verified" &&
    marker.plan_hash === hashClassification(marker.classification_json) &&
    typeof marker.verified_at === "number" &&
    Number.isSafeInteger(marker.verified_at) &&
    marker.verified_at > 0 &&
    marker.cutover_at === null &&
    pilotSubject
    ? pilotSubject
    : undefined;
}

function resolveMemoryIsolationSnapshotInDatabase(db: DatabaseSync): MemoryIsolationSnapshot {
  ensureOpenClawAgentScopedMemorySchema(db);
  db.exec(AGENT_SESSION_MEMORY_SCHEMA_SQL); // sqlite-allow-raw -- Existing additive subject DDL.
  const memoryDb = getNodeSqliteKysely<MemoryCutoverDatabase>(db);
  const cutovers = executeSqliteQuerySync(
    db,
    memoryDb
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
      .where("source_kind", "=", FINAL_CUTOVER_SOURCE_KIND),
  ).rows;
  if (cutovers.length > 0) {
    return cutovers.length === 1 &&
      isVerifiedFinalCutoverMarker({ database: db, marker: cutovers[0]! })
      ? { mode: "cutover" }
      : { mode: "unavailable" };
  }
  const shadow = executeSqliteQueryTakeFirstSync(
    db,
    memoryDb
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
      .where("source_kind", "=", SHADOW_READ_ONLY_SOURCE_KIND)
      .limit(1),
  );
  if (!shadow) {
    return { mode: "legacy" };
  }
  const pilotSubject = isVerifiedShadowReadOnlyMarker(shadow);
  return pilotSubject ? { mode: "shadow-read-only", pilotSubject } : { mode: "unavailable" };
}

function resolveMemoryIsolationSnapshotFromDatabase(params: {
  agentId: string;
  options?: OpenClawAgentDatabaseOptions;
}): MemoryIsolationSnapshot {
  const database = openOpenClawAgentDatabase({
    ...params.options,
    agentId: params.agentId,
  });
  return resolveMemoryIsolationSnapshotInDatabase(database.db);
}

function readMemoryIsolationSnapshot(
  agentIdInput: string,
  options?: OpenClawAgentDatabaseOptions,
): MemoryIsolationSnapshot {
  const agentId = agentIdInput.trim();
  if (!agentId) {
    return { mode: "unavailable" };
  }
  const cached = snapshotByAgentId.get(agentId);
  if (cached) {
    return cached;
  }
  try {
    const snapshot = resolveMemoryIsolationSnapshotFromDatabase({ agentId, options });
    snapshotByAgentId.set(agentId, snapshot);
    return snapshot;
  } catch {
    const unavailable = { mode: "unavailable" } as const;
    snapshotByAgentId.set(agentId, unavailable);
    return unavailable;
  }
}

function resolveSingleShadowPilotSubject(params: {
  database: ReturnType<typeof openOpenClawAgentDatabase>;
}): ShadowPilotSubject {
  const db = getNodeSqliteKysely<MemoryCutoverDatabase>(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_memory_subjects")
      .select(["subject_kind", "principal_id"])
      .where("principal_id", "is not", null)
      .distinct(),
  ).rows;
  const subjects = new Map<string, ShadowPilotSubject>();
  for (const row of rows) {
    if (!PILOT_SUBJECT_KINDS.has(row.subject_kind) || !row.principal_id?.trim()) {
      continue;
    }
    const subject = Object.freeze({
      kind: row.subject_kind as ShadowPilotSubject["kind"],
      principalId: row.principal_id.trim(),
    });
    subjects.set(`${subject.kind}\u0000${subject.principalId}`, subject);
  }
  if (subjects.size !== 1) {
    throw new Error(
      "memory isolation shadow-read-only requires exactly one persisted verified session subject",
    );
  }
  return subjects.values().next().value as ShadowPilotSubject;
}

/**
 * Read the durable P1C posture for one agent. A malformed or unreadable marker is unavailable,
 * not legacy, so no failure path can silently widen access.
 */
export function resolveMemoryIsolationMode(agentIdInput: string): MemoryIsolationMode {
  return readMemoryIsolationSnapshot(agentIdInput).mode;
}

/** Write Doctor's reversible P1C shadow-read-only marker; Phase 6's cutover marker is untouched. */
export function enableMemoryShadowReadOnlyMode(params: {
  agentId: string;
  nowMs?: number;
  options?: OpenClawAgentDatabaseOptions;
}): MemoryIsolationMode {
  const agentId = params.agentId.trim();
  if (!agentId) {
    throw new Error("memory isolation agent id is required");
  }
  const nowMs = params.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("memory isolation verification time is invalid");
  }
  const database = openOpenClawAgentDatabase({
    ...params.options,
    agentId,
  });
  ensureOpenClawAgentScopedMemorySchema(database.db);
  database.db.exec(AGENT_SESSION_MEMORY_SCHEMA_SQL); // sqlite-allow-raw -- Existing additive subject DDL.
  const db = getNodeSqliteKysely<MemoryCutoverDatabase>(database.db);
  const cutover = executeSqliteQueryTakeFirstSync(
    database.db,
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
      .where("source_kind", "=", FINAL_CUTOVER_SOURCE_KIND)
      .limit(1),
  );
  if (cutover && isVerifiedFinalCutoverMarker({ database: database.db, marker: cutover })) {
    throw new Error(
      "memory isolation has completed final cutover and cannot return to shadow mode",
    );
  }
  if (cutover) {
    throw new Error("memory isolation final cutover marker is invalid");
  }
  const pilotSubject = resolveSingleShadowPilotSubject({ database });
  const classificationJson = createShadowClassification(pilotSubject);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("memory_migrations")
      .values({
        migration_id: SHADOW_READ_ONLY_MIGRATION_ID,
        source_kind: SHADOW_READ_ONLY_SOURCE_KIND,
        source_hash: SHADOW_READ_ONLY_SOURCE_HASH,
        phase: "verified",
        classification_json: classificationJson,
        plan_hash: hashClassification(classificationJson),
        verified_at: nowMs,
        cutover_at: null,
        updated_at: nowMs,
      })
      .onConflict((conflict) => conflict.columns(["source_kind", "source_hash"]).doNothing()),
  );
  const snapshot = resolveMemoryIsolationSnapshotFromDatabase({ agentId, options: params.options });
  if (
    snapshot.mode !== "shadow-read-only" ||
    snapshot.pilotSubject?.kind !== pilotSubject.kind ||
    snapshot.pilotSubject?.principalId !== pilotSubject.principalId
  ) {
    throw new Error("memory isolation shadow-read-only marker did not verify");
  }
  // The request-time cache deliberately stays unchanged: Doctor runs out of process and a
  // gateway must restart before its enforcement snapshot changes. This direct verification is
  // only for the lifecycle command's durable-write acknowledgement.
  return snapshot.mode;
}

/** Remove only the reversible P1C marker. Final cutover remains a Phase 6-only lifecycle state. */
export function disableMemoryShadowReadOnlyMode(params: {
  agentId: string;
  options?: OpenClawAgentDatabaseOptions;
}): MemoryIsolationMode {
  const agentId = params.agentId.trim();
  if (!agentId) {
    throw new Error("memory isolation agent id is required");
  }
  const database = openOpenClawAgentDatabase({
    ...params.options,
    agentId,
  });
  ensureOpenClawAgentScopedMemorySchema(database.db);
  database.db.exec(AGENT_SESSION_MEMORY_SCHEMA_SQL); // sqlite-allow-raw -- Existing additive subject DDL.
  const db = getNodeSqliteKysely<MemoryCutoverDatabase>(database.db);
  const cutover = executeSqliteQueryTakeFirstSync(
    database.db,
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
      .where("source_kind", "=", FINAL_CUTOVER_SOURCE_KIND)
      .limit(1),
  );
  if (cutover && isVerifiedFinalCutoverMarker({ database: database.db, marker: cutover })) {
    throw new Error("memory isolation has completed final cutover and cannot be disabled");
  }
  if (cutover) {
    throw new Error("memory isolation final cutover marker is invalid");
  }
  executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("memory_migrations")
      .where("source_kind", "=", SHADOW_READ_ONLY_SOURCE_KIND)
      .where("source_hash", "=", SHADOW_READ_ONLY_SOURCE_HASH),
  );
  const snapshot = resolveMemoryIsolationSnapshotFromDatabase({ agentId, options: params.options });
  if (snapshot.mode !== "legacy") {
    throw new Error("memory isolation shadow-read-only marker did not clear");
  }
  // Do not refresh a live gateway's cached posture from a lifecycle mutation; restart owns the
  // activation boundary. The direct database read above only proves Doctor removed its marker.
  return snapshot.mode;
}

/**
 * Atomically activates one already-verified migration manifest. The selected memory plugin owns
 * copying and verification; core owns the final switch so no runtime guesses between layouts.
 */
export function completeMemoryIsolationCutover(params: {
  agentId: string;
  migrationId: string;
  planHash: string;
  sources: readonly VerifiedMemoryMigrationSource[];
  nowMs?: number;
  options?: OpenClawAgentDatabaseOptions;
}): MemoryIsolationMode {
  const agentId = params.agentId.trim();
  if (!agentId) {
    throw new Error("memory isolation agent id is required");
  }
  const migrationId = normalizeFinalCutoverText(params.migrationId, "migration id");
  const planHash = normalizeFinalMigrationHash(params.planHash, "plan hash");
  const manifest = Object.freeze({
    migrationId,
    sources: normalizeVerifiedMigrationSources(params.sources),
  });
  const classificationJson = createFinalCutoverClassification(manifest);
  const sourceHash = hashClassification(classificationJson);
  const nowMs = params.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("memory isolation cutover time is invalid");
  }
  const database = openOpenClawAgentDatabase({
    ...params.options,
    agentId,
  });
  ensureOpenClawAgentScopedMemorySchema(database.db);
  database.db.exec(AGENT_SESSION_MEMORY_SCHEMA_SQL); // sqlite-allow-raw -- Existing additive subject DDL.
  const db = getNodeSqliteKysely<MemoryCutoverDatabase>(database.db);
  runSqliteImmediateTransactionSync(database.db, () => {
    const finalMarkers = executeSqliteQuerySync(
      database.db,
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
        .where("source_kind", "=", FINAL_CUTOVER_SOURCE_KIND),
    ).rows;
    if (finalMarkers.length > 0) {
      const existing = finalMarkers.length === 1 ? finalMarkers[0] : undefined;
      if (
        !existing ||
        existing.classification_json !== classificationJson ||
        existing.plan_hash !== planHash ||
        !isVerifiedFinalCutoverMarker({ database: database.db, marker: existing })
      ) {
        throw new Error("memory isolation final cutover marker is invalid");
      }
      return;
    }
    const planned = executeSqliteQuerySync(
      database.db,
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
        .where("plan_hash", "=", planHash)
        .where("source_kind", "!=", FINAL_CUTOVER_SOURCE_KIND),
    ).rows;
    const expected = new Set(
      manifest.sources.map((source) => `${source.sourceKind}\0${source.sourceHash}`),
    );
    const requiresEmptyCorpusReceipt = manifest.sources.length === 0;
    if (planned.length !== expected.size + (requiresEmptyCorpusReceipt ? 1 : 0)) {
      throw new Error("memory isolation final cutover must name every verified source in the plan");
    }
    for (const verified of planned) {
      if (verified.source_kind === EMPTY_LEGACY_CORPUS_SOURCE_KIND) {
        if (
          !requiresEmptyCorpusReceipt ||
          !isVerifiedEmptyLegacyCorpusReceipt({
            receipt: verified,
            migrationId,
            planHash,
            phase: "verified",
          })
        ) {
          throw new Error(
            "memory isolation final cutover requires a reviewed empty legacy corpus plan",
          );
        }
        continue;
      }
      const evidence = verified
        ? parseFinalMigrationSourceEvidence(verified.classification_json)
        : undefined;
      if (
        verified.phase !== "verified" ||
        !hasVerifiedCutoverTime(verified.verified_at) ||
        verified.cutover_at !== null ||
        !evidence ||
        evidence.migrationId !== migrationId ||
        evidence.source.kind !== verified.source_kind ||
        evidence.source.hash !== verified.source_hash ||
        !expected.delete(`${verified.source_kind}\0${verified.source_hash}`)
      ) {
        throw new Error("memory isolation migration sources are not verified");
      }
    }
    if (expected.size > 0) {
      throw new Error("memory isolation final cutover must name every verified source in the plan");
    }
    if (requiresEmptyCorpusReceipt) {
      const receipt = planned.find(
        (source) => source.source_kind === EMPTY_LEGACY_CORPUS_SOURCE_KIND,
      );
      if (!receipt) {
        throw new Error(
          "memory isolation final cutover requires a reviewed empty legacy corpus plan",
        );
      }
      const updated = executeSqliteQuerySync(
        database.db,
        db
          .updateTable("memory_migrations")
          .set({ phase: "cutover", cutover_at: nowMs, updated_at: nowMs })
          .where("source_kind", "=", receipt.source_kind)
          .where("source_hash", "=", receipt.source_hash)
          .where("phase", "=", "verified")
          .where("plan_hash", "=", planHash),
      );
      if (updated.numAffectedRows !== 1n) {
        throw new Error("memory isolation empty legacy corpus receipt changed during cutover");
      }
    }
    for (const source of manifest.sources) {
      const updated = executeSqliteQuerySync(
        database.db,
        db
          .updateTable("memory_migrations")
          .set({ phase: "cutover", cutover_at: nowMs, updated_at: nowMs })
          .where("source_kind", "=", source.sourceKind)
          .where("source_hash", "=", source.sourceHash)
          .where("phase", "=", "verified")
          .where("plan_hash", "=", planHash),
      );
      if (updated.numAffectedRows !== 1n) {
        throw new Error("memory isolation migration sources changed during cutover");
      }
    }
    executeSqliteQuerySync(
      database.db,
      db.insertInto("memory_migrations").values({
        migration_id: FINAL_CUTOVER_MIGRATION_ID,
        source_kind: FINAL_CUTOVER_SOURCE_KIND,
        source_hash: sourceHash,
        phase: "cutover",
        classification_json: classificationJson,
        plan_hash: planHash,
        verified_at: nowMs,
        cutover_at: nowMs,
        updated_at: nowMs,
      }),
    );
  });
  const snapshot = resolveMemoryIsolationSnapshotFromDatabase({ agentId, options: params.options });
  if (snapshot.mode !== "cutover") {
    throw new Error("memory isolation final cutover marker did not verify");
  }
  return snapshot.mode;
}

/**
 * Read the marker only after validating every source in its complete plan. Doctor passes this
 * bounded grant to the selected plugin for archival; a phase flag by itself never authorizes it.
 */
export function readVerifiedMemoryIsolationFinalCutover(params: {
  agentId: string;
  options?: OpenClawAgentDatabaseOptions;
}): VerifiedMemoryIsolationFinalCutover {
  const agentId = params.agentId.trim();
  if (!agentId) {
    throw new Error("memory isolation agent id is required");
  }
  const database = openOpenClawAgentDatabase({ ...params.options, agentId });
  ensureOpenClawAgentScopedMemorySchema(database.db);
  database.db.exec(AGENT_SESSION_MEMORY_SCHEMA_SQL); // sqlite-allow-raw -- Existing additive subject DDL.
  const db = getNodeSqliteKysely<MemoryCutoverDatabase>(database.db);
  const markers = executeSqliteQuerySync(
    database.db,
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
      .where("source_kind", "=", FINAL_CUTOVER_SOURCE_KIND),
  ).rows;
  const marker = markers.length === 1 ? markers[0] : undefined;
  const manifest = marker ? parseFinalCutoverManifest(marker.classification_json) : undefined;
  if (!marker || !manifest || !isVerifiedFinalCutoverMarker({ database: database.db, marker })) {
    throw new Error("memory isolation archival requires a verified final cutover");
  }
  return Object.freeze({
    migrationId: manifest.migrationId,
    planHash: marker.plan_hash,
    sources: manifest.sources,
  });
}

export const memoryIsolationCutoverTestApi = {
  createVerifiedSourceClassification(params: {
    migrationId: string;
    sourceId: string;
    sourceKind: string;
    sourceHash: string;
    contentHash: string;
    actorRole?: "owner" | "admin";
  }): string {
    const sourceHash = normalizeFinalMigrationHash(params.sourceHash, "test source hash");
    const contentHash = normalizeFinalMigrationHash(params.contentHash, "test content hash");
    return createFinalMigrationSourceClassification({
      migrationId: normalizeFinalCutoverText(params.migrationId, "test migration id"),
      source: {
        id: normalizeFinalCutoverText(params.sourceId, "test source id"),
        kind: normalizeFinalCutoverText(params.sourceKind, "test source kind"),
        hash: sourceHash,
        contentHash,
        bytes: 1,
      },
      decision: {
        placement: "approved",
        actorRole: params.actorRole ?? "owner",
        actorId: "test-actor",
      },
      backup: { artifactHash: contentHash, contentHash, verifiedAt: 1 },
      destination: {
        storeId: `test-store-${sourceHash}`,
        resourceId: `test-resource-${sourceHash}`,
        revisionId: `test-revision-${sourceHash}`,
        contentHash,
        lifecycleState: "active",
      },
      archive: { state: "pending" },
    });
  },
};

/** The P1C pilot binds one durable subject; a different subject cannot mint a protected context. */
export function isMemoryIsolationSubjectAdmitted(params: {
  agentId: string;
  subject: Readonly<{ kind: string; principalId: string }>;
  options?: OpenClawAgentDatabaseOptions;
}): boolean {
  const snapshot = readMemoryIsolationSnapshot(params.agentId, params.options);
  if (snapshot.mode === "unavailable") {
    return false;
  }
  if (snapshot.mode !== "shadow-read-only") {
    return true;
  }
  return (
    snapshot.pilotSubject?.kind === params.subject.kind &&
    snapshot.pilotSubject.principalId === params.subject.principalId
  );
}

/**
 * True whenever Doctor's durable P1C shadow posture or final Phase 6 cutover disables legacy
 * memory. An unreadable authority store fails closed: selected-memory callers never use legacy.
 */
export function isMemoryIsolationCutoverAgent(agentIdInput: string): boolean {
  const agentId = agentIdInput.trim();
  // Tool construction can be intentionally unscoped (for example, local workspace utilities).
  // It has no authority-store owner, so it must retain legacy behavior rather than borrow an agent.
  return agentId ? resolveMemoryIsolationMode(agentId) !== "legacy" : false;
}

/**
 * Transcript companions are part of the same durable memory boundary as selected-memory reads.
 * A malformed marker fails closed, so shadow and final cutover never persist raw rows without one.
 */
export function isMemoryIsolationTranscriptPolicyEnforcedInDatabase(db: DatabaseSync): boolean {
  try {
    return resolveMemoryIsolationSnapshotInDatabase(db).mode !== "legacy";
  } catch {
    return true;
  }
}

export function resetMemoryIsolationCutoverForTest(): void {
  snapshotByAgentId.clear();
}
