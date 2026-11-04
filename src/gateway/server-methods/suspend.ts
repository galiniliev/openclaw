// Gateway RPC handlers for cooperative, host-neutral process suspension.
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateGatewaySuspendPrepareParams,
  validateGatewaySuspendResumeParams,
  validateGatewaySuspendStatusParams,
  validateGatewaySuspendHandoffParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  setDatabaseEngineReadOnlyAdmission,
  getDatabaseEngineSelection,
} from "../../infra/database-engine/context.js";
import { isPostgresCompanionSelection } from "../../infra/database-engine/registry.js";
import {
  armGatewaySuspendHandoff,
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resumeGatewaySuspend,
  holdGatewaySuspendExecutionYield,
} from "../../infra/gateway-suspend-coordinator.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getActiveGatewayRootWorkCount,
  setGatewayRollingAdmission,
  getGatewayRollingAdmission,
} from "../../process/gateway-work-admission.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import { createGatewayServerActiveWorkInspectors } from "../server-active-work.js";
import { respondError } from "./response.js";
import type { GatewayRequestContext } from "./shared-types.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";

const suspendLog = createSubsystemLogger("gateway/suspension");

function callerDescription(client: GatewayClient | null) {
  return JSON.stringify({ client: client?.connect.client.id, connection: client?.connId });
}

