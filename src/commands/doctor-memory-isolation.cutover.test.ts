import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";

const migrationRuntime = vi.hoisted(() => ({
  runSelectedMemoryIsolationMigration: vi.fn(),
  archiveSelectedMemoryIsolationMigration: vi.fn(),
  rollbackSelectedMemoryIsolationMigration: vi.fn(),
  exportSelectedMemoryIsolationMigration: vi.fn(),
  requireSelectedMemoryIsolationBackendConformance: vi.fn(),
}));
const cutover = vi.hoisted(() => ({
  completeMemoryIsolationCutover: vi.fn(() => "cutover"),
  readVerifiedMemoryIsolationFinalCutover: vi.fn(),
  resolveMemoryIsolationMode: vi.fn(() => "legacy"),
}));

vi.mock("../plugins/memory-runtime.js", () => migrationRuntime);
vi.mock("../plugins/memory-cutover.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/memory-cutover.js")>()),
  completeMemoryIsolationCutover: cutover.completeMemoryIsolationCutover,
  readVerifiedMemoryIsolationFinalCutover: cutover.readVerifiedMemoryIsolationFinalCutover,
  resolveMemoryIsolationMode: cutover.resolveMemoryIsolationMode,
}));

import { runDoctorMemoryIsolation } from "./doctor-memory-isolation.js";

