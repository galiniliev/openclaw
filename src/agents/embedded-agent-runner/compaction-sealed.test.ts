import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitAuthorizedMemoryDerivationMock,
  commitSealedSqliteTranscriptCompactionMock,
  compactWithSafetyTimeoutMock,
  createAgentSessionMock,
  isMemoryIsolationCutoverAgentMock,
  loadCompactHooksHarness,
  prepareAuthorizedSealedCompactionHostMock,
  readAuthorizedTranscriptDerivationMock,
  resolveEmbeddedAgentStreamFnMock,
  resetCompactHooksHarnessMocks,
  sealedCompactionCommitMock,
  sealedCompactionStageMock,
  sessionApplyDeferredCompactionMock,
  sessionAutomaticCompactionMock,
  sessionDeferredCompactionMock,
  sessionDiscardDeferredCompactionMock,
  sessionManualCompactionMock,
} from "./compact.hooks.harness.js";

let compactEmbeddedAgentSessionDirect: typeof import("./compact.js").compactEmbeddedAgentSessionDirect;

beforeAll(async () => {
  ({ compactEmbeddedAgentSessionDirect } = await loadCompactHooksHarness());
});

beforeEach(() => {
  resetCompactHooksHarnessMocks();
});

describe("sealed embedded compaction", () => {
  it("stages and commits the summary before applying its in-memory transcript entry", async () => {
    const source = {
      eventSeqs: [0, 1],
      sourcePolicySetId: "policy-set-1",
      deliveryAudiencesJson: '[{"kind":"user","id":"alice"}]',
    };
    isMemoryIsolationCutoverAgentMock.mockReturnValue(true);
    admitAuthorizedMemoryDerivationMock.mockResolvedValue(true);
    readAuthorizedTranscriptDerivationMock.mockReturnValue(source);
    prepareAuthorizedSealedCompactionHostMock.mockResolvedValue({
      source: { kind: "transcript", sessionId: "session-1", ...source },
      recheckBeforeModel: vi.fn(async () => true),
      stage: sealedCompactionStageMock,
    });

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "agent:main:session-1",
      sessionTarget: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: "/tmp/sessions.json",
      },
      workspaceDir: "/tmp",
      provider: "openai",
      model: "gpt-5.5",
      enqueue: async <T>(task: () => Promise<T> | T) => await task(),
    });

    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(sessionDeferredCompactionMock).toHaveBeenCalledOnce();
    expect(sessionManualCompactionMock).not.toHaveBeenCalled();
    expect(sessionAutomaticCompactionMock).not.toHaveBeenCalled();
    expect(sealedCompactionStageMock).toHaveBeenCalledWith("summary");
    expect(commitSealedSqliteTranscriptCompactionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ id: "sealed-compaction-entry", summary: "summary" }),
        source,
        checkpoint: expect.objectContaining({
          preCompaction: expect.objectContaining({ entryId: "entry-1" }),
          postCompaction: expect.objectContaining({ entryId: "sealed-compaction-entry" }),
        }),
      }),
    );
    expect(sealedCompactionCommitMock).toHaveBeenCalledWith(
      expect.objectContaining({ compactionPolicyId: expect.any(String), eventSeq: 7 }),
    );
    expect(sessionApplyDeferredCompactionMock).toHaveBeenCalledOnce();
    expect(sessionDiscardDeferredCompactionMock).not.toHaveBeenCalled();
  });

  it("rechecks each sealed compaction model dispatch after the prepared source changes", async () => {
    const source = {
      eventSeqs: [0, 1],
      sourcePolicySetId: "policy-set-a",
      deliveryAudiencesJson: '[{"kind":"user","id":"alice"}]',
    };
    const recheckBeforeModel = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const providerStream = vi.fn();
    isMemoryIsolationCutoverAgentMock.mockReturnValue(true);
    admitAuthorizedMemoryDerivationMock.mockResolvedValue(true);
    readAuthorizedTranscriptDerivationMock.mockReturnValue(source);
    resolveEmbeddedAgentStreamFnMock.mockReturnValue(providerStream);
    prepareAuthorizedSealedCompactionHostMock.mockResolvedValue({
      source: { kind: "transcript", sessionId: "session-1", ...source },
      recheckBeforeModel,
      stage: sealedCompactionStageMock,
    });
    const { session } = await createAgentSessionMock();
    const compactDeferred = session.compactDeferred;
    session.compactDeferred = vi.fn(async (...args) => {
      await session.agent.streamFn({} as never, {} as never, {});
      await session.agent.streamFn({} as never, {} as never, {});
      return await compactDeferred(...args);
    });
    createAgentSessionMock.mockResolvedValue({ session });

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "agent:main:session-1",
      sessionTarget: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: "/tmp/sessions.json",
      },
      workspaceDir: "/tmp",
      provider: "openai",
      model: "gpt-5.5",
      enqueue: async <T>(task: () => Promise<T> | T) => await task(),
    });

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: expect.stringContaining("compaction transcript derivation authorization unavailable"),
    });
    expect(recheckBeforeModel).toHaveBeenCalledTimes(2);
    expect(providerStream).toHaveBeenCalledOnce();
    expect(compactWithSafetyTimeoutMock).toHaveBeenCalledOnce();
    expect(sessionDeferredCompactionMock).not.toHaveBeenCalled();
    expect(sealedCompactionStageMock).not.toHaveBeenCalled();
    expect(commitSealedSqliteTranscriptCompactionMock).not.toHaveBeenCalled();
  });
});
