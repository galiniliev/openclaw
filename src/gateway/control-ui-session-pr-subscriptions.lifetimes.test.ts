import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ControlUiSessionPullRequests } from "./control-ui-contract.js";
import type { ControlUiSessionPrTarget } from "./control-ui-session-pr-read.js";
import { createTestControlUiSessionPrSubscriptions } from "./control-ui-session-pr-subscriptions.test-support.js";

const CHANGED_EVENT = "controlUi.sessionPullRequests.changed";
const READY: ControlUiSessionPullRequests = { pullRequests: [], rateLimited: false };
let active: ReturnType<typeof createTestControlUiSessionPrSubscriptions> | undefined;

afterEach(async () => {
  await active?.stop();
  active = undefined;
  vi.useRealTimers();
});

describe("recipient publication lifetimes", () => {
  const target: ControlUiSessionPrTarget = {
    params: { sessionKey: "shared", agentId: "main" },
    identity: "shared",
    readSource: { agentId: "main", path: "unused" },
    source: null,
  };
  const changed: ControlUiSessionPullRequests = { ...READY, rateLimited: true };
  const changedSessions = {
    shared: { ...changed, status: "rate-limited" },
  };

  it("checks the recipient's prepared authority when another watcher joins before send", async () => {
    vi.useFakeTimers();
    const recipientEntered = createDeferred();
    const recipientRead = createDeferred<ControlUiSessionPrTarget>();
    const joiningEntered = createDeferred();
    const joiningRead = createDeferred<ControlUiSessionPrTarget>();
    const access = new AbortController();
    const recipientTarget = { ...target, assertCurrent: () => access.signal.throwIfAborted() };
    let holdRecipient = false;
    let snapshot = READY;
    const broadcastToConnIds = vi.fn();
    active = createTestControlUiSessionPrSubscriptions({
      broadcastToConnIds,
      load: async () => snapshot,
      prepareRead: async (connId) => () => {
        if (connId === "joining") {
          joiningEntered.resolve();
          return joiningRead.promise;
        }
        if (connId === "recipient") {
          if (holdRecipient) {
            holdRecipient = false;
            recipientEntered.resolve();
            return recipientRead.promise;
          }
          return Promise.resolve(access.signal.aborted ? undefined : recipientTarget);
        }
        return Promise.resolve(target);
      },
    });
    await active.replace("first", ["shared"]);
    await active.replace("recipient", ["shared"]);
    broadcastToConnIds.mockClear();
    broadcastToConnIds.mockImplementationOnce(() => {
      holdRecipient = true;
    });
    snapshot = changed;
    const poll = active.pollNow();
    const operations: Promise<unknown>[] = [poll];
    try {
      await recipientEntered.promise;
      operations.push(active.replace("joining", ["shared"]));
      await joiningEntered.promise;
      access.abort(new Error("Recipient access retired"));
      // The recipient finishes preparation first; admission then updates the shared
      // target before the recipient's queued send can resume.
      recipientRead.resolve(recipientTarget);
      joiningRead.resolve(target);
      await Promise.all(operations);

      expect(broadcastToConnIds.mock.calls).toEqual(
        ["first", "joining"].map((connId) => [
          CHANGED_EVENT,
          { sessions: changedSessions },
          new Set([connId]),
          { sessionKeys: ["shared"], agentId: "main" },
        ]),
      );
    } finally {
      recipientRead.resolve(recipientTarget);
      joiningRead.resolve(target);
      await Promise.allSettled(operations);
    }
  });

  it.each(["pending", "prepared"] as const)(
    "does not revive a removed watcher whose delivery read is %s",
    async (boundary) => {
      vi.useFakeTimers();
      const entered = createDeferred();
      const held = createDeferred<ControlUiSessionPrTarget>();
      let holdRecipient = false;
      let snapshot = READY;
      let cacheSignal: AbortSignal | undefined;
      const broadcastToConnIds = vi.fn();
      active = createTestControlUiSessionPrSubscriptions({
        broadcastToConnIds,
        load: async (_params, signal) => {
          cacheSignal = signal;
          return snapshot;
        },
        prepareRead: async (connId) => () => {
          if (connId === "removed" && holdRecipient) {
            holdRecipient = false;
            entered.resolve();
            return held.promise;
          }
          return Promise.resolve(target);
        },
      });
      await active.replace("first", ["shared"]);
      await active.replace("removed", ["shared"]);
      broadcastToConnIds.mockClear();
      broadcastToConnIds.mockImplementationOnce(() => {
        holdRecipient = true;
      });
      snapshot = changed;
      const poll = active.pollNow();
      try {
        await entered.promise;
        if (boundary === "pending") {
          active.unsubscribe("removed");
        }
        held.resolve(target);
        if (boundary === "prepared") {
          // The owner's earlier promise reaction installs the prepared target;
          // retire membership before the queued publication continuation runs.
          await held.promise;
          active.unsubscribe("removed");
        }
        await poll;

        expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
          CHANGED_EVENT,
          { sessions: changedSessions },
          new Set(["first"]),
          { sessionKeys: ["shared"], agentId: "main" },
        );
        active.unsubscribe("first");
        expect(cacheSignal?.aborted).toBe(true);
      } finally {
        held.resolve(target);
        await poll;
      }
    },
  );

  it("continues to later recipients after one prepared authority rejects the shared snapshot", async () => {
    vi.useFakeTimers();
    const entered = createDeferred();
    const held = createDeferred<ControlUiSessionPrTarget>();
    const access = new AbortController();
    const rejectedTarget = { ...target, assertCurrent: () => access.signal.throwIfAborted() };
    let holdRecipient = false;
    let snapshot = READY;
    const broadcastToConnIds = vi.fn();
    active = createTestControlUiSessionPrSubscriptions({
      broadcastToConnIds,
      load: async () => snapshot,
      prepareRead: async (connId) => () => {
        if (connId === "rejected") {
          if (holdRecipient) {
            holdRecipient = false;
            entered.resolve();
            return held.promise;
          }
          return Promise.resolve(access.signal.aborted ? undefined : rejectedTarget);
        }
        return Promise.resolve(target);
      },
    });
    for (const connId of ["first", "rejected", "last"]) {
      await active.replace(connId, ["shared"]);
    }
    broadcastToConnIds.mockClear();
    broadcastToConnIds.mockImplementationOnce(() => {
      holdRecipient = true;
    });
    snapshot = changed;
    const poll = active.pollNow();
    try {
      await entered.promise;
      access.abort(new Error("Recipient access retired"));
      held.resolve(rejectedTarget);
      await poll;

      expect(broadcastToConnIds.mock.calls).toEqual(
        ["first", "last"].map((connId) => [
          CHANGED_EVENT,
          { sessions: changedSessions },
          new Set([connId]),
          { sessionKeys: ["shared"], agentId: "main" },
        ]),
      );
      broadcastToConnIds.mockClear();
      await active.pollNow();
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    } finally {
      held.resolve(rejectedTarget);
      await poll;
    }
  });
});
