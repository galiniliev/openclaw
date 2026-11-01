import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseGatewayRollingContract,
  type GatewayRollingContract,
  type GatewayRollingLeaseObservation,
} from "../gateway/rolling-release-contract.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { readAgentDatabaseLeaseProvenance } from "../state/openclaw-agent-db-lease-provenance.js";
import type { OpenClawStateSchemaReadAdmission } from "../state/openclaw-state-db-contract.js";
import { isStatePostgres } from "../state/openclaw-state-db-engine.js";
import {
  withExistingOpenClawStateDatabaseCurrentReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { withOpenClawStateStartupMigrationCheckpointDatabase } from "../state/openclaw-state-db.js";
import {
  existingPathOrUndefined,
  resolveOpenClawStateSqlitePath,
} from "../state/openclaw-state-db.paths.js";
import { startOpenClawStateLeaseHeartbeat } from "../state/openclaw-state-lease-heartbeat.js";
import {
  releaseOpenClawStateLeaseInTransaction,
  updateOpenClawStateLeasePayloadInTransaction,
  renewOpenClawStateLeaseUnderWriteFence,
} from "../state/openclaw-state-lease-store.js";
import { captureOpenClawStateReadSource } from "../state/openclaw-state-read-worker.js";
import type { OpenClawStateReadOutcome } from "../state/openclaw-state-read.types.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { readProcessMachineIdentity } from "./current-machine-identity.js";
import {
  getDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "./database-engine/context.js";
import {
  classifyGatewayOwnerProcessNamespace,
  describeGatewayLockHolder,
  GATEWAY_OWNER_HEARTBEAT_STALE_MS,
  GatewayLockNamespaceError,
  readGatewayLockProcessNamespace,
} from "./gateway-lock-payload.js";
import { gatewayOwnerKey, readGatewayOwnerLeaseFromDatabase } from "./gateway-owner-lease.read.js";
import type {
  GatewayOwnerLeaseIdentity,
  GatewayOwnerSupervisor,
} from "./gateway-owner-lease.types.js";
import { captureGatewayStateOwner, type StateDatabaseSchemaLease } from "./gateway-state-owner.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";
import type { EngineConnection } from "./sql-connection.js";
import { throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import { retainSnapshotTempDirectory } from "./sqlite-readonly-location-cleanup.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import { prepareSqliteReadOnlyLocationSync } from "./sqlite-snapshot-source.js";
import {
  runSqliteImmediateTransactionSync,
  runSqliteSingleStatementSync,
} from "./sqlite-transaction.js";
import { STARTUP_MIGRATION_LEASE_TTL_MS } from "./startup-migration-checkpoint.js";
import { readStateLeaseProcessOwnerStatus } from "./state-lease-process-owner.js";

const log = createSubsystemLogger("gateway");

export type GatewayOwnerLease = {
  owner: string;
  assertCurrent: () => void;
  ready: Promise<void>;
  markListening: () => void;
  release: () => Promise<void>;
  /** Domain mutators are fenced/settled; the private old read transport may remain alive. */
  yieldTo: (contract: GatewayRollingContract) => Promise<void>;
  restoreYield: () => Promise<void>;
  observeYield: () => Promise<GatewayRollingLeaseObservation>;
  /** Rebind an exact reserved grant; does not reopen predecessor execution. */
  rebindYield: (
    previous: GatewayRollingContract,
    candidateBootId: string,
    expectedOwner: string,
  ) => Promise<GatewayRollingContract>;
  returnToPredecessor: () => Promise<void>;
  commitPreparation: (releaseId: string) => void;
};

function resolveStoppedGatewayOwnerLease(previous: GatewayOwnerLeaseIdentity | undefined) {
  if (!previous) {
    return undefined;
  }
  // A failed handoff cannot strand a dead owner forever; time alone never retires a live reader.
  if (
    previous.rollingHandoff &&
    !(previous.state === "dead" && previous.rollingHandoff.expiresAtMs <= Date.now())
  ) {
    throw new Error("Gateway ownership is reserved for its exact rolling successor");
  }
  if (previous.state === "dead") {
    return previous;
  }
  const namespace = classifyGatewayOwnerProcessNamespace(previous.processNamespace, {
    ownerHost: previous.host,
    machineIdentity: previous.machineIdentity,
  });
  if (namespace === "dead") {
    return previous;
  }
  if (namespace === "unknown") {
    throw new GatewayLockNamespaceError(previous);
  }
  throw new Error(
    `Another Gateway owner lease is still active for this state directory: ${describeGatewayLockHolder(previous, undefined, previous.state === "live" ? "live" : "unknown")}`,
  );
}

/** Physical custody alone must not bypass a fresh, unverifiable lease. */
export async function assertGatewayOwnerLeaseStopped(
  env: NodeJS.ProcessEnv,
  owner: StateDatabaseSchemaLease,
  schemaMaintenance = false,
  rollingHandoff?: GatewayRollingContract,
): Promise<void> {
  const pathname = resolveOpenClawStateSqlitePath(env);
  owner.assertDatabaseAccess(pathname);
  if (existingPathOrUndefined(pathname) === undefined) {
    return;
  }
  const context = captureOpenClawStateReadWorkerContext({ env, path: pathname });
  const source = captureOpenClawStateReadSource();
  const transport = source.createTransport({ type: "gatewayOwnerLease.read", schemaMaintenance });
  const controller = new AbortController();
  const callerSignal = getAsyncWorkSignal();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  const authority = {
    signal,
    assertCurrent() {
      signal.throwIfAborted();
      context.maintenanceScope?.assertReadAdmission();
      context.admission.assertCurrent();
      owner.assertDatabaseAccess(pathname);
    },
  };
  let prepared: PreparedSqliteReadOnlyLocation | undefined;
  let releaseSnapshot: (() => void) | undefined;
  let read: Promise<OpenClawStateReadOutcome> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      // Read failure belongs to the caller; cleanup must still retire its native task.
      await read?.catch(() => undefined);
      await transport.startClose();
      releaseSnapshot?.();
      releaseSnapshot = undefined;
      if (prepared) {
        // Disposable cleanup warnings and retries belong to the snapshot owner.
        await prepared.cleanupAsync();
        prepared = undefined;
      }
      releaseSource();
    })().finally(() => {
      closing = undefined;
    }));
  const releaseSource = source.own(() => {
    controller.abort();
    return close();
  });
  const errors: unknown[] = [];
  let outcome: OpenClawStateReadOutcome | undefined;
  try {
    authority.assertCurrent();
    if (schemaMaintenance && !isStatePostgres()) {
      prepared = prepareSqliteReadOnlyLocationSync(pathname);
      releaseSnapshot = retainSnapshotTempDirectory(
        prepared.cleanupRoot ?? path.dirname(prepared.location),
      );
    }
    read = transport.startRead(
      {
        context,
        // Offline custody permits a direct worker read; only repair needs a private snapshot.
        location: prepared?.location ?? pathname,
        snapshotRoot: prepared?.cleanupRoot,
        checkFreshAdmission: false,
      },
      authority,
    );
    outcome = await read;
    if ("error" in outcome) {
      errors.push(outcome.error);
    }
    authority.assertCurrent();
  } catch (error) {
    errors.push(error);
  }
  const cleanupErrors: unknown[] = [];
  try {
    await close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    authority.assertCurrent();
    if (outcome && "value" in outcome) {
      const reply = outcome.value;
      if (reply.type !== "gatewayOwnerLease.read") {
        throw new Error("Unexpected Gateway owner lease inspection result");
      }
      const observed = reply.lease
        ? {
            ...reply.lease,
            state: readStateLeaseProcessOwnerStatus(reply.lease, reply.lease.heartbeatAt),
          }
        : undefined;
      if (rollingHandoff) {
        admitGatewayRollingSuccessor(observed, rollingHandoff);
      } else {
        resolveStoppedGatewayOwnerLease(observed);
      }
    }
  } catch (error) {
    errors.push(error);
  }
  throwSqliteLifecycleErrors(
    [...errors, ...cleanupErrors],
    "Gateway owner lease inspection and cleanup failed",
  );
}

