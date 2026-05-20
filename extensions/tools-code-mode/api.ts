export type {
  CodeModeExecutionResult,
  CodeModeHydration,
  CodeModeHydrationFactory,
  CodeModeSession,
  CodeModeToolInput,
  CodeModeToolOutput,
} from "./src/types.js";
export { CodeModeError, type CodeModeErrorKind } from "./src/errors.js";
export { CodeModeSessionManager } from "./src/mode-manager.js";
export { shutdown as shutdownCodeMode } from "./src/executor.js";
export {
  CodeModeRegistry,
  globalCodeModeRegistry,
  globalCodeModeSessionManager,
  type CodeModeHydrationRegistration,
} from "./src/registry.js";

import type { CodeModeHydration } from "./src/types.js";
import { globalCodeModeRegistry, globalCodeModeSessionManager } from "./src/registry.js";

export function registerCodeModeHydration<TApi, TNamespace>(
  hydration: CodeModeHydration<TApi, TNamespace>,
  apiAdapter: TApi,
): void {
  globalCodeModeRegistry.register(hydration, apiAdapter);
  globalCodeModeSessionManager.register(hydration as CodeModeHydration);
}

export function unregisterCodeModeHydration(hydrationId: string): boolean {
  globalCodeModeSessionManager.unregister(hydrationId);
  return globalCodeModeRegistry.unregister(hydrationId);
}

export function activateCodeModeSession(
  hydrationId: string,
  context?: unknown,
  sessionKey?: string,
): void {
  globalCodeModeSessionManager.activate(hydrationId, context, sessionKey);
}

export function deactivateCodeModeSession(sessionKey?: string): void {
  globalCodeModeSessionManager.deactivate(sessionKey);
}
