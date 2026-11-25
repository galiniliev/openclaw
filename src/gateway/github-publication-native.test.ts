// Install provider transport fixtures before importing the native publication owners.
// oxfmt-ignore
import { commandResult, githubPublicationTestMocks, installGitHubPublicationTestHarness, SESSION_ID, SESSION_KEY } from "./github-publication.test-support.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { notifyManagedGitHubProfileChanged } from "../agents/github-tool-identity-lifecycle.js";
import { GitHubIdentityError } from "../agents/github-tool-identity.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { holdNextReply } from "../state/github-publication.worker.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createPersonalPublicationFixture,
  personalPublicationAccount,
  personalPublicationRequest,
  preparePersonalPublicationFixtureAction,
} from "./github-personal-publication.test-support.js";
import { registerPublicationCredentialFixture } from "./github-publication-credential.test-helpers.js";
import {
  prepareGitHubPublicationWorkerIdentity,
  createGitHubPublicationExecutionIdentityOwner,
} from "./github-publication-execution-identity.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { createNativePublicationTransport } from "./github-publication-native.test-support.js";
import {
  createRequesterPublicationFixture,
  publicationGuestEmail as email,
} from "./github-publication-requester.test-support.js";
import { readRepositoryGitHubPublicationFixture as readRepositoryGitHubPublication } from "./github-publication-store.test-support.js";
import { readRepositoryGitHubPublicationInDatabase } from "./github-repository-publication-store.worker.js";
import { createRepositoryPublicationFixture } from "./github-repository-publication.test-support.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
// mock-isolation: Checkpoint capture is fixture-owned; requester/source/receipt and native transfer owners are real.
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryPublicationCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));
const fixture = createRequesterPublicationFixture.bind(undefined, checkpoint);
const request = (f: Awaited<ReturnType<typeof fixture>>, key: string) =>
  f.coordinator.requestForSessionV2(f.request(key, f.guest));

