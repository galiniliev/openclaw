/** Acyclic contracts for capabilities stored in the installed plugin registry. */
import type { EmbeddingInput } from "../../packages/memory-host-sdk/src/engine-embeddings.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngine } from "../context-engine/types.js";
import type { MemoryAuthorizationConformanceAdapter } from "../memory-host-sdk/host/authorization-conformance.js";
import type {
  AuthorizedMemoryRuntime,
  AuthorizedMemoryContentPlan,
  AuthorizedMemoryResultEnvelope,
  AuthorizedMemoryVirtualView,
  MemoryAuthorizationCapabilities,
  MemoryContentAccessContext,
} from "../memory-host-sdk/host/authorization.js";
import type { MemorySearchManager, MemorySearchResult } from "../memory-host-sdk/host/types.js";
import type { MemoryReadResult } from "../memory-host-sdk/host/types.js";
import type {
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderIndexIdentity,
  EmbeddingProviderRuntime,
} from "./embedding-provider-types.js";
import type { AuthorizedMemoryReadHost } from "./tool-types.js";

export type ContextEngineFactoryContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
};
export type ContextEngineFactory = (
  ctx: ContextEngineFactoryContext,
) => ContextEngine | Promise<ContextEngine>;
export type ContextEngineRegistrationLifecycle = "runtime" | "readOnlyDiscovery";
export type ContextEngineRegistration = {
  factory: ContextEngineFactory;
  owner: string;
  lifecycle: ContextEngineRegistrationLifecycle;
};

type CompactionProviderSummarizationInstructions = {
  identifierPolicy?: "strict" | "off" | "custom";
  identifierInstructions?: string;
};

export interface CompactionProvider {
  id: string;
  label: string;
  summarize(params: {
    messages: unknown[];
    signal?: AbortSignal;
    compressionRatio?: number;
    customInstructions?: string;
    summarizationInstructions?: CompactionProviderSummarizationInstructions;
    previousSummary?: string;
  }): Promise<string>;
}

export type RegisteredCompactionProvider = {
  provider: CompactionProvider;
  ownerPluginId?: string;
};

export type MemoryEmbeddingBatchChunk = {
  text: string;
  embeddingInput?: EmbeddingInput;
};

export type MemoryEmbeddingBatchOptions = {
  agentId: string;
  chunks: MemoryEmbeddingBatchChunk[];
  wait: boolean;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
  debug: (message: string, data?: Record<string, unknown>) => void;
};

export type MemoryEmbeddingProviderCallOptions = Pick<EmbeddingProviderCallOptions, "signal">;

export type MemoryEmbeddingProviderRuntime = EmbeddingProviderRuntime & {
  sourceWideBatchEmbed?: boolean;
  batchEmbed?: (options: MemoryEmbeddingBatchOptions) => Promise<number[][] | null>;
};

export type MemoryEmbeddingProviderIndexIdentity = EmbeddingProviderIndexIdentity;

export type MemoryEmbeddingProvider = Pick<
  EmbeddingProvider,
  "id" | "model" | "maxInputTokens" | "close"
> & {
  embedQuery: (text: string, options?: MemoryEmbeddingProviderCallOptions) => Promise<number[]>;
  embedBatch: (
    texts: string[],
    options?: MemoryEmbeddingProviderCallOptions,
  ) => Promise<number[][]>;
  embedBatchInputs?: (
    inputs: EmbeddingInput[],
    options?: MemoryEmbeddingProviderCallOptions,
  ) => Promise<number[][]>;
};

export type MemoryEmbeddingProviderCreateOptions = Omit<
  EmbeddingProviderCreateOptions,
  "dimensions" | "local" | "taskType"
> & {
  fallback?: string;
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
    contextSize?: number | "auto";
  };
  outputDimensionality?: number;
  taskType?:
    | "RETRIEVAL_QUERY"
    | "RETRIEVAL_DOCUMENT"
    | "SEMANTIC_SIMILARITY"
    | "CLASSIFICATION"
    | "CLUSTERING"
    | "QUESTION_ANSWERING"
    | "FACT_VERIFICATION";
};

