import { createHash } from "node:crypto";
import { logWarn } from "../logger.js";
import type {
  AuthorizedMemoryVirtualView,
  AuthorizedMemoryMutation,
  AuthorizedMemoryContentPlan,
  AuthorizedMemoryPlan,
  AuthorizedMemoryResultEnvelope,
  AuthorizedResourceHandle,
  AudienceRef,
  MemoryContentAccessOperation,
  MemoryContentAccessContext,
  MemoryAccessContext,
  MemoryWriteResult,
  AuthorizedMemoryRuntime,
  IssuedMemoryChildDelegation,
  MemoryChildDelegationIssue,
  AuthorizedSealedCompactionArtifact,
  AuthorizedResourceDerivationPurpose,
  AuthorizedTranscriptDerivationSource,
} from "../memory-host-sdk/host/authorization.js";
import type {
  MemoryReadResult,
  MemorySearchResult,
  MemorySource,
} from "../memory-host-sdk/host/types.js";
import {
  materializeTrustedMemoryAccessContext,
  type TrustedMemoryAccessContext,
} from "../state/memory-access-context.js";
import {
  admitMemoryAuthorizationReadRuntime,
  admitMemoryAuthorizationRuntime,
  type AdmittedAuthorizedMemoryReadRuntime,
} from "./memory-authorization-runtime.js";
import {
  hydrateMemoryRunExposureFromLedger,
  persistMemoryRunExposureBeforeContent,
} from "./memory-run-exposure-ledger.js";
import {
  captureDurableMemoryAuthorizationFacts,
  prepareMemoryRunExposure,
  publishMemoryRunExposure,
} from "./memory-run-exposure.js";
import { resolveSelectedMemoryCapabilityRegistration } from "./memory-state.js";
import type {
  MemoryPluginCapability,
  MemoryPluginVirtualViewProvider,
} from "./registry-contribution-types.js";
import { requireActivePluginRegistry } from "./runtime.js";

export type MemoryInvocationUnavailable = Readonly<{
  disabled: true;
  unavailable: true;
  error: "memory unavailable";
}>;

export const MEMORY_INVOCATION_UNAVAILABLE: MemoryInvocationUnavailable = Object.freeze({
  disabled: true,
  unavailable: true,
  error: "memory unavailable",
});

const memoryReadInvocationBrand: unique symbol = Symbol("openclaw.memory-read-invocation");
const memoryDerivationInvocationBrand: unique symbol = Symbol(
  "openclaw.memory-derivation-invocation",
);
const memoryExportInvocationBrand: unique symbol = Symbol("openclaw.memory-export-invocation");
const memoryWriteInvocationBrand: unique symbol = Symbol("openclaw.memory-write-invocation");

export type AuthorizedMemoryReadInvocation = Readonly<{
  readonly [memoryReadInvocationBrand]: true;
}>;

/**
 * Opaque, single-plan resource derivation. Its source handles and destination
 * are retained privately so a plugin cannot turn one authorized read into a
 * differently scoped write.
 */
export type AuthorizedMemoryDerivationInvocation = Readonly<{
  readonly [memoryDerivationInvocationBrand]: true;
}>;

/**
 * Opaque host-only export admission. It deliberately carries no resource
 * handle or payload: transcript export has its own captured-source path and
 * must never turn a generic read handle into an artifact capability.
 */
export type AuthorizedMemoryExportInvocation = Readonly<{
  readonly [memoryExportInvocationBrand]: true;
}>;

/** Opaque host-owned write continuation; a caller cannot supply context or a selected runtime. */
export type AuthorizedMemoryWriteInvocation = Readonly<{
  readonly [memoryWriteInvocationBrand]: true;
}>;

type ContentInvocationState<Operation extends MemoryContentAccessOperation> = Readonly<{
  trustedContext: TrustedMemoryAccessContext;
  context: MemoryContentAccessContext<Operation>;
  plan: AuthorizedMemoryContentPlan<Operation>;
  authorizationStartedAtMs: number;
  runtime: AdmittedAuthorizedMemoryReadRuntime;
  /** Bound at admission; registry changes cannot replace this run's provider. */
  virtualView?: MemoryPluginVirtualViewProvider;
  /** Canonical broker-issued views for this invocation; caller-shaped lookalikes never authorize reads. */
  virtualViews: Map<string, AuthorizedMemoryVirtualView>;
  handles: Map<string, AuthorizedResourceHandle>;
  sourcePolicySetIds: Set<string>;
  exposedRevisionHandles: Set<string>;
  exposureReceiptIds: Set<string>;
  egressReceiptIds: Set<string>;
  runExposureRevisions: Set<string>;
}>;

type DerivationInvocationState = Omit<ContentInvocationState<"derive">, "runtime"> &
  Readonly<{
    runtime: Readonly<AuthorizedMemoryRuntime>;
    /** Every resource whose snippet or text reached the derivation model. */
    observedSourceHandles: Map<string, AuthorizedResourceHandle>;
  }>;

type ReadInvocationState = ContentInvocationState<"read">;
type AnyContentInvocationState = ReadInvocationState | DerivationInvocationState;

const VIRTUAL_ROOT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

const invocationStates = new WeakMap<object, ReadInvocationState>();
const derivationInvocationStates = new WeakMap<object, DerivationInvocationState>();

type ExportInvocationState = Readonly<{
  trustedContext: TrustedMemoryAccessContext;
  context: MemoryAccessContext & Readonly<{ operation: "export" }>;
  plan: AuthorizedMemoryPlan & Readonly<{ operation: "export" }>;
  runtime: Readonly<AuthorizedMemoryRuntime>;
}>;

const exportInvocationStates = new WeakMap<object, ExportInvocationState>();

type WriteOperation = Extract<
  MemoryAccessContext["operation"],
  | "append"
  | "replace"
  | "derive"
  | "deposit"
  | "project"
  | "publish"
  | "import"
  | "delete"
  | "sync"
  | "policy-admin"
>;

type WriteInvocationState<Operation extends WriteOperation> = Readonly<{
  trustedContext: TrustedMemoryAccessContext;
  context: MemoryAccessContext & Readonly<{ operation: Operation }>;
  plan: AuthorizedMemoryPlan & Readonly<{ operation: Operation }>;
  runtime: Readonly<AuthorizedMemoryRuntime>;
}>;

// Preserve the current operation on both plan and context. The state itself
// stays broad until a caller proves one operation; a mapped union cannot be
// narrowed by a generic type predicate under TypeScript's assignability rules.
type AnyWriteInvocationState = WriteInvocationState<WriteOperation>;

const writeInvocationStates = new WeakMap<object, AnyWriteInvocationState>();

type MemoryInvocationDiagnostic =
  | "admission-rejected"
  | "authorization-failed"
  | "invalid-plan"
  | "materialization-rejected"
  | "search-failed";

