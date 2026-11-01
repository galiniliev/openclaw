import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE } from "../auto-reply/reply/session-fork.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  createInternalHookEvent,
  hasInternalHookListeners,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isModelSelectionLocked } from "../sessions/model-overrides.js";
import { isSessionControllerWorkActive } from "../sessions/session-controller.lifecycle.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";
import { loadSessionLifecycleRuntime } from "./session-lifecycle-runtime-loader.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { invalidSessionRequest, unavailableSessionRequest } from "./session-request-error.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

/** Refresh and validate the parent under creation's lifecycle fence before reset hooks run. */
export async function prepareSessionCreateParentLifecycle(input: {
  params: CreateGatewaySessionParams;
  agentId: string;
  parentSessionKey: string | undefined;
  canonicalParentSessionKey: string | undefined;
  parentSelectedAgentId: string | undefined;
  parentSessionEntry: SessionEntry | undefined;
  parentSessionTarget: GatewaySessionStoreTarget | undefined;
  holdParentLifecycle: boolean;
  commitGuard: () => void;
}) {
  const {
    params,
    agentId,
    parentSessionKey,
    canonicalParentSessionKey,
    parentSelectedAgentId,
    parentSessionEntry,
    parentSessionTarget,
    holdParentLifecycle,
    commitGuard,
  } = input;
  let currentParentSessionEntry = parentSessionEntry;
  if (canonicalParentSessionKey && parentSessionTarget && holdParentLifecycle) {
    const currentParent = await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: params.cfg,
      key: canonicalParentSessionKey,
      ...(parentSelectedAgentId ? { agentId: parentSelectedAgentId } : {}),
      assertActive: commitGuard,
    });
    const currentParentEntry = currentParent.entry;
    if (
      !currentParentEntry?.sessionId ||
      currentParentEntry.sessionId !== parentSessionEntry?.sessionId ||
      currentParentEntry.lifecycleRevision !== parentSessionEntry?.lifecycleRevision
    ) {
      return invalidSessionRequest(
        `Parent session ${parentSessionKey} changed before child creation; retry.`,
      );
    }
    currentParentSessionEntry = currentParentEntry;
    const parentOwnershipError = resolvePluginSessionOwnershipError({
      action: params.fork === true ? "fork" : "link",
      entry: currentParentEntry,
      key: canonicalParentSessionKey,
      pluginOwnerId: params.authorizedPluginId,
    });
    if (parentOwnershipError) {
      return { ok: false as const, error: parentOwnershipError };
    }
    if (
      (params.emitCommandHooks === true || params.fork === true) &&
      isModelSelectionLocked(currentParentEntry)
    ) {
      return invalidSessionRequest(MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
    }
    const parentHasActiveWork =
      (params.emitCommandHooks === true || params.fork === true) &&
      isSessionControllerWorkActive(
        parentSessionTarget.storePath,
        [canonicalParentSessionKey, currentParentEntry.sessionId],
        parentSessionTarget.agentId,
      );
    if (
      parentHasActiveWork &&
      (params.emitCommandHooks === true ||
        (params.forkFrom !== "last-completed" && !params.activeParentFork))
    ) {
      return unavailableSessionRequest(
        `Parent session ${parentSessionKey} is still active; try again in a moment.`,
      );
    }
  }

  if (canonicalParentSessionKey && parentSessionTarget && params.emitCommandHooks === true) {
    const parentEntry = currentParentSessionEntry;
    const parentAgentId = normalizeAgentId(
      parentSelectedAgentId ?? resolveAgentIdFromSessionKey(canonicalParentSessionKey) ?? agentId,
    );
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, parentAgentId);
    if (hasInternalHookListeners("command", "new")) {
      await triggerInternalHook(
        createInternalHookEvent("command", "new", canonicalParentSessionKey, {
          agentId: parentAgentId,
          sessionEntry: parentEntry,
          previousSessionEntry: parentEntry,
          commandSource: params.commandSource,
          cfg: params.cfg,
          storePath: parentSessionTarget.storePath,
          workspaceDir,
        }),
      );
    }
    const { emitGatewayBeforeResetPluginHook } = await loadSessionLifecycleRuntime();
    await emitGatewayBeforeResetPluginHook({
      cfg: params.cfg,
      key: canonicalParentSessionKey,
      target: parentSessionTarget,
      storePath: parentSessionTarget.storePath,
      entry: parentEntry,
      reason: "new",
    });
  }

  return { ok: true as const, entry: currentParentSessionEntry };
}
