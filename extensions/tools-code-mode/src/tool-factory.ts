/**
 * Code Mode Tool Factory
 *
 * Creates OpenClaw-compatible tools from code mode hydrations.
 */

import { executeCodeMode } from "./executor.js";
import type { CodeModeHydration, CodeModeToolInput, CodeModeToolOutput } from "./types.js";

/**
 * OpenClaw tool interface.
 */
export interface CodeModeTool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (
    toolCallId: string,
    params: CodeModeToolInput,
  ) => Promise<{ content: { type: string; text: string }[]; details: CodeModeToolOutput }>;
}

/**
 * Creates an OpenClaw-compatible tool from a code mode hydration.
 * Namespace is recreated per execution to avoid stale references on token refresh.
 */
export function createCodeModeTool<TApi, TNamespace>(
  hydration: CodeModeHydration<TApi, TNamespace>,
  api: TApi,
  context?: any,
): CodeModeTool {
  const validationError = hydration.validateApi?.(api);
  if (validationError) {
    throw new Error(validationError);
  }

  return {
    name: hydration.toolName,
    description: `Execute ${hydration.displayName} code. Provides the ${hydration.namespaceName} namespace for scripting.`,
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The code to execute",
        },
        timeoutMs: {
          type: "number",
          description: "Optional execution timeout in milliseconds",
        },
      },
      required: ["code"],
    },
    execute: async (toolCallId: string, params: CodeModeToolInput) => {
      const startTime = Date.now();
      const namespace = hydration.createNamespace(api);
      const extraGlobals = hydration.extraGlobals?.(api, context);

      const executionResult = await executeCodeMode(params.code, hydration, namespace, {
        timeoutMs: params.timeoutMs,
        extraGlobals,
        toolCallId,
      });

      const durationMs = Date.now() - startTime;

      const toolOutput: CodeModeToolOutput = {
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
