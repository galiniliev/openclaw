import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SandboxBackendHandle } from "../../agents/sandbox/backend-handle.types.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { createSandboxFsBridge } from "../../agents/sandbox/fs-bridge.js";
import { createPreprovisionedSshSandboxBackend } from "../../agents/sandbox/ssh-backend.js";
import type { SandboxConfig, SandboxContext } from "../../agents/sandbox/types.js";
import type {
  PreparedSessionPlacementSandbox,
  SessionPlacementSandboxParams,
} from "../../agents/session-placement-admission.js";
import { resolveSessionSkillResourceMounts } from "../../agents/session-placement-skill-resources.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import {
  assertWorkerSandboxEnvironment,
  isWorkerEnvironmentAttachedTo,
} from "./placement-target.js";
import type { WorkerEnvironmentService } from "./service.js";
import { resolveWorkerSshSandboxSettings } from "./ssh.js";
import type { WorkerTurnLauncherOptions } from "./worker-turn-launcher.types.js";

type ActiveRemoteExecPlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;

type PlacementSandboxEnvironmentService = Pick<WorkerEnvironmentService, "get"> &
  Partial<Pick<WorkerEnvironmentService, "resolveSshIdentity">>;

type RemoteExecPlacementSandbox = SandboxContext & {
  placementExecutionMode: "remote-exec";
} & (
    | {
        backendId: "node";
        placementNodeId: string;
        placementEnvironmentId: string;
        placementSessionId: string;
        placementOwnerEpoch: number;
        placementRetainedSession?: true;
        placementRequireExistingNativeState?: true;
      }
    | {
        backendId: "ssh";
        backend: SandboxBackendHandle;
        placementNodeId?: never;
        placementEnvironmentId?: never;
        placementSessionId?: never;
        placementOwnerEpoch?: never;
      }
  );

function requireRemoteWorkspaceDir(value: string, nodeCarrier: boolean): string {
  // Paired nodes report their own native paths, which can differ from the Gateway platform.
  const windowsPath = nodeCarrier && /^[A-Za-z]:/u.test(value) && value[2] === "\\";
  const remotePath = windowsPath ? path.win32 : path.posix;
  if (
    !remotePath.isAbsolute(value) ||
    remotePath.parse(value).root === value ||
    remotePath.normalize(value) !== value ||
    value.endsWith(remotePath.sep) ||
    (nodeCarrier && (windowsPath ? value.includes("/") : value.includes("\\")))
  ) {
    throw new Error("Remote-exec placement has an invalid managed workspace path");
  }
  return value;
}

