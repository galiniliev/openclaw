import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import {
  createCrabboxSnapshotAllocationBinding,
  materializeCrabboxSnapshotBinding,
  readCrabboxSnapshotVerifier,
  type AzureSandboxImage,
} from "./crabbox-worker-azure-snapshot-binding.js";
import { parseCrabboxProfile } from "./crabbox-worker-profile.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtime = {
  runtimeImage: `registry.example/worker@sha256:${"a".repeat(64)}`,
  buildId: "fixture-build",
  runtimeVersion: "2026.10.4",
  enabledPluginIds: ["codex"],
  nodeBootstrapSha256: "b".repeat(64),
  workerBundleSha256: "c".repeat(64),
  bundleHash: "d".repeat(64),
  cacheHitVerified: true as const,
};
const identity = {
  nodeBootstrapSha256: runtime.nodeBootstrapSha256,
  workerBundleSha256: runtime.workerBundleSha256,
  executionMode: "worker-turn" as const,
};
const clean = {
  schema: "crabbox.pre-enrollment-state.v1",
  credentialEnvironmentAbsent: true,
  credentialAndSessionPathsAbsent: true,
  workerStateLimitedToPreparedCaches: true,
  workspaceEmpty: true,
};
const receipt = {
  preEnrollment: clean,
  checkedCredentialPathsAbsent: true,
  preparedRuntime: runtime,
};
const profile = parseCrabboxProfile({
  provider: "azure-sandbox",
  class: "standard",
  ttl: "4h",
  idleTimeout: "60m",
});

it("consumes the canonical clean receipt and preserves its exact attestation bytes", () => {
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  expect(readCrabboxSnapshotVerifier(bytes, identity)).toEqual({
    preparedRuntime: runtime,
    verifier: bytes,
    verifierSha256: createHash("sha256").update(bytes).digest("hex"),
  });
});

it.each([
  {
    name: "unclean workspace",
    value: { ...receipt, preEnrollment: { ...clean, workspaceEmpty: false } },
  },
  {
    name: "wrong clean schema",
    value: { ...receipt, preEnrollment: { ...clean, schema: "teamclaw.pre-enrollment-state.v1" } },
  },
  {
    name: "unprojected version",
    value: {
      ...receipt,
      preparedRuntime: { ...runtime, runtimeVersion: undefined, openclawVersion: "2026.10.4" },
    },
  },
  {
    name: "wrong node archive",
    value: { ...receipt, preparedRuntime: { ...runtime, nodeBootstrapSha256: "e".repeat(64) } },
  },
  {
    name: "wrong worker archive",
    value: { ...receipt, preparedRuntime: { ...runtime, workerBundleSha256: "e".repeat(64) } },
  },
  {
    name: "mutable base image",
    value: {
      ...receipt,
      preparedRuntime: { ...runtime, runtimeImage: "registry.example/worker:latest" },
    },
  },
])("rejects $name before a snapshot can be admitted", ({ value }) => {
  expect(() => readCrabboxSnapshotVerifier(JSON.stringify(value), identity)).toThrow();
});

it("regenerates exact pinned ce7 exports without changing a sibling allocation", async () => {
  const directory = tempDirs.make("snapshot-bindings-");
  const verifier = `${JSON.stringify(receipt)}\n`;
  const image: AzureSandboxImage = {
    ...readCrabboxSnapshotVerifier(verifier, identity),
    snapshotId: "snapshot-original",
    sourceSandboxId: "sandbox-original",
    sourceDiskId: "disk-original",
    operationId: "11111111-1111-4111-8111-111111111111",
    capturedAt: "2026-10-21T00:00:00Z",
    providerScope: "azure-sandbox:eastus:subscription:resource-group:sandbox-group",
    scope: {
      region: "eastus",
      subscriptionId: "subscription",
      resourceGroup: "resource-group",
      group: "sandbox-group",
    },
    route: {
      sdkPython: "/qualified/bin/python",
      configFile: "/qualified/config",
      sdkIdentity: { kind: "azure-cli" },
    },
  };
  const binding = createCrabboxSnapshotAllocationBinding(
    image,
    profile,
    Date.parse("2026-10-21T01:00:00Z"),
  );
  const exported = await materializeCrabboxSnapshotBinding(
    directory,
    image,
    binding,
    "allocation-one",
  );
  const sibling = await materializeCrabboxSnapshotBinding(
    directory,
    image,
    binding,
    "allocation-two",
  );
  const expectedReceipt = {
    schema: "crabbox.azure-sandbox-snapshot.v1",
    providerScope: "azure-sandbox:eastus:subscription:resource-group:sandbox-group",
    snapshotId: "snapshot-original",
    sourceSandboxId: "sandbox-original",
    sourceDiskId: "disk-original",
    capturedAt: "2026-10-21T00:00:00Z",
    validUntil: "2026-10-21T05:00:00.000Z",
    verifierFile: "verifier.json",
    verifierSha256: createHash("sha256").update(verifier).digest("hex"),
    preparedRuntime: runtime,
    lifecycle: {
      autoSuspendPolicy: { enabled: true, interval: 3600, mode: "Disk" },
      autoDeletePolicy: { enabled: true, deleteIntervalInSeconds: 14400 },
    },
  };
  expect(JSON.parse(await fs.readFile(exported.receiptPath, "utf8"))).toEqual(expectedReceipt);
  expect(exported.generation).toBe(createHash("sha256").update(binding.receipt).digest("hex"));
  await fs.rm(path.join(directory, "allocation-one"), { recursive: true });
  const regenerated = await materializeCrabboxSnapshotBinding(
    directory,
    image,
    binding,
    "allocation-one",
  );
  expect(regenerated).toEqual(exported);
  expect(await fs.readFile(regenerated.receiptPath, "utf8")).toBe(binding.receipt);
  expect(
    await fs.readFile(path.join(path.dirname(regenerated.receiptPath), "verifier.json"), "utf8"),
  ).toBe(verifier);
  expect(await fs.readFile(sibling.receiptPath, "utf8")).toBe(binding.receipt);
});

it("accepts first-installer verification without inventing a cache hit", () => {
  const { cacheHitVerified: _legacy, ...fields } = runtime;
  const preparedRuntime = { ...fields, installationVerified: true as const };
  expect(
    readCrabboxSnapshotVerifier(JSON.stringify({ ...receipt, preparedRuntime }), identity)
      .preparedRuntime,
  ).toEqual(preparedRuntime);
  expect(() =>
    readCrabboxSnapshotVerifier(
      JSON.stringify({ ...receipt, preparedRuntime: { ...fields, installationVerified: false } }),
      identity,
    ),
  ).toThrow();
});
