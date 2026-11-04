import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { GitHubIdentityError } from "../agents/github-read-identity.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { NodeWorkerPublicationConflictError } from "../worker/node-workspace-transfer-protocol.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  personalPublicationAccount,
  restartPersonalPublicationFixture,
} from "./github-personal-publication.test-support.js";
import { createGitHubPublicationRequesterFixture } from "./github-publication-requester.test-support.js";
import {
  SESSION_ID,
  SESSION_KEY,
  commandResult,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  root,
} from "./github-publication.test-support.js";
import { listRepositoryGitHubPublicationsInDatabase } from "./github-repository-publication-read.worker.js";
import { readGitHubRepositoryPublicationMetadata } from "./github-repository-publication-snapshot.js";
import { readRepositoryGitHubPublicationInDatabase } from "./github-repository-publication-store.worker.js";
import {
  createRepositoryPublicationFixture,
  repositoryPublicationTestUrl as url,
} from "./github-repository-publication.test-support.js";
import type { PrepareRepositoryPublicationIntegration } from "./repository-publication-checkpoint.js";

const readRepositoryGitHubPublication = (requestId: string) =>
  readRepositoryGitHubPublicationInDatabase(openOpenClawStateDatabase().db, requestId);

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));

// Cold reset imports are fixture preparation, outside the publication behavior's test budget.
await import("./session-reset-service.js");
await import("../agents/embedded-agent.js");

