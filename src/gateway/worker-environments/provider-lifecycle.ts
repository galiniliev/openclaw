import type { WorkerEnvironmentStartStatus } from "../../../packages/gateway-protocol/src/schema/environments.js";
import type { WorkerProvider } from "../../plugins/types.js";
import type { RetainedWorkspaceAuthority } from "../../state/retained-workspace-authority.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { createDedicatedNodeLeaseAttestations } from "./dedicated-node-lease-attestations.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import { createWorkerReconcileTrace } from "./environment-operation.js";
import type { WorkerInitialSnapshotCustody } from "./preparation-identity.js";
import { createWorkerProviderIntent, failUnallocatedImageIntent } from "./provider-intent.js";
import { createWorkerLeaseInspection } from "./provider-lease-inspection.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { createWorkerMachineCatalog } from "./provider-machine-catalog.js";
import { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import type { WorkerProviderRepositorySource } from "./provider-project-preparation.js";
import { createWorkerProvisionCancellation } from "./provider-provisioning-cancellation.js";
import { createWorkerProviderProvisioning } from "./provider-provisioning.js";
import { createWorkerRuntimeRefresher } from "./provider-runtime-refresh.js";
import { createWorkerRetainedLeaseLifecycle } from "./retained-lease-lifecycle.js";
import { requireInstall } from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

const ORPHANED_LEASE_ERROR = "Worker provider no longer recognizes the lease";

export function createWorkerProviderLifecycle(
  options: WorkerProviderLifecycleOptions & { ownerSignal: AbortSignal },
) {
  const { store, move, saveError, now = Date.now } = options;
  const startStatuses = new Map<
    string,
    { ownerEpoch: number; status: WorkerEnvironmentStartStatus }
  >();
  const { commitReady, ensurePendingCredential } = options.credentialBroker;
  const dedicatedLeases = createDedicatedNodeLeaseAttestations(options, (record) =>
    requireCurrentOwner(record),
  );

  const providerFor = (providerId: string): WorkerProvider => {
    const provider = options.resolveProvider(providerId);
    if (provider) {
      return provider;
    }
    throw serviceError("provider_not_found", `Worker provider is unavailable: ${providerId}`);
  };

  const retained = createWorkerRetainedLeaseLifecycle({
    ...options,
    providerFor,
    signal: options.ownerSignal,
    now,
  });
  const {
    identityResolverFor,
    requireCurrentOwner,
    stopOwner,
    beginDrain,
    finishProvenDestroy,
    lifecycleLease,
    finishDestroy,
    failBootstrap,
    finishBootstrap,
    finishConfirmedProvisionCleanup,
    preserveIndeterminateProvisionCleanup,
    destroy,
    reclaim,
    retireMismatchedLease,
  } = createWorkerProviderOwnerLifecycle({
    ...options,
    providerFor,
    onOwnerStopped: dedicatedLeases.retire,
  });

  const { settleLostLease, inspectTurnLease } = createWorkerLeaseInspection({
    ...options,
    providerFor,
    inspect: dedicatedLeases.inspect,
    lifecycleLease,
    stopOwner,
    beginDrain,
    finishProvenDestroy,
    finishDestroy,
  });

  const expirePrepared = async (record: WorkerEnvironmentRecord) =>
    record.preparation?.consumedAtMs === null && record.preparation.expiresAtMs <= now()
      ? store.requestDestroy({
          environmentId: record.environmentId,
          state: record.state,
          lastError: "Unused prepared worker expired",
          assertCurrent: () => requireCurrentOwner(record),
        })
      : record;

  const nodeProvisioning = createWorkerNodeProvisioning({
    ...options,
    commitReady,
    failBootstrap,
    acceptInitial: retained.acceptInitial,
  });

  const runtimeRefresher = createWorkerRuntimeRefresher({
    ...options,
    providerFor,
    requireCurrentOwner,
    stopOwner,
    identityResolverFor,
  });

  const finishProvision = createWorkerProviderProvisioning({
    options,
    nodeProvisioning,
    retained,
    dedicatedLeases,
    startStatuses,
    owner: {
      requireCurrentOwner,
      failBootstrap,
      finishBootstrap,
      finishConfirmedProvisionCleanup,
      preserveIndeterminateProvisionCleanup,
    },
  });

  const resumeProvision = async (
    record: WorkerEnvironmentRecord,
    provider = providerFor(record.providerId),
    signal?: AbortSignal,
    retainProviderSettlement?: (settled: Promise<void>) => void,
    beforeProvision?: () => void,
    repositorySource?: WorkerProviderRepositorySource,
    originalDisk?: RetainedWorkspaceAuthority,
    recordInitialSnapshot?: (custody: WorkerInitialSnapshotCustody) => void,
  ) => {
    const workSignal = signal
      ? AbortSignal.any([options.ownerSignal, signal])
      : options.ownerSignal;
    let pending = await expirePrepared(record);
    if (pending.destroyRequestedAtMs !== null) {
      return finishDestroy(pending, provider);
    }
    // Shutdown cancels this attempt; only request cancellation records destroy intent.
    const cancellation = signal
      ? createWorkerProvisionCancellation(store, record, signal)
      : undefined;
    if (cancellation) {
      retainProviderSettlement?.(cancellation.settled);
    }
    try {
      beforeProvision?.();
      if (originalDisk) {
        pending = await retained.resumeForProvision(pending, originalDisk, workSignal, () => {
          cancellation?.assertActive();
          beforeProvision?.();
          requireCurrentOwner(pending);
        });
      }
      const preparedNode = await nodeProvisioning.prepare(
        pending,
        provider,
        workSignal,
        beforeProvision,
      );
      let installation: WorkerInstallationArtifact | undefined = preparedNode?.installation;
      cancellation?.assertActive();
      if (
        record.state === "requested" &&
        record.destroyRequestedAtMs === null &&
        !installation &&
        provider.provisionBeforeInstallation !== true
      ) {
        try {
          // Fresh requests package before allocation. Once provisioning is durable, provider replay
          // must happen first because the previous response may have been lost after allocation.
          installation = await options.prepareInstallation(requireInstall(record), workSignal);
        } catch (error) {
          cancellation?.assertActive();
          options.ownerSignal.throwIfAborted();
          const detail = boundedError(error);
          await move(record, "failed", { lastError: detail });
          throw serviceError(
            "bootstrap_failure",
            `Worker installation preparation failed: ${detail}`,
          );
        }
        cancellation?.assertActive();
      }
      beforeProvision?.();
      return await finishProvision(
        pending,
        provider,
        workSignal,
        installation,
        cancellation,
        preparedNode?.identity,
        beforeProvision,
        repositorySource,
        recordInitialSnapshot,
      );
    } catch (error) {
      return await failUnallocatedImageIntent(options, record, error, workSignal);
    } finally {
      await cancellation?.close();
    }
  };

  const reconcileRecord = async (
    initialRecord: WorkerEnvironmentRecord,
    signal?: AbortSignal,
    retainProviderSettlement?: (settled: Promise<void>) => void,
    beforeProvision?: () => void,
    repositorySource?: WorkerProviderRepositorySource,
  ): Promise<void> => {
    const step = createWorkerReconcileTrace(initialRecord);
    const workSignal = signal
      ? AbortSignal.any([options.ownerSignal, signal])
      : options.ownerSignal;
    workSignal.throwIfAborted();
    let record = initialRecord;
    if (record.state === "requested" && record.destroyRequestedAtMs !== null) {
      return void (await finishDestroy(record));
    }
    const retainedRecord = await retained.reconcile(record, workSignal, () => {
      workSignal.throwIfAborted();
      beforeProvision?.();
    });
    if (!retainedRecord) {
      return;
    }
    record = retainedRecord;
    let currentBundle: WorkerInstallationArtifact | undefined;
    if (
      record.destroyRequestedAtMs === null &&
      ["ready", "idle", "attached"].includes(record.state)
    ) {
      try {
        currentBundle = await step("installation", () =>
          options.prepareInstallation("bundle", workSignal),
        );
        if (record.bootstrapReceipt && sameWorkerBuild(record.bootstrapReceipt, currentBundle)) {
          const sessionId = record.state === "attached" ? record.attachedSessionIds[0] : null;
          if (record.state !== "attached" || sessionId) {
            await step("credential", () => ensurePendingCredential(record, sessionId ?? null));
            record = store.get(record.environmentId) ?? record;
          }
        }
      } catch {
        workSignal.throwIfAborted();
        // Provider inspection and the state-specific path below retain their existing retry policy.
      }
    }
    let provider: WorkerProvider;
    try {
      provider = providerFor(record.providerId);
    } catch (error) {
      await saveError(record, error);
      return;
    }
    const leaseId = record.leaseId;
    if (!leaseId) {
      await (
        record.destroyRequestedAtMs !== null
          ? finishDestroy(record, provider, workSignal)
          : resumeProvision(
              record,
              provider,
              signal,
              retainProviderSettlement,
              beforeProvision,
              repositorySource,
            )
      ).catch(() => undefined);
      return;
    }
    if (await step("mismatched-lease", () => retireMismatchedLease(record, provider))) {
      return;
    }
    const lease = lifecycleLease(record, leaseId);
    const inspection = await dedicatedLeases.inspect(record, provider, lease, workSignal);
    if (!inspection) {
      return;
    }
    const { status } = inspection;
    const teardownExpected = record.destroyRequestedAtMs !== null || record.state === "destroying";
    if (status === "destroyed" || status === "unknown") {
      await settleLostLease(record, provider, status);
      return;
    }
    if (status === "dormant") {
      if (teardownExpected) {
        await finishDestroy(record, provider).catch(() => undefined);
      }
      // A paired device may be offline without losing its lease. Keep that authoritative
      // holding state out of the unknown/orphan path until pairing itself is removed.
      return;
    }
    record = await dedicatedLeases.reconcileSharedHost(record, leaseId, inspection, stopOwner);
    if (record.destroyRequestedAtMs !== null) {
      await finishDestroy(record, provider).catch(() => undefined);
      return;
    }
    if (!record.sshEndpoint || record.state === "attached") {
      // Failed upgrades retain the old receipt and exact lease for recovery.
      await runtimeRefresher
        .refresh(record, provider, currentBundle, workSignal)
        .catch(async (error: unknown) => {
          workSignal.throwIfAborted();
          await saveError(record, error);
        });
      return;
    }
    if (record.state === "draining") {
      // Draining without destroy intent is durable provider-loss cleanup.
      record = await stopOwner(record);
      await move(record, "orphaned", { lastError: record.lastError ?? ORPHANED_LEASE_ERROR });
      return;
    }
    if (["bootstrapping", "ready", "idle"].includes(record.state)) {
      let cancellation = signal
        ? createWorkerProvisionCancellation(store, record, signal)
        : undefined;
      if (cancellation) {
        retainProviderSettlement?.(cancellation.settled);
      }
      try {
        cancellation?.assertActive();
        let installation = currentBundle;
        try {
          // Bundle identity is local and canonical for both install channels. A matching admitted
          // receipt must not depend on npm registry availability during routine reconciliation.
          installation ??= await options.prepareInstallation("bundle", workSignal);
        } catch (error) {
          workSignal.throwIfAborted();
          if (record.bootstrapReceipt && ["ready", "idle"].includes(record.state)) {
            await saveError(record, error);
            return;
          }
          await failBootstrap(record, leaseId, provider, error).catch(() => undefined);
          return;
        }
        if (record.bootstrapReceipt && sameWorkerBuild(record.bootstrapReceipt, installation)) {
          await ensurePendingCredential(record, null);
          return;
        }
        if (requireInstall(record) === "npm") {
          try {
            installation = await options.prepareInstallation("npm", workSignal);
          } catch (error) {
            workSignal.throwIfAborted();
            await failBootstrap(record, leaseId, provider, error).catch(() => undefined);
            return;
          }
        }
        record = await stopOwner(record);
        cancellation?.assertActive();
        const bootstrapping =
          record.state === "bootstrapping" ? record : await move(record, "bootstrapping");
        if (cancellation && bootstrapping.ownerEpoch !== record.ownerEpoch) {
          // Rebootstrap retires the admitted owner. Transfer cancellation synchronously
          // to the committed epoch before a child can run under that new authority.
          await cancellation.close();
          cancellation = createWorkerProvisionCancellation(
            store,
            bootstrapping,
            cancellation.signal,
          );
          retainProviderSettlement?.(cancellation.settled);
          cancellation.assertActive();
        }
        await finishBootstrap(bootstrapping, provider, installation, cancellation).catch(
          () => undefined,
        );
        return;
      } finally {
        await cancellation?.close();
      }
    }
    if (["draining", "destroying"].includes(record.state)) {
      await finishDestroy(record, provider).catch(() => undefined);
    }
  };

  const intentOwner = createWorkerProviderIntent({
    ...options,
    providerFor,
    resumeProvision,
  });

  return {
    readStartStatus: (record: WorkerEnvironmentRecord) => {
      const entry = startStatuses.get(record.environmentId);
      return record.state === "provisioning" && entry?.ownerEpoch === record.ownerEpoch
        ? entry.status
        : undefined;
    },
    getDedicatedNodeLeaseSignal: dedicatedLeases.signal,
    clearDedicatedNodeLeases: () => dedicatedLeases.clear(),
    ...intentOwner,
    resumePrepared: (
      record: WorkerEnvironmentRecord,
      signal?: AbortSignal,
      beforeReconcile?: () => void,
      repositorySource?: WorkerProviderRepositorySource,
    ) =>
      options.withLock(record.environmentId, async () => {
        signal?.throwIfAborted();
        beforeReconcile?.();
        let current = store.get(record.environmentId);
        if (!current || !current.preparation || current.preparation.consumedAtMs !== null) {
          return current;
        }
        current = await expirePrepared(current);
        if (current.destroyRequestedAtMs !== null) {
          return finishDestroy(current);
        }
        // Keep the reserve slot and lock until any timed-out allocation actually settles.
        const providerSettlements: Promise<void>[] = [];
        try {
          await reconcileRecord(
            current,
            signal ?? new AbortController().signal,
            (settled) => providerSettlements.push(settled),
            beforeReconcile,
            repositorySource,
          );
        } finally {
          await Promise.all(providerSettlements);
        }
        return store.get(record.environmentId);
      }),
    destroy,
    reclaim,
    identityResolverFor,
    ...createWorkerMachineCatalog(options),
    providerFor,
    reconcileRecord,
    inspectTurnLease: (request: Parameters<typeof inspectTurnLease>[0]) =>
      retained.inspectForTurn(request, inspectTurnLease),
    pauseRetained: (request: Parameters<typeof retained.pauseCurrent>[0]) =>
      options.withLock(request.environmentId, () => retained.pauseCurrent(request)),
    resumeNode: runtimeRefresher.resumeCurrentNode,
    refreshInitialRuntime: runtimeRefresher.refreshInitialRuntime,
    readRuntimeRefresh: runtimeRefresher.read,
  };
}
