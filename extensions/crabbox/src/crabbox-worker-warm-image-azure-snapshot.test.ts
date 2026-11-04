import fs from "node:fs/promises";
import path from "node:path";
import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it, vi } from "vitest";
import * as processRunner from "./crabbox-process.js";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import type { AzureSandboxSnapshotContext } from "./crabbox-worker-azure-snapshot.js";
import { resolveCrabboxProvisionProfile } from "./crabbox-worker-profile.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import { createCrabboxRetainedLeaseOperations } from "./crabbox-worker-retention.js";
import type { CrabboxSnapshotVerifierInput } from "./crabbox-worker-snapshot-verifier.js";
import { openCrabboxWarmImageStore } from "./crabbox-worker-warm-image-store.js";
import { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";
import { jsonResult, tempDirs } from "./crabbox-worker-warm-image.test-support.js";

function fixture(
  loseCreateResponse = false,
  afterDelete = () => {},
  verifierStatus = 0,
  installationProof = false,
  qualifyLegacySnapshotContract = async () => true,
) {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("azure-snapshot-owner-"));
  const runtime = {
    runtimeImage: `registry.example/worker@sha256:${"a".repeat(64)}`,
    buildId: "fixture-build",
    runtimeVersion: "2026.10.4",
    enabledPluginIds: ["codex"],
    nodeBootstrapSha256: "b".repeat(64),
    workerBundleSha256: "c".repeat(64),
    bundleHash: "d".repeat(64),
    ...(installationProof
      ? { installationVerified: true as const }
      : { cacheHitVerified: true as const }),
  };
  const verifier = {
    preEnrollment: {
      schema: "crabbox.pre-enrollment-state.v1",
      credentialEnvironmentAbsent: true,
      credentialAndSessionPathsAbsent: true,
      workerStateLimitedToPreparedCaches: true,
      workspaceEmpty: true,
    },
    checkedCredentialPathsAbsent: true,
    preparedRuntime: runtime,
  };
  const azureSnapshot: AzureSandboxSnapshotContext = {
    scope: {
      region: "eastus",
      subscriptionId: "subscription",
      resourceGroup: "group",
      group: "sandboxes",
    },
    providerScope: "azure-sandbox:eastus:subscription:group:sandboxes",
    sdkPython: "/qualified/python",
    helperPath: "/qualified/snapshot.py",
    providerEnv: { CRABBOX_CONFIG: "/qualified/config", CRABBOX_AZURE_SANDBOX_CLIENT_ID: "" },
  };
  const profile = {
    ...resolveCrabboxProvisionProfile(
      {
        provider: "azure-sandbox",
        class: "standard",
        ttl: "4h",
        idleTimeout: "60m",
        warmImage: true,
        azureSandboxDiskId: "disk-original",
        sdkPython: "/qualified/python",
        configFile: "/qualified/config",
        sdkIdentity: { kind: "azure-cli" },
        snapshotVerifier: ["node", "/qualified/verifier.mjs", "--snapshot-verifier"],
      },
      undefined,
    ).profile,
    azureSandboxScope: azureSnapshot.providerScope,
  };
  let deleted = false;
  const effects: string[] = [];
  const forkReceipts: string[] = [];
  const forkReceiptPaths: string[] = [];
  const run = vi
    .spyOn(processRunner, "runCrabboxProcess")
    .mockImplementation(async (argv, options) => {
      if (argv[0] === "/qualified/python") {
        const request = JSON.parse(String(options.input));
        effects.push(request.action);
        if (request.action === "capture") {
          // Exercise the real store writer before the external POST can happen.
          expect(openWarmImageStore().entries()[0]?.value.operation).toMatchObject({
            type: "capture",
            phase: "creating",
            id: request.operationId,
            azureSnapshotCapture: {
              sourceSandboxId: "sandbox-original",
              sourceDiskId: "disk-original",
            },
          });
          if (loseCreateResponse) {
            return commandResult({ code: null, termination: "timeout", killed: true });
          }
        }
        if (request.action === "delete") {
          deleted = true;
          afterDelete();
        }
        return jsonResult({
          schema: "openclaw.azure-sandbox-checkpoint.v1",
          state:
            request.action === "capture" || request.action === "delete"
              ? "pending"
              : deleted
                ? "missing"
                : "available",
          snapshot: {
            snapshotId: "snapshot-original",
            sourceSandboxId: "sandbox-original",
            operationId: request.operationId,
            capturedAt: "2026-10-21T00:00:00Z",
          },
        });
      }
      if (argv[1] === "run" && String(options.input).includes("CRABBOX_NODE_ENROLLMENT_SCRIPT")) {
        const { nodeBootstrap, workerBundle } = verifierInput.currentRuntime;
        return commandResult({
          stdout:
            "openclaw.runtime-installed:" +
            JSON.stringify({
              schema: "openclaw.runtime-installation.v1",
              installationVerified: true,
              disposition: "existing-verified",
              nodeBootstrap,
              workerBundle: {
                sha256: workerBundle.sha256,
                bytes: workerBundle.bytes,
                packageRelativePath: workerBundle.packageRelativePath,
              },
            }),
        });
      }
      if (argv[1] === "run" && String(options.input).includes("OPENCLAW_SNAPSHOT_VERIFIER")) {
        return jsonResult({
          schema: "openclaw.snapshot-verifier-result.v1",
          child: {
            status: verifierStatus,
            signal: null,
            errorCode: null,
            stdoutBytes: 0,
            stderrBytes: 0,
          },
          ...(verifierStatus === 0 ? { receipt: JSON.stringify(verifier) } : {}),
        });
      }
      if (argv[1] === "warmup" && argv.includes("--azure-sandbox-snapshot-receipt")) {
        const receiptPath = argv[argv.indexOf("--azure-sandbox-snapshot-receipt") + 1]!;
        forkReceiptPaths.push(receiptPath);
        forkReceipts.push(await fs.readFile(receiptPath, "utf8"));
      }
      return commandResult();
    });
  const manager = () =>
    createCrabboxWarmImageManager({
      isLeaseActive: () => false,
      state: crabboxState,
      qualifyLegacySnapshotContract,
      warn: vi.fn(),
      snapshotHelperPath: "/qualified/snapshot.py",
      prepareCapture: async ({ id }) => ({
        id,
        state: "running",
        tailscaleEnabled: false,
        azureSandboxId: "sandbox-original",
      }),
    });
  const source = {
    id: "cbx_builder",
    slug: "builder",
    binary: "crabbox",
    provider: "azure-sandbox",
    profile,
    azureSnapshot,
    providerEnv: azureSnapshot.providerEnv,
    projectKey: "project-one",
    nodeRuntimeIdentity: {
      nodeBootstrapSha256: runtime.nodeBootstrapSha256,
      workerBundleSha256: runtime.workerBundleSha256,
      executionMode: "worker-turn" as const,
    },
    preparation: {
      key: "e".repeat(64),
      cacheKey: "f".repeat(64),
      purpose: "reserve" as const,
      demandAtMs: Date.now(),
    },
    timeoutMs: () => 60_000,
  };
  const verifierInput: CrabboxSnapshotVerifierInput = {
    schema: "openclaw.snapshot-verifier-input.v1",
    preparedProject: {
      namespace: "gateway",
      seedKey: "1".repeat(64),
      cacheKey: "f".repeat(64),
      baseCommit: "1".repeat(40),
      workspaceDir: "/synthetic/workspace",
      homeDir: "/synthetic/home",
      sourceManifestRef: "sha256:" + "2".repeat(64),
      preparedManifestRef: "sha256:" + "3".repeat(64),
    },
    currentRuntime: {
      nodeBootstrap: {
        sha256: runtime.nodeBootstrapSha256,
        bytes: 1,
        buildId: runtime.buildId,
        manifestSha256: "4".repeat(64),
        openclawVersion: runtime.runtimeVersion,
        enabledPluginIds: ["codex"],
      },
      workerBundle: {
        sha256: runtime.workerBundleSha256,
        bytes: 1,
        packageRelativePath: `worker-artifacts/${runtime.workerBundleSha256}.tgz`,
        bundleHash: runtime.bundleHash,
      },
    },
  };
  const prepareSource = async () => ({
    timeoutMs: 1,
    run: async () => {},
    verifySnapshot: async () => verifierInput,
  });
  return {
    manager,
    source,
    effects,
    forkReceipts,
    forkReceiptPaths,
    run,
    prepareSource,
    verifierInput,
  };
}

