import { afterEach, describe, expect, it, vi } from "vitest";
import * as processRunner from "./crabbox-process.js";
import {
  createCrabboxSnapshotAllocationBinding,
  type AzureSandboxImage,
} from "./crabbox-worker-azure-snapshot-binding.js";
import { parseCrabboxProfile } from "./crabbox-worker-profile.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import {
  hasNoCrabboxLocalClaim,
  isCrabboxRejectedSnapshotBinding,
  isCrabboxSnapshotBindingRejection,
} from "./crabbox-worker-snapshot-rejection.js";

afterEach(() => vi.restoreAllMocks());

const image: AzureSandboxImage = {
  snapshotId: "snapshot-original",
  operationId: "capture-original",
  sourceSandboxId: "sandbox-original",
  sourceDiskId: "disk-original",
  capturedAt: "2026-01-01T00:00:00Z",
  providerScope: "azure-sandbox:eastus:subscription:group:sandboxes",
  scope: {
    region: "eastus",
    subscriptionId: "subscription",
    resourceGroup: "group",
    group: "sandboxes",
  },
  route: {
    sdkPython: "/qualified/python",
    configFile: "/qualified/config",
    sdkIdentity: { kind: "azure-cli" },
  },
  verifier: "{}",
  verifierSha256: "a".repeat(64),
  preparedRuntime: {
    runtimeImage: `registry.example/worker@sha256:${"b".repeat(64)}`,
    buildId: "fixture-build",
    runtimeVersion: "2026.10.4",
    enabledPluginIds: [],
    nodeBootstrapSha256: "c".repeat(64),
    workerBundleSha256: "d".repeat(64),
    bundleHash: "e".repeat(64),
    installationVerified: true,
  },
};

describe("snapshot rejection cleanup boundary", () => {
  it.each([
    ["closed rejection", {}, true],
    ["timeout", { termination: "timeout", code: null }, false],
    ["signal", { termination: "signal", code: null }, false],
    ["different exit", { code: 4 }, false],
    ["unknown failure", { stderr: "strict claim identifier mismatch" }, false],
    ["partial success output", { stdout: "{}" }, false],
    [
      "provider effect",
      {
        stderr:
          'ACA snapshot binding is invalid\n{"runnerPhases":[{"name":"provider.acquire","ms":1}]}',
      },
      false,
    ],
    [
      "empty timing",
      { stderr: 'ACA snapshot binding is invalid\n{"runnerPhases":[],"creationEvents":[]}' },
      true,
    ],
  ] as const)("qualifies only the closed pre-acquire result: %s", (_name, patch, expected) => {
    expect(
      isCrabboxSnapshotBindingRejection(
        commandResult({ code: 1, stderr: "ACA snapshot binding is invalid", ...patch }),
      ),
    ).toBe(expected);
  });

  it("binds legacy requalification to the original image and exact pinned receipt", () => {
    const profile = parseCrabboxProfile({
      provider: "azure-sandbox",
      ttl: "4h",
      idleTimeout: "60m",
    });
    const binding = createCrabboxSnapshotAllocationBinding(
      image,
      profile,
      Date.parse("2026-01-01T00:01:00Z"),
    );
    expect(isCrabboxRejectedSnapshotBinding(image, binding)).toBe(true);
    expect(
      isCrabboxRejectedSnapshotBinding(image, { ...binding, receipt: binding.receipt + " " }),
    ).toBe(false);
    expect(isCrabboxRejectedSnapshotBinding({ ...image, snapshotId: "replacement" }, binding)).toBe(
      false,
    );
    const supported = {
      ...image,
      preparedRuntime: { ...image.preparedRuntime, cacheHitVerified: true as const },
    };
    expect(
      isCrabboxRejectedSnapshotBinding(
        supported,
        createCrabboxSnapshotAllocationBinding(
          supported,
          profile,
          Date.parse("2026-01-01T00:01:00Z"),
        ),
      ),
    ).toBe(false);
  });

  it.each(["absent", "present", "problems", "partial", "malformed", "revoked"] as const)(
    "requires a complete local claim read with current authority: %s",
    async (scenario) => {
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("Authority revoked");
        }
      };
      const run = vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(async () => {
        if (scenario === "revoked") {
          current = false;
        }
        return commandResult({
          code: scenario === "partial" ? 2 : 0,
          stdout:
            scenario === "malformed"
              ? "{"
              : JSON.stringify({
                  version: 1,
                  source: "local-claims",
                  claims: [{ leaseId: scenario === "present" ? "cbx_failed" : "cbx_working" }],
                  problems: scenario === "problems" ? [{ code: "invalid_claim" }] : [],
                }),
        });
      });
      const read = hasNoCrabboxLocalClaim(
        { binary: "crabbox", provider: "azure-sandbox", id: "cbx_failed" },
        assertCurrent,
      );
      if (scenario === "malformed" || scenario === "revoked") {
        await expect(read).rejects.toThrow(
          scenario === "revoked" ? "Authority revoked" : "invalid JSON",
        );
      } else {
        await expect(read).resolves.toBe(scenario === "absent");
      }
      expect(run.mock.calls[0]?.[0]).toEqual(["crabbox", "claims", "list", "--json"]);
    },
  );
});
