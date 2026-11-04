import { afterEach, expect, it, vi } from "vitest";
import type {
  GatewayRollingContract,
  GatewayRollingControlRequest,
} from "../../gateway/rolling-release-contract.js";
import type { GatewayServerOptions } from "../../gateway/server-public.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { GatewayRollingCandidate } from "./rolling-candidate.js";

afterEach(() => resetGatewayWorkAdmission());

const contract: GatewayRollingContract = {
  version: 1,
  releaseId: "release-one",
  predecessorBootId: "old-boot",
  candidateBootId: "next-boot",
  predecessorOwner: "old-owner",
  compatibilityDigest: "a".repeat(64),
  expiresAtMs: 20_000,
};
const command = (
  action: GatewayRollingControlRequest["action"],
  extra: Partial<GatewayRollingControlRequest> = {},
): GatewayRollingControlRequest => ({
  version: 1,
  id: action,
  releaseId: contract.releaseId,
  action,
  ...extra,
});

function fixture() {
  let now = 1_000;
  let writerAvailable = true;
  const mutations: string[] = [];
  const phases: string[] = [];
  const reset = vi.fn(async () => {
    phases.push("reset");
  });
  const start = vi.fn(
    (
      options: GatewayServerOptions,
      publishServer: (server: import("../../gateway/server-public.js").GatewayServer) => void,
    ) => {
      expect(options.bootId).toBe(contract.candidateBootId);
      const writer = options.rollingWriterPreparation !== undefined;
      phases.push(writer ? "future-writer-handles" : "readonly-handles");
      const gate = options.rollingStartup!;
      gate.defer(async () => {
        mutations.push("mutable-startup");
      });
      gate.publishReadReady();
      const server = {
        getTailscaleIngressEndpoint: () => undefined,
        isRollingReadReady: () => true,
        isRollingWriterReady: () => writerAvailable && mutations.length > 0,
        close: vi.fn(async () => {
          phases.push("closed");
        }),
        startupSettled: gate.waitForMutableStartup().catch(() => undefined),
        readRollingFacts: async () => ({
          compatibilityDigest: contract.compatibilityDigest,
          storeIdentity: "logical-store",
          executionOwner: writer ? "next-owner" : contract.predecessorOwner,
        }),
        ...(writer
          ? {
              activateRollingWriter: async (assertRetired: () => void) => {
                assertRetired();
                await gate.activate(assertRetired);
              },
            }
          : {}),
      };
      publishServer(server);
      return {
        server: Promise.resolve(server),
        stop: async () => {
          gate.beginClose();
          await server.close();
          await gate.close();
        },
      };
    },
  );
  const prewarm = vi.fn(async () => {
    phases.push("immutable-imports");
  });
  const candidate = new GatewayRollingCandidate(contract, {
    prewarm,
    start,
    reset,
    now: () => now,
  });
  return {
    candidate,
    start,
    prewarm,
    mutations,
    phases,
    reset,
    expire: () => {
      now = contract.expiresAtMs;
    },
    invalidateWriter: () => {
      writerAvailable = false;
    },
  };
}

it("keeps prewarm immutable and defers mutable startup until exact predecessor retirement", async () => {
  const f = fixture();
  await f.candidate.prewarm();
  expect(f.start).not.toHaveBeenCalled();
  expect(f.candidate.status()).toMatchObject({
    immutableReady: true,
    readReady: false,
    writerReady: false,
  });
  expect(f.candidate.status().observed).toBeUndefined();
  await f.candidate.dispatch(
    command("bind-read-only", {
      companion: { generation: "final-archive", restoreReceiptId: "restore-one" },
    }),
  );
  expect(f.candidate.status()).toMatchObject({
    phase: "read-only",
    readReady: true,
    writerReady: false,
  });
  await f.candidate.dispatch(command("prepare-writer"));
  expect(f.mutations).toEqual([]);
  expect(f.candidate.status()).toMatchObject({
    phase: "writer-prepared",
    readReady: true,
    writerReady: false,
    observed: { executionOwner: "next-owner" },
  });
  await f.candidate.dispatch(
    command("activate", {
      predecessorRetirement: {
        bootId: "old-boot",
        releaseId: "release-one",
        childIdentity: "owned-child",
        exited: true,
      },
    }),
  );
  expect(f.mutations).toEqual(["mutable-startup"]);
  expect(f.candidate.status()).toMatchObject({ writerReady: true, readReady: true });
  expect(f.start).toHaveBeenCalledTimes(2);
  f.expire();
  expect(await f.candidate.dispatch(command("status"))).toMatchObject({
    phase: "writer-ready",
    writerReady: true,
  });
  f.invalidateWriter();
  expect(f.candidate.status()).toMatchObject({
    phase: "writer-ready",
    writerReady: false,
    readReady: true,
  });
});

it("refuses activation without positive exact predecessor retirement", async () => {
  const f = fixture();
  await f.candidate.prewarm();
  await f.candidate.dispatch(
    command("bind-read-only", {
      companion: { generation: "final", restoreReceiptId: "restore-one" },
    }),
  );
  await f.candidate.dispatch(command("prepare-writer"));
  await expect(f.candidate.dispatch(command("activate"))).rejects.toThrow(/retirement/);
  expect(f.mutations).toEqual([]);
  await f.candidate.close();
});

it("never renews the caller's original release expiry or replaces a bound generation", async () => {
  const f = fixture();
  await f.candidate.prewarm();
  await f.candidate.dispatch(
    command("bind-read-only", {
      companion: { generation: "final", restoreReceiptId: "restore-one" },
    }),
  );
  await expect(
    f.candidate.dispatch(
      command("bind-read-only", {
        companion: { generation: "different", restoreReceiptId: "restore-two" },
      }),
    ),
  ).rejects.toThrow(/exactly once/);
  f.expire();
  await expect(f.candidate.dispatch(command("prepare-writer"))).rejects.toThrow(/expired/);
  expect(f.start).toHaveBeenCalledTimes(1);
  await f.candidate.close();
});
