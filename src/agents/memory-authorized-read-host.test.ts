import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collectDerivation: vi.fn(),
  captureTranscriptExport: vi.fn(),
  createDeriveInvocation: vi.fn(),
  createExportInvocation: vi.fn(),
  commitDerivation: vi.fn(),
  currentSession: vi.fn(),
  createWriteInvocation: vi.fn(),
  createTrustedContext: vi.fn(),
  materializeTrustedContext: vi.fn(),
  issueChildDelegation: vi.fn(),
  revokeChildDelegation: vi.fn(),
  readTranscriptDerivation: vi.fn(),
  recheckDerivationSources: vi.fn(),
  recheckDeriveWriteInvocation: vi.fn(),
  recheckExportInvocation: vi.fn(),
  resolveEgressDeliveryFacts: vi.fn(),
  search: vi.fn(),
  write: vi.fn(),
  stageTranscriptExport: vi.fn(),
  activateTranscriptExport: vi.fn(),
  failTranscriptExport: vi.fn(),
  readChildCapabilitySnapshot: vi.fn(),
  stageChildDelegation: vi.fn(),
  activateChildDelegation: vi.fn(),
  revokeChildDelegationRecord: vi.fn(),
  revokeChildDelegationsForGeneration: vi.fn(),
  resolveChildDelegation: vi.fn(),
  recheckMemoryIdentity: vi.fn(),
}));

vi.mock("../plugins/memory-cutover.js", () => ({
  isMemoryIsolationCutoverAgent: () => true,
}));
vi.mock("../plugins/memory-invocation.js", () => ({
  MEMORY_INVOCATION_UNAVAILABLE: { unavailable: true },
  collectAuthorizedMemoryDerivationSources: mocks.collectDerivation,
  commitAuthorizedMemoryDerivationForInvocation: mocks.commitDerivation,
  createAuthorizedMemoryDeriveInvocation: mocks.createDeriveInvocation,
  createAuthorizedMemoryExportInvocation: mocks.createExportInvocation,
  createAuthorizedMemoryReadInvocation: vi.fn(),
  createAuthorizedMemoryWriteInvocation: mocks.createWriteInvocation,
  issueAuthorizedMemoryChildDelegationForInvocation: mocks.issueChildDelegation,
  materializeAuthorizedMemoryVirtualView: vi.fn(),
  readAuthorizedMemoryVirtualFile: vi.fn(),
  readAuthorizedMemoryForInvocation: vi.fn(),
  recheckAuthorizedMemoryDerivationSources: mocks.recheckDerivationSources,
  recheckAuthorizedMemoryDeriveWriteInvocation: mocks.recheckDeriveWriteInvocation,
  recheckAuthorizedMemoryExportInvocation: mocks.recheckExportInvocation,
  searchAuthorizedMemoryForInvocation: mocks.search,
  revokeAuthorizedMemoryChildDelegationForInvocation: mocks.revokeChildDelegation,
  writeAuthorizedMemoryForInvocation: mocks.write,
}));
vi.mock("../config/sessions/session-transcript-memory-policy.js", () => ({
  captureAuthorizedTranscriptExportSource: mocks.captureTranscriptExport,
  readAuthorizedTranscriptDerivation: mocks.readTranscriptDerivation,
}));
vi.mock("../state/memory-transcript-export-ledger.js", () => ({
  activateTranscriptExportArtifact: mocks.activateTranscriptExport,
  failTranscriptExportArtifact: mocks.failTranscriptExport,
  stageTranscriptExportArtifact: mocks.stageTranscriptExport,
}));
vi.mock("../state/openclaw-agent-db.js", () => ({
  openOpenClawAgentDatabase: () => ({ db: { kind: "agent-db" } }),
}));
vi.mock("../state/memory-access-context.js", () => ({
  captureTrustedMemoryAccessFacts: (facts: unknown) => facts,
  createTrustedMemoryAccessContext: mocks.createTrustedContext,
  materializeTrustedMemoryAccessContext: mocks.materializeTrustedContext,
}));
vi.mock("../state/memory-child-delegation.js", () => ({
  readMemoryChildTaskCapabilitySnapshot: mocks.readChildCapabilitySnapshot,
  stageMemoryChildDelegation: mocks.stageChildDelegation,
  activateMemoryChildDelegation: mocks.activateChildDelegation,
  revokeMemoryChildDelegation: mocks.revokeChildDelegationRecord,
  revokeMemoryChildDelegationsForChildGeneration: mocks.revokeChildDelegationsForGeneration,
  resolveActiveMemoryChildDelegation: mocks.resolveChildDelegation,
}));
vi.mock("../state/memory-identity.js", () => ({
  recheckMemoryIdentityBinding: mocks.recheckMemoryIdentity,
}));
vi.mock("../state/memory-session-subject.js", () => ({
  createCurrentMemorySessionContext: mocks.currentSession,
}));
vi.mock("./memory-egress-admission.js", () => ({
  resolveMemoryEgressDeliveryFacts: mocks.resolveEgressDeliveryFacts,
}));

