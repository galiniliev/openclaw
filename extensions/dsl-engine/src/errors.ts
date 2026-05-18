export type DslErrorKind =
  | "timeout"
  | "codeSizeExceeded"
  | "sandboxViolation"
  | "executionError"
  | "apiCallFailed"
  | "validationError"
  | "concurrencyLimitReached";

export class DslError extends Error {
  constructor(
    public readonly kind: DslErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DslError";
  }
}
