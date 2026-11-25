import { GitHubPublicationWorkspaceChangedError } from "./github-publication-failure.js";
import type { GitHubRepositoryPublicationSnapshot } from "./github-repository-publication-snapshot.js";

type Entry = GitHubRepositoryPublicationSnapshot["entries"][number] & { type: "blob" | "commit" };
type TreeInput = { base_tree: string; tree: Entry[] };
export type GitHubPublicationTreePlan = Pick<
  GitHubRepositoryPublicationSnapshot,
  "baseTree" | "entries"
>;
export type GitHubPublicationTreeWriteProgress = {
  batch: number;
  batchCount: number;
  entryCount: number;
  bodyBytes: number;
};
// A request-shape target, not a GitHub limit or a reason to reject accepted work.
const TREE_REQUEST_TARGET_BYTES = 256 * 1024;

export function gitHubPublicationTreeBody(plan: GitHubPublicationTreePlan): TreeInput {
  return {
    base_tree: plan.baseTree,
    tree: plan.entries.map((entry) => ({
      ...entry,
      type: entry.mode === "160000" ? "commit" : "blob",
    })),
  };
}

/** Intermediate trees are immutable objects; only the exact final tree may be committed. */
export async function createGitHubPublicationTree(
  snapshot: GitHubRepositoryPublicationSnapshot,
  write: (input: TreeInput) => Promise<string>,
  options: {
    plan?: GitHubPublicationTreePlan;
    onProgress?: (progress: GitHubPublicationTreeWriteProgress) => void;
  } = {},
) {
  const plan = options.plan ?? snapshot;
  const input = gitHubPublicationTreeBody(plan);
  const paths = new Set(input.tree.map((entry) => entry.path));
  const groups = new Map<string, Entry[]>();
  for (const entry of input.tree) {
    let root = entry.path;
    // Keep file/directory replacements atomic, even with intervening names such as a-.
    for (let slash = root.indexOf("/"); slash !== -1; slash = entry.path.indexOf("/", slash + 1)) {
      const ancestor = entry.path.slice(0, slash);
      if (paths.has(ancestor)) {
        root = ancestor;
        break;
      }
    }
    let group = groups.get(root);
    if (!group) {
      groups.set(root, (group = []));
    }
    group.push(entry);
  }
  const upserts: Entry[][] = [];
  const deletions: Entry[][] = [];
  for (const group of groups.values()) {
    (group.some((entry) => entry.sha !== null) ? upserts : deletions).push(group);
  }
  // Independent upserts first avoid an empty intermediate root during replacement.
  const batches: Entry[][] = [];
  let batch: Entry[] = [];
  const overhead = Buffer.byteLength(JSON.stringify({ base_tree: plan.baseTree, tree: [] }));
  let bytes = overhead;
  for (const group of [...upserts, ...deletions]) {
    const sizes = group.map((entry) => Buffer.byteLength(JSON.stringify(entry)));
    const addition = sizes.reduce((sum, size) => sum + size + 1, 0) - (batch.length ? 0 : 1);
    if (batch.length && bytes + addition > TREE_REQUEST_TARGET_BYTES) {
      batches.push(batch);
      batch = [];
      bytes = overhead;
    }
    // An oversized related group retains its original single-request semantics.
    for (const [index, entry] of group.entries()) {
      bytes += sizes[index]! + (batch.length ? 1 : 0);
      batch.push(entry);
    }
  }
  if (batch.length) {
    batches.push(batch);
  }
  let tree = plan.baseTree;
  for (const [index, entries] of batches.entries()) {
    const body = { base_tree: tree, tree: entries };
    options.onProgress?.({
      batch: index + 1,
      batchCount: batches.length,
      entryCount: entries.length,
      bodyBytes: Buffer.byteLength(JSON.stringify(body)),
    });
    tree = await write(body);
  }
  if (tree !== snapshot.workspaceTree) {
    throw new GitHubPublicationWorkspaceChangedError("GitHub publication normalized tree changed.");
  }
  return tree;
}