it("captures through SQLite ownership, forks retained leases through fixed warmup, and preserves the shared template on release", async () => {
  const f = fixture();
  let manager = f.manager();
  await manager.allocate(f.source);
  await manager.markPrepared(f.source.id, "1".repeat(40));
  await manager.capture(f.source, f.prepareSource);
  await manager.release(f.source);
  const image = openWarmImageStore().entries()[0]?.value.image;
  expect(image).toMatchObject({
    checkpointId: "chk_azure_sandbox_snapshot-original",
    state: "available",
  });
  manager = f.manager();
  const retained = {
    ...f.source,
    id: "cbx_private",
    slug: "private",
    retention: {
      policy: { mode: "session-disk" as const, computeWindowSeconds: 14400 },
      owner: { sessionId: "session-one", sessionKey: "agent:main:one", agentId: "main" },
      ownerBinding: "2".repeat(64),
      desiredState: "running" as const,
      receipt: null,
      operation: null,
    },
  };
  await expect(manager.allocate(retained)).resolves.toEqual({
    kind: "checkpoint",
    checkpointId: image!.checkpointId,
  });
  await manager.markPrepared(retained.id, "1".repeat(40));
  await expect(manager.capture({ ...retained, projectCaptureRequired: true })).resolves.toBe(false);
  await manager.markEnrolled(retained.id);
  await fs.rm(path.dirname(f.forkReceiptPaths[0]!), { recursive: true });
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  manager = f.manager();
  await manager.allocate(retained);
  expect(f.forkReceipts).toHaveLength(2);
  expect(f.forkReceipts[1]).toBe(f.forkReceipts[0]);
  expect(JSON.parse(f.forkReceipts[0]!)).toMatchObject({
    schema: "crabbox.azure-sandbox-snapshot.v1",
    snapshotId: "snapshot-original",
    verifierFile: "verifier.json",
    lifecycle: { autoDeletePolicy: { enabled: true, deleteIntervalInSeconds: 14400 } },
  });
  await manager.release(retained);
  expect(f.effects).toEqual(["capture", "inspect"]);
  expect(openWarmImageStore().entries()[0]?.value.image?.checkpointId).toBe(image!.checkpointId);
  await manager.delete({ binaries: ["crabbox"] }, image!.checkpointId);
  expect(f.effects.slice(-2)).toEqual(["delete", "inspect"]);
  expect(openWarmImageStore().entries()).toHaveLength(0);
});

