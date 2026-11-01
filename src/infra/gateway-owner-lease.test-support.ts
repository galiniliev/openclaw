import path from "node:path";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import { acquireGatewayOwnerLease, type GatewayOwnerLease } from "./gateway-owner-lease.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";

export function createGatewayOwnerLeaseFixture(stateDir: string) {
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const coordinator = acquireGatewayStateOwner({
    databasePath,
    payload: {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      configPath: path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
      role: "gateway",
      processNamespace: readGatewayLockProcessNamespace(),
    },
  });
  let lease: GatewayOwnerLease | undefined;
  return {
    env,
    acquire(params: Partial<Omit<Parameters<typeof acquireGatewayOwnerLease>[0], "env">> = {}) {
      lease = acquireGatewayOwnerLease({
        env,
        port: 19483,
        mode: "foreground",
        supervisor: null,
        ...params,
      });
      return lease;
    },
    async [Symbol.asyncDispose]() {
      try {
        await lease?.ready;
      } finally {
        await lease?.release();
        coordinator.release();
      }
    },
  };
}
