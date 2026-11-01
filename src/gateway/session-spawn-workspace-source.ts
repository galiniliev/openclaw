import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { SessionWorktreeSourceChangedError } from "../agents/worktrees/errors.js";
import {
  captureWorktreeRegistryReadGuard,
  readLiveRegistryWorktreeByOwner,
} from "../agents/worktrees/registry-read.js";
import { captureWorktreeRunEndContext } from "../agents/worktrees/run-end-lifecycle.js";
import type { WorktreeSourceStage } from "../agents/worktrees/types.js";
import { getRuntimeConfig } from "../config/io.js";
import { captureSessionEntrySourceAssertion } from "../config/sessions/session-entry-source-authority.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import {
  resolveWorkspaceProject,
  selectStoredProjectRegistry,
} from "../projects/project-registry.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type {
  PrepareGatewaySessionLifecycle,
  PreparedGatewaySessionLifecycle,
} from "./session-create-service.types.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import { withGatewaySessionEntryReadOnly } from "./session-utils-read-lifetime.js";
import type { GatewaySessionEntryRead } from "./session-utils-store.js";

type AcceptedWorktreeSource = NonNullable<
  PreparedGatewaySessionLifecycle["pendingWorktree"]
>["source"];

export type SpawnParentRepositorySource = {
  kind: "repository";
  prepareChild: (
    target: Parameters<PrepareGatewaySessionLifecycle>[0],
    options: { branchPrefix?: string; runSetupScript: boolean; assertCurrent: () => void },
  ) => ReturnType<PrepareGatewaySessionLifecycle>;
};

/** Fork accepted repository facts; the parent's private disk never becomes child ownership. */
export async function prepareSpawnParentRepositorySource(
  parent: GatewaySessionEntryRead,
  workspaceId: string,
  assertParentCurrent: SessionSourceAssertion,
  refuse: () => never,
): Promise<SpawnParentRepositorySource> {
  assertParentCurrent();
  const store = getSessionRepositoryWorkspaceStore();
  const source = captureOpenClawStateWorkerContext({ path: store.path });
  const prepared = await store.prepare(workspaceId);
  assertParentCurrent();
  source.admission.assertCurrent();
  const workspace = prepared.workspace;
  if (
    !workspace ||
    workspace.agentId !== parent.agentId ||
    workspace.sessionKey !== parent.canonicalKey
  ) {
    refuse();
  }
  const assertCurrent = () => {
    assertParentCurrent();
    source.admission.assertCurrent();
    if (prepared.current()?.revision !== workspace.revision) {
      refuse();
    }
  };
  assertCurrent();
  return {
    kind: "repository",
    prepareChild: async (target, options) => {
      // The creation owner also imports worktree preparation; load it after source selection.
      const { prepareSessionRepositoryWorkspace } =
        await import("./server-methods/session-create-project.js");
      const guard = () => {
        options.assertCurrent();
        assertCurrent();
      };
      guard();
      return prepareSessionRepositoryWorkspace(
        { url: workspace.url, ...(workspace.requestedRef ? { ref: workspace.requestedRef } : {}) },
        {
          branchPrefix: options.branchPrefix,
          forkSourceWorkspaceId: workspace.workspaceId,
          runSetupScript: options.runSetupScript,
          assertCurrent: guard,
        },
      )(target);
    },
  };
}

export type SpawnParentFilesystemSource = {
  kind?: never;
  workspace: string;
  source?: AcceptedWorktreeSource;
  withCurrent: WorktreeSourceStage;
  withRollback?: <T>(run: (assertCurrent: () => void) => Promise<T>) => Promise<T>;
};
type SpawnParentWorktreeSource = SpawnParentFilesystemSource | SpawnParentRepositorySource;

export async function resolveSpawnParentWorkspaceSource(
  parentSessionKey: string,
  agentId: string,
  options: { signal?: AbortSignal } = {},
): Promise<SpawnParentWorktreeSource | undefined> {
  return withGatewaySessionEntryReadOnly(
    {
      cfg: getRuntimeConfig(),
      key: parentSessionKey,
      agentId,
      assertActive: () => options.signal?.throwIfAborted(),
    },
    async (parent) => prepareSpawnParentWorkspaceSource(parent, agentId, options),
  );
}

