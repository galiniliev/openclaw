import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitMemoryPostboxTurnIngress,
  mintMemoryPostboxTurnCapability,
  resetMemoryPostboxTurnCapabilitiesForTest,
} from "../../../../src/gateway/memory-postbox-turn-capability.js";
import { openOpenClawAgentDatabase } from "../../../../src/state/openclaw-agent-db.js";
import {
  createBuiltinScopedMemoryResource,
  createBuiltinScopedMemoryResourceRevision,
  readBuiltinScopedMemoryRevisionSnapshot,
} from "./scoped-memory-resources.js";
import {
  createBuiltinMemoryProjection,
  depositBuiltinMemoryPostbox,
  depositBuiltinMemoryPostboxFromTurnCapability,
  expireBuiltinMemoryProjections,
  inspectBuiltinMemoryProjectionImpact,
  inspectBuiltinMemorySharingStatus,
  inspectBuiltinMemoryPostboxItem,
  previewBuiltinMemoryProjection,
  refreshBuiltinMemoryProjection,
  registerBuiltinMemoryProjectionTarget,
  revokeBuiltinMemoryProjection,
  reviewBuiltinMemoryPostboxItem,
  setBuiltinMemoryPostboxMode,
  setBuiltinMemoryPostboxModeForPrincipal,
} from "./scoped-memory-sharing.js";
import { createBuiltinScopedMemoryStore } from "./scoped-memory-store.js";

const createCurrentMemorySessionContext = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/state/memory-session-subject.js", () => ({
  createCurrentMemorySessionContext,
}));

