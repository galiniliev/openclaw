import { describe, expect, it, vi } from "vitest";
import type { WorkerProvider } from "../../plugins/types.js";
import type { WorkerSessionDiskRetention } from "../../plugins/worker-retention.types.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  bindSessionRepositoryWorkspaceBaseInDatabase,
  createSessionRepositoryWorkspaceInDatabase,
} from "../../state/session-repository-workspaces.kernel.js";
import * as support from "./service.test-support.js";

const owner = { agentId: "main", sessionKey: "agent:main:original", sessionId: "original-session" };
const environmentId = "original-environment";
const binding = "a".repeat(64);
const identity = {
  leaseId: "cbx_0123456789ab",
  attemptLeaseId: "cbx_0123456789ab",
  slug: "original",
  resourceId: "original-private-disk",
};

async function fixture() {
  const retainedLease: NonNullable<WorkerProvider["retainedLease"]> = {
    inspect: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    destroy: vi.fn(async () => {}),
  };
  const provider = support.createProvider({ retainedLease, destroy: vi.fn(async () => {}) });
  const service = support.createService(provider);
  const retention: WorkerSessionDiskRetention = {
    owner,
    ownerBinding: binding,
    desiredState: "running",
    policy: { mode: "session-disk", computeWindowSeconds: 60 },
    receipt: null,
    operation: null,
  };
  const store = support.testState.store;
  await store.createIntent({
    environmentId,
    providerId: provider.id,
    profileId: "development",
    profileSnapshot: { settings: {} },
    provisionOperationId: "original-operation",
    retention,
  });
  await store.transition({ environmentId, from: "requested", to: "provisioning" });
  await store.transition({
    environmentId,
    from: "provisioning",
    to: "bootstrapping",
    patch: { leaseId: identity.leaseId, sshEndpoint: support.SSH_ENDPOINT, sharedHost: false },
  });
  const environment = await store.transition({
    environmentId,
    from: "bootstrapping",
    to: "ready",
    patch: {
      ...support.readyPatch(environmentId),
      leaseId: identity.leaseId,
      sshEndpoint: support.SSH_ENDPOINT,
      sharedHost: false,
    },
  });
  const restoreDiskAuthority = () =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const created = createSessionRepositoryWorkspaceInDatabase(
          db,
          { ...owner, url: "https://github.com/example/original.git" },
          1000,
        ).workspace!;
        return bindSessionRepositoryWorkspaceBaseInDatabase(
          db,
          {
            workspaceId: created.workspaceId,
            expectedRevision: created.revision,
            baseCommit: "b".repeat(40),
            baseManifestHash: `sha256:${"c".repeat(64)}`,
            diskAuthority: {
              environmentId,
              sessionId: owner.sessionId,
              ownerEpoch: environment.ownerEpoch,
              ownerBinding: binding,
              identity,
              workspaceDir: "/original/private/workspace",
            },
          },
          1000,
        ).workspace!;
      },
      { database: support.testState.stateDb },
    );
  return { service, store, environment, provider, retainedLease, restoreDiskAuthority };
}

describe("original retained workspace cleanup", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("refuses failed-setup cleanup before recording destruction of an original disk", async () => {
    const f = await fixture();
    const workspace = f.restoreDiskAuthority();
    await expect(f.service.destroy(environmentId)).rejects.toThrow(
      "Original retained workspace disk is preserved",
    );
    expect(f.store.get(environmentId)).toEqual(f.environment);
    expect(workspace.diskAuthority).toMatchObject({ environmentId, identity });
    expect(f.retainedLease.destroy).not.toHaveBeenCalled();
    expect(f.provider.destroy).not.toHaveBeenCalled();
  });

  it("blocks provider deletion when an original binding is restored after old cleanup intent", async () => {
    const f = await fixture();
    await f.store.requestDestroy({ environmentId, state: "ready" });
    await f.store.transition({ environmentId, from: "ready", to: "draining" });
    await f.store.transition({ environmentId, from: "draining", to: "destroying" });
    f.restoreDiskAuthority();
    await f.service.reconcileEnvironment(environmentId);
    expect(f.retainedLease.destroy).not.toHaveBeenCalled();
    expect(f.provider.destroy).not.toHaveBeenCalled();
    expect(f.store.get(environmentId)).toMatchObject({
      leaseId: identity.leaseId,
      destroyRequestedAtMs: 1000,
    });
    expect(f.store.get(environmentId)?.lastError).toContain(
      "Original retained workspace disk is preserved",
    );
  });

  it("still cleans a new unadmitted allocation without original disk authority", async () => {
    const f = await fixture();
    await f.service.destroy(environmentId);
    expect(f.retainedLease.destroy).toHaveBeenCalledOnce();
    expect(f.store.get(environmentId)?.state).toBe("destroyed");
  });

  it("admits explicit retirement only with the exact original retained owner binding", async () => {
    const f = await fixture();
    const attached = await f.store.transition({
      environmentId,
      from: "ready",
      to: "attached",
      patch: support.attachedPatch(environmentId, owner.sessionId),
    });
    f.restoreDiskAuthority();
    await expect(
      f.service.destroy(environmentId, {
        sessionId: owner.sessionId,
        ownerEpoch: attached.ownerEpoch,
        retainedOwnerBinding: "wrong",
      }),
    ).rejects.toThrow("Retained worker owner changed");
    await f.service.destroy(environmentId, {
      sessionId: owner.sessionId,
      ownerEpoch: attached.ownerEpoch,
      retainedOwnerBinding: binding,
    });
    // The existing discard disposition owns the later background retry.
    await f.service.destroy(environmentId);
    expect(f.retainedLease.destroy).toHaveBeenCalledOnce();
    expect(f.store.get(environmentId)?.state).toBe("destroyed");
  });
});
