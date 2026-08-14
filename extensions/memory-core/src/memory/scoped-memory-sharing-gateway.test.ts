import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../../../src/plugins/registry-empty.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../../src/plugins/runtime.js";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptor,
} from "../../../../src/gateway/methods/registry.js";
import { handleGatewayRequest } from "../../../../src/gateway/server-methods.js";
import { registerScopedMemorySharingGatewayMethods } from "./scoped-memory-sharing-gateway.js";

const resolveMemoryPrincipalForUserProfile = vi.hoisted(() => vi.fn());
const inspectBuiltinMemorySharingStatus = vi.hoisted(() => vi.fn());
const registerBuiltinMemoryProjectionTargetStore = vi.hoisted(() => vi.fn());
const setBuiltinMemoryPostboxModeForPrincipal = vi.hoisted(() => vi.fn());
const previewBuiltinMemoryProjection = vi.hoisted(() => vi.fn());
const createBuiltinMemoryProjection = vi.hoisted(() => vi.fn());
const refreshBuiltinMemoryProjection = vi.hoisted(() => vi.fn());
const revokeBuiltinMemoryProjection = vi.hoisted(() => vi.fn());
const inspectBuiltinMemoryProjectionImpact = vi.hoisted(() => vi.fn());
const inspectBuiltinMemoryPostboxItem = vi.hoisted(() => vi.fn());
const reviewBuiltinMemoryPostboxItem = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/memory-sharing-control-runtime", () => ({
  resolveMemoryPrincipalForUserProfile,
}));

vi.mock("./scoped-memory-sharing.js", () => ({
  inspectBuiltinMemorySharingStatus,
  registerBuiltinMemoryProjectionTargetStore,
  setBuiltinMemoryPostboxModeForPrincipal,
  previewBuiltinMemoryProjection,
  createBuiltinMemoryProjection,
  refreshBuiltinMemoryProjection,
  revokeBuiltinMemoryProjection,
  inspectBuiltinMemoryProjectionImpact,
  inspectBuiltinMemoryPostboxItem,
  reviewBuiltinMemoryPostboxItem,
}));

type RegisteredMethod = {
  handler: (options: GatewayRequestHandlerOptions) => Promise<void>;
  scope: NonNullable<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2]>["scope"];
};

function createHarness() {
  const methods = new Map<string, RegisteredMethod>();
  const api = {
    registerGatewayMethod(
      method: string,
      handler: RegisteredMethod["handler"],
      options?: NonNullable<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2]>,
    ) {
      methods.set(method, { handler, scope: options?.scope });
    },
  } as unknown as OpenClawPluginApi;
  registerScopedMemorySharingGatewayMethods(api);
  return methods;
}

async function invoke(params: { method: RegisteredMethod; request: unknown; profileId?: string }) {
  const respond = vi.fn();
  await params.method.handler({
    params: params.request,
    client: params.profileId
      ? ({ authenticatedUserProfile: { profileId: params.profileId } } as never)
      : null,
    respond,
  } as unknown as GatewayRequestHandlerOptions);
  return respond;
}

