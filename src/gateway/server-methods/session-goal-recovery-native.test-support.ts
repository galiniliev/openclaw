import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { installFactoryRestartRepositoryFixture } from "../../agents/main-session-recovery/main-session-recovery-factory-read.test-support.js";
import type { createOriginalIssuerFixture } from "../../agents/main-session-recovery/main-session-recovery-original-issuer.test-support.js";
import * as runtimePlugins from "../../agents/runtime-plugins.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { bindDeviceWorkerAvailability } from "../worker-environments/device-provider.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import {
  seedAttachedPlacementEnvironment,
  writePlacementEnvironmentFixture,
} from "../worker-environments/placement-test-fixtures.js";
import { prepareRepositoryWorkerProjectSource } from "../worker-environments/repository-project-admission.js";
import { createNodeCarrier } from "../worker-environments/skill-resource-transfer.test-support.js";
import type { WorkerTunnelHandle } from "../worker-environments/tunnel-contract.js";
import { createWorkerPlacementRedispatch } from "../worker-environments/worker-placement-redispatch.js";
import { createWorkerSessionTurnPlacementProvider } from "../worker-environments/worker-turn-launcher.js";
import {
  attachedEnvironment,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
} from "../worker-environments/worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "../worker-environments/workspace-operation-coordinator.js";
import {
  createRecoveryDispatchFixture,
  type RecoveryPreparedScenario,
} from "./session-recovery-dispatch.test-support.js";

