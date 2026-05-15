import type { DslHydration } from "../types.js";

export interface M365HydrationDeps {
  createM365Namespace: (api: any) => any;
  getM365SystemPrompt: () => string;
  MessageSet: new (...args: any[]) => any;
  EventSet: new (...args: any[]) => any;
  ChatSet: new (...args: any[]) => any;
}

export function createM365Hydration(deps: M365HydrationDeps): DslHydration {
  return {
    id: "m365",
    toolName: "execute_m365_dsl",
    displayName: "M365 Copilot",
    namespaceName: "M365",
    createNamespace: (api) => deps.createM365Namespace(api),
    collectionClasses: {
      MessageSet: deps.MessageSet,
      EventSet: deps.EventSet,
      ChatSet: deps.ChatSet,
    },
    getSystemPrompt: () => deps.getM365SystemPrompt(),
    maxCodeBytes: 100_000,
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 120_000,
  };
}
