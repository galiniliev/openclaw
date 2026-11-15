// Doctor and runtime share record policy without loading a state-store implementation.
import { createHash } from "node:crypto";
import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  AzureSandboxImage,
  AzureSandboxAllocationBinding,
  AzureSandboxCaptureAdmission,
} from "./crabbox-worker-azure-snapshot-binding.js";
import type { CrabboxOperatingSystem } from "./crabbox-worker-profile.js";
import { crabboxWarmImageCaptureAdmission } from "./crabbox-worker-warm-image-debt.js";
import type { RecipePreparation } from "./crabbox-worker-warm-image-recipe.js";

type WorkerNodeRuntimeIdentity = NonNullable<
  NonNullable<Parameters<WorkerProvider["provision"]>[2]>["nodeRuntimeIdentity"]
>;
export type WarmStartStatus = Parameters<
  NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["reportStartStatus"]>
>[0];
export type WarmColdReason = Extract<WarmStartStatus, { mode: "cold" }>["reason"];

export type WarmImageRecord = {
  checkpointId: string;
  kind: string;
  state: "pending" | "available";
  createdAtMs: number;
  preparationKey: string | null;
  cacheKey: string | null;
  purpose: "session" | "reserve" | null;
  lastDemandAtMs: number | null;
  pinned?: { atMs: number };
  baseCommit?: string;
  /** Runtime content attested by successful preparation before this capture. */
  runtimeIdentity?: WorkerNodeRuntimeIdentity;
  azureSandbox?: AzureSandboxImage;
};

export type WarmAllocationRecord = {
  coldReason?: WarmColdReason;
  choice: { kind: "cold" } | { kind: "checkpoint"; checkpointId: string };
  machineClass: string;
  /** Absent in existing Linux allocations. */
  os?: CrabboxOperatingSystem;
  phase: "pending" | "prepared" | "enrolled";
  /** Failed detected setup must never be published, including during teardown. */
  captureSkipped?: string;
  preparationKey: string | null;
  cacheKey: string | null;
  purpose: "session" | "reserve" | null;
  demandAtMs: number | null;
  imageGeneration: { checkpointId: string; createdAtMs: number } | null;
  /** A cold preparation may replace only the image observed at its admission. */
  publicationBase?: { checkpointId: string; createdAtMs: number };
  baseCommit?: string;
  /** Frozen target; preparation/enrollment must verify it before capture can publish it. */
  runtimeIdentity?: WorkerNodeRuntimeIdentity;
  azureSnapshotBinding?: AzureSandboxAllocationBinding;
  /** Terminal CLI observations fence rejected bindings separately from unknown effects. */
  snapshotPreflightOutcome?: { generation: string; outcome: "rejected" | "unknown" };
  /** This private allocation cannot become a reusable capture source. */
  retentionOwnerBinding?: string;
  timingIdentity?: { operationId: string; environmentId?: string };
};

export type WarmRetirementRecord = {
  type: "retire";
  checkpointId: string;
  azureSandbox?: AzureSandboxImage;
};

export type WarmProfileRecord = {
  version: 4;
  latestColdReason?: WarmColdReason;
  /** Configured profile that most recently allocated from this key; display only. */
  profileId?: string;
  backend?: string;
  machineClass?: string;
  os?: CrabboxOperatingSystem;
  projectLabel?: string;
  projectRoot?: string;
  projectKey?: string;
  recipePreparation?: RecipePreparation;
  recipePreparationAtMs?: number;
  image?: WarmImageRecord;
  previous?: WarmImageRecord;
  /** Latest native-capture refusal; retained for display without suppressing later attempts. */
  captureUnsupported?: { atMs: number; provider: string; message: string };
  allocations: Record<string, WarmAllocationRecord>;
  retirements?: WarmRetirementRecord[];
  operation?: {
    type: "capture";
    id: string;
    startedAtMs: number;
    leaseId?: string;
    provider?: string;
    phase: "scrubbing" | "creating" | "uncertain";
    azureSnapshotCapture?: AzureSandboxCaptureAdmission;
    checkpointIds?: string[];
  };
};

export type WarmProfileV3 = Omit<WarmProfileRecord, "version" | "retirements" | "operation"> & {
  version: 3;
  operation?: WarmProfileRecord["operation"] | WarmRetirementRecord;
};

const allocationHoldsCheckpoint = (allocation: WarmAllocationRecord, checkpointId: string) =>
  (allocation.choice.kind === "checkpoint" && allocation.choice.checkpointId === checkpointId) ||
  allocation.imageGeneration?.checkpointId === checkpointId;

export const isCrabboxWarmImageHeld = (
  record: Pick<WarmProfileRecord, "allocations">,
  checkpointId: string,
) =>
  Object.values(record.allocations).some((allocation) =>
    allocationHoldsCheckpoint(allocation, checkpointId),
  );

export const crabboxWarmImageHoldingLeaseIds = (
  record: Pick<WarmProfileRecord, "allocations">,
  checkpointId: string,
) =>
  Object.entries(record.allocations)
    .filter(([, allocation]) => allocationHoldsCheckpoint(allocation, checkpointId))
    .map(([id]) => id);

export type WarmImageOperation = NonNullable<WarmProfileRecord["operation"]> | WarmRetirementRecord;

