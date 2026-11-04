import { afterAll, afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { VERSION } from "../../version.js";
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

const recoveryCases = [
  "missing feature",
  "current bundle",
  "refresh failure",
  "authority changed",
  "legacy receiver",
  "prepared receiver",
  "same-version worker-turn",
  "same-version remote-exec",
] as const;
it.each(recoveryCases)(
  "preserves the retained lease and exact worker owner through launch admission: %s",
  async (scenario) => {
    const legacy = scenario === "legacy receiver";
    const sameVersion = scenario.startsWith("same-version");
    const remoteExec = scenario === "same-version remote-exec";
    const executionMode = remoteExec ? ("remote-exec" as const) : ("worker-turn" as const);
    if (sameVersion) {
      const build = vi
        .spyOn(await import("../../version.js"), "resolveRuntimeServiceBuildId")
        .mockReturnValue("current-build");
      onTestFinished(() => build.mockRestore());
    }
    const olderReceiver = legacy || scenario === "prepared receiver" || sameVersion;
    let nodeVersion = sameVersion ? VERSION : olderReceiver ? "2026.10.6" : undefined;
    let nodeBuildId = sameVersion ? "previous-build" : undefined;
    const original = worker.attachedEnvironment();
    const receipt = original.bootstrapReceipt!;
    const installation = {
      ...BUNDLE_ARTIFACT,
      ...receipt,
      install: "bundle" as const,
      openclawVersion: VERSION,
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
        openclawVersion: scenario === "prepared receiver" ? "2026.10.6" : VERSION,
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
        ...(legacy ? {} : { runtimePreparation: { ...preparation, source: "image" } }),
      },
      bootstrapReceipt:
        scenario === "current bundle" || olderReceiver
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
      { ...worker.workerTurnRequest("capability-recovery"), executionMode },
      {
        environmentId: worker.ENVIRONMENT_ID,
        ownerEpoch: worker.OWNER_EPOCH,
        workerBundleHash:
          scenario === "current bundle" || olderReceiver
            ? installation.bundleHash
            : receipt.bundleHash,
        remoteWorkspaceDir: "/retained/workspace",
        seedEnvironment: false,
      },
    );
    const store = await createWorkerEnvironmentStore({ database: worker.database });
    const events: string[] = [];
    let connected = scenario === "current bundle" || olderReceiver;
    let current = true;
    const resumeNode = vi.fn(
      async (
        request: Parameters<NonNullable<ReturnType<typeof createProvider>["resumeNode"]>>[0],
      ) => {
        request.assertCurrent();
        if (olderReceiver) {
          expect(claimTurn).not.toHaveBeenCalled();
          expect(request.runtime?.nodeBootstrap.sha256).toBe("c".repeat(64));
          nodeVersion = VERSION;
          nodeBuildId = "current-build";
        }
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
        if (olderReceiver && nodeVersion !== VERSION) {
          throw new Error("invalid worker launch descriptor");
        }
        events.push("launch");
        request.onDispatchReady?.();
        return completeTurn(request, "Retained worker continued", 51);
      },
    );
    const tunnel = worker.createWorkerTurnTunnel({
      launchTurn: tunnelLaunch,
      reconcileWorkspace: worker.reconcileUnchangedLocalWorkspace,
      runWorkspaceCommand: async (request) => {
        request.assertCurrent?.();
        return {
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      },
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
          supportedExecutionModes: [executionMode],
          resumeNode,
          provision,
          destroy,
        }),
      prepareInstallation: async () => installation,
      prepareNodeRuntime: async (_record, _bundle, _signal, assertCurrent) => {
        assertCurrent?.();
        return {
          nodeBootstrap: {
            url: "https://example.test/node",
            token: "synthetic",
            sha256: "c".repeat(64),
            bytes: 1,
            openclawVersion: "2026.10.9",
            enabledPluginIds: [],
          },
          workerBundle: {
            url: "https://example.test/worker",
            token: "synthetic",
            sha256: "d".repeat(64),
            bytes: 1,
            packageRelativePath: "worker-artifacts/fixture.tgz",
          },
        };
      },
      closeNodeRuntime: () => {},
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
    if (remoteExec) {
      // Startup reconciliation mints the original attachment's tunnel credential.
      await service.reconcileEnvironment(worker.ENVIRONMENT_ID);
    }
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
      () => nodeVersion,
      () => nodeBuildId,
    );
    const dispatch = createProviderReplayDispatch({
      placements: worker.placements,
      environments: service,
      initialPlacements: await worker.placements.listAsync(),
      resolveWorkspace: async () => ({ kind: "local", path: worker.root }),
    });
    const claimTurn = vi.spyOn(worker.placements, "claimTurn");
    const runLocal = vi.fn(async () => {
      if (!remoteExec) {
        return localResult();
      }
      expect(nodeBuildId).toBe("current-build");
      expect(claimTurn).toHaveBeenCalledOnce();
      await inputRecorder.persistApproved({ cwd: worker.root });
      events.push("local");
      return { payloads: [{ text: "Retained worker continued" }], meta: { durationMs: 1 } };
    });
    const provider = worker.createWorkerSessionTurnPlacementProvider({
      placements: worker.placements,
      environments: service,
      waitForAdmissionNode: waiter.wait,
      reconcileActivePlacement: (id) => dispatch.reconcileActive(id),
    });
    const input = worker.turn("capability-recovery");
    const inputRecorder = createUserTurnTranscriptRecorder({
      target: { ...worker.sessionTarget, sessionEntry: undefined },
      input: { text: input.prompt },
    });
    await worker.appendWorkerReply("Original retained history", 1);
    const workspaceFile = path.join(worker.root, "retained.txt");
    await fs.writeFile(workspaceFile, "Original retained workspace");
    try {
      const execution = provider.executeTurn(
        worker.workerTurnRequest(input.runId),
        {
          ...input,
          userTurnTranscriptRecorder: inputRecorder,
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
        expect(tunnelLaunch).toHaveBeenCalledTimes(remoteExec ? 0 : 1);
        expect(claimTurn).toHaveBeenCalledTimes(
          scenario === "current bundle" || olderReceiver ? 1 : 2,
        );
        expect(events).toEqual(
          olderReceiver
            ? ["resume", "connected", remoteExec ? "local" : "launch"]
            : scenario === "current bundle"
              ? ["connected", "launch"]
              : ["resume", "connected", "connected", "stop", "install", "connected", "launch"],
        );
      }
      await waitForSessionRunEnd(worker.SESSION_ID, null);
      expect(await fs.readFile(workspaceFile, "utf8")).toBe("Original retained workspace");
      const messages = (await worker.openSessionManager()).buildSessionContext().messages;
      expect(JSON.stringify(messages)).toContain("Original retained history");
      expect(messages.filter((message) => message.role === "user")).toHaveLength(
        scenario === "missing feature" || scenario === "current bundle" || olderReceiver ? 1 : 0,
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
      expect(runLocal).toHaveBeenCalledTimes(remoteExec ? 1 : 0);
    } finally {
      input.preparedRunAdmission.close();
      await service.stop();
    }
  },
);
import fs from "node:fs/promises";
import path from "node:path";
