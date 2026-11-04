import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS,
  readGitHubRepositoryPublicationMetadata,
} from "../gateway/github-repository-publication-snapshot.js";
import { prepareNodeWorkerPublicationIntegration } from "../gateway/worker-environments/node-worker-repository-preparation.js";
import { createNodeWorkspaceTransferService } from "../gateway/worker-environments/node-workspace-transfer-service.js";
import {
  startNodeWorkspaceTransferTestServer,
  transferOwner,
} from "../gateway/worker-environments/node-workspace-transfer.test-support.js";
import { NODE_WORKSPACE_EMPTY_MANIFEST_REF } from "../worker/node-workspace-transfer-protocol.js";
import { integrateNodeRepositoryPublication } from "./node-worker-publication-integration.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";

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

it.each([false, true])(
  "uses retained ancestry only when its tree matches the accepted checkpoint (mismatch: %s)",
  async (mismatch) => {
    const root = temporary.make("publication-history-");
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
    await fs.writeFile(path.join(workspace, "upstream.txt"), "old upstream\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "original source base");
    const baseCommit = git("rev-parse", "HEAD");
    await fs.writeFile(path.join(workspace, "upstream.txt"), "included upstream\n");
    git("commit", "--quiet", "-am", "newer source parent");
    const parent = git("rev-parse", "HEAD");
    await fs.writeFile(path.join(workspace, "fix.txt"), "saved repair\n");
    await fs.writeFile(path.join(workspace, "test.txt"), "saved regression\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "original two-file repair");
    const original = git("rev-parse", "HEAD");
    execFileSync(
      process.execPath,
      ["-e", REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS, workspace, baseCommit, inputRoot],
      { env },
    );
    const inputDigest =
      "sha256:" +
      createHash("sha256")
        .update(await fs.readFile(path.join(inputRoot, "snapshot.json")))
        .digest("hex");
    const gitPackPath = path.join(root, "history.pack");
    await fs.writeFile(
      gitPackPath,
      execFileSync("git", ["pack-objects", "--revs", "--stdout"], {
        cwd: workspace,
        env,
        input: `${original}\n^${baseCommit}\n`,
      }),
    );
    git("reset", "--hard", parent);
    await fs.writeFile(path.join(workspace, "upstream.txt"), "latest upstream\n");
    git("commit", "--quiet", "-am", "latest main");
    const mainCommit = git("rev-parse", "HEAD");
    git("reflog", "expire", "--expire=now", "--all");
    git("gc", "--prune=now");
    expect(spawnSync("git", ["cat-file", "-e", original], { cwd: workspace, env }).status).not.toBe(
      0,
    );
    await fs.writeFile(path.join(workspace, "fix.txt"), "later editing change\n");
    const index = await fs.readFile(path.join(workspace, ".git", "index"));
    vi.stubEnv("GIT_DIR", path.join(workspace, ".git"));
    vi.stubEnv("GIT_WORK_TREE", workspace);
    const input = {
      workspaceDir: workspace,
      inputRoot,
      inputDigest,
      outputRoot,
      sourceUrl: workspace,
      targetUrl: workspace,
      mainCommit,
      token: "synthetic-token",
    };
    // The normalized tree on the old base conflicts only because it lost the real parent.
    await expect(integrateNodeRepositoryPublication(input)).rejects.toThrow("merge conflicts");
    const service = createNodeWorkspaceTransferService({
      temporaryRoot: path.join(root, "transfers"),
      getOwner: () => transferOwner("session"),
    });
    await service.prepareRepository({
      environmentId: "environment",
      ownerEpoch: 1,
      sessionId: "session",
      baseCommit,
      baseManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
      isAuthorized: () => true,
    });
    const server = await startNodeWorkspaceTransferTestServer(service);
    onTestFinished(async () => {
      await service.closeAll();
      await server.close();
    });
    let dispatched = 0;
    const transfer = async (
      value: Parameters<typeof runNodeWorkerWorkspaceTransfer>[0]["transfer"],
    ) => {
      dispatched++;
      return {
        code: 0,
        termination: "exit" as const,
        killed: false,
        signal: null,
        stderr: "",
        workspaceDir: workspace,
        stdout: await runNodeWorkerWorkspaceTransfer({
          gatewayUrl: server.gatewayUrl,
          environmentId: "environment",
          workspaceDir: workspace,
          manifestHome: path.join(root, "home"),
          transfer: value,
        }),
      };
    };
    const request = {
      snapshotRoot: inputRoot,
      snapshotDigest: inputDigest,
      sourceUrl: workspace,
      targetUrl: workspace,
      mainCommit,
      token: "synthetic-token",
      assertCurrent: () => {},
      history: {
        gitPackPath,
        gitHistory: {
          baseCommit,
          headCommit: mismatch ? parent : original,
          descendsFromBase: true,
        },
      },
    };
    const owner = {
      environmentId: "environment",
      signal: new AbortController().signal,
      workspaceTransfer: service,
      transfer,
    };
    if (!mismatch) {
      await expect(
        prepareNodeWorkerPublicationIntegration(
          {
            ...owner,
            readCapabilities: async () => ({ publicationIntegration: 1 }),
          },
          request,
        ),
      ).rejects.toThrow("current runtime");
      expect(dispatched).toBe(0);
    }
    const integrated = prepareNodeWorkerPublicationIntegration(
      {
        ...owner,
        readCapabilities: async () => ({ publicationIntegration: 1, publicationGitHistory: true }),
      },
      request,
    );
    if (mismatch) {
      await expect(integrated).rejects.toThrow("merge conflicts");
    } else {
      const result = await integrated;
      try {
        expect(result.snapshot.entries.map((entry) => entry.path)).toEqual(["fix.txt", "test.txt"]);
        expect(result.snapshot.baseCommit).toBe(mainCommit);
        expect(
          await fs.readFile(
            path.join(result.snapshotRoot, "blobs", result.snapshot.entries[0]!.sha!),
            "utf8",
          ),
        ).toBe("saved repair\n");
      } finally {
        await result.release();
      }
    }
    expect(git("rev-parse", "HEAD")).toBe(mainCommit);
    expect(await fs.readFile(path.join(workspace, ".git", "index"))).toEqual(index);
    expect(await fs.readFile(path.join(workspace, "fix.txt"), "utf8")).toBe(
      "later editing change\n",
    );
  },
);
