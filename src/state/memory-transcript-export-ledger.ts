import { randomUUID } from "node:crypto";
import type { AuthorizedTranscriptExportSource } from "../config/sessions/session-transcript-memory-policy.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db.js";
import { ensureOpenClawAgentScopedMemorySchema } from "./openclaw-agent-scoped-memory-schema.js";

type TranscriptExportLedgerDatabase = {
  memory_transcript_export_artifacts: {
    export_id: string;
    artifact_type: TranscriptExportArtifactType;
    session_id: string;
    source_policy_set_id: string;
    delivery_audiences_json: string;
    source_content_hash: string;
    artifact_content_hash: string;
    created_at: number;
  };
  memory_transcript_export_artifact_sources: {
    export_id: string;
    event_seq: number;
    source_session_id: string;
    source_event_seq: number;
    event_hash: string;
    session_identity_revision: string;
    subject_revision: string;
    run_exposure_set_id: string;
    run_exposure_revision: number;
    actor_evidence_json: string;
    delegation_snapshot_json: string;
    exposed_resource_revisions_json: string;
    exposure_receipt_ids_json: string;
    egress_receipt_ids_json: string;
    created_at: number;
  };
  memory_transcript_export_artifact_events: {
    export_event_id: string;
    export_id: string;
    event_kind: "staged" | "active" | "failed";
    failure_reason: string | null;
    created_at: number;
  };
};

export type TranscriptExportArtifactType = "session-html" | "trajectory";
export type TranscriptExportArtifactFailure =
  | "publication-authorization-lost"
  | "publication-failed";

export type StagedTranscriptExportArtifact = Readonly<{
  exportId: string;
  artifactContentHash: string;
  artifactType: TranscriptExportArtifactType;
}>;

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`transcript export ${label} is required`);
  }
  return trimmed;
}

function assertCompleteSource(source: AuthorizedTranscriptExportSource): void {
  if (
    source.eventSeqs.length === 0 ||
    source.eventSeqs.length !== source.eventHashes.length ||
    source.eventSeqs.length !== source.eventJsons.length ||
    source.eventSeqs.length !== source.sourceEvidence.length
  ) {
    throw new Error("transcript export source is incomplete");
  }
  for (const [index, evidence] of source.sourceEvidence.entries()) {
    if (
      evidence.eventSeq !== source.eventSeqs[index] ||
      !evidence.sourceSessionId.trim() ||
      !Number.isInteger(evidence.sourceEventSeq) ||
      evidence.sourceEventSeq < 0 ||
      !source.eventHashes[index]?.trim()
    ) {
      throw new Error("transcript export source lineage is invalid");
    }
  }
}

/**
 * Persist an immutable artifact manifest before any external filesystem write.
 * The caller has already performed asynchronous authorization; this section is
 * intentionally synchronous so the source and staged lifecycle event commit together.
 */
