import {
  readSessionTranscriptSummaryAsync,
  type SessionTranscriptReadScope,
} from "../../gateway/session-transcript-readers.js";

export async function readMainSessionRecoveryCheckpoint(
  scope: SessionTranscriptReadScope,
  verifiedToolCallId?: string,
  expectedSourceTurnId?: string,
) {
  const { checkpoint } = await readSessionTranscriptSummaryAsync(scope, {
    kind: "recovery-checkpoint",
    verifiedToolCallId,
    expectedSourceTurnId,
  });
  return checkpoint;
}
