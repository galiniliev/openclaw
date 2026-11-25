// Install transport fixtures before importing the publication owners.
// oxfmt-ignore
import { commandResult, githubPublicationTestMocks, installGitHubPublicationTestHarness } from "./github-publication.test-support.js";
import { expect, it, vi } from "vitest";
import { readGitHubRepositoryPublicationMetadata } from "./github-repository-publication-snapshot.js";
import { createRepositoryPublicationFixture } from "./github-repository-publication.test-support.js";

const checkpoint = vi.hoisted(() => vi.fn());
// mock-isolation: Synthetic accepted checkpoints; real coordinator, Git objects and API transport owner.
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryPublicationCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));
const mocks = githubPublicationTestMocks();
installGitHubPublicationTestHarness();

it("reuses known main tree metadata for source and integration without changing their history", async () => {
  const f = await createRepositoryPublicationFixture(checkpoint);
  const changes = Object.fromEntries(
    Array.from({ length: 210 }, (_, i) => [`upstream/${i}.txt`, "shared upstream\n"]),
  );
  const accepted = await f.capture("private change\n", "known-main", changes);
  const mainOnly = f.git(["hash-object", "-w", "--stdin"], "new upstream file\n");
  f.git(["read-tree", accepted.workspaceTree]);
  f.git(["update-index", "--index-info"], `0 ${"0".repeat(40)}\tcounter.txt\n`);
  f.git(["update-index", "--add", "--cacheinfo", `100644,${mainOnly},main-only.txt`]);
  const mainTree = f.git(["write-tree"]);
  f.runtime.baseHeadTree = mainTree;
  f.runtime.baseHead = f.git(["commit-tree", mainTree, "-p", f.baseCommit], "upstream\n");
  f.git(["read-tree", accepted.workspaceTree]);
  f.git(["update-index", "--add", "--cacheinfo", `100644,${mainOnly},main-only.txt`]);
  const integratedTree = f.git(["write-tree"]);
  mocks.prepareRepositoryIntegration.mockImplementation(async (_identity, input) => {
    const { snapshot } = await readGitHubRepositoryPublicationMetadata(
      input.snapshotRoot,
      input.snapshotDigest,
    );
    return {
      snapshot: {
        ...snapshot,
        baseCommit: input.targetCommit,
        baseTree: mainTree,
        workspaceTree: integratedTree,
      },
      snapshotRoot: input.snapshotRoot,
      release: async () => {},
    };
  });
  const route = mocks.runCommand.getMockImplementation()!;
  const bodies: Array<{
    base_tree: string;
    tree: Array<{ path: string; mode: string; sha: string | null }>;
  }> = [];
  let recursiveReads = 0;
  mocks.runCommand.mockImplementation(async (args: string[], options) => {
    if (args.some((arg) => arg.endsWith("?recursive=1"))) {
      recursiveReads++;
    }
    if (args.some((arg) => arg.endsWith("/git/trees"))) {
      bodies.push(JSON.parse(String(options.input)));
    }
    return route(args, options);
  });
  expect(await f.publish("known-main")).toMatchObject({ status: "published" });
  expect(recursiveReads).toBe(2); // Existing pinned-base and main-tree blob lookups only.
  expect(bodies).toHaveLength(2);
  expect(bodies[0]!.base_tree).toBe(mainTree);
  expect(bodies[0]!.tree).toEqual([
    { path: "counter.txt", mode: "100644", type: "blob", sha: accepted.sha },
    { path: "main-only.txt", mode: "100644", type: "blob", sha: null },
  ]);
  expect(bodies[1]!.tree).toEqual([
    { path: "counter.txt", mode: "100644", type: "blob", sha: accepted.sha },
  ]);
  const sourceCommit = f.git(["rev-parse", `${f.runtime.head}^1`]);
  expect(f.git(["rev-parse", `${sourceCommit}^{tree}`])).toBe(accepted.workspaceTree);
  expect(f.git(["rev-parse", `${sourceCommit}^`])).toBe(f.baseCommit);
  expect(f.git(["rev-parse", `${f.runtime.head}^{tree}`])).toBe(integratedTree);
  expect(f.git(["rev-parse", `${f.runtime.head}^2`])).toBe(f.runtime.baseHead);
  expect(f.runtime.effects).toEqual(["push", "pull_request"]);
});

it.each([false, true])(
  "publishes a large accepted tree through bounded requests (later failure: %s)",
  async (failLater) => {
    const f = await createRepositoryPublicationFixture(checkpoint);
    const directory = Array.from({ length: 8 }, () => "directory-" + "x".repeat(180)).join("/");
    const accepted = await f.capture(
      "accepted\n",
      "large-tree",
      Object.fromEntries(
        Array.from({ length: 210 }, (_, i) => [`${directory}/${i}.txt`, "shared\n"]),
      ),
    );
    const route = mocks.runCommand.getMockImplementation()!;
    const bodies: string[] = [];
    let completedTrees = 0;
    let commitCalls = 0;
    mocks.runCommand.mockImplementation(async (args: string[], options) => {
      if (args.some((arg) => arg.endsWith("/git/commits"))) {
        commitCalls++;
      }
      if (args.some((arg) => arg.endsWith("/git/trees"))) {
        const body = String(options.input);
        bodies.push(body);
        // A synthetic provider body ceiling reproduces the observed shape failure;
        // it does not assert a documented GitHub API limit.
        if (Buffer.byteLength(body) > 256 * 1024 || (failLater && completedTrees === 1)) {
          return {
            ...commandResult("", 1),
            termination: "exit",
            stderr: Buffer.from("gh: failure (HTTP 502)"),
          };
        }
        completedTrees++;
      }
      return route(args, options);
    });
    const result = await f.publish("large-tree");
    if (failLater) {
      expect(result).toMatchObject({ status: "failed", code: "unavailable" });
      expect(completedTrees).toBe(1);
      expect(bodies).toHaveLength(3); // First batch succeeds; second has its one existing 502 retry.
      expect(bodies[1]).toBe(bodies[2]);
      expect(commitCalls).toBe(0);
      expect(f.runtime.effects).toEqual([]);
      expect(f.runtime.head).toBeNull();
    } else {
      expect(result).toMatchObject({ status: "published" });
      expect(completedTrees).toBeGreaterThan(1);
      expect(bodies.every((body) => Buffer.byteLength(body) <= 256 * 1024)).toBe(true);
      expect(f.git(["rev-parse", `${f.runtime.head}^{tree}`])).toBe(accepted.workspaceTree);
      expect(f.runtime.effects).toEqual(["push", "pull_request"]);
    }
  },
);
