import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createCodeModeTool } from "./src/tool-factory.js";
import { globalCodeModeRegistry, globalCodeModeSessionManager } from "./src/registry.js";
import { shutdown } from "./src/executor.js";
import { loadJsonHydrations } from "./src/hydration/json-loader.js";
import type { CodeModeToolInput, CodeModeToolOutput } from "./src/types.js";

type ExecuteCodeToolParams = CodeModeToolInput & {
  hydrationId?: string;
};

function createExecuteCodeModeTool(): AnyAgentTool {
  return {
    name: "execute_code",
    description:
      "Execute JavaScript code for a registered code mode hydration. Use hydrationId to choose the domain.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        hydrationId: {
          type: "string",
          description: "Registered code mode hydration id, for example m365, engage, or planner.",
        },
        code: {
          type: "string",
          description: "JavaScript code to execute against the selected code mode namespace.",
        },
        timeoutMs: {
          type: "number",
          description: "Optional execution timeout in milliseconds.",
        },
      },
      required: ["hydrationId", "code"],
    },
    async execute(toolCallId, params) {
      const startTime = Date.now();
      const input = readExecuteCodeToolParams(params);
      if ("error" in input) {
        return createFailureToolResult(input.error, "validationError", Date.now() - startTime);
      }

      const registration = globalCodeModeRegistry.get(input.hydrationId);
      if (!registration) {
        const available = globalCodeModeRegistry
          .listHydrations()
          .map((hydration) => hydration.id)
          .sort();
        return createFailureToolResult(
          `code mode hydration "${input.hydrationId}" is not registered. Available hydrations: ${available.join(", ") || "(none)"}`,
          "validationError",
          Date.now() - startTime,
        );
      }

      const tool = createCodeModeTool(registration.hydration, registration.apiAdapter);
      return await tool.execute(toolCallId, {
        code: input.code,
        timeoutMs: input.timeoutMs,
      });
    },
  };
}

function readExecuteCodeToolParams(params: unknown):
  | (Required<Pick<ExecuteCodeToolParams, "hydrationId" | "code">> & Pick<ExecuteCodeToolParams, "timeoutMs">)
  | { error: string } {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { error: "execute_code params must be an object." };
  }
  const record = params as Record<string, unknown>;
  const hydrationId = typeof record.hydrationId === "string" ? record.hydrationId.trim() : "";
  const code = typeof record.code === "string" ? record.code : "";
  const timeoutMs = typeof record.timeoutMs === "number" ? record.timeoutMs : undefined;
  if (!hydrationId) {
    return { error: "execute_code requires hydrationId." };
  }
  if (!code) {
    return { error: "execute_code requires code." };
  }
  return { hydrationId, code, timeoutMs };
}

function createFailureToolResult(
  error: string,
  errorKind: CodeModeToolOutput["errorKind"],
  durationMs: number,
) {
  const toolOutput: CodeModeToolOutput = {
    ok: false,
    consoleOutput: [],
    error,
    errorKind,
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
}

export default definePluginEntry({
  id: "tools-code-mode",
  name: "Code Mode Engine",
  description: "Generic code mode execution engine for registered domain hydrations.",
  register(api) {
    // Load JSON hydrations from workspace (sync read, lazy auth)
    try {
      const workspacePath = api.runtime.agent.resolveAgentWorkspaceDir(api.config);
      loadJsonHydrations(workspacePath, api.config);
    } catch {
      // workspace path resolution may not be available in all environments
    }

    for (const hydration of globalCodeModeRegistry.listHydrations()) {
      globalCodeModeSessionManager.register(hydration);
    }

    // Mode activation injects the hydration's system prompt into agent context.
    // This is a prompt hint only — it does NOT gate execute_code access.
    // Any registered hydration can be executed regardless of active mode.
    api.on("agent_turn_prepare", (_event, ctx) => {
      const prompt = globalCodeModeSessionManager.getActivePrompt(ctx.sessionKey);
      if (!prompt) {
        return undefined;
      }
      return {
        appendContext: prompt,
      };
    });

    api.registerTool(
      () => (globalCodeModeRegistry.list().length > 0 ? createExecuteCodeModeTool() : null),
      { name: "execute_code", optional: true },
    );

    api.on("dispose", () => {
      shutdown();
    });
  },
});
