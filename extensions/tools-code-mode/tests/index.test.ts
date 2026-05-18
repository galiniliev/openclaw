import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import type { DslHydration } from "../src/types.js";
import {
  activateDslMode,
  registerDslHydration,
  unregisterDslHydration,
} from "../api.js";

const hydration: DslHydration<{ greet(name: string): string }, { greet(name: string): string }> = {
  id: "test",
  toolName: "execute_test_dsl",
  displayName: "Test DSL",
  namespaceName: "Test",
  createNamespace: (api) => ({
    greet: api.greet,
  }),
  collectionClasses: {},
  getSystemPrompt: () => "Use Test.greet(name).",
};

function createApi() {
  const toolFactories: unknown[] = [];
  const hooks: Array<{ name: string; handler: Function }> = [];
  const api = {
    registerTool: vi.fn((factory: unknown) => toolFactories.push(factory)),
    on: vi.fn((name: string, handler: Function) => hooks.push({ name, handler })),
  };
  return { api, toolFactories, hooks };
}

describe("tools-code-mode plugin entry", () => {
  beforeEach(() => {
    unregisterDslHydration("test");
  });

  it("does not expose execute_dsl until a hydration is registered", () => {
    const { api, toolFactories } = createApi();
    plugin.register(api as never);

    expect(api.registerTool).toHaveBeenCalledWith(expect.any(Function), {
      name: "execute_dsl",
      optional: true,
    });
    const factory = toolFactories[0] as () => unknown;
    expect(factory()).toBeNull();
  });

  it("executes registered hydrations through the generic tool", async () => {
    const { api, toolFactories } = createApi();
    plugin.register(api as never);
    registerDslHydration(hydration, {
      greet: (name: string) => `Hello, ${name}!`,
    });

    const tool = (toolFactories[0] as () => any)();
    const result = await tool.execute("call-1", {
      hydrationId: "test",
      code: 'return await Test.greet("World");',
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.returnValue).toBe("Hello, World!");
  });

  it("adds the active session prompt during agent turn preparation", () => {
    const { api, hooks } = createApi();
    plugin.register(api as never);
    registerDslHydration(hydration, {});
    activateDslMode("test", undefined, "agent:test");

    const hook = hooks.find((entry) => entry.name === "agent_turn_prepare");
    expect(hook?.handler({}, { sessionKey: "agent:test" })).toEqual({
      appendContext: "Use Test.greet(name).",
    });
    expect(hook?.handler({}, { sessionKey: "agent:other" })).toBeUndefined();
  });
});
