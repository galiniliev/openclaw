import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ info: vi.fn(), runCommandBuffered: vi.fn() }));
vi.mock("../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/exec.js")>();
  return {
    ...actual,
    runCommandBuffered: mocks.runCommandBuffered,
  };
});
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...original,
    createSubsystemLogger: (name: string) =>
      name === "agents/github-identity"
        ? { info: mocks.info }
        : original.createSubsystemLogger(name),
  };
});

import {
  clearGitHubCredentialVerificationCache,
  verifyGitHubCredential,
} from "./github-oauth-client.js";
import { readNativeGitHubToken } from "./github-read-identity.js";

const lookupId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const secret = "synthetic-private-token";
const frame = (stage: string, code: string, httpStatus?: number) =>
  `${JSON.stringify({
    event: "github_credential_lookup_client",
    lookupId,
    stage,
    code,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  })}\n`;
const commandResult = (stdout: string, code: number, stderr = "") => ({
  stdout: Buffer.from(stdout),
  stderr: Buffer.from(stderr),
  code,
  signal: null,
  killed: false,
  termination: "exit" as const,
});

describe("effective GitHub identity diagnostics", () => {
  beforeEach(() => {
    mocks.info.mockReset();
    mocks.runCommandBuffered.mockReset();
    vi.stubEnv("GH_TOKEN", undefined);
    vi.stubEnv("GITHUB_TOKEN", undefined);
    vi.stubEnv("GH_ENTERPRISE_TOKEN", undefined);
    vi.stubEnv("GITHUB_ENTERPRISE_TOKEN", undefined);
    clearGitHubCredentialVerificationCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("records the accepted wrapper lookup before scrubbing without logging credential output", async () => {
    const result = commandResult(secret, 0, frame("payload", "accepted", 200));
    mocks.runCommandBuffered.mockResolvedValue(result);
    await expect(readNativeGitHubToken({})).resolves.toBe(secret);
    expect(mocks.info).toHaveBeenCalledWith("github identity lookup", {
      stage: "command",
      code: "token_accepted",
      lookupId,
      clientStage: "payload",
      clientCode: "accepted",
      httpStatus: 200,
    });
    expect(result.stdout.every((byte) => byte === 0)).toBe(true);
    expect(result.stderr.every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(secret);
  });

  it.each([
    ["transport", "broker_unavailable", undefined],
    ["transport", "deadline_exceeded", undefined],
    ["broker", "http_rejected", 403],
    ["parse", "response_unreadable", 200],
    ["payload", "invalid_credential_response", 200],
  ])(
    "keeps the source-known wrapper %s/%s and lookup ID",
    async (clientStage, clientCode, httpStatus) => {
      const result = commandResult(secret, 1, frame(clientStage, clientCode, httpStatus));
      mocks.runCommandBuffered.mockResolvedValue(result);
      await expect(readNativeGitHubToken({})).rejects.toMatchObject({
        name: "GitHubCredentialLookupError",
        diagnostic: {
          lookupId,
          clientStage,
          clientCode,
          ...(httpStatus === undefined ? {} : { httpStatus }),
        },
      });
      expect(mocks.info).toHaveBeenCalledWith("github identity lookup", {
        stage: "command",
        code: "nonzero_exit",
        lookupId,
        clientStage,
        clientCode,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      });
      expect(result.stdout.every((byte) => byte === 0)).toBe(true);
      expect(result.stderr.every((byte) => byte === 0)).toBe(true);
      expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(secret);
    },
  );

  it("rejects extra or forged wrapper output and logs an unknown native cause without it", async () => {
    const privateOutput = `${frame("broker", "http_rejected", 403)}private customer content`;
    mocks.runCommandBuffered.mockResolvedValue(commandResult("", 1, privateOutput));
    await expect(readNativeGitHubToken({})).resolves.toBeUndefined();
    expect(mocks.info).toHaveBeenCalledWith("github identity lookup", {
      stage: "command",
      code: "nonzero_exit",
    });
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("private customer content");
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(lookupId);
    mocks.info.mockClear();
    mocks.runCommandBuffered.mockResolvedValue(
      commandResult("", 1, frame("__proto__", "http_rejected", 403)),
    );
    await expect(readNativeGitHubToken({})).resolves.toBeUndefined();
    expect(mocks.info).toHaveBeenCalledWith("github identity lookup", {
      stage: "command",
      code: "nonzero_exit",
    });
  });

  it("does not link a wrapper frame that contradicts the child exit result", async () => {
    mocks.runCommandBuffered
      .mockResolvedValueOnce(commandResult("", 1, frame("payload", "accepted", 200)))
      .mockResolvedValueOnce(commandResult(secret, 0, frame("broker", "http_rejected", 403)));
    await expect(readNativeGitHubToken({})).resolves.toBeUndefined();
    expect(mocks.info).toHaveBeenCalledWith("github identity lookup", {
      stage: "command",
      code: "nonzero_exit",
    });
    mocks.info.mockClear();
    await expect(readNativeGitHubToken({})).resolves.toBe(secret);
    expect(mocks.info).toHaveBeenCalledWith("github identity lookup", {
      stage: "command",
      code: "token_accepted",
    });
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(lookupId);
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(secret);
  });

  it("separates invalid executable and nonzero auth status from invalid hosts JSON", async () => {
    await expect(
      readNativeGitHubToken({ OPENCLAW_GITHUB_IDENTITY_EXECUTABLE: "relative/gh" }),
    ).rejects.toMatchObject({ reason: "unverified" });
    expect(mocks.info).toHaveBeenCalledWith("github identity lookup", {
      stage: "command",
      code: "invalid_executable",
    });
    mocks.info.mockClear();
    mocks.runCommandBuffered
      .mockResolvedValueOnce(commandResult("", 1))
      .mockResolvedValueOnce(commandResult("not JSON", 0));
    await expect(readNativeGitHubToken({}, true)).rejects.toMatchObject({ reason: "unverified" });
    expect(mocks.info).toHaveBeenCalledWith("github identity lookup", {
      stage: "command",
      code: "nonzero_exit",
    });
    expect(mocks.info).toHaveBeenCalledWith("github identity lookup", {
      stage: "auth_status",
      code: "invalid_json",
    });
  });

  it("keeps an unexpected command failure unknown and omits its private message", async () => {
    mocks.runCommandBuffered.mockRejectedValue(new Error("private process content"));
    await expect(readNativeGitHubToken({})).rejects.toThrow("private process content");
    expect(mocks.info).toHaveBeenCalledWith("github identity lookup", {
      stage: "command",
      code: "unknown",
    });
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("private process content");
  });

  it.each([
    [401, "unauthorized"],
    [429, "rate_limited"],
    [502, "http_unverified"],
  ])("logs only fixed API verification code for HTTP %i", async (httpStatus, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("private response", { status: httpStatus })),
    );
    await verifyGitHubCredential(secret);
    expect(mocks.info).toHaveBeenCalledWith("github identity verification", {
      stage: "api_verification",
      code,
      httpStatus,
    });
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("private response");
  });

  it("distinguishes API transport from unreadable response without exposing errors or bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private transport detail")));
    await verifyGitHubCredential(secret);
    expect(mocks.info).toHaveBeenCalledWith("github identity verification", {
      stage: "api_verification",
      code: "transport_unavailable",
    });
    mocks.info.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("private invalid JSON", { status: 200 })),
    );
    await verifyGitHubCredential(secret);
    expect(mocks.info).toHaveBeenCalledWith("github identity verification", {
      stage: "api_verification",
      code: "response_unreadable",
    });
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("private invalid JSON");
  });
});
