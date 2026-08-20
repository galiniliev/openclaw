import { createHash } from "node:crypto";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import type { AudienceRef } from "../memory-host-sdk/host/authorization.js";
import { isMemoryIsolationCutoverAgent } from "../plugins/memory-cutover.js";
import {
  readLatestDurableMemoryRunExposure,
  type DurableMemoryRunExposureLookup,
} from "../plugins/memory-run-exposure-ledger.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { readCurrentEnterpriseMemoryFactsForUser } from "../state/memory-enterprise-admission.js";
import { recheckMemoryIdentityBindingRecipient } from "../state/memory-identity.js";
import { createCurrentMemorySessionContext } from "../state/memory-session-subject.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

/** The constrained Phase 1D pilot exposes only automatic final replies. */
export const MEMORY_EGRESS_CAPABILITY_REPLY_FINAL = "reply.final";
export const MEMORY_EGRESS_REGISTRY_REVISION = "mer1_reply-final";

type MemoryEgressDeliveryFacts = Readonly<{
  sink: "private" | "channel" | "internal";
  audiences: readonly AudienceRef[];
  deliveryRevision: string;
  egressRegistryRevision: typeof MEMORY_EGRESS_REGISTRY_REVISION;
}>;

export type MemoryEgressAuthorization = Readonly<{
  version: 1;
  capabilityId: string;
  agentId: string;
  sessionId: string;
  runId: string;
  deliveryRevision: string;
  egressRegistryRevision: string;
  audiences: readonly AudienceRef[];
  exposure?: Readonly<{ exposureSetId: string; revisionNumber: number }>;
}>;

/** Internal queue marker; it never crosses a channel or plugin payload boundary. */
export type MemoryEgressPayloadAuthorization =
  | Readonly<{ kind: "authorized"; authorization: MemoryEgressAuthorization }>
  | Readonly<{ kind: "denied"; reason: "unregistered" | "unavailable" | "stale" }>;

export type MemoryEgressAdmission =
  | Readonly<{ allowed: true; authorization: MemoryEgressAuthorization }>
  | Readonly<{ allowed: false; reason: "unregistered" | "unavailable" | "stale" }>;

/**
 * Core-owned route input sampled at the queue and platform-I/O boundaries.
 * A captured dispatch context is not sufficient: the actual delivery owner
 * must provide current routing facts again before it sends anything visible.
 */
export type TrustedMemoryEgressDeliveryFacts = Readonly<{
  deliveryContext?: DeliveryContext;
  messageChannel?: string;
  agentAccountId?: string;
}>;

export type TrustedMemoryEgressDeliveryFactsSource = () =>
  | TrustedMemoryEgressDeliveryFacts
  | undefined;

export function memoryEgressPayloadAuthorization(
  admission: MemoryEgressAdmission,
): MemoryEgressPayloadAuthorization {
  return admission.allowed
    ? Object.freeze({ kind: "authorized", authorization: admission.authorization })
    : Object.freeze({ kind: "denied", reason: admission.reason });
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function sortedAudiences(audiences: readonly AudienceRef[]): readonly AudienceRef[] {
  const unique = new Map<string, AudienceRef>();
  for (const audience of audiences) {
    unique.set(`${audience.kind}\u0000${audience.id}`, Object.freeze({
      kind: audience.kind,
      id: audience.id,
    }));
  }
  return Object.freeze(
    [...unique.values()]
      .toSorted((left, right) =>
        `${left.kind}\u0000${left.id}`.localeCompare(`${right.kind}\u0000${right.id}`),
      ),
  );
}

function sameAudiences(left: readonly AudienceRef[], right: readonly AudienceRef[]): boolean {
  const keys = (audiences: readonly AudienceRef[]) =>
    audiences.map((audience) => `${audience.kind}\u0000${audience.id}`).toSorted();
  const leftKeys = keys(left);
  const rightKeys = keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((value, index) => value === rightKeys[index])
  );
}

function currentEnterpriseRoleAudiences(userPrincipalId: string): readonly AudienceRef[] {
  const memberships = readCurrentEnterpriseMemoryFactsForUser({ userPrincipalId })
    .verifiedMemberships;
  return memberships
    .filter((membership) => membership.principalId === userPrincipalId)
    .map((membership) => ({ kind: "role" as const, id: membership.groupId }));
}

