import fs from "node:fs/promises";
// Owns the filesystem boundary for session-export artifacts.
import path from "node:path";
import { resolveSecureTempRoot, withTempWorkspace } from "@openclaw/fs-safe/temp";
import {
  getPublishFileExclusiveFailureDetails,
  publishFileNoClobber,
} from "../../infra/directory-durability.js";
import { sameFileIdentity } from "../../infra/fs-safe-advanced.js";
import {
  FsSafeError,
  isPathInside,
  root,
  writeExternalFileWithinRoot,
  type Root,
} from "../../infra/fs-safe.js";

const MAX_DEFAULT_FILENAME_ATTEMPTS = 100;

function addCollisionSuffix(filePath: string, suffix: number): string {
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  return path.join(path.dirname(filePath), `${baseName}-${suffix}${ext}`);
}

async function createUnusedFile(
  workspaceRoot: Root,
  filePath: string,
  contents: string,
): Promise<string> {
  for (let suffix = 1; suffix <= MAX_DEFAULT_FILENAME_ATTEMPTS; suffix++) {
    const candidate = suffix === 1 ? filePath : addCollisionSuffix(filePath, suffix);
    try {
      await workspaceRoot.create(candidate, contents, { encoding: "utf-8" });
      return candidate;
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "already-exists") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Could not find an unused export filename near ${filePath}`);
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

/**
 * fs-safe may surface a post-publication durability error after creating the
 * target. Only accept that outcome when its receipt and current bytes prove
 * the generated path still names this export; otherwise the error is fatal.
 */
async function isConfirmedPublishedExport(params: {
  contents: string;
  error: unknown;
  targetPath: string;
}): Promise<boolean> {
  const details = getPublishFileExclusiveFailureDetails(params.error);
  if (!details?.targetCreated || details.cleanup === "removed" || !details.targetIdentity) {
    return false;
  }
  let target: fs.FileHandle | undefined;
  try {
    target = await fs.open(params.targetPath, "r");
    const opened = await target.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(details.targetIdentity, opened)) {
      return false;
    }
    const contents = await target.readFile({ encoding: "utf-8" });
    const current = await fs.lstat(params.targetPath, { bigint: true });
    return (
      contents === params.contents &&
      !current.isSymbolicLink() &&
      current.isFile() &&
      sameFileIdentity(details.targetIdentity, current)
    );
  } catch {
    return false;
  } finally {
    await target?.close().catch(() => undefined);
  }
}

/**
 * Writes outside the workspace first, then uses fs-safe's exclusive publication
 * primitive. An authorization recheck is the irrevocable publication fence: a
 * concurrent filename claim retries without ever replacing its winner.
 */
async function writeGeneratedExportFile(params: {
  contents: string;
  defaultFileName: string;
  recheckBeforePublication: () => Promise<void>;
  workspaceRoot: Root;
}): Promise<string> {
  const tempRoot = resolveSecureTempRoot({
    fallbackPrefix: "openclaw-session-export",
    unsafeFallbackLabel: "session export temporary directory",
  });
  return await withTempWorkspace(
    { rootDir: tempRoot, prefix: "artifact", dirMode: 0o700, mode: 0o600 },
    async (workspace) => {
      const stagedPath = await workspace.writeText("session.html", params.contents);
      for (let suffix = 1; suffix <= MAX_DEFAULT_FILENAME_ATTEMPTS; suffix++) {
        const candidate =
          suffix === 1
            ? params.defaultFileName
            : addCollisionSuffix(params.defaultFileName, suffix);
        const targetPath = await params.workspaceRoot.resolve(candidate);
        await params.recheckBeforePublication();
        try {
          await publishFileNoClobber(stagedPath, targetPath, {
            strategy: "link-or-copy",
            durability: "degrade",
          });
          return candidate;
        } catch (error) {
          if (
            await isConfirmedPublishedExport({
              contents: params.contents,
              error,
              targetPath,
            })
          ) {
            return candidate;
          }
          if (isAlreadyExistsError(error)) {
            continue;
          }
          throw error;
        }
      }
      throw new Error(`Could not find an unused export filename near ${params.defaultFileName}`);
    },
  );
}

function normalizeWorkspaceAliasPath(workspaceRoot: Root, requestedPath: string): string {
  if (!path.isAbsolute(requestedPath)) {
    return requestedPath;
  }
  const normalizedRequest = path.resolve(requestedPath);
  if (!isPathInside(workspaceRoot.rootDir, normalizedRequest)) {
    return requestedPath;
  }
  const relativePath = path.relative(workspaceRoot.rootDir, normalizedRequest);
  return relativePath || requestedPath;
}

export async function writeSessionExportFile(params: {
  workspaceDir: string;
  requestedPath?: string;
  defaultFileName: string;
  contents: string;
  /** Invoked after private staging and immediately before atomic publication. */
  recheckBeforePublication?: () => Promise<void>;
}): Promise<{ absolutePath: string; displayPath: string }> {
  const workspaceRoot = await root(params.workspaceDir, { mkdir: true, mode: 0o600 });

  let writtenPath: string;
  if (params.requestedPath) {
    // Explicit regular files retain overwrite behavior. Rebase only lexical workspace
    // aliases onto the canonical Root; nested aliases, symlinks, and outside paths
    // still reach fs-safe unchanged and are blocked.
    writtenPath = normalizeWorkspaceAliasPath(workspaceRoot, params.requestedPath);
  } else if (params.recheckBeforePublication) {
    writtenPath = await writeGeneratedExportFile({
      contents: params.contents,
      defaultFileName: params.defaultFileName,
      recheckBeforePublication: params.recheckBeforePublication,
      workspaceRoot,
    });
  } else {
    writtenPath = await createUnusedFile(workspaceRoot, params.defaultFileName, params.contents);
  }

  if (params.requestedPath && params.recheckBeforePublication) {
    const recheckBeforePublication = params.recheckBeforePublication;
    const published = await writeExternalFileWithinRoot({
      rootDir: workspaceRoot.rootDir,
      path: writtenPath,
      write: async (tempPath) => {
        await fs.writeFile(tempPath, params.contents, { encoding: "utf-8", mode: 0o600 });
        await recheckBeforePublication();
      },
    });
    writtenPath = published.path;
  } else if (params.requestedPath) {
    await workspaceRoot.write(writtenPath, params.contents, { encoding: "utf-8" });
  }

  const absolutePath = await workspaceRoot.resolve(writtenPath);
  const relativePath = path.relative(workspaceRoot.rootReal, absolutePath);
  return {
    absolutePath,
    displayPath: relativePath.startsWith("..") ? absolutePath : relativePath,
  };
}
