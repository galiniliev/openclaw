import type { Server as HttpServer } from "node:http";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import type { WebSocketServer } from "ws";
import { disposeAcpSessionManager } from "../acp/control-plane/manager.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-tools.js";
import { disposeRegisteredAgentHarnesses } from "../agents/harness/registry.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import { fenceSessionSuspensionWritesForGatewayShutdown } from "../agents/session-suspension.js";
import { closeSwarmScheduler } from "../agents/subagents/swarm/swarm-scheduler.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { closeSessionTranscriptReconcileWorkerPool } from "../config/sessions/session-transcript-reconcile-pool.js";
import { drainCronReceiptAuthority } from "../cron/store/receipt-authority-owner.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { closePluginStateDatabaseAsync } from "../plugin-state/plugin-state-store.js";
import type { GatewayPluginMetadataOwner } from "../plugins/plugin-metadata-lifecycle.js";
import { hasRetainedPluginRuntimeCloseError } from "../plugins/runtime-close-error.js";
import type { createPluginRegistryOwner } from "../plugins/runtime.js";
import { getCanonicalGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { finalizeActiveDebugProxyCaptures } from "../proxy-capture/runtime-cleanup.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { settlesWithin } from "../shared/settle-within.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { collectGatewayProcessMemoryUsageMb, recordGatewayRestartTrace } from "./restart-trace.js";
import type { ChatRunState } from "./server-chat-state.js";
import { createCloseStepTimer, shutdownStep } from "./server-close-step.js";
import { closeGatewayTransports } from "./server-close-transports.js";
import type { GatewayMaintenanceHandles } from "./server-maintenance-lifecycle.js";
import {
  waitForMediaCleanupDrainsToSettle,
  type MediaCleanupStopResult,
} from "./server-media-cleanup-lifecycle.js";
import type { GatewayCloseOptions } from "./server-public.js";
import { prepareGatewayRunShutdown, type GatewayRunShutdownParams } from "./server-run-shutdown.js";
import {
  recordGatewayShutdownWarning as recordShutdownWarning,
  resolveGatewayShutdownNotice,
} from "./server-shutdown.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");
const GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS = 5_000;
const GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS = 10_000;
const ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;
const MCP_RUNTIME_CLOSE_GRACE_MS = 5_000;
const LSP_RUNTIME_CLOSE_GRACE_MS = 5_000;
const EMBEDDING_PROVIDER_CLOSE_GRACE_MS = 5_000;
const AGENT_HARNESS_CLOSE_GRACE_MS = 5_000;
type ShutdownResult = {
  durationMs: number;
  warnings: string[];
  processWritersRetired: boolean;
};

async function triggerGatewayLifecycleHookWithTimeout(params: {
  cleanupWork: AsyncWorkScope;
  event: ReturnType<typeof createInternalHookEvent>;
  hookName: "gateway:shutdown" | "gateway:pre-restart";
  timeoutMs: number;
}): Promise<"completed" | "timeout"> {
  const hookPromise = params.cleanupWork.track(() => triggerInternalHook(params.event));
  void hookPromise.catch(() => undefined);
  if (await settlesWithin(hookPromise, params.timeoutMs)) {
    return "completed";
  }
  shutdownLog.warn(
    `${params.hookName} hook timed out after ${params.timeoutMs}ms; continuing shutdown`,
  );
  return "timeout";
}

async function disposeRuntimeWithShutdownGrace(params: {
  cleanupWork: AsyncWorkScope;
  label:
    | "plugin-services"
    | "agent-harnesses"
    | "bundle-mcp"
    | "bundle-lsp"
    | "embedding-providers";
  dispose: () => Promise<void>;
  graceMs: number;
  warnings: string[];
}): Promise<void> {
  const disposePromise = params.cleanupWork
    .track(() => Promise.resolve().then(params.dispose))
    .catch((err: unknown) => {
      shutdownLog.warn(`${params.label} runtime disposal failed during shutdown: ${String(err)}`);
      recordShutdownWarning(params.warnings, params.label);
    });
  if (!(await settlesWithin(disposePromise, params.graceMs))) {
    shutdownLog.warn(
      `${params.label} runtime disposal exceeded ${params.graceMs}ms; continuing shutdown`,
    );
    recordShutdownWarning(params.warnings, params.label);
  }
}