describe("builtin scoped memory sharing", () => {
  let stateDir = "";
  const agentId = "main";
  const alice = "principal-alice";
  const channel = "conversation-team";

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-sharing-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    createCurrentMemorySessionContext.mockReturnValue({
      kind: "current",
      context: {
        subject: { kind: "user" },
        principalId: alice,
        fingerprint: "alice-current-session",
      },
    });
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    resetMemoryPostboxTurnCapabilitiesForTest();
    createCurrentMemorySessionContext.mockReset();
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

  function sharedProjectionStore(params: {
    kind: "role" | "agent-shared";
    id: string;
    allowPublish: boolean;
  }) {
    return createBuiltinScopedMemoryStore({
      agentId,
      scopeKind: params.kind,
      audienceKind: params.kind,
      audienceId: params.id,
      authorityKind: params.kind,
      authorityOwnerId: params.id,
      defaultCapabilities: ["read"],
      policyEntries: [
        ...(params.allowPublish
          ? [
              {
                kind: "publish" as const,
                effect: "allow" as const,
                principalId: alice,
                operation: "publish" as const,
                grantorPrincipalId: alice,
                reason: "named shared publisher",
              },
            ]
          : []),
        {
          effect: "allow",
          principalId: alice,
          operation: "policy-admin",
          grantorPrincipalId: alice,
          reason: "projection administrator",
        },
      ],
      actor: { kind: "human", id: alice },
      reason: "test shared projection target",
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
    const sourceContext = {};
    const sourceTurnId = `channel-user:v1:${params.sourceMessageRef}`;
    admitMemoryPostboxTurnIngress({
      context: sourceContext,
      agentId,
      sessionKey,
      sessionId: "session-alice",
      provider: "telegram",
      inputProvenance: { kind: "external_user" },
      sourceTurnId,
      sourceChannelRef: "telegram:account:direct-alice",
      senderEvidenceRef: "telegram:sender-alice",
    });
    const token = mintMemoryPostboxTurnCapability({
      agentId,
      runId,
      sessionKey,
      sessionId: "session-alice",
      sourceContext,
    });
    if (!token) {
      throw new Error("expected verified turn capability");
    }
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
          `SELECT target_audience_kind, target_audience_id, source_revision_id, publisher_principal_id,
                  reviewed_by_principal_id, purpose, preview, expiry_kind, expiry_audit_reason,
                  revocation_behavior, state
             FROM memory_projections`,
        )
        .get(),
    ).toEqual({
      target_audience_kind: "conversation",
      target_audience_id: channel,
      source_revision_id: privateRevision.revisionId,
      publisher_principal_id: alice,
      reviewed_by_principal_id: alice,
      purpose: "share approved contact detail",
      preview: "one approved detail",
      expiry_kind: "no-expiry",
      expiry_audit_reason: "owner approved durable reference",
      revocation_behavior: "tombstone-copy",
      state: "active",
    });
    expect(
      database.db
        .prepare(
          "SELECT parent_id FROM memory_lineage_edges WHERE child_revision_id = ? AND parent_kind = 'resource-revision'",
        )
        .get(projection.copyRevisionId),
    ).toEqual({ parent_id: privateRevision.revisionId });
  });

  it("previews the authorized projection metadata without reading or changing the private source", () => {
    const source = sourceStore();
    const target = projectionStore();
    const privateRevision = createBuiltinScopedMemoryResource({
      agentId,
      store: source,
      logicalLocator: "private.md",
      content: "private source that must not appear in preview",
      actor: { kind: "human", id: alice },
    });
    registerBuiltinMemoryProjectionTarget({
      agentId,
      target: { kind: "conversation", id: channel },
      store: target,
      operatorPrincipalId: alice,
    });

    expect(
      previewBuiltinMemoryProjection({
        agentId,
        sourceRevisionId: privateRevision.revisionId,
        target: { kind: "conversation", id: channel },
        publisherPrincipalId: alice,
        purpose: "share approved contact detail",
        preview: "one approved detail",
        expiry: { kind: "no-expiry", auditReason: "owner approved durable reference" },
      }),
    ).toEqual({
      sourceRevisionId: privateRevision.revisionId,
      target: { kind: "conversation", id: channel },
      purpose: "share approved contact detail",
      preview: "one approved detail",
      expiry: "no-expiry",
    });
    expect(
      openOpenClawAgentDatabase({ agentId })
        .db.prepare("SELECT COUNT(*) AS count FROM memory_projections")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("refuses raw private-user projection targets before a helper can create a direct grant", () => {
    const privateTarget = privateTargetStore();
    expect(() =>
      registerBuiltinMemoryProjectionTarget({
        agentId,
        target: { kind: "user", id: "principal-bob" } as never,
        store: privateTarget,
        operatorPrincipalId: alice,
      }),
    ).toThrow("memory projection target is unavailable");
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

  it.each([
    { kind: "role" as const, id: "support" },
    { kind: "agent-shared" as const, id: agentId },
  ])("requires an explicit publisher for a $kind projection target", ({ kind, id }) => {
    const source = sourceStore();
    const sourceRevision = createBuiltinScopedMemoryResource({
      agentId,
      store: source,
      logicalLocator: `${kind}-source.md`,
      content: "private source",
      actor: { kind: "human", id: alice },
    });
    const readOnlyTarget = sharedProjectionStore({ kind, id, allowPublish: false });
    registerBuiltinMemoryProjectionTarget({
      agentId,
      target: { kind, id },
      store: readOnlyTarget,
      operatorPrincipalId: alice,
    });
    expect(() =>
      createBuiltinMemoryProjection({
        agentId,
        sourceRevisionId: sourceRevision.revisionId,
        target: { kind, id },
        publisherPrincipalId: alice,
        reviewedByPrincipalId: alice,
        purpose: "share",
        preview: "preview",
        content: "copy",
        expiry: { kind: "expires", expiresAt: Date.now() + 60_000 },
      }),
    ).toThrow("memory sharing authorization is unavailable");

    const publisherTarget = sharedProjectionStore({ kind, id, allowPublish: true });
    registerBuiltinMemoryProjectionTarget({
      agentId,
      target: { kind, id },
      store: publisherTarget,
      operatorPrincipalId: alice,
    });
    expect(
      createBuiltinMemoryProjection({
        agentId,
        sourceRevisionId: sourceRevision.revisionId,
        target: { kind, id },
        publisherPrincipalId: alice,
        reviewedByPrincipalId: alice,
        purpose: "share",
        preview: "preview",
        content: "copy",
        expiry: { kind: "expires", expiresAt: Date.now() + 60_000 },
      }),
    ).toMatchObject({ target: { kind, id } });
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
      inspectBuiltinMemoryProjectionImpact({
        agentId,
        projectionId: projection.projectionId,
        operatorPrincipalId: alice,
      }),
    ).toEqual({
      projectionId: projection.projectionId,
      exposureSetIds: ["projection-impact-exposure"],
    });
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId,
        storeIds: [target.storeId],
        revisionId: projection.copyRevisionId,
      }),
    ).toBeUndefined();
    closeOpenClawAgentDatabasesForTest();
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

    const editedSource = createBuiltinScopedMemoryResourceRevision({
      agentId,
      resourceId: firstSource.resourceId,
      content: "private v1 edited",
      actor: { kind: "human", id: alice },
    });
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId,
        storeIds: [target.storeId],
        revisionId: original.copyRevisionId,
      }),
    ).toBeUndefined();
    expect(
      openOpenClawAgentDatabase({ agentId })
        .db.prepare("SELECT count(*) AS count FROM memory_projections")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      openOpenClawAgentDatabase({ agentId })
        .db.prepare("SELECT count(*) AS count FROM memory_projections WHERE source_revision_id = ?")
        .get(editedSource.revisionId),
    ).toEqual({ count: 0 });

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

  it("rolls back a replacement when the old projection no longer has the same audience", () => {
    const source = sourceStore();
    const target = projectionStore();
    const otherChannel = "conversation-other";
    const otherTarget = createBuiltinScopedMemoryStore({
      agentId,
      scopeKind: "conversation",
      audienceKind: "conversation",
      audienceId: otherChannel,
      authorityKind: "conversation",
      authorityOwnerId: otherChannel,
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
      reason: "different projection target",
    });
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
    registerBuiltinMemoryProjectionTarget({
      agentId,
      target: { kind: "conversation", id: otherChannel },
      store: otherTarget,
      operatorPrincipalId: alice,
    });
    const original = createBuiltinMemoryProjection({
      agentId,
      sourceRevisionId: sourceRevision.revisionId,
      target: { kind: "conversation", id: channel },
      publisherPrincipalId: alice,
      reviewedByPrincipalId: alice,
      purpose: "share",
      preview: "original",
      content: "original approved copy",
      expiry: { kind: "no-expiry", auditReason: "approved" },
    });

    expect(() =>
      createBuiltinMemoryProjection({
        agentId,
        sourceRevisionId: sourceRevision.revisionId,
        target: { kind: "conversation", id: otherChannel },
        publisherPrincipalId: alice,
        reviewedByPrincipalId: alice,
        purpose: "share",
        preview: "replacement",
        content: "must never become readable",
        expiry: { kind: "no-expiry", auditReason: "approved" },
        replaceActiveProjectionId: original.projectionId,
      }),
    ).toThrow("memory projection is unavailable");
    expect(
      openOpenClawAgentDatabase({ agentId })
        .db.prepare("SELECT COUNT(*) AS count FROM memory_projections")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId,
        storeIds: [target.storeId],
        revisionId: original.copyRevisionId,
      })?.content,
    ).toBe("original approved copy");
  });

  it("keeps postbox off by default and promotes only an explicitly approved reviewed copy", () => {
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
    closeOpenClawAgentDatabasesForTest();
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
      reviewedContent: "owner-edited review copy",
    });
    expect(database.db.prepare("SELECT state FROM memory_postbox_items").get()).toEqual({
      state: "reviewed",
    });
    const reviewedCopy = database.db
      .prepare(`SELECT revision_id FROM memory_postbox_reviewed_copies WHERE item_id = ?`)
      .get(item.item_id) as { revision_id: string };
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId,
        storeIds: [target.storeId],
        revisionId: reviewedCopy.revision_id,
      })?.content,
    ).toBe("owner-edited review copy");
    closeOpenClawAgentDatabasesForTest();
    expect(() =>
      inspectBuiltinMemoryPostboxItem({
        agentId,
        itemId: item.item_id,
        operatorPrincipalId: alice,
      }),
    ).toThrow("memory postbox item is unavailable");
    expect(
      openOpenClawAgentDatabase({ agentId })
        .db.prepare("SELECT state FROM memory_postbox_items WHERE item_id = ?")
        .get(item.item_id),
    ).toEqual({ state: "reviewed" });
    reviewBuiltinMemoryPostboxItem({
      agentId,
      itemId: item.item_id,
      operatorPrincipalId: alice,
      decision: "purge",
    });
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId,
        storeIds: [target.storeId],
        revisionId: reviewedCopy.revision_id,
      }),
    ).toBeUndefined();
    expect(
      openOpenClawAgentDatabase({ agentId })
        .db.prepare("SELECT item_id FROM memory_postbox_reviewed_copies WHERE item_id = ?")
        .get(item.item_id),
    ).toEqual({ item_id: item.item_id });
    expect(
      openOpenClawAgentDatabase({ agentId })
        .db.prepare("SELECT state, content, purged_at FROM memory_postbox_items WHERE item_id = ?")
        .get(item.item_id),
    ).toMatchObject({ state: "purged", content: "", purged_at: expect.any(Number) });
  });

  it("rolls back a purge when the durable postbox redaction cannot commit", () => {
    const target = privateTargetStore();
    setBuiltinMemoryPostboxMode({
      agentId,
      targetStoreId: target.storeId,
      operatorPrincipalId: alice,
      mode: "review-required",
    });
    expect(
      depositFromVerifiedTurn({
        content: "review body",
        sourceMessageRef: "message-purge-rollback",
      }),
    ).toEqual({ accepted: true });

    const database = openOpenClawAgentDatabase({ agentId });
    const item = database.db.prepare("SELECT item_id FROM memory_postbox_items").get() as {
      item_id: string;
    };
    reviewBuiltinMemoryPostboxItem({
      agentId,
      itemId: item.item_id,
      operatorPrincipalId: alice,
      decision: "approve",
      reviewedContent: "owner-reviewed body",
    });
    const reviewedCopy = database.db
      .prepare("SELECT revision_id FROM memory_postbox_reviewed_copies WHERE item_id = ?")
      .get(item.item_id) as { revision_id: string };
    database.db.exec(`
      CREATE TRIGGER fail_postbox_purge_redaction
      BEFORE UPDATE OF state ON memory_postbox_items
      WHEN NEW.state = 'purged'
      BEGIN
        SELECT RAISE(ABORT, 'forced postbox purge redaction failure');
      END;
    `);

    try {
      expect(() =>
        reviewBuiltinMemoryPostboxItem({
          agentId,
          itemId: item.item_id,
          operatorPrincipalId: alice,
          decision: "purge",
        }),
      ).toThrow("forced postbox purge redaction failure");
    } finally {
      database.db.exec("DROP TRIGGER fail_postbox_purge_redaction");
    }

    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId,
        storeIds: [target.storeId],
        revisionId: reviewedCopy.revision_id,
      })?.content,
    ).toBe("owner-reviewed body");
    expect(
      database.db
        .prepare(
          "SELECT state, content, content_hash, purged_at FROM memory_postbox_items WHERE item_id = ?",
        )
        .get(item.item_id),
    ).toMatchObject({
      state: "reviewed",
      content: "review body",
      content_hash: expect.any(String),
      purged_at: null,
    });
    expect(
      database.db
        .prepare(
          "SELECT lifecycle_state, retired_at FROM memory_resource_revisions WHERE revision_id = ?",
        )
        .get(reviewedCopy.revision_id),
    ).toEqual({ lifecycle_state: "active", retired_at: null });
    expect(
      database.db
        .prepare("SELECT revision_id FROM memory_postbox_reviewed_copies WHERE item_id = ?")
        .get(item.item_id),
    ).toEqual({ revision_id: reviewedCopy.revision_id });
    const remainingChunks = database.db
      .prepare("SELECT COUNT(*) AS count FROM memory_scoped_chunks WHERE revision_id = ?")
      .get(reviewedCopy.revision_id) as { count: number };
    expect(remainingChunks.count).toBeGreaterThan(0);
  });

  it("denies forged, stale, cross-run, cross-session, and replayed postbox capabilities", () => {
    const target = privateTargetStore();
    setBuiltinMemoryPostboxMode({
      agentId,
      targetStoreId: target.storeId,
      operatorPrincipalId: alice,
      mode: "review-required",
    });
    const sourceContext = {};
    const sourceTurnId = "channel-user:v1:message-capability";
    admitMemoryPostboxTurnIngress({
      context: sourceContext,
      agentId,
      sessionKey: "agent:main:direct:alice",
      sessionId: "session-alice",
      provider: "telegram",
      inputProvenance: { kind: "external_user" },
      sourceTurnId,
      sourceChannelRef: "telegram:account:direct-alice",
      senderEvidenceRef: "telegram:sender-alice",
    });
    const token = mintMemoryPostboxTurnCapability({
      agentId,
      runId: "run-capability",
      sessionKey: "agent:main:direct:alice",
      sessionId: "session-alice",
      sourceContext,
    });
    if (!token) {
      throw new Error("expected verified turn capability");
    }
    const deposit = (
      overrides: Partial<{
        runId: string;
        sessionKey: string;
        sessionId: string;
        turnCapability: string;
      }> = {},
    ) =>
      depositBuiltinMemoryPostboxFromTurnCapability({
        agentId,
        runId: "run-capability",
        sessionKey: "agent:main:direct:alice",
        sessionId: "session-alice",
        turnCapability: token,
        content: "one-way observation",
        ...overrides,
      });

    expect(deposit({ turnCapability: "forged" })).toEqual({ accepted: false });
    expect(deposit({ runId: "other-run" })).toEqual({ accepted: false });
    expect(deposit({ sessionId: "other-session" })).toEqual({ accepted: false });
    createCurrentMemorySessionContext.mockReturnValueOnce({
      kind: "current",
      context: {
        subject: { kind: "user" },
        principalId: alice,
        fingerprint: "rebound-session",
      },
    });
    expect(deposit()).toEqual({ accepted: false });
    expect(deposit()).toEqual({ accepted: true });
    expect(deposit()).toEqual({ accepted: false });
  });

  it("derives the owner quarantine internally and returns only redacted sharing status", () => {
    const source = sourceStore();
    const target = projectionStore();
    privateTargetStore();
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
      purpose: "share approved detail",
      preview: "approved detail",
      content: "reviewed copy only",
      expiry: { kind: "no-expiry", auditReason: "durable approved reference" },
    });

    setBuiltinMemoryPostboxModeForPrincipal({
      agentId,
      principalId: alice,
      mode: "review-required",
    });

    expect(inspectBuiltinMemorySharingStatus({ agentId, operatorPrincipalId: alice })).toEqual({
      postboxMode: "review-required",
      projections: [
        {
          projectionId: projection.projectionId,
          target: { kind: "conversation", id: channel },
          purpose: "share approved detail",
          preview: "approved detail",
          state: "active",
          expiresAt: null,
        },
      ],
      postboxItems: [],
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
    closeOpenClawAgentDatabasesForTest();
    expect(
      depositFromVerifiedTurn({
        content: "observation-after-reopen",
        sourceMessageRef: "message-after-reopen",
      }),
    ).toEqual({ accepted: false });
    expect(
      openOpenClawAgentDatabase({ agentId })
        .db.prepare("SELECT deposit_count FROM memory_postbox_rate_limits")
        .get(),
    ).toEqual({ deposit_count: 12 });
  });

  it("limits postbox body inspection to the target owner and persists a purged audit record", () => {
    const target = privateTargetStore();
    setBuiltinMemoryPostboxMode({
      agentId,
      targetStoreId: target.storeId,
      operatorPrincipalId: alice,
      mode: "review-required",
    });
    expect(
      depositFromVerifiedTurn({
        content: "private review body",
        sourceMessageRef: "message-inspect",
      }),
    ).toEqual({ accepted: true });
    const database = openOpenClawAgentDatabase({ agentId });
    const item = database.db.prepare("SELECT item_id FROM memory_postbox_items").get() as {
      item_id: string;
    };

    expect(
      inspectBuiltinMemoryPostboxItem({
        agentId,
        itemId: item.item_id,
        operatorPrincipalId: alice,
      }),
    ).toMatchObject({
      itemId: item.item_id,
      content: "private review body",
      sourceChannelRef: "telegram:account:direct-alice",
    });
    expect(() =>
      inspectBuiltinMemoryPostboxItem({
        agentId,
        itemId: item.item_id,
        operatorPrincipalId: "principal-mallory",
      }),
    ).toThrow("memory sharing authorization is unavailable");

    reviewBuiltinMemoryPostboxItem({
      agentId,
      itemId: item.item_id,
      operatorPrincipalId: alice,
      decision: "purge",
      nowMs: 1_700_000_000_000,
    });
    expect(
      database.db.prepare("SELECT state, content, purged_at FROM memory_postbox_items").get(),
    ).toEqual({
      state: "purged",
      content: "",
      purged_at: 1_700_000_000_000,
    });
    expect(() =>
      inspectBuiltinMemoryPostboxItem({
        agentId,
        itemId: item.item_id,
        operatorPrincipalId: alice,
      }),
    ).toThrow("memory postbox item is unavailable");
  });
});
