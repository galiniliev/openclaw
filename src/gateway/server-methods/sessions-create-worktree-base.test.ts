import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import * as gitExecution from "../../infra/git-exec.js";
import { refreshProjectClone } from "../../projects/project-clone.js";
import { registerProjectRegistry } from "../../projects/project-registry.js";
import { registerClonedProjectRegistry } from "../../projects/project-registry.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import * as projectIdentity from "../project-github-identity.js";
import {
  controlUiClient,
  initializeRepository,
  removeOwnedSessionWorktree,
  settleWorkspaceRuns,
  successfulSessionRequest as requestOk,
} from "../server.sessions.create.projects.test-support.js";
import { sessionTitleRequests } from "../session-title-state.js";
import { dispatchInboundMessageMock, testState } from "../test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const execFileAsync = promisify(execFile);
const git = (cwd: string, ...args: string[]) => execFileAsync("git", ["-C", cwd, ...args]);
const readSession = (storePath: string, sessionKey: string) =>
  loadSessionEntry({ agentId: "main", sessionKey, storePath });
const createRun = (
  params: Record<string, unknown>,
  options: Parameters<typeof directSessionReq<{ key: string; runId: string }>>[2],
) =>
  requestOk<{ key: string; runId: string }>(
    "sessions.create",
    { agentId: "main", worktree: true, ...params },
    options,
  );
const sendRun = (
  sessionKey: string,
  message: string,
  idempotencyKey: string,
  options: Parameters<typeof directSessionReq>[2],
) => requestOk("chat.send", { agentId: "main", sessionKey, message, idempotencyKey }, options);
const gitUrl = "https://github.com/openclaw/openclaw.git";
const projectCloneMocks = vi.hoisted(() => ({ materialize: vi.fn() }));

