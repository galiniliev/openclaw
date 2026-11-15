import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Private supervisor projection. It carries identities, never authentication material. */
export type GatewayRollingContract = {
  version: 1;
  releaseId: string;
  predecessorBootId: string;
  candidateBootId: string;
  predecessorOwner: string;
  compatibilityDigest: string;
  /** Absent during immutable prewarm; bound once after canonical final restore. */
  companionGeneration?: string;
  expiresAtMs: number;
};
export type GatewayRollingLeaseObservation = {
  owner: string;
  contract: GatewayRollingContract;
  returnedToOwner?: string;
};

export type BoundGatewayRollingContract = GatewayRollingContract & { companionGeneration: string };

export type GatewayRollingPhase =
  | "prewarming"
  | "prewarmed"
  | "binding-read-only"
  | "read-only"
  | "preparing-writer"
  | "writer-prepared"
  | "activating"
  | "writer-ready"
  | "aborting"
  | "aborted"
  | "failed";

export type GatewayRollingControlRequest = {
  version: 1;
  id: string;
  releaseId: string;
  action: "status" | "bind-read-only" | "prepare-writer" | "activate" | "abort";
  predecessorRetirement?: {
    bootId: string;
    releaseId: string;
    childIdentity: string;
    exited: true;
  };
  companion?: { generation: string; restoreReceiptId: string };
};

export type GatewayRollingControlStatus = {
  version: 1;
  releaseId: string;
  candidateBootId: string;
  phase: GatewayRollingPhase;
  /** Immutable imports are not application readiness or mutable state admission. */
  immutableReady: boolean;
  readReady: boolean;
  writerReady: boolean;
  observed?: {
    observedAtMs: number;
    compatibilityDigest: string;
    storeIdentity: string;
    executionOwner: string;
    companionGeneration: string;
    restoreReceiptId: string;
  };
};

const MAX_ID_LENGTH = 128;
export const MAX_GATEWAY_ROLLING_CONTROL_BYTES = 16_384;

function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)
  );
}

/** Unknown fields are rejected so a credential cannot accidentally enter the control ledger. */
export function parseGatewayRollingContract(value: unknown): GatewayRollingContract {
  const keys = new Set([
    "version",
    "releaseId",
    "predecessorBootId",
    "candidateBootId",
    "predecessorOwner",
    "compatibilityDigest",
    "companionGeneration",
    "expiresAtMs",
  ]);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !keys.has(key)) ||
    value.version !== 1 ||
    !identity(value.releaseId) ||
    !identity(value.predecessorBootId) ||
    !identity(value.candidateBootId) ||
    value.predecessorBootId.length > 96 ||
    value.candidateBootId.length > 96 ||
    value.predecessorBootId === value.candidateBootId ||
    !identity(value.predecessorOwner) ||
    typeof value.compatibilityDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.compatibilityDigest) ||
    (value.companionGeneration !== undefined && !identity(value.companionGeneration)) ||
    typeof value.expiresAtMs !== "number" ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs <= 0
  ) {
    throw new Error("Invalid private Gateway rolling contract");
  }
  return value as GatewayRollingContract;
}

export function parseGatewayRollingControlRequest(value: unknown): GatewayRollingControlRequest {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        !["version", "id", "releaseId", "action", "predecessorRetirement", "companion"].includes(
          key,
        ),
    ) ||
    value.version !== 1 ||
    !identity(value.id) ||
    !identity(value.releaseId) ||
    typeof value.action !== "string" ||
    !["status", "bind-read-only", "prepare-writer", "activate", "abort"].includes(value.action) ||
    (value.predecessorRetirement !== undefined &&
      (value.action !== "activate" ||
        !isRecord(value.predecessorRetirement) ||
        Object.keys(value.predecessorRetirement).some(
          (key) => !["bootId", "releaseId", "childIdentity", "exited"].includes(key),
        ) ||
        !identity(value.predecessorRetirement.bootId) ||
        !identity(value.predecessorRetirement.releaseId) ||
        !identity(value.predecessorRetirement.childIdentity) ||
        value.predecessorRetirement.exited !== true)) ||
    (value.companion !== undefined &&
      (value.action !== "bind-read-only" ||
        !isRecord(value.companion) ||
        Object.keys(value.companion).some(
          (key) => !["generation", "restoreReceiptId"].includes(key),
        ) ||
        !identity(value.companion.generation) ||
        !identity(value.companion.restoreReceiptId)))
  ) {
    throw new Error("Invalid private Gateway rolling control request");
  }
  return value as GatewayRollingControlRequest;
}
