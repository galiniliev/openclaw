/**
 * Code Mode Tool Factory
 *
 * Creates OpenClaw-compatible per-namespace tools from a single namespace.
 * The generic multi-namespace `execute_code` tool lives in
 * `extensions/tools-code-mode/index.ts`; this factory is retained for
 * domain plugins that want to expose a dedicated `execute_<domain>_code`
 * tool name alongside the generic one.
 */

import { executeCodeMode } from "./executor.js";
import type { CodeModeNamespace, CodeModeToolInput, CodeModeToolOutput } from "./types.js";

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
 * Creates an OpenClaw-compatible tool from a code mode namespace.
 * Scope is recreated per execution to avoid stale references on token refresh.
 */
export function createCodeModeTool<TApi, TNamespace>(
  ns: CodeModeNamespace<TApi, TNamespace>,
  api: TApi,
  context?: any,
): CodeModeTool {
  const validationError = ns.validateApi?.(api);
  if (validationError) {
    throw new Error(validationError);
  }

  return {
    name: ns.toolName,
    description: `Execute ${ns.displayName} code. Provides the ${ns.namespaceName} namespace for scripting.`,
    parameters: {
      type: "object",
      properties: {
        namespaceIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: `Namespace ids to bind. Defaults to ["${ns.id}"] when omitted.`,
        },
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
      const scope = ns.createNamespace(api);
      const extraGlobals = ns.extraGlobals?.(api, context);

      const executionResult = await executeCodeMode(
        params.code,
        [{ namespace: ns, scope }],
        {
          timeoutMs: params.timeoutMs,
          extraGlobals,
          toolCallId,
        },
      );

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
