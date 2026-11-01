import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { WorkerExecutionMode, WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createCoreGatewayMethodDescriptors } from "../methods/core-method-policy.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { environmentsHandlers } from "../server-methods/environments.js";
import { dispatchGatewayMethodInProcess } from "../server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { readWorkerProjectPreparation } from "./preparation-identity.schema.js";
import * as support from "./service.test-support.js";
import * as workspaceGitBase from "./workspace-git-base.js";

describe("on-demand prepared worker admission", () => {
  support.setupWorkerEnvironmentServiceSuite();

  async function fixture() {
    const projectPath = path.join(support.testState.root, "project");
    await fs.mkdir(projectPath);
    await requireGit(projectPath, ["init", "--quiet"]);
    await requireGit(projectPath, ["config", "user.name", "Project Test"]);
    await requireGit(projectPath, ["config", "user.email", "project@example.invalid"]);
    await requireGit(projectPath, ["config", "commit.gpgsign", "false"]);
    await fs.mkdir(path.join(projectPath, ".openclaw"));
    await fs.writeFile(path.join(projectPath, ".openclaw/worktree-setup.sh"), "#!/bin/sh\ntrue\n", {
      mode: 0o755,
    });
    await requireGit(projectPath, ["add", "."]);
    await requireGit(projectPath, ["commit", "--quiet", "-m", "base"]);
    const provision = vi.fn<WorkerProvider["provision"]>(async () => {
      throw new Error("Synthetic provider unavailable");
    });
    const provider = support.createProvider({
      requiresNodeEnrollment: true,
      provisionBeforeInstallation: true,
      supportedExecutionModes: ["worker-turn", "remote-exec"],
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: () => ({ machineClass: "small", platform: "linux", arch: "x64" }),
      resolvePreparedIdleTimeoutMs: () => 10_000,
      provision,
    });
    const prepareNodeArtifacts = vi.fn(async (profileSnapshot: WorkerProfile) => ({
      artifacts: {
        nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
        enabledPluginIds: profileSnapshot.executionMode === "remote-exec" ? ["runtime-plugin"] : [],
        workerBundleHash: support.BUNDLE_HASH,
        workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
        openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
        protocolFeatures: [],
      },
      assertCurrent: () => {},
    }));
    const service = support.createService(provider, {
      projectNamespace: "gateway-test",
      prepareNodeEnrollment: async () => {
        throw new Error("Synthetic provider must not enroll");
      },
      prepareNodeArtifacts,
    });
    return {
      service,
      provider,
      projectPath,
      provision,
      prepareNodeArtifacts,
      request: { profileId: "development", projectPath },
    };
  }

  it.each<{ executionMode?: WorkerExecutionMode; runSetupScript?: false }>([
    {},
    { executionMode: "worker-turn" },
    { executionMode: "remote-exec" },
    { executionMode: "remote-exec", runSetupScript: false },
  ])(
    "admits HEAD with mode $executionMode and profile setup policy $runSetupScript",
    async ({ executionMode, runSetupScript }) => {
      const f = await fixture();
      if (runSetupScript === false) {
        support.getDevelopmentProfile().runSetupScript = false;
      }
      await f.service.ready();
      support.getDevelopmentProfile().readyWorkers = 0;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const provision = expectDefined(
        f.provision.getMockImplementation(),
        "provider implementation",
      );
      f.provision.mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return await provision(...args);
      });
      try {
        const result = await f.service.prepare({
          ...f.request,
          ...(executionMode ? { executionMode } : {}),
        });
        // Provider entry follows the committed provisioning transition; hold it during reads.
        await entered.promise;
        const baseCommit = await requireGit(f.projectPath, ["rev-parse", "HEAD"]);
        const record = support.testState.store.get(result.environmentId)!;
        expect(result).toEqual({
          environmentId: record.environmentId,
          preparationKey: record.preparation!.key,
          cacheKey: readWorkerProjectPreparation(record.profileSnapshot.project)!.cacheKey,
          reused: false,
        });
        expect(record).toMatchObject({
          profileId: "development",
          attachedSessionIds: [],
          profileSnapshot: {
            executionMode: executionMode ?? "worker-turn",
            project: {
              root: f.projectPath,
              baseCommit,
            },
          },
          preparation: {
            purpose: "build",
            demandAtMs: 1_000,
            expiresAtMs: 11_000,
            consumedAtMs: null,
          },
        });
        expect(
          readWorkerProjectPreparation(record.profileSnapshot.project)?.artifacts.enabledPluginIds,
        ).toEqual(executionMode === "remote-exec" ? ["runtime-plugin"] : []);
        expect(record.profileSnapshot.runSetupScript).toBe(runSetupScript);
        expect(readWorkerProjectPreparation(record.profileSnapshot.project)?.runSetupScript).toBe(
          runSetupScript,
        );
        expect(readWorkerProjectPreparation(record.profileSnapshot.project)?.setupRecipe).toMatch(
          /^[a-f0-9]{40}$/u,
        );
        expect(f.provision).toHaveBeenCalledOnce();
        expect(support.testState.store.get(record.environmentId)?.destroyRequestedAtMs).toBeNull();
        expect(f.service.list()[0]?.preparation).toEqual({
          purpose: "build",
          key: result.preparationKey,
          demandAtMs: 1_000,
          expiresAtMs: 11_000,
          consumedAtMs: null,
          project: { label: "project", baseCommit },
        });
      } finally {
        release.resolve();
        await f.service.stop();
      }
    },
  );

  it("rejects an unsupported explicit mode before source, artifacts, or provider effects", async () => {
    const f = await fixture();
    f.provider.supportedExecutionModes = ["worker-turn"];
    const source = vi.spyOn(workspaceGitBase, "prepareWorkerProjectSnapshot");
    await expect(
      f.service.prepare({ ...f.request, executionMode: "remote-exec" }),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
    expect(source).not.toHaveBeenCalled();
    expect(f.prepareNodeArtifacts).not.toHaveBeenCalled();
    expect(f.provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toHaveLength(0);
  });

  it("uses the admitted profile's idle timeout after configuration changes during Git validation", async () => {
    const f = await fixture();
    f.provider.resolvePreparedIdleTimeoutMs = (settings) =>
      typeof settings.idleTimeoutMs === "number" ? settings.idleTimeoutMs : 10_000;
    const original = workspaceGitBase.prepareWorkerProjectSnapshot;
    const snapshot = vi
      .spyOn(workspaceGitBase, "prepareWorkerProjectSnapshot")
      .mockImplementationOnce(async (params) => {
        const project = await original(params);
        support.testState.config.cloudWorkers!.profiles!.development = {
          ...support.getDevelopmentProfile(),
          settings: { region: "test", idleTimeoutMs: 20_000 },
        };
        return project;
      });
    try {
      const result = await f.service.prepare(f.request);
      expect(support.testState.store.get(result.environmentId)?.preparation?.expiresAtMs).toBe(
        21_000,
      );
    } finally {
      snapshot.mockRestore();
    }
  });

  it.each(["reserve"] as const)(
    "cancels an in-flight %s while retaining cleanup ownership until the provider settles",
    async () => {
      const f = await fixture();
      const entered = createDeferredCore<AbortSignal>();
      const release = createDeferredCore();
      let provisionSettled = false;
      f.provision.mockImplementation(async (_profile, _operation, options) => {
        const signal = options!.signal!;
        entered.resolve(signal);
        try {
          await release.promise;
          signal.throwIfAborted();
          throw new Error("Synthetic provider unavailable");
        } finally {
          provisionSettled = true;
        }
      });
      const destroyProvider = vi.fn(async () => {
        expect(provisionSettled).toBe(true);
      });
      f.provider.destroy = destroyProvider;
      const intent = await f.service.prepareProjectIntent("development", {
        projectPath: f.projectPath,
        executionMode: "worker-turn",
        setupAuthorized: true,
      });
      const { environmentId } = await support.testState.store.createIntent({
        environmentId: "automatic-reserve",
        provisionOperationId: "automatic-reserve-operation",
        providerId: intent.providerId,
        profileId: "development",
        profileSnapshot: intent.profileSnapshot,
        preparation: {
          purpose: "reserve",
          key: intent.profileSnapshot.project!.preparation!.key,
          demandAtMs: 1_000,
          expiresAtMs: 11_000,
        },
      });
      f.service.schedulePreparedRefill();
      const signal = await entered.promise;
      const cancelled = new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      const destroyed = f.service.destroyUnattached(environmentId);
      try {
        await cancelled;
        expect(support.testState.store.get(environmentId)?.destroyRequestedAtMs).toBe(
          support.testState.nowMs,
        );
        expect(signal.aborted).toBe(true);
        expect(destroyProvider).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await destroyed;
      }
      expect(support.testState.store.get(environmentId)?.state).toBe("destroyed");
      expect(destroyProvider).toHaveBeenCalledOnce();
    },
  );

  it("deduplicates concurrent fresh builds and fails closed at the global cap", async () => {
    const f = await fixture();
    support.testState.config.cloudWorkers!.preparedPool = { maxTotal: 1 };
    const results = await Promise.all([f.service.prepare(f.request), f.service.prepare(f.request)]);
    expect(new Set(results.map((result) => result.environmentId)).size).toBe(1);
    expect(results.filter((result) => result.reused)).toHaveLength(1);
    await requireGit(f.projectPath, ["commit", "--allow-empty", "--quiet", "-m", "next"]);
    await expect(f.service.prepare(f.request)).rejects.toMatchObject({ code: "capacity" });
    expect(support.testState.store.list()).toHaveLength(1);
    const first = results[0]!;
    await f.service.destroyUnattached(first.environmentId);
    expect(support.testState.store.get(first.environmentId)?.state).toBe("destroyed");
    const next = await f.service.prepare(f.request);
    expect(next.preparationKey).not.toBe(first.preparationKey);
    expect(next.cacheKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(next.cacheKey).toBe(first.cacheKey);
  });

  it.each([
    { revoked: false, retained: false },
    { revoked: true, retained: false },
    { revoked: false, retained: true },
    { revoked: true, retained: true },
  ])(
    "enforces the original Gateway source at durable admission with revoked=$revoked retained=$retained",
    async ({ revoked, retained }) => {
      const f = await fixture();
      const profile = support.getDevelopmentProfile();
      profile.readyWorkers = retained ? 1 : 0;
      if (retained) {
        profile.retention = { mode: "session-disk", computeWindowSeconds: 14400 };
        f.provider.supportsRetainedProjectImages = () => true;
        support.testState.config.cloudWorkers!.preparedPool = { maxTotal: 1 };
        expect(f.service.readReadyWorkerTarget("development")).toBe(0);
      }
      const context = createContext();
      context.resolveGatewayContext = () => context;
      context.getRuntimeConfig = () => support.testState.config;
      context.workerEnvironmentService = f.service;
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry(createCoreGatewayMethodDescriptors(environmentsHandlers));
      const client = createOperatorClient({
        profileName: "preparation-operator",
        scopes: ["operator.admin"],
      });
      const controller = new AbortController();
      const source = expectDefined(
        await captureGatewayOperatorRunAuthority({
          client,
          context,
          sourceAuthority: {
            signal: controller.signal,
            assertCurrent: () => controller.signal.throwIfAborted(),
          },
        }),
        "original preparation source",
      );
      client.internal = { operatorRunAuthority: source.authority };
      f.provider.resolvePreparationTarget = () => {
        if (revoked) {
          controller.abort(new Error("Original preparation source revoked"));
        }
        return { machineClass: "small", platform: "linux" as const, arch: "x64" as const };
      };
      try {
        const request = withPluginRuntimeGatewayRequestScope(
          { context, client, isWebchatConnect: () => false },
          () =>
            dispatchGatewayMethodInProcess<{ environmentId: string; reused: boolean }>(
              "environments.prepare",
              { ...f.request, executionMode: "remote-exec" },
            ),
        );
        if (revoked) {
          await expect(request).rejects.toThrow();
          expect(support.testState.store.list()).toHaveLength(0);
          expect(f.provision).not.toHaveBeenCalled();
        } else {
          const result = await request;
          expect(result.reused).toBe(false);
          expect(
            support.testState.store.get(result.environmentId)?.profileSnapshot.executionMode,
          ).toBe("remote-exec");
          expect(support.testState.store.get(result.environmentId)?.preparation?.purpose).toBe(
            "build",
          );
          await support.waitForFast(() => expect(f.provision).toHaveBeenCalledOnce());
        }
      } finally {
        source.release();
      }
    },
  );

  it.each(["missing-profile", "unsupported", "no-timeout", "missing-path", "subdirectory"])(
    "rejects %s before admitting a build",
    async (scenario) => {
      const f = await fixture();
      let code = "invalid_project";
      if (scenario === "missing-profile") {
        f.request.profileId = "missing";
        code = "profile_not_found";
      } else if (scenario === "unsupported") {
        f.provider.supportsProjectPreparation = () => false;
        code = "invalid_profile";
      } else if (scenario === "no-timeout") {
        f.provider.resolvePreparedIdleTimeoutMs = () => undefined;
        code = "invalid_profile";
      } else if (scenario === "missing-path") {
        f.request.projectPath = path.join(support.testState.root, "missing");
      } else {
        f.request.projectPath = path.join(f.projectPath, ".openclaw");
      }
      await expect(f.service.prepare(f.request)).rejects.toMatchObject({ code });
      expect(support.testState.store.list()).toHaveLength(0);
      expect(f.provision).not.toHaveBeenCalled();
    },
  );
});