function logMemoryInvocationDiagnostic(diagnostic: MemoryInvocationDiagnostic): void {
  // Memory content, access facts, capability metadata, plans, and backend errors are all sensitive.
  // Keep the emitted diagnostic low-cardinality and content-free; the unavailable result is intentional.
  logWarn(`memory invocation unavailable: ${diagnostic}`);
}

function sameAudiences(left: readonly AudienceRef[], right: readonly AudienceRef[]): boolean {
  const key = (audience: AudienceRef) => `${audience.kind}\u0000${audience.id}`;
  const leftKeys = [...new Set(left.map(key))].toSorted();
  const rightKeys = [...new Set(right.map(key))].toSorted();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((value, index) => value === rightKeys[index])
  );
}

function isCurrentPlan(params: {
  context: MemoryAccessContext;
  plan: AuthorizedMemoryPlan;
  nowMs: number;
}): boolean {
  const { context, plan } = params;
  const expiresAt = Date.parse(plan.expiresAt);
  return (
    plan.version === 1 &&
    plan.contextFingerprint === context.contextFingerprint &&
    plan.runId === context.runId &&
    plan.agentId === context.agentId &&
    plan.sessionId === context.sessionId &&
    plan.sessionIdentityRevision === context.sessionIdentityRevision &&
    plan.subjectRevision === context.subjectRevision &&
    plan.deliveryRevision === context.delivery.deliveryRevision &&
    plan.operation === context.operation &&
    Number.isFinite(expiresAt) &&
    expiresAt > params.nowMs
  );
}

function isContentContextForOperation<Operation extends MemoryContentAccessOperation>(
  context: MemoryAccessContext,
  operation: Operation,
): context is MemoryContentAccessContext<Operation> {
  return context.operation === operation;
}

function isContextForOperation<Operation extends MemoryAccessContext["operation"]>(
  context: MemoryAccessContext,
  operation: Operation,
): context is MemoryAccessContext & Readonly<{ operation: Operation }> {
  return context.operation === operation;
}

function isWriteContext(context: MemoryAccessContext): context is MemoryAccessContext & {
  operation: WriteOperation;
} {
  return (
    context.operation === "append" ||
    context.operation === "replace" ||
    context.operation === "derive" ||
    context.operation === "deposit" ||
    context.operation === "project" ||
    context.operation === "publish" ||
    context.operation === "import" ||
    context.operation === "delete" ||
    context.operation === "sync" ||
    context.operation === "policy-admin"
  );
}

function isWriteInvocationStateFor<Operation extends WriteOperation>(
  state: AnyWriteInvocationState,
  operation: Operation,
): state is WriteInvocationState<Operation> {
  return state.context.operation === operation && state.plan.operation === operation;
}

function readCurrentWriteContext<Operation extends WriteOperation>(
  state: WriteInvocationState<Operation>,
): (MemoryAccessContext & Readonly<{ operation: Operation }>) | undefined {
  const current = materializeTrustedMemoryAccessContext(state.trustedContext);
  if (
    !current ||
    !isContextForOperation(current, state.context.operation) ||
    current.contextFingerprint !== state.context.contextFingerprint ||
    current.runId !== state.context.runId ||
    current.agentId !== state.context.agentId ||
    current.sessionId !== state.context.sessionId ||
    current.sessionIdentityRevision !== state.context.sessionIdentityRevision ||
    current.subjectRevision !== state.context.subjectRevision ||
    current.delivery.deliveryRevision !== state.context.delivery.deliveryRevision ||
    current.delivery.egressRegistryRevision !== state.context.delivery.egressRegistryRevision ||
    !sameAudiences(current.delivery.audiences, state.context.delivery.audiences)
  ) {
    return undefined;
  }
  return current;
}

function readCurrentExportContext(
  state: ExportInvocationState,
): (MemoryAccessContext & Readonly<{ operation: "export" }>) | undefined {
  const current = materializeTrustedMemoryAccessContext(state.trustedContext);
  if (
    !current ||
    !isContextForOperation(current, "export") ||
    current.contextFingerprint !== state.context.contextFingerprint ||
    current.runId !== state.context.runId ||
    current.agentId !== state.context.agentId ||
    current.sessionId !== state.context.sessionId ||
    current.sessionIdentityRevision !== state.context.sessionIdentityRevision ||
    current.subjectRevision !== state.context.subjectRevision ||
    current.delivery.deliveryRevision !== state.context.delivery.deliveryRevision ||
    current.delivery.egressRegistryRevision !== state.context.delivery.egressRegistryRevision ||
    !sameAudiences(current.delivery.audiences, state.context.delivery.audiences)
  ) {
    return undefined;
  }
  return current;
}

function readCurrentContext<Operation extends MemoryContentAccessOperation>(
  state: ContentInvocationState<Operation>,
): MemoryContentAccessContext<Operation> | undefined {
  const current = materializeTrustedMemoryAccessContext(state.trustedContext);
  if (!current || !isContentContextForOperation(current, state.context.operation)) {
    return undefined;
  }
  if (
    current.contextFingerprint !== state.context.contextFingerprint ||
    current.runId !== state.context.runId ||
    current.agentId !== state.context.agentId ||
    current.sessionId !== state.context.sessionId ||
    current.sessionIdentityRevision !== state.context.sessionIdentityRevision ||
    current.subjectRevision !== state.context.subjectRevision ||
    current.delivery.deliveryRevision !== state.context.delivery.deliveryRevision ||
    current.delivery.egressRegistryRevision !== state.context.delivery.egressRegistryRevision ||
    !sameAudiences(current.delivery.audiences, state.context.delivery.audiences)
  ) {
    return undefined;
  }
  return current;
}

function isReadContentContext(
  context: MemoryContentAccessContext<MemoryContentAccessOperation>,
): context is MemoryContentAccessContext<"read"> {
  return context.operation === "read";
}

function isReadInvocationState(state: AnyContentInvocationState): state is ReadInvocationState {
  return state.context.operation === "read" && state.plan.operation === "read";
}

function isDerivationInvocationState(
  state: AnyContentInvocationState,
): state is DerivationInvocationState {
  return state.context.operation === "derive" && state.plan.operation === "derive";
}

function isDeriveWriteInvocationState(
  state: AnyWriteInvocationState,
): state is WriteInvocationState<"derive"> {
  return isWriteInvocationStateFor(state, "derive");
}

