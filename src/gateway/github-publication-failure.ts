import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  GatewayErrorDetailCodes,
  type GitHubPublicationSelectionRejectedErrorDetails,
} from "../../packages/gateway-protocol/src/gateway-error-details.js";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { readErrorStackFrames } from "../infra/error-graph-internal.js";
import { extractErrorCode } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createCommandError } from "../process/command-error.js";
import type { BufferedCommandResult } from "../process/exec.js";
import {
  NodeWorkerWorkspaceTransferError,
  NODE_WORKSPACE_PUBLICATION_CONFLICT_CODE,
} from "../worker/node-workspace-transfer-protocol.js";
import { WORKSPACE_RESULT_LIMIT_ERROR_CODE } from "./worker-environments/workspace-inventory-limits.js";

type PublicationFailure = Pick<
  Extract<SessionGitHubPublicationResult, { status: "failed" }>,
  "code" | "nextAction"
>;

export type GitHubPublicationPreparation = {
  idempotencyKey: string;
  hasRequest: () => boolean;
};
const identityNextAction =
  "Reconnect My GitHub, the shared agent account, or the agent’s own account in Settings → Profile → GitHub accounts, then request publication again.";

/** An owner observed a definitive outcome; an unavailable probe is not this failure. */
export class GitHubPublicationKnownFailure extends Error {
  constructor(
    message: string,
    readonly failure: PublicationFailure,
    readonly rejection?: GitHubPublicationSelectionRejectedErrorDetails,
  ) {
    super(message);
  }
}

export type GitHubPublicationApiContext = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  endpointKind:
    | "blob"
    | "tree"
    | "commit"
    | "ref"
    | "compare"
    | "repository"
    | "pull-request"
    | "graphql"
    | "other";
  credentialSource?: "system-detected" | "system-configured" | "agent-override" | "personal";
};

export function describeGitHubPublicationApiContext(
  argv: readonly string[],
  credentialSource?: GitHubPublicationApiContext["credentialSource"],
): GitHubPublicationApiContext {
  const methodValue = argv[argv.indexOf("--method") + 1];
  const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].find(
    (value) => value === methodValue,
  );
  const endpoint =
    argv.find((value) => value === "graphql" || value.startsWith("repos/"))?.split("?")[0] ?? "";
  const endpointKind =
    endpoint === "graphql"
      ? "graphql"
      : /\/git\/blobs(?:\/[^/]+)?$/u.test(endpoint)
        ? "blob"
        : /\/git\/trees(?:\/[^/]+)?$/u.test(endpoint)
          ? "tree"
          : /\/git\/commits(?:\/[^/]+)?$/u.test(endpoint)
            ? "commit"
            : /\/git\/(?:ref|refs|matching-refs)\//u.test(endpoint)
              ? "ref"
              : endpoint.includes("/compare/")
                ? "compare"
                : /\/pulls(?:\/[^/]+)?$/u.test(endpoint)
                  ? "pull-request"
                  : /^repos\/[^/]+\/[^/]+$/u.test(endpoint)
                    ? "repository"
                    : "other";
  return {
    ...(method === "GET" ||
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE" ||
    method === "HEAD"
      ? { method }
      : {}),
    endpointKind,
    credentialSource,
  };
}

/** Only transport outcome facts cross into a public receipt, never command output. */
export class GitHubPublicationApiError extends Error {
  readonly code = "GITHUB_PUBLICATION_API_ERROR";
  readonly transport;
  constructor(
    result: BufferedCommandResult,
    timeoutMs: number,
    context: GitHubPublicationApiContext = { endpointKind: "other" },
  ) {
    const reason = createCommandError(
      "GitHub API command",
      {
        ...result,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: undefined,
      },
      { timeoutMs },
    ).message;
    const status = /\(HTTP ([1-5]\d{2})\)/u.exec(result.stderr.toString("utf8"))?.[1];
    super(`${reason}${status ? `; HTTP ${status}` : ""}.`);
    const processCode = extractErrorCode(result.error);
    const networkCode =
      /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/u.exec(
        result.stderr.toString("utf8"),
      )?.[0] ??
      (/^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)$/u.test(
        processCode ?? "",
      )
        ? processCode
        : undefined);
    const httpStatus = status ? Number(status) : undefined;
    this.transport = {
      origin: "gateway-managed-publication" as const,
      ...context,
      termination: result.termination,
      exitCode: result.code,
      signal: result.signal,
      killed: result.killed,
      capturedStdoutBytes: result.stdout.length,
      capturedStderrBytes: result.stderr.length,
      configuredTimeoutMs: timeoutMs,
      ...(result.outputLimitStream ? { outputLimitStream: result.outputLimitStream } : {}),
      ...(httpStatus ? { httpStatus } : {}),
      ...(networkCode ? { networkCode } : {}),
      ...(/^(?:ENOENT|EACCES|ENOMEM|EMFILE|ENFILE)$/u.test(processCode ?? "")
        ? { processCode }
        : {}),
      reasonFamily:
        result.termination === "timeout" || result.termination === "no-output-timeout"
          ? "timeout"
          : result.termination === "output-limit"
            ? "output-limit"
            : result.termination === "signal"
              ? "signal"
              : networkCode
                ? "network"
                : httpStatus === 401
                  ? "authentication"
                  : httpStatus === 429
                    ? "rate-limit"
                    : httpStatus
                      ? "http"
                      : processCode
                        ? "local-process"
                        : "unknown",
    };
  }
}

