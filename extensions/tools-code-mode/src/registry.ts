import type { CodeModeNamespace } from "./types.js";
import { CodeModeSessionManager } from "./mode-manager.js";

export type CodeModeNamespaceRegistration<TApi = unknown, TNamespace = unknown> = {
  namespace: CodeModeNamespace<TApi, TNamespace>;
  apiAdapter: TApi;
};

export class CodeModeRegistry {
  private readonly registrations = new Map<string, CodeModeNamespaceRegistration>();

  register<TApi, TNamespace>(
    namespace: CodeModeNamespace<TApi, TNamespace>,
    apiAdapter: TApi,
  ): void {
    const existing = this.registrations.get(namespace.id);
    if (existing && existing.namespace !== namespace) {
      throw new Error(
        `CodeModeRegistry: namespace id "${namespace.id}" already registered with a different implementation`,
      );
    }
    // Reject namespaceName collisions across distinct ids — combined sandbox
    // scope would shadow one of them silently otherwise.
    for (const [otherId, entry] of this.registrations) {
      if (otherId !== namespace.id && entry.namespace.namespaceName === namespace.namespaceName) {
        throw new Error(
          `CodeModeRegistry: namespaceName "${namespace.namespaceName}" collides between "${otherId}" and "${namespace.id}"`,
        );
      }
    }
    this.registrations.set(namespace.id, {
      namespace: namespace as CodeModeNamespace,
      apiAdapter,
    });
  }

  unregister(namespaceId: string): boolean {
    return this.registrations.delete(namespaceId);
  }

  get(namespaceId: string): CodeModeNamespaceRegistration | undefined {
    return this.registrations.get(namespaceId);
  }

  list(): CodeModeNamespaceRegistration[] {
    return Array.from(this.registrations.values());
  }

  listNamespaces(): CodeModeNamespace[] {
    return this.list().map((entry) => entry.namespace);
  }
}

export const globalCodeModeRegistry = new CodeModeRegistry();
export const globalCodeModeSessionManager = new CodeModeSessionManager([]);
