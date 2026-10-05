import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { MainSessionRecoveryAdmission } from "./main-session-recovery-admission.js";
import type { MainSessionRecoveryObservation } from "./main-session-recovery-state.js";
import type { dispatchRestartRecoveryWithinCapacity } from "./main-session-restart-dispatch-capacity.js";

export type MainSessionResumeResult = "started" | "settled" | "skipped" | "failed";

export type ResumeMainSessionParams = {
  agentId: string;
  canonicalSessionKey?: string;
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  observation: MainSessionRecoveryObservation;
  recoveryAttempt: number;
  storePath: string;
  sessionKey: string;
  pendingFinalDeliveryText?: string | null;
  forceRestartSafeTools?: boolean;
  forceCodeModeTools?: boolean;
  recoveryAdmission?: MainSessionRecoveryAdmission;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  shouldContinueDelivery?: () => boolean;
  gatewayRuntime: GatewayRecoveryRuntime;
  recoveryCapacity?: Parameters<typeof dispatchRestartRecoveryWithinCapacity>[0]["capacity"];
};
