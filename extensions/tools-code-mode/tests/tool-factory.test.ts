/**
 * Code Mode Tool Factory Tests
 */

import { describe, it, expect } from "vitest";
import { createCodeModeTool } from "../src/tool-factory.js";
import type { CodeModeNamespace } from "../src/types.js";

// Test API and Namespace types
interface TestApi {
  greet(name: string): string;
  getData(): { count: number };
  asyncOperation(): Promise<string>;
}

interface TestNamespace {
  greet(name: string): string;
  getData(): { count: number };
  asyncOperation(): Promise<string>;
}

// Create a test hydration
function createTestNamespace(
  overrides?: Partial<CodeModeNamespace<TestApi, TestNamespace>>,
): CodeModeNamespace<TestApi, TestNamespace> {
  return {
    id: "test",
    toolName: "execute_test_code",
    displayName: "Test Code Mode",
    namespaceName: "Test",
    createNamespace: (api: TestApi): TestNamespace => ({
      greet: api.greet,
      getData: api.getData,
      asyncOperation: api.asyncOperation,
    }),
    collectionClasses: {},
    getSystemPrompt: () => "Test Code Mode system prompt",
    ...overrides,
  };
}

// Create a test API
function createTestApi(): TestApi {
  return {
    greet: (name: string) => `Hello, ${name}!`,
    getData: () => ({ count: 42 }),
    asyncOperation: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "async result";
    },
  };
}

