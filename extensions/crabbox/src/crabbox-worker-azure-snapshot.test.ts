import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, expect, it, vi } from "vitest";
import * as processRunner from "./crabbox-process.js";
import {
  prepareCrabboxAzureSnapshotContext,
  runCrabboxAzureSnapshotEffect,
  type AzureSandboxSnapshotContext,
} from "./crabbox-worker-azure-snapshot.js";
import { parseCrabboxProfile } from "./crabbox-worker-profile.js";

const context: AzureSandboxSnapshotContext = {
  scope: {
    region: "eastus",
    subscriptionId: "subscription",
    resourceGroup: "group",
    group: "sandboxes",
  },
  providerScope: "azure-sandbox:eastus:subscription:group:sandboxes",
  sdkPython: "/qualified/bin/python",
  helperPath: "/qualified/plugin/assets/azure-sandbox-checkpoint.py",
  providerEnv: { CRABBOX_CONFIG: "/qualified/provider/config" },
};
const snapshot = {
  snapshotId: "snapshot-one",
  sourceSandboxId: "sandbox-original",
  operationId: "11111111-1111-4111-8111-111111111111",
  capturedAt: "2026-10-21T00:00:00Z",
};
const request = {
  action: "inspect" as const,
  operationId: snapshot.operationId,
  sourceSandboxId: snapshot.sourceSandboxId,
  snapshotId: snapshot.snapshotId,
  timeoutMs: 1_000,
  timingIdentity: { operationId: "native-operation" },
  assertCurrent: () => {},
};
const success = { schema: "openclaw.azure-sandbox-checkpoint.v1", state: "available", snapshot };
function result(receipt: unknown, overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: JSON.stringify(receipt),
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("observes the exact saved snapshot through the selected isolated SDK route", async () => {
  const run = vi.spyOn(processRunner, "runCrabboxProcess").mockResolvedValue(result(success));
  await expect(runCrabboxAzureSnapshotEffect(context, request)).resolves.toEqual({
    state: "available",
    snapshot,
  });
  const [argv, options] = run.mock.calls[0]!;
  expect(argv).toEqual([
    "/qualified/bin/python",
    "-I",
    "-B",
    "/qualified/plugin/assets/azure-sandbox-checkpoint.py",
  ]);
  expect(JSON.parse(String(options.input))).toEqual({
    schema: "openclaw.azure-sandbox-checkpoint.v1",
    action: "inspect",
    scope: context.scope,
    sourceSandboxId: "sandbox-original",
    snapshotId: "snapshot-one",
    operationId: "11111111-1111-4111-8111-111111111111",
  });
  expect(options.env).toMatchObject({ CRABBOX_CONFIG: "/qualified/provider/config" });
});

it.each([
  {
    name: "another source",
    receipt: { ...success, snapshot: { ...snapshot, sourceSandboxId: "sandbox-other" } },
  },
  {
    name: "another operation",
    receipt: {
      ...success,
      snapshot: { ...snapshot, operationId: "22222222-2222-4222-8222-222222222222" },
    },
  },
  {
    name: "another snapshot",
    receipt: { ...success, snapshot: { ...snapshot, snapshotId: "snapshot-other" } },
  },
  { name: "truncated output", receipt: success, overrides: { stdoutTruncatedBytes: 1 } },
  {
    name: "timeout after output",
    receipt: success,
    overrides: { termination: "timeout" as const, code: null },
  },
])("does not publish $name as an available image", async ({ receipt, overrides }) => {
  const run = vi
    .spyOn(processRunner, "runCrabboxProcess")
    .mockResolvedValue(result(receipt, overrides));
  await expect(runCrabboxAzureSnapshotEffect(context, request)).rejects.toThrow();
  expect(run).toHaveBeenCalledOnce();
});

it.each(["missing", "unknown"] as const)(
  "preserves the distinct %s observation without retrying effects",
  async (state) => {
    const run = vi
      .spyOn(processRunner, "runCrabboxProcess")
      .mockResolvedValue(result({ schema: success.schema, state }));
    await expect(runCrabboxAzureSnapshotEffect(context, request)).resolves.toEqual({ state });
    expect(run).toHaveBeenCalledOnce();
  },
);

it("rejects an otherwise valid observation after its caller authority closes", async () => {
  let current = true;
  vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(async () => {
    current = false;
    return result(success);
  });
  await expect(
    runCrabboxAzureSnapshotEffect(context, {
      ...request,
      assertCurrent: () => {
        if (!current) {
          throw new Error("owner closed");
        }
      },
    }),
  ).rejects.toThrow("owner closed");
});

const scopeEnv = {
  CRABBOX_AZURE_SANDBOX_REGION: "eastus",
  CRABBOX_AZURE_SANDBOX_SUBSCRIPTION_ID: "subscription",
  CRABBOX_AZURE_SANDBOX_RESOURCE_GROUP: "group",
  CRABBOX_AZURE_SANDBOX_GROUP: "sandboxes",
};
const preparation = {
  binary: "/qualified/crabbox",
  helperPath: context.helperPath,
  profile: parseCrabboxProfile({
    provider: "azure-sandbox",
    ttl: "4h",
    idleTimeout: "15m",
    sdkPython: context.sdkPython,
    configFile: "/qualified/provider/config",
    sdkIdentity: { kind: "azure-cli" },
  }),
  assertCurrent: () => {},
};
const ce7Config = { provider: "azure-sandbox", providerScope: "", idempotentLeaseId: false };
const sdkQualification = { schema: success.schema, state: "available", versions: {} };

it("prepares the ce7 snapshot route from explicit effective provider environment", async () => {
  for (const [key, value] of Object.entries(scopeEnv)) {
    vi.stubEnv(key, value);
  }
  const run = vi
    .spyOn(processRunner, "runCrabboxProcess")
    .mockResolvedValueOnce(result(ce7Config))
    .mockResolvedValueOnce(result(sdkQualification));
  await expect(prepareCrabboxAzureSnapshotContext(preparation)).resolves.toEqual({
    ...context,
    providerEnv: { ...context.providerEnv, ...scopeEnv, CRABBOX_AZURE_SANDBOX_CLIENT_ID: "" },
  });
  expect(run.mock.calls[0]![0]).toEqual([
    preparation.binary,
    "config",
    "show",
    "--provider",
    "azure-sandbox",
    "--json",
  ]);
  expect(run.mock.calls[1]![0]).toEqual([
    context.sdkPython,
    "-I",
    "-B",
    context.helperPath,
    "--check-runtime",
  ]);
  for (const [, options] of run.mock.calls) {
    expect(options.env).toMatchObject(scopeEnv);
  }
});

it.each(Object.keys(scopeEnv))("refuses incomplete explicit scope: %s", async (missing) => {
  for (const [key, value] of Object.entries(scopeEnv)) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv(missing, undefined);
  const run = vi.spyOn(processRunner, "runCrabboxProcess").mockResolvedValue(result(ce7Config));
  await expect(prepareCrabboxAzureSnapshotContext(preparation)).rejects.toThrow(
    "Snapshot preparation requires explicit Azure Sandbox scope environment",
  );
  expect(run).not.toHaveBeenCalled();
});

it.each([
  ["CRABBOX_AZURE_SANDBOX_REGION", "east us"],
  ["CRABBOX_AZURE_SANDBOX_GROUP", "../other"],
  ["CRABBOX_AZURE_SANDBOX_SUBSCRIPTION_ID", "subscription:other"],
])("refuses malformed snapshot routing input %s", async (key, value) => {
  for (const [name, expected] of Object.entries(scopeEnv)) {
    vi.stubEnv(name, expected);
  }
  vi.stubEnv(key, value);
  const run = vi.spyOn(processRunner, "runCrabboxProcess").mockResolvedValue(result(ce7Config));
  await expect(prepareCrabboxAzureSnapshotContext(preparation)).rejects.toThrow(
    "Snapshot provider scope is invalid",
  );
  expect(run).not.toHaveBeenCalled();
});

it("refuses wrong provider configuration before SDK qualification", async () => {
  for (const [key, value] of Object.entries(scopeEnv)) {
    vi.stubEnv(key, value);
  }
  const run = vi
    .spyOn(processRunner, "runCrabboxProcess")
    .mockResolvedValue(result({ provider: "other" }));
  await expect(prepareCrabboxAzureSnapshotContext(preparation)).rejects.toThrow(
    "Snapshot provider identity does not match Azure Sandbox",
  );
  expect(run).toHaveBeenCalledOnce();
});

it("retains SDK qualification after the scope projection", async () => {
  for (const [key, value] of Object.entries(scopeEnv)) {
    vi.stubEnv(key, value);
  }
  const run = vi
    .spyOn(processRunner, "runCrabboxProcess")
    .mockResolvedValueOnce(result(ce7Config))
    .mockResolvedValueOnce(result({}, { code: 1 }));
  await expect(prepareCrabboxAzureSnapshotContext(preparation)).rejects.toThrow(
    "Snapshot SDK is unavailable or unqualified",
  );
  expect(run).toHaveBeenCalledTimes(2);
});

it("stops preparation when caller authority closes after configuration validation", async () => {
  for (const [key, value] of Object.entries(scopeEnv)) {
    vi.stubEnv(key, value);
  }
  let current = true;
  const run = vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(async () => {
    current = false;
    return result(ce7Config);
  });
  await expect(
    prepareCrabboxAzureSnapshotContext({
      ...preparation,
      assertCurrent: () => {
        if (!current) {
          throw new Error("owner closed");
        }
      },
    }),
  ).rejects.toThrow("owner closed");
  expect(run).toHaveBeenCalledOnce();
});
