import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { readAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { prepareCoreToolPolicy } from "../../agents/prepared-tool-surface.js";
import { createToolSurfacePresentationForTest } from "../../agents/tool-surface-plan.test-support.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import { withoutGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { createAccountCronScheduledToolPolicy } from "../../cron/scheduled-tool-policy.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { revokeCronCreatorAuthorityRunScope } from "../cron-creator-authority-grant.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import {
  createOperatorRecoveryFixture,
  pairedOperator,
} from "../operator-run-recovery.test-support.js";
import {
  admission,
  cfg,
  CREATOR,
  createCronFixture,
  inRun,
  installRequesterCronAuthorityTestHooks,
  SESSION,
  SESSION_ID,
  stateDir,
} from "../server-methods/requester-cron-authority.test-support.js";
import { createWorkerConnectionIdentity } from "./connection-identity.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { bindWorkerTurnCapabilities, bindWorkerTurnOwner } from "./placement-turn-claim-events.js";
import { createWorkerGatewayToolRuntime } from "./worker-gateway-tool-runtime.js";
import { createWorkerGatewayTools } from "./worker-session-tool-executor.js";

installRequesterCronAuthorityTestHooks();

it.each(["admin-owner", "revoked", "nonadmin", "wrong-run"] as const)(
  "binds through worker construction only for its live admitted owner (%s)",
  async (authorityState) => {
    const config = { ...cfg, tools: { allow: [AUTOMATIONS_TOOL_NAME] } };
    const fixture = createCronFixture(undefined, config);
    const { context } = fixture;
    context.resolveGatewayContext = () => context;
    const profile = ensureProfileForEmail("worker-cron-owner@example.test");
    const recovery = await createOperatorRecoveryFixture({
      stateDir,
      context,
      config,
      profileId: profile.id,
      sessionKey: SESSION,
      sessionId: SESSION_ID,
      device: pairedOperator(),
      ...(authorityState === "nonadmin" ? { scopes: ["operator.write"] } : {}),
    });
    const created = await context.cron.add(
      {
        name: "Retained worker monitoring",
        enabled: true,
        agentId: "main",
        owner: { agentId: "main", sessionKey: SESSION, accountId: "default" },
        schedule: { kind: "every", everyMs: 75 * 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Check the deployment", toolsAllow: ["read"] },
        delivery: { mode: "none" },
      },
      {
        createdActor: CREATOR,
        scheduledToolPolicy: createAccountCronScheduledToolPolicy({
          ownerSessionKey: SESSION,
          ownerAccountId: "default",
        }),
      },
    );
    const job = "job" in created ? created.job : created;
    const database = openOpenClawStateDatabase();
    const placements = createWorkerSessionPlacementStore({ database });
    const source = { agentId: "main", sessionId: SESSION_ID, sessionKey: SESSION };
    const environmentId = "worker-cron-environment";
    const ownerEpoch = 3;
    await advancePlacementFixtureToActive(placements, database, source, {
      environmentId,
      ownerEpoch,
    });
    context.validateAgentRuntimeApprovalAuthority =
      createAgentRuntimeApprovalAuthorityValidator(placements);
    const runId = "worker-cron-owner-run";
    const claim = await placements.claimTurn({
      ...source,
      runId,
      claimId: "worker-cron-claim",
      owner: { kind: "worker", environmentId, ownerEpoch },
    });
    await placements.authorizeWorkerTurnTools(claim, [AUTOMATIONS_TOOL_NAME]);
    const original = expectDefined(
      await captureGatewayOperatorRunAuthority({
        client: recovery.client,
        context,
        sourceAuthority: null,
      }),
      "authenticated operator",
    );
    try {
      await withPluginRuntimeGatewayRequestScope(
        { client: recovery.client, context, isWebchatConnect: () => false },
        () =>
          inRun(
            runId,
            admission(runId, recovery.client),
            async (_identity, admitted, cronCapability) => {
              await bindWorkerTurnOwner(
                placements,
                claim,
                admitted.executionIdentityToken,
                admitted.operationalRunInstance,
                {
                  ...source,
                  storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
                },
                () => original.authority.assertCurrent(),
                undefined,
                readAdmittedRunOperatorAuthority(admitted),
              );
              const identity = createWorkerConnectionIdentity(claim, {
                credentialExpiresAtMs: Date.now() + 60_000,
              });
              const runtime = createWorkerGatewayToolRuntime({
                signal: new AbortController().signal,
                assertCurrent: () => {},
                prepare: async () => ({
                  policy: prepareCoreToolPolicy(config),
                  presentation: createToolSurfacePresentationForTest(),
                  tools: await createWorkerGatewayTools({
                    identity,
                    placements,
                    resolveGatewayContext: () => context,
                    environments: { get: () => undefined },
                    dispatchChild: vi.fn(),
                    waitForInitialPlacement: vi.fn(),
                    portals: {
                      getService: () => undefined,
                      carrier: { open: vi.fn() },
                      onChanged: vi.fn(),
                    },
                    prepareTools: () => [
                      createCronTool({
                        config,
                        agentId: "main",
                        agentSessionKey: SESSION,
                        runId: authorityState === "wrong-run" ? "another-run" : runId,
                      }),
                    ],
                  }),
                }),
              });
              bindWorkerTurnCapabilities(placements, claim, { toolSurface: runtime });
              try {
                // Placement intentionally clears the launching caller. Construction and invocation
                // must recover the same admitted worker owner, rather than borrowing that caller.
                await withoutGatewayToolCallerIdentity(async () => {
                  const surface = await runtime.getSurface(identity);
                  const tool = expectDefined(
                    surface.tools.find((entry) => entry.definition.name === AUTOMATIONS_TOOL_NAME),
                    "worker automations tool",
                  );
                  if (authorityState === "revoked") {
                    revokeCronCreatorAuthorityRunScope(expectDefined(cronCapability, "cron scope"));
                  }
                  const result = await runtime.invoke(
                    identity,
                    {
                      generation: surface.generation,
                      toolId: tool.id,
                      toolCallId: "bind-from-worker",
                      arguments: { action: "bind", jobId: job.id },
                    },
                    { send: () => {} },
                  );
                  if (authorityState === "admin-owner") {
                    expect(result, JSON.stringify(result)).toMatchObject({
                      details: { id: job.id, bound: { operatorSource: true } },
                    });
                  } else {
                    expect(result).toMatchObject({ isError: true, details: { status: "error" } });
                  }
                });
              } finally {
                await runtime.close();
              }
            },
            original.authority,
          ),
      );
      const stored = expectDefined(
        (await fixture.read()).find((value) => value.id === job.id),
        "job",
      );
      expect(stored.sourceConversation).toEqual(
        authorityState === "admin-owner"
          ? {
              sessionKey: SESSION,
              sessionId: SESSION_ID,
              lifecycleRevision: recovery.entry.lifecycleRevision,
            }
          : undefined,
      );
      expect(stored.createdActor).toEqual(CREATOR);
      expect(stored.schedule).toEqual(job.schedule);
      expect(stored.payload).toEqual(job.payload);
    } finally {
      await placements.closeWorkerTurnToolState(claim);
      await placements.releaseTurn(claim);
      original.release();
    }
  },
);
