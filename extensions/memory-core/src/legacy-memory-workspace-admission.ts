import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isLegacyMemorySurfaceDisabled } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryDreamingWorkspaces } from "openclaw/plugin-sdk/memory-core-host-status";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeMemoryCoreWorkspaceKey } from "./dreaming-state.js";

const legacyMemoryWorkspaceAdmissionBrand = Symbol("legacyMemoryWorkspaceAdmission");

/**
 * Opaque authority for a legacy workspace. The token is issued from the
 * configured roster, never from a caller-provided workspace path or owner set.
 */
export type LegacyMemoryWorkspaceAdmission = Readonly<{
  readonly [legacyMemoryWorkspaceAdmissionBrand]: true;
}>;

type LegacyMemoryWorkspaceAdmissionRecord = Readonly<{
  agentId: string;
  cfg: OpenClawConfig;
  workspaceKey: string;
}>;

export type LegacyMemoryWorkspaceAccess = Readonly<{
  agentId: string;
  workspaceDir: string;
}>;

const admissions = new WeakMap<
  LegacyMemoryWorkspaceAdmission,
  LegacyMemoryWorkspaceAdmissionRecord
>();

function resolveLegacyMemoryWorkspaceAccess(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceKey?: string;
}): LegacyMemoryWorkspaceAccess | undefined {
  const agentId = normalizeLowercaseStringOrEmpty(params.agentId);
  if (!agentId) {
    return undefined;
  }
  const workspace = resolveMemoryDreamingWorkspaces(params.cfg).find(
    (entry) =>
      entry.agentIds.includes(agentId) &&
      (!params.workspaceKey ||
        normalizeMemoryCoreWorkspaceKey(entry.workspaceDir) === params.workspaceKey),
  );
  if (
    !workspace ||
    workspace.agentIds.some((ownerAgentId) => isLegacyMemorySurfaceDisabled(ownerAgentId))
  ) {
    return undefined;
  }
  return Object.freeze({ agentId, workspaceDir: workspace.workspaceDir });
}

export function admitLegacyMemoryWorkspace(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): LegacyMemoryWorkspaceAdmission | undefined {
  const access = resolveLegacyMemoryWorkspaceAccess(params);
  if (!access) {
    return undefined;
  }
  const admission = Object.freeze({
    [legacyMemoryWorkspaceAdmissionBrand]: true,
  }) as LegacyMemoryWorkspaceAdmission;
  admissions.set(
    admission,
    Object.freeze({
      agentId: access.agentId,
      cfg: params.cfg,
      workspaceKey: normalizeMemoryCoreWorkspaceKey(access.workspaceDir),
    }),
  );
  return admission;
}

export function resolveAdmittedLegacyMemoryWorkspace(
  admission: LegacyMemoryWorkspaceAdmission,
): LegacyMemoryWorkspaceAccess | undefined {
  const record = admissions.get(admission);
  return record
    ? resolveLegacyMemoryWorkspaceAccess({
        cfg: record.cfg,
        agentId: record.agentId,
        workspaceKey: record.workspaceKey,
      })
    : undefined;
}

export function requireAdmittedLegacyMemoryWorkspace(
  admission: LegacyMemoryWorkspaceAdmission,
): LegacyMemoryWorkspaceAccess {
  const access = resolveAdmittedLegacyMemoryWorkspace(admission);
  if (!access) {
    throw new Error("legacy memory workspace access is unavailable");
  }
  return access;
}
