import { describe, expect, it, vi } from "vitest";
import type {
  MemoryEgressAdmission,
  TrustedMemoryEgressDeliveryFactsSource,
} from "../agents/memory-egress-admission.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createReplyDispatcher } from "./reply/reply-dispatcher.js";
import { buildTestCtx } from "./reply/test-ctx.js";

type DispatchReplyFromConfigFn =
  typeof import("./reply/dispatch-from-config.js").dispatchReplyFromConfig;
type PrepareMemoryEgressAuthorizationFn =
  typeof import("../agents/memory-egress-admission.js").prepareMemoryEgressAuthorization;
type AdmitMemoryEgressAtDeliveryFn =
  typeof import("../agents/memory-egress-admission.js").admitMemoryEgressAtDelivery;

const hoisted = vi.hoisted(() => ({
  dispatchReplyFromConfig: vi.fn(),
  prepareMemoryEgressAuthorization: vi.fn(),
  admitMemoryEgressAtDelivery: vi.fn(),
  queueRoute: undefined as string | undefined,
  deliveryRoute: undefined as string | undefined,
}));

vi.mock("./reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: (...args: Parameters<DispatchReplyFromConfigFn>) =>
    hoisted.dispatchReplyFromConfig(...args),
}));

vi.mock("../agents/memory-egress-admission.js", () => ({
  MEMORY_EGRESS_CAPABILITY_REPLY_FINAL: "reply.final",
  prepareMemoryEgressAuthorization: (...args: Parameters<PrepareMemoryEgressAuthorizationFn>) =>
    hoisted.prepareMemoryEgressAuthorization(...args),
  admitMemoryEgressAtDelivery: (...args: Parameters<AdmitMemoryEgressAtDeliveryFn>) =>
    hoisted.admitMemoryEgressAtDelivery(...args),
  memoryEgressPayloadAuthorization: (admission: MemoryEgressAdmission) =>
    admission.allowed
      ? { kind: "authorized" as const, authorization: admission.authorization }
      : { kind: "denied" as const, reason: admission.reason },
}));

vi.mock("../plugins/memory-cutover.js", () => ({
  isMemoryIsolationCutoverAgent: (agentId: string) => agentId === "memory-agent",
}));

const { dispatchInboundMessage } = await import("./dispatch.js");

function readRoute(source: TrustedMemoryEgressDeliveryFactsSource | undefined): string | undefined {
  return source?.()?.deliveryContext?.to;
}

function allowedFinalAdmission(): MemoryEgressAdmission {
  return {
    allowed: true,
    authorization: {
      version: 1,
      capabilityId: "reply.final",
      agentId: "memory-agent",
      sessionId: "session-1",
      runId: "run-1",
      deliveryRevision: "delivery-1",
      egressRegistryRevision: "registry-1",
      audiences: [{ kind: "user", id: "alice" }],
    },
  };
}

describe("memory egress at final dispatch", () => {
  it("uses the installed final gate and denies a direct block plus a rebound final route", async () => {
    const delivered = vi.fn(async () => undefined);
    const dispatcher = createReplyDispatcher({ deliver: delivered });
    const ctx = buildTestCtx({
      AgentId: "memory-agent",
      SessionKey: "agent:memory-agent:direct:alice",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "chat-before",
      AccountId: "default",
    });

    hoisted.prepareMemoryEgressAuthorization.mockImplementation(
      (params: Parameters<PrepareMemoryEgressAuthorizationFn>[0]) => {
        const route = readRoute(params.resolveDeliveryFacts);
        if (params.capabilityId === "reply.final") {
          hoisted.queueRoute = route;
          return allowedFinalAdmission();
        }
        return { allowed: false, reason: "unregistered" };
      },
    );
    hoisted.admitMemoryEgressAtDelivery.mockImplementation(
      (params: Parameters<AdmitMemoryEgressAtDeliveryFn>[0]) => {
        hoisted.deliveryRoute = readRoute(params.resolveDeliveryFacts);
        return { allowed: false, reason: "stale" };
      },
    );
    hoisted.dispatchReplyFromConfig.mockImplementation(
      async ({ ctx: dispatchCtx, dispatcher: dispatchDispatcher }) => {
        dispatchDispatcher.sendBlockReply({ text: "streamed block" });
        dispatchDispatcher.sendFinalReply({ text: "final" });
        // This happens after queue-time preparation but before the serialized
        // dispatcher reaches its final platform deliverer.
        dispatchCtx.OriginatingTo = "chat-rebound";
        return { queuedFinal: true, counts: { tool: 0, block: 1, final: 1 } };
      },
    );

    await dispatchInboundMessage({
      ctx,
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyOptions: { runId: "run-1" },
    });

    expect(hoisted.queueRoute).toBe("chat-before");
    expect(hoisted.deliveryRoute).toBe("chat-rebound");
    expect(hoisted.prepareMemoryEgressAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ capabilityId: "reply.block" }),
    );
    // The finalized channel context has no authoritative session identity. The
    // admission owner resolves sessionId/sessionKey from the registered run,
    // so a stale inbound field cannot retarget memory egress.
    expect(
      hoisted.prepareMemoryEgressAuthorization.mock.calls.every(([params]) =>
        params.sessionId === undefined && params.sessionKey === undefined,
      ),
    ).toBe(true);
    expect(delivered).not.toHaveBeenCalled();
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 1, final: 1 });
  });
});
