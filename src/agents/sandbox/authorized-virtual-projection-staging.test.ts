import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveAuthorizedVirtualProjectionMountPlan,
  resolveAuthorizedVirtualProjectionRoot,
  resolveAuthorizedVirtualProjectionSourcePath,
} from "./authorized-virtual-projection-mounts.js";
import {
  stageAuthorizedVirtualProjectionMountPlan,
  type AuthorizedVirtualProjectionBroker,
} from "./authorized-virtual-projection-staging.js";

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-authorized-projection-stage-"));
  tmpDirs.push(dir);
  return dir;
}

function createBroker(
  readFile: AuthorizedVirtualProjectionBroker["readFile"] = async (virtualPath) =>
    `contents:${virtualPath}`,
) {
  return {
    view: {
      version: 1 as const,
      viewId: "opaque-view",
      planId: "opaque-plan",
      contextFingerprint: "opaque-context",
      revision: "opaque-revision",
      roots: [
        {
          version: 1 as const,
          mountHandle: "opaque-a",
          virtualRoot: "private",
          access: "read" as const,
        },
        {
          version: 1 as const,
          mountHandle: "opaque-b",
          virtualRoot: "shared",
          access: "read" as const,
        },
      ],
      files: [
        { version: 1 as const, mountHandle: "opaque-b", virtualPath: "shared/2.md" },
        { version: 1 as const, mountHandle: "opaque-a", virtualPath: "private/1.md" },
      ],
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    readFile: vi.fn<AuthorizedVirtualProjectionBroker["readFile"]>(readFile),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(resolveAuthorizedVirtualProjectionRoot(dir), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("authorized virtual projection staging", () => {
  it("stages only broker-returned logical files and emits a core-issued mount plan", async () => {
    const agentWorkspaceDir = makeTempDir();
    const broker = createBroker();
    const staged = await stageAuthorizedVirtualProjectionMountPlan({ agentWorkspaceDir, broker });

    expect(staged.plan.mounts[0]!.sourcePath.startsWith(`${agentWorkspaceDir}${path.sep}`)).toBe(
      false,
    );

    expect(broker.readFile).toHaveBeenNthCalledWith(1, "private/1.md");
    expect(broker.readFile).toHaveBeenNthCalledWith(2, "shared/2.md");
    expect(staged.plan.mounts).toEqual([
      expect.objectContaining({ mountHandle: "opaque-a", virtualRoot: "private", access: "read" }),
      expect.objectContaining({ mountHandle: "opaque-b", virtualRoot: "shared", access: "read" }),
    ]);
    for (const mount of staged.plan.mounts) {
      expect(mount.sourcePath).toBe(
        resolveAuthorizedVirtualProjectionSourcePath({
          agentWorkspaceDir,
          viewId: broker.view.viewId,
          revision: broker.view.revision,
          stagingId: staged.plan.stagingId,
          mountHandle: mount.mountHandle,
        }),
      );
    }
    expect(fs.readFileSync(path.join(staged.plan.mounts[0]!.sourcePath, "1.md"), "utf8")).toBe(
      "contents:private/1.md",
    );
    expect(
      resolveAuthorizedVirtualProjectionMountPlan({ agentWorkspaceDir, plan: staged.plan }),
    ).toHaveLength(2);

    await staged.dispose();
    expect(fs.existsSync(staged.plan.mounts[0]!.sourcePath)).toBe(false);
  });

  it("fails closed and removes partial staging when the broker withholds a file", async () => {
    const agentWorkspaceDir = makeTempDir();
    const broker = createBroker(async (virtualPath) =>
      virtualPath === "shared/2.md" ? undefined : "private contents",
    );
    await expect(
      stageAuthorizedVirtualProjectionMountPlan({ agentWorkspaceDir, broker }),
    ).rejects.toThrow(/content is unavailable/);
    const privateSource = resolveAuthorizedVirtualProjectionSourcePath({
      agentWorkspaceDir,
      viewId: broker.view.viewId,
      revision: broker.view.revision,
      stagingId: "unavailable-stage",
      mountHandle: "opaque-a",
    });
    expect(fs.existsSync(privateSource)).toBe(false);
  });

  it("never carries undeclared files across repeated or revised whole-directory staging", async () => {
    const agentWorkspaceDir = makeTempDir();
    const first = createBroker(async (virtualPath) => `first:${virtualPath}`);
    first.view = {
      ...first.view,
      roots: [first.view.roots[0]!],
      files: [{ version: 1 as const, mountHandle: "opaque-a", virtualPath: "private/old.md" }],
    };
    const firstStage = await stageAuthorizedVirtualProjectionMountPlan({
      agentWorkspaceDir,
      broker: first,
    });
    const firstSource = firstStage.plan.mounts[0]!.sourcePath;
    expect(fs.existsSync(path.join(firstSource, "old.md"))).toBe(true);

    const sameRevision = createBroker(async (virtualPath) => `same:${virtualPath}`);
    sameRevision.view = {
      ...sameRevision.view,
      roots: [sameRevision.view.roots[0]!],
      files: [{ version: 1 as const, mountHandle: "opaque-a", virtualPath: "private/current.md" }],
    };
    const sameRevisionStage = await stageAuthorizedVirtualProjectionMountPlan({
      agentWorkspaceDir,
      broker: sameRevision,
    });
    const sameRevisionSource = sameRevisionStage.plan.mounts[0]!.sourcePath;
    expect(sameRevisionSource).not.toBe(firstSource);
    expect(fs.readdirSync(sameRevisionSource)).toEqual(["current.md"]);
    expect(fs.readFileSync(path.join(sameRevisionSource, "current.md"), "utf8")).toBe(
      "same:private/current.md",
    );

    const revised = createBroker(async (virtualPath) => `revised:${virtualPath}`);
    revised.view = {
      ...revised.view,
      revision: "opaque-revision-2",
      roots: [revised.view.roots[0]!],
      files: [{ version: 1 as const, mountHandle: "opaque-a", virtualPath: "private/new.md" }],
    };
    const revisedStage = await stageAuthorizedVirtualProjectionMountPlan({
      agentWorkspaceDir,
      broker: revised,
    });
    const revisedSource = revisedStage.plan.mounts[0]!.sourcePath;
    expect(revisedSource).not.toBe(firstSource);
    expect(fs.readdirSync(revisedSource)).toEqual(["new.md"]);
    expect(fs.readFileSync(path.join(revisedSource, "new.md"), "utf8")).toBe(
      "revised:private/new.md",
    );

    await Promise.all([firstStage.dispose(), sameRevisionStage.dispose(), revisedStage.dispose()]);
  });

  it("rejects a manifest path that does not stay beneath its declared virtual root", async () => {
    const agentWorkspaceDir = makeTempDir();
    const broker = createBroker();
    const invalidBroker = {
      ...broker,
      view: {
        ...broker.view,
        files: [
          { version: 1 as const, mountHandle: "opaque-b", virtualPath: "private/2.md" },
          broker.view.files[1]!,
        ],
      },
    };
    await expect(
      stageAuthorizedVirtualProjectionMountPlan({ agentWorkspaceDir, broker: invalidBroker }),
    ).rejects.toThrow(/manifest path is invalid/);
  });
});
