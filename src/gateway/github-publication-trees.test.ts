import { expect, it, vi } from "vitest";
import { createGitHubPublicationTreeMetadata } from "./github-publication-trees.js";

it("keeps positive object evidence scoped by host, repository and tree request shape", async () => {
  let host = "github.com";
  const root = "a".repeat(40);
  const blob = "b".repeat(40);
  const readTree = vi.fn(async (_repository: string, sha: string, _recursive: boolean) => ({
    sha,
    truncated: false,
    tree: [{ path: "file.txt", type: "blob", mode: "100644", sha: blob }],
  }));
  const metadata = createGitHubPublicationTreeMetadata({
    host: () => host,
    readTree,
    readCommit: async () => undefined,
  });
  await metadata.readTree("foreign/repo", root);
  expect((await metadata.readKnownBlobs("publish/repo", [], () => {})).has(blob)).toBe(false);
  await metadata.readTree("publish/repo", root);
  await metadata.readTree("foreign/repo", root);
  expect((await metadata.readKnownBlobs("publish/repo", [root], () => {})).has(blob)).toBe(true);
  await metadata.readKnownBlobs("publish/repo", [root], () => {});
  expect(readTree.mock.calls).toEqual([
    ["foreign/repo", root, false],
    ["publish/repo", root, false],
    ["publish/repo", root, true],
  ]);
  host = "enterprise.example.test";
  expect((await metadata.readKnownBlobs("publish/repo", [], () => {})).size).toBe(0);
  await metadata.readTree("publish/repo", root);
  expect(readTree).toHaveBeenCalledTimes(4);
});

it("keeps incomplete metadata unknown and does not swallow lost authority", async () => {
  const root = "a".repeat(40);
  const readTree = vi.fn(async () => ({
    sha: root,
    truncated: true,
    tree: [{ path: "file", type: "blob", mode: "100644", sha: "b".repeat(40) }],
  }));
  const metadata = createGitHubPublicationTreeMetadata({
    host: () => "github.com",
    readTree,
    readCommit: async () => undefined,
  });
  expect((await metadata.readKnownBlobs("owner/repo", [root], () => {})).size).toBe(0);
  let current = true;
  readTree.mockImplementationOnce(async () => {
    current = false;
    throw new Error("network unavailable");
  });
  const assertCurrent = () => {
    if (!current) {
      throw new Error("authority closed");
    }
  };
  await expect(
    metadata.readKnownBlobs("owner/repo", ["c".repeat(40)], assertCurrent),
  ).rejects.toThrow("authority closed");
});
