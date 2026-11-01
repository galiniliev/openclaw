import { isDeepStrictEqual } from "node:util";
import type {
  WarmImageRecord,
  WarmProfileRecord,
  WarmRetirementRecord,
} from "./crabbox-worker-warm-image-records.js";

export const WARM_IMAGE_MAX_RETIREMENTS = 64;
// Match the existing plugin-state value limit; reserve two bounded descriptors before capture.
export const WARM_IMAGE_ROW_BYTES = 1024 * 1024;
export const WARM_IMAGE_DESCRIPTOR_BYTES = 64 * 1024;

export function isCrabboxImageRetiring(record: WarmProfileRecord, checkpointId?: string) {
  return Boolean(
    checkpointId && record.retirements?.some((debt) => debt.checkpointId === checkpointId),
  );
}

export function assertCrabboxWarmImageRowBudget(record: WarmProfileRecord) {
  if (Buffer.byteLength(JSON.stringify(record)) > WARM_IMAGE_ROW_BYTES) {
    throw new Error("Warm-image row capacity is full; existing obligations are preserved");
  }
}

export function crabboxWarmImageCaptureAdmission(record: WarmProfileRecord): string | undefined {
  if (record.operation) {
    return "capture-active";
  }
  if (
    isCrabboxImageRetiring(record, record.image?.checkpointId) ||
    isCrabboxImageRetiring(record, record.previous?.checkpointId)
  ) {
    return "selectable-generation-retiring";
  }
  if (record.image?.pinned && record.previous?.pinned) {
    return "both-generations-pinned";
  }
  return crabboxWarmImageCaptureCapacity(record);
}

export function crabboxWarmImageCaptureCapacity(record: WarmProfileRecord): string | undefined {
  if ((record.retirements?.length ?? 0) >= WARM_IMAGE_MAX_RETIREMENTS) {
    return "retirement-capacity";
  }
  if (
    Buffer.byteLength(JSON.stringify(record)) + 2 * WARM_IMAGE_DESCRIPTOR_BYTES >
    WARM_IMAGE_ROW_BYTES
  ) {
    return "row-capacity";
  }
  return undefined;
}

export function withCrabboxWarmImageRetirement(
  record: WarmProfileRecord,
  debt: WarmRetirementRecord,
): WarmProfileRecord {
  const existing = record.retirements?.find((item) => item.checkpointId === debt.checkpointId);
  if (existing) {
    if (!isDeepStrictEqual(existing, debt)) {
      throw new Error("Snapshot retirement identity changed; original debt is preserved");
    }
    return record;
  }
  if ((record.retirements?.length ?? 0) >= WARM_IMAGE_MAX_RETIREMENTS) {
    throw new Error("Snapshot retirement capacity is full; original debt is preserved");
  }
  const next = { ...record, retirements: [...(record.retirements ?? []), debt] };
  assertCrabboxWarmImageRowBudget(next);
  return next;
}

export function crabboxWarmImageRetirement(image: WarmImageRecord): WarmRetirementRecord {
  return {
    type: "retire",
    checkpointId: image.checkpointId,
    ...(image.azureSandbox ? { azureSandbox: image.azureSandbox } : {}),
  };
}
