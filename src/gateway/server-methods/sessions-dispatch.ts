import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsDispatchParams,
  validateSessionsMoveParams,
  validateSessionsReclaimParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { factoryGitHubDispatchCredentialReader } from "../factory-github-proof.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicy,
} from "../operator-role-policy.js";
import { prepareSessionCreatorProfile } from "../session-creator.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { resolveDevicePlacementEligibility } from "../worker-environments/device-placement-eligibility.js";
import { selectDevicePlacementCandidates } from "../worker-environments/device-placement-selector.js";
import { DEVICE_WORKER_PROVIDER_ID } from "../worker-environments/device-provider-identity.js";
import { deviceUnavailableText } from "../worker-environments/device-provider.js";
import {
  resolveProjectProfileDestination,
  resolveWorkerPlacementDestination,
} from "../worker-environments/placement-destination.js";
import { canRetryDeviceDispatch } from "../worker-environments/placement-dispatch-failure.js";
import { readWorkerPlacementIdentity } from "../worker-environments/placement-projector.js";
import {
  isForceAbandonedWorkerPlacement,
  type WorkerSessionPlacementRecord,
} from "../worker-environments/placement-record.js";
import {
  resolveWorkerPlacementCapabilities,
  resolveWorkerPlacementSessionRuntime,
} from "../worker-environments/placement-session-runtime.js";
import { isFailedWorkerPlacementEnvironmentGone } from "../worker-environments/placement-target.js";
import { listGatewayEnvironments } from "./environments.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  resolveSessionWorkspace,
  respondInvalidWorkerSession,
} from "./sessions-dispatch-workspace.js";
import {
  respondWorkerPlacement,
  respondWorkerDispatchError,
} from "./sessions-placement-response.js";
import { loadAccessorSessionEntryForGatewayTarget, requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const MAX_AUTO_DEVICE_PLACEMENT_ATTEMPTS = 3;

function resolveWorkerSessionTarget(params: {
  key: string;
  agentId?: string;
  profileId?: string;
  deviceId?: string;
  machineClass?: string;
  os?: string;
  context: GatewayRequestContext;
  respond: RespondFn;
}) {
  const cfg = params.context.getRuntimeConfig();
  const requestedAgent = resolveRequestedGlobalAgentId(cfg, params.key, params.agentId);
  if (!requestedAgent.ok) {
    params.respond(false, undefined, requestedAgent.error);
    return undefined;
  }
  const destination = resolveWorkerPlacementDestination({
    cfg,
    profileId: params.profileId,
    deviceId: params.deviceId,
    machineClass: params.machineClass,
    os: params.os,
  });
  if (!destination.ok) {
    respondInvalidWorkerSession(params.respond, destination.error);
    return undefined;
  }
  const target = loadAccessorSessionEntryForGatewayTarget({
    key: params.key,
    cfg,
    agentId: requestedAgent.agentId,
  });
  const entry = target.entry;
  const sessionId = normalizeOptionalString(entry?.sessionId);
  if (!entry || !sessionId) {
    respondInvalidWorkerSession(params.respond, `session not found: ${params.key}`);
    return undefined;
  }
  return { cfg, target, entry, sessionId, dispatchTarget: destination.value };
}

async function validateDispatchExecutionMode(params: {
  context: GatewayRequestContext;
  executionMode: "worker-turn" | "remote-exec";
  sessionRuntime: string;
  devicePlacement: ReturnType<typeof resolveWorkerPlacementCapabilities>["devicePlacement"];
  target: { profileId: string; deviceId?: string };
  respond: RespondFn;
}): Promise<boolean> {
  if (params.target.deviceId !== undefined) {
    const eligibility = await resolveDevicePlacementEligibility({
      environmentService: params.context.workerEnvironmentService,
      deviceId: params.target.deviceId,
      runtimeId: params.sessionRuntime,
      executionMode: params.executionMode,
      requirement: params.devicePlacement,
      config: params.context.getRuntimeConfig(),
      currentNode: params.context.nodeRegistry?.get?.(params.target.deviceId),
    });
    if (eligibility.ok) {
      return true;
    }
    respondInvalidWorkerSession(params.respond, eligibility.error);
    return false;
  }
  const environmentService = params.context.workerEnvironmentService;
  if (environmentService?.supportsExecutionMode(params.target.profileId, params.executionMode)) {
    return true;
  }
  respondInvalidWorkerSession(
    params.respond,
    `runtime ${params.sessionRuntime} requires a cloud worker provider that supports ${params.executionMode}; choose a compatible provider, or select an agent/model route with agentRuntime.id "openclaw"`,
  );
  return false;
}

export const sessionDispatchHandlers: GatewayRequestHandlers = {
  "sessions.dispatch": async ({
    params,
    respond,
    context,
    client,
    signal,
    sessionMutationAuthorization,
  }) => {
    if (
      params.autoDevice === true &&
      (params.profileId !== undefined || params.deviceId !== undefined)
    ) {
      respondInvalidWorkerSession(
        respond,
        "choose exactly one dispatch target: autoDevice, deviceId, or profileId",
      );
      return;
    }
    if (!assertValidParams(params, validateSessionsDispatchParams, "sessions.dispatch", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const dispatchService = context.workerPlacementDispatchService;
    const placementReader = context.workerSessionPlacementService;
    if (!dispatchService || !placementReader) {
      respondInvalidWorkerSession(respond, "cloud worker dispatch is not configured");
      return;
    }
    const resolved = resolveWorkerSessionTarget({
      key,
      agentId: params.agentId,
      profileId: params.profileId,
      deviceId: params.deviceId,
      machineClass: params.machineClass,
      os: params.os,
      context,
      respond,
    });
    if (!resolved) {
      return;
    }
    const { cfg, target, entry, sessionId } = resolved;
    const runSetupScript = client?.connect?.scopes?.includes(ADMIN_SCOPE) === true;
    const cloudProfileAllowed = () => {
      const currentConfig = context.getRuntimeConfig();
      const role = resolveOperatorRolePolicy(client ?? null, currentConfig);
      const administrator =
        (!currentConfig.gateway?.roles && !client) ||
        (client?.connect?.scopes?.includes(ADMIN_SCOPE) === true &&
          (!role || role.scopes.includes(ADMIN_SCOPE)));
      if (runSetupScript && !administrator) {
        return false;
      }
      if (administrator || params.deviceId !== undefined || params.autoDevice === true) {
        return true;
      }
      const actor = resolveGatewayOperatorRoleActor(client);
      return (
        actor?.kind === "operator" &&
        Boolean(params.profileId && role?.workerProfiles?.includes(params.profileId)) &&
        prepareSessionCreatorProfile(
          actor.profileId,
          client?.preparedSessionProfile?.aliases,
        )(entry.createdActor)
      );
    };
    const profileAccessError = () =>
      errorShape(ErrorCodes.FORBIDDEN, "Your operator role cannot dispatch to this Cloud profile.");
    if (!cloudProfileAllowed()) {
      respond(false, undefined, profileAccessError());
      return;
    }
    const authorizeDispatch = () => {
      sessionMutationAuthorization?.assertCurrent();
      if (!cloudProfileAllowed()) {
        throw new SessionMutationAuthorizationChangedError(profileAccessError());
      }
    };
    let { dispatchTarget } = resolved;
    const autoDevice = params.autoDevice === true;
    const canUseProjectProfile =
      !autoDevice && params.profileId === undefined && params.deviceId === undefined;
    if (!dispatchTarget && !canUseProjectProfile && !autoDevice) {
      respondInvalidWorkerSession(respond, "worker dispatch target is missing");
      return;
    }
    if (entry.archivedAt !== undefined) {
      respondInvalidWorkerSession(respond, "cannot dispatch an archived session");
      return;
    }
    const sessionRuntime = resolveWorkerPlacementSessionRuntime({
      cfg,
      entry,
      agentId: target.target.agentId,
      sessionKey: target.canonicalKey,
    });
    const { executionMode, devicePlacement } = resolveWorkerPlacementCapabilities(sessionRuntime);
    if (!executionMode) {
      respondInvalidWorkerSession(
        respond,
        `runtime ${sessionRuntime} lacks cloud placement support`,
      );
      return;
    }
    let automaticDeviceIds: string[] = [];
    if (autoDevice) {
      const selection = await selectDevicePlacementCandidates({
        environments: await listGatewayEnvironments(context),
        nodeRegistry: context.nodeRegistry,
        environmentService: context.workerEnvironmentService,
        requirement: devicePlacement,
        runtimeId: sessionRuntime,
        executionMode,
        config: cfg,
        getPendingDispatchCount: (deviceId) =>
          dispatchService.getPendingDeviceDispatchCount?.(deviceId, sessionId) ?? 0,
        getAdmittedSessionCounts: () => dispatchService.getAdmittedDeviceSessionCounts?.(sessionId),
      });
      if (!selection.ok) {
        respondInvalidWorkerSession(respond, selection.error);
        return;
      }
      automaticDeviceIds = selection.candidates
        .slice(0, MAX_AUTO_DEVICE_PLACEMENT_ATTEMPTS)
        .map(({ deviceId }) => deviceId);
      const destination = resolveWorkerPlacementDestination({
        cfg,
        deviceId: automaticDeviceIds[0],
      });
      if (!destination.ok || !destination.value) {
        respondInvalidWorkerSession(
          respond,
          destination.ok ? "automatic device placement did not select a node" : destination.error,
        );
        return;
      }
      dispatchTarget = destination.value;
    }
    if (
      !autoDevice &&
      dispatchTarget &&
      !(await validateDispatchExecutionMode({
        context,
        executionMode,
        sessionRuntime,
        devicePlacement,
        target: dispatchTarget,
        respond,
      }))
    ) {
      return;
    }
    const existingPlacement = placementReader.getMany([sessionId]).get(sessionId);
    if (
      existingPlacement?.state === "failed" &&
      context.workerPlacementDispatchService?.canRecoverFailedPlacement?.(existingPlacement) !==
        true &&
      !isFailedWorkerPlacementEnvironmentGone({
        environmentService: context.workerEnvironmentService,
        placement: existingPlacement,
      })
    ) {
      let providerId: string | undefined;
      try {
        const identity = readWorkerPlacementIdentity(
          existingPlacement,
          context.workerEnvironmentService,
        );
        providerId = identity?.providerId;
      } catch {
        // Missing inventory proof must retain the refusal even when its label is unknown.
      }
      respondInvalidWorkerSession(
        respond,
        providerId === DEVICE_WORKER_PROVIDER_ID
          ? "device worker placement must be abandoned before redispatch; use Continue on Gateway"
          : "cloud worker environment must be stopped before redispatch; use Stop cloud worker",
      );
      return;
    }
    if (
      existingPlacement &&
      (existingPlacement.state === "active" ||
        existingPlacement.state === "draining" ||
        existingPlacement.state === "reconciling")
    ) {
      respondInvalidWorkerSession(
        respond,
        `session cannot dispatch from placement ${existingPlacement.state}`,
      );
      return;
    }
    const workspace = await resolveSessionWorkspace({
      entry,
      sessionKey: target.canonicalKey,
      agentId: target.target.agentId,
      method: "sessions.dispatch",
      respond,
    });
    if (!workspace) {
      return;
    }
    const readNativeCredential = factoryGitHubDispatchCredentialReader({
      client,
      agentId: target.target.agentId,
      sessionKey: target.canonicalKey,
      sessionId,
      repositoryUrl: workspace.kind === "repository" ? workspace.repository.url : undefined,
      assertCurrent: () => {
        signal?.throwIfAborted();
        sessionMutationAuthorization?.assertCurrent();
      },
    });
    if (!dispatchTarget && canUseProjectProfile) {
      try {
        dispatchTarget = await resolveProjectProfileDestination({ cfg, workspace });
      } catch (error) {
        respondWorkerDispatchError(error, respond);
        return;
      }
    }
    if (!dispatchTarget) {
      respondInvalidWorkerSession(respond, "worker dispatch target is missing");
      return;
    }
    if (
      canUseProjectProfile &&
      !(await validateDispatchExecutionMode({
        context,
        executionMode,
        sessionRuntime,
        devicePlacement,
        target: dispatchTarget,
        respond,
      }))
    ) {
      return;
    }
    let lastEligibilityError: string | undefined;
    const candidates = autoDevice ? automaticDeviceIds : [dispatchTarget.deviceId];
    for (let attempt = 0; attempt < candidates.length; attempt += 1) {
      if (attempt > 0) {
        const destination = resolveWorkerPlacementDestination({
          cfg,
          deviceId: candidates[attempt],
        });
        if (!destination.ok || !destination.value) {
          respondInvalidWorkerSession(
            respond,
            destination.ok ? "automatic device placement did not select a node" : destination.error,
          );
          return;
        }
        dispatchTarget = destination.value;
      }
      if (autoDevice) {
        const eligibility = await resolveDevicePlacementEligibility({
          environmentService: context.workerEnvironmentService,
          deviceId: candidates[attempt]!,
          runtimeId: sessionRuntime,
          executionMode,
          requirement: devicePlacement,
          config: cfg,
          currentNode: context.nodeRegistry.get(candidates[attempt]!),
        });
        if (!eligibility.ok) {
          lastEligibilityError = eligibility.error;
          continue;
        }
        // Recheck after asynchronous eligibility, before dispatch registers its pending owner.
        if (
          devicePlacement?.consumesWorkerSlot &&
          eligibility.availableSlots <=
            (dispatchService.getPendingDeviceDispatchCount?.(candidates[attempt]!, sessionId) ?? 0)
        ) {
          lastEligibilityError = deviceUnavailableText(candidates[attempt]!, {
            available: false,
            unavailableReason: "at-capacity",
          });
          continue;
        }
      }
      let attemptedPlacement: WorkerSessionPlacementRecord | undefined;
      try {
        authorizeDispatch();
        const placement = await dispatchService.dispatch(
          {
            sessionId,
            sessionKey: target.canonicalKey,
            agentId: target.target.agentId,
            executionMode,
            runSetupScript,
            ...(readNativeCredential ? { readNativeCredential } : {}),
            ...dispatchTarget,
            ...(devicePlacement ? { devicePlacement } : {}),
          },
          (observed) => {
            attemptedPlacement = { ...observed };
            emitSessionsChanged(context, {
              reason: "dispatch",
              sessionKey: target.canonicalKey,
            });
          },
          authorizeDispatch,
          signal,
        );
        respondWorkerPlacement({
          respond,
          key: target.canonicalKey,
          sessionId,
          context,
          placement,
        });
        return;
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          throw error;
        }
        if (!autoDevice || !dispatchTarget.deviceId) {
          respondWorkerDispatchError(error, respond);
          return;
        }
        const failedPlacement = placementReader.getMany([sessionId]).get(sessionId);
        if (
          !canRetryDeviceDispatch({
            error,
            deviceId: dispatchTarget.deviceId,
            sessionId,
            sessionKey: target.canonicalKey,
            agentId: target.target.agentId,
            attempted: attemptedPlacement,
            current: failedPlacement,
            environments: context.workerEnvironmentService,
          })
        ) {
          respondWorkerDispatchError(error, respond);
          return;
        }
        lastEligibilityError = formatErrorMessage(error);
      }
    }
    respondWorkerDispatchError(
      new Error(
        `automatic device placement failed after ${candidates.length} attempts; ${lastEligibilityError ?? "no eligible host remains; reconnect a paired session-host node and retry"}`,
      ),
      respond,
    );
  },
  "sessions.move": async ({ params, respond, context, client, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsMoveParams, "sessions.move", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const placementService = context.workerPlacementDispatchService;
    const placementReader = context.workerSessionPlacementService;
    if (!placementService?.move || !placementReader) {
      respondInvalidWorkerSession(respond, "session placement move is not configured");
      return;
    }
    const resolved = resolveWorkerSessionTarget({
      key,
      agentId: params.agentId,
      context,
      respond,
    });
    if (!resolved) {
      return;
    }
    const { target, entry, sessionId } = resolved;
    if (entry.archivedAt !== undefined) {
      respondInvalidWorkerSession(respond, "cannot move an archived session");
      return;
    }
    const existingPlacement = placementReader.getMany([sessionId]).get(sessionId);
    const retryAbandonment =
      "abandonSource" in params && isForceAbandonedWorkerPlacement(existingPlacement);
    if (
      existingPlacement?.state !== "active" &&
      existingPlacement?.state !== "draining" &&
      !retryAbandonment
    ) {
      respondInvalidWorkerSession(
        respond,
        `session cannot move from placement ${existingPlacement?.state ?? "local"}`,
      );
      return;
    }
    const workspace = await resolveSessionWorkspace({
      entry,
      sessionKey: target.canonicalKey,
      agentId: target.target.agentId,
      method: "sessions.move",
      respond,
    });
    if (!workspace) {
      return;
    }
    try {
      const placement = await placementService.move(
        {
          sessionId,
          sessionKey: target.canonicalKey,
          agentId: target.target.agentId,
          source: params.expected,
          target: params.target,
          readNativeCredential: factoryGitHubDispatchCredentialReader({
            client,
            sessionId,
            sessionKey: target.canonicalKey,
            agentId: target.target.agentId,
            repositoryUrl: workspace.kind === "repository" ? workspace.repository.url : undefined,
            assertCurrent: () => sessionMutationAuthorization?.assertCurrent(),
          }),
          ...("abandonSource" in params ? { abandonSource: true } : {}),
        },
        () =>
          emitSessionsChanged(context, {
            reason: "move",
            sessionKey: target.canonicalKey,
          }),
        sessionMutationAuthorization?.assertCurrent,
      );
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          sessionId,
          placement: { state: placement.state, generation: placement.generation },
        },
        undefined,
      );
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      try {
        emitSessionsChanged(context, { reason: "move", sessionKey: target.canonicalKey });
      } catch {
        // Reporting cannot replace the placement owner's failure response.
      }
      respondWorkerDispatchError(error, respond);
    }
  },
  "sessions.reclaim": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
    if (!assertValidParams(params, validateSessionsReclaimParams, "sessions.reclaim", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const placementService = context.workerPlacementDispatchService;
    const placementReader = context.workerSessionPlacementService;
    if (!placementService?.reclaim || !placementReader) {
      respondInvalidWorkerSession(respond, "cloud worker stop is not configured");
      return;
    }
    const resolved = resolveWorkerSessionTarget({
      key,
      agentId: params.agentId,
      context,
      respond,
    });
    if (!resolved) {
      return;
    }
    const { target, entry, sessionId } = resolved;
    const existingPlacement = placementReader.getMany([sessionId]).get(sessionId);
    const reportPlacementChange = (placement: WorkerSessionPlacementRecord | undefined): void => {
      if (
        !placement ||
        (existingPlacement &&
          placement.state === existingPlacement.state &&
          placement.generation === existingPlacement.generation &&
          placement.updatedAtMs === existingPlacement.updatedAtMs)
      ) {
        return;
      }
      try {
        emitSessionsChanged(context, { reason: "reclaim", sessionKey: target.canonicalKey });
      } catch {
        // Reporting cannot replace a committed reclaim outcome.
      }
    };
    const workspace =
      existingPlacement?.state !== "failed" || params.recoverToGateway
        ? await resolveSessionWorkspace({
            entry,
            sessionKey: target.canonicalKey,
            agentId: target.target.agentId,
            method: "sessions.reclaim",
            respond,
          })
        : undefined;
    if ((existingPlacement?.state !== "failed" || params.recoverToGateway) && !workspace) {
      return;
    }
    let placement: WorkerSessionPlacementRecord;
    try {
      placement = await placementService.reclaim(
        {
          sessionId,
          sessionKey: target.canonicalKey,
          agentId: target.target.agentId,
          ...(params.recoverToGateway ? { recoverToGateway: params.recoverToGateway } : {}),
          readNativeCredential: factoryGitHubDispatchCredentialReader({
            client,
            sessionId,
            sessionKey: target.canonicalKey,
            agentId: target.target.agentId,
            repositoryUrl: workspace?.kind === "repository" ? workspace.repository.url : undefined,
            assertCurrent: () => sessionMutationAuthorization?.assertCurrent(),
          }),
        },
        sessionMutationAuthorization?.assertCurrent,
      );
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      reportPlacementChange(placementReader.getMany([sessionId]).get(sessionId));
      respondWorkerDispatchError(error, respond);
      return;
    }
    reportPlacementChange(placement);
    respondWorkerPlacement({ respond, key: target.canonicalKey, sessionId, context, placement });
  },
};
