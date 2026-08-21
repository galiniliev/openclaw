import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
  type AuthorizedMemoryPlan,
  type AuthorizedMemoryResultEnvelope,
  type AuthorizedMemorySearchResult,
  type AuthorizedMemoryVirtualView,
  type MemoryAccessContext,
} from "../plugin-sdk/memory-authorization.js";
import type {
  AuthorizedMemoryReadInvocation,
  AuthorizedMemoryWriteInvocation,
  MemoryInvocationUnavailable,
} from "./memory-invocation.js";

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  materialize: vi.fn(),
  hydrateExposure: vi.fn(() => true),
  logWarn: vi.fn(),
  persistExposure: vi.fn(() => true),
}));

vi.mock("../state/memory-access-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/memory-access-context.js")>()),
  materializeTrustedMemoryAccessContext: mocks.materialize,
}));

vi.mock("./memory-authorization-runtime.js", () => ({
  admitMemoryAuthorizationReadRuntime: mocks.admit,
  admitMemoryAuthorizationRuntime: mocks.admit,
}));

vi.mock("./memory-run-exposure-ledger.js", () => ({
  hydrateMemoryRunExposureFromLedger: mocks.hydrateExposure,
  persistMemoryRunExposureBeforeContent: mocks.persistExposure,
}));

vi.mock("../logger.js", () => ({
  logWarn: mocks.logWarn,
}));

const {
  MEMORY_INVOCATION_UNAVAILABLE,
  collectAuthorizedMemoryDerivationSources,
  commitAuthorizedMemoryDerivationForInvocation,
  createAuthorizedMemoryDeriveInvocation,
  createAuthorizedMemoryReadInvocation,
  createAuthorizedMemoryWriteInvocation,
  materializeAuthorizedMemoryVirtualView,
  readAuthorizedMemoryVirtualFile,
  readAuthorizedMemoryForInvocation,
  readAuthorizedMemoryRunExposure,
  recheckAuthorizedMemoryDerivationSources,
  searchAuthorizedMemoryForInvocation,
  stageAuthorizedMemorySealedCompactionForInvocation,
  writeAuthorizedMemoryForInvocation,
} = await import("./memory-invocation.js");
const { clearMemoryRunExposureForTest } = await import("./memory-run-exposure.js");

function createContext(): MemoryAccessContext & Readonly<{ operation: "read" }> {
  return {
    version: 1,
    contextId: "context-1",
    contextFingerprint: "fingerprint-1",
    requestId: "request-1",
    runId: "run-1",
    agentId: "main",
    sessionKey: "agent:main:direct:dm",
    sessionId: "session-1",
    sessionIdentityRevision: "session-revision-1",
    subjectRevision: "subject-revision-1",
    subject: {
      version: 1,
      kind: "user",
      principalId: "alice",
      creationEvidence: { kind: "gateway-profile", revision: "binding-1" },
    },
    actor: {
      kind: "principal",
      actorKind: "human",
      principalId: "alice",
      assurance: "gateway-profile",
      evidenceRevision: "binding-1",
    },
    verifiedPrincipals: [
      { principalId: "alice", assurance: "gateway-profile", evidenceRevision: "binding-1" },
    ],
    delivery: {
      sinkKind: "private",
      audiences: [{ kind: "user", id: "alice" }],
      egressCapabilityIds: ["reply.final"],
      egressRegistryRevision: "egress-1",
      deliveryRevision: "delivery-1",
    },
    collaboration: { kind: "not-applicable" },
    verifiedMemberships: [],
    operation: "read",
    hostFactsRevision: "host-1",
  };
}