export type StartupNativeEffect = (input: {
  runId: string;
  agentId: string;
  nodeId: string;
  workspace: {
    workspaceDir: string;
    environmentId: string;
    ownerEpoch: number;
    sessionId: string;
    sessionKey: string;
  };
  assertCurrent: () => void;
  acquireManagedWorkspaceAsync: Awaited<
    ReturnType<typeof prepareGoalRecoveryNativeFixture>
  >["acquireManagedWorkspaceAsync"];
  runWorkspaceCommand: WorkerTunnelHandle["runWorkspaceCommand"];
}) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Synthetic provider transport; placement, original issuer, proof and repository admission stay real. */
export async function prepareGoalRecoveryNativeFixture(
  fixture: Awaited<ReturnType<typeof createOriginalIssuerFixture>>,
  target: { agentId: string; sessionKey: string },
  sessionId: string,
  workspaceDir: string,
  canonicalDispatch = false,
  failedSource = false,
  suppliedRepositoryProof?: ReturnType<typeof installFactoryRestartRepositoryFixture>,
  preparedScenario?: RecoveryPreparedScenario,
  delayedOriginalResult = false,
  afterCurrentRead?: () => Promise<void>,
  exactWorkerWorkspace = false,
) {
  const database = openOpenClawStateDatabase();
  const oldCarrier = await createNodeCarrier(workspaceDir);
  const freshRoot = path.join(workspaceDir, "fresh-worker");
  if (failedSource) {
    await fs.mkdir(freshRoot, { recursive: true });
  }
  const carrier = failedSource ? await createNodeCarrier(freshRoot) : oldCarrier;
  let commandsStarted = 0;
  let commandsCompleted = 0;
  const placements = createWorkerSessionPlacementStore({ database });
  const identity = { ...target, sessionId };
  let environment: NonNullable<ReturnType<WorkerTurnEnvironmentService["get"]>> = {
    ...attachedEnvironment(),
    providerId: "crabbox",
    ...(preparedScenario
      ? { profileSnapshot: { install: "bundle", settings: { region: "test" } } }
      : {}),
    nodeDeviceId: "synthetic-native-worker",
    sshEndpoint: null,
    attachedSessionIds: [sessionId],
  };
  const activate = async () => {
    let placement = await placements.startDispatch({ ...identity, executionMode: "remote-exec" });
    if (preparedScenario) {
      writePlacementEnvironmentFixture(database, environment);
    } else {
      seedAttachedPlacementEnvironment(database, {
        environmentId: environment.environmentId,
        sessionId,
        ownerEpoch: environment.ownerEpoch,
        providerId: environment.providerId,
        profileId: environment.profileId,
        nodeDeviceId: environment.nodeDeviceId,
      });
    }
    placement = await placements.transition({
      sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: environment.environmentId },
    });
    placement = await placements.transition({
      sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: environment.bootstrapReceipt!.bundleHash },
    });
    placement = await placements.transition({
      sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        remoteWorkspaceDir: oldCarrier.workspace,
        workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
      },
    });
    return placements.transition({
      sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: environment.ownerEpoch },
    });
  };
  const active = await activate();
  const reclaimOriginal = async () => {
    const draining = await placements.startDrain({
      sessionId,
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
      expectedGeneration: active.generation,
    });
    const reconciling = await placements.startReconcile({
      sessionId,
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
      expectedGeneration: draining.generation,
    });
    if (failedSource) {
      await placements.fail({
        sessionId,
        expectedGeneration: reconciling.generation,
        recoveryError: "Synthetic original worker executor failed after accepted checkpoint",
      });
    } else {
      await placements.transition({
        sessionId,
        from: "reconciling",
        to: "reclaimed",
        expectedGeneration: reconciling.generation,
      });
    }
  };
  if (!delayedOriginalResult) {
    await reclaimOriginal();
  }
  if (canonicalDispatch) {
    writePlacementEnvironmentFixture(database, environment);
  }
  fixture.context.workerSessionPlacementService = placements;
  fixture.registry.plugins.push(createPluginRecord({ id: "codex" }));
  const { createCodexHarnessForTest } = await loadBundledPluginFacade<{
    createCodexHarnessForTest: () => Promise<AgentHarness>;
  }>({ pluginId: "codex", artifactBasename: "test-api.js" });
  const harness = await createCodexHarnessForTest();
  const harnessAttempts = vi.spyOn(harness, "runAttempt");
  registerAgentHarness(harness, { ownerPluginId: "codex" });
  const registerInPreparedRegistry = (registry: PluginRegistry) =>
    withPluginRuntimeRegistryScope(registry, () =>
      registerAgentHarness(harness, { ownerPluginId: "codex" }),
    );
  // Install the synthetic native edge before the prepared owner publishes its registry.
  const loadRegistry = runtimePlugins.loadAgentRuntimePluginRegistryHandle;
  const registryLoader = vi
    .spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle")
    .mockImplementation((...args) => {
      const registry = loadRegistry(...args);
      registerInPreparedRegistry(registry);
      return registry;
    });
  const acquireRegistry = runtimePlugins.acquireAgentRuntimePluginRegistry;
  const registryAcquirer = vi
    .spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry")
    .mockImplementation(async (...args) => {
      const acquired = await acquireRegistry(...args);
      registerInPreparedRegistry(acquired.registry);
      return acquired;
    });
  const repositoryUrl = "https://microsoft.ghe.com/acme/accepted.git";
  const repository = await getSessionRepositoryWorkspaceStore().create({
    ...identity,
    url: repositoryUrl,
    requestedRef: "main",
    runSetupScript: false,
    assertCurrent: fixture.original!.authority.assertCurrent,
  });
  const repositoryProof =
    suppliedRepositoryProof ??
    installFactoryRestartRepositoryFixture({
      binding: () => ({
        ...identity,
        actorId: 700100,
        profileId: fixture.profile.id,
        repositoryUrl,
        context: fixture.context,
      }),
      afterLookup: async () => {
        if (preparedScenario !== "target-replaced") {
          return;
        }
        const store = getSessionRepositoryWorkspaceStore();
        const current = await store.get(repository.workspaceId);
        if (!current?.checkpointRef) {
          return;
        }
        const authority = expectDefined(
          getGatewayToolCallerIdentity()?.operatorAuthority ??
            getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
          "current original repository caller",
        );
        await store.acceptCheckpoint({
          workspaceId: current.workspaceId,
          expectedRevision: current.revision,
          checkpointRef: current.checkpointRef,
          manifestHash: expectDefined(current.manifestHash, "accepted target manifest"),
          branch: "replacement-target-branch",
          assertCurrent: authority.assertCurrent,
        });
      },
      broker: () => "current",
      ...(failedSource
        ? {
            allowPublicationPreflight: true as const,
            repositorySnapshot: () => canonical?.failedRecovery?.repositorySnapshot,
          }
        : {}),
    });
  const environments: WorkerTurnEnvironmentService = {
    ...unusedEnvironments(),
    get: vi.fn(() => environment),
    startTunnel: vi.fn(async () => ({
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
      runWorkspaceCommand: vi.fn(async (command) => {
        commandsStarted += 1;
        const result = await carrier.runWorkspaceCommand(command);
        commandsCompleted += 1;
        return result;
      }),
      quiesceWorkspace: vi.fn(async () => ({
        assertActive: async () => {},
        resume: async () => {},
      })),
      syncWorkspace: vi.fn(async () => {
        throw new Error("Unexpected workspace sync");
      }),
      reconcileWorkspace: vi.fn<WorkerTunnelHandle["reconcileWorkspace"]>(async (request) => {
        if (request.source.kind !== "local") {
          throw new Error("Expected synthetic provider workspace");
        }
        const manifestRef = `sha256:${"b".repeat(64)}`;
        await request.source.journal.commit(manifestRef);
        return {
          manifestRef,
          changed: false,
          publishStagedResult: async () => {},
          discardPreparedStagedResult: async () => {},
          verifyStable: async () => {},
          verifyLocalStable: async () => {},
        };
      }),
      stop: vi.fn(async () => {}),
    })),
  };
  const originalEnvironmentId = environment.environmentId;
  const tunnel = await environments.startTunnel({
    environmentId: environment.environmentId,
    ownerEpoch: environment.ownerEpoch,
  });
  const canonical = canonicalDispatch
    ? await createRecoveryDispatchFixture({
        database,
        placements,
        cfg: fixture.cfg,
        repository,
        tunnel,
        remoteWorkspaceDir: carrier.workspace,
        build: environment.bootstrapReceipt!,
        ...(exactWorkerWorkspace ? { exactWorkerWorkspace: carrier } : {}),
        preparedScenario,
        ...(delayedOriginalResult
          ? {
              lateResult: {
                originalEnvironmentId: environment.environmentId,
                sessionId,
                carrier: oldCarrier,
                afterCurrentRead,
              },
            }
          : {}),
        ...(failedSource
          ? {
              failedSource: {
                sessionId,
                environmentId: environment.environmentId,
                leaseId: expectDefined(environment.leaseId, "original owned lease"),
                oldWorkspaceDir: oldCarrier.workspace,
              },
            }
          : {}),
      })
    : undefined;
  if (canonical) {
    Object.assign(environments, canonical.service);
    vi.spyOn(environments, "startTunnel");
    bindDeviceWorkerAvailability(environments, canonical.resolveAvailability);
  }
  let redispatches = 0;
  const redispatch = createWorkerPlacementRedispatch({
    placements,
    resolveRepositoryWorkspace: async () =>
      expectDefined(
        await getSessionRepositoryWorkspaceStore().get(repository.workspaceId),
        "current repository workspace",
      ),
    resolveDevicePlacementRequirement: async () => ({
      requiredNodeCommands: ["codex.exec-server.stdio.v1"],
      consumesWorkerSlot: false,
    }),
    dispatch: async (request, onTransition, assertCurrent) => {
      assertCurrent?.();
      expect(request).toMatchObject({ ...identity, executionMode: "remote-exec" });
      if (canonical) {
        const next = await canonical.dispatch(request, onTransition, assertCurrent);
        environment = expectDefined(canonical.service.get(next.environmentId), "fresh environment");
        expect(environment.environmentId).not.toBe(originalEnvironmentId);
        redispatches += 1;
        return next;
      }
      const readNativeCredential = expectDefined(
        request.readNativeCredential,
        "original issuer dispatch reader",
      );
      const source = await prepareRepositoryWorkerProjectSource({
        namespace: "informed-native-recovery",
        repository: { agentId: target.agentId, url: repositoryUrl, ref: "main" },
        getConfig: fixture.context.getRuntimeConfig,
        assertCurrent: () => assertCurrent?.(),
        readNativeCredential,
      });
      expect(source.project.source.url).toBe(repositoryUrl);
      const next = await activate();
      onTransition?.(next);
      if (next.state !== "active") {
        throw new Error("Synthetic provider failed to activate");
      }
      redispatches += 1;
      return next;
    },
  });
  const provider = createWorkerSessionTurnPlacementProvider({
    environments,
    placements,
    resolveWorkspace: async () => ({ kind: "local", path: workspaceDir }),
    waitForAdmissionNode: async () => {},
    reconcileActivePlacement: async () => {
      throw new Error("Unexpected provider failure cleanup");
    },
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    redispatchPlacement: redispatch,
    ...(failedSource && canonical
      ? { recoverFailedPlacement: canonical.recoverFailedPlacement }
      : {}),
  });
  const uninstall = installSessionPlacementAdmissionProvider(provider);
  return {
    placements,
    get environment() {
      return environment;
    },
    repository,
    repositoryProof,
    environments,
    redispatches: () => redispatches,
    async close() {
      uninstall();
      try {
        await canonical?.close();
      } finally {
        registryLoader.mockRestore();
        registryAcquirer.mockRestore();
      }
    },
    get remoteWorkspaceDir() {
      return carrier.workspace;
    },
    acquireManagedWorkspaceAsync: carrier.acquireManagedWorkspaceAsync,
    oldWorkspaceDir: oldCarrier.workspace,
    failedRecovery: canonical?.failedRecovery,
    reconcileFailedPlacement: canonical?.reconcileFailedPlacement,
    lateResult: canonical?.lateResult,
    transportCounts: () => ({ started: commandsStarted, completed: commandsCompleted }),
    harnessAttempts,
    coldAllocations: () => canonical?.coldAllocations(),
    warmEnvironment: () => canonical?.warmEnvironment(),
    warmReceipt: () => canonical?.warmReceipt(),
    readWarmClaim: () => canonical?.readWarmClaim(),
    credentialErrors: () => canonical?.credentialErrors,
    settlePrevious: async () => {
      if (canonical && !failedSource) {
        if (delayedOriginalResult) {
          await reclaimOriginal();
        }
        const retire = canonical.service.destroy(originalEnvironmentId);
        if (canonical.lateResult) {
          await canonical.lateResult.finishRetirement(retire.then(() => {}));
        }
        const retired = await retire;
        expect(retired.state).toBe("destroyed");
        await canonical.prepareWarm();
      }
    },
  };
}
