// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it } from "vitest";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "catalog-projection-generation" });
const { mocks } = fixture;

it("retains the prepared plugin generation during deferred catalog normalization", async () => {
  const config = {};
  mocks.configuredAgentIds = ["default"];
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const owner = await prepareModelRuntimeSnapshot(fixture.agentInput("default", config));
  await owner.loadFullModelCatalog!({ refresh: true, wait: true });
  expect(owner.pluginRegistry).toBeDefined();
  const registries: unknown[] = [];
  mocks.modelRegistry.getAll.mockImplementation(() => {
    registries.push(getPluginRuntimeGenerationRegistry());
    return [];
  });
  await owner.loadFullModelCatalog!({ refresh: true, wait: true });
  expect(registries.length).toBeGreaterThan(0);
  expect(registries.every((registry) => registry === owner.pluginRegistry)).toBe(true);
  expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
});
