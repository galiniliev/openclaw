import fs from "node:fs/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getRuntimeConfig } from "../../config/config.js";
import type { WorkerSessionDiskRetention } from "../../plugins/worker-retention.types.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as repositoryAdmission from "./repository-project-admission.js";
import * as support from "./service.test-support.js";

vi.mock("../../config/config.js", async (original) => ({
  ...(await original<typeof import("../../config/config.js")>()),
  getRuntimeConfig: vi.fn(() => ({})),
}));

describe("lost worker repository source admission", () => {
  support.setupWorkerEnvironmentServiceSuite();
  it.each([
    "branch",
    "base",
    "denied",
    "default",
    "retained",
    "retained-missing",
    "retained-base-only",
    "retained-denied",
  ] as const)(
    "prepares a lost worker replacement from admitted source only when opted in (%s)",
    async (scenario) => {
      const retained = scenario.startsWith("retained");
      const denied = scenario === "denied" || scenario === "retained-denied";
      const optedIn = scenario !== "default" && !retained;
      const resetToRef =
        optedIn || scenario === "retained-missing" || scenario === "retained-denied";
      const selectedCommit = scenario === "branch" ? "d".repeat(40) : "a".repeat(40);
      const admission = vi.spyOn(repositoryAdmission, "prepareRepositoryWorkerProjectSource");
      admission.mockImplementation(async () => {
        if (denied) {
          throw new Error("Repository authentication failed");
        }
        return {
          project: {
            key: "d".repeat(64),
            baseCommit: selectedCommit,
            source: {
              kind: "repository",
              url: "https://github.com/example/project.git",
              repositoryId: "R_dispatch_fixture",
              owner: {
                agent: { agentId: REQUEST.agentId, provenance: null },
                identity: { source: "anonymous" },
              },
            },
          },
          recoverySource:
            scenario === "base" || scenario === "retained-missing"
              ? "recorded-base"
              : "published-branch",
          setupRecipe: undefined,
          recipe: undefined,
          assertCurrent: () => {},
          revalidate: async () => {},
        };
      });
      onTestFinished(() => admission.mockRestore());
      vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
      const config = {
        cloudWorkers: {
          profiles: {
            development: {
              provider: "fake",
              ...(optedIn ? { lostWorkerRecovery: "repository-ref" as const } : {}),
            },
          },
        },
      };
      vi.mocked(getRuntimeConfig).mockReturnValue(config);
      onTestFinished(() => {
        vi.unstubAllEnvs();
        vi.mocked(getRuntimeConfig).mockReturnValue({
          gateway: { nodes: { commands: { allow: ["codex.exec-server.stdio.v1"] } } },
        });
      });
      const repositories = getSessionRepositoryWorkspaceStore();
      const initial = await repositories.create({
        agentId: REQUEST.agentId,
        sessionKey: REQUEST.sessionKey,
        url: "https://github.com/example/project.git",
        requestedRef: "refs/heads/main",
        branch: "saved/session-branch",
        assertCurrent: () => {},
      });
      const pinned = await repositories.bindBase({
        workspaceId: initial.workspaceId,
        expectedRevision: initial.revision,
        baseCommit: "a".repeat(40),
        baseManifestHash: `sha256:${"b".repeat(64)}`,
        assertCurrent: () => {},
      });
      const accepted = await repositories.acceptCheckpoint({
        workspaceId: pinned.workspaceId,
        expectedRevision: pinned.revision,
        checkpointRef: "refs/openclaw/worker-results/accepted",
        manifestHash: `sha256:${(scenario === "retained-base-only" ? "b" : "c").repeat(64)}`,
        assertCurrent: () => {},
      });
      if (scenario === "retained") {
        await fs.mkdir(repositories.artifactPath(accepted.workspaceId), { recursive: true });
      }
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const harness = await createHarness(support.testState.stateDb, placements, {
        requiresNodeEnrollment: true,
        failAt: "create",
        resolveWorkspace: async () => ({
          kind: "repository",
          repository: (await repositories.get(initial.workspaceId))!,
        }),
      });
      const active = await harness.placements.seedActive(2);
      const oldClaim = await placements.claimTurn({
        sessionId: active.sessionId,
        sessionKey: active.sessionKey,
        agentId: active.agentId,
        claimId: "lost-claim",
        runId: "lost-run",
        owner: {
          kind: "worker",
          environmentId: active.environmentId!,
          ownerEpoch: active.activeOwnerEpoch!,
        },
      });
      const draining = await placements.startDrain({
        sessionId: active.sessionId,
        environmentId: active.environmentId!,
        ownerEpoch: active.activeOwnerEpoch!,
        expectedGeneration: active.generation,
      });
      const reconciling = await placements.startReconcile({
        sessionId: active.sessionId,
        environmentId: active.environmentId!,
        ownerEpoch: active.activeOwnerEpoch!,
        expectedGeneration: draining.generation,
      });
      const failed = await placements.fail({
        sessionId: active.sessionId,
        expectedGeneration: reconciling.generation,
        recoveryError: "Dedicated machine disappeared",
      });
      harness.markEnvironmentDestroyed();
      if (retained) {
        const retention: WorkerSessionDiskRetention = {
          policy: { mode: "session-disk", computeWindowSeconds: 14400 },
          owner: REQUEST,
          ownerBinding: "a".repeat(64),
          desiredState: "suspended",
          receipt: null,
          operation: null,
        };
        const readEnvironment = vi.mocked(harness.environments.get).getMockImplementation();
        if (!readEnvironment) {
          throw new Error("Missing environment fixture");
        }
        vi.mocked(harness.environments.get).mockImplementation((id) => {
          const record = readEnvironment(id);
          return record ? { ...record, retention } : record;
        });
      }
      await expect(
        harness.service.dispatch({
          ...REQUEST,
          expectedPlacement: {
            state: failed.state,
            generation: failed.generation,
            environmentId: failed.environmentId,
            activeOwnerEpoch: failed.activeOwnerEpoch,
          },
        }),
      ).rejects.toThrow(denied ? "Repository authentication failed" : "create failed");
      if (denied) {
        expect(await repositories.get(initial.workspaceId)).toEqual(accepted);
        expect(harness.environments.prepareProjectIntent).not.toHaveBeenCalled();
        return;
      }
      const requested = vi.mocked(harness.environments.prepareProjectIntent).mock.calls[0]![1]!
        .repository;
      expect(requested).toEqual({
        agentId: REQUEST.agentId,
        url: initial.url,
        ref: resetToRef ? selectedCommit : "refs/heads/main",
        baseCommit: resetToRef ? undefined : "a".repeat(40),
      });
      const after = (await repositories.get(initial.workspaceId))!;
      expect(after.workspaceId).toBe(initial.workspaceId);
      expect(after.sessionKey).toBe(REQUEST.sessionKey);
      expect(after.branch).toBe("saved/session-branch");
      expect(after.checkpointRef).toBe(resetToRef ? null : accepted.checkpointRef);
      expect(admission).toHaveBeenCalledTimes(resetToRef ? 1 : 0);
      if (resetToRef) {
        expect(after.recovery).toMatchObject({
          reason:
            scenario === "retained-missing" ? "missing-checkpoint-artifact" : "missing-worker",
          original: {
            revision: accepted.revision,
            baseCommit: accepted.baseCommit,
            baseManifestHash: accepted.baseManifestHash,
            checkpointRef: accepted.checkpointRef,
            manifestHash: accepted.manifestHash,
          },
          sourceCommit: selectedCommit,
          unrecoverablePrivateContent: true,
        });
        expect(admission.mock.calls[0]?.[0].repository).toEqual({
          agentId: REQUEST.agentId,
          url: initial.url,
          ref: "refs/heads/saved/session-branch",
          fallbackCommit: "a".repeat(40),
        });
      }
      await expect(placements.markWorkspaceResultPending(oldClaim)).rejects.toThrow();
    },
  );
  it.each(["published", "missing", "revoked"] as const)(
    "preflights a legacy branch-only workspace before worker allocation (%s)",
    async (scenario) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const repositories = getSessionRepositoryWorkspaceStore();
      const initial = await repositories.create({
        agentId: REQUEST.agentId,
        sessionKey: REQUEST.sessionKey,
        url: "https://github.com/example/project.git",
        requestedRef: "refs/heads/saved/session-branch",
        branch: "saved/session-branch",
        assertCurrent: () => {},
      });
      const admission = vi.spyOn(repositoryAdmission, "prepareRepositoryWorkerProjectSource");
      const assertCurrent = vi.fn(() => {
        if (scenario === "revoked") {
          throw new Error("Repository authority revoked");
        }
      });
      admission.mockImplementation(async () => {
        if (scenario === "missing") {
          throw new Error("Restore this workspace from a verified backup before retrying");
        }
        return {
          project: {
            key: "d".repeat(64),
            baseCommit: "a".repeat(40),
            source: {
              kind: "repository",
              url: initial.url,
              repositoryId: "R_dispatch_fixture",
              owner: {
                agent: { agentId: REQUEST.agentId, provenance: null },
                identity: { source: "anonymous" },
              },
            },
          },
          recoverySource: "published-branch",
          setupRecipe: undefined,
          recipe: undefined,
          assertCurrent,
          revalidate: async () => {},
        };
      });
      onTestFinished(() => admission.mockRestore());
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const harness = await createHarness(support.testState.stateDb, placements, {
        requiresNodeEnrollment: true,
        failAt: "create",
        resolveWorkspace: async () => ({
          kind: "repository",
          repository: (await repositories.get(initial.workspaceId))!,
        }),
      });
      await expect(harness.service.dispatch(REQUEST)).rejects.toThrow(
        scenario === "published"
          ? "create failed"
          : scenario === "missing"
            ? "verified backup"
            : "Repository authority revoked",
      );
      expect(admission.mock.calls[0]?.[0].repository).toEqual({
        agentId: REQUEST.agentId,
        url: initial.url,
        ref: "refs/heads/saved/session-branch",
        requirePublishedRef: true,
      });
      if (scenario === "published") {
        expect(await repositories.get(initial.workspaceId)).toMatchObject({
          requestedRef: "a".repeat(40),
          branch: initial.branch,
          checkpointRef: null,
          revision: initial.revision + 1,
        });
        expect(
          vi.mocked(harness.environments.prepareProjectIntent).mock.calls[0]?.[1]?.repository,
        ).toMatchObject({
          ref: "a".repeat(40),
        });
      } else {
        expect(await repositories.get(initial.workspaceId)).toEqual(initial);
        expect(harness.environments.prepareProjectIntent).not.toHaveBeenCalled();
        expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
        expect(await placements.getAsync(REQUEST.sessionId)).toMatchObject({
          state: "failed",
          recoveryError: expect.stringContaining(
            scenario === "missing" ? "verified backup" : "Repository authority revoked",
          ),
        });
      }
    },
  );
});
