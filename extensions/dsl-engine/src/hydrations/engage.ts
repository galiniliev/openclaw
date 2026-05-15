import type { DslHydration } from "../types.js";

export interface EngageHydrationDeps {
  createEngageNamespace: (api: any) => any;
  getEngageSystemPrompt: () => string;
  ThreadSet: new (...args: any[]) => any;
  CommunitySet: new (...args: any[]) => any;
  EngageUserSet: new (...args: any[]) => any;
  EngageEventSet: new (...args: any[]) => any;
}

export function createEngageHydration(deps: EngageHydrationDeps): DslHydration {
  return {
    id: "engage",
    toolName: "execute_engage_dsl",
    displayName: "Viva Engage Copilot",
    namespaceName: "Engage",
    createNamespace: (api) => deps.createEngageNamespace(api),
    collectionClasses: {
      ThreadSet: deps.ThreadSet,
      CommunitySet: deps.CommunitySet,
      EngageUserSet: deps.EngageUserSet,
      EngageEventSet: deps.EngageEventSet,
    },
    getSystemPrompt: () => deps.getEngageSystemPrompt(),
    maxCodeBytes: 100_000,
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 120_000,
  };
}
