import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { onAgentEvent } from "../infra/agent-events.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import { buildCwdBoundHashedArgPattern } from "../infra/exec-command-resolution.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { expectNoCalls } from "../test-utils/mock-call-assertions.js";
import {
  approvalDecisionMock,
  approvalRouteFixture,
  approvalRouteMock,
  commitAuthorizationMock,
  completedOutcome,
  configurePlanBackedCommand,
  expectAuthorization,
  expectCall,
  expectPending,
  followupMock,
  markBackgroundedMock,
  mockAllowlist,
  mockAllowlistTimeoutFallback,
  mockApprovedDetachedExec,
  mockCompletedProcess,
  mockExactTrust,
  mockHostPolicy,
  pendingResultMock,
  requireSentFollowupText,
  requiresApprovalMock,
  runAbortedApprovalError,
  runDetached,
  runExecProcessMock,
  runGatewayAllowlist,
  startupCancellationMocks,
  waitForFollowup,
} from "./bash-tools.exec-host-gateway.test-support.js";
import { captureProcessUnhandledRejections } from "./bash-tools.exec-runtime.test-support.js";
import type {
  ExecApprovalFollowupFactory,
  ExecApprovalFollowupOutcome,
} from "./bash-tools.exec-types.js";
import { captureSecurityEvents } from "./test-helpers/security-events.js";

