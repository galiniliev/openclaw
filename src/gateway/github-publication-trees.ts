import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import {
  gitHubPublicationTreeBody,
  type GitHubPublicationTreePlan,
} from "./github-publication-tree-write.js";
import type { GitHubRepositoryPublicationSnapshot } from "./github-repository-publication-snapshot.js";

type TreeEntry = {
  path: string;
  mode: "040000" | GitHubRepositoryPublicationSnapshot["entries"][number]["mode"];
  sha: string;
};
type Tree = { sha: string; recursive: boolean; complete: boolean; entries: TreeEntry[] };

/** One execution owns its immutable tree metadata; repository and request shape stay distinct. */
export function createGitHubPublicationTreeMetadata(params: {
  host: () => string;
  readTree: (repository: string, sha: string, recursive: boolean) => Promise<unknown>;
  readCommit: (repository: string, sha: string) => Promise<unknown>;
}) {
  const trees = new Map<string, Map<string, Promise<Tree | undefined>>>();
  const knownBlobs = new Map<string, Set<string>>();
  const scope = (repository: string) => params.host() + "\0" + repository;
  const readTree = (repository: string, sha: string, recursive = false) => {
    const repositoryScope = scope(repository);
    let repositoryTrees = trees.get(repositoryScope);
    if (!repositoryTrees) {
      trees.set(repositoryScope, (repositoryTrees = new Map()));
    }
    const key = JSON.stringify([sha, recursive]);
    return getOrCreatePromise(repositoryTrees, key, async (): Promise<Tree | undefined> => {
      const value = await params.readTree(repository, sha, recursive);
      if (
        !isRecord(value) ||
        value.sha !== sha ||
        typeof value.truncated !== "boolean" ||
        !Array.isArray(value.tree)
      ) {
        return undefined;
      }
      const names = new Set<string>();
      const entries: TreeEntry[] = [];
      for (const entry of value.tree) {
        if (
          !isRecord(entry) ||
          typeof entry.path !== "string" ||
          !entry.path ||
          entry.path.includes("\\") ||
          entry.path.includes("\0") ||
          path.posix.isAbsolute(entry.path) ||
          path.posix.normalize(entry.path) !== entry.path ||
          entry.path === "." ||
          entry.path === ".." ||
          entry.path.startsWith("../") ||
          (!recursive && entry.path.includes("/")) ||
          names.has(entry.path) ||
          typeof entry.sha !== "string" ||
          !/^[a-f0-9]{40}$/u.test(entry.sha) ||
          typeof entry.mode !== "string" ||
          !(
            (entry.mode === "040000" && entry.type === "tree") ||
            (entry.mode === "160000" && entry.type === "commit") ||
            ((entry.mode === "100644" || entry.mode === "100755" || entry.mode === "120000") &&
              entry.type === "blob")
          )
        ) {
          return undefined;
        }
        names.add(entry.path);
        entries.push({ path: entry.path, mode: entry.mode, sha: entry.sha });
      }
      if (!value.truncated) {
        let known = knownBlobs.get(repositoryScope);
        if (!known) {
          knownBlobs.set(repositoryScope, (known = new Set()));
        }
        for (const entry of entries) {
          if (entry.mode !== "040000" && entry.mode !== "160000") {
            known.add(entry.sha);
          }
        }
      }
      return { sha, recursive, complete: !value.truncated, entries };
    });
  };
  return {
    readTree,
    async planTree(repository: string, snapshot: GitHubRepositoryPublicationSnapshot) {
      let plan: GitHubPublicationTreePlan = snapshot;
      const cached = trees.get(scope(repository));
      if (!cached) {
        return plan;
      }
      const base = await cached
        .get(JSON.stringify([snapshot.baseTree, true]))
        ?.catch(() => undefined);
      // Reuse only complete observations already acquired by this execution. Explicit empty
      // trees cannot be expressed by the normalized leaf delta and keep the original plan.
      const usable = (tree: Tree | undefined): tree is Tree =>
        Boolean(
          tree?.complete &&
          tree.recursive &&
          !tree.entries.some(
            (entry) =>
              entry.mode === "040000" && entry.sha === "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
          ),
        );
      if (!usable(base)) {
        return plan;
      }
      const desired = new Map(
        base.entries.filter((entry) => entry.mode !== "040000").map((entry) => [entry.path, entry]),
      );
      for (const entry of snapshot.entries) {
        if (entry.sha === null) {
          desired.delete(entry.path);
        } else {
          desired.set(entry.path, { path: entry.path, mode: entry.mode, sha: entry.sha });
        }
      }
      let bytes = Buffer.byteLength(JSON.stringify(gitHubPublicationTreeBody(plan)));
      for (const pending of cached.values()) {
        const candidate = await pending.catch(() => undefined);
        if (!usable(candidate)) {
          continue;
        }
        const prior = new Map(candidate.entries.map((entry) => [entry.path, entry]));
        const entries: GitHubPublicationTreePlan["entries"] = [];
        for (const entry of desired.values()) {
          const previous = prior.get(entry.path);
          if (
            entry.mode !== "040000" &&
            (previous?.sha !== entry.sha || previous.mode !== entry.mode)
          ) {
            entries.push({ path: entry.path, mode: entry.mode, sha: entry.sha });
          }
        }
        for (const entry of candidate.entries) {
          if (entry.mode !== "040000" && !desired.has(entry.path)) {
            entries.push({ path: entry.path, mode: entry.mode, sha: null });
          }
        }
        const alternative = { baseTree: candidate.sha, entries };
        const size = Buffer.byteLength(JSON.stringify(gitHubPublicationTreeBody(alternative)));
        if (size < bytes) {
          plan = alternative;
          bytes = size;
        }
      }
      return plan;
    },
    async readKnownBlobs(
      repository: string,
      roots: readonly string[],
      assertCurrent: () => void,
      targetCommit?: string,
    ) {
      const selectedRoots = [...roots];
      if (targetCommit) {
        assertCurrent();
        try {
          const value = await params.readCommit(repository, targetCommit);
          if (
            isRecord(value) &&
            value.sha === targetCommit &&
            isRecord(value.tree) &&
            typeof value.tree.sha === "string" &&
            /^[a-f0-9]{40}$/u.test(value.tree.sha)
          ) {
            selectedRoots.push(value.tree.sha);
          }
        } catch {
          assertCurrent();
        }
      }
      // Positive evidence is optional. Unknown objects keep the ordinary upload path.
      for (const sha of [...new Set(selectedRoots)].slice(0, 3)) {
        assertCurrent();
        try {
          await readTree(repository, sha, true);
        } catch {
          assertCurrent();
        }
      }
      assertCurrent();
      return knownBlobs.get(scope(repository)) ?? new Set<string>();
    },
  };
}

export type GitHubPublicationTreeMetadata = ReturnType<typeof createGitHubPublicationTreeMetadata>;
