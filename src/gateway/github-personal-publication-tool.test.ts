// Register the existing synthetic Git transport before publication consumers.
// oxfmt-ignore
import { SESSION_KEY, SESSION_ID, installGitHubPublicationTestHarness, githubPublicationTestMocks, persistPublicationTestSession } from "./github-publication.test-support.js";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createGitHubPublishTool } from "../agents/tools/github-publish-tool.js";
import * as gateway from "../agents/tools/in-process-gateway.js";
import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { updateUserGitHubConnection } from "../state/user-github-connections.test-support.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "./agent-runtime-approval-authority.js";
import {
  createPersonalPublicationFixture,
  callPersonalPublicationRpc,
  personalPublicationAccount,
} from "./github-personal-publication.test-support.js";
import { createGitHubPublicationRuntime } from "./github-publication-runtime.js";
import { readRepositoryGitHubPublicationInDatabase } from "./github-repository-publication-store.worker.js";
import {
  checkRepositoryGitHubPublication,
  repositoryGitHubPublicationDigest,
} from "./github-repository-publication.kernel.js";
import { createRepositoryPublicationFixture } from "./github-repository-publication.test-support.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

const checkpoint = vi.hoisted(() => vi.fn());
// mock-isolation: Synthetic external checkpoint I/O; publication owner and persisted receipts remain real.
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryPublicationCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));
installGitHubPublicationTestHarness();
afterEach(() => vi.unstubAllGlobals());

it.each(["interactive", "forwarded"] as const)(
  "publishes and reads the requesting collaborator's personal receipt through %s tools",
  async (transport) => {
    const f = await createPersonalPublicationFixture();
    await withPersonalToolTurn(
      {
        owner: { profileId: f.owner, senderId: "alice", name: "Alice" },
        sessionKey: SESSION_KEY,
        sessionId: SESSION_ID,
      },
      async (turn) => {
        const caller = getGatewayToolCallerIdentity()!;
        const mocks = githubPublicationTestMocks();
        const original = mocks.loadSession.getMockImplementation()!;
        mocks.loadSession.mockImplementation((key: string) => ({
          ...original(key),
          entry: {
            ...original(key).entry,
            createdActor: { type: "human", source: "profile", id: f.otherOwner },
          },
        }));
        await persistPublicationTestSession();
        f.context.validateAgentRuntimeApprovalAuthority =
          createAgentRuntimeApprovalAuthorityValidator();
        f.client.internal = {
          ...f.client.internal,
          syntheticClient: true,
          operatorRunAuthority: caller.operatorAuthority,
          ...(transport === "forwarded" ? { agentRuntimeIdentity: turn.runtimeIdentity } : {}),
        };
        using _ = vi
          .spyOn(gateway, "callInProcessGatewayTool")
          .mockImplementation(async <T>(method: string, params: Record<string, unknown>) => {
            const [ok, result, error] = await callPersonalPublicationRpc(f, method, params);
            if (!ok) {
              throw new Error(error?.message);
            }
            return result as T;
          });
        const run = async () => {
          const tool = createGitHubPublishTool();
          const ready = await tool.execute("ready", { action: "readiness", publisher: "personal" });
          expect(ready.details).toMatchObject({
            personal: { account: personalPublicationAccount, state: "connected" },
          });
          const published = await tool.execute("personal-publish", { publisher: "personal" });
          expect(published.details).toMatchObject({
            status: "published",
            publisher: { source: "personal", ...personalPublicationAccount },
          });
          const requestId = (published.details as { requestId: string }).requestId;
          const status = await tool.execute("observe", {
            action: "status",
            publisher: "personal",
            requestId,
          });
          expect(status.details).toMatchObject({ result: published.details });
          expect(
            (await tool.execute("personal-publish", { publisher: "personal" })).details,
          ).toEqual(published.details);
          await expect(
            tool.execute("personal-publish", { publisher: "personal", title: "Changed intent" }),
          ).rejects.toThrow(/idempotency.*different selection/);
          turn.revoke(f.owner);
          await expect(tool.execute("revoked", { publisher: "personal" })).rejects.toThrow();
        };
        if (transport === "forwarded") {
          await withoutGatewayToolCallerIdentity(() =>
            withGatewayToolCallerIdentity(
              { agentId: "main", sessionKey: SESSION_KEY },
              async () => {
                expect(getGatewayToolCallerIdentity()?.personalToolParticipants).toBeUndefined();
                await run();
              },
            ),
          );
        } else {
          await run();
        }
      },
    );
  },
);

