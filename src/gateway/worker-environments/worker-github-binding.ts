import { WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { GitHubAppInstallationRetryableError } from "../../agents/github-app-installation.js";
import { resolveGitHubApiBaseUrl } from "../../agents/github-host-runtime.js";
import { githubRepositoryUrl } from "../../agents/github-host.js";
import {
  onManagedGitHubProfileChanged,
  resolveConfiguredGitHubToolIdentity,
} from "../../agents/github-tool-identity.js";
import type { PreparedGitHubPublicationIdentity } from "../../agents/github-tool-identity.types.js";
import type { AgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { registerConfigWriteListener } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getRepositoryIntegration } from "../../plugins/repository-integration-runtime.js";
import {
  onUserProfilesChanged,
  onUserProfileEmailBindingChanged,
} from "../../state/user-profile-events.js";
import {
  parseWorkerGitHubLaunchBinding,
  type WorkerGitHubLaunchBinding,
} from "../../worker/launch-descriptor.js";
import {
  currentGitHubPublicationConfig,
  prepareGitHubPublicationSession,
  repositoryPublicationPreflightCredential,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  prepareGitHubPublicationWorkspaceOwner,
  sameGitHubPublicationWorkspace,
} from "../github-publication-availability.js";
import type { PublicationSessionIdentity } from "../github-publication-session.types.js";
import { parseGitHubRemoteUrl } from "../github-remote.js";
import { StaleWorkerBuildError } from "./admission.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import {
  bindWorkerTurnGitHubGrant,
  type WorkerTurnExecutionIdentityStore,
} from "./placement-turn-claim-events.js";
import type {
  WorkerGitHubBindingGrant,
  WorkerGitHubBindingRefresh,
} from "./worker-github-binding-contract.js";

function workspaceKey(
  workspace: Awaited<ReturnType<typeof prepareGitHubPublicationWorkspaceOwner>>["initial"],
): string {
  return JSON.stringify(
    workspace.kind === "repository"
      ? [
          workspace.kind,
          workspace.workspace.workspaceId,
          workspace.workspace.url,
          workspace.workspace.branch,
        ]
      : [
          workspace.kind,
          workspace.worktree.id,
          workspace.worktree.repoFingerprint,
          workspace.worktree.branch,
        ],
  );
}

export async function prepareGitHubPublicationFact(
  params: PublicationSessionIdentity & {
    assertCurrent?: () => boolean;
  },
): Promise<
  | {
      available: boolean;
      github?: WorkerGitHubLaunchBinding;
      identity?: PreparedGitHubPublicationIdentity;
      workspaceKey?: string;
    }
  | undefined
> {
  try {
    if (params.assertCurrent?.() === false) {
      return undefined;
    }
    const currentWorkspace = await prepareGitHubPublicationWorkspaceOwner(params);
    using _ = { [Symbol.dispose]: () => currentWorkspace.release() };
    const workspace = currentWorkspace.initial;
    const identity = await prepareCurrentGitHubPublicationIdentity(
      params.agentId,
      undefined,
      undefined,
      false,
    );
    const originUrl =
      workspace.kind === "repository"
        ? workspace.workspace.url
        : (await managedWorktrees.resolveRepositoryIdentity(workspace.worktree.path)).originUrl;
    const current = await currentWorkspace.read();
    if (
      params.assertCurrent?.() === false ||
      !sameGitHubPublicationWorkspace(workspace, current) ||
      !matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity })
    ) {
      return undefined;
    }
    const remote = parseGitHubRemoteUrl(originUrl, identity.host);
    const remoteUrl =
      remote && /^[A-Za-z0-9_.-]+$/u.test(remote.owner) && /^[A-Za-z0-9_.-]+$/u.test(remote.repo)
        ? githubRepositoryUrl(`${remote.owner}/${remote.repo}`, identity.host)
        : undefined;
    const scope =
      identity.source === "agent-override"
        ? "agent"
        : identity.source === "system-configured"
          ? "system"
          : undefined;
    const gitAuthor = scope
      ? resolveConfiguredGitHubToolIdentity({
          config: currentGitHubPublicationConfig(),
          agentId: params.agentId,
          scope,
        })?.gitAuthor
      : undefined;
    const binding = parseWorkerGitHubLaunchBinding({
      token: identity.env.GH_TOKEN,
      host: identity.host,
      login: identity.account.login,
      branch:
        workspace.kind === "repository" ? workspace.workspace.branch : workspace.worktree.branch,
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(gitAuthor ? { gitAuthor } : {}),
    });
    return {
      available: Boolean(identity.env.GH_TOKEN),
      ...(binding ? { github: binding, identity, workspaceKey: workspaceKey(workspace) } : {}),
    };
  } catch {
    return undefined;
  }
}

