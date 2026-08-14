import { afterEach, describe, expect, it, vi } from "vitest";

const sessionContextMock = vi.hoisted(() => vi.fn());

vi.mock("../state/memory-session-subject.js", () => ({
  createCurrentMemorySessionContext: sessionContextMock,
}));

import {
  admitMemoryPostboxTurnIngress,
  mintMemoryPostboxTurnCapability,
  resetMemoryPostboxTurnCapabilitiesForTest,
  resolveMemoryPostboxTurnCapability,
  resolveMemoryPostboxTargetPrincipal,
  revokeMemoryPostboxTurnCapability,
} from "./memory-postbox-turn-capability.js";

describe("memory postbox turn capability", () => {
  afterEach(() => {
    resetMemoryPostboxTurnCapabilitiesForTest();
    sessionContextMock.mockReset();
  });

  function admittedUserContext() {
    return {
      kind: "current" as const,
      context: {
        subject: { kind: "user" as const },
        principalId: "principal-alice",
        fingerprint: "current-user-fingerprint",
      },
    };
  }

  function sourceContext(sourceTurnId = "channel-user:v1:source-1") {
    const context = {};
    admitMemoryPostboxTurnIngress({
      context,
      agentId: "main",
      sessionKey: "agent:main:group:team",
      sessionId: "session-1",
      provider: "telegram",
      inputProvenance: { kind: "external_user" },
      sourceTurnId,
      sourceChannelRef: "telegram:account:team",
      senderEvidenceRef: "telegram:sender-alice",
    });
    return context;
  }

  it("binds trusted source evidence to one live agent run and session", () => {
    sessionContextMock.mockReturnValue(admittedUserContext());
    const token = mintMemoryPostboxTurnCapability({
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:group:team",
      sessionId: "session-1",
      sourceContext: sourceContext(),
      nowMs: 100,
      ttlMs: 1_000,
    });

    expect(
      resolveMemoryPostboxTurnCapability({
        token,
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:group:team",
        sessionId: "session-1",
        nowMs: 101,
      }),
    ).toEqual({
      sourceTurnId: "channel-user:v1:source-1",
      sourceChannelRef: "telegram:account:team",
      senderEvidenceRef: "telegram:sender-alice",
      targetPrincipalId: "principal-alice",
    });
    for (const mismatch of [
      {
        agentId: "other",
        runId: "run-1",
        sessionKey: "agent:main:group:team",
        sessionId: "session-1",
      },
      {
        agentId: "main",
        runId: "run-2",
        sessionKey: "agent:main:group:team",
        sessionId: "session-1",
      },
      {
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:group:other",
        sessionId: "session-1",
      },
      {
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:group:team",
        sessionId: "session-2",
      },
    ]) {
      expect(
        resolveMemoryPostboxTurnCapability({ token, ...mismatch, nowMs: 101 }),
      ).toBeUndefined();
    }
    expect(
      resolveMemoryPostboxTurnCapability({
        token,
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:group:team",
        sessionId: "session-1",
        nowMs: 1_100,
      }),
    ).toBeUndefined();
  });

  it("cannot be redeemed after explicit terminal revocation", () => {
    sessionContextMock.mockReturnValue(admittedUserContext());
    const token = mintMemoryPostboxTurnCapability({
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:group:team",
      sessionId: "session-1",
      sourceContext: sourceContext(),
    });
    expect(revokeMemoryPostboxTurnCapability(token)).toBe(true);
    expect(
      resolveMemoryPostboxTurnCapability({
        token,
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:group:team",
        sessionId: "session-1",
      }),
    ).toBeUndefined();
  });

  it("requires a private ingress source marker and rechecks the current user subject", () => {
    sessionContextMock.mockReturnValue(admittedUserContext());
    expect(
      mintMemoryPostboxTurnCapability({
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:direct:alice",
        sessionId: "session-1",
        sourceContext: {},
      }),
    ).toBeUndefined();

    const source = {};
    admitMemoryPostboxTurnIngress({
      context: source,
      agentId: "main",
      sessionKey: "agent:main:direct:alice",
      sessionId: "session-1",
      provider: "telegram",
      inputProvenance: { kind: "external_user" },
      sourceTurnId: "channel-user:v1:direct-alice",
      sourceChannelRef: "telegram:account:alice",
      senderEvidenceRef: "telegram:sender-alice",
    });
    const token = mintMemoryPostboxTurnCapability({
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:direct:alice",
      sessionId: "session-1",
      sourceContext: source,
    });
    expect(token).toEqual(expect.any(String));
    sessionContextMock.mockReturnValue({
      kind: "current",
      context: {
        subject: { kind: "user" },
        principalId: "principal-alice",
        fingerprint: "rebound-user-fingerprint",
      },
    });

    expect(
      resolveMemoryPostboxTurnCapability({
        token,
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:direct:alice",
        sessionId: "session-1",
      }),
    ).toBeUndefined();
  });

  it("binds provenance to the exact admitted external-user context and session", () => {
    sessionContextMock.mockReturnValue(admittedUserContext());
    const source = sourceContext();
    expect(
      mintMemoryPostboxTurnCapability({
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:group:team",
        sessionId: "session-1",
        sourceContext: source,
      }),
    ).toEqual(expect.any(String));

    for (const context of [{ ...source }, {}]) {
      expect(
        mintMemoryPostboxTurnCapability({
          agentId: "main",
          runId: "run-2",
          sessionKey: "agent:main:group:team",
          sessionId: "session-1",
          sourceContext: context,
        }),
      ).toBeUndefined();
    }
    expect(
      mintMemoryPostboxTurnCapability({
        agentId: "main",
        runId: "run-2",
        sessionKey: "agent:main:direct:alice",
        sessionId: "session-1",
        sourceContext: source,
      }),
    ).toBeUndefined();

    const internal = {};
    admitMemoryPostboxTurnIngress({
      context: internal,
      agentId: "main",
      sessionKey: "agent:main:group:team",
      sessionId: "session-1",
      provider: "telegram",
      inputProvenance: { kind: "internal_system", sourceTool: "restart-sentinel" },
      sourceTurnId: "channel-user:v1:restarted",
      sourceChannelRef: "telegram:account:team",
      senderEvidenceRef: "telegram:sender-alice",
    });
    expect(
      mintMemoryPostboxTurnCapability({
        agentId: "main",
        runId: "run-3",
        sessionKey: "agent:main:group:team",
        sessionId: "session-1",
        sourceContext: internal,
      }),
    ).toBeUndefined();

    const missingProvenance = {};
    admitMemoryPostboxTurnIngress({
      context: missingProvenance,
      agentId: "main",
      sessionKey: "agent:main:group:team",
      sessionId: "session-1",
      provider: "telegram",
      inputProvenance: undefined,
      sourceTurnId: "channel-user:v1:unknown-provenance",
      sourceChannelRef: "telegram:account:team",
      senderEvidenceRef: "telegram:sender-alice",
    });
    expect(
      mintMemoryPostboxTurnCapability({
        agentId: "main",
        runId: "run-4",
        sessionKey: "agent:main:group:team",
        sessionId: "session-1",
        sourceContext: missingProvenance,
      }),
    ).toBeUndefined();
  });

  it("selects a postbox target only from the current verified direct-user session", () => {
    sessionContextMock.mockReturnValue(admittedUserContext());

    expect(
      resolveMemoryPostboxTargetPrincipal({
        agentId: "main",
        sessionKey: "agent:main:direct:alice",
        sessionId: "session-1",
      }),
    ).toBe("principal-alice");
    expect(sessionContextMock).toHaveBeenCalledWith({
      sessionKey: "agent:main:direct:alice",
      sessionId: "session-1",
      options: { agentId: "main" },
    });

    sessionContextMock.mockReturnValue({
      kind: "current",
      context: {
        subject: { kind: "conversation" },
        principalId: "conversation-team",
        fingerprint: "conversation-fingerprint",
      },
    });
    expect(
      resolveMemoryPostboxTargetPrincipal({
        agentId: "main",
        sessionKey: "agent:main:group:team",
        sessionId: "session-2",
      }),
    ).toBeUndefined();
  });
});
