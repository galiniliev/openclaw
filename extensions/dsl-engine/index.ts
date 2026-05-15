import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createDslTool } from "./src/tool-factory.js";
import { DslModeManager } from "./src/mode-manager.js";
import type { DslHydration } from "./src/types.js";

/**
 * Registry for API adapters keyed by hydration ID.
 * External plugins register their API implementations here.
 */
const apiRegistry = new Map<string, any>();

/**
 * DSL Engine Plugin Entry Point
 *
 * This plugin provides a generic DSL execution framework that can be hydrated
 * with domain-specific implementations (M365, Engage, Planner, custom).
 *
 * The plugin exports:
 * - A mode manager service for registering hydrations externally
 * - Pre-registered tool stubs that resolve hydrations at execution time
 *
 * External plugins (like agent-tools) register their hydrations and APIs at runtime
 * via the exposed service API. Tools are registered eagerly but resolve dependencies
 * lazily at execution time.
 */
export default definePluginEntry({
  id: "dsl-engine",
  name: "DSL Engine",
  description: "Generic DSL execution engine — registers code-mode tools for M365, Engage, Planner, and custom domains",
  register(api) {
    // Initialize the mode manager with an empty hydration list
    // Hydrations will be registered dynamically by external plugins
    const modeManager = new DslModeManager([]);

    // Expose the mode manager and registration API as a service
    api.registerService({
      id: "dsl-engine",
      getInstance: () => ({
        modeManager,
        /**
         * Register a DSL hydration with its API implementation.
         * @param hydration - The hydration configuration
         * @param apiAdapter - The API implementation for this hydration
         */
        registerHydration: (hydration: DslHydration, apiAdapter: any) => {
          modeManager.register(hydration);
          apiRegistry.set(hydration.id, apiAdapter);
        },
      }),
    });

    // Helper to create a lazy tool that resolves hydration at execution time
    const createLazyDslTool = (hydrationId: string, toolName: string): AnyAgentTool => ({
      name: toolName,
      description: `Execute ${hydrationId} DSL code. Tool will be available once the ${hydrationId} hydration is registered.`,
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
      async execute(toolCallId, params, signal, onUpdate) {
        // Resolve hydration at execution time
        const hydrations = modeManager.listAvailable();
        const hydration = hydrations.find((h) => h.id === hydrationId);

        if (!hydration) {
          throw new Error(
            `DSL hydration "${hydrationId}" not registered. Available hydrations: ${hydrations.map((h) => h.id).join(", ")}`,
          );
        }

        const apiAdapter = apiRegistry.get(hydrationId);
        if (!apiAdapter) {
          throw new Error(`API adapter for "${hydrationId}" not registered.`);
        }

        // Create the actual tool and delegate execution
        const actualTool = createDslTool(hydration, apiAdapter);
        return actualTool.execute(toolCallId, params);
      },
    });

    // Pre-register tool stubs for the expected hydrations
    // These will resolve to actual tools when hydrations are registered
    api.registerTool(createLazyDslTool("m365", "execute_m365_dsl"));
    api.registerTool(createLazyDslTool("engage", "execute_engage_dsl"));
    api.registerTool(createLazyDslTool("planner", "execute_planner_dsl"));
  },
});
