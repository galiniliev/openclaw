import { execFileSync } from "node:child_process";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createGitHubPublicationTree } from "./github-publication-tree-write.js";
import type { GitHubRepositoryPublicationSnapshot as Snapshot } from "./github-repository-publication-snapshot.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
type Entry = Snapshot["entries"][number];
const longDirectory = Array.from({ length: 8 }, () => "directory-" + "x".repeat(180)).join("/");

function fixture() {
  const root = temporary.make("publication-tree-write-");
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
        GIT_CONFIG_COUNT: "0",
      },
    }).trim();
  git(["init", "--bare", "--quiet", "--object-format=sha1"]);
  const empty = git(["mktree"], "");
  const sha = git(["hash-object", "-w", "--stdin"], "synthetic\n");
  const entry = (path: string, mode: Entry["mode"] = "100644"): Entry => ({ path, mode, sha });
  const apply = (base: string, entries: Entry[]) => {
    // GitHub refuses deletion of absent paths. Check the original request's base,
    // before applying its atomic file/directory replacement.
    const present = new Set(git(["ls-tree", "-r", "-z", "--name-only", base]).split("\0"));
    for (const removed of entries.filter((e) => e.sha === null)) {
      expect(present.has(removed.path)).toBe(true);
    }
    git(["read-tree", base]);
    git(
      ["update-index", "-z", "--index-info"],
      [...entries.filter((e) => e.sha === null), ...entries.filter((e) => e.sha !== null)]
        .map((e) => `${e.sha === null ? "0" : e.mode} ${e.sha ?? "0".repeat(40)}\t${e.path}\0`)
        .join(""),
    );
    return git(["write-tree"]);
  };
  const snapshot = (baseTree: string, entries: Entry[]): Snapshot => ({
    version: 1,
    baseCommit: "a".repeat(40),
    baseTree,
    entries,
    workspaceTree: apply(baseTree, entries),
  });
  const write = vi.fn(
    async (body: Parameters<Parameters<typeof createGitHubPublicationTree>[1]>[0]) => {
      const result = apply(body.base_tree, body.tree);
      expect(result).not.toBe(empty); // No empty intermediate root.
      return result;
    },
  );
  return { empty, entry, apply, snapshot, write };
}

it("keeps file/directory and symlink transitions atomic without grouping a- with a", async () => {
  const f = fixture();
  const base = f.apply(f.empty, [
    f.entry("a"),
    f.entry("directory/old"),
    f.entry("link", "120000"),
  ]);
  const value = f.snapshot(base, [
    { ...f.entry("a"), sha: null },
    ...Array.from({ length: 210 }, (_, i) => f.entry(`a-${i}/${longDirectory}/file`)),
    f.entry("a/child"),
    f.entry("directory", "120000"),
    { ...f.entry("directory/old"), sha: null },
    f.entry("link", "100755"),
  ]);
  await expect(createGitHubPublicationTree(value, f.write)).resolves.toBe(value.workspaceTree);
  expect(f.write.mock.calls.length).toBeGreaterThan(1);
  for (const [body] of f.write.mock.calls) {
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(256 * 1024);
    for (const pair of [
      ["a", "a/child"],
      ["directory", "directory/old"],
    ]) {
      const selected = body.tree
        .filter((entry) => pair.includes(entry.path))
        .map((entry) => entry.path);
      if (selected.length) {
        expect(selected).toEqual(pair);
      }
    }
  }
});

it("upserts before independent deletions so replacing a root never creates an empty intermediate tree", async () => {
  const f = fixture();
  const old = Array.from({ length: 210 }, (_, i) => f.entry(`${longDirectory}/${i}`));
  const base = f.apply(f.empty, old);
  const value = f.snapshot(base, [
    ...old.map(({ path, mode }) => ({ path, mode, sha: null })),
    f.entry("new"),
  ]);
  await expect(createGitHubPublicationTree(value, f.write)).resolves.toBe(value.workspaceTree);
  expect(f.write.mock.calls.length).toBeGreaterThan(1);
  expect(f.write.mock.calls[0]![0].tree[0]!.path).toBe("new");
});

it("preserves an oversized atomic replacement as one request and rejects a wrong final tree", async () => {
  const f = fixture();
  const base = f.apply(f.empty, [f.entry("a")]);
  const value = f.snapshot(base, [
    { ...f.entry("a"), sha: null },
    ...Array.from({ length: 210 }, (_, i) => f.entry(`a/${longDirectory}/${i}`)),
  ]);
  await expect(createGitHubPublicationTree(value, f.write)).resolves.toBe(value.workspaceTree);
  expect(f.write).toHaveBeenCalledOnce();
  expect(Buffer.byteLength(JSON.stringify(f.write.mock.calls[0]![0]))).toBeGreaterThan(256 * 1024);
  await expect(createGitHubPublicationTree(value, async () => base)).rejects.toThrow(
    "normalized tree changed",
  );
  f.write.mockClear();
  await expect(createGitHubPublicationTree(f.snapshot(base, []), f.write)).resolves.toBe(base);
  expect(f.write).not.toHaveBeenCalled();
});
