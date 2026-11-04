import type {
  WorkerRetainedLeaseReceipt,
  WorkerSessionDiskRetention,
} from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, expect, it, vi } from "vitest";
import * as processRunner from "./crabbox-process.js";
import {
  createCrabboxRetainedLeaseOperations,
  inspectCrabboxRetainedLease,
} from "./crabbox-worker-retention.js";

const receipt: WorkerRetainedLeaseReceipt = {
  schema: "crabbox.session-disk.v1",
  mode: "session-disk",
  ownerBinding: "b".repeat(64),
  identity: {
    leaseId: "cbx_0123456789ab",
    attemptLeaseId: "cbx_abcdef123456",
    slug: "owned",
    resourceId: "resource-owned",
  },
  claimRevision: "revision-2",
  computeWindowSeconds: 60,
  desiredState: "running",
  computeWindow: {
    id: "cbx_0123456789ab",
    authorizedAt: "2026-10-18T10:00:00Z",
    expiresAt: "2026-10-18T10:01:00Z",
    state: "active",
  },
  policyVerified: true,
  observedState: "Running",
  stopPending: false,
};
const retention: WorkerSessionDiskRetention = {
  policy: { mode: "session-disk", computeWindowSeconds: 60 },
  owner: { sessionId: "test-session", sessionKey: "agent:main:test", agentId: "main" },
  ownerBinding: receipt.ownerBinding,
  desiredState: "running",
  receipt,
  operation: { id: "pause-original", action: "pause", expectedClaimRevision: "revision-original" },
};
const profile = { provider: "azure-sandbox", ttl: "60m", idleTimeout: "15m" };
const result = (value: unknown) => ({
  stdout: JSON.stringify(value),
  stderr: "",
  code: 0,
  killed: false,
  signal: null,
  termination: "exit" as const,
});
afterEach(() => vi.restoreAllMocks());

it("dispatches persisted exact identity and original operation revision, never a guessed attempt or new window", async () => {
  const run = vi.spyOn(processRunner, "runCrabboxProcess").mockResolvedValue(
    result({
      id: receipt.identity.leaseId,
      state: "suspended",
      retention: {
        ...receipt,
        desiredState: "suspended",
        observedState: "Stopped",
        computeWindow: { ...receipt.computeWindow, state: "closed" },
      },
    }),
  );
  const operations = createCrabboxRetainedLeaseOperations(async () => ({
    binary: "/test/crabbox",
  }));
  await operations.pause({
    leaseId: receipt.identity.leaseId,
    profile,
    retention,
    operationId: "pause-original",
    signal: new AbortController().signal,
    assertCurrent: () => {},
  });
  const argv = run.mock.calls[0]?.[0];
  expect(argv).toEqual([
    "/test/crabbox",
    "pause",
    "--provider",
    "azure-sandbox",
    "--id",
    receipt.identity.leaseId,
    "--json",
    "--operation-id",
    "pause-original",
    "--owner-binding",
    receipt.ownerBinding,
    "--expected-claim-revision",
    "revision-original",
    "--expected-provider-lease-id",
    "cbx_0123456789ab",
    "--expected-provider-attempt-lease-id",
    "cbx_abcdef123456",
    "--expected-provider-slug",
    "owned",
    "--expected-provider-resource-id",
    "resource-owned",
  ]);
});

it.each(["deleted", "unknown"])(
  "settles destructive cleanup only from exact released tombstone (%s)",
  async (state) => {
    const run = vi
      .spyOn(processRunner, "runCrabboxProcess")
      .mockResolvedValueOnce(
        result({ id: receipt.identity.leaseId, state: "running", retention: receipt }),
      )
      .mockResolvedValueOnce(result({}))
      .mockResolvedValueOnce(
        result({
          id: receipt.identity.leaseId,
          state,
          retention: {
            ...receipt,
            desiredState: "retired",
            observedState: "",
            policyVerified: false,
          },
        }),
      );
    const operations = createCrabboxRetainedLeaseOperations(async () => ({
      binary: "/test/crabbox",
    }));
    const deleting = operations.destroy({
      leaseId: receipt.identity.leaseId,
      profile,
      retention,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    if (state === "deleted") {
      await expect(deleting).resolves.toBeUndefined();
    } else {
      await expect(deleting).rejects.toThrow("cleanup remains pending");
    }
    expect(run.mock.calls.map(([argv]) => argv[1])).toEqual(["status", "stop", "status"]);
  },
);

it("refuses incomplete identity before submitting any lifecycle effect", async () => {
  const run = vi.spyOn(processRunner, "runCrabboxProcess").mockResolvedValue(
    result({
      id: receipt.identity.leaseId,
      state: "unknown",
      retention: { ...receipt, identity: { ...receipt.identity, resourceId: "" } },
    }),
  );
  const operations = createCrabboxRetainedLeaseOperations(async () => ({
    binary: "/test/crabbox",
  }));
  await expect(
    operations.destroy({
      leaseId: receipt.identity.leaseId,
      profile,
      retention,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    }),
  ).rejects.toThrow("incomplete");
  expect(run).toHaveBeenCalledOnce();
});

it.each(["missing", "unknown", "wrong-owner", "wrong-resource", "403", "timeout"] as const)(
  "keeps exact missing-resource observation separate from deletion and uncertainty (%s)",
  async (outcome) => {
    vi.spyOn(processRunner, "runCrabboxProcess").mockResolvedValue(
      outcome === "403" || outcome === "timeout"
        ? {
            ...result({}),
            code: outcome === "timeout" ? null : 1,
            termination: outcome === "timeout" ? "timeout" : "exit",
            killed: outcome === "timeout",
            stderr: outcome,
          }
        : result({
            id: receipt.identity.leaseId,
            state: outcome === "unknown" ? "unknown" : "missing",
            retention: {
              ...receipt,
              policyVerified: false,
              ...(outcome === "wrong-owner" ? { ownerBinding: "c".repeat(64) } : {}),
              identity: {
                ...receipt.identity,
                ...(outcome === "wrong-resource" ? { resourceId: "different-resource" } : {}),
              },
            },
          }),
    );
    const operations = createCrabboxRetainedLeaseOperations(async () => ({
      binary: "/test/crabbox",
    }));
    const inspection = inspectCrabboxRetainedLease(
      {
        leaseId: receipt.identity.leaseId,
        profile,
        retention,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      },
      operations,
    );
    if (outcome === "missing") {
      // Unknown requests canonical cleanup; only delete/readback can prove gone.
      await expect(inspection).resolves.toEqual({ status: "unknown" });
    } else {
      await expect(inspection).rejects.toThrow();
    }
    expect(processRunner.runCrabboxProcess).toHaveBeenCalledTimes(1);
  },
);
