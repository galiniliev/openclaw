import { createHash, randomUUID } from "node:crypto";
import {
  captureAuthorizedTranscriptExportSource,
  readAuthorizedTranscriptDerivation,
  type AuthorizedTranscriptExportSource,
} from "../config/sessions/session-transcript-memory-policy.js";
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
  createAuthorizedMemoryExportInvocation,
  createAuthorizedMemoryReadInvocation,
  createAuthorizedMemoryWriteInvocation,
  materializeAuthorizedMemoryVirtualView,
  issueAuthorizedMemoryChildDelegationForInvocation,
  readAuthorizedMemoryVirtualFile,
  readAuthorizedMemoryForInvocation,
  recheckAuthorizedMemoryDerivationSources,
  recheckAuthorizedMemoryDeriveWriteInvocation,
  recheckAuthorizedMemoryExportInvocation,
  searchAuthorizedMemoryForInvocation,
  stageAuthorizedMemorySealedCompactionForInvocation,
  revokeAuthorizedMemoryChildDelegationForInvocation,
  writeAuthorizedMemoryForInvocation,
  type AuthorizedMemoryDerivationInvocation,
  type AuthorizedMemoryReadInvocation,
} from "../plugins/memory-invocation.js";
import type {
  AuthorizedMemoryReadHost,
  AuthorizedMemoryResourceDerivationHost,
  AuthorizedMemoryTranscriptDerivationHost,
  AuthorizedMemoryWriteHost,
} from "../plugins/tool-types.js";
import {
  captureTrustedMemoryAccessFacts,
  createTrustedMemoryAccessContext,
  materializeTrustedMemoryAccessContext,
  type TrustedMemoryAccessContext,
} from "../state/memory-access-context.js";
import {
  activateMemoryChildDelegation,
  readMemoryChildTaskCapabilitySnapshot,
  resolveActiveMemoryChildDelegation,
  revokeMemoryChildDelegationsForChildGeneration,
  revokeMemoryChildDelegation,
  stageMemoryChildDelegation,
} from "../state/memory-child-delegation.js";
import { recheckMemoryIdentityBinding } from "../state/memory-identity.js";
import {
  createCurrentMemorySessionContext,
  type CurrentMemorySessionContext,
} from "../state/memory-session-subject.js";
import {
  activateTranscriptExportArtifact,
  failTranscriptExportArtifact,
  stageTranscriptExportArtifact,
  type StagedTranscriptExportArtifact,
  type TranscriptExportArtifactType,
} from "../state/memory-transcript-export-ledger.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { resolveMemoryEgressDeliveryFacts } from "./memory-egress-admission.js";

const authorizedMemoryVirtualBroker: unique symbol = Symbol(
  "openclaw.authorized-memory-virtual-broker",
);
const BACKGROUND_MEMORY_DELIVERY_REGISTRY_REVISION = "mer1_internal-no-egress";

/** Core-private bridge for generic filesystem tools; it is absent from plugin contexts. */
export type AuthorizedMemoryVirtualFileBroker = Readonly<{
  view: AuthorizedMemoryVirtualView;
  readFile: (virtualPath: string) => Promise<string | undefined>;
}>;

/** Core-private sealed compaction capability; plugins never receive this host. */
export type AuthorizedSealedCompactionHost = Readonly<{
  source: AuthorizedTranscriptDerivationSource;
  /** Rechecks the captured source immediately before each compaction model request. */
  recheckBeforeModel: () => Promise<boolean>;
  stage: (
    content: string,
  ) => Promise<AuthorizedSealedCompactionArtifact | typeof MEMORY_INVOCATION_UNAVAILABLE>;
}>;

/** Core-private child grant lifecycle; it never crosses task text or gateway payloads. */
export type AuthorizedMemoryChildDelegationLease = Readonly<{
  activate: () => Promise<boolean>;
  revoke: () => Promise<void>;
}>;

