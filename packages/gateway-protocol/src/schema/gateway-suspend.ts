import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
// Gateway Protocol schemas for cooperative host suspension.
import { stringLiteralUnion } from "./string-literal-union.js";

const SuspensionTokenSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" });
const CountSchema = Type.Integer({ minimum: 0 });

/** Recorded lifecycle sections; absence on older residents means unknown custody. */
const GatewayWriteCustodySchema = Type.Array(
  closedObject({
    phase: Type.String({ minLength: 1 }),
    count: CountSchema,
  }),
);
export type GatewayWriteCustody = Static<typeof GatewayWriteCustodySchema>;

/** Public admission state only; never includes the controller's suspension token. */
export const GatewaySuspensionSchema = closedObject({
  phase: stringLiteralUnion(["accepting", "preparing", "draining", "prepared"]),
});
export type GatewaySuspension = Static<typeof GatewaySuspensionSchema>;

export const GatewaySuspendBlockerSchema = closedObject({
  kind: stringLiteralUnion([
    "queue",
    "reply",
    "embedded-run",
    "background-exec",
    "cron-run",
    "agent-run",
    "acp-run",
    "media-generation",
    "root-request",
    "session-admission",
    "session-mutation",
    "chat-run",
    "queued-turn",
    "terminal-persistence",
    "terminal-session",
  ]),
  count: CountSchema,
  message: Type.String(),
});

export const GatewaySuspendPrepareParamsSchema = closedObject({
  requestId: SuspensionTokenSchema,
  terminalPolicy: Type.Optional(stringLiteralUnion(["preserve", "terminate"])),
  drain: Type.Optional(Type.Boolean()),
  rollingReleaseId: Type.Optional(SuspensionTokenSchema),
});

export const GatewaySuspendPrepareBusyResultSchema = closedObject({
  status: Type.Literal("busy"),
  reason: stringLiteralUnion(["active-work", "gateway-draining"]),
  retryAfterMs: CountSchema,
  activeCount: CountSchema,
  blockers: Type.Array(GatewaySuspendBlockerSchema),
  writeCustody: Type.Optional(GatewayWriteCustodySchema),
});

export const GatewaySuspendPrepareDrainingResultSchema = closedObject({
  status: Type.Literal("draining"),
  suspensionId: SuspensionTokenSchema,
  expiresAtMs: CountSchema,
  retryAfterMs: CountSchema,
  activeCount: CountSchema,
  blockers: Type.Array(GatewaySuspendBlockerSchema),
  writeCustody: Type.Optional(GatewayWriteCustodySchema),
});

export const GatewaySuspendPrepareReadyResultSchema = closedObject({
  status: Type.Literal("ready"),
  suspensionId: SuspensionTokenSchema,
  expiresAtMs: CountSchema,
  activeCount: CountSchema,
  blockers: Type.Array(GatewaySuspendBlockerSchema),
  writeCustody: Type.Optional(GatewayWriteCustodySchema),
});

export const GatewaySuspendPrepareResultSchema = Type.Union([
  GatewaySuspendPrepareBusyResultSchema,
  GatewaySuspendPrepareDrainingResultSchema,
  GatewaySuspendPrepareReadyResultSchema,
]);

export const GatewaySuspendStatusParamsSchema = closedObject({
  suspensionId: SuspensionTokenSchema,
  includeLifecycle: Type.Optional(Type.Boolean()),
});

const GatewaySuspendResumeObservationSchema = closedObject({
  suspensionId: SuspensionTokenSchema,
  ownerId: SuspensionTokenSchema,
  executionYielded: Type.Boolean(),
  schedulingResumed: Type.Boolean(),
  admissionReopened: Type.Boolean(),
  reason: stringLiteralUnion(["resume", "expired"]),
  observedAtMs: CountSchema,
});

export const GatewaySuspendStatusRunningResultSchema = closedObject({
  status: Type.Literal("running"),
  resumeObservationVersion: Type.Optional(Type.Literal(1)),
  resumeObservation: Type.Optional(GatewaySuspendResumeObservationSchema),
});

