import assert from "node:assert/strict";
import type { RequestFrame } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "./pending-request.js";
import type { GatewayProtocolRequestOptions } from "./protocol-request.js";

function fixture(
  dependencies: Partial<ConstructorParameters<typeof GatewayPendingRequests>[0]> = {},
  onSend?: (frame: RequestFrame) => void,
) {
  let sequence = 0;
  const requests = new GatewayPendingRequests({
    createRequestId: () => `${sequence++}`,
    nowMs: () => Date.now(),
    ...dependencies,
  });
  const frames: string[] = [];
  const sender = {
    send: (raw: string) => {
      frames.push(raw);
      onSend?.(JSON.parse(raw) as RequestFrame);
    },
  };
  const frame = (index = 0) => {
    const raw = frames[index];
    assert(raw);
    return JSON.parse(raw) as RequestFrame;
  };
  const write = (
    params: unknown,
    options: GatewayProtocolRequestOptions = { timeoutMs: 1_000, retainSentResultOnAbort: true },
  ) => requests.request(sender, "chat.send", params, options).catch((error: unknown) => error);
  const accept = (responseTo: RequestFrame, runId: string) =>
    requests.handleResponse({ type: "res", id: responseTo.id, ok: true, payload: { runId } });
  return { requests, sender, frames, frame, write, accept };
}

function expectSettled(requests: GatewayPendingRequests) {
  expect(requests.hasPending).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
}