export function readGatewayOwnerLease(
  params: {
    env?: NodeJS.ProcessEnv;
    port?: number;
    /** Mutation admission must not inherit a discovery snapshot. */
    current?: boolean;
    openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission;
  } = {},
): GatewayOwnerLeaseIdentity | undefined {
  const operation = ({ db }: { db: EngineConnection }) =>
    readGatewayOwnerLeaseFromDatabase(db, params.port);
  return params.current || params.openStateSchemaReadAdmission
    ? withExistingOpenClawStateDatabaseCurrentReadOnly(
        operation,
        { env: params.env },
        params.openStateSchemaReadAdmission,
      )
    : withExistingOpenClawStateDatabaseReadOnly(operation, { env: params.env });
}

/** Publish only while the caller holds the Gateway lifecycle coordinator. */
export function acquireGatewayOwnerLease(params: {
  env?: NodeJS.ProcessEnv;
  port: number;
  mode: GatewayOwnerLeaseIdentity["mode"];
  supervisor: GatewayOwnerSupervisor | null;
  owner?: string;
  rollingHandoff?: GatewayRollingContract;
}): GatewayOwnerLease {
  const env = params.env ?? process.env;
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const custody = captureGatewayStateOwner(databasePath);
  const identity = { ...gatewayOwnerKey, owner: params.owner ?? randomUUID() };
  const processOwner = {
    pid: process.pid,
    host: hostname(),
    processNamespace: readGatewayLockProcessNamespace(),
    machineIdentity: process.platform === "darwin" ? readProcessMachineIdentity() : undefined,
    // Retry the native self lookup with its full Windows budget before publication.
    startedAt:
      getFileLockProcessStartTime(process.pid, env) ??
      getFileLockProcessStartTime(process.pid, env),
  };
  const payload = {
    owner: processOwner,
    port: params.port,
    mode: params.mode,
    supervisor: params.supervisor,
  };
  const payloadJson = JSON.stringify(payload);
  const selection = getDatabaseEngineSelection();
  const controlSelection = selection ? { ...selection, access: "read-write" as const } : undefined;
  const runControl = <T>(run: () => T): T =>
    controlSelection ? withDatabaseEngineSelection(controlSelection, run) : run();
  const mutateLease = <T>(
    operation: "acquire" | "release" | "listening" | "handoff" | "observe",
    mutate: (db: EngineConnection) => T,
  ) => {
    const run = () =>
      withOpenClawStateStartupMigrationCheckpointDatabase(
        (db) =>
          // Compound operations join the admitted owner's transaction; native
          // checkpoint bootstrap still needs its own envelope here.
          db.isTransaction
            ? mutate(db)
            : operation === "release"
              ? runSqliteSingleStatementSync(db, () => mutate(db))
              : runSqliteImmediateTransactionSync(db, () => mutate(db), {
                  databaseLabel: databasePath,
                  operationLabel: `gateway.owner-lease.${operation}`,
                }),
        {
          env,
          path: databasePath,
          sealOnClose: operation === "release" || operation === "handoff",
          singleStatement: operation === "release" ? true : undefined,
        },
      );
    // This existing owner is the only control-plane write capability during a
    // domain fence. User work never receives this scoped selection.
    return runControl(run);
  };
  let expiresAt = mutateLease("acquire", (db) => {
    const observed = readGatewayOwnerLeaseFromDatabase(db);
    const previous = params.rollingHandoff
      ? admitGatewayRollingSuccessor(observed, params.rollingHandoff)
      : resolveStoppedGatewayOwnerLease(observed);
    const now = Date.now();
    const leaseExpiresAt = now + STARTUP_MIGRATION_LEASE_TTL_MS;
    const values = {
      scope: identity.scope,
      lease_key: identity.key,
      owner: identity.owner,
      expires_at: leaseExpiresAt,
      heartbeat_at: now,
      payload_json: payloadJson,
      created_at: now,
      updated_at: now,
    };
    const acquired = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
        .insertInto("state_leases")
        .values(values)
        .onConflict((conflict) =>
          conflict
            .columns(["scope", "lease_key"])
            .doUpdateSet(values)
            .where("state_leases.owner", "=", previous?.owner ?? identity.owner),
        )
        .returning("expires_at"),
    );
    if (!acquired) {
      throw new Error("Another Gateway owner lease is still active for this state directory");
    }
    return leaseExpiresAt;
  });
  const acquiredAt = expiresAt - STARTUP_MIGRATION_LEASE_TTL_MS;
  let heartbeat: ReturnType<typeof startOpenClawStateLeaseHeartbeat> | undefined;
  let constructionFailure: { error: unknown } | undefined;
  let warned = false;
  const startHeartbeat = () =>
    runControl(async () => {
      try {
        // Start outside the write transaction so the worker never retains its lifecycle gate.
        heartbeat = startOpenClawStateLeaseHeartbeat({
          path: databasePath,
          identity,
          leaseMs: STARTUP_MIGRATION_LEASE_TTL_MS,
          acquiredAt,
          expiresAt,
          // Keep holder diagnostics fresh even when its process namespace is not visible.
          heartbeatMs: Math.floor(
            Math.min(STARTUP_MIGRATION_LEASE_TTL_MS, GATEWAY_OWNER_HEARTBEAT_STALE_MS) / 3,
          ),
          ...(processOwner.startedAt === null
            ? { processOwner: { identity: processOwner, env: resolveDiagnosticProcessEnv(env) } }
            : {}),
          onLost: (error) => {
            if (!warned) {
              warned = true;
              log.warn("Gateway owner lease heartbeat stopped; process identity remains recorded");
              custody?.invalidate(
                new Error("Gateway execution ownership was lost", { cause: error }),
              );
            }
          },
        });
      } catch (error) {
        constructionFailure = { error };
        throw error;
      }
      await heartbeat.ready;
    });
  const ready = startHeartbeat();
  let released = false;
  let yielded: GatewayRollingContract | undefined;
  let yieldStoppedHeartbeat = false;
  let preparation = params.rollingHandoff;
  const assertCurrent = () => {
    custody?.assertCurrent();
    if (released || warned || constructionFailure) {
      throw new Error("Gateway execution ownership is not current");
    }
  };
  return {
    owner: identity.owner,
    assertCurrent,
    ready,
    markListening() {
      assertCurrent();
      mutateLease("listening", (db) => {
        custody?.assertCurrent();
        // A heartbeat can repair an initially unavailable process start time.
        const startedAt =
          processOwner.startedAt ?? readGatewayOwnerLeaseFromDatabase(db)?.startedAt ?? null;
        const updated = updateOpenClawStateLeasePayloadInTransaction(
          db,
          identity,
          JSON.stringify({
            ...payload,
            owner: { ...processOwner, startedAt },
            listeningAt: Date.now(),
            // Listening follows startup admission. Peers trust this live owner of the exact file.
            stateDatabaseProvenance: readAgentDatabaseLeaseProvenance(databasePath),
          }),
        );
        if (!updated) {
          throw new Error("Gateway owner changed before listening publication");
        }
      });
    },
    async release() {
      if (released) {
        return;
      }
      if (constructionFailure) {
        // Construction did not return cleanup custody; keep the physical owner held.
        throw new Error("Gateway owner heartbeat cleanup could not be confirmed", {
          cause: constructionFailure.error,
        });
      }
      await heartbeat?.stop();
      try {
        // Lost custody may join its worker, but cannot mutate the recorded lease.
        if (!custody?.signal.aborted) {
          mutateLease("release", (db) => {
            releaseOpenClawStateLeaseInTransaction(db, identity);
          });
        }
      } catch (error) {
        if (!custody?.signal.aborted) {
          throw error;
        }
      }
      released = true;
    },
    async yieldTo(contract) {
      assertCurrent();
      if (preparation) {
        throw new Error("Gateway preparation must activate before becoming a predecessor");
      }
      if (
        contract.predecessorOwner !== identity.owner ||
        !contract.companionGeneration ||
        contract.expiresAtMs <= Date.now()
      ) {
        throw new Error("Gateway rolling handoff does not name this current owner");
      }
      await heartbeat?.stop();
      yieldStoppedHeartbeat = true;
      mutateLease("listening", (db) => {
        custody?.assertCurrent();
        const observed = readGatewayOwnerLeaseFromDatabase(db);
        if (
          contract.expiresAtMs <= Date.now() ||
          observed?.owner !== identity.owner ||
          observed.rollingHandoff
        ) {
          throw new Error("Gateway owner changed before rolling handoff publication");
        }
        if (
          !updateOpenClawStateLeasePayloadInTransaction(
            db,
            identity,
            JSON.stringify({ ...payload, rollingHandoff: contract }),
          )
        ) {
          throw new Error("Gateway rolling handoff publication lost ownership");
        }
      });
      // Retain the same row for the successor's exact compare-and-swap. Ordinary
      // close must never delete that grant or a subsequently acquired owner.
      released = true;
      yielded = contract;
    },
    async observeYield() {
      custody?.assertCurrent();
      if (!yielded || !released) {
        throw new Error("Gateway has no held execution handoff");
      }
      const held = yielded;
      return mutateLease("observe", (db) => {
        custody?.assertCurrent();
        const observed = readGatewayOwnerLeaseFromDatabase(db);
        const contract = observed?.rollingHandoff;
        if (
          !observed ||
          !contract?.companionGeneration ||
          !isDeepStrictEqual({ ...contract, candidateBootId: held.candidateBootId }, held) ||
          (observed.owner === identity.owner
            ? observed.rollingReturnToOwner !== undefined
            : observed.rollingReturnToOwner !== identity.owner)
        ) {
          throw new Error("Matching reserved or returned handoff is unavailable");
        }
        return {
          owner: observed.owner,
          contract: { ...contract },
          ...(observed.rollingReturnToOwner
            ? { returnedToOwner: observed.rollingReturnToOwner }
            : {}),
        };
      });
    },
    async rebindYield(previous, candidateBootId, expectedOwner) {
      custody?.assertCurrent();
      const next = parseGatewayRollingContract({ ...previous, candidateBootId });
      if (
        !yielded ||
        !released ||
        preparation ||
        warned ||
        constructionFailure ||
        previous.predecessorOwner !== identity.owner ||
        !previous.companionGeneration ||
        candidateBootId === previous.candidateBootId ||
        previous.expiresAtMs <= Date.now() ||
        !isDeepStrictEqual({ ...yielded, candidateBootId: previous.candidateBootId }, previous)
      ) {
        throw new Error("Gateway has no matching held handoff to rebind");
      }
      mutateLease("handoff", (db) => {
        custody?.assertCurrent();
        const observed = readGatewayOwnerLeaseFromDatabase(db);
        if (
          !observed ||
          observed.owner !== expectedOwner ||
          !isDeepStrictEqual(observed.rollingHandoff, previous) ||
          previous.expiresAtMs <= Date.now() ||
          (observed.owner === identity.owner
            ? observed.rollingReturnToOwner !== undefined
            : observed.rollingReturnToOwner !== identity.owner)
        ) {
          throw new Error("Gateway handoff changed or candidate has not returned its grant");
        }
        const rebound = executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
            .updateTable("state_leases")
            .set({
              owner: identity.owner,
              payload_json: JSON.stringify({ ...payload, rollingHandoff: next }),
              created_at: acquiredAt,
              updated_at: Date.now(),
            })
            .where("scope", "=", identity.scope)
            .where("lease_key", "=", identity.key)
            .where("owner", "=", expectedOwner)
            .returning("owner"),
        );
        if (!rebound) {
          throw new Error("Gateway rebind lost its exact reservation");
        }
      });
      // Keep execution released and its heartbeat stopped. Only the fresh
      // candidate may acquire this reservation through normal admission.
      yielded = next;
      return { ...next };
    },
    async returnToPredecessor() {
      assertCurrent();
      const contract = preparation;
      if (!contract?.companionGeneration) {
        throw new Error("Gateway execution owner has no bound rolling predecessor");
      }
      await heartbeat?.stop();
      mutateLease("handoff", (db) => {
        assertCurrent();
        const observed = readGatewayOwnerLeaseFromDatabase(db);
        if (observed?.owner !== identity.owner || observed.rollingHandoff) {
          throw new Error("Gateway execution owner changed before preparation abort");
        }
        if (
          !updateOpenClawStateLeasePayloadInTransaction(
            db,
            identity,
            JSON.stringify({
              ...payload,
              rollingHandoff: contract,
              rollingReturnToOwner: contract.predecessorOwner,
            }),
          )
        ) {
          throw new Error("Gateway preparation abort could not return execution ownership");
        }
      });
      released = true;
    },
    commitPreparation(releaseId) {
      assertCurrent();
      if (preparation?.releaseId !== releaseId) {
        throw new Error("Gateway preparation grant is absent or already consumed");
      }
      preparation = undefined;
    },
    async restoreYield() {
      custody?.assertCurrent();
      if (!yielded && !yieldStoppedHeartbeat) {
        if (released) {
          throw new Error("Gateway execution owner has already retired");
        }
        return;
      }
      mutateLease("acquire", (db) => {
        const observed = readGatewayOwnerLeaseFromDatabase(db);
        const returned = observed?.rollingReturnToOwner === identity.owner;
        if (
          !observed ||
          (!returned && observed.owner !== identity.owner) ||
          (yielded
            ? !observed.rollingHandoff ||
              Object.entries(yielded).some(
                ([key, value]) =>
                  observed.rollingHandoff?.[key as keyof GatewayRollingContract] !== value,
              )
            : observed.rollingHandoff !== undefined)
        ) {
          throw new Error("Gateway execution ownership has transferred; predecessor cannot resume");
        }
        if (returned) {
          const now = Date.now();
          const restored = executeSqliteQueryTakeFirstSync(
            db,
            getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
              .updateTable("state_leases")
              .set({
                owner: identity.owner,
                expires_at: now + STARTUP_MIGRATION_LEASE_TTL_MS,
                heartbeat_at: now,
                payload_json: payloadJson,
                created_at: acquiredAt,
                updated_at: now,
              })
              .where("scope", "=", identity.scope)
              .where("lease_key", "=", identity.key)
              .where("owner", "=", observed.owner)
              .returning("expires_at"),
          );
          if (!restored?.expires_at) {
            throw new Error("Gateway returned execution grant changed during restoration");
          }
          expiresAt = restored.expires_at;
          return;
        }
        const renewed = renewOpenClawStateLeaseUnderWriteFence(
          db,
          identity,
          acquiredAt,
          STARTUP_MIGRATION_LEASE_TTL_MS,
        );
        if (!renewed || !updateOpenClawStateLeasePayloadInTransaction(db, identity, payloadJson)) {
          throw new Error("Gateway execution ownership could not be restored");
        }
        expiresAt = renewed;
      });
      await startHeartbeat();
      released = false;
      yielded = undefined;
      yieldStoppedHeartbeat = false;
    },
  };
}

