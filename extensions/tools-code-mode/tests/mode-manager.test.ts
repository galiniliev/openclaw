/**
 * Code Mode Session Manager Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CodeModeSessionManager } from "../src/mode-manager.js";
import type { CodeModeHydration } from "../src/types.js";

// Create test hydrations
function createTestHydration(id: string, displayName: string): CodeModeHydration {
  return {
    id,
    toolName: `execute_${id}_code`,
    displayName,
    namespaceName: id.toUpperCase(),
    createNamespace: (api: any) => api,
    collectionClasses: {},
    getSystemPrompt: (context?: any) => {
      const basePrompt = `${displayName} code mode system prompt`;
      return context ? `${basePrompt} (context: ${JSON.stringify(context)})` : basePrompt;
    },
  };
}

describe("CodeModeSessionManager", () => {
  let manager: CodeModeSessionManager;
  let hydration1: CodeModeHydration;
  let hydration2: CodeModeHydration;

  beforeEach(() => {
    hydration1 = createTestHydration("test1", "Test 1");
    hydration2 = createTestHydration("test2", "Test 2");
    manager = new CodeModeSessionManager([hydration1, hydration2]);
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
    expect(prompt).toBe("Test 1 code mode system prompt");
  });

  it("getActivePrompt passes context to hydration", () => {
    const context = { option: "value" };
    manager.activate("test1", context);

    const prompt = manager.getActivePrompt();
    expect(prompt).toBe('Test 1 code mode system prompt (context: {"option":"value"})');
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

  it("tracks active modes independently by session key", () => {
    manager.activate("test1", { value: 1 }, "agent:one");
    manager.activate("test2", { value: 2 }, "agent:two");

    expect(manager.getActiveMode("agent:one")?.hydrationId).toBe("test1");
    expect(manager.getActiveMode("agent:two")?.hydrationId).toBe("test2");
    expect(manager.getActivePrompt("agent:one")).toBe('Test 1 code mode system prompt (context: {"value":1})');
    expect(manager.getActivePrompt("agent:two")).toBe('Test 2 code mode system prompt (context: {"value":2})');
  });

  it("deactivates only the selected session key", () => {
    manager.activate("test1", undefined, "agent:one");
    manager.activate("test2", undefined, "agent:two");

    manager.deactivate("agent:one");

    expect(manager.getActiveMode("agent:one")).toBeNull();
    expect(manager.getActiveMode("agent:two")?.hydrationId).toBe("test2");
  });
});
