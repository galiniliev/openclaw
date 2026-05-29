/**
 * Integration Tests
 *
 * End-to-end tests that verify the full flow: hydration → tool factory → execute → result.
 */

import { describe, it, expect } from "vitest";
import { executeCodeMode } from "../src/executor.js";
import { createCodeModeTool } from "../src/tool-factory.js";
import { CodeModeSessionManager } from "../src/mode-manager.js";
import type { CodeModeNamespace } from "../src/types.js";

// Test API and Namespace types
interface TestApi {
  greet(name: string): string;
  getData(): { count: number };
  throwError(message: string): never;
}

interface TestNamespace {
  greet(name: string): string;
  getData(): { count: number };
  throwError(message: string): never;
}

// Test collection class
class TestCollection {
  items: string[] = [];

  add(item: string) {
    this.items.push(item);
  }

  getAll(): string[] {
    return this.items;
  }
}

// Create a test hydration with mock API
function createTestNamespace(overrides?: Partial<CodeModeNamespace<TestApi, TestNamespace>>): CodeModeNamespace<TestApi, TestNamespace> {
  return {
    id: "test",
    toolName: "execute_test_code",
    displayName: "Test Code Mode",
    namespaceName: "Test",
    createNamespace: (api: TestApi): TestNamespace => ({
      greet: api.greet,
      getData: api.getData,
      throwError: api.throwError,
    }),
    collectionClasses: {
      TestCollection,
    },
    getSystemPrompt: (context?: any) => {
      const basePrompt = "Test Code Mode system prompt";
      return context ? `${basePrompt}\nContext: ${JSON.stringify(context)}` : basePrompt;
    },
    ...overrides,
  };
}

// Create a mock in-memory API
function createMockApi(): TestApi {
  return {
    greet: (name: string) => `Hello, ${name}!`,
    getData: () => ({ count: 42 }),
    throwError: (message: string) => {
      throw new Error(message);
    },
  };
}

