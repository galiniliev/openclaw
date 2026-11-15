import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { agentPortProvider } from "../infra/database-engine/agent-port.js";
import { logbookPortProvider } from "../infra/database-engine/logbook-port.js";
import type {
  PortDescriptor,
  DatabasePortPluginOwners,
} from "../infra/database-engine/port-descriptor.js";
import {
  loadDatabasePortDescriptor,
  loadDatabasePortDescriptorIdentity,
} from "../infra/database-engine/port-provider-descriptor.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { statePortProvider } from "../infra/database-engine/state-port.js";
import { teamReportsPortProvider } from "../infra/database-engine/team-reports-port.js";
import { workboardPortProvider } from "../infra/database-engine/workboard-port.js";
import { readGatewayRollingCompatibility } from "./rolling-release-compatibility.js";

const config: OpenClawConfig = {
  database: {
    engine: "postgres",
    postgres: { connection: "synthetic-only", schemaPrefix: "fixture" },
  },
};

// mock-isolation: already-admitted inventory, logical store and other owners are
// fixtures; the omitted optional plugin's actual descriptor guard is exercised.
vi.mock("../infra/database-engine/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/database-engine/context.js")>()),
  getDatabaseEngineSelection: () => ({
    effectiveEngines: resolveDatabaseFamilyEngines(config),
    postgres: { connection: "synthetic-only", schemaPrefix: "fixture" },
  }),
}));
vi.mock("../plugins/current-plugin-metadata-state.js", () => ({
  getGatewayPluginMetadataSnapshot: () => ({ manifestRegistry: { plugins: [] } }),
}));
vi.mock("./config-revision-token.js", () => ({
  loadGatewayConfigRevisionProjector: async () => ({
    logicalStoreIdentity: "admitted-postgres-store",
    projectResolvedHash: () => "fixture-keyed-config-identity",
  }),
}));
vi.mock("../plugins/public-surface-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/public-surface-loader.js")>()),
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: () => undefined,
}));

beforeEach(() => {
  for (const provider of [
    statePortProvider,
    agentPortProvider,
    workboardPortProvider,
    logbookPortProvider,
  ]) {
    const descriptor: PortDescriptor = {
      id: provider.id,
      version: 1,
      minimumPostgresVersion: 16,
      tables: [],
      expectedCatalog: [],
      sqlite: "",
      preData: "",
      postData: "",
    };
    vi.spyOn(provider, "loadDescriptor").mockResolvedValue(descriptor);
  }
});
afterEach(() => vi.restoreAllMocks());

it("reads rolling identity with Team Reports uninstalled while refusing its executable port", async () => {
  const identity = await readGatewayRollingCompatibility(config);
  expect(identity.storeIdentity).toBe("admitted-postgres-store");
  expect(identity.compatibilityDigest).toMatch(/^[a-f0-9]{64}$/);
  const schema = await loadDatabasePortDescriptorIdentity("team-reports", config, {
    pluginOwners: {},
  });
  expect(schema.tables.some((table) => table.name === "team_reports_periods")).toBe(true);
  expect(schema.expectedCatalog.length).toBeGreaterThan(0);
  expect(schema).not.toHaveProperty("admit");
  expect(schema).not.toHaveProperty("preData");
  vi.spyOn(teamReportsPortProvider, "loadIdentity").mockResolvedValue({
    ...schema,
    version: schema.version + 1,
  });
  expect((await readGatewayRollingCompatibility(config)).compatibilityDigest).not.toBe(
    identity.compatibilityDigest,
  );
  await expect(
    loadDatabasePortDescriptor("team-reports", config, { pluginOwners: {} }),
  ).rejects.toThrow(
    "Team Reports port API is unavailable; install the matching Team Reports plugin.",
  );
});

it("reads expected identity without turning a missing installed port into executable availability", async () => {
  const owner: DatabasePortPluginOwners[string] = {
    id: "team-reports",
    rootDir: "/isolated/unavailable-team-reports",
    source: "bundled",
    origin: "bundled",
  };
  const owners = { "team-reports": owner };
  expect(
    (await loadDatabasePortDescriptorIdentity("team-reports", config, { pluginOwners: owners })).id,
  ).toBe("team-reports");
  await expect(
    loadDatabasePortDescriptor("team-reports", config, { pluginOwners: owners }),
  ).rejects.toThrow(
    "Team Reports port API is unavailable; install the matching Team Reports plugin.",
  );
});
