/** Shared export-command parsing and target session resolution helpers. */
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isMemoryIsolationCutoverAgent } from "../../plugins/memory-cutover.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { escapeRegExp } from "../../shared/regexp.js";
import type { ReplyPayload } from "../types.js";
import type { HandleCommandsParams } from "./commands-types.js";

/** Resolved session entry and scoped transcript identity targeted by an export command. */
interface ExportCommandSessionTarget {
  agentId: string;
  entry: SessionEntry;
  sessionId: string;
  sessionFile: string;
  sessionKey: string;
  storePath: string;
}

const MAX_EXPORT_COMMAND_OUTPUT_PATH_CHARS = 512;
const LEGACY_TRANSCRIPT_EXPORT_CUTOVER_DENIAL =
  "❌ Transcript export is unavailable after scoped-memory cutover. Scoped transcript export with lineage is not available yet.";

export type TranscriptExportCutoverStatus =
  | Readonly<{ kind: "legacy"; targetAgentId: string }>
  | Readonly<{ kind: "scoped"; targetAgentId: string }>
  | Readonly<{ kind: "denied"; reply: ReplyPayload }>;

/** Resolve the transcript owner before either legacy or scoped export reads session state. */
export function resolveTranscriptExportCutoverStatus(
  params: Pick<HandleCommandsParams, "agentId" | "sessionKey">,
): TranscriptExportCutoverStatus {
  const commandAgentId = params.agentId?.trim();
  let targetAgentId: string;
  try {
    targetAgentId = resolveAgentIdFromSessionKey(params.sessionKey, commandAgentId);
  } catch {
    return {
      kind: "denied",
      reply: {
        text: "❌ Transcript export is unavailable because OpenClaw could not resolve the session agent.",
      },
    };
  }
  // The session target selects transcript content, while command execution can carry a
  // separately resolved agent. A mismatch must not use either cutover identity as a bypass.
  const agentIds = commandAgentId ? [targetAgentId, commandAgentId] : [targetAgentId];
  if (!agentIds.some(isMemoryIsolationCutoverAgent)) {
    return { kind: "legacy", targetAgentId };
  }
  // The new host can bind only the same agent's current session and principal
  // evidence. Retain fail-closed denial for a mismatched command/runtime agent.
  return commandAgentId && commandAgentId !== targetAgentId
    ? { kind: "denied", reply: { text: LEGACY_TRANSCRIPT_EXPORT_CUTOVER_DENIAL } }
    : { kind: "scoped", targetAgentId };
}

/**
 * Raw transcript exports cannot preserve the scoped policy and lineage contract.
 * Keep both command surfaces closed until the selected memory runtime owns that export.
 */
export function rejectLegacyTranscriptExportAfterMemoryCutover(
  params: Pick<HandleCommandsParams, "agentId" | "sessionKey">,
): ReplyPayload | undefined {
  const status = resolveTranscriptExportCutoverStatus(params);
  if (status.kind === "denied") {
    return status.reply;
  }
  return status.kind === "scoped" ? { text: LEGACY_TRANSCRIPT_EXPORT_CUTOVER_DENIAL } : undefined;
}

/** Parses an optional non-flag output path from export command text. */
export function parseExportCommandOutputPath(
  commandBodyNormalized: string,
  aliases: readonly string[],
): { outputPath?: string; error?: string } {
  const normalized = commandBodyNormalized.trim();
  if (aliases.some((alias) => normalized === `/${alias}`)) {
    return {};
  }
  const aliasPattern = aliases.map(escapeRegExp).join("|");
  const args = normalized.replace(new RegExp(`^/(${aliasPattern})\\s*`), "").trim();
  const outputPath = args.split(/\s+/).find((part) => !part.startsWith("-"));
  if (outputPath && outputPath.length > MAX_EXPORT_COMMAND_OUTPUT_PATH_CHARS) {
    return {
      error: `❌ Output path is too long. Keep it at ${MAX_EXPORT_COMMAND_OUTPUT_PATH_CHARS} characters or less.`,
    };
  }
  return { outputPath };
}

/** Resolves the session store entry and transcript file for an export command. */
export function resolveExportCommandSessionTarget(
  params: HandleCommandsParams,
): ExportCommandSessionTarget | ReplyPayload {
  const targetAgentId = resolveAgentIdFromSessionKey(params.sessionKey) || params.agentId;
  if (!targetAgentId) {
    return { text: `❌ Failed to resolve agent for session: ${params.sessionKey}` };
  }
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(targetAgentId);
  const entry = loadSessionEntryReadOnly({
    storePath,
    sessionKey: params.sessionKey,
    clone: false,
  });
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    return { text: `❌ Session not found: ${params.sessionKey}` };
  }

  try {
    const sessionFile = resolveSessionFilePath(
      sessionId,
      entry,
      resolveSessionFilePathOptions({ agentId: targetAgentId, storePath }),
    );
    return {
      agentId: targetAgentId,
      entry,
      sessionFile,
      sessionId,
      sessionKey: params.sessionKey,
      storePath,
    };
  } catch (err) {
    return {
      text: `❌ Failed to resolve session file: ${formatErrorMessage(err)}`,
    };
  }
}

/** Distinguishes command error replies from successful export session targets. */
export function isReplyPayload(
  value: ExportCommandSessionTarget | ReplyPayload,
): value is ReplyPayload {
  return "text" in value;
}