/** Recomputes route, sink, and audience facts from the current session owner. */
export function resolveMemoryEgressDeliveryFacts(params: {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  deliveryContext?: DeliveryContext;
  messageChannel?: string;
  agentAccountId?: string;
}): MemoryEgressDeliveryFacts | undefined {
  const session = createCurrentMemorySessionContext({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    options: { agentId: params.agentId },
  });
  if (session.kind !== "current") {
    return undefined;
  }
  const route = {
    channel: params.deliveryContext?.channel ?? params.messageChannel ?? null,
    accountId: params.deliveryContext?.accountId ?? params.agentAccountId ?? null,
    to: params.deliveryContext?.to ?? null,
    threadId: params.deliveryContext?.threadId ?? null,
  };
  if (!route.channel?.trim() || !route.accountId?.trim() || !route.to?.trim()) {
    return undefined;
  }
  const channel = route.channel.trim().toLowerCase();
  const accountId = normalizeAccountId(route.accountId.trim());
  const to = route.to.trim();
  const sinkAndAudiences =
    session.context.subject.kind === "user"
      ? session.context.bindingId &&
        recheckMemoryIdentityBindingRecipient({
          bindingId: session.context.bindingId,
          channel,
          accountId,
          recipientId: to,
        }).kind === "current"
        ? {
            sink: "private" as const,
            // A direct recipient may receive role-scoped memory only while the
            // matching verified membership is current. Keep it in the same
            // route fact as outbound egress so revocation invalidates both.
            audiences: [
              { kind: "user" as const, id: session.context.subject.principalId },
              ...currentEnterpriseRoleAudiences(session.context.subject.principalId),
            ],
          }
        : undefined
      : session.context.subject.kind === "conversation"
        ? session.context.conversation &&
          session.context.conversation.channel === channel &&
          session.context.conversation.accountId === accountId &&
          session.context.conversation.deliveryTarget === to
          ? {
              sink: "channel" as const,
              audiences: [{ kind: "conversation" as const, id: session.context.principalId }],
            }
          : undefined
        : undefined;
  if (!sinkAndAudiences) {
    return undefined;
  }
  const audiences = sortedAudiences(sinkAndAudiences.audiences);
  return Object.freeze({
    sink: sinkAndAudiences.sink,
    audiences,
    // Sink and audience are deliberately inside this revision: a route that keeps the same
    // transport target must still lose authority when its recipient classification changes.
    deliveryRevision: `mdr1_${hash({ route: { ...route, channel, accountId, to }, sink: sinkAndAudiences.sink, audiences })}`,
    egressRegistryRevision: MEMORY_EGRESS_REGISTRY_REVISION,
  });
}

function resolveRunIdentity(params: {
  runId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
}) {
  const runId = params.runId?.trim();
  const registered = runId ? getAgentRunContext(runId) : undefined;
  const agentId = params.agentId?.trim() || registered?.agentId?.trim();
  const sessionId = params.sessionId?.trim() || registered?.sessionId?.trim();
  const sessionKey = params.sessionKey?.trim() || registered?.sessionKey?.trim();
  return runId && agentId && sessionId && sessionKey
    ? { runId, agentId, sessionId, sessionKey }
    : undefined;
}

function resolveTrustedDeliveryFacts(params: {
  deliveryContext?: DeliveryContext;
  messageChannel?: string;
  agentAccountId?: string;
  resolveDeliveryFacts?: TrustedMemoryEgressDeliveryFactsSource;
}): TrustedMemoryEgressDeliveryFacts | undefined {
  if (!params.resolveDeliveryFacts) {
    return {
      deliveryContext: params.deliveryContext,
      messageChannel: params.messageChannel,
      agentAccountId: params.agentAccountId,
    };
  }
  try {
    return params.resolveDeliveryFacts();
  } catch {
    // A delivery owner that cannot state its current route cannot safely send
    // selected memory content to a recipient.
    return undefined;
  }
}

function authorizationFromLookup(params: {
  capabilityId: string;
  identity: NonNullable<ReturnType<typeof resolveRunIdentity>>;
  facts: MemoryEgressDeliveryFacts;
  lookup: DurableMemoryRunExposureLookup;
}): MemoryEgressAdmission {
  const { capabilityId, identity, facts, lookup } = params;
  if (capabilityId !== MEMORY_EGRESS_CAPABILITY_REPLY_FINAL) {
    return Object.freeze({ allowed: false, reason: "unregistered" });
  }
  if (lookup.kind === "unavailable") {
    return Object.freeze({ allowed: false, reason: "unavailable" });
  }
  if (lookup.kind === "absent") {
    return Object.freeze({
      allowed: true,
      authorization: Object.freeze({
        version: 1,
        capabilityId,
        ...identity,
        deliveryRevision: facts.deliveryRevision,
        egressRegistryRevision: facts.egressRegistryRevision,
        audiences: facts.audiences,
      }),
    });
  }
  const snapshot = lookup.snapshot;
  if (
    snapshot.agentId !== identity.agentId ||
    snapshot.sessionId !== identity.sessionId ||
    snapshot.sessionKey !== identity.sessionKey ||
    snapshot.runId !== identity.runId ||
    snapshot.deliveryRevision !== facts.deliveryRevision ||
    snapshot.egressRegistryRevision !== facts.egressRegistryRevision ||
    snapshot.egressReceiptIds.length === 0 ||
    !sameAudiences(snapshot.deliveryAudiences, facts.audiences)
  ) {
    return Object.freeze({ allowed: false, reason: "stale" });
  }
  return Object.freeze({
    allowed: true,
    authorization: Object.freeze({
      version: 1,
      capabilityId,
      ...identity,
      deliveryRevision: facts.deliveryRevision,
      egressRegistryRevision: facts.egressRegistryRevision,
      audiences: facts.audiences,
      exposure: Object.freeze({
        exposureSetId: snapshot.exposureSetId,
        revisionNumber: snapshot.revisionNumber,
      }),
    }),
  });
}

