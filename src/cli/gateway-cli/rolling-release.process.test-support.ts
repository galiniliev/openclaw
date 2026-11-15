import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { startGatewayServer } from "../../gateway/server.js";
import { createBackupArchive } from "../../infra/backup-create.js";
import { routeLogsToStderr } from "../../logging/console.js";
import { getMediaDir } from "../../media/store.js";

routeLogsToStderr();
const port = Number(process.env.OPENCLAW_GATEWAY_PORT);
const server = await startGatewayServer(port, {
  bootId: "fixture-old-boot",
  sidecarStartup: "defer",
  bind: "loopback",
});
await server.startupSettled;
process.send?.({ type: "ready" });
let operations = Promise.resolve();
process.on(
  "message",
  (request: {
    id: string;
    action: "capture" | "seed-companion" | "close";
    output?: string;
    captureAtMs?: number;
  }) => {
    operations = operations.then(async () => {
      try {
        if (request.action === "capture") {
          const archive = await createBackupArchive({
            output: request.output,
            nowMs: request.captureAtMs,
            localCompanion: true,
            preserveSourceArtifacts: true,
            includeWorkspace: true,
            excludeWorktreeTemplates: true,
          });
          process.send?.({ id: request.id, ok: true, archive });
        } else if (request.action === "seed-companion") {
          const root = path.join(process.env.OPENCLAW_STATE_DIR!, "rolling-fixture");
          await fs.mkdir(root, { recursive: true, mode: 0o700 });
          await fs.writeFile(
            path.join(root, "provider-journal.json"),
            JSON.stringify({ fixture: true, epoch: "final-before-fence" }),
            { mode: 0o600 },
          );
          await fs.writeFile(
            path.join(root, "file-credential.json"),
            JSON.stringify({ synthetic: "final-before-fence" }),
            { mode: 0o600 },
          );
          const git = promisify(execFile);
          const repository = path.join(root, "checkpoint");
          const gitOptions = {
            env: {
              PATH: process.env.PATH,
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
            },
          };
          await git("git", ["init", "--quiet", repository], gitOptions);
          await fs.writeFile(path.join(repository, "fixture.txt"), "final-before-fence\n");
          await git("git", ["-C", repository, "add", "fixture.txt"], gitOptions);
          await git(
            "git",
            [
              "-C",
              repository,
              "-c",
              "user.name=Synthetic Fixture",
              "-c",
              "user.email=fixture@example.invalid",
              "commit",
              "--quiet",
              "-m",
              "synthetic checkpoint",
            ],
            gitOptions,
          );
          const head = await git("git", ["-C", repository, "rev-parse", "HEAD"], gitOptions);
          const mediaRoot = path.relative(
            process.env.OPENCLAW_STATE_DIR!,
            path.join(getMediaDir(), "inbound"),
          );
          if (mediaRoot.startsWith("..") || path.isAbsolute(mediaRoot)) {
            throw new Error("Synthetic media is outside its companion");
          }
          const mediaFiles = await fs.readdir(
            path.join(process.env.OPENCLAW_STATE_DIR!, mediaRoot),
          );
          process.send?.({
            id: request.id,
            ok: true,
            gitHead: head.stdout.trim(),
            media: { relativeRoot: mediaRoot, files: mediaFiles },
          });
        } else {
          await server.close();
          process.send?.({ id: request.id, ok: true });
          process.disconnect?.();
        }
      } catch (error) {
        // The parent retains only this owned child's bounded private stderr.
        console.error("[rolling-fixture] owned operation failed", error);
        process.send?.({ id: request.id, ok: false, errorCode: "FIXTURE_OPERATION_FAILED" });
      }
    });
  },
);
