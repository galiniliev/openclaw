import { afterEach, describe, expect, it, vi } from "vitest";

const sessionContextMock = vi.hoisted(() => vi.fn());

vi.mock("../state/memory-session-subject.js", () => ({
  createCurrentMemorySessionContext: sessionContextMock,
}));

import {
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

  it("binds trusted source evidence to one live agent run and session", () => {
    const token = mintMemoryPostboxTurnCapability({
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:group:team",
      sessionId: "session-1",
      sourceChannelRef: "telegram:team",
      sourceMessageRef: "message-1",
      senderEvidenceRef: "sender-evidence-1",
      targetPrincipalId: "principal-alice",
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
      sourceChannelRef: "telegram:team",
      sourceMessageRef: "message-1",
      senderEvidenceRef: "sender-evidence-1",
      targetPrincipalId: "principal-alice",
    });
    for (const mismatch of [
      { agentId: "other", runId: "run-1", sessionKey: "agent:main:group:team", sessionId: "session-1" },
      { agentId: "main", runId: "run-2", sessionKey: "agent:main:group:team", sessionId: "session-1" },
      { agentId: "main", runId: "run-1", sessionKey: "agent:main:group:other", sessionId: "session-1" },
      { agentId: "main", runId: "run-1", sessionKey: "agent:main:group:team", sessionId: "session-2" },
    ]) {
      expect(resolveMemoryPostboxTurnCapability({ token, ...mismatch, nowMs: 101 })).toBeUndefined();
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
    const token = mintMemoryPostboxTurnCapability({
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:group:team",
      sourceChannelRef: "telegram:team",
      sourceMessageRef: "message-1",
      senderEvidenceRef: "sender-evidence-1",
      targetPrincipalId: "principal-alice",
    });
    expect(revokeMemoryPostboxTurnCapability(token)).toBe(true);
    expect(
      resolveMemoryPostboxTurnCapability({
        token,
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:group:team",
      }),
    ).toBeUndefined();
  });

  it("selects a postbox target only from the current verified direct-user session", () => {
    sessionContextMock.mockReturnValue({
      kind: "current",
      context: { subject: { kind: "user" }, principalId: "principal-alice" },
    });

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
      context: { subject: { kind: "conversation" }, principalId: "conversation-team" },
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
