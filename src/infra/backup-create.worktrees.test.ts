import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withWorktreeAllocationLease } from "../agents/worktrees/allocation.js";
import { reservePendingWorktree } from "../agents/worktrees/pending-slots.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { makeWorktreeRecord } from "../agents/worktrees/service.test-support.js";
import { verifyBackupArchive } from "../commands/backup-verify.js";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildBackupArchivePath } from "./backup-archive-path-policy.js";
import {
  backupCase,
  declarePluginSqliteResources,
  createOwnedSqliteDatabase,
  createVerifiedBackup,
  expectAbsent,
  expectDatabaseRows,
  mkdirs,
  restoreBackup,
  withDatabase,
} from "./backup-create-family.test-support.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntries } from "./backup-create.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";

const record = (root: string, id: string, worktreePath: string) =>
  makeWorktreeRecord(root, id, {
    path: worktreePath,
    branch: `worktree/${id}`,
    ownerId: `agent:main:${id}`,
  });

describe("backup managed workspaces", () => {
  it.each([1, 17])(
    "backs up pre-Doctor state without rewriting schema %s",
    backupCase({ prefix: "backup-worktree-upgrade-" })(async (state, schemaVersion) => {
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      const live = state.statePath("checkouts", "live");
      const removed = state.statePath("checkouts", "removed");
      await mkdirs(path.dirname(databasePath), live, removed);
      await fs.writeFile(path.join(live, "source.txt"), "live checkout\n");
      await fs.writeFile(path.join(removed, "source.txt"), "reused path\n");
      createOwnedSqliteDatabase({ sqlitePath: databasePath, role: "global", schemaVersion });
      withDatabase(databasePath, (database) => {
        // Discovery needs only scope and live paths, not the newer full worktree record.
        database.exec(`CREATE TABLE state_leases (
          scope TEXT NOT NULL
        )`);
        if (schemaVersion === 17) {
          database.exec(`CREATE TABLE worktrees (
            path TEXT NOT NULL, removed_at INTEGER
          ) STRICT`);
          for (const [root, removedAt] of [
            [live, null],
            [removed, 2],
          ] as const) {
            database
              .prepare("INSERT INTO worktrees (path, removed_at) VALUES (?, ?)")
              .run(root, removedAt);
          }
        }
      });
      const original = await fs.readFile(databasePath);
      // Capture is read-only; the CLI separately records its outcome in the live store.
      const archive = await createBackupArchive({
        output: state.path("backup.tar.gz"),
        includeWorkspace: false,
      });
      const restored = await restoreBackup(state, archive);
      const restoredPath = (source: string) =>
        path.join(restored.targetPath, buildBackupArchivePath(archive.archiveRoot, source));
      const readRestored = (source: string) => fs.readFile(restoredPath(source), "utf8");
      if (schemaVersion === 17) {
        await expectAbsent(restoredPath(path.join(live, "source.txt")));
      } else {
        await expect(readRestored(path.join(live, "source.txt"))).resolves.toBe("live checkout\n");
      }
      await expect(readRestored(path.join(removed, "source.txt"))).resolves.toBe("reused path\n");
      expectDatabaseRows(restoredPath(databasePath), "PRAGMA user_version", [
        { user_version: schemaVersion },
      ]);
      expect((await fs.readFile(databasePath)).equals(original)).toBe(true);
    }),
  );

  it(
    "omits registered old and custom roots while restoring nested owners and reused retired paths",
    backupCase({ layout: "home", prefix: "backup-managed-worktrees-" })(async (state) => {
      const oldRoot = state.statePath("worktrees", "old-root-chat");
      const customRoot = state.statePath("custom-checkouts", "current-chat");
      const pendingRoot = state.statePath("worktrees", "pending-chat");
      const retiredRoot = state.statePath("worktrees", "reused-path");
      const protectedAgent = path.join(oldRoot, "durable-agent");
      const credentials = path.join(oldRoot, "credentials");
      const includePath = path.join(oldRoot, "settings.json");
      await mkdirs(protectedAgent, credentials);
      await fs.writeFile(includePath, JSON.stringify({ identity: { name: "Kept" } }));
      await fs.writeFile(path.join(credentials, "credential.txt"), "synthetic credential\n");
      Object.assign(state.envVars, {
        OPENCLAW_INCLUDE_ROOTS: oldRoot,
        OPENCLAW_OAUTH_DIR: credentials,
      });
      state.applyEnv();
      await state.writeConfig({
        agents: {
          ownership: "explicit",
          entries: { main: { agentDir: protectedAgent, $include: includePath } },
        },
        worktreeRoot: state.statePath("custom-checkouts"),
      });
      const agentPath = path.join(protectedAgent, "openclaw-agent.sqlite");
      openOpenClawAgentDatabase({ agentId: "main", path: agentPath, env: state.env });
      for (const [id, root] of [
        ["old", oldRoot],
        ["custom", customRoot],
        ["retired", retiredRoot],
      ] as const) {
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(path.join(root, "build-output.bin"), "workspace bytes\n");
        await insertRegistryWorktree(state.env, {
          ...record(state.root, id, root),
          ...(id === "retired" ? { removedAt: 2 } : {}),
        });
      }
      const pending = record(state.root, "pending", pendingRoot);
      await withWorktreeAllocationLease({ env: state.env, id: pending.id }, async (guard) => {
        await reservePendingWorktree(state.env, pending, guard.workerAuthority);
        await fs.mkdir(pendingRoot, { recursive: true });
        await fs.writeFile(path.join(pendingRoot, "build-output.bin"), "pending bytes\n");
      });
      const adjacent = await state.writeText("worktrees/operator-notes.txt", "keep notes\n");
      await closeStateDatabaseForTest();

      const archive = await createVerifiedBackup(state);
      const restored = await restoreBackup(state, archive);
      const restoredPath = (source: string) =>
        path.join(restored.targetPath, buildBackupArchivePath(archive.archiveRoot, source));
      const readRestored = (source: string) => fs.readFile(restoredPath(source), "utf8");
      for (const root of [oldRoot, customRoot, pendingRoot]) {
        await expectAbsent(restoredPath(path.join(root, "build-output.bin")));
        expect(await fs.readFile(path.join(root, "build-output.bin"), "utf8")).toMatch(/bytes/);
      }
      for (const [file, contents] of [
        [path.join(retiredRoot, "build-output.bin"), "workspace bytes\n"],
        [adjacent, "keep notes\n"],
        [includePath, JSON.stringify({ identity: { name: "Kept" } })],
        [path.join(credentials, "credential.txt"), "synthetic credential\n"],
      ] as const) {
        await expect(readRestored(file)).resolves.toBe(contents);
      }
      expectDatabaseRows(
        restoredPath(agentPath),
        "SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'",
        [{ role: "agent", agent_id: "main" }],
      );
    }),
  );

  it.each([false, true])(
    "keeps the existing full-backup selection and resolves registered aliases (includeWorkspace=%s)",
    backupCase({ prefix: "backup-worktree-alias-" })(async (state, includeWorkspace) => {
      const root = state.statePath("worktrees", "chat");
      const alias = state.statePath("chat-alias");
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "source.txt"), "managed source\n");
      await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
      await insertRegistryWorktree(state.env, record(state.root, "aliased", alias));
      await closeStateDatabaseForTest();
      const archive = await createVerifiedBackup(state, { includeWorkspace });
      const entries = await listArchiveEntries(archive.archivePath);
      for (const source of [path.join(root, "source.txt"), alias]) {
        expect(entries.includes(buildBackupArchivePath(archive.archiveRoot, source))).toBe(
          includeWorkspace,
        );
      }
    }),
  );
});

