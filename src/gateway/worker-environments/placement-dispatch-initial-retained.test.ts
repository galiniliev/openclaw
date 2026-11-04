import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
} from "../../infra/node-commands.js";
import { projectNodeWorkerSupervisorReceipt } from "../../node-host/node-worker-supervisor-contract.js";
import { waitForNodeWorkerTerminal } from "../../node-host/node-worker-supervisor.fixture.test-support.js";
import { createNodeWorkerSupervisor } from "../../node-host/node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testWorkerLaunchInput,
} from "../../node-host/node-worker-supervisor.test-support.js";
import type { WorkerProvider } from "../../plugins/types.js";
import type { WorkerSessionDiskRetention } from "../../plugins/worker-retention.types.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { VERSION } from "../../version.js";
import {
  parseNodeWorkerEnvironmentStopInput,
  parseNodeWorkerLaunchInput,
} from "../../worker/node-supervisor-protocol.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import { createWorkerRuntimeRefreshWaiter } from "../server-worker-placement-runtime-refresh.js";
import { createWorkerPlacementNodeWorkspaceBindingResolver } from "../server-worker-placement-session-target.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { createNodeWorkerLaunchAdapter } from "./node-launch-adapter.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";
import { nodeWorkerGatewayNamespace } from "./node-worker-gateway-namespace.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import { transport, workspaceTransfer } from "./node-worker-tunnel.test-support.js";
import { REQUEST, seedSyncingPlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { writePlacementEnvironmentFixture } from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import {
  createPreparedRepositoryNodeFixture,
  createRepositoryPolicySource,
} from "./repository-policy-node.test-support.js";
import * as support from "./service.test-support.js";
import { withSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";

support.setupWorkerEnvironmentServiceSuite();

it.each([
  "original",
  "setup-enabled",
  "node-disconnected",
  "node-connected",
  "node-connected-capture",
  "node-stale-build",
  "node-stale-build-revoked",
  "node-owner-changed",
  "node-expired-running",
  "node-expired-stopped",
  "node-expired-mismatch",
  "node-expired-revoked",
  "node-expired-unknown",
  "foreign-owner",
  "foreign-resource",
  "pending-stop",
  "stale-predecessor",
])("retries failed initial setup on its accepted original disk (%s)", async (scenario) => {
  support.testState.nowMs = Date.now();
  vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const owner = {
    agentId: REQUEST.agentId,
    sessionId: REQUEST.sessionId,
    sessionKey: REQUEST.sessionKey,
  };
  const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
  const capture = scenario === "node-connected-capture";
  let launchedTurns = 0;
  const nodeBacked = scenario.startsWith("node-");
  const expired = scenario.startsWith("node-expired-");
  let recoveryPhase: "initial" | "cleanup" | "upgrade" = "initial";
  let liveNodeBuildId = "previous-native-build";
  let callerCurrent = true;
  const assertCallerCurrent = () => {
    if (!callerCurrent) {
      throw new Error("Synthetic caller authority revoked");
    }
  };
  let nodeProof: ReturnType<typeof createNodeWorkerBundleTestNode> | undefined;
  let nativeManager: ReturnType<typeof createNodeWorkerTunnelManager> | undefined;
  let nativeTunnel:
    | Awaited<ReturnType<ReturnType<typeof createNodeWorkerTunnelManager>["start"]>>
    | undefined;
  let nodeReady: ReturnType<typeof createWorkerRuntimeRefreshWaiter> | undefined;
  const staleBuild = scenario.startsWith("node-stale-build");
  let connected = scenario.startsWith("node-connected") || staleBuild;
  const readinessEvents: string[] = [];
  const workspaces = getSessionRepositoryWorkspaceStore();
  const created = await workspaces.create({
    ...REQUEST,
    url: "https://example.test/project.git",
    assertCurrent() {},
  });
  const harness = await createHarness(support.testState.stateDb, placements, {
    requiresNodeEnrollment: true,
    ...(capture ? { needsAcceptedWorkspacePublication: async () => true } : {}),
    hasCurrentRunner: () => connected,
    waitForRecoveryNode: async (placement, assertCurrent) => {
      if (!nodeReady) {
        throw new Error("Fixture recovery readiness is not bound");
      }
      await nodeReady.waitForRecoveryNode(placement, assertCurrent);
    },
    waitForInitialNode: async (input) => {
      if (!nodeReady) {
        throw new Error("Fixture node readiness is not bound");
      }
      await nodeReady.waitForInitialNode(input);
    },
    isCurrentNodePlacement: () => connected,
    resolveWorkspace: async () => ({
      kind: "repository",
      repository: (await workspaces.get(created.workspaceId))!,
    }),
  });
  const boundLaunch = scenario.startsWith("node-connected");
  const gatewayNamespace = nodeWorkerGatewayNamespace("retained-test-gateway");
  const nodeHome = path.join(support.testState.root, "prepared-node");
  const workspaceDir = path.join(
    nodeHome,
    ".openclaw-worker",
    "prepared",
    gatewayNamespace,
    "e".repeat(64),
    "workspace",
  );
  const preparedSource = boundLaunch ? await createRepositoryPolicySource(workspaceDir) : undefined;
  const disk = {
    environmentId: harness.attached.environmentId,
    sessionId: REQUEST.sessionId,
    ownerEpoch: harness.attached.ownerEpoch,
    ownerBinding: "original-binding",
    identity: {
      leaseId: harness.attached.leaseId!,
      attemptLeaseId: "original-attempt",
      resourceId: "original-resource",
      slug: "original-worker",
    },
    workspaceDir: preparedSource
      ? workspaceDir
      : "/original/workspace-with-unpublished-setup-edits",
  };
  // Initial sync accepts the real disk before postCreate; activation has not occurred.
  const source = await workspaces.bindBase({
    workspaceId: created.workspaceId,
    expectedRevision: created.revision,
    baseCommit: preparedSource?.baseCommit ?? "a".repeat(40),
    baseManifestHash: preparedSource?.base.manifestRef ?? `sha256:${"b".repeat(64)}`,
    diskAuthority: disk,
    assertCurrent() {},
  });
  const syncing = await seedSyncingPlacement(placements, disk.environmentId);
  const failed = await placements.fail({
    sessionId: REQUEST.sessionId,
    expectedGeneration: syncing.generation,
    recoveryError: "Prepared project setup failed: exit 1",
  });
  expect(failed.generation).toBe(4);
  const retention: WorkerSessionDiskRetention = {
    owner: scenario === "foreign-owner" ? { ...owner, sessionId: "another" } : owner,
    ownerBinding: disk.ownerBinding,
    policy: { mode: "session-disk", computeWindowSeconds: 14400 },
    desiredState: "running",
    operation: null,
    receipt: {
      schema: "crabbox.session-disk.v1",
      mode: "session-disk",
      identity: {
        ...disk.identity,
        ...(scenario === "foreign-resource" ? { resourceId: "another" } : {}),
      },
      ownerBinding: disk.ownerBinding,
      claimRevision: "original-claim",
      computeWindowSeconds: 14400,
      desiredState: "running",
      observedState: expired && scenario !== "node-expired-running" ? "Stopped" : "Running",
      policyVerified: true,
      stopPending: scenario === "pending-stop",
      computeWindow: {
        id: "original-window",
        authorizedAt: new Date(support.testState.nowMs - 1000).toISOString(),
        expiresAt: new Date(support.testState.nowMs + (expired ? -1 : 14400000)).toISOString(),
        state: "active",
      },
    },
  };
  const environment = {
    ...harness.attached,
    ...(nodeBacked
      ? {
          nodeDeviceId: "original-node",
          sshEndpoint: null,
          bootstrapReceipt: {
            ...harness.attached.bootstrapReceipt!,
            installKind: "bundle" as const,
          },
        }
      : {}),
    providerId: "crabbox",
    profileSnapshot: {
      settings: { provider: "azure-sandbox" },
      runSetupScript: scenario === "setup-enabled",
      project: {
        key: "c".repeat(64),
        root: "/prepared/source",
        baseCommit: source.baseCommit!,
        preparation: {
          key: "d".repeat(64),
          cacheKey: "e".repeat(64),
          contractVersion: 1 as const,
          recipe: {
            source: "script" as const,
            inputs: {},
            env: {},
            postCreate: "post-create",
            postStart: "post-start",
          },
          target: { machineClass: "standard", platform: "linux" },
          artifacts: {
            nodeBootstrapSha256: "f".repeat(64),
            enabledPluginIds: [],
            workerBundleHash: harness.attached.bootstrapReceipt!.bundleHash,
            workerArchiveSha256: "a".repeat(64),
            openclawVersion: VERSION,
            protocolFeatures: harness.attached.bootstrapReceipt!.protocolFeatures,
          },
        },
      },
    },
    retention,
    tunnelStatus: "stopped" as const,
  };
  writePlacementEnvironmentFixture(support.testState.stateDb, environment);
  harness.markEnvironmentOwnerEpoch(disk.ownerEpoch);
  if (staleBuild || boundLaunch) {
    await support.testState.store.renewCredential({
      ...support.attachedPatch(disk.environmentId, owner.sessionId).credential,
      environmentId: disk.environmentId,
      expectedOwnerEpoch: disk.ownerEpoch,
    });
  }
  // Provider/transport I/O is external; placement admission, disk acceptance and startup are real.
  vi.mocked(harness.environments.get).mockReturnValue(environment);
  vi.mocked(harness.environments.createWithRequest).mockResolvedValue(environment);
  vi.mocked(harness.environments.attachSession).mockRejectedValue(
    new Error("Original attachment must not be replaced"),
  );
  const resume = vi.fn<NonNullable<WorkerProvider["resumeNode"]>>(async (input) => {
    input.assertCurrent();
    if (boundLaunch && recoveryPhase !== "initial") {
      expect((await placements.getAsync(owner.sessionId))?.state).toBe("active");
      if (recoveryPhase === "cleanup") {
        expect(input).toMatchObject({ retainedRuntimeOnly: true });
        expect(input.runtime).toBeUndefined();
        expect(input.linuxToolchainSetup).toBeUndefined();
        expect(placements.get(owner.sessionId)?.turnClaim?.claimId).toBe("retained-launch-claim");
      } else {
        expect(placements.get(owner.sessionId)?.turnClaim).toBeNull();
        expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect(input.runtime?.nodeBootstrap.sha256).toBe("c".repeat(64));
        liveNodeBuildId = "current-native-build";
      }
      connected = true;
      return;
    }
    expect(input).toMatchObject({
      leaseId: disk.identity.leaseId,
      deviceId: "original-node",
      nodeBootstrapSha256: "f".repeat(64),
    });
    expect((await placements.getAsync(REQUEST.sessionId))?.state).toBe("provisioning");
    readinessEvents.push("resume");
    connected = true;
    if (scenario === "node-owner-changed") {
      const current = (await placements.getAsync(REQUEST.sessionId))!;
      await placements.fail({
        sessionId: REQUEST.sessionId,
        expectedGeneration: current.generation,
        recoveryError: "Synthetic retry owner changed",
      });
      input.assertCurrent();
    }
  });
  if (nodeBacked) {
    const currentReceipt = {
      ...environment.bootstrapReceipt!,
      protocolFeatures: environment.bootstrapReceipt!.protocolFeatures.toSorted(),
      bundleHash: staleBuild ? "9".repeat(64) : environment.bootstrapReceipt!.bundleHash,
    };
    support.testState.prepareInstallation = vi.fn(async () => ({
      ...support.BUNDLE_ARTIFACT,
      ...currentReceipt,
    }));
    let observed = structuredClone(retention.receipt!);
    const inspect = vi.fn<NonNullable<WorkerProvider["retainedLease"]>["inspect"]>(
      async (input) => {
        input.assertCurrent();
        readinessEvents.push("inspect");
        await Promise.resolve();
        if (scenario === "node-expired-revoked") {
          callerCurrent = false;
          input.assertCurrent();
        }
        if (scenario === "node-expired-unknown") {
          throw new Error("Provider observation unknown");
        }
        return scenario === "node-expired-mismatch"
          ? { ...observed, identity: { ...observed.identity, resourceId: "foreign-resource" } }
          : structuredClone(observed);
      },
    );
    const nodeService = support.createService(
      support.createProvider({
        id: "crabbox",
        supportedExecutionModes: ["worker-turn"],
        resumeNode: resume,
        retainedLease: {
          inspect,
          pause: async (input) => {
            input.assertCurrent();
            if (!expired) {
              throw new Error("Unexpected pause");
            }
            readinessEvents.push("pause");
            observed = {
              ...observed,
              claimRevision: "paused-claim",
              desiredState: "suspended",
              observedState: "Stopped",
              computeWindow: { ...observed.computeWindow, state: "closed" },
              operation: { ...input.retention.operation!, phase: "observed" },
            };
            return structuredClone(observed);
          },
          resume: async (input) => {
            input.assertCurrent();
            expect(input.leaseId).toBe(disk.identity.leaseId);
            expect(input.retention.ownerBinding).toBe(disk.ownerBinding);
            readinessEvents.push("renew");
            observed = {
              ...observed,
              claimRevision: "renewed-claim",
              desiredState: "running",
              observedState: "Running",
              computeWindow: {
                id: input.operationId,
                authorizedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 14400000).toISOString(),
                state: "active",
              },
              operation: { ...input.retention.operation!, phase: "observed" },
            };
            return structuredClone(observed);
          },
          destroy: async () => {
            throw new Error("Replacement refused");
          },
        },
      }),
      {
        placementStore: createWorkerSessionPlacementGate(placements),
        ...(boundLaunch
          ? {
              prepareNodeRuntime: async (_record, _bundle, _signal, assertCurrent) => {
                assertCurrent?.();
                expect(recoveryPhase).toBe("upgrade");
                return {
                  nodeBootstrap: {
                    url: "https://example.test/node",
                    token: "synthetic",
                    sha256: "c".repeat(64),
                    bytes: 1,
                    openclawVersion: VERSION,
                    buildId: "current-native-build",
                    enabledPluginIds: [],
                  },
                  workerBundle: {
                    url: "https://example.test/worker",
                    token: "synthetic",
                    sha256: "b".repeat(64),
                    bytes: 1,
                    packageRelativePath: "worker-artifacts/fixture.tgz",
                  },
                };
              },
            }
          : {}),
        ensureNodeWorkerBundle: async (input) => {
          input.assertCurrent?.();
          expect(input.artifact.bundleHash).toBe("9".repeat(64));
          expect((await placements.getAsync(REQUEST.sessionId))?.state).toBe("provisioning");
          expect(support.testState.store.getCredential(disk.environmentId)).toBeUndefined();
          readinessEvents.push("install");
          if (scenario === "node-stale-build-revoked") {
            callerCurrent = false;
          }
          input.assertCurrent?.();
          return currentReceipt;
        },
        nodeTunnelManager: {
          status: () => "stopped",
          start: async (input) => {
            expect(support.testState.store.get(disk.environmentId)?.bootstrapReceipt).toEqual({
              ...currentReceipt,
              installKind: "bundle",
            });
            if (nativeManager) {
              expect((await placements.getAsync(owner.sessionId))?.state).toBe(
                input.workspaceAuthority ? "active" : "syncing",
              );
              nativeTunnel = await nativeManager.start(input);
              vi.spyOn(nativeTunnel, "syncWorkspace");
              vi.spyOn(nativeTunnel, "runWorkspaceCommand");
              return nativeTunnel;
            }
            readinessEvents.push("tunnel");
            return harness.tunnelHandle(input.ownerEpoch);
          },
          stop: async (...args) => {
            if (nativeManager) {
              await nativeManager.stop(...args);
            }
          },
          stopAll: async () => {},
          beginClose: () => {},
          observeProcesses: async () => {
            throw new Error("Unexpected process inspection");
          },
        },
      },
    );
    if (staleBuild || boundLaunch) {
      vi.mocked(harness.environments.startTunnel).mockImplementation(nodeService.startTunnel);
      vi.mocked(harness.environments.get).mockImplementation(nodeService.get);
      if (boundLaunch) {
        vi.mocked(harness.environments.stopTunnel).mockImplementation(nodeService.stopTunnel);
        vi.mocked(harness.environments.fenceWorkerTurnForRecovery).mockImplementation(
          nodeService.fenceWorkerTurnForRecovery,
        );
      }
    }
    nodeReady = createWorkerRuntimeRefreshWaiter({
      environments: nodeService,
      isStopping: () => false,
    });
    vi.mocked(harness.environments.destroy).mockImplementation(nodeService.destroy);
    nodeReady.bind(
      async (_id, input) => {
        input.assertCurrent();
        expect(connected).toBe(true);
        if (input.isReady && !input.isReady()) {
          throw new Error("Fixture node build is not ready");
        }
        readinessEvents.push("ready");
      },
      async () => connected,
      ...(boundLaunch
        ? ([
            () => (connected ? VERSION : undefined),
            () => (connected ? liveNodeBuildId : undefined),
          ] as const)
        : []),
    );
    bindDeviceWorkerAvailability(harness.environments, async () => {
      readinessEvents.push("eligibility");
      return connected
        ? {
            available: true,
            node: createNodeWorkerBundleTestNode({
              nodeId: "original-node",
              workerHost: {
                capacity: { total: 2, available: 2 },
                capturedExecPolicy: true,
                promptContext: 1,
              },
              commands: [],
            }),
          }
        : { available: false, unavailableReason: "disconnected" };
    });
  }
  if (preparedSource) {
    const node = await createPreparedRepositoryNodeFixture({
      nodeHome,
      workspaceDir,
      base: preparedSource.base,
      store: support.testState.store,
      identity: {
        gatewayNamespace,
        environmentId: disk.environmentId,
        preparationKey: "d".repeat(64),
        cacheKey: "e".repeat(64),
      },
    });
    await node.runtime.prepare({
      action: "bind",
      gatewayNamespace,
      environmentId: disk.environmentId,
      preparationKey: "d".repeat(64),
      cacheKey: "e".repeat(64),
      ...owner,
      ownerEpoch: disk.ownerEpoch,
    });
    await fs.writeFile(
      path.join(workspaceDir, "private-result.txt"),
      "unpublished retained result",
    );
    const bundleRoot = path.join(nodeHome, "bundles-root");
    const bundleDir = path.join(
      bundleRoot,
      gatewayNamespace,
      "bundles",
      environment.bootstrapReceipt!.bundleHash,
    );
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "worker.mjs"), TEST_WORKER_SOURCE);
    const supervisor = createNodeWorkerSupervisor({
      bundleRoot,
      env: { ...process.env, HOME: nodeHome, OPENCLAW_STATE_DIR: path.join(nodeHome, "state") },
      workspace: node.runtime,
    });
    onTestFinished(() => supervisor.close());
    nodeProof = createNodeWorkerBundleTestNode({
      nodeId: "original-node",
      workerHost: {
        environmentSession: 1,
        capturedExecPolicy: true,
        promptContext: 1,
        workspaceQuiescence: 1,
      },
    });
    const currentNodeProof = nodeProof;
    const nodeTransport = transport();
    nodeTransport.getCurrentNode = async (id) =>
      id === currentNodeProof.nodeId ? currentNodeProof : undefined;
    nodeTransport.listCurrentNodes = async () => [currentNodeProof];
    nodeTransport.invoke = async (request) => {
      expect(request.isDispatchAuthorized()).toBe(true);
      if (request.command === NODE_WORKER_WORKSPACE_EXEC_COMMAND) {
        const command = parseNodeWorkerWorkspaceExecInput(JSON.stringify(request.params));
        return {
          ok: true,
          payloadJSON: JSON.stringify(
            await node.runtime.exec(command, request.signal, { url: node.gatewayUrl }),
          ),
        };
      }
      if (request.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
        await supervisor.stopEnvironment(
          parseNodeWorkerEnvironmentStopInput(JSON.stringify(request.params)),
        );
        return { ok: true, payloadJSON: "null" };
      }
      expect(request.command).toBe(NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND);
      launchedTurns += 1;
      const input = parseNodeWorkerLaunchInput(JSON.stringify(request.params));
      await expect(
        supervisor.launch({ ...input, sessionKey: "agent:main:foreign" }, TEST_WORKER_ENDPOINT),
      ).rejects.toThrow("does not own");
      await expect(
        supervisor.launch(
          {
            ...input,
            sessionKey: owner.sessionKey,
            descriptor: {
              ...input.descriptor,
              admission: {
                ...input.descriptor.admission,
                ownerEpoch: input.descriptor.admission.ownerEpoch + 1,
              },
            },
          },
          TEST_WORKER_ENDPOINT,
        ),
      ).rejects.toThrow("does not own");
      await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      return {
        ok: true,
        payloadJSON: JSON.stringify(
          projectNodeWorkerSupervisorReceipt(
            await waitForNodeWorkerTerminal(supervisor, input.launchId),
          ),
        ),
      };
    };
    nativeManager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "retained-test-gateway",
      getEnvironment: () => environment,
      listEnvironments: () => [environment],
      getTransport: () => nodeTransport,
      workspaceTransfer: capture ? node.workspaceTransfer : workspaceTransfer(),
      validateWorkerTurn: (claim) => placements.validateTurnClaim(claim),
      launchNodeWorker: createNodeWorkerLaunchAdapter({ getTransport: () => nodeTransport }).launch,
    });
    const resolveBinding = createWorkerPlacementNodeWorkspaceBindingResolver({
      placements,
      resolveWorkspace: async () => ({ kind: "repository", repository: source }),
    });
    nativeManager.bindWorkspaceBindingResolver(async (binding) => {
      const initial = binding.initialPlacement;
      if (initial) {
        for (const changed of [
          { initialPlacement: { ...initial, generation: initial.generation + 1 } },
          { initialPlacement: { ...initial, sessionKey: "agent:main:foreign" } },
          { ownerEpoch: binding.ownerEpoch + 1 },
          { sessionId: "foreign-session" },
        ]) {
          await expect(resolveBinding({ ...binding, ...changed })).resolves.toBeUndefined();
        }
      }
      return resolveBinding(binding);
    });
  }
  const expected = {
    ...failed,
    generation: failed.generation + (scenario === "stale-predecessor" ? 1 : 0),
  };
  const retryable = scenario === "original" || scenario === "setup-enabled" || nodeBacked;
  expect(await placements.canResumeRetainedOriginal({ ...REQUEST, expected })).toBe(retryable);
  if (!retryable) {
    await expect(
      placements.startDispatch({ ...REQUEST, expectedPlacement: expected }),
    ).rejects.toThrow(scenario === "stale-predecessor" ? "changed" : "requires recovery");
    expect(await placements.getAsync(REQUEST.sessionId)).toEqual(failed);
    return;
  }
  const executing = harness.service.dispatch(
    { ...REQUEST, expectedPlacement: failed },
    undefined,
    assertCallerCurrent,
  );
  if (
    ["node-expired-mismatch", "node-expired-revoked", "node-expired-unknown"].includes(scenario)
  ) {
    await expect(executing).rejects.toThrow();
    expect(readinessEvents).toEqual(["inspect"]);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(support.testState.store.get(disk.environmentId)).toMatchObject({
      state: "attached",
      leaseId: disk.identity.leaseId,
      ownerEpoch: disk.ownerEpoch,
      nodeDeviceId: "original-node",
      attachedSessionIds: [owner.sessionId],
    });
    expect(await workspaces.get(source.workspaceId)).toEqual(source);
    return;
  }
  if (scenario === "node-owner-changed") {
    await expect(executing).rejects.toThrow("Retained initial node readiness lost");
    expect(readinessEvents).toEqual(["inspect", "resume"]);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(support.testState.store.get(disk.environmentId)).toMatchObject({
      state: "attached",
      leaseId: disk.identity.leaseId,
      ownerEpoch: disk.ownerEpoch,
      nodeDeviceId: "original-node",
    });
    expect(await workspaces.get(source.workspaceId)).toEqual(source);
    return;
  }
  if (scenario === "node-stale-build-revoked") {
    await expect(executing).rejects.toThrow("Synthetic caller authority revoked");
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(support.testState.store.get(disk.environmentId)?.bootstrapReceipt).toEqual({
      ...environment.bootstrapReceipt!,
      protocolFeatures: environment.bootstrapReceipt!.protocolFeatures.toSorted(),
    });
    expect(await workspaces.get(source.workspaceId)).toEqual(source);
    return;
  }
  const active = await executing;
  expect(active).toMatchObject({
    state: "active",
    environmentId: disk.environmentId,
    activeOwnerEpoch: disk.ownerEpoch,
    remoteWorkspaceDir: disk.workspaceDir,
  });
  expect(harness.environments.attachSession).not.toHaveBeenCalled();
  const tunnel = await vi.mocked(harness.environments.startTunnel).mock.results[0]!.value;
  expect(tunnel.syncWorkspace).not.toHaveBeenCalled();
  expect(tunnel.runWorkspaceCommand).toHaveBeenCalledTimes(scenario === "setup-enabled" ? 1 : 0);
  expect(harness.environments.bindPreparedWorkspace).toHaveBeenCalledOnce();
  expect(harness.environments.destroy).not.toHaveBeenCalled();
  expect(await workspaces.get(source.workspaceId)).toEqual(source);
  if (nativeTunnel) {
    const claim = await placements.claimTurn({
      ...owner,
      claimId: "retained-launch-claim",
      runId: "run-1",
      owner: { kind: "worker", environmentId: disk.environmentId, ownerEpoch: disk.ownerEpoch },
    });
    const input = testWorkerLaunchInput(workspaceDir, "retained-bound-turn", "env");
    input.descriptor.admission = {
      ...input.descriptor.admission,
      environmentId: disk.environmentId,
      sessionId: owner.sessionId,
      ownerEpoch: disk.ownerEpoch,
      handshake: {
        bundleHash: environment.bootstrapReceipt!.bundleHash,
        openclawVersion: environment.bootstrapReceipt!.openclawVersion,
        protocolFeatures: environment.bootstrapReceipt!.protocolFeatures,
      },
    };
    await expect(
      nativeTunnel.launchTurn({ plan: input.descriptor, turnClaim: claim }),
    ).resolves.toMatchObject({ code: 0 });
    expect(
      JSON.parse(await fs.readFile(path.join(workspaceDir, "retained-bound-turn.env.json"), "utf8"))
        .HOME,
    ).toBe(path.join(path.dirname(workspaceDir), "home"));
    await expect(
      nativeTunnel.runWorkspaceCommand({
        argv: [
          "node",
          "-e",
          "process.stdout.write(require('node:fs').readFileSync('private-result.txt', 'utf8'))",
        ],
        transportRetry: "never",
      }),
    ).resolves.toMatchObject({ code: 0, stdout: "unpublished retained result", workspaceDir });
    expect(await fs.readFile(path.join(workspaceDir, "private-result.txt"), "utf8")).toBe(
      "unpublished retained result",
    );
    const build = vi
      .spyOn(await import("../../version.js"), "resolveRuntimeServiceBuildId")
      .mockReturnValue("current-native-build");
    onTestFinished(() => build.mockRestore());
    support.testState.prepareInstallation = vi.fn(async () => ({
      ...support.BUNDLE_ARTIFACT,
      bundleHash: "9".repeat(64),
    }));
    await placements.markWorkspaceResultPending(claim);
    await placements.handoffWorkspaceResultRecovery(claim);
    const pending = await placements.listPendingWorkspaceResultsAsync();
    recoveryPhase = "cleanup";
    await expect(
      harness.environments.startTunnel({
        environmentId: disk.environmentId,
        ownerEpoch: disk.ownerEpoch,
        recoveryClaim: { ...claim, placementGeneration: claim.placementGeneration + 1 },
      }),
    ).rejects.toThrow("recovery owner changed");
    connected = false;
    // Missing dialect may reconnect transport, but never acknowledges native cleanup.
    delete nodeProof!.workerHost.environmentSession;
    await harness.service.reconcileActive();
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual(pending);
    expect(placements.get(owner.sessionId)?.turnClaim?.claimId).toBe(claim.claimId);
    nodeProof!.workerHost.environmentSession = 1;
    await harness.service.reconcileActive();
    expect(placements.get(owner.sessionId)?.turnClaim).toBeNull();
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(resume).toHaveBeenCalledOnce();
    expect(launchedTurns).toBe(1);
    if (capture) {
      await withSessionRepositoryCheckpoint(
        { workspaceId: source.workspaceId },
        async (snapshot) => {
          expect(
            await fs.readFile(path.join(snapshot.stagingRoot, "private-result.txt"), "utf8"),
          ).toBe("unpublished retained result");
        },
      );
      await expect(
        nativeTunnel.launchTurn({ plan: input.descriptor, turnClaim: claim }),
      ).rejects.toThrow("remote-exec");
    }
    recoveryPhase = "upgrade";
    connected = false;
    await nodeReady!.wait({
      placement: active,
      signal: new AbortController().signal,
      assertCurrent: assertCallerCurrent,
    });
    expect(resume).toHaveBeenCalledTimes(2);
    const normalTunnel = await nativeManager!.start({
      executionMode: "worker-turn",
      environmentId: disk.environmentId,
      ownerEpoch: disk.ownerEpoch,
      deviceId: "original-node",
      sessionId: owner.sessionId,
      expectedBuild: environment.bootstrapReceipt!,
      authorize: assertCallerCurrent,
    });
    await expect(
      normalTunnel.runWorkspaceCommand({
        argv: [
          "node",
          "-e",
          "process.stdout.write(require('node:fs').readFileSync('private-result.txt', 'utf8'))",
        ],
        transportRetry: "never",
      }),
    ).resolves.toMatchObject({ code: 0, stdout: "unpublished retained result" });
    await normalTunnel.stop();
    expect(launchedTurns).toBe(1);
    expect(await fs.readFile(path.join(workspaceDir, "private-result.txt"), "utf8")).toBe(
      "unpublished retained result",
    );
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    return;
  }
  if (staleBuild) {
    expect(active.workerBundleHash).toBe("9".repeat(64));
    expect(readinessEvents).toEqual(["inspect", "ready", "install", "eligibility", "tunnel"]);
    expect(support.testState.store.get(disk.environmentId)).toMatchObject({
      state: "attached",
      ownerEpoch: disk.ownerEpoch,
      leaseId: disk.identity.leaseId,
      attachedSessionIds: [owner.sessionId],
      profileSnapshot: environment.profileSnapshot,
    });
    return;
  }
  if (nodeBacked) {
    expect(resume).toHaveBeenCalledTimes(scenario === "node-disconnected" || expired ? 1 : 0);
    if (expired) {
      expect(readinessEvents).toEqual([
        "inspect",
        "inspect",
        "pause",
        "renew",
        "resume",
        "ready",
        "eligibility",
      ]);
      expect(support.testState.store.get(disk.environmentId)?.retention).toMatchObject({
        operation: null,
        receipt: {
          claimRevision: "renewed-claim",
          observedState: "Running",
          computeWindow: { state: "active" },
        },
      });
      return;
    }
    expect(readinessEvents).toEqual(
      scenario === "node-disconnected"
        ? ["inspect", "resume", "ready", "eligibility"]
        : ["inspect", "ready", "eligibility"],
    );
  }
});
