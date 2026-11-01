import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  SESSION_CREATE_IDEMPOTENCY_RETENTION_MS,
  errorShape,
  missingScopeErrorShape,
  type SessionsCreateParams,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  prepareSessionCreationOperation,
  SessionCreationOperationError,
  readSessionCreationOperationError,
} from "../../config/sessions/session-creation-operation.js";
import { sessionEntryForkedFromParent } from "../../config/sessions/session-entry-lineage.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { getOrCreateWeakOwnerMap } from "../../shared/weak-owner-map.js";
import { DEDUPE_MAX } from "../server-constants.js";
import type {
  CreateGatewaySessionResult,
  PreparedGatewaySessionLifecycle,
} from "../session-create-service.types.js";
import { projectSessionFastModeEntryResult } from "../session-fast-mode-presentation.js";
import { resolveSessionCreateAgentId } from "../session-request-agent.js";
import { gatewayClientUploadPolicyError } from "../upload-policy.js";
import type { GatewayInflightResult } from "./inflight.js";
import { respondError } from "./response.js";
import { isFreshChatSendStarted } from "./session-create-initial-turn.js";
import { prepareRequiredWorkerSessionCreate } from "./session-create-required-worker.js";
import { bindGatewayRequestHandlerMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestContext, GatewayRequestHandler, RespondFn } from "./types.js";

type SessionCreateAuthorization = { role: string | null; scopes: readonly string[] };
type SessionCreateEntry = {
  requestIdentity: string;
  authorization: SessionCreateAuthorization;
  expiresAt: number;
  state:
    | { kind: "inflight"; work: Promise<GatewayInflightResult> }
    | { kind: "completed"; result: GatewayInflightResult };
};

const sessionCreatesByContext = new WeakMap<
  GatewayRequestContext,
  Map<string, Map<string, SessionCreateEntry>>
>();

/** Pin immutable intent before applying the required placement and physical creation key. */
export function prepareSessionCreateRequest(
  params: SessionsCreateParams,
  caller: Pick<Parameters<GatewayRequestHandler>[0], "client" | "context">,
): Result<
  {
    params: SessionsCreateParams;
    requiredProfile?: string;
    automaticEmptyWorkspace: boolean;
    creationOperation?: ReturnType<typeof prepareSessionCreationOperation>;
  },
  ErrorShape
> {
  const uploadError = gatewayClientUploadPolicyError({
    method: "sessions.create",
    requestParams: params,
    client: caller.client,
    context: caller.context,
  });
  if (uploadError) {
    return err(uploadError);
  }
  const profileId = caller.client?.authenticatedUserProfile?.profileId;
  const config = caller.context.getRuntimeConfig();
  const mutable = structuredClone(params);
  const placement = prepareRequiredWorkerSessionCreate(mutable, config);
  if (placement.error) {
    return err(placement.error);
  }
  const { requiredProfile, automaticEmptyWorkspace } = placement;
  const request = { params: mutable, requiredProfile, automaticEmptyWorkspace };
  if (
    params.purpose &&
    (!params.creationOperationId ||
      !params.sessionId ||
      Boolean(params.repository) !== (params.purpose === "coding") ||
      !requiredProfile ||
      !config.cloudWorkers?.profiles?.[requiredProfile])
  ) {
    return err(
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Worker creation requires a durable operation, physical UUID, and configured required worker profile; coding requires repository and investigation requires an empty workspace.",
      ),
    );
  }
  if (params.creationOperationId === undefined && params.sessionId === undefined) {
    return ok(request);
  }
  const allowed = new Set([
    "creationOperationId",
    "sessionId",
    "agentId",
    "label",
    "idempotencyKey",
    "purpose",
    "repository",
  ]);
  if (
    Object.keys(params).some((key) => !allowed.has(key)) ||
    !params.creationOperationId ||
    !params.sessionId ||
    !profileId ||
    Boolean(params.repository) !== (params.purpose === "coding")
  ) {
    return err(
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Durable creation requires a verified profile, operation ID and physical UUID, with empty-session arguments or a worker purpose and its repository selection only.",
      ),
    );
  }
  try {
    const { idempotencyKey: _transportId, ...immutable } = params;
    const creationOperation = prepareSessionCreationOperation(
      profileId,
      params.creationOperationId,
      params.sessionId,
      immutable,
      Date.now(),
    );
    // A caller-selected physical UUID identifies a target; it never grants authority.
    mutable.key = `dashboard:${creationOperation.sessionId}`;
    return ok({ ...request, creationOperation });
  } catch (error) {
    if (!(error instanceof SessionCreationOperationError)) {
      throw error;
    }
    return err(
      errorShape(ErrorCodes.INVALID_REQUEST, error.message, { details: { reason: error.reason } }),
    );
  }
}

