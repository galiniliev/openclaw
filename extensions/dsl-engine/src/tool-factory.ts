/**
 * DSL Tool Factory
 *
 * Creates OpenClaw-compatible tools from DSL hydrations.
 */

import { executeDsl } from "./executor.js";
import type { DslHydration, DslToolInput, DslToolOutput } from "./types.js";

/**
 * OpenClaw tool interface.
 */
export interface DslTool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (
    toolCallId: string,
    params: DslToolInput,
  ) => Promise<{ content: { type: string; text: string }[]; details: DslToolOutput }>;
}

/**
 * Creates an OpenClaw-compatible tool from a DSL hydration.
 * Namespace is recreated per execution to avoid stale references on token refresh.
 */
export function createDslTool<TApi, TNamespace>(
  hydration: DslHydration<TApi, TNamespace>,
  api: TApi,
  context?: any,
): DslTool {
  const validationError = hydration.validateApi?.(api);
  if (validationError) {
    throw new Error(validationError);
  }

  return {
    name: hydration.toolName,
    description: `Execute ${hydration.displayName} DSL code. Provides the ${hydration.namespaceName} namespace for scripting.`,
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The DSL code to execute",
        },
        timeoutMs: {
          type: "number",
          description: "Optional execution timeout in milliseconds",
        },
      },
      required: ["code"],
    },
    execute: async (toolCallId: string, params: DslToolInput) => {
      const startTime = Date.now();
      const namespace = hydration.createNamespace(api);
      const extraGlobals = hydration.extraGlobals?.(api, context);

      const executionResult = await executeDsl(params.code, hydration, namespace, {
        timeoutMs: params.timeoutMs,
        extraGlobals,
        toolCallId,
      });

      const durationMs = Date.now() - startTime;

      const toolOutput: DslToolOutput = {
        ok: executionResult.kind === "Succeeded",
        returnValue: executionResult.kind === "Succeeded" ? executionResult.result : undefined,
        consoleOutput: executionResult.consoleOutput,
        error: executionResult.kind === "Failed" ? executionResult.error : undefined,
        errorKind: executionResult.errorKind,
        durationMs,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(toolOutput, null, 2),
          },
        ],
        details: toolOutput,
      };
    },
  };
}
