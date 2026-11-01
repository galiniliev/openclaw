import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import { runDatabasePortTask } from "../infra/database-engine/port-command.worker.js";
import { syncDatabasePortPath } from "../infra/database-port-recovery.js";
import {
  createPrivateSqliteTempDirectory,
  resolvePrivateSqliteSnapshotStagingRoot,
} from "../infra/sqlite-private-directory.js";
import { publishVerifiedSqliteFile } from "../infra/sqlite-snapshot.js";
import { withStateInspectionCleanup } from "../infra/update-candidate-state.process.js";
import { assertDatabaseArtifact, captureDatabaseArtifact } from "../snapshot/database-backup.js";
import {
  type Context,
  manifest,
  refuse,
  revise,
  storeAt,
  storeDirectory,
} from "./doctor-database-port-context.js";

async function copyPortArtifact(
  ctx: Context,
  source: Parameters<typeof assertDatabaseArtifact>[0],
  targetPath: string,
) {
  await publishVerifiedSqliteFile({
    sourcePath: source.path,
    sourceIdentity: fs.lstatSync(source.path, { bigint: true }),
    targetPath,
    expectedContent: { sha256: source.sha256, sizeBytes: source.size },
    beforePublish: ctx.assertCurrent,
    afterPublish: (guard) => {
      guard.assertTargetUnchanged(ctx.assertCurrent);
    },
  });
}

async function privateMigrate(
  ctx: Context,
  index: number,
  config: OpenClawConfig,
  localPath: string,
) {
  ctx.phase = "private migrate";
  const current = manifest(ctx);
  const prefix = path.join(storeDirectory(ctx, index), "working-");
  const recorded = current.artifacts.find((file) => file.path.startsWith(prefix));
  const source =
    recorded ?? current.artifacts.find((file) => file.path === storeAt(ctx, index).input.image);
  if (!source) {
    refuse(ctx, "missing recorded original image", "manifest-bound SQLite capture");
  }
  // The original was verified before journaling. Copy its pinned bytes, rather
  // than repeating SQLite integrity queries on the durable network filesystem.
  await copyPortArtifact(ctx, source, localPath);
  if (recorded) {
    return;
  }
  await runDatabasePortTask({ operation: "migrate", sourcePath: localPath, config }, ctx);
  await runDatabasePortTask({ operation: "checkpoint", sourcePath: localPath }, ctx);
  syncDatabasePortPath(localPath);
  const qualified = await captureDatabaseArtifact(localPath);
  const file = `${prefix}${randomUUID()}.sqlite`;
  await copyPortArtifact(ctx, qualified, file);
  current.artifacts.push(await captureDatabaseArtifact(file));
  revise(ctx);
}
/** Preserve the durable journal while SQL consumes a rebuildable private image. */
export async function withDatabasePortWorkingCopy<T>(
  ctx: Context,
  index: number,
  config: OpenClawConfig,
  run: (working: string) => Promise<T>,
): Promise<T> {
  const scratch = await createPrivateSqliteTempDirectory(
    resolvePrivateSqliteSnapshotStagingRoot(ctx.env),
    "database-port-working-",
  );
  const working = path.join(scratch, "database.sqlite");
  // Failed workers may retain native custody. Keep scratch on failure and clean
  // only after the joined migration, checkpoint and consuming stage succeed.
  await privateMigrate(ctx, index, config, working);
  const result = await run(working);
  return withStateInspectionCleanup(scratch, async () => result);
}