/** Preserve Git command failures while keeping GitHub transport output out of public errors. */
export function createGitHubPublicationCommandError(
  argv: readonly string[],
  result: BufferedCommandResult,
  timeoutMs: number,
  credentialSource?: GitHubPublicationApiContext["credentialSource"],
): Error {
  return argv[0] === "gh"
    ? new GitHubPublicationApiError(
        result,
        timeoutMs,
        describeGitHubPublicationApiContext(argv, credentialSource),
      )
    : createCommandError(
        argv[0] ?? "command",
        { ...result, stdout: Buffer.alloc(0) },
        { timeoutMs },
      );
}

/** Shared Git reads and personal publication can have different repository permissions. */
export function gitHubPublicationWorkerReadFailure(error: unknown): unknown {
  // GitHub also uses 403 for throttling; status alone cannot prove access was lost.
  if (error instanceof GitHubPublicationApiError && /HTTP 403/u.test(error.message)) {
    return new GitHubPublicationKnownFailure("Worker repository read is unavailable (HTTP 403).", {
      code: "unavailable",
      nextAction:
        "GitHub may be rate-limiting this read. Wait before retrying; if the refusal persists, verify the normal worker execution account's repository access. The personal publisher connection is separate.",
    });
  }
  if (error instanceof GitHubPublicationApiError && /HTTP 404/u.test(error.message)) {
    return new GitHubPublicationKnownFailure(
      "Worker execution identity cannot read the publication repositories.",
      {
        code: "identity_unavailable",
        nextAction:
          "The normal worker GitHub execution account could not read the source or target repository. Review its existing access, then explicitly request publication again. This failed request and checkpoint remain saved; the personal publisher connection is separate.",
      },
    );
  }
  return error;
}

export function rejectGitHubPublicationSelection(
  message: string,
  preparation?: GitHubPublicationPreparation,
): never {
  let rejection: GitHubPublicationSelectionRejectedErrorDetails | undefined;
  try {
    // Check at rejection, not before awaited preparation. Another invocation may have admitted.
    if (preparation && !preparation.hasRequest()) {
      rejection = {
        code: GatewayErrorDetailCodes.GITHUB_PUBLICATION_SELECTION_REJECTED,
        idempotencyKey: preparation.idempotencyKey,
      };
    }
  } catch {
    // An unreadable receipt cannot establish that publication was not admitted.
  }
  throw new GitHubPublicationKnownFailure(
    message,
    { code: "identity_changed", nextAction: identityNextAction },
    rejection,
  );
}

export class GitHubPublicationWorkspaceChangedError extends GitHubPublicationKnownFailure {
  constructor(message: string) {
    super(message, {
      code: "workspace_changed",
      nextAction:
        "Inspect the reconciled workspace and any recorded GitHub effects, then request a new publication after reviewing the changes.",
    });
  }
}

/** The session worktree has a branch checked out other than the branch this session publishes. */
export class GitHubPublicationSessionBranchMismatchError extends GitHubPublicationKnownFailure {
  constructor(branches: { session: string; checkedOut: string }) {
    const { session, checkedOut } = branches;
    super(
      `The session worktree has branch ${checkedOut} checked out, but this session publishes branch ${session}.`,
      {
        code: "workspace_changed",
        nextAction: `In the session worktree, rename the branch back with \`git branch -m ${checkedOut} ${session}\`, or switch to it with \`git switch ${session}\` if it still exists, then request publication again. Publication only pushes the session branch.`,
      },
    );
  }
}