export function idempotentSessionCreate(handler: GatewayRequestHandler): GatewayRequestHandler {
  return async (request) => {
    const respond: RespondFn = (...args) => {
      if (args[0] && args.length > 1) {
        args[1] = projectSessionFastModeEntryResult(args[1], request.client);
      }
      request.respond(...args);
    };
    if (typeof request.params.creationOperationId === "string") {
      try {
        prepareSessionCreationOperation(
          request.client?.authenticatedUserProfile?.profileId ?? "",
          request.params.creationOperationId,
          typeof request.params.sessionId === "string" ? request.params.sessionId : "",
          request.params,
          Date.now(),
        );
      } catch (error) {
        if (!(error instanceof SessionCreationOperationError)) {
          throw error;
        }
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
            details: { reason: error.reason },
          }),
        );
        return;
      }
    }
    const idempotencyKey = request.params.idempotencyKey;
    if (typeof idempotencyKey !== "string" || !idempotencyKey) {
      await handler(
        bindGatewayRequestHandlerMutationAuthority(request, { ...request, respond }, undefined),
      );
      return;
    }
    // Hosted tools retain a live operator source without impersonating a human connection.
    const operatorAuthority = request.client?.internal?.operatorRunAuthority;
    operatorAuthority?.assertCurrent();
    const principal =
      request.client?.authenticatedUserProfile?.profileId ??
      request.client?.authenticatedUserId ??
      operatorAuthority?.profileId;
    const deviceId = request.client?.connect.device?.id?.trim();
    if (!principal && !deviceId) {
      respondError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        "idempotent session creation requires an authenticated principal or device identity",
      );
      return;
    }
    const owner = principal ? `principal:${principal}` : `device:${deviceId}`;
    const entriesByOwner = getOrCreateWeakOwnerMap(sessionCreatesByContext, request.context);
    const now = Date.now();
    let retainedEntryCount = 0;
    for (const [entryOwner, ownerEntries] of entriesByOwner) {
      for (const [key, entry] of ownerEntries) {
        if (entry.state.kind === "completed" && entry.expiresAt <= now) {
          ownerEntries.delete(key);
        }
      }
      if (ownerEntries.size === 0) {
        entriesByOwner.delete(entryOwner);
      } else {
        retainedEntryCount += ownerEntries.size;
      }
    }
    let entries = entriesByOwner.get(owner);
    const requestIdentity = sha256Hex(stableStringify(request.params));
    const authorization: SessionCreateAuthorization = {
      role: request.client?.connect.role ?? null,
      scopes: request.client?.connect.scopes?.toSorted() ?? [],
    };
    const existing = entries?.get(idempotencyKey);
    if (existing) {
      if (existing.requestIdentity !== requestIdentity) {
        respondError(
          respond,
          ErrorCodes.INVALID_REQUEST,
          "session creation idempotency key was reused with different parameters",
        );
        return;
      }
      if (existing.authorization.role !== authorization.role) {
        respondError(
          respond,
          ErrorCodes.FORBIDDEN,
          "session creation authorization changed; start again",
        );
        return;
      }
      const missingScope = existing.authorization.scopes.find(
        (scope) => !authorization.scopes.includes(scope),
      );
      if (missingScope) {
        respond(
          false,
          undefined,
          missingScopeErrorShape({
            missingScope,
            requiredScopes: existing.authorization.scopes,
          }),
        );
        return;
      }
      const result =
        existing.state.kind === "completed" ? existing.state.result : await existing.state.work;
      respond(result.ok, result.payload, result.error, {
        ...result.meta,
        cached: true,
      });
      return;
    }
    // Reserve a full owner's capacity for other principals while bounding process-wide state.
    if ((entries?.size ?? 0) >= DEDUPE_MAX || retainedEntryCount >= DEDUPE_MAX * 2) {
      respondError(
        respond,
        ErrorCodes.UNAVAILABLE,
        "session creation capacity is full; retry later",
      );
      return;
    }
    if (!entries) {
      entries = new Map();
      entriesByOwner.set(owner, entries);
    }
    const releaseEntry = () => {
      entries.delete(idempotencyKey);
      if (entries.size === 0) {
        entriesByOwner.delete(owner);
      }
    };
    // The entry is installed before work begins; in-flight identity is never TTL/cap-evictable.
    const work = Promise.resolve().then(async (): Promise<GatewayInflightResult> => {
      try {
        let result: GatewayInflightResult | undefined;
        await handler(
          bindGatewayRequestHandlerMutationAuthority(
            request,
            {
              ...request,
              respond: (accepted, payload, error, meta) => {
                result = { ok: accepted, payload, error, meta };
              },
            },
            undefined,
          ),
        );
        result ??= {
          ok: false,
          error: errorShape(ErrorCodes.UNAVAILABLE, "session creation was interrupted"),
        };
        if (result.ok) {
          entry.expiresAt = Date.now() + SESSION_CREATE_IDEMPOTENCY_RETENTION_MS;
          entry.state = { kind: "completed", result };
        } else {
          releaseEntry();
        }
        return result;
      } catch (error) {
        releaseEntry();
        throw error;
      }
    });
    const entry: SessionCreateEntry = {
      requestIdentity,
      authorization,
      expiresAt: now + SESSION_CREATE_IDEMPOTENCY_RETENTION_MS,
      state: { kind: "inflight", work },
    };
    entries.set(idempotencyKey, entry);
    const result = await work;
    respond(result.ok, result.payload, result.error, result.meta);
  };
}