describe("final Doctor memory isolation cutover", () => {
  let stateDir = "";
  const cfg: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true, workspace: "/tmp/openclaw-memory-workspace" }] },
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-memory-cutover-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    openOpenClawAgentDatabase({ agentId: "main" });
    migrationRuntime.runSelectedMemoryIsolationMigration.mockReset();
    migrationRuntime.archiveSelectedMemoryIsolationMigration.mockReset();
    migrationRuntime.rollbackSelectedMemoryIsolationMigration.mockReset();
    migrationRuntime.exportSelectedMemoryIsolationMigration.mockReset();
    migrationRuntime.requireSelectedMemoryIsolationBackendConformance.mockReset();
    migrationRuntime.requireSelectedMemoryIsolationBackendConformance.mockResolvedValue(undefined);
    cutover.completeMemoryIsolationCutover.mockClear();
    cutover.readVerifiedMemoryIsolationFinalCutover.mockReset();
    cutover.resolveMemoryIsolationMode.mockReturnValue("legacy");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { force: true, recursive: true });
  });

  it("returns a redacted dry-run plan without writing a cutover marker", async () => {
    const planHash = `sha256:${createHash("sha256").update("plan").digest("hex")}`;
    migrationRuntime.runSelectedMemoryIsolationMigration.mockResolvedValueOnce({
      state: "planned",
      migrationId: "memory-isolation-final:main",
      planHash,
      sources: [
        {
          sourceId: "m6_source",
          sourceKind: "legacy-file",
          sourceHash: `sha256:${createHash("sha256").update("source").digest("hex")}`,
          placement: "quarantine",
        },
      ],
    });

    await expect(
      runDoctorMemoryIsolation({ action: "dry-run", cfg, nowMs: 1_000 }),
    ).resolves.toMatchObject({
      agentId: "main",
      mode: "legacy",
      restartRequired: false,
      migration: { state: "planned", sources: [{ placement: "quarantine" }] },
    });
    expect(cutover.completeMemoryIsolationCutover).not.toHaveBeenCalled();
    expect(migrationRuntime.runSelectedMemoryIsolationMigration).toHaveBeenCalledWith(
      expect.objectContaining({ action: "dry-run", decisions: [] }),
    );
  });

  it("loads only a versioned hash-bound owner decision manifest", async () => {
    const planHash = `sha256:${createHash("sha256").update("plan").digest("hex")}`;
    const sourceHash = `sha256:${createHash("sha256").update("source").digest("hex")}`;
    const decisionsPath = path.join(stateDir, "reviewed-decisions.json");
    fs.writeFileSync(
      decisionsPath,
      JSON.stringify({
        version: 1,
        decisions: [
          {
            sourceId: "m6_source",
            sourceHash,
            placement: "user-private",
            principalId: "principal-alice",
          },
        ],
      }),
    );
    migrationRuntime.runSelectedMemoryIsolationMigration.mockResolvedValueOnce({
      state: "planned",
      migrationId: "memory-isolation-final:main",
      planHash,
      sources: [
        {
          sourceId: "m6_source",
          sourceKind: "legacy-file",
          sourceHash,
          placement: "user-private",
        },
      ],
    });

    await runDoctorMemoryIsolation({
      action: "dry-run",
      cfg,
      decisionsPath,
      nowMs: 1_000,
    });

    expect(migrationRuntime.runSelectedMemoryIsolationMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: [
          {
            sourceId: "m6_source",
            sourceHash,
            placement: "user-private",
            principalId: "principal-alice",
          },
        ],
      }),
    );
  });

  it("allows core to write the final marker only after selected-plugin verification", async () => {
    const planHash = `sha256:${createHash("sha256").update("plan").digest("hex")}`;
    const sourceHash = `sha256:${createHash("sha256").update("source").digest("hex")}`;
    const verifiedSources = [{ sourceKind: "legacy-file", sourceHash }];
    migrationRuntime.runSelectedMemoryIsolationMigration.mockResolvedValueOnce({
      state: "verified",
      migrationId: "memory-isolation-final:main",
      planHash,
      sources: [
        {
          sourceId: "m6_source",
          sourceKind: "legacy-file",
          sourceHash,
          placement: "quarantine",
        },
      ],
      verifiedSources,
    });

    await expect(
      runDoctorMemoryIsolation({ action: "cutover", cfg, planHash, nowMs: 1_000 }),
    ).resolves.toMatchObject({
      agentId: "main",
      mode: "cutover",
      restartRequired: true,
      archiveRequired: true,
      migration: { state: "verified" },
    });
    expect(cutover.completeMemoryIsolationCutover).toHaveBeenCalledWith({
      agentId: "main",
      migrationId: "memory-isolation-final:main",
      planHash,
      sources: verifiedSources,
      nowMs: 1_000,
    });
    expect(migrationRuntime.runSelectedMemoryIsolationMigration).toHaveBeenCalledWith(
      expect.objectContaining({ action: "apply", expectedPlanHash: planHash }),
    );
    expect(migrationRuntime.requireSelectedMemoryIsolationBackendConformance).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
    });
    expect(migrationRuntime.archiveSelectedMemoryIsolationMigration).not.toHaveBeenCalled();
  });

  it("refuses to write a final marker when the selected plugin returns only a plan", async () => {
    const planHash = `sha256:${createHash("sha256").update("plan").digest("hex")}`;
    migrationRuntime.runSelectedMemoryIsolationMigration.mockResolvedValueOnce({
      state: "planned",
      migrationId: "memory-isolation-final:main",
      planHash,
      sources: [],
    });

    await expect(
      runDoctorMemoryIsolation({ action: "cutover", cfg, planHash, nowMs: 1_000 }),
    ).rejects.toThrow("did not produce verified cutover evidence");
    expect(cutover.completeMemoryIsolationCutover).not.toHaveBeenCalled();
  });

  it("passes a verified empty legacy corpus to core for a clean pilot cutover", async () => {
    const planHash = `sha256:${createHash("sha256").update("empty-plan").digest("hex")}`;
    migrationRuntime.runSelectedMemoryIsolationMigration.mockResolvedValueOnce({
      state: "verified",
      migrationId: "memory-isolation-final:main",
      planHash,
      sources: [],
      verifiedSources: [],
    });

    await expect(
      runDoctorMemoryIsolation({ action: "cutover", cfg, planHash, nowMs: 1_000 }),
    ).resolves.toMatchObject({ mode: "cutover", restartRequired: true });
    expect(cutover.completeMemoryIsolationCutover).toHaveBeenCalledWith(
      expect.objectContaining({ planHash, sources: [] }),
    );
  });

  it("refuses final cutover when the selected backend fails the enforced conformance gate", async () => {
    const planHash = `sha256:${createHash("sha256").update("plan").digest("hex")}`;
    migrationRuntime.requireSelectedMemoryIsolationBackendConformance.mockRejectedValueOnce(
      new Error("selected memory backend is nonconforming for enforced memory isolation"),
    );

    await expect(
      runDoctorMemoryIsolation({ action: "cutover", cfg, planHash, nowMs: 1_000 }),
    ).rejects.toThrow("backend is nonconforming");
    expect(migrationRuntime.runSelectedMemoryIsolationMigration).not.toHaveBeenCalled();
    expect(cutover.completeMemoryIsolationCutover).not.toHaveBeenCalled();
  });

  it("archives only with core's validated final-cutover grant", async () => {
    const planHash = `sha256:${createHash("sha256").update("plan").digest("hex")}`;
    const sourceHash = `sha256:${createHash("sha256").update("source").digest("hex")}`;
    const grant = {
      migrationId: "memory-isolation-final:main",
      planHash,
      sources: [{ sourceKind: "legacy-file", sourceHash }],
    } as const;
    cutover.resolveMemoryIsolationMode.mockReturnValue("cutover");
    cutover.readVerifiedMemoryIsolationFinalCutover.mockReturnValueOnce(grant);

    await expect(
      runDoctorMemoryIsolation({ action: "archive", cfg, nowMs: 1_000 }),
    ).resolves.toMatchObject({ mode: "cutover", restartRequired: false });
    expect(migrationRuntime.archiveSelectedMemoryIsolationMigration).toHaveBeenCalledWith(
      expect.objectContaining({ cutover: grant, nowMs: 1_000 }),
    );
  });

  it("rolls back only the exact reviewed pre-cutover plan", async () => {
    const planHash = `sha256:${createHash("sha256").update("plan").digest("hex")}`;

    await expect(
      runDoctorMemoryIsolation({ action: "rollback", cfg, planHash, nowMs: 1_000 }),
    ).resolves.toMatchObject({ mode: "legacy", restartRequired: false });
    expect(migrationRuntime.rollbackSelectedMemoryIsolationMigration).toHaveBeenCalledWith(
      expect.objectContaining({ planHash, nowMs: 1_000 }),
    );
  });

  it("requires the explicit post-cutover export path and preserves the cutover posture", async () => {
    const planHash = `sha256:${createHash("sha256").update("plan").digest("hex")}`;
    const sourceHash = `sha256:${createHash("sha256").update("source").digest("hex")}`;
    const grant = {
      migrationId: "memory-isolation-final:main",
      planHash,
      sources: [{ sourceKind: "legacy-file", sourceHash }],
    } as const;
    cutover.resolveMemoryIsolationMode.mockReturnValue("cutover");
    cutover.readVerifiedMemoryIsolationFinalCutover.mockReturnValueOnce(grant);
    migrationRuntime.exportSelectedMemoryIsolationMigration.mockResolvedValueOnce({
      outputDir: "/tmp/scoped-memory-export",
      exportedResources: 1,
      excludedQuarantineResources: 1,
      warning: "metadata is omitted",
    });

    await expect(
      runDoctorMemoryIsolation({
        action: "export",
        cfg,
        nowMs: 1_000,
        exportDir: "/tmp/scoped-memory-export",
      }),
    ).resolves.toMatchObject({
      mode: "cutover",
      restartRequired: false,
      export: { outputDir: "/tmp/scoped-memory-export" },
    });
    expect(migrationRuntime.exportSelectedMemoryIsolationMigration).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      migrationId: "memory-isolation-final:main",
      outputDir: "/tmp/scoped-memory-export",
      cutover: grant,
      nowMs: 1_000,
    });
    expect(cutover.resolveMemoryIsolationMode).toHaveBeenCalledWith("main");
  });

  it("rejects export before cutover or without an output directory", async () => {
    await expect(runDoctorMemoryIsolation({ action: "export", cfg })).rejects.toThrow(
      "requires a verified final cutover",
    );

    cutover.resolveMemoryIsolationMode.mockReturnValue("cutover");
    await expect(runDoctorMemoryIsolation({ action: "export", cfg })).rejects.toThrow(
      "requires an output directory",
    );
  });
});