export async function runGatewayClosePrelude(params: {
  stopDiagnostics?: () => void;
  skillsChangeUnsub?: () => void | Promise<void>;
  disposeAuthRateLimiter?: () => void;
  disposeBrowserAuthRateLimiter: () => void;
  stopChannelHealthMonitor?: () => Promise<void>;
  stopReadinessEventLoopHealth?: () => void;
  closeMcpServer?: () => Promise<void>;
}): Promise<void> {
  params.stopDiagnostics?.();
  await params.skillsChangeUnsub?.();
  params.disposeAuthRateLimiter?.();
  params.disposeBrowserAuthRateLimiter();
  await params.stopChannelHealthMonitor?.();
  params.stopReadinessEventLoopHealth?.();
  await params.closeMcpServer?.().catch(() => {});
}

export type GatewayCloseParams = {
  resolveGatewayContext: GatewayRunShutdownParams["resolveGatewayContext"];
  closePluginRegistry: ReturnType<typeof createPluginRegistryOwner>["close"];
  pluginMetadata: Pick<GatewayPluginMetadataOwner, "beginClose" | "close">;
  bonjourStop: (() => Promise<void>) | null;
  tailscaleCleanup: (() => Promise<void>) | null;
  clearSecretsRuntimeSnapshot?: (() => void) | null;
  channelIds?: readonly ChannelId[];
  stopChannel: (name: ChannelId, accountId?: string) => Promise<void>;
  pluginServices: PluginServicesHandle | null;
  disposeAllBundleLspRuntimes: () => Promise<void>;
  drainRetainedOpenAiEmbeddingProviders: () => Promise<void>;
  stopGmailWatcher: () => Promise<void>;
  disposeAllCodeModeRuns: () => Promise<void> | void;
  closeProviderTransportDispatcherPool: () => Promise<void>;
  cron: { stop: () => void; stopAndDrain?: () => Promise<void> };
  stopCronMaintenance?: () => Promise<void>;
  heartbeatRunner: HeartbeatRunner;
  maintenance: GatewayMaintenanceHandles | null;
  stopMediaCleanup: () => Promise<MediaCleanupStopResult>;
  agentUnsub: (() => Promise<void> | void) | null;
  heartbeatUnsub: (() => void) | null;
  transcriptUnsub: (() => void) | null;
  lifecycleUnsub: (() => void) | null;
  clients: Set<{
    connect?: { role?: string };
    connectionKind?: "gateway" | "worker";
    socket: { close: (code: number, reason: string) => void };
  }>;
  finishRequestEntries?: () => Promise<void>;
  drainSdkWork?: () => Promise<void>;
  stopScheduler: () => Promise<void>;
  closeSdkResources?: () => Promise<void>;
  wss?: WebSocketServer;
  httpServer?: HttpServer;
  httpServers?: HttpServer[];
  drainActiveSessionsForShutdown?: (params: {
    reason: "shutdown" | "restart";
    totalTimeoutMs?: number;
  }) => Promise<{ emittedSessionIds: string[]; timedOut: boolean }>;
  chatRunState: ChatRunState;
};

export type GatewayClosePrepareParams = GatewayRunShutdownParams & {
  updateCheckStop?: (() => Promise<void> | void) | null;
  configReloader: { stop: () => Promise<void> };
  getPendingReplyCount: () => number;
};

export type GatewayClosePreparation = {
  start: number;
  notice: ReturnType<typeof resolveGatewayShutdownNotice>;
  warnings: string[];
  cleanupWork: AsyncWorkScope;
  retainReaderTransport?: true;
};

