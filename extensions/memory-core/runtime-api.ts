// Runtime maintenance APIs resolve legacy workspaces from the host configuration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  dedupeDreamDiaryEntries as dedupeDreamDiaryEntriesAtWorkspace,
  removeBackfillDiaryEntries as removeBackfillDiaryEntriesAtWorkspace,
  writeBackfillDiaryEntries as writeBackfillDiaryEntriesAtWorkspace,
} from "./src/dreaming-narrative.js";
import {
  auditDreamingArtifacts as auditDreamingArtifactsAtWorkspace,
  repairDreamingArtifacts as repairDreamingArtifactsAtWorkspace,
  type DreamingArtifactsAuditSummary,
  type RepairDreamingArtifactsResult,
} from "./src/dreaming-repair.js";
import {
  admitLegacyMemoryWorkspace,
  requireAdmittedLegacyMemoryWorkspace,
} from "./src/legacy-memory-workspace-admission.js";
import {
  auditShortTermPromotionArtifacts as auditShortTermPromotionArtifactsAtWorkspace,
  loadShortTermPromotionDreamingStats as loadShortTermPromotionDreamingStatsAtWorkspace,
  removeGroundedShortTermCandidates as removeGroundedShortTermCandidatesAtWorkspace,
  repairShortTermPromotionArtifacts as repairShortTermPromotionArtifactsAtWorkspace,
  type RepairShortTermPromotionArtifactsResult,
  type ShortTermAuditSummary,
  type ShortTermDreamingStats,
} from "./src/short-term-promotion.js";

// Memory Core API module exposes the plugin runtime contract.
export { getMemorySearchManager, MemoryIndexManager } from "./src/memory/index.js";
export { memoryRuntime } from "./src/runtime-provider.js";
export {
  DEFAULT_LOCAL_MODEL,
  getBuiltinMemoryEmbeddingProviderDoctorMetadata,
  listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata,
} from "./src/memory/provider-adapters.js";
export { createEmbeddingProvider } from "./src/memory/embeddings.js";
export {
  resolveMemoryCacheSummary,
  resolveMemoryFtsState,
  resolveMemoryVectorState,
  type Tone,
} from "openclaw/plugin-sdk/memory-core-host-status";
export { hasConfiguredMemorySecretInput } from "openclaw/plugin-sdk/memory-core-host-secret";
export { configureMemoryCoreDreamingState } from "./src/dreaming-state.js";
export type { BuiltinMemoryEmbeddingProviderDoctorMetadata } from "./src/memory/provider-adapters.js";
export type { DreamingArtifactsAuditSummary, RepairDreamingArtifactsResult };
export type {
  RepairShortTermPromotionArtifactsResult,
  ShortTermDreamingStats,
  ShortTermDreamingStatsEntry,
  ShortTermAuditSummary,
} from "./src/short-term-promotion.js";

type LegacyMemoryMaintenanceTarget = {
  cfg: OpenClawConfig;
  agentId: string;
};

function requireLegacyMemoryMaintenanceWorkspace(params: LegacyMemoryMaintenanceTarget): string {
  if (!params.cfg || !params.agentId.trim()) {
    throw new Error("Memory maintenance requires configured agent authority.");
  }
  const admission = admitLegacyMemoryWorkspace(params);
  if (!admission) {
    throw new Error("Legacy memory maintenance is unavailable after scoped-memory cutover.");
  }
  return requireAdmittedLegacyMemoryWorkspace(admission).workspaceDir;
}

/** Audit dreaming artifacts through configuration-derived legacy workspace authority. */
export async function auditDreamingArtifacts(
  params: LegacyMemoryMaintenanceTarget,
): Promise<DreamingArtifactsAuditSummary> {
  return await auditDreamingArtifactsAtWorkspace({
    workspaceDir: requireLegacyMemoryMaintenanceWorkspace(params),
  });
}