it("does not admit an unattended synthetic caller using a copied profile", async () => {
  const f = await createPersonalPublicationFixture();
  f.client.internal = { ...f.client.internal, syntheticClient: true };
  const [ok, , error] = await callPersonalPublicationRpc(f, "sessions.github.publish", {
    sessionKey: SESSION_KEY,
    idempotencyKey: "unattended",
    selection: {
      source: "personal",
      generation: f.generation,
      account: personalPublicationAccount,
    },
  });
  expect(ok).toBe(false);
  expect(error.message).toMatch(/authenticated human/);
});

it.each(["forged", "missing-connection", "bound-pr"] as const)(
  "rejects personal tool publication with %s",
  async (failure) => {
    const f = await createPersonalPublicationFixture();
    await withPersonalToolTurn(
      {
        owner: { profileId: f.owner, senderId: "alice", name: "Alice" },
        sessionKey: SESSION_KEY,
        sessionId: SESSION_ID,
      },
      async () => {
        const authority = getGatewayToolCallerIdentity()!.operatorAuthority!;
        f.client.internal = {
          ...f.client.internal,
          syntheticClient: true,
          operatorRunAuthority: failure === "forged" ? { ...authority } : authority,
        };
        if (failure === "missing-connection") {
          updateUserGitHubConnection(
            f.owner,
            () => ({ version: 1, generation: f.generation, selection: { kind: "disconnected" } }),
            () => {},
          );
        }
        if (failure === "bound-pr") {
          const mocks = githubPublicationTestMocks();
          const original = mocks.loadSession.getMockImplementation()!;
          const source = {
            repository: "openclaw/openclaw",
            repositoryId: 1,
            branch: "main",
            commit: "a".repeat(40),
          };
          mocks.loadSession.mockImplementation((key: string) => ({
            ...original(key),
            entry: {
              ...original(key).entry,
              worktree: {
                ...original(key).entry.worktree,
                githubPullRequest: {
                  url: "https://github.com/openclaw/openclaw/pull/42",
                  host: "github.com",
                  number: 42,
                  base: source,
                  head: source,
                },
              },
            },
          }));
          await persistPublicationTestSession();
        }
        using _ = vi
          .spyOn(gateway, "callInProcessGatewayTool")
          .mockImplementation(async <T>(method: string, params: Record<string, unknown>) => {
            const [ok, result, error] = await callPersonalPublicationRpc(f, method, params);
            if (!ok) {
              throw new Error(error?.message);
            }
            return result as T;
          });
        await expect(
          createGitHubPublishTool().execute("rejected", { publisher: "personal" }),
        ).rejects.toThrow(
          failure === "forged"
            ? /issued by the host/
            : failure === "missing-connection"
              ? /Reconnect/
              : /original publisher/,
        );
      },
    );
  },
);

