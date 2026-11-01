import fsp from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
} from "../../agents/agent-lifecycle-registry.js";
import type { GitHubCredentialReader } from "../../agents/github-credential-reader.js";
import { resolveConfiguredGitHubToolIdentity } from "../../agents/github-tool-identity.js";
import { resolveGitRepositoryPaths } from "../../agents/worktrees/git.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import type { WorkerExecutionMode, WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import type { RetainedWorkspaceAuthority } from "../../state/retained-workspace-authority.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import { assertEnvironmentRecipeSecretsMapped } from "./environment-recipe.js";
import {
  createWorkerPreparationIdentity,
  type WorkerProviderPreparedIntent,
} from "./preparation-identity.js";
import {
  readWorkerProjectPreparation,
  readWorkerPreparation,
  workerPreparationSourceKey,
  type WorkerProjectPreparationIdentity,
  type WorkerRuntimePreparationIdentity,
} from "./preparation-identity.schema.js";
import {
  readWorkerProjectEnvironmentRecipe,
  readWorkerProjectSnapshot,
  workerProjectReplayIdentity,
} from "./project-preparation.js";
import type {
  WorkerProviderIntentOptions,
  WorkerProviderLifecycleOptions,
} from "./provider-lifecycle.types.js";
import type { WorkerProviderRepositorySource } from "./provider-project-preparation.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";
import { createWorkerSessionDiskRetention } from "./retained-lease-lifecycle.js";
import { resumeOriginalRetainedWorkspaceOwner } from "./retained-workspace.js";
import { deriveEnvironmentIntent, workerAllocationProfileSnapshot } from "./service-contract.js";
import {
  configuredWorkerProfileSnapshot,
  requireInheritedWorkerProfileAuthorization,
  requireWorkerProfile,
} from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { boundedWorkerError } from "./worker-error.js";
import { prepareWorkerProjectSnapshot, workerLocalProjectKey } from "./workspace-git-base.js";

export type WorkerProviderIntentPreparationOptions = {
  retentionOwner?: { sessionId: string; sessionKey: string; agentId: string };
  retainedWorkspaceAuthority?: RetainedWorkspaceAuthority;
  inherited?: { providerId: string; profileSnapshot: WorkerProfile };
  machineClass?: string;
  os?: string;
  executionMode?: WorkerExecutionMode;
  projectPath?: string;
  projectCommit?: string;
  /** Refill only: the retained source already admitted an empty committed workspace. */
  emptyWorkspace?: true;
  /** Dedicated runtime capacity without repository contents or read authority. */
  imageReserve?: true;
  repository?: { agentId: string; url: string; ref?: string; baseCommit?: string };
  projectRepository?: RepositoryWorkerProjectSnapshot;
  runSetupScript?: boolean;
  signal?: AbortSignal;
  setupAuthorized?: boolean;
  beforeProvision?: () => void;
  assertCurrent?: () => void;
  readNativeCredential?: GitHubCredentialReader;
  retainCredentialCleanup?: (revoke: () => Promise<void>) => void;
};

export async function failUnallocatedImageIntent(
  options: Pick<WorkerProviderLifecycleOptions, "store" | "move">,
  record: WorkerEnvironmentRecord,
  error: unknown,
  signal: AbortSignal,
): Promise<never> {
  const preparation = readWorkerPreparation(record.profileSnapshot);
  const current = options.store.get(record.environmentId);
  // Reconciliation must not retry a refused image without its live admission.
  // Provisioning rows can already own a paid lease; cancellation owns its teardown.
  if (
    !signal.aborted &&
    preparation &&
    "source" in preparation &&
    preparation.source === "image" &&
    current?.state === "requested" &&
    current.provisionOperationId === record.provisionOperationId &&
    current.ownerEpoch === record.ownerEpoch &&
    current.destroyRequestedAtMs === null
  ) {
    await options.move(current, "failed", { lastError: boundedWorkerError(error) });
  }
  throw error;
}

