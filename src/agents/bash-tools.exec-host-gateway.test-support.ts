import crypto from "node:crypto";
import { afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import type {
  ExecAllowlistEntry,
  ExecApprovalsDefaults,
  ExecApprovalsFile,
  ExecAsk,
  ExecCommandSegment,
  ExecSecurity,
  ExecSegmentSatisfiedBy,
} from "../infra/exec-approvals.js";
import {
  planShellAuthorization,
  type ExecAuthorizationPlan,
} from "../infra/exec-authorization-plan.js";
import { buildAuthorizedShellCommandFromPlan } from "../infra/exec-authorization-render.js";
import { resolvePolicyTargetCandidatePath } from "../infra/exec-command-resolution.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import type { ProcessSupervisor } from "../process/supervisor/types.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import type { ExecApprovalFollowupOutcome } from "./bash-tools.exec-types.js";
type SendExecApprovalFollowupResult =
  typeof import("./bash-tools.exec-host-shared.js").sendExecApprovalFollowupResult;
type ExecAutoReviewer = typeof import("../infra/exec-auto-review.js").defaultExecAutoReviewer;
type MockAllowlistSegment = Omit<ExecCommandSegment, "raw"> & { raw?: string };
type MockAllowlistResult = {
  allowlistMatches: unknown[];
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  segments: MockAllowlistSegment[];
  segmentAllowlistEntries: unknown[];
  segmentSatisfiedBy?: ExecSegmentSatisfiedBy[];
  authorizationPlan?: ExecAuthorizationPlan;
};
type MockExecHostApprovalContext = {
  approvals: {
    allowlist: ExecAllowlistEntry[];
    file: ExecApprovalsFile;
    agent?: Required<ExecApprovalsDefaults>;
  };
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  askFallback?: ExecSecurity;
};

const INLINE_EVAL_HIT = {
  executable: "python3",
  normalizedExecutable: "python3",
  flag: "-c",
  argv: ["python3", "-c", "print(1)"],
};

function exactCommandMarker(command: string): string {
  return `=command:${crypto.createHash("sha256").update(command.trim()).digest("hex").slice(0, 16)}`;
}

const pendingResultMock = vi.hoisted(() => vi.fn());
const allowlistMock = vi.hoisted(() => vi.fn<() => MockAllowlistResult>());
const durableApprovalMock = vi.hoisted(() => vi.fn(() => true));
const exactApprovalMock = vi.hoisted(() => vi.fn(() => false));
const requiresApprovalMock = vi.hoisted(() => vi.fn(() => false));
const enforcedCommandMock = vi.hoisted(() =>
  vi.fn<() => { ok: boolean; reason?: string; command?: string }>(),
);
const reviewerMock = vi.hoisted(() => vi.fn<ExecAutoReviewer>());
const commitAuthorizationMock = vi.hoisted(() =>
  vi.fn<typeof import("../infra/exec-approvals.js").commitExecAuthorizationLocked>(
    async () => () => {},
  ),
);
const approvalDecisionMock = vi.hoisted(() =>
  vi.fn<() => Promise<string | null | undefined>>(async () => undefined),
);
const runAbortedApprovalError = vi.hoisted(() => new Error("run aborted"));
const approvalRouteFixture = vi.hoisted(() => ({ inline: false, id: "" }));
const gatewayMock = vi.hoisted(() =>
  vi.fn(async (method: string, _options: unknown, params: { id: string }) => {
    if (method === "exec.approval.request") {
      approvalRouteFixture.id = params.id;
      return approvalRouteFixture.inline ? { decision: null } : { status: "accepted" };
    }
    if (method !== "exec.approval.waitDecision") {
      throw new Error(`Unexpected gateway method: ${method}`);
    }
    try {
      const decision = await approvalDecisionMock();
      if (decision === undefined) {
        throw new Error("approval request failed");
      }
      return { decision };
    } catch (error) {
      if (error === runAbortedApprovalError) {
        return { terminalReason: "run-aborted" };
      }
      throw error;
    }
  }),
);
const hostPolicyMock = vi.hoisted(() => vi.fn<() => MockExecHostApprovalContext>());
const runExecProcessMock = vi.hoisted(() => vi.fn());
const startupCancellationMocks = vi.hoisted(() => ({
  spawn: vi.fn<ProcessSupervisor["spawn"]>(),
  prepare: vi.fn<() => void>(),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: startupCancellationMocks.spawn }),
}));

