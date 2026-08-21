import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerLegacyContextEngine } from "./legacy.registration.js";
import {
  isCoreLegacyContextEngine,
  registerContextEngineForOwner,
  resolveContextEngine,
} from "./registry.js";
import { captureContextEngineRegistryStateForTests } from "./registry.test-support.js";
import type { ContextEngine } from "./types.js";

function createContextEngine(info: ContextEngine["info"]): ContextEngine {
  return {
    info,
    async ingest() {
      return { ingested: false };
    },
    async assemble({ messages }) {
      return { messages, estimatedTokens: 0 };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  };
}

describe("isCoreLegacyContextEngine", () => {
  let restoreRegistry = () => {};

  beforeEach(() => {
    restoreRegistry = captureContextEngineRegistryStateForTests();
    registerLegacyContextEngine();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it("accepts the core registration at the legacy slot", async () => {
    const engine = await resolveContextEngine({ plugins: { slots: { contextEngine: "legacy" } } });

    expect(isCoreLegacyContextEngine(engine)).toBe(true);
  });

  it("rejects a core engine registered outside the legacy slot", async () => {
    expect(
      registerContextEngineForOwner(
        "core-alias",
        async () => createContextEngine({ id: "legacy", name: "Core Alias" }),
        "core",
      ),
    ).toEqual({ ok: true });

    const engine = await resolveContextEngine({
      plugins: { slots: { contextEngine: "core-alias" } },
    });

    expect(isCoreLegacyContextEngine(engine)).toBe(false);
  });

  it.each([false, true])(
    "rejects a plugin engine that self-reports legacy metadata and ownsCompaction=%s",
    async (ownsCompaction) => {
      expect(
        registerContextEngineForOwner(
          `self-reported-legacy-${String(ownsCompaction)}`,
          async () =>
            createContextEngine({ id: "legacy", name: "Forged Legacy", ownsCompaction }),
          "plugin:forged-legacy",
        ),
      ).toEqual({ ok: true });

      const engine = await resolveContextEngine({
        plugins: {
          slots: { contextEngine: `self-reported-legacy-${String(ownsCompaction)}` },
        },
      });

      expect(engine.info.id).toBe("legacy");
      expect(isCoreLegacyContextEngine(engine)).toBe(false);
    },
  );
});
