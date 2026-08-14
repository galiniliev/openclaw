import { randomBytes } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { createCurrentMemorySessionContext } from "../state/memory-session-subject.js";
import { isTrustedMessageActionTurnIngress } from "./message-action-turn-capability.js";

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const MAX_ACTIVE_CAPABILITIES = 4096;
const RUN_LIFETIME_EXPIRES_AT_MS = Number.MAX_SAFE_INTEGER;

type MemoryPostboxTurnCapability = Readonly<{
  agentId: string;
  runId: string;
  sessionKey: string;
  sessionId: string;
  sourceTurnId: string;
  sourceChannelRef: string;
  senderEvidenceRef: string;
  targetPrincipalId: string;
  sessionContextFingerprint: string;
  expiresAtMs: number;
}>;

export type ResolvedMemoryPostboxSource = Readonly<{
  /** Opaque, account-and-conversation-scoped identity minted at trusted channel ingress. */
  sourceTurnId: string;
  sourceChannelRef: string;
  senderEvidenceRef: string;
  /** The core-selected private subject whose quarantine receives this source. */
  targetPrincipalId: string;
}>;

const capabilitiesByToken = new Map<string, MemoryPostboxTurnCapability>();
const admittedIngressByContext = new WeakMap<object, AdmittedMemoryPostboxIngress>();

type AdmittedMemoryPostboxIngress = Readonly<
  ResolvedMemoryPostboxSource & {
    agentId: string;
    sessionKey: string;
    sessionId: string;
    sessionContextFingerprint: string;
  }
>;

function resolveTtlMs(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(Math.trunc(value), MAX_TTL_MS);
}

function required(value: string | undefined, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`memory postbox turn capability requires ${label}`);
  }
  return normalized;
}

function readCurrentUserSubject(params: {
  agentId: string;
  sessionKey: string;
  sessionId: string;
}) {
  const session = createCurrentMemorySessionContext({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    options: { agentId: params.agentId },
  });
  return session.kind === "current" && session.context.subject.kind === "user"
    ? Object.freeze({
        principalId: session.context.principalId,
        fingerprint: session.context.fingerprint,
      })
    : undefined;
}

/**
 * Stamps one exact inbound context after channel routing has selected both the source message and
 * the current user subject. A copied symbol field or caller-supplied session tuple cannot recover
 * this record, and non-user/system continuations intentionally receive no postbox authority.
 */
export function admitMemoryPostboxTurnIngress(params: {
  context: object;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  provider: string | undefined;
  inputProvenance: InputProvenance | undefined;
  sourceTurnId: string | undefined;
  sourceChannelRef: string | undefined;
  senderEvidenceRef: string | undefined;
}): void {
  admittedIngressByContext.delete(params.context);
  if (
    !isTrustedMessageActionTurnIngress(params.provider) ||
    params.inputProvenance?.kind !== "external_user"
  ) {
    return;
  }
  const sourceTurnId = normalizeOptionalString(params.sourceTurnId);
  const sourceChannelRef = normalizeOptionalString(params.sourceChannelRef);
  const senderEvidenceRef = normalizeOptionalString(params.senderEvidenceRef);
  if (!sourceTurnId || !sourceChannelRef || !senderEvidenceRef) {
    return;
  }
  const agentId = normalizeAgentId(params.agentId);
  const sessionKey = required(params.sessionKey, "session identity");
  const sessionId = required(params.sessionId, "session generation");
  const subject = readCurrentUserSubject({ agentId, sessionKey, sessionId });
  if (!subject) {
    return;
  }
  admittedIngressByContext.set(
    params.context,
    Object.freeze({
      agentId,
      sessionKey,
      sessionId,
      sourceTurnId,
      sourceChannelRef,
      senderEvidenceRef,
      targetPrincipalId: subject.principalId,
      sessionContextFingerprint: subject.fingerprint,
    }),
  );
}

function sweepExpiredMemoryPostboxTurnCapabilities(nowMs: number = Date.now()): void {
  for (const [token, capability] of capabilitiesByToken) {
    if (nowMs >= capability.expiresAtMs) {
      capabilitiesByToken.delete(token);
    }
  }
}

/**
 * Minted only from the exact context admitted at trusted external-user ingress. Neither callers nor
 * models may select the source, sender evidence, target principal, or the session it belongs to.
 */
