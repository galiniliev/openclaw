import type fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ignoreMissingPath } from "../infra/errno.js";
import { hasNodeErrorCode } from "../infra/path-guards.js";
import {
  nodeWorkerWorkspaceLaunchGenerationKey,
  type NodeWorkerWorkspaceLaunchReference,
  type NodeWorkerWorkspaceSession,
} from "./node-worker-workspace-identity.js";

const ENVIRONMENT_HASH_PATTERN = /^[a-f0-9]{16}$/u;
const SESSION_HASH_PATTERN = /^[a-f0-9]{32}$/u;

export async function listOwnedEntries(parent: string): Promise<fs.Dirent[]> {
  try {
    return (await fsp.readdir(parent, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
  } catch (error) {
    return ignoreMissingPath(error) ?? [];
  }
}

async function listOwnedDirectories(parent: string): Promise<string[]> {
  return (await listOwnedEntries(parent))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function removeIfEmpty(target: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  try {
    await fsp.rmdir(target);
  } catch (error) {
    if (
      !hasNodeErrorCode(error, "ENOENT") &&
      !hasNodeErrorCode(error, "ENOTEMPTY") &&
      !hasNodeErrorCode(error, "EEXIST")
    ) {
      throw error;
    }
  }
}

export async function listNodeWorkerWorkspaceSessions(
  root: string,
  gatewayNamespace: string,
): Promise<NodeWorkerWorkspaceSession[]> {
  const gatewayRoot = path.join(root, gatewayNamespace);
  const workspacesRoot = path.join(gatewayRoot, "workspaces");
  const sessions: NodeWorkerWorkspaceSession[] = [];
  for (const environmentHash of await listOwnedDirectories(workspacesRoot)) {
    if (!ENVIRONMENT_HASH_PATTERN.test(environmentHash)) {
      continue;
    }
    const environmentRoot = path.join(workspacesRoot, environmentHash);
    for (const sessionHash of await listOwnedDirectories(environmentRoot)) {
      if (!SESSION_HASH_PATTERN.test(sessionHash)) {
        continue;
      }
      sessions.push({
        gatewayNamespace,
        environmentHash,
        sessionHash,
        workspacesRoot,
        environmentRoot,
        sessionRoot: path.join(environmentRoot, sessionHash),
      });
    }
  }
  return sessions;
}

/** Refcount active workspace use and carry protection through an in-flight retention pass. */
export class NodeWorkerWorkspaceRetainProtection {
  private readonly operations = new Map<string, number>();
  private readonly passes = new Map<string, Set<string>>();

  beginOperation(gatewayNamespace: string, generationKey: string): () => void {
    this.operations.set(generationKey, (this.operations.get(generationKey) ?? 0) + 1);
    this.passes.get(gatewayNamespace)?.add(generationKey);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const count = this.operations.get(generationKey) ?? 0;
      if (count <= 1) {
        this.operations.delete(generationKey);
      } else {
        this.operations.set(generationKey, count - 1);
      }
    };
  }

  beginPass(gatewayNamespace: string): Set<string> {
    const protection = this.currentProtection(gatewayNamespace);
    this.passes.set(gatewayNamespace, protection);
    return protection;
  }

  endPass(gatewayNamespace: string): void {
    this.passes.delete(gatewayNamespace);
  }

  currentProtection(
    gatewayNamespace: string,
    retainedDuringPass?: ReadonlySet<string>,
    launches: readonly NodeWorkerWorkspaceLaunchReference[] = [],
  ): Set<string> {
    const protectedGenerations = new Set(retainedDuringPass);
    for (const generationKey of this.operations.keys()) {
      if (generationKey.startsWith(`${gatewayNamespace}/`)) {
        protectedGenerations.add(generationKey);
      }
    }
    for (const launch of launches) {
      if (launch.gatewayNamespace === gatewayNamespace) {
        protectedGenerations.add(nodeWorkerWorkspaceLaunchGenerationKey(launch));
      }
    }
    return protectedGenerations;
  }
}
