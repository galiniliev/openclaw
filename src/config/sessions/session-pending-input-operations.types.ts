import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import type {
  AcceptedGoalRecoveryInput,
  GoalRecoveryInputAdmission,
  SessionGoalOperationResult,
  SessionTranscriptTurnMutationResult,
} from "./goals-operations.types.js";
import type { TurnRecoveryIntent } from "./main-session-recovery.types.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type {
  SessionPendingInputRow,
  readSessionInputCompletion,
} from "./session-accessor.sqlite-pending-inputs.js";
import type { InternalSessionEntry } from "./types.js";

type PendingInputIdentity = {
  sessionKey: string;
  sessionId: string;
  idempotencyKey: string;
};

export type PendingInputRead =
  | PendingInputStageRead
  | PendingInputSourceRead
  | PendingInputQueueRead;

type PendingInputQueueRead = {
  kind: "queue";
  sessionKey: string;
  sessionId: string;
  runId?: string;
  afterSeq?: number;
  throughSeq?: number;
};

export type PendingInputQueueCandidate = Pick<
  SessionPendingInputRow,
  | "seq"
  | "input_id"
  | "session_key"
  | "session_id"
  | "idempotency_key"
  | "run_id"
  | "lifecycle_generation"
  | "state"
> & {
  rowFingerprint: string;
  ownerDeviceId?: string;
};

export type PendingInputQueueSnapshot = {
  kind: "queue";
  current: boolean;
  entry?: InternalSessionEntry;
  rows: PendingInputQueueCandidate[];
  row?: PendingInputQueueCandidate;
  throughSeq: number;
  nextAfterSeq?: number;
};

type PendingInputStageRead = PendingInputIdentity & {
  kind: "stage";
  trackCompletion: boolean;
  goalOperation?: GoalRecoveryInputAdmission["operation"];
};

export type PendingInputSourceRead = PendingInputIdentity & {
  kind: "source";
  pendingOnly: boolean;
};

export type PendingInputSourceSnapshot = {
  kind: "source";
  current: boolean;
  pending?: SessionPendingInputRow;
  committed?: PersistedUserTurnMessage;
};

export type PendingInputSnapshot = {
  kind: "stage";
  current: boolean;
  entry?: InternalSessionEntry;
  goalReceipt?: SessionGoalOperationResult;
  existing?: SessionPendingInputRow;
  previous?: ReturnType<typeof readSessionInputCompletion>;
  committed?: { messageId: string; message: PersistedUserTurnMessage };
};

type PendingInputSettlementIdentity = PendingInputIdentity & {
  runId: string;
  requestHash: string;
  lifecycleGeneration: string;
};

type PendingInputRowMutation =
  | (PendingInputSettlementIdentity & {
      kind: "stage";
      expected: PendingInputSnapshot;
      trackCompletion: boolean;
      inputId: string;
      messageJson: string;
      turnIntent?: TurnRecoveryIntent;
      goalRecovery?: AcceptedGoalRecoveryInput;
    })
  | (PendingInputSettlementIdentity & {
      kind: "complete";
      outcome: AgentRunTerminalOutcome;
    })
  | (PendingInputSettlementIdentity & {
      kind: "finish";
      inputId: string;
      disposition: "cancelled" | "interrupted";
    });

export type PendingInputQueueMutation = {
  sessionKey: string;
  sessionId: string;
  lifecycleGeneration: string;
  expectedEntry: InternalSessionEntry;
  idempotencyKey?: never;
  runId?: never;
  requestHash?: never;
} & ({ kind: "promote" } | { kind: "cancel-queued"; row: PendingInputQueueCandidate });

export type PendingInputMutation = PendingInputRowMutation | PendingInputQueueMutation;

export type PendingInputMutationReceipt = {
  kind: "pending-input-settlement";
  operation: PendingInputMutation["kind"];
  sessionKey: string;
  sessionId: string;
  lifecycleGeneration: string;
  outcome?: AgentRunTerminalOutcome;
  goalOperation?: SessionTranscriptTurnMutationResult;
  publication?: SessionEntryReplacementPublication;
} & (
  | {
      operation: PendingInputRowMutation["kind"];
      idempotencyKey: string;
      runId: string;
      requestHash: string;
    }
  | {
      operation: PendingInputQueueMutation["kind"];
      idempotencyKey?: never;
      runId?: never;
      requestHash?: never;
      changed: boolean;
      entry?: InternalSessionEntry;
    }
);

export type PendingInputCustodyGrant = {
  kind: "pending-input-settlement-custody";
  candidate?: SessionPendingInputRow;
  receipt: PendingInputMutationReceipt;
};
