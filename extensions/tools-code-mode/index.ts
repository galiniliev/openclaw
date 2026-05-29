import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { executeCodeMode, type NamespaceBinding } from "./src/executor.js";
import { globalCodeModeRegistry, globalCodeModeSessionManager } from "./src/registry.js";
import { shutdown } from "./src/executor.js";
import { loadJsonHydrations } from "./src/hydration/json-loader.js";
import type { CodeModeToolOutput } from "./src/types.js";

function createExecuteCodeModeTool(): AnyAgentTool {
  return {
    name: "execute_code",
    description:
      "Execute JavaScript code composed of one or more registered code mode namespaces. Pass namespaceIds: [\"m365\"] for a single namespace, or [\"m365\",\"outlook\"] to combine multiple namespaces in the same sandbox.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        namespaceIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Registered code mode namespace ids, e.g. [\"m365\"] or [\"m365\",\"outlook\"]. All listed namespaces are bound into the same sandbox.",
        },
        code: {
          type: "string",
          description: "JavaScript code to execute against the composed namespaces.",
        },
        timeoutMs: {
          type: "number",
          description: "Optional execution timeout in milliseconds.",
        },
      },
      required: ["namespaceIds", "code"],
    },
    async execute(toolCallId, params) {
      const startTime = Date.now();
      const input = readExecuteCodeToolParams(params);
      if ("error" in input) {
        return createFailureToolResult(input.error, "validationError", Date.now() - startTime);
      }

      const bindings: NamespaceBinding[] = [];
      const seen = new Set<string>();
      for (const id of input.namespaceIds) {
        if (seen.has(id)) {
          return createFailureToolResult(
            `execute_code received duplicate namespaceId "${id}".`,
            "validationError",
            Date.now() - startTime,
          );
        }
        seen.add(id);
        const registration = globalCodeModeRegistry.get(id);
        if (!registration) {
          const available = globalCodeModeRegistry
            .listNamespaces()
            .map((ns) => ns.id)
            .sort();
          return createFailureToolResult(
            `code mode namespace "${id}" is not registered. Available namespaces: ${available.join(", ") || "(none)"}`,
            "validationError",
            Date.now() - startTime,
          );
        }
        const validationError = registration.namespace.validateApi?.(registration.apiAdapter);
        if (validationError) {
          return createFailureToolResult(validationError, "validationError", Date.now() - startTime);
        }
        bindings.push({
          namespace: registration.namespace,
          scope: registration.namespace.createNamespace(registration.apiAdapter),
        });
      }

      // Compose extraGlobals from all namespaces; later namespaces override
      // earlier on key collisions. Document this in README if anyone trips on it.
      const composedExtraGlobals: Record<string, unknown> = {};
      for (const b of bindings) {
        const extras = b.namespace.extraGlobals?.(
          (globalCodeModeRegistry.get(b.namespace.id) as { apiAdapter: unknown }).apiAdapter,
        );
        if (extras && typeof extras === "object") {
          Object.assign(composedExtraGlobals, extras);
        }
      }

      const executionResult = await executeCodeMode(input.code, bindings, {
        timeoutMs: input.timeoutMs,
        extraGlobals: composedExtraGlobals,
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
        content: [{ type: "text", text: JSON.stringify(toolOutput, null, 2) }],
        details: toolOutput,
      };
    },
  };
}

function readExecuteCodeToolParams(params: unknown):
  | { namespaceIds: string[]; code: string; timeoutMs?: number }
  | { error: string } {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { error: "execute_code params must be an object." };
  }
  const record = params as Record<string, unknown>;
  const rawIds = record.namespaceIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return { error: "execute_code requires namespaceIds: a non-empty array of namespace ids." };
  }
  const namespaceIds: string[] = [];
  for (const v of rawIds) {
    if (typeof v !== "string" || !v.trim()) {
      return { error: "execute_code namespaceIds entries must be non-empty strings." };
    }
    namespaceIds.push(v.trim());
  }
  const code = typeof record.code === "string" ? record.code : "";
  if (!code) {
    return { error: "execute_code requires code." };
  }
  const timeoutMs = typeof record.timeoutMs === "number" ? record.timeoutMs : undefined;
  return { namespaceIds, code, timeoutMs };
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
    content: [{ type: "text", text: JSON.stringify(toolOutput, null, 2) }],
    details: toolOutput,
  };
}

export default definePluginEntry({
  id: "tools-code-mode",
  name: "Code Mode Engine",
  description: "Generic code mode execution engine for registered domain namespaces.",
  register(api) {
    // Load JSON namespaces from workspace (sync read, lazy auth)
    try {
      const workspacePath = api.runtime.agent.resolveAgentWorkspaceDir(api.config);
      loadJsonHydrations(workspacePath, api.config);
    } catch {
      // workspace path resolution may not be available in all environments
    }

    for (const ns of globalCodeModeRegistry.listNamespaces()) {
      globalCodeModeSessionManager.register(ns);
    }

    // Mode activation injects the active namespace's system prompt into agent
    // context. This is a prompt hint only — it does NOT gate execute_code
    // access. Any registered namespace can be executed regardless of active
    // mode.
    api.on("agent_turn_prepare", (_event, ctx) => {
      const prompt = globalCodeModeSessionManager.getActivePrompt(ctx.sessionKey);
      if (!prompt) {
        return undefined;
      }
      return { appendContext: prompt };
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
