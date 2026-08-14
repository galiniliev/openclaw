import { randomBytes } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createCurrentMemorySessionContext } from "../state/memory-session-subject.js";

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const MAX_ACTIVE_CAPABILITIES = 4096;
const RUN_LIFETIME_EXPIRES_AT_MS = Number.MAX_SAFE_INTEGER;

type MemoryPostboxTurnCapability = Readonly<{
  agentId: string;
  runId: string;
  sessionKey: string;
  sessionId?: string;
  sourceChannelRef: string;
  sourceMessageRef: string;
  senderEvidenceRef: string;
  targetPrincipalId: string;
  expiresAtMs: number;
}>;

export type ResolvedMemoryPostboxSource = Readonly<{
  sourceChannelRef: string;
  sourceMessageRef: string;
  senderEvidenceRef: string;
  /** The core-selected private subject whose quarantine receives this source. */
  targetPrincipalId: string;
}>;

const capabilitiesByToken = new Map<string, MemoryPostboxTurnCapability>();

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

function sweepExpiredMemoryPostboxTurnCapabilities(nowMs: number = Date.now()): void {
  for (const [token, capability] of capabilitiesByToken) {
    if (nowMs >= capability.expiresAtMs) {
      capabilitiesByToken.delete(token);
    }
  }
}

/**
 * Minted only from an admitted inbound user turn. The opaque token is later scoped to the selected
 * memory plugin, which redeems current channel/sender evidence without accepting it from tool args.
 */
export function mintMemoryPostboxTurnCapability(params: {
  agentId: string;
  runId: string;
  sessionKey: string;
  sessionId?: string;
  sourceChannelRef: string;
  sourceMessageRef: string;
  senderEvidenceRef: string;
  /** Resolved only by core from the current verified user session subject. */
  targetPrincipalId: string;
  expiresWithRun?: boolean;
  ttlMs?: number;
  nowMs?: number;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const runId = required(params.runId, "run identity");
  const sessionKey = required(params.sessionKey, "session identity");
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
      sessionId: normalizeOptionalString(params.sessionId),
      sourceChannelRef: required(params.sourceChannelRef, "source channel evidence"),
      sourceMessageRef: required(params.sourceMessageRef, "source message evidence"),
      senderEvidenceRef: required(params.senderEvidenceRef, "sender evidence"),
      targetPrincipalId: required(params.targetPrincipalId, "target principal"),
      expiresAtMs: params.expiresWithRun
        ? RUN_LIFETIME_EXPIRES_AT_MS
        : nowMs + resolveTtlMs(params.ttlMs),
    }),
  );
  return token;
}

/** Rejects forged, stale, cross-agent, cross-run, and cross-session tokens without disclosure. */
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
    (capability.sessionId && capability.sessionId !== normalizeOptionalString(params.sessionId))
  ) {
    if (nowMs >= capability.expiresAtMs) {
      capabilitiesByToken.delete(token);
    }
    return undefined;
  }
  return Object.freeze({
    sourceChannelRef: capability.sourceChannelRef,
    sourceMessageRef: capability.sourceMessageRef,
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
  const session = createCurrentMemorySessionContext({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    options: { agentId: params.agentId },
  });
  return session.kind === "current" && session.context.subject.kind === "user"
    ? session.context.principalId
    : undefined;
}

export function revokeMemoryPostboxTurnCapability(token: string | undefined): boolean {
  return Boolean(token && capabilitiesByToken.delete(token));
}

export function resetMemoryPostboxTurnCapabilitiesForTest(): void {
  capabilitiesByToken.clear();
}
