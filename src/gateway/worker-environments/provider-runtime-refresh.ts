import { compareOpenClawReleaseVersions } from "../../infra/npm-registry-spec.js";
import type { WorkerProvider, WorkerNodeRuntimePreparation } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../../version.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import { DEFAULT_BOOTSTRAP_TIMEOUT_MS, NODE_ENROLLMENT_TIMEOUT_MS } from "./bootstrap-timeouts.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import { DEFAULT_NODE_TOOLCHAIN_SETUP_SH } from "./node-toolchain.js";
import type {
  WorkerSessionPlacementGate,
  WorkerInitialDispatchBinding,
} from "./placement-worker-gate.js";
import { readWorkerPreparation } from "./preparation-identity.schema.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import { requireWorkerProfile } from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export type WorkerRuntimeRefreshInFlight = {
  /** Settles after the refresh finishes or fails; never rejects. */
  readonly settled: Promise<void>;
  /** Observe real install progress until the returned function unsubscribes. */
  onProgress(listener: () => void): () => void;
};

export class WorkerRuntimeRefreshPendingError extends Error {
  readonly code = "invalid_state";

  constructor(detail: string) {
    super(
      `Cloud worker runtime update is pending; recovery will retry when the worker is available: ${detail}`,
    );
  }
}

type WorkerRuntimeRefreshOptions = Pick<
  WorkerProviderLifecycleOptions,
  | "store"
  | "withLock"
  | "callBootstrap"
  | "isStopping"
  | "placementStore"
  | "ensureNodeWorkerBundle"
  | "bootstrapWorker"
  | "credentialBroker"
  | "callProvider"
  | "prepareInstallation"
  | "prepareNodeRuntime"
  | "closeNodeRuntime"
> &
  Pick<
    ReturnType<typeof createWorkerProviderOwnerLifecycle>,
    "requireCurrentOwner" | "stopOwner" | "identityResolverFor"
  > & { providerFor: (providerId: string) => WorkerProvider };

