import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { bindAgentToolSourceExecutionGuard } from "../../agents/agent-tool-source-execution-guard.js";
import { rewrapToolWithBeforeToolCallHook } from "../../agents/agent-tools.before-tool-call.wrapper.js";
import { runWithToolExecutionValidation } from "../../agents/agent-tools.execution-validation.js";
import { getBeforeToolCallHookContext } from "../../agents/before-tool-call-metadata.js";
import { runAgentHarnessAfterToolCallHook } from "../../agents/harness/hook-helpers.js";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import type { buildSubagentExecutionSessionSpawnContext } from "../../agents/subagents/spawn/subagent-spawn-execution-identity.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
  withAgentToolGatewayRuntimeIdentity,
} from "../../agents/tools/in-process-gateway.js";
import { SessionPortalToolSchema } from "../../agents/tools/portal-tool-contract.js";
import { runWithScopedSessionAccess } from "../../agents/tools/scoped-session-access.js";
import {
  PlacedSessionsSpawnSchema,
  PlacedSessionsSendSchema,
} from "../../agents/tools/sessions-placement-tool-contract.js";
import { getRuntimeConfig } from "../../config/config.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { repositoryDispatchCredentialReader } from "../repository-dispatch.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import type { WorkerSessionPlacementStore, WorkerSessionTurnClaim } from "./placement-store.js";
import {
  getWorkerTurnExecutionIdentityCapability,
  type WorkerTurnExecutionIdentity,
  type WorkerTurnExecutionIdentityCapability,
} from "./placement-turn-claim-events.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementDispatchContract,
} from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import {
  workerSessionToolErrorResult as errorResult,
  type WorkerSessionToolRequest,
} from "./worker-session-tool-result.js";
import {
  assertWorkerSessionToolChild,
  readWorkerSessionToolEntry,
  type WorkerSessionToolSource as ExactSource,
  type WorkerSessionToolTarget,
} from "./worker-session-tool-topology.js";

export function prepareWorkerSessionToolRequest(
  binding: Pick<WorkerSessionToolRequest, "identity" | "signal" | "onUpdate">,
  toolName: string,
  toolCallId: string,
  raw: unknown,
): WorkerSessionToolRequest | undefined {
  if (toolName === "sessions_spawn" && Value.Check(PlacedSessionsSpawnSchema, raw)) {
    return { ...binding, toolName, request: { ...raw, toolCallId } };
  }
  if (toolName === "sessions_send" && Value.Check(PlacedSessionsSendSchema, raw)) {
    return { ...binding, toolName, request: { ...raw, toolCallId } };
  }
  if (toolName === "portal" && Value.Check(SessionPortalToolSchema, raw)) {
    if (
      (raw.title?.length ?? 0) > 256 ||
      (raw.description?.length ?? 0) > 8 * 1024 ||
      (raw.path?.length ?? 0) > 1024 ||
      (raw.id?.length ?? 0) > 256
    ) {
      return undefined;
    }
    return { ...binding, toolName, request: { ...raw, toolCallId } };
  }
  return undefined;
}

export type WorkerSessionToolAuthority = {
  assertSource: () => void;
  collectExecutionIdentity: boolean;
  callGateway: <T = Record<string, unknown>>(
    request: Parameters<AgentToolGatewayRequestCaller>[0],
    sessionSpawnContext?: ReturnType<typeof buildSubagentExecutionSessionSpawnContext>,
  ) => Promise<T>;
};

export function prepareWorkerSessionChildDispatch(params: {
  identity: Pick<WorkerPlacementDispatchRequest, "sessionId" | "sessionKey" | "agentId">;
  sourceEnvironment: Pick<WorkerEnvironmentRecord, "profileId" | "providerId" | "profileSnapshot">;
  repositoryBacked: boolean;
  assertSource: () => void;
}): WorkerPlacementDispatchRequest {
  const { identity, sourceEnvironment, repositoryBacked, assertSource } = params;
  const dispatch: WorkerPlacementDispatchRequest = {
    ...identity,
    profileId: sourceEnvironment.profileId,
    executionMode: "worker-turn",
    inheritedProfile: {
      providerId: sourceEnvironment.providerId,
      profileSnapshot: sourceEnvironment.profileSnapshot,
    },
  };
  const operatorAuthority = getGatewayToolCallerIdentity()?.operatorAuthority;
  if (repositoryBacked && operatorAuthority) {
    dispatch.readNativeCredential = repositoryDispatchCredentialReader({
      ...identity,
      client: null,
      operatorAuthority,
      requestDigest: sha256Hex(JSON.stringify(dispatch)),
      assertCurrent: assertSource,
    });
  }
  return dispatch;
}