export type MemoryEmbeddingProviderCreateResult = {
  provider: MemoryEmbeddingProvider | null;
  runtime?: MemoryEmbeddingProviderRuntime;
};

export type MemoryEmbeddingProviderAdapter = Omit<
  EmbeddingProviderAdapter,
  "create" | "resolveIndexIdentity"
> & {
  autoSelectPriority?: number;
  allowExplicitWhenConfiguredAuto?: boolean;
  supportsMultimodalEmbeddings?: (params: { model: string }) => boolean;
  resolveIndexIdentity?: (
    options: MemoryEmbeddingProviderCreateOptions,
  ) => MemoryEmbeddingProviderIndexIdentity;
  create: (
    options: MemoryEmbeddingProviderCreateOptions,
  ) => Promise<MemoryEmbeddingProviderCreateResult>;
  shouldContinueAutoSelection?: (err: unknown) => boolean;
};

export type MemoryPromptSectionParams = {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  /** True when supplemental legacy memory reads are unavailable for this agent. */
  memoryReadEnforced?: true;
  /**
   * Host-minted invocation for this run's selected authorized memory runtime.
   * In enforced mode, prompt contributors must not derive access from agent or
   * session strings; an absent handle means their content path is unavailable.
   */
  authorizedMemoryRead?: AuthorizedMemoryReadHost;
};

export type MemoryPromptSectionBuilder = (params: MemoryPromptSectionParams) => string[];

export type MemoryPromptSectionPreparer = (
  params: MemoryPromptSectionParams,
) => Promise<readonly string[]>;

export type PreparedMemoryPromptSection = Readonly<{
  context: Readonly<{
    availableTools: readonly string[];
    citationsMode?: MemoryCitationsMode;
    agentId?: string;
    agentSessionKey?: string;
    sandboxed: boolean;
    memoryReadEnforced: boolean;
    authorizedMemoryRead?: AuthorizedMemoryReadHost;
  }>;
  lines: readonly string[];
}>;

export type MemoryCorpusSearchResult = {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  score: number;
  snippet: string;
  id?: string;
  startLine?: number;
  endLine?: number;
  citation?: string;
  source?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
};

type MemoryCorpusGetResult = {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  content: string;
  fromLine: number;
  lineCount: number;
  id?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
};

export type MemoryCorpusSupplement = {
  search(params: {
    query: string;
    maxResults?: number;
    agentId?: string;
    agentSessionKey?: string;
    sandboxed?: boolean;
    memoryReadEnforced?: true;
    /** Host-minted invocation for this run; required for enforced content access. */
    authorizedMemoryRead?: AuthorizedMemoryReadHost;
  }): Promise<MemoryCorpusSearchResult[]>;
  get(params: {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
    agentId?: string;
    agentSessionKey?: string;
    sandboxed?: boolean;
    memoryReadEnforced?: true;
    /** Host-minted invocation for this run; required for enforced content access. */
    authorizedMemoryRead?: AuthorizedMemoryReadHost;
  }): Promise<MemoryCorpusGetResult | null>;
};

export type MemoryCorpusSupplementRegistration = {
  pluginId: string;
  supplement: MemoryCorpusSupplement;
};

export type MemoryPromptSupplementRegistration = {
  pluginId: string;
  builder: MemoryPromptSectionBuilder;
};

export type MemoryPromptPreparationRegistration = {
  pluginId: string;
  prepare: MemoryPromptSectionPreparer;
};

export type MemoryFlushPlan = {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
  model?: string;
  prompt: string;
  systemPrompt: string;
  relativePath: string;
  recordWriteProvenance?: (params: {
    workspaceDir: string;
    relativePath: string;
    contentBefore: string;
    contentAfter: string;
    originClass: "agent" | "untrusted";
    observedAt: number;
  }) => Promise<(() => Promise<void>) | void>;
  clearWriteProvenance?: (params: { workspaceDir: string; relativePath: string }) => Promise<void>;
};