/** Repair dreaming artifacts through configuration-derived legacy workspace authority. */
export async function repairDreamingArtifacts(
  params: LegacyMemoryMaintenanceTarget & { archiveDiary?: boolean; now?: Date },
): Promise<RepairDreamingArtifactsResult> {
  return await repairDreamingArtifactsAtWorkspace({
    workspaceDir: requireLegacyMemoryMaintenanceWorkspace(params),
    ...(params.archiveDiary !== undefined ? { archiveDiary: params.archiveDiary } : {}),
    ...(params.now !== undefined ? { now: params.now } : {}),
  });
}

/** Audit short-term promotion artifacts through configuration-derived legacy workspace authority. */
export async function auditShortTermPromotionArtifacts(
  params: LegacyMemoryMaintenanceTarget,
): Promise<ShortTermAuditSummary> {
  return await auditShortTermPromotionArtifactsAtWorkspace({
    workspaceDir: requireLegacyMemoryMaintenanceWorkspace(params),
  });
}

/** Repair short-term promotion artifacts through configuration-derived legacy workspace authority. */
export async function repairShortTermPromotionArtifacts(
  params: LegacyMemoryMaintenanceTarget,
): Promise<RepairShortTermPromotionArtifactsResult> {
  return await repairShortTermPromotionArtifactsAtWorkspace({
    workspaceDir: requireLegacyMemoryMaintenanceWorkspace(params),
  });
}

/** Remove grounded short-term candidates through configuration-derived legacy workspace authority. */
export async function removeGroundedShortTermCandidates(
  params: LegacyMemoryMaintenanceTarget,
): Promise<{ removed: number; storePath: string }> {
  return await removeGroundedShortTermCandidatesAtWorkspace({
    workspaceDir: requireLegacyMemoryMaintenanceWorkspace(params),
  });
}

/** Load dreaming stats through configuration-derived legacy workspace authority. */
export async function loadShortTermPromotionDreamingStats(
  params: LegacyMemoryMaintenanceTarget & { nowMs: number; timezone?: string },
): Promise<ShortTermDreamingStats> {
  return await loadShortTermPromotionDreamingStatsAtWorkspace({
    workspaceDir: requireLegacyMemoryMaintenanceWorkspace(params),
    nowMs: params.nowMs,
    ...(params.timezone !== undefined ? { timezone: params.timezone } : {}),
  });
}

/** Remove duplicate diary entries through configuration-derived legacy workspace authority. */
export async function dedupeDreamDiaryEntries(
  params: LegacyMemoryMaintenanceTarget,
): Promise<{ dreamsPath: string; removed: number; kept: number }> {
  return await dedupeDreamDiaryEntriesAtWorkspace({
    workspaceDir: requireLegacyMemoryMaintenanceWorkspace(params),
  });
}

/** Write backfill diary entries through configuration-derived legacy workspace authority. */
export async function writeBackfillDiaryEntries(
  params: LegacyMemoryMaintenanceTarget & {
    entries: Array<{ isoDay: string; bodyLines: string[]; sourcePath?: string }>;
    preserveExisting?: boolean;
    timezone?: string;
  },
): Promise<{ dreamsPath: string; written: number; replaced: number }> {
  return await writeBackfillDiaryEntriesAtWorkspace({
    workspaceDir: requireLegacyMemoryMaintenanceWorkspace(params),
    entries: params.entries,
    ...(params.preserveExisting !== undefined ? { preserveExisting: params.preserveExisting } : {}),
    ...(params.timezone !== undefined ? { timezone: params.timezone } : {}),
  });
}

/** Remove backfilled diary entries through configuration-derived legacy workspace authority. */
export async function removeBackfillDiaryEntries(
  params: LegacyMemoryMaintenanceTarget,
): Promise<{ dreamsPath: string; removed: number }> {
  return await removeBackfillDiaryEntriesAtWorkspace({
    workspaceDir: requireLegacyMemoryMaintenanceWorkspace(params),
  });
}
