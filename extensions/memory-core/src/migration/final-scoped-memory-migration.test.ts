import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeMemoryIsolationCutover,
  readVerifiedMemoryIsolationFinalCutover,
  resetMemoryIsolationCutoverForTest,
  resolveMemoryIsolationMode,
} from "../../../../src/plugins/memory-cutover.js";
import { withScopedMemoryDatabase } from "../memory/scoped-memory-db.js";
import { evaluateBuiltinScopedMemoryPolicy } from "../memory/scoped-memory-policy.js";
import {
  readBuiltinScopedMemoryRevisionSnapshot,
  resolveBuiltinScopedMemoryArtifactPath,
} from "../memory/scoped-memory-resources.js";
import {
  applyFinalScopedMemoryMigration,
  archiveFinalScopedMemoryMigration,
  discoverFinalScopedMemoryMigrationSources,
  exportFinalScopedMemoryMigration,
  finalScopedMemoryMigrationTestApi,
  type FinalScopedMemoryMigrationDecision,
  type FinalScopedMemoryMigrationSource,
  planFinalScopedMemoryMigration,
  rollbackFinalScopedMemoryMigration,
  rollbackFinalScopedMemoryMigrationByPlan,
} from "./final-scoped-memory-migration.js";

describe("final scoped memory migration", () => {
  let stateDir = "";

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-final-scoped-migration-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    resetMemoryIsolationCutoverForTest();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { force: true, recursive: true });
  });

  const actor = { role: "owner", principalId: "principal-alice" } as const;

  function sourceHash(source: FinalScopedMemoryMigrationSource): string {
    const contentHash = `sha256:${createHash("sha256").update(source.content).digest("hex")}`;
    return `sha256:${createHash("sha256")
      .update(`${source.sourceId}\0${source.sourceKind}\0${contentHash}`)
      .digest("hex")}`;
  }

  function privateDecision(
    source: FinalScopedMemoryMigrationSource,
  ): FinalScopedMemoryMigrationDecision {
    return {
      sourceId: source.sourceId,
      sourceHash: sourceHash(source),
      placement: "user-private",
      principalId: "principal-alice",
    };
  }

  function applyReviewed(params: {
    agentId: string;
    migrationId: string;
    sources: readonly FinalScopedMemoryMigrationSource[];
    decisions?: readonly FinalScopedMemoryMigrationDecision[];
    nowMs: number;
  }) {
    const plan = planFinalScopedMemoryMigration({
      migrationId: params.migrationId,
      actor,
      sources: params.sources,
      decisions: params.decisions,
    });
    return applyFinalScopedMemoryMigration({
      ...params,
      actor,
      expectedPlanHash: plan.planHash,
    });
  }

  function completeReviewedCutover(params: {
    result: ReturnType<typeof applyFinalScopedMemoryMigration>;
    nowMs: number;
  }) {
    completeMemoryIsolationCutover({
      agentId: "main",
      migrationId: params.result.migrationId,
      planHash: params.result.planHash,
      sources: params.result.verifiedSources,
      nowMs: params.nowMs,
    });
    return readVerifiedMemoryIsolationFinalCutover({ agentId: "main" });
  }

  it("requires an owner decision for private placement and quarantines every unassigned source", () => {
    const aliceSource = {
      sourceId: "opaque-alice",
      sourceKind: "legacy-file",
      content: "Alice private fact",
    } as const;
    const ambiguousSource = {
      sourceId: "opaque-ambiguous",
      sourceKind: "legacy-transcript",
      content: "unbound history",
    } as const;
    const plan = planFinalScopedMemoryMigration({
      migrationId: "pilot-one",
      actor,
      sources: [aliceSource, ambiguousSource],
      decisions: [privateDecision(aliceSource)],
    });

    expect(plan.sources).toEqual([
      expect.objectContaining({ sourceId: "opaque-alice", placement: "user-private" }),
      expect.objectContaining({ sourceId: "opaque-ambiguous", placement: "quarantine" }),
    ]);
    expect(() =>
      planFinalScopedMemoryMigration({
        migrationId: "pilot-one",
        actor,
        sources: [
          { sourceId: "opaque-bob", sourceKind: "legacy-file", content: "Bob private fact" },
        ],
        decisions: [
          {
            sourceId: "opaque-bob",
            sourceHash: sourceHash({
              sourceId: "opaque-bob",
              sourceKind: "legacy-file",
              content: "Bob private fact",
            }),
            placement: "user-private",
            principalId: "principal-bob",
          },
        ],
      }),
    ).toThrow("only into their own private store");
  });

  it("backs up, copies, indexes, verifies, and records canonical cutover evidence", () => {
    const aliceSource = {
      sourceId: "opaque-alice",
      sourceKind: "legacy-file",
      content: "Alice private fact",
    } as const;
    const ambiguousSource = {
      sourceId: "opaque-ambiguous",
      sourceKind: "legacy-transcript",
      content: "unbound history",
    } as const;
    const result = applyReviewed({
      agentId: "main",
      migrationId: "pilot-one",
      sources: [aliceSource, ambiguousSource],
      decisions: [privateDecision(aliceSource)],
      nowMs: 1_000,
    });

    expect(result.verifiedSources).toHaveLength(2);
    const rows = withScopedMemoryDatabase(
      "main",
      (database) =>
        database
          .prepare(
            "SELECT phase, classification_json FROM memory_migrations ORDER BY source_kind, source_hash",
          )
          .all() as Array<{ phase: string; classification_json: string }>,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.phase === "verified")).toBe(true);
    expect(rows.some((row) => row.classification_json.includes("Alice private fact"))).toBe(false);
    expect(rows.some((row) => row.classification_json.includes("unbound history"))).toBe(false);
    expect(
      rows.every((row) => row.classification_json.includes('"archive":{"state":"pending"}')),
    ).toBe(true);

    const scoped = withScopedMemoryDatabase(
      "main",
      (database) =>
        database
          .prepare(
            `SELECT revision.revision_id, revision.lifecycle_state, resource.store_id
             FROM memory_resource_revisions AS revision
             JOIN memory_resources AS resource ON resource.resource_id = revision.resource_id
            ORDER BY revision.revision_id`,
          )
          .all() as Array<{
          revision_id: string;
          lifecycle_state: "active" | "quarantined";
          store_id: string;
        }>,
    );
    const active = scoped.find((row) => row.lifecycle_state === "active");
    const quarantined = scoped.find((row) => row.lifecycle_state === "quarantined");
    expect(active).toBeDefined();
    expect(quarantined).toBeDefined();
    const privateSnapshot = readBuiltinScopedMemoryRevisionSnapshot({
      agentId: "main",
      storeIds: [active!.store_id],
      revisionId: active!.revision_id,
      nowMs: 1_000,
    });
    expect(privateSnapshot?.content).toBe("Alice private fact");
    expect(
      evaluateBuiltinScopedMemoryPolicy({
        agentId: "main",
        storeId: quarantined!.store_id,
        principalIds: ["principal-alice"],
        deliveryAudiences: [{ kind: "internal", id: "not-the-private-store" }],
        operation: "read",
        nowMs: 1_000,
      }).allowed,
    ).toBe(false);

    const backups = path.join(
      stateDir,
      "agents",
      "main",
      "agent",
      "memory-migration-backups",
      "v1",
    );
    expect(
      fs.readdirSync(backups, { withFileTypes: true }).some((entry) => entry.isDirectory()),
    ).toBe(true);
    expect(
      applyReviewed({
        agentId: "main",
        migrationId: "pilot-one",
        sources: [aliceSource, ambiguousSource],
        decisions: [privateDecision(aliceSource)],
        nowMs: 1_000,
      }),
    ).toEqual(result);
  });

  it("records a reviewed empty-corpus receipt before allowing a clean pilot cutover", () => {
    const result = applyReviewed({
      agentId: "main",
      migrationId: "pilot-empty-corpus",
      sources: [],
      nowMs: 1_000,
    });

    expect(result.verifiedSources).toEqual([]);
    expect(
      withScopedMemoryDatabase("main", (database) =>
        database
          .prepare(
            `SELECT migration_id, source_kind, phase, plan_hash, classification_json
               FROM memory_migrations`,
          )
          .all(),
      ),
    ).toEqual([
      expect.objectContaining({
        migration_id: "pilot-empty-corpus",
        source_kind: "memory-isolation-empty-legacy-corpus",
        phase: "verified",
        plan_hash: result.planHash,
        classification_json: expect.stringContaining(
          '"mode":"memory-isolation-empty-legacy-corpus"',
        ),
      }),
    ]);

    const cutover = completeReviewedCutover({ result, nowMs: 2_000 });
    expect(cutover.sources).toEqual([]);
    expect(resolveMemoryIsolationMode("main")).toBe("cutover");

    expect(() =>
      archiveFinalScopedMemoryMigration({
        agentId: "main",
        migrationId: result.migrationId,
        cutover,
        sources: [],
        nowMs: 3_000,
      }),
    ).not.toThrow();
    const outputDir = path.join(stateDir, "empty-corpus-export");
    expect(
      exportFinalScopedMemoryMigration({
        agentId: "main",
        migrationId: result.migrationId,
        cutover,
        outputDir,
        nowMs: 3_000,
      }),
    ).toMatchObject({ exportedResources: 0, excludedQuarantineResources: 0 });
  });

  it("removes the empty-corpus receipt when a pre-cutover rollback uses the reviewed digest", () => {
    const result = applyReviewed({
      agentId: "main",
      migrationId: "pilot-empty-rollback",
      sources: [],
      nowMs: 1_000,
    });

    rollbackFinalScopedMemoryMigrationByPlan({
      agentId: "main",
      migrationId: result.migrationId,
      planHash: result.planHash,
      nowMs: 2_000,
    });
    expect(
      withScopedMemoryDatabase("main", (database) =>
        database.prepare("SELECT COUNT(*) AS count FROM memory_migrations").get(),
      ),
    ).toEqual({ count: 0 });
  });

  it("supports pre-cutover rollback without altering the verified backup", () => {
    const source = {
      sourceId: "opaque-alice",
      sourceKind: "legacy-file",
      content: "Alice private fact",
    } as const;
    const result = applyReviewed({
      agentId: "main",
      migrationId: "pilot-rollback",
      sources: [source],
      decisions: [privateDecision(source)],
      nowMs: 1_000,
    });

    rollbackFinalScopedMemoryMigration({
      agentId: "main",
      migrationId: "pilot-rollback",
      result,
      nowMs: 2_000,
    });
    expect(
      withScopedMemoryDatabase(
        "main",
        (database) =>
          database
            .prepare(
              `SELECT revision.lifecycle_state, migration.phase
               FROM memory_resource_revisions AS revision
               CROSS JOIN memory_migrations AS migration`,
            )
            .all() as Array<{ lifecycle_state: string; phase: string }>,
      ),
    ).toEqual([{ lifecycle_state: "tombstoned", phase: "backed-up" }]);
  });

  it("resumes rollback after a scoped revision was retired before its phase was recorded", () => {
    const alice = {
      sourceId: "opaque-alice",
      sourceKind: "legacy-file",
      content: "Alice private fact",
    } as const;
    const bob = {
      sourceId: "opaque-bob",
      sourceKind: "legacy-file",
      content: "Bob private fact",
    } as const;
    const result = applyReviewed({
      agentId: "main",
      migrationId: "pilot-rollback-recovery",
      sources: [alice, bob],
      decisions: [privateDecision(alice), privateDecision(bob)],
      nowMs: 1_000,
    });
    const aliceRevisionId = withScopedMemoryDatabase("main", (database) => {
      const row = database
        .prepare("SELECT classification_json FROM memory_migrations WHERE source_hash = ?")
        .get(sourceHash(alice)) as { classification_json: string };
      return (JSON.parse(row.classification_json) as { destination: { revisionId: string } })
        .destination.revisionId;
    });
    withScopedMemoryDatabase("main", (database) => {
      database
        .prepare(
          "UPDATE memory_resource_revisions SET lifecycle_state = 'tombstoned' WHERE revision_id = ?",
        )
        .run(aliceRevisionId);
    });

    rollbackFinalScopedMemoryMigration({
      agentId: "main",
      migrationId: result.migrationId,
      result,
      nowMs: 2_000,
    });

    expect(
      withScopedMemoryDatabase("main", (database) => ({
        phases: database
          .prepare("SELECT phase FROM memory_migrations ORDER BY source_hash")
          .all() as Array<{ phase: string }>,
        revisions: database
          .prepare("SELECT lifecycle_state FROM memory_resource_revisions ORDER BY revision_id")
          .all() as Array<{ lifecycle_state: string }>,
      })),
    ).toEqual({
      phases: [{ phase: "backed-up" }, { phase: "backed-up" }],
      revisions: [{ lifecycle_state: "tombstoned" }, { lifecycle_state: "tombstoned" }],
    });
  });

  it("reconstructs every durable pre-cutover phase without a duplicate scoped resource", () => {
    const source = {
      sourceId: "opaque-alice",
      sourceKind: "legacy-file",
      content: "Alice private fact",
    } as const;

    for (const phase of ["previewed", "backed-up", "copied", "indexed"] as const) {
      const agentId = `resume-${phase}`;
      const migrationId = `pilot-resume-${phase}`;
      const result = applyReviewed({
        agentId,
        migrationId,
        sources: [source],
        decisions: [privateDecision(source)],
        nowMs: 1_000,
      });
      withScopedMemoryDatabase(agentId, (database) => {
        database.prepare("UPDATE memory_migrations SET phase = ?, verified_at = NULL").run(phase);
      });

      expect(
        applyReviewed({
          agentId,
          migrationId,
          sources: [source],
          decisions: [privateDecision(source)],
          nowMs: 2_000,
        }),
      ).toEqual(result);
      expect(
        withScopedMemoryDatabase(agentId, (database) =>
          database.prepare("SELECT COUNT(*) AS count FROM memory_resources").get(),
        ),
      ).toEqual({ count: 1 });
    }
  });

  it("rejects an apply when source bytes changed after the reviewed dry run", () => {
    const reviewed = {
      sourceId: "opaque-alice",
      sourceKind: "legacy-file",
      content: "Alice private fact",
    } as const;
    const plan = planFinalScopedMemoryMigration({
      migrationId: "pilot-stale-review",
      actor,
      sources: [reviewed],
      decisions: [privateDecision(reviewed)],
    });

    expect(() =>
      applyFinalScopedMemoryMigration({
        agentId: "main",
        migrationId: "pilot-stale-review",
        actor,
        sources: [{ ...reviewed, content: "changed after review" }],
        decisions: [privateDecision(reviewed)],
        expectedPlanHash: plan.planHash,
        nowMs: 1_000,
      }),
    ).toThrow("decision does not match the discovered source hash");
  });

  it("rolls back from the reviewed plan without rediscovering legacy bytes", () => {
    const source = {
      sourceId: "opaque-alice",
      sourceKind: "legacy-file",
      content: "Alice private fact",
    } as const;
    const result = applyReviewed({
      agentId: "main",
      migrationId: "pilot-plan-rollback",
      sources: [source],
      decisions: [privateDecision(source)],
      nowMs: 1_000,
    });

    rollbackFinalScopedMemoryMigrationByPlan({
      agentId: "main",
      migrationId: result.migrationId,
      planHash: result.planHash,
      nowMs: 2_000,
    });
    expect(
      withScopedMemoryDatabase("main", (database) =>
        database.prepare("SELECT lifecycle_state FROM memory_resource_revisions").get(),
      ),
    ).toEqual({ lifecycle_state: "tombstoned" });
  });

  it("archives only cut-over legacy files and removes their exact legacy index rows", () => {
    const workspaceDir = path.join(stateDir, "workspace");
    const legacyPath = path.join(workspaceDir, "legacy.md");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(legacyPath, "Alice private fact");
    const source = {
      sourceId: "opaque-alice",
      sourceKind: "legacy-workspace-markdown",
      content: "Alice private fact",
      sourcePath: legacyPath,
    } as const;
    const result = applyReviewed({
      agentId: "main",
      migrationId: "pilot-archive",
      sources: [source],
      decisions: [privateDecision(source)],
      nowMs: 1_000,
    });
    const cutover = completeReviewedCutover({ result, nowMs: 2_000 });
    withScopedMemoryDatabase("main", (database) => {
      database
        .prepare(
          "INSERT INTO memory_index_sources(path, source, hash, mtime, size) VALUES (?, 'memory', 'legacy', 1, 1)",
        )
        .run(legacyPath);
      database
        .prepare(
          `INSERT INTO memory_index_chunks
             (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
           VALUES ('legacy-chunk', ?, 'memory', 1, 1, 'legacy', 'legacy', 'legacy', '[]', 1)`,
        )
        .run(legacyPath);
      database
        .prepare(
          "INSERT INTO memory_index_sources(path, source, hash, mtime, size) VALUES (?, 'memory', 'other', 1, 1)",
        )
        .run(path.join(workspaceDir, "other.md"));
      database
        .prepare(
          `INSERT INTO memory_index_chunks
             (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
           VALUES ('other-chunk', ?, 'memory', 1, 1, 'other', 'other', 'other', '[]', 1)`,
        )
        .run(path.join(workspaceDir, "other.md"));
      database.exec(`
        CREATE TABLE memory_index_chunks_fts (id TEXT, path TEXT, source TEXT);
        CREATE TABLE memory_index_paths_fts (path TEXT, source TEXT);
        CREATE TABLE memory_index_chunks_vec (id TEXT PRIMARY KEY);
      `);
      database
        .prepare(
          "INSERT INTO memory_index_chunks_fts (id, path, source) VALUES ('legacy-chunk', ?, 'memory')",
        )
        .run(legacyPath);
      database
        .prepare("INSERT INTO memory_index_paths_fts (path, source) VALUES (?, 'memory')")
        .run(legacyPath);
      database.prepare("INSERT INTO memory_index_chunks_vec (id) VALUES ('legacy-chunk')").run();
      database
        .prepare(
          "INSERT INTO memory_index_chunk_recall_metadata (chunk_id, importance) VALUES ('legacy-chunk', 5)",
        )
        .run();
      database
        .prepare(
          "INSERT INTO memory_index_chunk_provenance (chunk_id, origin_class, session_kind, observed_at) VALUES ('legacy-chunk', 'owner', 'interactive', 1)",
        )
        .run();
    });

    archiveFinalScopedMemoryMigration({
      agentId: "main",
      migrationId: result.migrationId,
      cutover,
      sources: [source],
      nowMs: 3_000,
    });
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(
      withScopedMemoryDatabase("main", (database) => ({
        sources: database.prepare("SELECT * FROM memory_index_sources").all(),
        chunks: database.prepare("SELECT * FROM memory_index_chunks").all(),
        fts: database.prepare("SELECT * FROM memory_index_chunks_fts").all(),
        pathFts: database.prepare("SELECT * FROM memory_index_paths_fts").all(),
        vectors: database.prepare("SELECT * FROM memory_index_chunks_vec").all(),
        recallMetadata: database.prepare("SELECT * FROM memory_index_chunk_recall_metadata").all(),
        provenance: database.prepare("SELECT * FROM memory_index_chunk_provenance").all(),
        migration: database.prepare("SELECT classification_json FROM memory_migrations").get() as {
          classification_json: string;
        },
      })),
    ).toMatchObject({
      sources: [expect.objectContaining({ path: path.join(workspaceDir, "other.md") })],
      chunks: [expect.objectContaining({ path: path.join(workspaceDir, "other.md") })],
      fts: [],
      pathFts: [],
      vectors: [],
      recallMetadata: [],
      provenance: [],
      migration: { classification_json: expect.stringContaining('"archive":{"state":"archived"') },
    });
  });

  it("refuses a partial archive when a cut-over source is no longer in the requested corpus", () => {
    const workspaceDir = path.join(stateDir, "workspace");
    const alicePath = path.join(workspaceDir, "alice.md");
    const bobPath = path.join(workspaceDir, "bob.md");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(alicePath, "Alice private fact");
    fs.writeFileSync(bobPath, "Bob private fact");
    const alice = {
      sourceId: "opaque-alice",
      sourceKind: "legacy-workspace-markdown",
      content: "Alice private fact",
      sourcePath: alicePath,
    } as const;
    const bob = {
      sourceId: "opaque-bob",
      sourceKind: "legacy-workspace-markdown",
      content: "Bob private fact",
      sourcePath: bobPath,
    } as const;
    const result = applyReviewed({
      agentId: "main",
      migrationId: "pilot-partial-archive",
      sources: [alice, bob],
      decisions: [privateDecision(alice), privateDecision(bob)],
      nowMs: 1_000,
    });
    const cutover = completeReviewedCutover({ result, nowMs: 2_000 });

    expect(() =>
      archiveFinalScopedMemoryMigration({
        agentId: "main",
        migrationId: result.migrationId,
        cutover,
        sources: [alice],
        nowMs: 3_000,
      }),
    ).toThrow("archival is incomplete");
    expect(fs.existsSync(bobPath)).toBe(true);
    expect(
      withScopedMemoryDatabase("main", (database) =>
        database
          .prepare("SELECT classification_json FROM memory_migrations WHERE source_hash = ?")
          .get(sourceHash(bob)),
      ),
    ).toEqual(
      expect.objectContaining({
        classification_json: expect.stringContaining('"archive":{"state":"pending"'),
      }),
    );
  });

  it("binds real selected-plugin evidence to the final marker and retains that posture after archive", () => {
    const workspaceDir = path.join(stateDir, "workspace");
    const legacyPath = path.join(workspaceDir, "legacy.md");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(legacyPath, "Alice private fact");
    const source = {
      sourceId: "opaque-alice",
      sourceKind: "legacy-workspace-markdown",
      content: "Alice private fact",
      sourcePath: legacyPath,
    } as const;
    const result = applyReviewed({
      agentId: "main",
      migrationId: "pilot-marker",
      sources: [source],
      decisions: [privateDecision(source)],
      nowMs: 1_000,
    });

    const cutover = completeReviewedCutover({ result, nowMs: 2_000 });
    archiveFinalScopedMemoryMigration({
      agentId: "main",
      migrationId: result.migrationId,
      cutover,
      sources: [source],
      nowMs: 3_000,
    });

    resetMemoryIsolationCutoverForTest();
    expect(resolveMemoryIsolationMode("main")).toBe("cutover");
  });

  it("exports only active scoped content with the downgrade metadata-loss warning", () => {
    const alice = {
      sourceId: "opaque-alice",
      sourceKind: "legacy-workspace-markdown",
      content: "Alice private fact",
    } as const;
    const ambiguous = {
      sourceId: "opaque-ambiguous",
      sourceKind: "legacy-transcript",
      content: "unbound history",
    } as const;
    const result = applyReviewed({
      agentId: "main",
      migrationId: "pilot-export",
      sources: [alice, ambiguous],
      decisions: [privateDecision(alice)],
      nowMs: 1_000,
    });
    const cutover = completeReviewedCutover({ result, nowMs: 2_000 });
    const outputDir = path.join(stateDir, "downgrade-export");

    const exported = exportFinalScopedMemoryMigration({
      agentId: "main",
      migrationId: result.migrationId,
      cutover,
      outputDir,
      nowMs: 3_000,
    });

    expect(exported).toMatchObject({
      outputDir,
      exportedResources: 1,
      excludedQuarantineResources: 1,
      warning: expect.stringContaining(
        "omits audience, policy, identity, lineage, and audit metadata",
      ),
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8")) as {
      warning: string;
      exported: Array<{ file: string; contentHash: string }>;
      excludedQuarantineResources: number;
    };
    expect(manifest).toMatchObject({
      excludedQuarantineResources: 1,
      warning: exported.warning,
      exported: [{ contentHash: finalScopedMemoryMigrationTestApi.sha256(alice.content) }],
    });
    expect(fs.readFileSync(path.join(outputDir, manifest.exported[0]!.file), "utf8")).toBe(
      alice.content,
    );
    resetMemoryIsolationCutoverForTest();
    expect(resolveMemoryIsolationMode("main")).toBe("cutover");
  });

  it("removes partial downgrade export output when a later scoped resource cannot be verified", () => {
    const first = {
      sourceId: "opaque-first",
      sourceKind: "legacy-workspace-markdown",
      content: "First private fact",
    } as const;
    const second = {
      sourceId: "opaque-second",
      sourceKind: "legacy-workspace-markdown",
      content: "Second private fact",
    } as const;
    const result = applyReviewed({
      agentId: "main",
      migrationId: "pilot-export-cleanup",
      sources: [first, second],
      decisions: [privateDecision(first), privateDecision(second)],
      nowMs: 1_000,
    });
    const cutover = completeReviewedCutover({ result, nowMs: 2_000 });
    const brokenArtifact = withScopedMemoryDatabase("main", (database, databasePath) => {
      const revision = database
        .prepare(
          `SELECT root.path_key, revision.artifact_locator
             FROM memory_resource_revisions AS revision
             JOIN memory_resources AS resource ON resource.resource_id = revision.resource_id
             JOIN memory_stores AS store ON store.store_id = resource.store_id
             JOIN memory_storage_roots AS root ON root.storage_root_id = store.storage_root_id
            WHERE revision.lifecycle_state = 'active'
            ORDER BY revision.revision_id DESC
            LIMIT 1`,
        )
        .get() as { path_key: string; artifact_locator: string };
      return resolveBuiltinScopedMemoryArtifactPath({
        databasePath,
        pathKey: revision.path_key,
        artifactLocator: revision.artifact_locator,
      });
    });
    fs.unlinkSync(brokenArtifact);
    const outputDir = path.join(stateDir, "downgrade-export-partial");

    expect(() =>
      exportFinalScopedMemoryMigration({
        agentId: "main",
        migrationId: result.migrationId,
        cutover,
        outputDir,
        nowMs: 3_000,
      }),
    ).toThrow("could not verify");
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it("recovers an archive that moved a source after its exact legacy rows were removed", () => {
    const workspaceDir = path.join(stateDir, "workspace");
    const legacyPath = path.join(workspaceDir, "legacy.md");
    const migrationId = "pilot-archive-recovery";
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(legacyPath, "Alice private fact");
    const source = {
      sourceId: "opaque-alice",
      sourceKind: "legacy-workspace-markdown",
      content: "Alice private fact",
      sourcePath: legacyPath,
    } as const;
    const result = applyReviewed({
      agentId: "main",
      migrationId,
      sources: [source],
      decisions: [privateDecision(source)],
      nowMs: 1_000,
    });
    const cutover = completeReviewedCutover({ result, nowMs: 2_000 });
    const archivingJson = withScopedMemoryDatabase("main", (database) => {
      const row = database.prepare("SELECT classification_json FROM memory_migrations").get() as {
        classification_json: string;
      };
      const evidence = JSON.parse(row.classification_json) as Parameters<
        typeof finalScopedMemoryMigrationTestApi.createEvidenceClassification
      >[0];
      return finalScopedMemoryMigrationTestApi.createEvidenceClassification({
        ...evidence,
        archive: { state: "archiving" },
      });
    });
    withScopedMemoryDatabase("main", (database) => {
      database.prepare("UPDATE memory_migrations SET classification_json = ?").run(archivingJson);
      database
        .prepare("DELETE FROM memory_index_chunks WHERE path = ? AND source = 'memory'")
        .run(legacyPath);
      database
        .prepare("DELETE FROM memory_index_sources WHERE path = ? AND source = 'memory'")
        .run(legacyPath);
    });
    const archiveDir = path.join(
      stateDir,
      "agents",
      "main",
      "agent",
      "memory-migration-archive",
      "v1",
      `m6_${createHash("sha256").update(migrationId).digest("hex").slice(0, 32)}`,
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.renameSync(legacyPath, path.join(archiveDir, "opaque-alice.archive"));

    archiveFinalScopedMemoryMigration({
      agentId: "main",
      migrationId,
      cutover,
      sources: [],
      nowMs: 3_000,
    });

    expect(
      withScopedMemoryDatabase("main", (database) =>
        database.prepare("SELECT classification_json FROM memory_migrations").get(),
      ),
    ).toEqual(
      expect.objectContaining({
        classification_json: expect.stringContaining('"archive":{"state":"archived"'),
      }),
    );
  });

  it("keeps filenames and source paths out of the durable dry-run identity", () => {
    const workspaceDir = path.join(stateDir, "workspace");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    fs.mkdirSync(path.join(workspaceDir, "memory", "imports", "codex"), { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "MEMORY.md"), "workspace fact");
    fs.writeFileSync(path.join(workspaceDir, "memory", "private.md"), "memory fact");
    fs.writeFileSync(
      path.join(workspaceDir, "memory", "imports", "codex", "nested.md"),
      "nested fact",
    );
    fs.writeFileSync(path.join(sessionsDir, "session.jsonl"), "transcript fact\n");

    const sources = discoverFinalScopedMemoryMigrationSources({
      agentId: "main",
      workspaceDir,
      stateDir,
    });
    expect(sources).toHaveLength(4);
    expect(sources.every((source) => source.sourceId.startsWith("m6_"))).toBe(true);
    const plan = planFinalScopedMemoryMigration({ migrationId: "pilot-scan", actor, sources });
    expect(JSON.stringify(plan)).not.toContain("MEMORY.md");
    expect(JSON.stringify(plan)).not.toContain("private.md");
    expect(JSON.stringify(plan)).not.toContain("session.jsonl");
  });
});
