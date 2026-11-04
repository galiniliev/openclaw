import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWorkerProviderIntent } from "./provider-intent.js";
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
