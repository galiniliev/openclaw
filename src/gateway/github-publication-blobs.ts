import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { gitHubPublicationObjectSha } from "./github-publication-git-transport.js";
import { requestGitHubPublicationJson } from "./github-publication-json-read.js";
import type { GitHubPublicationTreeMetadata } from "./github-publication-trees.js";
import {
  readGitHubRepositoryPublicationBlob,
  type GitHubRepositoryPublicationSnapshot,
} from "./github-repository-publication-snapshot.js";

/** Both accepted and integrated trees need their objects, even when they share content. */
export async function uploadGitHubPublicationBlobs(params: {
  snapshots: readonly { snapshot: GitHubRepositoryPublicationSnapshot; root: string }[];
  metadata: GitHubPublicationTreeMetadata;
  repository: string;
  roots: readonly string[];
  targetCommit?: string;
  identity: PreparedGitHubPublicationIdentity;
  endpoint: string;
  assertCurrent: () => void;
  assertAction: () => void;
  progress: { total: number; reused: number; completed: number };
  onProgress: () => void;
}): Promise<void> {
  const roots = new Map<string, string>();
  for (const { snapshot, root } of params.snapshots) {
    for (const entry of snapshot.entries) {
      if (entry.sha !== null && entry.mode !== "160000") {
        roots.set(entry.sha, root);
      }
    }
  }
  const known = await params.metadata.readKnownBlobs(
    params.repository,
    params.roots,
    params.assertAction,
    params.targetCommit,
  );
  const missing = [...roots.keys()].filter((sha) => !known.has(sha));
  params.progress.total = roots.size;
  params.progress.reused = roots.size - missing.length;
  params.onProgress();
  const progressInterval = Math.max(1, Math.ceil(missing.length / 10));
  const uploaded = await runTasksWithConcurrency({
    limit: 4,
    errorMode: "stop",
    tasks: missing.map((sha) => async () => {
      params.assertCurrent();
      const bytes = await readGitHubRepositoryPublicationBlob(roots.get(sha)!, sha);
      params.assertCurrent();
      const blob = await requestGitHubPublicationJson(
        params.endpoint + "blobs",
        params.identity,
        params.assertAction,
        {
          content: bytes.toString("base64"),
          encoding: "base64",
        },
      );
      if (gitHubPublicationObjectSha(blob) !== sha) {
        throw new Error("GitHub publication blob content changed.");
      }
      params.progress.completed++;
      if (params.progress.completed % progressInterval === 0) {
        params.onProgress();
      }
    }),
  });
  if (uploaded.hasError) {
    throw uploaded.firstError;
  }
}
