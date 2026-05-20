export type CodeModeErrorKind =
  | "timeout"
  | "codeSizeExceeded"
  | "sandboxViolation"
  | "executionError"
  | "apiCallFailed"
  | "validationError"
  | "concurrencyLimitReached";

export class CodeModeError extends Error {
  constructor(
    public readonly kind: CodeModeErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CodeModeError";
  }
}