test.each([undefined, false])(
  "sessions.create isolates a cloned project when worktree is %s",
  async (worktree) => {
    const { root, storePath } = await workspaceFixture("shared-clone");
    const projectRoot = await initializeRepository(root, "project");
    const project = await registerClonedProjectRegistry({
      path: projectRoot,
      name: "Shared clone",
      originUrl: gitUrl,
    });
    const key = "agent:main:dashboard:shared-clone";
    try {
      await requestOk(
        "sessions.create",
        { agentId: "main", key, projectId: project.id, worktree },
        controlUiClient,
      );
      const entry = readSession(storePath, key);
      expect(entry?.worktree?.id).toBeDefined();
      const owned = await managedWorktrees.findLiveByOwner("session", key);
      expect(owned).toBeDefined();
      expect(entry?.spawnedCwd).toBe(owned?.path);
      expect(entry?.sessionRoot).toBe(owned?.path);
      expect(entry?.spawnedCwd).not.toBe(projectRoot);
      await fs.mkdir(path.join(entry!.spawnedCwd!, ".openclaw/tmp/build"), { recursive: true });
      await fs.writeFile(path.join(entry!.spawnedCwd!, ".openclaw/tmp/build/output"), "scratch");
      await expect(fs.stat(path.join(projectRoot, ".openclaw/tmp"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await removeOwnedSessionWorktree(key);
    }
  },
);

async function workspaceFixture(name: string) {
  const root = tempDirs.make(`openclaw-session-${name}-`);
  const workspace = await initializeRepository(root, "workspace");
  testState.agentConfig = { workspace };
  return { root, workspace, ...(await createSessionStoreDir()) };
}

async function cloneFixture(root: string) {
  const publisher = await initializeRepository(root, "publisher");
  const upstream = path.join(root, "upstream.git");
  const projectRoot = path.join(root, "project");
  await execFileAsync("git", ["clone", "--bare", publisher, upstream]);
  await execFileAsync("git", ["clone", "--no-local", upstream, projectRoot]);
  return { publisher, upstream, projectRoot };
}

function runContext() {
  dispatchInboundMessageMock.mockResolvedValue({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  });
  return { broadcast: vi.fn() };
}

async function cleanupRun(
  context: ReturnType<typeof runContext>,
  storePath: string,
  sessionKey: string,
) {
  await settleWorkspaceRuns(context, storePath, sessionKey, true);
  await removeOwnedSessionWorktree(sessionKey);
}

vi.mock("../../projects/project-clone.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../projects/project-clone.js")>();
  return { ...actual, materializeProjectClone: projectCloneMocks.materialize };
});

afterEach(async () => {
  projectCloneMocks.materialize.mockReset();
  dispatchInboundMessageMock.mockReset();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
  vi.restoreAllMocks();
});

test.each(["fresh", "retry"] as const)(
  "sessions.create validates a %s remote base",
  async (mode) => {
    const { root, storePath } = await workspaceFixture("remote-base");
    const { publisher, upstream, projectRoot } = await cloneFixture(root);
    const baseRef = mode === "retry" ? "origin/missing" : "main";
    if (mode === "retry") {
      const commit = (await git(projectRoot, "rev-parse", "HEAD")).stdout.trim();
      const branches = [
        "main",
        ...Array.from({ length: 7_850 }, (_, index) => String(index).padStart(65, "0")),
      ];
      for (const [directory, prefix] of [
        [upstream, "refs/heads"],
        [path.join(projectRoot, ".git"), "refs/remotes/origin"],
      ] as const) {
        await fs.writeFile(
          path.join(directory, "packed-refs"),
          branches
            .map((branch) => `${commit} ${prefix}/${branch}\n`)
            .toSorted()
            .join(""),
        );
      }
      // A matching branch at the mutable origin must not bypass the registry-owned remote.
      const unrelated = await initializeRepository(root, "unrelated");
      await git(unrelated, "branch", "missing");
      await git(projectRoot, "remote", "set-url", "origin", unrelated);
    } else {
      await git(projectRoot, "remote", "set-url", "origin", path.join(root, "unavailable.git"));
    }
    projectCloneMocks.materialize.mockResolvedValue(
      await registerClonedProjectRegistry({
        path: projectRoot,
        name: "Project",
        originUrl: mode === "retry" ? upstream : gitUrl,
      }),
    );
    const context = runContext();
    const options = { ...controlUiClient, context };
    const created = await createRun(
      { message: "start", projectGitUrl: gitUrl, worktreeBaseRef: baseRef },
      options,
    );
    const sessionKey = created.key;
    try {
      await settleWorkspaceRuns(context, storePath, sessionKey);
      if (mode === "retry") {
        expect(context.broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({
            runId: created.runId,
            sessionKey,
            state: "error",
            errorMessage: expect.stringContaining("does not resolve to a commit"),
          }),
          expect.anything(),
        );
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(readSession(storePath, sessionKey)?.pendingWorktree).toMatchObject({ baseRef });
        await fs.writeFile(path.join(publisher, "requested.txt"), "requested branch\n");
        await git(publisher, "add", "requested.txt");
        await git(publisher, "commit", "-m", "requested branch");
        const expectedCommit = (await git(publisher, "rev-parse", "HEAD")).stdout.trim();
        await git(publisher, "branch", "missing");
        await git(publisher, "push", upstream, "refs/heads/missing:refs/heads/missing");
        await sendRun(sessionKey, "retry", "retry-invalid-remote-base", options);
        await settleWorkspaceRuns(context, storePath, sessionKey);
        expect(readSession(storePath, sessionKey)).not.toHaveProperty("pendingWorktree");
        const owned = await managedWorktrees.findLiveByOwner("session", sessionKey);
        expect(owned).toBeDefined();
        expect((await git(owned!.path, "rev-parse", "HEAD")).stdout.trim()).toBe(expectedCommit);
        expect(await fs.readFile(path.join(owned!.path, "requested.txt"), "utf8")).toBe(
          "requested branch\n",
        );
      }
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      expect((await managedWorktrees.findLiveByOwner("session", sessionKey))?.baseRef).toBe(
        baseRef,
      );
    } finally {
      await cleanupRun(context, storePath, sessionKey);
    }
  },
);
test("remote retry refresh does not mutate a registered project checkout", async () => {
  const root = tempDirs.make("openclaw-session-registered-project-refresh-");
  const { publisher, upstream, projectRoot } = await cloneFixture(root);
  const project = await registerProjectRegistry({ path: projectRoot, name: "Registered" });

  await git(publisher, "branch", "operator");
  await git(publisher, "push", upstream, "refs/heads/operator:refs/heads/operator");
  await refreshProjectClone(project);

  await expect(
    git(projectRoot, "rev-parse", "--verify", "refs/remotes/origin/operator"),
  ).rejects.toBeDefined();
});

test("sessions.create rejects an invalid worktree base before persisting the session", async () => {
  const { storePath } = await workspaceFixture("invalid-worktree-base");
  const sessionKey = "agent:main:dashboard:invalid-worktree-base";

  const created = await directSessionReq(
    "sessions.create",
    {
      agentId: "main",
      key: sessionKey,
      message: "start",
      worktree: true,
      worktreeBaseRef: "126887",
    },
    controlUiClient,
  );

  expect(created).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("does not resolve to a commit"),
    },
  });
  expect(readSession(storePath, sessionKey)).toBeUndefined();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});

