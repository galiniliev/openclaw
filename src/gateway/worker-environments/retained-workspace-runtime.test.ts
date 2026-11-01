import { expect, it, vi } from "vitest";
import type { WorkerSessionDiskRetention } from "../../plugins/worker-retention.types.js";
import { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import * as support from "./service.test-support.js";

support.setupWorkerEnvironmentServiceSuite();

it.each([false, true])(
  "keeps new image pins and prepares current runtime only for an admitted original disk (admitted=%s)",
  async (admitted) => {
    const identity = {
      leaseId: "cbx_0123456789ab",
      attemptLeaseId: "cbx_0123456789ab",
      slug: "original",
      resourceId: "original-private-disk",
    };
    const retention: WorkerSessionDiskRetention = {
      policy: { mode: "session-disk", computeWindowSeconds: 3600 },
      owner: { agentId: "main", sessionKey: "agent:main:original", sessionId: "original-session" },
      ownerBinding: "a".repeat(64),
      desiredState: "running",
      operation: null,
      receipt: admitted
        ? {
            schema: "crabbox.session-disk.v1",
            mode: "session-disk",
            identity,
            ownerBinding: "a".repeat(64),
            claimRevision: "verified-current-claim",
            computeWindowSeconds: 3600,
            desiredState: "running",
            observedState: "Running",
            policyVerified: true,
            stopPending: false,
            computeWindow: {
              id: "current-window",
              authorizedAt: new Date(1000).toISOString(),
              expiresAt: new Date(3601000).toISOString(),
              state: "active",
            },
          }
        : null,
    };
    const historical = {
      source: "empty",
      key: "c".repeat(64),
      cacheKey: "d".repeat(64),
      contractVersion: 2,
      target: { machineClass: "small", platform: "linux" },
      artifacts: {
        nodeBootstrapSha256: "e".repeat(64),
        workerArchiveSha256: "f".repeat(64),
        workerBundleHash: "a".repeat(64),
        enabledPluginIds: [],
        openclawVersion: "historical",
        protocolFeatures: [],
      },
    };
    const store = support.testState.store;
    const record = await store.createIntent({
      environmentId: "runtime-owner",
      providerId: "fake",
      profileId: "development",
      provisionOperationId: "original-operation",
      profileSnapshot: {
        settings: {},
        executionMode: "worker-turn",
        runtimePreparation: historical,
      },
      retention,
    });
    const current = createWorkerNodeProvisioning({
      store,
      now: () => 1000,
      isStopping: () => false,
      ownerSignal: new AbortController().signal,
      prepareNodeBootstrap: async () => support.NODE_BOOTSTRAP.sha256,
      prepareInstallation: async () => support.BUNDLE_ARTIFACT,
      move: (owner, to, patch, assertCurrent) =>
        store.transition({
          environmentId: owner.environmentId,
          from: owner.state,
          to,
          patch,
          assertCurrent,
        }),
      saveError: (owner, error) =>
        store.recordError({
          environmentId: owner.environmentId,
          state: owner.state,
          error: String(error),
        }),
      failBootstrap: vi.fn(async () => {
        throw new Error("Unexpected bootstrap effect");
      }),
      acceptInitial: async (owner) => owner,
      commitReady: vi.fn(async () => record),
    });
    const result = current.prepare(
      record,
      support.createProvider({ requiresNodeEnrollment: true }),
    );
    if (admitted) {
      await expect(result).resolves.toMatchObject({
        identity: {
          nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
          workerBundleSha256: support.BUNDLE_ARTIFACT.tarballSha256,
        },
        installation: support.BUNDLE_ARTIFACT,
      });
      expect(store.get(record.environmentId)?.profileSnapshot.runtimePreparation).toEqual(
        historical,
      );
      expect(store.get(record.environmentId)?.bootstrapReceipt).toBeNull();
    } else {
      await expect(result).rejects.toThrow("runtime artifacts changed after admission");
    }
  },
);
