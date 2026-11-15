import { isPidAlive, isPidDefinitelyDead } from "../shared/pid-alive.js";
import { GatewayLockError } from "./gateway-lock-error.js";
import { classifyGatewayLockProcessNamespace, type LockPayload } from "./gateway-lock-payload.js";
import {
  GATEWAY_LOCK_PROCESS_TIMEOUT_MS,
  readGatewayLockProcessCmdline,
  readGatewayLockProcessStartTime,
} from "./gateway-lock-process.js";
import { classifyOpenClawArgv } from "./gateway-process-argv.js";

type LockOwnerStatus = "alive" | "dead" | "unknown";

export function resolveGatewayOwnerStatusSync(
  pid: number,
  payload: LockPayload | null,
  platform: NodeJS.Platform,
  opts: {
    trustUnknownCmdlineOwner?: boolean;
    deadlineMs?: number;
    signal?: AbortSignal;
    lockPath?: string;
  } = {},
): LockOwnerStatus {
  const remainingTimeoutMs = () => {
    opts.signal?.throwIfAborted();
    const remaining =
      opts.deadlineMs === undefined
        ? GATEWAY_LOCK_PROCESS_TIMEOUT_MS
        : opts.deadlineMs - performance.now();
    if (remaining <= 0) {
      throw new GatewayLockError("Gateway lock inspection deadline expired");
    }
    return Math.max(1, Math.min(GATEWAY_LOCK_PROCESS_TIMEOUT_MS, Math.ceil(remaining)));
  };
  remainingTimeoutMs();
  const namespace = classifyGatewayLockProcessNamespace(payload, opts.lockPath);
  if (namespace !== "same") {
    return namespace;
  }
  const role = payload?.role ?? "gateway";
  if (!isPidAlive(pid)) {
    return isPidDefinitelyDead(pid) ? "dead" : "unknown";
  }

  // Process start identity catches PID recycling even when the replacement
  // process has the same argv shape.
  const payloadStartTime = payload?.startTime;
  if (Number.isFinite(payloadStartTime)) {
    const currentStartTime = readGatewayLockProcessStartTime(pid, platform, remainingTimeoutMs());
    remainingTimeoutMs();
    if (currentStartTime != null) {
      return currentStartTime === payloadStartTime ? "alive" : "dead";
    }
  }

  const embedded =
    role === "agent-embedded" || role === "sqlite-maintenance" || role === "skill-workshop-apply";
  const args = readGatewayLockProcessCmdline(pid, platform, remainingTimeoutMs(), opts.deadlineMs);
  remainingTimeoutMs();
  if (!args) {
    // An unavailable command observation cannot prove that the owner stopped.
    return embedded || platform === "linux" || opts.trustUnknownCmdlineOwner === false
      ? "unknown"
      : "alive";
  }
  // Embedded agents cover every state-writing command; maintenance roles require
  // an OpenClaw command. Gateway classification also recognizes retitled processes.
  const command =
    role === "agent-embedded" || role === "sqlite-maintenance"
      ? undefined
      : role === "skill-workshop-apply"
        ? "skills"
        : "gateway";
  const identity = classifyOpenClawArgv(args, command ? { command, pid } : { pid });
  remainingTimeoutMs();
  return identity.kind === "openclaw" ? "alive" : "unknown";
}

export async function resolveGatewayOwnerStatus(
  ...args: Parameters<typeof resolveGatewayOwnerStatusSync>
): Promise<LockOwnerStatus> {
  return resolveGatewayOwnerStatusSync(...args);
}
