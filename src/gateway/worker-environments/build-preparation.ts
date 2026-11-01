import { randomUUID } from "node:crypto";
import type { EnvironmentsPrepareParams } from "../../../packages/gateway-protocol/src/schema/environments.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import type { WorkerExecutionMode } from "../../plugins/types.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { createWorkerProviderLifecycle } from "./provider-lifecycle.js";
import type { WorkerProviderLifecycleInputOptions } from "./provider-lifecycle.types.js";
import {
  deriveEnvironmentIntent,
  type WorkerEnvironmentPreparationAuthority,
} from "./service-contract.js";
import { requireWorkerProfile } from "./service-validation.js";
import { prepareWorkerProjectSnapshot } from "./workspace-git-base.js";

type BuildPreparationOptions = Pick<
  WorkerProviderLifecycleInputOptions,
  "getConfig" | "resolveProvider" | "projectNamespace" | "store"
> & {
  providerLifecycle: Pick<
    ReturnType<typeof createWorkerProviderLifecycle>,
    | "prepareIntent"
    | "assertPreparedIntentCurrent"
    | "providerFor"
    | "resumePrepared"
    | "preparedRepositorySource"
  >;
  signal: AbortSignal;
  now: () => number;
  configuredProfileProviderId: (profileId: string) => string;
  requireProviderExecutionMode: (providerId: string, mode: WorkerExecutionMode) => void;
  schedulePreparedRefill: () => void;
};

export function createWorkerEnvironmentBuildPreparation(options: BuildPreparationOptions) {
  return async (
    request: EnvironmentsPrepareParams,
    authorize?: () => void,
    authority?: WorkerEnvironmentPreparationAuthority,
  ) => {
    const repositoryMode = "repository" in request;
    let open = true;
    const signal =
      repositoryMode && authority?.signal
        ? AbortSignal.any([options.signal, authority.signal])
        : options.signal;
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (!open) {
        throw new Error("Repository preparation request is closed");
      }
      authorize?.();
    };
    try {
      const {
        providerLifecycle,
        now,
        store,
        configuredProfileProviderId,
        requireProviderExecutionMode,
        schedulePreparedRefill,
      } = options;
      signal.throwIfAborted();
      authorize?.();
      const { profileId } = request;
      const providerId = configuredProfileProviderId(profileId);
      const provider = options.resolveProvider(
        normalizeCapabilityProviderId(providerId) ?? providerId,
      );
      const profile = options.getConfig().cloudWorkers!.profiles![profileId]!;
      if (!provider?.supportsProjectPreparation?.(requireWorkerProfile(profile.settings ?? {}))) {
        throw serviceError(
          "invalid_profile",
          "Worker profile does not support project preparation",
        );
      }
      const namespace = options.projectNamespace;
      if (!namespace) {
        throw serviceError("invalid_state", "Worker project preparation namespace is unavailable");
      }
      // A requested target is fixed before Git, credential, or artifact preparation.
      const executionMode =
        request.executionMode ??
        (provider.supportedExecutionModes?.includes("worker-turn") ? "worker-turn" : "remote-exec");
      if (request.executionMode !== undefined) {
        requireProviderExecutionMode(provider.id, request.executionMode);
      }
      let localProject: Awaited<ReturnType<typeof prepareWorkerProjectSnapshot>> = undefined;
      if ("projectPath" in request) {
        try {
          if (!request.projectPath.trim()) {
            throw new Error("Empty project path");
          }
          localProject = await prepareWorkerProjectSnapshot({
            localPath: request.projectPath,
            namespace,
            signal,
          });
        } catch {
          signal.throwIfAborted();
        }
        if (!localProject) {
          throw serviceError(
            "invalid_project",
            "Project must be an accessible local Git checkout root with committed files",
          );
        }
      }
      authorize?.();
      const intent = await providerLifecycle.prepareIntent(profileId, {
        ...(localProject
          ? { projectPath: localProject.root, projectCommit: localProject.baseCommit }
          : {}),
        ...("repository" in request
          ? {
              repository: request.repository,
              assertCurrent,
              readNativeCredential: authority?.readNativeCredential,
              retainCredentialCleanup: authority?.retainCredentialCleanup,
            }
          : {}),
        executionMode,
        setupAuthorized: true,
        signal,
      });
      signal.throwIfAborted();
      authorize?.();
      providerLifecycle.assertPreparedIntentCurrent(profileId, intent);
      const project = readWorkerProjectSnapshot(intent.profileSnapshot.project);
      if (!project) {
        throw serviceError(
          "invalid_project",
          "Worker preparation did not retain its admitted project source",
        );
      }
      const preparation =
        intent.profileSnapshot.runtimePreparation ?? intent.profileSnapshot.project?.preparation;
      requireProviderExecutionMode(intent.providerId, executionMode);
      const timeout = providerLifecycle
        .providerFor(intent.providerId)
        .resolvePreparedIdleTimeoutMs?.(requireWorkerProfile(intent.profileSnapshot.settings));
      if (!preparation || !Number.isSafeInteger(timeout) || !timeout || timeout <= 0) {
        throw serviceError(
          "invalid_profile",
          "Worker profile does not support prepared workers with an idle timeout",
        );
      }
      const demandAtMs = now();
      const identity = deriveEnvironmentIntent(`prepared:${randomUUID()}`);
      const record = await store.ensurePreparedIntent({
        intent: {
          ...identity,
          providerId: intent.providerId,
          profileId,
          profileSnapshot: intent.profileSnapshot,
          preparation: {
            purpose: "build",
            key: preparation.key,
            demandAtMs,
            expiresAtMs: demandAtMs + timeout,
          },
        },
        projectKey: project.key,
        target: profile.readyWorkers ?? 1,
        maxTotal: options.getConfig().cloudWorkers?.preparedPool?.maxTotal ?? 4,
        assertCurrent: () => {
          signal.throwIfAborted();
          authorize?.();
          providerLifecycle.assertPreparedIntentCurrent(profileId, intent);
        },
      });
      if (!record) {
        throw serviceError(
          "capacity",
          "Prepared worker pool is full; destroy an unused worker or wait for cleanup, then retry",
        );
      }
      const result = {
        environmentId: record.environmentId,
        preparationKey: preparation.key,
        cacheKey: preparation.cacheKey,
        reused: record.environmentId !== identity.environmentId,
      };
      if (repositoryMode) {
        // No caller-bound reader enters background refill. The existing lifecycle
        // lock owns effects and settlement while this request remains current.
        const completed = await providerLifecycle.resumePrepared(
          record,
          signal,
          assertCurrent,
          providerLifecycle.preparedRepositorySource(profileId, intent),
        );
        assertCurrent();
        if (completed?.state !== "ready" || completed.destroyRequestedAtMs !== null) {
          throw serviceError(
            "bootstrap_failure",
            completed?.lastError ??
              "Repository preparation has no final ready receipt; inspect its recorded operation before retrying",
          );
        }
        return { ...result, status: "ready" as const };
      }
      schedulePreparedRefill();
      return result;
    } finally {
      open = false;
    }
  };
}
