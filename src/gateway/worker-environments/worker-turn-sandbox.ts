import type { SandboxContext } from "../../agents/sandbox/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { matchesWorkerPlacementTarget } from "./placement-target.js";
import type { WorkerTurnLauncherOptions } from "./worker-turn-launcher.types.js";

const loadPlacementSandbox = createLazyRuntimeModule(() => import("./placement-sandbox.js"));

export async function resolveWorkerTurnSandbox(
  options: Pick<WorkerTurnLauncherOptions, "placements" | "environments" | "resolveWorkspace">,
  params: {
    agentId: string;
    config?: OpenClawConfig;
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
  },
): Promise<SandboxContext | null> {
  const placement = options.placements.get(params.sessionId);
  if (
    placement?.state !== "active" ||
    placement.executionMode !== "remote-exec" ||
    placement.agentId !== params.agentId ||
    placement.sessionKey !== params.sessionKey
  ) {
    return null;
  }
  const assertCurrentPlacement = (phase: "managed workspace" | "sandbox") => {
    const current = options.placements.get(params.sessionId);
    if (
      !matchesWorkerPlacementTarget(current, placement) ||
      current?.executionMode !== "remote-exec" ||
      current.agentId !== placement.agentId ||
      current.sessionKey !== placement.sessionKey
    ) {
      throw new Error(`Remote-exec placement changed while preparing its ${phase}`);
    }
  };
  const workspace = await options.resolveWorkspace({
    sessionId: placement.sessionId,
    agentId: placement.agentId,
    sessionKey: placement.sessionKey,
  });
  assertCurrentPlacement("managed workspace");
  const { createRemoteExecPlacementSandbox } = await loadPlacementSandbox();
  assertCurrentPlacement("sandbox");
  const sandbox = await createRemoteExecPlacementSandbox({
    config: params.config,
    environments: options.environments,
    workspaceDir: workspace.kind === "local" ? workspace.path : placement.remoteWorkspaceDir,
    placement,
  });
  assertCurrentPlacement("sandbox");
  const currentEnvironment = options.environments.get(placement.environmentId);
  if (
    currentEnvironment?.state !== "attached" ||
    currentEnvironment.environmentId !== placement.environmentId ||
    currentEnvironment.ownerEpoch !== placement.activeOwnerEpoch ||
    currentEnvironment.attachedSessionIds.length !== 1 ||
    currentEnvironment.attachedSessionIds[0] !== placement.sessionId ||
    (sandbox.backendId === "node" && currentEnvironment.nodeDeviceId !== sandbox.placementNodeId)
  ) {
    throw new Error("Remote-exec environment changed while preparing its sandbox");
  }
  return sandbox;
}
