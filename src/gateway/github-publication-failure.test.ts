import { afterEach, expect, it, vi } from "vitest";
import * as subsystem from "../logging/subsystem.js";
import * as exec from "../process/exec.js";
import {
  GitHubPublicationApiError,
  recordGitHubPublicationFailure,
} from "./github-publication-failure.js";
import { requirePublicationCommand } from "./github-publication-git-transport.js";

afterEach(() => vi.restoreAllMocks());

it("keeps safe blob transport facts without leaking command output", async () => {
  const logger = subsystem.createSubsystemLogger("gateway/github-publication");
  const warn = vi.fn();
  vi.spyOn(subsystem, "createSubsystemLogger").mockReturnValue({ ...logger, warn });
  const stderr = Buffer.from(
    "POST private/repository ECONNRESET Authorization: Bearer synthetic-private-token",
  );
  vi.spyOn(exec, "runCommandBuffered").mockResolvedValue({
    code: 1,
    signal: null,
    killed: false,
    termination: "exit",
    stdout: Buffer.from("synthetic-private-response"),
    stderr,
  });
  let error: unknown;
  try {
    await requirePublicationCommand(
      ["gh", "api", "--method", "POST", "repos/private/repository/git/blobs"],
      { apiCredentialSource: "system-configured" },
    );
  } catch (failure) {
    error = failure;
  }
  expect(error).toBeInstanceOf(GitHubPublicationApiError);
  const failure = recordGitHubPublicationFailure(
    error,
    { request_id: "publication", session_id: "session" },
    "blob-upload",
  );
  expect(warn).toHaveBeenCalledWith(
    "Repository publication failed",
    expect.objectContaining({
      transport: expect.objectContaining({
        origin: "gateway-managed-publication",
        method: "POST",
        endpointKind: "blob",
        exitCode: 1,
        termination: "exit",
        networkCode: "ECONNRESET",
        reasonFamily: "network",
        capturedStderrBytes: stderr.length,
      }),
    }),
  );
  expect(JSON.stringify({ failure, logs: warn.mock.calls })).not.toMatch(
    /synthetic-private|private\/repository|Authorization/,
  );
});

it.each([
  { stderr: "synthetic-private-unknown", reasonFamily: "unknown" },
  { stderr: "synthetic-private-refusal (HTTP 403)", reasonFamily: "http" },
])(
  "keeps provider refusals unclassified when their cause is unknown ($reasonFamily)",
  ({ stderr, reasonFamily }) => {
    const error = new GitHubPublicationApiError(
      {
        code: 1,
        signal: null,
        killed: false,
        termination: "exit",
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(stderr),
      },
      60_000,
    );
    expect(error.transport.reasonFamily).toBe(reasonFamily);
    expect(error.message).not.toContain("synthetic-private");
  },
);

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
