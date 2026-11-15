import { WORKER_LOCAL_INFERENCE_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInferenceModelRef } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { OPENCLAW_AGENT_RUNTIME_ID } from "../../agents/agent-runtime-id.js";
import {
  loadManifestModelCatalog,
  overlayConfiguredModelCatalog,
} from "../../agents/model-catalog.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import type { PreparedModelRuntimeLeaseOptions } from "../../agents/prepared-model-runtime.types.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { resolveProviderThinkingLevel } from "../../auto-reply/thinking.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentBootstrapReceipt,
} from "./environment-record.js";
import { resolveApprovedWorkerLocalModel, resolveApprovedWorkerModel } from "./inference-model.js";
import { workerInferencePlacement } from "./inference-placement.js";
import { executePreparedWorkerInference } from "./inference-runtime.js";
import { boundedWorkerError } from "./worker-error.js";
import { assertSupportedTurn } from "./worker-turn-payload.js";

/** Reacquires the admitted runtime, which may be a generation derived for this turn's model. */
export function workerTurnRuntimeLeaseOptions(
  turn: SessionPlacementTurnParams,
): PreparedModelRuntimeLeaseOptions {
  return {
    pluginGeneration: turn.pluginGeneration,
    abortSignal: turn.abortSignal,
    deriveRuntimePluginSelections: ({ config }) => {
      const { provider, model } = assertSupportedTurn({ ...turn, config });
      return [{ provider, modelId: model, runtime: OPENCLAW_AGENT_RUNTIME_ID }];
    },
  };
}

/** Validate model policy and node capability at the worker-local inference boundary. */
export function resolveWorkerTurnInferencePlacement(params: {
  environment: WorkerEnvironmentRecord;
  bootstrapReceipt: WorkerEnvironmentBootstrapReceipt;
  modelRef: WorkerInferenceModelRef;
  config: SessionPlacementTurnParams["config"];
  agentId: string;
}): "gateway" | "worker" {
  const { environment, bootstrapReceipt, modelRef, config, agentId } = params;
  const inferencePlacement = workerInferencePlacement(environment);
  if (inferencePlacement === "worker") {
    const policy = createModelVisibilityPolicy({
      cfg: config ?? {},
      catalog: [],
      defaultProvider: modelRef.provider,
      agentId,
    });
    if (!policy.allows(modelRef)) {
      throw new Error(
        `Worker-local inference cannot use ${modelRef.provider}/${modelRef.model} for agent ` +
          `${agentId}. Allow that model in the agent model policy or choose an allowed model.`,
      );
    }
    if (!environment.nodeDeviceId) {
      throw new Error(
        "Worker-local inference requires a paired device profile. Set " +
          "cloudWorkers.profiles.<id>.settings.device to a connected node.",
      );
    }
    if (!bootstrapReceipt.protocolFeatures.includes(WORKER_LOCAL_INFERENCE_PROTOCOL_FEATURE)) {
      throw new Error(
        `Worker-local inference is unavailable on paired device ${environment.nodeDeviceId}. ` +
          "Update and restart its OpenClaw node host, use a non-Windows host with " +
          'nodeHost.workerRuns.isolation set to "none", and configure a compatible ' +
          "models.providers model with a usable node-local credential.",
      );
    }
  }
  return inferencePlacement;
}

export async function prepareWorkerTurnModel(params: {
  target: BoundAgentRunSessionTarget;
  modelRef: WorkerInferenceModelRef;
  runtimeSnapshot: PreparedModelRuntimeSnapshot;
  inferencePlacement: "gateway" | "worker";
  turn: Pick<SessionPlacementTurnParams, "abortSignal" | "config" | "workspaceDir" | "thinkLevel">;
  assertCurrent: () => void;
}) {
  const resolveModel =
    params.inferencePlacement === "worker"
      ? resolveApprovedWorkerLocalModel
      : resolveApprovedWorkerModel;
  const approved = await resolveModel({
    target: params.target,
    modelRef: params.modelRef,
    runtimeSnapshot: params.runtimeSnapshot,
    signal: params.turn.abortSignal,
    assertCurrent: params.assertCurrent,
  });
  if (!approved) {
    throw new Error("Worker model is not approved for this session");
  }
  if ("error" in approved) {
    throw new Error(boundedWorkerError(approved.error, 256));
  }
  const model = "prepared" in approved ? approved.prepared.model : approved.model;
  const reasoning = resolveProviderThinkingLevel({
    provider: params.modelRef.provider,
    model: params.modelRef.model,
    catalog:
      params.turn.thinkLevel === "ultra"
        ? overlayConfiguredModelCatalog({
            catalog: loadManifestModelCatalog({
              config: params.turn.config ?? {},
              workspaceDir: params.turn.workspaceDir,
            }),
            config: params.turn.config ?? {},
            workspaceDir: params.turn.workspaceDir,
          })
        : undefined,
    agentRuntime: "openclaw",
    level: params.turn.thinkLevel,
  });
  return {
    model,
    reasoning,
    transcriptPolicy: approved.transcriptPolicy,
    inference:
      "prepared" in approved ? executePreparedWorkerInference.bind(undefined, approved) : undefined,
  };
}