export function stageTranscriptExportArtifact(params: {
  artifactContentHash: string;
  artifactType: TranscriptExportArtifactType;
  database: OpenClawAgentDatabase;
  exportId: string;
  sessionId: string;
  source: AuthorizedTranscriptExportSource;
  stagedAt?: number;
}): StagedTranscriptExportArtifact {
  const exportId = requireText(params.exportId, "id");
  const artifactContentHash = requireText(params.artifactContentHash, "content hash");
  assertCompleteSource(params.source);
  const createdAt = params.stagedAt ?? Date.now();
  runSqliteImmediateTransactionSync(
    params.database.db,
    () => {
      ensureOpenClawAgentScopedMemorySchema(params.database.db);
      const db = getNodeSqliteKysely<TranscriptExportLedgerDatabase>(params.database.db);
      executeSqliteQuerySync(
        params.database.db,
        db.insertInto("memory_transcript_export_artifacts").values({
          export_id: exportId,
          artifact_type: params.artifactType,
          session_id: requireText(params.sessionId, "session"),
          source_policy_set_id: requireText(params.source.sourcePolicySetId, "source policy set"),
          delivery_audiences_json: requireText(
            params.source.deliveryAudiencesJson,
            "delivery audiences",
          ),
          source_content_hash: requireText(params.source.contentHash, "source content hash"),
          artifact_content_hash: artifactContentHash,
          created_at: createdAt,
        }),
      );
      for (const [index, evidence] of params.source.sourceEvidence.entries()) {
        executeSqliteQuerySync(
          params.database.db,
          db.insertInto("memory_transcript_export_artifact_sources").values({
            export_id: exportId,
            event_seq: evidence.eventSeq,
            source_session_id: evidence.sourceSessionId,
            source_event_seq: evidence.sourceEventSeq,
            event_hash: requireText(params.source.eventHashes[index] ?? "", "event hash"),
            session_identity_revision: evidence.sessionIdentityRevision,
            subject_revision: evidence.subjectRevision,
            run_exposure_set_id: evidence.runExposureSetId,
            run_exposure_revision: evidence.runExposureRevision,
            actor_evidence_json: evidence.actorEvidenceJson,
            delegation_snapshot_json: evidence.delegationSnapshotJson,
            exposed_resource_revisions_json: evidence.exposedResourceRevisionsJson,
            exposure_receipt_ids_json: evidence.exposureReceiptIdsJson,
            egress_receipt_ids_json: evidence.egressReceiptIdsJson,
            created_at: createdAt,
          }),
        );
      }
      executeSqliteQuerySync(
        params.database.db,
        db.insertInto("memory_transcript_export_artifact_events").values({
          export_event_id: randomUUID(),
          export_id: exportId,
          event_kind: "staged",
          failure_reason: null,
          created_at: createdAt,
        }),
      );
    },
    { operationLabel: "memory-transcript-export.stage" },
  );
  return Object.freeze({
    exportId,
    artifactContentHash,
    artifactType: params.artifactType,
  });
}

function appendTranscriptExportArtifactLifecycle(params: {
  artifact: StagedTranscriptExportArtifact;
  database: OpenClawAgentDatabase;
  eventKind: "active" | "failed";
  failureReason?: TranscriptExportArtifactFailure;
  occurredAt?: number;
}): boolean {
  try {
    runSqliteImmediateTransactionSync(
      params.database.db,
      () => {
        ensureOpenClawAgentScopedMemorySchema(params.database.db);
        const db = getNodeSqliteKysely<TranscriptExportLedgerDatabase>(params.database.db);
        const manifest = executeSqliteQueryTakeFirstSync(
          params.database.db,
          db
            .selectFrom("memory_transcript_export_artifacts")
            .select(["artifact_content_hash", "artifact_type", "export_id"])
            .where("export_id", "=", params.artifact.exportId)
            .limit(1),
        );
        if (
          !manifest ||
          manifest.artifact_content_hash !== params.artifact.artifactContentHash ||
          manifest.artifact_type !== params.artifact.artifactType
        ) {
          throw new Error("transcript export artifact manifest is unavailable");
        }
        executeSqliteQuerySync(
          params.database.db,
          db.insertInto("memory_transcript_export_artifact_events").values({
            export_event_id: randomUUID(),
            export_id: params.artifact.exportId,
            event_kind: params.eventKind,
            failure_reason: params.eventKind === "failed" ? params.failureReason : null,
            created_at: params.occurredAt ?? Date.now(),
          }),
        );
      },
      { operationLabel: `memory-transcript-export.${params.eventKind}` },
    );
    return true;
  } catch {
    return false;
  }
}

/** Append the only successful terminal event after publication. */
export function activateTranscriptExportArtifact(params: {
  artifact: StagedTranscriptExportArtifact;
  database: OpenClawAgentDatabase;
  activatedAt?: number;
}): boolean {
  return appendTranscriptExportArtifactLifecycle({
    ...params,
    eventKind: "active",
    occurredAt: params.activatedAt,
  });
}

/** Record a stable failure outcome without leaking an operating-system error into durable lineage. */
export function failTranscriptExportArtifact(params: {
  artifact: StagedTranscriptExportArtifact;
  database: OpenClawAgentDatabase;
  failureReason: TranscriptExportArtifactFailure;
  failedAt?: number;
}): boolean {
  return appendTranscriptExportArtifactLifecycle({
    ...params,
    eventKind: "failed",
    occurredAt: params.failedAt,
  });
}
