import type { DslHydration } from "../types.js";

export interface PlannerHydrationDeps {
  createPlannerNamespace: (api: any) => any;
  getPlannerSystemPrompt: () => string;
  PlanSet: new (...args: any[]) => any;
  TaskSet: new (...args: any[]) => any;
  GoalSet: new (...args: any[]) => any;
}

export function createPlannerHydration(deps: PlannerHydrationDeps): DslHydration {
  return {
    id: "planner",
    toolName: "execute_planner_dsl",
    displayName: "Planner Copilot",
    namespaceName: "Planner",
    createNamespace: (api) => deps.createPlannerNamespace(api),
    collectionClasses: {
      PlanSet: deps.PlanSet,
      TaskSet: deps.TaskSet,
      GoalSet: deps.GoalSet,
    },
    getSystemPrompt: () => deps.getPlannerSystemPrompt(),
    maxCodeBytes: 100_000,
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 120_000,
  };
}
