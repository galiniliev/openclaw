import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createBackupResourcePlan } from "../commands/backup-resource-inventory.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupSqliteSnapshotPlan } from "./backup-sqlite-snapshot.js";

const mocks = vi.hoisted(() => ({ registry: vi.fn(), exportPostgres: vi.fn() }));
vi.mock("../state/openclaw-agent-db-registry-listing.js", async (original) => ({
  ...(await original<typeof import("../state/openclaw-agent-db-registry-listing.js")>()),
  inspectOpenClawRegisteredAgentDatabases: mocks.registry,
}));
vi.mock("../snapshot/database-backup.js", async (original) => ({
  ...(await original<typeof import("../snapshot/database-backup.js")>()),
  capturePostgresBackup: mocks.exportPostgres,
}));

it("captures companion anchors and fixed-local credentials without exporting PostgreSQL rows", async () => {
  await withOpenClawTestState({ layout: "state-only", scenario: "empty" }, async (state) => {
    const shared = state.statePath("state/openclaw.sqlite");
    const agent = state.statePath("agents/retained/agent/openclaw-agent.sqlite");
    const client = state.statePath("client/credentials.sqlite");
    for (const [file, id] of [
      [shared, "shared-store"],
      [agent, "agent-store"],
    ] as const) {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      using database = new DatabaseSync(file);
      database.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)",
      );
      database
        .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
        .run(id, `${id.replaceAll("-", "_")}_namespace`);
    }
    await fs.mkdir(path.dirname(client), { recursive: true, mode: 0o700 });
    {
      using database = new DatabaseSync(client);
      database.exec("CREATE TABLE native_exec_socket_credentials (socket_token TEXT)");
      database.exec("INSERT INTO native_exec_socket_credentials VALUES ('synthetic-retained-key')");
    }
    mocks.registry.mockResolvedValue([
      { agentId: "retained", path: agent, schemaVersion: 23, lastSeenAt: 1, sizeBytes: null },
    ]);
    mocks.exportPostgres.mockImplementation(() => {
      throw new Error("Companion capture must not export database rows");
    });
    const resources = await createBackupResourcePlan({
      stateDir: state.stateDir,
      configPaths: [],
      oauthDirs: [],
      workspaceDirs: [],
      excludedWorkspaceDirs: [],
      agentRoots: [],
      pluginResources: [],
      pluginRoots: [],
    });
    const tempDir = state.path("capture");
    await fs.mkdir(tempDir, { mode: 0o700 });
    const result = await createBackupSqliteSnapshotPlan({
      resources,
      tempDir,
      legacyAuditSnapshots: [],
      localCompanion: true,
    });
    expect(result.postgresSnapshots).toEqual([]);
    expect(result.postgresAnchors).toEqual(
      expect.arrayContaining([
        { sourcePath: shared, storeId: "shared-store", namespace: "shared_store_namespace" },
        { sourcePath: agent, storeId: "agent-store", namespace: "agent_store_namespace" },
      ]),
    );
    expect(result.postgresAnchors).toHaveLength(2);
    expect(mocks.exportPostgres).not.toHaveBeenCalled();
    const credentials = result.snapshots.find((snapshot) => snapshot.archiveSourcePath === client);
    expect(credentials).toBeDefined();
    using copied = new DatabaseSync(credentials!.sourcePath, { readOnly: true });
    expect(
      copied.prepare("SELECT socket_token FROM native_exec_socket_credentials").get(),
    ).toMatchObject({ socket_token: "synthetic-retained-key" });
  });
});