function createPlan(): AuthorizedMemoryPlan & Readonly<{ operation: "read" }> {
  return {
    version: 1,
    planId: "plan-1",
    contextFingerprint: "fingerprint-1",
    runId: "run-1",
    agentId: "main",
    sessionId: "session-1",
    sessionIdentityRevision: "session-revision-1",
    subjectRevision: "subject-revision-1",
    memoryPolicyRevision: "policy-1",
    deliveryRevision: "delivery-1",
    operation: "read",
    mounts: [],
    bootstrapResourceHandles: [],
    allowedEgressAudiences: [{ kind: "user", id: "alice" }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function createWriteContext(): MemoryAccessContext & Readonly<{ operation: "append" }> {
  return { ...createContext(), operation: "append" };
}

function createWritePlan(): AuthorizedMemoryPlan & Readonly<{ operation: "append" }> {
  return { ...createPlan(), operation: "append" };
}

function createDeriveContext(): MemoryAccessContext & Readonly<{ operation: "derive" }> {
  return { ...createContext(), operation: "derive" };
}

function createDerivePlan(): AuthorizedMemoryPlan & Readonly<{ operation: "derive" }> {
  return { ...createPlan(), operation: "derive" };
}

let receiptSequence = 0;

function createEnvelope<T>(
  value: AuthorizedMemoryResultEnvelope<T>["value"],
  overrides?: Readonly<{
    exposureReceipt?: Partial<AuthorizedMemoryResultEnvelope<T>["exposureReceipt"]>;
    egressReceipt?: Partial<AuthorizedMemoryResultEnvelope<T>["egressReceipt"]>;
  }>,
): AuthorizedMemoryResultEnvelope<T> {
  const receiptSequenceValue = ++receiptSequence;
  return {
    version: 1,
    // The SDK freezes result envelopes at the host boundary; mutable test
    // fixture input is otherwise compatible with that readonly result shape.
    value: value as AuthorizedMemoryResultEnvelope<T>["value"],
    exposureReceipt: {
      version: 1,
      receiptId: `exposure-${receiptSequenceValue}`,
      contextFingerprint: "fingerprint-1",
      planId: "plan-1",
      runId: "run-1",
      runExposureRevision: `run-exposure-${receiptSequenceValue}`,
      sourcePolicySetId: "policy-set-1",
      exposedRevisionHandles: ["revision-1"],
      recordedAt: new Date().toISOString(),
      ...overrides?.exposureReceipt,
    },
    egressReceipt: {
      version: 1,
      receiptId: `egress-${receiptSequenceValue}`,
      contextFingerprint: "fingerprint-1",
      planId: "plan-1",
      runId: "run-1",
      runExposureRevision: `run-exposure-${receiptSequenceValue}`,
      sourcePolicySetId: "policy-set-1",
      allowedAudiences: [{ kind: "user", id: "alice" }],
      deliveryRevision: "delivery-1",
      egressRegistryRevision: "egress-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...overrides?.egressReceipt,
    },
  };
}

function isMemoryInvocationUnavailable(value: unknown): value is MemoryInvocationUnavailable {
  return value === MEMORY_INVOCATION_UNAVAILABLE;
}

function assertMemoryInvocationAvailable(
  value: AuthorizedMemoryReadInvocation | MemoryInvocationUnavailable,
  message?: string,
): asserts value is AuthorizedMemoryReadInvocation;
function assertMemoryInvocationAvailable(
  value: AuthorizedMemoryWriteInvocation | MemoryInvocationUnavailable,
  message?: string,
): asserts value is AuthorizedMemoryWriteInvocation;
function assertMemoryInvocationAvailable(
  value: AuthorizedMemoryVirtualView | MemoryInvocationUnavailable,
  message?: string,
): asserts value is AuthorizedMemoryVirtualView;
function assertMemoryInvocationAvailable(
  value:
    | AuthorizedMemoryReadInvocation
    | AuthorizedMemoryWriteInvocation
    | AuthorizedMemoryVirtualView
    | MemoryInvocationUnavailable,
  message = "fixture failed to create an authorized memory value",
): void {
  expect(value).not.toBe(MEMORY_INVOCATION_UNAVAILABLE);
  if ("unavailable" in value) {
    throw new Error(message);
  }
}

describe("authorized memory read invocation", () => {
  afterEach(() => {
    clearMemoryRunExposureForTest();
    receiptSequence = 0;
    mocks.hydrateExposure.mockReset();
    mocks.hydrateExposure.mockReturnValue(true);
    mocks.logWarn.mockReset();
    mocks.persistExposure.mockReset();
    mocks.persistExposure.mockReturnValue(true);
  });

  it("returns only an unavailable result when backend admission fails", async () => {
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: false, reasonCode: "backend-nonconforming" });

    await expect(
      createAuthorizedMemoryReadInvocation({
        context: {} as never,
        capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES },
      }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
  });

  it("emits fixed diagnostics without memory access facts or backend error content", async () => {
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({
      ok: true,
      runtime: {
        authorize: vi.fn().mockRejectedValue(new Error("private memory error")),
      },
    });

    await expect(
      createAuthorizedMemoryReadInvocation({
        context: {} as never,
        capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES },
      }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);

    expect(mocks.logWarn).toHaveBeenCalledWith(
      "memory invocation unavailable: authorization-failed",
    );
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain("private memory error");
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain("alice");
  });

  it("does not leak a search result unless its current exposure and egress receipts validate", async () => {
    const handle = {
      version: 1 as const,
      handleId: "handle-1",
      planId: "plan-1",
      contextFingerprint: "fingerprint-1",
      resourceRevision: "revision-1",
      policyRevision: "policy-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const result: AuthorizedMemorySearchResult = {
      path: "private/note.md",
      startLine: 1,
      endLine: 1,
      score: 1,
      snippet: "allowed text",
      source: "memory",
      resourceHandle: handle,
    };
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createPlan()),
      searchAuthorized: vi.fn().mockImplementation(async () => createEnvelope([result])),
      readAuthorized: vi
        .fn()
        .mockImplementation(async () =>
          createEnvelope({ text: "allowed text", path: "private/note.md" }),
        ),
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryReadInvocation({
      context: {} as never,
      capability: {
        authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
      },
    });
    assertMemoryInvocationAvailable(invocation);
    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "allowed" }),
    ).resolves.toEqual({
      results: [
        {
          handleId: "handle-1",
          path: "private/note.md",
          startLine: 1,
          endLine: 1,
          score: 1,
          snippet: "allowed text",
          source: "memory",
        },
      ],
    });
    await expect(
      readAuthorizedMemoryForInvocation({ invocation, handleId: "handle-1" }),
    ).resolves.toEqual({ text: "allowed text", path: "private/note.md" });

    runtime.searchAuthorized.mockResolvedValueOnce({
      ...createEnvelope([result]),
      egressReceipt: {
        ...createEnvelope([result]).egressReceipt,
        allowedAudiences: [{ kind: "user", id: "mallory" }],
      },
    });
    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "denied" }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
  });

  it("does not return selected-plugin content or commit a receipt when exposure recording fails", async () => {
    const result: AuthorizedMemorySearchResult = {
      path: "private/note.md",
      startLine: 1,
      endLine: 1,
      score: 1,
      snippet: "private content",
      source: "memory",
      resourceHandle: {
        version: 1,
        handleId: "handle-1",
        planId: "plan-1",
        contextFingerprint: "fingerprint-1",
        resourceRevision: "revision-1",
        policyRevision: "policy-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createPlan()),
      // Receipt time is minted by the backend after authorization, not while the
      // test fixture is assembled before the host admits the invocation.
      searchAuthorized: vi.fn().mockImplementation(() => createEnvelope([result])),
      readAuthorized: vi.fn(),
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });
    mocks.persistExposure.mockReturnValue(false);

    const invocation = await createAuthorizedMemoryReadInvocation({
      context: {} as never,
      capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES },
    });
    assertMemoryInvocationAvailable(invocation);

    const response = await searchAuthorizedMemoryForInvocation({ invocation, query: "private" });

    expect(response).toBe(MEMORY_INVOCATION_UNAVAILABLE);
    expect(JSON.stringify(response)).not.toContain("private content");
    expect(mocks.persistExposure).toHaveBeenCalledOnce();
    expect(readAuthorizedMemoryRunExposure(invocation)).toEqual({
      sourcePolicySetIds: [],
      exposedRevisionHandles: [],
      exposureReceiptIds: [],
      egressReceiptIds: [],
    });
  });

  it("does not return exact-read text or commit its receipt when the ledger write fails", async () => {
    const handle = {
      version: 1 as const,
      handleId: "handle-1",
      planId: "plan-1",
      contextFingerprint: "fingerprint-1",
      resourceRevision: "revision-1",
      policyRevision: "policy-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createPlan()),
      searchAuthorized: vi.fn().mockResolvedValue(
        createEnvelope([
          {
            path: "private/note.md",
            startLine: 1,
            endLine: 1,
            score: 1,
            snippet: "search text",
            source: "memory",
            resourceHandle: handle,
          },
        ]),
      ),
      readAuthorized: vi
        .fn()
        .mockResolvedValue(createEnvelope({ path: "private/note.md", text: "private exact text" })),
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryReadInvocation({
      context: {} as never,
      capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES },
    });
    assertMemoryInvocationAvailable(invocation);
    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "private" }),
    ).resolves.toEqual(
      expect.objectContaining({ results: [expect.objectContaining({ handleId: "handle-1" })] }),
    );
    mocks.persistExposure.mockReturnValue(false);

    const response = await readAuthorizedMemoryForInvocation({ invocation, handleId: "handle-1" });

    expect(response).toBe(MEMORY_INVOCATION_UNAVAILABLE);
    expect(JSON.stringify(response)).not.toContain("private exact text");
    expect(readAuthorizedMemoryRunExposure(invocation)).toEqual({
      sourcePolicySetIds: ["policy-set-1"],
      exposedRevisionHandles: ["revision-1"],
      exposureReceiptIds: ["exposure-1"],
      egressReceiptIds: ["egress-1"],
    });
  });

  it("allows a fresh exact-read receipt after a failed ledger write", async () => {
    const handle = {
      version: 1 as const,
      handleId: "handle-1",
      planId: "plan-1",
      contextFingerprint: "fingerprint-1",
      resourceRevision: "revision-1",
      policyRevision: "policy-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createPlan()),
      searchAuthorized: vi.fn().mockResolvedValue(
        createEnvelope([
          {
            path: "private/note.md",
            startLine: 1,
            endLine: 1,
            score: 1,
            snippet: "search text",
            source: "memory",
            resourceHandle: handle,
          },
        ]),
      ),
      readAuthorized: vi
        .fn()
        .mockImplementation(async () =>
          createEnvelope({ path: "private/note.md", text: "private exact text" }),
        ),
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryReadInvocation({
      context: {} as never,
      capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES },
    });
    assertMemoryInvocationAvailable(invocation);
    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "private" }),
    ).resolves.toEqual(
      expect.objectContaining({ results: [expect.objectContaining({ handleId: "handle-1" })] }),
    );
    mocks.persistExposure.mockReturnValueOnce(false).mockReturnValue(true);

    await expect(
      readAuthorizedMemoryForInvocation({ invocation, handleId: "handle-1" }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
    await expect(
      readAuthorizedMemoryForInvocation({ invocation, handleId: "handle-1" }),
    ).resolves.toEqual({ path: "private/note.md", text: "private exact text" });
    expect(readAuthorizedMemoryRunExposure(invocation)).toEqual({
      sourcePolicySetIds: ["policy-set-1"],
      exposedRevisionHandles: ["revision-1"],
      exposureReceiptIds: ["exposure-1", "exposure-3"],
      egressReceiptIds: ["egress-1", "egress-3"],
    });
  });

  it("allows a fresh receipt after a failed ledger write without retaining the failed attempt", async () => {
    const result = (snippet: string, handleId: string): AuthorizedMemorySearchResult => ({
      path: "private/note.md",
      startLine: 1,
      endLine: 1,
      score: 1,
      snippet,
      source: "memory",
      resourceHandle: {
        version: 1,
        handleId,
        planId: "plan-1",
        contextFingerprint: "fingerprint-1",
        resourceRevision: "revision-1",
        policyRevision: "policy-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createPlan()),
      searchAuthorized: vi
        .fn()
        .mockResolvedValueOnce(createEnvelope([result("first private text", "handle-1")]))
        .mockResolvedValueOnce(createEnvelope([result("retry text", "handle-2")])),
      readAuthorized: vi.fn(),
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });
    mocks.persistExposure.mockReturnValueOnce(false).mockReturnValue(true);

    const invocation = await createAuthorizedMemoryReadInvocation({
      context: {} as never,
      capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES },
    });
    assertMemoryInvocationAvailable(invocation);
    await expect(searchAuthorizedMemoryForInvocation({ invocation, query: "first" })).resolves.toBe(
      MEMORY_INVOCATION_UNAVAILABLE,
    );
    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "retry" }),
    ).resolves.toEqual({
      results: [
        expect.objectContaining({
          handleId: "handle-2",
          snippet: "retry text",
        }),
      ],
    });
    expect(readAuthorizedMemoryRunExposure(invocation)).toEqual({
      sourcePolicySetIds: ["policy-set-1"],
      exposedRevisionHandles: ["revision-1"],
      exposureReceiptIds: ["exposure-2"],
      egressReceiptIds: ["egress-2"],
    });
  });

  it.each([
    {
      name: "has an invalid timestamp",
      recordedAt: "not-a-date",
    },
    {
      name: "was issued before this invocation authorized its plan",
      recordedAt: new Date(0).toISOString(),
    },
  ])("does not leak a search result when its exposure receipt $name", async ({ recordedAt }) => {
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createPlan()),
      searchAuthorized: vi
        .fn()
        .mockResolvedValue(createEnvelope([], { exposureReceipt: { recordedAt } })),
      readAuthorized: vi.fn(),
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryReadInvocation({
      context: {} as never,
      capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES },
    });
    assertMemoryInvocationAvailable(invocation);
    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "private" }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
  });

  it("does not leak a search result from an unsupported result-envelope version", async () => {
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createPlan()),
      searchAuthorized: vi.fn().mockResolvedValue({
        ...createEnvelope([]),
        version: 2,
      }),
      readAuthorized: vi.fn(),
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryReadInvocation({
      context: {} as never,
      capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES },
    });
    assertMemoryInvocationAvailable(invocation);

    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "private" }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
    expect(readAuthorizedMemoryRunExposure(invocation)).toEqual({
      sourcePolicySetIds: [],
      exposedRevisionHandles: [],
      exposureReceiptIds: [],
      egressReceiptIds: [],
    });
  });

  it("rejects a replayed exposure receipt instead of exposing the repeated result", async () => {
    const handle = {
      version: 1 as const,
      handleId: "handle-1",
      planId: "plan-1",
      contextFingerprint: "fingerprint-1",
      resourceRevision: "revision-1",
      policyRevision: "policy-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const result: AuthorizedMemorySearchResult = {
      path: "private/note.md",
      startLine: 1,
      endLine: 1,
      score: 1,
      snippet: "allowed text",
      source: "memory",
      resourceHandle: handle,
    };
    let replayedEnvelope:
      | AuthorizedMemoryResultEnvelope<AuthorizedMemorySearchResult[]>
      | undefined;
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createPlan()),
      searchAuthorized: vi
        .fn()
        .mockImplementation(async () => (replayedEnvelope ??= createEnvelope([result]))),
      readAuthorized: vi.fn(),
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryReadInvocation({
      context: {} as never,
      capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES },
    });
    assertMemoryInvocationAvailable(invocation);
    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "allowed" }),
    ).resolves.toEqual({
      results: [
        {
          handleId: "handle-1",
          path: "private/note.md",
          startLine: 1,
          endLine: 1,
          score: 1,
          snippet: "allowed text",
          source: "memory",
        },
      ],
    });
    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "replay" }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
  });

  it("keeps multiple authorized results in one fresh receipt envelope", async () => {
    const secondHandle = {
      version: 1 as const,
      handleId: "handle-2",
      planId: "plan-1",
      contextFingerprint: "fingerprint-1",
      resourceRevision: "revision-2",
      policyRevision: "policy-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const results: AuthorizedMemorySearchResult[] = [
      {
        path: "private/one.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "one",
        source: "memory",
        resourceHandle: {
          version: 1,
          handleId: "handle-1",
          planId: "plan-1",
          contextFingerprint: "fingerprint-1",
          resourceRevision: "revision-1",
          policyRevision: "policy-1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
      {
        path: "private/two.md",
        startLine: 1,
        endLine: 1,
        score: 0.9,
        snippet: "two",
        source: "memory",
        resourceHandle: secondHandle,
      },
    ];
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createPlan()),
      searchAuthorized: vi.fn().mockImplementation(async () =>
        createEnvelope(results, {
          exposureReceipt: { exposedRevisionHandles: ["revision-1", "revision-2"] },
        }),
      ),
      readAuthorized: vi.fn(),
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryReadInvocation({
      context: {} as never,
      capability: { authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES },
    });
    assertMemoryInvocationAvailable(invocation);
    await expect(
      searchAuthorizedMemoryForInvocation({ invocation, query: "allowed" }),
    ).resolves.toMatchObject({
      results: [
        { handleId: "handle-1", snippet: "one" },
        { handleId: "handle-2", snippet: "two" },
      ],
    });
  });

  it("binds virtual reads to the admitted provider and exact manifest members", async () => {
    const admittedVirtualView = {
      materializeAuthorizedVirtualView: vi.fn(async () => ({
        version: 1 as const,
        viewId: "view-1",
        planId: "plan-1",
        contextFingerprint: "fingerprint-1",
        revision: "revision-1",
        roots: [
          {
            version: 1 as const,
            mountHandle: "mount-1",
            virtualRoot: "private",
            access: "read" as const,
          },
        ],
        files: [{ version: 1 as const, mountHandle: "mount-1", virtualPath: "private/1.md" }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
      readAuthorizedVirtualFile: vi.fn(async (_params) =>
        createEnvelope({ text: "allowed", path: "memory/private/1.md" }),
      ),
    };
    const plan = {
      ...createPlan(),
      mounts: [
        {
          version: 1 as const,
          agentId: "main",
          mountHandle: "mount-1",
          capabilities: ["read"] as const,
          audienceRevision: "audience-1",
        },
      ],
    };
    const runtime = {
      authorize: vi.fn().mockResolvedValue(plan),
      searchAuthorized: vi.fn(),
      readAuthorized: vi.fn(),
      virtualView: admittedVirtualView,
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryReadInvocation({ context: {} as never });
    assertMemoryInvocationAvailable(invocation, "fixture failed to admit virtual provider");
    const view = await materializeAuthorizedMemoryVirtualView({ invocation });
    assertMemoryInvocationAvailable(view, "fixture failed to materialize virtual view");
    await expect(
      readAuthorizedMemoryVirtualFile({ invocation, view, virtualPath: "private/2.md" }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
    expect(admittedVirtualView.readAuthorizedVirtualFile).not.toHaveBeenCalled();
  });

  it("never materializes a derive invocation through the generic virtual filesystem", async () => {
    const admittedVirtualView = {
      materializeAuthorizedVirtualView: vi.fn(),
      readAuthorizedVirtualFile: vi.fn(),
    };
    const context = {
      ...createContext(),
      operation: "derive" as const,
    };
    const plan = {
      ...createPlan(),
      operation: "derive" as const,
      mounts: [
        {
          version: 1 as const,
          agentId: "main",
          mountHandle: "derive-mount",
          capabilities: ["retrieve", "read", "derive"] as const,
          audienceRevision: "derive-audience",
        },
      ],
    };
    mocks.materialize.mockReturnValue(context);
    mocks.admit.mockResolvedValue({
      ok: true,
      runtime: {
        authorize: vi.fn().mockResolvedValue(plan),
        searchAuthorized: vi.fn(),
        readAuthorized: vi.fn(),
        virtualView: admittedVirtualView,
      },
    });

    const invocation = await createAuthorizedMemoryDeriveInvocation({ context: {} as never });
    if (isMemoryInvocationUnavailable(invocation)) {
      throw new Error("fixture failed to admit derive invocation");
    }

    // JavaScript callers can bypass the opaque TypeScript brand, so prove the
    // runtime boundary still refuses a derive invocation on the generic FS path.
    await expect(
      materializeAuthorizedMemoryVirtualView({
        invocation: invocation as unknown as AuthorizedMemoryReadInvocation,
      }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
    expect(admittedVirtualView.materializeAuthorizedVirtualView).not.toHaveBeenCalled();
  });

  it("rejects malformed duplicate and case-colliding virtual views before any broker read", async () => {
    const admittedVirtualView = {
      materializeAuthorizedVirtualView: vi.fn(async () => ({
        version: 1 as const,
        viewId: "view-duplicate",
        planId: "plan-1",
        contextFingerprint: "fingerprint-1",
        revision: "revision-1",
        roots: [
          {
            version: 1 as const,
            mountHandle: "mount-1",
            virtualRoot: "private",
            access: "read" as const,
          },
        ],
        files: [
          { version: 1 as const, mountHandle: "mount-1", virtualPath: "private/Note.md" },
          { version: 1 as const, mountHandle: "mount-1", virtualPath: "private/note.md" },
        ],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
      readAuthorizedVirtualFile: vi.fn(),
    };
    const runtime = {
      authorize: vi.fn().mockResolvedValue({
        ...createPlan(),
        mounts: [
          {
            version: 1 as const,
            agentId: "main",
            mountHandle: "mount-1",
            capabilities: ["read"] as const,
            audienceRevision: "audience-1",
          },
        ],
      }),
      searchAuthorized: vi.fn(),
      readAuthorized: vi.fn(),
      virtualView: admittedVirtualView,
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryReadInvocation({ context: {} as never });
    if (isMemoryInvocationUnavailable(invocation)) {
      throw new Error("fixture failed to admit virtual provider");
    }
    await expect(materializeAuthorizedMemoryVirtualView({ invocation })).resolves.toBe(
      MEMORY_INVOCATION_UNAVAILABLE,
    );
    expect(admittedVirtualView.readAuthorizedVirtualFile).not.toHaveBeenCalled();
  });

  it("freezes the admitted virtual revision and denies caller-shaped replacement views", async () => {
    const issuedView = {
      version: 1 as const,
      viewId: "view-frozen",
      planId: "plan-1",
      contextFingerprint: "fingerprint-1",
      revision: "revision-1",
      roots: [
        {
          version: 1 as const,
          mountHandle: "mount-1",
          virtualRoot: "private",
          access: "read" as const,
        },
      ],
      files: [{ version: 1 as const, mountHandle: "mount-1", virtualPath: "private/1.md" }],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const admittedVirtualView = {
      materializeAuthorizedVirtualView: vi.fn(async () => issuedView),
      readAuthorizedVirtualFile: vi.fn(async (_params) =>
        createEnvelope({ text: "allowed", path: "memory/private/1.md" }),
      ),
    };
    const runtime = {
      authorize: vi.fn().mockResolvedValue({
        ...createPlan(),
        mounts: [
          {
            version: 1 as const,
            agentId: "main",
            mountHandle: "mount-1",
            capabilities: ["read"] as const,
            audienceRevision: "audience-1",
          },
        ],
      }),
      searchAuthorized: vi.fn(),
      readAuthorized: vi.fn(),
      virtualView: admittedVirtualView,
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryReadInvocation({ context: {} as never });
    assertMemoryInvocationAvailable(invocation, "fixture failed to admit virtual provider");
    const view = await materializeAuthorizedMemoryVirtualView({ invocation });
    assertMemoryInvocationAvailable(view, "fixture failed to materialize virtual view");
    issuedView.revision = "replacement-revision";
    issuedView.files[0]!.virtualPath = "private/replacement.md";

    await expect(
      readAuthorizedMemoryVirtualFile({ invocation, view, virtualPath: "private/1.md" }),
    ).resolves.toEqual({ text: "allowed", path: "memory/private/1.md" });
    await expect(
      readAuthorizedMemoryVirtualFile({
        invocation,
        view: { ...view, revision: "forged-revision" },
        virtualPath: "private/1.md",
      }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
    expect(admittedVirtualView.readAuthorizedVirtualFile).toHaveBeenCalledOnce();
    expect(admittedVirtualView.readAuthorizedVirtualFile).toHaveBeenCalledWith(
      expect.objectContaining({
        view: expect.objectContaining({ revision: "revision-1" }),
        virtualPath: "private/1.md",
      }),
    );
  });

  it("keeps the admitted virtual provider when the mutable runtime registry object is replaced", async () => {
    const admitted = {
      materializeAuthorizedVirtualView: vi.fn(async () => ({
        version: 1 as const,
        viewId: "view-admitted",
        planId: "plan-1",
        contextFingerprint: "fingerprint-1",
        revision: "revision-1",
        roots: [
          {
            version: 1 as const,
            mountHandle: "mount-1",
            virtualRoot: "private",
            access: "read" as const,
          },
        ],
        files: [{ version: 1 as const, mountHandle: "mount-1", virtualPath: "private/1.md" }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
      readAuthorizedVirtualFile: vi.fn(),
    };
    const replacement = {
      materializeAuthorizedVirtualView: vi.fn(),
      readAuthorizedVirtualFile: vi.fn(),
    };
    const runtime = {
      authorize: vi.fn().mockResolvedValue({
        ...createPlan(),
        mounts: [
          {
            version: 1 as const,
            agentId: "main",
            mountHandle: "mount-1",
            capabilities: ["read"] as const,
            audienceRevision: "audience-1",
          },
        ],
      }),
      searchAuthorized: vi.fn(),
      readAuthorized: vi.fn(),
      virtualView: admitted,
    };
    mocks.materialize.mockReturnValue(createContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryReadInvocation({ context: {} as never });
    if (isMemoryInvocationUnavailable(invocation)) {
      throw new Error("fixture failed to admit virtual provider");
    }
    runtime.virtualView = replacement;
    await expect(materializeAuthorizedMemoryVirtualView({ invocation })).resolves.toMatchObject({
      viewId: "view-admitted",
    });
    expect(admitted.materializeAuthorizedVirtualView).toHaveBeenCalledOnce();
    expect(replacement.materializeAuthorizedVirtualView).not.toHaveBeenCalled();
  });
});

describe("authorized resource derivation invocation", () => {
  afterEach(() => {
    clearMemoryRunExposureForTest();
    receiptSequence = 0;
    mocks.admit.mockReset();
    mocks.hydrateExposure.mockReset();
    mocks.hydrateExposure.mockReturnValue(true);
    mocks.materialize.mockReset();
    mocks.persistExposure.mockReset();
    mocks.persistExposure.mockReturnValue(true);
  });

  function createDeriveContext(): MemoryAccessContext & Readonly<{ operation: "derive" }> {
    return { ...createContext(), operation: "derive" };
  }

  function createDerivePlan(
    bootstrapResourceHandles: AuthorizedMemoryPlan["bootstrapResourceHandles"] = [],
  ): AuthorizedMemoryPlan & Readonly<{ operation: "derive" }> {
    return {
      ...createPlan(),
      operation: "derive",
      mounts: [
        {
          version: 1,
          agentId: "main",
          mountHandle: "mount-derive",
          capabilities: ["retrieve", "read", "derive"] as const,
          audienceRevision: "audience-derive",
        },
      ],
      bootstrapResourceHandles,
    };
  }

  function createSourceHandle() {
    return {
      version: 1 as const,
      handleId: "derive-source-1",
      planId: "plan-1",
      contextFingerprint: "fingerprint-1",
      resourceRevision: "revision-1",
      policyRevision: "policy-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  it("rejects a multi-store derive plan before any source operation", async () => {
    const plan = {
      ...createDerivePlan(),
      mounts: [
        ...createDerivePlan().mounts,
        {
          version: 1 as const,
          agentId: "main",
          mountHandle: "mount-second",
          capabilities: ["retrieve", "read", "derive"] as const,
          audienceRevision: "audience-second",
        },
      ],
    };
    const runtime = {
      authorize: vi.fn().mockResolvedValue(plan),
      readAuthorized: vi.fn(),
      searchAuthorized: vi.fn(),
      writeAuthorized: vi.fn(),
    };
    mocks.materialize.mockReturnValue(createDeriveContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    await expect(createAuthorizedMemoryDeriveInvocation({ context: {} as never })).resolves.toBe(
      MEMORY_INVOCATION_UNAVAILABLE,
    );
    expect(runtime.readAuthorized).not.toHaveBeenCalled();
    expect(runtime.searchAuthorized).not.toHaveBeenCalled();
    expect(runtime.writeAuthorized).not.toHaveBeenCalled();
  });

  it("commits exactly the receipt-recorded bootstrap sources without caller policy input", async () => {
    const handle = createSourceHandle();
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createDerivePlan([handle])),
      readAuthorized: vi
        .fn()
        .mockImplementation(async () =>
          createEnvelope({ text: "scoped source", path: "memory/a.md" }),
        ),
      searchAuthorized: vi.fn(),
      writeAuthorized: vi.fn().mockResolvedValue({
        version: 1,
        mutationId: "committed-derive",
        status: "committed",
        policyRevision: "policy-1",
        committedAt: new Date().toISOString(),
      }),
    };
    mocks.materialize.mockReturnValue(createDeriveContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryDeriveInvocation({ context: {} as never });
    if (isMemoryInvocationUnavailable(invocation)) {
      throw new Error("fixture failed to create a derive invocation");
    }
    await expect(collectAuthorizedMemoryDerivationSources({ invocation })).resolves.toEqual([
      { text: "scoped source", path: "memory/a.md" },
    ]);
    expect(runtime.readAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ operation: "derive" }),
        plan: expect.objectContaining({ operation: "derive" }),
      }),
    );
    await expect(
      commitAuthorizedMemoryDerivationForInvocation({
        invocation,
        content: "scoped consolidation",
        purpose: "dreaming",
      }),
    ).resolves.toMatchObject({ status: "committed" });

    expect(runtime.writeAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ operation: "derive" }),
        plan: expect.objectContaining({ planId: "plan-1" }),
        mutation: expect.objectContaining({
          kind: "derive",
          derivationPurpose: "dreaming",
          sourceHandles: [handle],
        }),
      }),
    );
    expect(runtime.writeAuthorized.mock.calls[0]?.[0].mutation).not.toHaveProperty(
      "sourcePolicySetId",
    );
  });

  it("fails source freshness before model dispatch when a recorded source is revoked", async () => {
    const handle = createSourceHandle();
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createDerivePlan([handle])),
      readAuthorized: vi
        .fn()
        .mockResolvedValueOnce(createEnvelope({ text: "scoped source", path: "memory/a.md" }))
        .mockRejectedValueOnce(new Error("source revoked")),
      searchAuthorized: vi.fn(),
      writeAuthorized: vi.fn(),
    };
    mocks.materialize.mockReturnValue(createDeriveContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryDeriveInvocation({ context: {} as never });
    if (isMemoryInvocationUnavailable(invocation)) {
      throw new Error("fixture failed to create a derive invocation");
    }
    const sources = await collectAuthorizedMemoryDerivationSources({ invocation });
    expect(runtime.readAuthorized).toHaveBeenCalledOnce();
    expect(sources).toHaveLength(1);
    await expect(recheckAuthorizedMemoryDerivationSources({ invocation })).resolves.toBe(false);
    expect(runtime.readAuthorized).toHaveBeenCalledTimes(2);
    expect(runtime.writeAuthorized).not.toHaveBeenCalled();
  });

  it("does not write when this derive invocation has exposed no source content", async () => {
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createDerivePlan()),
      readAuthorized: vi.fn(),
      searchAuthorized: vi.fn(),
      writeAuthorized: vi.fn(),
    };
    mocks.materialize.mockReturnValue(createDeriveContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });

    const invocation = await createAuthorizedMemoryDeriveInvocation({ context: {} as never });
    if (isMemoryInvocationUnavailable(invocation)) {
      throw new Error("fixture failed to create a derive invocation");
    }
    await expect(
      commitAuthorizedMemoryDerivationForInvocation({
        invocation,
        content: "must not write",
        purpose: "promotion",
      }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
    expect(runtime.writeAuthorized).not.toHaveBeenCalled();
  });

  it("stages a sealed compaction only through a derive write invocation", async () => {
    const transcriptSource = {
      kind: "transcript" as const,
      sessionId: "session-1",
      eventSeqs: [1],
      sourcePolicySetId: "policy-set-1",
      deliveryAudiencesJson: '[{"kind":"user","id":"alice"}]',
    };
    const staged = {
      resourceRevisionId: "sealed-revision-1",
      commitInTransaction: vi.fn(),
    };
    const deriveRuntime = {
      authorize: vi.fn().mockResolvedValue(createDerivePlan()),
      stageSealedCompaction: vi.fn().mockResolvedValue(staged),
    };
    mocks.materialize.mockReturnValue(createDeriveContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime: deriveRuntime });
    const deriveInvocation = await createAuthorizedMemoryWriteInvocation({ context: {} as never });
    if (isMemoryInvocationUnavailable(deriveInvocation)) {
      throw new Error("fixture failed to create a derive write invocation");
    }
    await expect(
      stageAuthorizedMemorySealedCompactionForInvocation({
        invocation: deriveInvocation,
        content: "sealed summary",
        transcriptSource,
      }),
    ).resolves.toBe(staged);
    expect(deriveRuntime.stageSealedCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ operation: "derive" }),
        plan: expect.objectContaining({ operation: "derive" }),
      }),
    );

    const appendRuntime = {
      authorize: vi.fn().mockResolvedValue(createWritePlan()),
      stageSealedCompaction: vi.fn(),
    };
    mocks.materialize.mockReturnValue(createWriteContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime: appendRuntime });
    const appendInvocation = await createAuthorizedMemoryWriteInvocation({ context: {} as never });
    if (isMemoryInvocationUnavailable(appendInvocation)) {
      throw new Error("fixture failed to create an append write invocation");
    }
    await expect(
      stageAuthorizedMemorySealedCompactionForInvocation({
        invocation: appendInvocation,
        content: "must not stage",
        transcriptSource,
      }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
    expect(appendRuntime.stageSealedCompaction).not.toHaveBeenCalled();
  });
});

describe("authorized memory write invocation", () => {
  afterEach(() => {
    mocks.admit.mockReset();
    mocks.materialize.mockReset();
    mocks.logWarn.mockReset();
  });

  it("uses only a trusted append context and closed mutation DTO for a selected runtime", async () => {
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createWritePlan()),
      writeAuthorized: vi.fn().mockResolvedValue({
        version: 1,
        mutationId: "remember-1",
        status: "committed",
        policyRevision: "policy-1",
        committedAt: new Date().toISOString(),
      }),
    };
    mocks.materialize.mockReturnValue(createWriteContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime });
    const invocation = await createAuthorizedMemoryWriteInvocation({ context: {} as never });
    assertMemoryInvocationAvailable(invocation);
    await expect(
      writeAuthorizedMemoryForInvocation({
        invocation,
        mutation: {
          version: 1,
          kind: "remember",
          mutationId: "remember-1",
          idempotencyKey: "request-1",
          content: "host-selected destination",
          contentType: "markdown",
        },
      }),
    ).resolves.toMatchObject({ status: "committed" });
    expect(runtime.writeAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          operation: "append",
          subject: createWriteContext().subject,
        }),
        mutation: expect.not.objectContaining({
          storeId: expect.anything(),
          ownerId: expect.anything(),
        }),
      }),
    );
    await expect(
      writeAuthorizedMemoryForInvocation({
        invocation,
        mutation: {
          version: 1,
          kind: "derive",
          mutationId: "derive-through-append",
          idempotencyKey: "derive-through-append",
          content: "must not write",
          contentType: "markdown",
          derivationPurpose: "dreaming",
          sourceHandles: [],
        },
      }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
    expect(runtime.writeAuthorized).toHaveBeenCalledTimes(1);
  });

  it("rejects project before a generic model write invocation can reach a runtime", async () => {
    mocks.materialize.mockReturnValue({
      ...createWriteContext(),
      operation: "project",
    } as unknown as MemoryAccessContext);

    await expect(createAuthorizedMemoryWriteInvocation({ context: {} as never })).resolves.toBe(
      MEMORY_INVOCATION_UNAVAILABLE,
    );

    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("never converts a derive writer into an append remember operation", async () => {
    const deriveContext = { ...createContext(), operation: "derive" as const };
    const derivePlan = {
      ...createPlan(),
      operation: "derive" as const,
      mounts: [
        {
          version: 1 as const,
          agentId: "main",
          mountHandle: "derive-mount",
          capabilities: ["retrieve", "read", "derive"] as const,
          audienceRevision: "derive-audience",
        },
      ],
    };
    const runtime = {
      authorize: vi.fn().mockResolvedValue(derivePlan),
      writeAuthorized: vi.fn(),
    };
    mocks.materialize.mockReturnValue(deriveContext);
    mocks.admit.mockResolvedValue({ ok: true, runtime });
    const invocation = await createAuthorizedMemoryWriteInvocation({ context: {} as never });
    if (isMemoryInvocationUnavailable(invocation)) {
      throw new Error("fixture failed to create a derive write invocation");
    }
    await expect(
      writeAuthorizedMemoryForInvocation({
        invocation,
        mutation: {
          version: 1,
          kind: "remember",
          mutationId: "remember-through-derive",
          idempotencyKey: "remember-through-derive",
          content: "must not write",
          contentType: "markdown",
        },
      }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
    expect(runtime.writeAuthorized).not.toHaveBeenCalled();
  });

  it("fails closed after the trusted write facts are no longer current", async () => {
    const context = createWriteContext();
    const runtime = {
      authorize: vi.fn().mockResolvedValue(createWritePlan()),
      writeAuthorized: vi.fn(),
    };
    mocks.materialize.mockReturnValueOnce(context).mockReturnValueOnce(undefined);
    mocks.admit.mockResolvedValue({ ok: true, runtime });
    const invocation = await createAuthorizedMemoryWriteInvocation({ context: {} as never });
    if (isMemoryInvocationUnavailable(invocation)) {
      throw new Error("fixture failed to create a write invocation");
    }
    await expect(
      writeAuthorizedMemoryForInvocation({
        invocation,
        mutation: {
          version: 1,
          kind: "remember",
          mutationId: "remember-stale",
          idempotencyKey: "request-stale",
          content: "must not write",
          contentType: "markdown",
        },
      }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
    expect(runtime.writeAuthorized).not.toHaveBeenCalled();
  });

  it("stages sealed compaction only for a revalidated derive invocation", async () => {
    const artifact = {
      resourceRevisionId: "revision-derive-1",
      commitInTransaction: vi.fn(),
    };
    const deriveRuntime = {
      authorize: vi.fn().mockResolvedValue(createDerivePlan()),
      stageSealedCompaction: vi.fn().mockResolvedValue(artifact),
    };
    mocks.materialize.mockReturnValue(createDeriveContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime: deriveRuntime });
    const deriveInvocation = await createAuthorizedMemoryWriteInvocation({ context: {} as never });
    assertMemoryInvocationAvailable(
      deriveInvocation,
      "fixture failed to create a derive invocation",
    );
    const transcriptSource = {
      kind: "transcript" as const,
      sessionId: "session-1",
      eventSeqs: [1],
      sourcePolicySetId: "policy-set-1",
      deliveryAudiencesJson: '[{"kind":"user","id":"alice"}]',
    };
    await expect(
      stageAuthorizedMemorySealedCompactionForInvocation({
        invocation: deriveInvocation,
        content: "sealed summary",
        transcriptSource,
      }),
    ).resolves.toBe(artifact);
    expect(deriveRuntime.stageSealedCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ operation: "derive" }),
        plan: expect.objectContaining({ operation: "derive" }),
        transcriptSource,
      }),
    );

    const appendRuntime = {
      authorize: vi.fn().mockResolvedValue(createWritePlan()),
      stageSealedCompaction: vi.fn(),
    };
    mocks.materialize.mockReturnValue(createWriteContext());
    mocks.admit.mockResolvedValue({ ok: true, runtime: appendRuntime });
    const appendInvocation = await createAuthorizedMemoryWriteInvocation({ context: {} as never });
    assertMemoryInvocationAvailable(
      appendInvocation,
      "fixture failed to create an append invocation",
    );
    await expect(
      stageAuthorizedMemorySealedCompactionForInvocation({
        invocation: appendInvocation,
        content: "must not stage",
        transcriptSource,
      }),
    ).resolves.toBe(MEMORY_INVOCATION_UNAVAILABLE);
    expect(appendRuntime.stageSealedCompaction).not.toHaveBeenCalled();
  });
});
