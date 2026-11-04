import path from "node:path";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEngineStoreAdmission } from "./database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "./database-engine/mixed-agent.conformance.test-support.js";
import { getPostgresPhysicalFacts } from "./database-engine/physical-facts.js";
import {
  acquireGatewayOwnerLease,
  readGatewayOwnerLease,
  type GatewayOwnerLease,
} from "./gateway-owner-lease.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL rolling execution-owner abort", () => {
  useMixedAgentPair("postgres", "postgres");
  const leases: GatewayOwnerLease[] = [];
  let physical: ReturnType<typeof acquireGatewayStateOwner> | undefined;
  const acquirePhysical = () =>
    acquireGatewayStateOwner({
      databasePath: resolveOpenClawStateSqlitePath(),
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: path.join(process.env.OPENCLAW_STATE_DIR!, "openclaw.json"),
        role: "gateway",
      },
    });
  afterEach(async () => {
    for (const lease of leases.splice(0).toReversed()) {
      await lease.release();
    }
    physical?.release();
    physical = undefined;
  });

  it("restores only the exact returned predecessor grant, without a second lock or deleting a successor", async () => {
    physical = acquirePhysical();
    const predecessor = acquireGatewayOwnerLease({
      port: 19381,
      mode: "foreground",
      supervisor: null,
    });
    leases.push(predecessor);
    await predecessor.ready;
    const contract = {
      version: 1 as const,
      releaseId: "same-pg-release",
      predecessorBootId: "old-boot",
      candidateBootId: "candidate-boot",
      predecessorOwner: predecessor.owner,
      compatibilityDigest: "b".repeat(64),
      companionGeneration: "synthetic-contract-generation",
      expiresAtMs: Date.now() + 60_000,
    };
    await predecessor.yieldTo(contract);
    const candidate = acquireGatewayOwnerLease({
      port: 19382,
      mode: "foreground",
      supervisor: null,
      rollingHandoff: contract,
    });
    leases.push(candidate);
    await candidate.ready;
    await expect(predecessor.restoreYield()).rejects.toThrow(/transferred/);
    expect(withEngineStoreAdmission(() => readGatewayOwnerLease({ current: true }))?.owner).toBe(
      candidate.owner,
    );
    await candidate.returnToPredecessor();
    await candidate.release();
    expect(withEngineStoreAdmission(() => readGatewayOwnerLease({ current: true }))).toMatchObject({
      owner: candidate.owner,
      rollingReturnToOwner: predecessor.owner,
      rollingHandoff: contract,
    });
    await predecessor.restoreYield();
    predecessor.assertCurrent();
    physical.assertCurrent();
    expect(withEngineStoreAdmission(() => readGatewayOwnerLease({ current: true }))).toMatchObject({
      owner: predecessor.owner,
    });
    expect(
      withEngineStoreAdmission(() => readGatewayOwnerLease({ current: true }))?.rollingHandoff,
    ).toBeUndefined();
  });

  it("consumes the initial preparation and can become the predecessor of the next release", async () => {
    physical = acquirePhysical();
    const predecessor = acquireGatewayOwnerLease({
      port: 19381,
      mode: "foreground",
      supervisor: null,
    });
    leases.push(predecessor);
    await predecessor.ready;
    const first = {
      version: 1 as const,
      releaseId: "first-release",
      predecessorBootId: "old-boot",
      candidateBootId: "middle-boot",
      predecessorOwner: predecessor.owner,
      compatibilityDigest: "c".repeat(64),
      companionGeneration: "synthetic-first",
      expiresAtMs: Date.now() + 60_000,
    };
    await predecessor.yieldTo(first);
    const middle = acquireGatewayOwnerLease({
      port: 19382,
      mode: "foreground",
      supervisor: null,
      rollingHandoff: first,
    });
    leases.push(middle);
    await middle.ready;
    middle.commitPreparation(first.releaseId);
    await expect(middle.returnToPredecessor()).rejects.toThrow(/no bound/);
    const next = {
      ...first,
      releaseId: "next-release",
      predecessorBootId: "middle-boot",
      candidateBootId: "last-boot",
      predecessorOwner: middle.owner,
      companionGeneration: "synthetic-next",
    };
    await middle.yieldTo(next);
    const successor = acquireGatewayOwnerLease({
      port: 19383,
      mode: "foreground",
      supervisor: null,
      rollingHandoff: next,
    });
    leases.push(successor);
    await successor.ready;
    successor.commitPreparation(next.releaseId);
    await expect(middle.restoreYield()).rejects.toThrow(/transferred/);
    expect(withEngineStoreAdmission(() => readGatewayOwnerLease({ current: true }))?.owner).toBe(
      successor.owner,
    );
  });

  it.each([false, true])(
    "rebinds a reserved or returned grant without reviving predecessor writes (%s)",
    async (returned) => {
      physical = acquirePhysical();
      const predecessor = acquireGatewayOwnerLease({
        port: 19381,
        mode: "foreground",
        supervisor: null,
      });
      leases.push(predecessor);
      await predecessor.ready;
      const namespace = withEngineStoreAdmission(
        () => getPostgresPhysicalFacts(openOpenClawStateDatabase().db)?.namespace,
      );
      expect(namespace).toBeDefined();
      const client = new Client({ connectionString: mixedAgentConnection });
      await client.connect();
      try {
        const contract = {
          version: 1 as const,
          releaseId: "postgres-rebind",
          predecessorBootId: "old-boot",
          candidateBootId: "failed-boot",
          predecessorOwner: predecessor.owner,
          compatibilityDigest: "a".repeat(64),
          companionGeneration: "frozen-companion",
          expiresAtMs: Date.now() + 60_000,
        };
        await predecessor.yieldTo(contract);
        let expectedOwner = predecessor.owner;
        if (returned) {
          const candidate = acquireGatewayOwnerLease({
            port: 19382,
            mode: "foreground",
            supervisor: null,
            owner: "failed-candidate",
            rollingHandoff: contract,
          });
          leases.push(candidate);
          await candidate.ready;
          await expect(
            predecessor.rebindYield(contract, "fresh-boot", candidate.owner),
          ).rejects.toThrow();
          await candidate.returnToPredecessor();
          await candidate.release();
          expectedOwner = candidate.owner;
        }
        const quoted = `"${namespace!.replaceAll('"', '""')}"`;
        const before = await client.query(
          `SELECT expires_at FROM ${quoted}.state_leases WHERE owner = $1`,
          [expectedOwner],
        );
        expect(before.rows).toHaveLength(1);
        await expect(
          predecessor.rebindYield(contract, "fresh-boot", "wrong-owner"),
        ).rejects.toThrow();
        const next = await predecessor.rebindYield(contract, "fresh-boot", expectedOwner);
        expect(next).toEqual({ ...contract, candidateBootId: "fresh-boot" });
        expect(await predecessor.observeYield()).toEqual({
          owner: predecessor.owner,
          contract: next,
        });
        expect(() => predecessor.assertCurrent()).toThrow();
        const after = await client.query(
          `SELECT expires_at FROM ${quoted}.state_leases WHERE owner = $1`,
          [predecessor.owner],
        );
        expect(after.rows).toEqual(before.rows);
        const replacement = acquireGatewayOwnerLease({
          port: 19383,
          mode: "foreground",
          supervisor: null,
          owner: "fresh-candidate",
          rollingHandoff: next,
        });
        leases.push(replacement);
        await replacement.ready;
        expect(() => replacement.assertCurrent()).not.toThrow();
        expect(() => predecessor.assertCurrent()).toThrow();
        await replacement.returnToPredecessor();
        await replacement.release();
        await predecessor.restoreYield();
      } finally {
        await client.end();
      }
    },
  );
});
