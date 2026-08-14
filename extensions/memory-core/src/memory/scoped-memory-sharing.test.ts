import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mintMemoryPostboxTurnCapability,
  resetMemoryPostboxTurnCapabilitiesForTest,
} from "../../../../src/gateway/memory-postbox-turn-capability.js";
import { openOpenClawAgentDatabase } from "../../../../src/state/openclaw-agent-db.js";
import {
  createBuiltinScopedMemoryResource,
  readBuiltinScopedMemoryRevisionSnapshot,
} from "./scoped-memory-resources.js";
import {
  createBuiltinMemoryProjection,
  depositBuiltinMemoryPostbox,
  depositBuiltinMemoryPostboxFromTurnCapability,
  expireBuiltinMemoryProjections,
  refreshBuiltinMemoryProjection,
  registerBuiltinMemoryProjectionTarget,
  revokeBuiltinMemoryProjection,
  reviewBuiltinMemoryPostboxItem,
  setBuiltinMemoryPostboxMode,
} from "./scoped-memory-sharing.js";
import { createBuiltinScopedMemoryStore } from "./scoped-memory-store.js";

describe("builtin scoped memory sharing", () => {
  let stateDir = "";
  const agentId = "main";
  const alice = "principal-alice";
  const channel = "conversation-team";

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-sharing-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    resetMemoryPostboxTurnCapabilitiesForTest();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function sourceStore() {
    return createBuiltinScopedMemoryStore({
      agentId,
      scopeKind: "user",
      audienceKind: "user",
      audienceId: alice,
      authorityKind: "user",
      authorityOwnerId: alice,
      defaultCapabilities: ["read", "project"],
      actor: { kind: "human", id: alice },
      reason: "test private source",
    });
  }

  function projectionStore() {
    return createBuiltinScopedMemoryStore({
      agentId,
      scopeKind: "conversation",
      audienceKind: "conversation",
      audienceId: channel,
      authorityKind: "conversation",
      authorityOwnerId: channel,
      defaultCapabilities: ["read"],
      policyEntries: [
        {
          kind: "publish",
          effect: "allow",
          principalId: alice,
          operation: "publish",
          grantorPrincipalId: alice,
          reason: "named publisher",
        },
        {
          effect: "allow",
          principalId: alice,
          operation: "policy-admin",
          grantorPrincipalId: alice,
          reason: "projection administrator",
        },
      ],
      actor: { kind: "human", id: alice },
      reason: "test projection target",
    });
  }

  function privateTargetStore() {
    return createBuiltinScopedMemoryStore({
      agentId,
      scopeKind: "user",
      audienceKind: "user",
      audienceId: alice,
      authorityKind: "user",
      authorityOwnerId: alice,
      defaultCapabilities: ["read"],
      policyEntries: [
        {
          effect: "allow",
          principalId: alice,
          operation: "policy-admin",
          grantorPrincipalId: alice,
          reason: "postbox owner",
        },
      ],
      actor: { kind: "human", id: alice },
      reason: "test postbox target",
    });
  }

  function depositFromVerifiedTurn(params: { content: string; sourceMessageRef: string }) {
    const runId = `run-${params.sourceMessageRef}`;
    const sessionKey = "agent:main:direct:alice";
    const token = mintMemoryPostboxTurnCapability({
      agentId,
      runId,
      sessionKey,
      sessionId: "session-alice",
      sourceChannelRef: "telegram:alice",
      sourceMessageRef: params.sourceMessageRef,
      senderEvidenceRef: "telegram:sender-alice",
      targetPrincipalId: alice,
    });
    return depositBuiltinMemoryPostboxFromTurnCapability({
      agentId,
      runId,
      sessionKey,
      sessionId: "session-alice",
      turnCapability: token,
      content: params.content,
    });
  }

  it("creates a reviewed target copy with source lineage and no private read grant", () => {
    const source = sourceStore();
    const target = projectionStore();
    const privateRevision = createBuiltinScopedMemoryResource({
      agentId,
      store: source,
      logicalLocator: "private.md",
      content: "private source",
      actor: { kind: "human", id: alice },
    });
    registerBuiltinMemoryProjectionTarget({
      agentId,
      target: { kind: "conversation", id: channel },
      store: target,
      operatorPrincipalId: alice,
    });

    const projection = createBuiltinMemoryProjection({
      agentId,
      sourceRevisionId: privateRevision.revisionId,
      target: { kind: "conversation", id: channel },
      publisherPrincipalId: alice,
      reviewedByPrincipalId: alice,
      purpose: "share approved contact detail",
      preview: "one approved detail",
      content: "approved copy",
      expiry: { kind: "no-expiry", auditReason: "owner approved durable reference" },
    });

    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId,
        storeIds: [target.storeId],
        revisionId: projection.copyRevisionId,
      })?.content,
    ).toBe("approved copy");
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId,
        storeIds: [target.storeId],
        revisionId: privateRevision.revisionId,
      }),
    ).toBeUndefined();
    const database = openOpenClawAgentDatabase({ agentId });
    expect(
      database.db
        .prepare(
          "SELECT source_revision_id, reviewed_by_principal_id, expiry_kind FROM memory_projections",
        )
        .get(),
    ).toEqual({
      source_revision_id: privateRevision.revisionId,
      reviewed_by_principal_id: alice,
      expiry_kind: "no-expiry",
    });
    expect(
      database.db
        .prepare(
          "SELECT parent_id FROM memory_lineage_edges WHERE child_revision_id = ? AND parent_kind = 'resource-revision'",
        )
        .get(projection.copyRevisionId),
    ).toEqual({ parent_id: privateRevision.revisionId });
  });

  it("requires independent source project and target publisher authority", () => {
    const source = createBuiltinScopedMemoryStore({
      agentId,
      scopeKind: "user",
      audienceKind: "user",
      audienceId: alice,
      authorityKind: "user",
      authorityOwnerId: alice,
      defaultCapabilities: ["read"],
      actor: { kind: "human", id: alice },
      reason: "no project authority",
    });
    const target = projectionStore();
    const sourceRevision = createBuiltinScopedMemoryResource({
      agentId,
      store: source,
      logicalLocator: "private.md",
      content: "private source",
      actor: { kind: "human", id: alice },
    });
    registerBuiltinMemoryProjectionTarget({
      agentId,
      target: { kind: "conversation", id: channel },
      store: target,
      operatorPrincipalId: alice,
    });
    expect(() =>
      createBuiltinMemoryProjection({
        agentId,
        sourceRevisionId: sourceRevision.revisionId,
        target: { kind: "conversation", id: channel },
        publisherPrincipalId: alice,
        reviewedByPrincipalId: alice,
        purpose: "share",
        preview: "preview",
        content: "copy",
        expiry: { kind: "expires", expiresAt: Date.now() + 60_000 },
      }),
    ).toThrow("memory sharing authorization is unavailable");
  });

  it("revokes the copy and removes every future read", () => {
    const source = sourceStore();
    const target = projectionStore();
    const sourceRevision = createBuiltinScopedMemoryResource({
      agentId,
      store: source,
      logicalLocator: "private.md",
      content: "private source",
      actor: { kind: "human", id: alice },
    });
    registerBuiltinMemoryProjectionTarget({
      agentId,
      target: { kind: "conversation", id: channel },
      store: target,
      operatorPrincipalId: alice,
    });
    const projection = createBuiltinMemoryProjection({
      agentId,
      sourceRevisionId: sourceRevision.revisionId,
      target: { kind: "conversation", id: channel },
      publisherPrincipalId: alice,
      reviewedByPrincipalId: alice,
      purpose: "share",
      preview: "preview",
      content: "copy",
      expiry: { kind: "expires", expiresAt: Date.now() + 60_000 },
    });

    const database = openOpenClawAgentDatabase({ agentId });
    database.db
      .prepare(
        `INSERT INTO memory_policy_sets
          (policy_set_id, agent_id, memory_policy_revision, member_policy_set_ids_json, created_at)
         VALUES ('projection-impact-policy-set', ?, 'policy-revision', '[]', 1)`,
      )
      .run(agentId);
    database.db
      .prepare(
        `INSERT INTO memory_run_exposures
          (exposure_set_id, agent_id, run_id, context_fingerprint, plan_id, revision_number,
           previous_exposure_set_id, source_policy_set_ids_json, effective_source_policy_set_id,
           exposed_resource_revisions_json, exposure_receipt_ids_json, egress_receipt_ids_json,
           delivery_audiences_json, delivery_revision, egress_registry_revision, created_at)
         VALUES ('projection-impact-exposure', ?, 'run-impact', 'context', 'plan', 1, NULL, '[]',
           'projection-impact-policy-set', '[]', '[]', '[]', '[]', 'delivery', 'egress', 1)`,
      )
      .run(agentId);
    database.db
      .prepare(
        `INSERT INTO memory_run_exposure_resources
          (exposure_set_id, resource_revision_id, policy_set_id, created_at)
         VALUES ('projection-impact-exposure', ?, 'projection-impact-policy-set', 1)`,
      )
      .run(projection.copyRevisionId);

    expect(
      revokeBuiltinMemoryProjection({
        agentId,
        projectionId: projection.projectionId,
        operatorPrincipalId: alice,
      }),
    ).toEqual(["projection-impact-exposure"]);
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId,
        storeIds: [target.storeId],
        revisionId: projection.copyRevisionId,
      }),
    ).toBeUndefined();
  });

  it("persists expiry and reports every already-recorded target exposure", () => {
    const nowMs = Date.now();
    const source = sourceStore();
    const target = projectionStore();
    const sourceRevision = createBuiltinScopedMemoryResource({
      agentId,
      store: source,
      logicalLocator: "private.md",
      content: "private source",
      actor: { kind: "human", id: alice },
      nowMs,
    });
    registerBuiltinMemoryProjectionTarget({
      agentId,
      target: { kind: "conversation", id: channel },
      store: target,
      operatorPrincipalId: alice,
      nowMs,
    });
    const projection = createBuiltinMemoryProjection({
      agentId,
      sourceRevisionId: sourceRevision.revisionId,
      target: { kind: "conversation", id: channel },
      publisherPrincipalId: alice,
      reviewedByPrincipalId: alice,
      purpose: "short lived",
      preview: "short lived copy",
      content: "approved copy",
      expiry: { kind: "expires", expiresAt: nowMs + 1 },
      nowMs,
    });
    const database = openOpenClawAgentDatabase({ agentId });
    database.db
      .prepare(
        `INSERT INTO memory_policy_sets
          (policy_set_id, agent_id, memory_policy_revision, member_policy_set_ids_json, created_at)
         VALUES ('expiry-impact-policy-set', ?, 'policy-revision', '[]', 1)`,
      )
      .run(agentId);
    database.db
      .prepare(
        `INSERT INTO memory_run_exposures
          (exposure_set_id, agent_id, run_id, context_fingerprint, plan_id, revision_number,
           previous_exposure_set_id, source_policy_set_ids_json, effective_source_policy_set_id,
           exposed_resource_revisions_json, exposure_receipt_ids_json, egress_receipt_ids_json,
           delivery_audiences_json, delivery_revision, egress_registry_revision, created_at)
         VALUES ('expiry-impact-exposure', ?, 'run-impact', 'context', 'plan', 1, NULL, '[]',
           'expiry-impact-policy-set', '[]', '[]', '[]', '[]', 'delivery', 'egress', 1)`,
      )
      .run(agentId);
    database.db
      .prepare(
        `INSERT INTO memory_run_exposure_resources
          (exposure_set_id, resource_revision_id, policy_set_id, created_at)
         VALUES ('expiry-impact-exposure', ?, 'expiry-impact-policy-set', 1)`,
      )
      .run(projection.copyRevisionId);

    expect(expireBuiltinMemoryProjections({ agentId, nowMs: nowMs + 1 })).toEqual([
      { projectionId: projection.projectionId, exposureSetIds: ["expiry-impact-exposure"] },
    ]);
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId,
        storeIds: [target.storeId],
        revisionId: projection.copyRevisionId,
        nowMs: nowMs + 1,
      }),
    ).toBeUndefined();
    expect(
      database.db
        .prepare("SELECT state FROM memory_projections WHERE projection_id = ?")
        .get(projection.projectionId),
    ).toEqual({ state: "expired" });
  });

  it("refreshes only by creating a new reviewed copy and revoking the old one", () => {
    const source = sourceStore();
    const target = projectionStore();
    const firstSource = createBuiltinScopedMemoryResource({
      agentId,
      store: source,
      logicalLocator: "private-v1.md",
      content: "private v1",
      actor: { kind: "human", id: alice },
    });
    const secondSource = createBuiltinScopedMemoryResource({
      agentId,
      store: source,
      logicalLocator: "private-v2.md",
      content: "private v2",
      actor: { kind: "human", id: alice },
    });
    registerBuiltinMemoryProjectionTarget({
      agentId,
      target: { kind: "conversation", id: channel },
      store: target,
      operatorPrincipalId: alice,
    });
    const original = createBuiltinMemoryProjection({
      agentId,
      sourceRevisionId: firstSource.revisionId,
      target: { kind: "conversation", id: channel },
      publisherPrincipalId: alice,
      reviewedByPrincipalId: alice,
      purpose: "share v1",
      preview: "v1",
      content: "approved v1",
      expiry: { kind: "no-expiry", auditReason: "initial review" },
    });

    const refreshed = refreshBuiltinMemoryProjection({
      agentId,
      projectionId: original.projectionId,
      sourceRevisionId: secondSource.revisionId,
      publisherPrincipalId: alice,
      reviewedByPrincipalId: alice,
      purpose: "share v2",
      preview: "v2",
      content: "approved v2",
      expiry: { kind: "no-expiry", auditReason: "new review" },
    });

    expect(refreshed.projection.projectionId).not.toBe(original.projectionId);
    expect(refreshed.projection.copyRevisionId).not.toBe(original.copyRevisionId);
    expect(refreshed.projection.sourceRevisionId).toBe(secondSource.revisionId);
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId,
        storeIds: [target.storeId],
        revisionId: original.copyRevisionId,
      }),
    ).toBeUndefined();
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId,
        storeIds: [target.storeId],
        revisionId: refreshed.projection.copyRevisionId,
      })?.content,
    ).toBe("approved v2");
  });

  it("keeps postbox off by default and makes review-required deposits one-way", () => {
    const target = privateTargetStore();
    expect(
      depositFromVerifiedTurn({ content: "observation", sourceMessageRef: "message-ref-off" }),
    ).toEqual({ accepted: false });

    setBuiltinMemoryPostboxMode({
      agentId,
      targetStoreId: target.storeId,
      operatorPrincipalId: alice,
      mode: "review-required",
    });
    expect(
      depositBuiltinMemoryPostbox({ agentId, sourceHandleId: "forged", content: "observation" }),
    ).toEqual({ accepted: false });
    expect(
      depositFromVerifiedTurn({ content: "observation", sourceMessageRef: "message-ref-live" }),
    ).toEqual({ accepted: true });

    const database = openOpenClawAgentDatabase({ agentId });
    const item = database.db.prepare("SELECT item_id, state FROM memory_postbox_items").get() as {
      item_id: string;
      state: string;
    };
    expect(item.state).toBe("postbox");
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM memory_resources").get()).toEqual({
      count: 0,
    });
    reviewBuiltinMemoryPostboxItem({
      agentId,
      itemId: item.item_id,
      operatorPrincipalId: alice,
      decision: "approve",
    });
    expect(database.db.prepare("SELECT state FROM memory_postbox_items").get()).toEqual({
      state: "reviewed",
    });
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM memory_resources").get()).toEqual({
      count: 0,
    });
  });

  it("enforces the persisted per-channel target cap without exposing deposited content", () => {
    const target = privateTargetStore();
    setBuiltinMemoryPostboxMode({
      agentId,
      targetStoreId: target.storeId,
      operatorPrincipalId: alice,
      mode: "review-required",
    });
    for (let index = 0; index < 13; index += 1) {
      expect(
        depositFromVerifiedTurn({
          content: `observation-${index}`,
          sourceMessageRef: `message-${index}`,
        }),
      ).toEqual({ accepted: index < 12 });
    }
    const database = openOpenClawAgentDatabase({ agentId });
    expect(
      database.db.prepare("SELECT deposit_count FROM memory_postbox_rate_limits").get(),
    ).toEqual({
      deposit_count: 12,
    });
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM memory_postbox_items").get()).toEqual(
      {
        count: 12,
      },
    );
  });
});
