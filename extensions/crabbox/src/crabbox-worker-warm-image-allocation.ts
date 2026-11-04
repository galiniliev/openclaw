import { isDeepStrictEqual } from "node:util";
import { removePathWithinRoot } from "openclaw/plugin-sdk/file-access-runtime";
import { WorkerProviderError, type WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { reportCrabboxSnapshotPhase } from "./crabbox-provision-timing.js";
import {
  createCrabboxSnapshotAllocationBinding,
  materializeCrabboxSnapshotBinding,
} from "./crabbox-worker-azure-snapshot-binding.js";
import {
  buildCrabboxAllocationArgs,
  type resolveCrabboxProvisionProfile,
} from "./crabbox-worker-profile.js";
import { runProvisionWarmup } from "./crabbox-worker-provision-commands.js";
import { CrabboxSnapshotBindingRejectedError } from "./crabbox-worker-snapshot-rejection.js";
import { WARM_IMAGE_COMMAND_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";
import {
  type CheckpointContext,
  checkpointCommand,
  parseForkedCheckpoint,
} from "./crabbox-worker-warm-image-checkpoint.js";
import type { CrabboxWarmImagePolicy } from "./crabbox-worker-warm-image-policy.js";
import type {
  WarmAllocationRecord,
  WarmProfileRecord,
  WarmStartStatus,
} from "./crabbox-worker-warm-image-records.js";
import {
  isCrabboxCaptureRefusalRetained,
  withCrabboxWarmImageGeneration,
  type openCrabboxWarmImageStore,
} from "./crabbox-worker-warm-image-store.js";

export type AllocationContext = CheckpointContext & {
  id: string;
  timingIdentity?: { operationId: string; environmentId?: string };
  provider: string;
  reportStartStatus?: (status: WarmStartStatus) => void;
  prepareProject?: boolean;
  profile: ReturnType<typeof resolveCrabboxProvisionProfile>["profile"];
  slug: string;
  projectKey?: string;
  profileId?: string;
  projectLabel?: string;
  projectRoot?: string;
  nodeRuntimeIdentity?: WarmAllocationRecord["runtimeIdentity"];
  retention?: NonNullable<Parameters<WorkerProvider["provision"]>[2]>["retention"];
  preparation?: {
    key: string;
    cacheKey: string;
    purpose: "session" | "reserve";
    demandAtMs: number;
  };
  timeoutMs: () => number;
};

type Store = ReturnType<typeof openCrabboxWarmImageStore>;
type AllocationOwner = NonNullable<Awaited<ReturnType<Store["lookupLease"]>>>;

export function createCrabboxWarmImageAllocation({
  assertMigrationReady,
  lookupLease,
  selectAllocation,
  openStore,
  verifyCheckpoint,
  policy,
  assertCurrent,
  snapshotDirectory,
  releaseRejectedSnapshot,
}: {
  assertMigrationReady: () => Promise<void>;
  lookupLease: Store["lookupLease"];
  selectAllocation: (
    context: AllocationContext,
    profile: AllocationContext["profile"] & { class: string },
  ) => Promise<AllocationOwner>;
  openStore: () => Store;
  verifyCheckpoint: (
    context: AllocationContext,
    key: string,
    checkpointId: string,
    retireHeld?: boolean,
  ) => Promise<unknown>;
  policy: CrabboxWarmImagePolicy;
  assertCurrent: (context: CheckpointContext) => void;
  snapshotDirectory: string;
  releaseRejectedSnapshot: (context: AllocationContext) => Promise<boolean>;
}) {
  return async (context: AllocationContext): Promise<WarmAllocationRecord["choice"]> => {
    assertCurrent(context);
    let startStatus: WarmStartStatus = {
      mode: "cold",
      reason:
        context.profile.target !== "linux"
          ? "os-unsupported"
          : !context.profile.class
            ? "class-unknown"
            : "warm-images-off",
      phase: "provisioning",
    };
    if (!context.profile.warmImage) {
      const replay = await lookupLease(context.id);
      if (
        replay &&
        ((replay.os ?? "linux") !== context.profile.target ||
          replay.machineClass !== context.profile.class)
      ) {
        throw new Error(
          "Crabbox provision retry changed its recorded operating system or machine class.",
        );
      }
    }
    if (context.profile.warmImage) {
      await assertMigrationReady();
      const owner = await selectAllocation(context, context.profile);
      const record = await openStore().lookup(owner.key);
      startStatus =
        owner.choice.kind === "checkpoint"
          ? { mode: "snapshot" }
          : {
              mode: "cold",
              reason: owner.coldReason ?? "snapshot-unavailable",
              phase:
                context.prepareProject &&
                owner.phase !== "enrolled" &&
                record &&
                !record.operation &&
                !isCrabboxCaptureRefusalRetained(record, policy.refreshAfterMs) &&
                !(record.image?.pinned && record.previous?.pinned)
                  ? "preparing"
                  : "provisioning",
            };
      context.reportStartStatus?.(startStatus);
      if (owner.choice.kind === "checkpoint") {
        const checkpointId = owner.choice.checkpointId;
        const image = [record?.image, record?.previous].find(
          (candidate) => candidate?.checkpointId === checkpointId,
        );
        if (image?.azureSandbox) {
          if (
            !context.azureSnapshot ||
            context.azureSnapshot.providerScope !== image.azureSandbox.providerScope
          ) {
            throw new Error("Snapshot restore requires its selected SDK provider scope");
          }
          const profile = context.retention
            ? { ...context.profile, ttl: `${context.retention.policy.computeWindowSeconds}s` }
            : context.profile;
          const binding =
            owner.azureSnapshotBinding ??
            createCrabboxSnapshotAllocationBinding(image.azureSandbox, profile, Date.now());
          if (!owner.azureSnapshotBinding) {
            const saved = await openStore().update(owner.key, (current) => {
              assertCurrent(context);
              const allocation = current?.allocations[context.id];
              if (
                !current ||
                allocation?.choice.kind !== "checkpoint" ||
                allocation.choice.checkpointId !== checkpointId
              ) {
                return undefined;
              }
              return {
                ...current,
                allocations: {
                  ...current.allocations,
                  [context.id]: { ...allocation, azureSnapshotBinding: binding },
                },
              };
            });
            if (!saved) {
              throw new Error("Snapshot restore lost its original allocation owner");
            }
          }
          const exported = await materializeCrabboxSnapshotBinding(
            snapshotDirectory,
            image.azureSandbox,
            binding,
            context.id,
          );
          assertCurrent(context);
          const started = performance.now();
          let outcome: "success" | "failed" = "failed";
          try {
            await runProvisionWarmup({
              ...context,
              profile: {
                ...profile,
                azureSandboxSnapshotId: image.azureSandbox.snapshotId,
                azureSandboxSnapshotReceipt: exported.receiptPath,
                azureSandboxSnapshotGeneration: exported.generation,
              },
            });
            outcome = "success";
          } catch (error) {
            const saved = await openStore().update(owner.key, (current) => {
              // Terminal bookkeeping outlives caller cancellation; the allocation tuple fences it.
              const allocation = current?.allocations[context.id];
              if (
                !current ||
                allocation?.phase !== "pending" ||
                allocation.choice.kind !== "checkpoint" ||
                allocation.choice.checkpointId !== checkpointId ||
                !isDeepStrictEqual(allocation.azureSnapshotBinding, binding)
              ) {
                return undefined;
              }
              return {
                ...current,
                allocations: {
                  ...current.allocations,
                  [context.id]: {
                    ...allocation,
                    snapshotPreflightOutcome: {
                      generation: binding.generation,
                      outcome:
                        error instanceof CrabboxSnapshotBindingRejectedError
                          ? "rejected"
                          : "unknown",
                    },
                  },
                },
              };
            });
            if (!saved) {
              throw new Error("Snapshot rejection lost its original allocation owner", {
                cause: error,
              });
            }
            if (error instanceof CrabboxSnapshotBindingRejectedError) {
              let released: boolean;
              try {
                released = await releaseRejectedSnapshot(context);
              } catch (cleanupError) {
                throw WorkerProviderError.cleanupIndeterminate(context.id, error, cleanupError);
              }
              if (!released) {
                throw WorkerProviderError.cleanupIndeterminate(
                  context.id,
                  error,
                  new Error("Snapshot rejection has not proved local claim absence"),
                );
              }
              throw WorkerProviderError.cleanupComplete(context.id, error);
            }
            throw error;
          } finally {
            reportCrabboxSnapshotPhase(
              context.timingIdentity ?? { operationId: context.id },
              "snapshot.fork.provider",
              {
                durationMs: performance.now() - started,
                outcome,
                nonAdditive: true,
              },
            );
          }
        } else {
          if (image?.kind === "azure-sandbox-snapshot") {
            throw new Error(
              "Snapshot restore has no original source binding; ownership is preserved",
            );
          }
          parseForkedCheckpoint(
            await checkpointCommand(
              context,
              "fork",
              [
                "checkpoint",
                "fork",
                checkpointId,
                ...buildCrabboxAllocationArgs(context.profile, context.id, context.slug),
                "--json",
              ],
              context.timeoutMs(),
            ).catch(async (error: unknown) => {
              await verifyCheckpoint(context, owner.key, checkpointId, true);
              throw error;
            }),
            { checkpointId, leaseId: context.id, provider: context.provider, slug: context.slug },
          );
        }
        await openStore().update(owner.key, (current) => {
          assertCurrent(context);
          return withCrabboxWarmImageGeneration(current, owner.imageGeneration, (generation) => ({
            ...generation,
            state: "available",
            lastDemandAtMs:
              owner.purpose === "session" || owner.demandAtMs === null
                ? generation.lastDemandAtMs
                : Math.max(generation.lastDemandAtMs ?? 0, owner.demandAtMs),
          }));
        });
        return owner.choice;
      }
    }
    if (!context.profile.warmImage) {
      context.reportStartStatus?.(startStatus);
    }
    assertCurrent(context);
    await runProvisionWarmup(context);
    return { kind: "cold" };
  };
}

export function createCrabboxWarmImageStartContext(
  binary: string,
  provider: string,
  options: Parameters<WorkerProvider["provision"]>[2],
  prepareProject: boolean,
) {
  let status: WarmStartStatus | undefined;
  return {
    binary,
    provider,
    prepareProject,
    reportStartStatus: (next: WarmStartStatus) => {
      status = next;
      options?.reportStartStatus?.(next);
    },
    onCaptureStart: () => {
      if (status) {
        options?.reportStartStatus?.({ ...status, phase: "saving" });
      }
    },
    onCaptureEnd: () => {
      if (status) {
        options?.reportStartStatus?.(status);
      }
    },
  };
}

export async function releaseCrabboxWarmImageAllocation(
  context: CheckpointContext & { id: string; provider: string },
  dependencies: {
    openStore: () => ReturnType<typeof openCrabboxWarmImageStore>;
    snapshotDirectory: string;
    retireImage: (
      context: CheckpointContext,
      key: string,
      record: WarmProfileRecord,
      remainingMs: () => number,
    ) => Promise<void>;
    deleteImage: (
      context: CheckpointContext,
      key: string,
      record: WarmProfileRecord,
      remainingMs: () => number,
    ) => Promise<void>;
    deleteEmptyProfile: (key: string) => Promise<boolean>;
    warnOnce: (action: string, error: unknown) => void;
  },
  expected?: AllocationOwner,
) {
  const { openStore, snapshotDirectory, retireImage, deleteImage, deleteEmptyProfile, warnOnce } =
    dependencies;
  // Only confirmed stop or absence releases this hold: enrollment success may be a lost response,
  // and replay still needs the original checkpoint catalog entry and native artifact.
  const owner = await openStore().lookupLease(context.id);
  if (!owner) {
    return;
  }
  await openStore().update(owner.key, (record) => {
    if (!record?.allocations[context.id]) {
      if (expected) {
        throw new Error("Rejected snapshot allocation changed before release");
      }
      return undefined;
    }
    context.assertCurrent?.();
    context.signal?.throwIfAborted();
    if (
      expected &&
      !isDeepStrictEqual(
        { key: owner.key, projectKey: record.projectKey, ...record.allocations[context.id] },
        expected,
      )
    ) {
      throw new Error("Rejected snapshot allocation changed before release");
    }
    const allocations = { ...record.allocations };
    delete allocations[context.id];
    return { ...record, allocations };
  });
  if (expected) {
    // No lease was admitted. Keep the rejected input exports as diagnostics and leave
    // the shared seed unchanged; neither template retirement nor provider I/O is needed.
    return;
  }
  if (owner.azureSnapshotBinding) {
    // The lease is already proven stopped. Exports are per allocation;
    // cleaning one borrow never removes another lease's binding files.
    await removePathWithinRoot({
      rootDir: snapshotDirectory,
      relativePath: context.id,
      recursive: true,
      force: true,
    }).catch((error: unknown) => warnOnce("derived snapshot binding cleanup", error));
  }
  const deadline = performance.now() + WARM_IMAGE_COMMAND_TIMEOUT_MS;
  const remaining = () => deadline - performance.now();
  const current = await openStore().lookup(owner.key);
  if (current) {
    await retireImage(context, owner.key, current, remaining);
  }
  const released = await openStore().lookup(owner.key);
  if (released?.image?.lastDemandAtMs === null) {
    // A failed session never earned retention. Keep any failed deletion as normal debt.
    await deleteImage(context, owner.key, released, remaining);
  }
  await deleteEmptyProfile(owner.key);
}
