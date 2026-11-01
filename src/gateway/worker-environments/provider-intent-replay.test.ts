import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { RetainedWorkspaceAuthority } from "../../state/retained-workspace-authority.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { readWorkerPreparation } from "./preparation-identity.schema.js";
import { createWorkerProviderIntent } from "./provider-intent.js";
import { createProviderIntentFixture } from "./provider-intent.test-support.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import { requireWorkerProfile } from "./service-validation.js";
import * as support from "./service.test-support.js";
import type { WorkerEnvironmentRecord } from "./store.js";

describe("saved worker allocation replay", () => {
  support.setupWorkerEnvironmentServiceSuite();
  function fixture() {
    const provider = support.createProvider({
      requiresNodeEnrollment: true,
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: () => ({ machineClass: "small", platform: "linux", arch: "x64" }),
    });
    const resumeProvision = vi.fn(async (record: WorkerEnvironmentRecord) => record);
    const createOwner = () =>
      createWorkerProviderIntent({
        store: support.testState.store,
        getConfig: () => support.testState.config,
        projectNamespace: "saved-allocation-test",
        providerFor: () => provider,
        prepareNodeArtifacts: async () => ({
          artifacts: {
            nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
            workerBundleHash: support.BUNDLE_ARTIFACT.bundleHash,
            workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
            enabledPluginIds: [],
            openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
            protocolFeatures: [],
          },
          assertCurrent: () => {},
        }),
        resumeProvision,
        isStopping: () => false,
        withLock: async (_id, task) => task(),
      });
    return {
      owner: createOwner(),
      createOwner,
      projectPath: path.join(support.testState.root, "another-source"),
    };
  }
  it.each([
    "original",
    "ordinary",
    "wrong-resource",
    "wrong-actor",
    "wrong-provider",
    "changed-selector",
    "unowned-intent",
  ] as const)(
    "retains an original empty allocation across current project preparation (%s)",
    async (selection) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const f = await createProviderIntentFixture();
      const policy = { mode: "session-disk" as const, computeWindowSeconds: 3600 };
      support.getDevelopmentProfile().retention = policy;
      f.provider.supportsRetainedProjectImages = () => true;
      const owner = {
        agentId: "main",
        sessionKey: "agent:main:retained",
        sessionId: "original-session",
      };
      const disk: RetainedWorkspaceAuthority = {
        environmentId: deriveEnvironmentIntent("original-key").environmentId,
        sessionId: owner.sessionId,
        ownerEpoch: 713,
        ownerBinding: "original-binding",
        identity: {
          leaseId: "original-lease",
          attemptLeaseId: "original-attempt",
          slug: "original-worker",
          resourceId: "original-resource",
        },
        workspaceDir: "/original/private-workspace",
      };
      const empty = await f.owner.prepareIntent("development", {
        emptyWorkspace: true,
        executionMode: "worker-turn",
      });
      const preparation = readWorkerPreparation(empty.profileSnapshot)!;
      const historical = requireWorkerProfile({
        ...empty.profileSnapshot,
        runSetupScript: false,
        runtimePreparation: {
          ...preparation,
          artifacts: {
            ...preparation.artifacts,
            nodeBootstrapSha256: "1".repeat(64),
            workerArchiveSha256: "2".repeat(64),
            workerBundleHash: "3".repeat(64),
          },
        },
      });
      const original = await support.testState.store.createIntent({
        environmentId: disk.environmentId,
        providerId: "fake",
        profileId: "development",
        profileSnapshot: historical,
        provisionOperationId: "original-operation",
        retention: {
          owner,
          ownerBinding: disk.ownerBinding,
          policy,
          desiredState: "running",
          receipt: null,
          operation: null,
        },
      });
      const workspaces = getSessionRepositoryWorkspaceStore();
      const workspace = await workspaces.create({
        ...owner,
        url: "https://example.test/original.git",
        assertCurrent() {},
      });
      const source = await workspaces.bindBase({
        workspaceId: workspace.workspaceId,
        expectedRevision: workspace.revision,
        baseCommit: "a".repeat(40),
        diskAuthority: disk,
        assertCurrent() {},
      });
      const current = await f.prepare({ executionMode: "worker-turn" });
      expect(historical).not.toHaveProperty("project");
      expect(historical).not.toHaveProperty("machineClass");
      expect(historical).not.toHaveProperty("os");
      expect(current.profileSnapshot).toHaveProperty("project");
      const selectedDisk =
        selection === "wrong-resource"
          ? { ...disk, identity: { ...disk.identity, resourceId: "another-resource" } }
          : disk;
      const result = f.owner.createWithProfile(
        "development",
        selection === "ordinary" ? "original-key" : "new-dispatch-generation",
        {
          executionMode: "worker-turn",
          ...(selection === "ordinary" ? {} : { retainedWorkspaceAuthority: selectedDisk }),
          retentionOwner:
            selection === "wrong-actor" ? { ...owner, sessionId: "another-session" } : owner,
          ...(selection === "wrong-provider"
            ? { inherited: { providerId: "another-provider", profileSnapshot: historical } }
            : {}),
          ...(selection === "changed-selector" ? { machineClass: "large" } : {}),
        },
        selection === "unowned-intent" ? { ...current } : current,
      );
      if (selection === "original") {
        await expect(result).resolves.toEqual(original);
        expect(f.resumeProvision).toHaveBeenCalledWith(
          original,
          undefined,
          undefined,
          undefined,
          expect.any(Function),
          undefined,
          disk,
        );
      } else {
        await expect(result).rejects.toThrow(
          selection === "ordinary"
            ? "another project preparation"
            : selection === "wrong-provider" || selection === "changed-selector"
              ? "another profile"
              : selection === "unowned-intent"
                ? "not owned by this lifecycle"
                : "replacement is refused",
        );
        expect(f.resumeProvision).not.toHaveBeenCalled();
      }
      expect(support.testState.store.list()).toHaveLength(1);
      expect(support.testState.store.get(original.environmentId)).toEqual(original);
      expect(await workspaces.get(source.workspaceId)).toEqual(source);
    },
  );
  it.each(["replaced", "removed"] as const)(
    "replays the saved allocation after restart when the stable profile is %s",
    async (change) => {
      const f = fixture();
      support.getDevelopmentProfile().settings = {
        region: "original",
        azureSandboxDiskId: "disk-original",
      };
      const admitted = await f.owner.prepareIntent("development", { imageReserve: true });
      const created = await f.owner.createWithProfile(
        "development",
        "saved-runtime-allocation",
        { imageReserve: true },
        admitted,
      );
      const originalSnapshot = structuredClone(created.profileSnapshot);
      await support.testState.store.transition({
        environmentId: created.environmentId,
        from: "requested",
        to: "provisioning",
      });
      if (change === "removed") {
        delete support.testState.config.cloudWorkers!.profiles!.development;
      } else {
        support.getDevelopmentProfile().settings = {
          region: "latest",
          azureSandboxDiskId: "disk-latest",
        };
      }
      await support.reopenWorkerEnvironmentStore();
      const restarted = f.createOwner();
      await expect(
        restarted.createWithProfile("development", "saved-runtime-allocation", {
          imageReserve: true,
        }),
      ).resolves.toMatchObject({
        environmentId: created.environmentId,
        provisionOperationId: created.provisionOperationId,
        profileSnapshot: originalSnapshot,
      });
      expect(support.testState.store.list()).toHaveLength(1);
      for (const changedSource of [
        { emptyWorkspace: true as const },
        { projectPath: f.projectPath },
      ]) {
        await expect(
          restarted.createWithProfile("development", "saved-runtime-allocation", changedSource),
        ).rejects.toThrow("Idempotency key belongs to another project preparation");
      }
      if (change === "removed") {
        await expect(
          restarted.createWithProfile("development", "fresh-stale-snapshot", {
            inherited: { providerId: created.providerId, profileSnapshot: originalSnapshot },
          }),
        ).rejects.toThrow("Unknown worker profile");
        expect(support.testState.store.list()).toHaveLength(1);
      } else {
        const latest = await restarted.createWithProfile("development", "fresh-latest", {
          imageReserve: true,
        });
        expect(latest.profileSnapshot.settings).toEqual({
          region: "latest",
          azureSandboxDiskId: "disk-latest",
        });
        expect(support.testState.store.get(created.environmentId)?.profileSnapshot).toEqual(
          originalSnapshot,
        );
        await expect(
          restarted.createWithProfile("development", "saved-runtime-allocation", {
            repository: { agentId: "main", url: "https://github.com/other/repo" },
            imageReserve: true,
          }),
        ).rejects.toThrow();
      }
    },
  );
});
