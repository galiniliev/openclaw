import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveMemoryPrincipalForUserProfile } from "openclaw/plugin-sdk/memory-sharing-control-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";

const MEMORY_SHARING_GATEWAY_METHODS = {
  status: "memory.sharing.status",
  projectionTargetRegister: "memory.sharing.projection.target.register",
  projectionPreview: "memory.sharing.projection.preview",
  projectionCreate: "memory.sharing.projection.create",
  projectionRefresh: "memory.sharing.projection.refresh",
  projectionRevoke: "memory.sharing.projection.revoke",
  projectionImpact: "memory.sharing.projection.impact",
  postboxMode: "memory.sharing.postbox.mode.set",
  postboxInspect: "memory.sharing.postbox.inspect",
  postboxReview: "memory.sharing.postbox.review",
  postboxPurge: "memory.sharing.postbox.purge",
} as const;

const loadSharing = createLazyRuntimeModule(() => import("./scoped-memory-sharing.js"));

class InvalidMemorySharingRequestError extends Error {}
class ForbiddenMemorySharingRequestError extends Error {}

function paramsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidMemorySharingRequestError("params must be an object.");
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(params: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  const unexpected = Object.keys(params).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new InvalidMemorySharingRequestError(`unexpected parameter: ${unexpected}`);
  }
}

function readRequiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidMemorySharingRequestError(`${key} must be a non-empty string.`);
  }
  return value.trim();
}

function readAgentId(params: Record<string, unknown>): string {
  try {
    return normalizeAgentId(readRequiredString(params, "agentId"));
  } catch (error) {
    throw new InvalidMemorySharingRequestError(
      error instanceof Error ? error.message : "agentId is invalid.",
    );
  }
}

function readProjectionTarget(params: Record<string, unknown>, agentId: string) {
  const kind = readRequiredString(params, "targetKind");
  if (kind !== "conversation" && kind !== "role" && kind !== "agent-shared") {
    throw new InvalidMemorySharingRequestError(
      "targetKind must be conversation, role, or agent-shared.",
    );
  }
  const id = readRequiredString(params, "targetId");
  if (id === "*" || (kind === "agent-shared" && id !== agentId)) {
    throw new InvalidMemorySharingRequestError("projection target is unavailable.");
  }
  return { kind, id } as const;
}

function readExpiry(params: Record<string, unknown>) {
  const expiresAt = params.expiresAt;
  const noExpiryAuditReason = params.noExpiryAuditReason;
  if (typeof expiresAt === "string" && expiresAt.trim() && noExpiryAuditReason === undefined) {
    const parsed = Date.parse(expiresAt);
    if (!Number.isSafeInteger(parsed) || parsed <= Date.now()) {
      throw new InvalidMemorySharingRequestError("expiresAt must be a future ISO timestamp.");
    }
    return { kind: "expires" as const, expiresAt: parsed };
  }
  if (
    expiresAt === undefined &&
    typeof noExpiryAuditReason === "string" &&
    noExpiryAuditReason.trim()
  ) {
    return { kind: "no-expiry" as const, auditReason: noExpiryAuditReason.trim() };
  }
  throw new InvalidMemorySharingRequestError(
    "provide either a future expiresAt or a noExpiryAuditReason.",
  );
}

type ProjectionDraftRequest = Readonly<{
  agentId: string;
  sourceRevisionId: string;
  purpose: string;
  preview: string;
  expiry: ReturnType<typeof readExpiry>;
}>;

type ProjectionCreateRequest = ProjectionDraftRequest &
  Readonly<{ target: ReturnType<typeof readProjectionTarget>; content: string }>;
type ProjectionPreviewRequest = ProjectionDraftRequest &
  Readonly<{ target: ReturnType<typeof readProjectionTarget> }>;
type ProjectionRefreshRequest = ProjectionDraftRequest &
  Readonly<{ projectionId: string; content: string }>;

function readProjectionDraftRequest(value: unknown) {
  const request = paramsRecord(value);
  return {
    agentId: readAgentId(request),
    sourceRevisionId: readRequiredString(request, "sourceRevisionId"),
    purpose: readRequiredString(request, "purpose"),
    preview: readRequiredString(request, "preview"),
    expiry: readExpiry(request),
  } satisfies ProjectionDraftRequest;
}

function readProjectionPreviewRequest(value: unknown): ProjectionPreviewRequest {
  const request = paramsRecord(value);
  const draft = readProjectionDraftRequest(value);
  assertOnlyKeys(request, [
    "agentId",
    "sourceRevisionId",
    "targetKind",
    "targetId",
    "purpose",
    "preview",
    "expiresAt",
    "noExpiryAuditReason",
  ]);
  return { ...draft, target: readProjectionTarget(request, draft.agentId) };
}