/**
 * Core-private transcript-export capability. The command formatter receives
 * captured event bytes, never a session path or a database reader, and cannot
 * choose the session, policy set, actor evidence, or artifact destination.
 */
export type AuthorizedTranscriptExportHost = Readonly<{
  exportId: string;
  eventJsons: readonly string[];
  sourceContentHash: string;
  /** Recheck immediately before serializing the captured event bytes. */
  recheckBeforeSerialization: () => Promise<boolean>;
  /** Persist the immutable manifest and a staged lifecycle event before publication. */
  stage: (params: {
    artifactContentHash: string;
    artifactType: TranscriptExportArtifactType;
  }) => Promise<StagedTranscriptExportArtifact | undefined>;
  /** Recheck immediately before the irrevocable publication fence, then append the lifecycle event. */
  publish: <Result>(params: {
    artifact: StagedTranscriptExportArtifact;
    write: (params: { recheckBeforePublication: () => Promise<void> }) => Promise<Result>;
  }) => Promise<Result | undefined>;
}>;

type AuthorizedMemoryReadHostWithVirtualBroker = AuthorizedMemoryReadHost &
  Readonly<{
    [authorizedMemoryVirtualBroker]: () => Promise<AuthorizedMemoryVirtualFileBroker | undefined>;
  }>;

class TranscriptExportPublicationAuthorizationLostError extends Error {
  constructor() {
    super("transcript export publication authorization was lost");
  }
}

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

function matchesCurrentTranscriptDerivationSource(
  source: AuthorizedTranscriptDerivationSource,
  current: ReturnType<typeof readAuthorizedTranscriptDerivation>,
): boolean {
  return (
    current?.sourcePolicySetId === source.sourcePolicySetId &&
    current.deliveryAudiencesJson === source.deliveryAudiencesJson &&
    current.eventSeqs.length === source.eventSeqs.length &&
    current.eventSeqs.every((eventSeq, index) => eventSeq === source.eventSeqs[index])
  );
}

