import { isDeepStrictEqual } from "node:util";
import type { GitHubCredentialReader } from "../../agents/github-credential-reader.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import { readWorkerProjectPreparation } from "./preparation-identity.schema.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { createWorkerProviderIntent } from "./provider-intent.js";
import type { WorkerProviderLifecycleInputOptions } from "./provider-lifecycle.types.js";
import { measureWorkerProvisionPhase } from "./provision-timing.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import type { WorkerEnvironmentRecord } from "./store.js";

type Options = Pick<
  WorkerProviderLifecycleInputOptions,
  "bindPreparedWorkspace" | "projectNamespace" | "getConfig"
> & {
  requireCurrentRecord: (environmentId: string) => WorkerEnvironmentRecord;
  preparedRepositorySource?: ReturnType<
    typeof createWorkerProviderIntent
  >["preparedRepositorySource"];
  takeInitialSnapshot?: ReturnType<typeof createWorkerProviderIntent>["takeInitialSnapshot"];
};

/** Host admission and the node's one-session claim share this binding owner. */
export function createWorkerPreparedWorkspaceBinding(options: Options) {
  const bindPreparedWorkspace = async (
    request: Parameters<NonNullable<Options["bindPreparedWorkspace"]>>[0] & {
      readNativeCredential?: GitHubCredentialReader;
      retainCredentialCleanup?: (revoke: () => Promise<void>) => void;
      admittedIntent?: WorkerProviderPreparedIntent;
    },
  ) => {
    // Repository admission belongs to this host owner, not the node transport payload.
    const { readNativeCredential, retainCredentialCleanup, admittedIntent, ...binding } = request;
    const bind = options.bindPreparedWorkspace;
    const assertCurrent = () => {
      request.signal?.throwIfAborted();
      request.assertCurrent();
      const record = options.requireCurrentRecord(request.environmentId);
      const preparation = readWorkerProjectPreparation(record.profileSnapshot.project);
      if (
        record.state !== "attached" ||
        record.ownerEpoch !== request.ownerEpoch ||
        record.attachedSessionIds.length !== 1 ||
        record.attachedSessionIds[0] !== request.sessionId ||
        record.destroyRequestedAtMs !== null ||
        record.sharedHost !== false ||
        preparation?.key !== request.preparationKey ||
        preparation.cacheKey !== request.cacheKey
      ) {
        throw new Error("Prepared workspace lost its exact attached environment owner");
      }
      return { record, preparation };
    };
    const { record, preparation } = assertCurrent();
    if (!bind) {
      throw new Error("Prepared workspace node transport is unavailable");
    }
    const projectSnapshot = readWorkerProjectSnapshot(record.profileSnapshot.project);
    let repository: Awaited<ReturnType<typeof prepareRepositoryWorkerProjectSource>> | undefined;
    if (projectSnapshot && "source" in projectSnapshot) {
      if (!options.projectNamespace) {
        throw new Error("Prepared repository namespace is unavailable");
      }
      // A ready hit and resumed initial binding must prove current source access too;
      // a snapshot is reusable content, never a substitute for repository authority.
      // The intent retains dispatch-owned admission, not the closed provider operation.
      repository =
        (admittedIntent && options.preparedRepositorySource?.(record.profileId, admittedIntent)) ||
        (await prepareRepositoryWorkerProjectSource({
          expected: projectSnapshot,
          readNativeCredential,
          retainCredentialCleanup,
          namespace: options.projectNamespace,
          getConfig: options.getConfig,
          assertCurrent,
          signal: request.signal,
          knownRecipe: () => ({
            setupRecipe: preparation.setupRecipe,
            recipe: preparation.recipe,
          }),
        }));
      if (
        !isDeepStrictEqual(repository.project, projectSnapshot) ||
        repository.setupRecipe !== preparation.setupRecipe
      ) {
        throw new Error("Prepared repository differs from its admitted source or recipe");
      }
    }
    const assertBindingCurrent = () => {
      assertCurrent();
      repository?.assertCurrent();
    };
    assertBindingCurrent();
    const initialSnapshot = admittedIntent && options.takeInitialSnapshot?.(admittedIntent, record);
    // Both operations retain this attachment owner. Drain the node claim even
    // when source access fails, before the caller can clean up or release it.
    const [prepared, source] = await Promise.allSettled([
      measureWorkerProvisionPhase(record, "workspace.binding.node", () =>
        bind({
          ...binding,
          ...(initialSnapshot ? { initialSnapshot } : {}),
          assertCurrent: assertBindingCurrent,
        }),
      ),
      repository
        ? measureWorkerProvisionPhase(record, "workspace.binding.source", () =>
            repository.revalidate(request.signal),
          )
        : Promise.resolve(),
    ]);
    if (prepared.status === "rejected") {
      throw prepared.reason;
    }
    if (source.status === "rejected") {
      throw source.reason;
    }
    assertBindingCurrent();
    return { ...prepared.value, assertCurrent: assertBindingCurrent };
  };

  return bindPreparedWorkspace;
}
