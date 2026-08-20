import { createHash, randomUUID } from "node:crypto";
import { readAuthorizedTranscriptDerivation } from "../config/sessions/session-transcript-memory-policy.js";
import type {
  AuthorizedMemoryVirtualView,
  AuthorizedSealedCompactionArtifact,
  AuthorizedResourceDerivationPurpose,
  AuthorizedTranscriptDerivationSource,
  AuthorizedTranscriptDerivationPurpose,
  MemoryAccessContext,
  MemoryActorEvidence,
} from "../memory-host-sdk/host/authorization.js";
import { isMemoryIsolationCutoverAgent } from "../plugins/memory-cutover.js";
import {
  MEMORY_INVOCATION_UNAVAILABLE,
  commitAuthorizedMemoryDerivationForInvocation,
  collectAuthorizedMemoryDerivationSources,
  createAuthorizedMemoryDeriveInvocation,
  createAuthorizedMemoryReadInvocation,
  createAuthorizedMemoryWriteInvocation,
  materializeAuthorizedMemoryVirtualView,
  readAuthorizedMemoryVirtualFile,
  readAuthorizedMemoryForInvocation,
  searchAuthorizedMemoryForInvocation,
  stageAuthorizedMemorySealedCompactionForInvocation,
  writeAuthorizedMemoryForInvocation,
  type AuthorizedMemoryDerivationInvocation,
  type AuthorizedMemoryReadInvocation,
} from "../plugins/memory-invocation.js";
import type {
  AuthorizedMemoryReadHost,
  AuthorizedMemoryResourceDerivationHost,
  AuthorizedMemoryWriteHost,
} from "../plugins/tool-types.js";
import {
  captureTrustedMemoryAccessFacts,
  createTrustedMemoryAccessContext,
  type TrustedMemoryAccessContext,
} from "../state/memory-access-context.js";
import { recheckMemoryIdentityBinding } from "../state/memory-identity.js";
import {
  createCurrentMemorySessionContext,
  type CurrentMemorySessionContext,
} from "../state/memory-session-subject.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { resolveMemoryEgressDeliveryFacts } from "./memory-egress-admission.js";

const authorizedMemoryVirtualBroker: unique symbol = Symbol(
  "openclaw.authorized-memory-virtual-broker",
);

/** Core-private bridge for generic filesystem tools; it is absent from plugin contexts. */
export type AuthorizedMemoryVirtualFileBroker = Readonly<{
  view: AuthorizedMemoryVirtualView;
  readFile: (virtualPath: string) => Promise<string | undefined>;
}>;

/** Core-private sealed compaction capability; plugins never receive this host. */
export type AuthorizedSealedCompactionHost = Readonly<{
  source: AuthorizedTranscriptDerivationSource;
  stage: (
    content: string,
  ) => Promise<AuthorizedSealedCompactionArtifact | typeof MEMORY_INVOCATION_UNAVAILABLE>;
}>;

type AuthorizedMemoryReadHostWithVirtualBroker = AuthorizedMemoryReadHost &
  Readonly<{
    [authorizedMemoryVirtualBroker]: () => Promise<AuthorizedMemoryVirtualFileBroker | undefined>;
  }>;

