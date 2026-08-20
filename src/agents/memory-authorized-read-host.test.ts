import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDeriveInvocation: vi.fn(),
  commitDerivation: vi.fn(),
  currentSession: vi.fn(),
  createWriteInvocation: vi.fn(),
  createTrustedContext: vi.fn(),
  readTranscriptDerivation: vi.fn(),
  search: vi.fn(),
  write: vi.fn(),
}));

vi.mock("../plugins/memory-cutover.js", () => ({
  isMemoryIsolationCutoverAgent: () => true,
}));
vi.mock("../plugins/memory-invocation.js", () => ({
  MEMORY_INVOCATION_UNAVAILABLE: { unavailable: true },
  commitAuthorizedMemoryDerivationForInvocation: mocks.commitDerivation,
  createAuthorizedMemoryDeriveInvocation: mocks.createDeriveInvocation,
  createAuthorizedMemoryReadInvocation: vi.fn(),
  createAuthorizedMemoryWriteInvocation: mocks.createWriteInvocation,
  materializeAuthorizedMemoryVirtualView: vi.fn(),
  readAuthorizedMemoryVirtualFile: vi.fn(),
  readAuthorizedMemoryForInvocation: vi.fn(),
  searchAuthorizedMemoryForInvocation: mocks.search,
  writeAuthorizedMemoryForInvocation: mocks.write,
}));
vi.mock("../config/sessions/session-transcript-memory-policy.js", () => ({
  readAuthorizedTranscriptDerivation: mocks.readTranscriptDerivation,
}));
vi.mock("../state/openclaw-agent-db.js", () => ({
  openOpenClawAgentDatabase: () => ({ db: { kind: "agent-db" } }),
}));
vi.mock("../state/memory-access-context.js", () => ({
  captureTrustedMemoryAccessFacts: (facts: unknown) => facts,
  createTrustedMemoryAccessContext: mocks.createTrustedContext,
}));
vi.mock("../state/memory-identity.js", () => ({
  recheckMemoryIdentityBinding: () => true,
}));
vi.mock("../state/memory-session-subject.js", () => ({
  createCurrentMemorySessionContext: mocks.currentSession,
}));
vi.mock("./memory-egress-admission.js", () => ({
  resolveMemoryEgressDeliveryFacts: () => ({
    sink: "internal",
    audiences: [{ kind: "agent", id: "main" }],
    deliveryRevision: "delivery-1",
    egressRegistryRevision: "egress-1",
  }),
}));

import {
  admitAuthorizedMemoryDerivation,
  createAuthorizedMemoryDerivationHost,
  createAuthorizedMemoryReadHost,
  prepareAuthorizedMemoryBackgroundDerivationHost,
  prepareAuthorizedTranscriptDerivationHost,
} from "./memory-authorized-read-host.js";