import {
  admitAuthorizedMemoryDerivation,
  createAuthorizedMemoryDerivationHost,
  createAuthorizedMemoryReadHost,
  prepareAuthorizedMemoryBackgroundDerivationHost,
  prepareAuthorizedSealedCompactionHost,
  prepareAuthorizedTranscriptExportHost,
  prepareAuthorizedTranscriptDerivationHost,
  revokeAuthorizedMemoryChildDelegationsForChildGeneration,
  resolveAuthorizedMemoryVirtualFileBroker,
  stageAuthorizedMemoryChildDelegation,
} from "./memory-authorized-read-host.js";

describe("admitAuthorizedMemoryDerivation", () => {
  beforeEach(() => {
    mocks.collectDerivation.mockReset();
    mocks.captureTranscriptExport.mockReset();
    mocks.createDeriveInvocation.mockReset();
    mocks.createExportInvocation.mockReset();
    mocks.commitDerivation.mockReset();
    mocks.currentSession.mockReset();
    mocks.createWriteInvocation.mockReset();
    mocks.createTrustedContext.mockReset();
    mocks.materializeTrustedContext.mockReset();
    mocks.issueChildDelegation.mockReset();
    mocks.revokeChildDelegation.mockReset();
    mocks.readTranscriptDerivation.mockReset();
    mocks.recheckDerivationSources.mockReset();
    mocks.recheckDeriveWriteInvocation.mockReset();
    mocks.recheckExportInvocation.mockReset();
    mocks.resolveEgressDeliveryFacts.mockReset();
    mocks.search.mockReset();
    mocks.write.mockReset();
    mocks.stageTranscriptExport.mockReset();
    mocks.activateTranscriptExport.mockReset();
    mocks.failTranscriptExport.mockReset();
    mocks.readChildCapabilitySnapshot.mockReset();
    mocks.stageChildDelegation.mockReset();
    mocks.activateChildDelegation.mockReset();
    mocks.revokeChildDelegationRecord.mockReset();
    mocks.revokeChildDelegationsForGeneration.mockReset();
    mocks.resolveChildDelegation.mockReset();
    mocks.recheckMemoryIdentity.mockReset();
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
    mocks.materializeTrustedContext.mockReturnValue({
      agentId: "main",
      contextId: "parent-context",
      subject: { kind: "user", principalId: "alice" },
      delivery: {
        sinkKind: "channel",
        audiences: [{ kind: "user", id: "alice" }],
        deliveryRevision: "delivery-1",
        egressCapabilityIds: [],
        egressRegistryRevision: "egress-1",
      },
      actor: {
        kind: "principal",
        actorKind: "human",
        principalId: "alice",
        assurance: "gateway-profile",
        evidenceRevision: "identity-1",
      },
      verifiedPrincipals: [],
      collaboration: { kind: "not-applicable" },
    });
    mocks.recheckDeriveWriteInvocation.mockReturnValue(true);
    mocks.recheckExportInvocation.mockResolvedValue(true);
    mocks.resolveEgressDeliveryFacts.mockReturnValue({
      sink: "internal",
      audiences: [{ kind: "agent", id: "main" }],
      deliveryRevision: "delivery-1",
      egressRegistryRevision: "egress-1",
    });
    mocks.recheckMemoryIdentity.mockReturnValue({
      kind: "current",
      binding: {
        principalId: "alice",
        evidenceRevision: "identity-1",
        expiresAt: null,
      },
    });
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

  it("binds a staged child lease to the persisted parent and child generations", async () => {
    const parent = {
      agentId: "main",
      fingerprint: "parent-fingerprint",
      isChildSession: false,
      principalId: "alice",
      bindingId: "binding-alice",
      sessionId: "parent-session",
      sessionKey: "agent:main:direct:alice",
      sessionIdentityRevision: "parent-session-revision",
      subjectRevision: "parent-subject-revision",
      authorityRevision: "parent-authority-revision",
      subject: { kind: "user" as const, principalId: "alice" },
    };
    const child = {
      agentId: "main",
      fingerprint: "child-fingerprint",
      isChildSession: true,
      principalId: "agent:child",
      sessionId: "child-session",
      sessionKey: "agent:main:subagent:child",
      sessionIdentityRevision: "child-session-revision",
      subjectRevision: "child-subject-revision",
      authorityRevision: "child-authority-revision",
      subject: { kind: "agent" as const, principalId: "agent:child" },
    };
    mocks.currentSession.mockImplementation(({ sessionKey }: { sessionKey: string }) => ({
      kind: "current",
      context: sessionKey === parent.sessionKey ? parent : child,
    }));
    mocks.readChildCapabilitySnapshot.mockReturnValue("mcap1_child-tools");
    mocks.issueChildDelegation.mockResolvedValue({
      version: 1,
      storeCapToken: "mchildcap1_opaque",
      parentMemoryPlanId: "memory-plan-1",
    });
    const staged = {
      delegationId: "mchild1_grant",
      childSessionKey: child.sessionKey,
      childSessionId: child.sessionId,
      childSessionIdentityRevision: child.sessionIdentityRevision,
    };
    mocks.stageChildDelegation.mockReturnValue(staged);
    mocks.activateChildDelegation.mockReturnValue(true);

    const lease = await stageAuthorizedMemoryChildDelegation({
      agentId: "main",
      parentSessionKey: parent.sessionKey,
      parentSessionId: parent.sessionId,
      childSessionKey: child.sessionKey,
      childSessionId: child.sessionId,
      childSessionIdentityRevision: child.sessionIdentityRevision,
      expiresAt: Date.now() + 60_000,
    });

    expect(lease).toBeDefined();
    expect(mocks.stageChildDelegation).toHaveBeenCalledWith(
      expect.objectContaining({
        parent,
        child,
        delegation: expect.objectContaining({
          rootPrincipalId: "alice",
          capabilitySnapshotId: "mcap1_child-tools",
          allowedOperations: ["read"],
        }),
      }),
    );
    await expect(lease?.activate()).resolves.toBe(true);
    expect(mocks.activateChildDelegation).toHaveBeenCalledWith({
      delegation: staged,
      options: { agentId: "main" },
    });

    await lease?.revoke();
    expect(mocks.revokeChildDelegationRecord).toHaveBeenCalledWith({
      delegation: staged,
      options: { agentId: "main" },
    });
    expect(mocks.revokeChildDelegation).toHaveBeenCalledWith({
      agentId: "main",
      storeCapToken: "mchildcap1_opaque",
    });
  });

  it("closes core child grants by exact generation before best-effort backend revocation", async () => {
    mocks.revokeChildDelegationsForGeneration.mockReturnValue(["mchildcap1_opaque"]);
    mocks.revokeChildDelegation.mockResolvedValue(undefined);

    revokeAuthorizedMemoryChildDelegationsForChildGeneration({
      agentId: "main",
      childSessionKey: "agent:main:subagent:child",
      childSessionId: "child-session",
      childSessionIdentityRevision: "child-session-revision",
    });
    await Promise.resolve();

    expect(mocks.revokeChildDelegationsForGeneration).toHaveBeenCalledWith({
      agentId: "main",
      childSessionKey: "agent:main:subagent:child",
      childSessionId: "child-session",
      childSessionIdentityRevision: "child-session-revision",
      options: { agentId: "main" },
    });
    expect(mocks.revokeChildDelegation).toHaveBeenCalledWith({
      agentId: "main",
      storeCapToken: "mchildcap1_opaque",
    });
    expect(
      mocks.revokeChildDelegationsForGeneration.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.revokeChildDelegation.mock.invocationCallOrder[0] ?? Infinity);
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

  it("does not attach the generic virtual-file broker to a derive host", async () => {
    mocks.createDeriveInvocation.mockResolvedValue({});

    const host = createAuthorizedMemoryDerivationHost({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      runId: "run-1",
    });

    await expect(resolveAuthorizedMemoryVirtualFileBroker(host)).resolves.toBeUndefined();
    expect(mocks.createDeriveInvocation).not.toHaveBeenCalled();
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

  it("gives an operational background derivation only an internal agent audience", async () => {
    mocks.createDeriveInvocation.mockResolvedValue({});

    await expect(
      prepareAuthorizedMemoryBackgroundDerivationHost({
        agentId: "main",
        sessionKey: "agent:main:cron:memory-dreaming",
        sessionId: "cron-session",
        purpose: "dreaming",
      }),
    ).resolves.toBeDefined();

    expect(mocks.resolveEgressDeliveryFacts).not.toHaveBeenCalled();
    expect(mocks.createTrustedContext).toHaveBeenCalledWith(
      expect.objectContaining({
        facts: expect.objectContaining({
          delivery: expect.objectContaining({
            sink: "internal",
            audiences: [{ kind: "agent", id: "main" }],
            egressCapabilityIds: [],
            egressRegistryRevision: "mer1_internal-no-egress",
          }),
        }),
      }),
    );
  });

  it.each(["service", "agent", "system"] as const)(
    "gives a foreground %s host an internal agent audience without resolving egress",
    (subjectKind) => {
      mocks.currentSession.mockReturnValue({
        kind: "current",
        context: {
          agentId: "main",
          fingerprint: `${subjectKind}-session-fingerprint`,
          principalId: `${subjectKind}:main`,
          sessionId: `${subjectKind}-session`,
          sessionKey: `agent:main:${subjectKind}:session`,
          authorityRevision: `${subjectKind}-authority-1`,
          subject: { kind: subjectKind, principalId: `${subjectKind}:main` },
        },
      });
      mocks.resolveEgressDeliveryFacts.mockReset();

      expect(
        createAuthorizedMemoryReadHost({
          agentId: "main",
          sessionKey: `agent:main:${subjectKind}:session`,
          sessionId: `${subjectKind}-session`,
          runId: "run-1",
        }),
      ).toBeDefined();

      expect(mocks.resolveEgressDeliveryFacts).not.toHaveBeenCalled();
      expect(mocks.createTrustedContext).toHaveBeenCalledWith(
        expect.objectContaining({
          facts: expect.objectContaining({
            delivery: expect.objectContaining({
              sink: "internal",
              audiences: [{ kind: "agent", id: "main" }],
              egressCapabilityIds: [],
              egressRegistryRevision: "mer1_internal-no-egress",
            }),
          }),
        }),
      );
    },
  );

  it("rechecks background derivation sources through the host-owned invocation", async () => {
    const invocation = {};
    mocks.createDeriveInvocation.mockResolvedValue(invocation);
    mocks.recheckDerivationSources.mockResolvedValue(true);

    const host = await prepareAuthorizedMemoryBackgroundDerivationHost({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      runId: "run-1",
      purpose: "dreaming",
    });

    await expect(host?.recheckSources()).resolves.toBe(true);
    expect(mocks.recheckDerivationSources).toHaveBeenCalledWith({ invocation });
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

  it("rejects transcript source drift before the flush model dispatches", async () => {
    const invocation = {};
    const original = {
      eventSeqs: [0, 1],
      sourcePolicySetId: "policy-set-1",
      deliveryAudiencesJson: '[{"kind":"user","id":"alice"}]',
    };
    mocks.readTranscriptDerivation
      .mockReturnValueOnce(original)
      .mockReturnValueOnce({ ...original, sourcePolicySetId: "policy-set-revoked" });
    mocks.createWriteInvocation.mockResolvedValue(invocation);

    const host = await prepareAuthorizedTranscriptDerivationHost({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      runId: "run-1",
    });

    await expect(host?.recheckBeforeModel()).resolves.toBe(false);
    expect(mocks.recheckDeriveWriteInvocation).toHaveBeenCalledWith({ invocation });
  });

  it("rejects a changed transcript source before sealed compaction dispatches", async () => {
    const invocation = {};
    const original = {
      eventSeqs: [0, 1],
      sourcePolicySetId: "policy-set-a",
      deliveryAudiencesJson: '[{"kind":"user","id":"alice"}]',
    };
    mocks.readTranscriptDerivation
      .mockReturnValueOnce(original)
      .mockReturnValueOnce({ ...original, sourcePolicySetId: "policy-set-b" });
    mocks.createWriteInvocation.mockResolvedValue(invocation);

    const host = await prepareAuthorizedSealedCompactionHost({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      runId: "run-1",
    });

    await expect(host?.recheckBeforeModel()).resolves.toBe(false);
    expect(mocks.recheckDeriveWriteInvocation).toHaveBeenCalledWith({ invocation });
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

describe("prepareAuthorizedTranscriptExportHost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.recheckExportInvocation.mockResolvedValue(true);
  });

  function source(overrides: Record<string, unknown> = {}) {
    return {
      eventSeqs: [7],
      eventJsons: [
        JSON.stringify({
          type: "message",
          id: "entry-7",
          timestamp: "2026-08-20T00:00:00.000Z",
          message: { role: "user", content: "authorized" },
        }),
      ],
      eventHashes: ["event-hash"],
      sourcePolicySetId: "policy-set-1",
      deliveryAudiencesJson: '[{"kind":"user","id":"alice"}]',
      contentHash: "source-hash",
      sourceEvidence: [
        {
          eventSeq: 7,
          sourceEventSeq: 7,
          sourceSessionId: "session-1",
          sessionIdentityRevision: "session-revision-1",
          subjectRevision: "subject-revision-1",
          runExposureRevision: 2,
          runExposureSetId: "exposure-set-1",
          actorEvidenceJson: '{"kind":"principal"}',
          delegationSnapshotJson: '{"kind":"none"}',
          exposedResourceRevisionsJson: "[]",
          exposureReceiptIdsJson: "[]",
          egressReceiptIdsJson: "[]",
        },
      ],
      ...overrides,
    };
  }

  it("captures one authorized source, stages immutable lineage, and rechecks around publication", async () => {
    const invocation = {};
    const capturedSource = source();
    const artifact = {
      exportId: "mexp1_export",
      artifactContentHash: "artifact-hash",
      artifactType: "session-html" as const,
    };
    mocks.createExportInvocation.mockResolvedValue(invocation);
    mocks.captureTranscriptExport.mockReturnValue(capturedSource);
    mocks.stageTranscriptExport.mockReturnValue(artifact);
    mocks.activateTranscriptExport.mockReturnValue(true);

    const host = await prepareAuthorizedTranscriptExportHost({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      runId: "run-1",
    });

    expect(host?.eventJsons).toEqual(capturedSource.eventJsons);
    await expect(host?.recheckBeforeSerialization()).resolves.toBe(true);
    const staged = await host?.stage({
      artifactContentHash: "artifact-hash",
      artifactType: "session-html",
    });
    await expect(
      host?.publish({ artifact: staged!, write: async () => "published" }),
    ).resolves.toBe("published");

    expect(mocks.createExportInvocation).toHaveBeenCalledWith({ context: { trusted: true } });
    expect(mocks.stageTranscriptExport).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactContentHash: "artifact-hash",
        artifactType: "session-html",
        sessionId: "session-1",
        source: capturedSource,
      }),
    );
    expect(mocks.recheckExportInvocation).toHaveBeenCalledWith({ invocation });
    expect(mocks.activateTranscriptExport).toHaveBeenCalledWith({
      artifact,
      database: { db: { kind: "agent-db" } },
    });
    expect(mocks.failTranscriptExport).not.toHaveBeenCalled();
  });

  it("refuses to serialize when the captured event source drifts", async () => {
    mocks.createExportInvocation.mockResolvedValue({});
    mocks.captureTranscriptExport
      .mockReturnValueOnce(source())
      .mockReturnValueOnce(source({ contentHash: "changed-source-hash" }));

    const host = await prepareAuthorizedTranscriptExportHost({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      runId: "run-1",
    });

    await expect(host?.recheckBeforeSerialization()).resolves.toBe(false);
  });

  it("records authorization loss when publication staging detects source drift", async () => {
    const invocation = {};
    const artifact = {
      exportId: "mexp1_export",
      artifactContentHash: "artifact-hash",
      artifactType: "session-html" as const,
    };
    mocks.createExportInvocation.mockResolvedValue(invocation);
    mocks.captureTranscriptExport.mockReturnValue(source());
    mocks.stageTranscriptExport.mockReturnValue(artifact);
    mocks.recheckExportInvocation
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const host = await prepareAuthorizedTranscriptExportHost({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      runId: "run-1",
    });
    const staged = await host?.stage({
      artifactContentHash: "artifact-hash",
      artifactType: "session-html",
    });

    await expect(
      host?.publish({
        artifact: staged!,
        write: async ({ recheckBeforePublication }) => {
          await recheckBeforePublication();
          return "published";
        },
      }),
    ).resolves.toBeUndefined();

    expect(mocks.activateTranscriptExport).not.toHaveBeenCalled();
    expect(mocks.failTranscriptExport).toHaveBeenCalledWith({
      artifact,
      database: { db: { kind: "agent-db" } },
      failureReason: "publication-authorization-lost",
    });
  });

  it("keeps a published export successful when authorization changes after its fence", async () => {
    const artifact = {
      exportId: "mexp1_export",
      artifactContentHash: "artifact-hash",
      artifactType: "session-html" as const,
    };
    mocks.createExportInvocation.mockResolvedValue({});
    mocks.captureTranscriptExport.mockReturnValue(source());
    mocks.stageTranscriptExport.mockReturnValue(artifact);
    mocks.activateTranscriptExport.mockReturnValue(true);
    mocks.recheckExportInvocation
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const host = await prepareAuthorizedTranscriptExportHost({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      runId: "run-1",
    });
    const staged = await host?.stage({
      artifactContentHash: "artifact-hash",
      artifactType: "session-html",
    });

    await expect(
      host?.publish({
        artifact: staged!,
        write: async ({ recheckBeforePublication }) => {
          await recheckBeforePublication();
          return "published";
        },
      }),
    ).resolves.toBe("published");

    expect(mocks.recheckExportInvocation).toHaveBeenCalledTimes(3);
    expect(mocks.activateTranscriptExport).toHaveBeenCalledWith({
      artifact,
      database: { db: { kind: "agent-db" } },
    });
    expect(mocks.failTranscriptExport).not.toHaveBeenCalled();
  });

  it("does not report a visible export as cancelled when ledger activation is unavailable", async () => {
    const artifact = {
      exportId: "mexp1_export",
      artifactContentHash: "artifact-hash",
      artifactType: "session-html" as const,
    };
    mocks.createExportInvocation.mockResolvedValue({});
    mocks.captureTranscriptExport.mockReturnValue(source());
    mocks.stageTranscriptExport.mockReturnValue(artifact);
    mocks.activateTranscriptExport.mockReturnValue(false);

    const host = await prepareAuthorizedTranscriptExportHost({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: "session-1",
      runId: "run-1",
    });
    const staged = await host?.stage({
      artifactContentHash: "artifact-hash",
      artifactType: "session-html",
    });

    await expect(
      host?.publish({
        artifact: staged!,
        write: async ({ recheckBeforePublication }) => {
          await recheckBeforePublication();
          return "published";
        },
      }),
    ).resolves.toBe("published");

    expect(mocks.failTranscriptExport).not.toHaveBeenCalled();
  });
});
