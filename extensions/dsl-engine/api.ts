export type {
  DslExecutionResult,
  DslHydration,
  DslHydrationFactory,
  DslMode,
  DslToolInput,
  DslToolOutput,
} from "./src/types.js";
export { DslModeManager } from "./src/mode-manager.js";
export {
  DslEngineRegistry,
  globalDslEngineRegistry,
  globalDslModeManager,
  type DslHydrationRegistration,
} from "./src/registry.js";

import type { DslHydration } from "./src/types.js";
import { globalDslEngineRegistry, globalDslModeManager } from "./src/registry.js";

export function registerDslHydration<TApi, TNamespace>(
  hydration: DslHydration<TApi, TNamespace>,
  apiAdapter: TApi,
): void {
  globalDslEngineRegistry.register(hydration, apiAdapter);
  globalDslModeManager.register(hydration as DslHydration);
}

export function unregisterDslHydration(hydrationId: string): boolean {
  globalDslModeManager.unregister(hydrationId);
  return globalDslEngineRegistry.unregister(hydrationId);
}

export function activateDslMode(
  hydrationId: string,
  context?: unknown,
  sessionKey?: string,
): void {
  globalDslModeManager.activate(hydrationId, context, sessionKey);
}

export function deactivateDslMode(sessionKey?: string): void {
  globalDslModeManager.deactivate(sessionKey);
}