test.each(["local", "remote"] as const)(
  "chat.send keeps an accepted %s base pinned after setup fails and its branch moves",
  async (source) => {
    const { workspace, storePath } = await workspaceFixture("pinned-worktree-base");
    await git(workspace, "branch", "base");
    const acceptedCommit = (await git(workspace, "rev-parse", "base")).stdout.trim();
    const setup = path.join(workspace, ".openclaw", "worktree-setup.sh");
    await fs.mkdir(path.dirname(setup));
    await fs.writeFile(setup, "#!/bin/sh\nexit 23\n", { mode: 0o755 });
    if (source === "remote") {
      projectCloneMocks.materialize.mockResolvedValue(
        await registerClonedProjectRegistry({
          path: workspace,
          name: "Pinned",
          originUrl: gitUrl,
        }),
      );
    }
    const context = runContext();
    const options = { client: { connect: { scopes: ["operator.admin"] } } as never, context };
    const created = await createRun(
      {
        message: "start",
        worktreeName: "pinned-base",
        worktreeBaseRef: "base",
        ...(source === "remote" ? { projectGitUrl: gitUrl } : {}),
      },
      options,
    );
    const sessionKey = created.key;
    try {
      await settleWorkspaceRuns(context, storePath, sessionKey);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(readSession(storePath, sessionKey)).toMatchObject({
        status: "failed",
        lastRunError: expect.stringContaining("23"),
        pendingWorktree: { baseRef: "base", baseCommit: acceptedCommit },
      });
      expect(await managedWorktrees.findLiveByOwner("session", sessionKey)).toBeUndefined();
      await git(workspace, "commit", "--allow-empty", "-m", "move base");
      await git(workspace, "branch", "-f", "base", "HEAD");
      await fs.writeFile(setup, "#!/bin/sh\nexit 0\n");
      await sendRun(sessionKey, "retry", "retry-pinned-base", options);
      await settleWorkspaceRuns(context, storePath, sessionKey);
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      const worktree = await managedWorktrees.findLiveByOwner("session", sessionKey);
      if (!worktree) {
        throw new Error("expected a managed worktree");
      }
      expect(worktree.baseRef).toBe("base");
      expect((await git(worktree.path, "rev-parse", "HEAD")).stdout.trim()).toBe(acceptedCommit);
      expect(readSession(storePath, sessionKey)).not.toHaveProperty("pendingWorktree");
    } finally {
      await cleanupRun(context, storePath, sessionKey);
    }
  },
);

test("sessions.create recovers a failed worktree in the same session with an explicit project", async () => {
  const root = tempDirs.make("openclaw-session-worktree-source-recovery-");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await execFileAsync("git", ["init", "-b", "main", workspace]);
  const repository = await initializeRepository(root, "project");
  const project = await registerProjectRegistry({ path: repository, name: "Recovery" });
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const context = runContext();
  const options = { ...controlUiClient, context };
  const created = await createRun({ message: "start" }, options);
  const sessionKey = created.key;
  const target = { agentId: "main", sessionKey, storePath };
  try {
    await settleWorkspaceRuns(context, storePath, sessionKey);
    const beforeTitle = loadSessionEntry(target)!;
    // Automatic naming is independent of the failed worktree run's settlement.
    await sessionTitleRequests.get({ ...target, sessionId: beforeTitle.sessionId });
    const failed = loadSessionEntry(target)!;
    expect(failed.displayName).toMatch(/^[a-z]+-[a-z]+$/);
    expect(failed.updatedAt).toBeGreaterThanOrEqual(beforeTitle.updatedAt);
    expect(failed).toMatchObject({
      status: "failed",
      lastRunError: expect.stringContaining("has no commits"),
      pendingWorktree: { workspace },
    });
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    const transcriptScope = { ...target, sessionId: failed.sessionId };
    const history = loadTranscriptEventsSync(transcriptScope);
    const selection = { agentId: "main", key: sessionKey, projectId: project.id, worktree: true };
    const rejected = await directSessionReq(
      "sessions.create",
      { ...selection, worktreeBaseRef: "missing-base" },
      options,
    );
    expect(rejected.ok).toBe(false);
    expect(loadSessionEntry(target)).toEqual(failed);
    expect(loadTranscriptEventsSync(transcriptScope)).toEqual(history);
    const recovered = await directSessionReq("sessions.create", selection, options);
    expect(recovered.ok, JSON.stringify(recovered.error)).toBe(true);
    const bound = loadSessionEntry(target)!;
    expect(bound).toMatchObject({
      sessionId: failed.sessionId,
      displayName: failed.displayName,
      projectId: project.id,
      lastRunError: failed.lastRunError,
      worktree: { repoRoot: repository },
    });
    expect(bound.updatedAt).toBeGreaterThanOrEqual(failed.updatedAt);
    expect(bound).not.toHaveProperty("pendingWorktree");
    expect(bound).not.toHaveProperty("pendingProjectGitUrl");
    expect(loadTranscriptEventsSync(transcriptScope)).toEqual(history);
    await sendRun(sessionKey, "retry", "recovered-worktree-turn", options);
    await settleWorkspaceRuns(context, storePath, sessionKey);
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    expect(loadSessionEntry(target)?.sessionId).toBe(failed.sessionId);
  } finally {
    await cleanupRun(context, storePath, sessionKey);
  }
});