describe("combined native publication proof", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: email,
    sandbox: "required",
    realWorktree: true,
  });
  it.each(["known", "unavailable"] as const)(
    "reuses reachable upstream blobs through native integration (%s)",
    async (lookup) => {
      const f = await fixture("repository");
      const repository = f.repository!;
      const upstream = Object.fromEntries(
        Array.from({ length: 16 }, (_, i) => [`upstream-${i}.txt`, `known upstream ${i}\n`]),
      );
      repository.git(["read-tree", repository.baseTree]);
      for (const [file, text] of Object.entries(upstream)) {
        const sha = repository.git(["hash-object", "-w", "--stdin"], text);
        repository.git(["update-index", "--add", "--cacheinfo", "100644", sha, file]);
      }
      repository.runtime.baseHeadTree = repository.git(["write-tree"]);
      repository.runtime.baseHead = repository.git(
        ["commit-tree", repository.runtime.baseHeadTree, "-p", repository.baseCommit],
        "upstream changes\n",
      );
      const accepted = await repository.capture(
        "one novel user blob\n",
        "known-upstream",
        upstream,
      );
      const transport = await createNativePublicationTransport(f, []);
      repository.git(["update-ref", "refs/heads/main", repository.runtime.baseHead]);
      transport.recoverProvider();
      const route = mocks.runCommand.getMockImplementation()!;
      if (lookup === "unavailable") {
        mocks.runCommand.mockImplementation((args, options) =>
          args.some((a) => a.includes("/git/trees/") && a.endsWith("?recursive=1"))
            ? Promise.resolve(commandResult("", 1))
            : route(args, options),
        );
      }
      const result = await request(f, "reuse-native-upstream");
      expect(result).toMatchObject({ status: "published" });
      expect(repository.runtime.uploaded.size).toBe(lookup === "known" ? 1 : 17);
      expect([...repository.runtime.uploaded.values()].map((b) => b.toString())).toContain(
        "one novel user blob\n",
      );
      const bulkReads = mocks.runCommand.mock.calls.flatMap(([args]) =>
        args.filter((a) => a.includes("/git/trees/") && a.endsWith("?recursive=1")),
      );
      expect(bulkReads.length).toBeLessThanOrEqual(3);
      expect(
        mocks.runCommand.mock.calls.some(
          ([args]) => args.includes("GET") && args.some((a) => a.includes("/git/blobs/")),
        ),
      ).toBe(false);
      expect(repository.git(["rev-parse", `${transport.readRef()}^{tree}`])).toBe(
        accepted.workspaceTree,
      );
      expect(transport.observed.physicalCas).toBe(1);
    },
  );
  it("publishes through worker App admission with the original requester and execution binding", async () => {
    const f = await createRequesterPublicationFixture(checkpoint, "repository");
    const profileId = "ghp_00000000000000000000000000000001";
    f.config.tools = {
      github: {
        kind: "app-installation",
        profileId,
        app: {
          appId: 10,
          installationId: 20,
          accountId: 42,
          repositories: [{ id: 40, fullName: "owner/repository" }],
          permissions: { contents: "write", metadata: "read", pull_requests: "write" },
          privateKey: "synthetic",
          keyVersion: "synthetic-v1",
        },
      },
    };
    let executionAdmitted = false;
    const events: string[] = [];
    registerPublicationCredentialFixture(f, events, (context) => {
      expect(context.actor.profileId).toBe(f.guestProfile);
      expect(context.actor.sessionKey).toBe(f.session.sessionKey);
      if (context.operation.purpose === "publication-execution") {
        const binding = context.operation.binding;
        const row = readRepositoryGitHubPublicationInDatabase(f.database.db, binding.requestId);
        expect(binding).toMatchObject({
          kind: "publication",
          sessionId: f.session.sessionId,
          sessionKey: f.session.sessionKey,
          executionKind: "repository",
          requestDigest: row?.request_digest,
          ownerId: row?.execution_id,
        });
        executionAdmitted = true;
      }
    });
    const revoke = vi.fn(async () => {});
    mocks.prepareIdentity.mockImplementation(async (params) => {
      await params.readNativeCredential?.(params.env ?? {});
      return {
        source: "system-configured",
        profileId,
        account: { accountId: 42, login: "roboclaw-bot", avatarUrl: null },
        env: { GH_TOKEN: "synthetic-app-token" },
        revoke,
      };
    });
    const sourceRead = holdNextReply("githubPublication.sourceFacts");
    onTestFinished(() => sourceRead.release());
    const publishing = f.coordinator.requestForSessionV2(
      f.request("worker-app-authority", f.guest),
    );
    try {
      await Promise.race([
        sourceRead.ready,
        publishing.then(() => {
          throw new Error("Publication settled before native source preparation");
        }),
      ]);
      sessionChanges.emit({ all: true, scope: "runtime" });
    } finally {
      sourceRead.release();
    }
    const result = await publishing;
    expect(result).toMatchObject({ status: "published" });
    expect(executionAdmitted).toBe(true);
    expect(mocks.prepareRepositoryIntegration).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalled();
  });

  it.each([
    "allowed",
    "read-throttled",
    "revoked",
    "different-requester",
    "placement-moving",
    "custody-revoked",
  ] as const)(
    "retains the accepted request across a pre-effect 503 and coordinator restart: %s",
    async (scenario) => {
      const f = await fixture("repository", undefined, { requestedRef: "topic" });
      const repository = f.repository!;
      const events: string[] = [];
      const canary = registerPublicationCredentialFixture(f, events);
      const native = await createNativePublicationTransport(f, events);
      if (scenario === "read-throttled") {
        native.recoverProvider();
        const provider = mocks.runCommand.getMockImplementation()!;
        let repositoryReads = 0;
        mocks.runCommand.mockImplementation((argv, options) => {
          // Target selection and publisher observation succeed; the execution-reader
          // probe is throttled before any native integration or publication effect.
          if (argv.includes("repos/owner/repository") && ++repositoryReads === 3) {
            return {
              ...commandResult("", 1),
              stderr: Buffer.from("synthetic secondary rate limit (HTTP 403)"),
            };
          }
          return provider(argv, options);
        });
      }
      const beforeRef = native.readRef();
      expect(beforeRef).toBe("");
      const first = await request(f, "combined-retry");
      expect(first).toMatchObject({
        status: "failed",
        code: "unavailable",
        nextAction: expect.stringContaining(
          scenario === "read-throttled" ? "HTTP 403" : "HTTP 503",
        ),
      });
      const accepted = readRepositoryGitHubPublication(first.requestId)!;
      expect(accepted).toMatchObject({
        base_branch: "main",
        checkpoint_ref: repository.first.ref,
        last_effect: null,
      });
      expect(native.readRef()).toBe(beforeRef);
      expect(repository.runtime.effects).toEqual([]);
      const integrated = scenario === "read-throttled" ? 0 : 1;
      expect(native.observed.nativeExecutions).toBe(integrated);
      expect(native.observed.gitFetches).toBe(integrated * 2);
      if (integrated) {
        expect(native.observed.httpRequests).toBeGreaterThan(0);
      } else {
        expect(native.observed.httpRequests).toBe(0);
      }
      expect(native.observed.admissions).toBe(integrated);
      const beforeRetry = { ...native.observed };
      native.recoverProvider();
      if (scenario === "revoked") {
        await f.revoke();
      } else if (scenario === "placement-moving") {
        const active = await f.placements.getAsync(f.session.sessionId);
        if (active?.state !== "active") {
          throw new Error("Expected an admitted active placement");
        }
        await f.placements.beginPlacementMove({
          sessionId: f.session.sessionId,
          source: {
            generation: active.generation,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          },
          target: { kind: "profile", profileId: "other-worker" },
        });
      } else if (scenario === "custody-revoked") {
        await native.revokeCustody();
      }
      const restarted = f.restart();
      const retry = restarted.requestForSessionV2(
        f.request("combined-retry", scenario === "different-requester" ? f.maintainer : f.guest),
      );
      if (scenario === "allowed" || scenario === "read-throttled") {
        await expect(retry).resolves.toMatchObject({
          status: "published",
          requestId: first.requestId,
        });
        expect(native.observed.physicalCas).toBe(1);
        expect(repository.runtime.effects).toEqual(["push", "pull_request"]);
        expect(repository.runtime.pr?.baseRef).toBe("main");
        expect(native.readRef()).toBe(repository.runtime.head);
        expect(repository.git(["rev-parse", native.ref + "^{tree}"])).toBe(
          repository.first.workspaceTree,
        );
        expect(repository.git(["show", native.ref + ":counter.txt"])).toBe("accepted first");
        expect(repository.git(["rev-parse", native.ref + "^2"])).toBe(repository.baseCommit);
        expect(repository.git(["rev-parse", native.ref + "^1^1"])).toBe(repository.baseCommit);
        expect(repository.git(["rev-parse", native.ref + "^1^{tree}"])).toBe(
          repository.first.workspaceTree,
        );
        expect(
          repository.git(["rev-list", "--parents", "-n", "1", native.ref]).split(" "),
        ).toHaveLength(3);
        expect(repository.git(["rev-parse", "refs/heads/main"])).toBe(repository.baseCommit);
        expect(repository.git(["rev-parse", "refs/heads/topic"])).toBe(repository.baseCommit);
        await restarted.resumeSessionRequests();
        expect(native.observed.physicalCas).toBe(1);
      } else {
        if (scenario === "custody-revoked") {
          await expect(retry).resolves.toMatchObject({
            status: "failed",
            code: "workspace_changed",
            requestId: first.requestId,
          });
        } else if (scenario === "placement-moving") {
          await expect(retry).rejects.toThrow("The repository checkpoint is busy");
        } else if (scenario === "different-requester") {
          await expect(retry).rejects.toThrow("different requester");
        } else {
          await expect(retry).rejects.toBeInstanceOf(GitHubPublicationRequesterUnavailableError);
        }
        expect(native.readRef()).toBe(beforeRef);
        expect(native.observed.physicalCas).toBe(0);
        expect(native.observed.nativeExecutions).toBe(beforeRetry.nativeExecutions);
        expect(native.observed.gitFetches).toBe(beforeRetry.gitFetches);
        expect(native.observed.httpRequests).toBe(beforeRetry.httpRequests);
        expect(repository.runtime.effects).toEqual([]);
        // A pending move blocks effects after same-key reopening; it retains recoverable work, not a terminal failure.
        expect(readRepositoryGitHubPublication(first.requestId)?.status).toBe(
          scenario === "placement-moving" ? "requested" : "failed",
        );
      }
      const settled = readRepositoryGitHubPublication(first.requestId)!;
      expect(settled).toMatchObject({
        request_id: accepted.request_id,
        request_digest: accepted.request_digest,
        checkpoint_ref: accepted.checkpoint_ref,
        checkpoint_digest: accepted.checkpoint_digest,
        previous_head_commit: accepted.previous_head_commit,
        workspace_tree: accepted.workspace_tree,
      });
      const trace = JSON.stringify({
        scenario,
        beforeRef,
        afterRef: native.readRef(),
        requestId: settled.request_id,
        checkpoint: settled.checkpoint_ref,
        checkpointDigest: settled.checkpoint_digest,
        digest: settled.request_digest,
        baseBranch: settled.base_branch,
        workspaceTree: settled.workspace_tree,
        afterFirstFailure: beforeRetry,
        status: settled.status,
        intentionalPending: scenario === "placement-moving",
        effects: repository.runtime.effects,
        ...native.observed,
      });
      expect(trace).not.toContain(canary);
      expect(trace).not.toContain("synthetic-provider-canary");
      expect(JSON.stringify(first)).not.toContain("synthetic-provider-canary");
      console.info("PUBLICATION_BOUNDARY_TRACE " + trace);
    },
  );
});