export function createWorkerRuntimeRefresher(options: WorkerRuntimeRefreshOptions) {
  const { store, callBootstrap, requireCurrentOwner, stopOwner, identityResolverFor } = options;
  const { ensurePendingCredential } = options.credentialBroker;
  const inFlight = new Map<string, WorkerRuntimeRefreshInFlight>();
  const refresh = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    installation: WorkerInstallationArtifact | undefined,
    signal?: AbortSignal,
    initial?: { dispatch: WorkerInitialDispatchBinding; assertCurrent: () => void },
  ) => {
    if (
      !installation ||
      (record.bootstrapReceipt && sameWorkerBuild(record.bootstrapReceipt, installation))
    ) {
      return;
    }
    if (
      (record.state !== "attached" && record.state !== "ready" && record.state !== "idle") ||
      !record.bootstrapReceipt ||
      !record.leaseId
    ) {
      throw serviceError("invalid_state", "Worker runtime refresh requires an admitted lease");
    }
    const settled = createDeferredCore();
    const listeners = new Set<() => void>();
    const fact: WorkerRuntimeRefreshInFlight = {
      settled: settled.promise,
      onProgress: (listener) => registerListener(listeners, listener),
    };
    const reportProgress = () => notifyListeners(listeners, undefined);
    inFlight.set(record.environmentId, fact);
    try {
      const sessionId = record.state === "attached" ? record.attachedSessionIds[0] : undefined;
      let placementAuthority:
        | Awaited<ReturnType<WorkerSessionPlacementGate["prepareWorkerRuntimeRefresh"]>>
        | undefined;
      if (record.state === "attached") {
        if (!sessionId || !options.placementStore) {
          throw serviceError("invalid_state", "Worker runtime refresh requires its placement");
        }
        placementAuthority = await options.placementStore.prepareWorkerRuntimeRefresh({
          sessionId,
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
          ...(record.retention ? { idleOnly: true as const } : {}),
          ...(initial ? { initialDispatch: initial.dispatch } : {}),
        });
      }
      const assertCurrent = () => {
        signal?.throwIfAborted();
        initial?.assertCurrent();
        const current = requireCurrentOwner(record);
        if (options.isStopping() || current.destroyRequestedAtMs !== null) {
          throw serviceError("invalid_state", "Worker runtime refresh owner is stopping");
        }
        placementAuthority?.assertCurrent();
      };
      try {
        // Stop the old process and revoke its credential, but retain the epoch: it also owns
        // the node workspace directory. A new turn gets a new claim and credential below.
        await stopOwner(record, undefined, { assertCurrent });
        const receipt = await callBootstrap(installation, async (timeoutSignal) => {
          const refreshSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
          assertCurrent();
          if (record.nodeDeviceId) {
            if (installation.install !== "bundle" || !options.ensureNodeWorkerBundle) {
              throw new Error("Worker node bundle installer is unavailable");
            }
            return options.ensureNodeWorkerBundle({
              reason: "refresh",
              environmentId: record.environmentId,
              deviceId: record.nodeDeviceId,
              artifact: installation,
              prewarm: record.profileSnapshot.executionMode !== "remote-exec",
              signal: refreshSignal,
              assertCurrent,
              onProgress: reportProgress,
            });
          }
          if (!record.sshEndpoint) {
            throw new Error("Worker runtime refresh has no transport");
          }
          return options.bootstrapWorker({
            operationId: record.provisionOperationId,
            sshEndpoint: record.sshEndpoint,
            installation,
            resolveIdentity: identityResolverFor(record, provider, record.leaseId!),
            signal: refreshSignal,
            assertCurrent,
          });
        });
        if (!sameWorkerBuild(receipt, installation)) {
          throw new Error("Worker runtime refresh returned a mismatched build receipt");
        }
        const refreshed = await store.refreshBootstrapReceipt({
          environmentId: record.environmentId,
          ...(record.state === "attached"
            ? {
                expectedState: record.state,
                expectedPlacementGeneration: placementAuthority!.generation,
                ...(initial ? { initialDispatch: initial.dispatch } : {}),
                expectedReclaimResult: placementAuthority!.reclaimResult,
              }
            : { expectedState: record.state }),
          expectedOwnerEpoch: record.ownerEpoch,
          expectedNodeDeviceId: record.nodeDeviceId,
          expectedBootstrapReceipt: record.bootstrapReceipt,
          bootstrapReceipt: { ...receipt, installKind: "bundle" },
          assertCurrent,
        });
        await ensurePendingCredential(refreshed, sessionId ?? null);
      } finally {
        placementAuthority?.release();
      }
    } finally {
      inFlight.delete(record.environmentId);
      settled.resolve();
    }
  };
  const resumeNode = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    request: {
      signal: AbortSignal;
      assertCurrent: () => void;
      initialDispatch?: WorkerInitialDispatchBinding;
      nodeBuildId?: string;
      placementState?: "active" | "draining";
    },
  ): Promise<{ retainedCleanupOnly: true } | void> => {
    const resume = provider.resumeNode;
    const { leaseId, nodeDeviceId } = record;
    if (!resume || record.sharedHost !== false || !nodeDeviceId) {
      return;
    }
    const preparation = readWorkerPreparation(record.profileSnapshot);
    // Capture provenance is immutable. Loaded host build metadata selects recovery,
    // including same-version updates and reconnects, without granting execution.
    const releaseOrder =
      preparation && compareOpenClawReleaseVersions(preparation.artifacts.openclawVersion, VERSION);
    const currentBuildId = resolveRuntimeServiceBuildId();
    const currentRuntimeRequired =
      !preparation ||
      (releaseOrder ?? 0) < 0 ||
      (releaseOrder === 0 &&
        (request.initialDispatch !== undefined || request.placementState === "active") &&
        preparation.target.platform === "linux" &&
        currentBuildId !== null &&
        request.nodeBuildId !== currentBuildId);
    if (!record.bootstrapReceipt || !leaseId) {
      throw serviceError(
        "invalid_state",
        "Worker node recovery requires its retained runtime identity",
      );
    }
    const sessionId = record.attachedSessionIds[0];
    if (
      record.state !== "attached" ||
      record.attachedSessionIds.length !== 1 ||
      !sessionId ||
      !options.placementStore
    ) {
      throw serviceError("invalid_state", "Worker node recovery requires its exclusive placement");
    }
    const authority = await options.placementStore.prepareWorkerRuntimeRefresh({
      sessionId,
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      ...(currentRuntimeRequired ? { idleOnly: true as const } : {}),
      ...(record.retention && !request.initialDispatch
        ? { allowRetainedCleanup: true as const }
        : {}),
      ...(request.initialDispatch ? { initialDispatch: request.initialDispatch } : {}),
    });
    const assertCurrent = () => {
      request.signal.throwIfAborted();
      request.assertCurrent();
      authority.assertCurrent();
      const current = requireCurrentOwner(record);
      if (
        options.isStopping() ||
        current.state !== "attached" ||
        current.destroyRequestedAtMs !== null ||
        current.leaseId !== record.leaseId
      ) {
        throw serviceError("invalid_state", "Worker node recovery owner changed");
      }
    };
    let runtime: WorkerNodeRuntimePreparation | undefined;
    try {
      assertCurrent();
      if (currentRuntimeRequired && !authority.retainedCleanupOnly) {
        if (!options.prepareNodeRuntime) {
          throw serviceError(
            "invalid_state",
            "Current Node runtime preparation owner is unavailable",
          );
        }
        const bundle = await options.prepareInstallation("bundle", request.signal);
        assertCurrent();
        if (bundle.install !== "bundle") {
          throw new Error("Worker node recovery requires a bundle artifact");
        }
        runtime = await options.prepareNodeRuntime!(record, bundle, request.signal, assertCurrent);
        assertCurrent();
      }
      await options.callProvider(
        record.environmentId,
        "resume-node",
        () =>
          resume({
            leaseId,
            profile: requireWorkerProfile(record.profileSnapshot.settings),
            deviceId: nodeDeviceId,
            ...(authority.retainedCleanupOnly
              ? { retainedRuntimeOnly: true as const }
              : {
                  nodeBootstrapSha256:
                    runtime?.nodeBootstrap.sha256 ?? preparation!.artifacts.nodeBootstrapSha256,
                  openclawVersion:
                    runtime?.nodeBootstrap.openclawVersion ??
                    preparation!.artifacts.openclawVersion,
                  ...(runtime ? { runtime } : {}),
                  linuxToolchainSetup: DEFAULT_NODE_TOOLCHAIN_SETUP_SH,
                }),
            signal: request.signal,
            assertCurrent,
          }),
        // A retained host may need the current Node prerequisite before reconnect.
        DEFAULT_BOOTSTRAP_TIMEOUT_MS + NODE_ENROLLMENT_TIMEOUT_MS,
      );
      assertCurrent();
      if (authority.retainedCleanupOnly) {
        return { retainedCleanupOnly: true };
      }
    } finally {
      try {
        if (runtime) {
          options.closeNodeRuntime?.(runtime);
        }
      } finally {
        authority.release();
      }
    }
  };
  return {
    refresh,
    refreshInitialRuntime: async (request: {
      environmentId: string;
      ownerEpoch: number;
      initialDispatch: WorkerInitialDispatchBinding;
      signal: AbortSignal;
      assertCurrent: () => void;
    }) =>
      options.withLock(request.environmentId, async () => {
        await store.ready();
        request.assertCurrent();
        const record = store.get(request.environmentId);
        if (
          !record ||
          record.state !== "attached" ||
          record.lastActivatedAtMs !== null ||
          record.sharedHost !== false ||
          record.ownerEpoch !== request.ownerEpoch ||
          record.leaseId !== request.initialDispatch.leaseId ||
          record.nodeDeviceId !== request.initialDispatch.nodeDeviceId
        ) {
          throw serviceError(
            "invalid_state",
            "Initial worker runtime refresh lost its retained owner",
          );
        }
        const installation = await options.prepareInstallation("bundle", request.signal);
        request.assertCurrent();
        await refresh(
          record,
          options.providerFor(record.providerId),
          installation,
          request.signal,
          {
            dispatch: request.initialDispatch,
            assertCurrent: request.assertCurrent,
          },
        );
      }),
    resumeCurrentNode: async (request: {
      environmentId: string;
      ownerEpoch: number;
      leaseId: string;
      signal: AbortSignal;
      assertCurrent: () => void;
      initialDispatch?: WorkerInitialDispatchBinding;
      nodeBuildId?: string;
      placementState?: "active" | "draining";
    }) =>
      options.withLock(request.environmentId, async () => {
        await store.ready();
        request.assertCurrent();
        const record = store.get(request.environmentId);
        if (
          !record ||
          record.ownerEpoch !== request.ownerEpoch ||
          record.leaseId !== request.leaseId
        ) {
          throw serviceError("invalid_state", "Worker node recovery lease changed");
        }
        return await resumeNode(record, options.providerFor(record.providerId), request);
      }),
    read: (environmentId: string) => inFlight.get(environmentId),
  };
}
