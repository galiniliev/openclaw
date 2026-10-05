import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, type Mock } from "vitest";
import { prepareGoalRecoveryNativeFixture } from "../../gateway/server-methods/session-goal-recovery-native.test-support.js";
import { prepareRepositoryWorkerProjectSource } from "../../gateway/worker-environments/repository-project-admission.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { buildRunUserTurnIdempotencyKey } from "../../sessions/user-turn-transcript.js";
import { makeAttemptResult } from "../embedded-agent-runner/run.overflow-compaction.fixture.js";
import type { AgentHarnessV2 } from "../harness/types.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import type { installFactoryRestartRepositoryFixture } from "./main-session-recovery-factory-read.test-support.js";
import {
  type createOriginalIssuerFixture,
  readIssuerFixtureHistory,
} from "./main-session-recovery-original-issuer.test-support.js";

export async function prepareQueuedNativeRecoveryFixture(params: {
  first: Awaited<ReturnType<typeof createOriginalIssuerFixture>>;
  target: { agentId: string; sessionKey: string };
  sessionId: string;
  workerRoot: string;
  nativeAttempt: Mock<AgentHarnessV2["runAttempt"]>;
  requests: readonly { runId: string; text: string }[];
  issuers: readonly Awaited<ReturnType<typeof createOriginalIssuerFixture>>[];
  effects: Array<{ runId: string; profileId: string; body: string }>;
  executionIndexes: readonly number[];
  onCompleted: () => void;
  getBrokerContext: () => Awaited<ReturnType<typeof createOriginalIssuerFixture>>["context"];
  repositoryProof: ReturnType<typeof installFactoryRestartRepositoryFixture>;
}) {
  const originalIssuers = params.issuers.map((issuer) =>
    expectDefined(
      issuer.original!.authority.captureRestartRecoveryIssuer?.(),
      "original accepted queued issuer basis",
    ),
  );
  await fs.mkdir(params.workerRoot, { recursive: true });
  const native = await prepareGoalRecoveryNativeFixture(
    params.first,
    params.target,
    params.sessionId,
    params.workerRoot,
    true,
    false,
    params.repositoryProof,
  );
  params.nativeAttempt.mockImplementation(async (attempt) => {
    const index = expectDefined(
      params.executionIndexes[params.effects.length],
      "next accepted FIFO index",
    );
    const issuer = expectDefined(params.issuers[index], "original queued issuer");
    const accepted = expectDefined(params.requests[index], "original accepted queued input");
    const scope = expectDefined(getPluginRuntimeGatewayRequestScope(), "native queued scope");
    const authority = expectDefined(
      getGatewayToolCallerIdentity()?.operatorAuthority ??
        scope.client?.internal?.operatorRunAuthority,
      "original queued native authority",
    );
    expect(authority.profileId).toBe(issuer.profile.id);
    expect(authority.scopes).toEqual(["operator.read", "operator.write"]);
    expect(authority.captureRestartRecoveryIssuer?.()).toEqual(originalIssuers[index]);
    expect(authority.modelPolicy?.allows({ provider: "openai", model: "allowed" })).toBe(true);
    expect(authority.modelPolicy?.allows({ provider: "openai", model: "other" })).toBe(false);
    expect(attempt.provider).toBe("openai");
    expect(attempt.modelId).toBe("allowed");
    expect(attempt.sessionId).toBe(params.sessionId);
    expect(attempt.sessionKey).toBe(params.target.sessionKey);
    if (index > 0) {
      expect(attempt.runId).toBe(accepted.runId);
      expect(attempt.prompt).toContain(accepted.text);
    }
    const assertNativeCurrent = expectDefined(
      scope.assertNodeExecutionCurrent,
      "native queued effect guard",
    );
    expect(native.placements.get(params.sessionId)).toMatchObject({
      state: "active",
      executionMode: "remote-exec",
      turnClaim: { runId: attempt.runId },
    });
    const request = {
      runId: attempt.runId,
      agentId: params.target.agentId,
      nodeId: native.environment.nodeDeviceId!,
      workspace: {
        workspaceDir: native.remoteWorkspaceDir,
        environmentId: native.environment.environmentId,
        ownerEpoch: native.environment.ownerEpoch,
        sessionId: params.sessionId,
        sessionKey: params.target.sessionKey,
      },
    };
    const assertCurrent = () => {
      authority.assertCurrent();
      assertNativeCurrent(request);
    };
    assertCurrent();
    const readNativeCredential = expectDefined(
      authority.createFactoryGitHubDispatchCredentialReader,
      "original queued dispatch reader",
    )({
      ...params.target,
      sessionId: params.sessionId,
      repositoryUrl: native.repository.url,
      assertCurrent,
    });
    const source = await prepareRepositoryWorkerProjectSource({
      namespace: "native-queued-original",
      repository: { agentId: params.target.agentId, url: native.repository.url, ref: "main" },
      getConfig: params.getBrokerContext().getRuntimeConfig,
      assertCurrent,
      readNativeCredential,
    });
    expect(source.project.source.url).toBe(native.repository.url);
    assertCurrent();
    const history = await readIssuerFixtureHistory(params.target, params.sessionId);
    expect(
      history.filter(
        (message) =>
          isRecord(message) &&
          message.idempotencyKey === buildRunUserTurnIdempotencyKey(accepted.runId),
      ),
    ).toEqual([expect.objectContaining({ role: "user", content: accepted.text })]);
    assertCurrent();
    const tunnel = await expectDefined(
      native.environments.startTunnel,
      "current native transport",
    )({
      environmentId: native.environment.environmentId,
      ownerEpoch: native.environment.ownerEpoch,
    });
    assertCurrent();
    const result = await tunnel.runWorkspaceCommand({
      argv: [
        "node",
        "-e",
        "process.stdout.write(require('node:fs').readFileSync('accepted.txt', 'utf8'))",
      ],
      timeoutMs: 10_000,
      transportRetry: "never",
      assertCurrent,
    });
    assertCurrent();
    expect(result).toMatchObject({ code: 0, stdout: "accepted marker" });
    params.effects.push({
      runId: attempt.runId,
      profileId: authority.profileId,
      body: accepted.text,
    });
    if (params.effects.length === params.executionIndexes.length) {
      params.onCompleted();
    }
    return makeAttemptResult({
      terminal: { kind: "ok" },
      sessionIdUsed: params.sessionId,
      agentHarnessId: "codex",
      assistantTexts: ["Accepted native queued input completed"],
      lastAssistant: makeAgentAssistantMessage({
        content: [{ type: "text", text: "Accepted native queued input completed" }],
        timestamp: Date.now(),
      }),
    });
  });
  return native;
}