function readProjectionCreateRequest(value: unknown): ProjectionCreateRequest {
  const request = paramsRecord(value);
  const draft = readProjectionDraftRequest(value);
  assertOnlyKeys(request, [
    "agentId",
    "sourceRevisionId",
    "targetKind",
    "targetId",
    "purpose",
    "preview",
    "content",
    "expiresAt",
    "noExpiryAuditReason",
  ]);
  return {
    ...draft,
    target: readProjectionTarget(request, draft.agentId),
    content: readRequiredString(request, "content"),
  };
}

function readProjectionRefreshRequest(value: unknown): ProjectionRefreshRequest {
  const request = paramsRecord(value);
  const draft = readProjectionDraftRequest(value);
  assertOnlyKeys(request, [
    "agentId",
    "projectionId",
    "sourceRevisionId",
    "purpose",
    "preview",
    "content",
    "expiresAt",
    "noExpiryAuditReason",
  ]);
  return {
    ...draft,
    projectionId: readRequiredString(request, "projectionId"),
    content: readRequiredString(request, "content"),
  };
}

function readProjectionIdRequest(value: unknown) {
  const request = paramsRecord(value);
  assertOnlyKeys(request, ["agentId", "projectionId"]);
  return {
    agentId: readAgentId(request),
    projectionId: readRequiredString(request, "projectionId"),
  };
}

function readProjectionTargetRegisterRequest(value: unknown) {
  const request = paramsRecord(value);
  assertOnlyKeys(request, ["agentId", "targetKind", "targetId", "storeId"]);
  const agentId = readAgentId(request);
  return {
    agentId,
    target: readProjectionTarget(request, agentId),
    storeId: readRequiredString(request, "storeId"),
  };
}

function readPostboxItemIdRequest(value: unknown) {
  const request = paramsRecord(value);
  assertOnlyKeys(request, ["agentId", "itemId"]);
  return {
    agentId: readAgentId(request),
    itemId: readRequiredString(request, "itemId"),
  };
}

function readPostboxReviewRequest(value: unknown): {
  agentId: string;
  itemId: string;
  decision: "approve" | "reject";
  reviewedContent?: string;
} {
  const request = paramsRecord(value);
  assertOnlyKeys(request, ["agentId", "itemId", "decision", "reviewedContent"]);
  const decision = readRequiredString(request, "decision");
  if (decision !== "approve" && decision !== "reject") {
    throw new InvalidMemorySharingRequestError("decision must be approve or reject.");
  }
  const reviewedContent = request.reviewedContent;
  if (decision === "reject" && reviewedContent !== undefined) {
    throw new InvalidMemorySharingRequestError("reviewedContent is available only for approve.");
  }
  return {
    agentId: readAgentId(request),
    itemId: readRequiredString(request, "itemId"),
    decision,
    ...(reviewedContent === undefined
      ? {}
      : { reviewedContent: readRequiredString(request, "reviewedContent") }),
  };
}

function resolveGatewayPrincipal(
  client: {
    authenticatedUserProfile?: { profileId: string };
  } | null,
): string {
  const profileId = client?.authenticatedUserProfile?.profileId;
  if (!profileId) {
    throw new ForbiddenMemorySharingRequestError(
      "memory sharing requires an authenticated Gateway profile.",
    );
  }
  const principal = resolveMemoryPrincipalForUserProfile({ userProfileId: profileId });
  if (!principal) {
    throw new ForbiddenMemorySharingRequestError("memory sharing is unavailable for this profile.");
  }
  return principal.principalId;
}

function respondInvalid(respond: GatewayRequestHandlerOptions["respond"], error: unknown) {
  const message = error instanceof Error ? error.message : "invalid memory sharing request";
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

function respondForbidden(respond: GatewayRequestHandlerOptions["respond"], error: unknown) {
  const message = error instanceof Error ? error.message : "memory sharing is unavailable";
  respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, message));
}

function respondUnavailable(respond: GatewayRequestHandlerOptions["respond"]) {
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "memory sharing is unavailable"));
}

