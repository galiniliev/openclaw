import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS,
  readGitHubRepositoryPublicationMetadata,
} from "../gateway/github-repository-publication-snapshot.js";
import { integrateNodeRepositoryPublication } from "./node-worker-publication-integration.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
it.each([false, true])(
  "integrates latest main without changing editing state (conflict: %s)",
  async (conflict) => {
    const root = temporary.make("publication-integration-");
    const workspace = path.join(root, "workspace");
    const inputRoot = path.join(root, "input");
    const outputRoot = path.join(root, "output");
    await fs.mkdir(workspace);
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    };
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, env, encoding: "utf8" }).trim();
    git("init", "--quiet", "--initial-branch=main");
    await fs.writeFile(path.join(workspace, "fix.txt"), "base\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    await fs.writeFile(path.join(workspace, "fix.txt"), "saved repair\n");
    execFileSync(
      process.execPath,
      ["-e", REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS, workspace, base, inputRoot],
      { env },
    );
    const inputDigest =
      "sha256:" +
      createHash("sha256")
        .update(await fs.readFile(path.join(inputRoot, "snapshot.json")))
        .digest("hex");
    await fs.writeFile(
      path.join(workspace, "fix.txt"),
      conflict ? "upstream conflict\n" : "base\n",
    );
    await fs.writeFile(path.join(workspace, "main.txt"), "latest main\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "latest main");
    const mainCommit = git("rev-parse", "HEAD");
    await fs.writeFile(path.join(workspace, "fix.txt"), "concurrent later edit\n");
    const index = await fs.readFile(path.join(workspace, ".git", "index"));
    vi.stubEnv("GIT_DIR", path.join(workspace, ".git"));
    vi.stubEnv("GIT_WORK_TREE", workspace);
    const operation = integrateNodeRepositoryPublication({
      workspaceDir: workspace,
      inputRoot,
      inputDigest,
      outputRoot,
      sourceUrl: workspace,
      targetUrl: workspace,
      mainCommit,
      token: "synthetic-token",
    });
    if (conflict) {
      await expect(operation).rejects.toThrow("merge conflicts");
    } else {
      await operation;
      const raw = await fs.readFile(path.join(outputRoot, "snapshot.json"));
      const digest = "sha256:" + createHash("sha256").update(raw).digest("hex");
      const { snapshot } = await readGitHubRepositoryPublicationMetadata(outputRoot, digest);
      expect(snapshot.baseCommit).toBe(mainCommit);
      expect(snapshot.entries.map((entry) => entry.path)).toEqual(["fix.txt"]);
      expect(
        await fs.readFile(path.join(outputRoot, "blobs", snapshot.entries[0]!.sha!), "utf8"),
      ).toBe("saved repair\n");
    }
    expect(git("rev-parse", "HEAD")).toBe(mainCommit);
    expect(await fs.readFile(path.join(workspace, ".git", "index"))).toEqual(index);
    expect(await fs.readFile(path.join(workspace, "fix.txt"), "utf8")).toBe(
      "concurrent later edit\n",
    );
  },
);
