import { afterEach, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { requestSessionCreate } from "../../lib/sessions/create.ts";
import { advanceSessionPlacementDraft } from "../../lib/sessions/session-placement-submit.ts";
import { buildSelectedSessionCreateParams } from "./draft-create-params.ts";
import { createDraftFixture, resetSubmissionMocks } from "./draft-submission-flow.test-support.ts";

afterEach(resetSubmissionMocks);
const profileId = "teamclaw-aca-sandbox";
const project = {
  id: "lobster",
  displayName: "Lobster",
  source: "registered" as const,
  repoRoot: "/gateway/nfs/projects/lobster",
  originUrl: "git@microsoft.ghe.com:org/lobster.git",
};
const repository = { url: "https://microsoft.ghe.com/org/lobster.git" };
async function fixture(
  source: "registered" | "workspace" = "registered",
  expectedRepository: { url: string; ref?: string } = repository,
  rejectRef = false,
) {
  const f = createDraftFixture({
    methods: [
      "sessions.create",
      "sessions.dispatch",
      "sessions.describe",
      "chat.send",
      "projects.list",
      "environments.list",
      "worktrees.branches",
    ],
    scopes: ["operator.admin", "operator.read", "operator.write"],
    request: async (method, params) => {
      if (method === "projects.list") {
        return { projects: [{ ...project, source }], githubHost: "microsoft.ghe.com" };
      }
      if (method === "environments.list") {
        return {
          environments: [
            {
              id: "node:existing-device",
              type: "node",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: 1 },
            },
          ],
          dispatchableProfileIds: [profileId],
          profiles: [
            {
              id: profileId,
              providerId: "crabbox",
              executionModes: ["worker-turn"],
              operatingSystems: [{ id: "linux", label: "Linux", default: true }],
              machines: [{ id: "4cpu-8gib", label: "XL", cpu: 4, memoryGb: 8, default: true }],
            },
          ],
        };
      }
      if (method === "projects.checkoutOptions") {
        return { current: true, worktree: true };
      }
      if (method === "worktrees.branches") {
        return {
          repositoryStatus: "git",
          branches: [
            { name: "origin/published", kind: "remote" },
            { name: "origin/origin/feature", kind: "remote" },
            { name: "unpublished/local-feature", kind: "local" },
          ],
          defaultBranch: "origin/main",
        };
      }
      if (method === "sessions.create") {
        expect(params).toMatchObject({ repository: expectedRepository, message: "" });
        for (const field of [
          "worktree",
          "projectId",
          "cwd",
          "worktreeBaseRef",
          "worktreeName",
          "projectGitUrl",
        ]) {
          expect(params).not.toHaveProperty(field);
        }
        return { key: (params as { key: string }).key, sessionId: "worker-repository-session" };
      }
      if (method === "sessions.dispatch") {
        if (rejectRef) {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "GitHub repository ref was not found",
          });
        }
        return {
          sessionId: "worker-repository-session",
          placement: { state: "active", environmentId: "worker:cloud", profileId },
        };
      }
      if (method === "chat.send") {
        return { status: "started", runId: "worker-first-turn" };
      }
      throw new Error(`Unexpected Gateway operation: ${method}`);
    },
  });
  await f.place.browser.refreshProjects();
  await f.gateway.refreshCloudProfiles();
  f.place.selectProjectId(project.id);
  await f.place.repositoryState.repositoryRead?.completed;
  await f.place.repositoryState.checkoutRead?.completed;
  return f;
}

