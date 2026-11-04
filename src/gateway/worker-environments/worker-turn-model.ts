import { WORKER_LOCAL_INFERENCE_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInferenceModelRef } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  loadManifestModelCatalog,
  overlayConfiguredModelCatalog,
} from "../../agents/model-catalog.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { resolveProviderThinkingLevel } from "../../auto-reply/thinking.js";
import { resolveApprovedWorkerLocalModel, resolveApprovedWorkerModel } from "./inference-model.js";
import { executePreparedWorkerInference } from "./inference-runtime.js";
import { boundedWorkerError } from "./worker-error.js";

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

/** Worker-local model and protocol admission precedes workspace or inference effects. */
export function assertWorkerLocalModelAdmission(params: {
  turn: Pick<SessionPlacementTurnParams, "config">;
  modelRef: WorkerInferenceModelRef;
  agentId: string;
  nodeDeviceId: string | null;
  protocolFeatures: readonly string[];
}) {
  const policy = createModelVisibilityPolicy({
    cfg: params.turn.config ?? {},
    catalog: [],
    defaultProvider: params.modelRef.provider,
    agentId: params.agentId,
  });
  if (!policy.allows(params.modelRef)) {
    throw new Error(
      `Worker-local inference cannot use ${params.modelRef.provider}/${params.modelRef.model} for agent ` +
        `${params.agentId}. Allow that model in the agent model policy or choose an allowed model.`,
    );
  }
  if (!params.nodeDeviceId) {
    throw new Error(
      "Worker-local inference requires a paired device profile. Set " +
        "cloudWorkers.profiles.<id>.settings.device to a connected node.",
    );
  }
  if (!params.protocolFeatures.includes(WORKER_LOCAL_INFERENCE_PROTOCOL_FEATURE)) {
    throw new Error(
      `Worker-local inference is unavailable on paired device ${params.nodeDeviceId}. ` +
        "Update and restart its OpenClaw node host, use a non-Windows host with " +
        'nodeHost.workerRuns.isolation set to "none", and configure a compatible ' +
        "models.providers model with a usable node-local credential.",
    );
  }
}
