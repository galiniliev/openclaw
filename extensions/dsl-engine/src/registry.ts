import type { DslHydration } from "./types.js";
import { DslModeManager } from "./mode-manager.js";

export type DslHydrationRegistration<TApi = unknown, TNamespace = unknown> = {
  hydration: DslHydration<TApi, TNamespace>;
  apiAdapter: TApi;
};

export class DslEngineRegistry {
  private readonly registrations = new Map<string, DslHydrationRegistration>();

  register<TApi, TNamespace>(
    hydration: DslHydration<TApi, TNamespace>,
    apiAdapter: TApi,
  ): void {
    this.registrations.set(hydration.id, {
      hydration: hydration as DslHydration,
      apiAdapter,
    });
  }

  unregister(hydrationId: string): boolean {
    return this.registrations.delete(hydrationId);
  }

  get(hydrationId: string): DslHydrationRegistration | undefined {
    return this.registrations.get(hydrationId);
  }

  list(): DslHydrationRegistration[] {
    return Array.from(this.registrations.values());
  }

  listHydrations(): DslHydration[] {
    return this.list().map((entry) => entry.hydration);
  }
}

export const globalDslEngineRegistry = new DslEngineRegistry();
export const globalDslModeManager = new DslModeManager([]);
