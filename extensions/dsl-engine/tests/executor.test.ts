/**
 * Generic DSL Executor Tests
 */

import { describe, it, expect } from "vitest";
import { executeDsl } from "../src/executor.js";
import type { DslHydration } from "../src/types.js";

// Test API and Namespace types
interface TestApi {
  greet(name: string): string;
  getData(): { count: number };
}

interface TestNamespace {
  greet(name: string): string;
  getData(): { count: number };
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

// Create a test hydration
function createTestHydration(overrides?: Partial<DslHydration<TestApi, TestNamespace>>): DslHydration<TestApi, TestNamespace> {
  return {
    id: "test",
    toolName: "execute_test_dsl",
    displayName: "Test DSL",
    namespaceName: "Test",
    createNamespace: (api: TestApi): TestNamespace => ({
      greet: api.greet,
      getData: api.getData,
    }),
    collectionClasses: {
      TestCollection,
    },
    getSystemPrompt: () => "Test DSL system prompt",
    ...overrides,
  };
}

// Create a test namespace
function createTestNamespace(): TestNamespace {
  return {
    greet: (name: string) => `Hello, ${name}!`,
    getData: () => ({ count: 42 }),
  };
}

describe("executeDsl", () => {
  it("executes code with injected namespace and returns result", async () => {
    const hydration = createTestHydration();
    const namespace = createTestNamespace();
    const code = `return Test.greet("World");`;

    const result = await executeDsl(code, hydration, namespace);

    expect(result.kind).toBe("Succeeded");
    expect(result.result).toBe("Hello, World!");
    expect(result.consoleOutput).toEqual([]);
  });

  it("captures console.log output", async () => {
    const hydration = createTestHydration();
    const namespace = createTestNamespace();
    const code = `
      console.log("First log");
      console.log("Second log");
      const data = Test.getData();
      console.log("Count:", data.count);
      return "done";
    `;

    const result = await executeDsl(code, hydration, namespace);

    expect(result.kind).toBe("Succeeded");
    expect(result.result).toBe("done");
    expect(result.consoleOutput).toEqual([
      "First log",
      "Second log",
      "Count: 42",
    ]);
  });

  it("captures console.warn and console.error output", async () => {
    const hydration = createTestHydration();
    const namespace = createTestNamespace();
    const code = `
      console.log("Info");
      console.warn("Warning message");
      console.error("Error message");
      return "done";
    `;

    const result = await executeDsl(code, hydration, namespace);

    expect(result.kind).toBe("Succeeded");
    expect(result.consoleOutput).toEqual([
      "Info",
      "WARN: Warning message",
      "ERROR: Error message",
    ]);
  });

  it("returns Failed on thrown error", async () => {
    const hydration = createTestHydration();
    const namespace = createTestNamespace();
    const code = `throw new Error("Test error");`;

    const result = await executeDsl(code, hydration, namespace);

    expect(result.kind).toBe("Failed");
    expect(result.error).toBe("Test error");
    expect(result.consoleOutput).toEqual([]);
  });

  it("enforces max code size", async () => {
    const hydration = createTestHydration({
      maxCodeBytes: 50, // Very small limit
    });
    const namespace = createTestNamespace();
    const code = `return "a".repeat(100);`; // This code is >50 bytes

    const result = await executeDsl(code, hydration, namespace);

    expect(result.kind).toBe("Failed");
    expect(result.error).toContain("exceeds maximum allowed");
    expect(result.consoleOutput).toEqual([]);
  });

  it("respects timeout", async () => {
    const hydration = createTestHydration({
      defaultTimeoutMs: 100, // Very short timeout
    });
    const namespace = createTestNamespace();
    const code = `
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
      return "done";
    `;

    const result = await executeDsl(code, hydration, namespace);

    expect(result.kind).toBe("Failed");
    expect(result.error).toContain("timed out");
    expect(result.consoleOutput).toEqual([]);
  });

  it("injects collection classes into scope", async () => {
    const hydration = createTestHydration();
    const namespace = createTestNamespace();
    const code = `
      const collection = new TestCollection();
      collection.add("item1");
      collection.add("item2");
      return collection.getAll();
    `;

    const result = await executeDsl(code, hydration, namespace);

    expect(result.kind).toBe("Succeeded");
    expect(result.result).toEqual(["item1", "item2"]);
  });

  it("injects extraGlobals into scope", async () => {
    const hydration = createTestHydration();
    const namespace = createTestNamespace();
    const code = `return customValue + 10;`;

    const result = await executeDsl(code, hydration, namespace, {
      extraGlobals: { customValue: 32 },
    });

    expect(result.kind).toBe("Succeeded");
    expect(result.result).toBe(42);
  });

  it("uses console output as result when result is undefined and console has output", async () => {
    const hydration = createTestHydration();
    const namespace = createTestNamespace();
    const code = `
      console.log("Line 1");
      console.log("Line 2");
      // No return statement
    `;

    const result = await executeDsl(code, hydration, namespace);

    expect(result.kind).toBe("Succeeded");
    expect(result.result).toBe("Line 1\nLine 2");
    expect(result.consoleOutput).toEqual(["Line 1", "Line 2"]);
  });

  it("preserves undefined result when console is empty", async () => {
    const hydration = createTestHydration();
    const namespace = createTestNamespace();
    const code = `// No return statement`;

    const result = await executeDsl(code, hydration, namespace);

    expect(result.kind).toBe("Succeeded");
    expect(result.result).toBeUndefined();
    expect(result.consoleOutput).toEqual([]);
  });

  it("allows JSON usage in code", async () => {
    const hydration = createTestHydration();
    const namespace = createTestNamespace();
    const code = `
      const obj = { name: "test", value: 42 };
      return JSON.stringify(obj);
    `;

    const result = await executeDsl(code, hydration, namespace);

    expect(result.kind).toBe("Succeeded");
    expect(result.result).toBe('{"name":"test","value":42}');
  });

  it("respects opts.timeoutMs over default timeout", async () => {
    const hydration = createTestHydration({
      defaultTimeoutMs: 1000, // 1 second default
    });
    const namespace = createTestNamespace();
    const code = `
      await new Promise(resolve => setTimeout(resolve, 150));
      return "done";
    `;

    // Request a very short timeout
    const result = await executeDsl(code, hydration, namespace, {
      timeoutMs: 50,
    });

    expect(result.kind).toBe("Failed");
    expect(result.error).toContain("timed out");
  });

  it("enforces maxTimeoutMs cap", async () => {
    const hydration = createTestHydration({
      maxTimeoutMs: 100, // Cap at 100ms
    });
    const namespace = createTestNamespace();
    const code = `
      await new Promise(resolve => setTimeout(resolve, 200));
      return "done";
    `;

    // Request a longer timeout, but it should be capped
    const result = await executeDsl(code, hydration, namespace, {
      timeoutMs: 500,
    });

    expect(result.kind).toBe("Failed");
    expect(result.error).toContain("timed out after 100ms");
  });
});
