import type { BoundGatewayRollingContract } from "../../gateway/rolling-release-contract.js";
import type { startGatewayServer } from "../../gateway/server.js";
import type { GatewayBootLifecycleCompletion } from "../../infra/gateway-boot-lifecycle.js";
import type { GatewayLockHandle } from "../../infra/gateway-lock.js";
import type {
  GatewayRunLoopStartOptions,
  GatewayRestartStartupFailureHandler,
} from "./run-loop-startup.js";

export type GatewayRunLoopOptions = {
  start: (
    params?: GatewayRunLoopStartOptions,
  ) => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  /** Grants this run loop authority over the process it exclusively owns. */
  ownsProcessLifecycle?: boolean;
  lockPort?: number;
  lifecycleLockDeadlineMs?: number;
  /** Private rolling projection; ordinary Gateways keep the existing lock/start path. */
  rollingHandoff?: BoundGatewayRollingContract;
  startupSignal?: AbortSignal;
  controlReady?: (control: { stop: () => void }) => void;
  canRestart?: () => boolean;
  beforeReleaseLock?: (lock: GatewayLockHandle) => Promise<void>;
  healthHost?: string;
  beginBoot?: (startedAtMs: number) => void | Promise<void>;
  completeBoot?: (completion: GatewayBootLifecycleCompletion) => void | Promise<void>;
  /** Reports terminal cleanup disposition, never mere invocation or exit intent. */
  onProcessResourcesSettled?: (outcome: "drained" | "retained") => void;
  onRestartStartupFailure?: GatewayRestartStartupFailureHandler;
};
