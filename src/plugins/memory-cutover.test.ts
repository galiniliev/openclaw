import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  completeMemoryIsolationCutover,
  disableMemoryShadowReadOnlyMode,
  enableMemoryShadowReadOnlyMode,
  isMemoryIsolationCutoverAgent,
  memoryIsolationCutoverTestApi,
  resetMemoryIsolationCutoverForTest,
  resolveMemoryIsolationMode,
} from "./memory-cutover.js";

describe("memory isolation lifecycle", () => {
  let stateDir = "";
  const planHash = `sha256:${createHash("sha256").update("memory-isolation-test-plan").digest("hex")}`;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-isolation-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    resetMemoryIsolationCutoverForTest();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { force: true, recursive: true });
  });

  function insertPilotSubject(params: { principalId: string; sessionKey?: string }) {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    database.db
      .prepare(
        `INSERT INTO session_memory_subjects
         (session_key, binding_id, principal_id, subject_kind, subject_revision, created_at)
         VALUES (?, NULL, ?, 'agent', ?, 1)`,
      )
      .run(params.sessionKey ?? "agent:main:pilot", params.principalId, randomUUID());
  }

  function insertVerifiedMigrationSource(params: {
    sourceKind: string;
    sourceHash: string;
    planHash?: string;
  }) {
    const contentHash = `sha256:${createHash("sha256")
      .update(`content:${params.sourceHash}`)
      .digest("hex")}`;
    const classificationJson = memoryIsolationCutoverTestApi.createVerifiedSourceClassification({
      migrationId: "pilot-migration",
      sourceId: `source-${params.sourceHash}`,
      sourceKind: params.sourceKind,
      sourceHash: params.sourceHash,
      contentHash,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    database.db
      .prepare(
        `INSERT INTO memory_migrations
          (migration_id, source_kind, source_hash, phase, classification_json, plan_hash,
           verified_at, cutover_at, updated_at)
         VALUES (?, ?, ?, 'verified', ?, ?, 1, NULL, 1)`,
      )
      .run(
        randomUUID(),
        params.sourceKind,
        params.sourceHash,
        classificationJson,
        params.planHash ?? planHash,
      );
  }

  it("does not borrow an agent cutover state when the caller has no agent scope", () => {
    expect(isMemoryIsolationCutoverAgent("")).toBe(false);
    expect(isMemoryIsolationCutoverAgent("   ")).toBe(false);
  });

  it("persists a verified shadow-read-only marker and activates it only after a cache reset", () => {
    insertPilotSubject({ principalId: "principal-alice" });
    expect(resolveMemoryIsolationMode("main")).toBe("legacy");

    expect(enableMemoryShadowReadOnlyMode({ agentId: "main", nowMs: 1 })).toBe("shadow-read-only");
    // Doctor is a separate process. A running gateway retains its request-time posture until
    // restart, so an operator cannot flip memory authority in the middle of a run.
    expect(isMemoryIsolationCutoverAgent("main")).toBe(false);

    resetMemoryIsolationCutoverForTest();
    expect(resolveMemoryIsolationMode("main")).toBe("shadow-read-only");
    expect(isMemoryIsolationCutoverAgent("main")).toBe(true);

    expect(disableMemoryShadowReadOnlyMode({ agentId: "main" })).toBe("legacy");
    expect(isMemoryIsolationCutoverAgent("main")).toBe(true);
    resetMemoryIsolationCutoverForTest();
    expect(resolveMemoryIsolationMode("main")).toBe("legacy");
  });

  it("fails closed for a malformed reserved shadow marker", () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    database.db
      .prepare(
        `INSERT INTO memory_migrations
          (migration_id, source_kind, source_hash, phase, classification_json, plan_hash,
           verified_at, cutover_at, updated_at)
         VALUES ('memory-isolation-shadow-read-only-v1', 'memory-isolation-shadow-read-only',
                 'wrong-source-hash', 'verified', '{"mode":"shadow-read-only","version":1}',
                 'sha256:46920e4ef88f60e8d1f0c271dc0a1b95', 1, NULL, 1)`,
      )
      .run();

    expect(resolveMemoryIsolationMode("main")).toBe("unavailable");
    expect(isMemoryIsolationCutoverAgent("main")).toBe(true);
  });

  it("does not treat an unbound phase-cutover row as a final migration", () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    database.db
      .prepare(
        `INSERT INTO memory_migrations
          (migration_id, source_kind, source_hash, phase, classification_json, plan_hash,
           verified_at, cutover_at, updated_at)
         VALUES ('phase-6-cutover', 'test', 'test-source', 'cutover', '{}', 'test-plan', 1, 1, 1)`,
      )
      .run();

    expect(resolveMemoryIsolationMode("main")).toBe("legacy");
  });

  it("atomically binds every verified source to the final cutover marker", () => {
    const aliceHash = `sha256:${createHash("sha256").update("alice").digest("hex")}`;
    const bobHash = `sha256:${createHash("sha256").update("bob").digest("hex")}`;
    insertVerifiedMigrationSource({ sourceKind: "legacy-file", sourceHash: aliceHash });
    insertVerifiedMigrationSource({ sourceKind: "legacy-file", sourceHash: bobHash });

    expect(
      completeMemoryIsolationCutover({
        agentId: "main",
        migrationId: "pilot-migration",
        planHash,
        sources: [
          { sourceKind: "legacy-file", sourceHash: bobHash },
          { sourceKind: "legacy-file", sourceHash: aliceHash },
        ],
        nowMs: 2,
      }),
    ).toBe("cutover");
    resetMemoryIsolationCutoverForTest();
    expect(resolveMemoryIsolationMode("main")).toBe("cutover");
    expect(() => enableMemoryShadowReadOnlyMode({ agentId: "main", nowMs: 3 })).toThrow(
      "final cutover",
    );
    expect(() => disableMemoryShadowReadOnlyMode({ agentId: "main" })).toThrow("final cutover");

    const rows = openOpenClawAgentDatabase({ agentId: "main" })
      .db.prepare(
        `SELECT source_kind, source_hash, phase, cutover_at
           FROM memory_migrations
          WHERE plan_hash = ?
          ORDER BY source_kind, source_hash`,
      )
      .all(planHash);
    expect(rows).toEqual([
      {
        source_kind: "legacy-file",
        source_hash: aliceHash,
        phase: "cutover",
        cutover_at: 2,
      },
      {
        source_kind: "legacy-file",
        source_hash: bobHash,
        phase: "cutover",
        cutover_at: 2,
      },
      {
        source_kind: "memory-isolation-final-cutover",
        source_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        phase: "cutover",
        cutover_at: 2,
      },
    ]);
  });

  it("fails closed when a final marker is not the canonical migration manifest", () => {
    const aliceHash = `sha256:${createHash("sha256").update("alice").digest("hex")}`;
    insertVerifiedMigrationSource({ sourceKind: "legacy-file", sourceHash: aliceHash });
    completeMemoryIsolationCutover({
      agentId: "main",
      migrationId: "pilot-migration",
      planHash,
      sources: [{ sourceKind: "legacy-file", sourceHash: aliceHash }],
      nowMs: 2,
    });

    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const marker = database.db
      .prepare(
        `SELECT classification_json
           FROM memory_migrations
          WHERE source_kind = 'memory-isolation-final-cutover'`,
      )
      .get() as { classification_json: string };
    const noncanonical = JSON.stringify({
      ...JSON.parse(marker.classification_json),
      ignored: true,
    });
    database.db
      .prepare(
        `UPDATE memory_migrations
            SET classification_json = ?, source_hash = ?
          WHERE source_kind = 'memory-isolation-final-cutover'`,
      )
      .run(noncanonical, `sha256:${createHash("sha256").update(noncanonical).digest("hex")}`);

    resetMemoryIsolationCutoverForTest();
    expect(resolveMemoryIsolationMode("main")).toBe("unavailable");
  });

  it("refuses a final marker that omits a verified member of the reviewed plan", () => {
    const aliceHash = `sha256:${createHash("sha256").update("alice").digest("hex")}`;
    const bobHash = `sha256:${createHash("sha256").update("bob").digest("hex")}`;
    insertVerifiedMigrationSource({ sourceKind: "legacy-file", sourceHash: aliceHash });
    insertVerifiedMigrationSource({ sourceKind: "legacy-file", sourceHash: bobHash });

    expect(() =>
      completeMemoryIsolationCutover({
        agentId: "main",
        migrationId: "pilot-migration",
        planHash,
        sources: [{ sourceKind: "legacy-file", sourceHash: aliceHash }],
        nowMs: 2,
      }),
    ).toThrow("must name every verified source");
    expect(resolveMemoryIsolationMode("main")).toBe("legacy");
  });

  it("keeps the fenced cutover posture while an explicit archive is recoverable", () => {
    const aliceHash = `sha256:${createHash("sha256").update("alice").digest("hex")}`;
    insertVerifiedMigrationSource({ sourceKind: "legacy-file", sourceHash: aliceHash });
    completeMemoryIsolationCutover({
      agentId: "main",
      migrationId: "pilot-migration",
      planHash,
      sources: [{ sourceKind: "legacy-file", sourceHash: aliceHash }],
      nowMs: 2,
    });

    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const source = database.db
      .prepare(
        `SELECT classification_json
           FROM memory_migrations
          WHERE source_kind = 'legacy-file' AND source_hash = ?`,
      )
      .get(aliceHash) as { classification_json: string };
    const archiving = JSON.stringify({
      ...JSON.parse(source.classification_json),
      archive: { state: "archiving" },
    });
    database.db
      .prepare(
        `UPDATE memory_migrations
            SET classification_json = ?
          WHERE source_kind = 'legacy-file' AND source_hash = ?`,
      )
      .run(archiving, aliceHash);

    resetMemoryIsolationCutoverForTest();
    expect(resolveMemoryIsolationMode("main")).toBe("cutover");
  });

  it("refuses final cutover until every source is verified under the same plan", () => {
    const aliceHash = `sha256:${createHash("sha256").update("alice").digest("hex")}`;
    const missingHash = `sha256:${createHash("sha256").update("missing").digest("hex")}`;
    insertVerifiedMigrationSource({ sourceKind: "legacy-file", sourceHash: aliceHash });

    expect(() =>
      completeMemoryIsolationCutover({
        agentId: "main",
        migrationId: "pilot-migration",
        planHash,
        sources: [
          { sourceKind: "legacy-file", sourceHash: aliceHash },
          { sourceKind: "legacy-file", sourceHash: missingHash },
        ],
        nowMs: 2,
      }),
    ).toThrow("must name every verified source");
    expect(resolveMemoryIsolationMode("main")).toBe("legacy");
  });
});
