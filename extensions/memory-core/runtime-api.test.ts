import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const admitLegacyMemoryWorkspace = vi.hoisted(() => vi.fn());
const requireAdmittedLegacyMemoryWorkspace = vi.hoisted(() => vi.fn());
const auditDreamingArtifactsAtWorkspace = vi.hoisted(() => vi.fn());
const repairDreamingArtifactsAtWorkspace = vi.hoisted(() => vi.fn());
const dedupeDreamDiaryEntriesAtWorkspace = vi.hoisted(() => vi.fn());
const removeBackfillDiaryEntriesAtWorkspace = vi.hoisted(() => vi.fn());
const writeBackfillDiaryEntriesAtWorkspace = vi.hoisted(() => vi.fn());
const auditShortTermPromotionArtifactsAtWorkspace = vi.hoisted(() => vi.fn());
const loadShortTermPromotionDreamingStatsAtWorkspace = vi.hoisted(() => vi.fn());
const removeGroundedShortTermCandidatesAtWorkspace = vi.hoisted(() => vi.fn());
const repairShortTermPromotionArtifactsAtWorkspace = vi.hoisted(() => vi.fn());

vi.mock("./src/legacy-memory-workspace-admission.js", () => ({
  admitLegacyMemoryWorkspace,
  requireAdmittedLegacyMemoryWorkspace,
}));

vi.mock("./src/dreaming-repair.js", () => ({
  auditDreamingArtifacts: auditDreamingArtifactsAtWorkspace,
  repairDreamingArtifacts: repairDreamingArtifactsAtWorkspace,
}));

vi.mock("./src/dreaming-narrative.js", () => ({
  dedupeDreamDiaryEntries: dedupeDreamDiaryEntriesAtWorkspace,
  removeBackfillDiaryEntries: removeBackfillDiaryEntriesAtWorkspace,
  writeBackfillDiaryEntries: writeBackfillDiaryEntriesAtWorkspace,
}));

vi.mock("./src/short-term-promotion.js", () => ({
  auditShortTermPromotionArtifacts: auditShortTermPromotionArtifactsAtWorkspace,
  loadShortTermPromotionDreamingStats: loadShortTermPromotionDreamingStatsAtWorkspace,
  removeGroundedShortTermCandidates: removeGroundedShortTermCandidatesAtWorkspace,
  repairShortTermPromotionArtifacts: repairShortTermPromotionArtifactsAtWorkspace,
}));

import { auditDreamingArtifacts } from "./runtime-api.js";

describe("memory-core runtime maintenance API", () => {
  const cfg = {
    agents: { list: [{ id: "beta", workspace: "/tmp/shared-workspace" }] },
  } as OpenClawConfig;

  beforeEach(() => {
    admitLegacyMemoryWorkspace.mockReset().mockReturnValue({ admission: "opaque" });
    requireAdmittedLegacyMemoryWorkspace.mockReset().mockReturnValue({
      workspaceDir: "/tmp/shared-workspace",
    });
    auditDreamingArtifactsAtWorkspace.mockReset().mockResolvedValue({ issues: [] });
    repairDreamingArtifactsAtWorkspace.mockReset();
    dedupeDreamDiaryEntriesAtWorkspace.mockReset();
    removeBackfillDiaryEntriesAtWorkspace.mockReset();
    writeBackfillDiaryEntriesAtWorkspace.mockReset();
    auditShortTermPromotionArtifactsAtWorkspace.mockReset();
    loadShortTermPromotionDreamingStatsAtWorkspace.mockReset();
    removeGroundedShortTermCandidatesAtWorkspace.mockReset();
    repairShortTermPromotionArtifactsAtWorkspace.mockReset();
  });

  it("requires configuration-derived agent authority instead of a caller workspace path", async () => {
    expectTypeOf<{ cfg: OpenClawConfig; agentId: string }>().toMatchTypeOf<
      Parameters<typeof auditDreamingArtifacts>[0]
    >();
    expectTypeOf<{ workspaceDir: string }>().not.toMatchTypeOf<
      Parameters<typeof auditDreamingArtifacts>[0]
    >();

    await auditDreamingArtifacts({ cfg, agentId: "beta" });

    expect(admitLegacyMemoryWorkspace).toHaveBeenCalledWith({ cfg, agentId: "beta" });
    expect(requireAdmittedLegacyMemoryWorkspace).toHaveBeenCalledWith({ admission: "opaque" });
    expect(auditDreamingArtifactsAtWorkspace).toHaveBeenCalledWith({
      workspaceDir: "/tmp/shared-workspace",
    });
  });

  it("rejects an unadmitted workspace before any maintenance facade reaches the filesystem", async () => {
    admitLegacyMemoryWorkspace.mockReturnValueOnce(undefined);

    await expect(auditDreamingArtifacts({ cfg, agentId: "beta" })).rejects.toThrow(
      "Legacy memory maintenance is unavailable after scoped-memory cutover.",
    );

    expect(requireAdmittedLegacyMemoryWorkspace).not.toHaveBeenCalled();
    expect(auditDreamingArtifactsAtWorkspace).not.toHaveBeenCalled();
  });
});
