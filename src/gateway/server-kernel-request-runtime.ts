import { AsyncLocalStorage } from "node:async_hooks";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/io.js";
import { setDatabaseEngineReadOnlyAdmission } from "../infra/database-engine/context.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getGatewaySuspendStatus } from "../infra/gateway-suspend-coordinator.js";
import { retireQuestionChannelGateway } from "../infra/question-channel-runtime.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { bindLegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import {
  runWithGatewayIndependentRootWorkAdmission,
  clearGatewayRollingAdmission,
  getGatewayRollingAdmission,
} from "../process/gateway-work-admission.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { closeGatewayDeviceRevocation } from "./device-revocation.js";
import { shouldUseGatewayOwnerProfile } from "./gateway-owner-profile.js";
import {
  isCoreGatewayRollingRead,
  listCoreGatewayMethodNames,
} from "./methods/core-method-policy.js";
import { readGatewayRollingCompatibility } from "./rolling-release-compatibility.js";
import { runOrDeferGatewayMutableStartup } from "./rolling-startup.js";
import { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import type { startGatewayCoreRuntime } from "./server-core-runtime.js";
import { attachInitialGatewayLifetimeSidecars } from "./server-lifetime-sidecars.js";
import { readPreparedServerMethodModelCatalogs } from "./server-methods/optional-model-catalog.js";
import type { GatewayHostLifecycle } from "./server-public.js";

type GatewayCoreRuntime = Awaited<ReturnType<typeof startGatewayCoreRuntime>>;
type GatewayLogger = ReturnType<typeof createSubsystemLogger>;

/** Prepares request bindings and the one-shot initializer shared by startup and transports. */
export async function prepareGatewayKernelRequestRuntime(params: {
  coreRuntime: GatewayCoreRuntime;
  log: GatewayLogger;
  logHealth: GatewayLogger;
  hostLifecycle?: GatewayHostLifecycle;
}) {
  const { coreRuntime: runtime, log, logHealth } = params;
  const {
    minimalTestGateway,
    runtimeState,
    bindApprovalPublicationContext,
    startupTrace,
    workerPlacementRuntime,
    githubPublicationRuntime,
    pluginGatewayContext,
    getAttachedGatewayMethodRegistry,
    gatewayInstanceRuntimeRef,
    startupState,
    shutdownRuntime,
  } = runtime;
  // Candidate reads open only after their observational startup is published.
  if (runtime.opts.rollingStartup) {
    for (const method of listCoreGatewayMethodNames()) {
      if (isCoreGatewayRollingRead(method)) {
        runtime.unavailableGatewayMethods.add(method);
      }
    }
  }
  const [chatMetadataLifecycle, configRevisionProjector] = await Promise.all([
    startupTrace.measure("gateway.chat-metadata-lifecycle", () =>
      createGatewayChatMetadataLifecycle({
        getConfig: getRuntimeConfig,
        log,
        getPluginMetadataSnapshot: runtime.getPluginMetadataSnapshot,
      }),
    ),
    startupTrace.measure("gateway.config-revision-key", async () => {
      const { loadGatewayConfigRevisionProjector } = await import("./config-revision-token.js");
      return loadGatewayConfigRevisionProjector({ env: process.env });
    }),
  ]);
  const gatewayRequestContext = await startupTrace.measure("gateway.request-context", async () => {
    const { createGatewayRequestContext } = await import("./server-request-context.js");
    return createGatewayRequestContext({
      runtime,
      configRevisionProjector,
      chatMetadataLifecycle,
      log,
      logHealth,
    });
  });
  let yieldedReleaseId: string | undefined;
  gatewayRequestContext.yieldRollingExecution = async (contract) => {
    const owner = runtime.opts.gatewayStateOwner;
    if (
      !owner?.yieldExecutionForRollingHandoff ||
      runtime.bootId !== contract.predecessorBootId ||
      getGatewayRollingAdmission()?.releaseId !== contract.releaseId
    ) {
      throw new Error("Gateway rolling execution handoff does not name this prepared owner");
    }
    const actual = await readGatewayRollingCompatibility(getRuntimeConfig());
    if (actual.compatibilityDigest !== contract.compatibilityDigest) {
      throw new Error("Gateway rolling compatibility changed before execution yield");
    }
    await owner.yieldExecutionForRollingHandoff(contract);
    yieldedReleaseId = contract.releaseId;
  };
  gatewayRequestContext.getPendingRollingReleaseId = () =>
    runtime.opts.rollingStartup && !runtime.opts.rollingStartup.writableReady
      ? runtime.opts.rollingStartup.releaseId
      : yieldedReleaseId;
  if (runtime.opts.rollingStartup) {
    gatewayRequestContext.isRollingReadReady = () => runtime.opts.rollingStartup!.readReady;
  }
  gatewayRequestContext.observeRollingExecution = async () => {
    const owner = runtime.opts.gatewayStateOwner;
    if (!getGatewayRollingAdmission() || !owner?.observeRollingExecutionHandoff) {
      throw new Error("Gateway has no observable rolling execution handoff");
    }
    return owner.observeRollingExecutionHandoff();
  };
  gatewayRequestContext.rebindRollingExecution = async (
    suspensionId,
    previous,
    candidateBootId,
    expectedOwner,
    assertCallerCurrent,
  ) => {
    const owner = runtime.opts.gatewayStateOwner;
    if (!owner?.rebindRollingExecutionHandoff || runtime.bootId !== previous.predecessorBootId) {
      throw new Error("Gateway rebind does not name this physical predecessor");
    }
    assertCallerCurrent();
    const actual = await readGatewayRollingCompatibility(getRuntimeConfig());
    assertCallerCurrent();
    const suspension = getGatewaySuspendStatus(suspensionId, true);
    if (
      actual.compatibilityDigest !== previous.compatibilityDigest ||
      getGatewayRollingAdmission()?.releaseId !== previous.releaseId ||
      suspension.status !== "ready" ||
      suspension.executionYielded !== true
    ) {
      throw new Error("Gateway is no longer the matching held read-only predecessor");
    }
    return owner.rebindRollingExecutionHandoff(previous, candidateBootId, expectedOwner);
  };
  gatewayRequestContext.resumeRollingExecution = async () => {
    const rolling = getGatewayRollingAdmission();
    const owner = runtime.opts.gatewayStateOwner;
    if (!rolling || !owner?.restoreExecutionAfterRollingHandoff) {
      throw new Error("Gateway rolling execution owner is unavailable");
    }
    await owner.restoreExecutionAfterRollingHandoff();
    gatewayRequestContext.reopenRollingAdmission?.();
  };
  gatewayRequestContext.reopenRollingAdmission = () => {
    const rolling = getGatewayRollingAdmission();
    if (!rolling) {
      return;
    }
    const owner = runtime.opts.gatewayStateOwner;
    if (!owner?.assertExecutionCurrent) {
      throw new Error("Gateway rolling writer custody is unavailable");
    }
    setDatabaseEngineReadOnlyAdmission(false, () => owner.assertExecutionCurrent!());
    clearGatewayRollingAdmission(rolling.releaseId);
    yieldedReleaseId = undefined;
  };
  gatewayRequestContext.readRollingCompatibility = async () => {
    const actual = await readGatewayRollingCompatibility(getRuntimeConfig());
    const lease = await executeExistingOpenClawStateRead(
      {},
      { type: "gatewayOwnerLease.read", schemaMaintenance: false },
    );
    const executionOwner = lease?.lease?.owner;
    if (!executionOwner) {
      throw new Error("Gateway execution ownership is unavailable");
    }
    return { ...actual, bootId: runtime.bootId, executionOwner };
  };
  const projectionReady = runtime.opts.updateCanary
    ? undefined
    : startupTrace.measure("sessions.projection", async () => {
        const { createSessionRowProjection } = await import("./session-row-projection.js");
        return createSessionRowProjection({
          cfg: getRuntimeConfig(),
          getConfig: getRuntimeConfig,
          getPolicyConfig: gatewayRequestContext.getCommittedRuntimeConfig ?? getRuntimeConfig,
          getModelCatalog: () =>
            readPreparedServerMethodModelCatalogs(
              gatewayRequestContext,
              listAgentIds(getRuntimeConfig()),
            ),
          context: gatewayRequestContext,
          placementFactsReader: runtime.workerEnvironmentStartup?.placementStore,
        });
      });
  // Startup and teardown retain this work even if transport setup fails first.
  void projectionReady?.catch(() => {});
  let requestRuntimeReady: Promise<void> | undefined;
  const projectionLifetime: { closing: boolean; detach?: () => void } = { closing: false };
  runtime.registerGatewayLifetimeSidecars({
    name: "request-runtime",
    stop: async () => {
      projectionLifetime.closing = true;
      // Received mutations and their finalizers join before lifetime sidecars stop.
      // Retire this exact context too when no request ever bound its coordinator.
      retireQuestionChannelGateway(runtime.connectionWork.signal);
      closeGatewayDeviceRevocation(gatewayRequestContext);
      await gatewayRequestContext.scopeUpgradeCoordinator?.close();
      const projection = await projectionReady?.catch(() => undefined);
      await shutdownRuntime.flushPendingSessionsChangedEvents(gatewayRequestContext);
      if (projection) {
        await shutdownRuntime.drainSessionEventPublications(projection);
      }
      projectionLifetime.detach?.();
      projection?.dispose();
    },
  });
  // An early request may initialize this while other listeners bind; keep startup ownership.
  const initializeRequestRuntime = AsyncLocalStorage.bind(async () => {
    const projection = await projectionReady;
    if (projectionLifetime.closing) {
      throw new Error("Gateway closed during session projection startup");
    }
    if (projection) {
      projectionLifetime.detach = runtime.attachSessionRowProjection(projection);
      if (
        shouldUseGatewayOwnerProfile({
          role: "operator",
          authMethod: runtime.getResolvedAuth().mode,
          rolesConfigured: Boolean(getRuntimeConfig().gateway?.roles),
        })
      ) {
        await runOrDeferGatewayMutableStartup(runtime.opts.rollingStartup, async () => {
          try {
            await startupTrace.measure("gateway.owner-profile", async () => {
              const [{ ensureCanonicalGatewayOwnerProfile }, { resolveHostAccountName }] =
                await Promise.all([
                  import("../state/user-profile-writes.js"),
                  import("../infra/host-account-name.js"),
                ]);
              // Projection owns the admitted catalog; first connect consumes its committed owner.
              await ensureCanonicalGatewayOwnerProfile(resolveHostAccountName);
            });
          } catch (error) {
            log.warn(`Gateway owner profile preparation failed: ${formatErrorMessage(error)}`);
          }
        });
      }
      // The initial roster must be usable before reconnecting clients can issue lists.
      // Load-bearing: exact preparations outrank the bulk drain, so an un-awaited drain can
      // stay incomplete under traffic and every read re-prepares rows (#184368, reverted).
      await startupTrace.measure("sessions.materialize", () => projection.ensureMaterialized());
      if (projectionLifetime.closing) {
        throw new Error("Gateway closed during session projection startup");
      }
      // Facts are ready, but display rows remain lazy. Warm the recent page while sidecars start.
      void runtime.connectionWork
        .track(() =>
          runWithGatewayIndependentRootWorkAdmission(
            async () => {
              const { listProjectedSessions } = await import("./session-utils-list.js");
              runtime.connectionWork.signal.throwIfAborted();
              await startupTrace.measure("sessions.first-page", () =>
                listProjectedSessions({
                  projection,
                  opts: { limit: 100, archived: false, rowMode: "sidebar" },
                  acceptsSerializedJson: true,
                }),
              );
            },
            "startup:session-row-prewarm",
            runtime.connectionWork.signal,
          ),
        )
        .catch((error: unknown) => {
          if (!runtime.connectionWork.signal.aborted) {
            log.warn(`Session first-page preparation failed: ${formatErrorMessage(error)}`);
          }
        });
    }
    if (!runtime.opts.updateCanary) {
      await runOrDeferGatewayMutableStartup(runtime.opts.rollingStartup, () =>
        startupTrace.measure("gateway.lifetime-sidecars", () =>
          attachInitialGatewayLifetimeSidecars({
            scheduler: runtime.scheduler,
            chatMetadataLifecycle,
            gatewayRequestContext,
            flushPendingSessionsChangedEvents: shutdownRuntime.flushPendingSessionsChangedEvents,
            minimalTestGateway,
            logWarning: (message) => log.warn(message),
            ...(!workerPlacementRuntime && githubPublicationRuntime
              ? { reconcileGitHubPublications: githubPublicationRuntime.reconcilePublications }
              : {}),
            publishSidecars: runtimeState.gatewayLifetimeSidecars.publish,
          }),
        ),
      );
    }
  });
  const ensureRequestRuntimeReady = () => (requestRuntimeReady ??= initializeRequestRuntime());
  gatewayRequestContext.requestEntryLifetime = runtime.requestEntryLifetime;
  bindApprovalPublicationContext(gatewayRequestContext);
  pluginGatewayContext.current = gatewayRequestContext;
  gatewayRequestContext.dispatchHookAgentTurn = async (pluginId, hookParams) => {
    const transport = runtime.transportBridge.current();
    if (!transport) {
      throw new Error("Gateway listener must start before plugin hook dispatch");
    }
    return await transport.dispatchHookAgentTurn(pluginId, hookParams);
  };
  const { createGatewayInstanceRuntime } = await startupTrace.measure(
    "gateway.instance-runtime-import",
    () => import("./server-instance-runtime.js"),
  );
  const gatewayInstanceRuntime = createGatewayInstanceRuntime({
    getContext: () => gatewayRequestContext,
    getMethodRegistry: () => getAttachedGatewayMethodRegistry(),
    // Request entry fences new calls during the prelude. Retained principals
    // stay current until run shutdown records recovery and cancels execution.
    isDispatchAvailable: () => startupState.dispatchReady,
    logError: (message) => log.error(message),
  });
  gatewayInstanceRuntimeRef.current = gatewayInstanceRuntime;
  gatewayRequestContext.resolveGatewayContext = () =>
    gatewayInstanceRuntime.isAvailable() ? gatewayRequestContext : undefined;
  bindLegacyPluginSdkResourceHost(
    gatewayRequestContext.resolveGatewayContext,
    runtime.sdkResourceHost,
  );
  // Detached RPC replies retain this availability fence after the request ends.
  // Shutdown must still recognize them as work owned by this exact Gateway.
  bindGatewayContextResolver(
    gatewayRequestContext.resolveGatewayContext,
    runtime.resolvePluginGatewayContext,
  );
  const hostLifecycle = params.hostLifecycle;
  if (hostLifecycle) {
    gatewayRequestContext.hostLifecycle = {
      externalRestart: hostLifecycle.externalRestart,
      getShutdownBudget: () => hostLifecycle.getShutdownBudget?.(),
      request: (action, assertCaller) =>
        hostLifecycle.request(action, () => {
          // Host control creates new effects; retained reply principals can remain
          // current during recovery marking without admitting host start/stop.
          if (
            runtime.requestEntryLifetime.signal.aborted ||
            !gatewayInstanceRuntime.isAvailable()
          ) {
            throw new Error(
              "Gateway lifecycle is unavailable for this closed instance. Reconnect and retry.",
            );
          }
          assertCaller();
        }),
    };
  }
  gatewayRequestContext.approvalEvents = gatewayInstanceRuntime.approvalEvents;
  gatewayRequestContext.lifecycleRuntime = gatewayInstanceRuntime.lifecycle;
  bindGatewayContextResolver(
    gatewayInstanceRuntime.lifecycle,
    gatewayRequestContext.resolveGatewayContext,
  );
  gatewayRequestContext.createAgentTurnFacade = gatewayInstanceRuntime.createAgentTurnFacade;
  return {
    ...runtime,
    chatMetadataLifecycle,
    gatewayRequestContext,
    gatewayInstanceRuntime,
    ensureRequestRuntimeReady,
  };
}

export type GatewayKernelRuntime = Awaited<ReturnType<typeof prepareGatewayKernelRequestRuntime>>;
