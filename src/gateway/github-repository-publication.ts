import type {
  SessionGitHubConfirmParams,
  SessionGitHubPublishParams,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import {
  decodeGitHubPublicationRequester,
  encodeGitHubPublicationRequester,
  matchesGitHubPublicationRequester,
} from "../state/github-publication-requester.js";
import type { PersonalGitHubAction } from "./github-personal-oauth.js";
import { createRepositoryPersonalPublicationStatus } from "./github-personal-publication-status.js";
import {
  assertPersonalGitHubPublicationReplay,
  bindPersonalGitHubPublicationSelection,
  preparePersonalRepositoryPublicationStatus as preparePersonalStatus,
  preparePersonalGitHubPublicationSelection,
  type PersonalGitHubSessionActionV2,
  type PreparedRepositoryPublicationStatus,
} from "./github-personal-publication.js";
import {
  prepareCurrentGitHubPublicationIdentity,
  repositoryPublicationPreflightCredential,
  repositoryPublicationPreflightActor,
  sameGitHubPublicationWorkspace,
  prepareGitHubPublicationSession,
} from "./github-publication-availability.js";
import {
  exactClaimForPlacement,
  type GitHubPublicationClaimRequestV2,
  type GitHubPublicationSessionRequestV2,
} from "./github-publication-coordinator-methods.js";
import { GitHubPublicationKnownFailure } from "./github-publication-failure.js";
import {
  assertExpectedSharedGitHubPublisher,
  matchesGitHubPublicationIdentityRow,
  projectGitHubPublicationResult as projectReceipt,
} from "./github-publication-receipt.js";
import type { GitHubPublicationRecoveryBackoff } from "./github-publication-recovery.js";
import { insertRepositoryGitHubPublicationAsync } from "./github-publication-request-async.js";
import {
  isGitHubPublicationRequesterV2,
  type GitHubPublicationRequesterPolicyV2,
  type RetainedGitHubPublicationRequester,
} from "./github-publication-requester.js";
import type { PublicationSessionIdentity as SessionIdentity } from "./github-publication-session.types.js";
import { bindGitHubPublicationSourceLifetime } from "./github-publication-source.js";
import {
  listRepositoryGitHubPublicationsAsync,
  readRepositoryGitHubPublicationAsync,
  readRepositoryGitHubPublicationInputAsync,
  reopenRepositoryGitHubPublicationAsync,
} from "./github-publication-store-async.js";
import { createRepositoryPublicationAdmission } from "./github-repository-publication-admission.js";
import { createRepositoryGitHubPublicationExecution } from "./github-repository-publication-execution.js";
import { createRepositoryGitHubPublicationRecovery } from "./github-repository-publication-recovery.js";
import {
  readPendingRepositoryGitHubPublication,
  terminalRepositoryGitHubPublication,
  retryableRepositoryGitHubPublication,
} from "./github-repository-publication-store.js";
import {
  prepareRepositoryOwner,
  type RepositoryDiskPublicationSource,
} from "./github-repository-publication-workspace.js";
import { matchesRepositoryGitHubPublicationClaim } from "./github-repository-publication.kernel.js";
import { prepareRepositoryGitHubPublicationTarget } from "./github-repository-target.js";
import { resolvePlacementTurnEnvironment } from "./worker-environments/placement-record.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

export function createRepositoryGitHubPublicationCoordinator(params: {
  placements: WorkerSessionPlacementStore;
  environments?: RepositoryDiskPublicationSource["environments"];
  prepareRepositoryIntegration?: import("./repository-publication-integration.js").PrepareRepositoryPublicationIntegration;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  assertCurrent: () => void;
  signal: AbortSignal;
  recovery?: GitHubPublicationRecoveryBackoff;
}) {
  const { placements, getCommittedRuntimeConfig } = params;
  const projectGitHubPublicationResult = (row: RepositoryGitHubPublicationRow) => {
    const result = projectReceipt(row);
    return params.recovery?.describe(result) ?? result;
  };
  const prepareSource = async (
    requester: Pick<GitHubPublicationRequesterPolicyV2, "prepareSource">,
    selector: Parameters<GitHubPublicationRequesterPolicyV2["prepareSource"]>[0],
  ) => {
    const source = await requester.prepareSource(selector);
    try {
      params.assertCurrent();
      return bindGitHubPublicationSourceLifetime(source, params.signal);
    } catch (error) {
      await source.release();
      throw error;
    }
  };
  const instanceId = placements.workspaceResultInstanceId();
  const active = new Map<string, string>();
  // Only this coordinator retains the original live startup source for an accepted
  // personal claim. Restart keeps durable consent but requires fresh source admission.
  const personalClaims = new Map<string, RetainedGitHubPublicationRequester>();
  const releasePersonalClaim = (id: string) => {
    const held = personalClaims.get(id);
    personalClaims.delete(id);
    held?.release();
  };
  params.signal.addEventListener(
    "abort",
    () => personalClaims.forEach((_held, id) => releasePersonalClaim(id)),
    { once: true },
  );
  const hasPersonalSource = (id: string) => {
    const held = personalClaims.get(id);
    if (!held) {
      return false;
    }
    try {
      held.requester.assertCurrent();
      return true;
    } catch {
      releasePersonalClaim(id);
      return false;
    }
  };
  const personalStatus = createRepositoryPersonalPublicationStatus(
    instanceId,
    active,
    hasPersonalSource,
  );
  const executePublication = createRepositoryGitHubPublicationExecution({
    instanceId,
    active,
    prepareSource,
    prepareIntegration: params.prepareRepositoryIntegration,
    disk: params.environments && { placements, environments: params.environments },
    getCommittedRuntimeConfig,
    assertCurrent: params.assertCurrent,
  });
  const execute: typeof executePublication = async (row, context) => {
    if (
      row.owner_profile_id !== null &&
      row.requester_authority_json !== null &&
      !context.action &&
      !hasPersonalSource(row.request_id)
    ) {
      return projectGitHubPublicationResult({ ...row, status: "needs_confirmation" });
    }
    let result: Awaited<ReturnType<typeof executePublication>>;
    try {
      const requester = context.requester ?? personalClaims.get(row.request_id)?.requester;
      result = await executePublication(row, { ...context, requester });
    } catch (error) {
      if (
        row.owner_profile_id !== null &&
        error instanceof GitHubPublicationKnownFailure &&
        error.failure.code === "identity_changed"
      ) {
        // A rejected account selection no longer owns pending work. Preserve its
        // immutable receipt and expose reconnect guidance instead of endless requested status.
        releasePersonalClaim(row.request_id);
      }
      throw error;
    }
    if (
      result.status === "published" ||
      result.status === "failed" ||
      result.status === "needs_confirmation"
    ) {
      releasePersonalClaim(row.request_id);
    }
    return result;
  };
  const { makeRow, bindIdleCheckpoint } = createRepositoryPublicationAdmission({
    prepareSource,
    assertCurrent: params.assertCurrent,
    disk: params.environments && { placements, environments: params.environments },
    projectResult: projectGitHubPublicationResult,
  });
  const admitShared = async (
    input: GitHubPublicationSessionRequestV2,
    claim?: WorkerSessionTurnClaim,
  ) => {
    const requester = input.requester;
    requester.assertCurrent();
    const requesterAuthorityJson = encodeGitHubPublicationRequester(requester.snapshot);
    if (!input.sessionKey) {
      throw new Error("GitHub publication requires an authoritative session.");
    }
    using selectedSession = await prepareGitHubPublicationSession(input.sessionKey, {
      cfg: getCommittedRuntimeConfig(),
      agentId: input.agentId,
      assertCurrent: params.assertCurrent,
    });
    const loaded = selectedSession.loaded;
    requester.assertCurrent();
    if (!loaded.entry?.sessionId) {
      throw new Error("GitHub publication session changed.");
    }
    const session = {
      sessionId: loaded.entry.sessionId,
      lifecycleRevision: loaded.entry.lifecycleRevision ?? null,
      sessionKey: loaded.canonicalKey,
      agentId: input.agentId,
    };
    const currentOwner = await prepareRepositoryOwner(session);
    using _ = { [Symbol.dispose]: () => currentOwner.release() };

    const initial = currentOwner();
    const assertCurrent = () => {
      requester.assertCurrent();
      const placement = claim ? placements.get(session.sessionId) : undefined;
      if (
        !sameGitHubPublicationWorkspace(initial, currentOwner()) ||
        (claim &&
          (!placement ||
            claim.sessionId !== session.sessionId ||
            placement.agentId !== session.agentId ||
            placement.sessionKey !== session.sessionKey ||
            !resolvePlacementTurnEnvironment(placement, claim)))
      ) {
        throw new Error("GitHub publication session authority changed.");
      }
    };
    assertCurrent();
    const [existing] = await listRepositoryGitHubPublicationsAsync({
      sessionId: session.sessionId,
      idempotencyKey: input.idempotencyKey,
      ownerProfileId: null,
    });
    assertCurrent();
    if (
      existing &&
      (existing.workspace_id !== initial.workspace.workspaceId ||
        existing.title !== (input.title ?? null) ||
        existing.body !== (input.body ?? null) ||
        (existing.draft == null
          ? input.draft === false
          : existing.draft !== Number(input.draft ?? false)))
    ) {
      throw new Error("GitHub publication idempotency key was reused.");
    }
    const expected = input.selection?.source === "shared" ? input.selection.expected : undefined;
    const retry =
      existing?.status === "failed" &&
      retryableRepositoryGitHubPublication(
        existing,
        existing.error_code === "unavailable"
          ? undefined
          : await readRepositoryGitHubPublicationInputAsync(existing),
      );
    assertCurrent();
    if (existing && terminalRepositoryGitHubPublication(existing) && !retry) {
      const result = projectGitHubPublicationResult(existing);
      assertExpectedSharedGitHubPublisher(expected, result.publisher!);
      return existing;
    }
    if (existing) {
      const original = decodeGitHubPublicationRequester(existing.requester_authority_json);
      if (!original || !matchesGitHubPublicationRequester(original, requester.snapshot)) {
        throw new Error("GitHub publication idempotency key was reused by a different requester.");
      }
    }
    const identity = await prepareCurrentGitHubPublicationIdentity(
      input.agentId,
      repositoryPublicationPreflightActor(requester, session.sessionKey, assertCurrent),
      repositoryPublicationPreflightCredential({
        agentId: input.agentId,
        sessionKey: session.sessionKey,
        sessionId: session.sessionId,
        lifecycleRevision: session.lifecycleRevision ?? null,
        assertCurrent,
      }),
    );
    await using identityLifetime = {
      identity,
      [Symbol.asyncDispose]: async () => {
        await identity.revoke?.();
      },
    };
    assertCurrent();
    assertExpectedSharedGitHubPublisher(
      expected,
      { source: identityLifetime.identity.source, ...identityLifetime.identity.account },
      existing
        ? undefined
        : { idempotencyKey: input.idempotencyKey, hasRequest: () => Boolean(existing) },
    );
    if (existing) {
      if (!matchesGitHubPublicationIdentityRow(existing, identity)) {
        throw new Error("GitHub publication identity changed.");
      }
      if (!retry) {
        return existing;
      }
      const source = await prepareSource(requester, {
        ...session,
        repositoryWorkspaceId: existing.workspace_id,
        repositoryBranch: existing.branch,
      });
      try {
        assertCurrent();
        return await reopenRepositoryGitHubPublicationAsync(existing, source);
      } finally {
        await source.release();
      }
    }
    const target = await prepareRepositoryGitHubPublicationTarget(
      initial.workspace,
      identity,
      assertCurrent,
    );
    assertCurrent();
    const row = await makeRow({
      session,
      workspace: initial.workspace,
      request: input,
      identity,
      target,
      claim,
      requesterAuthorityJson,
      origin: requester.snapshot.origin,
    });
    const source = await prepareSource(requester, {
      ...session,
      repositoryWorkspaceId: row.workspace_id,
      repositoryBranch: row.branch,
    });
    try {
      assertCurrent();
      return await insertRepositoryGitHubPublicationAsync(row, source);
    } finally {
      await source.release();
    }
  };
  return {
    async requestForClaimV2(input: GitHubPublicationClaimRequestV2) {
      const expected = input.expectedPublisher;
      if (expected?.source === "personal") {
        throw new Error("My GitHub publication requires direct personal authorization.");
      }
      const row = await admitShared(
        {
          ...input,
          selection: {
            source: "shared",
            ...(expected
              ? {
                  expected: {
                    source: expected.source,
                    accountId: expected.accountId,
                    login: expected.login,
                  },
                }
              : {}),
          },
        },
        input.claim,
      );
      return projectGitHubPublicationResult(row);
    },
    async requestForSessionV2(input: GitHubPublicationSessionRequestV2) {
      if (input.selection?.source === "personal") {
        throw new Error("My GitHub publication requires direct personal authorization.");
      }
      using selectedSession = await prepareGitHubPublicationSession(input.sessionKey!, {
        cfg: getCommittedRuntimeConfig(),
        agentId: input.agentId,
        assertCurrent: params.assertCurrent,
      });
      const loaded = selectedSession.loaded;
      const placement = loaded.entry?.sessionId
        ? await placements.getAsync(loaded.entry.sessionId)
        : undefined;
      input.requester.assertCurrent();
      const currentClaim = placement ? exactClaimForPlacement(placement) : undefined;
      if (input.expectedRunId !== undefined && input.expectedRunId !== currentClaim?.runId) {
        throw new Error("GitHub publication run identity changed.");
      }
      const claim = input.expectedRunId !== undefined ? currentClaim : undefined;
      let row = await admitShared(input, claim);
      if (
        terminalRepositoryGitHubPublication(row) ||
        claim ||
        (await placements.getAsync(row.session_id))?.turnClaim
      ) {
        return projectGitHubPublicationResult(row);
      }
      const prepared = await placements.withRepositoryWorkspaceReservation(
        { sessionId: row.session_id, sessionKey: row.session_key, agentId: row.agent_id },
        (assertReservation) => bindIdleCheckpoint(row, input.requester, assertReservation),
      );
      if (!("request_id" in prepared)) {
        return prepared;
      }
      row = prepared;
      // The input is immutable; worker refresh must not retain a placement-admission hold.
      return await placements.withWorkspaceExclusion(
        row.session_id,
        async (assertCustody) =>
          await execute(row, {
            assertCustody,
            assertCurrent: input.requester.assertInvocationCurrent,
            requester: input.requester,
          }),
      );
    },
    async requestPersonalForSessionV2(
      input: SessionGitHubPublishParams,
      action: PersonalGitHubSessionActionV2,
    ) {
      if (input.selection?.source !== "personal" || input.idempotencyKey.length > 128) {
        throw new Error("My GitHub publication requires an explicit bounded account selection.");
      }
      const selected = input.selection;
      action.assertCurrent();
      const [existing] = await listRepositoryGitHubPublicationsAsync({
        sessionId: action.sessionId,
        idempotencyKey: input.idempotencyKey,
        ownerProfileId: action.owner,
      });
      action.assertCurrent();
      if (existing) {
        assertPersonalGitHubPublicationReplay(existing, input, selected);
        const prepared = await preparePersonalStatus(existing.request_id);
        using _ = { [Symbol.dispose]: () => prepared?.release() };
        action.assertCurrent();
        return (await personalStatus(existing, action, action, prepared)).result;
      }
      const bound = await bindPersonalGitHubPublicationSelection(action, selected, {
        idempotencyKey: input.idempotencyKey,
        hasRequest: () => Boolean(existing),
      });
      const currentOwner = await prepareRepositoryOwner(action);
      using _ = { [Symbol.dispose]: () => currentOwner.release() };
      const initial = currentOwner();
      const assertCurrent = () => {
        bound.assertCurrent();
        if (!sameGitHubPublicationWorkspace(initial, currentOwner())) {
          throw new Error("My GitHub repository owner changed.");
        }
      };
      const identity = await preparePersonalGitHubPublicationSelection(bound, assertCurrent);
      const target = await prepareRepositoryGitHubPublicationTarget(
        initial.workspace,
        identity,
        assertCurrent,
      );
      const placement = await placements.getAsync(action.sessionId);
      assertCurrent();
      const claim =
        action.expectedRunId && placement ? exactClaimForPlacement(placement) : undefined;
      if (claim && claim.runId !== action.expectedRunId) {
        throw new Error("GitHub publication run identity changed.");
      }
      if (
        claim &&
        (!action.requester?.retainForSettlement ||
          !isGitHubPublicationRequesterV2(action.requester) ||
          action.requester.snapshot.actor.kind !== "operator" ||
          action.requester.snapshot.actor.profileId !== action.owner)
      ) {
        throw new Error("Personal claim publication requires its verified requesting human.");
      }
      const candidate = await makeRow({
        session: action,
        workspace: initial.workspace,
        request: input,
        identity,
        target,
        action,
        generation: selected.generation,
        claim,
        requesterAuthorityJson: claim
          ? encodeGitHubPublicationRequester({ ...action.requester!.snapshot, version: 2 })
          : null,
      });
      if (claim) {
        using lifetime = new DisposableStack();
        const held = await action.requester!.retainForSettlement!();
        lifetime.defer(() => held.release());
        const source = await prepareSource(action, {
          agentId: action.agentId,
          sessionKey: action.sessionKey,
          sessionId: action.sessionId,
          lifecycleRevision: action.lifecycleRevision,
          personalOwnerProfileId: action.owner,
          repositoryWorkspaceId: candidate.workspace_id,
          repositoryBranch: candidate.branch,
        });
        await using sourceLifetime = new AsyncDisposableStack();
        sourceLifetime.defer(() => source.release());
        assertCurrent();
        const current = placements.get(action.sessionId);
        if (!current || !resolvePlacementTurnEnvironment(current, claim)) {
          throw new Error("GitHub publication run identity changed.");
        }
        const row = await insertRepositoryGitHubPublicationAsync(candidate, source);
        if (!personalClaims.has(row.request_id)) {
          const custody = lifetime.move();
          personalClaims.set(row.request_id, {
            requester: held.requester,
            release: () => custody.dispose(),
          });
        }
        return projectGitHubPublicationResult(row);
      }
      const prepared = await placements.withRepositoryWorkspaceReservation(
        action,
        async (assertReservation) => {
          const source = await prepareSource(action, {
            agentId: action.agentId,
            sessionKey: action.sessionKey,
            sessionId: action.sessionId,
            lifecycleRevision: action.lifecycleRevision,
            personalOwnerProfileId: action.owner,
            repositoryWorkspaceId: candidate.workspace_id,
            repositoryBranch: candidate.branch,
          });
          let row: RepositoryGitHubPublicationRow;
          try {
            assertCurrent();
            assertReservation();
            row = await insertRepositoryGitHubPublicationAsync(candidate, source);
          } finally {
            await source.release();
          }
          return await bindIdleCheckpoint(row, action, () => {
            assertReservation();
            assertCurrent();
          });
        },
      );
      if (!("request_id" in prepared)) {
        return prepared;
      }
      return await placements.withWorkspaceExclusion(prepared.session_id, (assertCustody) =>
        execute(prepared, { assertCustody, assertCurrent, action }),
      );
    },
    async processClaim(claim: WorkerSessionTurnClaim) {
      const results = [];
      const selected = (
        await listRepositoryGitHubPublicationsAsync({
          sessionId: claim.sessionId,
          pending: true,
        })
      ).filter(
        (candidate) =>
          (candidate.owner_profile_id === null || candidate.requester_authority_json !== null) &&
          (candidate.claim_id === null ||
            matchesRepositoryGitHubPublicationClaim(candidate, claim)),
      );
      for (const row of selected) {
        await placements.prepareWorkspaceResultClaim(claim);
        results.push(
          await placements.withWorkspaceExclusion(
            row.session_id,
            async (assertOwned) =>
              await execute(row, {
                requester: personalClaims.get(row.request_id)?.requester,
                captureRequestIds: selected
                  .filter((entry) => !entry.checkpoint_ref)
                  .map((entry) => entry.request_id),
                assertCustody: () => {
                  assertOwned();
                  if (!placements.validateWorkspaceResultClaim(claim)) {
                    throw new Error("GitHub publication lost its workspace result claim.");
                  }
                },
              }),
          ),
        );
      }
      return results;
    },
    ...createRepositoryGitHubPublicationRecovery({
      placements,
      disk: params.environments && { placements, environments: params.environments },
      recovery: params.recovery,
      getCommittedRuntimeConfig,
      assertCurrent: params.assertCurrent,
      isExecuting: (requestId) => active.has(requestId),
      hasPersonalSource,
      execute: (row, assertCustody, recoveryResult, captureOnly) =>
        execute(row, { assertCustody, recoveryResult, captureOnly }),
    }),
    preparePersonalStatus,
    async personalStatusAsync(
      action: PersonalGitHubAction,
      session: SessionIdentity,
      requestId: string,
      prepared: PreparedRepositoryPublicationStatus | undefined,
    ) {
      const row = await readRepositoryGitHubPublicationAsync(requestId);
      params.assertCurrent();
      return row ? personalStatus(row, action, session, prepared) : undefined;
    },
    async personalPending(action: PersonalGitHubAction, session: SessionIdentity) {
      action.assertCurrent();
      const row = await readPendingRepositoryGitHubPublication({
        ownerProfileId: action.owner,
        sessionKey: session.sessionKey,
        agentId: session.agentId,
      });
      if (!row) {
        action.assertCurrent();
        return null;
      }
      const prepared = await preparePersonalStatus(row.request_id);
      using _ = { [Symbol.dispose]: () => prepared?.release() };
      action.assertCurrent();
      return await personalStatus(row, action, session, prepared);
    },
    async confirmPersonalV2(
      input: SessionGitHubConfirmParams,
      action: PersonalGitHubSessionActionV2,
    ) {
      action.assertCurrent();
      const row = await readRepositoryGitHubPublicationAsync(input.requestId);
      action.assertCurrent();
      if (
        !row ||
        row.owner_profile_id !== action.owner ||
        row.session_id !== action.sessionId ||
        (!terminalRepositoryGitHubPublication(row) &&
          row.session_lifecycle_revision !== action.lifecycleRevision) ||
        row.session_key !== action.sessionKey ||
        row.agent_id !== action.agentId ||
        row.request_digest !== input.requestDigest ||
        row.connection_generation !== input.generation ||
        row.identity_account_id !== input.account.accountId ||
        row.identity_login.toLowerCase() !== input.account.login.toLowerCase()
      ) {
        throw new Error("My GitHub confirmation no longer matches the original request.");
      }
      if (terminalRepositoryGitHubPublication(row)) {
        return projectGitHubPublicationResult(row);
      }
      if (active.has(row.request_id)) {
        throw new Error("My GitHub publication is still running; wait for its result.");
      }
      if (!row.checkpoint_ref) {
        throw new Error("GitHub publication has no accepted checkpoint.");
      }
      await bindPersonalGitHubPublicationSelection(action, input);
      const placement = await placements.getAsync(action.sessionId);
      action.assertCurrent();
      const claim =
        action.expectedRunId && placement ? exactClaimForPlacement(placement) : undefined;
      if (claim && row.requester_authority_json !== null) {
        if (claim.runId !== action.expectedRunId || !action.requester?.retainForSettlement) {
          throw new Error("GitHub confirmation run identity changed.");
        }
        const held = await action.requester.retainForSettlement();
        try {
          action.assertCurrent();
          const original = decodeGitHubPublicationRequester(row.requester_authority_json);
          if (!original || !matchesGitHubPublicationRequester(original, held.requester.snapshot)) {
            throw new Error("GitHub confirmation requester changed.");
          }
          releasePersonalClaim(row.request_id);
          personalClaims.set(row.request_id, held);
        } catch (error) {
          held.release();
          throw error;
        }
        return projectGitHubPublicationResult({ ...row, status: "requested" });
      }
      await placements.withRepositoryWorkspaceReservation(action, async (assertReservation) => {
        assertReservation();
        action.assertCurrent();
      });
      return await placements.withWorkspaceExclusion(row.session_id, (assertCustody) =>
        execute(row, { assertCustody, assertCurrent: action.assertCurrent, action }),
      );
    },
    async readAsync(requestId: string) {
      const row = await readRepositoryGitHubPublicationAsync(requestId);
      params.assertCurrent();
      return row && row.owner_profile_id === null ? projectGitHubPublicationResult(row) : undefined;
    },
    async hasRequestAsync(requestId: string) {
      const row = await readRepositoryGitHubPublicationAsync(requestId);
      params.assertCurrent();
      return Boolean(row);
    },
    async listUnreportedResultsAsync() {
      const rows = await listRepositoryGitHubPublicationsAsync({
        pending: false,
        unreported: true,
      });
      params.assertCurrent();
      return rows.map((row) => ({
        sessionId: row.session_id,
        sessionKey: row.session_key,
        agentId: row.agent_id,
        result: projectGitHubPublicationResult(row),
      }));
    },
  };
}