function refuse(
  requests: GatewayPendingRequests,
  frame: RequestFrame,
  reason: string,
  delay = 250,
) {
  requests.handleResponse({
    type: "res",
    id: frame.id,
    ok: false,
    error: {
      code: "UNAVAILABLE",
      message: "not admitted",
      retryable: true,
      retryAfterMs: delay,
      details: { reason, method: frame.method },
    },
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function refusePlanned(f: ReturnType<typeof fixture>) {
  const request = f.frame();
  f.requests.handleResponse({
    type: "res",
    id: request.id,
    ok: false,
    error: {
      code: "UNAVAILABLE",
      message: "not admitted",
      retryable: true,
      retryAfterMs: 1,
      details: {
        reason: "gateway-planned-handoff",
        method: request.method,
        rollingReleaseId: "release-one",
        handlerNotEntered: true,
      },
    },
  });
}

it("binds a pre-hello read to its new authenticated store before retaining it", async () => {
  const f = fixture();
  f.requests.acceptReconnectIdentity("old-person", "old-store", ["sessions.list"]);
  f.requests.flush(new Error("old connection retired"));
  const result = f.requests.request(
    f.sender,
    "sessions.list",
    undefined,
    { timeoutMs: 1_000 },
    true,
  );
  f.requests.acceptReconnectIdentity("new-person", "new-store", ["sessions.list"]);
  f.requests.releaseHeldRequests(() => true);
  expect(f.frames).toHaveLength(1);
  f.requests.flush(new Error("planned handoff"), true);
  f.requests.acceptReconnectIdentity("new-person", "new-store", ["sessions.list"]);
  expect(f.frames).toHaveLength(2);
  f.accept(f.frame(1), "retained-read");
  await expect(result).resolves.toEqual({ runId: "retained-read" });
  expectSettled(f.requests);
});

it("sends an eligible read during mutation pause and retains it through planned reconnect", async () => {
  const f = fixture();
  f.requests.acceptReconnectIdentity("person", "store", ["sessions.list"]);
  f.requests.setSuspensionPhase("prepared");
  const result = f.requests.request(f.sender, "sessions.list", undefined, { timeoutMs: 1_000 });
  expect(f.frames).toHaveLength(1);
  f.requests.flush(new Error("planned handoff"), true);
  f.requests.acceptReconnectIdentity("person", "store", ["sessions.list"]);
  expect(f.frames).toHaveLength(2);
  f.accept(f.frame(1), "retained-read");
  await expect(result).resolves.toEqual({ runId: "retained-read" });
  f.requests.setSuspensionPhase("accepting");
  expectSettled(f.requests);
});

it("retains only proven non-admitted input through fresh same-principal/same-store reconnect", async () => {
  const f = fixture();
  f.requests.acceptReconnectIdentity("person-device", "logical-store");
  const result = f.write({
    idempotencyKey: "one-input",
    attachments: [{ data: "private-synthetic-file" }],
  });
  refusePlanned(f);
  await vi.advanceTimersByTimeAsync(100);
  f.requests.flush(new Error("old reader retired"), true);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.frames).toHaveLength(1);
  f.requests.acceptReconnectIdentity("person-device", "logical-store");
  f.requests.setSuspensionPhase("accepting");
  expect(f.frames).toHaveLength(2);
  expect(f.frame(1)).toEqual(f.frame());
  f.accept(f.frame(1), "one-run");
  await expect(result).resolves.toEqual({ runId: "one-run" });
  expectSettled(f.requests);
});

it("keeps the original deadline while a non-admitted input waits through handoff", async () => {
  const f = fixture();
  f.requests.acceptReconnectIdentity("person-device", "logical-store");
  const result = f.write({ idempotencyKey: "one-input" }, { timeoutMs: 1_000 });
  refusePlanned(f);
  await vi.advanceTimersByTimeAsync(900);
  f.requests.flush(new Error("reader retired"), true);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({
    name: "GatewayProtocolRequestTimeoutError",
    requestSent: false,
  });
  expect(f.frames).toHaveLength(1);
  expectSettled(f.requests);
});

it("cancels retained non-delivery without a later replay and rejects changed identity", async () => {
  const f = fixture();
  f.requests.acceptReconnectIdentity("person-device", "logical-store");
  const abort = new AbortController();
  const result = f.write(
    { idempotencyKey: "one-input" },
    { timeoutMs: 1_000, signal: abort.signal },
  );
  refusePlanned(f);
  f.requests.flush(new Error("reader retired"), true);
  abort.abort();
  expect(await result).toBeInstanceOf(Error);
  f.requests.acceptReconnectIdentity("person-device", "logical-store");
  f.requests.setSuspensionPhase("accepting");
  expect(f.frames).toHaveLength(1);
  const next = f.write({ idempotencyKey: "another-input" });
  const request = f.frame(1);
  f.requests.handleResponse({
    type: "res",
    id: request.id,
    ok: false,
    error: {
      code: "UNAVAILABLE",
      retryable: true,
      message: "not admitted",
      details: {
        reason: "gateway-planned-handoff",
        method: "chat.send",
        rollingReleaseId: "release-one",
        handlerNotEntered: true,
      },
    },
  });
  f.requests.flush(new Error("reader retired"), true);
  f.requests.acceptReconnectIdentity("another-person", "logical-store");
  expect(await next).toMatchObject({
    message: expect.stringMatching(/identity or logical store changed/),
  });
  expectSettled(f.requests);
});

it("does not retain an unknown write outcome merely because the transport is reconnecting", async () => {
  const f = fixture();
  f.requests.acceptReconnectIdentity("person-device", "logical-store");
  const result = f.write({ idempotencyKey: "unknown-input" });
  f.requests.flush(new Error("connection lost after send"), true);
  expect(await result).toMatchObject({ message: "connection lost after send" });
  f.requests.acceptReconnectIdentity("person-device", "logical-store");
  f.requests.setSuspensionPhase("accepting");
  expect(f.frames).toHaveLength(1);
  expectSettled(f.requests);
});

it("does not reuse a predecessor non-delivery proof after resending the write", async () => {
  const f = fixture();
  f.requests.acceptReconnectIdentity("person-device", "logical-store");
  const result = f.write({ idempotencyKey: "one-input" });
  refusePlanned(f);
  f.requests.flush(new Error("first retirement"), true);
  f.requests.acceptReconnectIdentity("person-device", "logical-store");
  f.requests.setSuspensionPhase("accepting");
  expect(f.frames).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(10);
  expect(f.frames).toHaveLength(2);
  f.requests.flush(new Error("successor lost an unknown result"), true);
  expect(await result).toMatchObject({ message: "successor lost an unknown result" });
  expectSettled(f.requests);
});

it("retries an advertised pure read only across matching current read capability and identity", async () => {
  const f = fixture();
  f.requests.acceptReconnectIdentity("person-device", "logical-store", ["sessions.list"]);
  const result = f.requests.request(f.sender, "sessions.list", {}, { timeoutMs: 1_000 });
  f.requests.flush(new Error("planned reader close"), true);
  f.requests.acceptReconnectIdentity("person-device", "logical-store", ["sessions.list"]);
  f.requests.setSuspensionPhase("accepting");
  expect(f.frames).toHaveLength(2);
  f.requests.handleResponse({
    type: "res",
    id: f.frame(1).id,
    ok: true,
    payload: { sessions: [] },
  });
  await expect(result).resolves.toEqual({ sessions: [] });
  expectSettled(f.requests);
});

it.each(["chat.history", "chat.send"])(
  "repeats an interrupted entered read, never an entered write (%s)",
  async (method) => {
    const f = fixture();
    f.requests.acceptReconnectIdentity("person-device", "logical-store", ["chat.history"]);
    const result = f.requests
      .request(f.sender, method, {}, { timeoutMs: 1_000 })
      .catch((error: unknown) => error);
    const sent = f.frame();
    f.requests.handleResponse({
      type: "res",
      id: sent.id,
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "reader retiring",
        retryable: true,
        details: {
          reason: "gateway-planned-handoff",
          method,
          rollingReleaseId: "same-release",
          handlerNotEntered: false,
          readInterrupted: true,
        },
      },
    });
    f.requests.flush(new Error("old reader retired"), true);
    f.requests.acceptReconnectIdentity("person-device", "logical-store", ["chat.history"]);
    f.requests.setSuspensionPhase("accepting");
    if (method === "chat.history") {
      expect(f.frames).toHaveLength(2);
      f.requests.handleResponse({
        type: "res",
        id: f.frame(1).id,
        ok: true,
        payload: { messages: [] },
      });
      expect(await result).toEqual({ messages: [] });
    } else {
      expect(f.frames).toHaveLength(1);
      expect(await result).toMatchObject({ message: "reader retiring" });
    }
    expectSettled(f.requests);
  },
);

it.each([false, true])(
  "unblocks a ready agent after probing startup, newer pause=%s",
  async (newerPause) => {
    const { requests, frames, frame, write, accept } = fixture();
    const controller = new AbortController();
    const slow = write({ agentId: "slow" }, { timeoutMs: 10_000, signal: controller.signal });
    const ready = write({ agentId: "ready" }, { timeoutMs: 10_000 });
    const [slowRaw, readyRaw] = frames;
    const slowFrame = frame();
    const readyFrame = frame(1);
    refuse(requests, slowFrame, "startup-sidecars", 100);
    refuse(requests, readyFrame, "startup-sidecars", 200);
    await vi.advanceTimersByTimeAsync(100);
    refuse(requests, slowFrame, "gateway-suspending", 250);
    await vi.advanceTimersByTimeAsync(250);
    expect(frames).toEqual([slowRaw, readyRaw, slowRaw, slowRaw]);
    if (newerPause) {
      requests.setSuspensionPhase("draining");
    }
    refuse(requests, slowFrame, "startup-sidecars");
    if (newerPause) {
      expect(frames).toEqual([slowRaw, readyRaw, slowRaw, slowRaw]);
      requests.setSuspensionPhase("accepting");
    }
    expect(frames).toEqual([slowRaw, readyRaw, slowRaw, slowRaw, readyRaw]);
    accept(readyFrame, "ready");
    await expect(ready).resolves.toEqual({ runId: "ready" });
    controller.abort();
    await expect(slow).resolves.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(frames).toHaveLength(5);
    expectSettled(requests);
  },
);

it.each(["announced", "gateway-suspending", "gateway-restarting"])(
  "replays the original write after %s",
  async (pause) => {
    const { requests, frames, frame: readFrame, write, accept } = fixture();
    const result = write({ idempotencyKey: "original", message: "synthetic" });
    const raw = frames[0];
    const frame = readFrame();
    refuse(requests, frame, "startup-sidecars");
    if (pause === "announced") {
      requests.setSuspensionPhase("draining");
    }
    await vi.advanceTimersByTimeAsync(250);
    if (pause !== "announced") {
      expect(frames).toEqual([raw, raw]);
      refuse(requests, frame, pause);
    } else {
      expect(frames).toEqual([raw]);
    }
    expect(requests.hasPending).toBe(true);
    requests.setSuspensionPhase("accepting");
    expect(frames).toEqual(pause === "announced" ? [raw, raw] : [raw, raw, raw]);
    accept(frame, "original");
    await expect(result).resolves.toEqual({ runId: "original" });
    expectSettled(requests);
  },
);

it.each(["waiting", "synchronous refusal", "redispatched", "overdue retry"])(
  "preserves the original deadline through %s",
  async (phase) => {
    let clockOffset = 0;
    const nowMs = () => Date.now() + clockOffset;
    const {
      requests,
      frames,
      frame: readFrame,
      write,
    } = fixture({ nowMs }, (frame) => {
      if (phase === "synchronous refusal") {
        refuse(requests, frame, "startup-sidecars", 2_000);
      }
    });
    const result = write({ idempotencyKey: "original" });
    const frame = readFrame();
    if (phase !== "synchronous refusal") {
      refuse(requests, frame, "startup-sidecars", phase === "waiting" ? 2_000 : 250);
    }
    if (phase === "overdue retry") {
      clockOffset = 1_000;
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({
      code: "CLIENT_TIMEOUT",
      timeoutMs: 1_000,
      requestSent: phase === "redispatched",
    });
    expect(frames).toHaveLength(phase === "redispatched" ? 2 : 1);
    expectSettled(requests);
  },
);

it("settles each retired request once when its timing observer shuts down again", async () => {
  const timings: string[] = [];
  const { requests } = fixture({
    nowMs: () => 0,
    onTiming: ({ method }) => {
      timings.push(method);
      if (timings.length === 1) {
        requests.flush(new Error("nested shutdown"));
      }
    },
  });
  const retired = requests.request({ send: () => {} }, "session.observe", {}, { timeoutMs: null });
  void retired.catch(() => undefined);

  requests.flush(new Error("transport closed"));

  expect(timings).toEqual(["session.observe"]);
  await expect(retired).rejects.toThrow("transport closed");
  expect(requests.hasPending).toBe(false);
});
