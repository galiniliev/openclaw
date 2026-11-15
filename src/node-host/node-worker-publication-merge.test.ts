import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS } from "../gateway/github-repository-publication-snapshot.js";
import { prepareNodeWorkerPublicationIntegration } from "../gateway/worker-environments/node-worker-publication-transfer.js";
import { createNodeWorkspaceTransferCommand } from "../gateway/worker-environments/node-workspace-transfer-command.js";
import { createNodeWorkspaceTransferService } from "../gateway/worker-environments/node-workspace-transfer-service.js";
import {
  startNodeWorkspaceTransferTestServer,
  transferOwner,
} from "../gateway/worker-environments/node-workspace-transfer.test-support.js";
import { captureWorkspaceSnapshot } from "../gateway/worker-environments/workspace-manifest-worker.js";
import {
  NODE_WORKSPACE_EMPTY_MANIFEST_REF,
  NodeWorkerPublicationConflictError,
} from "../worker/node-workspace-transfer-protocol.js";
import { transferNodeRepositoryPublication } from "./node-worker-publication-merge.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it("restores exact retained ancestry through transfer without changing later editing state", async () => {
  const root = temporary.make("publication-merge-");
  const workspace = path.join(root, "workspace");
  const inputRoot = path.join(root, "input");
  await fs.mkdir(workspace);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workspace, env, encoding: "utf8" }).trim();
  const write = (name: string, content: string) =>
    fs.writeFile(path.join(workspace, name), content);
  git("init", "--quiet", "--initial-branch=main");
  await write("upstream.txt", "old upstream\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const baseCommit = git("rev-parse", "HEAD");
  await write("upstream.txt", "included upstream\n");
  git("commit", "--quiet", "-am", "intermediate main");
  const parent = git("rev-parse", "HEAD");
  await write("fix.txt", "saved repair\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "accepted repair");
  const headCommit = git("rev-parse", "HEAD");
  execFileSync(
    process.execPath,
    ["-e", REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS, workspace, baseCommit, inputRoot],
    { env },
  );
  const snapshotDigest = `sha256:${createHash("sha256")
    .update(await fs.readFile(path.join(inputRoot, "snapshot.json")))
    .digest("hex")}`;
  const gitPackPath = path.join(root, "history.pack");
  await fs.writeFile(
    gitPackPath,
    execFileSync("git", ["pack-objects", "--revs", "--stdout"], {
      cwd: workspace,
      env,
      input: `${headCommit}\n^${baseCommit}\n`,
    }),
  );
  git("reset", "--hard", parent);
  await write("upstream.txt", "latest upstream\n");
  git("commit", "--quiet", "-am", "latest main");
  const targetCommit = git("rev-parse", "HEAD");
  git("reflog", "expire", "--expire=now", "--all");
  git("gc", "--prune=now");
  expect(spawnSync("git", ["cat-file", "-e", headCommit], { cwd: workspace, env }).status).not.toBe(
    0,
  );
  await write("fix.txt", "later editing work\n");
  git("add", "fix.txt");
  await write("fix.txt", "later unstaged work\n");
  const index = await fs.readFile(path.join(workspace, ".git", "index"));
  const input = {
    snapshotRoot: inputRoot,
    snapshotDigest,
    sourceUrl: pathToFileURL(workspace).href,
    targetUrl: pathToFileURL(workspace).href,
    targetCommit,
    token: "synthetic-token",
    assertCurrent: () => {},
  };
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
  const editingSnapshot = {
    ...(await captureWorkspaceSnapshot({ root: inputRoot, baseCommit: null })),
    root: inputRoot,
  };
  const editingToken = service.publishSnapshot("environment", editingSnapshot);
  await service.revoke("environment", editingToken);
  const server = await startNodeWorkspaceTransferTestServer(service);
  onTestFinished(async () => {
    await service.closeAll();
    await server.close();
  });
  const signal = new AbortController().signal;
  const createTransfer = (workspaceDir: string) =>
    createNodeWorkspaceTransferCommand(async (command) => {
      if (!command.transfer) {
        throw new Error("Expected a publication transfer");
      }
      const stdout = await runNodeWorkerWorkspaceTransfer({
        gatewayUrl: server.gatewayUrl,
        environmentId: "environment",
        workspaceDir,
        manifestHome: root,
        transfer: command.transfer,
        signal,
      });
      return {
        code: 0,
        termination: "exit",
        signal: null,
        killed: false,
        stdout,
        stderr: "",
        workspaceDir,
      };
    });
  const context = {
    environmentId: "environment",
    signal,
    workspaceTransfer: service,
    supportsIntegration: async () => true,
    transfer: createTransfer(workspace),
  };
  // Without its real parent, the normalized checkpoint falsely conflicts with later upstream edits.
  await expect(prepareNodeWorkerPublicationIntegration(context, input)).rejects.toBeInstanceOf(
    NodeWorkerPublicationConflictError,
  );
  await expect(
    prepareNodeWorkerPublicationIntegration(context, {
      ...input,
      history: {
        gitPackPath,
        gitHistory: { baseCommit, headCommit: parent, descendsFromBase: true },
      },
    }),
  ).rejects.toBeInstanceOf(NodeWorkerPublicationConflictError);
  const integrated = await prepareNodeWorkerPublicationIntegration(context, {
    ...input,
    history: { gitPackPath, gitHistory: { baseCommit, headCommit, descendsFromBase: true } },
  });
  try {
    expect(integrated.snapshot.baseCommit).toBe(targetCommit);
    expect(integrated.snapshot.entries.map((entry) => entry.path)).toEqual(["fix.txt"]);
    expect(
      await fs.readFile(
        path.join(integrated.snapshotRoot, "blobs", integrated.snapshot.entries[0]!.sha!),
        "utf8",
      ),
    ).toBe("saved repair\n");
  } finally {
    await integrated.release();
  }
  const emptyWorkspace = path.join(root, "empty-objects");
  await fs.mkdir(emptyWorkspace);
  execFileSync("git", ["init", "--bare", "--quiet"], { cwd: emptyWorkspace, env });
  await expect(
    prepareNodeWorkerPublicationIntegration(
      { ...context, transfer: createTransfer(emptyWorkspace) },
      {
        ...input,
        sourceUrl: pathToFileURL(path.join(root, "missing-source")).href,
      },
    ),
  ).rejects.toMatchObject({
    name: "NodeWorkerWorkspaceTransferError",
    operation: "publication",
    cause: expect.objectContaining({ message: expect.stringContaining("fetch=source-base") }),
  });
  expect(service.getSnapshot("environment", editingSnapshot.manifestRef)).toBeDefined();
  expect(git("rev-parse", "HEAD")).toBe(targetCommit);
  expect(git("symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(await fs.readFile(path.join(workspace, ".git", "index"))).toEqual(index);
  expect(await fs.readFile(path.join(workspace, "fix.txt"), "utf8")).toBe("later unstaged work\n");
});

it("merges a shallow editing checkout without borrowing its incomplete ancestry", async () => {
  const root = temporary.make("publication-shallow-");
  const remote = path.join(root, "remote");
  const workspace = path.join(root, "workspace");
  const inputRoot = path.join(root, "input");
  await fs.mkdir(remote);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  git(remote, "init", "--quiet", "--initial-branch=main");
  const historical = Array.from({ length: 2_000 }, (_, i) =>
    createHash("sha256").update(String(i)).digest("hex"),
  ).join("\n");
  await fs.writeFile(path.join(remote, "history.txt"), historical);
  git(remote, "add", ".");
  git(remote, "commit", "--quiet", "-m", "ancestor");
  const ancestor = git(remote, "rev-parse", "HEAD");
  await fs.writeFile(path.join(remote, "history.txt"), "shallow tip\n");
  await fs.writeFile(path.join(remote, "fix.txt"), "base\n");
  git(remote, "add", ".");
  git(remote, "commit", "--quiet", "-m", "base");
  const baseCommit = git(remote, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", "--depth=1", pathToFileURL(remote).href, workspace);
  expect(git(workspace, "rev-parse", "--is-shallow-repository")).toBe("true");
  expect(spawnSync("git", ["cat-file", "-e", ancestor], { cwd: workspace, env }).status).not.toBe(
    0,
  );
  await fs.writeFile(path.join(workspace, "fix.txt"), "saved repair\n");
  execFileSync(
    process.execPath,
    ["-e", REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS, workspace, baseCommit, inputRoot],
    { env },
  );
  const rawInput = await fs.readFile(path.join(inputRoot, "snapshot.json"));
  const inputDigest = `sha256:${createHash("sha256").update(rawInput).digest("hex")}`;
  await fs.writeFile(path.join(remote, "history.txt"), historical + "\nnew upstream line\n");
  git(remote, "commit", "--quiet", "-am", "latest main");
  const targetCommit = git(remote, "rev-parse", "HEAD");
  const index = await fs.readFile(path.join(workspace, ".git", "index"));
  const shallow = await fs.readFile(path.join(workspace, ".git", "shallow"));
  await transferNodeRepositoryPublication(
    {
      gatewayUrl: "https://gateway.example.test",
      environmentId: "environment",
      workspaceDir: workspace,
      manifestHome: root,
      request: { gatewayUrl: "https://gateway.example.test", token: "synthetic-token" },
      setStage() {},
      transfer: {
        direction: "publication",
        token: "synthetic-token",
        inputToken: "synthetic-input",
        inputManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
        inputDigest,
        sourceUrl: pathToFileURL(remote).href,
        targetUrl: pathToFileURL(remote).href,
        targetCommit,
        gitToken: "synthetic-token",
      },
    },
    {
      download: async (params) => {
        await fs.cp(inputRoot, params.workspaceDir, { recursive: true });
        return "";
      },
      upload: async (params) => {
        const snapshot = JSON.parse(
          await fs.readFile(path.join(params.workspaceDir, "snapshot.json"), "utf8"),
        );
        expect(snapshot.baseCommit).toBe(targetCommit);
        expect(snapshot.entries).toEqual([
          { path: "fix.txt", mode: "100644", sha: expect.any(String) },
        ]);
        expect(
          await fs.readFile(
            path.join(params.workspaceDir, "blobs", snapshot.entries[0].sha),
            "utf8",
          ),
        ).toBe("saved repair\n");
        return "";
      },
    },
  );
  expect(git(workspace, "rev-parse", "HEAD")).toBe(baseCommit);
  expect(await fs.readFile(path.join(workspace, ".git", "index"))).toEqual(index);
  expect(await fs.readFile(path.join(workspace, ".git", "shallow"))).toEqual(shallow);
  expect(await fs.readFile(path.join(workspace, "fix.txt"), "utf8")).toBe("saved repair\n");
  expect(await fs.readFile(path.join(inputRoot, "snapshot.json"))).toEqual(rawInput);
});
