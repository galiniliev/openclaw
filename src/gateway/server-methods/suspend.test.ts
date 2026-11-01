import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import { resetDatabaseEngineSelectionForTest } from "../../infra/database-engine/context.test-support.js";
import {
  resetGatewayWorkAdmission,
  getGatewayRollingAdmission,
} from "../../process/gateway-work-admission.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import { suspendHandlers } from "./suspend.js";
import type { GatewayRequestContext, GatewayClient } from "./types.js";

const coordinator = vi.hoisted(() => ({
  prepare: vi.fn(),
  status: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("../../infra/gateway-suspend-coordinator.js", () => ({
  prepareGatewaySuspend: coordinator.prepare,
  getGatewaySuspendStatus: coordinator.status,
  resumeGatewaySuspend: coordinator.resume,
}));

vi.mock("../server-active-work.js", () => ({
  createGatewayServerActiveWorkInspectors: vi.fn(() => ({ getChatRuns: vi.fn(() => 0) })),
}));
vi.mock("../../infra/database-engine/registry.js", () => ({
  // mock-isolation: this handler test exercises client admission after PG eligibility.
  isPostgresCompanionSelection: () => true,
}));

async function invoke(
  method: keyof typeof suspendHandlers,
  params: unknown,
  context: Partial<GatewayRequestContext> = {},
  hasCurrentClientAuthority?: () => boolean,
) {
  const respond = vi.fn();
  const handler = expectDefined(suspendHandlers[method], "suspendHandlers[method] test invariant");
  await handler({
    params,
    respond,
    hasCurrentClientAuthority,
    context: {
      cron: { pauseScheduling: vi.fn(), resumeScheduling: vi.fn() },
      logGateway: { warn: vi.fn(), info: vi.fn() },
      ...context,
    },
  } as unknown as Parameters<typeof handler>[0]);
  return { respond };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  resetGatewayWorkAdmission();
  resetDatabaseEngineSelectionForTest();
});

describe("gateway suspend handlers", () => {
  it("rebinds only a held handoff and observes without repeating mutation", async () => {
    const previous = {
      version: 1 as const,
      releaseId: "release",
      predecessorBootId: "old",
      candidateBootId: "failed",
      predecessorOwner: "owner",
      compatibilityDigest: "a".repeat(64),
      companionGeneration: "capture",
      expiresAtMs: Date.now() + 60000,
    };
    const next = { ...previous, candidateBootId: "replacement" };
    const target = { pid: process.pid, processInstanceId: getGatewayProcessInstanceId() };
    const rebind = vi.fn(async () => next);
    const observe = vi.fn(async () => ({ owner: "owner", contract: next }));
    const context = { rebindRollingExecution: rebind, observeRollingExecution: observe };
    coordinator.status.mockReturnValue({ status: "ready", executionYielded: true });
    const params = {
      target,
      suspensionId: "suspension",
      rebindExecution: {
        previous,
        candidateBootId: "replacement",
        expectedOwner: "returned-owner",
      },
    };
    const done = await invoke("gateway.suspend.handoff", params, context, () => true);
    expect(done.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "execution-rebound",
        execution: { owner: "owner", contract: next },
      }),
    );
    expect(rebind).toHaveBeenCalledWith(
      "suspension",
      previous,
      "replacement",
      "returned-owner",
      expect.any(Function),
    );
    const read = await invoke(
      "gateway.suspend.handoff",
      { target, suspensionId: "suspension", inspectExecution: true },
      context,
      () => true,
    );
    expect(read.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "execution-observed" }),
    );
    expect(rebind).toHaveBeenCalledTimes(1);
    for (const denied of [
      { ...params, inspectExecution: true },
      { ...params, target: { ...target, pid: process.pid + 1 } },
    ]) {
      const result = await invoke("gateway.suspend.handoff", denied, context, () => true);
      expect(result.respond.mock.calls[0]?.[0]).toBe(false);
    }
    await invoke("gateway.suspend.handoff", params, context, () => false);
    expect(rebind).toHaveBeenCalledTimes(1);
  });

  it("does not disclose a handoff observation after caller revocation", async () => {
    let current = true;
    coordinator.status.mockReturnValue({ status: "ready", executionYielded: true });
    const result = await invoke(
      "gateway.suspend.handoff",
      {
        suspensionId: "suspension",
        inspectExecution: true,
        target: { pid: process.pid, processInstanceId: getGatewayProcessInstanceId() },
      },
      {
        observeRollingExecution: async () => {
          current = false;
          return {
            owner: "owner",
            contract: {
              version: 1,
              releaseId: "release",
              predecessorBootId: "old",
              candidateBootId: "new",
              predecessorOwner: "owner",
              compatibilityDigest: "a".repeat(64),
              companionGeneration: "capture",
              expiresAtMs: Date.now() + 60000,
            },
          };
        },
      },
      () => current,
    );
    expect(result.respond.mock.calls[0]?.[0]).toBe(false);
  });

  it("leaves the old writer unfenced until every live operator can retain input, then reevaluates the same release", async () => {
    const connected = [
      { connId: "legacy", connect: { role: "operator", caps: [] } },
    ] as unknown as GatewayClient[];
    const context: Partial<GatewayRequestContext> = {
      yieldRollingExecution: async () => {},
      getClientConnIds: (filter) =>
        new Set(
          connected
            .filter((client) => !filter || filter(client))
            .map((client) => expectDefined(client.connId, "connected fixture identity")),
        ),
    };
    const params = {
      requestId: "same-operation",
      rollingReleaseId: "same-release",
      terminalPolicy: "preserve",
    };
    const blocked = await invoke("gateway.suspend.prepare", params, context);
    expect(blocked.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        retryable: false,
        details: {
          reason: "gateway-rolling-client-upgrade-required",
          requiredCapability: GATEWAY_CLIENT_CAPS.PLANNED_HANDOFF_RETENTION_V1,
          incompatibleConnectionCount: 1,
        },
      }),
    );
    expect(coordinator.prepare).not.toHaveBeenCalled();
    expect(getGatewayRollingAdmission()).toBeUndefined();
    connected[0]!.connect.caps = [GATEWAY_CLIENT_CAPS.PLANNED_HANDOFF_RETENTION_V1];
    coordinator.prepare.mockReturnValueOnce({ status: "ready", suspensionId: "same-operation" });
    const ready = await invoke("gateway.suspend.prepare", params, context);
    expect(ready.respond).toHaveBeenCalledWith(true, {
      status: "ready",
      suspensionId: "same-operation",
    });
    expect(coordinator.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ rollingReleaseId: "same-release" }),
    );
    expect(getGatewayRollingAdmission()?.releaseId).toBe("same-release");
  });
  it("validates the closed prepare params shape", async () => {
    const { respond } = await invoke("gateway.suspend.prepare", {
      requestId: "request-1",
      extra: true,
    });

    expect(coordinator.prepare).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid gateway.suspend.prepare params",
    });
  });

  it("maps a competing prepared lease to retryable unavailable", async () => {
    coordinator.prepare.mockReturnValueOnce({ status: "conflict", expiresAtMs: Date.now() + 5000 });
    const { respond } = await invoke("gateway.suspend.prepare", { requestId: "request-2" });

    expect(respond.mock.calls[0]).toMatchObject([
      false,
      undefined,
      {
        code: "UNAVAILABLE",
        details: expect.objectContaining({ reason: "gateway-suspension-conflict" }),
        retryable: true,
      },
    ]);
  });

  it.each([
    ["gateway.suspend.prepare", false],
    ["gateway.suspend.status", true],
  ] as const)("passes through %s draining results (custody=%s)", async (method, held) => {
    const params = held
      ? { suspensionId: "suspension-draining" }
      : { requestId: "request-draining", drain: true };
    const blockers = [{ kind: "terminal-persistence", count: 1, message: "pending write" }];
    const result = {
      status: "draining",
      ...(!held ? { suspensionId: "suspension-draining" } : {}),
      activeCount: blockers.length,
      blockers,
      ...(held ? { writeCustody: [{ phase: "terminal-persistence", count: 1 }] } : {}),
    };
    coordinator[held ? "status" : "prepare"].mockReturnValue(result);
    const { respond } = await invoke(method, params);
    if (!held) {
      expect(coordinator.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ ...params, terminalPolicy: "preserve" }),
      );
    }
    expect(respond).toHaveBeenCalledWith(true, result);
  });

  it("keeps resume idempotent and rejects a mismatched active lease", async () => {
    coordinator.resume.mockReturnValueOnce({ ok: false, reason: "suspension-mismatch" });
    const mismatch = await invoke("gateway.suspend.resume", {
      suspensionId: "suspension-wrong",
    });
    expect(mismatch.respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "gateway suspension id does not match",
    });

    const result = { ok: true, status: "running", resumed: false };
    coordinator.resume.mockReturnValueOnce(result);
    const resumed = await invoke("gateway.suspend.resume", { suspensionId: "suspension-1" });
    expect(resumed.respond).toHaveBeenCalledWith(true, result);
  });
});
