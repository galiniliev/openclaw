import { isDeepStrictEqual } from "node:util";
import {
  WorkerProviderError,
  type WorkerProfile,
  type WorkerProvider,
} from "openclaw/plugin-sdk/plugin-entry";
import { reportCrabboxSnapshotPhase } from "./crabbox-provision-timing.js";
import {
  prepareCrabboxAzureSnapshotContext,
  type AzureSandboxSnapshotContext,
} from "./crabbox-worker-azure-snapshot.js";
import { type LeaseCommandContext, stopCrabboxLease } from "./crabbox-worker-command.js";
import { createCrabboxHeartbeatManager } from "./crabbox-worker-heartbeat.js";
import type { ParsedInspect } from "./crabbox-worker-inspect.js";
import {
  prepareCrabboxCaptureLifetime,
  createCrabboxProviderLeaseLifecycle,
  resolveCrabboxLeaseContext,
} from "./crabbox-worker-lifetime.js";
import { createCrabboxMachineOptionsResolver } from "./crabbox-worker-machine-options.js";
import { collectCrabboxNodeEnrollmentEvidence } from "./crabbox-worker-node-enrollment-diagnostics.js";
import {
  createCrabboxNodeEnrollmentSetup,
  type CrabboxWorkerNodeEnrollment,
} from "./crabbox-worker-node-enrollment.js";
import { createCrabboxNodeResumer } from "./crabbox-worker-node-resume.js";
import {
  assertAwsWorkerHasNoInstanceProfile,
  assertHetznerDesktopHasManagedCoordinator,
} from "./crabbox-worker-preflight.js";
import {
  CRABBOX_WORKER_PROVIDER_ID,
  operationLeaseId,
  operationSlug,
  parseCrabboxProfile,
  parseCrabboxCleanupProfile,
  resolveCrabboxProvisionProfile,
  resolveCrabboxProfileCommandEnv,
  resolveCrabboxPreparationTarget,
  resolveCrabboxPreparedIdleTimeoutMs,
  supportsCrabboxProjectPreparation,
} from "./crabbox-worker-profile.js";
import {
  prepareCrabboxSnapshotVerifierInput,
  prepareCrabboxProjectFiles,
  prepareCrabboxWorkerRuntime,
} from "./crabbox-worker-project.js";
import { createCrabboxWorkerBinaryResolver } from "./crabbox-worker-provider-binary.js";
import {
  createCrabboxProvisionAuthority,
  prepareCrabboxProvisionProfile,
  failProvisionAfterCleanup,
  inspectWithContext,
  isNonRunnableState,
  prepareProvisionDesktop,
  remainingProvisionTimeout,
  runProvisionWarmup,
  runProvisionSetup,
  waitForProvisionReady,
} from "./crabbox-worker-provision-commands.js";
import {
  createCrabboxRetainedLeaseOperations,
  createCrabboxRetentionCapabilityReader,
} from "./crabbox-worker-retention.js";
import {
  assertCrabboxSetupEgressSupport,
  createCrabboxSetupCommandRunner,
} from "./crabbox-worker-setup-egress.js";
import {
  createCrabboxSnapshotActions,
  resolveCrabboxCheckpointBinaries,
  type CrabboxSnapshotActions,
} from "./crabbox-worker-snapshot-actions.js";
import {
  countCrabboxProvisionSetupPhases,
  CRABBOX_PROJECT_PREPARATION_TIMEOUT_MS,
  CRABBOX_SETUP_TIMEOUT_MS,
  resolveCrabboxDestroyTimeoutMs,
  resolveCrabboxLifecycleTimeoutMs,
  resolveCrabboxNodeEnrollmentTimeoutMs,
  resolveCrabboxProvisionBaseTimeoutMs,
  resolveCrabboxProvisionCallTimeoutMs,
  resolveCrabboxWarmImageCaptureTimeoutMs,
} from "./crabbox-worker-timeouts.js";
import { loadCrabboxWorkerWallpaperBase64 } from "./crabbox-worker-wallpaper.js";
import type { CrabboxWarmImagePolicy } from "./crabbox-worker-warm-image-policy.js";
import type { CrabboxState } from "./crabbox-worker-warm-image-store.js";
import { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";

type CrabboxWorkerProviderDependencies = {
  openclawRoot?: string;
  wallpaperPath: string;
  snapshotHelperPath?: string;
  state: CrabboxState;
  warn?: (message: string) => void;
  info?: (message: string) => void;
  warmImagePolicy?: CrabboxWarmImagePolicy;
};

export function createCrabboxWorkerProvider(
  dependencies: CrabboxWorkerProviderDependencies,
): WorkerProvider & { dispose: () => Promise<void>; images: CrabboxSnapshotActions } {
  const wallpaperBase64 = loadCrabboxWorkerWallpaperBase64(dependencies.wallpaperPath);
  const warn = dependencies.warn ?? (() => {});
  const openclawRoot = dependencies.openclawRoot ?? process.cwd();
  const heartbeats = createCrabboxHeartbeatManager({
    warn,
  });
  const providerAbort = new AbortController();
  const binaryResolver = createCrabboxWorkerBinaryResolver({
    openclawRoot,
    signal: providerAbort.signal,
    warn,
  });
  const resolveBinary = binaryResolver.resolve;
  const retainedLease = createCrabboxRetainedLeaseOperations(
    resolveBinary,
    (context) => warmImages.release(context),
    (context) => warmImages.releaseRejectedSnapshot(context),
  );
  const requireRetentionCapability = createCrabboxRetentionCapabilityReader();
  const machineOptions = createCrabboxMachineOptionsResolver({
    resolveBinary: async (...args) => (await resolveBinary(...args)).binary,
    warn,
  });
  const activeProvisions = new Set<{ leaseId: string }>();
  const warmImages = createCrabboxWarmImageManager({
    isLeaseActive: (leaseId) => {
      for (const owner of activeProvisions) {
        if (owner.leaseId === leaseId) {
          return true;
        }
      }
      return false;
    },
    state: dependencies.state,
    qualifyLegacySnapshotContract: binaryResolver.qualifyLegacySnapshotContract,
    snapshotHelperPath: dependencies.snapshotHelperPath,
    warn,
    info: dependencies.info,
    policy: dependencies.warmImagePolicy,
    prepareCapture: async (context) => {
      heartbeats.start({ ...context.profile, ...context });
      return await prepareCrabboxCaptureLifetime(context, {
        observe: (inspected) =>
          heartbeats.start({
            ...context.profile,
            ...context,
            lifetime: inspected.lifetime,
          }),
      });
    },
  });
  let maintenanceInFlight: Promise<void> | undefined;
  const resolveMaintenanceBinaries = (
    profiles: readonly Parameters<typeof parseCrabboxProfile>[0][],
    signal: AbortSignal,
  ) =>
    resolveCrabboxCheckpointBinaries({
      profiles,
      signal,
      resolveBinary: async (...args) => (await resolveBinary(...args)).binary,
      warn,
    });
  const snapshots = createCrabboxSnapshotActions({
    manager: warmImages,
    signal: providerAbort.signal,
    resolveBinaries: resolveMaintenanceBinaries,
  });
  const stopLease = async (
    context: LeaseCommandContext,
    onCleanupAccepted?: () => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    await heartbeats.stop(context.id);
    // Cleanup has its own deadline. Confirmed stop or absence releases allocation/image ownership.
    await stopCrabboxLease({
      ...context,
      warn,
      onCleanupAccepted,
      signal,
    });
    await warmImages.release({ ...context, signal });
  };
  const resolveLeaseContext = (lease: Parameters<WorkerProvider["inspect"]>[0]) =>
    resolveCrabboxLeaseContext(lease, resolveBinary);

  const resolveAllocation: WorkerProvider["resolveAllocation"] = async (_profile, operationId) => ({
    leaseId: operationLeaseId(operationId),
    sharedHost: false,
  });

  const prepareProvision: NonNullable<WorkerProvider["prepareProvision"]> = async (
    profile: WorkerProfile,
    operationId: string,
    options: Parameters<WorkerProvider["provision"]>[2],
  ) => {
    const { signal, assertCurrent } = createCrabboxProvisionAuthority(options);
    const {
      parsed,
      nodeRuntimeIdentity,
      warmupTimeoutMs,
      protectedSetup,
      project,
      projectImage,
      preparationSignal,
    } = prepareCrabboxProvisionProfile(profile, options, providerAbort.signal);
    const allocation = await resolveAllocation(profile, operationId);
    signal?.throwIfAborted();
    const { binary, version: cliVersion } = await resolveBinary(parsed.binary, preparationSignal);
    let azureSnapshot: AzureSandboxSnapshotContext | undefined;
    if (parsed.sdkPython) {
      const helperPath = dependencies.snapshotHelperPath;
      if (!helperPath) {
        throw new WorkerProviderError(
          "Snapshot helper is missing; reinstall the qualified Crabbox provider package",
        );
      }
      azureSnapshot = await prepareCrabboxAzureSnapshotContext({
        binary,
        profile: parsed,
        helperPath,
        signal: preparationSignal,
        assertCurrent,
      });
    }
    if (azureSnapshot) {
      parsed.azureSandboxScope = azureSnapshot.providerScope;
    }
    if (options?.retention) {
      await requireRetentionCapability(binary, preparationSignal);
      assertCurrent();
    }
    preparationSignal?.throwIfAborted();
    if (protectedSetup) {
      await assertCrabboxSetupEgressSupport({
        binary,
        target: parsed.target,
        assertCurrent,
        signal: preparationSignal,
        projectPrepared: project ? Boolean(project.preparation) : undefined,
      });
    }
    const deadline = performance.now() + resolveCrabboxProvisionBaseTimeoutMs(parsed);
    const nodeBootstrapTimeoutMs = resolveCrabboxNodeEnrollmentTimeoutMs(
      options?.nodeBootstrapTimeoutMs,
    );
    const setupDeadline =
      deadline +
      countCrabboxProvisionSetupPhases(parsed) * CRABBOX_SETUP_TIMEOUT_MS +
      2 * nodeBootstrapTimeoutMs +
      (project
        ? CRABBOX_PROJECT_PREPARATION_TIMEOUT_MS +
          resolveCrabboxWarmImageCaptureTimeoutMs(parsed.provider)
        : 0);
    const context = {
      ...warmImages.startContext(binary, parsed.provider, options, Boolean(project)),
      // An admitted private disk predates this setup attempt; only explicit
      // retained retirement owns its deletion, even if enrollment now fails.
      preserveRetainedLease: Boolean(options?.retention?.receipt),
      providerEnv: resolveCrabboxProfileCommandEnv(parsed),
      azureSnapshot,
      timingIdentity: { operationId, environmentId: options?.environmentId },
    };
    const leaseId = allocation.leaseId;
    if (parsed.desktop && parsed.provider === "hetzner") {
      await assertHetznerDesktopHasManagedCoordinator({ binary, signal });
    }
    if (parsed.provider === "aws") {
      await assertAwsWorkerHasNoInstanceProfile({ binary, signal });
    }

    const provision = async () => {
      assertCurrent();
      // Completed setup can survive a crash before its capture requirement returns.
      // Sample before allocate creates the first-call record; enrolled replay stays closed.
      const priorAllocation = project?.preparation && (await warmImages.lookupLease(leaseId));
      const preparedReplay = priorAllocation && priorAllocation.phase !== "enrolled";
      const allocationContext = {
        ...context,
        id: leaseId,
        profile: parsed,
        timingIdentity: { operationId, environmentId: options?.environmentId },
        signal: preparationSignal,
        slug: operationSlug(operationId),
        timeoutMs: () => remainingProvisionTimeout(deadline, warmupTimeoutMs),
      };
      const allocationChoice =
        options?.retention && !parsed.sdkPython
          ? await runProvisionWarmup({ ...allocationContext, retention: options.retention })
          : await warmImages.allocate({
              ...allocationContext,
              profileId: options?.profileId,
              nodeRuntimeIdentity,
              ...(options?.retention ? { retention: options.retention } : {}),
              ...(projectImage
                ? {
                    projectKey: projectImage.key,
                    ...(project ? { projectLabel: project.label, projectRoot: project.root } : {}),
                  }
                : {}),
              ...(projectImage?.preparation ? { preparation: projectImage.preparation } : {}),
              assertCurrent,
            });
      const isFork = allocationChoice.kind === "checkpoint";
      let provisioned = false;
      try {
        let inspected: ParsedInspect | undefined;
        try {
          inspected = await inspectWithContext({
            ...context,
            id: leaseId,
            timeoutMs: remainingProvisionTimeout(
              deadline,
              resolveCrabboxLifecycleTimeoutMs(parsed.provider),
            ),
            waitForReady: parsed.provider === "machine0",
            signal: preparationSignal,
          });
          signal?.throwIfAborted();
        } catch (error) {
          signal?.throwIfAborted();
          // Transport failure after warmup is indeterminate; preserve the lease for durable replay.
          if (error instanceof WorkerProviderError) {
            return await failProvisionAfterCleanup({ ...context, id: leaseId, stopLease }, error);
          }
          throw error;
        }
        if (!inspected) {
          throw new Error("Crabbox warmup lease was not found during inspection");
        }
        // The provider owns idle protection as soon as allocation is known,
        // including readiness, transfer, enrollment, and admitted capture.
        if (!options?.retention) {
          heartbeats.start({
            binary,
            providerEnv: context.providerEnv,
            id: leaseId,
            provider: parsed.provider,
            heartbeatIntervalMs: parsed.heartbeatIntervalMs,
            heartbeatTimeoutMs: parsed.heartbeatTimeoutMs,
            idleTimeout: parsed.idleTimeout,
            lifetime: inspected.lifetime,
          });
        }
        const inspectedParams = {
          ...context,
          timingIdentity: { operationId, environmentId: options?.environmentId },
          deadline,
          inspect: inspected,
          profile: parsed,
          stopLease,
          signal: preparationSignal,
          assertCurrent,
        };
        if (isNonRunnableState(inspected.state)) {
          return await failProvisionAfterCleanup(
            { ...inspectedParams, id: leaseId },
            new WorkerProviderError(
              `Crabbox warmup lease entered a terminal state${inspected.failureError ? `: ${inspected.failureError}` : ""}`,
            ),
          );
        }
        const readinessStarted = performance.now();
        let readinessOutcome: "success" | "failed" = "failed";
        try {
          inspectedParams.inspect = await waitForProvisionReady(inspectedParams);
          readinessOutcome = "success";
        } finally {
          if (azureSnapshot && isFork) {
            reportCrabboxSnapshotPhase(context.timingIdentity, "snapshot.fork.readiness", {
              durationMs: performance.now() - readinessStarted,
              outcome: readinessOutcome,
              nonAdditive: true,
            });
          }
        }
        inspectedParams.deadline = setupDeadline;
        // The image key covers the exact setup script, so a fork already carries its results.
        if (parsed.setup && !isFork) {
          await runProvisionSetup({
            ...inspectedParams,
            phase: "profile setup",
            setup: parsed.setup,
          });
          // Setup may restart SSH; refresh its endpoint and security attestation before bootstrap.
          inspectedParams.inspect = await waitForProvisionReady({
            ...inspectedParams,
            refresh: true,
          });
        }
        const desktop = await prepareProvisionDesktop({
          ...inspectedParams,
          wallpaperBase64,
          prepareBeforeEnrollment: Boolean(project),
        });
        const enrolled = project && (await warmImages.lookupLease(leaseId))?.phase === "enrolled";
        // New clean forks use canonical preparation to reconcile the requested
        // revision. An enrolled replay must only inspect its existing workspace.
        const inspectPrepared = project?.preparation && enrolled;
        if (project && inspectPrepared) {
          // Enrolled replays verify completion without setup, upload, or private capture.
          try {
            await prepareCrabboxProjectFiles({
              ...context,
              id: leaseId,
              project,
              inspectPrepared: true,
              signal: preparationSignal,
              timeoutMs: () => remainingProvisionTimeout(setupDeadline, CRABBOX_SETUP_TIMEOUT_MS),
            });
          } catch (error) {
            preparationSignal?.throwIfAborted();
            return await failProvisionAfterCleanup({ ...context, id: leaseId, stopLease }, error);
          }
        }
        let runtimePrepared = false;
        let runtimeSetupFailed = false;
        const prepareRuntime = async () => {
          const plan = await prepareCrabboxWorkerRuntime({
            context: inspectedParams,
            prepareNodeRuntime: options?.prepareNodeRuntime,
            leaseId,
            preparationSignal,
            assertCurrent,
            onSetupFailure: () => {
              runtimeSetupFailed = true;
            },
          });
          return {
            timeoutMs: plan.timeoutMs,
            verifySnapshot: () =>
              prepareCrabboxSnapshotVerifierInput({
                ...context,
                id: leaseId,
                project,
                signal: preparationSignal,
                assertCurrent,
                currentRuntime: plan.snapshotRuntime,
              }),
            run: async (scrubScript?: string) => {
              await plan.run(scrubScript);
              runtimePrepared = true;
            },
          };
        };
        if (project && !inspectPrepared && !enrolled) {
          let captured: boolean | "source-running";
          try {
            const preparedProject = await prepareCrabboxProjectFiles({
              ...context,
              id: leaseId,
              project,
              signal: preparationSignal,
              timeoutMs: () => remainingProvisionTimeout(setupDeadline, CRABBOX_SETUP_TIMEOUT_MS),
              recordRecipePreparation: (metadata) =>
                warmImages.noteRecipePreparation(leaseId, metadata, () => {
                  preparationSignal?.throwIfAborted();
                  assertCurrent();
                }),
              setupSecrets: parsed.setupSecrets,
              setupInitializer: parsed.setupInitializer,
              assertCurrent,
            });
            assertCurrent();
            await warmImages.markPrepared(
              leaseId,
              project.baseCommit,
              () => {
                preparationSignal?.throwIfAborted();
                assertCurrent();
              },
              preparedProject,
            );
            captured =
              !parsed.warmImage || preparedProject?.captureSkipped
                ? false
                : await warmImages.capture(
                    {
                      ...context,
                      id: leaseId,
                      profile: parsed,
                      cliVersion,
                      signal: preparationSignal,
                      assertCurrent,
                      projectCaptureRequired:
                        preparedProject?.captureRequired || preparedReplay ? true : undefined,
                      projectCaptureReplay: preparedReplay ? true : undefined,
                      ...(isFork ? { forkedCheckpointId: allocationChoice.checkpointId } : {}),
                    },
                    prepareRuntime,
                  );
          } catch (error) {
            // The runtime grant has a separate abort signal; revalidate the project owner.
            signal?.throwIfAborted();
            assertCurrent();
            if (runtimeSetupFailed) {
              throw error;
            }
            return await failProvisionAfterCleanup({ ...context, id: leaseId, stopLease }, error);
          }
          // Only native capture can have restarted the source since preparation returned.
          if (captured === true) {
            inspectedParams.inspect = await waitForProvisionReady({
              ...inspectedParams,
              refresh: true,
            });
          }
        }
        signal?.throwIfAborted();
        const beginNodeEnrollment = options?.beginNodeEnrollment;
        if (!beginNodeEnrollment) {
          return await failProvisionAfterCleanup(
            { ...inspectedParams, id: leaseId },
            new Error("Crabbox worker node enrollment is unavailable"),
          );
        }
        let enrollment: CrabboxWorkerNodeEnrollment;
        try {
          // A fork of an image captured for this exact runtime already holds it. Enrollment still
          // verifies the runtime, and the node fetches a missing worker bundle from the Gateway.
          const forkHasRuntime =
            isFork &&
            isDeepStrictEqual(
              await warmImages.checkpointRuntimeIdentity(allocationChoice.checkpointId),
              nodeRuntimeIdentity,
            );
          if (
            options?.prepareNodeRuntime &&
            !runtimePrepared &&
            priorAllocation?.phase !== "enrolled" &&
            !forkHasRuntime &&
            (!project || (!parsed.warmImage && Boolean(parsed.azureSandboxDiskId)) || isFork)
          ) {
            await (await prepareRuntime()).run();
          }
          enrollment = await beginNodeEnrollment();
          signal?.throwIfAborted();
        } catch (error) {
          signal?.throwIfAborted();
          if (runtimeSetupFailed) {
            throw error;
          }
          if (error instanceof Error && error.name === "AbortError") {
            throw error;
          }
          return await failProvisionAfterCleanup({ ...inspectedParams, id: leaseId }, error);
        }
        const nodeEnrollmentSetup = createCrabboxNodeEnrollmentSetup({
          enrollment,
          desktop: parsed.desktop,
          desktopSetup: project ? undefined : desktop?.setup,
          target: parsed.target,
          leaseId,
        });
        const enrollmentSignal =
          preparationSignal && enrollment.signal
            ? AbortSignal.any([preparationSignal, enrollment.signal])
            : (preparationSignal ?? enrollment.signal);
        // These owned scripts do not restart SSH; authenticated enrollment proves node readiness.
        await runProvisionSetup({
          ...inspectedParams,
          phase: "node enrollment setup",
          signal: enrollmentSignal,
          setup: nodeEnrollmentSetup.command,
          // Combine the existing phase budgets; desktop work starts after node launch.
          timeoutMs:
            resolveCrabboxNodeEnrollmentTimeoutMs(enrollment.bootstrapTimeoutMs) +
            (desktop && !project ? CRABBOX_SETUP_TIMEOUT_MS : 0),
          forwardedEnv: nodeEnrollmentSetup.forwardedEnv,
        });
        let deviceId: string;
        try {
          deviceId = await enrollment.waitForDeviceId();
          signal?.throwIfAborted();
        } catch (error) {
          signal?.throwIfAborted();
          // Gateway shutdown cancels its wait, not the fixed operation-owned provider lease.
          if (enrollment.signal?.aborted) {
            throw error;
          }
          const leaseContext = { ...inspectedParams, id: leaseId };
          // Read node evidence before cleanup destroys its only copy on the leased machine.
          const evidence = await collectCrabboxNodeEnrollmentEvidence({
            ...leaseContext,
            target: parsed.target,
            ...(enrollmentSignal ? { signal: enrollmentSignal } : {}),
          });
          signal?.throwIfAborted();
          enrollment.signal?.throwIfAborted();
          const message = error instanceof Error ? error.message : "Worker node enrollment failed";
          return await failProvisionAfterCleanup(
            leaseContext,
            new Error(`${message}; ${evidence}`, { cause: error }),
          );
        }
        if (parsed.warmImage) {
          await warmImages.markEnrolled(leaseId, () => {
            signal?.throwIfAborted();
            enrollment.signal?.throwIfAborted();
          });
          if (options?.retention && projectImage?.preparation && isFork) {
            await warmImages.notePreparedDemand(leaseId, {
              preparationKey: projectImage.preparation.key,
              demandAtMs: projectImage.preparation.demandAtMs,
            });
            assertCurrent();
          }
          signal?.throwIfAborted();
          enrollment.signal?.throwIfAborted();
        }
        provisioned = true;
        return {
          ...allocation,
          ...(options?.retention ? { retainedLease: inspectedParams.inspect.retention } : {}),
          node: { deviceId },
          ...(desktop ? { desktop: desktop.endpoint } : {}),
        };
      } finally {
        // Failed/cancelled preparation may retain a recoverable allocation, but
        // its abandoned caller no longer owns background idle renewal.
        if (!provisioned) {
          await heartbeats.stop(leaseId);
        }
      }
    };
    return async () => {
      // An admitted dispatch may not have created its lease yet; absence cannot release its hold.
      const owner = { leaseId };
      activeProvisions.add(owner);
      try {
        return await provision();
      } finally {
        activeProvisions.delete(owner);
      }
    };
  };

  return {
    id: CRABBOX_WORKER_PROVIDER_ID,
    resolveDisplayId: (profile) => parseCrabboxProfile(profile).provider,
    // Disposable worker desktops may resize only when the RFB server negotiates support.
    allowsDesktopResize: true,
    async dispose() {
      providerAbort.abort();
      await Promise.all([
        heartbeats.dispose(),
        maintenanceInFlight?.catch(() => {}),
        snapshots.settle(),
        binaryResolver.settle(),
      ]);
    },
    images: snapshots.images,
    maintain(context) {
      context.assertCurrent();
      providerAbort.signal.throwIfAborted();
      return (maintenanceInFlight ??= Promise.resolve()
        .then(async () => {
          const signal = AbortSignal.any([context.signal, providerAbort.signal]);
          const assertCurrent = () => {
            signal.throwIfAborted();
            context.assertCurrent();
          };
          assertCurrent();
          // Records have no binary owner: try sorted executables until deletion or all report absent.
          // Crabbox prints `checkpoint absent id=<id>` with exit 0 (internal/cli/checkpoint.go).
          const resolvedBinaries = await resolveMaintenanceBinaries(context.profiles, signal);
          assertCurrent();
          await warmImages.maintain({
            binaries: resolvedBinaries,
            signal,
            assertCurrent,
          });
        })
        .finally(() => {
          maintenanceInFlight = undefined;
        }));
    },
    ...machineOptions,
    supportedExecutionModes: ["worker-turn", "remote-exec"],
    supportsCleanupAcceptance: true,
    provisionBeforeInstallation: true,
    requiresNodeEnrollment: true,
    retainedLease,
    supportsProjectPreparation: supportsCrabboxProjectPreparation,
    supportsRetainedProjectImages: (profile, machineClass, os) => {
      const { profile: resolved } = resolveCrabboxProvisionProfile(profile, machineClass, os);
      return (
        resolved.provider === "azure-sandbox" && Boolean(resolved.sdkPython) && resolved.warmImage
      );
    },
    resolvePreparedIdleTimeoutMs: resolveCrabboxPreparedIdleTimeoutMs,
    resolvePreparationTarget: resolveCrabboxPreparationTarget,
    runSetupCommand: createCrabboxSetupCommandRunner({
      resolveBinary: async (...args) => (await resolveBinary(...args)).binary,
    }),
    resumeNode: createCrabboxNodeResumer({ resolveBinary }),
    notePreparedDemand: async (lease, preparation) =>
      await warmImages.notePreparedDemand(lease.leaseId, preparation),
    resolveAllocation,
    resolveProvisionTimeoutMs(profile, options) {
      return resolveCrabboxProvisionCallTimeoutMs(
        parseCrabboxProfile(profile),
        options?.nodeBootstrapTimeoutMs,
      );
    },
    resolveDestroyTimeoutMs(profile) {
      return resolveCrabboxDestroyTimeoutMs(parseCrabboxCleanupProfile(profile));
    },
    prepareProvision,
    async provision(...args) {
      const prepared = await prepareProvision(...args);
      return await prepared();
    },
    ...createCrabboxProviderLeaseLifecycle({
      heartbeats,
      warmImages,
      retainedLease,
      resolveLeaseContext,
      stopLease,
      providerAbort,
      warn,
      snapshotHelperPath: dependencies.snapshotHelperPath,
    }),
  };
}