/** Admits one immutable allocation intent before the provider lifecycle can allocate a lease. */
export function createWorkerProviderIntent(options: WorkerProviderIntentOptions) {
  const preparedIntents = new WeakMap<
    WorkerProviderPreparedIntent,
    { profileId: string; assertCurrent: () => void; repository?: WorkerProviderRepositorySource }
  >();
  const assertPreparedIntentCurrent = (profileId: string, intent: WorkerProviderPreparedIntent) => {
    const prepared = preparedIntents.get(intent);
    if (!prepared || prepared.profileId !== profileId) {
      throw serviceError("invalid_state", "Worker preparation is not owned by this lifecycle");
    }
    prepared.assertCurrent();
  };
  const { store, withLock, providerFor, resumeProvision } = options;
  const requireProfileId = (profileId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (options.isStopping()) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const normalizedProfileId = profileId.trim();
    if (!normalizedProfileId || normalizedProfileId !== profileId) {
      throw serviceError("invalid_profile", "Worker profile id must be non-empty and trimmed");
    }
    return normalizedProfileId;
  };
  const resolveProfile = (
    profileId: string,
    createOptions: WorkerProviderIntentPreparationOptions,
  ) => {
    const normalizedProfileId = requireProfileId(profileId, createOptions.signal);
    const { inherited } = createOptions;
    let provider: WorkerProvider;
    let providerId: string;
    let profileSnapshot: WorkerProfile;
    const profiles = options.getConfig().cloudWorkers?.profiles;
    const configuredProfile =
      profiles && Object.hasOwn(profiles, normalizedProfileId)
        ? profiles[normalizedProfileId]
        : undefined;
    if (inherited) {
      providerId = normalizeCapabilityProviderId(inherited.providerId) ?? inherited.providerId;
      if (providerId !== inherited.providerId) {
        throw serviceError(
          "invalid_profile",
          "Inherited worker provider ID is not in the expected format",
        );
      }
      requireInheritedWorkerProfileAuthorization(
        normalizedProfileId,
        providerId,
        inherited.profileSnapshot.settings,
        configuredProfile?.provider,
      );
      provider = providerFor(providerId);
      const resolvedProviderId = normalizeCapabilityProviderId(provider.id) ?? provider.id;
      if (resolvedProviderId !== providerId) {
        throw serviceError("invalid_profile", "Inherited worker provider identity changed");
      }
      profileSnapshot = inherited.profileSnapshot;
    } else {
      if (!configuredProfile) {
        throw serviceError("profile_not_found", `Unknown worker profile: ${normalizedProfileId}`);
      }
      provider = providerFor(configuredProfile.provider);
      providerId = normalizeCapabilityProviderId(provider.id) ?? provider.id;
      profileSnapshot = configuredWorkerProfileSnapshot(configuredProfile);
    }
    return {
      provider,
      providerId,
      profileSnapshot: structuredClone(
        requireWorkerProfile(workerAllocationProfileSnapshot(profileSnapshot, createOptions)),
      ),
    };
  };

  const isImageProfileCurrent = (
    profileId: string,
    createOptions: WorkerProviderIntentPreparationOptions,
    admitted: ReturnType<typeof resolveProfile>,
    target: WorkerProjectPreparationIdentity["target"],
  ) => {
    const current = resolveProfile(profileId, { ...createOptions, inherited: undefined });
    const profile = requireWorkerProfile(current.profileSnapshot.settings);
    const { provider } = admitted;
    const machineClass =
      typeof admitted.profileSnapshot.machineClass === "string"
        ? admitted.profileSnapshot.machineClass
        : undefined;
    const os =
      typeof admitted.profileSnapshot.os === "string" ? admitted.profileSnapshot.os : undefined;
    return (
      current.provider === provider &&
      current.providerId === admitted.providerId &&
      isDeepStrictEqual(current.profileSnapshot, admitted.profileSnapshot) &&
      provider.requiresNodeEnrollment === true &&
      provider.supportsProjectPreparation?.(profile, machineClass, os) === true &&
      isDeepStrictEqual(provider.resolvePreparationTarget?.(profile, machineClass, os), target)
    );
  };

  const prepareIntent = async (
    profileId: string,
    createOptions: WorkerProviderIntentPreparationOptions = {},
  ): Promise<WorkerProviderPreparedIntent> => {
    const resolved = resolveProfile(profileId, createOptions);
    const { provider, providerId } = resolved;
    const { signal, projectPath } = createOptions;
    let profileSnapshot = resolved.profileSnapshot;
    const runSetupScript =
      profileSnapshot.runSetupScript === false ? false : createOptions.runSetupScript;
    const machineClass =
      typeof profileSnapshot.machineClass === "string" ? profileSnapshot.machineClass : undefined;
    const os = typeof profileSnapshot.os === "string" ? profileSnapshot.os : undefined;
    let repositoryAdmission:
      | Awaited<ReturnType<typeof prepareRepositoryWorkerProjectSource>>
      | undefined;
    const profile = requireWorkerProfile(profileSnapshot.settings);
    let assertImageCurrent: (() => void) | undefined;
    if (
      [
        projectPath,
        createOptions.repository,
        createOptions.projectRepository,
        createOptions.emptyWorkspace,
        createOptions.imageReserve,
      ].filter(Boolean).length > 1
    ) {
      throw serviceError(
        "invalid_profile",
        "Worker preparation must have exactly one project source",
      );
    }
    const supportsProjectPreparation =
      (!profileSnapshot.retention ||
        provider.supportsRetainedProjectImages?.(profile, machineClass, os) === true) &&
      provider.supportsProjectPreparation?.(profile, machineClass, os);
    if (
      (projectPath ||
        createOptions.repository ||
        createOptions.projectRepository ||
        ((createOptions.emptyWorkspace || createOptions.imageReserve) &&
          supportsProjectPreparation)) &&
      (supportsProjectPreparation || provider.runSetupCommand)
    ) {
      if (!options.projectNamespace) {
        throw serviceError("invalid_state", "Worker project preparation namespace is unavailable");
      }
      if (createOptions.repository || createOptions.projectRepository) {
        repositoryAdmission = await prepareRepositoryWorkerProjectSource({
          ...(createOptions.projectRepository
            ? { expected: createOptions.projectRepository }
            : { repository: createOptions.repository! }),
          namespace: options.projectNamespace,
          getConfig: options.getConfig,
          assertCurrent: () => {
            requireProfileId(profileId, signal);
            createOptions.assertCurrent?.();
          },
          readNativeCredential: createOptions.readNativeCredential,
          retainCredentialCleanup: createOptions.retainCredentialCleanup,
          signal,
          knownRecipe: (admittedProject) => {
            for (const record of store.list()) {
              const value = record.profileSnapshot.project;
              if (
                !isRecord(value) ||
                value.key !== admittedProject.key ||
                value.baseCommit !== admittedProject.baseCommit
              ) {
                continue;
              }
              const cached = readWorkerProjectSnapshot(value);
              const preparation = readWorkerProjectPreparation(value);
              if (
                cached &&
                "source" in cached &&
                preparation &&
                preparation.recipe &&
                isDeepStrictEqual(cached, admittedProject)
              ) {
                return {
                  setupRecipe: preparation.setupRecipe,
                  recipe: preparation.recipe,
                };
              }
            }
            return undefined;
          },
        });
      }
      const project =
        createOptions.emptyWorkspace || createOptions.imageReserve
          ? null
          : (repositoryAdmission?.project ??
            (projectPath
              ? await prepareWorkerProjectSnapshot({
                  localPath: projectPath,
                  namespace: options.projectNamespace,
                  baseCommit: createOptions.projectCommit,
                  signal,
                })
              : undefined));
      signal?.throwIfAborted();
      if (project !== undefined) {
        const target = provider.resolvePreparationTarget?.(profile, machineClass, os);
        const recipe = project
          ? "source" in project
            ? repositoryAdmission?.recipe
            : await readWorkerProjectEnvironmentRecipe(project, signal)
          : undefined;
        if (runSetupScript !== false) {
          assertEnvironmentRecipeSecretsMapped(recipe, profile.setupSecrets);
        }
        const setupRecipe = recipe?.identity;
        signal?.throwIfAborted();
        // Recipe execution needs authorization; ordinary checkout alone cannot fill a reserve.
        if (
          target &&
          provider.requiresNodeEnrollment &&
          options.prepareNodeArtifacts &&
          (!setupRecipe ||
            createOptions.runSetupScript === false ||
            createOptions.setupAuthorized === true)
        ) {
          if (createOptions.imageReserve) {
            const admittedTarget = structuredClone(target);
            assertImageCurrent = () => {
              createOptions.assertCurrent?.();
              if (!isImageProfileCurrent(profileId, createOptions, resolved, admittedTarget)) {
                throw serviceError("invalid_profile", "Runtime-only worker preparation changed");
              }
            };
            assertImageCurrent();
          }
          const prepared = await options.prepareNodeArtifacts(profileSnapshot, signal);
          signal?.throwIfAborted();
          assertImageCurrent?.();
          const preparation = createWorkerPreparationIdentity({
            namespace: options.projectNamespace,
            providerId,
            profileId,
            profileSnapshot,
            project: project ?? undefined,
            imageReserve: createOptions.imageReserve,
            target,
            artifacts: prepared.artifacts,
            setupRecipe,
            recipe,
            runSetupScript: createOptions.runSetupScript,
          });
          profileSnapshot = project
            ? { ...resolved.profileSnapshot, project: { ...project, preparation } }
            : {
                ...resolved.profileSnapshot,
                runtimePreparation: {
                  source: createOptions.imageReserve ? "image" : "empty",
                  ...preparation,
                },
              };
        } else if (project && supportsProjectPreparation) {
          profileSnapshot = { ...resolved.profileSnapshot, project };
        }
      }
    }
    if (createOptions.imageReserve && !readWorkerPreparation(profileSnapshot)) {
      throw serviceError(
        "invalid_profile",
        "Worker profile cannot prepare runtime-only image capacity",
      );
    }
    const intent = {
      providerId,
      profileSnapshot,
    };
    preparedIntents.set(intent, {
      profileId,
      // Reusable local artifacts outlive their producer. Repository authority and
      // runtime-only image policy remain live until the allocation or claim.
      assertCurrent: () => {
        repositoryAdmission?.assertCurrent();
        assertImageCurrent?.();
      },
      repository: repositoryAdmission,
    });
    return intent;
  };

  // Retention checks immutable contents against local policy/runtime facts.
  // Unknown observations throw; only confirmed incompatibility returns undefined/false.
  // This closure cannot authorize an allocation or claim private source.
  const prepareRetention = async (
    record: WorkerEnvironmentRecord,
    preparation: WorkerProjectPreparationIdentity | WorkerRuntimePreparationIdentity,
    signal?: AbortSignal,
    onInvalid?: (reason: string) => void,
  ) => {
    const invalid = (reason: string) => {
      onInvalid?.(reason);
      return undefined;
    };
    const project = readWorkerProjectSnapshot(record.profileSnapshot.project);
    if (!options.prepareNodeArtifacts || !options.projectNamespace) {
      return invalid("preparation runtime is unavailable");
    }
    const source = workerPreparationSourceKey(record.profileSnapshot);
    const projectPreparation = "source" in preparation ? undefined : preparation;
    const createOptions: WorkerProviderIntentPreparationOptions = {
      ...(source === "image" ? { imageReserve: true } : {}),
      machineClass:
        typeof record.profileSnapshot.machineClass === "string"
          ? record.profileSnapshot.machineClass
          : undefined,
      os: typeof record.profileSnapshot.os === "string" ? record.profileSnapshot.os : undefined,
      executionMode:
        record.profileSnapshot.executionMode === "worker-turn" ||
        record.profileSnapshot.executionMode === "remote-exec"
          ? record.profileSnapshot.executionMode
          : undefined,
      signal,
    };
    signal?.throwIfAborted();
    const config = options.getConfig();
    const configured = config.cloudWorkers?.profiles?.[record.profileId];
    if (
      !configured ||
      normalizeCapabilityProviderId(configured.provider) !== record.providerId ||
      !isDeepStrictEqual(
        workerAllocationProfileSnapshot(configuredWorkerProfileSnapshot(configured), createOptions),
        workerAllocationProfileSnapshot(record.profileSnapshot, createOptions),
      )
    ) {
      return invalid("configured profile changed");
    }
    const isSourceOwnerCurrent = () => {
      const sourceConfig = options.getConfig();
      if (project && "source" in project) {
        const { agent, identity } = project.source.owner;
        const agentIdentity = resolveConfiguredGitHubToolIdentity({
          config: sourceConfig,
          agentId: agent.agentId,
          scope: "agent",
        });
        const systemIdentity = resolveConfiguredGitHubToolIdentity({
          config: sourceConfig,
          agentId: agent.agentId,
          scope: "system",
        });
        const selected = agentIdentity ?? systemIdentity;
        const selectedSource = agentIdentity ? "agent-override" : "system-configured";
        if (
          selected
            ? identity.source !== selectedSource ||
              !("profileId" in identity) ||
              identity.profileId !== selected.profileId
            : identity.source !== "anonymous" && identity.source !== "system-detected"
        ) {
          return false;
        }
      }
      return true;
    };
    if (!isSourceOwnerCurrent()) {
      return invalid("repository owner changed");
    }
    if (
      project &&
      "source" in project &&
      !(await matchesAgentLifecycleBindingAsync(options.getConfig, project.source.owner.agent))
    ) {
      return invalid("repository agent changed");
    }
    const resolved = resolveProfile(record.profileId, createOptions);
    const { provider, providerId, profileSnapshot } = resolved;
    const profile = requireWorkerProfile(profileSnapshot.settings);
    const target = provider.resolvePreparationTarget?.(
      profile,
      createOptions.machineClass,
      createOptions.os,
    );
    if (
      providerId !== record.providerId ||
      !target ||
      !isDeepStrictEqual(target, preparation.target) ||
      !provider.requiresNodeEnrollment ||
      !provider.supportsProjectPreparation?.(profile, createOptions.machineClass, createOptions.os)
    ) {
      return invalid("provider preparation target changed");
    }
    const prepared = await options.prepareNodeArtifacts(profileSnapshot, signal);
    const isCurrent = () => {
      if (
        source === "image" &&
        !isImageProfileCurrent(record.profileId, createOptions, resolved, preparation.target)
      ) {
        return false;
      }
      return (
        isSourceOwnerCurrent() &&
        (!project ||
          !("source" in project) ||
          matchesAgentLifecycleBinding(options.getConfig(), project.source.owner.agent))
      );
    };
    if (!isCurrent()) {
      return invalid("repository owner changed during retention");
    }
    const observed = createWorkerPreparationIdentity({
      namespace: options.projectNamespace,
      providerId,
      profileId: record.profileId,
      profileSnapshot,
      project,
      imageReserve: createOptions.imageReserve,
      target,
      artifacts: prepared.artifacts,
      setupRecipe: projectPreparation?.setupRecipe,
      recipe: projectPreparation?.recipe,
      runSetupScript: projectPreparation?.runSetupScript,
    });
    return isDeepStrictEqual(project ? observed : { source, ...observed }, preparation)
      ? { isCurrent }
      : invalid("runtime artifacts or preparation identity changed");
  };

  const createWithProfile = async (
    profileId: string,
    idempotencyKey: string,
    createOptions: WorkerProviderIntentPreparationOptions = {},
    admittedIntent?: WorkerProviderPreparedIntent,
  ) => {
    const { machineClass, os, executionMode, projectPath, signal } = createOptions;
    const inherited = createOptions.inherited;
    const normalizedProfileId = requireProfileId(profileId, signal);
    const beforeProvision = (intent?: WorkerProviderPreparedIntent) => () => {
      createOptions.beforeProvision?.();
      if (intent?.profileSnapshot.runtimePreparation?.source === "image") {
        assertPreparedIntentCurrent(profileId, intent);
      }
    };
    const derived = deriveEnvironmentIntent(idempotencyKey);
    const originalDisk = createOptions.retainedWorkspaceAuthority;
    const environmentId = originalDisk?.environmentId ?? derived.environmentId;
    return withLock(environmentId, async () => {
      await store.ready();
      signal?.throwIfAborted();
      if (options.isStopping()) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      let existing = store.get(environmentId);
      if (originalDisk && !existing) {
        throw new Error("Original retained worker owner is unavailable; replacement is refused");
      }
      if (existing) {
        const existingProject = readWorkerProjectSnapshot(existing.profileSnapshot.project);
        if (existingProject && projectPath) {
          if ("source" in existingProject) {
            throw serviceError("invalid_profile", "Idempotency key belongs to another project");
          }
          if (!options.projectNamespace) {
            throw serviceError(
              "invalid_state",
              "Worker project preparation namespace is unavailable",
            );
          }
          // Replay identifies the repository; it retains the already-admitted root and commit.
          const { commonDir } = await resolveGitRepositoryPaths(await fsp.realpath(projectPath), {
            signal,
          });
          signal?.throwIfAborted();
          if (workerLocalProjectKey(options.projectNamespace, commonDir) !== existingProject.key) {
            throw serviceError("invalid_profile", "Idempotency key belongs to another project");
          }
          if (
            createOptions.projectCommit !== undefined &&
            createOptions.projectCommit !== existingProject.baseCommit
          ) {
            throw serviceError(
              "invalid_profile",
              "Idempotency key belongs to another project preparation",
            );
          }
        }
        // Replay retains the captured allocation profile rather than retargeting it to current config.
        const imageReplay = workerPreparationSourceKey(existing.profileSnapshot) === "image";
        if (imageReplay && (projectPath || createOptions.emptyWorkspace)) {
          throw serviceError(
            "invalid_profile",
            "Idempotency key belongs to another project preparation",
          );
        }
        const requested =
          admittedIntent ??
          (createOptions.repository ||
          createOptions.projectRepository ||
          (createOptions.imageReserve && !imageReplay)
            ? await prepareIntent(profileId, createOptions)
            : undefined);
        if (requested) {
          signal?.throwIfAborted();
          assertPreparedIntentCurrent(profileId, requested);
          if (
            !originalDisk &&
            (!isDeepStrictEqual(
              workerProjectReplayIdentity(existing.profileSnapshot.project),
              workerProjectReplayIdentity(requested.profileSnapshot.project),
            ) ||
              !isDeepStrictEqual(
                existing.profileSnapshot.runtimePreparation,
                requested.profileSnapshot.runtimePreparation,
              ))
          ) {
            throw serviceError(
              "invalid_profile",
              "Idempotency key belongs to another project preparation",
            );
          }
        }
        if (
          existing.profileId !== normalizedProfileId ||
          (inherited !== undefined &&
            (existing.providerId !== inherited.providerId ||
              !isDeepStrictEqual(existing.profileSnapshot, {
                ...workerAllocationProfileSnapshot(inherited.profileSnapshot, createOptions),
                ...(existingProject ? { project: existing.profileSnapshot.project } : {}),
                ...(existing.profileSnapshot.runtimePreparation
                  ? { runtimePreparation: existing.profileSnapshot.runtimePreparation }
                  : {}),
              }))) ||
          (inherited === undefined &&
            (existing.profileSnapshot.machineClass !== machineClass ||
              existing.profileSnapshot.os !== os ||
              existing.profileSnapshot.executionMode !== executionMode))
        ) {
          throw serviceError("invalid_profile", "Idempotency key belongs to another profile");
        }
        if (originalDisk) {
          existing = await resumeOriginalRetainedWorkspaceOwner(
            existing,
            originalDisk,
            createOptions.retentionOwner,
            store,
            signal,
            requested ? () => assertPreparedIntentCurrent(profileId, requested) : undefined,
          );
        }
        if (existing.destroyRequestedAtMs !== null) {
          return existing;
        }
        if (!existing.leaseId && ["requested", "provisioning"].includes(existing.state)) {
          return resumeProvision(
            existing,
            undefined,
            signal,
            undefined,
            beforeProvision(requested),
            !originalDisk && requested ? preparedIntents.get(requested)?.repository : undefined,
            originalDisk,
          );
        }
        return existing;
      }
      const admitted =
        admittedIntent ??
        (await prepareIntent(profileId, {
          ...createOptions,
          setupAuthorized:
            createOptions.setupAuthorized ?? createOptions.runSetupScript !== undefined,
        }));
      signal?.throwIfAborted();
      assertPreparedIntentCurrent(profileId, admitted);
      const { providerId, profileSnapshot } = admitted;
      const provider = providerFor(providerId);
      const intent = await store.createIntent(
        {
          environmentId,
          providerId,
          profileId: normalizedProfileId,
          profileSnapshot,
          ...(profileSnapshot.retention
            ? {
                retention: createWorkerSessionDiskRetention({
                  provider,
                  policy:
                    options.getConfig().cloudWorkers?.profiles?.[normalizedProfileId]?.retention,
                  owner: createOptions.retentionOwner,
                  environmentId,
                  provisionOperationId: derived.provisionOperationId,
                }),
              }
            : {}),
          provisionOperationId: derived.provisionOperationId,
        },
        () => {
          signal?.throwIfAborted();
          assertPreparedIntentCurrent(profileId, admitted);
        },
      );
      return resumeProvision(
        intent,
        provider,
        signal,
        undefined,
        beforeProvision(admitted),
        preparedIntents.get(admitted)?.repository,
      );
    });
  };
  return {
    prepareIntent,
    prepareRetention,
    assertPreparedIntentCurrent,
    createWithProfile,
    preparedRepositorySource(profileId: string, intent: WorkerProviderPreparedIntent) {
      assertPreparedIntentCurrent(profileId, intent);
      return preparedIntents.get(intent)?.repository;
    },
  };
}