async function prepareSpawnParentWorkspaceSource(
  parent: GatewaySessionEntryRead,
  agentId: string,
  options: { signal?: AbortSignal },
): Promise<SpawnParentWorktreeSource | undefined> {
  if (!parent.entry) {
    return undefined;
  }
  const fields = [
    "sessionId",
    "lifecycleRevision",
    "archivedAt",
    "projectId",
    "sessionRoot",
    "worktree",
    "repositoryWorkspaceId",
  ] as const;
  const sourceKind = parent.entry.repositoryWorkspaceId
    ? "repository workspace"
    : parent.entry.worktree
      ? "managed worktree"
      : "project";
  const refuse = (): never => {
    throw new SessionWorktreeSourceChangedError(
      `Spawn parent ${sourceKind} changed; retry from its current session`,
    );
  };
  const scope = { agentId, sessionKey: parent.canonicalKey, storePath: parent.storePath };
  const assertRouting = captureSessionMutationRouting(parent.cfg, refuse, [scope]);
  const assertHostCurrent = () => {
    options.signal?.throwIfAborted();
    assertRouting(getRuntimeConfig());
  };
  const parentSource = captureSessionEntrySourceAssertion({
    scope,
    readSource: parent.capturedReadSource,
    expected: parent.entry,
    fields,
    assertCurrent: assertHostCurrent,
    assertHostCurrent,
    refuse,
  });
  if (parent.entry.repositoryWorkspaceId) {
    return prepareSpawnParentRepositorySource(
      parent,
      parent.entry.repositoryWorkspaceId,
      parentSource,
      refuse,
    );
  }
  if (!parent.entry.worktree) {
    const projectId = normalizeOptionalString(parent.entry.projectId);
    if (!projectId) {
      return undefined;
    }
    const selection = projectId.startsWith("workspace:")
      ? undefined
      : await selectStoredProjectRegistry(projectId, options);
    const project = selection?.project ?? resolveWorkspaceProject(parent.cfg, projectId);
    if (!project) {
      throw new SessionWorktreeSourceChangedError(
        "Spawn parent project changed; retry from its current session",
      );
    }
    const assertParentCurrent = (storedRoot: string | undefined, assertCheckout?: () => void) => {
      assertCheckout?.();
      const currentProjectRoot = selection
        ? storedRoot
        : resolveWorkspaceProject(getRuntimeConfig(), projectId)?.repoRoot;
      if (
        parent.entry?.archivedAt !== undefined ||
        parent.entry?.sessionRoot !== project.repoRoot ||
        currentProjectRoot !== project.repoRoot
      ) {
        throw new SessionWorktreeSourceChangedError(
          "Spawn parent project changed; retry from its current session",
        );
      }
    };
    if (selection) {
      return {
        workspace: project.repoRoot,
        source: { kind: "project", id: projectId },
        withRollback: selection.withRollback,
        withCurrent: async (run, acquisition) =>
          await selection.withCurrent((current) => {
            const assertCurrent = composeSessionSourceAssertion([parentSource], (assertSources) => {
              assertSources();
              assertParentCurrent(current.project?.repoRoot, current.assertCurrent);
            });
            return run({
              assertCurrent,
              assertCheckoutCurrent: current.assertCheckoutCurrent,
              signal: current.signal,
            });
          }, acquisition),
      };
    }
    const assertCurrent = composeSessionSourceAssertion([parentSource], (assertSources) => {
      assertSources();
      assertParentCurrent(undefined);
    });
    assertCurrent();
    return {
      workspace: project.repoRoot,
      source: { kind: "project", id: projectId },
      withCurrent: async (run) => await run({ assertCurrent, signal: options.signal }),
    };
  }
  const context = captureWorktreeRunEndContext(process.env);
  const accept = captureWorktreeRegistryReadGuard(context, "source-owner", {
    id: parent.entry.worktree.id,
    ownerKind: "session",
    ownerId: parent.canonicalKey,
  });
  const worktree = await readLiveRegistryWorktreeByOwner(context, "session", parent.canonicalKey);
  const assertWorktreeCurrent = accept(worktree);
  options.signal?.throwIfAborted();
  if (
    !worktree ||
    worktree.id !== parent.entry.worktree.id ||
    parent.entry.archivedAt !== undefined
  ) {
    throw new SessionWorktreeSourceChangedError(
      "Spawn parent managed worktree changed; retry from its current session",
    );
  }
  // Validate the inherited source through the child creation commit. After that,
  // persisted workspace intent belongs to the child and uses its admitted run.
  const assertCurrent = composeSessionSourceAssertion([parentSource], (assertSources) => {
    assertSources();
    assertWorktreeCurrent();
  });
  assertCurrent();
  return {
    workspace: worktree.repoRoot,
    source: { kind: "worktree", id: worktree.id },
    withCurrent: async (run) =>
      await run({
        assertCurrent,
        signal: options.signal,
        workerAuthority: {
          assertCurrent: parentSource,
          predicates: [
            {
              kind: "source-owner",
              ownerId: parent.canonicalKey,
              id: worktree.id,
              path: worktree.path,
              repoRoot: worktree.repoRoot,
            },
          ],
        },
      }),
  };
}
