import { createHash, randomUUID } from "node:crypto";
import {
  completeMemoryIsolationCutover,
  memoryIsolationCutoverTestApi,
  resetMemoryIsolationCutoverForTest,
} from "../plugins/memory-cutover.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";

/** Build a complete migration manifest in tests instead of bypassing final-cutover validation. */
export function completeTestMemoryIsolationCutover(options: OpenClawAgentDatabaseOptions): void {
  const migrationId = `test-migration:${randomUUID()}`;
  const sourceHash = `sha256:${createHash("sha256").update(randomUUID()).digest("hex")}`;
  const contentHash = `sha256:${createHash("sha256").update(randomUUID()).digest("hex")}`;
  const planHash = `sha256:${createHash("sha256").update(randomUUID()).digest("hex")}`;
  const classificationJson = memoryIsolationCutoverTestApi.createVerifiedSourceClassification({
    migrationId,
    sourceId: `test-source:${randomUUID()}`,
    sourceKind: "test-memory-isolation",
    sourceHash,
    contentHash,
  });
  const database = openOpenClawAgentDatabase(options);
  database.db
    .prepare(
      `INSERT INTO memory_migrations
        (migration_id, source_kind, source_hash, phase, classification_json, plan_hash,
         verified_at, cutover_at, updated_at)
       VALUES (?, 'test-memory-isolation', ?, 'verified', ?, ?, 1, NULL, 1)`,
    )
    .run(migrationId, sourceHash, classificationJson, planHash);
  completeMemoryIsolationCutover({
    agentId: options.agentId,
    migrationId,
    planHash,
    sources: [{ sourceKind: "test-memory-isolation", sourceHash }],
    nowMs: 2,
    options,
  });
  resetMemoryIsolationCutoverForTest();
}
