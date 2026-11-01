import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import { dispatchGatewayMethodInProcessRaw } from "../gateway/server-plugins.js";
import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";

/** Error envelope returned by in-process Gateway method dispatch. */
export type GatewayMethodDispatchError = NonNullable<GatewayMethodDispatchResponse["error"]>;

/** Response envelope returned to plugins after dispatching a Gateway method. */
export type GatewayMethodDispatchResponse = SchemaContract<
  Awaited<ReturnType<typeof dispatchGatewayMethodInProcessRaw>>
>;

/** Dispatch controls for plugin-initiated Gateway method calls. */
export type GatewayMethodDispatchOptions = {
  /** Wait for the Gateway's final response instead of returning the first response frame. */
  expectFinal?: boolean;
  /** Maximum time to wait for Gateway dispatch before the runtime reports a timeout. */
  timeoutMs?: number;
};

/**
 * Dispatch a Gateway control-plane method from an authenticated plugin request scope.
 */
export async function dispatchGatewayMethod(
  /** Gateway method name, validated by the Gateway method router. */
  method: string,
  /** Method-specific params forwarded without SDK-side normalization. */
  params?: unknown,
  /** Dispatch behavior controls for response timing and timeout handling. */
  options?: GatewayMethodDispatchOptions,
): Promise<GatewayMethodDispatchResponse> {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (scope?.gatewayMethodDispatchAllowed !== true) {
    // Gateway methods can mutate/control local runtime state; require the
    // authenticated request scope recorded by the plugin loader contract.
    const pluginLabel = scope?.pluginId ? ` for plugin "${scope.pluginId}"` : "";
    throw new Error(
      `Gateway method dispatch is reserved for authenticated plugin HTTP routes or RPC handlers that declare contracts.gatewayMethodDispatch: ["authenticated-request"]${pluginLabel}.`,
    );
  }
  return await dispatchGatewayMethodInProcessRaw(method, params, {
    disableSyntheticClient: true,
    requireScopedClient: true,
    ...(scope.signal ? { signal: scope.signal } : {}),
    ...(scope.hasCurrentClientAuthority
      ? { hasCurrentClientAuthority: scope.hasCurrentClientAuthority }
      : {}),
    ...(options?.expectFinal !== undefined ? { expectFinal: options.expectFinal } : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

/** Capture the host's direct-local authenticated system RPC provenance, never caller metadata. */
export function capturePrivateGatewayRequestAuthority(): () => void {
  const invocation = pluginInstanceInvocation.getStore();
  const scope = getPluginRuntimeGatewayRequestScope();
  const client = scope?.client;
  const context = scope?.context;
  const assertCurrent = () => {
    scope?.signal?.throwIfAborted();
    invocation?.instance.lifecycle.signal.throwIfAborted();
    if (
      !invocation ||
      !pluginInstanceInvocation.run(invocation, () => invocation.instance.hasActiveCall) ||
      !scope ||
      !context ||
      !client ||
      scope.hasCurrentClientAuthority?.() === false ||
      client.invalidated ||
      client.connectionSignal?.aborted ||
      client.internal?.isLocalClient !== true ||
      client.internal.authenticatedOperator !== true ||
      client.internal.operatorRoleActor?.kind !== "system" ||
      client.connect.role !== "operator" ||
      !client.connect.scopes?.includes("operator.admin") ||
      !client.connId ||
      context.isConnectionActive?.(client.connId) === false
    ) {
      throw new Error("Private Gateway RPC authority is unavailable");
    }
  };
  assertCurrent();
  return assertCurrent;
}
