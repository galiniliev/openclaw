import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthorizedTranscriptExportSource } from "../config/sessions/session-transcript-memory-policy.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db.js";
import {
  activateTranscriptExportArtifact,
  failTranscriptExportArtifact,
  stageTranscriptExportArtifact,
} from "./memory-transcript-export-ledger.js";

describe("memory transcript export ledger", () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close();
    }
  });

  function database(): OpenClawAgentDatabase {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    return { agentId: "main", db } as unknown as OpenClawAgentDatabase;
  }

  function source(): AuthorizedTranscriptExportSource {
    return {
      eventSeqs: [3],
      eventJsons: ['{"type":"message","id":"entry-3"}'],
      eventHashes: ["event-hash"],
      sourcePolicySetId: "policy-set-1",
      deliveryAudiencesJson: '[{"kind":"user","id":"alice"}]',
      contentHash: "source-hash",
      sourceEvidence: [
        {
          eventSeq: 3,
          sourceEventSeq: 3,
          sourceSessionId: "session-1",
          sessionIdentityRevision: "session-revision-1",
          subjectRevision: "subject-revision-1",
          runExposureRevision: 1,
          runExposureSetId: "exposure-set-1",
          actorEvidenceJson: '{"kind":"principal"}',
          delegationSnapshotJson: '{"kind":"none"}',
          exposedResourceRevisionsJson: "[]",
          exposureReceiptIdsJson: "[]",
          egressReceiptIdsJson: "[]",
        },
      ],
    };
  }

  it("stages immutable source lineage before the artifact becomes active", () => {
    const owner = database();
    const artifact = stageTranscriptExportArtifact({
      artifactContentHash: "artifact-hash",
      artifactType: "session-html",
      database: owner,
      exportId: "mexp1_export",
      sessionId: "session-1",
      source: source(),
      stagedAt: 100,
    });

    expect(
      owner.db
        .prepare(
          "SELECT source_content_hash, artifact_content_hash FROM memory_transcript_export_artifacts",
        )
        .all(),
    ).toEqual([{ source_content_hash: "source-hash", artifact_content_hash: "artifact-hash" }]);
    expect(
      owner.db
        .prepare(
          "SELECT event_seq, event_hash, actor_evidence_json, egress_receipt_ids_json FROM memory_transcript_export_artifact_sources",
        )
        .all(),
    ).toEqual([
      {
        event_seq: 3,
        event_hash: "event-hash",
        actor_evidence_json: '{"kind":"principal"}',
        egress_receipt_ids_json: "[]",
      },
    ]);
    expect(
      owner.db
        .prepare(
          "SELECT event_kind, failure_reason FROM memory_transcript_export_artifact_events ORDER BY created_at",
        )
        .all(),
    ).toEqual([{ event_kind: "staged", failure_reason: null }]);

    expect(activateTranscriptExportArtifact({ artifact, database: owner, activatedAt: 101 })).toBe(
      true,
    );
    expect(
      owner.db
        .prepare(
          "SELECT event_kind FROM memory_transcript_export_artifact_events ORDER BY created_at, export_event_id",
        )
        .all(),
    ).toEqual([{ event_kind: "staged" }, { event_kind: "active" }]);
    expect(
      failTranscriptExportArtifact({
        artifact,
        database: owner,
        failureReason: "publication-failed",
      }),
    ).toBe(false);
    expect(() =>
      owner.db
        .prepare(
          "UPDATE memory_transcript_export_artifacts SET session_id = 'other' WHERE export_id = 'mexp1_export'",
        )
        .run(),
    ).toThrow(/immutable/u);
  });
});
