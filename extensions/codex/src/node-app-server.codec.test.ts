import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { setManagedCodexPluginRoot } from "./app-server/managed-binary.js";
import { createCodexWorkerClientFactory } from "./app-server/node-app-server-transport.js";
import * as transport from "./app-server/transport-stdio.js";
import { useCodexWorkerProvisioningFixture } from "./node-app-server-command.test-support.js";
import {
  createCodexNodeAppServerCommand,
  createCodexNodeAppServerInvokePolicy,
} from "./node-app-server.js";

type NodeCommandContext = NonNullable<Parameters<OpenClawPluginNodeHostCommand["handle"]>[2]>;
const provision = useCodexWorkerProvisioningFixture();
afterEach(() => {
  vi.restoreAllMocks();
  setManagedCodexPluginRoot(undefined);
});

it.each([
  "new-retained",
  "existing-retained",
  "missing-state",
  "unknown-field",
  "wrong-flag",
  "wrong-required-flag",
  "missing-identity",
  "no-full-authority",
] as const)("keeps retained worker transport/policy/receiver custody (%s)", async (scenario) => {
  const bundle = provision();
  const root = resolveStateDir();
  const runtimeDir = path.join(root, "codex-runtime");
  await fs.mkdir(runtimeDir, { mode: 0o700 });
  const helper = path.join(runtimeDir, path.basename(bundle.helperPath));
  await fs.writeFile(helper, bundle.helperScript, { mode: 0o600 });
  await fs.writeFile(
    path.join(runtimeDir, "config.toml"),
    bundle.configToml.replace(bundle.helperPath, helper),
    { mode: 0o600 },
  );
  await fs.writeFile(path.join(runtimeDir, "version"), bundle.configVersion, { mode: 0o600 });
  setManagedCodexPluginRoot(fileURLToPath(new URL("../", import.meta.url)));
  const workspaceDir = path.join(root, "repository");
  const homeDir = path.join(root, "owned-home");
  await fs.mkdir(workspaceDir);
  await fs.mkdir(homeDir);
  const sessionId = "retained-session";
  const nativeHome = path.join(
    homeDir,
    ".openclaw-worker",
    "codex",
    createHash("sha256").update(sessionId).digest("hex"),
  );
  if (scenario === "existing-retained") {
    await fs.mkdir(nativeHome, { recursive: true });
    await fs.writeFile(path.join(nativeHome, "original-state"), "preserve native state");
  }
  const launch = new Error("Authorized native subprocess boundary");
  const spawn = vi.spyOn(transport, "createStdioTransport").mockRejectedValue(launch);
  const release = vi.fn();
  const acquire = vi.fn<NonNullable<NodeCommandContext["acquireManagedWorkspaceAsync"]>>(
    async (identity) => {
      expect(identity).toMatchObject({
        workspaceDir,
        environmentId: "retained-environment",
        sessionId,
        ownerEpoch: 745,
        sessionKey: "agent:main:retained",
        retainedSession: true,
      });
      return { workspaceDir, homeDir, release };
    },
  );
  const command = createCodexNodeAppServerCommand();
  const policy = createCodexNodeAppServerInvokePolicy();
  const full = vi.fn<
    NonNullable<OpenClawPluginNodeInvokePolicyContext["invokeNodeWithSessionFull"]>
  >(async ({ createParams }) => {
    await command.handle(
      JSON.stringify(createParams()),
      {
        signal: new AbortController().signal,
        emitChunk: async () => {},
        onInput: () => {},
        frames: { send: async () => {}, onMessage: () => () => {} },
      },
      {
        sessionKey: "agent:main:retained",
        sendNodeEvent: async () => {},
        prepareExecAuthorization: (source) => {
          expect(source).toBe("session-full");
          return () => {};
        },
        acquireManagedWorkspaceAsync: acquire,
      },
    );
    return { ok: true };
  });
  const runtime: Pick<PluginRuntime, "nodes"> = {
    nodes: {
      list: async () => {
        throw new Error("Unexpected discovery");
      },
      invoke: async () => {
        throw new Error("Unexpected unary invocation");
      },
      openDuplex: async (request) => {
        if (!isRecord(request.params) || !isRecord(request.params.placement)) {
          throw new Error("Missing transport request");
        }
        const placement = { ...request.params.placement };
        if (scenario === "unknown-field") {
          placement.unknownFlag = true;
        }
        if (scenario === "wrong-flag") {
          placement.retainedSession = false;
        }
        if (scenario === "wrong-required-flag") {
          placement.requireExistingNativeState = "true";
        }
        if (scenario === "missing-identity") {
          delete placement.ownerEpoch;
        }
        const result = await policy.handle({
          nodeId: request.nodeId,
          command: request.command,
          params: { ...request.params, placement },
          config: {},
          risk: { level: "high", family: "codex.app-server" },
          invokeNode: async () => {
            throw new Error("Unexpected approval fallback");
          },
          ...(scenario === "no-full-authority" ? {} : { invokeNodeWithSessionFull: full }),
        });
        throw new Error(result.ok ? "Unexpected node result" : result.message);
      },
    },
  };
  const requiresState = scenario === "existing-retained" || scenario === "missing-state";
  const sandbox = {
    ...createSandboxTestContext(),
    containerWorkdir: workspaceDir,
    sessionKey: "agent:main:retained",
    placementNodeId: "retained-node",
    placementEnvironmentId: "retained-environment",
    placementSessionId: sessionId,
    placementOwnerEpoch: 745,
    placementRetainedSession: true,
    ...(requiresState ? { placementRequireExistingNativeState: true } : {}),
  };
  const factory = createCodexWorkerClientFactory({
    runtime,
    permissionMode: "full",
    sandbox,
    signal: new AbortController().signal,
    assertCurrent: () => {},
  });
  if (scenario === "new-retained" || scenario === "existing-retained") {
    await expect(factory()).rejects.toBe(launch);
    expect(spawn).toHaveBeenCalledOnce();
    if (scenario === "existing-retained") {
      expect(await fs.readFile(path.join(nativeHome, "original-state"), "utf8")).toBe(
        "preserve native state",
      );
    }
  } else {
    await expect(factory()).rejects.toThrow(
      scenario === "missing-state"
        ? "Retained Codex session home is missing"
        : "current Full placement",
    );
    expect(spawn).not.toHaveBeenCalled();
  }
  const admitted = ["new-retained", "existing-retained", "missing-state"].includes(scenario);
  expect(acquire).toHaveBeenCalledTimes(admitted ? 1 : 0);
  expect(release).toHaveBeenCalledTimes(admitted ? 1 : 0);
  expect(full).toHaveBeenCalledTimes(admitted ? 1 : 0);
});
