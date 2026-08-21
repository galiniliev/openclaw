import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Hash content once at the artifact boundary; catalog rows carry this exact digest. */
export function hashScopedMemoryWriteContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The file is fsynced before rename. Directory fsync is best-effort because Windows does not
 * support it, but the artifact bytes remain the durability boundary on every supported host.
 */
export function syncScopedMemoryWriteDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR") {
      throw error;
    }
  }
}

export function stageScopedMemoryWriteArtifact(params: {
  directory: string;
  stageLocator: string;
  content: string;
}): string {
  fs.mkdirSync(params.directory, { recursive: true, mode: 0o700 });
  const pathname = path.join(params.directory, params.stageLocator);
  const descriptor = fs.openSync(pathname, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, params.content, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  syncScopedMemoryWriteDirectory(params.directory);
  return pathname;
}

export function finalizeScopedMemoryWriteArtifact(params: {
  directory: string;
  stagePath: string;
  finalPath: string;
}): void {
  fs.renameSync(params.stagePath, params.finalPath);
  syncScopedMemoryWriteDirectory(params.directory);
}

export function readVerifiedScopedMemoryWriteArtifact(params: {
  pathname: string;
  contentHash: string;
  contentBytes: number;
}): string | undefined {
  try {
    const content = fs.readFileSync(params.pathname, "utf8");
    return Buffer.byteLength(content) === params.contentBytes &&
      hashScopedMemoryWriteContent(content) === params.contentHash
      ? content
      : undefined;
  } catch {
    return undefined;
  }
}

/** Keep an invalid artifact outside every selected store root before another recovery can see it. */
export function quarantineScopedMemoryWriteArtifact(params: {
  directory: string;
  pathname: string;
}): void {
  if (!fs.existsSync(params.pathname)) {
    return;
  }
  const quarantine = path.join(path.dirname(params.directory), ".quarantine");
  fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 });
  fs.renameSync(params.pathname, path.join(quarantine, `orphan_${randomUUID()}`));
  syncScopedMemoryWriteDirectory(quarantine);
  syncScopedMemoryWriteDirectory(params.directory);
}

export function requireOneScopedMemoryWriteRow(
  result: Readonly<{ numAffectedRows?: bigint }>,
  operation: string,
): void {
  if (result.numAffectedRows !== 1n) {
    throw new Error(`authorized memory ${operation} lost its authoritative row`);
  }
}
