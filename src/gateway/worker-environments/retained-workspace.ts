import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { RetainedWorkspaceAuthority } from "../../state/retained-workspace-authority.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type {
  WorkerEnvironmentServiceContract,
  WorkerEnvironmentServiceRecord,
} from "./service-contract.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";

/** Existing allocation admission owns the lock and authenticated caller. */
export async function resumeOriginalRetainedWorkspaceOwner(
  environment: WorkerEnvironmentRecord,
  authority: RetainedWorkspaceAuthority,
  owner: { agentId: string; sessionKey: string; sessionId: string } | undefined,
  store: Pick<WorkerEnvironmentStore, "resumeParkedRetainedWorkspaceOwner">,
  signal: AbortSignal | undefined,
  assertCurrent: (() => void) | undefined,
): Promise<WorkerEnvironmentRecord> {
  if (
    !owner ||
    !environment.retention ||
    !isDeepStrictEqual(environment.retention.owner, owner) ||
    environment.retention.ownerBinding !== authority.ownerBinding ||
    authority.sessionId !== owner.sessionId
  ) {
    throw new Error("Original retained worker owner changed; replacement is refused");
  }
  const workspace = await getSessionRepositoryWorkspaceStore().find(owner);
  signal?.throwIfAborted();
  assertCurrent?.();
  if (!isDeepStrictEqual(workspace?.diskAuthority, authority)) {
    throw new Error("Original retained disk authority changed; replacement is refused");
  }
  if (environment.state !== "orphaned") {
    return environment;
  }
  return store.resumeParkedRetainedWorkspaceOwner({
    environmentId: environment.environmentId,
    expectedOwnerEpoch: environment.ownerEpoch,
    owner,
    expectedDiskAuthority: authority,
    assertCurrent: () => {
      signal?.throwIfAborted();
      assertCurrent?.();
    },
  });
}

export function retainedRepositoryDisk(
  environment:
    | Pick<
        WorkerEnvironmentRecord,
        | "environmentId"
        | "providerId"
        | "profileSnapshot"
        | "retention"
        | "leaseId"
        | "destroyRequestedAtMs"
        | "ownerEpoch"
      >
    | undefined,
  owner: { agentId: string; sessionKey: string; sessionId: string },
  workspaceDir: string,
): RetainedWorkspaceAuthority | undefined {
  const retention = environment?.retention;
  if (
    !environment ||
    environment.providerId !== "crabbox" ||
    !isRecord(environment.profileSnapshot.settings) ||
    environment.profileSnapshot.settings.provider !== "azure-sandbox" ||
    !retention
  ) {
    return undefined;
  }
  const receipt = retention.receipt;
  if (
    !receipt ||
    !receipt.policyVerified ||
    receipt.ownerBinding !== retention.ownerBinding ||
    receipt.identity.leaseId !== environment.leaseId ||
    retention.operation ||
    environment.destroyRequestedAtMs !== null ||
    retention.owner.agentId !== owner.agentId ||
    retention.owner.sessionKey !== owner.sessionKey ||
    retention.owner.sessionId !== owner.sessionId ||
    receipt.observedState === "missing"
  ) {
    throw new Error(
      "Retained workspace disk is missing or has a different owner; recovery is held",
    );
  }
  return {
    environmentId: environment.environmentId,
    sessionId: owner.sessionId,
    ownerEpoch: environment.ownerEpoch,
    ownerBinding: retention.ownerBinding,
    identity: receipt.identity,
    workspaceDir,
  };
}

export function assertRetainedWorkspaceDisk(
  authority: RetainedWorkspaceAuthority,
  environment:
    | Pick<
        WorkerEnvironmentServiceRecord,
        | "environmentId"
        | "state"
        | "ownerEpoch"
        | "retention"
        | "leaseId"
        | "attachedSessionIds"
        | "destroyRequestedAtMs"
      >
    | undefined,
  placement: Extract<WorkerSessionPlacementRecord, { state: "active" | "draining" }>,
): void {
  const retention = environment?.retention;
  const receipt = retention?.receipt;
  if (
    !environment ||
    !retention ||
    !receipt ||
    environment.state !== "attached" ||
    environment.environmentId !== authority.environmentId ||
    environment.ownerEpoch !== authority.ownerEpoch ||
    environment.ownerEpoch !== placement.activeOwnerEpoch ||
    environment.destroyRequestedAtMs !== null ||
    environment.leaseId !== authority.identity.leaseId ||
    retention.ownerBinding !== authority.ownerBinding ||
    retention.owner.sessionId !== placement.sessionId ||
    retention.owner.sessionKey !== placement.sessionKey ||
    retention.owner.agentId !== placement.agentId ||
    authority.sessionId !== placement.sessionId ||
    authority.workspaceDir !== placement.remoteWorkspaceDir ||
    !isDeepStrictEqual(receipt.identity, authority.identity) ||
    receipt.ownerBinding !== retention.ownerBinding ||
    !receipt.policyVerified ||
    retention.operation ||
    receipt.observedState.toLowerCase() === "missing" ||
    environment.attachedSessionIds.length !== 1 ||
    environment.attachedSessionIds[0] !== placement.sessionId
  ) {
    throw new Error(
      "Retained workspace disk is missing or has a different owner; recovery is held",
    );
  }
}

