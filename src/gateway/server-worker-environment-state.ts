import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { GatewayRollingStartup } from "./rolling-startup.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./worker-environments/device-provider.js";

export async function loadGatewayWorkerEnvironmentStartupState(
  rollingStartup?: GatewayRollingStartup,
) {
  const [{ createWorkerEnvironmentStore }, { createWorkerSessionPlacementStore }] =
    await Promise.all([
      import("./worker-environments/store.js"),
      import("./worker-environments/placement-store.js"),
    ]);
  const store = await createWorkerEnvironmentStore(rollingStartup ? { readOnlyStartup: true } : {});
  rollingStartup?.defer(() => store.initializeAfterReadOnlyStartup());
  const placementStore = createWorkerSessionPlacementStore();
  const records = store.list();
  const durableProviderIds = uniqueStrings(
    records.flatMap((record) =>
      record.state === "destroyed" || record.state === "failed" || record.state === "orphaned"
        ? []
        : record.providerId === DEVICE_WORKER_PROVIDER_ID
          ? []
          : [record.providerId],
    ),
  );
  const listDurableProviderIds = () =>
    uniqueStrings(
      store
        .listForReconcile()
        .filter((record) => record.providerId !== DEVICE_WORKER_PROVIDER_ID)
        .map((record) => record.providerId),
    );
  return {
    durableProviderIds,
    listDurableProviderIds,
    store,
    placementStore,
  };
}
