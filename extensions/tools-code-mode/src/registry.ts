import type { CodeModeHydration } from "./types.js";
import { CodeModeSessionManager } from "./mode-manager.js";

export type CodeModeHydrationRegistration<TApi = unknown, TNamespace = unknown> = {
  hydration: CodeModeHydration<TApi, TNamespace>;
  apiAdapter: TApi;
};

export class CodeModeRegistry {
  private readonly registrations = new Map<string, CodeModeHydrationRegistration>();

  register<TApi, TNamespace>(
    hydration: CodeModeHydration<TApi, TNamespace>,
    apiAdapter: TApi,
  ): void {
    this.registrations.set(hydration.id, {
      hydration: hydration as CodeModeHydration,
      apiAdapter,
    });
  }

  unregister(hydrationId: string): boolean {
    return this.registrations.delete(hydrationId);
  }

  get(hydrationId: string): CodeModeHydrationRegistration | undefined {
    return this.registrations.get(hydrationId);
  }

  list(): CodeModeHydrationRegistration[] {
    return Array.from(this.registrations.values());
  }

  listHydrations(): CodeModeHydration[] {
    return this.list().map((entry) => entry.hydration);
  }
}

export const globalCodeModeRegistry = new CodeModeRegistry();
export const globalCodeModeSessionManager = new CodeModeSessionManager([]);
