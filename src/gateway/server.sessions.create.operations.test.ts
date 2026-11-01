import { expect, test, vi } from "vitest";
import type { SessionPlacementAdmissionProvider } from "../agents/session-placement-admission.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { readSessionCreationOperationInWorker } from "../config/sessions/session-creation-operation-read.js";
import { prepareSessionCreationOperation } from "../config/sessions/session-creation-operation.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
type Creation = {
  key: string;
  sessionId: string;
  creationOperationId: string;
  creationReplayed: boolean;
  runStarted: boolean;
};
function intent(issuedAt = Date.now(), separator = ":") {
  const hex = issuedAt.toString(16).padStart(12, "0");
  return {
    creationOperationId: `v1${separator}${issuedAt}${separator}0123456789abcdef0123456789abcdef`,
    sessionId: `${hex.slice(0, 8)}-${hex.slice(8)}-7c62-bef8-f26bc2e8c724`,
    label: "receipt-fixture",
  };
}
function client(email = "creation-owner@example.invalid") {
  return {
    connect: { role: "operator", scopes: ["operator.write", "operator.admin"] },
    authenticatedUserProfile: { profileId: ensureProfileForEmail(email).id },
  };
}

test.each([":", "-"])(
  "public durable creation returns original request-scoped proof, denies changed intent and never adopts a deleted target (%s)",
  async (separator) => {
    await createSessionStoreDir();
    const owner = client();
    const params = intent(Date.now(), separator);
    const first = await directSessionReq<Creation>("sessions.create", params, {
      client: owner as never,
    });
    expect(first.ok, JSON.stringify(first.error)).toBe(true);
    expect(first.payload).toMatchObject({
      sessionId: params.sessionId,
      creationOperationId: params.creationOperationId,
      creationReplayed: false,
      runStarted: false,
    });
    // Fresh caller context and no legacy idempotency key force native receipt reconciliation.
    const replay = await directSessionReq<Creation>("sessions.create", params, {
      client: owner as never,
      context: { dedupe: new Map() },
    });
    expect(replay.ok, JSON.stringify(replay.error)).toBe(true);
    expect(replay.payload).toMatchObject({
      key: first.payload!.key,
      sessionId: params.sessionId,
      creationOperationId: params.creationOperationId,
      creationReplayed: true,
      runStarted: false,
    });
    expect(
      (
        await directSessionReq(
          "sessions.create",
          { ...params, label: "changed" },
          { client: owner as never },
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await directSessionReq("sessions.create", params, {
          client: client("other@example.invalid") as never,
        })
      ).ok,
    ).toBe(false);
    const deleted = await directSessionReq(
      "sessions.delete",
      { key: first.payload!.key, deleteTranscript: true },
      { client: owner as never },
    );
    expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
    const missing = await directSessionReq("sessions.create", params, { client: owner as never });
    expect(missing.ok).toBe(false);
    expect(
      (
        await directSessionReq(
          "sessions.create",
          { ...params, agentId: "other-agent" },
          { client: owner as never },
        )
      ).ok,
    ).toBe(false);
  },
);

test("public durable creation rejects expired or mismatched physical issuance before creating", async () => {
  await createSessionStoreDir();
  const owner = client();
  const expired = intent(Date.now() - 30 * 24 * 60 * 60 * 1000 - 1);
  const old = await directSessionReq("sessions.create", expired, { client: owner as never });
  expect(old.ok).toBe(false);
  expect(old.error?.details).toMatchObject({ reason: "creation-operation-expired" });
  const fresh = intent();
  const reused = await directSessionReq(
    "sessions.create",
    { ...fresh, sessionId: expired.sessionId },
    { client: owner as never },
  );
  expect(reused.ok).toBe(false);
  expect(reused.error?.details).toMatchObject({ reason: "creation-operation-invalid" });
});

test("durable coding creation retains its repository and failed placement on replay without starting a turn", async () => {
  const { storePath } = await createSessionStoreDir();
  const config = await getGatewayConfigModule();
  await config.writeConfigFile({
    cloudWorkers: {
      requiredProfile: "dedicated-native",
      profiles: { "dedicated-native": { provider: "crabbox" } },
    },
  });
  const owner = client();
  const params = {
    ...intent(),
    purpose: "coding",
    repository: { url: "https://github.com/example/project.git", ref: "main" },
  };
  // Real creation/receipt/repository persistence; provider preparation stops at
  // its existing boundary. This proves no new allocation on replay, not a cloud turn.
  const withRequiredSession = vi.fn<
    NonNullable<SessionPlacementAdmissionProvider["withRequiredSession"]>
  >(async (_identity, _task, assertCurrent) => {
    assertCurrent?.();
    throw new Error("Worker preparation outcome is unknown; use placement recovery.");
  });
  const context = { workerPlacementDispatchService: { withRequiredSession } };
  type CodingCreation = Creation & { entry: { repositoryWorkspaceId: string }; runError?: unknown };
  const first = await directSessionReq<CodingCreation>("sessions.create", params, {
    client: owner as never,
    context,
  });
  expect(first.ok, JSON.stringify(first.error)).toBe(true);
  expect(first.payload).toMatchObject({
    sessionId: params.sessionId,
    creationReplayed: false,
    runStarted: false,
    runError: { message: expect.stringContaining("outcome is unknown") },
  });
  const repository = await getSessionRepositoryWorkspaceStore().find({
    agentId: "main",
    sessionKey: first.payload!.key,
  });
  expect(repository).toMatchObject({
    workspaceId: first.payload!.entry.repositoryWorkspaceId,
    url: params.repository.url,
    requestedRef: "main",
  });
  const replay = await directSessionReq<CodingCreation>("sessions.create", params, {
    client: owner as never,
    context: { ...context, dedupe: new Map() },
  });
  expect(replay.ok, JSON.stringify(replay.error)).toBe(true);
  expect(replay.payload).toMatchObject({
    key: first.payload!.key,
    sessionId: params.sessionId,
    creationReplayed: true,
    runStarted: false,
    entry: { repositoryWorkspaceId: repository!.workspaceId },
  });
  expect(withRequiredSession).toHaveBeenCalledOnce();
  await expect(
    readSessionCreationOperationInWorker(
      { agentId: "main", sessionKey: first.payload!.key, storePath },
      prepareSessionCreationOperation(
        owner.authenticatedUserProfile.profileId,
        params.creationOperationId,
        params.sessionId,
        params,
        Date.now(),
      ),
    ),
  ).resolves.toBe(true);
  for (const changed of [
    { ...params, repository: { ...params.repository, ref: "other" } },
    { ...params, repository: { url: "https://github.com/example/other.git", ref: "main" } },
  ]) {
    const conflict = await directSessionReq("sessions.create", changed, {
      client: owner as never,
      context,
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.details, JSON.stringify(conflict.error)).toMatchObject({
      reason: "creation-operation-conflict",
    });
  }
  expect(withRequiredSession).toHaveBeenCalledOnce();
});

test.each([
  { purpose: "coding" },
  { repository: { url: "https://github.com/example/project.git" } },
  { purpose: "coding", repository: { url: "https://github.com/example/project.git" }, task: "run" },
  {
    purpose: "coding",
    repository: { url: "https://github.com/example/project.git" },
    execNode: "n",
  },
  { purpose: "gateway", repository: { url: "https://github.com/example/project.git" } },
])("durable creation rejects unsupported coding intent %j", async (fields) => {
  await createSessionStoreDir();
  const result = await directSessionReq(
    "sessions.create",
    { ...intent(), ...fields },
    {
      client: client() as never,
    },
  );
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe("INVALID_REQUEST");
});

test("durable investigation creates an empty required-worker workspace and replays without preparing twice", async () => {
  const { storePath } = await createSessionStoreDir();
  const config = await getGatewayConfigModule();
  await config.writeConfigFile({
    cloudWorkers: {
      requiredProfile: "dedicated-native",
      profiles: { "dedicated-native": { provider: "crabbox" } },
    },
  });
  const params = { ...intent(), purpose: "investigation" };
  const owner = client();
  const withRequiredSession = vi.fn<
    NonNullable<SessionPlacementAdmissionProvider["withRequiredSession"]>
  >(async (_identity, task, assertCurrent) => {
    assertCurrent?.();
    return await task(() => assertCurrent?.());
  });
  const context = { workerPlacementDispatchService: { withRequiredSession } };
  const key = `agent:main:dashboard:${params.sessionId}`;
  try {
    const created = await directSessionReq<Creation>("sessions.create", params, {
      client: owner as never,
      context,
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload).toMatchObject({ sessionId: params.sessionId, runStarted: false });
    const entry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(entry?.worktree).toBeDefined();
    expect(entry?.repositoryWorkspaceId).toBeUndefined();
    const replay = await directSessionReq<Creation>("sessions.create", params, {
      client: owner as never,
      context: { ...context, dedupe: new Map() },
    });
    expect(replay.ok, JSON.stringify(replay.error)).toBe(true);
    expect(replay.payload).toMatchObject({ sessionId: params.sessionId, creationReplayed: true });
    expect(withRequiredSession).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.worktree).toEqual(
      entry?.worktree,
    );
  } finally {
    const workspace = await managedWorktrees.findLiveByOwner("session", key);
    if (workspace) {
      await managedWorktrees.remove({
        id: workspace.id,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
  }
});

test.each(["investigation", "coding"])(
  "explicit %s intent refuses missing required policy before session creation",
  async (purpose) => {
    const { storePath } = await createSessionStoreDir();
    const params = {
      ...intent(),
      purpose,
      ...(purpose === "coding"
        ? { repository: { url: "https://github.com/example/project.git" } }
        : {}),
    };
    const config = await getGatewayConfigModule();
    for (const cloudWorkers of [{}, { requiredProfile: "missing" }]) {
      await config.writeConfigFile({ cloudWorkers });
      const result = await directSessionReq("sessions.create", params, {
        client: client() as never,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("configured required worker profile");
      expect(
        loadSessionEntry({
          agentId: "main",
          sessionKey: `agent:main:dashboard:${params.sessionId}`,
          storePath,
        }),
      ).toBeUndefined();
    }
  },
);
