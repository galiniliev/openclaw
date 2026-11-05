import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveGitHubPublicationFailure } from "../gateway/github-publication-failure.js";
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
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../infra/node-commands.js";
import * as logger from "../logger.js";
import * as command from "../process/exec.js";
import {
  NODE_WORKSPACE_EMPTY_MANIFEST_REF,
  NodeWorkerWorkspaceTransferError,
} from "../worker/node-workspace-transfer-protocol.js";
import { integrateNodeRepositoryPublication } from "./node-worker-publication-integration.js";
import { invokeNodeWorkerSupervisorCommand } from "./node-worker-supervisor-commands.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
it.each(["source-base", "target-main"] as const)(
  "preserves private %s fetch diagnosis without changing the public failure",
  async (role) => {
    const root = temporary.make("publication-fetch-diagnostic-");
    const inputRoot = path.join(root, "input");
    await fs.mkdir(inputRoot);
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull },
        encoding: "utf8",
      }).trim();
    git("init", "--quiet");
    const tree = git("mktree");
    const base = git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit-tree",
      tree,
    );
    git("update-ref", "refs/heads/main", base);
    const raw = JSON.stringify({
      version: 1,
      baseCommit: base,
      baseTree: tree,
      workspaceTree: tree,
      entries: [],
    });
    await fs.writeFile(path.join(inputRoot, "snapshot.json"), raw);
    const token =
      role === "source-base" ? "node-private-value+/%=9081726354" : `ghs_${"A".repeat(36)}`;
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    const secrets = [
      token,
      `x-access-token:${token}`,
      basic,
      `Basic ${basic}`,
      `Authorization: Basic ${basic}`,
    ].flatMap((value) => [
      value,
      encodeURIComponent(value),
      new URLSearchParams({ v: value }).toString().slice(2),
    ]);
    secrets.push(
      encodeURIComponent(`Authorization: Basic ${basic}`).replace(/%[\dA-F]{2}/gu, (escape) =>
        escape.toLowerCase(),
      ),
    );
    const mixedEscapes = [token, `Authorization: Basic ${basic}`].map((value) =>
      encodeURIComponent(value).replace(/%[\dA-F]{2}/gu, (escape, offset: number) =>
        offset % 2 === 0 ? escape.toLowerCase() : escape,
      ),
    );
    secrets.unshift(encodeURIComponent(basic).replace(/%3D$/u, "%3d"), ...mixedEscapes);
    const bearer = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const stderr = `fatal: harmless remote rejection ${secrets.join(" ")} ${root} ${encodeURIComponent(root)} https://url-user:url-pass@remote.invalid/repo?unusual=query-secret Authorization: Bearer ${bearer} ${"🌊".repeat(10_000)} fatal: harmless remote rejection`;
    const realRun = command.runCommandBuffered;
    let fetches = 0;
    const run = vi
      .spyOn(command, "runCommandBuffered")
      .mockImplementation(async (argv, options) => {
        if (
          argv[0] === "git" &&
          argv[1] === "fetch" &&
          ++fetches === (role === "source-base" ? 1 : 2)
        ) {
          return {
            code: 128,
            termination: "exit",
            signal: null,
            killed: false,
            stdout: Buffer.from("STDOUT_MUST_NOT_LEAK"),
            stderr: Buffer.from(stderr),
            error: new Error("RAW_ERROR_MUST_NOT_LEAK"),
          };
        }
        return realRun(argv, options);
      });
    onTestFinished(() => run.mockRestore());
    const error = await integrateNodeRepositoryPublication({
      workspaceDir: root,
      inputRoot,
      inputDigest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      outputRoot: path.join(root, "output"),
      sourceUrl: root,
      targetUrl: root,
      mainCommit: base,
      token,
    }).then(
      () => {
        throw new Error("Expected a fetch failure");
      },
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain(`fetch=${role}`);
    expect(message).toContain("fatal: harmless remote rejection");
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(16 * 1024);
    const warn = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const workspace = new NodeWorkerWorkspaceRuntime({ root: path.join(root, "runtime") });
    // The unchanged transfer wrapper carries the integration error into node serialization.
    const exec = vi
      .spyOn(workspace, "exec")
      .mockRejectedValue(
        new NodeWorkerWorkspaceTransferError(
          "workspace-transfer-failed: transfer did not complete",
          { cause: error, operation: "publication", stage: "replace" },
        ),
      );
    onTestFinished(() => exec.mockRestore());
    const result = await invokeNodeWorkerSupervisorCommand({
      command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
      paramsJSON: JSON.stringify({
        gatewayNamespace: "gateway",
        environmentId: "environment",
        sessionId: "session",
        generation: 1,
        argv: ["openclaw-internal-workspace-transfer"],
      }),
      workspace,
    });
    expect(result).toMatchObject({ ok: false, code: "WORKSPACE_TRANSFER_FAILED" });
    if (!result.handled || result.ok) {
      throw new Error("Expected the private node diagnostic");
    }
    expect(result.message).toContain(`fetch=${role}`);
    expect(result.message).toContain("fatal: harmless remote rejection");
    expect(result.message.length).toBeLessThanOrEqual(1_024);
    const diagnostics = [
      message,
      result.message,
      ...warn.mock.calls.flat().filter((value) => typeof value === "string"),
    ].join(" ");
    for (const secret of [
      ...secrets,
      root,
      encodeURIComponent(root),
      bearer,
      "url-user",
      "url-pass",
      "query-secret",
      "STDOUT_MUST_NOT_LEAK",
      "RAW_ERROR_MUST_NOT_LEAK",
    ]) {
      expect(diagnostics).not.toContain(secret);
    }
    expect(
      resolveGitHubPublicationFailure(new NodeWorkerWorkspaceTransferError(result.message)),
    ).toEqual({
      code: "unavailable",
      nextAction:
        "Publication integration fetch failed (exit; exit 128). Worker publication transfer failed. Restore worker and repository connectivity, then retry the same request.",
    });
  },
);
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
