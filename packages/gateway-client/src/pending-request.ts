import type { ErrorShape, ResponseFrame } from "@openclaw/gateway-protocol";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "@openclaw/gateway-protocol/frame-guards";
import {
  GATEWAY_SUSPEND_IDENTITY_RETRY_AFTER_MS,
  isGatewayRestartUnavailableError,
  isGatewaySuspendUnavailableError,
  isGatewayPlannedHandoffUnavailableError,
  isGatewayPlannedHandoffReadInterruption,
} from "@openclaw/gateway-protocol/restart-unavailable";
import { isRetryableGatewayStartupUnavailableError } from "@openclaw/gateway-protocol/startup-unavailable";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import {
  GatewayPayloadLimitError,
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  retainGatewayResponsePayload,
  type GatewayProtocolRequestOptions,
} from "./protocol-request.js";
import { resolveFiniteTimeoutDelayMs, resolveSafeTimeoutDelayMs } from "./timeouts.js";

export type GatewayProtocolRequestTiming = {
  id: string;
  method: string;
  ok: boolean;
  durationMs: number;
  startedAtMs: number;
  endedAtMs: number;
  errorCode?: string;
};

type GatewayPendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  expectFinal: boolean;
  acceptedNotified: boolean;
  onAccepted?: (payload: unknown) => void;
  cleanup?: () => void;
  unbounded: boolean;
  method: string;
  startedAtMs: number;
  resend?: () => void;
  retryStartup?: (retryAfterMs?: number) => void;
  prepareRetry: (provenNonDelivery?: boolean) => boolean;
  waitingForResume?: boolean;
  afterHello?: () => void;
  plannedNonDelivery?: { recoveryScope: string; storeIdentity: string };
  plannedRead?: { recoveryScope: string; storeIdentity: string };
  waitingForReconnect?: boolean;
};

type GatewayPendingRequestsOptions = {
  createRequestId: () => string;
  createRequestError?: (error: Partial<ErrorShape>) => GatewayProtocolRequestError;
  createRequestTimeoutError?: (method: string, timeoutMs: number, requestSent: boolean) => Error;
  createRequestAbortError?: (method: string) => Error;
  requestTimeoutMs?: number;
  nowMs: () => number;
  onTiming?: (timing: GatewayProtocolRequestTiming) => void;
  onCallbackError?: (label: string, error: unknown) => void;
};

/** Owns request deadlines, correlation, settlement, and generation-scoped IDs. */
export class GatewayPendingRequests {
  maxPayloadBytes: number | undefined = MAX_PREAUTH_PAYLOAD_BYTES;
  private reconnectIdentity?: { recoveryScope: string; storeIdentity: string };
  private plannedReadMethods = new Set<string>();
  private pending = new Map<string, GatewayPendingRequest>();
  private requestSequence = 0;
  private bootstrapPause:
    | {
        timer?: ReturnType<typeof setTimeout>;
        probe?: { pending: GatewayPendingRequest; revision: number };
        retryAtMs: number;
        revision: number;
        announced: boolean;
      }
    | undefined;

  constructor(private readonly opts: GatewayPendingRequestsOptions) {}

  /** Called after the new authenticated hello is accepted, before retained sends resume. */
  acceptReconnectIdentity(
    recoveryScope: string | undefined,
    storeIdentity: string | undefined,
    plannedReadMethods: readonly string[] = [],
  ): void {
    this.reconnectIdentity =
      recoveryScope && storeIdentity ? { recoveryScope, storeIdentity } : undefined;
    this.plannedReadMethods = new Set(plannedReadMethods);
    for (const [id, pending] of this.pending) {
      const expected = pending.plannedNonDelivery ?? pending.plannedRead;
      if (
        expected &&
        (expected.recoveryScope !== recoveryScope ||
          expected.storeIdentity !== storeIdentity ||
          (pending.plannedRead && !this.plannedReadMethods.has(pending.method)))
      ) {
        this.pending.delete(id);
        pending.cleanup?.();
        this.finishTiming(id, pending, false, "HANDOFF_IDENTITY_CHANGED");
        pending.reject(
          new Error("Gateway identity or logical store changed during planned handoff"),
        );
        continue;
      }
      pending.waitingForReconnect = false;
      if (pending.plannedRead && pending.waitingForResume) {
        pending.resend?.();
      }
    }
  }

  setSuspensionPhase(phase: unknown): void {
    if (phase === "accepting") {
      this.resumeBootstrapRequests();
    } else if (phase === "preparing" || phase === "draining" || phase === "prepared") {
      this.pauseBootstrapRequests(undefined, true);
    }
  }