export function durableSessionCreateAgentError(
  params: SessionsCreateParams,
  config: OpenClawConfig,
): ErrorShape | undefined {
  const selected = resolveSessionCreateAgentId(config, {});
  return !selected.ok ||
    (params.agentId !== undefined && normalizeAgentId(params.agentId) !== selected.agentId)
    ? errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Durable creation is restricted to the configured default agent.",
      )
    : undefined;
}

export function sessionCreationOperationErrorShape(error: unknown): ErrorShape | undefined {
  const failure = readSessionCreationOperationError(error);
  return failure
    ? errorShape(ErrorCodes.INVALID_REQUEST, failure.message, {
        details: { reason: failure.reason },
      })
    : undefined;
}

/** Transport presentation combines committed session facts with its initial-turn outcome. */
export function projectSessionCreateResponse(
  created: Extract<CreateGatewaySessionResult, { ok: true }>,
  params: {
    lifecycle?: PreparedGatewaySessionLifecycle;
    runPayload?: Record<string, unknown>;
    runError: unknown;
    runMeta?: Record<string, unknown>;
    publicRead: boolean;
    creationOperationId?: string;
    creationReplayed: boolean;
  },
) {
  const worktree = params.lifecycle?.worktree
    ? {
        id: params.lifecycle.worktree.id,
        path: params.lifecycle.sessionRoot,
        branch: params.lifecycle.worktree.branch,
      }
    : undefined;
  const runError =
    created.postCommit.status === "failed"
      ? errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(created.postCommit.error))
      : params.runError;
  const entry = sessionEntryForkedFromParent(created.entry)
    ? { ...created.entry, forkedFromParent: true as const }
    : created.entry;
  const runStarted =
    !created.resetExisting &&
    isFreshChatSendStarted({ payload: params.runPayload, cached: params.runMeta?.cached === true });
  return {
    ok: true,
    key: created.key,
    sessionId: created.entry.sessionId,
    ...(params.creationOperationId
      ? {
          creationOperationId: params.creationOperationId,
          creationReplayed: params.creationReplayed,
        }
      : {}),
    entry,
    runStarted,
    publicRead: params.publicRead,
    ...(!created.resetExisting && params.runPayload ? params.runPayload : {}),
    ...(!created.resetExisting && runError ? { runError } : {}),
    resolved: created.resolved,
    ...(worktree ? { worktree } : {}),
  };
}
