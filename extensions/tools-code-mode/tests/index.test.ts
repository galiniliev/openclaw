import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import type { CodeModeNamespace } from "../src/types.js";
import {
  activateCodeModeSession,
  registerCodeModeNamespace,
  unregisterCodeModeNamespace,
} from "../api.js";

const ns: CodeModeNamespace<{ greet(name: string): string }, { greet(name: string): string }> = {
  id: "test",
  toolName: "execute_test_code",
  displayName: "Test Code Mode",
  namespaceName: "Test",
  createNamespace: (api) => ({ greet: api.greet }),
  collectionClasses: {},
  getSystemPrompt: () => "Use Test.greet(name).",
};

const ns2: CodeModeNamespace<{ shout(name: string): string }, { shout(name: string): string }> = {
  id: "other",
  toolName: "execute_other_code",
  displayName: "Other Code Mode",
  namespaceName: "Other",
  createNamespace: (api) => ({ shout: api.shout }),
  collectionClasses: {},
  getSystemPrompt: () => "Use Other.shout(name).",
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
    unregisterCodeModeNamespace("test");
    unregisterCodeModeNamespace("other");
  });

  it("does not expose execute_code until a namespace is registered", () => {
    const { api, toolFactories } = createApi();
    plugin.register(api as never);

    expect(api.registerTool).toHaveBeenCalledWith(expect.any(Function), {
      name: "execute_code",
      optional: true,
    });
    const factory = toolFactories[0] as () => unknown;
    expect(factory()).toBeNull();
  });

  it("executes single-namespace code through the generic tool", async () => {
    const { api, toolFactories } = createApi();
    plugin.register(api as never);
    registerCodeModeNamespace(ns, { greet: (name: string) => `Hello, ${name}!` });

    const tool = (toolFactories[0] as () => any)();
    const result = await tool.execute("call-1", {
      namespaceIds: ["test"],
      code: 'return await Test.greet("World");',
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.returnValue).toBe("Hello, World!");
  });

  it("composes two namespaces in one execute_code call", async () => {
    const { api, toolFactories } = createApi();
    plugin.register(api as never);
    registerCodeModeNamespace(ns, { greet: (name: string) => `Hello, ${name}!` });
    registerCodeModeNamespace(ns2, { shout: (name: string) => `HEY ${name}` });

    const tool = (toolFactories[0] as () => any)();
    const result = await tool.execute("call-1", {
      namespaceIds: ["test", "other"],
      code: 'const a = await Test.greet("a"); const b = await Other.shout("b"); return a + "|" + b;',
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.returnValue).toBe("Hello, a!|HEY b");
  });

  it("returns structured validation errors for unknown namespaces", async () => {
    const { api, toolFactories } = createApi();
    plugin.register(api as never);
    registerCodeModeNamespace(ns, { greet: (name: string) => `Hello, ${name}!` });

    const tool = (toolFactories[0] as () => any)();
    const result = await tool.execute("call-1", {
      namespaceIds: ["unknown"],
      code: "return 1;",
    });

    expect(result.details.ok).toBe(false);
    expect(result.details.errorKind).toBe("validationError");
    expect(result.details.error).toContain('code mode namespace "unknown" is not registered');
    expect(result.content[0].text).toContain("Available namespaces: test");
  });

  it("returns structured validation errors for missing/empty namespaceIds", async () => {
    const { api, toolFactories } = createApi();
    plugin.register(api as never);
    registerCodeModeNamespace(ns, { greet: (name: string) => `Hello, ${name}!` });

    const tool = (toolFactories[0] as () => any)();
    const result = await tool.execute("call-1", {
      namespaceIds: [],
      code: "return 1;",
    });

    expect(result.details.ok).toBe(false);
    expect(result.details.errorKind).toBe("validationError");
    expect(result.details.error).toContain("non-empty array");
  });

  it("rejects duplicate namespaceIds in a single call", async () => {
    const { api, toolFactories } = createApi();
    plugin.register(api as never);
    registerCodeModeNamespace(ns, { greet: (name: string) => `Hello, ${name}!` });

    const tool = (toolFactories[0] as () => any)();
    const result = await tool.execute("call-1", {
      namespaceIds: ["test", "test"],
      code: "return 1;",
    });

    expect(result.details.ok).toBe(false);
    expect(result.details.errorKind).toBe("validationError");
    expect(result.details.error).toContain("duplicate");
  });

  it("adds the active session prompt during agent turn preparation", () => {
    const { api, hooks } = createApi();
    plugin.register(api as never);
    registerCodeModeNamespace(ns, {});
    activateCodeModeSession("test", undefined, "agent:test");

    const hook = hooks.find((entry) => entry.name === "agent_turn_prepare");
    expect(hook?.handler({}, { sessionKey: "agent:test" })).toEqual({
      appendContext: "Use Test.greet(name).",
    });
    expect(hook?.handler({}, { sessionKey: "agent:other" })).toBeUndefined();
  });
});
