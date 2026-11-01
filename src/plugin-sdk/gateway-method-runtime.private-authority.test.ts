import { expect, it } from "vitest";
import { createDirectChatContext } from "../gateway/server-chat.agent-events.test-helpers.js";
import type { GatewayClient } from "../gateway/server-methods/client-types.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { capturePrivateGatewayRequestAuthority } from "./gateway-method-runtime.js";

function fixture() {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "repository-policy",
    source: "synthetic-policy",
    origin: "workspace",
    enabled: true,
    configSchema: false,
  });
  builder.registry.plugins.push(record);
  builder.createApi(record, { config: {} });
  const client: GatewayClient = {
    connId: "private-connection",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "cli", version: "test", platform: "test", mode: "cli" },
      role: "operator",
      scopes: ["operator.admin"],
    },
    internal: {
      isLocalClient: true,
      authenticatedOperator: true,
      operatorRoleActor: { kind: "system" },
    },
  };
  let current = true;
  const scope = {
    client,
    context: createDirectChatContext({ isConnectionActive: () => current }),
    isWebchatConnect: () => false,
    hasCurrentClientAuthority: () => current,
  };
  return {
    client,
    scope,
    retire: () => {
      current = false;
    },
    instance: getPluginInstance(record)!,
  };
}
it("private authority is exact-call bound even when its authenticated connection remains live", async () => {
  const f = fixture();
  const retained = await f.instance.run(async () =>
    withPluginRuntimeGatewayRequestScope(f.scope, () => {
      const assertCurrent = capturePrivateGatewayRequestAuthority();
      assertCurrent();
      return assertCurrent;
    }),
  );
  expect(() => retained()).toThrow("unavailable");
  await f.instance.dispose();
});
it.each(["public-proxy", "person-admin", "untrusted", "disconnected"])(
  "denies %s redemption at host provenance boundary",
  async (scenario) => {
    const f = fixture();
    if (scenario === "public-proxy") {
      delete f.client.internal!.isLocalClient;
    }
    if (scenario === "person-admin") {
      f.client.internal!.operatorRoleActor = { kind: "operator", profileId: "person" };
    }
    if (scenario === "untrusted") {
      delete f.client.internal!.authenticatedOperator;
    }
    if (scenario === "disconnected") {
      f.retire();
    }
    await f.instance.run(async () =>
      withPluginRuntimeGatewayRequestScope(f.scope, () => {
        expect(() => capturePrivateGatewayRequestAuthority()).toThrow("unavailable");
      }),
    );
    await f.instance.dispose();
  },
);
