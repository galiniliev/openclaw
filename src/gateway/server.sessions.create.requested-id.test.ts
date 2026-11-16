import { beforeEach, expect, test, vi } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntry,
  loadSessionEntryByIdReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
import {
  chatSendOwner,
  requireNonEmptyString,
  setupPersistentSessionCreateTestHarness,
} from "./server.sessions.create.test-support.js";
import { rpcReq } from "./test-helpers.js";

const { createSessionStoreDir, openClient } = setupPersistentSessionCreateTestHarness();
let storePath: string;
beforeEach(async () => {
  ({ storePath } = await createSessionStoreDir());
});
type Created = { key: string; sessionId: string; entry: SessionEntry; runStarted: boolean };

test("sessions.create requested UUID owns its header, readback, and first turn exactly once", async () => {
  const requestedId = "019a4ab1-2cd3-7efa-8abc-1234567890ab";
  const key = `agent:main:ahp:${requestedId}`;
  const { ws } = await openClient();
  using chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
  const message = "Synthetic first input for the requested physical UUID";
  const params = {
    agentId: "main",
    key,
    sessionId: requestedId,
    idempotencyKey: "requested-once",
    message,
  };
  const scope = { agentId: "main", sessionKey: key, sessionId: requestedId, storePath };
  try {
    const first = await rpcReq<Created>(ws, "sessions.create", params);
    expect(first.ok, JSON.stringify(first.error)).toBe(true);
    expect(first.payload).toMatchObject({
      key,
      sessionId: requestedId,
      entry: { sessionId: requestedId },
      runStarted: true,
    });
    await captureSessionControllerSettlement({ scope: storePath, identities: [key, requestedId] });
    expect(loadSessionEntry(scope)?.sessionId).toBe(requestedId);
    expect(loadSessionEntryByIdReadOnly(scope)?.sessionKey).toBe(key);
    const events = await loadTranscriptEvents(scope);
    expect(events[0]).toMatchObject({ type: "session", id: requestedId });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ role: "user", content: message }),
      }),
    );
    expect(await rpcReq(ws, "sessions.describe", { key, agentId: "main" })).toMatchObject({
      ok: true,
      payload: { session: { key, sessionId: requestedId } },
    });
    const history = await rpcReq<{ messages: unknown[] }>(ws, "sessions.get", { key });
    expect(history.ok, JSON.stringify(history.error)).toBe(true);
    expect(JSON.stringify(history.payload?.messages)).toContain(message);
    const retry = await rpcReq<Created>(ws, "sessions.create", params);
    expect(retry.ok, JSON.stringify(retry.error)).toBe(true);
    expect(retry.payload).toEqual(first.payload);
    expect(chatSend).toHaveBeenCalledOnce();
    expect(await loadTranscriptEvents(scope)).toEqual(events);
  } finally {
    await closeGatewayTestWebSocket(ws);
  }
});

test("sessions.create refuses invalid requested UUID modes before creating or dispatching", async () => {
  const requestedId = "019a4ab1-2cd3-7efa-8abc-1234567890ac";
  const key = `agent:main:ahp:${requestedId}`;
  const { ws } = await openClient();
  using chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
  try {
    const parentKey = "agent:main:ahp:requested-id-parent";
    const parent = await rpcReq<Created>(ws, "sessions.create", { key: parentKey });
    expect(parent.ok, JSON.stringify(parent.error)).toBe(true);
    const parentScope = {
      agentId: "main",
      sessionKey: parentKey,
      sessionId: requireNonEmptyString(parent.payload?.sessionId, "parent session ID"),
      storePath,
    };
    const entries = listSessionEntriesReadOnly({ agentId: "main", storePath });
    const parentTranscript = await loadTranscriptEvents(parentScope);
    const invalid: Array<Record<string, unknown>> = [
      { sessionId: "not-a-uuid" },
      { sessionId: requestedId.toUpperCase() },
      { idempotencyKey: undefined },
      { key: undefined },
      { incognito: true },
      { fork: true, parentSessionKey: parentKey },
    ];
    for (const [index, overrides] of invalid.entries()) {
      const result = await rpcReq(ws, "sessions.create", {
        agentId: "main",
        key,
        sessionId: requestedId,
        idempotencyKey: `invalid-requested-${index}`,
        message: "This refused input must never dispatch",
        ...overrides,
      });
      expect(result, JSON.stringify(overrides)).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    }
    expect(listSessionEntriesReadOnly({ agentId: "main", storePath })).toEqual(entries);
    expect(await loadTranscriptEvents(parentScope)).toEqual(parentTranscript);
    expect(chatSend).not.toHaveBeenCalled();
  } finally {
    await closeGatewayTestWebSocket(ws);
  }
});

test("sessions.create requested UUID collisions preserve the original row and first input", async () => {
  const requestedId = "019a4ab1-2cd3-7efa-8abc-1234567890ad";
  const otherId = "019a4ab1-2cd3-7efa-8abc-1234567890ae";
  const key = `agent:main:ahp:${requestedId}`;
  const { ws } = await openClient();
  using chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
  const params = {
    agentId: "main",
    key,
    sessionId: requestedId,
    idempotencyKey: "original-requested",
    message: "Only the original requested UUID input may run",
  };
  const scope = { agentId: "main", sessionKey: key, sessionId: requestedId, storePath };
  try {
    const original = await rpcReq<Created>(ws, "sessions.create", params);
    expect(original.ok, JSON.stringify(original.error)).toBe(true);
    await captureSessionControllerSettlement({ scope: storePath, identities: [key, requestedId] });
    const entries = listSessionEntriesReadOnly({ agentId: "main", storePath });
    const events = await loadTranscriptEvents(scope);
    const collisions = [
      { idempotencyKey: "same-key-same-id" },
      { sessionId: otherId, idempotencyKey: "same-key-new-id" },
      { key: "agent:main:ahp:different-key", idempotencyKey: "same-id-new-key" },
      { sessionId: otherId },
    ];
    for (const overrides of collisions) {
      const result = await rpcReq(ws, "sessions.create", { ...params, ...overrides });
      expect(result, JSON.stringify(overrides)).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    }
    expect(listSessionEntriesReadOnly({ agentId: "main", storePath })).toEqual(entries);
    expect(await loadTranscriptEvents(scope)).toEqual(events);
    expect(loadSessionEntryByIdReadOnly(scope)?.sessionKey).toBe(key);
    expect(chatSend).toHaveBeenCalledOnce();
    const retry = await rpcReq<Created>(ws, "sessions.create", params);
    expect(retry.ok, JSON.stringify(retry.error)).toBe(true);
    expect(retry.payload).toEqual(original.payload);
  } finally {
    await closeGatewayTestWebSocket(ws);
  }
});