vi.mock("./shell-snapshot.js", () => ({
  maybeWrapCommandWithShellSnapshot: async (input: { command: string }) => {
    startupCancellationMocks.prepare();
    return input.command;
  },
}));

const markBackgroundedMock = vi.hoisted(() => vi.fn());
const followupMock = vi.hoisted(() => vi.fn<SendExecApprovalFollowupResult>(async () => undefined));
const approvalRouteMock = vi.hoisted(() =>
  vi.fn<typeof import("./bash-tools.exec-host-shared.js").createExecApprovalRequestRoute>(),
);
const inlineEvalMock = vi.hoisted(() => vi.fn<() => typeof INLINE_EVAL_HIT | null>());

vi.mock("../infra/exec-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-approvals.js")>()),
  evaluateShellAllowlistWithAuthorization: allowlistMock,
  hasDurableExecApproval: durableApprovalMock,
  hasExactCommandDurableExecApproval: exactApprovalMock,
  buildEnforcedShellCommand: enforcedCommandMock,
  requiresExecApproval: requiresApprovalMock,
  commitExecAuthorizationLocked: commitAuthorizationMock,
  resolveApprovalAuditTrustPath: vi.fn(() => null),
  resolveAllowAlwaysPatterns: vi.fn(() => []),
}));

vi.mock("../infra/exec-auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-auto-review.js")>()),
  defaultExecAutoReviewer: reviewerMock,
}));

// mock-isolation: Keep Gateway transport and credential loading inert while testing local approval ownership.
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: gatewayMock,
  readGatewayCallOptions: vi.fn(() => ({})),
}));

vi.mock("./bash-tools.exec-host-shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bash-tools.exec-host-shared.js")>();
  approvalRouteMock.mockImplementation(actual.createExecApprovalRequestRoute);
  return {
    ...actual,
    resolveExecHostApprovalContext: hostPolicyMock,
    buildExecApprovalPendingToolResult: pendingResultMock,
    createExecApprovalRequestRoute: approvalRouteMock,
    sendExecApprovalFollowupResult: followupMock,
  };
});

vi.mock("./bash-tools.exec-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-runtime.js")>()),
  createApprovalSlug: vi.fn(() => "slug"),
  runExecProcess: runExecProcessMock,
}));

vi.mock("./bash-process-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-process-registry.js")>()),
  getActiveBackgroundExecSessionCount: vi.fn(() => 0),
  markBackgrounded: markBackgroundedMock,
  tail: vi.fn((value) => value),
}));

vi.mock("../infra/command-analysis/inline-eval.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/command-analysis/inline-eval.js")>()),
  describeInterpreterInlineEval: vi.fn(() => "python -c"),
  detectInterpreterInlineEvalArgv: inlineEvalMock,
}));

let processGatewayAllowlist: typeof import("./bash-tools.exec-host-gateway.js").processGatewayAllowlist;
type GatewayAllowlistParams = Parameters<typeof processGatewayAllowlist>[0];
type GatewayResult = Awaited<ReturnType<typeof processGatewayAllowlist>>;

const expectCall = (mock: unknown, fields: object) =>
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));

function expectAuthorization(fields: object) {
  expectCall(commitAuthorizationMock, {
    authorization: expect.objectContaining(fields),
  });
}

const expectPending = (result: GatewayResult) =>
  expect(result.pendingResult?.details.status).toBe("approval-pending");

const completedOutcome = (aggregated = "done"): ExecApprovalFollowupOutcome => ({
  status: "completed",
  exitCode: 0,
  timedOut: false,
  aggregated,
});

const requireSentFollowupText = (callIndex = 0): string =>
  followupMock.mock.calls[callIndex]?.[1] ?? "";

