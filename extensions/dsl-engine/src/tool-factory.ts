/**
 * DSL Tool Factory
 *
 * Creates OpenClaw-compatible tools from DSL hydrations.
 */

import { executeDsl } from "./executor.js";
import type { DslHydration, DslToolInput, DslToolOutput } from "./types.js";

/**
 * OpenClaw tool interface.
 * Tools have a name, description, parameters schema, and execute function.
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
 *
 * The tool wraps the DSL executor and provides:
 * - Automatic namespace creation from the API
 * - Optional extra globals injection
 * - Timing measurement
 * - Result normalization (DslExecutionResult -> DslToolOutput)
 *
 * @param hydration - The DSL hydration configuration
 * @param api - The API implementation to inject into the namespace
 * @param context - Optional context for extra globals
 * @returns An OpenClaw tool that executes DSL code
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

  // Create the namespace once when the tool is created
  const namespace = hydration.createNamespace(api);

  // Build extra globals if the hydration provides them
  const extraGlobals = hydration.extraGlobals?.(api, context);

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

      // Execute the DSL code
      const executionResult = await executeDsl(params.code, hydration, namespace, {
        timeoutMs: params.timeoutMs,
        extraGlobals,
      });

      const durationMs = Date.now() - startTime;

      // Normalize execution result to tool output format
      const toolOutput: DslToolOutput = {
        ok: executionResult.kind === "Succeeded",
        returnValue: executionResult.kind === "Succeeded" ? executionResult.result : undefined,
        consoleOutput: executionResult.consoleOutput,
        error: executionResult.kind === "Failed" ? executionResult.error : undefined,
        durationMs,
      };

      // Return OpenClaw tool result format
      // Content contains JSON-stringified payload, details contains structured data
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