it.each(["settled", "revoked", "restarted", "reselected", "disconnected", "lost-push"] as const)(
  "settles an active cloud personal request: %s",
  async (mode) => {
    const f = await createRepositoryPublicationFixture(checkpoint, undefined, REQUEST);
    const person = await createPersonalPublicationFixture();
    const selectionChanged = mode === "reselected" || mode === "disconnected";
    f.runtime.accountId = personalPublicationAccount.accountId;
    const warn = vi.fn();
    const makeRuntime = () =>
      createGitHubPublicationRuntime({
        placements: f.placements,
        prepareRepositoryIntegration: githubPublicationTestMocks().prepareRepositoryIntegration,
        getCommittedRuntimeConfig: person.context.getRuntimeConfig,
        loadSessionRuntime: () => {
          throw new Error("Transcript delivery is outside this fixture");
        },
        warn,
      });
    let runtime = makeRuntime();
    onTestFinished(() => runtime.close());
    await runtime.ready;
    const owner = { environmentId: "personal-cloud", ownerEpoch: 7 };
    seedAttachedPlacementEnvironment(openOpenClawStateDatabase(), {
      ...owner,
      sessionId: REQUEST.sessionId,
    });
    await seedActivePlacement(f.placements, { ...owner, executionMode: "worker-turn" });
    const claim = await f.placements.claimTurn({
      ...REQUEST,
      claimId: "personal-cloud-claim",
      runId: "personal-cloud-run",
      owner: { kind: "worker", ...owner },
    });
    const fixture = { ...person, coordinator: runtime.coordinator };
    let requestedId = "";
    let savedSha = "";
    await withPersonalToolTurn(
      {
        owner: { profileId: person.owner, senderId: "alice", name: "Alice" },
        sessionKey: REQUEST.sessionKey,
        sessionId: REQUEST.sessionId,
        runId: claim.runId,
      },
      async (turn) => {
        fixture.client.internal = {
          ...fixture.client.internal,
          syntheticClient: true,
          operatorRunAuthority: getGatewayToolCallerIdentity()!.operatorAuthority,
        };
        using _ = vi
          .spyOn(gateway, "callInProcessGatewayTool")
          .mockImplementation(async <T>(method: string, params: Record<string, unknown>) => {
            const [ok, result, error] = await callPersonalPublicationRpc(fixture, method, params);
            if (!ok) {
              throw new Error(error?.message);
            }
            return result as T;
          });
        const tool = createGitHubPublishTool();
        const accepted = (await tool.execute("cloud-personal", { publisher: "personal" }))
          .details as { requestId: string; status: string };
        requestedId = accepted.requestId;
        expect(accepted.status).toBe("requested");
        const read = () =>
          readRepositoryGitHubPublicationInDatabase(
            openOpenClawStateDatabase().db,
            accepted.requestId,
          )!;
        expect(read()).toMatchObject({
          owner_profile_id: person.owner,
          connection_generation: person.generation,
          claim_id: claim.claimId,
          run_id: claim.runId,
          checkpoint_ref: null,
        });
        expect(JSON.parse(read().requester_authority_json!)).toMatchObject({
          version: 2,
          actor: { kind: "operator", profileId: person.owner },
        });
        const consent = read();
        const legacy = {
          ...consent,
          requester_authority_json: null,
          claim_id: null,
          run_id: null,
          environment_id: null,
          owner_epoch: null,
          placement_generation: null,
        };
        legacy.request_digest = repositoryGitHubPublicationDigest(legacy);
        expect(checkRepositoryGitHubPublication(legacy)).toBe(legacy);
        for (const snapshot of [
          { ...JSON.parse(consent.requester_authority_json!), version: 1 },
          {
            ...JSON.parse(consent.requester_authority_json!),
            actor: { kind: "operator", profileId: person.otherOwner },
          },
        ]) {
          const invalid = { ...consent, requester_authority_json: JSON.stringify(snapshot) };
          invalid.request_digest = repositoryGitHubPublicationDigest(invalid);
          expect(() => checkRepositoryGitHubPublication(invalid)).toThrow("receipt is corrupt");
        }
        expect(f.runtime.effects).toEqual([]);
        expect(
          (
            await tool.execute("pending", {
              action: "status",
              publisher: "personal",
              requestId: accepted.requestId,
            })
          ).details,
        ).toMatchObject({ result: { status: "requested" }, confirmation: null });
        if (selectionChanged) {
          updateUserGitHubConnection(
            person.owner,
            (current) => {
              if (current?.selection.kind !== "connected") {
                throw new Error("Expected the admitted personal connection");
              }
              return {
                ...current,
                generation: randomUUID(),
                selection:
                  mode === "disconnected"
                    ? { kind: "disconnected" }
                    : {
                        ...current.selection,
                        profileId: "ghp_33333333333333333333333333333333",
                        accountId: 202,
                        login: "personal-bob",
                      },
              };
            },
            () => {},
          );
        }
        const saved = await f.capture(
          "accepted personal cloud edit\n",
          "personal-cloud-checkpoint",
        );
        savedSha = saved.sha;
        await f.placements.markWorkspaceResultPending(claim);
        expect(await runtime.needsAcceptedWorkspacePublication(claim)).toBe(true);
        await runtime.prepareAcceptedWorkspacePublication(claim);
        await f.placements.acceptWorkspaceResult(claim);
        await runtime.publishAcceptedWorkspace(claim);
        await turn.complete();
        await f.placements.completeWorkspaceResultAndReleaseTurn(claim);
        expect((await f.placements.getAsync(REQUEST.sessionId))?.turnClaim).toBeNull();
        if (mode === "revoked") {
          turn.revoke(person.owner);
        }
        if (mode === "restarted") {
          await runtime.close();
          runtime = makeRuntime();
          await runtime.ready;
          fixture.coordinator = runtime.coordinator;
        }
        if (mode === "lost-push") {
          f.runtime.interruptPush = true;
        }
        await runtime.reconcilePublications();
        if (mode === "lost-push") {
          expect(f.runtime.effects).toEqual(["push"]);
          expect(read()).toMatchObject({
            request_id: requestedId,
            connection_generation: person.generation,
            identity_account_id: personalPublicationAccount.accountId,
            checkpoint_ref: saved.ref,
            pull_request_url: null,
          });
          await runtime.close();
          runtime = makeRuntime();
          await runtime.ready;
          fixture.coordinator = runtime.coordinator;
          await runtime.reconcilePublications();
          expect(f.runtime.effects).toEqual(["push"]);
          return;
        }
        if (mode !== "settled") {
          expect(f.runtime.effects).toEqual([]);
          if (selectionChanged) {
            expect(f.runtime.uploaded.size).toBe(0);
          }
          return;
        }
        expect(read(), JSON.stringify(warn.mock.calls)).toMatchObject({
          status: "published",
          identity_source: "personal",
          identity_account_id: personalPublicationAccount.accountId,
        });
        expect(read().pull_request_url).toBe("https://github.com/owner/repository/pull/1");
        expect(f.runtime.uploaded.get(saved.sha)).toEqual(
          Buffer.from("accepted personal cloud edit\n"),
        );
        expect(f.runtime.effects).toEqual(["push", "pull_request"]);
        await runtime.reconcilePublications();
        expect(f.runtime.effects).toEqual(["push", "pull_request"]);
      },
    );
    if (mode !== "settled") {
      const nextClaim = await f.placements.claimTurn({
        ...REQUEST,
        claimId: "confirm-claim",
        runId: "confirm-run",
        owner: { kind: "worker", ...owner },
      });
      await withPersonalToolTurn(
        {
          owner: { profileId: person.owner, senderId: "alice", name: "Alice" },
          sessionKey: REQUEST.sessionKey,
          sessionId: REQUEST.sessionId,
          runId: nextClaim.runId,
        },
        async (turn) => {
          fixture.client.internal = {
            ...fixture.client.internal,
            operatorRunAuthority: getGatewayToolCallerIdentity()!.operatorAuthority,
          };
          using _ = vi
            .spyOn(gateway, "callInProcessGatewayTool")
            .mockImplementation(async <T>(method: string, params: Record<string, unknown>) => {
              const [ok, result, error] = await callPersonalPublicationRpc(fixture, method, params);
              if (!ok) {
                throw new Error(error?.message);
              }
              return result as T;
            });
          const tool = createGitHubPublishTool();
          const observed = await tool.execute("observe", {
            action: "status",
            publisher: "personal",
            requestId: requestedId,
          });
          if (selectionChanged) {
            expect(observed.details).toMatchObject({
              result: { status: "failed", code: "identity_changed", requestId: requestedId },
              confirmation: null,
            });
            expect(
              readRepositoryGitHubPublicationInDatabase(
                openOpenClawStateDatabase().db,
                requestedId,
              ),
            ).toMatchObject({
              request_id: requestedId,
              owner_profile_id: person.owner,
              connection_generation: person.generation,
              identity_source: "personal",
              identity_account_id: personalPublicationAccount.accountId,
              identity_login: personalPublicationAccount.login,
              pull_request_url: null,
            });
            expect(f.runtime.effects).toEqual([]);
            expect(f.runtime.uploaded.size).toBe(0);
            await turn.complete();
            await f.placements.releaseTurn(nextClaim);
            return;
          }
          expect(observed.details).toMatchObject({
            result: { status: "needs_confirmation", requestId: requestedId },
            confirmation: { generation: person.generation, account: personalPublicationAccount },
          });
          expect(
            (
              await tool.execute("confirm", {
                action: "confirm",
                publisher: "personal",
                requestId: requestedId,
              })
            ).details,
          ).toMatchObject({ requestId: requestedId, status: "requested" });
          expect(f.runtime.effects).toEqual(mode === "lost-push" ? ["push"] : []);
          await turn.complete();
          await f.placements.releaseTurn(nextClaim);
          await runtime.reconcilePublications();
          expect(
            readRepositoryGitHubPublicationInDatabase(openOpenClawStateDatabase().db, requestedId),
            JSON.stringify(warn.mock.calls),
          ).toMatchObject({
            status: "published",
            identity_account_id: personalPublicationAccount.accountId,
            pull_request_url: "https://github.com/owner/repository/pull/1",
          });
          expect(f.runtime.uploaded.get(savedSha)).toEqual(
            Buffer.from("accepted personal cloud edit\n"),
          );
          expect(f.runtime.effects).toEqual(["push", "pull_request"]);
        },
      );
    }
  },
);