export function mintMemoryPostboxTurnCapability(params: {
  agentId: string;
  runId: string;
  sessionKey: string;
  sessionId: string;
  /** The inbound context whose private marker is written only by trusted channel ingress. */
  sourceContext: object;
  expiresWithRun?: boolean;
  ttlMs?: number;
  nowMs?: number;
}): string | undefined {
  const agentId = normalizeAgentId(params.agentId);
  const runId = required(params.runId, "run identity");
  const sessionKey = required(params.sessionKey, "session identity");
  const sessionId = required(params.sessionId, "session generation");
  const source = admittedIngressByContext.get(params.sourceContext);
  if (
    !source ||
    source.agentId !== agentId ||
    source.sessionKey !== sessionKey ||
    source.sessionId !== sessionId
  ) {
    return undefined;
  }
  const subject = readCurrentUserSubject({ agentId, sessionKey, sessionId });
  if (
    !subject ||
    subject.principalId !== source.targetPrincipalId ||
    subject.fingerprint !== source.sessionContextFingerprint
  ) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  sweepExpiredMemoryPostboxTurnCapabilities(nowMs);
  pruneMapToMaxSize(capabilitiesByToken, MAX_ACTIVE_CAPABILITIES - 1);
  const token = randomBytes(32).toString("base64url");
  capabilitiesByToken.set(
    token,
    Object.freeze({
      agentId,
      runId,
      sessionKey,
      sessionId,
      sourceTurnId: source.sourceTurnId,
      sourceChannelRef: source.sourceChannelRef,
      senderEvidenceRef: source.senderEvidenceRef,
      targetPrincipalId: source.targetPrincipalId,
      sessionContextFingerprint: source.sessionContextFingerprint,
      expiresAtMs: params.expiresWithRun
        ? RUN_LIFETIME_EXPIRES_AT_MS
        : nowMs + resolveTtlMs(params.ttlMs),
    }),
  );
  return token;
}

/** Rejects forged, stale, rebound, cross-agent, cross-run, and cross-session tokens without disclosure. */
export function resolveMemoryPostboxTurnCapability(params: {
  token?: string;
  agentId: string;
  runId?: string;
  sessionKey: string;
  sessionId?: string;
  nowMs?: number;
}): ResolvedMemoryPostboxSource | undefined {
  const token = normalizeOptionalString(params.token);
  if (!token) {
    return undefined;
  }
  const capability = capabilitiesByToken.get(token);
  if (!capability) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  if (
    nowMs >= capability.expiresAtMs ||
    capability.agentId !== normalizeAgentId(params.agentId) ||
    capability.runId !== normalizeOptionalString(params.runId) ||
    capability.sessionKey !== normalizeOptionalString(params.sessionKey) ||
    capability.sessionId !== normalizeOptionalString(params.sessionId)
  ) {
    if (nowMs >= capability.expiresAtMs) {
      capabilitiesByToken.delete(token);
    }
    return undefined;
  }
  const subject = readCurrentUserSubject({
    agentId: capability.agentId,
    sessionKey: capability.sessionKey,
    sessionId: capability.sessionId,
  });
  if (
    !subject ||
    subject.principalId !== capability.targetPrincipalId ||
    subject.fingerprint !== capability.sessionContextFingerprint
  ) {
    return undefined;
  }
  return Object.freeze({
    sourceTurnId: capability.sourceTurnId,
    sourceChannelRef: capability.sourceChannelRef,
    senderEvidenceRef: capability.senderEvidenceRef,
    targetPrincipalId: capability.targetPrincipalId,
  });
}

/**
 * A postbox source can target only the current verified user's quarantine. Group and autonomous
 * sessions intentionally have no fallback target: a sender id or model argument must not pick one.
 */
export function resolveMemoryPostboxTargetPrincipal(params: {
  agentId: string;
  sessionKey: string;
  sessionId: string;
}): string | undefined {
  return readCurrentUserSubject(params)?.principalId;
}

export function revokeMemoryPostboxTurnCapability(token: string | undefined): boolean {
  return Boolean(token && capabilitiesByToken.delete(token));
}

export function resetMemoryPostboxTurnCapabilitiesForTest(): void {
  capabilitiesByToken.clear();
}