describe("admitAuthorizedMemoryDerivation", () => {
  beforeEach(() => {
    mocks.createDeriveInvocation.mockReset();
    mocks.commitDerivation.mockReset();
    mocks.currentSession.mockReset();
    mocks.createWriteInvocation.mockReset();
    mocks.createTrustedContext.mockReset();
    mocks.readTranscriptDerivation.mockReset();
    mocks.search.mockReset();
    mocks.write.mockReset();
    mocks.currentSession.mockReturnValue({
      kind: "current",
      context: {
        agentId: "main",
        fingerprint: "session-fingerprint",
        principalId: "service:main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        authorityRevision: "authority-1",
        subject: { kind: "service", principalId: "service:main" },
      },
    });
    mocks.createTrustedContext.mockReturnValue({ kind: "current", context: { trusted: true } });
  });

  it("admits a host-minted derive context before a model can receive derived content", async () => {
    mocks.createDeriveInvocation.mockResolvedValue({});

    await expect(
      admitAuthorizedMemoryDerivation({
        agentId: "main",
        sessionKey: "agent:main:session-1",
        sessionId: "session-1",
        runId: "run-1",
      }),
    ).resolves.toBe(true);

    expect(mocks.createDeriveInvocation).toHaveBeenCalledWith({ context: { trusted: true } });
    expect(mocks.createTrustedContext).toHaveBeenCalledWith(
      expect.objectContaining({ facts: expect.objectContaining({ operation: "derive" }) }),
    );
  });

  it("fails closed when derive admission is unavailable", async () => {
    mocks.createDeriveInvocation.mockResolvedValue({ unavailable: true });

    await expect(
      admitAuthorizedMemoryDerivation({
        agentId: "main",
        sessionKey: "agent:main:session-1",
        sessionId: "session-1",
        runId: "run-1",
      }),
    ).resolves.toBe(false);
  });

  it("does not mint a host for a spawned child without an explicit delegation", async () => {
    mocks.currentSession.mockReturnValue({
      kind: "current",
      context: {
        agentId: "main",
        fingerprint: "child-session-fingerprint",
        isChildSession: true,
        principalId: "agent:child",
        sessionId: "child-session",
        sessionKey: "agent:main:subagent:child",
        authorityRevision: "child-authority-1",
        subject: { kind: "agent", principalId: "agent:child" },
      },
    });

    expect(
      createAuthorizedMemoryReadHost({
        agentId: "main",
        sessionKey: "agent:main:subagent:child",
        sessionId: "child-session",
      }),
    ).toBeUndefined();
    await expect(
      prepareAuthorizedMemoryBackgroundDerivationHost({
        agentId: "main",
        sessionKey: "agent:main:subagent:child",
        sessionId: "child-session",
        purpose: "dreaming",
      }),
    ).resolves.toBeUndefined();
    expect(mocks.createDeriveInvocation).not.toHaveBeenCalled();
  });

  it("keeps source reads on the derive invocation after admission", async () => {
    const invocation = {};
    mocks.createDeriveInvocation.mockResolvedValue(invocation);
    mocks.search.mockResolvedValue({ results: [] });

    const host = createAuthorizedMemoryDerivationHost({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      runId: "run-1",
    });

    await host?.search({ query: "compaction source" });

    expect(mocks.createDeriveInvocation).toHaveBeenCalledWith({ context: { trusted: true } });
  });

  it("binds background dreaming output to the same derive invocation that exposed its source", async () => {
    const invocation = {};
    mocks.createDeriveInvocation.mockResolvedValue(invocation);
    mocks.search.mockResolvedValue({
      results: [{ handleId: "source-1", snippet: "scoped source" }],
    });
    mocks.commitDerivation.mockResolvedValue({
      version: 1,
      mutationId: "dream",
      status: "committed",
    });

    const host = await prepareAuthorizedMemoryBackgroundDerivationHost({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      runId: "run-1",
      purpose: "dreaming",
    });

    await host?.search({ query: "scoped source" });
    await host?.commit({ content: "consolidated scoped source" });

    expect(mocks.createDeriveInvocation).toHaveBeenCalledWith({ context: { trusted: true } });
    expect(mocks.commitDerivation).toHaveBeenCalledWith({
      invocation,
      content: "consolidated scoped source",
      contentType: "markdown",
      purpose: "dreaming",
    });
  });

  it("does not reconstruct private derivation authority for background work", async () => {
    mocks.currentSession.mockReturnValue({
      kind: "current",
      context: {
        agentId: "main",
        fingerprint: "private-session-fingerprint",
        principalId: "alice",
        sessionId: "private-session",
        sessionKey: "agent:main:direct:alice",
        authorityRevision: "private-authority-1",
        bindingId: "binding-alice",
        subject: { kind: "user", principalId: "alice" },
      },
    });

    await expect(
      prepareAuthorizedMemoryBackgroundDerivationHost({
        agentId: "main",
        sessionKey: "agent:main:direct:alice",
        sessionId: "private-session",
        purpose: "dreaming",
      }),
    ).resolves.toBeUndefined();
    expect(mocks.createDeriveInvocation).not.toHaveBeenCalled();
  });

  it("binds a flush mutation to the host-read transcript policy set before the model can write", async () => {
    const invocation = {};
    mocks.readTranscriptDerivation.mockReturnValue({
      eventSeqs: [0, 1],
      sourcePolicySetId: "policy-set-1",
      deliveryAudiencesJson: '[{"kind":"user","id":"alice"}]',
    });
    mocks.createWriteInvocation.mockResolvedValue(invocation);
    mocks.write.mockResolvedValue({ version: 1, mutationId: "mutation", status: "committed" });

    const host = await prepareAuthorizedTranscriptDerivationHost({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      runId: "run-1",
    });

    await host?.remember({ content: "durable fact" });

    expect(mocks.readTranscriptDerivation).toHaveBeenCalledWith({ kind: "agent-db" }, "session-1");
    expect(mocks.createWriteInvocation).toHaveBeenCalledWith({ context: { trusted: true } });
    expect(mocks.readTranscriptDerivation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createWriteInvocation.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation,
        mutation: expect.objectContaining({
          kind: "derive",
          derivationPurpose: "flush",
          sourcePolicySetId: "policy-set-1",
          transcriptSource: {
            kind: "transcript",
            sessionId: "session-1",
            eventSeqs: [0, 1],
            sourcePolicySetId: "policy-set-1",
            deliveryAudiencesJson: '[{"kind":"user","id":"alice"}]',
          },
        }),
      }),
    );
  });

  it("names a compacted summary without letting the caller select transcript lineage", async () => {
    const invocation = {};
    mocks.readTranscriptDerivation.mockReturnValue({
      eventSeqs: [0, 1],
      sourcePolicySetId: "policy-set-1",
      deliveryAudiencesJson: '[{"kind":"user","id":"alice"}]',
    });
    mocks.createWriteInvocation.mockResolvedValue(invocation);
    mocks.write.mockResolvedValue({ version: 1, mutationId: "mutation", status: "committed" });

    const host = await prepareAuthorizedTranscriptDerivationHost({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      runId: "run-1",
      derivationPurpose: "compaction",
    });

    await host?.remember({ content: "summary" });

    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation,
        mutation: expect.objectContaining({
          kind: "derive",
          derivationPurpose: "compaction",
          sourcePolicySetId: "policy-set-1",
        }),
      }),
    );
  });
});