it("keeps a lost capture response fenced across manager replacement and never posts another capture", async () => {
  const f = fixture(true);
  const manager = f.manager();
  await manager.allocate(f.source);
  await manager.markPrepared(f.source.id, "1".repeat(40));
  await expect(manager.capture(f.source, f.prepareSource)).rejects.toThrow(/unresolved/u);
  expect(openWarmImageStore().entries()[0]?.value.operation).toMatchObject({
    type: "capture",
    phase: "uncertain",
  });
  await expect(f.manager().capture(f.source, f.prepareSource)).rejects.toThrow(/unresolved/u);
  expect(f.effects).toEqual(["capture"]);
  expect(openWarmImageStore().entries()[0]?.value.image).toBeUndefined();
});

it("keeps deletion debt when its existing operation budget expires before absence readback", async () => {
  let now = 0;
  const f = fixture(false, () => {
    now = 61_000;
  });
  const manager = f.manager();
  await manager.allocate(f.source);
  await manager.markPrepared(f.source.id, "1".repeat(40));
  await manager.capture(f.source, f.prepareSource);
  await manager.release(f.source);
  vi.spyOn(performance, "now").mockImplementation(() => now);
  await expect(
    manager.delete({ binaries: ["crabbox"] }, "chk_azure_sandbox_snapshot-original"),
  ).resolves.toEqual({ status: "retiring" });
  expect(f.effects).toEqual(["capture", "inspect", "delete"]);
  expect(openWarmImageStore().entries()[0]?.value.retirements?.[0]).toMatchObject({
    type: "retire",
    checkpointId: "chk_azure_sandbox_snapshot-original",
  });
});

