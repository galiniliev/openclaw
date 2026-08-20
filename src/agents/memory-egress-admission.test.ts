import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cutover: true,
  lookup: { kind: "absent" } as Record<string, unknown>,
  subject: "alice",
  subjectKind: "user" as "user" | "agent" | "conversation",
  recipientMatches: true,
  conversationTarget: "chat-1",
  roleIds: [] as string[],
}));

vi.mock("../infra/agent-run-registry.js", () => ({
  getAgentRunContext: () => ({
    agentId: "memory-agent",
    sessionId: "session-1",
    sessionKey: "agent:memory-agent:direct:alice",
  }),
}));

vi.mock("../plugins/memory-cutover.js", () => ({
  isMemoryIsolationCutoverAgent: () => mocks.cutover,
}));

vi.mock("../plugins/memory-run-exposure-ledger.js", () => ({
  readLatestDurableMemoryRunExposure: () => mocks.lookup,
}));

vi.mock("../state/memory-identity.js", () => ({
  recheckMemoryIdentityBindingRecipient: () =>
    mocks.recipientMatches ? { kind: "current" } : { kind: "unbound" },
}));

vi.mock("../state/memory-enterprise-admission.js", () => ({
  readCurrentEnterpriseMemoryFactsForUser: ({ userPrincipalId }: { userPrincipalId: string }) => ({
    verifiedMemberships: mocks.roleIds.map((groupId) => ({
      principalId: userPrincipalId,
      groupId,
    })),
  }),
}));

vi.mock("../state/memory-session-subject.js", () => ({
  createCurrentMemorySessionContext: () => ({
    kind: "current",
    context: {
      agentId: "memory-agent",
      sessionId: "session-1",
      sessionKey: "agent:memory-agent:direct:alice",
      principalId: mocks.subject,
      ...(mocks.subjectKind === "user" ? { bindingId: "binding-alice" } : {}),
      ...(mocks.subjectKind === "conversation"
        ? {
            conversation: {
              channel: "telegram",
              accountId: "default",
              primaryConversationId: "conversation-1",
              deliveryTarget: mocks.conversationTarget,
            },
          }
        : {}),
      subject: { kind: mocks.subjectKind, principalId: mocks.subject },
    },
  }),
}));

const {
  admitMemoryEgressAtDelivery,
  prepareMemoryEgressAuthorization,
  MEMORY_EGRESS_CAPABILITY_REPLY_FINAL,
} = await import("./memory-egress-admission.js");

function currentExposure(revisionNumber: number, overrides: Record<string, unknown> = {}) {
  const previousLookup = mocks.lookup;
  mocks.lookup = { kind: "absent" };
  const prepared = prepareFinal();
  mocks.lookup = previousLookup;
  if (!prepared.allowed) {
    throw new Error("test setup could not prepare final authorization");
  }
  return {
    kind: "current",
    snapshot: {
      agentId: "memory-agent",
      sessionId: "session-1",
      sessionKey: "agent:memory-agent:direct:alice",
      runId: "run-1",
      exposureSetId: `exposure-${revisionNumber}`,
      revisionNumber,
      egressReceiptIds: ["receipt-1"],
      deliveryAudiences: [{ kind: "user", id: "alice" }],
      deliveryRevision: prepared.authorization.deliveryRevision,
      egressRegistryRevision: prepared.authorization.egressRegistryRevision,
      ...overrides,
    },
  };
}

const deliveryContext = {
  channel: "telegram",
  to: "chat-1",
  accountId: "default",
  threadId: "thread-1",
};

function prepareFinal() {
  return prepareMemoryEgressAuthorization({
    capabilityId: MEMORY_EGRESS_CAPABILITY_REPLY_FINAL,
    runId: "run-1",
    deliveryContext,
  });
}