describe("Integration Tests", () => {
  describe("Full flow with mock hydration", () => {
    it("creates tool, executes code, and returns result", async () => {
      // 1. Create hydration and API
      const ns = createTestNamespace();
      const api = createMockApi();

      // 2. Build tool from hydration
      const tool = createCodeModeTool(ns, api);

      // 3. Execute code via tool
      const code = `
        const greeting = Test.greet("World");
        const data = Test.getData();
        return { greeting, count: data.count };
      `;

      const result = await tool.execute("test-call-1", { code });

      // 4. Verify result structure
      expect(result.details.ok).toBe(true);
      expect(result.details.returnValue).toEqual({
        greeting: "Hello, World!",
        count: 42,
      });
      expect(result.details.consoleOutput).toEqual([]);
      expect(result.details.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(JSON.parse(result.content[0].text)).toEqual(result.details);
    });

    it("executes async code with collection classes", async () => {
      const ns = createTestNamespace();
      const api = createMockApi();
      const tool = createCodeModeTool(ns, api);

      const code = `
        const collection = new TestCollection();
        collection.add("item1");
        collection.add("item2");

        // Simulate async operation
        await new Promise(resolve => setTimeout(resolve, 10));

        collection.add("item3");
        return collection.getAll();
      `;

      const result = await tool.execute("test-call-2", { code });

      expect(result.details.ok).toBe(true);
      expect(result.details.returnValue).toEqual(["item1", "item2", "item3"]);
    });

    it("supports extra globals via hydration", async () => {
      const ns = createTestNamespace({
        extraGlobals: (api: TestApi, context?: any) => ({
          customValue: 100,
          contextData: context?.userId || "anonymous",
        }),
      });
      const api = createMockApi();
      const context = { userId: "user-123" };
      const tool = createCodeModeTool(ns, api, context);

      const code = `
        return {
          value: customValue + 10,
          user: contextData,
        };
      `;

      const result = await tool.execute("test-call-3", { code });

      expect(result.details.ok).toBe(true);
      expect(result.details.returnValue).toEqual({
        value: 110,
        user: "user-123",
      });
    });
  });

  describe("Mode manager + tool creation", () => {
    it("registers hydrations, activates mode, and verifies prompt switching", () => {
      // Create multiple hydrations
      const testNs = createTestNamespace();
      const altNs = createTestNamespace({
        id: "alt",
        toolName: "execute_alt_code",
        displayName: "Alt Code Mode",
        getSystemPrompt: () => "Alt Code Mode system prompt",
      });

      // Create mode manager
      const manager = new CodeModeSessionManager([testNs, altNs]);

      // Verify initial state
      expect(manager.getActiveMode()).toBeNull();
      expect(manager.getActiveNamespace()).toBeNull();
      expect(manager.getActivePrompt()).toBeNull();

      // Activate test mode
      manager.activate("test", { feature: "testing" });

      const mode = manager.getActiveMode();
      expect(mode).not.toBeNull();
      expect(mode?.namespaceId).toBe("test");
      expect(mode?.context).toEqual({ feature: "testing" });
      expect(mode?.activatedAt).toBeGreaterThan(0);

      const activeNs = manager.getActiveNamespace();
      expect(activeNs?.id).toBe("test");
      expect(activeNs?.displayName).toBe("Test Code Mode");

      const prompt = manager.getActivePrompt();
      expect(prompt).toContain("Test Code Mode system prompt");
      expect(prompt).toContain('{"feature":"testing"}');

      // Switch to alt mode
      manager.activate("alt");

      expect(manager.getActiveMode()?.namespaceId).toBe("alt");
      expect(manager.getActiveNamespace()?.id).toBe("alt");
      expect(manager.getActivePrompt()).toBe("Alt Code Mode system prompt");

      // Deactivate
      manager.deactivate();
      expect(manager.getActiveMode()).toBeNull();
    });

    it("lists available hydrations", () => {
      const ns1 = createTestNamespace();
      const ns2 = createTestNamespace({
        id: "test2",
        toolName: "execute_test2_code",
      });

      const manager = new CodeModeSessionManager([ns1, ns2]);

      const available = manager.listAvailable();
      expect(available).toHaveLength(2);
      expect(available.map((h) => h.id)).toEqual(["test", "test2"]);
    });

    it("registers new hydration dynamically", () => {
      const manager = new CodeModeSessionManager([]);
      expect(manager.listAvailable()).toHaveLength(0);

      const ns = createTestNamespace();
      manager.register(ns);

      expect(manager.listAvailable()).toHaveLength(1);
      expect(manager.listAvailable()[0].id).toBe("test");

      // Can now activate it
      manager.activate("test");
      expect(manager.getActiveMode()?.namespaceId).toBe("test");
    });

    it("throws error when activating unknown hydration", () => {
      const manager = new CodeModeSessionManager([]);

      expect(() => manager.activate("unknown")).toThrow("Unknown namespace ID: unknown");
    });
  });

  describe("Console capture end-to-end", () => {
    it("captures console output through tool execution", async () => {
      const ns = createTestNamespace();
      const api = createMockApi();
      const tool = createCodeModeTool(ns, api);

      const code = `
        console.log("Starting execution");
        const data = Test.getData();
        console.log("Got data:", data.count);
        console.warn("This is a warning");
        console.error("This is an error");
        return "done";
      `;

      const result = await tool.execute("test-call-4", { code });

      expect(result.details.ok).toBe(true);
      expect(result.details.returnValue).toBe("done");
      expect(result.details.consoleOutput).toEqual([
        "Starting execution",
        "Got data: 42",
        "WARN: This is a warning",
        "ERROR: This is an error",
      ]);
    });

    it("returns console output as result when no explicit return", async () => {
      const ns = createTestNamespace();
      const api = createMockApi();
      const tool = createCodeModeTool(ns, api);

      const code = `
        console.log("First line");
        console.log("Second line");
        Test.greet("World");
      `;

      const result = await tool.execute("test-call-5", { code });

      expect(result.details.ok).toBe(true);
      expect(result.details.returnValue).toBe("First line\nSecond line");
      expect(result.details.consoleOutput).toEqual([
        "First line",
        "Second line",
      ]);
    });
  });

  describe("Error propagation", () => {
    it("returns ok:false when API throws error", async () => {
      const ns = createTestNamespace();
      const api = createMockApi();
      const tool = createCodeModeTool(ns, api);

      const code = `Test.throwError("Something went wrong");`;

      const result = await tool.execute("test-call-6", { code });

      expect(result.details.ok).toBe(false);
      expect(result.details.error).toBe("Something went wrong");
      expect(result.details.returnValue).toBeUndefined();
      expect(result.details.consoleOutput).toEqual([]);
    });

    it("returns error message when code throws", async () => {
      const ns = createTestNamespace();
      const api = createMockApi();
      const tool = createCodeModeTool(ns, api);

      const code = `throw new Error("Custom error");`;

      const result = await tool.execute("test-call-7", { code });

      expect(result.details.ok).toBe(false);
      expect(result.details.error).toBe("Custom error");
    });

    it("returns error when code has syntax error", async () => {
      const ns = createTestNamespace();
      const api = createMockApi();
      const tool = createCodeModeTool(ns, api);

      const code = `this is invalid javascript syntax {{{`;

      const result = await tool.execute("test-call-8", { code });

      expect(result.details.ok).toBe(false);
      expect(result.details.error).toBeDefined();
      expect(result.details.error).toContain("Unexpected");
    });

    it("preserves console output before error", async () => {
      const ns = createTestNamespace();
      const api = createMockApi();
      const tool = createCodeModeTool(ns, api);

      const code = `
        console.log("Before error");
        console.log("Still working");
        throw new Error("Boom!");
      `;

      const result = await tool.execute("test-call-9", { code });

      expect(result.details.ok).toBe(false);
      expect(result.details.error).toBe("Boom!");
      expect(result.details.consoleOutput).toEqual([
        "Before error",
        "Still working",
      ]);
    });
  });

  describe("Timeout end-to-end", () => {
    it("respects timeout and returns error", async () => {
      const ns = createTestNamespace({
        defaultTimeoutMs: 100, // Short timeout
      });
      const api = createMockApi();
      const tool = createCodeModeTool(ns, api);

      const code = `
        await new Promise(resolve => setTimeout(resolve, 500));
        return "done";
      `;

      const result = await tool.execute("test-call-10", { code });

      expect(result.details.ok).toBe(false);
      expect(result.details.error).toContain("timed out");
      expect(result.details.error).toContain("100ms");
    });

    it("respects custom timeout from tool input", async () => {
      const ns = createTestNamespace({
        defaultTimeoutMs: 5000, // Long default
      });
      const api = createMockApi();
      const tool = createCodeModeTool(ns, api);

      const code = `
        await new Promise(resolve => setTimeout(resolve, 200));
        return "done";
      `;

      // Request short timeout via tool parameter
      const result = await tool.execute("test-call-11", {
        code,
        timeoutMs: 50,
      });

      expect(result.details.ok).toBe(false);
      expect(result.details.error).toContain("timed out");
      expect(result.details.error).toContain("50ms");
    });

    it("completes successfully before timeout", async () => {
      const ns = createTestNamespace({
        defaultTimeoutMs: 500, // Generous timeout
      });
      const api = createMockApi();
      const tool = createCodeModeTool(ns, api);

      const code = `
        await new Promise(resolve => setTimeout(resolve, 50));
        return "completed";
      `;

      const result = await tool.execute("test-call-12", { code });

      expect(result.details.ok).toBe(true);
      expect(result.details.returnValue).toBe("completed");
      expect(result.details.durationMs).toBeGreaterThanOrEqual(50);
    });
  });

  describe("Full integration with mode manager and tools", () => {
    it("creates tools from active hydration and executes", async () => {
      // Set up two hydrations with different APIs
      const api1 = createMockApi();
      const api2: TestApi = {
        greet: (name: string) => `Greetings, ${name}!`,
        getData: () => ({ count: 99 }),
        throwError: (message: string) => {
          throw new Error(message);
        },
      };

      const ns1 = createTestNamespace();
      const ns2 = createTestNamespace({
        id: "alt",
        toolName: "execute_alt_code",
        displayName: "Alt Code Mode",
      });

      const manager = new CodeModeSessionManager([ns1, ns2]);

      // Activate first mode and create tool
      manager.activate("test");
      const tool1 = createCodeModeTool(ns1, api1);

      const result1 = await tool1.execute("call-1", {
        code: `return Test.greet("User");`,
      });

      expect(result1.details.ok).toBe(true);
      expect(result1.details.returnValue).toBe("Hello, User!");

      // Switch mode and create new tool with different API
      manager.activate("alt");
      const tool2 = createCodeModeTool(ns2, api2);

      const result2 = await tool2.execute("call-2", {
        code: `return Test.greet("User");`,
      });

      expect(result2.details.ok).toBe(true);
      expect(result2.details.returnValue).toBe("Greetings, User!");
    });
  });
});