/** Builds the node or SSH sandbox owned by one exact active placement generation. */
export async function createRemoteExecPlacementSandbox(params: {
  config?: OpenClawConfig;
  environments: PlacementSandboxEnvironmentService;
  workspaceDir: string;
  placement: ActiveRemoteExecPlacement;
}): Promise<RemoteExecPlacementSandbox> {
  const { placement } = params;
  if (placement.executionMode !== "remote-exec") {
    throw new Error(`Cloud placement ${placement.sessionId} is not a remote-exec placement`);
  }
  const environment = params.environments.get(placement.environmentId);
  if (
    !isWorkerEnvironmentAttachedTo(environment, placement) ||
    environment.environmentId !== placement.environmentId ||
    !environment.leaseId ||
    Boolean(environment.nodeDeviceId) === Boolean(environment.sshEndpoint)
  ) {
    throw new Error(
      `Remote-exec placement ${placement.sessionId} has no matching active node or SSH environment`,
    );
  }

  const assertCurrentEnvironment = () => {
    const current = params.environments.get(environment.environmentId);
    if (
      !isWorkerEnvironmentAttachedTo(current, {
        sessionId: placement.sessionId,
        activeOwnerEpoch: environment.ownerEpoch,
      }) ||
      current.environmentId !== environment.environmentId ||
      current.leaseId !== environment.leaseId ||
      current.nodeDeviceId !== environment.nodeDeviceId ||
      !isDeepStrictEqual(current.sshEndpoint, environment.sshEndpoint)
    ) {
      throw new Error(`Remote-exec placement ${placement.sessionId} lost its exact environment`);
    }
  };
  const remoteWorkspaceDir = requireRemoteWorkspaceDir(
    placement.remoteWorkspaceDir,
    Boolean(environment.nodeDeviceId),
  );
  const runtimeId = [
    "remote-exec",
    environment.environmentId,
    environment.ownerEpoch,
    placement.generation,
  ].join(":");
  const base = resolveSandboxConfigForAgent(params.config, placement.agentId);
  const { binds: _ignoredBinds, ...docker } = base.docker;
  const common = {
    enabled: true,
    placementExecutionMode: "remote-exec" as const,
    sessionKey: placement.sessionKey,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.workspaceDir,
    workspaceAccess: "rw" as const,
    readOnlyResourceMounts: resolveSessionSkillResourceMounts(),
    runtimeId,
    runtimeLabel: runtimeId,
    containerName: runtimeId,
    containerWorkdir: remoteWorkspaceDir,
    docker,
    tools: base.tools,
    browserAllowHostControl: false,
  };
  if (environment.nodeDeviceId) {
    // Node workspace ownership already belongs to the placement; JSON-RPC is its execution seam.
    assertCurrentEnvironment();
    return {
      ...common,
      nativeWorkerPlacement: {
        owner: {
          agentId: placement.agentId,
          sessionId: placement.sessionId,
          sessionKey: placement.sessionKey,
          environmentId: environment.environmentId,
          ownerEpoch: environment.ownerEpoch,
          ...(environment.retention
            ? { retentionOwnerBinding: environment.retention.ownerBinding }
            : {}),
        },
        ...(placement.confirmedLossRecovery ? { recovery: placement.confirmedLossRecovery } : {}),
      },
      backendId: "node",
      placementNodeId: environment.nodeDeviceId,
      placementEnvironmentId: environment.environmentId,
      placementSessionId: placement.sessionId,
      placementOwnerEpoch: environment.ownerEpoch,
      ...(environment.retention
        ? {
            placementRetainedSession: true as const,
            ...(environment.retention.receipt?.computeWindow.id !== environment.leaseId
              ? { placementRequireExistingNativeState: true as const }
              : {}),
          }
        : {}),
    };
  }
  const sshEndpoint = environment.sshEndpoint;
  const resolveSshIdentity = params.environments.resolveSshIdentity;
  if (!sshEndpoint || !resolveSshIdentity) {
    throw new Error("Remote-exec SSH sandbox identity resolver is unavailable");
  }
  const identity = await resolveSshIdentity(environment.environmentId);
  assertCurrentEnvironment();
  const ssh = resolveWorkerSshSandboxSettings({ ssh: sshEndpoint, identity });
  const cfg: SandboxConfig = {
    ...base,
    mode: "all",
    backend: "ssh",
    scope: "session",
    workspaceAccess: "rw",
    docker,
    ssh: {
      ...base.ssh,
      ...ssh,
      workspaceRoot: path.posix.dirname(remoteWorkspaceDir),
    },
    browser: { ...base.browser, enabled: false, allowHostControl: false },
    prune: { idleHours: 0, maxAgeDays: 0 },
  };
  const backend = await createPreprovisionedSshSandboxBackend(
    {
      sessionKey: placement.sessionKey,
      scopeKey: placement.sessionKey,
      workspaceDir: params.workspaceDir,
      agentWorkspaceDir: params.workspaceDir,
      cfg,
    },
    { runtimeId, remoteWorkspaceDir },
  );
  assertCurrentEnvironment();
  const sandbox: RemoteExecPlacementSandbox = { ...common, backendId: "ssh", backend };
  sandbox.fsBridge = backend.createFsBridge?.({ sandbox }) ?? createSandboxFsBridge({ sandbox });
  return sandbox;
}

export async function prepareRemoteExecPlacementSandbox(
  options: Pick<WorkerTurnLauncherOptions, "placements" | "environments" | "resolveWorkspace">,
  params: SessionPlacementSandboxParams,
): Promise<PreparedSessionPlacementSandbox> {
  using cleanup = new DisposableStack();
  const prepared = await options.placements.prepareRuntimeRefresh(params.sessionId);
  cleanup.defer(prepared.release);
  const retain = (
    sandbox: SandboxContext | null,
    assertCurrent = prepared.assertCurrent,
  ): PreparedSessionPlacementSandbox => {
    const lifetime = cleanup.move();
    return { sandbox, assertCurrent, [Symbol.dispose]: () => lifetime.dispose() };
  };
  const placement = prepared.placement;
  if (
    placement?.state !== "active" ||
    placement.executionMode !== "remote-exec" ||
    placement.agentId !== params.agentId ||
    placement.sessionKey !== params.sessionKey
  ) {
    return retain(null);
  }
  const workspace = await options.resolveWorkspace({
    sessionId: placement.sessionId,
    agentId: placement.agentId,
    sessionKey: placement.sessionKey,
  });
  prepared.assertCurrent();
  const sandbox = await createRemoteExecPlacementSandbox({
    config: params.config,
    environments: options.environments,
    workspaceDir: workspace.kind === "local" ? workspace.path : placement.remoteWorkspaceDir,
    placement,
  });
  const assertCurrent = () => {
    prepared.assertCurrent();
    const environment = options.environments.get(placement.environmentId);
    assertWorkerSandboxEnvironment(environment, placement, sandbox);
  };
  assertCurrent();
  return retain(sandbox, assertCurrent);
}
