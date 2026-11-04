import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY } from "../../packages/gateway-protocol/src/system-run-execution-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { loadDatabasePortDescriptorIdentity } from "../infra/database-engine/port-provider-descriptor.js";
import { databasePortProviders } from "../infra/database-engine/port-provider.js";
import {
  resolveDatabaseFamilyEngines,
  isPostgresCompanionSelection,
} from "../infra/database-engine/registry.js";
import type { DatabaseEngineFamily } from "../infra/database-engine/types.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { loadGatewayConfigRevisionProjector } from "./config-revision-token.js";
import {
  listCoreGatewayMethodNames,
  isCoreGatewayRollingRead,
} from "./methods/core-method-policy.js";

/** Compatibility evidence comes from canonical generated descriptors, not directory scans. */
export async function readGatewayRollingCompatibility(config: OpenClawConfig) {
  const engines = resolveDatabaseFamilyEngines(config);
  const selection = getDatabaseEngineSelection();
  if (
    !isPostgresCompanionSelection(selection) ||
    !isPostgresCompanionSelection({ ...selection, effectiveEngines: engines })
  ) {
    throw new Error("Gateway rolling release requires PostgreSQL for every portable store");
  }
  const metadata = getGatewayPluginMetadataSnapshot();
  if (!metadata) {
    throw new Error("Gateway rolling compatibility requires the admitted plugin inventory");
  }
  const descriptors = await Promise.all(
    databasePortProviders
      .filter((provider) => engines[provider.id as DatabaseEngineFamily] === "postgres")
      .map((provider) =>
        loadDatabasePortDescriptorIdentity(provider.id, config, {
          pluginOwners: Object.fromEntries(
            metadata.manifestRegistry.plugins.map((plugin) => [plugin.id, plugin]),
          ),
        }),
      ),
  );
  const projector = await loadGatewayConfigRevisionProjector({}, { existingOnly: true });
  if (!projector.logicalStoreIdentity) {
    throw new Error("Gateway rolling compatibility requires the admitted logical PostgreSQL store");
  }
  const compatibilityDigest = createHash("sha256")
    .update(
      stableStringify({
        version: 1,
        // Reuse the installation's existing keyed revision projection; publishing
        // an ordinary hash of resolved authentication secrets would create an oracle.
        configIdentity: projector.projectResolvedHash(
          createHash("sha256").update(stableStringify(config)).digest("hex"),
        ),
        engines,
        schemas: descriptors,
        plugins: metadata.manifestRegistry.plugins
          .map(({ id, version }) => ({ id, version }))
          .toSorted((a, b) => a.id.localeCompare(b.id)),
        protocol: PROTOCOL_VERSION,
        execution: SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY,
        handoffReads: listCoreGatewayMethodNames().filter(isCoreGatewayRollingRead).toSorted(),
        storeIdentity: projector.logicalStoreIdentity,
      }),
    )
    .digest("hex");
  return { compatibilityDigest, storeIdentity: projector.logicalStoreIdentity };
}
