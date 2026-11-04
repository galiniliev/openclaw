import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileWithinRoot } from "openclaw/plugin-sdk/file-access-runtime";
import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  AzureSandboxSnapshotFact,
  AzureSandboxSnapshotScope,
} from "./crabbox-worker-azure-snapshot.js";
import { parseCrabboxDurationMs, type parseCrabboxProfile } from "./crabbox-worker-profile.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

type Profile = ReturnType<typeof parseCrabboxProfile>;
type WorkerNodeRuntimeIdentity = NonNullable<
  NonNullable<Parameters<WorkerProvider["provision"]>[2]>["nodeRuntimeIdentity"]
>;
export type AzureSandboxPreparedRuntime = {
  runtimeImage: string;
  buildId: string;
  runtimeVersion: string;
  enabledPluginIds: string[];
  nodeBootstrapSha256: string;
  workerBundleSha256: string;
  bundleHash: string;
} & ({ installationVerified: true } | { cacheHitVerified: true });

export type AzureSandboxImage = AzureSandboxSnapshotFact & {
  providerScope: string;
  scope: AzureSandboxSnapshotScope;
  sourceDiskId: string;
  preparedRuntime: AzureSandboxPreparedRuntime;
  /** Original canonical producer receipt, not a second native verifier. */
  verifier: string;
  verifierSha256: string;
  route: {
    sdkPython: string;
    configFile: string;
    sdkIdentity: NonNullable<Profile["sdkIdentity"]>;
  };
};
export type AzureSandboxCaptureAdmission = Omit<AzureSandboxImage, "snapshotId" | "capturedAt">;

/** Stored in the existing allocation before its first fixed-warmup effect. */
export type AzureSandboxAllocationBinding = {
  receipt: string;
  generation: string;
};

export function readCrabboxSnapshotVerifier(
  output: string,
  expected: WorkerNodeRuntimeIdentity,
): { preparedRuntime: AzureSandboxPreparedRuntime; verifier: string; verifierSha256: string } {
  let receipt: unknown;
  try {
    receipt = JSON.parse(output);
  } catch {
    throw new Error("Snapshot verifier must return its complete canonical JSON receipt");
  }
  if (
    !isRecord(receipt) ||
    !isRecord(receipt.preEnrollment) ||
    receipt.preEnrollment.schema !== "crabbox.pre-enrollment-state.v1" ||
    receipt.preEnrollment.credentialEnvironmentAbsent !== true ||
    receipt.preEnrollment.credentialAndSessionPathsAbsent !== true ||
    receipt.preEnrollment.workerStateLimitedToPreparedCaches !== true ||
    receipt.preEnrollment.workspaceEmpty !== true ||
    receipt.checkedCredentialPathsAbsent !== true ||
    !isRecord(receipt.preparedRuntime)
  ) {
    throw new Error("Snapshot verifier did not attest clean pre-enrollment state");
  }
  const runtime = receipt.preparedRuntime;
  const plugins = runtime.enabledPluginIds;
  if (
    typeof runtime.runtimeImage !== "string" ||
    !/^\S+@sha256:[a-f0-9]{64}$/u.test(runtime.runtimeImage) ||
    typeof runtime.buildId !== "string" ||
    !runtime.buildId ||
    typeof runtime.runtimeVersion !== "string" ||
    !runtime.runtimeVersion ||
    !Array.isArray(plugins) ||
    !plugins.every(
      (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 128,
    ) ||
    runtime.nodeBootstrapSha256 !== expected.nodeBootstrapSha256 ||
    typeof runtime.workerBundleSha256 !== "string" ||
    !DIGEST.test(runtime.workerBundleSha256) ||
    (expected.workerBundleSha256 !== undefined &&
      runtime.workerBundleSha256 !== expected.workerBundleSha256) ||
    typeof runtime.bundleHash !== "string" ||
    !DIGEST.test(runtime.bundleHash) ||
    (runtime.installationVerified !== true && runtime.cacheHitVerified !== true)
  ) {
    throw new Error(
      "Snapshot verifier runtime differs from the admitted immutable worker archives",
    );
  }
  return {
    preparedRuntime: {
      runtimeImage: runtime.runtimeImage,
      buildId: runtime.buildId,
      runtimeVersion: runtime.runtimeVersion,
      enabledPluginIds: plugins,
      nodeBootstrapSha256: expected.nodeBootstrapSha256,
      workerBundleSha256: runtime.workerBundleSha256,
      bundleHash: runtime.bundleHash,
      ...(runtime.installationVerified === true
        ? { installationVerified: true as const }
        : { cacheHitVerified: true as const }),
    },
    verifier: output,
    verifierSha256: sha256(output),
  };
}

export function createCrabboxSnapshotAllocationBinding(
  image: AzureSandboxImage,
  profile: Profile,
  nowMs: number,
): AzureSandboxAllocationBinding {
  const ttlMs = parseCrabboxDurationMs(profile.ttl);
  if (
    !ttlMs ||
    !Number.isSafeInteger(ttlMs / 1000) ||
    !Number.isSafeInteger(profile.idleTimeoutMs / 1000)
  ) {
    throw new Error("Snapshot restore requires whole-second TTL and idle intervals");
  }
  // These are the requested new lease's bounds, not a claim about the captured
  // builder's billing policy. ce7 applies and reads back retained policy itself.
  const receipt = JSON.stringify({
    schema: "crabbox.azure-sandbox-snapshot.v1",
    providerScope: image.providerScope,
    snapshotId: image.snapshotId,
    sourceSandboxId: image.sourceSandboxId,
    sourceDiskId: image.sourceDiskId,
    capturedAt: image.capturedAt,
    validUntil: new Date(nowMs + ttlMs).toISOString(),
    verifierFile: "verifier.json",
    verifierSha256: image.verifierSha256,
    preparedRuntime: image.preparedRuntime,
    lifecycle: {
      autoSuspendPolicy: { enabled: true, interval: profile.idleTimeoutMs / 1000, mode: "Disk" },
      autoDeletePolicy: { enabled: true, deleteIntervalInSeconds: ttlMs / 1000 },
    },
  });
  return { receipt, generation: sha256(receipt) };
}

/** JSON files are derived exports required by the unchanged Crabbox CLI contract.
 * SQLite owns their exact bytes and pin; missing exports never replay capture.
 */
export async function materializeCrabboxSnapshotBinding(
  directory: string,
  image: AzureSandboxImage,
  binding: AzureSandboxAllocationBinding,
  allocationId: string,
): Promise<{ receiptPath: string; generation: string }> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFileWithinRoot({
    rootDir: directory,
    relativePath: `${allocationId}/${binding.generation}/verifier.json`,
    data: image.verifier,
    mkdir: true,
  });
  await writeFileWithinRoot({
    rootDir: directory,
    relativePath: `${allocationId}/${binding.generation}/binding.json`,
    data: binding.receipt,
    mkdir: true,
  });
  return {
    receiptPath: path.join(directory, allocationId, binding.generation, "binding.json"),
    generation: binding.generation,
  };
}
