import fs from "node:fs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  completeMemoryIsolationCutover,
  disableMemoryShadowReadOnlyMode,
  enableMemoryShadowReadOnlyMode,
  readVerifiedMemoryIsolationFinalCutover,
  resolveMemoryIsolationMode,
  type MemoryIsolationMode,
} from "../plugins/memory-cutover.js";
import {
  archiveSelectedMemoryIsolationMigration,
  exportSelectedMemoryIsolationMigration,
  requireSelectedMemoryIsolationBackendConformance,
  rollbackSelectedMemoryIsolationMigration,
  runSelectedMemoryIsolationMigration,
} from "../plugins/memory-runtime.js";
import type {
  MemoryIsolationDowngradeExport,
  MemoryIsolationMigrationActor,
  MemoryIsolationMigrationDecision,
  MemoryIsolationMigrationResult,
} from "../plugins/registry-contribution-types.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

export type DoctorMemoryIsolationAction =
  | "status"
  | "shadow-read-only"
  | "legacy"
  | "dry-run"
  | "cutover"
  | "rollback"
  | "archive"
  | "export";

export type DoctorMemoryIsolationReport = Readonly<{
  agentId: string;
  mode: MemoryIsolationMode;
  restartRequired: boolean;
  /** Legacy artifacts remain intact until the operator explicitly starts archival. */
  archiveRequired?: true;
  migration?: Pick<
    MemoryIsolationMigrationResult,
    "state" | "migrationId" | "planHash" | "sources"
  >;
  export?: MemoryIsolationDowngradeExport;
}>;

function readReviewedMigrationDecisions(
  pathname: string | undefined,
): readonly MemoryIsolationMigrationDecision[] {
  if (!pathname) {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    throw new Error("memory isolation decisions file must contain valid JSON");
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    (raw as { version?: unknown }).version !== 1 ||
    !Array.isArray((raw as { decisions?: unknown }).decisions)
  ) {
    throw new Error("memory isolation decisions file must be a version 1 decision manifest");
  }
  return (raw as { decisions: unknown[] }).decisions.map((decision) => {
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
      throw new Error("memory isolation decision entry is invalid");
    }
    const record = decision as Record<string, unknown>;
    if (
      typeof record.sourceId !== "string" ||
      typeof record.sourceHash !== "string" ||
      (record.placement !== "quarantine" && record.placement !== "user-private")
    ) {
      throw new Error("memory isolation decision entry is invalid");
    }
    if (record.placement === "quarantine") {
      return { sourceId: record.sourceId, sourceHash: record.sourceHash, placement: "quarantine" };
    }
    if (typeof record.principalId !== "string") {
      throw new Error("memory isolation private placement decision requires a principal id");
    }
    return {
      sourceId: record.sourceId,
      sourceHash: record.sourceHash,
      placement: "user-private",
      principalId: record.principalId,
    };
  });
}

function resolveDoctorMemoryIsolationAgent(params: {
  agentId?: string;
  cfg: OpenClawConfig;
}): string {
  const agentId = normalizeOptionalString(params.agentId) ?? resolveDefaultAgentId(params.cfg);
  if (!listAgentIds(params.cfg).includes(agentId)) {
    throw new Error(`Unknown configured agent id "${agentId}".`);
  }
  return agentId;
}

/**
 * Doctor owns the only P1C enablement path. It persists one reversible, verified posture and
 * deliberately does not create a Phase 6 cutover marker or claim two-subject confinement.
 */
