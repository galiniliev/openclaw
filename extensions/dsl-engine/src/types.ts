/**
 * Generic DSL Engine Types
 *
 * This module defines the core abstractions for pluggable DSL hydrations.
 * Any domain (M365, Engage, Planner, or future) implements DslHydration to plug into the generic DSL engine.
 */

/**
 * Execution result — matches the shape used by all existing DSL executors.
 */
export interface DslExecutionResult {
  kind: "Succeeded" | "Failed";
  result?: unknown;
  error?: string;
  consoleOutput: string[];
}

/**
 * Input parameters for DSL tool execution.
 */
export interface DslToolInput {
  /** The DSL code to execute */
  code: string;
  /** Optional timeout in milliseconds (default: domain-specific) */
  timeoutMs?: number;
}

/**
 * Output from DSL tool execution.
 * Normalizes execution results into a tool-friendly format.
 */
export interface DslToolOutput {
  /** Whether execution succeeded without errors */
  ok: boolean;
  /** The return value if execution succeeded */
  returnValue?: unknown;
  /** Console output captured during execution */
  consoleOutput: string[];
  /** Error message if execution failed */
  error?: string;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * DSL mode state.
 * Tracks which hydration is currently active and when it was activated.
 */
export interface DslMode {
  /** Identifier of the active hydration (e.g., "m365", "engage", "planner") */
  hydrationId: string;
  /** Timestamp when the mode was activated */
  activatedAt: number;
  /** Optional domain-specific context (e.g., API connection state, session data) */
  context?: unknown;
}

/**
 * Core abstraction for a DSL hydration.
 * Each domain implements this interface to provide:
 * - API contract (tool-shaped interface)
 * - Namespace creation (fluent API builder)
 * - Code execution (worker-backed VM with timeout)
 * - System prompt (DSL reference documentation)
 *
 * @template TApi - The API interface that this hydration requires (e.g., M365Api)
 * @template TNamespace - The namespace object returned by createNamespace (e.g., M365Namespace)
 */
export interface DslHydration<TApi = unknown, TNamespace = unknown> {
  /** Unique identifier (e.g., "m365", "engage", "planner"). */
  readonly id: string;

  /** OpenClaw tool name (e.g., "execute_m365_dsl"). */
  readonly toolName: string;

  /** Human-readable display name (e.g., "M365 Copilot"). */
  readonly displayName: string;

  /**
   * Variable name injected into generated code scope.
   * E.g., "M365" means code calls `M365.messages.list()`.
   */
  readonly namespaceName: string;

  /** Factory: given an API adapter, return the namespace object. */
  createNamespace(api: TApi): TNamespace;

  /**
   * Collection classes injected into scope (e.g., MessageSet, EventSet).
   * Keys are variable names available in generated code.
   */
  readonly collectionClasses: Record<string, new (...args: unknown[]) => unknown>;

  /** Returns system prompt with DSL reference, examples, gotchas. */
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
 * Factory function type for creating a hydration.
 */
export type DslHydrationFactory<TApi = unknown, TNamespace = unknown> = () => DslHydration<TApi, TNamespace>;
