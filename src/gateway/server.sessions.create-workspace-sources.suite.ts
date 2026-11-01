import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import * as repositoryPaths from "../agents/worktrees/repository-paths.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions/types.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";

type CreatedSourceSession = { key: string; sessionId: string; entry: SessionEntry };

export function registerWorkspaceSourceSpawnTests({
  parentKey,
  getStateRoot,
  createSession,
  createChild,
  requestChild,
  readEntry,
  expectCreationError,
  assertNoProjectClone,
}: {
  parentKey: string;
  getStateRoot: () => string;
  createSession: (params: Record<string, unknown>) => Promise<CreatedSourceSession>;
  createChild: (params?: Record<string, unknown>) => Promise<CreatedSourceSession>;
  requestChild: (params?: Record<string, unknown>) => Promise<unknown>;
  readEntry: (key: string) => InternalSessionEntry | undefined;
  expectCreationError: (
    request: Promise<unknown>,
    message: unknown,
    code?: string,
  ) => Promise<void>;
  assertNoProjectClone: () => void;
}) {
  test.each(["empty metadata", "missing worktree target", "partial metadata"])(
    "child sessions preserve %s without inventing a checkout",
    async (damage) => {
      const workspace = path.join(getStateRoot(), "non-git-workspace");
      const metadata = path.join(workspace, ".git");
      const contents = "gitdir: missing-worktree\n";
      if (damage === "missing worktree target") {
        await fs.writeFile(metadata, contents);
      } else {
        await fs.mkdir(damage === "partial metadata" ? path.join(metadata, "objects") : metadata, {
          recursive: true,
        });
      }
      await createSession({ key: parentKey });
      if (damage === "empty metadata") {
        const child = await createChild({ worktree: false });
        expect(child.entry.worktree).toBeUndefined();
        const stored = readEntry(child.key);
        expect(stored).toMatchObject({ parentSessionKey: parentKey });
        expect(stored?.pendingWorktree).toBeUndefined();
        expect(await fs.readdir(metadata)).toEqual([]);
        await expect(repositoryPaths.resolveRepositoryPaths(workspace)).rejects.toThrow(
          "not a git checkout",
        );
        await expectCreationError(
          requestChild(),
          "agent workspace is not a git checkout",
          "INVALID_REQUEST",
        );
        return;
      }
      await expectCreationError(
        requestChild(),
        expect.stringContaining("checkout preserved"),
        "UNAVAILABLE",
      );
      if (damage === "missing worktree target") {
        expect(await fs.readFile(metadata, "utf8")).toBe(contents);
      } else {
        expect(await fs.readdir(metadata)).toEqual(["objects"]);
      }
    },
  );

  test("worker-style child creation inherits a repository parent without a Gateway Git fallback", async () => {
    const parent = await createSession({
      key: parentKey,
      repository: { url: "https://github.com/example/spawn-fixture.git", ref: "main" },
    });
    const workspaces = getSessionRepositoryWorkspaceStore();
    const initial = await workspaces.get(parent.entry.repositoryWorkspaceId!);
    expect(initial).toBeDefined();
    const diskAuthority = {
      environmentId: "parent-private-worker",
      sessionId: parent.sessionId,
      ownerEpoch: 3,
      ownerBinding: "parent-owned-disk",
      identity: {
        leaseId: "parent-lease",
        attemptLeaseId: "parent-attempt",
        slug: "parent",
        resourceId: "parent-disk",
      },
      workspaceDir: "/worker/parent",
    };
    const original = await workspaces.bindBase({
      workspaceId: initial!.workspaceId,
      expectedRevision: initial!.revision,
      baseCommit: "a".repeat(40),
      diskAuthority,
      assertCurrent() {},
    });
    const first = await createChild({ key: "agent:main:dashboard:repository-child" });
    expect(first.entry.repositoryWorkspaceId).toBeDefined();
    expect(first.entry.repositoryWorkspaceId).not.toBe(original.workspaceId);
    expect(first.entry.worktree).toBeUndefined();
    expect(readEntry(first.key)?.pendingWorktree).toBeUndefined();
    const child = await workspaces.get(first.entry.repositoryWorkspaceId!);
    expect(child).toMatchObject({
      agentId: "main",
      sessionKey: first.key,
      url: original.url,
      requestedRef: original.requestedRef,
      baseCommit: original.baseCommit,
      runSetupScript: false,
    });
    expect(child?.diskAuthority).toBeUndefined();
    expect(await workspaces.get(original.workspaceId)).toEqual(original);
    assertNoProjectClone();
  });
}
