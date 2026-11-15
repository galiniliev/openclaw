import { afterEach, expect, it, vi } from "vitest";
import * as subsystem from "../logging/subsystem.js";
import { recordGitHubPublicationFailure } from "./github-publication-failure.js";

afterEach(() => vi.restoreAllMocks());

it("records publication stage and original cause locations without command output", () => {
  const warn = vi.fn();
  const logger = subsystem.createSubsystemLogger("gateway/github-publication");
  vi.spyOn(subsystem, "createSubsystemLogger").mockReturnValue({ ...logger, warn });
  const cause = new Error("session failure: synthetic-token\n    at synthetic-command-content");
  const error = new Error("outer session error: synthetic-command-output", { cause });

  expect(
    recordGitHubPublicationFailure(
      error,
      {
        request_id: "publication-request",
        session_id: "original-session",
      },
      "worker-integration",
    ),
  ).toMatchObject({ code: "session_changed" });

  expect(warn).toHaveBeenCalledWith(
    "Repository publication failed",
    expect.objectContaining({
      requestId: "publication-request",
      sessionId: "original-session",
      stage: "worker-integration",
      errorStacks: [
        expect.arrayContaining([expect.stringContaining("github-publication-failure.test")]),
        expect.arrayContaining([expect.stringContaining("github-publication-failure.test")]),
      ],
    }),
  );
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/synthetic-(token|command)/u);
});

it("does not replace the publication result when the diagnostic sink fails", () => {
  const logger = subsystem.createSubsystemLogger("gateway/github-publication");
  vi.spyOn(subsystem, "createSubsystemLogger").mockReturnValue({
    ...logger,
    warn() {
      throw new Error("sink unavailable");
    },
  });
  expect(
    recordGitHubPublicationFailure(
      new Error("session changed"),
      {
        request_id: "publication-request",
        session_id: "original-session",
      },
      "worker-integration",
    ),
  ).toMatchObject({ code: "session_changed" });
});
