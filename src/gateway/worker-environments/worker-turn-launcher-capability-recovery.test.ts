import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createWorkerRuntimeRefreshWaiter } from "../server-worker-placement-runtime-refresh.js";
import {
  advancePlacementFixtureToActive,
  writePlacementEnvironmentFixture,
} from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createWorkerPreparationIdentity } from "./preparation-identity.js";
import { createProviderReplayDispatch } from "./provider-replay.test-support.js";
import { createWorkerEnvironmentService } from "./service.js";
import { BUNDLE_ARTIFACT, createProvider } from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { completeTurn, localResult } from "./worker-turn-launcher-flow.test-support.js";
import * as worker from "./worker-turn-launcher.test-support.js";

beforeEach(worker.setupWorkerTurnLauncherTest);
afterEach(() => worker.cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));
afterAll(closeStateDatabaseForTest);

it.each(["missing feature", "current bundle", "refresh failure", "authority changed"] as const)(
  "preserves the retained lease through launch admission: %s",
  async (scenario) => {
    const original = worker.attachedEnvironment();
    const receipt = original.bootstrapReceipt!;
    const installation = {
      ...BUNDLE_ARTIFACT,
      ...receipt,
      install: "bundle" as const,
      bundleHash: "b".repeat(64),
    };
    const preparation = createWorkerPreparationIdentity({
      namespace: "launch-capability-recovery",
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: {} },
      imageReserve: true,
      target: { machineClass: "test", platform: "linux" },
      artifacts: {
        nodeBootstrapSha256: "c".repeat(64),
        enabledPluginIds: [],
        workerBundleHash: receipt.bundleHash,
        workerArchiveSha256: "d".repeat(64),
        openclawVersion: receipt.openclawVersion,
        protocolFeatures: receipt.protocolFeatures,
      },
    });
    writePlacementEnvironmentFixture(worker.database, {
      ...original,
      nodeDeviceId: "retained-node",
      sshEndpoint: null,
      sharedHost: false,
      profileSnapshot: {
        settings: {},
        runtimePreparation: { ...preparation, source: "image" },
      },
      bootstrapReceipt:
        scenario === "current bundle"
          ? installation
          : {
              ...receipt,
              protocolFeatures: receipt.protocolFeatures.filter(
                (feature) => feature !== WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE,
              ),
            },
    });
    const placement = await advancePlacementFixtureToActive(
      worker.placements,
      worker.database,
      { ...worker.workerTurnRequest("capability-recovery"), executionMode: "worker-turn" },
      {
        environmentId: worker.ENVIRONMENT_ID,
        ownerEpoch: worker.OWNER_EPOCH,
        workerBundleHash:
          scenario === "current bundle" ? installation.bundleHash : receipt.bundleHash,
        remoteWorkspaceDir: "/retained/workspace",
        seedEnvironment: false,
      },
    );
    const store = await createWorkerEnvironmentStore({ database: worker.database });
    const events: string[] = [];
    let connected = scenario === "current bundle";
    let current = true;
    const resumeNode = vi.fn(
      async (
        request: Parameters<NonNullable<ReturnType<typeof createProvider>["resumeNode"]>>[0],
      ) => {
        request.assertCurrent();
        expect(request).toMatchObject({
          leaseId: original.leaseId,
          deviceId: "retained-node",
          nodeBootstrapSha256: "c".repeat(64),
        });
        events.push("resume");
        connected = true;
        if (scenario === "authority changed") {
          current = false;
        }
      },
    );
    const provision = vi.fn(async (): Promise<never> => {
      throw new Error("unexpected replacement");
    });
    const destroy = vi.fn(async (): Promise<never> => {
      throw new Error("unexpected destroy");
    });
    const tunnelLaunch = vi.fn<Parameters<typeof worker.createWorkerTurnTunnel>[0]["launchTurn"]>(
      async (request) => {
        events.push("launch");
        request.onDispatchReady?.();
        return completeTurn(request, "Retained worker continued", 51);
      },
    );
    const tunnel = worker.createWorkerTurnTunnel({
      launchTurn: tunnelLaunch,
      reconcileWorkspace: worker.reconcileUnchangedLocalWorkspace,
    });
    const install = vi.fn(
      async (
        request: Parameters<
          NonNullable<
            Parameters<typeof createWorkerEnvironmentService>[0]["ensureNodeWorkerBundle"]
          >
        >[0],
      ) => {
        request.assertCurrent?.();
        events.push("install");
        if (scenario === "refresh failure") {
          throw new Error("fixture runtime install failed");
        }
        return installation;
      },
    );
    const service = createWorkerEnvironmentService({
      store,
      scheduler: createTestGatewayScheduler(),
      getConfig: () => ({
        cloudWorkers: { profiles: { development: { provider: "fake", settings: {} } } },
      }),
      resolveProvider: () =>
        createProvider({
          supportedExecutionModes: ["worker-turn"],
          resumeNode,
          provision,
          destroy,
        }),
      prepareInstallation: async () => installation,
      bootstrapWorker: async (): Promise<never> => {
        throw new Error("unexpected SSH bootstrap");
      },
      ensureNodeWorkerBundle: install,
      createGatewayTools: async ({ prepareTools }) => prepareTools?.([]) ?? [],
      placementStore: createWorkerSessionPlacementGate(worker.placements),
      nodeTunnelManager: {
        status: () => "stopped",
        observeProcesses: async (): Promise<never> => {
          throw new Error("unexpected process inspection");
        },
        start: async () => tunnel,
        stop: async () => {
          events.push("stop");
        },
        stopAll: async () => {},
        beginClose: () => {},
      },
    });
    const waiter = createWorkerRuntimeRefreshWaiter({
      environments: service,
      isStopping: () => false,
    });
    waiter.bind(
      async (_id, request) => {
        request.assertCurrent();
        expect(connected).toBe(true);
        events.push("connected");
      },
      async () => connected,
    );
    const dispatch = createProviderReplayDispatch({
      placements: worker.placements,
      environments: service,
      initialPlacements: await worker.placements.listAsync(),
      resolveWorkspace: async () => ({ kind: "local", path: worker.root }),
    });
    const claimTurn = vi.spyOn(worker.placements, "claimTurn");
    const runLocal = vi.fn(localResult);
    const provider = worker.createWorkerSessionTurnPlacementProvider({
      placements: worker.placements,
      environments: service,
      waitForAdmissionNode: waiter.wait,
      reconcileActivePlacement: (id) => dispatch.reconcileActive(id),
    });
    const input = worker.turn("capability-recovery");
    await worker.appendWorkerReply("Original retained history", 1);
    const workspaceFile = path.join(worker.root, "retained.txt");
    await fs.writeFile(workspaceFile, "Original retained workspace");
    try {
      const execution = provider.executeTurn(
        worker.workerTurnRequest(input.runId),
        {
          ...input,
          userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
            target: { ...worker.sessionTarget, sessionEntry: undefined },
            input: { text: input.prompt },
          }),
        },
        runLocal,
        undefined,
        () => {
          if (!current) {
            throw new Error("original authority closed");
          }
        },
      );
      if (scenario === "refresh failure" || scenario === "authority changed") {
        const error: unknown = await execution.catch((failure: unknown) => failure);
        expect(
          error,
          JSON.stringify({
            events,
            environment: service.get(worker.ENVIRONMENT_ID),
            placement: worker.placements.get(worker.SESSION_ID),
          }),
        ).toMatchObject({
          message: expect.stringContaining(
            scenario === "refresh failure"
              ? "current launch capability"
              : "original authority closed",
          ),
        });
        expect(tunnelLaunch).not.toHaveBeenCalled();
      } else {
        await expect(execution).resolves.toMatchObject({
          payloads: [{ text: "Retained worker continued" }],
        });
        expect(tunnelLaunch).toHaveBeenCalledOnce();
        expect(claimTurn).toHaveBeenCalledTimes(scenario === "current bundle" ? 1 : 2);
        expect(events).toEqual(
          scenario === "current bundle"
            ? ["launch"]
            : ["resume", "connected", "stop", "install", "launch"],
        );
      }
      await waitForSessionRunEnd(worker.SESSION_ID, null);
      expect(await fs.readFile(workspaceFile, "utf8")).toBe("Original retained workspace");
      const messages = (await worker.openSessionManager()).buildSessionContext().messages;
      expect(JSON.stringify(messages)).toContain("Original retained history");
      expect(messages.filter((message) => message.role === "user")).toHaveLength(
        scenario === "missing feature" || scenario === "current bundle" ? 1 : 0,
      );
      expect(service.get(worker.ENVIRONMENT_ID)).toMatchObject({
        state: "attached",
        leaseId: original.leaseId,
        ownerEpoch: worker.OWNER_EPOCH,
        nodeDeviceId: "retained-node",
      });
      expect(worker.placements.get(worker.SESSION_ID)).toMatchObject({
        state: "active",
        environmentId: placement.environmentId,
        activeOwnerEpoch: placement.activeOwnerEpoch,
        generation: placement.generation,
        remoteWorkspaceDir: "/retained/workspace",
        turnClaim: null,
      });
      expect(provision).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(runLocal).not.toHaveBeenCalled();
    } finally {
      input.preparedRunAdmission.close();
      await service.stop();
    }
  },
);
import fs from "node:fs/promises";
import path from "node:path";