/** Register profile-derived, redacted sharing controls. No handler accepts a principal or private-store id. */
export function registerScopedMemorySharingGatewayMethods(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    MEMORY_SHARING_GATEWAY_METHODS.status,
    async ({ params, client, respond }) => {
      try {
        const request = paramsRecord(params);
        assertOnlyKeys(request, ["agentId"]);
        const agentId = readAgentId(request);
        const operatorPrincipalId = resolveGatewayPrincipal(client);
        const { inspectBuiltinMemorySharingStatus } = await loadSharing();
        respond(true, inspectBuiltinMemorySharingStatus({ agentId, operatorPrincipalId }));
      } catch (error) {
        if (error instanceof InvalidMemorySharingRequestError) {
          respondInvalid(respond, error);
        } else if (error instanceof ForbiddenMemorySharingRequestError) {
          respondForbidden(respond, error);
        } else {
          respondUnavailable(respond);
        }
      }
    },
    { scope: "operator.read" },
  );

  api.registerGatewayMethod(
    MEMORY_SHARING_GATEWAY_METHODS.projectionTargetRegister,
    async ({ params, client, respond }) => {
      try {
        const request = readProjectionTargetRegisterRequest(params);
        const operatorPrincipalId = resolveGatewayPrincipal(client);
        const { registerBuiltinMemoryProjectionTargetStore } = await loadSharing();
        registerBuiltinMemoryProjectionTargetStore({ ...request, operatorPrincipalId });
        respond(true, { target: request.target });
      } catch (error) {
        if (error instanceof InvalidMemorySharingRequestError) {
          respondInvalid(respond, error);
        } else if (error instanceof ForbiddenMemorySharingRequestError) {
          respondForbidden(respond, error);
        } else {
          respondUnavailable(respond);
        }
      }
    },
    { scope: "operator.admin" },
  );

  api.registerGatewayMethod(
    MEMORY_SHARING_GATEWAY_METHODS.projectionPreview,
    async ({ params, client, respond }) => {
      try {
        const request = readProjectionPreviewRequest(params);
        const publisherPrincipalId = resolveGatewayPrincipal(client);
        const { previewBuiltinMemoryProjection } = await loadSharing();
        respond(true, previewBuiltinMemoryProjection({ ...request, publisherPrincipalId }));
      } catch (error) {
        if (error instanceof InvalidMemorySharingRequestError) {
          respondInvalid(respond, error);
        } else if (error instanceof ForbiddenMemorySharingRequestError) {
          respondForbidden(respond, error);
        } else {
          respondUnavailable(respond);
        }
      }
    },
    { scope: "operator.admin" },
  );

  api.registerGatewayMethod(
    MEMORY_SHARING_GATEWAY_METHODS.projectionCreate,
    async ({ params, client, respond }) => {
      try {
        const request = readProjectionCreateRequest(params);
        const publisherPrincipalId = resolveGatewayPrincipal(client);
        const { createBuiltinMemoryProjection } = await loadSharing();
        respond(
          true,
          createBuiltinMemoryProjection({
            agentId: request.agentId,
            sourceRevisionId: request.sourceRevisionId,
            target: request.target,
            purpose: request.purpose,
            preview: request.preview,
            content: request.content,
            expiry: request.expiry,
            publisherPrincipalId,
            reviewedByPrincipalId: publisherPrincipalId,
          }),
        );
      } catch (error) {
        if (error instanceof InvalidMemorySharingRequestError) {
          respondInvalid(respond, error);
        } else if (error instanceof ForbiddenMemorySharingRequestError) {
          respondForbidden(respond, error);
        } else {
          respondUnavailable(respond);
        }
      }
    },
    { scope: "operator.admin" },
  );

  api.registerGatewayMethod(
    MEMORY_SHARING_GATEWAY_METHODS.projectionRefresh,
    async ({ params, client, respond }) => {
      try {
        const request = readProjectionRefreshRequest(params);
        const publisherPrincipalId = resolveGatewayPrincipal(client);
        const { refreshBuiltinMemoryProjection } = await loadSharing();
        respond(
          true,
          refreshBuiltinMemoryProjection({
            agentId: request.agentId,
            projectionId: request.projectionId,
            sourceRevisionId: request.sourceRevisionId,
            purpose: request.purpose,
            preview: request.preview,
            content: request.content,
            expiry: request.expiry,
            publisherPrincipalId,
            reviewedByPrincipalId: publisherPrincipalId,
          }),
        );
      } catch (error) {
        if (error instanceof InvalidMemorySharingRequestError) {
          respondInvalid(respond, error);
        } else if (error instanceof ForbiddenMemorySharingRequestError) {
          respondForbidden(respond, error);
        } else {
          respondUnavailable(respond);
        }
      }
    },
    { scope: "operator.admin" },
  );

  api.registerGatewayMethod(
    MEMORY_SHARING_GATEWAY_METHODS.projectionRevoke,
    async ({ params, client, respond }) => {
      try {
        const request = readProjectionIdRequest(params);
        const operatorPrincipalId = resolveGatewayPrincipal(client);
        const { revokeBuiltinMemoryProjection } = await loadSharing();
        respond(true, {
          projectionId: request.projectionId,
          exposureSetIds: revokeBuiltinMemoryProjection({ ...request, operatorPrincipalId }),
        });
      } catch (error) {
        if (error instanceof InvalidMemorySharingRequestError) {
          respondInvalid(respond, error);
        } else if (error instanceof ForbiddenMemorySharingRequestError) {
          respondForbidden(respond, error);
        } else {
          respondUnavailable(respond);
        }
      }
    },
    { scope: "operator.admin" },
  );

  api.registerGatewayMethod(
    MEMORY_SHARING_GATEWAY_METHODS.projectionImpact,
    async ({ params, client, respond }) => {
      try {
        const request = readProjectionIdRequest(params);
        const operatorPrincipalId = resolveGatewayPrincipal(client);
        const { inspectBuiltinMemoryProjectionImpact } = await loadSharing();
        respond(true, inspectBuiltinMemoryProjectionImpact({ ...request, operatorPrincipalId }));
      } catch (error) {
        if (error instanceof InvalidMemorySharingRequestError) {
          respondInvalid(respond, error);
        } else if (error instanceof ForbiddenMemorySharingRequestError) {
          respondForbidden(respond, error);
        } else {
          respondUnavailable(respond);
        }
      }
    },
    { scope: "operator.read" },
  );

  api.registerGatewayMethod(
    MEMORY_SHARING_GATEWAY_METHODS.postboxMode,
    async ({ params, client, respond }) => {
      try {
        const request = paramsRecord(params);
        assertOnlyKeys(request, ["agentId", "mode"]);
        const agentId = readAgentId(request);
        const mode = readRequiredString(request, "mode");
        if (mode !== "off" && mode !== "review-required") {
          throw new InvalidMemorySharingRequestError("mode must be off or review-required.");
        }
        const principalId = resolveGatewayPrincipal(client);
        const { setBuiltinMemoryPostboxModeForPrincipal } = await loadSharing();
        setBuiltinMemoryPostboxModeForPrincipal({ agentId, principalId, mode });
        respond(true, { mode });
      } catch (error) {
        if (error instanceof InvalidMemorySharingRequestError) {
          respondInvalid(respond, error);
        } else if (error instanceof ForbiddenMemorySharingRequestError) {
          respondForbidden(respond, error);
        } else {
          respondUnavailable(respond);
        }
      }
    },
    { scope: "operator.admin" },
  );

  api.registerGatewayMethod(
    MEMORY_SHARING_GATEWAY_METHODS.postboxInspect,
    async ({ params, client, respond }) => {
      try {
        const request = readPostboxItemIdRequest(params);
        const operatorPrincipalId = resolveGatewayPrincipal(client);
        const { inspectBuiltinMemoryPostboxItem } = await loadSharing();
        respond(true, inspectBuiltinMemoryPostboxItem({ ...request, operatorPrincipalId }));
      } catch (error) {
        if (error instanceof InvalidMemorySharingRequestError) {
          respondInvalid(respond, error);
        } else if (error instanceof ForbiddenMemorySharingRequestError) {
          respondForbidden(respond, error);
        } else {
          respondUnavailable(respond);
        }
      }
    },
    { scope: "operator.read" },
  );

  api.registerGatewayMethod(
    MEMORY_SHARING_GATEWAY_METHODS.postboxReview,
    async ({ params, client, respond }) => {
      try {
        const request = readPostboxReviewRequest(params);
        const operatorPrincipalId = resolveGatewayPrincipal(client);
        const { reviewBuiltinMemoryPostboxItem } = await loadSharing();
        reviewBuiltinMemoryPostboxItem({ ...request, operatorPrincipalId });
        respond(true, { itemId: request.itemId, decision: request.decision });
      } catch (error) {
        if (error instanceof InvalidMemorySharingRequestError) {
          respondInvalid(respond, error);
        } else if (error instanceof ForbiddenMemorySharingRequestError) {
          respondForbidden(respond, error);
        } else {
          respondUnavailable(respond);
        }
      }
    },
    { scope: "operator.admin" },
  );

  api.registerGatewayMethod(
    MEMORY_SHARING_GATEWAY_METHODS.postboxPurge,
    async ({ params, client, respond }) => {
      try {
        const request = readPostboxItemIdRequest(params);
        const operatorPrincipalId = resolveGatewayPrincipal(client);
        const { reviewBuiltinMemoryPostboxItem } = await loadSharing();
        reviewBuiltinMemoryPostboxItem({ ...request, operatorPrincipalId, decision: "purge" });
        respond(true, { itemId: request.itemId, state: "purged" });
      } catch (error) {
        if (error instanceof InvalidMemorySharingRequestError) {
          respondInvalid(respond, error);
        } else if (error instanceof ForbiddenMemorySharingRequestError) {
          respondForbidden(respond, error);
        } else {
          respondUnavailable(respond);
        }
      }
    },
    { scope: "operator.admin" },
  );
}
