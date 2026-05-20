import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createCodeModeTool } from "./src/tool-factory.js";
import { globalCodeModeRegistry, globalCodeModeSessionManager } from "./src/registry.js";
import { shutdown } from "./src/executor.js";
import type { CodeModeToolInput } from "./src/types.js";

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
      const input = readExecuteCodeToolParams(params);
      const registration = globalCodeModeRegistry.get(input.hydrationId);
      if (!registration) {
        const available = globalCodeModeRegistry
          .listHydrations()
          .map((hydration) => hydration.id)
          .sort();
        throw new Error(
          `code mode hydration "${input.hydrationId}" is not registered. Available hydrations: ${available.join(", ") || "(none)"}`,
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

function readExecuteCodeToolParams(params: unknown): Required<Pick<ExecuteCodeToolParams, "hydrationId" | "code">> &
  Pick<ExecuteCodeToolParams, "timeoutMs"> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("execute_code params must be an object.");
  }
  const record = params as Record<string, unknown>;
  const hydrationId = typeof record.hydrationId === "string" ? record.hydrationId.trim() : "";
  const code = typeof record.code === "string" ? record.code : "";
  const timeoutMs = typeof record.timeoutMs === "number" ? record.timeoutMs : undefined;
  if (!hydrationId) {
    throw new Error("execute_code requires hydrationId.");
  }
  if (!code) {
    throw new Error("execute_code requires code.");
  }
  return { hydrationId, code, timeoutMs };
}

export default definePluginEntry({
  id: "tools-code-mode",
  name: "Code Mode Engine",
  description: "Generic code mode execution engine for registered domain hydrations.",
  register(api) {
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
