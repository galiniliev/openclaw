import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import type { SessionEntry } from "../config/sessions.js";
import { prepareInitialAssistantTranscript } from "../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import { createSessionTranscriptHeader } from "../config/sessions/transcript-header.js";
import {
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
  isAgentHarnessSessionKeyOwnedBy,
} from "../sessions/agent-harness-session-key.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";
import { invalidSessionRequest, unavailableSessionRequest } from "./session-request-error.js";

/** Reject reserved harness targets before preparation and again at commit. */
export function validateSessionCreateTarget(
  key: string | undefined,
  entry: Pick<SessionEntry, "modelSelectionLocked"> | undefined,
  authorizedHarnessCreation: boolean,
  requestedSessionId?: string,
) {
  if (requestedSessionId !== undefined && entry) {
    return invalidSessionRequest("Requested session ID requires a new session key.");
  }
  if (
    key &&
    isAgentHarnessSessionKey(key) &&
    !authorizedHarnessCreation &&
    (!entry || entry.modelSelectionLocked === true)
  ) {
    return invalidSessionRequest(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
  }
  return undefined;
}

type FreshSessionConstraints = {
  params: Pick<
    CreateGatewaySessionParams,
    | "initialEntry"
    | "initialCatalogContinuation"
    | "initialAssistantMessage"
    | "fork"
    | "atomicInitialization"
    | "deferInitialization"
    | "deviceFolder"
    | "catalogTarget"
  >;
  existingEntry: Pick<SessionEntry, "initializationPending" | "deviceFolder"> | undefined;
  sessionKey: string;
  hasWorkspacePreparation: boolean;
  hasSpawnToolPolicy: boolean;
};

/** Validate creation-only state before an existing session can be adopted. */
export function validateFreshSessionConstraints(input: FreshSessionConstraints) {
  const { params, existingEntry } = input;
  if (!params.initialEntry && existingEntry?.initializationPending === true) {
    return unavailableSessionRequest(
      `Session ${input.sessionKey} is still initializing; retry creation later.`,
    );
  }
  if (
    params.initialAssistantMessage &&
    (existingEntry !== undefined ||
      params.fork === true ||
      params.atomicInitialization === true ||
      params.deferInitialization === true ||
      params.initialEntry?.initializationPending === true)
  ) {
    return invalidSessionRequest(
      "initial assistant transcript requires a new session without fork or deferred initialization",
    );
  }
  if (
    (params.initialEntry || params.initialCatalogContinuation || params.deferInitialization) &&
    existingEntry !== undefined
  ) {
    return invalidSessionRequest("trusted initial session state requires a new session");
  }
  if (
    params.deviceFolder &&
    existingEntry !== undefined &&
    (existingEntry.deviceFolder?.deviceId !== params.deviceFolder.deviceId ||
      existingEntry.deviceFolder.path !== params.deviceFolder.path)
  ) {
    return invalidSessionRequest("device folder requires a new session or its original folder");
  }
  if (params.catalogTarget && existingEntry !== undefined) {
    return invalidSessionRequest("catalog session target requires a new session");
  }
  if (input.hasWorkspacePreparation && existingEntry !== undefined) {
    return invalidSessionRequest("workspace preparation requires a new session");
  }
  if (input.hasSpawnToolPolicy && existingEntry !== undefined) {
    return invalidSessionRequest("spawn tool policy requires a new session");
  }
  return undefined;
}

/** Creation-owned transcript bytes commit with the row, including a requested identity's header. */
export function withInitialAssistantTranscript<T extends object>(
  result: T,
  entry: SessionEntry,
  message: CreateGatewaySessionParams["initialAssistantMessage"],
  cwd: string | undefined,
  initializeTranscript = false,
) {
  const transcriptEvents = message
    ? prepareInitialAssistantTranscript({ ...message, sessionId: entry.sessionId, cwd })
    : initializeTranscript
      ? [createSessionTranscriptHeader({ sessionId: entry.sessionId, cwd })]
      : undefined;
  return {
    ...result,
    entry,
    ...(transcriptEvents ? { transcriptEvents } : {}),
  };
}

/** Trusted initial state must come from the owner of its reserved session namespace. */
export function resolveSessionCreateTrustedOwners(
  params: CreateGatewaySessionParams,
  explicitTargetKey: string | undefined,
) {
  const authorizedHarnessCreation = Boolean(
    explicitTargetKey &&
    params.initialEntry &&
    normalizeOptionalAgentRuntimeId(params.authorizedAgentHarnessId) ===
      normalizeOptionalAgentRuntimeId(params.initialEntry.agentHarnessId) &&
    isAgentHarnessSessionKeyOwnedBy(explicitTargetKey, params.authorizedAgentHarnessId),
  );
  const authorizedPluginCreation = Boolean(
    explicitTargetKey &&
    params.initialEntry?.pluginOwnerId &&
    params.authorizedPluginId === params.initialEntry.pluginOwnerId,
  );
  return { authorizedHarnessCreation, authorizedPluginCreation };
}
