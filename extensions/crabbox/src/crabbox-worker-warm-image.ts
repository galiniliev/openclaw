import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { WorkerSessionDiskRetention } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  deleteCrabboxAzureSnapshot,
  restoreCrabboxAzureSnapshotContext,
} from "./crabbox-worker-azure-snapshot-capture.js";
import type { ParsedInspect } from "./crabbox-worker-inspect.js";
import {
  resolveCrabboxWarmImageProfileKey,
  type parseCrabboxProfile,
} from "./crabbox-worker-profile.js";
import { releaseCrabboxRejectedSnapshotAllocation } from "./crabbox-worker-snapshot-rejection.js";
import { WARM_IMAGE_COMMAND_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";
import {
  createCrabboxWarmImageAllocation,
  releaseCrabboxWarmImageAllocation,
  createCrabboxWarmImageStartContext,
  type AllocationContext,
} from "./crabbox-worker-warm-image-allocation.js";
import { createCrabboxWarmImageCapture } from "./crabbox-worker-warm-image-capture.js";
import {
  createCrabboxWarmImageCheckpointUpdates,
  observeCrabboxWarmImage,
  type CheckpointContext,
  type MaintenanceContext,
} from "./crabbox-worker-warm-image-checkpoint.js";
import {
  isCrabboxImageRetiring,
  withCrabboxWarmImageRetirement,
  crabboxWarmImageRetirement,
} from "./crabbox-worker-warm-image-debt.js";
import {
  resolveCrabboxWarmImagePolicy,
  type CrabboxWarmImagePolicy,
} from "./crabbox-worker-warm-image-policy.js";
import {
  createCrabboxWarmImageRetirement,
  reconcileCrabboxWarmImageCapture,
} from "./crabbox-worker-warm-image-reconciliation.js";
import {
  hasNoCrabboxWarmImageProviderObligations,
  crabboxWarmImageCaptureStatus,
  isCrabboxWarmImageHeld as held,
  crabboxWarmImageRecoveryHint,
  CRABBOX_WARM_IMAGE_WAIT_HINT,
  WARM_IMAGE_MAX_ENTRIES,
  type WarmImageRecord,
  type WarmProfileRecord,
  type WarmColdReason,
} from "./crabbox-worker-warm-image-records.js";
import {
  assertCrabboxWarmImageMigrationReady,
  assertCrabboxWarmImagePreparation,
  assertCrabboxWarmImageReplay,
  CrabboxWarmImageRequestError,
  isCrabboxCaptureRefusalRetained,
  openCrabboxWarmImageStore,
  sameCrabboxWarmImageGeneration as sameImage,
  withCrabboxWarmImageDisplayFacts,
  type CrabboxState,
} from "./crabbox-worker-warm-image-store.js";

type CrabboxProfile = ReturnType<typeof parseCrabboxProfile>;
type RetirementContext = CheckpointContext | MaintenanceContext;
type LeaseContext = CheckpointContext & {
  id: string;
  provider: string;
};

export function createCrabboxWarmImageManager(dependencies: {
  state: CrabboxState;
  isLeaseActive: (leaseId: string) => boolean;
  warn: (message: string) => void;
  info?: (message: string) => void;
  prepareCapture: (
    context: LeaseContext & { profile: CrabboxProfile; sourcePreparationTimeoutMs: number },
  ) => Promise<ParsedInspect>;
  policy?: CrabboxWarmImagePolicy;
  snapshotHelperPath?: string;
  qualifyLegacySnapshotContract?: (binary: string) => Promise<boolean>;
}) {
  const policy = dependencies.policy ?? resolveCrabboxWarmImagePolicy();
  const snapshotDirectory = path.join(resolveStateDir(), "crabbox", "snapshot-bindings");
  let store: ReturnType<typeof openCrabboxWarmImageStore> | undefined;
  // Legacy allocations have no online writer; recovery and migration require stopped owners.
  let migrationReady = false;
  const assertMigrationReady = async () => {
    if (!migrationReady) {
      await assertCrabboxWarmImageMigrationReady(dependencies.state);
      migrationReady = true;
    }
  };
  const warned = new Set<string>();
  let pausedCaptureSnapshot = "";
  const openStore = () => (store ??= openCrabboxWarmImageStore(dependencies.state));
  const assertCurrent = (context: RetirementContext) => {
    context.assertCurrent?.();
    context.signal?.throwIfAborted();
  };
  const warnOnce = (action: string, error: unknown, failed = true) => {
    const message = `Crabbox warm image ${action}${failed ? " failed" : ""}: ${coerceErrorMessage(error)}`;
    if (!warned.has(message)) {
      // Periodic failures can carry changing request IDs; never retain an unbounded log cache.
      if (warned.size >= WARM_IMAGE_MAX_ENTRIES) {
        warned.clear();
      }
      warned.add(message);
      dependencies.warn(message);
    }
  };
  const imageExpired = (image: WarmImageRecord) =>
    !image.pinned &&
    (image.lastDemandAtMs === null || Date.now() - image.lastDemandAtMs >= policy.retainUnusedMs);
  const retiringCurrent = (record: WarmProfileRecord) =>
    isCrabboxImageRetiring(record, record.image?.checkpointId);
  const deleteEmptyProfile = (key: string) =>
    openStore().deleteIf(
      key,
      (record) =>
        hasNoCrabboxWarmImageProviderObligations(record) &&
        !isCrabboxCaptureRefusalRetained(record, policy.refreshAfterMs) &&
        !(
          record.recipePreparationAtMs !== undefined &&
          Date.now() < record.recipePreparationAtMs + policy.refreshAfterMs
        ),
    );

  const lookupLease = (id: string) => openStore().lookupLease(id);
  const requireSnapshotHelper = () => {
    if (!dependencies.snapshotHelperPath) {
      throw new Error(
        "Snapshot helper is missing; reinstall the qualified Crabbox provider package",
      );
    }
    return dependencies.snapshotHelperPath;
  };

  const { releaseRetirementHolds, retireImage } = createCrabboxWarmImageRetirement({
    openStore,
    deleteSnapshot: (context, image, remainingMs) =>
      deleteCrabboxAzureSnapshot(
        restoreCrabboxAzureSnapshotContext(image, requireSnapshotHelper()),
        image,
        {
          remainingMs,
          assertCurrent: () => assertCurrent(context),
          signal: context.signal,
          timingIdentity: context.timingIdentity ?? { operationId: image.operationId },
        },
      ),
    isLeaseActive: dependencies.isLeaseActive,
    warn: dependencies.warn,
    warnOnce,
    deleteEmptyProfile,
  });

  const deleteImage = async (
    context: RetirementContext,
    key: string,
    record: WarmProfileRecord,
    remainingMs?: () => number,
    checkpointId = record.image?.checkpointId,
    retireHeld = false,
  ) => {
    const image = [record.image, record.previous].find(
      (candidate) => candidate?.checkpointId === checkpointId,
    );
    if (
      !image ||
      !checkpointId ||
      image.pinned ||
      isCrabboxImageRetiring(record, checkpointId) ||
      record.operation ||
      (held(record, checkpointId) && !retireHeld)
    ) {
      return;
    }
    assertCurrent(context);
    const retiring = withCrabboxWarmImageRetirement(record, crabboxWarmImageRetirement(image));
    // Choice admission and retirement claim the same row; neither can pass an older observation.
    if (
      await openStore().update(key, (current) => {
        assertCurrent(context);
        return JSON.stringify(current) === JSON.stringify(record) ? retiring : undefined;
      })
    ) {
      await retireImage(context, key, retiring, remainingMs);
    }
  };

  const collectImages = async (
    context: RetirementContext,
    phase: "allocation" | "teardown" | "maintenance",
    entries: { key: string; value: WarmProfileRecord }[],
  ) => {
    const deadline = performance.now() + WARM_IMAGE_COMMAND_TIMEOUT_MS;
    assertCurrent(context);
    const paused: { selector: string; reason: string }[] = [];
    // A slow capture can consume the entire sweep budget. Retry known deletion debt first.
    const ordered = entries.toSorted(
      (a, b) =>
        Number(Boolean(b.value.retirements?.length)) - Number(Boolean(a.value.retirements?.length)),
    );
    for (const { key, value } of ordered) {
      assertCurrent(context);
      const capture = crabboxWarmImageCaptureStatus(value);
      if (capture) {
        if (
          capture.phase === "uncertain" &&
          "binaries" in context &&
          value.operation?.type === "capture" &&
          !dependencies.isLeaseActive(value.operation.leaseId ?? "")
        ) {
          const reason = await reconcileCrabboxWarmImageCapture(
            context,
            openStore(),
            key,
            value.operation,
            () => deadline - performance.now(),
            dependencies.info ?? (() => {}),
            dependencies.isLeaseActive,
          );
          if (reason) {
            paused.push({ selector: capture.selector, reason });
          }
        } else if (capture.phase === "uncertain") {
          warnOnce("capture paused", crabboxWarmImageRecoveryHint(capture.selector), false);
        } else if (capture.stale) {
          warnOnce(
            `capture ${capture.selector} still pending`,
            CRABBOX_WARM_IMAGE_WAIT_HINT,
            false,
          );
        }
        continue;
      }
      if ((value.operation || value.retirements?.length) && phase === "allocation") {
        continue;
      }
      const remaining = () => deadline - performance.now();
      if (remaining() <= 0) {
        break;
      }
      if (hasNoCrabboxWarmImageProviderObligations(value)) {
        await deleteEmptyProfile(key);
        continue;
      }
      const retiring =
        phase === "maintenance" && "binaries" in context
          ? await releaseRetirementHolds(context, key, value, remaining)
          : value;
      if (retiring) {
        await retireImage(context, key, retiring, remaining);
      }
      let current = await openStore().lookup(key);
      if (
        current?.previous &&
        !current.operation &&
        !current.previous.pinned &&
        (policy.keepPrevious === 0 || imageExpired(current.previous)) &&
        remaining() > 0
      ) {
        await deleteImage(context, key, current, remaining, current.previous.checkpointId);
        current = await openStore().lookup(key);
      }
      if (
        current?.image &&
        sameImage(current.image, value.image) &&
        !current.operation &&
        imageExpired(current.image) &&
        remaining() > 0
      ) {
        await deleteImage(context, key, current, remaining);
      }
    }
    const snapshot = JSON.stringify(paused);
    if (phase === "maintenance" && snapshot !== pausedCaptureSnapshot) {
      pausedCaptureSnapshot = snapshot;
      if (paused.length > 0) {
        dependencies.warn(
          `Crabbox warm image capture paused (${paused.length}; ${paused.map(({ selector, reason }) => `${selector}: ${reason}`).join(", ")}): ${crabboxWarmImageRecoveryHint(paused.length === 1 ? paused[0]!.selector : "<selector>")}`,
        );
      }
    }
  };

  const collectProfileImages = async (
    context: CheckpointContext,
    key: string,
    phase: "allocation" | "teardown",
  ) => {
    const value = await openStore().lookup(key);
    // Requests own only their selected profile; the service owns catalog-wide expiry.
    await collectImages(context, phase, value ? [{ key, value }] : []);
  };

  const makeRoom = async (context: LeaseContext) => {
    const deadline = performance.now() + WARM_IMAGE_COMMAND_TIMEOUT_MS;
    const entries = await openStore().entries();
    if (entries.length < WARM_IMAGE_MAX_ENTRIES) {
      return;
    }
    const candidates = entries
      .filter(({ value }) => !value.operation && Object.keys(value.allocations).length === 0)
      .toSorted(
        (a, b) => (a.value.image?.lastDemandAtMs ?? 0) - (b.value.image?.lastDemandAtMs ?? 0),
      );
    // Previous generations are reclaimed first, but a slot is freed only when its
    // whole profile has no images, allocations, or deletion obligations left.
    for (const generation of ["previous", "image"] as const) {
      for (const { key } of candidates) {
        if ((await openStore().count()) < WARM_IMAGE_MAX_ENTRIES) {
          return;
        }
        const remaining = () => deadline - performance.now();
        if (remaining() <= 0) {
          break;
        }
        const current = await openStore().lookup(key);
        const image = current?.[generation];
        if (current && image && (generation === "previous" || !current.previous)) {
          await deleteImage(context, key, current, remaining, image.checkpointId);
        }
        if (generation === "image") {
          // Retained diagnostics are display-only and never hold a capacity slot.
          await openStore().deleteIf(key, hasNoCrabboxWarmImageProviderObligations);
        }
      }
    }
    if ((await openStore().count()) >= WARM_IMAGE_MAX_ENTRIES) {
      throw new Error(
        "Crabbox warm-image profile capacity is full; stop outstanding workers or resolve cleanup with openclaw crabbox warm-images before retrying.",
      );
    }
  };

  // A missing checkpoint starts retiring so new leases provision cold. After a failed fork,
  // retireHeld lets that failed lease's own hold through; deletion waits for its release.
  const verifyCheckpoint = async (
    context: LeaseContext,
    key: string,
    checkpointId: string,
    retireHeld = false,
  ) => {
    try {
      const record = await openStore().lookup(key);
      const image = [record?.image, record?.previous].find(
        (candidate) => candidate?.checkpointId === checkpointId,
      );
      const state = await observeCrabboxWarmImage(
        context,
        image ?? { checkpointId },
        requireSnapshotHelper,
      );
      if (state === "missing" && record) {
        await deleteImage(context, key, record, undefined, checkpointId, retireHeld);
      }
      return state;
    } catch (error) {
      assertCurrent(context);
      warnOnce("verification", error);
      return undefined;
    }
  };

  const selectAllocation = async (
    context: AllocationContext,
    profile: CrabboxProfile & { class: string },
  ) => {
    if (!context.nodeRuntimeIdentity) {
      throw new Error("Crabbox warm-image allocation requires a prepared node runtime identity");
    }
    const preparationKey = context.preparation?.key ?? null;
    const cacheKey = context.preparation?.cacheKey ?? null;
    const purpose = context.preparation?.purpose ?? null;
    assertCrabboxWarmImagePreparation(context.preparation, {
      projectKey: context.projectKey,
      target: profile.target,
    });
    const key = resolveCrabboxWarmImageProfileKey(profile, context.projectKey);
    const displayFacts = {
      profileId: context.profileId,
      backend: profile.provider,
      machineClass: profile.class,
      os: profile.target,
      projectLabel: context.projectLabel,
      projectRoot: context.projectRoot,
    };
    const replay = await lookupLease(context.id);
    if (replay) {
      assertCrabboxWarmImageReplay(replay, {
        key,
        machineClass: profile.class,
        os: profile.target,
        preparationKey,
        cacheKey,
        retentionOwnerBinding: context.retention?.ownerBinding,
        purpose,
        demandAtMs: context.preparation?.demandAtMs,
        runtimeIdentity: context.nodeRuntimeIdentity,
      });
      assertCurrent(context);
      const updated = await openStore().update(key, (record) => {
        assertCurrent(context);
        const allocation = record?.allocations[context.id];
        return record &&
          allocation &&
          isDeepStrictEqual({ key, projectKey: record.projectKey, ...allocation }, replay)
          ? withCrabboxWarmImageDisplayFacts(record, displayFacts)
          : undefined;
      });
      if (!updated) {
        throw new Error(
          "Crabbox allocation changed before provisioning completed; retry the worker operation.",
        );
      }
      return replay;
    }
    await collectProfileImages(context, key, "allocation");
    const observed = await openStore().lookup(key);
    let coldReason: WarmColdReason = "no-snapshot-yet";
    if (observed?.image) {
      if (retiringCurrent(observed)) {
        coldReason = "snapshot-retiring";
      } else if (
        cacheKey !== null
          ? observed.image.cacheKey !== cacheKey
          : observed.image.preparationKey !== null || observed.image.cacheKey !== null
      ) {
        coldReason = "setup-changed";
      } else {
        coldReason = "snapshot-unavailable";
      }
    } else if (observed) {
      if (isCrabboxCaptureRefusalRetained(observed, policy.refreshAfterMs)) {
        coldReason = "backend-cannot-snapshot";
      } else if (observed.operation?.type === "capture") {
        coldReason = "capture-paused";
      }
    }
    let available = Boolean(
      observed?.image &&
      observed.image.lastDemandAtMs !== null &&
      (cacheKey !== null
        ? observed.image.cacheKey === cacheKey
        : observed.image.preparationKey === null && observed.image.cacheKey === null) &&
      !retiringCurrent(observed),
    );
    if (available && observed?.image?.state === "pending") {
      try {
        const state = await observeCrabboxWarmImage(context, observed.image, requireSnapshotHelper);
        available = state === "available";
        if (!available) {
          coldReason = "snapshot-unavailable";
        }
        if (state === "missing") {
          await deleteImage(context, key, observed);
        }
      } catch (error) {
        assertCurrent(context);
        available = false;
        warnOnce("verification", error);
      }
    }
    if (!(await openStore().lookup(key))) {
      await makeRoom(context);
    }
    assertCurrent(context);
    // Crabbox binds even a cold (empty checkpoint) intent to the fixed lease.
    // Freeze the choice before the first CLI call so a lost response cannot select a newer image.
    return openStore().recordAllocation({
      key,
      id: context.id,
      projectKey: context.projectKey,
      displayFacts,
      assertCurrent: () => assertCurrent(context),
      availableImage: available ? observed?.image : undefined,
      coldReason: available ? undefined : coldReason,
      allocation: {
        machineClass: profile.class,
        os: profile.target,
        phase: "pending",
        runtimeIdentity: context.nodeRuntimeIdentity,
        ...(context.retention ? { retentionOwnerBinding: context.retention.ownerBinding } : {}),
        ...(context.azureSnapshot && context.timingIdentity
          ? { timingIdentity: context.timingIdentity }
          : {}),
        preparationKey,
        cacheKey,
        purpose,
        demandAtMs: context.preparation?.demandAtMs ?? Date.now(),
      },
    });
  };

  const { checkpointEntry, updateCheckpoint } = createCrabboxWarmImageCheckpointUpdates(openStore);

  const releaseAllocation = (
    context: LeaseContext,
    expected?: NonNullable<Awaited<ReturnType<typeof lookupLease>>>,
  ) =>
    releaseCrabboxWarmImageAllocation(
      context,
      {
        openStore,
        snapshotDirectory,
        retireImage,
        deleteImage,
        deleteEmptyProfile,
        warnOnce,
      },
      expected,
    );
  const releaseRejectedSnapshot = (
    context: LeaseContext & { retention?: WorkerSessionDiskRetention },
  ) =>
    releaseCrabboxRejectedSnapshotAllocation(context, {
      openStore,
      release: releaseAllocation,
      qualifyLegacyContract: dependencies.qualifyLegacySnapshotContract,
    });
  const allocate = createCrabboxWarmImageAllocation({
    snapshotDirectory,
    assertMigrationReady,
    lookupLease,
    selectAllocation,
    openStore,
    policy,
    assertCurrent,
    releaseRejectedSnapshot,
    verifyCheckpoint,
  });

  return {
    pin(checkpointId: string, pinned: boolean, assertOwnerCurrent?: () => void) {
      return updateCheckpoint(
        checkpointId,
        (record) => {
          if (record.operation) {
            return "Wait for the profile's capture or retirement to finish before changing a pin.";
          }
          if (isCrabboxImageRetiring(record, checkpointId)) {
            return "Snapshot retirement is already owned; pin unchanged.";
          }
          const field = record.image?.checkpointId === checkpointId ? "image" : "previous";
          const image = record[field];
          if (image?.checkpointId !== checkpointId) {
            return "Unknown snapshot checkpoint.";
          }
          const updated = { ...image };
          if (pinned) {
            updated.pinned ??= { atMs: Date.now() };
          } else {
            delete updated.pinned;
          }
          return { ...record, [field]: updated };
        },
        assertOwnerCurrent,
      );
    },
    rollback(checkpointId: string, assertOwnerCurrent?: () => void) {
      return updateCheckpoint(
        checkpointId,
        (record) => {
          if (record.operation) {
            return "Wait for the profile's capture or retirement to finish before rolling back.";
          }
          if (
            isCrabboxImageRetiring(record, checkpointId) ||
            isCrabboxImageRetiring(record, record.image?.checkpointId)
          ) {
            return "Snapshot retirement is already owned; rollback unchanged.";
          }
          if (record.previous?.checkpointId !== checkpointId) {
            return "Rollback requires a previous snapshot checkpoint.";
          }
          const next: WarmProfileRecord = { ...record, image: record.previous };
          delete next.previous;
          if (record.image) {
            if (policy.keepPrevious === 1 || record.image.pinned) {
              next.previous = record.image;
            } else {
              return withCrabboxWarmImageRetirement(next, crabboxWarmImageRetirement(record.image));
            }
          }
          return next;
        },
        assertOwnerCurrent,
      );
    },
    async delete(
      context: MaintenanceContext,
      checkpointId: string,
    ): Promise<{ status: "deleted" | "retiring" }> {
      assertCurrent(context);
      const { key, value } = await checkpointEntry(checkpointId);
      if (value.operation?.type === "capture") {
        throw new CrabboxWarmImageRequestError(
          "A snapshot cannot be deleted while its profile is capturing.",
        );
      }
      if (held(value, checkpointId)) {
        throw new CrabboxWarmImageRequestError(
          "Stop outstanding allocations before deleting this snapshot.",
        );
      }
      if (
        [value.image, value.previous].some(
          (image) => image?.checkpointId === checkpointId && image.pinned,
        )
      ) {
        throw new CrabboxWarmImageRequestError("Unpin this snapshot before deleting it.");
      }
      if (isCrabboxImageRetiring(value, checkpointId)) {
        await retireImage(context, key, value);
      } else {
        await deleteImage(context, key, value, undefined, checkpointId);
      }
      assertCurrent(context);
      const current = await openStore().lookup(key);
      if (current && isCrabboxImageRetiring(current, checkpointId)) {
        return { status: "retiring" };
      }
      if (
        current?.image?.checkpointId === checkpointId ||
        current?.previous?.checkpointId === checkpointId
      ) {
        throw new CrabboxWarmImageRequestError(
          "Snapshot changed; refresh the list and retry deletion.",
        );
      }
      return { status: "deleted" };
    },
    maintain: async (context: MaintenanceContext) => {
      assertCurrent(context);
      await assertMigrationReady();
      await collectImages(
        { ...context, binaries: [...new Set(context.binaries)].toSorted() },
        "maintenance",
        await openStore().entries(),
      );
    },
    lookupLease,
    /** Runtime attested when this checkpoint was captured; undefined once its record is gone. */
    checkpointRuntimeIdentity: async (checkpointId: string) => {
      for (const { value } of await openStore().entries()) {
        for (const image of [value.image, value.previous]) {
          if (image?.checkpointId === checkpointId) {
            return image.runtimeIdentity;
          }
        }
      }
      return undefined;
    },
    markPrepared: (
      ...args: Parameters<ReturnType<typeof openCrabboxWarmImageStore>["markPrepared"]>
    ) => openStore().markPrepared(...args),
    noteRecipePreparation: (
      ...args: Parameters<ReturnType<typeof openCrabboxWarmImageStore>["noteRecipePreparation"]>
    ) => openStore().noteRecipePreparation(...args),
    markEnrolled: (id: string, assertOwnerCurrent?: () => void) =>
      openStore().markEnrolled(id, assertOwnerCurrent),

    notePreparedDemand: (id: string, preparation: { preparationKey: string; demandAtMs: number }) =>
      openStore().notePreparedDemand(id, preparation),

    release: releaseAllocation,
    releaseRejectedSnapshot,

    capture: createCrabboxWarmImageCapture({
      policy,
      openStore,
      lookupLease,
      assertCurrent,
      warnOnce,
      collectProfileImages,
      verifyImage: (context, image, timeoutMs) =>
        observeCrabboxWarmImage(context, image, requireSnapshotHelper, timeoutMs),
      held,
      deleteImage,
      retireImage,
      prepareCapture: dependencies.prepareCapture,
    }),

    startContext: createCrabboxWarmImageStartContext,
    allocate,
  };
}