it("rejects a failed canonical verifier before snapshot creation, without exposing raw failure buffers", async () => {
  const f = fixture(false, () => {}, 7);
  const manager = f.manager();
  await manager.allocate(f.source);
  await manager.markPrepared(f.source.id, "1".repeat(40));
  await expect(
    manager.capture({ ...f.source, projectCaptureRequired: true }, f.prepareSource),
  ).rejects.toThrow("Clean snapshot verifier failed");
  expect(f.effects).toEqual([]);
  expect(openWarmImageStore().entries()[0]?.value.image).toBeUndefined();
});

it("rejects a stale current runtime descriptor before invoking the verifier or snapshot SDK", async () => {
  const f = fixture();
  const manager = f.manager();
  await manager.allocate(f.source);
  await manager.markPrepared(f.source.id, "1".repeat(40));
  f.verifierInput.currentRuntime.nodeBootstrap.sha256 = "0".repeat(64);
  await expect(
    manager.capture({ ...f.source, projectCaptureRequired: true }, f.prepareSource),
  ).rejects.toThrow("current owner-verified");
  expect(f.effects).toEqual([]);
});

it.each([
  "rejected",
  "timeout",
  "unknown",
  "claim-present",
  "claim-problems",
  "persisted",
  "legacy",
  "changed-owner",
  "wrong-owner",
  "legacy-unqualified",
] as const)("settles only an exact never-admitted snapshot rejection: %s", async (scenario) => {
  const f = fixture(
    false,
    () => {},
    0,
    true,
    async () => scenario !== "legacy-unqualified",
  );
  let manager = f.manager();
  await manager.allocate(f.source);
  await manager.markPrepared(f.source.id, "1".repeat(40));
  await manager.capture(f.source, f.prepareSource);
  await manager.release(f.source);
  const sharedImage = openWarmImageStore().entries()[0]?.value.image;
  const run = f.run.getMockImplementation()!;
  let claimPresent =
    scenario === "claim-present" ||
    scenario === "persisted" ||
    scenario === "legacy" ||
    scenario === "legacy-unqualified" ||
    scenario === "wrong-owner";
  f.run.mockImplementation(async (argv, options) => {
    if (argv[1] === "claims") {
      if (scenario === "changed-owner") {
        await manager.markEnrolled("cbx_rejected");
      }
      return jsonResult({
        version: 1,
        source: "local-claims",
        claims: claimPresent ? [{ leaseId: "cbx_rejected" }] : [{ leaseId: "cbx_working" }],
        problems: scenario === "claim-problems" ? [{ code: "invalid_claim" }] : [],
      });
    }
    const result = await run(argv, options);
    if (argv[1] === "warmup" && argv.includes("--azure-sandbox-snapshot-receipt")) {
      return commandResult(
        scenario === "timeout"
          ? { code: null, termination: "timeout", killed: true }
          : {
              code: 1,
              stderr:
                scenario === "unknown"
                  ? "provider outcome unknown"
                  : "ACA snapshot binding is invalid",
            },
      );
    }
    return result;
  });
  const retained = {
    ...f.source,
    id: "cbx_rejected",
    slug: "rejected",
    retention: {
      policy: { mode: "session-disk" as const, computeWindowSeconds: 14400 },
      owner: { sessionId: "session-one", sessionKey: "agent:main:one", agentId: "main" },
      ownerBinding: "2".repeat(64),
      desiredState: "running" as const,
      receipt: null,
      operation: null,
    },
  };
  let failure: unknown;
  try {
    await manager.allocate(retained);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  if (scenario === "rejected") {
    expect(WorkerProviderError.isCleanupComplete(failure)).toBe(true);
    expect(openWarmImageStore().entries()[0]?.value.allocations[retained.id]).toBeUndefined();
  } else {
    expect(WorkerProviderError.isCleanupComplete(failure)).toBe(false);
    const allocation = openWarmImageStore().entries()[0]?.value.allocations[retained.id];
    expect(allocation?.phase).toBe(scenario === "changed-owner" ? "enrolled" : "pending");
    expect(allocation?.snapshotPreflightOutcome?.outcome).toBe(
      scenario === "timeout" || scenario === "unknown" ? "unknown" : "rejected",
    );
    if (scenario === "legacy" || scenario === "legacy-unqualified") {
      // Reopen a pre-outcome-field row with the original producer receipt unchanged.
      const ownerStore = openCrabboxWarmImageStore(crabboxState);
      const owner = await ownerStore.lookupLease(retained.id);
      if (!owner) {
        throw new Error("Missing legacy allocation fixture");
      }
      await ownerStore.update(owner.key, (record) => {
        const current = record?.allocations[retained.id];
        if (!record || !current) {
          throw new Error("Legacy fixture owner changed");
        }
        const { snapshotPreflightOutcome: _outcome, ...legacy } = current;
        return { ...record, allocations: { ...record.allocations, [retained.id]: legacy } };
      });
    }
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    manager = f.manager();
    if (scenario === "persisted" || scenario === "legacy" || scenario === "legacy-unqualified") {
      claimPresent = false;
    }
    const settled = scenario === "persisted" || scenario === "legacy";
    if (settled) {
      const cleanup = createCrabboxRetainedLeaseOperations(
        async () => ({ binary: "crabbox" }),
        undefined,
        (context) => manager.releaseRejectedSnapshot(context),
      );
      await expect(
        cleanup.destroy({
          leaseId: retained.id,
          profile: {
            provider: "azure-sandbox",
            ttl: "4h",
            idleTimeout: "60m",
            configFile: "/qualified/config",
            sdkIdentity: { kind: "azure-cli" },
          },
          retention: retained.retention,
          signal: new AbortController().signal,
          assertCurrent: () => {},
        }),
      ).resolves.toBeUndefined();
    } else {
      await expect(
        manager.releaseRejectedSnapshot(
          scenario === "wrong-owner"
            ? { ...retained, retention: { ...retained.retention, ownerBinding: "9".repeat(64) } }
            : retained,
        ),
      ).resolves.toBe(false);
    }
    if (settled) {
      expect(openWarmImageStore().entries()[0]?.value.allocations[retained.id]).toBeUndefined();
    } else {
      expect(
        openWarmImageStore().entries()[0]?.value.allocations[retained.id]?.azureSnapshotBinding,
      ).toEqual(allocation?.azureSnapshotBinding);
    }
  }
  if (scenario === "rejected" || scenario === "persisted" || scenario === "legacy") {
    expect(openWarmImageStore().entries()[0]?.value.image).toEqual(sharedImage);
    expect(await fs.readFile(f.forkReceiptPaths.at(-1)!, "utf8")).toBe(f.forkReceipts.at(-1));
  }
  expect(f.effects).toEqual(["capture", "inspect"]);
  expect(f.run.mock.calls.some(([argv]) => argv[1] === "stop")).toBe(false);
});