export type MemoryFlushPlanResolver = (params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  nowMs?: number;
}) => MemoryFlushPlan | null;

export type RegisteredMemorySearchManager = MemorySearchManager;

type MemoryRuntimeBackendConfig = { backend: "builtin" };

/**
 * Doctor supplies the local control-plane facts; the selected memory plugin owns source handling,
 * backup, placement, scoped catalog/index creation, and verification before core flips cutover.
 */
export type MemoryIsolationMigrationAction = "dry-run" | "apply";

export type MemoryIsolationMigrationActor = Readonly<{
  role: "owner" | "admin";
  principalId: string;
}>;

export type MemoryIsolationMigrationDecision =
  | Readonly<{ sourceId: string; sourceHash: string; placement: "quarantine" }>
  | Readonly<{
      sourceId: string;
      sourceHash: string;
      placement: "user-private";
      principalId: string;
    }>;

/** Core validates this durable marker before delegating destructive legacy archival to a plugin. */
export type MemoryIsolationFinalCutover = Readonly<{
  migrationId: string;
  planHash: string;
  sources: readonly Readonly<{ sourceKind: string; sourceHash: string }>[];
}>;

export type MemoryIsolationMigrationResult = Readonly<{
  state: "planned" | "verified";
  migrationId: string;
  planHash: string;
  sources: readonly Readonly<{
    sourceId: string;
    sourceKind: string;
    sourceHash: string;
    placement: "quarantine" | "user-private";
  }>[];
  verifiedSources?: readonly Readonly<{ sourceKind: string; sourceHash: string }>[];
}>;

export type MemoryIsolationDowngradeExport = Readonly<{
  outputDir: string;
  exportedResources: number;
  excludedQuarantineResources: number;
  warning: string;
}>;

export type MemoryPluginRuntime = {
  authorize?: AuthorizedMemoryRuntime["authorize"];
  searchAuthorized?: AuthorizedMemoryRuntime["searchAuthorized"];
  readAuthorized?: AuthorizedMemoryRuntime["readAuthorized"];
  writeAuthorized?: AuthorizedMemoryRuntime["writeAuthorized"];
  stageSealedCompaction?: AuthorizedMemoryRuntime["stageSealedCompaction"];
  importAuthorized?: AuthorizedMemoryRuntime["importAuthorized"];
  syncAuthorized?: AuthorizedMemoryRuntime["syncAuthorized"];
  exportAuthorized?: AuthorizedMemoryRuntime["exportAuthorized"];
  statusAuthorized?: AuthorizedMemoryRuntime["statusAuthorized"];
  runIsolationMigration?(params: {
    action: MemoryIsolationMigrationAction;
    agentId: string;
    workspaceDir: string;
    stateDir: string;
    migrationId: string;
    actor: MemoryIsolationMigrationActor;
    decisions: readonly MemoryIsolationMigrationDecision[];
    /** Required for apply: the exact dry-run plan digest the operator reviewed. */
    expectedPlanHash?: string;
    nowMs?: number;
  }): Promise<MemoryIsolationMigrationResult>;
  archiveIsolationMigration?(params: {
    agentId: string;
    workspaceDir: string;
    stateDir: string;
    migrationId: string;
    cutover: MemoryIsolationFinalCutover;
    nowMs?: number;
  }): Promise<void>;
  /** Retire verified scoped copies before final cutover while retaining the verified backup/source. */
  rollbackIsolationMigration?(params: {
    agentId: string;
    migrationId: string;
    planHash: string;
    nowMs?: number;
  }): Promise<void>;
  exportIsolationMigration?(params: {
    agentId: string;
    migrationId: string;
    outputDir: string;
    /** Core validates the durable final marker before a plugin can export scoped data. */
    cutover: MemoryIsolationFinalCutover;
    nowMs?: number;
  }): Promise<MemoryIsolationDowngradeExport>;
  getMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status" | "cli";
  }): Promise<{
    manager: RegisteredMemorySearchManager | null;
    debug?: {
      backend?: "builtin";
      purpose?: "default" | "status" | "cli";
      managerMs?: number;
    };
    error?: string;
  }>;
  resolveMemoryBackendConfig(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): MemoryRuntimeBackendConfig;
  /** Authorize raw hits before caller-visible use; absent runtimes must not expose session hits. */
  authorizeSearchHits?(params: {
    cfg: OpenClawConfig;
    agentId: string;
    requesterSessionKey: string | undefined;
    sandboxed: boolean;
    hits: MemorySearchResult[];
  }): Promise<MemorySearchResult[]>;
  closeMemorySearchManager?(params: { cfg: OpenClawConfig; agentId: string }): Promise<void>;
  closeAllMemorySearchManagers?(): Promise<void>;
};