/** Execution-owner transfer is distinct from the later positively observed read retirement. */
export function admitGatewayRollingSuccessor(
  observed: GatewayOwnerLeaseIdentity | undefined,
  contract: GatewayRollingContract,
): GatewayOwnerLeaseIdentity {
  if (
    !observed ||
    observed.rollingReturnToOwner !== undefined ||
    !contract.companionGeneration ||
    observed.owner !== contract.predecessorOwner ||
    contract.expiresAtMs <= Date.now() ||
    !observed.rollingHandoff ||
    Object.entries(contract).some(
      ([key, value]) => observed.rollingHandoff?.[key as keyof GatewayRollingContract] !== value,
    )
  ) {
    throw new Error("Exact yielded Gateway rolling execution handoff was not observed");
  }
  return observed;
}

/** The lock's physical custody guards its existing execution-lease operations. */
export function createGatewayRollingLeaseControls(
  ownerLease: GatewayOwnerLease | undefined,
  assertStateOwnerCurrent: () => void,
) {
  const currentOwner = (message = "Gateway execution owner is unavailable") => {
    assertStateOwnerCurrent();
    if (!ownerLease) {
      throw new Error(message);
    }
    return ownerLease;
  };
  return {
    yieldExecutionForRollingHandoff: async (contract: GatewayRollingContract) =>
      currentOwner("Gateway rolling handoff requires the current global owner lease").yieldTo(
        contract,
      ),
    observeRollingExecutionHandoff: async () => currentOwner().observeYield(),
    rebindRollingExecutionHandoff: async (
      previous: GatewayRollingContract,
      candidateBootId: string,
      expectedOwner: string,
    ) => currentOwner().rebindYield(previous, candidateBootId, expectedOwner),
    restoreExecutionAfterRollingHandoff: async () => {
      const owner = currentOwner();
      await owner.restoreYield();
      owner.markListening();
    },
    returnRollingPreparationToPredecessor: async () =>
      currentOwner("Gateway rolling preparation owner is unavailable").returnToPredecessor(),
    commitRollingPreparation: (releaseId: string) =>
      currentOwner("Gateway preparation owner is unavailable").commitPreparation(releaseId),
    gatewayOwnerId: ownerLease?.owner,
  };
}
