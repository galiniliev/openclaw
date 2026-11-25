import { createSubsystemLogger } from "../logging/subsystem.js";
import { extractErrorCode } from "./errors.js";
import {
  SOURCE_FENCE_ACCEPTED,
  SOURCE_FENCE_READY,
  type SqliteSourceFenceGrant,
  type SqliteSourceFenceIdentity,
} from "./sqlite-source-fence-contract.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
} from "./sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "./sqlite-worker-operation-settlement.js";

const SOURCE_FENCE_WAITING = 0;
const SOURCE_FENCE_REVOKED = 3;

export type SqliteSourceFenceOwner = {
  identity: SqliteSourceFenceIdentity;
  /** Must abort synchronously on owner/config/caller revocation, including during preparation. */
  signal: AbortSignal;
  assertCurrent(): void;
  /** Enroll native settlement in this physical owner's drain before any reservation. */
  retain(operation: RetainedWorkerTransactionAdmission): void;
};

/**
 * Each dispatch gets one revocable acceptance decision. Once accepted, the broker
 * retains native settlement; cancellation cannot release SQLite reservations.
 */
export function createSqliteSourceFenceAdmission(options: {
  destination: SqliteSourceFenceOwner;
  sources: readonly SqliteSourceFenceOwner[];
  signal: AbortSignal;
  deadlineNs: bigint;
}): SqliteWorkerAdmissionFactory {
  if (options.sources.length === 0) {
    throw new Error("SQLite source fence requires an explicit source");
  }
  const owners = [options.destination, ...options.sources];
  const identities = owners.map(({ identity }) => {
    if (!identity.physical.key.startsWith("file:") || !identity.incarnation) {
      throw new Error("SQLite source fence requires retained durable owners");
    }
    return structuredClone(identity);
  });
  const destination = structuredClone(options.destination.identity);
  return (operation) => {
    const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const signals = new Set([options.signal, ...owners.map((owner) => owner.signal)]);
    const report = (reason: "revoked" | "deadline") => {
      try {
        createSubsystemLogger("infra/source-fence").warn(`Source fence admission ${reason}`, {
          destinationIncarnation: destination.incarnation,
          sourceIncarnations: identities.slice(1).map((identity) => identity.incarnation),
          decision: Atomics.load(decision, 0),
          deadlineExpired: process.hrtime.bigint() >= options.deadlineNs,
          callerAborted: options.signal.aborted,
          destinationAborted: options.destination.signal.aborted,
          sourceAborted: options.sources.map((owner) => owner.signal.aborted),
          abortCodes: [...signals]
            .filter((signal) => signal.aborted)
            .map((signal) => {
              const code = extractErrorCode(signal.reason);
              return typeof code === "string" && code.startsWith("GITHUB_PUBLICATION_")
                ? code
                : "unclassified";
            }),
        });
      } catch {
        // Diagnostics never change admission, cancellation or native settlement.
      }
    };
    const revoke = () => {
      for (;;) {
        const current = Atomics.load(decision, 0);
        if (current === SOURCE_FENCE_ACCEPTED || current === SOURCE_FENCE_REVOKED) {
          return;
        }
        if (Atomics.compareExchange(decision, 0, current, SOURCE_FENCE_REVOKED) === current) {
          if ([...signals].some((signal) => signal.aborted)) {
            report("revoked");
          }
          return;
        }
      }
    };
    const assertCurrent = () => {
      if ([...signals].some((signal) => signal.aborted)) {
        revoke();
      }
      if (
        Atomics.load(decision, 0) === SOURCE_FENCE_REVOKED ||
        process.hrtime.bigint() >= options.deadlineNs
      ) {
        report(Atomics.load(decision, 0) === SOURCE_FENCE_REVOKED ? "revoked" : "deadline");
        throw new SqliteWorkerError("SQLite source fence authority expired", "closed");
      }
      for (const owner of owners) {
        owner.assertCurrent();
      }
    };
    assertCurrent();
    for (const owner of owners) {
      owner.retain(operation);
    }
    for (const signal of signals) {
      signal.addEventListener("abort", revoke, { once: true });
    }
    const detach = () => {
      revoke();
      for (const signal of signals) {
        signal.removeEventListener("abort", revoke);
      }
    };
    const attachment: SqliteSourceFenceGrant = {
      kind: "sqlite-source-fence",
      version: 1,
      decision: decision.buffer,
      destination,
      sources: identities.slice(1),
      deadlineNs: options.deadlineNs,
    };
    try {
      const admission = createSqliteWorkerOperationAdmission((request, grant) => {
        if (
          request.stage !== "prepare" ||
          request.facts !== "sqlite-source-fence" ||
          Atomics.load(decision, 0) !== SOURCE_FENCE_WAITING
        ) {
          throw new SqliteWorkerError(
            "SQLite source fence admission requested out of order",
            "closed",
          );
        }
        assertCurrent();
        if (
          !grant(() => {
            if (
              Atomics.compareExchange(decision, 0, SOURCE_FENCE_WAITING, SOURCE_FENCE_READY) !==
              SOURCE_FENCE_WAITING
            ) {
              report("revoked");
              throw new SqliteWorkerError("SQLite source fence authority expired", "closed");
            }
          })
        ) {
          revoke();
        }
      }, attachment);
      void operation.settled.then(detach, detach);
      return {
        admission,
        nativeLocations: identities.map((identity) => identity.physical.canonicalPath),
      };
    } catch (error) {
      detach();
      throw error;
    }
  };
}