export class GitHubPublicationBranchChangedError extends GitHubPublicationKnownFailure {
  constructor(options: { originalPullRequest?: boolean } = {}) {
    super("GitHub publication cannot safely extend the published branch.", {
      code: "push_rejected",
      nextAction: options.originalPullRequest
        ? "The PR head changed after this workspace last integrated it. Your local work is saved: call prepare_pr with this PR's URL to merge its newer head into that work, resolve any returned conflicts, then publish again. Do not create a replacement PR or redirect publication to another branch."
        : "Preserve your local work and inspect the published head. If this conversation published the PR from its managed workspace, call prepare_pr with its URL to merge the newer head into the saved work, then publish again; otherwise publish from a new session branch and open a replacement PR. Repository-only checkpoints cannot adopt external branch changes; use a new session branch for those. Do not merge old history merely to make a rebased branch pushable. The broker never rewrites published history.",
    });
  }
}

/**
 * Classify a push whose head did not land. Git exiting on its own with a failure while the
 * remote still holds its pre-push head is a definitive rejection. Anything else (exit 0, a
 * killed or signalled push, or a moved remote) stays unconfirmed for recovery to settle.
 */
export function gitHubPublicationPushFailure(
  pushed: { code: number | null; signal: unknown; killed: boolean },
  remoteUnchanged: boolean,
  { login, pushRepository }: { login: string; pushRepository: string },
): Error {
  if (!remoteUnchanged || pushed.code === 0 || pushed.signal !== null || pushed.killed) {
    return new Error(
      pushed.code === 0 ? "GitHub push verification failed." : "GitHub push was rejected.",
    );
  }
  return new GitHubPublicationKnownFailure(`GitHub rejected the push to ${pushRepository}.`, {
    code: "push_rejected",
    nextAction: `Nothing was pushed as @${login}. Give @${login} write access (or point the worktree's origin at a fork it owns) and check the repository's branch rules, then request publication again.`,
  });
}

export class GitHubPublicationSessionChangedError extends GitHubPublicationKnownFailure {
  constructor() {
    super("GitHub publication session lifecycle changed.", {
      code: "session_changed",
      nextAction:
        "Review any recorded GitHub effects, then request publication from the current session.",
    });
  }
}

export class GitHubPublicationRequesterUnavailableError extends GitHubPublicationKnownFailure {
  constructor() {
    super("The original GitHub publication requester is no longer authorized.", {
      code: "identity_changed",
      nextAction:
        "Review any recorded or unconfirmed GitHub effects, then request publication again from an authorized session. Saved work and existing pull requests are retained.",
    });
  }
}

export class GitHubPublicationCreditChangedError extends GitHubPublicationKnownFailure {
  constructor() {
    super("GitHub publication contributor credit changed.", {
      code: "identity_changed",
      nextAction:
        "Review contributor credit and any recorded GitHub effects, reconcile unpushed prepared commits, then request a new publication. Already published commits and pull requests are retained.",
    });
  }
}

export class GitHubPublicationWorkflowChangesError extends GitHubPublicationKnownFailure {
  constructor() {
    super("Publishing GitHub workflow changes requires full operator write permission.", {
      code: "github_rejected",
      nextAction:
        "OpenClaw requires the requester's full operator write authority for these workflow changes; this is not a GitHub token scope failure. Your saved changes are intact. Ask a maintainer with full write access to publish, or remove only unintended workflow edits after reviewing the accepted diff.",
    });
  }
}

/** Diagnostic bookkeeping must not replace the original outcome or record tool output. */
export function recordGitHubPublicationFailure(
  error: unknown,
  row: { request_id: string; session_id: string },
  stage = "execution",
  blobs?: { total: number; reused: number; completed: number },
): PublicationFailure {
  const failure = resolveGitHubPublicationFailure(error);
  if (!(error instanceof GitHubPublicationKnownFailure)) {
    try {
      createSubsystemLogger("gateway/github-publication").warn("Repository publication failed", {
        requestId: row.request_id,
        sessionId: row.session_id,
        failureCode: failure.code,
        errorCode: extractErrorCode(error),
        stage,
        errorStacks: readErrorStackFrames(error),
        ...(error instanceof GitHubPublicationApiError ? { transport: error.transport } : {}),
        ...(blobs
          ? { blobs: { total: blobs.total, reused: blobs.reused, completed: blobs.completed } }
          : {}),
      });
    } catch {
      // A diagnostic sink cannot change publication settlement.
    }
  }
  return failure;
}

