import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getOrCreatePromise } from "../shared/lazy-promise.js";

type TreeEntry = { path: string; mode: string; sha: string };
type Tree = { complete: boolean; entries: TreeEntry[] };

/** One execution owns its immutable tree metadata; repository and request shape stay distinct. */
export function createGitHubPublicationTreeMetadata(params: {
  host: () => string;
  readTree: (repository: string, sha: string, recursive: boolean) => Promise<unknown>;
  readCommit: (repository: string, sha: string) => Promise<unknown>;
}) {
  const trees = new Map<string, Promise<Tree | undefined>>();
  const knownBlobs = new Map<string, Set<string>>();
  const scope = (repository: string) => params.host() + "\0" + repository;
  const readTree = (repository: string, sha: string, recursive = false) => {
    const repositoryScope = scope(repository);
    const key = JSON.stringify([repositoryScope, sha, recursive]);
    return getOrCreatePromise(trees, key, async (): Promise<Tree | undefined> => {
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
            (["100644", "100755", "120000"].includes(entry.mode) && entry.type === "blob")
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
      return { complete: !value.truncated, entries };
    });
  };
  return {
    readTree,
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
