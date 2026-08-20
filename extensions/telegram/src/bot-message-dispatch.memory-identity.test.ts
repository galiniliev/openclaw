import { expect, it, vi } from "vitest";
import {
  createContext,
  createDirectSessionPayload,
  describeTelegramDispatch,
  dispatchWithContext,
  telegramDepsForTest,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage memory identity admission", () => {
  it("binds an admitted direct-DM proof to the exact finalized context", async () => {
    const attachVerifiedDirectSender = vi.fn();
    const admitVerifiedDirectPairingSender = vi.fn();
    const attachVerifiedNativeConversation = vi.fn();
    const ctxPayload = createDirectSessionPayload();
    const context = createContext({
      accountId: "account-1",
      ctxPayload,
      msg: {
        chat: { id: 123, type: "private" },
        from: { id: 456 },
        message_id: 789,
      } as TelegramMessageContext["msg"],
    });

    await dispatchWithContext({
      context,
      telegramDeps: {
        ...telegramDepsForTest,
        memoryIdentityAdmission: { attachVerifiedDirectSender, admitVerifiedDirectPairingSender },
        nativeChannelMemoryEvidenceAdmission: { attachVerifiedNativeConversation },
      },
    });

    expect(attachVerifiedDirectSender).toHaveBeenCalledWith({
      context: ctxPayload,
      channel: "telegram",
      accountId: "account-1",
      stableSenderId: "456",
    });
    expect(attachVerifiedNativeConversation).not.toHaveBeenCalled();
  });

  it("attaches only native conversation proof for a group event", async () => {
    const attachVerifiedDirectSender = vi.fn();
    const admitVerifiedDirectPairingSender = vi.fn();
    const attachVerifiedNativeConversation = vi.fn();
    const ctxPayload = {
      SessionKey: "agent:test:telegram:group:-100123",
      ChatType: "group",
    } as TelegramMessageContext["ctxPayload"];
    await dispatchWithContext({
      context: createContext({
        accountId: "account-1",
        chatId: -100123,
        isGroup: true,
        ctxPayload,
        msg: {
          chat: { id: -100123, type: "supergroup" },
          from: { id: 456 },
          message_id: 789,
        } as TelegramMessageContext["msg"],
      }),
      telegramDeps: {
        ...telegramDepsForTest,
        memoryIdentityAdmission: { attachVerifiedDirectSender, admitVerifiedDirectPairingSender },
        nativeChannelMemoryEvidenceAdmission: { attachVerifiedNativeConversation },
      },
    });

    expect(attachVerifiedDirectSender).not.toHaveBeenCalled();
    expect(attachVerifiedNativeConversation).toHaveBeenCalledWith({
      context: ctxPayload,
      channel: "telegram",
      accountId: "account-1",
      nativeChannelId: "-100123",
    });
  });
});