/** Phase boundaries are bounded per execution and never include command or source content. */
export function recordGitHubPublicationProgress(
  row: { request_id: string; session_id: string; execution_id?: string | null },
  stage: string,
  elapsedMs: number,
  blobs?: { total: number; reused: number; completed: number },
): void {
  try {
    createSubsystemLogger("gateway/github-publication").info("Repository publication progress", {
      requestId: row.request_id,
      sessionId: row.session_id,
      executionId: row.execution_id,
      stage,
      elapsedMs,
      ...(blobs
        ? { blobs: { total: blobs.total, reused: blobs.reused, completed: blobs.completed } }
        : {}),
    });
  } catch {
    // Optional diagnostics cannot change publication or its settlement.
  }
}

/**
 * Resolve the persisted failure code and guidance. A known failure's message is code-authored,
 * so it leads the guidance as the specific reason; other errors may carry raw command output
 * and only select generic guidance.
 */
export function resolveGitHubPublicationFailure(error: unknown): PublicationFailure {
  if (extractErrorCode(error) === NODE_WORKSPACE_PUBLICATION_CONFLICT_CODE) {
    return {
      code: "workspace_changed",
      nextAction:
        "The accepted checkpoint conflicts with the current publication base. Your saved work is retained; resolve the conflicts before requesting a new publication.",
    };
  }
  if (error instanceof NodeWorkerWorkspaceTransferError) {
    const reason =
      /Publication integration [a-z-]{1,48} failed \((?:exit|error|timeout|signal|no-output-timeout|output-limit); exit (?:null|-?\d+)\)\./u.exec(
        error.message,
      )?.[0] ??
      /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|HTTP [1-5]\d{2}|gateway returned [1-5]\d{2})\b/u.exec(
        error.message,
      )?.[0];
    return {
      code: "unavailable",
      nextAction: `${reason ? `${reason} ` : ""}Worker publication transfer failed. Restore worker and repository connectivity, then retry the same request.`,
    };
  }
  if (error instanceof GitHubPublicationApiError) {
    return {
      code: "unavailable",
      nextAction: `${error.message} Retry after the Gateway and GitHub are available.`,
    };
  }
  if (error instanceof GitHubPublicationKnownFailure) {
    const reason = /[.!?]$/u.test(error.message) ? error.message : `${error.message}.`;
    return { code: error.failure.code, nextAction: `${reason} ${error.failure.nextAction}` };
  }
  const message = error instanceof Error ? error.message : "";
  if (message && asOptionalRecord(error)?.code === WORKSPACE_RESULT_LIMIT_ERROR_CODE) {
    return { code: "workspace_changed", nextAction: message };
  }
  if (message.includes("publication workspace base")) {
    return {
      code: "unavailable",
      nextAction:
        "The pull request base or its Git history could not be verified. Check repository read access, connectivity, and local Git objects before retrying publication.",
    };
  }
  if (message.includes("publication remote branch could not be verified")) {
    return {
      code: "unavailable",
      nextAction:
        "Restore repository read access or connectivity, then verify the published branch before retrying. An unavailable observation does not prove the branch is absent or safe to overwrite.",
    };
  }
  if (message.includes("identity")) {
    return {
      code: message.includes("changed") ? "identity_changed" : "identity_unavailable",
      nextAction: identityNextAction,
    };
  }
  if (message.includes("session") || message.includes("worktree owner")) {
    return {
      code: "session_changed",
      nextAction: "Open the current session worktree and request publication again.",
    };
  }
  if (message.includes("transport configuration") || message.includes("replacement metadata")) {
    return {
      code: "workspace_changed",
      nextAction:
        "Remove the unsupported Git transport or replacement configuration from the session worktree, then retry.",
    };
  }
  if (message.includes("workspace") || message.includes("branch changed")) {
    return {
      code: "workspace_changed",
      nextAction:
        "Inspect the reconciled workspace and any recorded GitHub effects, then request a new publication after reviewing the changes.",
    };
  }
  if (message.includes("not a git")) {
    return { code: "not_git", nextAction: "Use a session-owned Git worktree to publish." };
  }
  if (message.includes("GitHub remote")) {
    return { code: "not_github", nextAction: "Use a GitHub repository remote to publish." };
  }
  if (message.includes("push")) {
    return {
      code: "push_rejected",
      nextAction:
        "Check repository write access and branch drift, then retry without force-pushing.",
    };
  }
  if (message.includes("pull request") || message.includes("GitHub")) {
    return {
      code: "github_rejected",
      nextAction: "Check pull-request permission for the effective account, then retry.",
    };
  }
  return { code: "unavailable", nextAction: "Retry after the Gateway and GitHub are available." };
}
