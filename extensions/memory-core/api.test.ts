import { describe, expect, it } from "vitest";
import {
  dedupeDreamDiaryEntries,
  removeBackfillDiaryEntries,
  writeBackfillDiaryEntries,
} from "./api.js";

describe("memory-core public diary API", () => {
  it.each([
    ["dedupe", () => dedupeDreamDiaryEntries({ workspaceDir: "/tmp/untrusted-workspace" })],
    [
      "write",
      () =>
        writeBackfillDiaryEntries({
          workspaceDir: "/tmp/untrusted-workspace",
          entries: [{ isoDay: "2026-08-19", bodyLines: ["untrusted write"] }],
        }),
    ],
    ["remove", () => removeBackfillDiaryEntries({ workspaceDir: "/tmp/untrusted-workspace" })],
  ])("fails closed for public workspace-path diary %s", async (_operation, invoke) => {
    await expect(invoke()).rejects.toThrow(
      "Memory diary maintenance requires host-authorized runtime maintenance access.",
    );
  });
});