function validateEnvelope<T>(params: {
  state: AnyContentInvocationState;
  context: MemoryContentAccessContext<MemoryContentAccessOperation>;
  expectedRevisionHandles: readonly string[];
  envelope: AuthorizedMemoryResultEnvelope<T>;
}): boolean {
  const { state, context, envelope } = params;
  const { exposureReceipt, egressReceipt } = envelope;
  const nowMs = Date.now();
  const exposureRecordedAt = Date.parse(exposureReceipt.recordedAt);
  const egressExpiry = Date.parse(egressReceipt.expiresAt);
  if (
    envelope.version !== 1 ||
    exposureReceipt.version !== 1 ||
    egressReceipt.version !== 1 ||
    exposureReceipt.contextFingerprint !== context.contextFingerprint ||
    egressReceipt.contextFingerprint !== context.contextFingerprint ||
    exposureReceipt.planId !== state.plan.planId ||
    egressReceipt.planId !== state.plan.planId ||
    exposureReceipt.runId !== context.runId ||
    egressReceipt.runId !== context.runId ||
    exposureReceipt.runExposureRevision !== egressReceipt.runExposureRevision ||
    exposureReceipt.sourcePolicySetId !== egressReceipt.sourcePolicySetId ||
    !exposureReceipt.receiptId ||
    !egressReceipt.receiptId ||
    !exposureReceipt.sourcePolicySetId ||
    !Number.isFinite(exposureRecordedAt) ||
    exposureRecordedAt < state.authorizationStartedAtMs ||
    exposureRecordedAt > nowMs ||
    !Number.isFinite(egressExpiry) ||
    egressExpiry <= nowMs ||
    exposureRecordedAt > egressExpiry ||
    egressReceipt.deliveryRevision !== context.delivery.deliveryRevision ||
    egressReceipt.egressRegistryRevision !== context.delivery.egressRegistryRevision ||
    !sameAudiences(egressReceipt.allowedAudiences, context.delivery.audiences) ||
    state.exposureReceiptIds.has(exposureReceipt.receiptId) ||
    state.egressReceiptIds.has(egressReceipt.receiptId) ||
    state.exposureReceiptIds.has(egressReceipt.receiptId) ||
    state.egressReceiptIds.has(exposureReceipt.receiptId) ||
    state.runExposureRevisions.has(exposureReceipt.runExposureRevision)
  ) {
    return false;
  }
  const exposed = new Set(exposureReceipt.exposedRevisionHandles);
  if (
    exposed.size !== exposureReceipt.exposedRevisionHandles.length ||
    !params.expectedRevisionHandles.every((revision) => exposed.has(revision))
  ) {
    return false;
  }
  return true;
}

function mergeEnvelope(
  state: AnyContentInvocationState,
  envelope: AuthorizedMemoryResultEnvelope<unknown>,
): void {
  const { exposureReceipt, egressReceipt } = envelope;
  state.sourcePolicySetIds.add(exposureReceipt.sourcePolicySetId);
  for (const revision of exposureReceipt.exposedRevisionHandles) {
    state.exposedRevisionHandles.add(revision);
  }
  state.exposureReceiptIds.add(exposureReceipt.receiptId);
  state.egressReceiptIds.add(egressReceipt.receiptId);
  state.runExposureRevisions.add(exposureReceipt.runExposureRevision);
}

function readTranscriptExposure(params: {
  state: AnyContentInvocationState;
  context: MemoryContentAccessContext<MemoryContentAccessOperation>;
  pendingEnvelope?: AuthorizedMemoryResultEnvelope<unknown>;
}) {
  const { state, context, pendingEnvelope } = params;
  const sourcePolicySetIds = new Set(state.sourcePolicySetIds);
  const exposedResourceRevisions = new Set(state.exposedRevisionHandles);
  const exposureReceiptIds = new Set(state.exposureReceiptIds);
  const egressReceiptIds = new Set(state.egressReceiptIds);
  if (pendingEnvelope) {
    const { exposureReceipt, egressReceipt } = pendingEnvelope;
    sourcePolicySetIds.add(exposureReceipt.sourcePolicySetId);
    for (const revision of exposureReceipt.exposedRevisionHandles) {
      exposedResourceRevisions.add(revision);
    }
    exposureReceiptIds.add(exposureReceipt.receiptId);
    egressReceiptIds.add(egressReceipt.receiptId);
  }
  return Object.freeze({
    agentId: context.agentId,
    sessionId: context.sessionId,
    sessionKey: context.sessionKey,
    runId: context.runId,
    contextFingerprint: context.contextFingerprint,
    planId: state.plan.planId,
    memoryPolicyRevision: state.plan.memoryPolicyRevision,
    sourcePolicySetIds: Object.freeze([...sourcePolicySetIds].toSorted()),
    exposedResourceRevisions: Object.freeze([...exposedResourceRevisions].toSorted()),
    exposureReceiptIds: Object.freeze([...exposureReceiptIds].toSorted()),
    egressReceiptIds: Object.freeze([...egressReceiptIds].toSorted()),
    deliveryAudiences: Object.freeze([...context.delivery.audiences]),
    deliveryRevision: context.delivery.deliveryRevision,
    egressRegistryRevision: context.delivery.egressRegistryRevision,
    sessionIdentityRevision: context.sessionIdentityRevision,
    subjectRevision: context.subjectRevision,
    ...captureDurableMemoryAuthorizationFacts(context),
  });
}

/**
 * Records the next immutable exposure revision before the selected plugin's content can leave
 * this broker. A recording failure leaves the invocation state unchanged and fails the read closed.
 */
function recordEnvelopeExposure(params: {
  state: AnyContentInvocationState;
  context: MemoryContentAccessContext<MemoryContentAccessOperation>;
  envelope: AuthorizedMemoryResultEnvelope<unknown>;
}): void {
  if (
    !hydrateMemoryRunExposureFromLedger({
      agentId: params.context.agentId,
      sessionId: params.context.sessionId,
      runId: params.context.runId,
    })
  ) {
    throw new Error("memory exposure ledger could not restore its durable tail");
  }
  const snapshot = prepareMemoryRunExposure(
    readTranscriptExposure({
      state: params.state,
      context: params.context,
      pendingEnvelope: params.envelope,
    }),
  );
  if (!persistMemoryRunExposureBeforeContent(snapshot) || !publishMemoryRunExposure(snapshot)) {
    throw new Error("memory exposure ledger did not commit before content release");
  }
  mergeEnvelope(params.state, params.envelope);
}

function readState(
  invocation: AuthorizedMemoryReadInvocation | AuthorizedMemoryDerivationInvocation,
): AnyContentInvocationState | undefined {
  return invocationStates.get(invocation) ?? derivationInvocationStates.get(invocation);
}