describe("personal publisher credential custody", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "alice@example.test",
    sandbox: "required",
    realWorktree: true,
  });
  it.each([
    "allowed",
    "requester-revoked",
    "execution-reselected",
    "cancelled-before",
    "cancelled-after",
    "read-denied",
    "target-read-denied",
    "execution-unavailable",
    "selection-after",
  ] as const)("publishes personally with worker execution identity: %s", async (scenario) => {
    const repository = await createRepositoryPublicationFixture(checkpoint);
    const originalFetch = globalThis.fetch;
    const person = await createPersonalPublicationFixture();
    const cancellation = new AbortController();
    person.action = await preparePersonalPublicationFixtureAction(person, cancellation.signal);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    repository.runtime.accountId = personalPublicationAccount.accountId;
    person.config.gateway = {};
    const events: string[] = [];
    const sharedToken = registerPublicationCredentialFixture(person, events);
    const actualIdentity = await vi.importActual<
      typeof import("../agents/github-tool-identity.js")
    >("../agents/github-tool-identity.js");
    mocks.prepareIdentity.mockImplementation(actualIdentity.prepareGitHubPublicationIdentity);
    mocks.matchesIdentity.mockImplementation(
      actualIdentity.matchesPreparedGitHubPublicationIdentity,
    );
    const sharedProfile = "ghp_77777777777777777777777777777777";
    person.config.tools = { github: { profileId: sharedProfile } };
    await actualIdentity.writeManagedGitHubProfileFiles(
      actualIdentity.resolveManagedGitHubProfileDir({
        scope: "system",
        agentId: "main",
        profileId: sharedProfile,
      }),
      { login: "shared-reader", token: sharedToken },
    );
    const personalToken = "synthetic-personal-credential-" + person.generation;
    const personalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
        if (
          url === "https://api.github.com/user" &&
          new Headers(options?.headers).get("Authorization") === "Bearer " + sharedToken
        ) {
          return Response.json({ id: 42, login: "shared-reader" });
        }
        return (url instanceof Request ? url.url : url.toString()).startsWith("http://127.0.0.1:")
          ? originalFetch(url, options)
          : personalFetch(url, options);
      },
    );
    let negativeExercised = false;
    let personalAtWorker = false;
    let sharedAtWorker = false;
    let personalApiCalls = 0;
    const forms = [
      personalToken,
      Buffer.from("x-access-token:" + personalToken).toString("base64"),
      encodeURIComponent(personalToken),
    ];
    const native = await createNativePublicationTransport(
      {
        repository,
        database: openOpenClawStateDatabase(),
        session: { sessionId: SESSION_ID, sessionKey: SESSION_KEY },
        placements: person.placements,
        config: person.config,
        guest: person.action,
      },
      events,
      {
        worker: (value) => {
          if (scenario === "selection-after" && value.includes('"fetch"')) {
            negativeExercised = true;
            expect(integrationSignal?.aborted).toBe(false);
            setRuntimeConfigSnapshot({
              ...person.config,
              tools: { github: { profileId: "ghp_88888888888888888888888888888888" } },
            });
            expect(integrationSignal?.aborted).toBe(true);
          }
          if (scenario === "cancelled-after" && value.includes('"fetch"')) {
            negativeExercised = true;
            cancellation.abort(new Error("Publication cancelled after worker dispatch"));
          }
          personalAtWorker ||= forms.some((secret) => value.includes(secret));
          sharedAtWorker ||=
            value.includes(sharedToken) ||
            value.includes(Buffer.from("x-access-token:" + sharedToken).toString("base64"));
        },
        publisher: (env, argv) => {
          if (env?.GH_TOKEN === sharedToken) {
            expect(argv).toContain("repos/owner/repository");
            expect(argv).not.toContain("POST");
            return;
          }
          expect(env?.GH_TOKEN === personalToken).toBe(true);
          personalApiCalls++;
        },
      },
    );
    const integrate = mocks.prepareRepositoryIntegration.getMockImplementation()!;
    let integrationSignal: AbortSignal | undefined;
    mocks.prepareRepositoryIntegration.mockImplementation(async (identity, input) => {
      integrationSignal = input.signal;
      negativeExercised ||= [
        "requester-revoked",
        "execution-reselected",
        "cancelled-before",
      ].includes(scenario);
      if (scenario === "requester-revoked") {
        person.runtime.live = false;
      }
      if (scenario === "execution-reselected") {
        person.config.tools!.github = { profileId: "ghp_88888888888888888888888888888888" };
      }
      if (scenario === "cancelled-before") {
        cancellation.abort(new Error("Publication cancelled before transfer"));
      }
      return integrate(identity, input);
    });
    if (scenario === "read-denied" || scenario === "target-read-denied") {
      const provider = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation((argv, options) => {
        const deniedRepository =
          scenario === "read-denied" ? "owner/repository" : "upstream/repository";
        if (
          (options?.preparedEnv ?? options?.env)?.GH_TOKEN === sharedToken &&
          argv.includes("repos/" + deniedRepository)
        ) {
          negativeExercised = true;
          return {
            ...commandResult("", 1),
            stderr: Buffer.from("synthetic access denied (HTTP 404)"),
          };
        }
        if (scenario === "target-read-denied" && argv.includes("repos/owner/repository")) {
          return commandResult(
            JSON.stringify({
              node_id: "repository-node",
              fork: true,
              default_branch: "main",
              parent: { name: "repository", owner: { login: "upstream" }, default_branch: "main" },
            }),
          );
        }
        return provider(
          argv.map((arg: string) =>
            arg.replace("repos/upstream/repository", "repos/owner/repository"),
          ),
          options,
        );
      });
    }
    if (scenario === "execution-unavailable") {
      await actualIdentity.removeManagedGitHubProfile(
        actualIdentity.resolveManagedGitHubProfileDir({
          scope: "system",
          agentId: "main",
          profileId: sharedProfile,
        }),
      );
      negativeExercised = true;
    }
    native.recoverProvider();
    const result = await person.coordinator
      .requestPersonalForSessionV2(
        personalPublicationRequest(person, "personal-custody"),
        person.action,
      )
      .catch(() => ({ status: "rejected" as const }));
    if (scenario !== "allowed") {
      expect(negativeExercised).toBe(true);
      if (scenario === "execution-unavailable") {
        expect(result).toMatchObject({
          status: "failed",
          code: "identity_unavailable",
          nextAction: expect.stringContaining("normal worker GitHub execution account"),
        });
      }
      if (scenario === "read-denied" || scenario === "target-read-denied") {
        expect(result).toMatchObject({
          status: "failed",
          code: "identity_unavailable",
          nextAction: expect.stringContaining("source or target repository"),
        });
      }
      if (["execution-reselected", "selection-after"].includes(scenario)) {
        expect(result).toMatchObject({
          status: "failed",
          code: "identity_changed",
          nextAction: expect.stringContaining("worker execution GitHub account"),
        });
      }
      expect(result.status).not.toBe("published");
      expect(native.observed.nativeExecutions).toBe(
        ["cancelled-after", "selection-after"].includes(scenario) ? 1 : 0,
      );
      expect(native.observed.physicalCas).toBe(0);
      expect(repository.runtime.effects).toEqual([]);
      expect(personalAtWorker).toBe(false);
      if (
        scenario !== "read-denied" &&
        scenario !== "target-read-denied" &&
        scenario !== "execution-unavailable"
      ) {
        expect(integrationSignal?.aborted).toBe(true);
      }
      if (scenario === "execution-reselected") {
        person.config.tools!.github = { profileId: sharedProfile };
        const replay = await person.coordinator.requestPersonalForSessionV2(
          personalPublicationRequest(person, "personal-custody"),
          person.action,
        );
        // Terminal personal receipts are immutable: repairing the worker does not
        // reopen the old action or silently create a new request.
        expect(replay).toEqual(result);
        expect(native.observed.physicalCas).toBe(0);
      }
      return;
    }
    expect(integrationSignal?.aborted).toBe(true);
    expect(result.status).toBe("published");
    expect(native.observed.physicalCas).toBe(1);
    expect(repository.runtime.effects).toEqual(["push", "pull_request"]);
    expect(repository.runtime.pr?.userId).toBe(personalPublicationAccount.accountId);
    expect(native.readRef()).toBe(repository.runtime.head);
    expect(repository.git(["show", native.ref + ":counter.txt"])).toBe("accepted first");
    expect(personalApiCalls).toBeGreaterThan(0);
    expect(personalAtWorker).toBe(false);
    expect(sharedAtWorker).toBe(true);
  });
});

