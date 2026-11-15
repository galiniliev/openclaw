import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { assertRequiredWorkerSelection } from "../../config/required-worker-profile.js";
import type { SessionCreatedActor } from "../../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { assertOperatorCloudProfileDispatchAllowed } from "../operator-role-policy.js";
import { repositoryDispatchCredentialReader } from "../repository-dispatch.js";
import { validateSessionDeviceFolderSelection } from "../session-device-folder.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function prepareRequiredWorkerSessionCreate(
  params: SessionsCreateParams,
  config: OpenClawConfig,
): { requiredProfile?: string; automaticEmptyWorkspace: boolean; error?: ErrorShape } {
  const selectionError = validateSessionDeviceFolderSelection(params);
  if (selectionError) {
    return { automaticEmptyWorkspace: false, error: selectionError };
  }
  const requiredProfile = config.cloudWorkers?.requiredProfile;
  const workerProfile = params.profileId ?? requiredProfile ?? params.defaultProfileId;
  if (
    (params.profileId || params.defaultProfileId) &&
    (params.cwd || params.projectId || params.projectGitUrl || params.worktreeBaseRef)
  ) {
    return {
      requiredProfile,
      automaticEmptyWorkspace: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Worker creation accepts a repository or a new empty workspace. Create and dispatch the session separately to use a Gateway project or folder.",
      ),
    };
  }
  if (!params.profileId && !requiredProfile && workerProfile) {
    params.profileId = workerProfile;
  }
  if (workerProfile && (params.deviceFolder || params.catalogId || params.execNode)) {
    return {
      requiredProfile,
      automaticEmptyWorkspace: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Device folders, terminal sessions, and execNode cannot be combined with a cloud worker profile.",
      ),
    };
  }
  try {
    assertRequiredWorkerSelection(config, params);
  } catch (error) {
    return {
      requiredProfile,
      automaticEmptyWorkspace: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
    };
  }
  if (workerProfile && !config.cloudWorkers?.profiles?.[workerProfile]) {
    return {
      requiredProfile,
      automaticEmptyWorkspace: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Worker creation requires a configured worker profile.",
      ),
    };
  }
  if (params.profileId && !params.repository && !params.worktreeSource) {
    params.worktree = true;
    params.worktreeSource = "empty";
    return { requiredProfile, automaticEmptyWorkspace: true };
  }
  if (!workerProfile || params.repository || params.catalogId || params.worktree === true) {
    return { requiredProfile, automaticEmptyWorkspace: false };
  }
  params.worktree = true;
  if (!params.cwd && !params.projectId && !params.projectGitUrl) {
    params.worktreeSource = "empty";
    return { requiredProfile, automaticEmptyWorkspace: true };
  }
  return { requiredProfile, automaticEmptyWorkspace: false };
}

export function assertRequiredWorkerSessionCreateCurrent(
  config: OpenClawConfig,
  requiredProfile: string | undefined,
  params: SessionsCreateParams,
  caller?: Pick<GatewayRequestHandlerOptions, "client">,
  createdActor?: SessionCreatedActor,
): void {
  if (config.cloudWorkers?.requiredProfile !== requiredProfile) {
    throw new Error("Required worker policy changed during session creation; retry.");
  }
  assertRequiredWorkerSelection(config, params);
  if (params.profileId && caller) {
    assertOperatorCloudProfileDispatchAllowed({
      config,
      client: caller.client,
      target: { profileId: params.profileId },
      createdActor,
      runSetupScript: false,
    });
  }
}

/** An automatic empty checkout may never replace an already accepted workspace. */
export function requiredWorkerWorkspaceReuseError(
  automaticEmptyWorkspace: boolean,
  existingTargetEntry: SessionEntry | undefined,
): ErrorShape | undefined {
  if (
    automaticEmptyWorkspace &&
    existingTargetEntry &&
    !existingTargetEntry.worktree &&
    (existingTargetEntry.sessionRoot ||
      existingTargetEntry.spawnedCwd ||
      existingTargetEntry.projectId)
  ) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "Required worker setup cannot replace an existing workspace with an empty one; create a managed-workspace session with the original source.",
    );
  }
  return undefined;
}

export async function prepareRequiredWorkerCreatedSession(params: {
  requiredProfile: string | undefined;
  profileId?: string;
  pendingWorktree: boolean;
  requestedProjectGitUrl: string | undefined;
  prepare: SessionPlacementAdmissionProvider["withRequiredSession"];
  session: { entry: Pick<SessionEntry, "sessionId">; key: string; agentId: string };
  assertCurrent: () => void;
  retainDispatch?: () => () => void;
  repository?: SessionsCreateParams["repository"];
  client?: GatewayRequestHandlerOptions["client"];
  hasCurrentClientAuthority?: () => boolean;
  signal?: AbortSignal;
}): Promise<void> {
  if (
    !(params.profileId ?? params.requiredProfile) ||
    params.pendingWorktree ||
    params.requestedProjectGitUrl
  ) {
    return;
  }
  if (!params.prepare) {
    throw new Error(
      "Required worker placement is unavailable; repair the configured profile and retry.",
    );
  }
  await params.prepare(
    {
      sessionId: params.session.entry.sessionId,
      sessionKey: params.session.key,
      agentId: params.session.agentId,
    },
    async (assertCurrent) => {
      params.assertCurrent();
      assertCurrent();
    },
    params.assertCurrent,
    params.signal,
    {
      waitForReady: false,
      profileId: params.profileId,
      retainDispatch: params.retainDispatch,
      readNativeCredential: params.repository
        ? repositoryDispatchCredentialReader({
            sessionId: params.session.entry.sessionId,
            sessionKey: params.session.key,
            agentId: params.session.agentId,
            client: params.client,
            hasCurrentClientAuthority: params.hasCurrentClientAuthority,
            requestDigest: sha256Hex(
              JSON.stringify({
                profileId: params.profileId ?? params.requiredProfile,
                repository: params.repository,
              }),
            ),
            assertCurrent: params.assertCurrent,
          })
        : undefined,
    },
  );
}
