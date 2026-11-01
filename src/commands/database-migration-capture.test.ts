import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withDaemonRuntimePinStore } from "../daemon/runtime-pin-store.js";
import { buildBackupArchivePath } from "../infra/backup-archive-path-policy.js";
import { createBackupArchive } from "../infra/backup-create.js";
import { readClientCredentialFileIdentity } from "../infra/client-credential-receipt.js";
import { capturePortClientCredentialBinding } from "../infra/client-credential-restore.js";
import {
  openClientCredentialCustody,
  runClientCredentialOperation,
} from "../infra/client-credential-store.js";
import { enqueueDelivery } from "../infra/outbound/delivery-queue-storage.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createDatabaseMigrationCapture,
  restoreDatabaseMigrationCapture,
} from "./database-migration-capture.js";
import { createDatabaseMigrationFilesystemBackup } from "./database-migration-filesystem-backup.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

describe("exact database migration capture", () => {
  it("creates and verifies the filesystem base through the isolated archive producer", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const config = { plugins: { enabled: false } };
      await state.writeConfig(config);
      openOpenClawStateDatabase({ env: state.env });
      await closeOpenClawStateDatabaseAsync();
      const output = state.path("isolated-filesystem.tar.gz");
      await createDatabaseMigrationFilesystemBackup({
        output,
        stateDir: state.stateDir,
        config,
        env: state.env,
        signal: new AbortController().signal,
      });
      expect((await fs.stat(output)).size).toBeGreaterThan(0);
    });
  });

  it("restores exact delivery and fixed-local data over a full private filesystem base", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await state.writeConfig({ plugins: { enabled: false } });
      const source = openOpenClawStateDatabase({ env: state.env });
      source.db.exec(
        "CREATE TABLE migration_witness(value TEXT); INSERT INTO migration_witness VALUES ('exact retained history');",
      );
      withDaemonRuntimePinStore(state.env, true, (db) => {
        db.prepare("INSERT INTO daemon_runtime_pins VALUES (?, ?, ?)").run(
          "migration-pin",
          "retained runtime",
          123,
        );
      });
      runClientCredentialOperation(state.env, {
        kind: "socket.ensure",
        fallback: {
          socket_key: "current",
          socket_path: "/synthetic/native.sock",
          socket_token: "retained-private-token",
          updated_at_ms: 123,
        },
        requested: { token: "retained-private-token" },
      });
      await enqueueDelivery(
        { channel: "matrix", to: "!room:example", payloads: [{ text: "retained send intent" }] },
        state.stateDir,
      );
      const witness = await state.writeText("workspace/user.txt", "retained workspace bytes");
      await closeOpenClawStateDatabaseAsync();
      const base = await createBackupArchive({ output: state.path("base.tar.gz"), verify: true });
      const output = state.path("capsule");
      const capture = await createDatabaseMigrationCapture({
        baseArchive: base.archivePath,
        output,
      });
      expect(capture).toMatchObject({ ok: true, profile: "exact-sqlite-migration" });
      const manifest = JSON.parse(await fs.readFile(capture.manifestPath, "utf8"));
      expect(manifest.databases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourcePath: state.statePath("state/openclaw.sqlite") }),
          expect.objectContaining({ sourcePath: state.statePath("client/credentials.sqlite") }),
          expect.objectContaining({ sourcePath: state.statePath("control/services.sqlite") }),
        ]),
      );
      const runtime = createTestRuntime();
      const restored = await restoreDatabaseMigrationCapture(runtime, {
        capture: output,
        target: state.path("staging"),
        manifestSha256: capture.manifestSha256,
      });
      expect(runtime.log).not.toHaveBeenCalled();
      expect(restored.exactMigration).toMatchObject({
        captureId: capture.captureId,
        sourceStateDir: state.stateDir,
      });
      const staged = (file: string) =>
        path.join(restored.targetPath, buildBackupArchivePath(restored.archiveRoot, file));
      {
        using database = new DatabaseSync(staged(state.statePath("state/openclaw.sqlite")), {
          readOnly: true,
        });
        expect(database.prepare("SELECT value FROM migration_witness").all()).toEqual([
          { value: "exact retained history" },
        ]);
        expect(database.prepare("SELECT entry_json FROM delivery_queue_entries").all()).toEqual([
          expect.objectContaining({ entry_json: expect.stringContaining("retained send intent") }),
        ]);
        expect(await fs.readFile(staged(witness), "utf8")).toBe("retained workspace bytes");
        using pins = new DatabaseSync(staged(state.statePath("control/services.sqlite")), {
          readOnly: true,
        });
        expect(pins.prepare("SELECT state_key,value_json FROM daemon_runtime_pins").all()).toEqual([
          { state_key: "migration-pin", value_json: "retained runtime" },
        ]);
        using credentials = new DatabaseSync(staged(state.statePath("client/credentials.sqlite")), {
          readOnly: true,
        });
        expect(
          credentials
            .prepare(
              "SELECT socket_token FROM native_exec_socket_credentials WHERE socket_key='current'",
            )
            .get(),
        ).toEqual({ socket_token: "retained-private-token" });
      }
      expect(await fs.readFile(witness, "utf8")).toBe("retained workspace bytes");
      const promotedState = state.path("promoted-state");
      await fs.rename(staged(state.stateDir), promotedState);
      const promotedEnv = { ...state.env, OPENCLAW_STATE_DIR: promotedState };
      const promotedShared = path.join(promotedState, "state/openclaw.sqlite");
      const promotedFile = readClientCredentialFileIdentity(promotedShared);
      if (!promotedFile) {
        throw new Error("Promoted synthetic shared store is missing");
      }
      expect(
        capturePortClientCredentialBinding({
          env: promotedEnv,
          sourcePath: promotedShared,
          sourceFile: promotedFile,
        }),
      ).not.toBeNull();
      using admitted = openClientCredentialCustody(promotedEnv, { readOnly: true });
      expect(admitted?.run({ kind: "socket.read" })).toMatchObject({
        kind: "socket",
        socket: { socket_token: "retained-private-token" },
      });
      // Signed POSIX witnesses pass format admission, but still cannot rebind a different source.
      const signedManifest = JSON.stringify({
        ...manifest,
        sourceSharedFile: { ...manifest.sourceSharedFile, dev: "-123", ino: "-456" },
      });
      await fs.writeFile(capture.manifestPath, signedManifest);
      const rejectedTarget = state.path("signed-witness-staging");
      await expect(
        restoreDatabaseMigrationCapture(runtime, {
          capture: output,
          target: rejectedTarget,
          manifestSha256: createHash("sha256").update(signedManifest).digest("hex"),
        }),
      ).rejects.toThrow("do not match the captured shared database");
      await expect(fs.stat(rejectedTarget)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refuses a changed capsule before creating any restore target", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await state.writeConfig({ plugins: { enabled: false } });
      openOpenClawStateDatabase({ env: state.env });
      await closeOpenClawStateDatabaseAsync();
      const base = await createBackupArchive({ output: state.path("base.tar.gz"), verify: true });
      const capture = await createDatabaseMigrationCapture({
        baseArchive: base.archivePath,
        output: state.path("capsule"),
      });
      const manifest = JSON.parse(await fs.readFile(capture.manifestPath, "utf8"));
      await fs.appendFile(path.join(capture.directory, manifest.configs[0].file), "changed");
      const target = state.path("staging");
      await expect(
        restoreDatabaseMigrationCapture(createTestRuntime(), {
          capture: capture.directory,
          target,
          manifestSha256: capture.manifestSha256,
        }),
      ).rejects.toThrow("artifact changed");
      await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      await fs.appendFile(capture.manifestPath, " ");
      await expect(
        restoreDatabaseMigrationCapture(createTestRuntime(), {
          capture: capture.directory,
          target,
          manifestSha256: capture.manifestSha256,
        }),
      ).rejects.toThrow("differs from its producer receipt");
      await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