const workerIdentityOwner = (assertCurrent: () => void) =>
  createGitHubPublicationExecutionIdentityOwner(() => ({
    row: {
      agent_id: "main",
      session_key: SESSION_KEY,
      session_id: SESSION_ID,
      request_id: "credential-lifetime-fixture",
      request_digest: "credential-lifetime-fixture",
    },
    actor: undefined,
    lifecycleRevision: null,
    executionKind: "repository",
    ownerId: "credential-lifetime-fixture",
    assertCurrent,
  }));

describe("publication worker credential lifetime", () => {
  installGitHubPublicationTestHarness();
  it.each([
    "expiry",
    "profile-rotation",
    "release",
    "acquisition-revoked",
    "acquisition-rotation",
    "acquisition-rate-limited",
    "refresh-rotation",
    "runtime-selection",
  ] as const)("closes the fixed operation and joins local cleanup: %s", async (scenario) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let authority = true;
    const assertCurrent = vi.fn(() => {
      if (!authority) {
        throw new Error("Publication owner revoked");
      }
    });
    const identity = {
      source: "system-configured" as const,
      profileId: "ghp_77777777777777777777777777777777",
      account: { accountId: 42, login: "shared-reader" },
      env: { GH_TOKEN: "synthetic-operation-only", GH_CONFIG_DIR: "/synthetic-profile" },
      accessExpiresAtMs: Date.now() + 1_000,
    };
    mocks.refreshIdentity.mockImplementation(async () => {
      if (scenario === "refresh-rotation") {
        notifyManagedGitHubProfileChanged({
          profileDir: identity.env.GH_CONFIG_DIR,
          kind: "updated",
        });
      }
    });
    mocks.prepareIdentity.mockImplementation(async () => {
      if (scenario === "acquisition-rate-limited") {
        throw new GitHubIdentityError("rate_limited");
      }
      if (scenario === "acquisition-rotation") {
        notifyManagedGitHubProfileChanged({
          profileDir: identity.env.GH_CONFIG_DIR,
          kind: "updated",
        });
      }
      if (scenario === "acquisition-revoked") {
        authority = false;
      }
      return identity;
    });
    let owned: Awaited<ReturnType<typeof prepareGitHubPublicationWorkerIdentity>> | undefined;
    const timersBefore = vi.getTimerCount();
    const abort = vi.spyOn(AbortController.prototype, "abort");
    try {
      const preparing = prepareGitHubPublicationWorkerIdentity({
        agentId: "main",
        assertCurrent,
        identity: workerIdentityOwner(assertCurrent),
      });
      if (scenario === "acquisition-rate-limited") {
        await expect(preparing).rejects.toMatchObject({
          failure: { code: "unavailable", nextAction: expect.stringContaining("rate limit") },
        });
      } else if (scenario === "acquisition-revoked" || scenario === "acquisition-rotation") {
        if (scenario === "acquisition-revoked") {
          await expect(preparing).rejects.toThrow("Publication owner revoked");
        } else {
          await expect(preparing).rejects.toMatchObject({
            failure: {
              code: "identity_changed",
              nextAction: expect.stringContaining("explicitly request publication again"),
            },
          });
        }
      } else {
        owned = await preparing;
        owned.assertCurrent();
        if (scenario === "runtime-selection") {
          sessionChanges.emit({ all: true, scope: "config" });
          expect(owned.signal.aborted).toBe(false);
          mocks.matchesIdentity.mockReturnValue(false);
          sessionChanges.emit({ all: true, scope: "config" });
        } else if (scenario === "expiry") {
          await vi.advanceTimersByTimeAsync(1_000);
        } else if (scenario === "profile-rotation") {
          notifyManagedGitHubProfileChanged({
            profileDir: identity.env.GH_CONFIG_DIR,
            kind: "updated",
          });
        } else {
          await owned.release();
        }
        expect(owned.signal.aborted).toBe(true);
        expect(() => owned!.assertCurrent()).toThrow();
      }
    } finally {
      await owned?.release();
      const checks = abort.mock.calls.length;
      notifyManagedGitHubProfileChanged({
        profileDir: identity.env.GH_CONFIG_DIR,
        kind: "removed",
      });
      expect(abort).toHaveBeenCalledTimes(checks);
      abort.mockRestore();
      expect(vi.getTimerCount()).toBe(timersBefore);
      vi.useRealTimers();
    }
  });
  it.each([false, true])(
    "uses committed selection during secrets activation (changed: %s)",
    async (changed) => {
      const state = await vi.importActual<typeof import("../secrets/runtime-state.js")>(
        "../secrets/runtime-state.js",
      );
      const revisions = await import("../agents/auth-profiles/runtime-snapshots.js");
      const { createEmptyRuntimeWebToolsMetadata } =
        await import("../secrets/runtime-fast-path.js");
      const actualIdentity = await vi.importActual<
        typeof import("../agents/github-tool-identity.js")
      >("../agents/github-tool-identity.js");
      mocks.getConfigSnapshot.mockImplementation(state.getActiveSecretsRuntimeConfigSnapshot);
      mocks.matchesIdentity.mockImplementation(
        actualIdentity.matchesPreparedGitHubPublicationIdentity,
      );
      const original = "ghp_11111111111111111111111111111111";
      const replacement = "ghp_99999999999999999999999999999999";
      const activate = (profileId: string, port: number) => {
        const config = { tools: { github: { profileId } }, gateway: { port } };
        state.activateSecretsRuntimeSnapshotState({
          snapshot: {
            sourceConfig: config,
            config,
            authStores: [],
            authStoreCredentialsRevision: revisions.getRuntimeAuthProfileStoreCredentialsRevision(),
            authStoreSnapshotsRevision: revisions.getRuntimeAuthProfileStoreSnapshotsRevision(),
            warnings: [],
            webTools: createEmptyRuntimeWebToolsMetadata(),
          },
          refreshContext: null,
          refreshHandler: null,
        });
      };
      activate(original, 19001);
      const worker = await prepareGitHubPublicationWorkerIdentity({
        agentId: "main",
        assertCurrent: () => {},
        identity: workerIdentityOwner(() => {}),
      });
      let profileAtNotification: string | undefined;
      const stop = sessionChanges.subscribe((change) => {
        if (change.scope === "config") {
          profileAtNotification =
            state.getActiveSecretsRuntimeConfigSnapshot()?.config.tools?.github?.profileId;
        }
      });
      try {
        activate(changed ? replacement : original, 19002);
        expect(profileAtNotification).toBe(original);
        expect(worker.signal.aborted).toBe(changed);
        if (changed) {
          expect(() => worker.assertCurrent()).toThrow("worker GitHub identity changed");
        } else {
          worker.assertCurrent();
        }
      } finally {
        stop();
        await worker.release();
        state.clearSecretsRuntimeSnapshotState();
      }
    },
  );
});
