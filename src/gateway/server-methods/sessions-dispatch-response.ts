import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { getGitHubIdentityErrorOrigin } from "../../agents/github-read-identity.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { DEVICE_WORKER_PROVIDER_ID } from "../worker-environments/device-provider-identity.js";
import {
  projectWorkerSessionPlacement,
  readWorkerPlacementIdentity,
} from "../worker-environments/placement-projector.js";
import { isWorkerDispatchInputError } from "./sessions-shared.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

export function respondWorkerRecoveryRequired(
  placement: Parameters<typeof readWorkerPlacementIdentity>[0],
  context: GatewayRequestContext,
  respond: RespondFn,
): void {
  let providerId: string | undefined;
  try {
    providerId = readWorkerPlacementIdentity(
      placement,
      context.workerEnvironmentService,
    )?.providerId;
  } catch {
    // Missing inventory proof must retain the refusal even when its label is unknown.
  }
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      providerId === DEVICE_WORKER_PROVIDER_ID
        ? "device worker placement must be abandoned before redispatch; use Continue on Gateway"
        : "cloud worker environment must be stopped before redispatch; use Stop cloud worker",
    ),
  );
}

export function respondWorkerPlacement(params: {
  respond: RespondFn;
  key: string;
  sessionId: string;
  context: GatewayRequestContext;
  placement: Parameters<typeof projectWorkerSessionPlacement>[0];
}): void {
  params.respond(
    true,
    {
      ok: true,
      key: params.key,
      sessionId: params.sessionId,
      placement: projectWorkerSessionPlacement(
        params.placement,
        params.context.workerPlacementDiskSpaceReader?.read(params.placement),
        // Canonical fenced runner reader; a node lost after durable provision
        // must project offline here exactly as sessions.list would.
        params.context.workerPlacementRunnerAvailabilityReader?.read(params.placement),
        readWorkerPlacementIdentity(params.placement, params.context.workerEnvironmentService),
      ),
    },
    undefined,
  );
}

export function respondWorkerDispatchError(error: unknown, respond: RespondFn): void {
  if (error instanceof SessionMutationAuthorizationChangedError) {
    throw error;
  }
  const origin = getGitHubIdentityErrorOrigin(error);
  respond(
    false,
    undefined,
    errorShape(
      isWorkerDispatchInputError(error) ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
      formatErrorMessage(error),
    ),
    origin ? { githubIdentityOrigin: origin } : undefined,
  );
}