/** Admission already excludes old pending results; never convert a recovery hold here. */
export async function prepareRetainedWorkspace(params: {
  workspace: WorkerSessionWorkspace;
  placement: Extract<WorkerSessionPlacementRecord, { state: "active" }>;
  getEnvironment: () => WorkerEnvironmentRecord | undefined;
  assertCurrent: () => void;
}): Promise<WorkerSessionWorkspace> {
  if (params.workspace.kind !== "repository") {
    return params.workspace;
  }
  const repository = params.workspace.repository;
  const authority = retainedRepositoryDisk(
    params.getEnvironment(),
    params.placement,
    params.placement.remoteWorkspaceDir,
  );
  if (!authority && !repository.diskAuthority) {
    return params.workspace;
  }
  if (
    !authority ||
    (repository.diskAuthority && !isDeepStrictEqual(repository.diskAuthority, authority))
  ) {
    throw new Error("Retained workspace disk authority changed; recovery is held");
  }
  const assertCurrent = () => {
    params.assertCurrent();
    assertRetainedWorkspaceDisk(authority, params.getEnvironment(), params.placement);
  };
  assertCurrent();
  if (repository.diskAuthority) {
    return params.workspace;
  }
  if (!repository.baseCommit || !repository.baseManifestHash) {
    throw new Error("Retained workspace has no admitted repository baseline");
  }
  const bound = await getSessionRepositoryWorkspaceStore().bindBase({
    workspaceId: repository.workspaceId,
    expectedRevision: repository.revision,
    baseCommit: repository.baseCommit,
    baseManifestHash: repository.baseManifestHash,
    diskAuthority: authority,
    assertCurrent,
  });
  assertCurrent();
  return { kind: "repository", repository: bound };
}

/** Reopen transport custody only. Provider admission still verifies the actual disk before execution. */
export function assertRetainedWorkspaceBinding(
  disk: RetainedWorkspaceAuthority,
  binding: {
    environmentId: string;
    ownerEpoch: number;
    sessionId: string;
    isOwnerCurrent: () => boolean;
  },
  workspace: { remoteWorkspaceDir: string; source: { kind: string } },
): void {
  if (
    !binding.isOwnerCurrent() ||
    disk.environmentId !== binding.environmentId ||
    disk.ownerEpoch !== binding.ownerEpoch ||
    disk.sessionId !== binding.sessionId ||
    disk.workspaceDir !== workspace.remoteWorkspaceDir ||
    workspace.source.kind !== "repository"
  ) {
    throw new Error("Retained workspace transport lost its exact disk owner");
  }
}

/** Explicit transfers may resume the owned disk; ordinary settlement never calls this path. */
export async function prepareRetainedWorkspaceTransfer(params: {
  authority: RetainedWorkspaceAuthority;
  placement: Extract<WorkerSessionPlacementRecord, { state: "active" }>;
  environments: Pick<WorkerEnvironmentServiceContract, "get" | "inspectTurnLease">;
  assertCurrent: () => void;
  assertResumeCurrent?: () => void;
  beforeResume?: () => Promise<void>;
}): Promise<void> {
  params.assertCurrent();
  const environment = params.environments.get(params.placement.environmentId);
  assertRetainedWorkspaceDisk(params.authority, environment, params.placement);
  const retention = environment?.retention;
  const receipt = retention?.receipt;
  if (
    retention?.desiredState === "suspended" ||
    receipt?.computeWindow.state === "closed" ||
    (receipt && Date.parse(receipt.computeWindow.expiresAt) <= Date.now()) ||
    (receipt && receipt.observedState.toLowerCase() !== "running")
  ) {
    const assertCurrent = params.assertResumeCurrent ?? params.assertCurrent;
    assertCurrent();
    await params.beforeResume?.();
    assertCurrent();
    if (!environment?.leaseId || !params.environments.inspectTurnLease) {
      throw new Error("Retained file transfer is waiting for exact disk recovery");
    }
    await params.environments.inspectTurnLease({
      environmentId: environment.environmentId,
      ownerEpoch: params.placement.activeOwnerEpoch,
      leaseId: environment.leaseId,
      assertCurrent,
    });
    params.assertCurrent();
    assertRetainedWorkspaceDisk(
      params.authority,
      params.environments.get(environment.environmentId),
      params.placement,
    );
  }
}
