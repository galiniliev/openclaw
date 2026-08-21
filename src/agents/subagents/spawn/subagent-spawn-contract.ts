import type { FastMode } from "../../../shared/fast-mode.js";
import type {
  SpawnSubagentContextMode,
  SpawnSubagentMode,
  SpawnSubagentSandboxMode,
} from "./subagent-spawn.types.js";

export type SpawnSubagentParams = {
  task: string;
  label?: string;
  agentId?: string;
  model?: string;
  taskName?: string;
  thinking?: string;
  fastMode?: FastMode;
  collect?: boolean;
  outputSchema?: Record<string, unknown>;
  groupId?: string;
  /** Host bridge identity used to recover a replay-safe collector launch. */
  swarmLaunchReplayKey?: string;
  /** Canonical request hash checked before reusing a host-reserved collector. */
  swarmLaunchRequestFingerprint?: string;
  cwd?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode?: SpawnSubagentMode;
  cleanup?: "delete" | "keep";
  sandbox?: SpawnSubagentSandboxMode;
  context?: SpawnSubagentContextMode;
  lightContext?: boolean;
  expectsCompletionMessage?: boolean;
  attachments?: Array<{
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
    mimeType?: string;
  }>;
  attachMountPath?: string;
};

/**
 * Core-private lease for one child session generation. It is never serialized
 * into a launch request, surfaced in the tool schema, or exposed to the model.
 */
export type SpawnSubagentMemoryChildDelegationLease = Readonly<{
  activate(): Promise<boolean>;
  revoke(): Promise<void>;
}>;

/**
 * The spawn owner supplies this after admitting the parent's memory view. The
 * native spawner supplies the exact persisted `spawned_by` key, not task text
 * or a completion-routing key, when it asks for the child lease.
 */
export type SpawnSubagentMemoryChildDelegationIssuer = (params: Readonly<{
  parentSessionKey: string;
  childSessionKey: string;
  childSessionId: string;
  childSessionIdentityRevision: string;
  expiresAt: number;
}>) => Promise<SpawnSubagentMemoryChildDelegationLease | undefined>;

export type SpawnSubagentContext = {
  agentSessionKey?: string;
  requesterTurnRunId?: string;
  /** Separate key used only for completion routing, not sandbox policy. */
  completionOwnerKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentMessageId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  agentMemberRoleIds?: string[];
  requesterAgentIdOverride?: string;
  /** Explicit workspace directory for subagent to inherit (optional). */
  workspaceDir?: string;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
  requesterRunId?: string;
  /** Core-private child-memory issuer; never forwarded to tool input or Gateway payloads. */
  issueMemoryChildDelegation?: SpawnSubagentMemoryChildDelegationIssuer;
};

export type SpawnSubagentResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  sessionKey?: string;
  runId?: string;
  mode?: SpawnSubagentMode;
  taskName?: string;
  note?: string;
  /** Fully resolved model ref applied to the spawned child session. */
  resolvedModel?: string;
  /** Provider prefix parsed from resolvedModel when the ref includes one. */
  resolvedProvider?: string;
  modelApplied?: boolean;
  error?: string;
  attachments?: {
    count: number;
    totalBytes: number;
    files: Array<{ name: string; bytes: number; sha256: string }>;
    relDir: string;
  };
};