installGitHubPublicationTestHarness();
afterEach(() => vi.unstubAllGlobals());
it("fences publication reservations when the Gateway owner restarts", async () => {
  await createRepositoryPublicationFixture(checkpoint);
  const person = await createPersonalPublicationFixture();
  const previous = person.placements;
  await expect(
    previous.withWorkspaceExclusion(SESSION_ID, async (assertOwned) => {
      await restartPersonalPublicationFixture(person);
      expect(assertOwned).toThrow("was aborted");
    }),
  ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
  await expect(previous.withWorkspaceExclusion(SESSION_ID, async () => {})).rejects.toMatchObject({
    code: "OPENCLAW_STATE_LEASE_ABORTED",
  });
  await person.placements.withWorkspaceExclusion(SESSION_ID, async (assertOwned) => assertOwned());
});

it.each(["reset", "move", "held", "store-busy", "retired-owner"] as const)(
  "requires the same personal owner after restart and a later %s",
  async (boundary) => {
    const f = await createRepositoryPublicationFixture(checkpoint);
    const person = await createPersonalPublicationFixture();
    f.runtime.accountId = personalPublicationAccount.accountId;
    f.runtime.interruptPush = true;
    const selection = { generation: person.generation, account: personalPublicationAccount };
    const request = {
      sessionKey: SESSION_KEY,
      idempotencyKey: "personal",
      selection: {
        source: "personal",
        ...selection,
      },
    };
    const [ok, first, error] = await callPersonalPublicationRpc(
      person,
      "sessions.github.publish",
      request,
    );
    expect(ok, JSON.stringify(error)).toBe(true);
    const id = first.requestId;
    expect(first.status).toBe("needs_confirmation");
    const original = readRepositoryGitHubPublication(id)!;
    expect(original.pushed_head_commit).toBeNull();
    await f.capture("later unselected change\n", "later");
    const retiredCoordinator = person.coordinator;
    await restartPersonalPublicationFixture(person);
    const preparedStatus = await person.coordinator.preparePersonalStatus(id);
    using _ = { [Symbol.dispose]: () => preparedStatus?.release() };
    const status = (action = person.action) =>
      person.coordinator.personalStatusAsync(action, person.action, id, preparedStatus);
    const receipt = () => readRepositoryGitHubPublication(id);
    const pending = await status();
    expect(pending?.confirmation?.workspaceTree).toBe(f.first.workspaceTree);
    await expect(status({ ...person.action, owner: person.otherOwner })).rejects.toThrow();
    const sessionChanged = {
      result: { status: "failed", code: "session_changed" },
      confirmation: null,
    };
    if (boundary === "move") {
      await f.closeSession("move");
      expect(mocks.loadSession(SESSION_KEY).entry.repositoryWorkspaceId).toBeUndefined();
      expect(await status()).toMatchObject(sessionChanged);
      return;
    }
    if (boundary === "reset") {
      await f.closeSession("reset");
      const response = await callPersonalPublicationRpc(person, "sessions.github.status", {
        sessionKey: SESSION_KEY,
        requestId: id,
      });
      expect(response[1]).toMatchObject(sessionChanged);
    }
    const database = openOpenClawStateDatabase();
    const now = Date.now();
    const holder = { owner: "previous-publication-owner", epoch: now };
    let writer: DatabaseSync | undefined;
    if (boundary === "held") {
      database.db
        .prepare(
          "INSERT INTO state_leases (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
        )
        .run("session-workspace-action", SESSION_ID, holder.owner, now + 60000, now, now, now);
    } else if (boundary === "store-busy") {
      expect(
        database.db
          .prepare("SELECT owner FROM state_leases WHERE scope = ? AND lease_key = ?")
          .all("session-workspace-action", SESSION_ID),
      ).toEqual([]);
      // Restarted agent workers release their leases through shared state.
      await closeOpenClawAgentDatabasesAsync(root);
      writer = new DatabaseSync(database.path);
      writer.exec("BEGIN IMMEDIATE");
    }
    const confirmation = {
      sessionKey: SESSION_KEY,
      requestId: id,
      ...selection,
      requestDigest: pending!.confirmation!.requestDigest,
    };
    const confirm = () =>
      callPersonalPublicationRpc(person, "sessions.github.confirm", confirmation);
    if (boundary === "retired-owner") {
      const aborted = await callPersonalPublicationRpc(
        { ...person, coordinator: retiredCoordinator },
        "sessions.github.confirm",
        confirmation,
      );
      expect(aborted[0]).toBe(false);
      expect(aborted[2]).toMatchObject({ code: "UNAVAILABLE", retryable: false });
      expect(aborted[2].details.leaseAcquisition).toMatchObject({
        kind: "aborted",
        reason: "caller-signal",
        elapsedMs: expect.any(Number),
      });
      expect(aborted[2].details.leaseAcquisition.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(f.runtime.effects).toEqual(["push"]);
      expect(receipt()?.checkpoint_ref).toBe(original.checkpoint_ref);
    }
    let confirmed = await confirm().finally(() => {
      writer?.exec("ROLLBACK");
      writer?.close();
    });
    if (boundary === "held" || boundary === "store-busy") {
      const held = boundary === "held";
      expect(confirmed[0]).toBe(false);
      expect(confirmed[2]).toMatchObject({
        code: held ? "FORBIDDEN" : "UNAVAILABLE",
        retryable: !held,
      });
      expect(confirmed[2].details.leaseAcquisition).toMatchObject(
        held ? { kind: "held", holder } : { kind: "store-unavailable", reason: "sqlite-busy" },
      );
      if (held) {
        expect(confirmed[2].message).toEqual(
          expect.stringContaining(`${holder.owner} (lease epoch ${holder.epoch})`),
        );
      }
      expect(f.runtime.effects).toEqual(["push"]);
      expect(receipt()).toEqual(original);
      if (held) {
        return;
      }
      confirmed = await confirm();
    }
    if (boundary === "reset") {
      expect(confirmed[0]).toBe(false);
      expect(confirmed[2]).toMatchObject({ code: "FORBIDDEN" });
      expect(f.runtime.effects).toEqual(["push"]);
      return;
    }
    expect(confirmed[0], JSON.stringify(confirmed[2])).toBe(true);
    expect(confirmed[1]).toMatchObject({ status: "published", url });
    expect(receipt()).toMatchObject({
      checkpoint_ref: original.checkpoint_ref,
      pushed_head_commit: f.runtime.head,
    });
    expect(f.runtime.effects).toEqual(["push", "pull_request"]);
    expect(f.runtime.uploaded.size).toBe(1);
  },
);

async function laterManagedPublicationFixture(mismatch?: "tree" | "requester") {
  const f = await createRepositoryPublicationFixture(checkpoint);
  const transport = mocks.runCommand.getMockImplementation()!;
  mocks.runCommand.mockImplementation(async (args, options) =>
    args.some((arg: string) => arg.endsWith("/git/blobs"))
      ? { ...commandResult(), code: null, termination: "timeout" }
      : transport(args, options),
  );
  const original = { body: "Original description", draft: true };
  const failed = await f.publish("older-managed-request", original);
  expect(failed).toMatchObject({ status: "failed", code: "unavailable" });
  mocks.runCommand.mockImplementation(transport);
  if (mismatch === "tree") {
    await f.capture("different accepted work\n", "different-tree");
  }
  const requester =
    mismatch === "requester"
      ? (
          await createGitHubPublicationRequesterFixture({
            profileId: (await ensureCanonicalUserProfileForEmail("other-publisher@example.test"))
              .id,
            scopes: ["operator.admin"],
            sessionKey: SESSION_KEY,
            agentId: "main",
          })
        ).requester
      : undefined;
  const later = await f.publish("later-managed-request", {
    body: "Newer description to preserve",
    draft: true,
    requester,
  });
  expect(later).toMatchObject({ status: "published", url });
  // An older executor without detached integration cannot reconcile this branch.
  expect(await f.publish("older-managed-request", original)).toMatchObject({
    status: "failed",
    code: "push_rejected",
  });
  await f.coordinator.markReportedAsync(failed.requestId);
  expect(readRepositoryGitHubPublication(failed.requestId)?.reported_at_ms).not.toBeNull();
  return { f, original, failed, later, saved: readRepositoryGitHubPublication(failed.requestId)! };
}

it("retries the original rejected request after a pre-effect identity failure through its later owned PR", async () => {
  const { f, original, failed, later, saved } = await laterManagedPublicationFixture();
  const managedHead = f.runtime.head!;
  const description = f.runtime.pr!.body;
  f.git(["read-tree", f.baseTree]);
  const upstream = f.git(["hash-object", "-w", "--stdin"], "latest upstream\n");
  f.git(["update-index", "--add", "--cacheinfo", "100644", upstream, "main.txt"]);
  f.runtime.baseHeadTree = f.git(["write-tree"]);
  f.runtime.baseHead = f.git(
    ["commit-tree", f.runtime.baseHeadTree, "-p", f.baseCommit],
    "latest main\n",
  );
  const identity = await mocks.prepareIdentity();
  mocks.prepareIdentity.mockResolvedValue({
    ...identity,
    env: { ...identity.env, GH_TOKEN: "synthetic-integration-token" },
  });
  let credentialReady = false;
  const coordinator = createTestGitHubPublicationCoordinator({
    placements: f.placements,
    prepareRepositoryIntegration: async (_identity, input) => {
      if (!credentialReady) {
        throw new GitHubIdentityError("unverified");
      }
      expect(input.mainCommit).toBe(f.runtime.baseHead);
      const { snapshot } = await readGitHubRepositoryPublicationMetadata(
        input.snapshotRoot,
        input.snapshotDigest,
      );
      f.git(["read-tree", f.runtime.baseHeadTree]);
      const repair = snapshot.entries[0]!;
      f.git(["update-index", "--add", "--cacheinfo", "100644", repair.sha!, repair.path]);
      return {
        snapshotRoot: input.snapshotRoot,
        knownBlobs: [upstream],
        release: async () => {},
        snapshot: {
          ...snapshot,
          workspaceTree: f.git(["write-tree"]),
          baseCommit: f.runtime.baseHead,
          baseTree: f.runtime.baseHeadTree,
        },
      };
    },
  });
  f.runtime.uploaded.clear();
  expect(
    await coordinator.requestForSessionV2({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "older-managed-request",
      ...original,
    }),
  ).toMatchObject({ requestId: failed.requestId, status: "failed", code: "identity_unavailable" });
  expect(f.runtime.effects).toEqual(["push", "pull_request"]);
  credentialReady = true;
  f.runtime.interruptPush = true;
  const result = await coordinator.requestForSessionV2({
    agentId: "main",
    sessionKey: SESSION_KEY,
    idempotencyKey: "older-managed-request",
    ...original,
  });
  expect(result).toMatchObject({ requestId: failed.requestId, status: "requested" });
  await coordinator.resumeSessionRequests();
  expect(await coordinator.readAsync(failed.requestId)).toMatchObject({ status: "published", url });
  expect(f.git(["rev-parse", `${f.runtime.head}^1`])).toBe(managedHead);
  expect(f.git(["rev-parse", `${f.runtime.head}^2`])).toBe(f.runtime.baseHead);
  expect(f.git(["show", `${f.runtime.head}:counter.txt`])).toBe("accepted first");
  expect(f.git(["show", `${f.runtime.head}:main.txt`])).toBe("latest upstream");
  expect(f.casRequests[1]).toMatchObject({ beforeOid: managedHead, force: false });
  expect(f.runtime.effects).toEqual(["push", "pull_request", "push"]);
  expect(f.runtime.pr!.body).toBe(description);
  expect(f.runtime.pr!.body).toContain(later.requestId);
  expect(f.runtime.uploaded.size).toBe(0);
  expect(readRepositoryGitHubPublication(failed.requestId)).toMatchObject({
    request_digest: saved.request_digest,
    previous_head_commit: null,
    requester_authority_json: saved.requester_authority_json,
    checkpoint_ref: saved.checkpoint_ref,
    checkpoint_digest: saved.checkpoint_digest,
    workspace_tree: saved.workspace_tree,
    reported_at_ms: null,
  });
  expect(
    listRepositoryGitHubPublicationsInDatabase(openOpenClawStateDatabase().db, {}),
  ).toHaveLength(2);
});

it.each(["external head", "tree", "requester", "PR publisher"] as const)(
  "does not reconcile the original request with a mismatched %s",
  async (mismatch) => {
    const { f, original, saved } = await laterManagedPublicationFixture(
      mismatch === "tree" || mismatch === "requester" ? mismatch : undefined,
    );
    if (mismatch === "external head") {
      f.runtime.head = f.git(
        ["commit-tree", f.first.workspaceTree, "-p", f.baseCommit],
        "External commit with the same tree\n",
      );
      f.runtime.pr!.headSha = f.runtime.head;
    } else if (mismatch === "PR publisher") {
      f.runtime.pr!.userId = 99;
    }
    const integrate = vi.fn<PrepareRepositoryPublicationIntegration>();
    const coordinator = createTestGitHubPublicationCoordinator({
      placements: f.placements,
      prepareRepositoryIntegration: integrate,
    });
    const before = mocks.runCommand.mock.calls.length;
    expect(
      await coordinator.requestForSessionV2({
        agentId: "main",
        sessionKey: SESSION_KEY,
        idempotencyKey: "older-managed-request",
        ...original,
      }),
    ).toMatchObject({ status: "failed" });
    expect(integrate).not.toHaveBeenCalled();
    expect(mocks.runCommand.mock.calls.slice(before).some(([args]) => args.includes("POST"))).toBe(
      false,
    );
    expect(readRepositoryGitHubPublication(saved.request_id)).toMatchObject({
      request_digest: saved.request_digest,
      head_commit: null,
      last_effect: null,
      pull_request_url: null,
    });
    expect(f.runtime.effects).toEqual(["push", "pull_request"]);
  },
);

it("reports a managed-input merge conflict without claiming the prior PR as a new result", async () => {
  const { f, original, saved } = await laterManagedPublicationFixture();
  const head = f.runtime.head;
  const description = f.runtime.pr!.body;
  const identity = await mocks.prepareIdentity();
  mocks.prepareIdentity.mockResolvedValue({
    ...identity,
    env: { ...identity.env, GH_TOKEN: "synthetic-integration-token" },
  });
  const coordinator = createTestGitHubPublicationCoordinator({
    placements: f.placements,
    prepareRepositoryIntegration: async () => {
      throw new NodeWorkerPublicationConflictError();
    },
  });
  expect(
    await coordinator.requestForSessionV2({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "older-managed-request",
      ...original,
    }),
  ).toMatchObject({
    status: "failed",
    code: "workspace_changed",
    nextAction: expect.stringContaining("merge conflicts"),
  });
  expect(readRepositoryGitHubPublication(saved.request_id)).toMatchObject({
    request_digest: saved.request_digest,
    workspace_tree: saved.workspace_tree,
    head_commit: null,
    last_effect: null,
    pull_request_url: null,
  });
  expect(f.runtime.head).toBe(head);
  expect(f.runtime.pr!.body).toBe(description);
  expect(f.runtime.effects).toEqual(["push", "pull_request"]);
});
