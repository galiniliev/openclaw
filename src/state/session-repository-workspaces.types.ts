import type { RetainedWorkspaceAuthority } from "./retained-workspace-authority.js";

/** Most recent lossy source replacement; later checkpoints retain this provenance. */
export type RepositoryWorkspaceRecovery = {
  reason: "missing-checkpoint-artifact" | "missing-worker";
  atMs: number;
  original: {
    revision: number;
    baseCommit: string | null;
    baseManifestHash: string | null;
    checkpointRef: string | null;
    manifestHash: string | null;
  };
  sourceCommit: string;
  source: "published-branch" | "recorded-base";
  unrecoverablePrivateContent: true;
};

export type SessionRepositoryWorkspaceRecord = {
  workspaceId: string;
  agentId: string;
  sessionKey: string;
  url: string;
  requestedRef: string | null;
  runSetupScript: boolean;
  baseCommit: string | null;
  baseManifestHash: string | null;
  branch: string;
  checkpointRef: string | null;
  manifestHash: string | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  recovery?: RepositoryWorkspaceRecovery;
  diskAuthority?: RetainedWorkspaceAuthority;
};

export type RepositoryWorkspaceOwner = { agentId: string; sessionKey: string };
export type RepositoryWorkspaceCreate = RepositoryWorkspaceOwner & {
  url: string;
  requestedRef?: string;
  runSetupScript?: boolean;
  branchPrefix?: string;
  branch?: string;
};
export type RepositoryWorkspaceMutation = { workspaceId: string; expectedRevision: number };
export type RepositoryWorkspaceBranchReset = RepositoryWorkspaceMutation & {
  sourceCommit: string;
  recovery?: Pick<RepositoryWorkspaceRecovery, "reason" | "source">;
};
export type RepositoryWorkspaceBase = RepositoryWorkspaceMutation & {
  diskAuthority?: RetainedWorkspaceAuthority;
  baseCommit: string;
  baseManifestHash?: string;
};
export type RepositoryWorkspaceRetainedOwner = RepositoryWorkspaceMutation & {
  expectedDiskAuthority: RetainedWorkspaceAuthority;
  diskAuthority: RetainedWorkspaceAuthority;
  placementGeneration: number;
};
export type RepositoryWorkspaceCheckpoint = RepositoryWorkspaceMutation & {
  checkpointRef: string;
  manifestHash: string;
};

export type RepositoryWorkspaceMutationResult = {
  workspaceId: string;
  workspace: SessionRepositoryWorkspaceRecord | undefined;
  owner: RepositoryWorkspaceOwner | undefined;
  changed: boolean;
};
