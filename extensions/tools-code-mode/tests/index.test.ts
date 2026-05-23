import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import type { CodeModeHydration } from "../src/types.js";
import {
  activateCodeModeSession,
  registerCodeModeHydration,
  unregisterCodeModeHydration,
} from "../api.js";

const hydration: CodeModeHydration<{ greet(name: string): string }, { greet(name: string): string }> = {
  id: "test",
  toolName: "execute_test_code",
  displayName: "Test Code Mode",
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
    unregisterCodeModeHydration("test");
  });

  it("does not expose execute_code until a hydration is registered", () => {
    const { api, toolFactories } = createApi();
    plugin.register(api as never);

    expect(api.registerTool).toHaveBeenCalledWith(expect.any(Function), {
      name: "execute_code",
      optional: true,
    });
    const factory = toolFactories[0] as () => unknown;
    expect(factory()).toBeNull();
  });

  it("executes registered hydrations through the generic tool", async () => {
    const { api, toolFactories } = createApi();
    plugin.register(api as never);
    registerCodeModeHydration(hydration, {
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

  it("returns structured validation errors for unknown hydrations", async () => {
    const { api, toolFactories } = createApi();
    plugin.register(api as never);
    registerCodeModeHydration(hydration, {
      greet: (name: string) => `Hello, ${name}!`,
    });

    const tool = (toolFactories[0] as () => any)();
    const result = await tool.execute("call-1", {
      hydrationId: "unknown",
      code: "return 1;",
    });

    expect(result.details.ok).toBe(false);
    expect(result.details.errorKind).toBe("validationError");
    expect(result.details.error).toContain('code mode hydration "unknown" is not registered');
    expect(result.content[0].text).toContain("Available hydrations: test");
  });

  it("returns structured validation errors for malformed execute_code params", async () => {
    const { api, toolFactories } = createApi();
    plugin.register(api as never);
    registerCodeModeHydration(hydration, {
      greet: (name: string) => `Hello, ${name}!`,
    });

    const tool = (toolFactories[0] as () => any)();
    const result = await tool.execute("call-1", {
      hydrationId: "",
      code: "return 1;",
    });

    expect(result.details.ok).toBe(false);
    expect(result.details.errorKind).toBe("validationError");
    expect(result.details.error).toBe("execute_code requires hydrationId.");
  });

  it("adds the active session prompt during agent turn preparation", () => {
    const { api, hooks } = createApi();
    plugin.register(api as never);
    registerCodeModeHydration(hydration, {});
    activateCodeModeSession("test", undefined, "agent:test");

    const hook = hooks.find((entry) => entry.name === "agent_turn_prepare");
    expect(hook?.handler({}, { sessionKey: "agent:test" })).toEqual({
      appendContext: "Use Test.greet(name).",
    });
    expect(hook?.handler({}, { sessionKey: "agent:other" })).toBeUndefined();
  });
});