test.each(["with-message", "without-message"] as const)(
  "registered local project default-ref credentials (%s)",
  async (mode) => {
    const { root, storePath } = await workspaceFixture("authenticated-default");
    const { publisher, upstream, projectRoot } = await cloneFixture(root);
    await fs.writeFile(path.join(publisher, "new-default.txt"), "current upstream default\n");
    await git(publisher, "add", "new-default.txt");
    await git(publisher, "commit", "-m", "advance default");
    const expected = (await git(publisher, "rev-parse", "HEAD")).stdout.trim();
    await git(publisher, "push", upstream, "main");
    await git(projectRoot, "remote", "set-url", "origin", gitUrl);
    await git(projectRoot, "config", `url.${upstream}.insteadOf`, gitUrl);
    await git(projectRoot, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    const project = await registerProjectRegistry({
      path: projectRoot,
      name: "Credentialed local project",
    });
    const token = "synthetic-default-ref-credential";
    const revoke = vi.fn(async () => {});
    let active = true;
    const startCalls = vi.fn();
    const start = async <T>(run: () => T): Promise<Awaited<T>> => {
      startCalls();
      if (!active) {
        throw new Error("credential scope closed");
      }
      return await run();
    };
    const identity = vi
      .spyOn(projectIdentity, "prepareGatewayProjectGitHubIdentity")
      .mockResolvedValue({
        token,
        cacheScope: "fixture-repository-reader",
        assertSelected: () => {
          if (!active) {
            throw new Error("credential scope closed");
          }
        },
        revalidate: async () => {},
        start,
        revoke,
        selection: { source: "system-configured", profileId: "fixture", accountId: 1 },
      });
    const execute = gitExecution.executeGitCommand;
    const network: string[] = [];
    vi.spyOn(gitExecution, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      if (
        cwd === projectRoot &&
        (args[0] === "fetch" || (args[0] === "ls-remote" && args.includes("--symref")))
      ) {
        network.push(args[0]);
        // Isolated fetches move resolved policy into a protected config file to
        // avoid E2BIG. Prove what Git receives at launch across both transports.
        const effective = await execFileAsync(
          "git",
          [
            "-C",
            cwd,
            "config",
            "--null",
            "--get-regexp",
            "^(http\\.https://github\\.com/\\.extraheader|core\\.(hookspath|fsmonitor))$",
          ],
          { env: options?.env },
        );
        const config = new Map(
          effective.stdout
            .split("\0")
            .filter(Boolean)
            .map((field): [string, string] => {
              const separator = field.indexOf("\n");
              return [field.slice(0, separator), field.slice(separator + 1)];
            }),
        );
        if (
          config.get("http.https://github.com/.extraheader") !==
          `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
        ) {
          throw new Error("fixture origin rejected missing credentials");
        }
        expect(config.get("core.hookspath")).toBeTruthy();
        expect(config.get("core.fsmonitor")).toBe("false");
      }
      return execute(cwd, args, options);
    });
    const context = runContext();
    const created = await createRun(
      {
        ...(mode === "with-message"
          ? { message: "start" }
          : { displayName: "No-message creation acceptance" }),
        projectId: project.id,
      },
      { ...controlUiClient, context },
    );
    try {
      await settleWorkspaceRuns(context, storePath, created.key);
      if (mode === "without-message") {
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      }
      const owned = await managedWorktrees.findLiveByOwner("session", created.key);
      expect(owned).toBeDefined();
      expect((await git(owned!.path, "rev-parse", "HEAD")).stdout.trim()).toBe(expected);
      expect(await fs.readFile(path.join(owned!.path, "new-default.txt"), "utf8")).toBe(
        "current upstream default\n",
      );
      expect(network).toEqual(["ls-remote", "fetch"]);
      expect(identity).toHaveBeenCalledWith(
        expect.objectContaining({ requestedRepository: "openclaw/openclaw" }),
      );
      expect(startCalls).toHaveBeenCalled();
      expect(revoke).toHaveBeenCalledOnce();
      expect(
        (
          await git(projectRoot, "config", "--get-regexp", "http.*extraheader").catch(() => ({
            stdout: "",
          }))
        ).stdout,
      ).toBe("");
    } finally {
      active = false;
      await cleanupRun(context, storePath, created.key);
    }
  },
);
