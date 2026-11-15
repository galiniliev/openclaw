import { ErrorCodes } from "../../packages/gateway-protocol/src/gateway-error-codes.js";
import { errorShape } from "../../packages/gateway-protocol/src/schema/error-codes.js";
import type { ErrorShape } from "../../packages/gateway-protocol/src/schema/frames.js";
import type { SessionEntryCreateWithTranscriptResult } from "../config/sessions/session-accessor.types.js";

/** Worker errors retain names, so known transactional claim refusals keep their public envelope. */
export function sessionCreationCommitFailure(
  error: unknown,
): Extract<SessionEntryCreateWithTranscriptResult<ErrorShape>, { ok: false }> {
  if (
    error instanceof Error &&
    ["SessionLabelConflictError", "SessionRequestedIdentityConflictError"].includes(error.name)
  ) {
    return { ...invalidSessionRequest(error.message), phase: "entry" };
  }
  throw error;
}

export function sessionCreationFailure(
  failure: Extract<SessionEntryCreateWithTranscriptResult<ErrorShape>, { ok: false }>,
): { ok: false; error: ErrorShape } {
  return {
    ok: false,
    error:
      failure.phase === "transcript"
        ? errorShape(
            ErrorCodes.UNAVAILABLE,
            `failed to create session transcript: ${failure.error}`,
          )
        : failure.error,
  };
}

export function invalidSessionRequest(
  message: string,
  options?: Parameters<typeof errorShape>[2],
): { ok: false; error: ErrorShape } {
  return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, message, options) };
}

/** A caller-selected directory is named so the caller can correct it; the default workspace is not. */
export function nonGitWorktreeSourceMessage(
  requestedWorkspace?: string | { kind: "empty" },
): string {
  return typeof requestedWorkspace === "string"
    ? `requested working directory is not a git checkout: ${requestedWorkspace}`
    : "agent workspace is not a git checkout";
}

export function unavailableSessionRequest(message: string): { ok: false; error: ErrorShape } {
  return { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, message) };
}