function canonicalizeAuthorizedVirtualView(params: {
  view: AuthorizedMemoryVirtualView;
  context: MemoryContentAccessContext<"read">;
  plan: AuthorizedMemoryContentPlan<"read">;
}): AuthorizedMemoryVirtualView | undefined {
  const { view, context, plan } = params;
  const mountHandles = new Set(plan.mounts.map((mount) => mount.mountHandle));
  const rootNames = new Map<string, string>();
  const rootHandles = new Set<string>();
  const virtualPaths = new Set<string>();
  const expiresAt = Date.parse(view.expiresAt);
  const valid =
    view.version === 1 &&
    view.planId === plan.planId &&
    view.contextFingerprint === context.contextFingerprint &&
    typeof view.viewId === "string" &&
    view.viewId.trim().length > 0 &&
    typeof view.revision === "string" &&
    view.revision.trim().length > 0 &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now() &&
    view.roots.length > 0 &&
    view.roots.every((root) => {
      const normalized = root.virtualRoot.normalize("NFC");
      const rootKey = normalized.toLocaleLowerCase("en-US");
      if (
        root.version !== 1 ||
        root.access !== "read" ||
        !mountHandles.has(root.mountHandle) ||
        !normalized ||
        !VIRTUAL_ROOT_PATTERN.test(normalized) ||
        normalized !== root.virtualRoot ||
        rootNames.has(rootKey) ||
        rootHandles.has(root.mountHandle)
      ) {
        return false;
      }
      rootNames.set(rootKey, root.mountHandle);
      rootHandles.add(root.mountHandle);
      return true;
    }) &&
    view.files.every((file) => {
      const normalized = file.virtualPath.normalize("NFC");
      const parts = normalized.split("/");
      const root = parts[0]!;
      const pathKey = normalized.toLocaleLowerCase("en-US");
      return file.version === 1 &&
        typeof file.mountHandle === "string" &&
        file.mountHandle.trim().length > 0 &&
        normalized === file.virtualPath &&
        parts.length === 2 &&
        Boolean(root) &&
        Boolean(parts[1]) &&
        parts[1] !== "." &&
        parts[1] !== ".." &&
        !parts[1]!.includes("\\") &&
        rootNames.get(root.toLocaleLowerCase("en-US")) === file.mountHandle &&
        !virtualPaths.has(pathKey)
        ? (virtualPaths.add(pathKey), true)
        : false;
    });
  if (!valid) {
    return undefined;
  }
  // Keep the exact opaque revision and manifest that the admitted provider issued.
  // Shallow-freezing provider data would let a later caller retarget a broker read.
  return Object.freeze({
    version: 1 as const,
    viewId: view.viewId,
    planId: view.planId,
    contextFingerprint: view.contextFingerprint,
    revision: view.revision,
    roots: Object.freeze(view.roots.map((root) => Object.freeze({ ...root }))),
    files: Object.freeze(view.files.map((file) => Object.freeze({ ...file }))),
    expiresAt: view.expiresAt,
  });
}

/**
 * Creates a process-local, opaque read invocation. No caller can inject a serializable identity,
 * audience, plan, or continuation: all of those come from the trusted context and selected backend.
 */