export const GatewaySuspendStatusDrainingResultSchema = closedObject({
  resumeObservationVersion: Type.Optional(Type.Literal(1)),
  executionYielded: Type.Optional(Type.Boolean()),
  status: Type.Literal("draining"),
  ownerId: Type.Optional(SuspensionTokenSchema),
  phase: Type.Optional(stringLiteralUnion(["draining", "interrupting", "exiting"])),
  expiresAtMs: CountSchema,
  retryAfterMs: CountSchema,
  activeCount: CountSchema,
  blockers: Type.Array(GatewaySuspendBlockerSchema),
  writeCustody: Type.Optional(GatewayWriteCustodySchema),
});

export const GatewaySuspendStatusReadyResultSchema = closedObject({
  resumeObservationVersion: Type.Optional(Type.Literal(1)),
  executionYielded: Type.Optional(Type.Boolean()),
  status: Type.Literal("ready"),
  ownerId: Type.Optional(SuspensionTokenSchema),
  expiresAtMs: CountSchema,
  writeCustody: Type.Optional(GatewayWriteCustodySchema),
});

export const GatewaySuspendStatusResultSchema = Type.Union([
  GatewaySuspendStatusRunningResultSchema,
  GatewaySuspendStatusDrainingResultSchema,
  GatewaySuspendStatusReadyResultSchema,
]);

export const GatewaySuspendResumeParamsSchema = closedObject({
  suspensionId: SuspensionTokenSchema,
});

export const GatewaySuspendResumeResultSchema = closedObject({
  ok: Type.Literal(true),
  status: Type.Literal("running"),
  resumed: Type.Boolean(),
});

const GatewaySuspendExecutionContractSchema = closedObject({
  version: Type.Literal(1),
  releaseId: SuspensionTokenSchema,
  predecessorBootId: SuspensionTokenSchema,
  candidateBootId: SuspensionTokenSchema,
  predecessorOwner: SuspensionTokenSchema,
  compatibilityDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  companionGeneration: SuspensionTokenSchema,
  expiresAtMs: Type.Integer({ minimum: 1 }),
});

/** Arms cleanup, or commits the exact host's shutdown before external native stop. */
export const GatewaySuspendHandoffParamsSchema = closedObject({
  suspensionId: SuspensionTokenSchema,
  commit: Type.Optional(Type.Literal(true)),
  yieldExecution: Type.Optional(GatewaySuspendExecutionContractSchema),
  inspectExecution: Type.Optional(Type.Literal(true)),
  rebindExecution: Type.Optional(
    closedObject({
      previous: GatewaySuspendExecutionContractSchema,
      candidateBootId: SuspensionTokenSchema,
      expectedOwner: SuspensionTokenSchema,
    }),
  ),
  target: closedObject({
    pid: Type.Integer({ minimum: 1 }),
    processInstanceId: SuspensionTokenSchema,
  }),
});

export const GatewaySuspendHandoffResultSchema = closedObject({
  status: stringLiteralUnion([
    "armed",
    "committed",
    "execution-yielded",
    "execution-observed",
    "execution-rebound",
  ]),
  suspensionId: SuspensionTokenSchema,
  expiresAtMs: CountSchema,
  execution: Type.Optional(
    closedObject({
      owner: SuspensionTokenSchema,
      contract: GatewaySuspendExecutionContractSchema,
      returnedToOwner: Type.Optional(SuspensionTokenSchema),
    }),
  ),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type GatewaySuspendBlocker = Static<typeof GatewaySuspendBlockerSchema>;
export type GatewaySuspendPrepareParams = Static<typeof GatewaySuspendPrepareParamsSchema>;
export type GatewaySuspendPrepareResult = Static<typeof GatewaySuspendPrepareResultSchema>;
export type GatewaySuspendStatusParams = Static<typeof GatewaySuspendStatusParamsSchema>;
export type GatewaySuspendStatusResult = Static<typeof GatewaySuspendStatusResultSchema>;
export type GatewaySuspendResumeParams = Static<typeof GatewaySuspendResumeParamsSchema>;
export type GatewaySuspendResumeResult = Static<typeof GatewaySuspendResumeResultSchema>;
export type GatewaySuspendHandoffParams = Static<typeof GatewaySuspendHandoffParamsSchema>;
export type GatewaySuspendHandoffResult = Static<typeof GatewaySuspendHandoffResultSchema>;