  private pauseBootstrapRequests(
    retryAfterMs = GATEWAY_SUSPEND_IDENTITY_RETRY_AFTER_MS,
    announced = false,
  ): void {
    const nowMs = this.opts.nowMs();
    const delayMs = resolveSafeTimeoutDelayMs(
      Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs
        : GATEWAY_SUSPEND_IDENTITY_RETRY_AFTER_MS,
    );
    const pause = (this.bootstrapPause ??= { retryAtMs: nowMs, revision: 0, announced });
    pause.announced ||= announced;
    pause.revision += 1;
    pause.retryAtMs = Math.max(pause.retryAtMs, nowMs + delayMs);
    clearTimeout(pause.timer);
    pause.timer = undefined;
    // An announced drain ends through readiness or connection retirement, not a read probe.
    if (pause.announced) {
      return;
    }
    pause.timer = setTimeout(
      () => {
        // A rolled-back fence may not publish readiness. An expired empty
        // pause lets the next read probe without imposing another wait.
        pause.timer = undefined;
        this.drainBootstrapRequests();
      },
      resolveSafeTimeoutDelayMs(pause.retryAtMs - nowMs),
    );
    pause.timer.unref?.();
  }

  private resumeBootstrapRequests(): void {
    clearTimeout(this.bootstrapPause?.timer);
    this.bootstrapPause = undefined;
    this.drainBootstrapRequests();
  }

