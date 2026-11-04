import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, expect, it, vi } from "vitest";
import * as processRunner from "./crabbox-process.js";
import { reportCrabboxProvisionTiming } from "./crabbox-provision-timing.js";
import { parseCrabboxProfile, resolveCrabboxProvisionProfile } from "./crabbox-worker-profile.js";
import { runProvisionSetup, runProvisionWarmup } from "./crabbox-worker-provision-commands.js";

const { info } = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("openclaw/plugin-sdk/logging-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/logging-core")>()),
  createSubsystemLogger: () => ({ info }),
}));
const identity = { environmentId: "environment-test", operationId: "operation-test" };
const report = {
  provider: "azure-sandbox",
  leaseId: "private-lease",
  privateUrl: "https://private.invalid",
  runnerPhases: [
    { name: "provider.sandbox.create", ms: 250, opaque: true, reason: "private details" },
    {
      name: "bootstrap.runtime.transfer",
      ms: 120,
      overlapping: true,
      privateUrl: "https://private.invalid",
    },
    { name: "https://private.invalid", ms: 10 },
    { name: "provider.sandbox.inspect", ms: -1 },
  ],
  creationEvents: [
    {
      phase: "provider_step",
      source: "client",
      step: "provider.sandbox.create",
      durationMs: 250,
      count: 2,
    },
    { phase: "provider_step", source: "client", step: "private", durationMs: 100, count: 1 },
  ],
};
const result: SpawnResult = {
  stdout: "",
  stderr: `notice\n${JSON.stringify(report)}\n`,
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
};
afterEach(() => {
  vi.restoreAllMocks();
  info.mockReset();
});

it.each([0, 1])("emits only bounded timing fields for warmup exit %s", (code) => {
  reportCrabboxProvisionTiming({ ...result, code }, identity);
  expect(info).toHaveBeenCalledExactlyOnceWith("Crabbox provisioning timing", {
    ...identity,
    outcome: code === 0 ? "success" : "failed",
    runnerPhases: [
      { phase: "provider.sandbox.create", durationMs: 250, opaque: true },
      { phase: "bootstrap.runtime.transfer", durationMs: 120, overlapping: true },
    ],
    creationEvents: [{ phase: "provider.sandbox.create", durationMs: 250, count: 2 }],
  });
});

it("ignores malformed timing and stdout allocation rejections", () => {
  for (const stderr of [
    "not json",
    '{"runnerPhases":[',
    JSON.stringify({ ...report, padding: "x".repeat(32768) }),
  ]) {
    reportCrabboxProvisionTiming({ ...result, stdout: JSON.stringify(report), stderr }, identity);
  }
  expect(info).not.toHaveBeenCalled();
});

it("records settled cancellation timing without changing the cancellation result", async () => {
  const controller = new AbortController();
  vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(async () => {
    controller.abort(new Error("cancelled warmup"));
    return { ...result, code: 1 };
  });
  await expect(
    runProvisionWarmup({
      binary: "crabbox",
      id: "cbx_0123456789ab",
      provider: "azure-sandbox",
      slug: "test",
      profile: resolveCrabboxProvisionProfile(
        {
          provider: "azure-sandbox",
          target: "linux",
          class: "standard",
          ttl: "60m",
          idleTimeout: "30m",
        },
        undefined,
      ).profile,
      timeoutMs: () => 1000,
      signal: controller.signal,
      timingIdentity: identity,
    }),
  ).rejects.toThrow("cancelled warmup");
  expect(info).toHaveBeenCalledWith(
    "Crabbox provisioning timing",
    expect.objectContaining({ outcome: "failed" }),
  );
});

it.each([0, 1])("reports correlated bootstrap timing through setup exit %s", async (code) => {
  vi.spyOn(processRunner, "runCrabboxProcess").mockResolvedValue({ ...result, code });
  const stopLease = vi.fn(async () => {});
  const setup = runProvisionSetup({
    binary: "crabbox",
    provider: "azure-sandbox",
    deadline: performance.now() + 60_000,
    inspect: { id: "cbx_0123456789ab", state: "running", ready: true, tailscaleEnabled: false },
    profile: parseCrabboxProfile({
      provider: "azure-sandbox",
      target: "linux",
      class: "standard",
      ttl: "60m",
      idleTimeout: "30m",
    }),
    phase: "node runtime preparation",
    setup: "synthetic setup",
    stopLease,
    timingIdentity: identity,
  });
  if (code === 0) {
    await setup;
    expect(stopLease).not.toHaveBeenCalled();
  } else {
    await expect(setup).rejects.toThrow("failed with exit code 1");
    expect(stopLease).toHaveBeenCalledOnce();
  }
  expect(info).toHaveBeenCalledWith(
    "Crabbox provisioning timing",
    expect.objectContaining({
      ...identity,
      outcome: code === 0 ? "success" : "failed",
      runnerPhases: expect.arrayContaining([
        { phase: "bootstrap.runtime.transfer", durationMs: 120, overlapping: true },
      ]),
    }),
  );
});