export type WorkerSessionChildDispatchDependencies = {
  placements: WorkerSessionPlacementStore;
  environments: Pick<WorkerEnvironmentService, "get">;
  dispatchChild: WorkerPlacementDispatchContract["dispatch"];
};

export async function prepareWorkerSessionChildForSend(
  params: WorkerSessionChildDispatchDependencies & {
    source: Pick<ExactSource, "agentId" | "sessionId" | "sessionKey">;
    target: WorkerSessionToolTarget;
    identity: WorkerConnectionIdentity;
    assertSource: () => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { source, target, identity, placements, environments, assertSource } = params;
  const placement = await placements.getAsync(target.sessionId);
  assertSource();
  if (
    placement?.state !== "failed" ||
    placement.environmentId !== null ||
    placement.activeOwnerEpoch !== null
  ) {
    return;
  }
  const child = await readWorkerSessionToolEntry(target.sessionKey, target.agentId);
  assertSource();
  if (
    !child.entry?.repositoryWorkspaceId ||
    (child.entry.parentSessionKey ?? child.entry.spawnedBy) !== source.sessionKey
  ) {
    return;
  }
  const assertChild = () =>
    assertWorkerSessionToolChild({
      childSessionKey: target.sessionKey,
      childSessionId: target.sessionId,
      sourceSessionKey: source.sessionKey,
      sourceSessionId: source.sessionId,
      targetAgentId: target.agentId,
      storePath: target.storePath,
    });
  await assertChild();
  const parent = environments.get(identity.environmentId);
  if (
    parent?.state !== "attached" ||
    parent.ownerEpoch !== identity.ownerEpoch ||
    parent.attachedSessionIds.length !== 1 ||
    parent.attachedSessionIds[0] !== source.sessionId
  ) {
    throw new Error("Worker source environment changed before child recovery");
  }
  await params.dispatchChild(
    prepareWorkerSessionChildDispatch({
      identity: {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        sessionId: target.sessionId,
      },
      sourceEnvironment: parent,
      repositoryBacked: true,
      assertSource,
    }),
    undefined,
    assertSource,
    params.signal,
  );
  assertSource();
  await assertChild();
}

/** Construction and invocation share the same admitted worker caller. */
export function withWorkerCaller<T>(
  capability: WorkerTurnExecutionIdentityCapability,
  params: {
    resolveGatewayContext: GatewayContextResolver;
    assertCurrent?: () => void;
    signal?: AbortSignal;
  },
  run: (owner: WorkerTurnExecutionIdentity) => T | Promise<T>,
): Promise<T> {
  // The owner rechecks its receiptAuthority before and after the awaited callback.
  return capability.run((owner) =>
    withGatewayToolCallerIdentity(
      {
        ...owner,
        gatewayContextResolver: params.resolveGatewayContext,
        approvalAuthority: owner.delegatedAuthority,
        receiptAuthority: params.assertCurrent ?? owner.receiptAuthority,
        workerTurnClaim: owner.turnClaim,
        workerTurnExecutionIdentityCapability: capability,
        ...(params.signal ? { approvalSignals: [params.signal] } : {}),
      },
      () => run(owner),
    ),
  );
}

export function createWorkerSessionToolSourceRunner(params: {
  resolveGatewayContext: GatewayContextResolver;
  placements: WorkerSessionPlacementStore;
}) {
  return async (operation: {
    source: Pick<ExactSource, "agentId" | "sessionId" | "sessionKey"> & {
      turnClaim: WorkerSessionTurnClaim;
    };
    request: Pick<WorkerSessionToolRequest, "identity" | "signal" | "onUpdate"> & {
      toolName: string;
      tool: AnyAgentTool | ((authority: WorkerSessionToolAuthority) => AnyAgentTool);
      approvalMode?: "deny";
      request: { toolCallId: string; arguments: unknown };
    };
  }): Promise<AgentToolResult<unknown>> => {
    const startArgs = operation.request.request.arguments;
    if (!isRecord(startArgs)) {
      throw new Error("Worker tool arguments must be an object");
    }
    const capability = getWorkerTurnExecutionIdentityCapability(
      params.placements,
      operation.source.turnClaim,
    );
    if (!capability) {
      throw new Error("Worker source turn has no operational owner");
    }
    const assertToolCurrent = composeSessionSourceAssertion(
      [capability.receiptAuthority],
      (assertSource) => {
        assertSource();
        operation.request.signal?.throwIfAborted();
        if (
          !params.placements.isWorkerTurnToolAuthorized(
            operation.source.turnClaim,
            operation.request.toolName,
          )
        ) {
          throw new Error("Worker tool authority changed");
        }
      },
    );
    return await runWithScopedSessionAccess({
      cfg: getRuntimeConfig(),
      agentId: operation.source.agentId,
      storePath: capability.sessionTarget.storePath,
      expectedSessionId: operation.source.sessionId,
      targetSessionKey: operation.source.sessionKey,
      ...(operation.request.signal ? { signal: operation.request.signal } : {}),
      run: () =>
        withWorkerCaller(
          capability,
          {
            resolveGatewayContext: params.resolveGatewayContext,
            assertCurrent: assertToolCurrent,
            signal: operation.request.signal,
          },
          async (owner) => {
            const assertSource = composeSessionSourceAssertion(
              [assertToolCurrent],
              (assertCurrent) => {
                assertCurrent();
                const source = operation.source;
                if (source.agentId !== owner.agentId || source.sessionKey !== owner.sessionKey) {
                  throw new Error("Worker source turn owner changed");
                }
              },
            );
            const callGateway = async <R = Record<string, unknown>>(
              request: Parameters<AgentToolGatewayRequestCaller>[0],
              sessionSpawnContext?: ReturnType<typeof buildSubagentExecutionSessionSpawnContext>,
            ): Promise<R> => {
              assertSource();
              return await capability.run(() =>
                callAgentToolGatewayRequest<R>(
                  withAgentToolGatewayRuntimeIdentity(
                    {
                      ...request,
                      ...(operation.request.signal ? { signal: operation.request.signal } : {}),
                    },
                    {
                      kind: "agentRuntime",
                      agentId: owner.agentId,
                      sessionKey: owner.sessionKey,
                      operationalRunInstance: owner.operationalRunInstance,
                      delegatedAuthority: {
                        kind: "worker",
                        ...owner.delegatedAuthority,
                        turnClaim: owner.turnClaim,
                      },
                      executionIdentity: owner.executionIdentityToken,
                      sessionSpawnContext,
                    },
                  ),
                ),
              );
            };
            assertSource();
            const startedAt = Date.now();
            const request = operation.request;
            let result: AgentToolResult<unknown> | undefined;
            let errorMessage: string | undefined;
            try {
              const sourceTool =
                typeof request.tool === "function"
                  ? request.tool({
                      assertSource,
                      callGateway,
                      collectExecutionIdentity: owner.executionIdentityToken !== undefined,
                    })
                  : request.tool;
              const tool = rewrapToolWithBeforeToolCallHook(
                bindAgentToolSourceExecutionGuard(sourceTool, assertSource),
                getBeforeToolCallHookContext(sourceTool) ?? {
                  ...operation.source,
                  config: getRuntimeConfig(),
                  runId: request.identity.runId ?? undefined,
                },
                request.approvalMode ? { approvalMode: request.approvalMode } : {},
              );
              result = await runWithToolExecutionValidation(
                request.request.toolCallId,
                (args) => {
                  // Bound adapters validate and narrow rewrites at their protocol owner.
                  if (typeof request.tool !== "function" && !Value.Check(tool.parameters, args)) {
                    throw new Error(`Invalid ${request.toolName} arguments`);
                  }
                },
                () =>
                  tool.execute(
                    request.request.toolCallId,
                    request.request.arguments,
                    request.signal,
                    request.onUpdate,
                  ),
              );
              assertSource();
              return result;
            } catch (error) {
              errorMessage = errorResult(error).details.error;
              throw error;
            } finally {
              void runAgentHarnessAfterToolCallHook({
                toolName: request.toolName,
                toolCallId: request.request.toolCallId,
                runId: request.identity.runId ?? undefined,
                agentId: owner.agentId,
                sessionKey: owner.sessionKey,
                sessionId: operation.source.sessionId,
                startArgs,
                result,
                error: errorMessage,
                startedAt,
              });
            }
          },
        ),
    });
  };
}
