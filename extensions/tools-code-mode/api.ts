export type {
  CodeModeExecutionResult,
  CodeModeNamespace,
  CodeModeNamespaceFactory,
  CodeModeSession,
  CodeModeToolInput,
  CodeModeToolOutput,
} from "./src/types.js";
export { CodeModeError, type CodeModeErrorKind } from "./src/errors.js";
export { CodeModeSessionManager } from "./src/mode-manager.js";
export { shutdown as shutdownCodeMode, type NamespaceBinding } from "./src/executor.js";
export {
  CodeModeRegistry,
  globalCodeModeRegistry,
  globalCodeModeSessionManager,
  type CodeModeNamespaceRegistration,
} from "./src/registry.js";

import type { CodeModeNamespace } from "./src/types.js";
import { globalCodeModeRegistry, globalCodeModeSessionManager } from "./src/registry.js";

export function registerCodeModeNamespace<TApi, TNamespace>(
  ns: CodeModeNamespace<TApi, TNamespace>,
  apiAdapter: TApi,
): void {
  globalCodeModeRegistry.register(ns, apiAdapter);
  globalCodeModeSessionManager.register(ns as CodeModeNamespace);
}

export function unregisterCodeModeNamespace(namespaceId: string): boolean {
  globalCodeModeSessionManager.unregister(namespaceId);
  return globalCodeModeRegistry.unregister(namespaceId);
}

export function activateCodeModeSession(
  namespaceId: string,
  context?: unknown,
  sessionKey?: string,
): void {
  globalCodeModeSessionManager.activate(namespaceId, context, sessionKey);
}

export function deactivateCodeModeSession(sessionKey?: string): void {
  globalCodeModeSessionManager.deactivate(sessionKey);
}