export async function runDoctorMemoryIsolation(params: {
  action: DoctorMemoryIsolationAction;
  agentId?: string;
  cfg?: OpenClawConfig;
  nowMs?: number;
  actor?: MemoryIsolationMigrationActor;
  decisions?: readonly MemoryIsolationMigrationDecision[];
  decisionsPath?: string;
  planHash?: string;
  exportDir?: string;
}): Promise<DoctorMemoryIsolationReport> {
  const cfg = params.cfg ?? getRuntimeConfig();
  const agentId = resolveDoctorMemoryIsolationAgent({ agentId: params.agentId, cfg });
  const migrationActor = params.actor ?? { role: "admin", principalId: "operator.admin" };
  const decisions = params.decisions ?? readReviewedMigrationDecisions(params.decisionsPath);
  const migrationId = `memory-isolation-final:${agentId}`;
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const stateDir = resolveStateDir(process.env);
  const runFinalMigration = async (action: "dry-run" | "apply") => {
    const migration = await runSelectedMemoryIsolationMigration({
      cfg,
      action,
      agentId,
      workspaceDir,
      stateDir,
      migrationId,
      actor: migrationActor,
      decisions,
      ...(action === "apply" ? { expectedPlanHash: params.planHash } : {}),
      ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
    });
    return migration;
  };
  switch (params.action) {
    case "status":
      return { agentId, mode: resolveMemoryIsolationMode(agentId), restartRequired: false };
    case "shadow-read-only":
      return await withDoctorSqliteMaintenanceLock({
        operation: "memory isolation shadow-read-only",
        protectedPaths: [resolveOpenClawAgentSqlitePath({ agentId })],
        run: () => ({
          agentId,
          mode: enableMemoryShadowReadOnlyMode({ agentId, nowMs: params.nowMs }),
          restartRequired: true,
        }),
      });
    case "legacy":
      return await withDoctorSqliteMaintenanceLock({
        operation: "memory isolation legacy",
        protectedPaths: [resolveOpenClawAgentSqlitePath({ agentId })],
        run: () => ({
          agentId,
          mode: disableMemoryShadowReadOnlyMode({ agentId }),
          restartRequired: true,
        }),
      });
    case "dry-run": {
      const migration = await runFinalMigration("dry-run");
      return {
        agentId,
        mode: resolveMemoryIsolationMode(agentId),
        restartRequired: false,
        migration: {
          state: migration.state,
          migrationId: migration.migrationId,
          planHash: migration.planHash,
          sources: migration.sources,
        },
      };
    }
    case "cutover":
      return await withDoctorSqliteMaintenanceLock({
        operation: "memory isolation final cutover",
        protectedPaths: [resolveOpenClawAgentSqlitePath({ agentId })],
        run: async () => {
          const currentMode = resolveMemoryIsolationMode(agentId);
          if (currentMode === "cutover" || currentMode === "unavailable") {
            throw new Error(
              "memory isolation final cutover requires a readable pre-cutover posture",
            );
          }
          await requireSelectedMemoryIsolationBackendConformance({ cfg, agentId });
          const migration = await runFinalMigration("apply");
          if (migration.state !== "verified" || !migration.verifiedSources) {
            throw new Error("memory isolation migration did not produce verified cutover evidence");
          }
          const mode = completeMemoryIsolationCutover({
            agentId,
            migrationId: migration.migrationId,
            planHash: migration.planHash,
            sources: migration.verifiedSources,
            ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
          });
          return {
            agentId,
            mode,
            restartRequired: true,
            archiveRequired: true,
            migration: {
              state: migration.state,
              migrationId: migration.migrationId,
              planHash: migration.planHash,
              sources: migration.sources,
            },
          };
        },
      });
    case "rollback":
      return await withDoctorSqliteMaintenanceLock({
        operation: "memory isolation pre-cutover rollback",
        protectedPaths: [resolveOpenClawAgentSqlitePath({ agentId })],
        run: async () => {
          if (resolveMemoryIsolationMode(agentId) !== "legacy") {
            throw new Error("memory isolation rollback requires a readable pre-cutover posture");
          }
          const planHash = normalizeOptionalString(params.planHash);
          if (!planHash) {
            throw new Error("memory isolation rollback requires --memory-isolation-plan <sha256>");
          }
          await rollbackSelectedMemoryIsolationMigration({
            cfg,
            agentId,
            migrationId,
            planHash,
            ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
          });
          return { agentId, mode: "legacy" as const, restartRequired: false };
        },
      });
    case "archive":
      return await withDoctorSqliteMaintenanceLock({
        operation: "memory isolation legacy archival",
        protectedPaths: [resolveOpenClawAgentSqlitePath({ agentId })],
        run: async () => {
          if (resolveMemoryIsolationMode(agentId) !== "cutover") {
            throw new Error("memory isolation archival requires a verified final cutover");
          }
          const cutover = readVerifiedMemoryIsolationFinalCutover({ agentId });
          await archiveSelectedMemoryIsolationMigration({
            cfg,
            agentId,
            workspaceDir,
            stateDir,
            migrationId,
            cutover,
            ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
          });
          return { agentId, mode: "cutover", restartRequired: false };
        },
      });
    case "export":
      return await withDoctorSqliteMaintenanceLock({
        operation: "memory isolation downgrade export",
        protectedPaths: [resolveOpenClawAgentSqlitePath({ agentId })],
        run: async () => {
          if (resolveMemoryIsolationMode(agentId) !== "cutover") {
            throw new Error("memory isolation downgrade export requires a verified final cutover");
          }
          const outputDir = normalizeOptionalString(params.exportDir);
          if (!outputDir) {
            throw new Error("memory isolation downgrade export requires an output directory");
          }
          const cutover = readVerifiedMemoryIsolationFinalCutover({ agentId });
          const exported = await exportSelectedMemoryIsolationMigration({
            cfg,
            agentId,
            migrationId,
            outputDir,
            cutover,
            ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
          });
          return { agentId, mode: "cutover", restartRequired: false, export: exported };
        },
      });
  }
}
