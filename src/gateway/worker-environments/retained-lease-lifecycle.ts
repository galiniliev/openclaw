import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WorkerLease, WorkerProvider } from "../../plugins/types.js";
import type {
  WorkerRetainedLeaseReceipt,
  WorkerDiskRetentionPolicy,
  WorkerSessionDiskRetention,
} from "../../plugins/worker-retention.types.js";
import type { RetainedWorkspaceAuthority } from "../../state/retained-workspace-authority.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import {
  workerEnvironmentServiceError as serviceError,
  WorkerRetainedLeaseInspectionUnavailableError,
} from "./environment-errors.js";
import { requireWorkerProfile } from "./service-validation.js";
import type { WorkerEnvironmentStore, WorkerEnvironmentRecord } from "./store.js";

const log = createSubsystemLogger("gateway/worker-environments");

class RetainedWorkerResourceMissingError extends Error {
  constructor() {
    super(
      "Retained worker resource is missing; recovery is held until its authoritative disk is restored",
    );
    this.name = "RetainedWorkerResourceMissingError";
  }
}

/** Uses the environment's existing lock and writer; no independent queue or timer. */
export function createWorkerRetainedLeaseLifecycle(options: {
  store: Pick<WorkerEnvironmentStore, "get" | "recordRetention">;
  providerFor: (id: string) => WorkerProvider;
  signal: AbortSignal;
  now: () => number;
  isStopping?: () => boolean;
  tunnelManager?: { stop: (environmentId: string, ownerEpoch?: number) => Promise<void> };
  saveError?: (record: WorkerEnvironmentRecord, error: unknown) => Promise<unknown>;
}) {
  const current = (record: WorkerEnvironmentRecord, assertCurrent: () => void) => {
    options.signal.throwIfAborted();
    assertCurrent();
    const live = options.store.get(record.environmentId);
    if (
      !live?.retention ||
      live.ownerEpoch !== record.ownerEpoch ||
      live.leaseId !== record.leaseId ||
      live.nodeDeviceId !== record.nodeDeviceId ||
      live.destroyRequestedAtMs !== null ||
      live.retention.ownerBinding !== record.retention?.ownerBinding
    ) {
      throw new Error("Retained worker ownership changed");
    }
    return live;
  };
  const publish = async (
    record: WorkerEnvironmentRecord,
    retention: WorkerSessionDiskRetention,
    assertCurrent: () => void,
  ) => {
    const live = current(record, assertCurrent);
    if (!live.retention) {
      throw new Error("Retained worker ownership is unavailable");
    }
    return options.store.recordRetention(
      {
        environmentId: live.environmentId,
        expectedOwnerEpoch: live.ownerEpoch,
        expectedRetention: live.retention,
        retention,
      },
      assertCurrent,
    );
  };
  const leaseRequest = (
    record: WorkerEnvironmentRecord,
    signal: AbortSignal,
    assertCurrent: () => void,
    originalDisk?: RetainedWorkspaceAuthority,
  ) => {
    const leaseId = record.leaseId ?? originalDisk?.identity.leaseId;
    if (!leaseId || !record.retention) {
      throw new Error("Retained worker lease is missing");
    }
    if (
      originalDisk &&
      (!["requested", "provisioning"].includes(record.state) ||
        record.leaseId !== null ||
        record.environmentId !== originalDisk.environmentId ||
        record.ownerEpoch <= originalDisk.ownerEpoch ||
        record.retention.ownerBinding !== originalDisk.ownerBinding ||
        record.retention.owner.sessionId !== originalDisk.sessionId)
    ) {
      throw new Error("Original retained lease is not owned by this fresh provisioning request");
    }
    return {
      leaseId,
      profile: requireWorkerProfile(record.profileSnapshot.settings),
      retention: record.retention,
      signal: AbortSignal.any([signal, options.signal]),
      assertCurrent: () => {
        signal.throwIfAborted();
        current(record, assertCurrent);
      },
    };
  };
  const accept = async (
    record: WorkerEnvironmentRecord,
    receipt: WorkerRetainedLeaseReceipt,
    assertCurrent: () => void,
    originalDisk?: RetainedWorkspaceAuthority,
  ) => {
    const live = current(record, assertCurrent);
    const retention = live.retention!;
    const missing = receipt.observedState === "missing";
    if (
      receipt.ownerBinding !== retention.ownerBinding ||
      (!receipt.policyVerified && !missing) ||
      receipt.computeWindowSeconds !== retention.policy.computeWindowSeconds ||
      !receipt.identity.resourceId ||
      (originalDisk && !isDeepStrictEqual(receipt.identity, originalDisk.identity)) ||
      (retention.receipt && !isDeepStrictEqual(receipt.identity, retention.receipt.identity))
    ) {
      throw new Error(
        "Retained worker resource or disk policy is missing or mismatched; replacement is refused",
      );
    }
    if (missing) {
      throw new RetainedWorkerResourceMissingError();
    }
    const operation =
      retention.operation &&
      receipt.operation?.id === retention.operation.id &&
      receipt.operation.action === retention.operation.action &&
      receipt.operation.expectedClaimRevision === retention.operation.expectedClaimRevision &&
      receipt.operation.phase === "observed"
        ? null
        : retention.operation;
    if (isDeepStrictEqual(receipt, retention.receipt) && operation === retention.operation) {
      return live;
    }
    return publish(live, { ...retention, receipt, operation }, assertCurrent);
  };
  const observe = async (
    record: WorkerEnvironmentRecord,
    signal: AbortSignal,
    assertCurrent: () => void,
    originalDisk?: RetainedWorkspaceAuthority,
  ) => {
    const provider = options.providerFor(record.providerId).retainedLease;
    if (!provider) {
      throw new Error("Retained worker provider is unavailable; ownership is preserved");
    }
    const request = leaseRequest(record, signal, assertCurrent, originalDisk);
    let authorityFailure: { cause: unknown } | undefined;
    let receipt: WorkerRetainedLeaseReceipt;
    try {
      receipt = await provider.inspect({
        ...request,
        assertCurrent: () => {
          try {
            request.assertCurrent();
          } catch (cause) {
            authorityFailure = { cause };
            throw cause;
          }
        },
      });
    } catch (cause) {
      request.signal.throwIfAborted();
      if (authorityFailure) {
        throw authorityFailure.cause;
      }
      current(record, assertCurrent);
      if (options.isStopping?.()) {
        throw cause;
      }
      throw new WorkerRetainedLeaseInspectionUnavailableError(cause);
    }
    if (authorityFailure) {
      throw authorityFailure.cause;
    }
    // Native validation/persistence failures must remain fatal, not provider outages.
    return accept(record, receipt, assertCurrent, originalDisk);
  };
  const operate = async (
    record: WorkerEnvironmentRecord,
    action: "pause" | "resume",
    signal: AbortSignal,
    assertCurrent: () => void,
    originalDisk?: RetainedWorkspaceAuthority,
  ) => {
    let live = current(record, assertCurrent);
    const retained = live.retention!;
    const provider = options.providerFor(live.providerId).retainedLease;
    if (!provider || !retained.receipt) {
      throw new Error("Retained worker receipt is unavailable; replacement is refused");
    }
    if (retained.operation && retained.operation.action !== action) {
      throw new Error("Retained worker has an unsettled lifecycle operation; retry recovery");
    }
    if (!retained.operation) {
      live = await publish(
        live,
        {
          ...retained,
          desiredState: action === "pause" ? "suspended" : "running",
          operation: {
            id: randomUUID(),
            action,
            expectedClaimRevision: retained.receipt.claimRevision,
          },
        },
        assertCurrent,
      );
    }
    const operationId = live.retention!.operation!.id;
    const started = performance.now();
    let outcome = "pending";
    let receipt: WorkerRetainedLeaseReceipt;
    try {
      receipt = await provider[action]({
        ...leaseRequest(live, signal, assertCurrent, originalDisk),
        operationId,
      });
      outcome = receipt.operation?.phase === "observed" ? "observed" : "pending";
    } finally {
      try {
        log.info("Worker retention phase", {
          environmentId: live.environmentId,
          operationId,
          phase: action,
          outcome,
          durationMs: Math.round(performance.now() - started),
        });
      } catch {
        /* Observability cannot settle or replace lifecycle work. */
      }
    }
    live = await accept(live, receipt, assertCurrent, originalDisk);
    if (live.retention?.operation) {
      throw new Error("Retained worker lifecycle remains pending; ownership is preserved");
    }
    return live;
  };
  const hasDiskAuthority = async (record: WorkerEnvironmentRecord, assertCurrent: () => void) => {
    if (!record.retention) {
      return false;
    }
    const workspace = await getSessionRepositoryWorkspaceStore().find(record.retention.owner);
    current(record, assertCurrent);
    return workspace?.diskAuthority !== undefined;
  };
  const expired = (record: WorkerEnvironmentRecord) => {
    const receipt = record.retention?.receipt;
    return (
      !receipt ||
      receipt.computeWindow.state === "closed" ||
      Date.parse(receipt.computeWindow.expiresAt) <= options.now()
    );
  };
  const pause = async (
    record: WorkerEnvironmentRecord,
    signal: AbortSignal,
    assertCurrent: () => void,
    originalDisk?: RetainedWorkspaceAuthority,
  ) => {
    let live = current(record, assertCurrent);
    if (live.retention?.desiredState !== "suspended") {
      live = await publish(live, { ...live.retention!, desiredState: "suspended" }, assertCurrent);
    }
    live = await observe(live, signal, assertCurrent, originalDisk);
    if (live.retention?.operation?.action === "resume") {
      live = await operate(live, "resume", signal, assertCurrent, originalDisk);
    }
    const receipt = live.retention!.receipt!;
    return receipt.computeWindow.state === "closed" &&
      receipt.desiredState === "suspended" &&
      !receipt.stopPending &&
      ["stopped", "suspended"].includes(receipt.observedState.toLowerCase()) &&
      !live.retention?.operation
      ? live
      : operate(live, "pause", signal, assertCurrent, originalDisk);
  };
  const resume = async (
    record: WorkerEnvironmentRecord,
    signal: AbortSignal,
    assertCurrent: () => void,
    originalDisk?: RetainedWorkspaceAuthority,
  ) => {
    let live = await observe(record, signal, assertCurrent, originalDisk);
    const receipt = live.retention!.receipt!;
    if (
      live.retention?.desiredState === "suspended" ||
      live.retention?.operation?.action === "pause" ||
      expired(live) ||
      receipt.observedState.toLowerCase() !== "running"
    ) {
      live = await pause(live, signal, assertCurrent, originalDisk);
    }
    if (live.retention?.operation?.action === "resume") {
      live = await operate(live, "resume", signal, assertCurrent, originalDisk);
    }
    if (expired(live)) {
      live = await operate(live, "resume", signal, assertCurrent, originalDisk);
    }
    if (expired(live) || live.retention?.operation || live.retention?.receipt?.stopPending) {
      throw new Error("Retained worker has no active authorized compute window");
    }
    return live;
  };
  return {
    async resumeForProvision(
      record: WorkerEnvironmentRecord,
      originalDisk: RetainedWorkspaceAuthority,
      signal: AbortSignal,
      assertCurrent: () => void,
    ) {
      assertCurrent();
      const owner = record.retention?.owner;
      if (!owner) {
        throw new Error("Original retained provisioning owner is unavailable");
      }
      const store = getSessionRepositoryWorkspaceStore();
      const workspace = await store.find(owner);
      assertCurrent();
      if (!workspace) {
        throw new Error("Original retained workspace is unavailable");
      }
      const source = await store.prepare(workspace.workspaceId);
      const assertSource = () => {
        assertCurrent();
        source.assertSourceCurrent();
        if (!isDeepStrictEqual(source.current()?.diskAuthority, originalDisk)) {
          throw new Error("Original retained disk authority changed before provisioning");
        }
      };
      assertSource();
      return resume(record, signal, assertSource, originalDisk);
    },
    async inspectForTurn(
      request: {
        environmentId: string;
        ownerEpoch: number;
        leaseId: string;
        assertCurrent: () => void;
        signal?: AbortSignal;
      },
      fallback: (value: typeof request) => Promise<void>,
    ) {
      const record = options.store.get(request.environmentId);
      if (!record?.retention) {
        return fallback(request);
      }
      const assertCurrent = () => {
        request.assertCurrent();
        request.signal?.throwIfAborted();
        const live = current(record, request.assertCurrent);
        if (
          live.ownerEpoch !== request.ownerEpoch ||
          live.leaseId !== request.leaseId ||
          live.state !== "attached" ||
          live.attachedSessionIds[0] !== live.retention?.owner.sessionId
        ) {
          throw new Error("Retained session placement is not current");
        }
      };
      try {
        await this.resumeForTurn(record, request.signal ?? options.signal, assertCurrent);
      } catch (error) {
        if (
          !(error instanceof RetainedWorkerResourceMissingError) ||
          (await hasDiskAuthority(record, assertCurrent))
        ) {
          throw error;
        }
        return fallback(request);
      }
    },
    async acceptInitial(
      this: void,
      record: WorkerEnvironmentRecord,
      lease: WorkerLease,
      assertCurrent: () => void,
    ) {
      if (!record.retention) {
        return record;
      }
      const receipt = lease.retainedLease;
      if (!receipt || receipt.identity.leaseId !== lease.leaseId) {
        throw new Error(
          "Retained allocation has no exact receipt; original allocation custody is preserved",
        );
      }
      return accept(record, receipt, assertCurrent);
    },
    async pauseCurrent(request: {
      environmentId: string;
      ownerEpoch: number;
      assertCurrent: () => void;
      signal?: AbortSignal;
    }) {
      const record = options.store.get(request.environmentId);
      if (
        !record?.retention ||
        record.ownerEpoch !== request.ownerEpoch ||
        record.state !== "attached"
      ) {
        throw new Error("Retained placement is unavailable");
      }
      const assertCurrent = () => {
        request.assertCurrent();
        current(record, request.assertCurrent);
        if (options.isStopping?.()) {
          throw new Error("Retention admission is stopping");
        }
      };
      try {
        assertCurrent();
        if (record.retention.desiredState !== "suspended") {
          await publish(record, { ...record.retention, desiredState: "suspended" }, assertCurrent);
        }
        await options.tunnelManager?.stop(record.environmentId, record.ownerEpoch);
        assertCurrent();
        return await pause(record, request.signal ?? options.signal, assertCurrent);
      } catch (error) {
        await options.saveError?.(record, error);
        throw error;
      }
    },
    expired,
    pause,
    observe,
    async reconcile(
      record: WorkerEnvironmentRecord,
      signal: AbortSignal,
      assertCurrent: () => void,
    ) {
      if (!record.retention || !record.leaseId || record.destroyRequestedAtMs !== null) {
        return record;
      }
      let live: WorkerEnvironmentRecord;
      try {
        live = await observe(record, signal, assertCurrent);
      } catch (error) {
        if (
          !(error instanceof RetainedWorkerResourceMissingError) ||
          (await hasDiskAuthority(record, assertCurrent))
        ) {
          throw error;
        }
        return current(record, assertCurrent);
      }
      return live.retention?.desiredState === "suspended" ||
        live.retention?.operation ||
        expired(live) ||
        live.retention?.receipt?.observedState.toLowerCase() !== "running"
        ? undefined
        : live;
    },
    async resumeForTurn(
      record: WorkerEnvironmentRecord,
      signal: AbortSignal,
      assertCurrent: () => void,
    ) {
      return resume(record, signal, assertCurrent);
    },
  };
}