type MemoryPluginPublicArtifactContentType = "markdown" | "json" | "text";

export type MemoryPluginPublicArtifact = {
  kind: string;
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
  agentIds: string[];
  contentType: MemoryPluginPublicArtifactContentType;
};

export type MemoryPluginPublicArtifactsProvider = {
  listArtifacts(params: { cfg: OpenClawConfig }): Promise<MemoryPluginPublicArtifact[]>;
};

/**
 * A selected memory plugin may move its content-bearing runtime behind the Gateway-owned broker.
 * The module URL is resolved by the plugin itself, so core neither knows a bundled plugin id nor
 * reaches into a plugin package's private source tree.
 */
export type MemoryPluginBrokerEntry = Readonly<{
  version: 1;
  kind: "local-child";
  moduleUrl: string;
}>;

/**
 * Selected-memory-only virtual projection. The implementation owns artifact
 * access and returns an opaque, read-only view; core only mounts the returned
 * projection and never derives paths from resource metadata.
 */
export type MemoryPluginVirtualViewProvider = {
  materializeAuthorizedVirtualView(params: {
    context: MemoryContentAccessContext<"read">;
    plan: AuthorizedMemoryContentPlan<"read">;
    signal?: AbortSignal;
  }): Promise<AuthorizedMemoryVirtualView | undefined>;
  readAuthorizedVirtualFile(params: {
    context: MemoryContentAccessContext<"read">;
    plan: AuthorizedMemoryContentPlan<"read">;
    view: AuthorizedMemoryVirtualView;
    /** Virtual-only slash-separated path, never a host filesystem path. */
    virtualPath: string;
    signal?: AbortSignal;
  }): Promise<AuthorizedMemoryResultEnvelope<MemoryReadResult>>;
};

export type MemoryPluginCapability = {
  /** Declares the selected backend's authorization support even when it has no runtime. */
  authorization?: MemoryAuthorizationCapabilities;
  /** Plugin-owned pure evaluator; core verifies it before an enforced read admission. */
  authorizationConformance?: MemoryAuthorizationConformanceAdapter;
  virtualView?: MemoryPluginVirtualViewProvider;
  promptBuilder?: MemoryPromptSectionBuilder;
  flushPlanResolver?: MemoryFlushPlanResolver;
  runtime?: MemoryPluginRuntime;
  broker?: MemoryPluginBrokerEntry;
  publicArtifacts?: MemoryPluginPublicArtifactsProvider;
};

export type MemoryPluginCapabilityRegistration = {
  pluginId: string;
  capability: MemoryPluginCapability;
};

export type SessionDiscussionState = "none" | "available" | "open";
export type SessionDiscussionInfo = {
  state: SessionDiscussionState;
  embedUrl?: string;
  openUrl?: string;
};

export type SessionDiscussionProvider = {
  id: string;
  info(params: { sessionKey: string; agentId: string }): Promise<SessionDiscussionInfo>;
  open(params: { sessionKey: string; agentId: string }): Promise<SessionDiscussionInfo>;
};

export type ResolvedPluginRuntimeArtifact = { source: string; rootDir: string };
