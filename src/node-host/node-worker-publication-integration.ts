import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import { readGitHubRepositoryPublicationMetadata } from "../gateway/github-repository-publication-snapshot.js";
import { appendGitConfig, gitMaintenanceEnvironment } from "../infra/git-maintenance-env.js";
import { runCommandBuffered } from "../process/exec.js";
import {
  NodeWorkerPublicationConflictError,
  NODE_WORKSPACE_EMPTY_MANIFEST_REF,
  NODE_WORKSPACE_EMPTY_MANIFEST,
} from "../worker/node-workspace-transfer-protocol.js";
import type { WorkspaceTransferOperation } from "./node-worker-transfer-client.js";

/** Integrate accepted bytes in private Git state; the editing checkout is only an object source. */
export async function integrateNodeRepositoryPublication(params: {
  workspaceDir: string;
  inputRoot: string;
  inputDigest: string;
  outputRoot: string;
  sourceUrl: string;
  targetUrl: string;
  mainCommit: string;
  token: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { snapshot } = await readGitHubRepositoryPublicationMetadata(
    params.inputRoot,
    params.inputDigest,
  );
  await withTempWorkspace(
    { rootDir: path.dirname(params.outputRoot), prefix: "openclaw-publication-merge-" },
    async ({ dir }) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/^(GIT_|GH_TOKEN$|GITHUB_TOKEN$)/iu.test(key)) {
          delete env[key];
        }
      }
      Object.assign(env, {
        HOME: dir,
        XDG_CONFIG_HOME: dir,
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_AUTHOR_NAME: "OpenClaw",
        GIT_AUTHOR_EMAIL: "publication@openclaw.invalid",
        GIT_COMMITTER_NAME: "OpenClaw",
        GIT_COMMITTER_EMAIL: "publication@openclaw.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        ...appendGitConfig(gitMaintenanceEnvironment(), [
          ["core.hooksPath", os.devNull],
          ["credential.helper", ""],
          ["http.followRedirects", "false"],
          ...[...new Set([params.sourceUrl, params.targetUrl])].map((url): [string, string] => [
            `http.${url}.extraheader`,
            `Authorization: Basic ${Buffer.from(`x-access-token:${params.token}`).toString("base64")}`,
          ]),
        ]),
      });
      const run = async (args: string[], input?: string | Buffer, cwd = dir) => {
        params.signal?.throwIfAborted();
        return await runCommandBuffered(["git", ...args], {
          cwd,
          baseEnv: env,
          input,
          signal: params.signal,
          timeoutMs: 120_000,
          maxOutputBytes: 64 * 1024 * 1024,
        });
      };
      const git = async (args: string[], input?: string | Buffer, cwd = dir) => {
        const result = await run(args, input, cwd);
        if (result.code !== 0 || result.error) {
          // Never propagate Git output: it can contain credentials or source contents.
          throw new Error(
            `Publication integration ${args[0]} failed (${result.termination}; exit ${result.code}).`,
          );
        }
        return result.stdout;
      };
      const text = async (args: string[], input?: string | Buffer) =>
        (await git(args, input)).toString("utf8").trim();
      await git(["init", "--bare", "--quiet", "--template=", "--object-format=sha1"]);
      const objects = (
        await git(
          ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
          undefined,
          params.workspaceDir,
        )
      )
        .toString("utf8")
        .trim();
      await fs.writeFile(path.join(dir, "objects", "info", "alternates"), `${objects}\n`);
      if ((await run(["cat-file", "-e", `${snapshot.baseCommit}^{commit}`])).code === 0) {
        await git(["update-ref", "refs/openclaw/input", snapshot.baseCommit]);
      }
      for (const [url, commit] of [
        [params.sourceUrl, snapshot.baseCommit],
        [params.targetUrl, params.mainCommit],
      ]) {
        await git([
          "fetch",
          "--no-tags",
          "--no-auto-maintenance",
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          "--",
          url!,
          commit!,
        ]);
      }
      if ((await text(["rev-parse", `${snapshot.baseCommit}^{tree}`])) !== snapshot.baseTree) {
        throw new Error("Publication integration source base changed.");
      }
      const remoteBlobs = new Set<string>();
      for (const commit of [
        snapshot.baseCommit,
        ...(params.sourceUrl === params.targetUrl ? [params.mainCommit] : []),
      ]) {
        const listing = await text([
          "ls-tree",
          "-r",
          "--format=%(objecttype) %(objectname)",
          commit,
        ]);
        for (const line of listing.split("\n")) {
          if (line.startsWith("blob ")) {
            remoteBlobs.add(line.slice(5));
          }
        }
      }
      for (const sha of new Set(
        snapshot.entries.flatMap((entry) =>
          entry.sha && entry.mode !== "160000" ? [entry.sha] : [],
        ),
      )) {
        const bytes = await fs.readFile(path.join(params.inputRoot, "blobs", sha));
        if ((await text(["hash-object", "-w", "--stdin"], bytes)) !== sha) {
          throw new Error("Publication integration input blob changed.");
        }
      }
      env.GIT_INDEX_FILE = path.join(dir, "publication-index");
      await git(["read-tree", snapshot.baseTree]);
      await git(
        ["update-index", "-z", "--index-info"],
        snapshot.entries
          .map(
            (entry) =>
              `${entry.sha === null ? "0" : entry.mode} ${entry.sha ?? "0".repeat(40)}\t${entry.path}\0`,
          )
          .join(""),
      );
      if ((await text(["write-tree"])) !== snapshot.workspaceTree) {
        throw new Error("Publication integration input tree changed.");
      }
      const accepted = await text(
        ["commit-tree", snapshot.workspaceTree, "-p", snapshot.baseCommit],
        "Accepted publication checkpoint\n",
      );
      const merge = await run(["merge-tree", "--write-tree", accepted, params.mainCommit]);
      if (merge.code === 1) {
        throw new NodeWorkerPublicationConflictError();
      }
      const mergedTree = merge.stdout.toString("utf8").trim();
      if (merge.code !== 0 || !/^[a-f0-9]{40}$/u.test(mergedTree)) {
        throw new Error("Publication integration could not produce a merged tree.");
      }
      const baseTree = await text(["rev-parse", `${params.mainCommit}^{tree}`]);
      const raw = await git([
        "diff-tree",
        "--no-commit-id",
        "--raw",
        "-r",
        "-z",
        "--no-renames",
        baseTree,
        mergedTree,
      ]);
      const fields = raw.toString("utf8").split("\0");
      if (!Buffer.from(raw.toString("utf8")).equals(raw)) {
        throw new Error("Publication integration paths must be UTF-8.");
      }
      const entries = [];
      await fs.mkdir(path.join(params.outputRoot, "blobs"), { recursive: true });
      for (let i = 0; i < fields.length - 1; i += 2) {
        const [, newMode, , sha] = fields[i]!.split(" ");
        const deleted = newMode === "000000";
        const entry = {
          path: fields[i + 1]!,
          mode: deleted ? fields[i]!.slice(1).split(" ")[0]! : newMode!,
          sha: deleted ? null : sha!,
        };
        entries.push(entry);
        if (entry.sha && entry.mode !== "160000") {
          await fs.writeFile(
            path.join(params.outputRoot, "blobs", entry.sha),
            await git(["cat-file", "blob", entry.sha]),
          );
        }
      }
      const candidates = new Set(
        [...snapshot.entries, ...entries].flatMap((entry) =>
          entry.sha && entry.mode !== "160000" ? [entry.sha] : [],
        ),
      );
      await fs.writeFile(
        path.join(params.outputRoot, "known-blobs.json"),
        JSON.stringify([...candidates].filter((sha) => remoteBlobs.has(sha))),
      );
      await fs.writeFile(
        path.join(params.outputRoot, "snapshot.json"),
        JSON.stringify({
          version: 1,
          baseCommit: params.mainCommit,
          baseTree,
          workspaceTree: mergedTree,
          entries,
        }),
      );
    },
  );
}

