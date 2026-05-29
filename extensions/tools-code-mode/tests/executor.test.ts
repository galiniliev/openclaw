/**
 * Generic code mode Executor Tests
 */

import { describe, it, expect } from "vitest";
import { executeCodeMode, type NamespaceBinding } from "../src/executor.js";
import type { CodeModeNamespace } from "../src/types.js";

interface TestApi {
  greet(name: string): string;
  getData(): { count: number };
}

interface TestNamespace {
  greet(name: string): string;
  getData(): { count: number };
}

class TestCollection {
  items: string[] = [];
  add(item: string) { this.items.push(item); }
  getAll(): string[] { return this.items; }
}

function createTestNamespaceDescriptor(
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
    }),
    collectionClasses: { TestCollection },
    getSystemPrompt: () => "Test Code Mode system prompt",
    ...overrides,
  };
}

function createTestScope(): TestNamespace {
  return {
    greet: (name: string) => `Hello, ${name}!`,
    getData: () => ({ count: 42 }),
  };
}

function bind(
  ns: CodeModeNamespace<TestApi, TestNamespace>,
  scope: TestNamespace = createTestScope(),
): NamespaceBinding[] {
  return [{ namespace: ns as unknown as CodeModeNamespace, scope }];
}

describe("executeCodeMode", () => {
  it("executes code with injected namespace and returns result", async () => {
    const result = await executeCodeMode(`return Test.greet("World");`, bind(createTestNamespaceDescriptor()));
    expect(result.kind).toBe("Succeeded");
    expect(result.result).toBe("Hello, World!");
    expect(result.consoleOutput).toEqual([]);
  });

  it("captures console.log output", async () => {
    const code = `
      console.log("First log");
      console.log("Second log");
      const data = Test.getData();
      console.log("Count:", data.count);
      return "done";
    `;
    const result = await executeCodeMode(code, bind(createTestNamespaceDescriptor()));
    expect(result.kind).toBe("Succeeded");
    expect(result.result).toBe("done");
    expect(result.consoleOutput).toEqual(["First log", "Second log", "Count: 42"]);
  });

  it("captures console.warn and console.error output", async () => {
    const code = `
      console.log("Info");
      console.warn("Warning message");
      console.error("Error message");
      return "done";
    `;
    const result = await executeCodeMode(code, bind(createTestNamespaceDescriptor()));
    expect(result.kind).toBe("Succeeded");
    expect(result.consoleOutput).toEqual(["Info", "WARN: Warning message", "ERROR: Error message"]);
  });

  it("returns Failed on thrown error", async () => {
    const result = await executeCodeMode(`throw new Error("Test error");`, bind(createTestNamespaceDescriptor()));
    expect(result.kind).toBe("Failed");
    expect(result.error).toBe("Test error");
  });

  it("enforces max code size", async () => {
    const result = await executeCodeMode(
      `return "a".repeat(100);`,
      bind(createTestNamespaceDescriptor({ maxCodeBytes: 50 })),
    );
    expect(result.kind).toBe("Failed");
    expect(result.error).toContain("exceeds maximum allowed");
  });

  it("respects timeout", async () => {
    const code = `
      await new Promise(resolve => setTimeout(resolve, 1000));
      return "done";
    `;
    const result = await executeCodeMode(
      code,
      bind(createTestNamespaceDescriptor({ defaultTimeoutMs: 100 })),
    );
    expect(result.kind).toBe("Failed");
    expect(result.error).toContain("timed out");
  });

  it("injects collection classes into scope", async () => {
    const code = `
      const collection = new TestCollection();
      collection.add("item1");
      collection.add("item2");
      return collection.getAll();
    `;
    const result = await executeCodeMode(code, bind(createTestNamespaceDescriptor()));
    expect(result.kind).toBe("Succeeded");
    expect(result.result).toEqual(["item1", "item2"]);
  });

  it("injects extraGlobals into scope", async () => {
    const result = await executeCodeMode(
      `return customValue + 10;`,
      bind(createTestNamespaceDescriptor()),
      { extraGlobals: { customValue: 32 } },
    );
    expect(result.kind).toBe("Succeeded");
    expect(result.result).toBe(42);
  });

  it("uses console output as result when result is undefined and console has output", async () => {
    const code = `
      console.log("Line 1");
      console.log("Line 2");
    `;
    const result = await executeCodeMode(code, bind(createTestNamespaceDescriptor()));
    expect(result.kind).toBe("Succeeded");
    expect(result.result).toBe("Line 1\nLine 2");
  });

  it("preserves undefined result when console is empty", async () => {
    const result = await executeCodeMode(`// nothing`, bind(createTestNamespaceDescriptor()));
    expect(result.kind).toBe("Succeeded");
    expect(result.result).toBeUndefined();
  });

  it("allows JSON usage in code", async () => {
    const result = await executeCodeMode(
      `return JSON.stringify({ name: "test", value: 42 });`,
      bind(createTestNamespaceDescriptor()),
    );
    expect(result.kind).toBe("Succeeded");
    expect(result.result).toBe('{"name":"test","value":42}');
  });

  it("respects opts.timeoutMs over default timeout", async () => {
    const code = `
      await new Promise(resolve => setTimeout(resolve, 150));
      return "done";
    `;
    const result = await executeCodeMode(
      code,
      bind(createTestNamespaceDescriptor({ defaultTimeoutMs: 1000 })),
      { timeoutMs: 50 },
    );
    expect(result.kind).toBe("Failed");
    expect(result.error).toContain("timed out");
  });

  it("enforces maxTimeoutMs cap", async () => {
    const code = `
      await new Promise(resolve => setTimeout(resolve, 200));
      return "done";
    `;
    const result = await executeCodeMode(
      code,
      bind(createTestNamespaceDescriptor({ maxTimeoutMs: 100 })),
      { timeoutMs: 500 },
    );
    expect(result.kind).toBe("Failed");
    expect(result.error).toContain("timed out after 100ms");
  });

  it("terminates CPU-bound code after timeout", async () => {
    const result = await executeCodeMode(
      "while (true) {}",
      bind(createTestNamespaceDescriptor({ defaultTimeoutMs: 50 })),
    );
    expect(result.kind).toBe("Failed");
    expect(result.error).toContain("timed out after 50ms");
    expect(result.errorKind).toBe("timeout");
  });

  it("returns codeSizeExceeded errorKind when code is too large", async () => {
    const result = await executeCodeMode(
      "return 'toolong';",
      bind(createTestNamespaceDescriptor({ maxCodeBytes: 10 })),
    );
    expect(result.kind).toBe("Failed");
    expect(result.errorKind).toBe("codeSizeExceeded");
  });

  it("blocks prototype pollution via __proto__ path", async () => {
    const result = await executeCodeMode(
      `try { const F = Promise.constructor.constructor; return "leaked"; } catch(e) { return "blocked: " + e.message; }`,
      bind(createTestNamespaceDescriptor()),
    );
    expect(result.kind).toBe("Succeeded");
    expect(result.result).toContain("blocked");
  });

  it("prevents sandbox escape via Promise realm traversal", async () => {
    const result = await executeCodeMode(
      `const p = Promise.resolve(); const C = p.constructor.constructor; const proc = C("return process")(); return proc.env;`,
      bind(createTestNamespaceDescriptor()),
    );
    expect(result.kind).toBe("Failed");
  });

  it("runs concurrent executions up to the concurrency limit", async () => {
    const ns = createTestNamespaceDescriptor({ defaultTimeoutMs: 5000 });
    const promises = Array.from({ length: 6 }, (_, i) =>
      executeCodeMode(`return ${i};`, bind(ns)),
    );
    const results = await Promise.all(promises);
    for (let i = 0; i < 6; i++) {
      expect(results[i].kind).toBe("Succeeded");
      expect(results[i].result).toBe(i);
    }
  });

  it("rejects empty bindings", async () => {
    const result = await executeCodeMode(`return 1;`, []);
    expect(result.kind).toBe("Failed");
    expect(result.errorKind).toBe("validationError");
  });

  it("composes two namespaces in one call", async () => {
    const m365: CodeModeNamespace<TestApi, TestNamespace> = createTestNamespaceDescriptor({
      id: "m365",
      namespaceName: "M365",
    });
    const outlook: CodeModeNamespace<TestApi, TestNamespace> = createTestNamespaceDescriptor({
      id: "outlook",
      namespaceName: "Outlook",
      createNamespace: () => ({
        greet: (n: string) => `Outlook hi ${n}`,
        getData: () => ({ count: 7 }),
      }),
    });
    const bindings: NamespaceBinding[] = [
      { namespace: m365 as unknown as CodeModeNamespace, scope: createTestScope() },
      { namespace: outlook as unknown as CodeModeNamespace, scope: outlook.createNamespace(null as unknown as TestApi) },
    ];
    const result = await executeCodeMode(
      `const a = await M365.greet("a"); const b = await Outlook.greet("b"); return a + "|" + b;`,
      bindings,
    );
    expect(result.kind).toBe("Succeeded");
    expect(result.result).toBe("Hello, a!|Outlook hi b");
  });

  it("rejects namespaceName collision across bindings", async () => {
    const a = createTestNamespaceDescriptor({ id: "a", namespaceName: "Same" });
    const b = createTestNamespaceDescriptor({ id: "b", namespaceName: "Same" });
    const bindings: NamespaceBinding[] = [
      { namespace: a as unknown as CodeModeNamespace, scope: createTestScope() },
      { namespace: b as unknown as CodeModeNamespace, scope: createTestScope() },
    ];
    const result = await executeCodeMode(`return 1;`, bindings);
    expect(result.kind).toBe("Failed");
    expect(result.errorKind).toBe("validationError");
    expect(result.error).toContain("collides");
  });
});
