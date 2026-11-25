import { resolveGitHubHost } from "../agents/github-host-runtime.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { retryAsync } from "../infra/retry.js";
import { createGitHubPublicationReadEnvironment } from "./github-publication-command-env.js";
import { GitHubPublicationApiError } from "./github-publication-failure.js";
import {
  githubPublicationApiArgs,
  runPublicationCommand,
  requirePublicationCommand,
} from "./github-publication-git-transport.js";

/** Native transport/response failure, distinct from a caller or source authority refusal. */
export class GitHubPublicationReadUnavailableError extends Error {}

export function createGitHubPublicationJsonReader(params: {
  host: string;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  unavailable: () => Error;
  requireSuccess: boolean;
}) {
  const { host, env, assertCurrent, unavailable, requireSuccess } = params;
  const prepareEnv = createGitHubPublicationReadEnvironment(env);
  const readFailure = () => {
    const cause = unavailable();
    return new GitHubPublicationReadUnavailableError(cause.message, { cause });
  };
  return async (
    endpoint: string,
    query?: { query?: string; variables?: Record<string, unknown>; jq?: string },
  ): Promise<unknown> => {
    assertCurrent();
    const response = await runPublicationCommand(
      [
        ...githubPublicationApiArgs(endpoint, query?.query ? "POST" : "GET", host),
        ...(query?.jq ? ["--jq", query.jq] : []),
      ],
      {
        prepareEnv,
        ...(query?.query
          ? { input: JSON.stringify({ query: query.query, variables: query.variables }) }
          : {}),
        beforeRun: assertCurrent,
      },
    ).catch(() => {
      assertCurrent();
      throw readFailure();
    });
    assertCurrent();
    if (response.code !== 0) {
      if (requireSuccess) {
        throw readFailure();
      }
      return undefined;
    }
    try {
      return JSON.parse(response.stdout.toString("utf8"));
    } catch {
      throw readFailure();
    }
  };
}

export async function requestGitHubPublicationJson(
  endpoint: string,
  identity: PreparedGitHubPublicationIdentity,
  assertCurrent: () => void,
  body?: unknown,
  maxOutputBytes?: number,
): Promise<unknown> {
  assertCurrent();
  // Object creation is content-addressed. Keep the original target and exact body
  // bytes across the one permitted retry; ref/PR/commit operations are not replayed.
  const args = githubPublicationApiArgs(
    endpoint,
    body === undefined ? "GET" : "POST",
    identity.host ?? resolveGitHubHost(),
  );
  const options = {
    env: identity.env,
    apiCredentialSource: identity.source,
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    beforeRun: assertCurrent,
    ...(body === undefined ? {} : { input: JSON.stringify(body) }),
  };
  const raw = await retryAsync(() => requirePublicationCommand(args, options), {
    attempts: 2,
    minDelayMs: 0,
    shouldRetry: (error) =>
      error instanceof GitHubPublicationApiError &&
      error.transport.httpStatus === 502 &&
      error.transport.method === "POST" &&
      (error.transport.endpointKind === "blob" || error.transport.endpointKind === "tree") &&
      error.transport.termination === "exit" &&
      !error.transport.killed &&
      error.transport.signal === null,
  });
  assertCurrent();
  return JSON.parse(raw);
}