beforeAll(async () => {
  ({ processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js"));
});

beforeEach(() => {
  resetGatewayWorkAdmission();
  resetDiagnosticEventsForTest();
  pendingResultMock.mockReset();
  allowlistMock.mockReset();
  mockAllowlist({
    allowlistSatisfied: true,
    segments: [{ resolution: null, argv: ["echo", "ok"] }],
    segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
    segmentSatisfiedBy: [],
  });
  durableApprovalMock.mockReset().mockReturnValue(true);
  exactApprovalMock.mockReset().mockReturnValue(false);
  requiresApprovalMock.mockReset().mockReturnValue(false);
  enforcedCommandMock.mockReset().mockReturnValue({
    ok: false,
    reason: "segment execution plan unavailable",
  });
  reviewerMock.mockReset().mockResolvedValue({
    decision: "allow-once",
    risk: "low",
    rationale: "allowed",
  });
  commitAuthorizationMock.mockReset();
  approvalDecisionMock.mockReset().mockResolvedValue(undefined);
  approvalRouteFixture.inline = false;
  gatewayMock.mockClear();
  approvalRouteFixture.id = "";
  hostPolicyMock.mockReset();
  mockHostPolicy();
  runExecProcessMock.mockReset();
  startupCancellationMocks.spawn.mockReset();
  startupCancellationMocks.prepare.mockReset();
  markBackgroundedMock.mockReset();
  followupMock.mockReset();
  inlineEvalMock.mockReset().mockReturnValue(null);
  pendingResultMock.mockReturnValue({
    details: { status: "approval-pending" },
    content: [],
  });
  approvalRouteMock.mockClear();
});

afterEach(() => {
  resetProcessRegistryForTests();
  resetGatewayWorkAdmission();
});

function mockHostPolicy(overrides: Partial<MockExecHostApprovalContext> = {}) {
  hostPolicyMock.mockReturnValue({
    approvals: { allowlist: [], file: { version: 1, agents: {} } },
    hostSecurity: "allowlist",
    hostAsk: "off",
    askFallback: "deny",
    ...overrides,
  });
}

function mockAllowlist(overrides: Partial<MockAllowlistResult> = {}) {
  allowlistMock.mockReturnValue({
    allowlistMatches: [],
    analysisOk: true,
    allowlistSatisfied: false,
    segments: [],
    segmentAllowlistEntries: [],
    ...overrides,
  });
}

function runGatewayAllowlist(
  overrides: Partial<GatewayAllowlistParams> & Pick<GatewayAllowlistParams, "command">,
) {
  return processGatewayAllowlist({
    workdir: process.cwd(),
    env: process.env as Record<string, string>,
    pty: false,
    defaultTimeoutSec: 30,
    security: "allowlist",
    ask: "off",
    safeBins: new Set(),
    safeBinProfiles: {},
    warnings: [],
    approvalRunningNoticeMs: 0,
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    ...overrides,
  });
}

function mockApprovedDetachedExec(outcome: ExecApprovalFollowupOutcome) {
  approvalDecisionMock.mockResolvedValueOnce("allow-once");
  mockCompletedProcess(outcome);
}

function mockCompletedProcess(outcome = completedOutcome(), sessionId = "sess-1") {
  runExecProcessMock.mockResolvedValue({
    session: { id: sessionId },
    promise: Promise.resolve(outcome),
  });
}

async function runDetached(overrides: Partial<GatewayAllowlistParams> = {}) {
  const result = await runGatewayAllowlist({
    command: "find . -maxdepth 1",
    turnSourceChannel: "webchat",
    approvalFollowupMode: "agent",
    ...overrides,
  });
  expectPending(result);
}

const waitForFollowup = () => vi.waitFor(() => expect(followupMock).toHaveBeenCalledOnce());

function mockExactTrust(command: string, entries: ExecAllowlistEntry[] = []) {
  durableApprovalMock.mockReturnValue(true);
  exactApprovalMock.mockReturnValue(true);
  mockHostPolicy({
    approvals: {
      allowlist: [...entries, { pattern: exactCommandMarker(command), source: "allow-always" }],
      file: { version: 1, agents: {} },
    },
  });
}

async function requireAuthorizationPlan(params: Parameters<typeof planShellAuthorization>[0]) {
  const authorizationPlan = await planShellAuthorization(params);
  if (!authorizationPlan.ok) {
    throw new Error(authorizationPlan.reason);
  }
  return authorizationPlan;
}

async function planAllowlistedNodeVersion() {
  const command = "node --version";
  const authorizationPlan = await requireAuthorizationPlan({ command, env: process.env });
  const segments = authorizationPlan.groups.flatMap((group) =>
    group.candidates.map((candidate) => candidate.sourceSegment),
  );
  const enforced = buildAuthorizedShellCommandFromPlan({
    plan: authorizationPlan,
    mode: "enforced",
    segmentSatisfiedBy: ["allowlist"],
  });
  if (!enforced.ok) {
    throw new Error(enforced.reason);
  }
  return { command, authorizationPlan, segments, enforcedCommand: enforced.command };
}

async function mockAllowlistTimeoutFallback(hostSecurity: ExecSecurity) {
  const { command, authorizationPlan, segments, enforcedCommand } =
    await planAllowlistedNodeVersion();
  const policyPath = resolvePolicyTargetCandidatePath(segments[0]?.resolution ?? null) ?? "node";
  requiresApprovalMock.mockReturnValue(true);
  enforcedCommandMock.mockReturnValue({ ok: true, command: enforcedCommand });
  mockAllowlist({
    allowlistMatches: [{ pattern: policyPath }],
    allowlistSatisfied: true,
    segments,
    segmentAllowlistEntries: [{ pattern: policyPath }],
    segmentSatisfiedBy: ["allowlist"],
    authorizationPlan,
  });
  mockHostPolicy({ hostSecurity, hostAsk: "always", askFallback: "allowlist" });
  return { command, enforcedCommand };
}

async function configurePlanBackedCommand(params: {
  command: string;
  env?: NodeJS.ProcessEnv;
  allowlistSatisfied?: boolean;
  allowlistMatches?: unknown[];
  requiresApproval?: boolean;
  satisfiedBy?: ExecSegmentSatisfiedBy;
  segmentSatisfiedBy?: ExecSegmentSatisfiedBy[];
  segmentAllowlistEntries?: unknown[];
  hostAsk?: "off" | "on-miss" | "always";
  askFallback?: "deny" | "allowlist" | "full";
}) {
  const authorizationPlan = await requireAuthorizationPlan({
    command: params.command,
    env: params.env ?? process.env,
  });
  const segments = authorizationPlan.groups.flatMap((group) =>
    group.candidates.map((entry) => entry.sourceSegment),
  );
  requiresApprovalMock.mockReturnValue(params.requiresApproval ?? true);
  mockAllowlist({
    allowlistSatisfied: params.allowlistSatisfied ?? false,
    allowlistMatches: params.allowlistMatches ?? [],
    segments,
    segmentAllowlistEntries: params.segmentAllowlistEntries ?? [],
    segmentSatisfiedBy: params.segmentSatisfiedBy ?? segments.map(() => params.satisfiedBy ?? null),
    authorizationPlan,
  });
  mockHostPolicy({
    hostAsk: params.hostAsk ?? "on-miss",
    askFallback: params.askFallback ?? "deny",
  });
  const [candidate] = authorizationPlan.groups.flatMap((group) => group.candidates);
  const resolvedPath =
    candidate?.sourceSegment.resolution?.execution.resolvedRealPath ??
    candidate?.sourceSegment.resolution?.execution.resolvedPath;
  const invocationPath =
    candidate?.sourceSegment.resolution?.execution.resolvedPath ?? resolvedPath;
  return { authorizationPlan, resolvedPath, invocationPath };
}

export {
  type ExecAutoReviewer,
  INLINE_EVAL_HIT,
  approvalDecisionMock,
  approvalRouteFixture,
  approvalRouteMock,
  commitAuthorizationMock,
  completedOutcome,
  configurePlanBackedCommand,
  durableApprovalMock,
  enforcedCommandMock,
  exactApprovalMock,
  expectAuthorization,
  expectCall,
  expectPending,
  followupMock,
  inlineEvalMock,
  markBackgroundedMock,
  mockAllowlist,
  mockAllowlistTimeoutFallback,
  mockApprovedDetachedExec,
  mockCompletedProcess,
  mockExactTrust,
  mockHostPolicy,
  pendingResultMock,
  planAllowlistedNodeVersion,
  requireAuthorizationPlan,
  requireSentFollowupText,
  requiresApprovalMock,
  reviewerMock,
  runAbortedApprovalError,
  runDetached,
  runExecProcessMock,
  runGatewayAllowlist,
  startupCancellationMocks,
  waitForFollowup,
};
