import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assertCrabboxWarmImageRowBudget,
  WARM_IMAGE_MAX_RETIREMENTS,
} from "./crabbox-worker-warm-image-debt.js";
import { normalizeRecipePreparation } from "./crabbox-worker-warm-image-recipe.js";
import type {
  WarmProfileRecord,
  WarmProfileV3,
  WarmImageRecord,
} from "./crabbox-worker-warm-image-records.js";

export function isCrabboxWarmProfileV3(value: unknown): value is WarmProfileV3 {
  return (
    isRecord(value) &&
    value.version === 3 &&
    value.retirements === undefined &&
    isRecord(value.allocations) &&
    (value.operation === undefined ||
      (isRecord(value.operation) &&
        (value.operation.type === "capture" ||
          (value.operation.type === "retire" &&
            typeof value.operation.checkpointId === "string" &&
            Boolean(value.operation.checkpointId.trim())))))
  );
}

/** Exclusive Doctor migration: no provider calls, and no reconstruction of opaque debt metadata. */
export function upgradeCrabboxWarmProfileV3(value: WarmProfileV3): WarmProfileRecord {
  const { operation, ...profile } = value;
  const next: WarmProfileRecord = {
    ...profile,
    version: 4,
    ...(operation?.type === "retire"
      ? { retirements: [operation] }
      : operation
        ? { operation }
        : {}),
  };
  admitCrabboxWarmImageProfile(next);
  assertCrabboxWarmImageRowBudget(next);
  return next;
}

export function admitCrabboxWarmImageProfile(record: WarmProfileRecord | undefined) {
  if (record && record.version !== 4) {
    throw new Error(
      "Crabbox warm-image state requires migration; run openclaw doctor --fix before provisioning workers.",
    );
  }
  const preparationKey = (value: unknown) =>
    value === null || (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
  const demandAtMs = (value: unknown) =>
    value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  const cacheIdentity = (value: { preparationKey: unknown; cacheKey: unknown; purpose: unknown }) =>
    preparationKey(value.cacheKey) &&
    (value.cacheKey === null
      ? value.purpose === null
      : value.preparationKey !== null &&
        (value.purpose === "session" || value.purpose === "reserve"));
  const validImage = (image: WarmImageRecord) =>
    isRecord(image) &&
    preparationKey(image.preparationKey) &&
    cacheIdentity(image) &&
    demandAtMs(image.lastDemandAtMs) &&
    (image.pinned === undefined ||
      (isRecord(image.pinned) &&
        Number.isSafeInteger(image.pinned.atMs) &&
        image.pinned.atMs >= 0));
  const validGeneration = (value: unknown) =>
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value.checkpointId === "string" &&
    Boolean(value.checkpointId.trim()) &&
    typeof value.createdAtMs === "number" &&
    Number.isSafeInteger(value.createdAtMs) &&
    value.createdAtMs >= 0;
  const validCaptureUnsupported = (value: unknown) =>
    isRecord(value) &&
    typeof value.atMs === "number" &&
    Number.isSafeInteger(value.atMs) &&
    value.atMs >= 0 &&
    typeof value.provider === "string" &&
    value.provider.length > 0 &&
    value.provider.length <= 128 &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    value.message.length <= 1024;
  if (
    record &&
    (!isRecord(record.allocations) ||
      (record.operation &&
        (record.operation.type !== "capture" ||
          typeof record.operation.id !== "string" ||
          !record.operation.id.trim() ||
          !Number.isSafeInteger(record.operation.startedAtMs) ||
          record.operation.startedAtMs < 0 ||
          !["scrubbing", "creating", "uncertain"].includes(record.operation.phase))) ||
      (record.retirements !== undefined &&
        (!Array.isArray(record.retirements) ||
          record.retirements.length > WARM_IMAGE_MAX_RETIREMENTS ||
          record.retirements.some(
            (debt) =>
              !isRecord(debt) ||
              debt.type !== "retire" ||
              typeof debt.checkpointId !== "string" ||
              !debt.checkpointId.trim(),
          ) ||
          new Set(record.retirements.map((debt) => debt.checkpointId)).size !==
            record.retirements.length)) ||
      (record.image && !validImage(record.image)) ||
      (record.previous && !validImage(record.previous)) ||
      (record.captureUnsupported !== undefined &&
        !validCaptureUnsupported(record.captureUnsupported)) ||
      Object.values(record.allocations).some(
        (allocation) =>
          !isRecord(allocation) ||
          !preparationKey(allocation.preparationKey) ||
          !cacheIdentity(allocation) ||
          !demandAtMs(allocation.demandAtMs) ||
          (allocation.preparationKey !== null && allocation.demandAtMs === null) ||
          (allocation.imageGeneration !== null && !validGeneration(allocation.imageGeneration)) ||
          (allocation.publicationBase !== undefined &&
            !validGeneration(allocation.publicationBase)) ||
          (allocation.captureSkipped !== undefined &&
            (typeof allocation.captureSkipped !== "string" ||
              !allocation.captureSkipped ||
              allocation.captureSkipped.length > 1024)),
      ))
  ) {
    throw new Error("Crabbox warm-image preparation state is invalid; run openclaw doctor --fix.");
  }
  if (!record || record.recipePreparation === undefined) {
    return record;
  }
  const normalized = { ...record };
  delete normalized.recipePreparation;
  delete normalized.recipePreparationAtMs;
  const recipePreparation = normalizeRecipePreparation(record.recipePreparation);
  if (recipePreparation) {
    normalized.recipePreparation = recipePreparation;
    if (
      record.recipePreparationAtMs !== undefined &&
      record.recipePreparationAtMs !== null &&
      demandAtMs(record.recipePreparationAtMs)
    ) {
      normalized.recipePreparationAtMs = record.recipePreparationAtMs;
    }
  }
  return normalized;
}
