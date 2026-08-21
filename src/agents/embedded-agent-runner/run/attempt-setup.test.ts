import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type ResolveSandboxContext = typeof import("../../sandbox.js").resolveSandboxContext;

const resolveProviderRuntimePluginHandle = vi.hoisted(() => vi.fn());
const resolveSandboxContext = vi.hoisted(() => vi.fn<ResolveSandboxContext>(async () => null));
const createAuthorizedMemoryReadHost = vi.hoisted(() => vi.fn());
const resolveAuthorizedMemoryVirtualFileBroker = vi.hoisted(() => vi.fn());
const stageAuthorizedVirtualProjectionMountPlan = vi.hoisted(() => vi.fn());

vi.mock("../../../plugins/provider-hook-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/provider-hook-runtime.js")>()),
  resolveProviderRuntimePluginHandle,
}));

vi.mock("../../sandbox.js", () => ({ resolveSandboxContext }));

vi.mock("../../memory-authorized-read-host.js", () => ({
  createAuthorizedMemoryReadHost,
  resolveAuthorizedMemoryVirtualFileBroker,
}));

vi.mock("../../sandbox/authorized-virtual-projection-staging.js", () => ({
  stageAuthorizedVirtualProjectionMountPlan,
}));

import { prepareEmbeddedAttemptSetup, resolveAttemptWorkspaceSandbox } from "./attempt-setup.js";

