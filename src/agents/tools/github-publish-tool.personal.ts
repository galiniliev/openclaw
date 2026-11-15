import type {
  SessionGitHubOptionsResult,
  SessionGitHubStatusResult,
  SessionGitHubPublicationResult,
  SessionGitHubPublishParams,
} from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { jsonResult } from "./common.js";
import { callInProcessGatewayTool as callGateway } from "./in-process-gateway.js";

type PublicationControlInput = {
  publisher?: "shared" | "personal";
  publishingSessionKey?: string;
  requestId?: string;
  workspacePath?: string;
};
type PublicationCaller = { sessionKey: string; agentId?: string };

/** Receipt observation and confirmation reuse the host's immutable publication intent. */
export async function executePersonalPublicationControl(
  action: "status" | "confirm" | "readiness",
  input: PublicationControlInput,
  caller: PublicationCaller,
) {
  if (action === "readiness") {
    if (Object.keys(input).some((key) => !["action", "publisher"].includes(key))) {
      throw new Error(
        "Personal readiness checks this requesting human's current session; use status for a receipt.",
      );
    }
    const options = await callGateway<SessionGitHubOptionsResult>("sessions.github.options", {
      sessionKey: caller.sessionKey,
      agentId: caller.agentId,
    });
    return jsonResult({ personal: options.personal, pendingPersonal: options.pendingPersonal });
  }
  if (
    !input.requestId ||
    Object.keys(input).some((key) => !["action", "publisher", "requestId"].includes(key))
  ) {
    throw new Error(
      "status requires the original requestId and accepts no new publication intent.",
    );
  }
  const params = {
    sessionKey: caller.sessionKey,
    agentId: caller.agentId,
    requestId: input.requestId,
  };
  const observed = await callGateway<SessionGitHubStatusResult>("sessions.github.status", params);
  if (action === "confirm") {
    if (input.publisher !== "personal") {
      throw new Error("Confirm requires the explicit personal publisher and original requestId.");
    }
    if (observed.confirmation) {
      return jsonResult(
        await callGateway<SessionGitHubPublicationResult>("sessions.github.confirm", {
          ...params,
          generation: observed.confirmation.generation,
          account: observed.confirmation.account,
          requestDigest: observed.confirmation.requestDigest,
        }),
      );
    }
  }
  return jsonResult(observed);
}

/** The model selects personal mode; only the host selects the saved account. */
export async function selectPersonalPublicationAccount(
  publication: SessionGitHubPublishParams,
  input: PublicationControlInput,
  agentId: string | undefined,
): Promise<Extract<NonNullable<SessionGitHubPublishParams["selection"]>, { source: "personal" }>> {
  if (input.requestId || input.publishingSessionKey) {
    throw new Error(
      "Use status with the original requestId; publish as me creates intent only for this session.",
    );
  }
  if (input.workspacePath !== undefined) {
    throw new Error(
      "Publish as me requires the session's prepared workspace; no shared fallback is allowed.",
    );
  }
  const options = await callGateway<SessionGitHubOptionsResult>("sessions.github.options", {
    sessionKey: publication.sessionKey,
    agentId,
    idempotencyKey: publication.idempotencyKey,
  });
  const personal = options.personal;
  if (
    personal?.state !== "connected" ||
    personal.stale ||
    !personal.generation ||
    !personal.account ||
    (personal.accessExpiresAtMs !== null &&
      personal.accessExpiresAtMs !== undefined &&
      personal.accessExpiresAtMs <= Date.now())
  ) {
    throw new Error(
      "Reconnect your personal GitHub account, then retry publish as me; no shared publication was requested.",
    );
  }
  return { source: "personal", generation: personal.generation, account: personal.account };
}