export async function resolveAuthorizedMemoryVirtualFileBroker(
  host: AuthorizedMemoryReadHost | undefined,
): Promise<AuthorizedMemoryVirtualFileBroker | undefined> {
  if (!host || !(authorizedMemoryVirtualBroker in host)) {
    return undefined;
  }
  return (host as AuthorizedMemoryReadHostWithVirtualBroker)[authorizedMemoryVirtualBroker]();
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function deliveryFacts(params: {
  context: CurrentMemorySessionContext;
  deliveryContext?: DeliveryContext;
  messageChannel?: string;
  agentAccountId?: string;
}) {
  const facts = resolveMemoryEgressDeliveryFacts({
    agentId: params.context.agentId,
    sessionKey: params.context.sessionKey,
    sessionId: params.context.sessionId,
    deliveryContext: params.deliveryContext,
    messageChannel: params.messageChannel,
    agentAccountId: params.agentAccountId,
  });
  return (
    facts && {
      sink: facts.sink,
      audiences: facts.audiences,
      routeRevision: facts.deliveryRevision,
      egressCapabilityIds: ["reply.final"],
      egressRegistryRevision: facts.egressRegistryRevision,
    }
  );
}

/**
 * Builds the sole tool-facing handle for a cut-over run. Session identity and delivery facts are
 * reread from their owners; sender IDs, `toolsBySender`, paths, and model parameters never name a
 * memory subject or namespace here.
 */
type AuthorizedMemoryHostParams = {
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  deliveryContext?: DeliveryContext;
  messageChannel?: string;
  agentAccountId?: string;
  /** Background derivation can use only an active operational subject, never a remembered user session. */
  background?: true;
};

/** Reissues identity and delivery evidence for each operation; read authority never implies write. */
function createTrustedMemoryHostContext(
  params: AuthorizedMemoryHostParams & Readonly<{ operation: MemoryAccessContext["operation"] }>,
): TrustedMemoryAccessContext | undefined {
  if (
    !isMemoryIsolationCutoverAgent(params.agentId) ||
    !params.sessionKey?.trim() ||
    !params.sessionId?.trim()
  ) {
    return undefined;
  }
  const session = createCurrentMemorySessionContext({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    options: { agentId: params.agentId },
  });
  if (session.kind !== "current") {
    return undefined;
  }
  const { context } = session;
  if (context.isChildSession) {
    // A child starts with the empty memory intersection. Only a future
    // host-issued delegation may add a bounded view; session metadata cannot.
    return undefined;
  }
  if (
    params.background === true &&
    context.subject.kind !== "agent" &&
    context.subject.kind !== "service" &&
    context.subject.kind !== "system"
  ) {
    return undefined;
  }
  const delivery = deliveryFacts({
    context,
    deliveryContext: params.deliveryContext,
    messageChannel: params.messageChannel,
    agentAccountId: params.agentAccountId,
  });
  if (!delivery) {
    return undefined;
  }
  let actor: MemoryActorEvidence;
  let verifiedPrincipals: Array<{
    principalId: string;
    assurance: "gateway-profile" | "service";
    evidenceRevision: string;
    expiresAt?: string;
  }> = [];
  if (context.subject.kind === "user" && context.bindingId) {
    const binding = recheckMemoryIdentityBinding({ bindingId: context.bindingId });
    if (binding.kind !== "current" || binding.binding.principalId !== context.principalId) {
      return undefined;
    }
    const expiresAt =
      binding.binding.expiresAt === null
        ? undefined
        : new Date(binding.binding.expiresAt).toISOString();
    actor = {
      kind: "principal" as const,
      actorKind: "human" as const,
      principalId: context.principalId,
      assurance: "gateway-profile" as const,
      evidenceRevision: binding.binding.evidenceRevision,
      ...(expiresAt ? { expiresAt } : {}),
    };
    verifiedPrincipals = [
      {
        principalId: context.principalId,
        assurance: "gateway-profile",
        evidenceRevision: binding.binding.evidenceRevision,
        ...(expiresAt ? { expiresAt } : {}),
      },
    ];
  } else if (context.subject.kind === "conversation") {
    actor = {
      kind: "unattributed" as const,
      transportAuditRef: `mta1_${hash({ session: context.fingerprint })}`,
      evidenceRevision: context.authorityRevision,
    };
  } else {
    const actorKind =
      context.subject.kind === "agent"
        ? "agent"
        : context.subject.kind === "system"
          ? "system"
          : "service";
    actor = {
      kind: "principal" as const,
      actorKind,
      principalId: context.principalId,
      assurance: "service" as const,
      evidenceRevision: context.authorityRevision,
    };
    verifiedPrincipals = [
      {
        principalId: context.principalId,
        assurance: "service",
        evidenceRevision: context.authorityRevision,
      },
    ];
  }
  const facts = captureTrustedMemoryAccessFacts({
    requestId: randomUUID(),
    runId: params.runId?.trim() || `session:${context.sessionId}`,
    actor,
    verifiedPrincipals,
    collaboration: { kind: "not-applicable" },
    // Role membership is intentionally absent until a trusted membership resolver exists. This
    // keeps a group actor from selecting a role store merely because they sent the latest message.
    verifiedMemberships: [],
    delivery,
    operation: params.operation,
    hostFactsRevision: `mhf1_${hash({
      session: context.fingerprint,
      delivery: delivery.routeRevision,
      egress: delivery.egressRegistryRevision,
    })}`,
  });
  const trusted = createTrustedMemoryAccessContext({
    sessionKey: context.sessionKey,
    sessionId: context.sessionId,
    options: { agentId: context.agentId },
    facts,
  });
  if (trusted.kind !== "current") {
    return undefined;
  }
  return trusted.context;
}

/**
 * Builds the sole tool-facing read handle for a cut-over run. Session identity and delivery facts
 * are reread from their owners; sender IDs, `toolsBySender`, and paths never name a memory subject.
 */
function createAuthorizedMemoryContentHost(
  params: AuthorizedMemoryHostParams,
  operation: "read" | "derive",
): AuthorizedMemoryReadHost | undefined {
  const trusted = createTrustedMemoryHostContext({ ...params, operation });
  if (!trusted) {
    return undefined;
  }
  let invocation:
    | Promise<
        | AuthorizedMemoryReadInvocation
        | AuthorizedMemoryDerivationInvocation
        | typeof MEMORY_INVOCATION_UNAVAILABLE
      >
    | undefined;
  const getInvocation = () =>
    (invocation ??=
      operation === "derive"
        ? createAuthorizedMemoryDeriveInvocation({ context: trusted })
        : createAuthorizedMemoryReadInvocation({ context: trusted }));
  let virtualBroker: Promise<AuthorizedMemoryVirtualFileBroker | undefined> | undefined;
  const getVirtualBroker = () =>
    (virtualBroker ??= (async () => {
      const active = await getInvocation();
      if ("unavailable" in active) {
        return undefined;
      }
      const view = await materializeAuthorizedMemoryVirtualView({ invocation: active });
      if ("unavailable" in view) {
        return undefined;
      }
      return Object.freeze({
        view,
        async readFile(virtualPath) {
          const result = await readAuthorizedMemoryVirtualFile({
            invocation: active,
            view,
            virtualPath,
          });
          return "unavailable" in result ? undefined : result.text;
        },
      });
    })());
  return Object.freeze({
    async search(search) {
      const active = await getInvocation();
      if ("unavailable" in active) {
        return active;
      }
      const result = await searchAuthorizedMemoryForInvocation({ invocation: active, ...search });
      return "unavailable" in result ? MEMORY_INVOCATION_UNAVAILABLE : result;
    },
    async read(read) {
      const active = await getInvocation();
      if ("unavailable" in active) {
        return active;
      }
      const result = await readAuthorizedMemoryForInvocation({ invocation: active, ...read });
      return "unavailable" in result ? MEMORY_INVOCATION_UNAVAILABLE : result;
    },
    [authorizedMemoryVirtualBroker]: getVirtualBroker,
  }) as AuthorizedMemoryReadHost;
}

export function createAuthorizedMemoryReadHost(
  params: AuthorizedMemoryHostParams,
): AuthorizedMemoryReadHost | undefined {
  return createAuthorizedMemoryContentHost(params, "read");
}

/**
 * Builds a content host whose every source read is authorized as a derivation. A caller cannot
 * turn an admitted derive plan into a weaker read plan after the source reaches model context.
 */
export function createAuthorizedMemoryDerivationHost(
  params: AuthorizedMemoryHostParams,
): AuthorizedMemoryReadHost | undefined {
  return createAuthorizedMemoryContentHost(params, "derive");
}

/**
 * Prepares one background resource derivation before any source bytes enter a
 * model context. The durable work item is rechecked as an operational subject,
 * so a cron/heartbeat cannot recover private memory merely by retaining a
 * session key.
 */
export async function prepareAuthorizedMemoryBackgroundDerivationHost(
  params: Omit<AuthorizedMemoryHostParams, "background"> &
    Readonly<{
      purpose: AuthorizedResourceDerivationPurpose;
    }>,
): Promise<AuthorizedMemoryResourceDerivationHost | undefined> {
  const trusted = createTrustedMemoryHostContext({
    ...params,
    background: true,
    operation: "derive",
  });
  if (!trusted) {
    return undefined;
  }
  const invocation = await createAuthorizedMemoryDeriveInvocation({ context: trusted });
  if ("unavailable" in invocation) {
    return undefined;
  }
  return Object.freeze({
    async search(search) {
      const result = await searchAuthorizedMemoryForInvocation({ invocation, ...search });
      return "unavailable" in result ? MEMORY_INVOCATION_UNAVAILABLE : result;
    },
    async read(read) {
      const result = await readAuthorizedMemoryForInvocation({ invocation, ...read });
      return "unavailable" in result ? MEMORY_INVOCATION_UNAVAILABLE : result;
    },
    async collectSources(params) {
      const result = await collectAuthorizedMemoryDerivationSources({
        invocation,
        ...(params?.signal ? { signal: params.signal } : {}),
      });
      return "unavailable" in result ? MEMORY_INVOCATION_UNAVAILABLE : result;
    },
    async commit({ content, contentType = "markdown", signal }) {
      if (signal?.aborted) {
        return MEMORY_INVOCATION_UNAVAILABLE;
      }
      const result = await commitAuthorizedMemoryDerivationForInvocation({
        invocation,
        content,
        contentType,
        purpose: params.purpose,
      });
      return "unavailable" in result ? MEMORY_INVOCATION_UNAVAILABLE : result;
    },
  });
}

/**
 * Rechecks the separate derive capability before a runtime can place memory-derived
 * material in a model context. Read admission alone intentionally never implies this.
 */
export async function admitAuthorizedMemoryDerivation(
  params: AuthorizedMemoryHostParams,
): Promise<boolean> {
  const trusted = createTrustedMemoryHostContext({ ...params, operation: "derive" });
  if (!trusted) {
    return false;
  }
  const invocation = await createAuthorizedMemoryDeriveInvocation({ context: trusted });
  return !("unavailable" in invocation);
}

/**
 * Admits one transcript-backed mutation before the flush model sees history.
 * The opaque source stays host-owned; neither the model nor a plugin tool can
 * substitute a session, event list, policy set, or delivery audience.
 */
export async function prepareAuthorizedTranscriptDerivationHost(
  params: AuthorizedMemoryHostParams &
    Readonly<{ derivationPurpose?: AuthorizedTranscriptDerivationPurpose }>,
): Promise<AuthorizedMemoryWriteHost | undefined> {
  const sessionId = params.sessionId?.trim();
  const trusted = createTrustedMemoryHostContext({ ...params, operation: "derive" });
  if (!trusted || !sessionId) {
    return undefined;
  }
  const transcriptSource = readAuthorizedTranscriptDerivation(
    openOpenClawAgentDatabase({ agentId: params.agentId }).db,
    sessionId,
  );
  if (!transcriptSource) {
    return undefined;
  }
  const invocation = await createAuthorizedMemoryWriteInvocation({ context: trusted });
  if ("unavailable" in invocation) {
    return undefined;
  }
  return Object.freeze({
    async remember({ content, contentType = "markdown" }) {
      const result = await writeAuthorizedMemoryForInvocation({
        invocation,
        mutation: {
          version: 1,
          kind: "derive",
          derivationPurpose: params.derivationPurpose ?? "flush",
          mutationId: randomUUID(),
          idempotencyKey: randomUUID(),
          content,
          contentType,
          sourcePolicySetId: transcriptSource.sourcePolicySetId,
          transcriptSource: {
            kind: "transcript",
            sessionId,
            eventSeqs: transcriptSource.eventSeqs,
            sourcePolicySetId: transcriptSource.sourcePolicySetId,
            deliveryAudiencesJson: transcriptSource.deliveryAudiencesJson,
          },
        },
      });
      return "unavailable" in result ? MEMORY_INVOCATION_UNAVAILABLE : result;
    },
  });
}

/**
 * Captures the exact transcript source before model work. The returned staging
 * capability has no caller-selectable session, policy, audience, or store.
 */
export async function prepareAuthorizedSealedCompactionHost(
  params: AuthorizedMemoryHostParams,
): Promise<AuthorizedSealedCompactionHost | undefined> {
  const sessionId = params.sessionId?.trim();
  const trusted = createTrustedMemoryHostContext({ ...params, operation: "derive" });
  if (!trusted || !sessionId) {
    return undefined;
  }
  const transcriptSource = readAuthorizedTranscriptDerivation(
    openOpenClawAgentDatabase({ agentId: params.agentId }).db,
    sessionId,
  );
  if (!transcriptSource) {
    return undefined;
  }
  const invocation = await createAuthorizedMemoryWriteInvocation({ context: trusted });
  if ("unavailable" in invocation) {
    return undefined;
  }
  const sealedSource = Object.freeze({
    kind: "transcript",
    sessionId,
    eventSeqs: transcriptSource.eventSeqs,
    sourcePolicySetId: transcriptSource.sourcePolicySetId,
    deliveryAudiencesJson: transcriptSource.deliveryAudiencesJson,
  });
  return Object.freeze({
    source: sealedSource,
    async stage(content) {
      return await stageAuthorizedMemorySealedCompactionForInvocation({
        invocation,
        content,
        transcriptSource: sealedSource,
      });
    },
  });
}

/**
 * Builds a one-mutation append host for a cut-over run. The model supplies only content; the host
 * reissues append facts and the selected runtime chooses the subject-owned store and audience.
 */
export function createAuthorizedMemoryWriteHost(
  params: AuthorizedMemoryHostParams,
): AuthorizedMemoryWriteHost | undefined {
  const trusted = createTrustedMemoryHostContext({ ...params, operation: "append" });
  if (!trusted) {
    return undefined;
  }
  return Object.freeze({
    async remember({ content, contentType = "markdown" }) {
      const invocation = await createAuthorizedMemoryWriteInvocation({ context: trusted });
      if ("unavailable" in invocation) {
        return MEMORY_INVOCATION_UNAVAILABLE;
      }
      const result = await writeAuthorizedMemoryForInvocation({
        invocation,
        mutation: {
          version: 1,
          kind: "remember",
          mutationId: randomUUID(),
          idempotencyKey: randomUUID(),
          content,
          contentType,
        },
      });
      return "unavailable" in result ? MEMORY_INVOCATION_UNAVAILABLE : result;
    },
  });
}