function invalidParams(method: string) {
  return errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method} params`);
}

function respondSuspendStatus(
  result: ReturnType<typeof prepareGatewaySuspend> | ReturnType<typeof getGatewaySuspendStatus>,
  context: GatewayRequestContext,
  respond: RespondFn,
  conflictMessage: string,
) {
  if (result.status === "conflict") {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, conflictMessage, {
        retryable: true,
        retryAfterMs: Math.max(0, result.expiresAtMs - Date.now()),
        details: { reason: "gateway-suspension-conflict", expiresAtMs: result.expiresAtMs },
      }),
    );
  } else {
    if (result.status === "draining") {
      context.logGateway.info(
        `DRAINING activeCount=${result.activeCount} blockers=${result.blockers.map(({ kind, count }) => `${kind}:${count}`).join(",")} holders=${JSON.stringify(result.blockers.map(({ message }) => message))} custody=${result.writeCustody?.some(({ count }) => count > 0) ? "held" : "clear"}`,
      );
    }
    respond(true, result);
  }
}

export const suspendHandlers: GatewayRequestHandlers = {
  "gateway.suspend.handoff": async ({
    respond,
    params,
    context,
    client,
    hasCurrentClientAuthority,
  }) => {
    if (!validateGatewaySuspendHandoffParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.handoff"));
      return;
    }
    if (
      params.target.pid !== process.pid ||
      params.target.processInstanceId !== getGatewayProcessInstanceId()
    ) {
      respondError(respond, ErrorCodes.UNAVAILABLE, "gateway process changed after preflight");
      return;
    }
    const executionActions =
      Number(Boolean(params.yieldExecution)) +
      Number(Boolean(params.rebindExecution)) +
      Number(Boolean(params.inspectExecution));
    if (executionActions > 1 || (executionActions > 0 && params.commit)) {
      respond(false, undefined, invalidParams("gateway.suspend.handoff"));
      return;
    }
    if (params.inspectExecution || params.rebindExecution) {
      const held = getGatewaySuspendStatus(params.suspensionId, true);
      if (
        (held.status !== "ready" && held.status !== "draining") ||
        held.executionYielded !== true ||
        (held.status === "draining" && (params.rebindExecution || held.phase !== "draining")) ||
        !context.observeRollingExecution ||
        !hasCurrentClientAuthority?.() ||
        (params.rebindExecution && !context.rebindRollingExecution)
      ) {
        respondError(
          respond,
          ErrorCodes.UNAVAILABLE,
          "Matching held execution handoff is unavailable",
        );
        return;
      }
      if (params.rebindExecution) {
        const { previous, candidateBootId, expectedOwner } = params.rebindExecution;
        await context.rebindRollingExecution!(
          params.suspensionId,
          previous,
          candidateBootId,
          expectedOwner,
          () => {
            if (!hasCurrentClientAuthority?.()) {
              throw new Error("Gateway recovery caller is no longer current");
            }
          },
        );
      }
      const execution = await context.observeRollingExecution();
      if (!hasCurrentClientAuthority?.()) {
        respondError(
          respond,
          ErrorCodes.UNAVAILABLE,
          "Gateway recovery caller is no longer current",
        );
        return;
      }
      respond(true, {
        status: params.rebindExecution ? "execution-rebound" : "execution-observed",
        suspensionId: params.suspensionId,
        expiresAtMs: execution.contract.expiresAtMs,
        execution,
      });
      return;
    }
    if (params.yieldExecution) {
      if (
        params.commit ||
        !context.yieldRollingExecution ||
        getGatewayRollingAdmission()?.releaseId !== params.yieldExecution.releaseId
      ) {
        respondError(
          respond,
          ErrorCodes.UNAVAILABLE,
          "Gateway rolling execution handoff is not prepared",
        );
        return;
      }
      holdGatewaySuspendExecutionYield(params.suspensionId);
      await context.yieldRollingExecution(params.yieldExecution);
      respond(true, {
        status: "execution-yielded",
        suspensionId: params.suspensionId,
        expiresAtMs: params.yieldExecution.expiresAtMs,
      });
      return;
    }
    const owner = context.hostLifecycle?.externalRestart;
    if (!owner) {
      respondError(respond, ErrorCodes.UNAVAILABLE, "gateway host does not own process exit");
      return;
    }
    const result = armGatewaySuspendHandoff({
      suspensionId: params.suspensionId.trim(),
      owner,
      commit: params.commit,
    });
    if (!result.ok) {
      respondError(respond, ErrorCodes.UNAVAILABLE, result.error);
      return;
    }
    suspendLog.info(
      `gateway.suspend.handoff leaseId=${JSON.stringify(params.suspensionId)} caller=${callerDescription(client)} result=${result.value.status}`,
    );
    respond(true, result.value);
  },
  "gateway.suspend.prepare": async ({ respond, params, context, client }) => {
    if (!validateGatewaySuspendPrepareParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.prepare"));
      return;
    }
    const requestId = params.requestId.trim();
    if (params.rollingReleaseId && !isPostgresCompanionSelection(getDatabaseEngineSelection())) {
      respondError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        "Rolling preparation requires PostgreSQL for every portable store",
      );
      return;
    }
    if (
      params.rollingReleaseId &&
      (params.drain || params.terminalPolicy === "terminate" || !context.yieldRollingExecution)
    ) {
      respondError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        "Rolling preparation requires preservation-first quiescent admission",
      );
      return;
    }
    if (params.rollingReleaseId) {
      const incompatible = context.getClientConnIds?.(
        (connected) =>
          connected.connect.role === "operator" &&
          !hasGatewayClientCap(
            connected.connect.caps,
            GATEWAY_CLIENT_CAPS.PLANNED_HANDOFF_RETENTION_V1,
          ),
      );
      // Inventory and quiescent entry below are synchronous. A reconnect after
      // entry rechecks this same capability immediately before registration.
      if (!incompatible || incompatible.size > 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Upgrade connected clients before rolling release", {
            retryable: false,
            details: {
              reason: "gateway-rolling-client-upgrade-required",
              requiredCapability: GATEWAY_CLIENT_CAPS.PLANNED_HANDOFF_RETENTION_V1,
              incompatibleConnectionCount: incompatible?.size,
            },
          }),
        );
        return;
      }
    }
    const inspect = createGatewayServerActiveWorkInspectors(context);
    const result = prepareGatewaySuspend({
      requestId,
      rollingReleaseId: params.rollingReleaseId,
      caller: `gateway.suspend.prepare ${callerDescription(client)}`,
      terminalPolicy: params.terminalPolicy ?? "preserve",
      ...(params.drain === true ? { drain: true } : {}),
      pauseScheduling: () => context.cron.pauseScheduling(),
      resumeScheduling: () => {
        if (params.rollingReleaseId) {
          context.reopenRollingAdmission?.();
        }
        context.cron.resumeScheduling();
      },
      inspect: params.rollingReleaseId
        ? {
            ...inspect,
            getRootRequests: () =>
              getActiveGatewayRootWorkCount({ excludeCurrent: true, mutableOnly: true }),
          }
        : inspect,
      warn: (message) => context.logGateway.warn(message),
    });
    if (params.rollingReleaseId && result.status === "ready") {
      setGatewayRollingAdmission(params.rollingReleaseId, true);
      setDatabaseEngineReadOnlyAdmission(true);
    }
    respondSuspendStatus(
      result,
      context,
      respond,
      "another gateway suspension is already prepared",
    );
  },
  "gateway.suspend.status": async ({ respond, params, context }) => {
    if (!validateGatewaySuspendStatusParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.status"));
      return;
    }
    const suspensionId = params.suspensionId.trim();
    // Polling reports custody; only the handoff owner decides whether it can stop.
    const result = getGatewaySuspendStatus(suspensionId, params.includeLifecycle === true);
    respondSuspendStatus(result, context, respond, "a different gateway suspension is prepared");
  },
  "gateway.suspend.resume": async ({ respond, params, client, context }) => {
    if (!validateGatewaySuspendResumeParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.resume"));
      return;
    }
    const suspensionId = params.suspensionId.trim();
    if (getGatewayRollingAdmission()) {
      if (getGatewaySuspendStatus(suspensionId).status !== "ready") {
        respondError(respond, ErrorCodes.UNAVAILABLE, "Gateway rolling suspension does not match");
        return;
      }
      await context.resumeRollingExecution?.();
    }
    const result = resumeGatewaySuspend(suspensionId);
    if (!result.ok) {
      if (result.reason === "gateway-restarting") {
        respondError(respond, ErrorCodes.UNAVAILABLE, "gateway shutdown is committed");
        return;
      }
      respondError(respond, ErrorCodes.INVALID_REQUEST, "gateway suspension id does not match");
      return;
    }
    suspendLog.info(
      `gateway.suspend.resume leaseId=${JSON.stringify(suspensionId)} caller=${callerDescription(client)} resumed=${result.resumed}`,
    );
    respond(true, result);
  },
};
