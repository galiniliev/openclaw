import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openOpenClawAgentDatabase } from "../../../../src/state/openclaw-agent-db.js";
import {
  createBuiltinScopedMemoryResource,
  readBuiltinScopedMemoryRevisionSnapshot,
} from "./scoped-memory-resources.js";
import {
  createBuiltinMemoryProjection,
  depositBuiltinMemoryPostbox,
  issueBuiltinMemoryPostboxSourceHandle,
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
        .prepare("SELECT source_revision_id, reviewed_by_principal_id, expiry_kind FROM memory_projections")
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

  it("keeps postbox off by default and makes review-required deposits one-way", () => {
    const target = privateTargetStore();
    const offHandle = issueBuiltinMemoryPostboxSourceHandle({
      agentId,
      sourceSessionId: "group-session",
      sourceChannelRef: "channel-ref",
      sourceMessageRef: "message-ref-off",
      senderEvidenceRef: "sender-proof",
      targetStoreId: target.storeId,
    });
    expect(depositBuiltinMemoryPostbox({ agentId, sourceHandleId: offHandle, content: "observation" })).toEqual({ accepted: false });

    setBuiltinMemoryPostboxMode({
      agentId,
      targetStoreId: target.storeId,
      operatorPrincipalId: alice,
      mode: "review-required",
    });
    const handle = issueBuiltinMemoryPostboxSourceHandle({
      agentId,
      sourceSessionId: "group-session",
      sourceChannelRef: "channel-ref",
      sourceMessageRef: "message-ref-live",
      senderEvidenceRef: "sender-proof",
      targetStoreId: target.storeId,
    });
    expect(depositBuiltinMemoryPostbox({ agentId, sourceHandleId: "forged", content: "observation" })).toEqual({ accepted: false });
    expect(depositBuiltinMemoryPostbox({ agentId, sourceHandleId: handle, content: "observation" })).toEqual({ accepted: true });
    expect(depositBuiltinMemoryPostbox({ agentId, sourceHandleId: handle, content: "observation" })).toEqual({ accepted: false });

    const database = openOpenClawAgentDatabase({ agentId });
    const item = database.db.prepare("SELECT item_id, state FROM memory_postbox_items").get() as { item_id: string; state: string };
    expect(item.state).toBe("postbox");
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM memory_resources").get()).toEqual({ count: 0 });
    reviewBuiltinMemoryPostboxItem({
      agentId,
      itemId: item.item_id,
      operatorPrincipalId: alice,
      decision: "approve",
    });
    expect(database.db.prepare("SELECT state FROM memory_postbox_items").get()).toEqual({ state: "reviewed" });
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM memory_resources").get()).toEqual({ count: 0 });
  });
});