  private drainBootstrapRequests(): void {
    for (const pending of this.pending.values()) {
      if (pending.waitingForResume) {
        pending.resend?.();
      }
    }
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  get hasUnboundedPending(): boolean {
    for (const pending of this.pending.values()) {
      if (pending.unbounded) {
        return true;
      }
    }
    return false;
  }

  releaseHeldRequests(isCurrent: () => boolean): void {
    for (const pending of this.pending.values()) {
      if (!isCurrent()) {
        return;
      }
      const send = pending.afterHello;
      pending.afterHello = undefined;
      send?.();
    }
  }

  request<T>(
    sender: { send: (data: string) => void },
    method: string,
    params?: unknown,
    options?: GatewayProtocolRequestOptions,
    deferUntilHello = false,
  ): Promise<T> {
    let id: string;
    try {
      this.requestSequence += 1;
      id = `${this.requestSequence}:${this.opts.createRequestId()}`;
    } catch (error) {
      return Promise.reject(toStringifiedError(error));
    }
    const requestedTimeoutMs =
      options?.timeoutMs === null ? undefined : (options?.timeoutMs ?? this.opts.requestTimeoutMs);
    const timeoutMs =
      typeof requestedTimeoutMs === "number" && Number.isFinite(requestedTimeoutMs)
        ? resolveSafeTimeoutDelayMs(requestedTimeoutMs, { minMs: 0 })
        : undefined;
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let startupRetry: ReturnType<typeof setTimeout> | undefined;
      let requestSent = false;
      let inFlight = false;
      let retainedSend: (() => void) | undefined;
      const pending: GatewayPendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        expectFinal: options?.expectFinal === true,
        acceptedNotified: false,
        onAccepted: options?.onAccepted,
        unbounded: timeoutMs === undefined,
        method,
        startedAtMs: this.opts.nowMs(),
        prepareRetry: (provenNonDelivery = true) => {
          inFlight = false;
          if (provenNonDelivery) {
            requestSent = false;
          }
          if (options?.signal?.aborted) {
            onAbort();
            return false;
          }
          return true;
        },
      };
      const cleanup = () => {
        clearTimeout(startupRetry);
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        options?.signal?.removeEventListener("abort", onAbort);
        if (this.bootstrapPause?.probe?.pending === pending) {
          this.bootstrapPause.probe = undefined;
          this.drainBootstrapRequests();
        }
      };
      const retire = (errorCode: string): boolean => {
        if (this.pending.get(id) !== pending) {
          return false;
        }
        this.pending.delete(id);
        cleanup();
        this.finishTiming(id, pending, false, errorCode);
        return true;
      };
      const onAbort = () => {
        if (options?.retainSentResultOnAbort && inFlight) {
          return;
        }
        if (!retire("CLIENT_ABORTED")) {
          return;
        }
        reject(
          this.opts.createRequestAbortError?.(method) ??
            new Error(`gateway request aborted for ${method}`),
        );
      };
      if (options?.signal?.aborted) {
        reject(
          this.opts.createRequestAbortError?.(method) ??
            new Error(`gateway request aborted for ${method}`),
        );
        return;
      }
      pending.cleanup = cleanup;
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          if (!retire("CLIENT_TIMEOUT")) {
            return;
          }
          reject(
            this.opts.createRequestTimeoutError?.(method, timeoutMs, requestSent) ??
              new GatewayProtocolRequestTimeoutError({ method, timeoutMs, requestSent }),
          );
        }, timeoutMs);
        timeout.unref?.();
      }
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, pending);
      try {
        const frame = JSON.stringify({ type: "req", id, method, params });
        const send = () => {
          if (
            this.pending.get(id) !== pending ||
            inFlight ||
            pending.waitingForReconnect ||
            options?.signal?.aborted ||
            (timeoutMs !== undefined && this.opts.nowMs() - pending.startedAtMs >= timeoutMs)
          ) {
            return;
          }
          // Held pre-hello reads bind to the identity that actually admits their send.
          if (
            !pending.plannedRead &&
            this.reconnectIdentity &&
            this.plannedReadMethods.has(method)
          ) {
            pending.plannedRead = { ...this.reconnectIdentity };
          }
          const pause = pending.resend && !pending.plannedRead ? this.bootstrapPause : undefined;
          if (pause && !pause.announced && !pause.timer && !pause.probe) {
            pause.probe = { pending, revision: pause.revision };
          }
          pending.waitingForResume = Boolean(
            pause && (pause.announced || pause.probe?.pending !== pending),
          );
          if (pending.waitingForResume) {
            return;
          }
          try {
            const limit = this.maxPayloadBytes;
            const bytes = new TextEncoder().encode(frame).byteLength;
            if (limit !== undefined && bytes > limit) {
              throw new GatewayPayloadLimitError(bytes, limit);
            }
            clearTimeout(startupRetry);
            startupRetry = undefined;
            // A new send has an unknown outcome until this generation proves
            // non-delivery again. Never reuse the predecessor's refusal proof.
            pending.plannedNonDelivery = undefined;
            inFlight = true;
            sender.send(frame);
            if (this.pending.get(id) !== pending) {
              return;
            }
            // A synchronous refusal can already have proved non-delivery.
            requestSent = inFlight;
            this.invoke("sent", () => options?.onSent?.(id));
          } catch (error) {
            if (retire("CLIENT_SEND_ERROR")) {
              reject(toStringifiedError(error));
            }
          }
        };
        retainedSend = send;
        // A startup refusal proves the handler has not run, so later attempts can
        // share pause/resume. Ordinary writes still send synchronously.
        pending.retryStartup = (retryAfterMs) => {
          pending.resend = retainedSend;
          clearTimeout(startupRetry);
          startupRetry = setTimeout(
            send,
            resolveFiniteTimeoutDelayMs(retryAfterMs, GATEWAY_SUSPEND_IDENTITY_RETRY_AFTER_MS),
          );
          startupRetry.unref?.();
        };
        if (
          method === "agent.identity.get" ||
          method === "sessions.subscribe" ||
          method === "sessions.groups.list" ||
          method === "question.list" ||
          method === "sessions.list"
        ) {
          pending.resend = send;
        }
        if (deferUntilHello) {
          pending.afterHello = send;
        } else {
          send();
        }
      } catch (error) {
        if (retire("CLIENT_SEND_ERROR")) {
          reject(toStringifiedError(error));
        }
      }
    });
  }

  handleResponse(frame: ResponseFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) {
      return;
    }
    const status = (frame.payload as { status?: unknown } | undefined)?.status;
    if (frame.ok && pending.expectFinal && status === "accepted") {
      if (!pending.acceptedNotified) {
        pending.acceptedNotified = true;
        this.invoke("accepted", () => pending.onAccepted?.(frame.payload));
      }
      return;
    }
    const startupDetails = frame.error?.details;
    if (
      !frame.ok &&
      !pending.acceptedNotified &&
      this.reconnectIdentity &&
      (isGatewayPlannedHandoffUnavailableError(frame.error) ||
        (pending.plannedRead && isGatewayPlannedHandoffReadInterruption(frame.error))) &&
      startupDetails &&
      typeof startupDetails === "object" &&
      "method" in startupDetails &&
      startupDetails.method === pending.method &&
      pending.prepareRetry()
    ) {
      if (isGatewayPlannedHandoffUnavailableError(frame.error)) {
        pending.plannedNonDelivery = { ...this.reconnectIdentity };
      }
      this.pauseBootstrapRequests(1_000, true);
      pending.retryStartup?.(1_000);
      pending.waitingForResume = true;
      return;
    }
    const startupRefusal =
      !frame.ok &&
      isRetryableGatewayStartupUnavailableError(frame.error) &&
      startupDetails !== null &&
      typeof startupDetails === "object" &&
      "method" in startupDetails &&
      startupDetails.method === pending.method;
    if (startupRefusal && !pending.acceptedNotified) {
      if (pending.prepareRetry()) {
        pending.retryStartup?.(frame.error?.retryAfterMs);
        if (
          this.bootstrapPause?.probe?.pending === pending &&
          this.bootstrapPause.probe.revision === this.bootstrapPause.revision
        ) {
          // Agent-local preparation no longer needs the Gateway-wide recovery fence.
          this.resumeBootstrapRequests();
        }
      }
      return;
    }
    if (
      !frame.ok &&
      pending.resend &&
      !pending.acceptedNotified &&
      frame.error?.code === "UNAVAILABLE" &&
      frame.error.retryable === true &&
      (isGatewaySuspendUnavailableError(frame.error) ||
        isGatewayRestartUnavailableError(frame.error))
    ) {
      if (!pending.prepareRetry()) {
        return;
      }
      // The admission fence refused execution. Keep the original deadline and cancellation.
      if (this.bootstrapPause?.probe?.pending === pending) {
        this.bootstrapPause.probe = undefined;
      }
      this.pauseBootstrapRequests(
        isGatewayRestartUnavailableError(frame.error)
          ? Math.ceil(
              Math.max(GATEWAY_SUSPEND_IDENTITY_RETRY_AFTER_MS, frame.error.retryAfterMs ?? 0) *
                (1 + Math.random() * 0.2),
            )
          : frame.error.retryAfterMs,
      );
      pending.waitingForResume = true;
      return;
    }
    this.pending.delete(frame.id);
    if (
      frame.ok &&
      this.bootstrapPause?.probe?.pending === pending &&
      this.bootstrapPause.probe.revision === this.bootstrapPause.revision
    ) {
      this.resumeBootstrapRequests();
    }
    pending.cleanup?.();
    if (frame.ok) {
      this.finishTiming(frame.id, pending, true);
      pending.resolve(frame.payload);
      return;
    }
    this.finishTiming(frame.id, pending, false, frame.error?.code);
    const error =
      this.opts.createRequestError?.(frame.error ?? {}) ??
      new GatewayProtocolRequestError(frame.error ?? {});
    retainGatewayResponsePayload(error, frame.payload);
    pending.reject(error);
  }

  flush(error: Error, preservePlannedHandoff = false): void {
    this.maxPayloadBytes = MAX_PREAUTH_PAYLOAD_BYTES;
    this.reconnectIdentity = undefined;
    this.plannedReadMethods.clear();
    clearTimeout(this.bootstrapPause?.timer);
    this.bootstrapPause = undefined;
    const retired = this.pending;
    this.pending = new Map();
    if (preservePlannedHandoff) {
      for (const [id, pending] of retired) {
        if ((pending.plannedNonDelivery || pending.plannedRead) && !pending.acceptedNotified) {
          this.pending.set(id, pending);
          retired.delete(id);
          if (!pending.prepareRetry(pending.plannedNonDelivery !== undefined)) {
            continue;
          }
          pending.retryStartup?.(1);
          pending.waitingForResume = true;
          pending.waitingForReconnect = true;
        }
      }
      if (this.pending.size > 0) {
        this.pauseBootstrapRequests(1_000, true);
      }
    }
    // Timing observers can reconnect synchronously, so detach the entire old
    // generation and reset its sequence before running any caller-owned code.
    if (this.pending.size === 0) {
      this.requestSequence = 0;
    }
    for (const [id, pending] of retired) {
      pending.cleanup?.();
      this.finishTiming(id, pending, false, "CLIENT_CLOSED");
      pending.reject(error);
    }
  }

  private finishTiming(
    id: string,
    pending: GatewayPendingRequest,
    ok: boolean,
    errorCode?: string,
  ): void {
    const endedAtMs = this.opts.nowMs();
    this.invoke("request timing", () =>
      this.opts.onTiming?.({
        id,
        method: pending.method,
        ok,
        durationMs: Math.max(0, endedAtMs - pending.startedAtMs),
        startedAtMs: pending.startedAtMs,
        endedAtMs,
        errorCode,
      }),
    );
  }

  private invoke(label: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.opts.onCallbackError?.(label, error);
    }
  }
}