export async function prepareGatewayClose(
  params: GatewayClosePrepareParams,
  opts?: GatewayCloseOptions,
): Promise<GatewayClosePreparation> {
  const start = Date.now();
  const warnings: string[] = [];
  const notice = resolveGatewayShutdownNotice(opts);
  const { reason } = notice;
  const restartExpectedMs = notice.restartExpectedMs ?? null;
  const measureCloseStep = createCloseStepTimer(reason);
  const cleanupWork = new AsyncWorkScope();
  // Fence async session-state writes before the first awaited shutdown step.
  fenceSessionSuspensionWritesForGatewayShutdown();
  // Debug-level: the signal handler already announced the stop/restart at
  // info, and the completion line below reports duration and outcome.
  shutdownLog.debug(`shutdown started: ${reason}`);

  const triggerLifecycleHook = (action: "shutdown" | "pre-restart", timeoutMs: number) => {
    const hookName = `gateway:${action}` as const;
    return measureCloseStep(`gateway-${action}-hook`, () =>
      shutdownStep(
        hookName,
        async () => {
          const result = await triggerGatewayLifecycleHookWithTimeout({
            cleanupWork,
            event: createInternalHookEvent("gateway", action, hookName, {
              reason,
              restartExpectedMs,
            }),
            hookName,
            timeoutMs,
          });
          if (result === "timeout") {
            recordShutdownWarning(warnings, hookName);
          }
        },
        warnings,
      ),
    );
  };

  try {
    await shutdownStep("update-check", () => params.updateCheckStop?.(), warnings);
    await measureCloseStep("config-reloader", () =>
      shutdownStep("config-reloader", () => params.configReloader.stop(), warnings),
    );
    await triggerLifecycleHook("shutdown", GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS);
    if (restartExpectedMs !== null) {
      await triggerLifecycleHook("pre-restart", GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS);
    }
    const drainTimeoutMs =
      typeof opts?.drainTimeoutMs === "number" && Number.isFinite(opts.drainTimeoutMs)
        ? Math.max(0, Math.floor(opts.drainTimeoutMs))
        : 0;
    await measureCloseStep("reply-drain", () =>
      prepareGatewayRunShutdown({
        ...params,
        restart: restartExpectedMs !== null,
        timeoutMs: drainTimeoutMs,
        warnings,
      }),
    );
    return {
      start,
      notice,
      warnings,
      cleanupWork,
      ...(opts?.retainReaderTransport ? { retainReaderTransport: true as const } : {}),
    };
  } catch (error) {
    await cleanupWork.drain();
    throw error;
  }
}

export function completeGatewayClose(
  params: GatewayCloseParams,
  preparation: GatewayClosePreparation,
): Promise<ShutdownResult> {
  // Cleanup belongs to shutdown, not the initiating RPC's drained connection scope.
  return preparation.cleanupWork.run(async () => {
    try {
      return await closeGatewayResources(params, preparation);
    } finally {
      await preparation.cleanupWork.drain();
    }
  });
}