describe("prepareEmbeddedAttemptSetup", () => {
  beforeEach(() => {
    resolveProviderRuntimePluginHandle.mockReset();
    resolveSandboxContext.mockClear();
    createAuthorizedMemoryReadHost.mockReset();
    createAuthorizedMemoryReadHost.mockReturnValue(undefined);
    resolveAuthorizedMemoryVirtualFileBroker.mockReset();
    resolveAuthorizedMemoryVirtualFileBroker.mockResolvedValue(undefined);
    stageAuthorizedVirtualProjectionMountPlan.mockReset();
  });

  it("prepares the default and session agent identities together", async () => {
    const setup = await prepareEmbeddedAttemptSetup({
      config: {
        agents: {
          list: [{ id: "main", default: true }, { id: "marketing" }],
        },
      },
      modelId: "gpt-5.4",
      provider: "openai",
      runId: "run-prepared-agent-identities",
      sessionId: "session-prepared-agent-identities",
      sessionKey: "agent:marketing:main",
      thinkLevel: "high",
      timeoutMs: 30_000,
      workspaceDir: path.join(os.tmpdir(), "openclaw-attempt-setup-agent-identities"),
    } as unknown as EmbeddedRunAttemptParams);

    expect(setup.defaultAgentId).toBe("main");
    expect(setup.sessionAgentId).toBe("marketing");
  });

  it("passes the resolved skill snapshot into sandbox synchronization", async () => {
    const skillsSnapshot = {
      prompt: "skills",
      skills: [{ name: "alpha" }],
      resolvedSkills: [],
      version: 42,
    };

    await prepareEmbeddedAttemptSetup({
      config: {},
      modelId: "gpt-5.4",
      provider: "openai",
      runId: "run-sandbox-skills",
      sessionId: "session-sandbox-skills",
      sessionKey: "agent:main:main",
      skillsSnapshot,
      thinkLevel: "high",
      timeoutMs: 30_000,
      workspaceDir: path.join(os.tmpdir(), "openclaw-attempt-setup-sandbox-skills"),
    } as unknown as EmbeddedRunAttemptParams);

    expect(resolveSandboxContext).toHaveBeenCalledWith(expect.objectContaining({ skillsSnapshot }));
  });

  it.each(["ro", "rw"] as const)(
    "keeps collection review on the host workspace with %s sandbox access",
    async (workspaceAccess) => {
      const workspaceDir = path.join(os.tmpdir(), "openclaw-attempt-setup-collection-review");
      const setup = await resolveAttemptWorkspaceSandbox({
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "all", workspaceAccess } } } },
        sessionId: "session-collection-review",
        sessionKey: "agent:main:skill-collection-review",
        skillWorkshopCollectionReconcile: {},
        workspaceDir,
      });

      expect(resolveSandboxContext).not.toHaveBeenCalled();
      expect(setup.effectiveWorkspace).toBe(workspaceDir);
    },
  );

  it("reuses lifecycle metadata and the provider handle from the runtime plan", async () => {
    const metadataSnapshot = { plugins: [] } as never;
    const workspaceDir = path.join(os.tmpdir(), "openclaw-attempt-setup-prepared");
    const providerRuntimeHandle: ProviderRuntimePluginHandle & { prepared: true } = {
      provider: "openai",
      modelId: "gpt-5.4",
      prepared: true,
      workspaceDir,
      plugin: {} as never,
    };
    const setup = await prepareEmbeddedAttemptSetup({
      config: {},
      modelId: "gpt-5.4",
      provider: "openai",
      runId: "run-prepared",
      sessionId: "session-prepared",
      thinkLevel: "high",
      timeoutMs: 30_000,
      workspaceDir,
      preparedModelRuntime: { metadataSnapshot } as never,
      runtimePlan: { providerRuntimeHandle } as never,
    } as unknown as EmbeddedRunAttemptParams);

    expect(setup.getCurrentAttemptPluginMetadataSnapshot()).toBe(metadataSnapshot);
    expect(setup.getProviderRuntimeHandle()).toBe(providerRuntimeHandle);
    expect(resolveProviderRuntimePluginHandle).not.toHaveBeenCalled();
  });

  it("resolves partial handles without trusting scoped metadata", async () => {
    const resolvedHandle: ProviderRuntimePluginHandle = {
      provider: "openai",
      modelId: "gpt-5.4",
    };
    resolveProviderRuntimePluginHandle.mockReturnValue(resolvedHandle);
    const setup = await prepareEmbeddedAttemptSetup({
      config: {},
      modelId: "gpt-5.4",
      provider: "openai",
      runId: "run-partial",
      sessionId: "session-partial",
      thinkLevel: "high",
      timeoutMs: 30_000,
      workspaceDir: path.join(os.tmpdir(), "openclaw-attempt-setup-partial"),
      preparedModelRuntime: {
        metadataSnapshot: { pluginIds: ["other"] },
      } as never,
      runtimePlan: { providerRuntimeHandle: { provider: "openai" } } as never,
    } as unknown as EmbeddedRunAttemptParams);

    const preparedHandle = setup.getProviderRuntimeHandle();
    expect(preparedHandle).toMatchObject(resolvedHandle);
    expect(preparedHandle.modelId).toBe("gpt-5.4");
    expect(setup.getProviderRuntimeHandle()).toBe(preparedHandle);
    expect(resolveProviderRuntimePluginHandle).toHaveBeenCalledOnce();
    const call = resolveProviderRuntimePluginHandle.mock.calls[0]?.[0];
    expect(call).toMatchObject({ provider: "openai", modelId: "gpt-5.4" });
    expect(call).not.toHaveProperty("pluginMetadataSnapshot");
  });

  it("uses one admission-bound host and broker when a sandbox stages a projection", async () => {
    const sandboxRoot = path.join(os.tmpdir(), "openclaw-attempt-setup-projection-sandbox");
    const host = {} as never;
    const broker = {
      view: { viewId: "view-1", roots: [], files: [], revision: "revision-1" },
      readFile: vi.fn(),
    } as never;
    const dispose = vi.fn(async () => {});
    const staged = {
      plan: { version: 1, viewId: "view-1", revision: "revision-1", mounts: [] },
      dispose,
    };
    createAuthorizedMemoryReadHost.mockReturnValue(host);
    resolveAuthorizedMemoryVirtualFileBroker.mockResolvedValue(broker);
    stageAuthorizedVirtualProjectionMountPlan.mockResolvedValue(staged);
    resolveSandboxContext.mockImplementation(async (input) => {
      await input.prepareAuthorizedVirtualProjectionMountPlan?.({
        agentWorkspaceDir: path.join(sandboxRoot, "agent"),
      });
      return {
        enabled: true,
        workspaceAccess: "ro",
        workspaceDir: path.join(sandboxRoot, "workspace"),
        disposeAuthorizedVirtualProjectionMountPlan: dispose,
      } as never;
    });

    const setup = await resolveAttemptWorkspaceSandbox({
      agentId: "main",
      config: {},
      messageChannel: "telegram",
      messageTo: "dm:alice",
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:alice",
      workspaceDir: path.join(os.tmpdir(), "openclaw-attempt-setup-projection"),
    });

    expect(createAuthorizedMemoryReadHost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:telegram:direct:alice",
      }),
    );
    expect(resolveAuthorizedMemoryVirtualFileBroker).toHaveBeenCalledWith(host);
    expect(stageAuthorizedVirtualProjectionMountPlan).toHaveBeenCalledWith({
      agentWorkspaceDir: path.join(sandboxRoot, "agent"),
      broker,
    });
    expect(setup.authorizedMemoryRead).toBe(host);
    expect(setup.authorizedMemoryVirtualBroker).toBe(broker);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("disposes post-provisioning native projection staging when setup later rejects", async () => {
    const dispose = vi.fn(async () => {});
    resolveSandboxContext.mockResolvedValue({
      enabled: true,
      workspaceAccess: "ro",
      workspaceDir: "/sandbox/workspace",
      disposeAuthorizedVirtualProjectionMountPlan: dispose,
    } as never);

    await expect(
      resolveAttemptWorkspaceSandbox({
        agentId: "main",
        config: {},
        cwd: path.join(os.tmpdir(), "other-cwd"),
        sessionId: "session-1",
        sessionKey: "agent:main:telegram:direct:alice",
        workspaceDir: path.join(os.tmpdir(), "openclaw-attempt-setup-native-dispose"),
      }),
    ).rejects.toThrow(/cwd override is not supported/);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