export const WARM_IMAGE_MAX_ENTRIES = 128;
export const LEGACY_WARM_LEASE_MAX_ENTRIES = 256;
const CAPTURE_WARNING_AGE_MS = 1_200_000;

export function withoutCrabboxWarmImageOperation<T extends { operation?: WarmImageOperation }>(
  record: T,
): Omit<T, "operation"> {
  const profile = { ...record };
  delete profile.operation;
  return profile;
}

export function crabboxWarmImageCaptureStatus(record: { operation?: WarmImageOperation }) {
  const capture = record.operation?.type === "capture" ? record.operation : undefined;
  if (!capture) {
    return undefined;
  }
  return {
    selector: capture.id,
    startedAtMs: capture.startedAtMs,
    ...(capture.leaseId ? { leaseId: capture.leaseId } : {}),
    ...(capture.provider ? { provider: capture.provider } : {}),
    phase: capture.phase,
    ...(capture.checkpointIds ? { checkpointIds: capture.checkpointIds } : {}),
    stale: Date.now() - capture.startedAtMs >= CAPTURE_WARNING_AGE_MS,
  };
}

export const CRABBOX_WARM_IMAGE_WAIT_HINT =
  "The capture may still be preparing its source or waiting for provider readiness. Inspect openclaw crabbox warm-images --json and allow the owning capture to settle.";

export function crabboxWarmImageRecoveryHint(selector: string, checkpointIds?: string[]): string {
  return `${checkpointIds?.length ? `Candidate checkpoints: ${checkpointIds.join(", ")}. ` : ""}Stop the owning Gateway and capture processes, confirm any worker being recovered is stopped, and reconcile any untracked checkpoint or snapshot in its original provider scope (the Crabbox catalog for CLI checkpoints, Azure snapshot inventory for SDK snapshots) before running: openclaw crabbox warm-images --recover ${selector} --acknowledge-provider-cleanup. Then restart the Gateway; the next eligible worker can capture again.`;
}

export function crabboxLegacyWarmImageCaptureSelector(key: string, record: unknown): string {
  return `legacy-${createHash("sha256").update(JSON.stringify({ key, record })).digest("hex")}`;
}

// Recovery selectors bind the original row bytes; preserve property order and prefixes.
export const legacyLeaseSelector = (key: string, value: unknown) =>
  `legacy-lease-${createHash("sha256").update(JSON.stringify({ key, value })).digest("hex")}`;

export function projectCrabboxLegacyWarmLeases(
  entries: readonly { key: string; value: unknown }[],
) {
  return entries.map(({ key, value }) => ({
    leaseId: key,
    machineClass:
      isRecord(value) && typeof value.machineClass === "string" ? value.machineClass : undefined,
    selector: legacyLeaseSelector(key, value),
  }));
}

export const hasNoCrabboxWarmImageProviderObligations = (record: WarmProfileRecord) =>
  !record.image &&
  !record.previous &&
  !record.operation &&
  !record.retirements?.length &&
  Object.keys(record.allocations).length === 0;

export function projectCrabboxWarmImage(key: string, value: WarmProfileRecord) {
  const captureAdmission = crabboxWarmImageCaptureAdmission(value);
  return {
    profileKey: key,
    profileId: value.profileId,
    backend: value.backend,
    machineClass: value.machineClass,
    os: value.os,
    projectLabel: value.projectLabel,
    projectRoot: value.projectRoot,
    projectKey: value.projectKey,
    recipePreparation: value.recipePreparation,
    recipePreparationAtMs: value.recipePreparationAtMs,
    checkpointId: value.image?.checkpointId,
    state: value.image?.state ?? "no-image",
    createdAtMs: value.image?.createdAtMs,
    preparationKey: value.image?.preparationKey,
    cacheKey: value.image?.cacheKey,
    purpose: value.image?.purpose,
    lastDemandAtMs: value.image?.lastDemandAtMs,
    baseCommit: value.image?.baseCommit,
    runtimeIdentity: value.image?.runtimeIdentity,
    pinned: value.image?.pinned,
    previous: value.previous
      ? {
          checkpointId: value.previous.checkpointId,
          createdAtMs: value.previous.createdAtMs,
          baseCommit: value.previous.baseCommit,
          runtimeIdentity: value.previous.runtimeIdentity,
          pinned: value.previous.pinned,
          held: isCrabboxWarmImageHeld(value, value.previous.checkpointId),
        }
      : undefined,
    allocations: Object.fromEntries(
      Object.entries(value.allocations).map(([id, allocation]) => {
        const {
          azureSnapshotBinding: _privateBinding,
          retentionOwnerBinding: _retainedOwner,
          ...publicAllocation
        } = allocation;
        return [id, publicAllocation];
      }),
    ),
    capture: crabboxWarmImageCaptureStatus(value),
    captureUnsupported: value.captureUnsupported,
    latestColdReason: value.latestColdReason,
    retirement: value.retirements?.[0]
      ? { checkpointId: value.retirements[0].checkpointId }
      : undefined,
    retirements: (value.retirements ?? []).map((debt) => ({
      checkpointId: debt.checkpointId,
      held: isCrabboxWarmImageHeld(value, debt.checkpointId),
    })),
    captureAdmission: {
      structurallyEligible: captureAdmission === undefined,
      blockedReason: captureAdmission ?? null,
    },
  };
}
