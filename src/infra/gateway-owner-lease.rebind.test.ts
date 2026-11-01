import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import * as leaseHeartbeat from "../state/openclaw-state-lease-heartbeat.js";
import { acquireGatewayOwnerLease, readGatewayOwnerLease } from "./gateway-owner-lease.js";
import { createGatewayOwnerLeaseFixture } from "./gateway-owner-lease.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

const fixture = () => createGatewayOwnerLeaseFixture(tempDirs.make("gateway-owner-rebind-"));

describe("Gateway owner rolling reservation recovery", () => {
  it.each([false, true])(
    "rebinds only an exact reserved or returned grant (returned: %s)",
    async (returned) => {
      await using owner = fixture();
      const heartbeat = vi.spyOn(leaseHeartbeat, "startOpenClawStateLeaseHeartbeat");
      const predecessor = owner.acquire();
      await predecessor.ready;
      const contract = {
        version: 1 as const,
        releaseId: "rebind-release",
        predecessorBootId: "old-boot",
        candidateBootId: "first-boot",
        predecessorOwner: predecessor.owner,
        compatibilityDigest: "a".repeat(64),
        companionGeneration: "frozen-companion",
        expiresAtMs: Date.now() + 60_000,
      };
      await predecessor.yieldTo(contract);
      expect(await predecessor.observeYield()).toEqual({ owner: predecessor.owner, contract });
      let expectedOwner = predecessor.owner;
      if (returned) {
        const candidate = acquireGatewayOwnerLease({
          env: owner.env,
          port: 19484,
          mode: "foreground",
          supervisor: null,
          owner: "failed-candidate",
          rollingHandoff: contract,
        });
        await candidate.ready;
        await expect(predecessor.observeYield()).rejects.toThrow(/unavailable/);
        await expect(
          predecessor.rebindYield(contract, "replacement-boot", candidate.owner),
        ).rejects.toThrow(/not returned/);
        await candidate.returnToPredecessor();
        await candidate.release();
        expectedOwner = candidate.owner;
        expect(await predecessor.observeYield()).toEqual({
          owner: candidate.owner,
          contract,
          returnedToOwner: predecessor.owner,
        });
      }
      await expect(
        predecessor.rebindYield(contract, "replacement-boot", "unrelated-owner"),
      ).rejects.toThrow();
      await expect(
        predecessor.rebindYield(
          { ...contract, expiresAtMs: contract.expiresAtMs + 1 },
          "replacement-boot",
          expectedOwner,
        ),
      ).rejects.toThrow();
      const heartbeatCount = heartbeat.mock.calls.length;
      const next = await predecessor.rebindYield(contract, "replacement-boot", expectedOwner);
      expect(next).toEqual({ ...contract, candidateBootId: "replacement-boot" });
      expect(await predecessor.observeYield()).toEqual({
        owner: predecessor.owner,
        contract: next,
      });
      expect(heartbeat).toHaveBeenCalledTimes(heartbeatCount);
      expect(() => predecessor.assertCurrent()).toThrow(/not current/);
      expect(readGatewayOwnerLease({ env: owner.env })).toMatchObject({
        owner: predecessor.owner,
        rollingHandoff: next,
      });
      expect(readGatewayOwnerLease({ env: owner.env })?.rollingReturnToOwner).toBeUndefined();
      await expect(
        predecessor.rebindYield(contract, "another-boot", expectedOwner),
      ).rejects.toThrow();
      const replacement = acquireGatewayOwnerLease({
        env: owner.env,
        port: 19485,
        mode: "foreground",
        supervisor: null,
        owner: "replacement-owner",
        rollingHandoff: next,
      });
      await replacement.ready;
      await replacement.returnToPredecessor();
      await replacement.release();
      await predecessor.restoreYield();
    },
  );
});
