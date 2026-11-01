import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { onAgentEvent } from "../infra/agent-events.js";
import type { ExecAllowlistEntry } from "../infra/exec-approvals.js";
import { buildAuthorizedShellCommandFromPlan } from "../infra/exec-authorization-render.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  ExecAutoReviewer,
  INLINE_EVAL_HIT,
  approvalDecisionMock,
  approvalRouteFixture,
  approvalRouteMock,
  commitAuthorizationMock,
  configurePlanBackedCommand,
  durableApprovalMock,
  enforcedCommandMock,
  exactApprovalMock,
  expectAuthorization,
  expectCall,
  expectPending,
  inlineEvalMock,
  mockAllowlist,
  mockExactTrust,
  mockHostPolicy,
  pendingResultMock,
  planAllowlistedNodeVersion,
  requireAuthorizationPlan,
  reviewerMock,
  runGatewayAllowlist,
} from "./bash-tools.exec-host-gateway.test-support.js";
import { captureSecurityEvents } from "./test-helpers/security-events.js";

describe("processGatewayAllowlist", () => {
  it("denies shell-expansion plan misses immediately when asking is off and fallback denies", async () => {
    const command = "grep -il needle -r /tmp --include=*.md";
    const authorizationPlan = await requireAuthorizationPlan({
      command,
      env: { PATH: "/usr/bin:/bin" },
    });
    const segments = authorizationPlan.groups.flatMap((group) =>
      group.candidates.map((candidate) => candidate.sourceSegment),
    );
    mockAllowlist({
      allowlistMatches: [{ pattern: "/usr/bin/grep" }],
      allowlistSatisfied: true,
      segments,
      segmentAllowlistEntries: [{ pattern: "/usr/bin/grep" }],
      segmentSatisfiedBy: ["allowlist"],
      authorizationPlan,
    });
    const captured = captureSecurityEvents();

    let result: Awaited<ReturnType<typeof runGatewayAllowlist>>;
    try {
      result = await runGatewayAllowlist({ command });
    } finally {
      captured.stop();
    }

    expect(approvalRouteMock).not.toHaveBeenCalled();
    expect(result!.deniedResult?.content[0]).toMatchObject({
      text: expect.stringContaining("ask-fallback-deny: execution-plan-miss"),
    });
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: "exec.approval.denied",
      outcome: "denied",
      reason: "ask-fallback-deny: execution-plan-miss",
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects a durable grant when its approved directory is replaced before execution",
    async () => {
      const { command, authorizationPlan, segments, enforcedCommand } =
        await planAllowlistedNodeVersion();
      mockAllowlist({
        allowlistMatches: [{ pattern: "/usr/bin/node" }],
        allowlistSatisfied: true,
        segments,
        segmentAllowlistEntries: [{ pattern: "/usr/bin/node", source: "allow-always" }],
        segmentSatisfiedBy: ["allowlist"],
        authorizationPlan,
      });
      enforcedCommandMock.mockReturnValue({ ok: true, command: enforcedCommand });
      const approvedCwd = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-cwd-approved-")),
      );
      const movedCwd = `${approvedCwd}-moved`;
      try {
        const result = await runGatewayAllowlist({ command, workdir: approvedCwd });
        expect(result.deniedResult).toBeUndefined();
        expect(result.revalidateBeforeExecution).toBeTypeOf("function");

        fs.renameSync(approvedCwd, movedCwd);
        fs.mkdirSync(approvedCwd);

        const denied = await result.revalidateBeforeExecution?.();
        expect(denied?.content[0]).toMatchObject({
          text: expect.stringContaining("SYSTEM_RUN_DENIED: approval cwd changed before execution"),
        });
      } finally {
        fs.rmSync(approvedCwd, { recursive: true, force: true });
        fs.rmSync(movedCwd, { recursive: true, force: true });
      }
    },
  );

  it("emits a denied security event for inline unavailable approval denials", async () => {
    approvalRouteFixture.inline = true;
    const captured = captureSecurityEvents();

    try {
      await expect(
        runGatewayAllowlist({
          command: "deploy --token raw-secret-value",
          agentId: "agent-1",
        }),
      ).rejects.toThrow("denied");
    } finally {
      captured.stop();
    }

    expect(captured.events.map(({ action, outcome, reason }) => [action, outcome, reason])).toEqual(
      [
        ["exec.approval.requested", "success", undefined],
        ["exec.approval.denied", "denied", "approval-timeout"],
      ],
    );
    const serialized = JSON.stringify(captured.events);
    expect(serialized).not.toContain("deploy");
    expect(serialized).not.toContain("raw-secret-value");
    expect(serialized).not.toContain("agent-1");
  });

  it.runIf(process.platform !== "win32")(
    "reviews an unquoted glob and semicolon chain and pins its dispatches once",
    async () => {
      const command = "ls *.ts; echo complete";
      await configurePlanBackedCommand({ command });
      reviewerMock.mockResolvedValue({
        decision: "allow-once",
        risk: "medium",
        rationale: "project inspection",
      });
      const warnings: string[] = [];
      const result = await runGatewayAllowlist({ command, autoReview: true, warnings });

      expectCall(reviewerMock, {
        command,
        reason: "execution-plan-miss",
        argv: undefined,
        resolvedPath: undefined,
        analysis: expect.objectContaining({ parsed: true, heredoc: false }),
      });
      expect(result.execCommandOverride).toMatch(
        /^'\/[^']*\/ls' \*\.ts; '\/[^']*\/echo' complete$/,
      );
      expect(result.allowWithoutEnforcedCommand).toBeUndefined();
      await expect(result.revalidateBeforeExecution?.()).resolves.toBeUndefined();
      expect(approvalRouteMock).not.toHaveBeenCalled();
      expectAuthorization({ source: "auto-review" });
      expect(warnings).toContain("Exec auto-review allowed once (risk=medium): project inspection");
    },
  );

  it("escalates the third session denial and resets after reviewer allowance or human resolution", async () => {
    const command = "echo review";
    await configurePlanBackedCommand({ command });
    reviewerMock.mockResolvedValue({
      decision: "deny",
      risk: "medium",
      rationale: "narrow it",
    });
    const sessionKey = "agent:main:auto-denial-circuit";
    const run = (warnings: string[] = []) =>
      runGatewayAllowlist({ command, autoReview: true, sessionKey, warnings });
    const expectDenied = async () =>
      expect((await run()).deniedResult?.details).toMatchObject({
        failureKind: "auto-review-denied",
      });
    await expectDenied();
    await expectDenied();
    reviewerMock.mockResolvedValueOnce({
      decision: "allow-once",
      risk: "medium",
      rationale: "safe now",
    });
    expect((await run()).deniedResult).toBeUndefined();
    await expectDenied();
    await expectDenied();
    expect(approvalRouteMock).not.toHaveBeenCalled();
    // Human denial resolves the escalation and starts a new denial sequence.
    approvalDecisionMock.mockResolvedValueOnce("deny");
    const warnings: string[] = [];
    await run(warnings);
    expect(approvalRouteMock).toHaveBeenCalledTimes(1);
    expect(warnings).toContain(
      "Exec auto-review denied 3 consecutive commands for this session; escalating to human approval",
    );
    await expectDenied();
    await expectDenied();
    expect(approvalRouteMock).toHaveBeenCalledTimes(1);
    const otherSession = await runGatewayAllowlist({
      command,
      autoReview: true,
      sessionKey: "agent:main:independent-circuit",
    });
    expect(otherSession.deniedResult?.details).toMatchObject({ failureKind: "auto-review-denied" });
    await run();
    expect(approvalRouteMock).toHaveBeenCalledTimes(2);
  });

  it("returns approval-required when non-interactive auto-review asks for a human", async () => {
    const command = "echo review";
    await configurePlanBackedCommand({ command });
    reviewerMock.mockResolvedValue({
      decision: "ask",
      risk: "low",
      rationale: "reviewed",
    });
    const result = await runGatewayAllowlist({
      command,
      autoReview: true,
      nonInteractiveApproval: true,
    });
    expect(reviewerMock).toHaveBeenCalledOnce();
    expect(approvalRouteMock).not.toHaveBeenCalled();
    expect(result.deniedResult?.details).toMatchObject({
      status: "failed",
      failureKind: "approval_required",
    });
    expect(commitAuthorizationMock).not.toHaveBeenCalled();
  });

  it("keeps always-ask commands on the human approval path", async () => {
    const command = "echo review";
    await configurePlanBackedCommand({ command, hostAsk: "always" });
    await runGatewayAllowlist({ command, autoReview: true });
    expect(reviewerMock).not.toHaveBeenCalled();
    expect(approvalRouteMock).toHaveBeenCalledOnce();
  });

  it("publishes and records the approved Guardian review on its exec call", async () => {
    const assessment = { decision: "allow-once", risk: "low", rationale: "read-only" } as const;
    const command = "echo ok";
    await configurePlanBackedCommand({ command });
    const review = createDeferredCore<Awaited<ReturnType<ExecAutoReviewer>>>();
    const autoReviewer = vi.fn<ExecAutoReviewer>(() => review.promise);
    const reviews: Array<Record<string, unknown>> = [];
    const publicationOrder: string[] = [];
    const onApprovalReview = vi.fn((value: { status: string }) => {
      publicationOrder.push(`stored:${value.status}`);
    });
    const unsubscribe = onAgentEvent((event) => {
      if (
        event.runId === "run-review" &&
        event.stream === "tool" &&
        event.data.phase === "review"
      ) {
        publicationOrder.push(`emitted:${String(event.data.approvalReviewOutcome)}`);
        reviews.push(event.data);
      }
    });
    try {
      const pending = runGatewayAllowlist({
        command,
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
        runId: "run-review",
        toolCallId: "tool-review",
        onApprovalReview,
      });
      await vi.waitFor(() => expect(autoReviewer).toHaveBeenCalledOnce());
      expect(reviews).toMatchObject([
        {
          toolCallId: "tool-review",
          approvalReviewOutcome: "reviewing",
          review: { status: "in_progress" },
        },
      ]);
      review.resolve(assessment);
      const result = await pending;
      expect(reviews.map((event) => event.approvalReviewOutcome)).toEqual([
        "reviewing",
        "approved",
      ]);
      expect(reviews[1]).toMatchObject({
        toolCallId: "tool-review",
        review: {
          id: "guardian:tool-review",
          status: "approved",
          riskLevel: assessment.risk,
          rationale: assessment.rationale,
        },
      });
      expect(publicationOrder).toEqual([
        "emitted:reviewing",
        "stored:approved",
        "emitted:approved",
      ]);
      expect(approvalRouteMock).not.toHaveBeenCalled();
      expect(result.deniedResult).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it.runIf(process.platform !== "win32")(
    "keeps login-shell startup commands on human approval",
    async () => {
      const command = "/bin/sh -lc 'printf ok'";
      await configurePlanBackedCommand({ command });
      const warnings: string[] = [];
      await runGatewayAllowlist({ command, ask: "on-miss", autoReview: true, warnings });
      expect(reviewerMock).not.toHaveBeenCalled();
      expect(approvalRouteMock).toHaveBeenCalledOnce();
      expect(approvalRouteMock).toHaveBeenCalledWith(
        expect.objectContaining({ requiresAutoReviewHumanApproval: true }),
      );
      expect(warnings).toContain(
        "Exec auto-review skipped: login or interactive shell startup requires human approval",
      );
    },
  );

  it("does not execute after cancellation wins during auto-review", async () => {
    const command = "echo ok";
    await configurePlanBackedCommand({ command });
    const autoReviewer = vi.fn<ExecAutoReviewer>(() => new Promise(() => {}));
    const abortController = new AbortController();
    const reviewStatuses: string[] = [];
    const unsubscribe = onAgentEvent((event) => {
      if (
        event.runId === "run-cancelled-review" &&
        event.stream === "tool" &&
        event.data.phase === "review"
      ) {
        const review = event.data.review as { status?: unknown } | undefined;
        if (typeof review?.status === "string") {
          reviewStatuses.push(review.status);
        }
      }
    });

    try {
      const result = runGatewayAllowlist({
        command,
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
        signal: abortController.signal,
        runId: "run-cancelled-review",
        toolCallId: "tool-cancelled-review",
      });
      await vi.waitFor(() => expect(autoReviewer).toHaveBeenCalledTimes(1));

      abortController.abort(new Error("cancelled during review"));

      await expect(result).rejects.toThrow("cancelled during review");
    } finally {
      unsubscribe();
    }
    expect(reviewStatuses).toEqual(["in_progress", "aborted"]);
    expect(approvalRouteMock).not.toHaveBeenCalled();
  });

  it("rejects contradictory high-risk custom reviewer approvals", async () => {
    const command = "echo ok";
    await configurePlanBackedCommand({ command });
    reviewerMock.mockResolvedValueOnce({
      decision: "allow-once",
      risk: "high",
      rationale: "contradictory custom decision",
    } as never);

    const result = await runGatewayAllowlist({ command, ask: "on-miss", autoReview: true });

    expect(approvalRouteMock).toHaveBeenCalledTimes(1);
    expect(result.deniedResult?.details.status).toBe("failed");
  });

  it("auto-reviews strict inline-eval commands instead of forcing human approval", async () => {
    const command = "python3 -c 'print(1)'";
    const { invocationPath } = await configurePlanBackedCommand({
      command,
      allowlistSatisfied: true,
      requiresApproval: false,
      satisfiedBy: "allowlist",
    });
    inlineEvalMock.mockReturnValue(INLINE_EVAL_HIT);
    const warnings: string[] = [];

    const result = await runGatewayAllowlist({
      command,
      ask: "on-miss",
      autoReview: true,
      strictInlineEval: true,
      warnings,
    });

    expectCall(reviewerMock, {
      command,
      argv: ["python3", "-c", "print(1)"],
      host: "gateway",
      reason: "strict-inline-eval",
      analysis: expect.objectContaining({ inlineEval: true }),
    });
    expect(approvalRouteMock).not.toHaveBeenCalled();
    expect(warnings[0]).toContain("reviewer or explicit approval");
    expect(result.execCommandOverride).toBe(`'${invocationPath}' -c 'print(1)'`);
  });

  it("does not bind current policy to redundant exact-command trust", async () => {
    const command = "cd .";
    const { authorizationPlan } = await configurePlanBackedCommand({
      command,
      env: { PATH: "/usr/bin:/bin" },
      allowlistSatisfied: true,
      requiresApproval: false,
      segmentAllowlistEntries: [null],
      satisfiedBy: "safeBuiltins",
    });
    const enforced = buildAuthorizedShellCommandFromPlan({
      plan: authorizationPlan,
      mode: "enforced",
      segmentSatisfiedBy: ["safeBuiltins"],
    });
    if (!enforced.ok) {
      throw new Error(enforced.reason);
    }
    mockExactTrust(command);

    const result = await runGatewayAllowlist({ command });

    expect(approvalRouteMock).not.toHaveBeenCalled();
    expect(result.execCommandOverride).toBe(enforced.command);
    expectAuthorization({
      source: "current-policy",
      requireExactCommandApproval: false,
      requireDurableAllowlistApproval: false,
    });
  });

  it("omits allow-always when allowlist execution cannot persist reusable patterns", async () => {
    const command = "ls *.ts";
    await configurePlanBackedCommand({
      command,
      env: { PATH: "/usr/bin:/bin" },
      allowlistSatisfied: true,
      requiresApproval: false,
      segmentAllowlistEntries: [{ pattern: "/usr/bin/ls", source: "allow-always" }],
      satisfiedBy: "allowlist",
    });
    durableApprovalMock.mockReturnValue(false);

    const result = await runGatewayAllowlist({
      approvalFollowupMode: "agent",
      command,
      ask: "on-miss",
      autoReview: false,
    });

    expectPending(result);
    expectCall(pendingResultMock, {
      allowedDecisions: ["allow-once", "deny"],
    });
  });

  it("binds mixed allowlist authorization to exact trust when it bypasses an unavailable plan", async () => {
    const command = "ls *.ts";
    const allowlistEntry: ExecAllowlistEntry = {
      pattern: "/usr/bin/ls",
      source: "allow-always",
    };
    await configurePlanBackedCommand({
      command,
      env: { PATH: "/usr/bin:/bin" },
      requiresApproval: false,
      allowlistMatches: [allowlistEntry],
      allowlistSatisfied: true,
      segmentAllowlistEntries: [allowlistEntry],
      satisfiedBy: "allowlist",
    });
    mockExactTrust(command, [allowlistEntry]);
    commitAuthorizationMock.mockRejectedValueOnce(new Error("exact-command approval revoked"));

    await expect(
      runGatewayAllowlist({
        command,
        ask: "off",
        autoReview: false,
      }),
    ).rejects.toThrow("exact-command approval revoked");

    expect(approvalRouteMock).not.toHaveBeenCalled();
    expectAuthorization({
      source: "current-policy",
      requireExactCommandApproval: true,
      requireDurableAllowlistApproval: false,
    });
  });

  it.runIf(process.platform !== "win32")(
    "defers compound plans with more than 64 candidates before Guardian review",
    async () => {
      const command = Array.from({ length: 65 }, () => "/bin/echo ok").join(" && ");
      await configurePlanBackedCommand({ command });

      const result = await runGatewayAllowlist({ command, ask: "on-miss", autoReview: true });

      expect(reviewerMock).not.toHaveBeenCalled();
      expect(approvalRouteMock).toHaveBeenCalledOnce();
      expect(result.deniedResult?.details.status).toBe("failed");
    },
  );

  it("does not use fallback-full when auto-review asks for human approval", async () => {
    const command = "echo ok";
    await configurePlanBackedCommand({ command });
    mockHostPolicy({ hostSecurity: "full", hostAsk: "on-miss", askFallback: "full" });
    reviewerMock.mockResolvedValue({
      decision: "ask",
      risk: "medium",
      rationale: "needs a person",
    });
    approvalDecisionMock.mockResolvedValue(null);
    const result = await runGatewayAllowlist({
      command,
      security: "full",
      ask: "on-miss",
      autoReview: true,
      turnSourceChannel: "webchat",
    });
    expect(reviewerMock).toHaveBeenCalledOnce();
    expect(result.deniedResult?.details.status).toBe("failed");
    expect(result.deniedResult?.content[0]).toMatchObject({
      text: `Exec denied (gateway id=${approvalRouteFixture.id}, approval-timeout): echo ok\nCommand did not run: approval timed out.`,
    });
  });

  it("allows durable exact-command trust to bypass the synchronous allowlist miss", async () => {
    const command = "/bin/echo durable";
    mockAllowlist({
      analysisOk: false,
      segments: [{ resolution: null, argv: ["/bin/echo", "durable"] }],
      segmentSatisfiedBy: [],
    });
    durableApprovalMock.mockReturnValue(true);
    exactApprovalMock.mockReturnValue(true);
    enforcedCommandMock.mockReturnValue({
      ok: true,
      command,
    });
    mockExactTrust(command);

    const result = await runGatewayAllowlist({ command });

    expect(approvalRouteMock).not.toHaveBeenCalled();
    expect(result.execCommandOverride).toBeUndefined();
    expectAuthorization({
      source: "current-policy",
      requireExactCommandApproval: true,
    });
  });

  it("keeps denying allowlist misses when durable trust does not match", async () => {
    mockAllowlist({
      analysisOk: false,
      segments: [{ resolution: null, argv: ["node", "--version"] }],
    });
    durableApprovalMock.mockReturnValue(false);

    await expect(
      runGatewayAllowlist({
        command: "node --version",
      }),
    ).rejects.toThrow("exec denied: allowlist miss");
  });
});