beforeEach(() => {
  mocks.cutover = true;
  mocks.lookup = { kind: "absent" };
  mocks.subject = "alice";
  mocks.subjectKind = "user";
  mocks.recipientMatches = true;
  mocks.conversationTarget = "chat-1";
  mocks.roleIds = [];
});

describe("memory egress admission", () => {
  it("permits only the registered final-reply capability for a cutover run", () => {
    expect(prepareFinal()).toMatchObject({ allowed: true });
    expect(
      prepareMemoryEgressAuthorization({
        capabilityId: "reply.block",
        runId: "run-1",
        deliveryContext,
      }),
    ).toEqual({ allowed: false, reason: "unregistered" });
  });

  it("fails closed when a known cutover agent has no registered run identity", () => {
    expect(
      prepareMemoryEgressAuthorization({
        capabilityId: MEMORY_EGRESS_CAPABILITY_REPLY_FINAL,
        agentId: "memory-agent",
        sessionId: "session-1",
        sessionKey: "agent:memory-agent:direct:alice",
        deliveryContext,
      }),
    ).toEqual({ allowed: false, reason: "unavailable" });
  });

  it("fails closed when the delivery owner cannot provide a current platform route", () => {
    expect(
      prepareMemoryEgressAuthorization({
        capabilityId: MEMORY_EGRESS_CAPABILITY_REPLY_FINAL,
        runId: "run-1",
        resolveDeliveryFacts: () => undefined,
      }),
    ).toEqual({ allowed: false, reason: "unavailable" });
  });

  it("rejects an initially unproven direct-recipient target", () => {
    mocks.recipientMatches = false;

    expect(prepareFinal()).toEqual({ allowed: false, reason: "unavailable" });
  });

  it("binds direct role-memory egress to current verified membership", () => {
    mocks.roleIds = ["engineering"];
    const prepared = prepareFinal();
    expect(prepared).toMatchObject({
      allowed: true,
      authorization: {
        audiences: [
          { kind: "role", id: "engineering" },
          { kind: "user", id: "alice" },
        ],
      },
    });
    if (!prepared.allowed) {
      return;
    }
    mocks.lookup = {
      kind: "current",
      snapshot: {
        agentId: "memory-agent",
        sessionId: "session-1",
        sessionKey: "agent:memory-agent:direct:alice",
        runId: "run-1",
        exposureSetId: "role-exposure",
        revisionNumber: 1,
        egressReceiptIds: ["receipt-1"],
        deliveryAudiences: prepared.authorization.audiences,
        deliveryRevision: prepared.authorization.deliveryRevision,
        egressRegistryRevision: prepared.authorization.egressRegistryRevision,
      },
    };

    mocks.roleIds = [];
    expect(
      admitMemoryEgressAtDelivery({
        authorization: prepared.authorization,
        deliveryContext,
      }),
    ).toEqual({ allowed: false, reason: "stale" });
  });

  it("admits only the persisted group conversation target", () => {
    mocks.subjectKind = "conversation";
    mocks.subject = "conversation-principal";
    expect(prepareFinal()).toMatchObject({
      allowed: true,
      authorization: { audiences: [{ kind: "conversation", id: "conversation-principal" }] },
    });

    mocks.conversationTarget = "other-group";
    expect(prepareFinal()).toEqual({ allowed: false, reason: "unavailable" });
  });

  it("invalidates a queued final after a later durable memory read", () => {
    mocks.lookup = currentExposure(1);
    const prepared = prepareFinal();
    expect(prepared.allowed).toBe(true);
    if (!prepared.allowed) {
      return;
    }
    mocks.lookup = currentExposure(2);

    expect(
      admitMemoryEgressAtDelivery({
        authorization: prepared.authorization,
        deliveryContext,
      }),
    ).toEqual({ allowed: false, reason: "stale" });
  });

  it("invalidates an unexposed queued final when memory is exposed before delivery", () => {
    const prepared = prepareFinal();
    expect(prepared.allowed).toBe(true);
    if (!prepared.allowed) {
      return;
    }
    mocks.lookup = currentExposure(1);

    expect(
      admitMemoryEgressAtDelivery({
        authorization: prepared.authorization,
        deliveryContext,
      }),
    ).toEqual({ allowed: false, reason: "stale" });
  });

  it("samples the actual delivery route again before platform I/O", () => {
    let actualDelivery = { ...deliveryContext };
    const resolveDeliveryFacts = () => ({ deliveryContext: actualDelivery });
    const prepared = prepareMemoryEgressAuthorization({
      capabilityId: MEMORY_EGRESS_CAPABILITY_REPLY_FINAL,
      runId: "run-1",
      resolveDeliveryFacts,
    });
    expect(prepared.allowed).toBe(true);
    if (!prepared.allowed) {
      return;
    }

    actualDelivery = { ...deliveryContext, to: "chat-rebound" };
    expect(
      admitMemoryEgressAtDelivery({
        authorization: prepared.authorization,
        resolveDeliveryFacts,
      }),
    ).toEqual({ allowed: false, reason: "stale" });
  });

  it("rejects a direct recipient whose binding no longer matches at delivery", () => {
    const prepared = prepareFinal();
    expect(prepared.allowed).toBe(true);
    if (!prepared.allowed) {
      return;
    }

    mocks.recipientMatches = false;
    expect(
      admitMemoryEgressAtDelivery({
        authorization: prepared.authorization,
        deliveryContext,
      }),
    ).toEqual({ allowed: false, reason: "unavailable" });
  });

  it("invalidates a queued final when the current sink changes", () => {
    const prepared = prepareFinal();
    expect(prepared.allowed).toBe(true);
    if (!prepared.allowed) {
      return;
    }

    mocks.subjectKind = "agent";
    mocks.subject = "memory-agent";
    expect(
      admitMemoryEgressAtDelivery({
        authorization: prepared.authorization,
        deliveryContext,
      }),
    ).toEqual({ allowed: false, reason: "unavailable" });
  });

  it("rejects changed audience and unavailable registry-backed exposure state", () => {
    mocks.lookup = currentExposure(1);
    const prepared = prepareFinal();
    expect(prepared.allowed).toBe(true);
    if (!prepared.allowed) {
      return;
    }
    mocks.subject = "bob";
    expect(
      admitMemoryEgressAtDelivery({
        authorization: prepared.authorization,
        deliveryContext,
      }),
    ).toEqual({ allowed: false, reason: "stale" });

    mocks.subject = "alice";
    mocks.lookup = { kind: "unavailable" };
    expect(
      admitMemoryEgressAtDelivery({
        authorization: prepared.authorization,
        deliveryContext,
      }),
    ).toEqual({ allowed: false, reason: "unavailable" });
  });

  it("rejects changed delivery route and registry revisions", () => {
    mocks.lookup = currentExposure(1);
    const prepared = prepareFinal();
    expect(prepared.allowed).toBe(true);
    if (!prepared.allowed) {
      return;
    }
    mocks.lookup = currentExposure(1, { deliveryRevision: "different-route" });
    expect(
      admitMemoryEgressAtDelivery({
        authorization: prepared.authorization,
        deliveryContext,
      }),
    ).toEqual({ allowed: false, reason: "stale" });

    mocks.lookup = currentExposure(1, { egressRegistryRevision: "different-registry" });
    expect(
      admitMemoryEgressAtDelivery({
        authorization: prepared.authorization,
        deliveryContext,
      }),
    ).toEqual({ allowed: false, reason: "stale" });
  });

  it("leaves non-cutover runs unchanged", () => {
    mocks.cutover = false;
    expect(
      prepareMemoryEgressAuthorization({
        capabilityId: "reply.block",
        runId: "run-1",
        deliveryContext,
      }),
    ).toMatchObject({ allowed: true, authorization: { capabilityId: "reply.block" } });
  });
});