describe("backup worktree template selection", () => {
  beforeEach(() => vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1"));
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    { excludeWorktreeTemplates: false, customRoot: false },
    { excludeWorktreeTemplates: true, customRoot: false },
    { excludeWorktreeTemplates: true, customRoot: true },
  ])(
    "preserves checkout and retained state (selected=$excludeWorktreeTemplates, custom=$customRoot)",
    async ({ excludeWorktreeTemplates, customRoot }) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          agents: { defaults: { workspace: state.workspaceDir } },
          ...(customRoot ? { worktreeRoot: state.statePath("custom-worktrees") } : {}),
        });
        const cache = `${customRoot ? "custom-worktrees" : "worktrees"}/.templates/generation/dependencies.txt`;
        const retained = [
          "worktrees/repository/checkout/unique-edit.txt",
          "repositories/source/.git/refs/openclaw/snapshots/removed-checkout",
          "retained/native-context.bin",
          "history/messages.bin",
          "credentials/private-state.bin",
        ];
        for (const relative of [cache, ...retained]) {
          await state.writeText(relative, `synthetic ${relative}\n`);
        }
        await fs.mkdir(state.workspaceDir, { recursive: true });
        await fs.writeFile(path.join(state.workspaceDir, "authored.txt"), "authored workspace\n");
        const result = await backupCreateCommand(createTestRuntime(), {
          output: state.path("backup.tar.gz"),
          excludeWorktreeTemplates,
          verify: true,
          json: true,
        });
        expect(result.verified).toBe(true);
        const entries = await listArchiveEntries(result.archivePath);
        const archived = (source: string) => buildBackupArchivePath(result.archiveRoot, source);
        expect(entries.includes(archived(state.statePath(cache)))).toBe(!excludeWorktreeTemplates);
        for (const relative of retained) {
          expect(entries).toContain(archived(state.statePath(relative)));
        }
        expect(entries).toContain(archived(path.join(state.workspaceDir, "authored.txt")));
        expect(result.skipped.filter((entry) => entry.kind === "worktree templates")).toHaveLength(
          excludeWorktreeTemplates ? 1 : 0,
        );
        const restored = state.path("restore");
        await fs.mkdir(restored);
        await tar.x({ file: result.archivePath, gzip: true, cwd: restored });
        for (const relative of retained) {
          expect(
            await fs.readFile(path.join(restored, archived(state.statePath(relative))), "utf8"),
          ).toBe(`synthetic ${relative}\n`);
        }
        const manifest = JSON.parse(
          await fs.readFile(path.join(restored, result.archiveRoot, "manifest.json"), "utf8"),
        );
        expect(manifest.options.excludeWorktreeTemplates ?? false).toBe(excludeWorktreeTemplates);
      });
    },
  );

  it("retains an explicitly owned durable plugin resource nested in the template directory", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await declarePluginSqliteResources(state, "worktrees/.templates/durable-owner");
      await state.writeText("worktrees/.templates/durable-owner/keep.txt", "durable\n");
      await state.writeText("worktrees/.templates/generation/dependency.txt", "regenerable\n");
      const databasePath = state.statePath("worktrees/.templates/durable-owner/context.sqlite");
      const database = new (requireNodeSqlite().DatabaseSync)(databasePath);
      try {
        database.exec(
          "CREATE TABLE retained_context (value TEXT); INSERT INTO retained_context VALUES ('keep');",
        );
      } finally {
        database.close();
      }
      const result = await backupCreateCommand(createTestRuntime(), {
        output: state.path("backup.tar.gz"),
        excludeWorktreeTemplates: true,
        verify: true,
        json: true,
      });
      expect(result.verified).toBe(true);
      const entries = await listArchiveEntries(result.archivePath);
      expect(entries.some((entry) => entry.endsWith("/durable-owner/keep.txt"))).toBe(true);
      expect(entries.some((entry) => entry.endsWith("/generation/dependency.txt"))).toBe(false);
      const restored = state.path("restore");
      await fs.mkdir(restored);
      await tar.x({ file: result.archivePath, gzip: true, cwd: restored });
      expectDatabaseRows(
        path.join(restored, buildBackupArchivePath(result.archiveRoot, databasePath)),
        "SELECT value FROM retained_context",
        [{ value: "keep" }],
      );
    });
  });
});