async function createAuthorizedMemoryContentInvocation(params: {
  context: TrustedMemoryAccessContext;
  capability?: MemoryPluginCapability;
}): Promise<AuthorizedMemoryReadInvocation | MemoryInvocationUnavailable> {
  const materialized = materializeTrustedMemoryAccessContext(params.context);
  if (!materialized || !isContentContextForOperation(materialized, "read")) {
    logMemoryInvocationDiagnostic("materialization-rejected");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  const context = materialized;
  const capability =
    params.capability ??
    resolveSelectedMemoryCapabilityRegistration(requireActivePluginRegistry())?.capability;
  const admission = await admitMemoryAuthorizationReadRuntime(capability);
  if (!admission.ok) {
    logMemoryInvocationDiagnostic("admission-rejected");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const authorizationStartedAtMs = Date.now();
    const plan = await admission.runtime.authorize(context);
    if (!isCurrentPlan({ context, plan, nowMs: Date.now() })) {
      logMemoryInvocationDiagnostic("invalid-plan");
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    const invocation = Object.freeze({}) as AuthorizedMemoryReadInvocation;
    invocationStates.set(
      invocation,
      Object.freeze({
        trustedContext: params.context,
        context,
        plan,
        authorizationStartedAtMs,
        runtime: admission.runtime,
        ...(admission.runtime.virtualView ? { virtualView: admission.runtime.virtualView } : {}),
        virtualViews: new Map(),
        handles: new Map(plan.bootstrapResourceHandles.map((handle) => [handle.handleId, handle])),
        sourcePolicySetIds: new Set<string>(),
        exposedRevisionHandles: new Set<string>(),
        exposureReceiptIds: new Set<string>(),
        egressReceiptIds: new Set<string>(),
        runExposureRevisions: new Set<string>(),
      }),
    );
    return invocation;
  } catch {
    logMemoryInvocationDiagnostic("authorization-failed");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

export async function createAuthorizedMemoryReadInvocation(params: {
  context: TrustedMemoryAccessContext;
  capability?: MemoryPluginCapability;
}): Promise<AuthorizedMemoryReadInvocation | MemoryInvocationUnavailable> {
  return await createAuthorizedMemoryContentInvocation(params);
}

/**
 * The selected plugin mints the opaque store capability. Core only binds that
 * result to durable parent/child lifecycle facts and never resolves a store id.
 */
export async function issueAuthorizedMemoryChildDelegationForInvocation(params: {
  context: TrustedMemoryAccessContext;
  issue: Omit<MemoryChildDelegationIssue, "parentContext">;
}): Promise<IssuedMemoryChildDelegation | MemoryInvocationUnavailable> {
  const parentContext = materializeTrustedMemoryAccessContext(params.context);
  if (
    !parentContext ||
    parentContext.operation !== "read" ||
    parentContext.delegation ||
    params.issue.child.agentId !== parentContext.agentId
  ) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  const capability = resolveSelectedMemoryCapabilityRegistration(
    requireActivePluginRegistry(),
  )?.capability;
  const admission = await admitMemoryAuthorizationRuntime(capability);
  if (!admission.ok || !admission.runtime.issueChildDelegation) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    return await admission.runtime.issueChildDelegation({
      ...params.issue,
      parentContext,
    });
  } catch {
    logMemoryInvocationDiagnostic("authorization-failed");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

/** Best-effort revocation closes the plugin token alongside the durable core grant. */
export async function revokeAuthorizedMemoryChildDelegationForInvocation(params: {
  agentId: string;
  storeCapToken: string;
}): Promise<void> {
  try {
    const capability = resolveSelectedMemoryCapabilityRegistration(
      requireActivePluginRegistry(),
    )?.capability;
    const admission = await admitMemoryAuthorizationRuntime(capability);
    if (admission.ok) {
      await admission.runtime.revokeChildDelegation?.(params);
    }
  } catch {
    // The core grant is already revoked and is the mandatory enforcement path.
  }
}

/**
 * Creates one opaque resource-derivation invocation. Search, exact reads, and
 * the eventual write all retain this same plan, so a source handle cannot be
 * replayed through a separately authorized destination plan.
 */
export async function createAuthorizedMemoryDeriveInvocation(params: {
  context: TrustedMemoryAccessContext;
  capability?: MemoryPluginCapability;
}): Promise<AuthorizedMemoryDerivationInvocation | MemoryInvocationUnavailable> {
  const context = materializeTrustedMemoryAccessContext(params.context);
  if (!context || !isContentContextForOperation(context, "derive")) {
    logMemoryInvocationDiagnostic("materialization-rejected");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  const capability =
    params.capability ??
    resolveSelectedMemoryCapabilityRegistration(requireActivePluginRegistry())?.capability;
  const admission = await admitMemoryAuthorizationRuntime(capability);
  if (!admission.ok) {
    logMemoryInvocationDiagnostic("admission-rejected");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const authorizationStartedAtMs = Date.now();
    const plan = await admission.runtime.authorize(context);
    // A derivation can have exactly one representable destination. Filtering a
    // multi-store result after model exposure would still launder its context.
    if (!isCurrentPlan({ context, plan, nowMs: Date.now() }) || plan.mounts.length !== 1) {
      logMemoryInvocationDiagnostic("invalid-plan");
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    const invocation = Object.freeze({}) as AuthorizedMemoryDerivationInvocation;
    derivationInvocationStates.set(
      invocation,
      Object.freeze({
        trustedContext: params.context,
        context,
        plan,
        authorizationStartedAtMs,
        runtime: admission.runtime,
        virtualViews: new Map(),
        handles: new Map(plan.bootstrapResourceHandles.map((handle) => [handle.handleId, handle])),
        sourcePolicySetIds: new Set<string>(),
        exposedRevisionHandles: new Set<string>(),
        exposureReceiptIds: new Set<string>(),
        egressReceiptIds: new Set<string>(),
        runExposureRevisions: new Set<string>(),
        observedSourceHandles: new Map(),
      }),
    );
    return invocation;
  } catch {
    logMemoryInvocationDiagnostic("authorization-failed");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

/**
 * Creates the authorization fence for a host-owned transcript export. Generic
 * `exportAuthorized` stays unusable for content until it has opaque export
 * handles; this operation only proves current export policy before the host
 * captures and publishes a transcript artifact.
 */
export async function createAuthorizedMemoryExportInvocation(params: {
  context: TrustedMemoryAccessContext;
  capability?: MemoryPluginCapability;
}): Promise<AuthorizedMemoryExportInvocation | MemoryInvocationUnavailable> {
  const context = materializeTrustedMemoryAccessContext(params.context);
  if (!context || !isContextForOperation(context, "export")) {
    logMemoryInvocationDiagnostic("materialization-rejected");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  const capability =
    params.capability ??
    resolveSelectedMemoryCapabilityRegistration(requireActivePluginRegistry())?.capability;
  const admission = await admitMemoryAuthorizationRuntime(capability);
  if (!admission.ok) {
    logMemoryInvocationDiagnostic("admission-rejected");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const plan = await admission.runtime.authorize(context);
    // One transcript policy set is the only currently representable source.
    // A multi-store export would need an explicit partitioned artifact format.
    if (!isCurrentPlan({ context, plan, nowMs: Date.now() }) || plan.mounts.length !== 1) {
      logMemoryInvocationDiagnostic("invalid-plan");
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    const invocation = Object.freeze({}) as AuthorizedMemoryExportInvocation;
    exportInvocationStates.set(
      invocation,
      Object.freeze({
        trustedContext: params.context,
        context,
        plan,
        runtime: admission.runtime,
      }),
    );
    return invocation;
  } catch {
    logMemoryInvocationDiagnostic("authorization-failed");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

/** Reauthorizes the fixed export context before every durable export transition. */
export async function recheckAuthorizedMemoryExportInvocation(params: {
  invocation: AuthorizedMemoryExportInvocation;
}): Promise<boolean> {
  const state = exportInvocationStates.get(params.invocation);
  const context = state ? readCurrentExportContext(state) : undefined;
  if (!state || !context || !isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() })) {
    return false;
  }
  try {
    const current = await state.runtime.authorize(context);
    return Boolean(
      isCurrentPlan({ context, plan: current, nowMs: Date.now() }) && current.mounts.length === 1,
    );
  } catch {
    logMemoryInvocationDiagnostic("authorization-failed");
    return false;
  }
}

async function authorizeWriteInvocation<Operation extends WriteOperation>(params: {
  context: MemoryAccessContext & Readonly<{ operation: Operation }>;
  trustedContext: TrustedMemoryAccessContext;
  runtime: Readonly<AuthorizedMemoryRuntime>;
}): Promise<WriteInvocationState<Operation> | undefined> {
  const plan = await params.runtime.authorize(params.context);
  if (!isCurrentPlan({ context: params.context, plan, nowMs: Date.now() })) {
    logMemoryInvocationDiagnostic("invalid-plan");
    return undefined;
  }
  return Object.freeze({
    trustedContext: params.trustedContext,
    context: params.context,
    plan,
    runtime: params.runtime,
  });
}

async function createWriteInvocationState(params: {
  context: MemoryAccessContext & Readonly<{ operation: WriteOperation }>;
  trustedContext: TrustedMemoryAccessContext;
  runtime: Readonly<AuthorizedMemoryRuntime>;
}): Promise<AnyWriteInvocationState | undefined> {
  const shared = { trustedContext: params.trustedContext, runtime: params.runtime };
  switch (params.context.operation) {
    case "append":
      return await authorizeWriteInvocation({ ...shared, context: params.context });
    case "replace":
      return await authorizeWriteInvocation({ ...shared, context: params.context });
    case "derive":
      return await authorizeWriteInvocation({ ...shared, context: params.context });
    case "deposit":
      return await authorizeWriteInvocation({ ...shared, context: params.context });
    case "project":
      return await authorizeWriteInvocation({ ...shared, context: params.context });
    case "publish":
      return await authorizeWriteInvocation({ ...shared, context: params.context });
    case "import":
      return await authorizeWriteInvocation({ ...shared, context: params.context });
    case "delete":
      return await authorizeWriteInvocation({ ...shared, context: params.context });
    case "sync":
      return await authorizeWriteInvocation({ ...shared, context: params.context });
    case "policy-admin":
      return await authorizeWriteInvocation({ ...shared, context: params.context });
  }
}

/**
 * Creates a process-local write invocation from host-minted facts. This is separate from read
 * exposure because a write is a resource lifecycle decision, never a continuation of a search hit.
 */
export async function createAuthorizedMemoryWriteInvocation(params: {
  context: TrustedMemoryAccessContext;
  capability?: MemoryPluginCapability;
}): Promise<AuthorizedMemoryWriteInvocation | MemoryInvocationUnavailable> {
  const context = materializeTrustedMemoryAccessContext(params.context);
  if (!context || !isWriteContext(context)) {
    logMemoryInvocationDiagnostic("materialization-rejected");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  const capability =
    params.capability ??
    resolveSelectedMemoryCapabilityRegistration(requireActivePluginRegistry())?.capability;
  const admission = await admitMemoryAuthorizationRuntime(capability);
  if (!admission.ok) {
    logMemoryInvocationDiagnostic("admission-rejected");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const state = await createWriteInvocationState({
      context,
      trustedContext: params.context,
      runtime: admission.runtime,
    });
    if (!state) {
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    const invocation = Object.freeze({}) as AuthorizedMemoryWriteInvocation;
    writeInvocationStates.set(invocation, state);
    return invocation;
  } catch {
    logMemoryInvocationDiagnostic("authorization-failed");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

/**
 * The host supplies the opaque invocation and mutation identity. Runtime arguments remain limited
 * to a closed mutation DTO, so content cannot retarget a store, owner, root, or broader audience.
 */
async function invokeAuthorizedMemoryWrite(params: {
  state: AnyWriteInvocationState;
  context: MemoryAccessContext & Readonly<{ operation: WriteOperation }>;
  mutation: AuthorizedMemoryMutation;
}): Promise<MemoryWriteResult | undefined> {
  const { state, context, mutation } = params;
  if (
    isWriteInvocationStateFor(state, "append") &&
    isContextForOperation(context, "append") &&
    (mutation.kind === "remember" || mutation.kind === "append")
  ) {
    return await writeAuthorizedMemoryForCurrentState({ state, context, mutation });
  }
  if (
    isWriteInvocationStateFor(state, "replace") &&
    isContextForOperation(context, "replace") &&
    mutation.kind === "replace"
  ) {
    return await writeAuthorizedMemoryForCurrentState({ state, context, mutation });
  }
  if (
    isWriteInvocationStateFor(state, "derive") &&
    isContextForOperation(context, "derive") &&
    mutation.kind === "derive"
  ) {
    return await writeAuthorizedMemoryForCurrentState({ state, context, mutation });
  }
  if (
    isWriteInvocationStateFor(state, "deposit") &&
    isContextForOperation(context, "deposit") &&
    mutation.kind === "deposit"
  ) {
    return await writeAuthorizedMemoryForCurrentState({ state, context, mutation });
  }
  if (
    isWriteInvocationStateFor(state, "project") &&
    isContextForOperation(context, "project") &&
    mutation.kind === "project"
  ) {
    return await writeAuthorizedMemoryForCurrentState({ state, context, mutation });
  }
  if (
    isWriteInvocationStateFor(state, "publish") &&
    isContextForOperation(context, "publish") &&
    mutation.kind === "publish"
  ) {
    return await writeAuthorizedMemoryForCurrentState({ state, context, mutation });
  }
  if (
    isWriteInvocationStateFor(state, "import") &&
    isContextForOperation(context, "import") &&
    mutation.kind === "import"
  ) {
    return await writeAuthorizedMemoryForCurrentState({ state, context, mutation });
  }
  if (
    isWriteInvocationStateFor(state, "delete") &&
    isContextForOperation(context, "delete") &&
    (mutation.kind === "delete" || mutation.kind === "tombstone")
  ) {
    return await writeAuthorizedMemoryForCurrentState({ state, context, mutation });
  }
  if (
    isWriteInvocationStateFor(state, "sync") &&
    isContextForOperation(context, "sync") &&
    mutation.kind === "sync"
  ) {
    return await writeAuthorizedMemoryForCurrentState({ state, context, mutation });
  }
  if (
    isWriteInvocationStateFor(state, "policy-admin") &&
    isContextForOperation(context, "policy-admin") &&
    mutation.kind === "admin-reclassify"
  ) {
    return await writeAuthorizedMemoryForCurrentState({ state, context, mutation });
  }
  return undefined;
}

/**
 * `invokeAuthorizedMemoryWrite` has already narrowed this triple to one SDK
 * operation. Its private distributed parameter union cannot retain that fact
 * at the runtime call boundary, so keep the bridge at this single boundary.
 */
async function writeAuthorizedMemoryForCurrentState(params: {
  state: AnyWriteInvocationState;
  context: MemoryAccessContext & Readonly<{ operation: WriteOperation }>;
  mutation: AuthorizedMemoryMutation;
}): Promise<MemoryWriteResult> {
  return await params.state.runtime.writeAuthorized({
    context: params.context,
    plan: params.state.plan,
    mutation: params.mutation,
  } as never);
}

export async function writeAuthorizedMemoryForInvocation(params: {
  invocation: AuthorizedMemoryWriteInvocation;
  mutation: AuthorizedMemoryMutation;
}): Promise<MemoryWriteResult | MemoryInvocationUnavailable> {
  const state = writeInvocationStates.get(params.invocation);
  const context = state ? readCurrentWriteContext(state) : undefined;
  if (!state || !context || !isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() })) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    return (
      (await invokeAuthorizedMemoryWrite({ state, context, mutation: params.mutation })) ??
      MEMORY_INVOCATION_UNAVAILABLE
    );
  } catch {
    logMemoryInvocationDiagnostic("authorization-failed");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

/** Reissues host facts for a derive write before its transcript source reaches a provider. */
export function recheckAuthorizedMemoryDeriveWriteInvocation(params: {
  invocation: AuthorizedMemoryWriteInvocation;
}): boolean {
  const state = writeInvocationStates.get(params.invocation);
  const context = state ? readCurrentWriteContext(state) : undefined;
  return Boolean(
    state &&
    context &&
    isDeriveWriteInvocationState(state) &&
    isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() }),
  );
}

function deriveMutationId(params: {
  content: string;
  purpose: AuthorizedResourceDerivationPurpose;
  sourceHandles: readonly AuthorizedResourceHandle[];
}): string {
  const sourceRevisions = params.sourceHandles.map((handle) => handle.resourceRevision).toSorted();
  return `mderive1_${createHash("sha256")
    .update(params.purpose)
    .update("\0")
    .update(sourceRevisions.join("\0"))
    .update("\0")
    .update(params.content)
    .digest("base64url")}`;
}

/**
 * Commits a resource-derived revision from exactly the handles whose content
 * this invocation exposed. The caller supplies only output bytes and a
 * purpose fixed by its host; no store, audience, parent, or policy input can
 * retarget the mutation.
 */
export async function commitAuthorizedMemoryDerivationForInvocation(params: {
  invocation: AuthorizedMemoryDerivationInvocation;
  content: string;
  contentType?: "markdown" | "text" | "json";
  purpose: AuthorizedResourceDerivationPurpose;
}): Promise<MemoryWriteResult | MemoryInvocationUnavailable> {
  const state = derivationInvocationStates.get(params.invocation);
  const context = state ? readCurrentContext(state) : undefined;
  const sourceHandles = state ? [...state.observedSourceHandles.values()] : [];
  if (
    !state ||
    !context ||
    context.operation !== "derive" ||
    !isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() }) ||
    sourceHandles.length === 0
  ) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const mutationId = deriveMutationId({
      content: params.content,
      purpose: params.purpose,
      sourceHandles,
    });
    return await state.runtime.writeAuthorized({
      context,
      plan: state.plan,
      mutation: {
        version: 1,
        kind: "derive",
        derivationPurpose: params.purpose,
        mutationId,
        idempotencyKey: mutationId,
        content: params.content,
        contentType: params.contentType ?? "markdown",
        sourceHandles,
      },
    });
  } catch {
    logMemoryInvocationDiagnostic("authorization-failed");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

/**
 * Revalidates every source already released to a derivation model without
 * releasing their bytes again. A revoked, tombstoned, or reclassified source
 * must fail before the next provider dispatch, not only during commit.
 */
export async function recheckAuthorizedMemoryDerivationSources(params: {
  invocation: AuthorizedMemoryDerivationInvocation;
}): Promise<boolean> {
  const state = derivationInvocationStates.get(params.invocation);
  const context = state ? readCurrentContext(state) : undefined;
  const sourceHandles = state ? [...state.observedSourceHandles.values()] : [];
  if (
    !state ||
    !context ||
    context.operation !== "derive" ||
    !isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() }) ||
    sourceHandles.length === 0
  ) {
    return false;
  }
  try {
    for (const handle of sourceHandles) {
      if (state.handles.get(handle.handleId) !== handle) {
        return false;
      }
      const envelope = await readAuthorizedMemoryWithCurrentState({
        state,
        context,
        handle,
        from: 1,
        lines: 1,
      });
      if (
        !envelope ||
        !validateEnvelope({
          state,
          context,
          expectedRevisionHandles: [handle.resourceRevision],
          envelope,
        })
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

const MAXIMUM_DERIVATION_SOURCE_CHARACTERS = 32_000;

/**
 * Reads the selected runtime's bounded derive bootstrap through the same
 * receipt-recording path as an interactive exact read. The bootstrap handles
 * never leave this core-owned invocation, so a plugin cannot enumerate another
 * store or retain a continuation beyond the plan lifetime.
 */
export async function collectAuthorizedMemoryDerivationSources(params: {
  invocation: AuthorizedMemoryDerivationInvocation;
  signal?: AbortSignal;
}): Promise<readonly MemoryReadResult[] | MemoryInvocationUnavailable> {
  const state = derivationInvocationStates.get(params.invocation);
  const context = state ? readCurrentContext(state) : undefined;
  if (
    !state ||
    !context ||
    context.operation !== "derive" ||
    !isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() })
  ) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  const sources: MemoryReadResult[] = [];
  let remainingCharacters = MAXIMUM_DERIVATION_SOURCE_CHARACTERS;
  for (const handle of state.plan.bootstrapResourceHandles) {
    if (params.signal?.aborted || remainingCharacters <= 0) {
      break;
    }
    const result = await readAuthorizedMemoryForInvocation({
      invocation: params.invocation,
      handleId: handle.handleId,
      from: 1,
      lines: 200,
    });
    if ("unavailable" in result) {
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    const text = result.text.slice(0, remainingCharacters);
    remainingCharacters -= text.length;
    sources.push(Object.freeze({ ...result, text }));
  }
  return Object.freeze(sources);
}

/**
 * Stages bytes before the caller opens its transaction. The returned closure is
 * the only route that may insert the selected runtime's revision/catalog rows
 * into the core-owned sealed compaction transaction.
 */
export async function stageAuthorizedMemorySealedCompactionForInvocation(params: {
  invocation: AuthorizedMemoryWriteInvocation;
  content: string;
  transcriptSource: AuthorizedTranscriptDerivationSource;
}): Promise<AuthorizedSealedCompactionArtifact | MemoryInvocationUnavailable> {
  const state = writeInvocationStates.get(params.invocation);
  if (!state || !isDeriveWriteInvocationState(state)) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  const context = readCurrentWriteContext(state);
  if (
    !context ||
    !state.runtime.stageSealedCompaction ||
    !isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() })
  ) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    return await state.runtime.stageSealedCompaction({
      context,
      plan: state.plan,
      content: params.content,
      transcriptSource: params.transcriptSource,
    });
  } catch {
    logMemoryInvocationDiagnostic("authorization-failed");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

/**
 * Obtains a selected-plugin projection for generic FS and sandbox consumers.
 * It is deliberately separate from search/read: no tool argument can turn a
 * host path, artifact locator, or mount handle into a projection request.
 */
export async function materializeAuthorizedMemoryVirtualView(params: {
  invocation: AuthorizedMemoryReadInvocation;
}): Promise<AuthorizedMemoryVirtualView | MemoryInvocationUnavailable> {
  const state = readState(params.invocation);
  const context = state ? readCurrentContext(state) : undefined;
  // Derivations may expose source bytes only to their dedicated content path. A generic virtual
  // filesystem is a read capability, so it must not become an alternate derive transport.
  if (
    !state ||
    !context ||
    !isReadContentContext(context) ||
    !isReadInvocationState(state) ||
    !state.virtualView
  ) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const view = await state.virtualView.materializeAuthorizedVirtualView({
      context,
      plan: state.plan,
    });
    const canonical = view
      ? canonicalizeAuthorizedVirtualView({ view, context, plan: state.plan })
      : undefined;
    if (!canonical) {
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    state.virtualViews.set(canonical.viewId, canonical);
    return canonical;
  } catch {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

/**
 * Reads one broker-addressed file from an opaque virtual view. The selected
 * plugin never gives core a storage path, and the durable exposure receipt is
 * committed before its content becomes visible to a generic file tool.
 */
export async function readAuthorizedMemoryVirtualFile(params: {
  invocation: AuthorizedMemoryReadInvocation;
  view: AuthorizedMemoryVirtualView;
  virtualPath: string;
}): Promise<MemoryReadResult | MemoryInvocationUnavailable> {
  const state = readState(params.invocation);
  const context = state ? readCurrentContext(state) : undefined;
  if (
    !state ||
    !context ||
    !isReadContentContext(context) ||
    !isReadInvocationState(state) ||
    !state.virtualView ||
    !isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() }) ||
    state.virtualViews.get(params.view.viewId) !== params.view ||
    !params.view.files.some((file) => file.virtualPath === params.virtualPath)
  ) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const envelope = await state.virtualView.readAuthorizedVirtualFile({
      context,
      plan: state.plan,
      view: params.view,
      virtualPath: params.virtualPath,
    });
    if (
      !validateEnvelope({
        state,
        context,
        expectedRevisionHandles: envelope.exposureReceipt.exposedRevisionHandles,
        envelope,
      })
    ) {
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    recordEnvelopeExposure({ state, context, envelope });
    return Object.freeze({ ...envelope.value });
  } catch {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

async function searchAuthorizedMemoryWithCurrentState(params: {
  state: AnyContentInvocationState;
  context: MemoryContentAccessContext<MemoryContentAccessOperation>;
  query: string;
  sources?: readonly MemorySource[];
  limit: number;
  signal?: AbortSignal;
}) {
  const input = {
    query: params.query,
    ...(params.sources ? { sources: params.sources } : {}),
    limit: params.limit,
    ...(params.signal ? { signal: params.signal } : {}),
  };
  if (isReadInvocationState(params.state) && isReadContentContext(params.context)) {
    return await params.state.runtime.searchAuthorized({
      context: params.context,
      plan: params.state.plan,
      ...input,
    });
  }
  if (
    isDerivationInvocationState(params.state) &&
    isContentContextForOperation(params.context, "derive")
  ) {
    return await params.state.runtime.searchAuthorized({
      context: params.context,
      plan: params.state.plan,
      ...input,
    });
  }
  return undefined;
}

async function readAuthorizedMemoryWithCurrentState(params: {
  state: AnyContentInvocationState;
  context: MemoryContentAccessContext<MemoryContentAccessOperation>;
  handle: AuthorizedResourceHandle;
  from?: number;
  lines?: number;
}) {
  const input = {
    handle: params.handle,
    ...(params.from !== undefined ? { from: params.from } : {}),
    ...(params.lines !== undefined ? { lines: params.lines } : {}),
  };
  if (isReadInvocationState(params.state) && isReadContentContext(params.context)) {
    return await params.state.runtime.readAuthorized({
      context: params.context,
      plan: params.state.plan,
      ...input,
    });
  }
  if (
    isDerivationInvocationState(params.state) &&
    isContentContextForOperation(params.context, "derive")
  ) {
    return await params.state.runtime.readAuthorized({
      context: params.context,
      plan: params.state.plan,
      ...input,
    });
  }
  return undefined;
}

export async function searchAuthorizedMemoryForInvocation(params: {
  invocation: AuthorizedMemoryReadInvocation | AuthorizedMemoryDerivationInvocation;
  query: string;
  sources?: readonly MemorySource[];
  limit?: number;
  signal?: AbortSignal;
}): Promise<
  | Readonly<{
      results: readonly (MemorySearchResult & Readonly<{ handleId: string }>)[];
    }>
  | MemoryInvocationUnavailable
> {
  const state = readState(params.invocation);
  const context = state ? readCurrentContext(state) : undefined;
  if (!state || !context || !isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() })) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const envelope = await searchAuthorizedMemoryWithCurrentState({
      state,
      context,
      query: params.query,
      limit: Math.max(1, Math.min(100, Math.trunc(params.limit ?? 10))),
      ...(params.sources ? { sources: params.sources } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!envelope) {
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    const revisionHandles = envelope.value.map((result) => result.resourceHandle.resourceRevision);
    if (
      !validateEnvelope({
        state,
        context,
        expectedRevisionHandles: revisionHandles,
        envelope,
      })
    ) {
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    recordEnvelopeExposure({ state, context, envelope });
    const results = envelope.value.map((result) => {
      state.handles.set(result.resourceHandle.handleId, result.resourceHandle);
      if (isDerivationInvocationState(state)) {
        // A snippet is model-visible source material too, even when the model
        // does not subsequently request its full text.
        state.observedSourceHandles.set(result.resourceHandle.handleId, result.resourceHandle);
      }
      const { resourceHandle: _resourceHandle, ...safe } = result;
      return Object.freeze({ ...safe, handleId: result.resourceHandle.handleId });
    });
    return Object.freeze({ results: Object.freeze(results) });
  } catch {
    logMemoryInvocationDiagnostic("search-failed");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

export async function readAuthorizedMemoryForInvocation(params: {
  invocation: AuthorizedMemoryReadInvocation | AuthorizedMemoryDerivationInvocation;
  handleId: string;
  from?: number;
  lines?: number;
}): Promise<MemoryReadResult | MemoryInvocationUnavailable> {
  const state = readState(params.invocation);
  const context = state ? readCurrentContext(state) : undefined;
  const handle = state?.handles.get(params.handleId);
  if (
    !state ||
    !context ||
    !handle ||
    !isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() })
  ) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const envelope = await readAuthorizedMemoryWithCurrentState({
      state,
      context,
      handle,
      ...(params.from !== undefined ? { from: params.from } : {}),
      ...(params.lines !== undefined ? { lines: params.lines } : {}),
    });
    if (!envelope) {
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    if (
      !validateEnvelope({
        state,
        context,
        expectedRevisionHandles: [handle.resourceRevision],
        envelope,
      })
    ) {
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    recordEnvelopeExposure({ state, context, envelope });
    if (isDerivationInvocationState(state)) {
      state.observedSourceHandles.set(handle.handleId, handle);
    }
    return Object.freeze({ ...envelope.value });
  } catch {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

/** Snapshot prepared for transcript persistence; it has no content or display path fields. */
export function readAuthorizedMemoryRunExposure(invocation: AuthorizedMemoryReadInvocation):
  | Readonly<{
      sourcePolicySetIds: readonly string[];
      exposedRevisionHandles: readonly string[];
      exposureReceiptIds: readonly string[];
      egressReceiptIds: readonly string[];
    }>
  | undefined {
  const state = readState(invocation);
  if (!state || !readCurrentContext(state)) {
    return undefined;
  }
  return Object.freeze({
    sourcePolicySetIds: Object.freeze([...state.sourcePolicySetIds].toSorted()),
    exposedRevisionHandles: Object.freeze([...state.exposedRevisionHandles].toSorted()),
    exposureReceiptIds: Object.freeze([...state.exposureReceiptIds].toSorted()),
    egressReceiptIds: Object.freeze([...state.egressReceiptIds].toSorted()),
  });
}

/** Returns the immutable facts needed to persist the current run exposure with a transcript row. */
export function readAuthorizedMemoryTranscriptExposure(invocation: AuthorizedMemoryReadInvocation):
  | Readonly<{
      agentId: string;
      sessionId: string;
      sessionKey: string;
      runId: string;
      contextFingerprint: string;
      planId: string;
      memoryPolicyRevision: string;
      sourcePolicySetIds: readonly string[];
      exposedResourceRevisions: readonly string[];
      exposureReceiptIds: readonly string[];
      egressReceiptIds: readonly string[];
      deliveryAudiences: readonly AudienceRef[];
      deliveryRevision: string;
      egressRegistryRevision: string;
      sessionIdentityRevision: string;
      subjectRevision: string;
    }>
  | undefined {
  const state = readState(invocation);
  const context = state ? readCurrentContext(state) : undefined;
  if (!state || !context || !isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() })) {
    return undefined;
  }
  return readTranscriptExposure({ state, context });
}
