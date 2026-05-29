/**
 * Generic Code Mode Engine Types
 *
 * Core abstractions for pluggable code-mode namespaces. Any domain
 * (M365, Engage, Planner, future) implements CodeModeNamespace to plug
 * into the generic code mode engine. A single `execute_code` tool-call
 * can compose multiple registered namespaces — see `namespaceIds` on
 * the tool input.
 */

/**
 * Execution result — matches the shape used by all existing code mode executors.
 */
export interface CodeModeExecutionResult {
  kind: "Succeeded" | "Failed";
  result?: unknown;
  error?: string;
  errorKind?: import("./errors.js").CodeModeErrorKind;
  consoleOutput: string[];
}

/**
 * Input parameters for code mode tool execution.
 */
export interface CodeModeToolInput {
  /** Registered namespace ids to compose into the sandbox (e.g. ["m365"] or ["m365","outlook"]). */
  namespaceIds: string[];
  /** The code to execute */
  code: string;
  /** Optional timeout in milliseconds (default: domain-specific) */
  timeoutMs?: number;
}

/**
 * Output from code mode tool execution.
 * Normalizes execution results into a tool-friendly format.
 */
export interface CodeModeToolOutput {
  /** Whether execution succeeded without errors */
  ok: boolean;
  /** The return value if execution succeeded */
  returnValue?: unknown;
  /** Console output captured during execution */
  consoleOutput: string[];
  /** Error message if execution failed */
  error?: string;
  /** Typed error classification for programmatic handling */
  errorKind?: import("./errors.js").CodeModeErrorKind;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Code mode session state.
 * Tracks which namespace is currently active (single-namespace identity
 * inside the engine; multi-namespace composition happens per-call via
 * `CodeModeToolInput.namespaceIds`).
 */
export interface CodeModeSession {
  /** Identifier of the active namespace (e.g., "m365", "engage", "planner") */
  namespaceId: string;
  /** Timestamp when the mode was activated */
  activatedAt: number;
  /** Optional domain-specific context (e.g., API connection state, session data) */
  context?: unknown;
}

/**
 * Core abstraction for a code mode namespace.
 * Each domain implements this interface to provide:
 * - API contract (tool-shaped interface)
 * - Namespace creation (fluent API builder)
 * - Code execution (worker-backed VM with timeout)
 * - System prompt (code mode reference documentation)
 *
 * @template TApi - The API interface that this namespace requires (e.g., M365Api)
 * @template TNamespace - The namespace object returned by createNamespace (e.g., M365Namespace)
 */
export interface CodeModeNamespace<TApi = unknown, TNamespace = unknown> {
  /** Unique identifier (e.g., "m365", "engage", "planner"). */
  readonly id: string;

  /** OpenClaw tool name (e.g., "execute_m365_code"). Reserved for per-namespace tools; the generic `execute_code` ignores this. */
  readonly toolName: string;

  /** Human-readable display name (e.g., "M365 Copilot"). */
  readonly displayName: string;

  /**
   * Variable name injected into generated code scope.
   * E.g., "M365" means code calls `M365.messages.list()`. Two registered
   * namespaces sharing the same namespaceName will be rejected at
   * registration time (collision).
   */
  readonly namespaceName: string;

  /** Factory: given an API adapter, return the namespace object. */
  createNamespace(api: TApi): TNamespace;

  /**
   * Collection classes injected into scope (e.g., MessageSet, EventSet).
   * Keys are variable names available in generated code.
   */
  readonly collectionClasses: Record<string, new (...args: unknown[]) => unknown>;

  /** Returns system prompt with code mode reference, examples, gotchas. */
  getSystemPrompt(context?: unknown): string;

  /** Max code size in bytes (default 100KB). */
  readonly maxCodeBytes?: number;

  /** Default execution timeout in ms (default 30s). */
  readonly defaultTimeoutMs?: number;

  /** Max allowed timeout in ms (default 120s). */
  readonly maxTimeoutMs?: number;

  /** Optional additional globals to inject into the executor scope. */
  extraGlobals?(api: TApi, context?: unknown): Record<string, unknown>;

  /** Optional API validation before execution. */
  validateApi?(api: TApi): string | undefined;
}

/**
 * Factory function type for creating a namespace.
 */
export type CodeModeNamespaceFactory<TApi = unknown, TNamespace = unknown> = () => CodeModeNamespace<TApi, TNamespace>;