/** Issues a queue-time authorization bound to the latest durable exposure, never process state. */
export function prepareMemoryEgressAuthorization(params: {
  capabilityId: string;
  runId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  deliveryContext?: DeliveryContext;
  messageChannel?: string;
  agentAccountId?: string;
  resolveDeliveryFacts?: TrustedMemoryEgressDeliveryFactsSource;
}): MemoryEgressAdmission {
  const identity = resolveRunIdentity(params);
  const requestedAgentId = params.agentId?.trim();
  if (!identity && requestedAgentId && isMemoryIsolationCutoverAgent(requestedAgentId)) {
    return Object.freeze({ allowed: false, reason: "unavailable" });
  }
  if (!identity || !isMemoryIsolationCutoverAgent(identity.agentId)) {
    return Object.freeze({
      allowed: true,
      authorization: Object.freeze({
        version: 1,
        capabilityId: params.capabilityId,
        agentId: identity?.agentId ?? "",
        sessionId: identity?.sessionId ?? "",
        runId: identity?.runId ?? "",
        deliveryRevision: "",
        egressRegistryRevision: "",
        audiences: Object.freeze([]),
      }),
    });
  }
  const delivery = resolveTrustedDeliveryFacts(params);
  if (!delivery) {
    return Object.freeze({ allowed: false, reason: "unavailable" });
  }
  const facts = resolveMemoryEgressDeliveryFacts({ ...identity, ...delivery });
  if (!facts) {
    return Object.freeze({ allowed: false, reason: "unavailable" });
  }
  return authorizationFromLookup({
    capabilityId: params.capabilityId,
    identity,
    facts,
    lookup: readLatestDurableMemoryRunExposure(identity),
  });
}

/** Rechecks a queue-time authorization immediately before recipient-visible platform I/O. */
export function admitMemoryEgressAtDelivery(params: {
  authorization: MemoryEgressAuthorization;
  deliveryContext?: DeliveryContext;
  messageChannel?: string;
  agentAccountId?: string;
  resolveDeliveryFacts?: TrustedMemoryEgressDeliveryFactsSource;
}): MemoryEgressAdmission {
  const { authorization } = params;
  if (!authorization.agentId || !isMemoryIsolationCutoverAgent(authorization.agentId)) {
    return Object.freeze({ allowed: true, authorization });
  }
  const identity = resolveRunIdentity(authorization);
  if (!identity) {
    return Object.freeze({ allowed: false, reason: "unavailable" });
  }
  const delivery = resolveTrustedDeliveryFacts(params);
  if (!delivery) {
    return Object.freeze({ allowed: false, reason: "unavailable" });
  }
  const facts = resolveMemoryEgressDeliveryFacts({ ...identity, ...delivery });
  if (!facts) {
    return Object.freeze({ allowed: false, reason: "unavailable" });
  }
  const current = authorizationFromLookup({
    capabilityId: authorization.capabilityId,
    identity,
    facts,
    lookup: readLatestDurableMemoryRunExposure(identity),
  });
  if (!current.allowed) {
    return current;
  }
  const expectedExposure = authorization.exposure;
  const actualExposure = current.authorization.exposure;
  if (
    authorization.capabilityId !== current.authorization.capabilityId ||
    authorization.deliveryRevision !== current.authorization.deliveryRevision ||
    authorization.egressRegistryRevision !== current.authorization.egressRegistryRevision ||
    !sameAudiences(authorization.audiences, current.authorization.audiences) ||
    expectedExposure?.exposureSetId !== actualExposure?.exposureSetId ||
    expectedExposure?.revisionNumber !== actualExposure?.revisionNumber
  ) {
    return Object.freeze({ allowed: false, reason: "stale" });
  }
  return current;
}
