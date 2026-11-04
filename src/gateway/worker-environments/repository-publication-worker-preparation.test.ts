import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { GitHubCredentialReader } from "../../agents/github-credential-reader.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { GitHubPublicationRecoveryPendingError } from "../github-publication-git-index.js";
import type { RepositoryPublicationIntegrationInput } from "../repository-publication-checkpoint.js";
import { StaleWorkerBuildError } from "./admission.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { placementTurnOwner } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createRepositoryPublicationPreparation } from "./repository-publication-worker-preparation.js";
import { createRepositoryWorkspaceMutationService } from "./repository-workspace-mutation.js";
import { createWorkerPlacementRedispatch } from "./worker-placement-redispatch.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

const temporary = useStateDatabaseTempDirs();
beforeEach(() => setRuntimeConfigSnapshot({}));
it.each([
  "reclaimed",
  "failed",
  "unknown",
  "old-runtime",
  "busy-runtime",
  "deferred-runtime",
] as const)("prepares saved publication through normal placement recovery (%s)", async (state) => {
  const root = temporary.make("publication-readiness-");
  const checkpoint = path.join(root, "accepted-checkpoint");
  await fs.writeFile(checkpoint, "original accepted repair");
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  const placements = createWorkerSessionPlacementStore({ database });
  const harness = await createHarness(database, placements, {
    workspacePath: root,
    reconcileChanged: false,
    reconcileCommitsManifest: false,
  });
  const active = await harness.service.dispatch(REQUEST);
  if (state === "reclaimed") {
    await harness.service.reclaim(REQUEST);
  } else if (state === "failed" || state === "unknown") {
    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    };
    const draining = await placements.startDrain({
      ...owner,
      expectedGeneration: active.generation,
    });
    const reconciling = await placements.startReconcile({
      ...owner,
      expectedGeneration: draining.generation,
    });
    await placements.fail({
      sessionId: active.sessionId,
      expectedGeneration: reconciling.generation,
      recoveryError: "worker lost",
    });
    if (state === "failed") {
      harness.markEnvironmentDestroyed();
    }
  }
  if (state === "busy-runtime") {
    await placements.claimTurn({
      ...REQUEST,
      claimId: "live-turn",
      runId: "live-turn",
      owner: placementTurnOwner(active),
    });
  }
  let stale = state === "old-runtime" || state === "busy-runtime" || state === "deferred-runtime";
  const before = placements.get(REQUEST.sessionId)!;
  const priorEnvironment = harness.environments.get(active.environmentId);
  const recovery =
    state === "reclaimed" || state === "failed"
      ? await createHarness(database, placements, {
          workspacePath: root,
          environmentGeneration: before.generation + 1,
          reconcileChanged: false,
          reconcileCommitsManifest: false,
        })
      : harness;
  if (recovery !== harness) {
    const readEnvironment = vi.mocked(recovery.environments.get).getMockImplementation()!;
    vi.spyOn(recovery.environments, "get").mockImplementation((id) =>
      id === active.environmentId ? priorEnvironment : readEnvironment(id),
    );
  }
  const allocations = vi.mocked(recovery.environments.createWithRequest).mock.calls.length;
  const dispatch = vi.spyOn(recovery.service, "dispatch");
  const redispatch = createWorkerPlacementRedispatch({
    placements,
    dispatch: (...args) => coordinated.dispatch(...args),
    resolveDevicePlacementRequirement: async () => ({
      requiredNodeCommands: [],
      consumesWorkerSlot: true,
    }),
  });
  const coordinated = coordinateWorkerPlacementDispatch(
    recovery.service,
    (_request, run) => run(),
    undefined,
    {
      placements,
      environments: recovery.environments,
      redispatchPlacement: redispatch,
      warn: () => {},
    },
  );
  const readNativeCredential: GitHubCredentialReader = Object.assign(
    async () => "synthetic-dispatch-token",
    { admit: async () => {} },
  );
  const integration = vi.fn(async (input: RepositoryPublicationIntegrationInput) => {
    input.assertCurrent();
    expect(placements.get(REQUEST.sessionId)?.state).toBe("active");
    expect(input.snapshotRoot).toBe(checkpoint);
    expect(await fs.readFile(checkpoint, "utf8")).toBe("original accepted repair");
    return {
      snapshotRoot: checkpoint,
      knownBlobs: [],
      snapshot: {
        version: 1 as const,
        baseCommit: "a".repeat(40),
        baseTree: "b".repeat(40),
        workspaceTree: "c".repeat(40),
        entries: [],
      },
      release: async () => {},
    };
  });
  vi.spyOn(recovery.environments, "startTunnel").mockImplementation(async ({ ownerEpoch }) => {
    if (stale) {
      throw new StaleWorkerBuildError();
    }
    return { ...recovery.tunnelHandle(ownerEpoch), integratePublication: integration };
  });
  const refresh = vi.fn(async () => {
    if (state !== "deferred-runtime") {
      stale = false;
    }
  });
  const service = createRepositoryWorkspaceMutationService({
    placements,
    environments: recovery.environments,
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    resolveWorkspace: async () => {
      throw new Error("Publication must not recapture live files");
    },
    ...createRepositoryPublicationPreparation({
      placements,
      environments: { ...recovery.environments, inspectTurnLease: vi.fn() },
      ensurePlacement: (request) => coordinated.ensurePlacement(request),
      resolveDevicePlacementRequirement: async () => ({
        requiredNodeCommands: [],
        consumesWorkerSlot: true,
      }),
      getConfig: () => ({}),
      waitForNode: async ({ assertCurrent }) => assertCurrent(),
      reconcileActive: refresh,
    }),
  });
  const pending = service.integratePublication(REQUEST, {
    snapshotRoot: checkpoint,
    snapshotDigest: `sha256:${"d".repeat(64)}`,
    sourceUrl: "https://github.com/example/repo.git",
    targetUrl: "https://github.com/example/repo.git",
    mainCommit: "a".repeat(40),
    token: "synthetic-publication-token",
    readNativeCredential,
    assertCurrent: () => {},
  });
  if (state === "deferred-runtime") {
    await expect(pending).rejects.toBeInstanceOf(GitHubPublicationRecoveryPendingError);
    expect(refresh).toHaveBeenCalledOnce();
    expect(integration).not.toHaveBeenCalled();
  } else if (state === "unknown" || state === "busy-runtime") {
    await expect(pending).rejects.toThrow();
    expect(integration).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.mocked(recovery.environments.createWithRequest).mock.calls.length).toBe(allocations);
  } else {
    expect((await pending).snapshotRoot).toBe(checkpoint);
    if (state === "old-runtime") {
      expect(refresh).toHaveBeenCalledOnce();
      expect(dispatch).not.toHaveBeenCalled();
    } else {
      expect(placements.get(REQUEST.sessionId)?.generation).toBeGreaterThan(before.generation);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        profileId: REQUEST.profileId,
        readNativeCredential,
      });
    }
    expect(integration).toHaveBeenCalledOnce();
  }
  expect(await fs.readFile(checkpoint, "utf8")).toBe("original accepted repair");
});
