import { beforeEach, expect, it, vi } from "vitest";
import type { WorkerProvider } from "../../plugins/types.js";
import type { WorkerRetainedLeaseReceipt } from "../../plugins/worker-retention.types.js";
import type { RetainedWorkspaceAuthority } from "../../state/retained-workspace-authority.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import { createWorkerRetainedLeaseLifecycle } from "./retained-lease-lifecycle.js";
import type { WorkerEnvironmentStore } from "./store.js";

const source = vi.hoisted(() => ({
  workspace: undefined as { workspaceId: string; diskAuthority: unknown } | undefined,
}));
vi.mock("../../state/session-repository-workspaces.js", () => ({
  getSessionRepositoryWorkspaceStore: () => ({
    find: async () => source.workspace,
    prepare: async () => ({
      assertSourceCurrent() {},
      current: () => source.workspace,
    }),
  }),
}));

const owner = { agentId: "main", sessionKey: "agent:main:original", sessionId: "original-session" };
const disk: RetainedWorkspaceAuthority = {
  environmentId: "original-environment",
  sessionId: owner.sessionId,
  ownerEpoch: 713,
  ownerBinding: "a".repeat(64),
  identity: {
    leaseId: "cbx_0123456789ab",
    attemptLeaseId: "cbx_0123456789ab",
    slug: "original",
    resourceId: "original-private-disk",
  },
  workspaceDir: "/original/workspace",
};

function fixture(wrongIdentity = false) {
  let record: WorkerEnvironmentRecord = {
    environmentId: disk.environmentId,
    providerId: "crabbox",
    profileId: "original-profile",
    profileSnapshot: { settings: { provider: "azure-sandbox" } },
    provisionOperationId: "original-provision-operation",
    state: "requested",
    leaseId: null,
    sshEndpoint: null,
    ownerEpoch: 714,
    nodeSetupId: null,
    nodeDeviceId: null,
    sharedHost: false,
    desktop: null,
    bootstrapReceipt: null,
    preparation: null,
    teardownTerminalState: null,
    attachedSessionIds: [],
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    lastActivatedAtMs: null,
    idleSinceAtMs: null,
    destroyRequestedAtMs: null,
    retention: {
      owner,
      ownerBinding: disk.ownerBinding,
      policy: { mode: "session-disk", computeWindowSeconds: 3600 },
      desiredState: "running",
      receipt: null,
      operation: null,
    },
  };
  let receipt: WorkerRetainedLeaseReceipt = {
    schema: "crabbox.session-disk.v1",
    mode: "session-disk",
    identity: {
      ...disk.identity,
      ...(wrongIdentity ? { resourceId: "another-private-disk" } : {}),
    },
    ownerBinding: disk.ownerBinding,
    claimRevision: "original-expired-revision",
    computeWindowSeconds: 3600,
    desiredState: "running",
    observedState: "Stopped",
    policyVerified: true,
    stopPending: false,
    computeWindow: {
      id: "expired-window",
      authorizedAt: new Date(0).toISOString(),
      expiresAt: new Date(1000).toISOString(),
      state: "active",
    },
  };
  const store: Pick<WorkerEnvironmentStore, "get" | "recordRetention"> = {
    get: () => record,
    recordRetention: vi.fn(async (input) => {
      input.assertCurrent?.();
      expect(input.expectedOwnerEpoch).toBe(714);
      expect(input.expectedRetention).toEqual(record.retention);
      record = { ...record, retention: input.retention };
      return record;
    }),
  };
  const retainedLease: NonNullable<WorkerProvider["retainedLease"]> = {
    inspect: vi.fn(async (request) => {
      request.assertCurrent();
      expect(request.leaseId).toBe(disk.identity.leaseId);
      expect(record.leaseId).toBeNull();
      return receipt;
    }),
    pause: vi.fn(async (request) => {
      request.assertCurrent();
      receipt = {
        ...receipt,
        claimRevision: "paused-revision",
        desiredState: "suspended",
        observedState: "Stopped",
        computeWindow: { ...receipt.computeWindow, state: "closed" },
        operation: {
          id: request.operationId,
          action: "pause",
          phase: "observed",
          expectedClaimRevision: request.retention.operation!.expectedClaimRevision,
        },
      };
      return receipt;
    }),
    resume: vi.fn(async (request) => {
      request.assertCurrent();
      receipt = {
        ...receipt,
        claimRevision: "fresh-revision",
        desiredState: "running",
        observedState: "Running",
        computeWindow: {
          id: request.operationId,
          authorizedAt: new Date(2000).toISOString(),
          expiresAt: new Date(3602000).toISOString(),
          state: "active",
        },
        operation: {
          id: request.operationId,
          action: "resume",
          phase: "observed",
          expectedClaimRevision: request.retention.operation!.expectedClaimRevision,
        },
      };
      return receipt;
    }),
    destroy: vi.fn(async () => {}),
  };
  const provider: WorkerProvider = {
    id: "crabbox",
    resolveAllocation: vi.fn(),
    provision: vi.fn(),
    inspect: vi.fn(),
    destroy: vi.fn(),
    retainedLease,
  };
  const lifecycle = createWorkerRetainedLeaseLifecycle({
    store,
    providerFor: () => provider,
    signal: new AbortController().signal,
    now: () => 2000,
  });
  return { lifecycle, retainedLease, provider, record: () => record };
}

beforeEach(() => {
  source.workspace = { workspaceId: "original-workspace", diskAuthority: disk };
});

it("resumes only the original expired disk before new node provisioning while Native remains unleased", async () => {
  const f = fixture();
  const result = await f.lifecycle.resumeForProvision(
    f.record(),
    disk,
    new AbortController().signal,
    () => {},
  );
  expect(result).toMatchObject({
    state: "requested",
    leaseId: null,
    ownerEpoch: 714,
    provisionOperationId: "original-provision-operation",
    retention: {
      operation: null,
      receipt: {
        identity: disk.identity,
        observedState: "Running",
        claimRevision: "fresh-revision",
      },
    },
  });
  expect(f.retainedLease.pause).toHaveBeenCalledOnce();
  expect(f.retainedLease.resume).toHaveBeenCalledOnce();
  expect(f.retainedLease.destroy).not.toHaveBeenCalled();
  expect(f.provider.provision).not.toHaveBeenCalled();
});

it("refuses a different provider resource before granting any compute or replacing the disk", async () => {
  const f = fixture(true);
  await expect(
    f.lifecycle.resumeForProvision(f.record(), disk, new AbortController().signal, () => {}),
  ).rejects.toThrow("mismatched");
  expect(f.retainedLease.pause).not.toHaveBeenCalled();
  expect(f.retainedLease.resume).not.toHaveBeenCalled();
  expect(f.retainedLease.destroy).not.toHaveBeenCalled();
  expect(f.record().retention?.receipt).toBeNull();
});
