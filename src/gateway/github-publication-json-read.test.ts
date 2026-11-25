import { afterEach, expect, it, vi } from "vitest";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.types.js";
import * as processRuntime from "../process/exec.js";
import { GitHubPublicationApiError } from "./github-publication-failure.js";
import { requestGitHubPublicationJson } from "./github-publication-json-read.js";

const identity: PreparedGitHubPublicationIdentity = {
  source: "system-configured",
  host: "enterprise.example.test",
  account: { accountId: 7, login: "publisher", avatarUrl: null },
  env: { GH_TOKEN: "synthetic-publication-token" },
};
const endpoint = "repos/owner/repository/git/";
const blob = { content: "aGVsbG8K", encoding: "base64" };
const success = (sha: string) => ({
  code: 0,
  signal: null,
  killed: false,
  termination: "exit" as const,
  stdout: Buffer.from(JSON.stringify({ sha })),
  stderr: Buffer.alloc(0),
});
const failure = (status?: number) => ({
  ...success(""),
  code: 1,
  stdout: Buffer.alloc(0),
  stderr: Buffer.from(
    status ? `gh: provider failure (HTTP ${status})` : "unknown provider failure",
  ),
});

afterEach(() => vi.restoreAllMocks());

it.each([
  { kind: "blobs", body: blob, sha: "ce013625030ba8dba906f756967f9e9ca394464a" },
  { kind: "trees", body: { tree: [] }, sha: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" },
])(
  "retries the identical immutable $kind POST once after typed HTTP502",
  async ({ kind, body, sha }) => {
    const command = vi
      .spyOn(processRuntime, "runCommandBuffered")
      .mockResolvedValueOnce(failure(502))
      .mockResolvedValueOnce(success(sha));
    await expect(
      requestGitHubPublicationJson(endpoint + kind, identity, () => {}, body),
    ).resolves.toEqual({
      sha,
    });
    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls.map(([args]) => args)).toEqual([
      [
        "gh",
        "api",
        "--hostname",
        identity.host,
        "--method",
        "POST",
        endpoint + kind,
        "--input",
        "-",
      ],
      [
        "gh",
        "api",
        "--hostname",
        identity.host,
        "--method",
        "POST",
        endpoint + kind,
        "--input",
        "-",
      ],
    ]);
    expect(command.mock.calls.map(([, options]) => options?.input)).toEqual([
      JSON.stringify(body),
      JSON.stringify(body),
    ]);
  },
);

it("settles repeated HTTP502 after two attempts without retrying the publication", async () => {
  const command = vi.spyOn(processRuntime, "runCommandBuffered").mockResolvedValue(failure(502));
  const error = await requestGitHubPublicationJson(endpoint + "trees", identity, () => {}, {
    tree: [],
  }).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(GitHubPublicationApiError);
  expect(error).toMatchObject({ transport: { httpStatus: 502, endpointKind: "tree" } });
  expect(command).toHaveBeenCalledTimes(2);
});

it("rechecks original authority before the retry can send another request", async () => {
  let current = true;
  const revoked = new Error("Original publication authority revoked");
  const command = vi.spyOn(processRuntime, "runCommandBuffered").mockImplementation(async () => {
    current = false;
    return failure(502);
  });
  await expect(
    requestGitHubPublicationJson(
      endpoint + "blobs",
      identity,
      () => {
        if (!current) {
          throw revoked;
        }
      },
      blob,
    ),
  ).rejects.toBe(revoked);
  expect(command).toHaveBeenCalledOnce();
});

it.each([
  { route: endpoint + "commits", body: { tree: "a".repeat(40) }, status: 502 },
  { route: endpoint + "refs/heads/topic", body: { sha: "a".repeat(40) }, status: 502 },
  { route: "graphql", body: { query: "mutation { updateRefs }" }, status: 502 },
  { route: "repos/owner/repository/pulls", body: { title: "Publication" }, status: 502 },
  { route: endpoint + "trees/" + "a".repeat(40), body: undefined, status: 502 },
  { route: endpoint + "blobs", body: blob, status: 401 },
  { route: endpoint + "blobs", body: blob, status: 403 },
  { route: endpoint + "blobs", body: blob, status: 429 },
  { route: endpoint + "trees", body: { tree: [] }, status: 503 },
  { route: endpoint + "blobs", body: blob, status: undefined },
])("does not retry disallowed route/status $route/$status", async ({ route, body, status }) => {
  const command = vi.spyOn(processRuntime, "runCommandBuffered").mockResolvedValue(failure(status));
  await expect(
    requestGitHubPublicationJson(route, identity, () => {}, body),
  ).rejects.toBeInstanceOf(GitHubPublicationApiError);
  expect(command).toHaveBeenCalledOnce();
});

it("does not treat a killed timed-out command with HTTP502 output as a retryable response", async () => {
  const command = vi.spyOn(processRuntime, "runCommandBuffered").mockResolvedValue({
    ...failure(502),
    termination: "timeout",
    code: null,
    killed: true,
  });
  await expect(
    requestGitHubPublicationJson(endpoint + "blobs", identity, () => {}, blob),
  ).rejects.toBeInstanceOf(GitHubPublicationApiError);
  expect(command).toHaveBeenCalledOnce();
});