export async function integrateNodePublicationTransfer(
  params: WorkspaceTransferOperation<"publication">,
  transfer: {
    download: (input: WorkspaceTransferOperation<"download">) => Promise<string>;
    upload: (input: WorkspaceTransferOperation<"upload">) => Promise<string>;
  },
): Promise<string> {
  return await withTempWorkspace(
    {
      rootDir: path.join(params.manifestHome, ".openclaw-worker", "publication"),
      prefix: "integration-",
    },
    async ({ dir }) => {
      const inputRoot = path.join(dir, "input");
      const outputRoot = path.join(dir, "output");
      await transfer.download({
        ...params,
        workspaceDir: inputRoot,
        prepared: undefined,
        hashMemo: undefined,
        request: { ...params.request, token: params.transfer.inputToken },
        transfer: {
          direction: "download",
          token: params.transfer.inputToken,
          manifestRef: params.transfer.inputManifestRef,
        },
      });
      await integrateNodeRepositoryPublication({
        workspaceDir: params.workspaceDir,
        inputRoot,
        outputRoot,
        inputDigest: params.transfer.inputDigest,
        mainCommit: params.transfer.mainCommit,
        sourceUrl: params.transfer.sourceUrl,
        targetUrl: params.transfer.targetUrl,
        token: params.transfer.gitToken,
        signal: params.signal,
      });
      const manifests = path.join(params.manifestHome, ".openclaw-worker", "manifests");
      await fs.mkdir(manifests, { recursive: true });
      await fs.writeFile(
        path.join(manifests, `${NODE_WORKSPACE_EMPTY_MANIFEST_REF.slice("sha256:".length)}.json`),
        NODE_WORKSPACE_EMPTY_MANIFEST,
      );
      return await transfer.upload({
        ...params,
        workspaceDir: outputRoot,
        prepared: undefined,
        hashMemo: undefined,
        transfer: {
          direction: "upload",
          token: params.transfer.token,
          baseManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
          referenceManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
        },
      });
    },
  );
}