it("rejects a forwarded scheduled run even when it retains the creator's profile", async () => {
  const f = await createPersonalPublicationFixture();
  const authority = createAdmittedRunOperatorAuthority({
    profileId: f.owner,
    scopes: ["operator.read", "operator.write"],
    gatewayAccessGrant: null,
    assertCurrent: () => {},
  });
  const admission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef("scheduled-personal"),
    admissionSource: "requester-schedule",
    operatorAuthority: authority,
    facts: {
      runId: "scheduled-personal",
      agentId: "main",
      ingress: { kind: "system", boundary: "schedule-fixture", state: "present" },
    },
  });
  onTestFinished(() => admission.close());
  const admittedRunContext = await admission.admit("embedded", "schedule-fixture");
  await withPersonalToolTurn(
    {
      owner: { profileId: f.owner, senderId: "alice", name: "Alice", operatorAuthority: authority },
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      runId: "scheduled-personal",
      admittedRunContext,
    },
    async (turn) => {
      f.context.validateAgentRuntimeApprovalAuthority =
        createAgentRuntimeApprovalAuthorityValidator();
      f.client.internal = {
        ...f.client.internal,
        syntheticClient: true,
        operatorRunAuthority: authority,
        agentRuntimeIdentity: turn.runtimeIdentity,
      };
      await withoutGatewayToolCallerIdentity(() =>
        withGatewayToolCallerIdentity({ agentId: "main", sessionKey: SESSION_KEY }, async () => {
          const [ok, , error] = await callPersonalPublicationRpc(f, "sessions.github.publish", {
            sessionKey: SESSION_KEY,
            idempotencyKey: "scheduled",
            selection: {
              source: "personal",
              generation: f.generation,
              account: personalPublicationAccount,
            },
          });
          expect(ok).toBe(false);
          expect(error.message).toMatch(/requesting human/);
        }),
      );
    },
  );
});
