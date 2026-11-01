import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { WorkerSessionDiskRetention } from "openclaw/plugin-sdk/plugin-entry";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  AzureSandboxAllocationBinding,
  AzureSandboxImage,
} from "./crabbox-worker-azure-snapshot-binding.js";
import {
  parseCrabboxJson,
  runCrabboxCommand,
  type LeaseCommandContext,
} from "./crabbox-worker-command.js";
import {
  sameCrabboxWarmImageGeneration,
  type openCrabboxWarmImageStore,
} from "./crabbox-worker-warm-image-store.js";

type Store = ReturnType<typeof openCrabboxWarmImageStore>;
type AllocationOwner = NonNullable<Awaited<ReturnType<Store["lookupLease"]>>>;

/** A closed CLI rejection emitted before snapshot acquire can connect or admit a claim. */
export class CrabboxSnapshotBindingRejectedError extends Error {
  constructor() {
    super("ACA snapshot binding is invalid");
    this.name = "CrabboxSnapshotBindingRejectedError";
  }
}

export function isCrabboxSnapshotBindingRejection(result: SpawnResult): boolean {
  if (
    result.termination !== "exit" ||
    result.code !== 1 ||
    result.outputLimitExceeded ||
    result.stdout.trim() !== ""
  ) {
    return false;
  }
  let rejected = false;
  for (const line of result.stderr.trim().split(/\r?\n/u)) {
    if (line === "ACA snapshot binding is invalid" && !rejected) {
      rejected = true;
      continue;
    }
    let timing: unknown;
    try {
      timing = JSON.parse(line);
    } catch {
      return false;
    }
    if (
      !isRecord(timing) ||
      !Array.isArray(timing.runnerPhases) ||
      timing.runnerPhases.length !== 0 ||
      (timing.creationEvents !== undefined &&
        (!Array.isArray(timing.creationEvents) || timing.creationEvents.length !== 0))
    ) {
      return false;
    }
  }
  return rejected;
}

/** Requalify the producer's exact immutable receipt, not an arbitrary failed allocation. */
export function isCrabboxRejectedSnapshotBinding(
  image: AzureSandboxImage,
  binding: AzureSandboxAllocationBinding,
): boolean {
  if (createHash("sha256").update(binding.receipt).digest("hex") !== binding.generation) {
    return false;
  }
  let value: unknown;
  try {
    value = JSON.parse(binding.receipt);
  } catch {
    return false;
  }
  return (
    isRecord(value) &&
    value.schema === "crabbox.azure-sandbox-snapshot.v1" &&
    value.providerScope === image.providerScope &&
    value.snapshotId === image.snapshotId &&
    value.sourceSandboxId === image.sourceSandboxId &&
    value.sourceDiskId === image.sourceDiskId &&
    value.capturedAt === image.capturedAt &&
    value.verifierSha256 === image.verifierSha256 &&
    value.verifierFile === "verifier.json" &&
    isDeepStrictEqual(value.preparedRuntime, image.preparedRuntime) &&
    isRecord(value.preparedRuntime) &&
    value.preparedRuntime.installationVerified === true &&
    !Object.hasOwn(value.preparedRuntime, "cacheHitVerified")
  );
}

/** The child inherits the Gateway claim namespace; partial or failed local reads cannot settle cleanup. */
export async function hasNoCrabboxLocalClaim(
  context: LeaseCommandContext,
  assertCurrent: () => void,
  signal?: AbortSignal,
): Promise<boolean> {
  assertCurrent();
  const result = await runCrabboxCommand({
    ...context,
    action: "claims list",
    args: ["claims", "list", "--json"],
    timeoutMs: 30_000,
    signal,
  });
  assertCurrent();
  if (result.termination !== "exit" || result.code !== 0 || result.outputLimitExceeded) {
    return false;
  }
  const value = parseCrabboxJson(result.stdout, "claims list");
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.source === "local-claims" &&
    Array.isArray(value.problems) &&
    value.problems.length === 0 &&
    Array.isArray(value.claims) &&
    value.claims.every(
      (claim: unknown) =>
        isRecord(claim) && typeof claim.leaseId === "string" && claim.leaseId !== context.id,
    )
  );
}

export async function releaseCrabboxRejectedSnapshotAllocation(
  context: LeaseCommandContext & {
    retention?: WorkerSessionDiskRetention;
    assertCurrent?: () => void;
    signal?: AbortSignal;
  },
  dependencies: {
    openStore: () => Store;
    qualifyLegacyContract?: (binary: string) => Promise<boolean>;
    release: (
      context: LeaseCommandContext & { assertCurrent?: () => void; signal?: AbortSignal },
      expected: AllocationOwner,
    ) => Promise<void>;
  },
): Promise<boolean> {
  if (context.provider !== "azure-sandbox") {
    return false;
  }
  const store = dependencies.openStore();
  const owner = await store.lookupLease(context.id);
  if (
    !owner ||
    owner.phase !== "pending" ||
    owner.choice.kind !== "checkpoint" ||
    owner.retentionOwnerBinding !== context.retention?.ownerBinding ||
    !owner.azureSnapshotBinding ||
    (owner.snapshotPreflightOutcome !== undefined &&
      (!isRecord(owner.snapshotPreflightOutcome) ||
        owner.snapshotPreflightOutcome.generation !== owner.azureSnapshotBinding.generation ||
        owner.snapshotPreflightOutcome.outcome !== "rejected"))
  ) {
    return false;
  }
  // Older allocations have no outcome field. Their exact installationVerified-only receipt
  // cannot pass ce7's closed snapshot binding decoder, which runs before connect/acquire.
  // Requalification still requires its original image/generation and a complete local claim read.
  // New unknown/canceled outcomes above never enter this legacy path.
  const record = await store.lookup(owner.key);
  const checkpointId = owner.choice.checkpointId;
  const image = [record?.image, record?.previous].find(
    (candidate) => candidate?.checkpointId === checkpointId,
  );
  if (
    record?.operation ||
    !image?.azureSandbox ||
    !owner.runtimeIdentity ||
    owner.runtimeIdentity.nodeBootstrapSha256 !==
      image.azureSandbox.preparedRuntime.nodeBootstrapSha256 ||
    (owner.runtimeIdentity.workerBundleSha256 !== undefined &&
      owner.runtimeIdentity.workerBundleSha256 !==
        image.azureSandbox.preparedRuntime.workerBundleSha256) ||
    !sameCrabboxWarmImageGeneration(image, owner.imageGeneration) ||
    !isCrabboxRejectedSnapshotBinding(image.azureSandbox, owner.azureSnapshotBinding)
  ) {
    return false;
  }
  const assertCurrent = () => {
    context.assertCurrent?.();
    context.signal?.throwIfAborted();
  };
  if (
    !owner.snapshotPreflightOutcome &&
    !(await dependencies.qualifyLegacyContract?.(context.binary))
  ) {
    return false;
  }
  assertCurrent();
  if (!(await hasNoCrabboxLocalClaim(context, assertCurrent, context.signal))) {
    return false;
  }
  assertCurrent();
  await dependencies.release(context, owner);
  return true;
}
