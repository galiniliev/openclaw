/** Structured error reason used while the gateway drains for a restart. */
export const GATEWAY_RESTART_UNAVAILABLE_REASON = "gateway-restarting";
/** Structured error reason used while the gateway drains for a suspension. */
export const GATEWAY_SUSPEND_UNAVAILABLE_REASON = "gateway-suspending";
export const GATEWAY_PLANNED_HANDOFF_UNAVAILABLE_REASON = "gateway-planned-handoff";

/** Issued only before handler entry, never for a lost/unknown execution outcome. */
export function isGatewayPlannedHandoffUnavailableError(error: unknown): boolean {
  if (!hasUnavailableReason(error, GATEWAY_PLANNED_HANDOFF_UNAVAILABLE_REASON)) {
    return false;
  }
  const details = (error as { details: Record<string, unknown> }).details;
  return (
    details.handlerNotEntered === true &&
    typeof details.rollingReleaseId === "string" &&
    details.rollingReleaseId.length > 0 &&
    typeof details.method === "string"
  );
}

/** An entered observational read can repeat; this never proves non-delivery of a write. */
export function isGatewayPlannedHandoffReadInterruption(error: unknown): boolean {
  if (!hasUnavailableReason(error, GATEWAY_PLANNED_HANDOFF_UNAVAILABLE_REASON)) {
    return false;
  }
  const details = (error as { details: Record<string, unknown> }).details;
  return (
    details.handlerNotEntered === false &&
    details.readInterrupted === true &&
    typeof details.rollingReleaseId === "string" &&
    details.rollingReleaseId.length > 0 &&
    typeof details.method === "string"
  );
}
/** Identity reads wait for resume, with a bounded probe if that event is missed. */
export const GATEWAY_SUSPEND_IDENTITY_RETRY_AFTER_MS = 60_000;

/** Detects the structured retryable error emitted while a restart drain refuses work. */
export function isGatewayRestartUnavailableError(error: unknown): boolean {
  return hasUnavailableReason(error, GATEWAY_RESTART_UNAVAILABLE_REASON);
}

/** Detects the structured retryable error emitted while suspension refuses work. */
export function isGatewaySuspendUnavailableError(error: unknown): boolean {
  return hasUnavailableReason(error, GATEWAY_SUSPEND_UNAVAILABLE_REASON);
}

function hasUnavailableReason(error: unknown, reason: string): boolean {
  if (!error || typeof error !== "object" || !("details" in error)) {
    return false;
  }
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    "reason" in details &&
    details.reason === reason
  );
}
