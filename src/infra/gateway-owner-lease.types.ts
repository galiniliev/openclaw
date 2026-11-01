import type { GatewayRollingContract } from "../gateway/rolling-release-contract.js";
import type { StateLeaseProcessOwner } from "./state-lease-process-owner.js";

export type GatewayOwnerSupervisor = {
  kind: "launchd" | "systemd" | "schtasks" | "external";
  name: string | null;
};

export type GatewayOwnerLeaseIdentity = StateLeaseProcessOwner & {
  owner: string;
  port: number;
  mode: "foreground" | "supervised";
  supervisor: GatewayOwnerSupervisor | null;
  state: "live" | "dead" | "unknown";
  expired: boolean;
  heartbeatAt?: number;
  listeningAt?: number;
  stateDatabaseProvenance?: string;
  /** Written only after predecessor domain mutators have fenced and positively settled. */
  rollingHandoff?: GatewayRollingContract;
  /** A never-activated successor returns the same row to this exact predecessor. */
  rollingReturnToOwner?: string;
};