async function closeGatewayResources(
  params: GatewayCloseParams,
  preparation: GatewayClosePreparation,
): Promise<ShutdownResult> {
  await params.pluginMetadata.beginClose();
  const { start, notice, warnings, cleanupWork } = preparation;
  const { reason } = notice;
  const restartExpectedMs = notice.restartExpectedMs ?? null;
  let pluginServicesCleanup: Promise<void> | undefined;
  let mediaCleanupStopResult: MediaCleanupStopResult | undefined;
  const resourceCleanupErrors: unknown[] = [];
  const recordResourceCleanupFailure = (error: unknown) => {
    if (hasRetainedPluginRuntimeCloseError(error)) {
      throw error;
    }
    resourceCleanupErrors.push(error);
  };
  let closeFailure: { error: unknown } | undefined;
  let processWritersRetired = false;
  const measureCloseStep = createCloseStepTimer(reason);
  try {
    if (params.drainActiveSessionsForShutdown) {
      await measureCloseStep("session-end-drain", () =>
        shutdownStep(
          "session-end-drain",
          async () => {
            const drainReason: "shutdown" | "restart" =
              restartExpectedMs !== null ? "restart" : "shutdown";
            const result = await params.drainActiveSessionsForShutdown!({
              reason: drainReason,
              totalTimeoutMs: ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS,
            });
            if (result.timedOut) {
              shutdownLog.warn(
                `session-end-drain timed out after ${ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS}ms after ${result.emittedSessionIds.length} sessions; continuing shutdown`,
              );
              recordShutdownWarning(warnings, "session-end-drain");
            }
          },
          warnings,
        ),
      );
    }
    if (params.bonjourStop) {
      await shutdownStep("bonjour", () => params.bonjourStop!(), warnings);
    }
    // ACPX owns agent-process cleanup, so plugin teardown must not overtake
    // the manager drain even when cancellation and handle close are slow.
    await measureCloseStep("acp-session-manager", () =>
      shutdownStep(
        "acp-session-manager",
        () => disposeAcpSessionManager("gateway-shutdown"),
        warnings,
      ),
    );
    if (params.pluginServices) {
      const cleanup = cleanupWork.track(() =>
        Promise.resolve().then(async () => {
          const result = await params.pluginServices!.stop();
          if (result?.errors.length) {
            recordShutdownWarning(warnings, "plugin-services");
          }
        }),
      );
      pluginServicesCleanup = cleanup;
      await measureCloseStep("plugin-services", () =>
        // A stalled plugin must not prevent later runtime and child-process cleanup.
        disposeRuntimeWithShutdownGrace({
          cleanupWork,
          label: "plugin-services",
          dispose: () => cleanup,
          graceMs: MCP_RUNTIME_CLOSE_GRACE_MS,
          warnings,
        }),
      );
    }
    await measureCloseStep("channels", async () => {
      const channelIds = params.channelIds ?? listChannelPlugins().map((plugin) => plugin.id);
      for (const channelId of channelIds) {
        await shutdownStep(`channel/${channelId}`, () => params.stopChannel(channelId), warnings);
      }
    });
    await shutdownStep("code-mode-runs", () => params.disposeAllCodeModeRuns(), warnings);
    await disposeRuntimeWithShutdownGrace({
      cleanupWork,
      label: "agent-harnesses",
      dispose: disposeRegisteredAgentHarnesses,
      graceMs: AGENT_HARNESS_CLOSE_GRACE_MS,
      warnings,
    });
    await shutdownStep("ai-session-resources", () => cleanupSessionResources(), warnings);
    await shutdownStep(
      "provider-transport-dispatchers",
      () => params.closeProviderTransportDispatcherPool(),
      warnings,
    );
    await measureCloseStep("bundle-runtimes", async () => {
      await Promise.all([
        disposeRuntimeWithShutdownGrace({
          cleanupWork,
          label: "bundle-mcp",
          dispose: disposeAllSessionMcpRuntimes,
          graceMs: MCP_RUNTIME_CLOSE_GRACE_MS,
          warnings,
        }),
        disposeRuntimeWithShutdownGrace({
          cleanupWork,
          label: "bundle-lsp",
          dispose: params.disposeAllBundleLspRuntimes,
          graceMs: LSP_RUNTIME_CLOSE_GRACE_MS,
          warnings,
        }),
      ]);
    });
    await shutdownStep(
      "periodic-maintenance",
      () => params.maintenance?.stopPeriodicTasks(),
      warnings,
    );
    await shutdownStep("skill-usage", () => params.maintenance?.skillUsageCleanup(), warnings);
    try {
      mediaCleanupStopResult = await params.stopMediaCleanup();
    } catch (err) {
      shutdownLog.warn(`media-cleanup: ${err instanceof Error ? err.message : String(err)}`);
      recordShutdownWarning(warnings, "media-cleanup");
    }
    if (mediaCleanupStopResult !== "drained") {
      // Timed-out cleanup still owns shared SQLite. Keep the process store open
      // so late completion cannot resume against a database torn down by shutdown.
      recordShutdownWarning(warnings, "media-cleanup");
    }
    await measureCloseStep("gmail-watcher", () =>
      shutdownStep("gmail-watcher", () => params.stopGmailWatcher(), warnings),
    );
    // Cron heartbeat runs await this owner's queued wakes after handing off cancellation.
    // Settle those waiters before joining cron so shutdown cannot wait on its own next step.
    await shutdownStep("heartbeat-runner", () => params.heartbeatRunner.stop(), warnings);
    await shutdownStep(
      "cron",
      () => (params.cron.stopAndDrain ? params.cron.stopAndDrain() : params.cron.stop()),
      warnings,
    );
    await shutdownStep("cron-maintenance", () => params.stopCronMaintenance?.(), warnings);
    await shutdownStep("cron-receipt-authority", () => drainCronReceiptAuthority(), warnings);
    if (params.agentUnsub) {
      await shutdownStep("agent-unsub", () => params.agentUnsub!(), warnings);
    }
    if (params.heartbeatUnsub) {
      await shutdownStep("heartbeat-unsub", () => params.heartbeatUnsub!(), warnings);
    }
    if (params.transcriptUnsub) {
      await shutdownStep("transcript-unsub", () => params.transcriptUnsub!(), warnings);
    }
    if (params.lifecycleUnsub) {
      await shutdownStep("lifecycle-unsub", () => params.lifecycleUnsub!(), warnings);
    }
    params.chatRunState.clear();
    await closeGatewayTransports(params, {
      reason,
      warnings,
      retainReaderTransport: preparation.retainReaderTransport,
    });
    await disposeRuntimeWithShutdownGrace({
      cleanupWork,
      label: "embedding-providers",
      dispose: params.drainRetainedOpenAiEmbeddingProviders,
      graceMs: EMBEDDING_PROVIDER_CLOSE_GRACE_MS,
      warnings,
    });
  } catch (error) {
    closeFailure = { error };
  } finally {
    // Grace lets independent teardown advance; raw cleanup and its descendants
    // still join before registry and shared-state retirement.
    await cleanupWork.runWhenIdle(() => {});
    await pluginServicesCleanup;
    await params.finishRequestEntries?.();
    await waitForMediaCleanupDrainsToSettle();
    // Drain before metadata elects the final Gateway that owns model retirement.
    await params.drainSdkWork?.();
    const swarmOwner = getCanonicalGatewayContextResolver(params.resolveGatewayContext);
    if (swarmOwner) {
      await closeSwarmScheduler(swarmOwner).catch(recordResourceCleanupFailure);
    }
    // Owner cleanup releases scheduled work; join it before retiring shared dependencies.
    await params.stopScheduler();
    // A sibling Gateway retains metadata before its registry exists. Only the
    // final owner may retire shared state and process-wide plugin caches.
    try {
      const registryClose = await params.closePluginRegistry(async (retireRegistry) => {
        // SDK cleanup can use prepared donors; release its claims before model or registry disposal.
        await params.closeSdkResources?.().catch(recordResourceCleanupFailure);
        return params.pluginMetadata.close(async (retire) => {
          await closeSwarmScheduler().catch(recordResourceCleanupFailure);
          await closePreparedModelRuntimeSnapshots();
          await closeSessionTranscriptReconcileWorkerPool();
          await retire();
          await cleanupWork.runWhenIdle(() => {});
          // Releasing agent leases still writes shared state; keep its owner alive until then.
          await closeOpenClawAgentDatabasesAsync();
          await finalizeActiveDebugProxyCaptures().catch(recordResourceCleanupFailure);
          if (mediaCleanupStopResult !== undefined) {
            await closePluginStateDatabaseAsync();
          }
          try {
            await drainGlobalSingletonLifecycleState(
              restartExpectedMs === null ? "close" : "restart",
            );
          } finally {
            try {
              params.clearSecretsRuntimeSnapshot?.();
            } catch {
              /* ignore */
            }
          }
          processWritersRetired = true;
        }, retireRegistry);
      });
      for (const error of registryClose.memoryErrors) {
        shutdownLog.warn(`memory-managers: ${formatErrorMessage(error)}`);
        recordShutdownWarning(warnings, "memory-managers");
      }
      for (const { pluginId, hookId, error } of registryClose.pluginFailures) {
        recordShutdownWarning(warnings, `plugin/${pluginId}`);
        resourceCleanupErrors.push(
          new Error(`Plugin ${pluginId} cleanup failed (${hookId}): ${formatErrorMessage(error)}`, {
            cause: error,
          }),
        );
      }
    } catch (error) {
      resourceCleanupErrors.push(error);
    }
  }
  const durationMs = Date.now() - start;
  if (resourceCleanupErrors.length > 0 || closeFailure) {
    shutdownLog.warn(
      `shutdown failed in ${durationMs}ms${warnings.length ? `: ${warnings.join(", ")}` : ""}`,
    );
  } else if (warnings.length > 0) {
    shutdownLog.warn(`shutdown completed in ${durationMs}ms with warnings: ${warnings.join(", ")}`);
  } else {
    shutdownLog.info(`shutdown completed cleanly in ${durationMs}ms`);
  }

  recordGatewayRestartTrace("restart.close.total", durationMs, [
    ["reason", reason],
    ["restartExpectedMs", restartExpectedMs ?? "none"],
    ...collectGatewayProcessMemoryUsageMb(),
  ]);
  if (resourceCleanupErrors.length === 1) {
    throw resourceCleanupErrors[0];
  }
  if (resourceCleanupErrors.length > 1) {
    throw new AggregateError(resourceCleanupErrors, "Gateway resource cleanup failed", {
      cause: resourceCleanupErrors[0],
    });
  }
  if (closeFailure) {
    throw closeFailure.error;
  }
  if (preparation.retainReaderTransport && warnings.length > 0) {
    throw new Error(`Native reader writer retirement is incomplete: ${warnings.join(", ")}`);
  }
  if (preparation.retainReaderTransport && !processWritersRetired) {
    throw new Error("Native reader retirement still has another process runtime owner");
  }
  return { durationMs, warnings, processWritersRetired };
}