function matchesCurrentTranscriptExportSource(
  source: AuthorizedTranscriptExportSource,
  current: AuthorizedTranscriptExportSource | undefined,
): boolean {
  return (
    current !== undefined &&
    current.sourcePolicySetId === source.sourcePolicySetId &&
    current.deliveryAudiencesJson === source.deliveryAudiencesJson &&
    current.contentHash === source.contentHash &&
    current.eventSeqs.length === source.eventSeqs.length &&
    current.eventSeqs.every((eventSeq, index) => eventSeq === source.eventSeqs[index]) &&
    current.eventHashes.length === source.eventHashes.length &&
    current.eventHashes.every((eventHash, index) => eventHash === source.eventHashes[index]) &&
    current.sourceEvidence.length === source.sourceEvidence.length &&
    current.sourceEvidence.every((evidence, index) => {
      const expected = source.sourceEvidence[index];
      return (
        expected !== undefined &&
        evidence.eventSeq === expected.eventSeq &&
        evidence.sourceEventSeq === expected.sourceEventSeq &&
        evidence.sourceSessionId === expected.sourceSessionId &&
        evidence.sessionIdentityRevision === expected.sessionIdentityRevision &&
        evidence.subjectRevision === expected.subjectRevision &&
        evidence.runExposureRevision === expected.runExposureRevision &&
        evidence.runExposureSetId === expected.runExposureSetId &&
        evidence.actorEvidenceJson === expected.actorEvidenceJson &&
        evidence.delegationSnapshotJson === expected.delegationSnapshotJson &&
        evidence.exposedResourceRevisionsJson === expected.exposedResourceRevisionsJson &&
        evidence.exposureReceiptIdsJson === expected.exposureReceiptIdsJson &&
        evidence.egressReceiptIdsJson === expected.egressReceiptIdsJson
      );
    })
  );
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
 * A maintenance derivation has no recipient-visible delivery path. It can use
 * only the owning agent's internal audience; reusing egress facts here would
 * make a delivery-less cron unable to derive, or let it borrow a stale route.
 */
function backgroundDeliveryFacts(context: CurrentMemorySessionContext) {
  return {
    sink: "internal" as const,
    audiences: [{ kind: "agent" as const, id: context.agentId }],
    routeRevision: `mbr1_${hash({
      agentId: context.agentId,
      authorityRevision: context.authorityRevision,
      session: context.fingerprint,
      subject: context.subject.kind,
    })}`,
    egressCapabilityIds: [] as const,
    egressRegistryRevision: BACKGROUND_MEMORY_DELIVERY_REGISTRY_REVISION,
  };
}

function delegationRootPrincipalId(subject: MemoryAccessContext["subject"]): string | undefined {
  switch (subject.kind) {
    case "user":
      return subject.principalId;
    case "conversation":
      return subject.conversationPrincipalId;
    case "service":
    case "agent":
    case "system":
      return subject.principalId;
    case "ambiguous":
      return undefined;
  }
}

/**
 * Stage a read-only child grant after the child session generation is durable.
 * The selected plugin owns the opaque token; the core record owns lifecycle,
 * parent/child identity rechecks, and revocation.
 */
export async function stageAuthorizedMemoryChildDelegation(params: {
  agentId: string;
  parentSessionKey?: string;
  parentSessionId?: string;
  runId?: string;
  deliveryContext?: DeliveryContext;
  messageChannel?: string;
  agentAccountId?: string;
  childSessionKey: string;
  childSessionId: string;
  childSessionIdentityRevision: string;
  expiresAt: number;
}): Promise<AuthorizedMemoryChildDelegationLease | undefined> {
  if (
    !params.parentSessionKey?.trim() ||
    !params.parentSessionId?.trim() ||
    !params.childSessionKey.trim() ||
    !params.childSessionId.trim() ||
    !params.childSessionIdentityRevision.trim() ||
    !Number.isFinite(params.expiresAt) ||
    params.expiresAt <= Date.now()
  ) {
    return undefined;
  }
  const parent = createCurrentMemorySessionContext({
    sessionKey: params.parentSessionKey,
    sessionId: params.parentSessionId,
    options: { agentId: params.agentId },
  });
  const child = createCurrentMemorySessionContext({
    sessionKey: params.childSessionKey,
    sessionId: params.childSessionId,
    options: { agentId: params.agentId },
  });
  if (
    parent.kind !== "current" ||
    child.kind !== "current" ||
    !child.context.isChildSession ||
    child.context.sessionIdentityRevision !== params.childSessionIdentityRevision
  ) {
    return undefined;
  }
  const parentTrusted = createTrustedMemoryHostContext({
    agentId: params.agentId,
    sessionKey: params.parentSessionKey,
    sessionId: params.parentSessionId,
    runId: params.runId,
    deliveryContext: params.deliveryContext,
    messageChannel: params.messageChannel,
    agentAccountId: params.agentAccountId,
    operation: "read",
  });
  if (!parentTrusted) {
    return undefined;
  }
  const parentContext = parentTrusted && materializeTrustedMemoryAccessContext(parentTrusted);
  const capabilitySnapshotId = readMemoryChildTaskCapabilitySnapshot({
    child: child.context,
    options: { agentId: params.agentId },
  });
  const rootPrincipalId = parentContext && delegationRootPrincipalId(parentContext.subject);
  if (!parentContext || !capabilitySnapshotId || !rootPrincipalId) {
    return undefined;
  }
  const delegationId = `mchild1_${randomUUID()}`;
  const issued = await issueAuthorizedMemoryChildDelegationForInvocation({
    context: parentTrusted,
    issue: {
      version: 1,
      delegationId,
      child: {
        agentId: params.agentId,
        sessionId: child.context.sessionId,
        sessionIdentityRevision: child.context.sessionIdentityRevision,
        subjectRevision: child.context.subjectRevision,
        capabilitySnapshotId,
      },
      allowedOperations: ["read"],
      maximumAudiences: parentContext.delivery.audiences,
      expiresAt: new Date(params.expiresAt).toISOString(),
    },
  });
  if ("unavailable" in issued) {
    return undefined;
  }
  const delegation = {
    rootPrincipalId,
    rootContextId: parentContext.contextId,
    parentContextId: parentContext.contextId,
    parentMemoryPlanId: issued.parentMemoryPlanId,
    capabilitySnapshotId,
    allowedOperations: ["read"] as const,
    maximumAudiences: parentContext.delivery.audiences,
    storeCapToken: issued.storeCapToken,
    depth: 1,
  } satisfies NonNullable<MemoryAccessContext["delegation"]>;
  const staged = stageMemoryChildDelegation({
    delegationId,
    parent: parent.context,
    child: child.context,
    delegation,
    facts: {
      subject: parentContext.subject,
      actor: parentContext.actor,
      verifiedPrincipals: parentContext.verifiedPrincipals,
      collaboration: parentContext.collaboration,
      delivery: parentContext.delivery,
    },
    expiresAt: params.expiresAt,
    options: { agentId: params.agentId },
  });
  if (!staged) {
    await revokeAuthorizedMemoryChildDelegationForInvocation({
      agentId: params.agentId,
      storeCapToken: issued.storeCapToken,
    });
    return undefined;
  }
  const revoke = async () => {
    revokeMemoryChildDelegation({ delegation: staged, options: { agentId: params.agentId } });
    await revokeAuthorizedMemoryChildDelegationForInvocation({
      agentId: params.agentId,
      storeCapToken: issued.storeCapToken,
    });
  };
  return Object.freeze({
    activate: async () =>
      activateMemoryChildDelegation({ delegation: staged, options: { agentId: params.agentId } }),
    revoke,
  });
}

/**
 * Terminal child cleanup owns durable revocation. The selected plugin only
 * receives opaque tokens after the core row is already closed.
 */
export function revokeAuthorizedMemoryChildDelegationsForChildGeneration(params: {
  agentId: string;
  childSessionKey: string;
  childSessionId: string;
  childSessionIdentityRevision: string;
}): void {
  const storeCapTokens = revokeMemoryChildDelegationsForChildGeneration({
    ...params,
    options: { agentId: params.agentId },
  });
  for (const storeCapToken of storeCapTokens) {
    void revokeAuthorizedMemoryChildDelegationForInvocation({
      agentId: params.agentId,
      storeCapToken,
    });
  }
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
  const childDelegation = context.isChildSession
    ? resolveActiveMemoryChildDelegation({
        child: context,
        operation: params.operation,
        options: { agentId: params.agentId },
      })
    : undefined;
  if (context.isChildSession && !childDelegation) {
    // Spawn metadata is never authority. A child needs its own durable,
    // exact-generation grant before it can receive even a parent-bounded view.
    return undefined;
  }
  if (
    params.background === true &&
    (childDelegation ||
      (context.subject.kind !== "agent" &&
        context.subject.kind !== "service" &&
        context.subject.kind !== "system"))
  ) {
    return undefined;
  }
  const delivery = childDelegation
    ? {
        sink: childDelegation.facts.delivery.sinkKind,
        audiences: childDelegation.facts.delivery.audiences,
        routeRevision: childDelegation.facts.delivery.deliveryRevision,
        egressCapabilityIds: childDelegation.facts.delivery.egressCapabilityIds,
        egressRegistryRevision: childDelegation.facts.delivery.egressRegistryRevision,
      }
    : params.background === true
      ? backgroundDeliveryFacts(context)
      : deliveryFacts({
          context,
          deliveryContext: params.deliveryContext,
          messageChannel: params.messageChannel,
          agentAccountId: params.agentAccountId,
        });
  if (!delivery) {
    return undefined;
  }
  let actor: MemoryActorEvidence;
  let verifiedPrincipals: Array<MemoryAccessContext["verifiedPrincipals"][number]> = [];
  if (childDelegation) {
    actor = childDelegation.facts.actor;
    verifiedPrincipals = [...childDelegation.facts.verifiedPrincipals];
  } else if (context.subject.kind === "user" && context.bindingId) {
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
    collaboration: childDelegation?.facts.collaboration ?? { kind: "not-applicable" },
    // Role membership is intentionally absent until a trusted membership resolver exists. This
    // keeps a group actor from selecting a role store merely because they sent the latest message.
    verifiedMemberships: [],
    delivery,
    ...(childDelegation
      ? {
          delegation: childDelegation.delegation,
          delegationSubject: childDelegation.facts.subject,
          delegationRecheck: () =>
            resolveActiveMemoryChildDelegation({
              child: context,
              operation: params.operation,
              options: { agentId: params.agentId },
            }) !== undefined,
        }
      : {}),
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
  let readInvocation:
    | Promise<AuthorizedMemoryReadInvocation | typeof MEMORY_INVOCATION_UNAVAILABLE>
    | undefined;
  let deriveInvocation:
    | Promise<AuthorizedMemoryDerivationInvocation | typeof MEMORY_INVOCATION_UNAVAILABLE>
    | undefined;
  const getReadInvocation = () =>
    (readInvocation ??= createAuthorizedMemoryReadInvocation({ context: trusted }));
  const getInvocation = () =>
    operation === "derive"
      ? (deriveInvocation ??= createAuthorizedMemoryDeriveInvocation({ context: trusted }))
      : getReadInvocation();
  const contentHost = {
    async search(search: Parameters<AuthorizedMemoryReadHost["search"]>[0]) {
      const active = await getInvocation();
      if ("unavailable" in active) {
        return active;
      }
      const result = await searchAuthorizedMemoryForInvocation({ invocation: active, ...search });
      return "unavailable" in result ? MEMORY_INVOCATION_UNAVAILABLE : result;
    },
    async read(read: Parameters<AuthorizedMemoryReadHost["read"]>[0]) {
      const active = await getInvocation();
      if ("unavailable" in active) {
        return active;
      }
      const result = await readAuthorizedMemoryForInvocation({ invocation: active, ...read });
      return "unavailable" in result ? MEMORY_INVOCATION_UNAVAILABLE : result;
    },
  } satisfies AuthorizedMemoryReadHost;
  if (operation === "derive") {
    // Generic virtual files are a read capability. Derivations expose source bytes
    // only through their dedicated broker, so they cannot create a second read path.
    return Object.freeze(contentHost);
  }
  let virtualBroker: Promise<AuthorizedMemoryVirtualFileBroker | undefined> | undefined;
  const getVirtualBroker = () =>
    (virtualBroker ??= (async () => {
      const active = await getReadInvocation();
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
    ...contentHost,
    [authorizedMemoryVirtualBroker]: getVirtualBroker,
  }) satisfies AuthorizedMemoryReadHost;
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
    async recheckSources() {
      return await recheckAuthorizedMemoryDerivationSources({ invocation });
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
  } satisfies AuthorizedMemoryResourceDerivationHost);
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
): Promise<AuthorizedMemoryTranscriptDerivationHost | undefined> {
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
  const source = Object.freeze({
    kind: "transcript" as const,
    sessionId,
    eventSeqs: transcriptSource.eventSeqs,
    sourcePolicySetId: transcriptSource.sourcePolicySetId,
    deliveryAudiencesJson: transcriptSource.deliveryAudiencesJson,
  });
  return Object.freeze({
    async recheckBeforeModel() {
      if (!recheckAuthorizedMemoryDeriveWriteInvocation({ invocation })) {
        return false;
      }
      const current = readAuthorizedTranscriptDerivation(
        openOpenClawAgentDatabase({ agentId: params.agentId }).db,
        sessionId,
      );
      return matchesCurrentTranscriptDerivationSource(source, current);
    },
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
          sourcePolicySetId: source.sourcePolicySetId,
          transcriptSource: source,
        },
      });
      return "unavailable" in result ? MEMORY_INVOCATION_UNAVAILABLE : result;
    },
  } satisfies AuthorizedMemoryTranscriptDerivationHost);
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
    eventSeqs: Object.freeze([...transcriptSource.eventSeqs]),
    sourcePolicySetId: transcriptSource.sourcePolicySetId,
    deliveryAudiencesJson: transcriptSource.deliveryAudiencesJson,
  });
  return Object.freeze({
    source: sealedSource,
    async recheckBeforeModel() {
      if (!recheckAuthorizedMemoryDeriveWriteInvocation({ invocation })) {
        return false;
      }
      return matchesCurrentTranscriptDerivationSource(
        sealedSource,
        readAuthorizedTranscriptDerivation(
          openOpenClawAgentDatabase({ agentId: params.agentId }).db,
          sessionId,
        ),
      );
    },
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
 * Creates an owner-command-only export capability for one complete transcript.
 * The caller's command gate owns owner authorization; this host owns current
 * identity, delivery, policy, source bytes, staging, and publication rechecks.
 */
export async function prepareAuthorizedTranscriptExportHost(
  params: AuthorizedMemoryHostParams,
): Promise<AuthorizedTranscriptExportHost | undefined> {
  const sessionId = params.sessionId?.trim();
  const trusted = createTrustedMemoryHostContext({ ...params, operation: "export" });
  if (!trusted || !sessionId) {
    return undefined;
  }
  const invocation = await createAuthorizedMemoryExportInvocation({ context: trusted });
  if ("unavailable" in invocation) {
    return undefined;
  }
  const database = openOpenClawAgentDatabase({ agentId: params.agentId });
  const source = captureAuthorizedTranscriptExportSource(database.db, sessionId);
  if (!source) {
    return undefined;
  }
  const exportId = `mexp1_${randomUUID()}`;
  const recheck = async (): Promise<boolean> => {
    if (!(await recheckAuthorizedMemoryExportInvocation({ invocation }))) {
      return false;
    }
    return matchesCurrentTranscriptExportSource(
      source,
      captureAuthorizedTranscriptExportSource(database.db, sessionId),
    );
  };
  const recheckBeforePublication = async (): Promise<void> => {
    if (!(await recheck())) {
      throw new TranscriptExportPublicationAuthorizationLostError();
    }
  };
  return Object.freeze({
    exportId,
    eventJsons: Object.freeze([...source.eventJsons]),
    sourceContentHash: source.contentHash,
    recheckBeforeSerialization: recheck,
    async stage({
      artifactContentHash,
      artifactType,
    }: {
      artifactContentHash: string;
      artifactType: TranscriptExportArtifactType;
    }) {
      if (!(await recheck())) {
        return undefined;
      }
      try {
        return stageTranscriptExportArtifact({
          artifactContentHash,
          artifactType,
          database,
          exportId,
          sessionId,
          source,
        });
      } catch {
        return undefined;
      }
    },
    async publish<Result>({
      artifact,
      write,
    }: {
      artifact: StagedTranscriptExportArtifact;
      write: (params: { recheckBeforePublication: () => Promise<void> }) => Promise<Result>;
    }): Promise<Result | undefined> {
      if (!(await recheck())) {
        failTranscriptExportArtifact({
          artifact,
          database,
          failureReason: "publication-authorization-lost",
        });
        return undefined;
      }
      try {
        const result = await write({ recheckBeforePublication });
        // The writer's final recheck is the authorization fence for an irreversible
        // filesystem publication. Once visible, retain the staged lineage even if
        // the post-commit ledger append cannot complete.
        activateTranscriptExportArtifact({ artifact, database });
        return result;
      } catch (error) {
        failTranscriptExportArtifact({
          artifact,
          database,
          failureReason:
            error instanceof TranscriptExportPublicationAuthorizationLostError
              ? "publication-authorization-lost"
              : "publication-failed",
        });
        return undefined;
      }
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
