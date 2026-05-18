import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createDslTool } from "./src/tool-factory.js";
import { globalDslEngineRegistry, globalDslModeManager } from "./src/registry.js";
import { shutdown } from "./src/executor.js";
import type { DslToolInput } from "./src/types.js";

type ExecuteDslToolParams = DslToolInput & {
  hydrationId?: string;
};

function createExecuteDslTool(): AnyAgentTool {
  return {
    name: "execute_dsl",
    description:
      "Execute JavaScript DSL code for a registered DSL hydration. Use hydrationId to choose the domain.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        hydrationId: {
          type: "string",
          description: "Registered DSL hydration id, for example m365, engage, or planner.",
        },
        code: {
          type: "string",
          description: "JavaScript code to execute against the selected DSL namespace.",
        },
        timeoutMs: {
          type: "number",
          description: "Optional execution timeout in milliseconds.",
        },
      },
      required: ["hydrationId", "code"],
    },
    async execute(toolCallId, params) {
      const input = readExecuteDslToolParams(params);
      const registration = globalDslEngineRegistry.get(input.hydrationId);
      if (!registration) {
        const available = globalDslEngineRegistry
          .listHydrations()
          .map((hydration) => hydration.id)
          .sort();
        throw new Error(
          `DSL hydration "${input.hydrationId}" is not registered. Available hydrations: ${available.join(", ") || "(none)"}`,
        );
      }

      const tool = createDslTool(registration.hydration, registration.apiAdapter);
      return await tool.execute(toolCallId, {
        code: input.code,
        timeoutMs: input.timeoutMs,
      });
    },
  };
}

function readExecuteDslToolParams(params: unknown): Required<Pick<ExecuteDslToolParams, "hydrationId" | "code">> &
  Pick<ExecuteDslToolParams, "timeoutMs"> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("execute_dsl params must be an object.");
  }
  const record = params as Record<string, unknown>;
  const hydrationId = typeof record.hydrationId === "string" ? record.hydrationId.trim() : "";
  const code = typeof record.code === "string" ? record.code : "";
  const timeoutMs = typeof record.timeoutMs === "number" ? record.timeoutMs : undefined;
  if (!hydrationId) {
    throw new Error("execute_dsl requires hydrationId.");
  }
  if (!code) {
    throw new Error("execute_dsl requires code.");
  }
  return { hydrationId, code, timeoutMs };
}

export default definePluginEntry({
  id: "tools-code-mode",
  name: "DSL Engine",
  description: "Generic DSL execution engine for registered domain hydrations.",
  register(api) {
    for (const hydration of globalDslEngineRegistry.listHydrations()) {
      globalDslModeManager.register(hydration);
    }

    // Mode activation injects the hydration's system prompt into agent context.
    // This is a prompt hint only — it does NOT gate execute_dsl access.
    // Any registered hydration can be executed regardless of active mode.
    api.on("agent_turn_prepare", (_event, ctx) => {
      const prompt = globalDslModeManager.getActivePrompt(ctx.sessionKey);
      if (!prompt) {
        return undefined;
      }
      return {
        appendContext: prompt,
      };
    });

    api.registerTool(
      () => (globalDslEngineRegistry.list().length > 0 ? createExecuteDslTool() : null),
      { name: "execute_dsl", optional: true },
    );

    api.on("dispose", () => {
      shutdown();
    });
  },
});
