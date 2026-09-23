import { expect, it, type Mock } from "vitest";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";

export function registerEmbeddedHistoryProjectionTests(params: {
  createBackend: () => EmbeddedTuiBackend;
  loadSessionEntry: Mock;
  describe: Mock;
  present: Mock;
  buildSessionRow: Mock;
}) {
  it("does not attach a replacement session row to captured history", async () => {
    params.loadSessionEntry.mockReturnValue({
      cfg: {},
      agentId: "main",
      canonicalKey: "agent:main:main",
      storePath: "/tmp/main.sqlite",
      entry: { sessionId: "previous-session" },
    });
    params.describe.mockReturnValue({
      entry: { sessionId: "replacement-session" },
      target: { key: "agent:main:main" },
    });
    const backend = params.createBackend();
    backend.start();
    try {
      const result = await backend.loadHistory({ sessionKey: "agent:main:main" });
      expect(result.sessionId).toBe("previous-session");
      expect(result.sessionInfo).toBeUndefined();
      expect(params.present).not.toHaveBeenCalled();
      expect(params.buildSessionRow).not.toHaveBeenCalled();
    } finally {
      await backend.stop();
    }
  });
}
