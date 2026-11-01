import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi, WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { NODE_WORKER_WORKSPACE_PREPARE_COMMAND } from "../../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { NodeWorkerPreparedWorkspaceRuntime } from "../../node-host/node-worker-prepared-workspace.js";
import { importFreshModule } from "../../plugin-sdk/test-helpers/import-fresh.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { createPluginStateKeyedStoreV2 } from "../../plugin-state/plugin-state-store.js";
import { resolvePluginModuleExport } from "../../plugins/module-export.js";
import type { WorkerNodeEnrollment } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { parseNodeWorkerPreparedWorkspaceInput } from "../../worker/node-workspace-prepared-protocol.js";
import type {
  NodeWorkerSupervisorTransport,
  NodeWorkerSupervisorNodeProof,
} from "../node-registry-private.js";
import { createWorkerNodeEnrollmentManager } from "./node-enrollment.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import { createNodeWorkerPreparedWorkspaceTransport } from "./node-worker-prepared-workspace-transport.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  createProjectPreparationFixture,
  runProjectScriptWithGitProbe,
} from "./project-preparation.test-support.js";
import * as support from "./service.test-support.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";

describe("prepared Sandbox fork native composition", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("reuses a clean retained snapshot across commits without touching an existing private disk", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    for (const [key, value] of Object.entries({
      CRABBOX_AZURE_SANDBOX_REGION: "eastus",
      CRABBOX_AZURE_SANDBOX_SUBSCRIPTION_ID: "subscription",
      CRABBOX_AZURE_SANDBOX_RESOURCE_GROUP: "group",
      CRABBOX_AZURE_SANDBOX_GROUP: "sandboxes",
    })) {
      vi.stubEnv(key, value);
    }
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const directory = path.join(support.testState.root, "project");
    await fs.mkdir(directory);
    const f = await createProjectPreparationFixture(
      directory,
      '#!/bin/sh\nprintf "setup\\n" >> "$HOME/setup-count"\n',
    );
    const scheduler = createTestPluginServiceScheduler();
    const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
    onTestFinished(async () => {
      scheduler.beginClose();
      for (const service of services) {
        await service.stop?.({
          scheduler,
          config: support.testState.config,
          stateDir: support.testState.root,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
        });
      }
      await scheduler.stop();
    });
    let provider: WorkerProvider | undefined;
    const { register } = resolvePluginModuleExport(
      await importFreshModule<unknown>(import.meta.url, "../../../extensions/crabbox/index.ts"),
    );
    if (!register) {
      throw new Error("Missing Crabbox registration");
    }
    register(
      createTestPluginApi({
        id: "crabbox",
        rootDir: fileURLToPath(new URL("../../../extensions/crabbox/", import.meta.url)),
        runtime: createPluginRuntimeMock({
          state: {
            openKeyedStoreV2: (options) =>
              createPluginStateKeyedStoreV2("crabbox", options, { assertCurrent() {} }),
          },
        }),
        registerWorkerProvider: (value) => {
          provider = value;
        },
        registerService: (service) => {
          services.push(service);
        },
      }),
    );
    if (!provider) {
      throw new Error("Missing registered provider");
    }
    const nativeProvider = provider;
    const profile = support.getDevelopmentProfile();
    profile.provider = "crabbox";
    profile.readyWorkers = 0;
    profile.retention = { mode: "session-disk", computeWindowSeconds: 14400 };
    profile.settings = {
      binary: "/mock/crabbox",
      provider: "azure-sandbox",
      class: "standard",
      ttl: "4h",
      idleTimeout: "60m",
      warmImage: true,
      azureSandboxDiskId: "disk-source",
      sdkPython: "/mock/python",
      configFile: "/mock/config",
      sdkIdentity: { kind: "azure-cli" },
      snapshotVerifier: ["node", "/mock/verifier.mjs", "--snapshot-verifier"],
    };
    support.testState.config.gateway = {
      publicOrigin: "https://gateway.example.test",
      auth: { mode: "token", token: "gateway-token" },
    };
    const result = (value?: unknown) => ({
      stdout: value === undefined ? "" : JSON.stringify(value),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    });
    const leases = new Map<
      string,
      { binding?: string; slug: string; home: string; stopped?: boolean }
    >();
    const snapshotHome = path.join(directory, "captured-home");
    let pending: { enrollment: WorkerNodeEnrollment; environmentId: string } | undefined;
    const nodes = new Map<string, NodeWorkerSupervisorNodeProof>();
    const nodeHomes = new Map<string, string>();
    const runtimes = new Map<string, NodeWorkerPreparedWorkspaceRuntime>();
    const builderEntered = createDeferredCore();
    void builderEntered.promise.catch(() => {});
    let forks = 0;
    let captures = 0;
    let uploads = 0;
    const scriptCalls: string[] = [];
    const runCommand = vi
      .spyOn(processRuntime, "runCommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        if (typeof options === "number") {
          throw new Error("Expected bounded command options");
        }
        if (argv[0] === "/mock/python") {
          if (argv.includes("--check-runtime")) {
            return result({
              schema: "openclaw.azure-sandbox-checkpoint.v1",
              state: "available",
              versions: {},
            });
          }
          const request = JSON.parse(String(options?.input));
          if (request.action === "capture") {
            captures++;
            await fs.cp(f.home, snapshotHome, { recursive: true });
          }
          return result({
            schema: "openclaw.azure-sandbox-checkpoint.v1",
            state: request.action === "capture" ? "pending" : "available",
            snapshot: {
              snapshotId: "snapshot-clean",
              sourceSandboxId: "sandbox-source",
              operationId: request.operationId,
              capturedAt: "2026-10-22T00:00:00Z",
            },
          });
        }
        if (argv[1] === "--version") {
          return { ...result(), stdout: "999.0.0" };
        }
        if (argv[1] === "providers") {
          return result([
            { provider: "azure-sandbox", features: ["session-disk-retention-v1", "pause-resume"] },
          ]);
        }
        if (argv[1] === "config") {
          return result({ provider: "azure-sandbox" });
        }
        const id = argv[argv.indexOf(argv[1] === "warmup" ? "--lease-id" : "--id") + 1]!;
        if (argv[1] === "warmup") {
          builderEntered.resolve();
          const isFork = argv.includes("--azure-sandbox-snapshot-receipt");
          const home = leases.size === 0 ? f.home : path.join(directory, `home-${id}`);
          if (isFork) {
            forks++;
            await fs.cp(snapshotHome, home, { recursive: true });
          } else {
            await fs.mkdir(home, { recursive: true });
          }
          leases.set(id, {
            home,
            binding: argv.includes("--azure-sandbox-owner-binding")
              ? argv[argv.indexOf("--azure-sandbox-owner-binding") + 1]
              : undefined,
            slug: argv[argv.indexOf("--slug") + 1]!,
          });
          return result();
        }
        if (argv[1] === "stop") {
          const lease = leases.get(id);
          if (lease) {
            lease.stopped = true;
          }
          return result();
        }
        if (argv[1] === "inspect" || argv[1] === "status") {
          const lease = leases.get(id);
          if (!lease) {
            throw new Error("Unallocated fixture lease");
          }
          return result({
            id,
            provider: "azure-sandbox",
            serverId: "sandbox-source",
            state: lease.stopped ? "missing" : "running",
            ready: !lease.stopped,
            idleTimeout: "60m",
            expiresAt: new Date(Date.now() + 14400_000).toISOString(),
            ...(lease.binding
              ? {
                  retention: {
                    schema: "crabbox.session-disk.v1",
                    mode: "session-disk",
                    ownerBinding: lease.binding,
                    identity: {
                      leaseId: id,
                      attemptLeaseId: id,
                      slug: lease.slug,
                      resourceId: "sandbox-source",
                    },
                    claimRevision: "1",
                    computeWindowSeconds: 14400,
                    desiredState: lease.stopped ? "retired" : "running",
                    computeWindow: {
                      id,
                      authorizedAt: new Date().toISOString(),
                      expiresAt: new Date(Date.now() + 14400_000).toISOString(),
                      state: lease.stopped ? "closed" : "active",
                    },
                    policyVerified: !lease.stopped,
                    observedState: lease.stopped ? "missing" : "Running",
                    stopPending: false,
                  },
                }
              : {}),
          });
        }
        if (argv[1] === "cp") {
          uploads++;
          const destination = argv.at(-1)!;
          await fs.copyFile(argv.at(-2)!, destination.slice(destination.indexOf(":") + 1));
          return result();
        }
        if (argv[1] === "run") {
          const input = String(options?.input ?? "");
          if (input.includes("OPENCLAW_SNAPSHOT_VERIFIER")) {
            return result({
              schema: "openclaw.snapshot-verifier-result.v1",
              child: { status: 0, signal: null, errorCode: null, stdoutBytes: 0, stderrBytes: 0 },
              receipt: JSON.stringify({
                preEnrollment: {
                  schema: "crabbox.pre-enrollment-state.v1",
                  credentialEnvironmentAbsent: true,
                  credentialAndSessionPathsAbsent: true,
                  workerStateLimitedToPreparedCaches: true,
                  workspaceEmpty: true,
                },
                checkedCredentialPathsAbsent: true,
                preparedRuntime: {
                  runtimeImage: `fixture-runtime@sha256:${"d".repeat(64)}`,
                  buildId: "fixture-runtime-build",
                  runtimeVersion: "2026.8.1",
                  enabledPluginIds: ["runtime-plugin"],
                  nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
                  workerBundleSha256: support.BUNDLE_ARTIFACT.tarballSha256,
                  bundleHash: support.BUNDLE_HASH,
                  cacheHitVerified: true,
                },
              }),
            });
          }
          if (input.includes("node <<'PROJECT_")) {
            scriptCalls.push(id);
            // A fork sees the captured disk, never a different session's later
            // private edits. Execute the real project scripts in that lease's HOME.
            return {
              ...result(),
              stdout: await runProjectScriptWithGitProbe(
                input,
                leases.get(id)!.home,
                () => undefined,
              ),
            };
          }
          if (pending?.enrollment.mode === "connect") {
            const deviceId = `node-${pending.environmentId}`;
            nodeHomes.set(deviceId, leases.get(id)!.home);
            await completeWorkerNodeSetupForTest({
              baseDir: support.testState.root,
              store: support.testState.store,
              setupId: pending.enrollment.setupId,
              deviceId,
              completedAtMs: 1000,
            });
            nodes.set(deviceId, {
              nodeId: deviceId,
              connId: deviceId,
              pairingIdentity: deviceId,
              pairingGeneration: "1",
              clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
              clientMode: "node",
              protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
              workerHost: { enabled: true, capacity: { total: 1, available: 1 }, bundlePrewarm: 1 },
              commands: [NODE_WORKER_WORKSPACE_PREPARE_COMMAND],
            });
            pending = undefined;
          }
          // The preinstalled runtime is the external-process fixture boundary;
          // both setup reuse and verify-only capture report its current identity.
          if (input.includes("openclaw.runtime-installed:")) {
            return {
              ...result(),
              stdout:
                "openclaw.runtime-installed:" +
                JSON.stringify({
                  schema: "openclaw.runtime-installation.v1",
                  installationVerified: true,
                  disposition: "existing-verified",
                  nodeBootstrap: {
                    sha256: support.NODE_BOOTSTRAP.sha256,
                    bytes: 1,
                    manifestSha256: "c".repeat(64),
                    buildId: "fixture-runtime-build",
                    openclawVersion: "2026.8.1",
                    enabledPluginIds: ["runtime-plugin"],
                  },
                  workerBundle: {
                    sha256: support.BUNDLE_ARTIFACT.tarballSha256,
                    bytes: 1,
                    packageRelativePath: `worker-artifacts/${support.BUNDLE_ARTIFACT.tarballSha256}.tgz`,
                  },
                }),
            };
          }
          return result();
        }
        return result();
      });
    const manager = createWorkerNodeEnrollmentManager({
      store: support.testState.store,
      getConfig: () => support.testState.config,
      resolveAvailability: async () => ({ available: true }),
      prepareArtifact: async () => ({
        tarballPath: path.join(directory, "runtime.tgz"),
        tarballSha256: support.NODE_BOOTSTRAP.sha256,
        tarballBytes: 1,
        openclawVersion: "2026.8.1",
        buildId: "fixture-runtime-build",
        manifestSha256: "c".repeat(64),
        enabledPluginIds: ["runtime-plugin"],
      }),
      transfer: createWorkerBootstrapArtifactTransferService(),
    });
    onTestFinished(() => manager.stop());
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const transport: NodeWorkerSupervisorTransport = {
      getCurrentNode: async (id) => nodes.get(id),
      listCurrentNodes: async () => [...nodes.values()],
      hasCurrentRunner: () => true,
      isCurrent: (node) => nodes.get(node.nodeId) === node,
      invoke: async (request) => {
        expect(request.command).toBe(NODE_WORKER_WORKSPACE_PREPARE_COMMAND);
        let runtime = runtimes.get(request.node.nodeId);
        if (!runtime) {
          runtime = new NodeWorkerPreparedWorkspaceRuntime(
            nodeHomes.get(request.node.nodeId)!,
            { path: path.join(directory, `${request.node.nodeId.replaceAll(":", "-")}.sqlite`) },
            new Map(),
            true,
          );
          runtimes.set(request.node.nodeId, runtime);
        }
        return {
          ok: true,
          payload: await runtime.prepare(
            parseNodeWorkerPreparedWorkspaceInput(JSON.stringify(request.params)),
            request.signal,
          ),
        };
      },
    };
    const prepared = createNodeWorkerPreparedWorkspaceTransport({
      store: support.testState.store,
      placementStore: placements,
      getNodeTransport: () => transport,
      gatewayNamespace: "gateway",
    });
    const service = support.createService(nativeProvider, {
      projectNamespace: "gateway",
      generateWorkerCredential: () => randomBytes(32).toString("base64url"),
      logger: { warn: (message) => builderEntered.reject(new Error(message)) },
      prepareNodeArtifacts: async () => ({
        artifacts: {
          nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
          enabledPluginIds: ["runtime-plugin"],
          workerBundleHash: support.BUNDLE_HASH,
          workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
          openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
          protocolFeatures: [],
        },
        assertCurrent() {},
      }),
      prepareNodeEnrollment: async (record, signal) => {
        const enrollment = await manager.begin(record, signal);
        pending = { enrollment, environmentId: record.environmentId };
        return enrollment;
      },
      closeNodeEnrollment: manager.close,
      prepareNodeRuntime: manager.prepareRuntime,
      closeNodeRuntime: manager.closeRuntime,
      registerPreparedWorkspace: prepared.registerPreparedWorkspace,
      ensureNodeWorkerBundle: async () => support.BOOTSTRAP_RECEIPT,
    });
    onTestFinished(async () => {
      await service.stop();
      runCommand.mockRestore();
    });
    await service.ready();
    const builder = await service.prepare({ profileId: "development", projectPath: f.repository });
    await service.reconcileEnvironment(builder.environmentId);
    expect(support.testState.store.get(builder.environmentId)).toMatchObject({
      state: "ready",
      lastError: null,
    });
    await builderEntered.promise;
    expect(captures).toBe(1);
    const beforeUploads = uploads;
    const beforeScripts = scriptCalls.length;
    const owner = {
      sessionId: "fork-session",
      sessionKey: "agent:main:fork-session",
      agentId: "main",
    };
    const admittedIntent = await service.prepareProjectIntent("development", {
      projectPath: f.repository,
      executionMode: "worker-turn",
      runSetupScript: true,
      setupAuthorized: true,
    });
    const fork = await service.createWithRequest({
      profileId: "development",
      idempotencyKey: "private-fork",
      admittedIntent,
      executionMode: "worker-turn",
      projectPath: f.repository,
      retentionOwner: owner,
    });
    expect(fork.state).toBe("ready");
    expect(forks).toBe(1);
    expect(captures).toBe(1);
    expect(uploads).toBe(beforeUploads);
    expect(scriptCalls.length - beforeScripts).toBe(1);
    const runtime = runtimes.get(fork.nodeDeviceId!)!;
    const row = await runtime.store!.find(fork.environmentId);
    expect(row).toMatchObject({
      environment_id: fork.environmentId,
      state: "available",
      gateway_namespace: "gateway",
    });
    expect(await fs.readFile(path.join(row!.home_dir, "setup-count"), "utf8")).toBe("setup\n");
    expect(await fs.readFile(path.join(row!.workspace_dir, "input.txt"), "utf8")).toBe(
      "prepared base\n",
    );
    const attachment = await service.attachSession({
      environmentId: fork.environmentId,
      sessionId: owner.sessionId,
      ownerEpoch: fork.ownerEpoch,
    });
    let placement = await placements.startDispatch({ ...owner, executionMode: "worker-turn" });
    placement = await placements.transition({
      sessionId: owner.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: fork.environmentId },
    });
    await placements.transition({
      sessionId: owner.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: support.BUNDLE_HASH },
    });
    const binding = {
      sessionId: owner.sessionId,
      sessionKey: owner.sessionKey,
      environmentId: fork.environmentId,
      ownerEpoch: attachment.ownerEpoch,
      preparationKey: row!.preparation_key,
      cacheKey: row!.cache_key,
      assertCurrent() {},
    };
    await prepared.bindPreparedWorkspace(binding);
    expect(await runtime.store!.find(fork.environmentId)).toMatchObject({
      state: "bound",
      session_id: owner.sessionId,
      session_key: owner.sessionKey,
      owner_epoch: attachment.ownerEpoch,
    });
    await fs.writeFile(path.join(row!.workspace_dir, "input.txt"), "private edits\n");
    await fs.writeFile(path.join(row!.home_dir, "private-temp"), "private temporary state\n");
    const beforeReplay = { captures, uploads, scripts: scriptCalls.length, forks };
    const replay = await service.createWithRequest({
      profileId: "development",
      idempotencyKey: "private-fork",
      admittedIntent,
      executionMode: "worker-turn",
      projectPath: f.repository,
      retentionOwner: owner,
    });
    expect(replay).toMatchObject({ environmentId: fork.environmentId, state: "attached" });
    await prepared.bindPreparedWorkspace(binding);
    await expect(
      prepared.bindPreparedWorkspace({ ...binding, sessionKey: "agent:main:foreign" }),
    ).rejects.toThrow("Prepared workspace lost its exact attached placement owner");
    expect({ captures, uploads, scripts: scriptCalls.length, forks }).toEqual(beforeReplay);
    expect(await fs.readFile(path.join(row!.workspace_dir, "input.txt"), "utf8")).toBe(
      "private edits\n",
    );
    expect(await fs.readFile(path.join(row!.home_dir, "private-temp"), "utf8")).toBe(
      "private temporary state\n",
    );
    // Only the new clean fork advances to the requested revision. The bound
    // session keeps its exact disk, private checkout, HOME, and owner epoch.
    await fs.writeFile(path.join(f.repository, "input.txt"), "new requested revision\n");
    await requireGit(f.repository, ["commit", "--quiet", "-am", "new revision"]);
    const changedCommit = await requireGit(f.repository, ["rev-parse", "HEAD"]);
    const changedOwner = {
      sessionId: "changed-revision-session",
      sessionKey: "agent:main:changed-revision-session",
      agentId: "main",
    };
    const changedIntent = await service.prepareProjectIntent("development", {
      projectPath: f.repository,
      executionMode: "worker-turn",
      runSetupScript: true,
      setupAuthorized: true,
    });
    const changed = await service.createWithRequest({
      profileId: "development",
      idempotencyKey: "changed-revision-private",
      admittedIntent: changedIntent,
      executionMode: "worker-turn",
      projectPath: f.repository,
      retentionOwner: changedOwner,
    });
    expect(changed.state).toBe("ready");
    expect(forks).toBe(beforeReplay.forks + 1);
    expect(captures).toBe(beforeReplay.captures);
    expect(uploads).toBe(beforeReplay.uploads + 1);
    const changedRow = await runtimes
      .get(changed.nodeDeviceId!)!
      .store!.find(changed.environmentId);
    expect(changedRow).toMatchObject({ environment_id: changed.environmentId, state: "available" });
    expect(await requireGit(changedRow!.workspace_dir, ["rev-parse", "HEAD"])).toBe(changedCommit);
    expect(await fs.readFile(path.join(changedRow!.workspace_dir, "input.txt"), "utf8")).toBe(
      "new requested revision\n",
    );
    expect(await fs.readFile(path.join(changedRow!.home_dir, "setup-count"), "utf8")).toBe(
      "setup\nsetup\n",
    );
    expect(
      await fs.stat(path.join(changedRow!.home_dir, "private-temp")).catch(() => undefined),
    ).toBeUndefined();
    expect(await runtime.store!.find(fork.environmentId)).toMatchObject({
      state: "bound",
      session_id: owner.sessionId,
    });
    expect(await fs.readFile(path.join(row!.workspace_dir, "input.txt"), "utf8")).toBe(
      "private edits\n",
    );
    expect(await fs.readFile(path.join(row!.home_dir, "private-temp"), "utf8")).toBe(
      "private temporary state\n",
    );
    const coldDirectory = path.join(support.testState.root, "cold-project");
    await fs.mkdir(coldDirectory);
    const coldProject = await createProjectPreparationFixture(coldDirectory);
    const coldOwner = {
      sessionId: "cold-private-session",
      sessionKey: "agent:main:cold-private-session",
      agentId: "main",
    };
    const coldIntent = await service.prepareProjectIntent("development", {
      projectPath: coldProject.repository,
      executionMode: "worker-turn",
      runSetupScript: true,
      setupAuthorized: true,
    });
    const cold = await service.createWithRequest({
      profileId: "development",
      idempotencyKey: "cold-private",
      admittedIntent: coldIntent,
      executionMode: "worker-turn",
      projectPath: coldProject.repository,
      retentionOwner: coldOwner,
    });
    expect(cold.state).toBe("ready");
    expect(forks).toBe(beforeReplay.forks + 1);
    expect(captures).toBe(beforeReplay.captures);
    expect(uploads).toBe(beforeReplay.uploads + 2);
    const coldRow = await runtimes.get(cold.nodeDeviceId!)!.store!.find(cold.environmentId);
    expect(coldRow).toMatchObject({ environment_id: cold.environmentId, state: "available" });
    expect(await fs.readFile(path.join(coldRow!.workspace_dir, "input.txt"), "utf8")).toBe(
      "prepared base\n",
    );
    expect(await fs.readFile(path.join(row!.workspace_dir, "input.txt"), "utf8")).toBe(
      "private edits\n",
    );
  });
});