const log = createSubsystemLogger("gateway/worker-github");

/** Discovery prepared the account off the turn path; admission binds only local live authority. */
async function prepareDiscoveredWorkerGitHubBindingGrant(
  params: PublicationSessionIdentity & {
    github: WorkerGitHubLaunchBinding;
    identity: PreparedGitHubPublicationIdentity;
    workspaceKey: string;
    sessionTarget: AgentRunSessionTarget;
    signal: AbortSignal;
    assertCurrent: () => void;
  },
): Promise<WorkerGitHubBindingGrant> {
  const controller = new AbortController();
  const signal = AbortSignal.any([params.signal, controller.signal]);
  const assertRun = () => {
    signal.throwIfAborted();
    params.assertCurrent();
  };
  assertRun();
  if (
    params.identity.accessExpiresAtMs !== undefined &&
    params.identity.accessExpiresAtMs <= Date.now()
  ) {
    throw new Error("Prepared GitHub credential expired; retry after background refresh");
  }
  const workspace = await prepareGitHubPublicationWorkspaceOwner(params, {
    sessionTarget: params.sessionTarget,
    assertCurrent: assertRun,
  });
  const initial = workspace.initial;
  const branch = initial.kind === "repository" ? initial.workspace.branch : initial.worktree.branch;
  if (
    workspaceKey(initial) !== params.workspaceKey ||
    branch !== params.github.branch ||
    params.identity.env.GH_TOKEN !== params.github.token
  ) {
    workspace.release();
    throw new Error("Prepared GitHub workspace or identity changed");
  }
  let revision = 0;
  let preparedRevision = 0;
  let checkedAt = Date.now();
  let generation = 0;
  let pending: WorkerGitHubBindingRefresh | undefined;
  let currentToken = params.github.token;
  let expiresAt = params.identity.accessExpiresAtMs;
  let pendingWork: Promise<WorkerGitHubBindingRefresh | undefined> | undefined;
  let released = false;
  const stops: (() => void)[] = [];
  const revoke = async () => {
    if (released) {
      return;
    }
    released = true;
    signal.removeEventListener("abort", onAbort);
    stops.splice(0).forEach((stop) => stop());
    workspace.release();
    controller.abort(new Error("Worker GitHub credential authority closed"));
  };
  const onAbort = () => {
    void revoke();
  };
  const assertCurrent = () => {
    try {
      assertRun();
      if (
        !sameGitHubPublicationWorkspace(initial, workspace.current()) ||
        !matchesCurrentGitHubPublicationIdentity({
          agentId: params.agentId,
          identity: params.identity,
        })
      ) {
        throw new Error("Worker GitHub credential authority changed");
      }
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  const changed = () => {
    try {
      assertCurrent();
    } catch {
      /* Abort owns cleanup. */
    }
  };
  try {
    signal.addEventListener("abort", onAbort, { once: true });
    stops.push(
      registerConfigWriteListener(changed),
      onUserProfilesChanged(changed),
      onUserProfileEmailBindingChanged(changed),
      onManagedGitHubProfileChanged(({ profileDir, kind }) => {
        if (profileDir === params.identity.env.GH_CONFIG_DIR) {
          if (kind === "removed") {
            controller.abort(new Error("Selected GitHub profile removed"));
          } else {
            revision++;
          }
        }
      }),
    );
    assertCurrent();
  } catch (error) {
    await revoke();
    throw error;
  }
  return {
    binding: params.github,
    signal,
    assertCurrent,
    revoke,
    refresh(installedGeneration) {
      pendingWork ??= (async () => {
        assertCurrent();
        if (pending && installedGeneration === pending.generation) {
          currentToken = pending.token;
          expiresAt = pending.expiresAtMs;
          pending = undefined;
        }
        if (pending?.expiresAtMs !== undefined && pending.expiresAtMs <= Date.now()) {
          pending = undefined;
        }
        if (
          Date.now() - checkedAt < 60_000 &&
          revision === preparedRevision &&
          (expiresAt === undefined || expiresAt > Date.now() + 60_000)
        ) {
          return pending;
        }
        const startedRevision = revision;
        const identity = await prepareCurrentGitHubPublicationIdentity(
          params.agentId,
          assertCurrent,
        );
        const current = await workspace.read();
        assertCurrent();
        if (
          !sameGitHubPublicationWorkspace(initial, current) ||
          identity.source !== params.identity.source ||
          identity.profileId !== params.identity.profileId ||
          identity.account.accountId !== params.identity.account.accountId ||
          identity.account.login.toLowerCase() !== params.identity.account.login.toLowerCase()
        ) {
          controller.abort(new Error("Selected GitHub account changed; start a new turn"));
          signal.throwIfAborted();
        }
        const token = identity.env.GH_TOKEN;
        if (
          !token ||
          (identity.accessExpiresAtMs !== undefined && identity.accessExpiresAtMs <= Date.now())
        ) {
          throw new Error("Selected GitHub credential expired or unavailable");
        }
        checkedAt = Date.now();
        preparedRevision = startedRevision;
        if (token !== (pending?.token ?? currentToken)) {
          pending = { generation: ++generation, token, expiresAtMs: identity.accessExpiresAtMs };
        }
        return pending;
      })()
        .catch((error: unknown) => {
          assertCurrent();
          if (expiresAt !== undefined && expiresAt <= Date.now()) {
            controller.abort(error);
            signal.throwIfAborted();
          }
          log.warn(
            "Worker GitHub renewal failed; retrying while the current credential remains usable.",
          );
          return pending;
        })
        .finally(() => {
          pendingWork = undefined;
        });
      return pendingWork;
    },
  };
}

/** Attach the background fact to this admitted turn without running identity discovery. */
export async function bindWorkerGitHubTurn(params: {
  session: PublicationSessionIdentity;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  fact: Awaited<ReturnType<typeof prepareGitHubPublicationFact>>;
  sessionTarget: AgentRunSessionTarget;
  store: WorkerTurnExecutionIdentityStore;
  claim: WorkerSessionTurnClaim;
  protocolFeatures: readonly string[];
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<WorkerGitHubBindingGrant | undefined> {
  if (getRepositoryIntegration()) {
    if (!params.protocolFeatures.includes(WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE)) {
      throw new StaleWorkerBuildError();
    }
    const grant = await prepareWorkerGitHubBindingGrant({
      ...params.session,
      operatorAuthority: params.operatorAuthority,
      signal: params.signal,
      assertCurrent: () => {
        params.assertCurrent();
        return true;
      },
    });
    if (grant) {
      try {
        params.assertCurrent();
        bindWorkerTurnGitHubGrant(params.store, params.claim, grant);
      } catch (error) {
        await grant.revoke();
        throw error;
      }
    }
    return grant;
  }
  const { github, identity, workspaceKey: expectedWorkspace } = params.fact ?? {};
  if (!github || !identity || !expectedWorkspace) {
    return undefined;
  }
  if (!params.protocolFeatures.includes(WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE)) {
    throw new StaleWorkerBuildError();
  }
  const preparing = prepareDiscoveredWorkerGitHubBindingGrant({
    ...params.session,
    github,
    identity,
    workspaceKey: expectedWorkspace,
    sessionTarget: params.sessionTarget,
    signal: params.signal,
    assertCurrent: params.assertCurrent,
  }).then((grant) => {
    if (params.signal.aborted) {
      void grant.revoke();
    }
    return grant;
  });
  const grant = await raceNodeWorkerOperation(preparing, params.signal);
  try {
    bindWorkerTurnGitHubGrant(params.store, params.claim, grant);
  } catch (error) {
    await grant.revoke();
    throw error;
  }
  return grant;
}

/** A native worker receives only the selected execution identity under its current operator and session. */
export async function prepareWorkerGitHubBindingGrant(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  expectedProfileId?: string;
  signal?: AbortSignal;
  assertCurrent?: () => boolean;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}): Promise<WorkerGitHubBindingGrant | undefined> {
  const initialConfig = currentGitHubPublicationConfig();
  const repositoryIntegration = getRepositoryIntegration(initialConfig);
  const configuredIdentity =
    resolveConfiguredGitHubToolIdentity({
      config: initialConfig,
      agentId: params.agentId,
      scope: "agent",
    }) ??
    resolveConfiguredGitHubToolIdentity({
      config: initialConfig,
      agentId: params.agentId,
      scope: "system",
    });
  // Native worker inference did not opt into Gateway GitHub credentials. Leave its
  // own environment alone; optional host CLI discovery must not gate model startup.
  if (!configuredIdentity && !repositoryIntegration && !params.expectedProfileId) {
    return undefined;
  }
  const caller = getGatewayToolCallerIdentity();
  const operator =
    params.operatorAuthority ??
    (caller?.agentId === params.agentId && caller.sessionKey === params.sessionKey
      ? caller.operatorAuthority
      : undefined);
  if (repositoryIntegration && !operator) {
    throw new Error("Worker GitHub execution requires the verified operator and session.");
  }
  if (operator) {
    assertAdmittedRunOperatorAuthority(operator);
    operator.assertCurrent();
  }
  const controller = new AbortController();
  const signal = AbortSignal.any(
    [controller.signal, params.signal, operator?.signal].filter((value): value is AbortSignal =>
      Boolean(value),
    ),
  );
  let closed = false;
  const assertAuthority = () => {
    signal.throwIfAborted();
    if (params.expectedProfileId) {
      const config = currentGitHubPublicationConfig();
      const selected =
        resolveConfiguredGitHubToolIdentity({ config, agentId: params.agentId, scope: "agent" }) ??
        resolveConfiguredGitHubToolIdentity({ config, agentId: params.agentId, scope: "system" });
      if (
        selected?.kind !== "app-installation" ||
        selected.profileId !== params.expectedProfileId
      ) {
        throw new Error("Selected GitHub App changed; start a new turn");
      }
    }
    operator?.assertCurrent();
    if (closed || params.assertCurrent?.() === false) {
      throw new Error("Worker GitHub execution authority closed");
    }
  };
  assertAuthority();
  const session = await prepareGitHubPublicationSession(params.sessionKey, {
    agentId: params.agentId,
    assertCurrent: assertAuthority,
  });
  let retained = false;
  const apiBaseUrl = resolveGitHubApiBaseUrl();
  let identity: Awaited<ReturnType<typeof prepareCurrentGitHubPublicationIdentity>> | undefined;
  try {
    const loaded = session.readCurrent();
    if (loaded.entry?.sessionId !== params.sessionId || loaded.agentId !== params.agentId) {
      throw new Error("Worker GitHub session authority changed");
    }
    const lifecycleRevision = loaded.entry.lifecycleRevision ?? null;
    const assertCurrent = () => {
      assertAuthority();
      if (resolveGitHubApiBaseUrl() !== apiBaseUrl) {
        throw new Error("Worker GitHub issuer changed");
      }
      const current = session.readCurrent();
      if (
        current.entry?.sessionId !== params.sessionId ||
        (current.entry.lifecycleRevision ?? null) !== lifecycleRevision
      ) {
        throw new Error("Worker GitHub session authority changed");
      }
      if (
        identity &&
        (!matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity }) ||
          (identity.accessExpiresAtMs !== undefined && identity.accessExpiresAtMs <= Date.now()))
      ) {
        throw new Error("Worker GitHub credential expired or its selection changed");
      }
    };
    identity = await prepareCurrentGitHubPublicationIdentity(
      params.agentId,
      operator
        ? {
            profileId: operator.profileId,
            credentialSource: operator.repositoryCredentialSource,
            sessionKey: params.sessionKey,
            assertCurrent,
          }
        : undefined,
      repositoryPublicationPreflightCredential({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        lifecycleRevision,
        assertCurrent,
      }),
    );
    assertCurrent();
    const scope =
      identity.source === "agent-override"
        ? "agent"
        : identity.source === "system-configured"
          ? "system"
          : undefined;
    const gitAuthor = scope
      ? resolveConfiguredGitHubToolIdentity({
          config: currentGitHubPublicationConfig(),
          agentId: params.agentId,
          scope,
        })?.gitAuthor
      : undefined;
    const binding = parseWorkerGitHubLaunchBinding({
      token: identity.env.GH_TOKEN,
      host: identity.host,
      login: identity.account.login,
      ...(gitAuthor ? { gitAuthor } : {}),
    });
    if (!binding) {
      throw new Error("Selected GitHub execution identity cannot be installed on this worker");
    }
    const selectedIdentity = identity;
    const credentials = new Set([identity]);
    let pending:
      | { identity: PreparedGitHubPublicationIdentity; update: WorkerGitHubBindingRefresh }
      | undefined;
    let generation = 0;
    let pendingWork: Promise<WorkerGitHubBindingRefresh | undefined> | undefined;
    let attemptedAt = Number.NEGATIVE_INFINITY;
    let revocation: Promise<void> | undefined;
    const stops: (() => void)[] = [];
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const revoke = () => {
      if (!revocation) {
        closed = true;
        clearTimeout(expiryTimer);
        signal.removeEventListener("abort", onAbort);
        stops.splice(0).forEach((stop) => stop());
        controller.abort(new Error("Worker GitHub execution authority closed"));
        session.release();
        revocation = (async () => {
          // In-flight issuance owns its late-result cleanup before the grant can close.
          await pendingWork?.catch(() => {});
          const outcomes = await Promise.allSettled(
            [...credentials].map((value) => Promise.resolve(value.revoke?.())),
          );
          const failures = outcomes.flatMap((outcome) =>
            outcome.status === "rejected" ? [outcome.reason] : [],
          );
          if (failures.length) {
            throw new AggregateError(failures, "Worker GitHub credential cleanup failed");
          }
        })();
      }
      return revocation;
    };
    const onAbort = () => {
      void revoke().catch(() =>
        log.warn("GitHub App credential cleanup failed; retry cleanup before reusing the worker."),
      );
    };
    const armExpiry = () => {
      clearTimeout(expiryTimer);
      if (identity?.accessExpiresAtMs !== undefined) {
        expiryTimer = setTimeout(onAbort, Math.max(1, identity.accessExpiresAtMs - Date.now()));
        expiryTimer.unref?.();
      }
    };
    const changed = () => {
      try {
        assertCurrent();
      } catch {
        onAbort();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    stops.push(
      registerConfigWriteListener(changed),
      onUserProfilesChanged(changed),
      onUserProfileEmailBindingChanged(changed),
    );
    armExpiry();
    assertCurrent();
    retained = true;
    return {
      binding,
      signal,
      assertCurrent,
      revoke,
      refresh(installedGeneration) {
        pendingWork ??= (async () => {
          assertCurrent();
          if (pending && installedGeneration === pending.update.generation) {
            identity = pending.identity;
            pending = undefined;
            // ACK advances only the installed deadline. Running commands keep their old
            // token's original validity; the turn's terminal cleanup still owns revocation.
            armExpiry();
          }
          if (pending) {
            return pending.update;
          }
          const expiresAt = identity?.accessExpiresAtMs;
          if (
            expiresAt === undefined ||
            expiresAt > Date.now() + 5 * 60_000 ||
            Date.now() - attemptedAt < 30_000
          ) {
            return undefined;
          }
          attemptedAt = Date.now();
          const replacement = await prepareCurrentGitHubPublicationIdentity(
            params.agentId,
            operator
              ? {
                  profileId: operator.profileId,
                  credentialSource: operator.repositoryCredentialSource,
                  sessionKey: params.sessionKey,
                  assertCurrent,
                }
              : assertCurrent,
            repositoryPublicationPreflightCredential({
              agentId: params.agentId,
              sessionKey: params.sessionKey,
              sessionId: params.sessionId,
              lifecycleRevision,
              assertCurrent,
            }),
          );
          const knownToken = [...credentials].some(
            (value) => value.env.GH_TOKEN === replacement.env.GH_TOKEN,
          );
          credentials.add(replacement);
          assertCurrent();
          if (
            replacement.source !== selectedIdentity.source ||
            replacement.profileId !== selectedIdentity.profileId ||
            replacement.host !== selectedIdentity.host ||
            replacement.account.accountId !== selectedIdentity.account.accountId ||
            replacement.account.login.toLowerCase() !==
              selectedIdentity.account.login.toLowerCase() ||
            !replacement.env.GH_TOKEN
          ) {
            throw new Error("Selected GitHub account or issuer changed; start a new turn");
          }
          // Re-reading an unchanged bearer never renews its lifetime or revokes it.
          if (knownToken) {
            if (replacement !== identity) {
              credentials.delete(replacement);
            }
            return undefined;
          }
          if (
            replacement.accessExpiresAtMs === undefined ||
            replacement.accessExpiresAtMs <= Date.now()
          ) {
            throw new Error("Renewed GitHub credential has no usable expiry");
          }
          pending = {
            identity: replacement,
            update: {
              generation: ++generation,
              token: replacement.env.GH_TOKEN,
              expiresAtMs: replacement.accessExpiresAtMs,
            },
          };
          return pending.update;
        })()
          .catch((error: unknown) => {
            try {
              assertCurrent();
            } catch (authorityError) {
              onAbort();
              throw authorityError;
            }
            if (error instanceof GitHubAppInstallationRetryableError) {
              log.warn(
                "Worker GitHub renewal failed; retrying while the installed credential remains usable.",
              );
              return undefined;
            }
            onAbort();
            throw error;
          })
          .finally(() => {
            pendingWork = undefined;
          });
        return pendingWork;
      },
    };
  } finally {
    if (!retained) {
      session.release();
      await identity?.revoke?.();
    }
  }
}

export type {
  WorkerGitHubBindingGrant,
  WorkerGitHubBindingRefresh,
} from "./worker-github-binding-contract.js";
