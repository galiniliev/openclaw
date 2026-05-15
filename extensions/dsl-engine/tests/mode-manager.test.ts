/**
 * DSL Mode Manager Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DslModeManager } from "../src/mode-manager.js";
import type { DslHydration } from "../src/types.js";

// Create test hydrations
function createTestHydration(id: string, displayName: string): DslHydration {
  return {
    id,
    toolName: `execute_${id}_dsl`,
    displayName,
    namespaceName: id.toUpperCase(),
    createNamespace: (api: any) => api,
    collectionClasses: {},
    getSystemPrompt: (context?: any) => {
      const basePrompt = `${displayName} DSL system prompt`;
      return context ? `${basePrompt} (context: ${JSON.stringify(context)})` : basePrompt;
    },
  };
}

describe("DslModeManager", () => {
  let manager: DslModeManager;
  let hydration1: DslHydration;
  let hydration2: DslHydration;

  beforeEach(() => {
    hydration1 = createTestHydration("test1", "Test 1");
    hydration2 = createTestHydration("test2", "Test 2");
    manager = new DslModeManager([hydration1, hydration2]);
  });

  it("starts with no active mode", () => {
    expect(manager.getActiveMode()).toBeNull();
    expect(manager.getActiveHydration()).toBeNull();
    expect(manager.getActivePrompt()).toBeNull();
  });

  it("activates a mode by id", () => {
    manager.activate("test1");

    const mode = manager.getActiveMode();
    expect(mode).not.toBeNull();
    expect(mode?.hydrationId).toBe("test1");
    expect(mode?.activatedAt).toBeGreaterThan(0);
    expect(mode?.context).toBeUndefined();
  });

  it("activates a mode with context", () => {
    const context = { userId: "123", sessionId: "abc" };
    manager.activate("test1", context);

    const mode = manager.getActiveMode();
    expect(mode?.context).toEqual(context);
  });

  it("switches mode (activate different one)", () => {
    manager.activate("test1");
    const firstMode = manager.getActiveMode();
    expect(firstMode?.hydrationId).toBe("test1");

    // Wait a bit to ensure timestamp changes
    const firstTimestamp = firstMode?.activatedAt ?? 0;

    manager.activate("test2");
    const secondMode = manager.getActiveMode();
    expect(secondMode?.hydrationId).toBe("test2");
    expect(secondMode?.activatedAt).toBeGreaterThanOrEqual(firstTimestamp);
  });

  it("returns hydration for active mode", () => {
    manager.activate("test1");

    const hydration = manager.getActiveHydration();
    expect(hydration).not.toBeNull();
    expect(hydration?.id).toBe("test1");
    expect(hydration?.displayName).toBe("Test 1");
  });

  it("deactivates mode", () => {
    manager.activate("test1");
    expect(manager.getActiveMode()).not.toBeNull();

    manager.deactivate();
    expect(manager.getActiveMode()).toBeNull();
    expect(manager.getActiveHydration()).toBeNull();
    expect(manager.getActivePrompt()).toBeNull();
  });

  it("lists available hydrations", () => {
    const available = manager.listAvailable();
    expect(available).toHaveLength(2);
    expect(available.map(h => h.id)).toEqual(expect.arrayContaining(["test1", "test2"]));
  });

  it("throws on unknown hydration id", () => {
    expect(() => {
      manager.activate("unknown");
    }).toThrow("Unknown hydration ID: unknown");
  });

  it("getActivePrompt returns the hydration's system prompt", () => {
    manager.activate("test1");

    const prompt = manager.getActivePrompt();
    expect(prompt).toBe("Test 1 DSL system prompt");
  });

  it("getActivePrompt passes context to hydration", () => {
    const context = { option: "value" };
    manager.activate("test1", context);

    const prompt = manager.getActivePrompt();
    expect(prompt).toBe('Test 1 DSL system prompt (context: {"option":"value"})');
  });

  it("registers new hydration", () => {
    const hydration3 = createTestHydration("test3", "Test 3");
    manager.register(hydration3);

    const available = manager.listAvailable();
    expect(available).toHaveLength(3);
    expect(available.map(h => h.id)).toContain("test3");

    // Can activate the newly registered hydration
    manager.activate("test3");
    expect(manager.getActiveMode()?.hydrationId).toBe("test3");
  });

  it("returns null hydration when no mode is active", () => {
    expect(manager.getActiveHydration()).toBeNull();
  });

  it("returns null prompt when no mode is active", () => {
    expect(manager.getActivePrompt()).toBeNull();
  });

  it("preserves context when switching modes", () => {
    const context1 = { key: "value1" };
    const context2 = { key: "value2" };

    manager.activate("test1", context1);
    expect(manager.getActiveMode()?.context).toEqual(context1);

    manager.activate("test2", context2);
    expect(manager.getActiveMode()?.context).toEqual(context2);
  });
});