describe("memory sharing gateway methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveMemoryPrincipalForUserProfile.mockReturnValue({
      principalId: "principal-alice",
      kind: "user",
      revision: "principal-revision",
    });
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("registers read-only status and admin mode controls", () => {
    const methods = createHarness();
    expect([...methods.entries()].map(([name, value]) => [name, value.scope])).toEqual([
      ["memory.sharing.status", "operator.read"],
      ["memory.sharing.projection.target.register", "operator.admin"],
      ["memory.sharing.projection.preview", "operator.admin"],
      ["memory.sharing.projection.create", "operator.admin"],
      ["memory.sharing.projection.refresh", "operator.admin"],
      ["memory.sharing.projection.revoke", "operator.admin"],
      ["memory.sharing.projection.impact", "operator.read"],
      ["memory.sharing.postbox.mode.set", "operator.admin"],
      ["memory.sharing.postbox.inspect", "operator.read"],
      ["memory.sharing.postbox.review", "operator.admin"],
      ["memory.sharing.postbox.purge", "operator.admin"],
    ]);
  });

  it("stops an operator.read client at Gateway dispatch before an admin mutation handler", async () => {
    const methods = createHarness();
    const registered = methods.get("memory.sharing.projection.create")!;
    const handler = vi.fn(registered.handler);
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.gatewayHandlers["memory.sharing.projection.create"] = handler;
    pluginRegistry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "memory-core",
        name: "memory.sharing.projection.create",
        handler,
        scope: registered.scope!,
      }),
    );
    setActivePluginRegistry(pluginRegistry);
    const respond = vi.fn();

    await handleGatewayRequest({
      req: {
        type: "req",
        id: "memory-sharing-read-denied",
        method: "memory.sharing.projection.create",
        params: {},
      },
      respond,
      client: {
        connId: "operator-read",
        connect: {
          role: "operator",
          scopes: ["operator.read"],
          client: { id: "test", version: "test", platform: "linux", mode: "cli" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      },
      isWebchatConnect: () => false,
      context: { logGateway: { warn: vi.fn() } } as never,
      methodRegistry: createGatewayMethodRegistry([]),
    });

    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "FORBIDDEN",
      message: "missing scope: operator.admin",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.admin",
        requiredScopes: ["operator.admin"],
      },
    });
  });

  it("registers only a profile-authorized non-private projection target store", async () => {
    const methods = createHarness();
    const respond = await invoke({
      method: methods.get("memory.sharing.projection.target.register")!,
      request: {
        agentId: "main",
        targetKind: "conversation",
        targetId: "conversation-team",
        storeId: "store-team",
      },
      profileId: "profile-alice",
    });

    expect(registerBuiltinMemoryProjectionTargetStore).toHaveBeenCalledWith({
      agentId: "main",
      target: { kind: "conversation", id: "conversation-team" },
      storeId: "store-team",
      operatorPrincipalId: "principal-alice",
    });
    expect(respond).toHaveBeenCalledWith(true, {
      target: { kind: "conversation", id: "conversation-team" },
    });
  });

  it("derives the status principal from the authenticated profile and rejects caller principal input", async () => {
    const methods = createHarness();
    inspectBuiltinMemorySharingStatus.mockReturnValue({
      postboxMode: "off",
      projections: [],
      postboxItems: [],
    });
    const status = methods.get("memory.sharing.status")!;
    const valid = await invoke({
      method: status,
      request: { agentId: "main" },
      profileId: "profile-alice",
    });
    const injectedPrincipal = await invoke({
      method: status,
      request: { agentId: "main", principalId: "principal-bob" },
      profileId: "profile-alice",
    });

    expect(resolveMemoryPrincipalForUserProfile).toHaveBeenCalledWith({
      userProfileId: "profile-alice",
    });
    expect(inspectBuiltinMemorySharingStatus).toHaveBeenCalledWith({
      agentId: "main",
      operatorPrincipalId: "principal-alice",
    });
    expect(valid).toHaveBeenCalledWith(true, {
      postboxMode: "off",
      projections: [],
      postboxItems: [],
    });
    expect(injectedPrincipal.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: "unexpected parameter: principalId",
    });
  });

  it("requires an authenticated profile and derives postbox ownership without a store argument", async () => {
    const methods = createHarness();
    const mode = methods.get("memory.sharing.postbox.mode.set")!;
    const unauthenticated = await invoke({
      method: mode,
      request: { agentId: "main", mode: "review-required" },
    });
    const valid = await invoke({
      method: mode,
      request: { agentId: "main", mode: "review-required" },
      profileId: "profile-alice",
    });

    expect(unauthenticated.mock.calls[0]?.[2]).toMatchObject({
      code: "FORBIDDEN",
      message: "memory sharing requires an authenticated Gateway profile.",
    });
    expect(setBuiltinMemoryPostboxModeForPrincipal).toHaveBeenCalledWith({
      agentId: "main",
      principalId: "principal-alice",
      mode: "review-required",
    });
    expect(valid).toHaveBeenCalledWith(true, { mode: "review-required" });
  });

  it("derives publisher and reviewer from the Gateway profile for a projection", async () => {
    const methods = createHarness();
    createBuiltinMemoryProjection.mockReturnValue({ projectionId: "projection-1" });
    const respond = await invoke({
      method: methods.get("memory.sharing.projection.create")!,
      request: {
        agentId: "main",
        sourceRevisionId: "revision-private",
        targetKind: "conversation",
        targetId: "conversation-team",
        purpose: "share contact detail",
        preview: "approved contact detail",
        content: "reviewed copy",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      profileId: "profile-alice",
    });

    expect(createBuiltinMemoryProjection).toHaveBeenCalledWith({
      agentId: "main",
      sourceRevisionId: "revision-private",
      target: { kind: "conversation", id: "conversation-team" },
      purpose: "share contact detail",
      preview: "approved contact detail",
      content: "reviewed copy",
      expiry: { kind: "expires", expiresAt: Date.parse("2030-01-01T00:00:00.000Z") },
      publisherPrincipalId: "principal-alice",
      reviewedByPrincipalId: "principal-alice",
    });
    expect(respond).toHaveBeenCalledWith(true, { projectionId: "projection-1" });
  });

  it("rejects a raw private-user target before projection creation", async () => {
    const methods = createHarness();
    const respond = await invoke({
      method: methods.get("memory.sharing.projection.create")!,
      request: {
        agentId: "main",
        sourceRevisionId: "revision-private",
        targetKind: "user",
        targetId: "principal-bob",
        purpose: "share contact detail",
        preview: "approved contact detail",
        content: "reviewed copy",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      profileId: "profile-alice",
    });

    expect(createBuiltinMemoryProjection).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: "targetKind must be conversation, role, or agent-shared.",
    });
  });

  it("previews with only the profile-derived publisher and no private source body", async () => {
    const methods = createHarness();
    previewBuiltinMemoryProjection.mockReturnValue({ preview: "approved contact detail" });
    const respond = await invoke({
      method: methods.get("memory.sharing.projection.preview")!,
      request: {
        agentId: "main",
        sourceRevisionId: "revision-private",
        targetKind: "conversation",
        targetId: "conversation-team",
        purpose: "share contact detail",
        preview: "approved contact detail",
        noExpiryAuditReason: "owner approved durable reference",
      },
      profileId: "profile-alice",
    });

    expect(previewBuiltinMemoryProjection).toHaveBeenCalledWith({
      agentId: "main",
      sourceRevisionId: "revision-private",
      target: { kind: "conversation", id: "conversation-team" },
      purpose: "share contact detail",
      preview: "approved contact detail",
      expiry: { kind: "no-expiry", auditReason: "owner approved durable reference" },
      publisherPrincipalId: "principal-alice",
    });
    expect(respond).toHaveBeenCalledWith(true, { preview: "approved contact detail" });
  });

  it("reads projection impact through the profile-derived operator", async () => {
    const methods = createHarness();
    inspectBuiltinMemoryProjectionImpact.mockReturnValue({
      projectionId: "projection-1",
      exposureSetIds: ["exposure-1"],
    });
    const respond = await invoke({
      method: methods.get("memory.sharing.projection.impact")!,
      request: { agentId: "main", projectionId: "projection-1" },
      profileId: "profile-alice",
    });

    expect(inspectBuiltinMemoryProjectionImpact).toHaveBeenCalledWith({
      agentId: "main",
      projectionId: "projection-1",
      operatorPrincipalId: "principal-alice",
    });
    expect(respond).toHaveBeenCalledWith(true, {
      projectionId: "projection-1",
      exposureSetIds: ["exposure-1"],
    });
  });

  it("sends edited review content only to the profile-derived target owner", async () => {
    const methods = createHarness();
    const respond = await invoke({
      method: methods.get("memory.sharing.postbox.review")!,
      request: {
        agentId: "main",
        itemId: "postbox-1",
        decision: "approve",
        reviewedContent: "owner-edited copy",
      },
      profileId: "profile-alice",
    });

    expect(reviewBuiltinMemoryPostboxItem).toHaveBeenCalledWith({
      agentId: "main",
      itemId: "postbox-1",
      decision: "approve",
      reviewedContent: "owner-edited copy",
      operatorPrincipalId: "principal-alice",
    });
    expect(respond).toHaveBeenCalledWith(true, { itemId: "postbox-1", decision: "approve" });
  });

  it("rejects edited content with a rejection decision", async () => {
    const methods = createHarness();
    const respond = await invoke({
      method: methods.get("memory.sharing.postbox.review")!,
      request: {
        agentId: "main",
        itemId: "postbox-1",
        decision: "reject",
        reviewedContent: "must not be promoted",
      },
      profileId: "profile-alice",
    });

    expect(reviewBuiltinMemoryPostboxItem).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: "reviewedContent is available only for approve.",
    });
  });

  it("rejects caller-supplied publisher and reviewer fields before projection creation", async () => {
    const methods = createHarness();
    const respond = await invoke({
      method: methods.get("memory.sharing.projection.create")!,
      request: {
        agentId: "main",
        sourceRevisionId: "revision-private",
        targetKind: "conversation",
        targetId: "conversation-team",
        purpose: "share contact detail",
        preview: "approved contact detail",
        content: "reviewed copy",
        expiresAt: "2030-01-01T00:00:00.000Z",
        publisherPrincipalId: "principal-mallory",
      },
      profileId: "profile-alice",
    });

    expect(createBuiltinMemoryProjection).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: "unexpected parameter: publisherPrincipalId",
    });
  });

  it("denies a profile that has no current memory principal", async () => {
    const methods = createHarness();
    resolveMemoryPrincipalForUserProfile.mockReturnValue(undefined);

    const respond = await invoke({
      method: methods.get("memory.sharing.status")!,
      request: { agentId: "main" },
      profileId: "profile-without-memory",
    });

    expect(inspectBuiltinMemorySharingStatus).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: "FORBIDDEN",
      message: "memory sharing is unavailable for this profile.",
    });
  });
});