describe("processGatewayAllowlist detached approvals", () => {
  it("preserves detached launch options while recording reusable shell approvals", async () => {
    if (process.platform === "win32") {
      return;
    }

    const command = "sh -c 'git status'";
    const env = { PATH: "/usr/bin:/bin" };
    const secretEgressBindings = [
      {
        name: "SERVICE_KEY",
        sentinel: "synthetic-approval-sentinel",
        allowedHosts: ["api.example.com"],
      },
    ];
    const durable = {
      durable: { notifyOnExit: true, notifyOnExitEmptySuccess: true },
      agentId: "main",
      sessionId: "origin-session",
    };
    await configurePlanBackedCommand({ command, env });
    const approval = createDeferredCore<"allow-always">();
    approvalDecisionMock.mockReturnValue(approval.promise);
    mockCompletedProcess();

    const result = await runGatewayAllowlist({
      approvalFollowupMode: "agent",
      command,
      ask: "on-miss",
      env,
      secretEgressBindings,
      autoReview: false,
      ...durable,
    });
    const expectedGitArgPattern = buildCwdBoundHashedArgPattern(
      ["/usr/bin/git", "status"],
      process.cwd(),
    );

    expectPending(result);
    expectCall(pendingResultMock, {
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
    expect(runExecProcessMock).not.toHaveBeenCalled();
    approval.resolve("allow-always");
    await waitForFollowup();
    expectCall(runExecProcessMock, { env, secretEgressBindings, ...durable, notifyOnExit: false });
    expectCall(commitAuthorizationMock, {
      authorization: expect.objectContaining({ source: "explicit-approval" }),
      allowAlwaysDecision: {
        kind: "patterns",
        commandText: "sh -c 'git status'",
        patterns: [{ pattern: "/usr/bin/git", argPattern: expectedGitArgPattern }],
      },
    });
  });

  it("keeps webchat diagnostics approvals as direct pasteable followups", async () => {
    mockApprovedDetachedExec(
      completedOutcome(
        JSON.stringify({
          path: "/tmp/openclaw-diagnostics.zip",
          bytes: 1234,
          manifest: {
            generatedAt: "2026-04-28T20:58:29.311Z",
            openclawVersion: "2026.4.27",
            contents: [
              { path: "diagnostics.json", bytes: 100 },
              { path: "summary.md", bytes: 200 },
            ],
            privacy: {
              payloadFree: true,
              rawLogsIncluded: false,
              notes: ["Logs keep operational summaries."],
            },
          },
        }),
      ),
    );

    const approvalFollowup = vi.fn<ExecApprovalFollowupFactory>(
      async () => "Synthetic harness diagnostics: thread-1",
    );

    const result = await runGatewayAllowlist({
      command: "openclaw gateway diagnostics export --json",
      trigger: "diagnostics",
      approvalFollowupMode: "direct",
      approvalFollowup,
      turnSourceChannel: "webchat",
    });
    expectPending(result);
    await waitForFollowup();

    const followupTarget = followupMock.mock.calls[0]?.[0];
    expect(followupTarget?.direct).toBe(true);
    const followupText = requireSentFollowupText();
    expect(followupText).toContain("Diagnostics export created.");
    expect(followupText).toContain("Path: /tmp/openclaw-diagnostics.zip");
    expect(followupText).toContain("Contents (2 files):");
    expect(followupText).toContain("Size: 1234 bytes");
    expect(followupText).toContain("Privacy:\n- payload-free: yes\n- raw logs included: no");
    expect(followupText).toContain("- Logs keep operational summaries.");
    expect(followupText).toContain("Synthetic harness diagnostics: thread-1");
    expect(approvalFollowup.mock.calls[0]?.[0]).toMatchObject({
      approvalId: approvalRouteFixture.id,
      sessionId: "sess-1",
      trigger: "diagnostics",
      outcome: { status: "completed", exitCode: 0 },
    });
  });

  it("keeps a completed detached outcome terminal when agent follow-up registration fails", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();
    const outcome = completedOutcome("completed output");
    const approvalFollowup = vi.fn<ExecApprovalFollowupFactory>(() => undefined);
    mockApprovedDetachedExec(outcome);
    followupMock.mockRejectedValueOnce(
      new Error("synchronous runtime-handoff registration failure"),
    );

    try {
      await runDetached({
        command: "side-effecting-command",
        approvalFollowup,
      });
      await vi.waitFor(() => expect(approvalFollowup).toHaveBeenCalledOnce());
      await setImmediate();

      expect(approvalFollowup.mock.calls[0]?.[0].outcome).toEqual(outcome);
      expect(unhandledRejections.reasons).toEqual([]);
      expect(followupMock).toHaveBeenCalledOnce();
      expect(requireSentFollowupText()).toContain("completed output");
      expect(requireSentFollowupText()).not.toContain("Exec denied");
    } finally {
      unhandledRejections.restore();
    }
  });

  it("consumes rejected detached request-failure and fallback follow-ups", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();
    approvalDecisionMock.mockRejectedValueOnce(new Error("approval request failed"));
    followupMock.mockRejectedValue(new Error("denial follow-up failed"));
    try {
      await runDetached({
        command: "side-effecting-command",
      });
      await vi.waitFor(() => expect(followupMock).toHaveBeenCalledTimes(2));
      await setImmediate();
      expect(unhandledRejections.reasons).toEqual([]);
      const denied = `Exec denied (gateway id=${approvalRouteFixture.id}, approval-request-failed): side-effecting-command`;
      expect(requireSentFollowupText()).toBe(denied);
      expect(requireSentFollowupText(1)).toBe(denied);
      expect(runExecProcessMock).not.toHaveBeenCalled();
    } finally {
      unhandledRejections.restore();
    }
  });

  it("fails closed when a detached allow-always authorization commit fails", async () => {
    approvalDecisionMock.mockResolvedValue("allow-always");
    commitAuthorizationMock.mockRejectedValueOnce(new Error("approval lock unavailable"));
    const captured = captureSecurityEvents();
    try {
      const result = await runGatewayAllowlist({
        approvalFollowupMode: "agent",
        command: "echo approved",
      });
      expectPending(result);
      await waitForFollowup();
      expect(requireSentFollowupText()).toContain("approval-state-write-failed");
      expect(runExecProcessMock).not.toHaveBeenCalled();
      expect(commitAuthorizationMock).toHaveBeenCalledOnce();
      expectCall(commitAuthorizationMock, {
        authorization: expect.objectContaining({ source: "explicit-approval" }),
        allowAlwaysDecision: expect.any(Object),
      });
      expect(captured.events.at(-1)).toMatchObject({
        action: "exec.approval.denied",
        outcome: "error",
        policy: { reason: "approval-state-write-failed" },
      });
    } finally {
      captured.stop();
    }
  });

  it("emits inline approval park and clear events for a denial", async () => {
    approvalDecisionMock.mockResolvedValue("deny");
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === "run-inline" && event.stream === "lifecycle") {
        events.push(event.data);
      }
    });

    try {
      await runGatewayAllowlist({
        command: "pwd",
        turnSourceChannel: "webchat",
        runId: "run-inline",
        toolCallId: "tool-inline",
        sessionKey: "agent:main:main",
        sessionId: "session-inline",
      });
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([
      { phase: "waiting-approval", approvalId: approvalRouteFixture.id, toolCallId: "tool-inline" },
      {
        phase: "approval-resolved",
        approvalId: approvalRouteFixture.id,
        toolCallId: "tool-inline",
      },
    ]);
  });

  it("waits outside admission, then atomically hands an approved process to the registry", async () => {
    const approval = createDeferredCore<ExecApprovalDecision>();
    const outcome = createDeferredCore<ExecApprovalFollowupOutcome>();
    const spawnAllowed = createDeferredCore();
    const spawnStarted = createDeferredCore();
    approvalDecisionMock.mockReturnValue(approval.promise);
    commitAuthorizationMock.mockImplementation(async () => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      return () => {};
    });
    runExecProcessMock.mockImplementation(async () => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      spawnStarted.resolve();
      await spawnAllowed.promise;
      return { session: { id: "sess-atomic" }, promise: outcome.promise };
    });
    markBackgroundedMock.mockImplementation(() => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    });

    await runDetached();
    await vi.waitFor(() => expect(approvalDecisionMock).toHaveBeenCalledOnce());
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    approval.resolve("allow-once");
    await Promise.resolve();
    await Promise.resolve();
    expectNoCalls(commitAuthorizationMock, runExecProcessMock, markBackgroundedMock);

    suspension?.release();
    await spawnStarted.promise;
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    spawnAllowed.resolve();
    await vi.waitFor(() => {
      expect(markBackgroundedMock).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
    expect(commitAuthorizationMock).toHaveBeenCalledOnce();
    expect(runExecProcessMock).toHaveBeenCalledOnce();

    outcome.resolve(completedOutcome());
    await waitForFollowup();
  });

  it("retains the executing App identity through detached approval with borrowed policy", async () => {
    const approval = createDeferredCore<ExecApprovalDecision>();
    approvalDecisionMock.mockReturnValue(approval.promise);
    mockCompletedProcess();
    const githubApp = {
      profileId: "ghp_11111111111111111111111111111111",
      agentId: "executor",
      sessionId: "executing-session",
      sessionKey: "agent:executor:actual",
    };
    const result = await runGatewayAllowlist({
      command: "find . -maxdepth 1",
      agentId: "policy-owner",
      sessionKey: "agent:policy-owner:policy",
      githubApp,
      turnSourceChannel: "webchat",
      approvalFollowupMode: "agent",
    });
    expect(result.pendingResult?.details.status).toBe("approval-pending");
    expect(runExecProcessMock).not.toHaveBeenCalled();
    approval.resolve("allow-once");
    await vi.waitFor(() => expect(runExecProcessMock).toHaveBeenCalledOnce());
    expect(runExecProcessMock).toHaveBeenCalledWith(expect.objectContaining({ githubApp }));
    await waitForFollowup();
  });

  it("re-prompts durable detached gateway script approvals and rejects changed bytes", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-script-binding-"));
    const script = path.join(workdir, "script.sh");
    const command = "sh script.sh";
    try {
      fs.writeFileSync(script, "#!/bin/sh\necho approved\n");
      mockAllowlist({
        segments: [{ resolution: null, argv: ["sh", "script.sh"] }],
        segmentSatisfiedBy: [],
      });
      mockExactTrust(command);
      approvalDecisionMock.mockImplementation(async () => {
        fs.writeFileSync(script, "#!/bin/sh\necho mutated\n");
        return "allow-once";
      });
      mockCompletedProcess(completedOutcome("approved"), "sess-script-binding");

      await runDetached({
        command,
        workdir,
      });
      expect(pendingResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ allowedDecisions: ["allow-once", "deny"] }),
      );
      await waitForFollowup();
      expect(requireSentFollowupText()).toContain(
        "approval script operand changed before execution",
      );
      expectNoCalls(commitAuthorizationMock, runExecProcessMock);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("denies a detached approved process when restart drain wins admission", async () => {
    const approval = createDeferredCore<ExecApprovalDecision>();
    approvalDecisionMock.mockReturnValue(approval.promise);

    await runDetached();
    await vi.waitFor(() => expect(approvalDecisionMock).toHaveBeenCalledOnce());

    markGatewayRestartDraining();
    approval.resolve("allow-once");
    await vi.waitFor(() => {
      expect(followupMock).toHaveBeenCalledWith(
        expect.anything(),
        `Exec denied (gateway id=${approvalRouteFixture.id}, gateway-draining): find . -maxdepth 1`,
      );
    });
    expect(followupMock).toHaveBeenCalledOnce();
    expectNoCalls(commitAuthorizationMock, runExecProcessMock, markBackgroundedMock);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "resolves a rotated GitHub credential only after delayed approval",
    async () => {
      const followupDelivered = createDeferredCore();
      followupMock.mockImplementation(async () => {
        followupDelivered.resolve();
      });
      const runtime = await vi.importActual<typeof import("./bash-tools.exec-runtime.js")>(
        "./bash-tools.exec-runtime.js",
      );
      runExecProcessMock.mockImplementation(runtime.runExecProcess);
      const profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delayed-github-")));
      const hostsPath = path.join(profileDir, "hosts.yml");
      fs.writeFileSync(hostsPath, "github.com:\n  oauth_token: synthetic-before-approval\n", {
        mode: 0o600,
      });
      let releaseApproval: () => void = () => {};
      approvalDecisionMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseApproval = () => resolve("allow-once");
          }),
      );
      const supervisor = createProcessSupervisor();
      startupCancellationMocks.spawn.mockImplementation(supervisor.spawn.bind(supervisor));
      const fixturePath = path.join(profileDir, "auth-result.cjs");
      fs.writeFileSync(
        fixturePath,
        `
        process.stdout.write(process.env.GH_TOKEN === "synthetic-after-approval"
          ? "selected-after-approval" : "wrong-account");
      `,
      );
      const command = [process.execPath, fixturePath].map(quoteCliArg).join(" ");
      const env = Object.freeze({
        PATH: "/usr/bin:/bin",
        GH_CONFIG_DIR: profileDir,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
      });
      try {
        await runDetached({
          command,
          env,
          requestedEnv: env,
          githubProfileDir: profileDir,
        });
        await vi.waitFor(() => expect(approvalDecisionMock).toHaveBeenCalledOnce());
        expect(startupCancellationMocks.spawn).not.toHaveBeenCalled();
        fs.writeFileSync(hostsPath, "github.com:\n  oauth_token: synthetic-after-approval\n");
        releaseApproval();
        await followupDelivered.promise;
        expect(followupMock.mock.calls.length).toBe(1);
        expect(requireSentFollowupText()).toContain("selected-after-approval");
        expect(startupCancellationMocks.spawn).toHaveBeenCalledOnce();
        expect(env.GH_TOKEN).toBe("");
        expect(JSON.stringify(approvalRouteMock.mock.calls)).not.toContain(
          "synthetic-after-approval",
        );
        expect(JSON.stringify(followupMock.mock.calls)).not.toContain("synthetic-after-approval");
        expect(JSON.stringify(startupCancellationMocks.spawn.mock.calls)).not.toContain(
          "synthetic-after-approval",
        );
      } finally {
        releaseApproval();
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        await supervisor.shutdown();
        fs.rmSync(profileDir, { recursive: true, force: true });
      }
    },
  );

  it("does not spawn or send a detached followup after cancellation during startup", async () => {
    const controller = new AbortController();
    mockApprovedDetachedExec(completedOutcome());
    const runtime = await vi.importActual<typeof import("./bash-tools.exec-runtime.js")>(
      "./bash-tools.exec-runtime.js",
    );
    runExecProcessMock.mockImplementation(runtime.runExecProcess);
    startupCancellationMocks.prepare.mockImplementationOnce(() =>
      controller.abort(new Error("cancelled while preparing")),
    );

    await runDetached({
      signal: controller.signal,
      env: { PATH: "/usr/bin:/bin" },
    });
    await vi.waitFor(() => expect(startupCancellationMocks.prepare).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    expect(startupCancellationMocks.spawn.mock.calls.length).toBe(0);
    expectNoCalls(markBackgroundedMock, followupMock);
  });

  it("drops detached execution and follow-up when the owning run is aborted", async () => {
    approvalDecisionMock.mockRejectedValue(runAbortedApprovalError);

    await runDetached({
      runId: "run-aborted",
      toolCallId: "tool-aborted",
    });
    await vi.waitFor(() => expect(approvalDecisionMock).toHaveBeenCalledOnce());
    expectNoCalls(commitAuthorizationMock, runExecProcessMock, followupMock);
  });

  it.each([false, true])(
    "binds a full-policy timeout to the allowlist plan (headless=%s)",
    async (headless) => {
      const { command, enforcedCommand } = await mockAllowlistTimeoutFallback("full");
      approvalRouteFixture.inline = headless;
      if (!headless) {
        approvalDecisionMock.mockResolvedValue(null);
      }
      const result = await runGatewayAllowlist({
        command,
        security: "full",
        ask: "always",
        ...(headless ? { trigger: "cron" } : { turnSourceChannel: "webchat" }),
      });

      expect(result.execCommandOverride).toBe(enforcedCommand);
      expectAuthorization({
        source: "ask-fallback",
        security: "allowlist",
        allowlistSatisfied: true,
      });
    },
  );

  it("denies allowlist timeout fallback without an enforceable plan", async () => {
    requiresApprovalMock.mockReturnValue(true);
    mockAllowlist({
      allowlistMatches: [{ pattern: "/usr/bin/rg" }],
      allowlistSatisfied: true,
      segments: [{ resolution: null, argv: ["rg", "needle"] }],
      segmentAllowlistEntries: [{ pattern: "/usr/bin/rg" }],
      segmentSatisfiedBy: ["allowlist"],
    });
    mockHostPolicy({ hostSecurity: "full", hostAsk: "always", askFallback: "allowlist" });
    approvalDecisionMock.mockResolvedValue(null);

    const result = await runGatewayAllowlist({
      command: "rg needle",
      security: "full",
      ask: "always",
      turnSourceChannel: "webchat",
    });

    expect(result.deniedResult?.content[0]).toMatchObject({
      text: expect.stringContaining("approval-timeout: execution-plan-miss"),
    });
    expect(commitAuthorizationMock).not.toHaveBeenCalled();
  });
});