/** Bind private disk ownership before allocation; an existing reserve cannot be adopted. */
export function createWorkerSessionDiskRetention(params: {
  provider: WorkerProvider;
  policy: WorkerDiskRetentionPolicy | undefined;
  owner: WorkerSessionDiskRetention["owner"] | undefined;
  environmentId: string;
  provisionOperationId: string;
}): WorkerSessionDiskRetention {
  const { provider, policy, owner, environmentId, provisionOperationId } = params;
  if (!owner || !provider.retainedLease || !provider.requiresNodeEnrollment) {
    throw serviceError(
      "invalid_profile",
      "Session disk retention requires an exclusive session and a retention-capable managed-node provider",
    );
  }
  if (!policy) {
    throw serviceError("invalid_profile", "New session retention admission is disabled");
  }
  return {
    policy,
    owner,
    ownerBinding: createHash("sha256")
      .update(JSON.stringify([owner, environmentId, provisionOperationId]))
      .digest("hex"),
    desiredState: "running",
    receipt: null,
    operation: null,
  };
}

/** A work window bounds execution, independently of provider idle-stop latency. */
export function boundRetainedWorkerTurn(
  turn: SessionPlacementTurnParams,
  retention: WorkerSessionDiskRetention | null | undefined,
): SessionPlacementTurnParams {
  if (!retention) {
    return turn;
  }
  const remainingMs = retention.receipt
    ? Date.parse(retention.receipt.computeWindow.expiresAt) - Date.now()
    : 0;
  if (
    remainingMs <= 0 ||
    retention.operation ||
    retention.receipt?.computeWindow.state !== "active" ||
    retention.desiredState !== "running"
  ) {
    throw new Error("Retained worker compute admission is closed; retry same-session recovery");
  }
  const deadline = AbortSignal.timeout(Math.ceil(remainingMs));
  return {
    ...turn,
    timeoutMs: Math.min(turn.timeoutMs, remainingMs),
    abortSignal: turn.abortSignal ? AbortSignal.any([turn.abortSignal, deadline]) : deadline,
  };
}
