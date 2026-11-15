import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { sha256File } from "openclaw/plugin-sdk/file-access-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { resolveCrabboxBinary } from "./crabbox-binary.js";
import { ensureManagedCrabboxBinary, type CrabboxBinary } from "./crabbox-managed-binary.js";

// Closed compatibility for the pristine ce7e7554 legacy consumer that rejected v1
// installationVerified bindings before acquire. Other artifacts retain unknown cleanup.
// Retire this proof once its pending legacy allocations have been settled.
const CE7_SNAPSHOT_BINDING_REJECTION_SHA256 =
  "101454dcb36d087e6c63ec2d556aa1178bfea4dac3f095077677133b2f17aa50";

export function createCrabboxWorkerBinaryResolver(dependencies: {
  openclawRoot: string;
  signal: AbortSignal;
  warn: (message: string) => void;
}) {
  const pathEnv = process.env.PATH;
  const binaries = new Map<string, Promise<CrabboxBinary>>();
  const reportedFallbacks = new Set<string>();
  const legacySnapshotContracts = new Map<string, Promise<boolean>>();
  let defaultCandidate: string | undefined;
  const discoverDefault = () =>
    (defaultCandidate ??= resolveCrabboxBinary({
      openclawRoot: dependencies.openclawRoot,
      pathEnv,
    }));
  return {
    async resolve(this: void, explicit?: string, signal?: AbortSignal): Promise<CrabboxBinary> {
      signal?.throwIfAborted();
      const candidate = explicit ?? discoverDefault();
      // Completed acquisition remains usable by cleanup after provider disposal.
      let resolution = binaries.get(candidate);
      if (!resolution) {
        dependencies.signal.throwIfAborted();
        resolution = ensureManagedCrabboxBinary({
          binary: candidate,
          ...(explicit ? { fallbackBinary: discoverDefault() } : {}),
          signal: dependencies.signal,
        })
          .then((resolved) => {
            dependencies.signal.throwIfAborted();
            return resolved;
          })
          .catch((error: unknown) => {
            binaries.delete(candidate);
            throw error;
          });
        binaries.set(candidate, resolution);
      }
      // Cancelling one waiter must not cancel provider-owned acquisition.
      const resolved = await racePromiseWithAbortSignal(resolution, signal, ({ reason }) =>
        toErrorObject(reason, "Crabbox acquisition aborted"),
      );
      signal?.throwIfAborted();
      // Implicit discovery may populate the cache before an explicit profile consumes it.
      if (explicit && resolved.rejected && !reportedFallbacks.has(candidate)) {
        reportedFallbacks.add(candidate);
        dependencies.warn(resolved.rejected);
      }
      return resolved;
    },
    qualifyLegacySnapshotContract(this: void, binary: string): Promise<boolean> {
      let proof = legacySnapshotContracts.get(binary);
      if (!proof) {
        // The binary resolver owns executable identity for this provider lifetime.
        // Public version strings can be "dev"; never infer a parser contract from them.
        proof = sha256File(binary)
          .then(({ digest }) => digest === CE7_SNAPSHOT_BINDING_REJECTION_SHA256)
          .catch(() => false);
        legacySnapshotContracts.set(binary, proof);
      }
      return proof;
    },
    async settle() {
      await Promise.allSettled([...binaries.values(), ...legacySnapshotContracts.values()]);
    },
  };
}