it.each(["default", "local-ref", "local-name", "restored-ref"] as const)(
  "creates cloud %s intent through repository validation without a Gateway worktree",
  async (mode) => {
    const ref =
      mode === "local-ref" || mode === "restored-ref" ? "unpublished/local-feature" : undefined;
    const f = await fixture("registered", { ...repository, ...(ref ? { ref } : {}) }, Boolean(ref));
    f.place.selectCloudProfile(profileId);
    await f.place.repositoryState.repositoryRead?.completed;
    if (mode === "local-ref") {
      f.place.setBaseRef(ref!);
    }
    if (mode === "restored-ref") {
      f.place.repositoryState.adoptPreference({ baseRef: ref });
    }
    if (mode === "local-name") {
      f.place.setWorktreeName("explicit-local-branch");
    }
    f.flow.setMessage("Investigate the current default branch");
    const client = { request: f.request as GatewayBrowserClient["request"] };
    vi.mocked(f.context.sessions.createResult).mockImplementation((params, options) =>
      requestSessionCreate(client, params, options),
    );
    let startup: ReturnType<typeof advanceSessionPlacementDraft> | undefined;
    const start = vi.fn<ApplicationContext["placementStartup"]["start"]>((input) => {
      expect(input.recovery.target).toEqual({
        kind: "profile",
        profileId,
        os: "linux",
        machineClass: "4cpu-8gib",
      });
      startup = advanceSessionPlacementDraft({
        client,
        recovery: input.recovery,
        mode: input.mode,
        describe: (params) => client.request("sessions.describe", params),
        isLifecycleCurrent: () => true,
        ownsRecovery: () => true,
        clearRecovery: vi.fn(),
        setRecoveryPhase: vi.fn(),
        cleanupOnCancellation: () => false,
      });
    });
    f.context.placementStartup.start = start;
    expect(f.flow.submitBlock()).toBeUndefined();
    await f.flow.submit();
    expect(f.flow.error).toBeNull();
    expect(start).toHaveBeenCalledOnce();
    expect(await startup).toMatchObject(
      ref
        ? { status: "paused", recovery: { error: "GitHub repository ref was not found" } }
        : { status: "started" },
    );
    expect(
      f.request.mock.calls
        .filter(([method]) =>
          ["sessions.create", "sessions.dispatch", "chat.send"].includes(method),
        )
        .map(([method]) => method),
    ).toEqual(
      ref
        ? ["sessions.create", "sessions.dispatch"]
        : ["sessions.create", "sessions.dispatch", "chat.send"],
    );
    expect(f.request).toHaveBeenCalledWith(
      "sessions.dispatch",
      expect.objectContaining({ profileId, machineClass: "4cpu-8gib", os: "linux" }),
    );
    expect(
      f.request.mock.calls.some(
        ([method]) => method === "projects.add" || method === "worktrees.create",
      ),
    ).toBe(false);
  },
);

it.each(["gateway", "device", "local-ref", "local-name", "workspace"] as const)(
  "preserves %s checkout intent",
  async (mode) => {
    const f = await fixture(mode === "workspace" ? "workspace" : "registered");
    f.place.selectWorktree(true);
    if (mode === "device") {
      f.place.selectDevice("existing-device");
      expect(f.place.deviceId).toBe("existing-device");
    }
    if (mode === "workspace") {
      f.place.selectCloudProfile(profileId);
    }
    if (mode === "local-ref") {
      f.place.setBaseRef("unpublished/local-feature");
    }
    if (mode === "local-name") {
      f.place.setWorktreeName("explicit-local-branch");
    }
    const params = buildSelectedSessionCreateParams(f.place, {
      message: "work",
      visibility: "normal",
    });
    expect(params).toMatchObject({ projectId: project.id, worktree: true });
    expect(params).not.toHaveProperty("repository");
    if (mode === "local-ref") {
      expect(params.worktreeBaseRef).toBe("unpublished/local-feature");
    }
    if (mode === "local-name") {
      expect(params.worktreeName).toBe("explicit-local-branch");
    }
  },
);

it("keeps a discovered origin branch on the repository route and restores local placement", async () => {
  const f = await fixture();
  f.place.selectCloudProfile(profileId);
  await f.place.repositoryState.repositoryRead?.completed;
  expect(f.place.remoteRepository).toEqual(repository);
  f.place.setBaseRef("origin/published");
  expect(
    buildSelectedSessionCreateParams(f.place, { message: "", visibility: "normal" }),
  ).toMatchObject({ repository: { ...repository, ref: "published" } });
  expect(f.place.worktree).toBe(false);
  f.place.selectDevice("");
  expect(f.place.remoteRepository).toBeUndefined();
  expect(f.place.baseRef).toBe("origin/published");
  expect(f.place.browser.projectId).toBe(project.id);
});

it("offers only origin branch suggestions for registered cloud repositories", async () => {
  const f = await fixture();
  f.place.selectCloudProfile(profileId);
  await f.place.repositoryState.repositoryRead?.completed;
  expect(f.place.repository).toMatchObject({
    branches: [
      { name: "origin/published", kind: "remote" },
      { name: "origin/origin/feature", kind: "remote" },
    ],
    defaultBranch: "origin/main",
  });
  const state = f.place.repository;
  if (state.kind !== "git") {
    throw new Error("Expected Git branch suggestions");
  }
  f.place.setBaseRef(state.branches[1]!.name);
  expect(f.place.remoteRepository).toEqual({ ...repository, ref: "origin/feature" });
  f.place.selectDevice("");
  await f.place.repositoryState.repositoryRead?.completed;
  expect(f.place.repository).toMatchObject({
    branches: [
      { name: "origin/published", kind: "remote" },
      { name: "origin/origin/feature", kind: "remote" },
      { name: "unpublished/local-feature", kind: "local" },
    ],
  });
});

it("preserves an empty origin tracking suffix for GitHub rejection", async () => {
  const f = await fixture();
  f.place.selectCloudProfile(profileId);
  f.place.setBaseRef("origin/");
  expect(f.place.remoteRepository).toEqual({ ...repository, ref: "origin/" });
  expect(f.place.worktree).toBe(false);
});