describe("createCodeModeTool", () => {
  it("creates a tool with correct name and description", () => {
    const ns = createTestNamespace();
    const api = createTestApi();
    const tool = createCodeModeTool(ns, api);

    expect(tool.name).toBe("execute_test_code");
    expect(tool.description).toContain("Test Code Mode");
    expect(tool.description).toContain("Test");
  });

  it("creates a tool with correct parameter schema", () => {
    const ns = createTestNamespace();
    const api = createTestApi();
    const tool = createCodeModeTool(ns, api);

    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        code: {
          type: "string",
        },
        timeoutMs: {
          type: "number",
        },
      },
      required: ["code"],
    });
  });

  it("executes valid code and returns ok=true with returnValue", async () => {
    const ns = createTestNamespace();
    const api = createTestApi();
    const tool = createCodeModeTool(ns, api);

    const result = await tool.execute("call-1", {
      code: `return Test.greet("World");`,
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.returnValue).toBe("Hello, World!");
    expect(result.details.error).toBeUndefined();
    expect(result.details.consoleOutput).toEqual([]);
    expect(result.details.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns ok=false with error for invalid code", async () => {
    const ns = createTestNamespace();
    const api = createTestApi();
    const tool = createCodeModeTool(ns, api);

    const result = await tool.execute("call-2", {
      code: `throw new Error("Test error");`,
    });

    expect(result.details.ok).toBe(false);
    expect(result.details.returnValue).toBeUndefined();
    expect(result.details.error).toBe("Test error");
    expect(result.details.consoleOutput).toEqual([]);
    expect(result.details.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("respects timeoutMs override", async () => {
    const ns = createTestNamespace({
      defaultTimeoutMs: 1000, // 1 second default
    });
    const api = createTestApi();
    const tool = createCodeModeTool(ns, api);

    const result = await tool.execute("call-3", {
      code: `await new Promise(resolve => setTimeout(resolve, 200)); return "done";`,
      timeoutMs: 50, // Very short timeout
    });

    expect(result.details.ok).toBe(false);
    expect(result.details.error).toContain("timed out");
    expect(result.details.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("includes durationMs in output", async () => {
    const ns = createTestNamespace();
    const api = createTestApi();
    const tool = createCodeModeTool(ns, api);

    const result = await tool.execute("call-4", {
      code: `return "quick";`,
    });

    expect(result.details.durationMs).toBeDefined();
    expect(typeof result.details.durationMs).toBe("number");
    expect(result.details.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures console output", async () => {
    const ns = createTestNamespace();
    const api = createTestApi();
    const tool = createCodeModeTool(ns, api);

    const result = await tool.execute("call-5", {
      code: `
        console.log("First log");
        console.log("Second log");
        return Test.getData().count;
      `,
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.returnValue).toBe(42);
    expect(result.details.consoleOutput).toEqual(["First log", "Second log"]);
  });

  it("handles async operations", async () => {
    const ns = createTestNamespace();
    const api = createTestApi();
    const tool = createCodeModeTool(ns, api);

    const result = await tool.execute("call-6", {
      code: `return await Test.asyncOperation();`,
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.returnValue).toBe("async result");
  });

  it("injects extraGlobals when provided by hydration", async () => {
    const ns = createTestNamespace({
      extraGlobals: (api: TestApi, context?: any) => ({
        customValue: context?.value ?? 100,
      }),
    });
    const api = createTestApi();
    const tool = createCodeModeTool(ns, api, { value: 42 });

    const result = await tool.execute("call-7", {
      code: `return customValue + 8;`,
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.returnValue).toBe(50);
  });

  it("returns content with JSON-stringified output", async () => {
    const ns = createTestNamespace();
    const api = createTestApi();
    const tool = createCodeModeTool(ns, api);

    const result = await tool.execute("call-8", {
      code: `return "test";`,
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain('"ok": true');
    expect(result.content[0].text).toContain('"returnValue": "test"');
    expect(result.content[0].text).toContain('"durationMs"');
  });

  it("handles syntax errors", async () => {
    const ns = createTestNamespace();
    const api = createTestApi();
    const tool = createCodeModeTool(ns, api);

    const result = await tool.execute("call-9", {
      code: `this is not valid javascript syntax!!!`,
    });

    expect(result.details.ok).toBe(false);
    expect(result.details.error).toBeDefined();
    expect(typeof result.details.error).toBe("string");
  });

  it("handles code that returns undefined", async () => {
    const ns = createTestNamespace();
    const api = createTestApi();
    const tool = createCodeModeTool(ns, api);

    const result = await tool.execute("call-10", {
      code: `// No return statement`,
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.returnValue).toBeUndefined();
    expect(result.details.error).toBeUndefined();
  });

  it("uses console output as returnValue when result is undefined", async () => {
    const ns = createTestNamespace();
    const api = createTestApi();
    const tool = createCodeModeTool(ns, api);

    const result = await tool.execute("call-11", {
      code: `
        console.log("Line 1");
        console.log("Line 2");
        // No return
      `,
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.returnValue).toBe("Line 1\nLine 2");
    expect(result.details.consoleOutput).toEqual(["Line 1", "Line 2"]);
  });

  it("handles multiple tool instances with different APIs", async () => {
    const ns = createTestNamespace();
    const api1 = createTestApi();
    const api2 = {
      ...createTestApi(),
      greet: (name: string) => `Bonjour, ${name}!`,
    };

    const tool1 = createCodeModeTool(ns, api1);
    const tool2 = createCodeModeTool(ns, api2);

    const result1 = await tool1.execute("call-12a", {
      code: `return Test.greet("Alice");`,
    });
    const result2 = await tool2.execute("call-12b", {
      code: `return Test.greet("Bob");`,
    });

    expect(result1.details.returnValue).toBe("Hello, Alice!");
    expect(result2.details.returnValue).toBe("Bonjour, Bob!");
  });

  it("creates namespace per execution for freshness", async () => {
    let namespaceCreationCount = 0;

    const ns = createTestNamespace({
      createNamespace: (api: TestApi) => {
        namespaceCreationCount++;
        return {
          greet: api.greet,
          getData: api.getData,
          asyncOperation: api.asyncOperation,
        };
      },
    });

    const api = createTestApi();
    const tool = createCodeModeTool(ns, api);

    // Namespace not created at tool creation time
    expect(namespaceCreationCount).toBe(0);

    await tool.execute("call-13a", { code: `return Test.getData().count;` });
    expect(namespaceCreationCount).toBe(1);

    await tool.execute("call-13b", { code: `return Test.greet("Test");` });
    expect(namespaceCreationCount).toBe(2);
  });
});
