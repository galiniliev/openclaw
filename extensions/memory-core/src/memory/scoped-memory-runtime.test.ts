import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  MemoryAccessContext,
  MemoryContentAccessContext,
} from "openclaw/plugin-sdk/memory-authorization";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuthorizedMemoryReadHost,
  createAuthorizedMemoryWriteHost,
  resolveAuthorizedMemoryVirtualFileBroker,
} from "../../../../src/agents/memory-authorized-read-host.js";
import { prepareMemoryEgressAuthorization } from "../../../../src/agents/memory-egress-admission.js";
import { createReplyDispatcher } from "../../../../src/auto-reply/reply/reply-dispatcher.js";
import { buildTestCtx } from "../../../../src/auto-reply/reply/test-ctx.js";
import {
  consumeAdmittedChannelMemoryIdentityFromContext,
  createChannelMemoryIdentityAdmission,
} from "../../../../src/channels/message-access/memory-identity-admission.js";
import { writeSessionEntry } from "../../../../src/config/sessions/session-accessor.sqlite-entry-store.js";
import { appendSqliteTranscriptMessage } from "../../../../src/config/sessions/session-accessor.sqlite-transcript-write.js";
import { readAuthorizedTranscriptDerivation } from "../../../../src/config/sessions/session-transcript-memory-policy.js";
import { withOwnedSessionTranscriptWrites } from "../../../../src/config/sessions/transcript-write-context.js";
import {
  registerAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../../../../src/infra/agent-run-registry.js";
import { admitMemoryAuthorizationReadRuntime } from "../../../../src/plugins/memory-authorization-runtime.js";
import { resetMemoryIsolationCutoverForTest } from "../../../../src/plugins/memory-cutover.js";
import {
  persistMemoryRunExposureBeforeContentInDatabase,
  readLatestDurableMemoryRunExposure,
} from "../../../../src/plugins/memory-run-exposure-ledger.js";
import { prepareMemoryRunExposure } from "../../../../src/plugins/memory-run-exposure.js";
import { createEmptyPluginRegistry } from "../../../../src/plugins/registry-empty.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../../src/plugins/runtime.js";
import {
  adminLinkAdmittedMemoryIdentity,
  ensureMemoryOperationalPrincipal,
  revokeMemoryIdentityBinding,
} from "../../../../src/state/memory-identity.js";
import {
  admitInboundMemorySessionContext,
  createCurrentMemorySessionContext,
} from "../../../../src/state/memory-session-subject.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../../../src/state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../../src/state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../../../src/state/user-profiles.js";
import { MEMORY_CORE_AUTHORIZATION_CAPABILITIES } from "../authorization.js";
import { resolveScopedMemoryArtifactBase, withScopedMemoryDatabase } from "./scoped-memory-db.js";
import { builtinScopedMemoryConformanceAdapter } from "./scoped-memory-policy.js";
import {
  createBuiltinScopedMemoryResource,
  readBuiltinScopedMemoryRevisionSnapshot,
  setBuiltinScopedMemoryRevisionLifecycle,
} from "./scoped-memory-resources.js";
import {
  builtinScopedMemoryAuthorizedRuntime,
  builtinScopedMemoryVirtualView,
  resetBuiltinScopedMemoryAuthorizedRuntimeForTest,
} from "./scoped-memory-runtime.js";
import { createBuiltinScopedMemoryStore } from "./scoped-memory-store.js";

const dispatchReplyFromConfig = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/auto-reply/reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig,
}));

const { dispatchInboundMessage } = await import("../../../../src/auto-reply/dispatch.js");

describe("builtin scoped authorized runtime", () => {
  let stateDir = "";

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-scoped-memory-runtime-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    dispatchReplyFromConfig.mockReset();
    resetBuiltinScopedMemoryAuthorizedRuntimeForTest();
    resetMemoryIsolationCutoverForTest();
    resetAgentRunRegistryForTest();
    resetPluginRuntimeStateForTest();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function markCutOver() {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    database.db
      .prepare(
        `INSERT INTO memory_migrations
          (migration_id, source_kind, source_hash, phase, classification_json, plan_hash,
           verified_at, cutover_at, updated_at)
         VALUES ('scoped-runtime-cutover', 'test', 'test-source', 'cutover', '{}', 'test-plan', 1, 1, 1)`,
      )
      .run();
    resetMemoryIsolationCutoverForTest();
  }

  function installBuiltinSelectedRuntime() {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({ id: "memory-core", memorySlotSelected: true } as never);
    registry.memoryCapabilities.push({
      pluginId: "memory-core",
      capability: {
        authorization: MEMORY_CORE_AUTHORIZATION_CAPABILITIES,
        authorizationConformance: builtinScopedMemoryConformanceAdapter,
        virtualView: builtinScopedMemoryVirtualView,
        runtime: builtinScopedMemoryAuthorizedRuntime,
      },
    });
    setActivePluginRegistry(registry);
  }

  function createSession(params: {
    sessionKey: string;
    sessionId: string;
    chatType: "direct" | "group" | "channel";
    primaryConversationId?: string;
  }) {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)",
      )
      .run(params.sessionKey, params.sessionId, '{"toolsBySender":{"alice":{"role":"owner"}}}');
    if (params.primaryConversationId) {
      database.db
        .prepare(
          `INSERT INTO conversations
           (conversation_id, channel, account_id, kind, peer_id, delivery_target, created_at, updated_at)
           VALUES (?, 'telegram', 'default', ?, ?, ?, 1, 1)`,
        )
        .run(
          params.primaryConversationId,
          params.chatType,
          `${params.chatType}-peer`,
          `${params.chatType}-target`,
        );
    }
    database.db
      .prepare(
        `INSERT INTO session_windows
         (session_id, session_key, created_at, updated_at, chat_type, channel, account_id, primary_conversation_id)
         VALUES (?, ?, 1, 1, ?, 'telegram', 'default', ?)`,
      )
      .run(
        params.sessionId,
        params.sessionKey,
        params.chatType,
        params.primaryConversationId ?? null,
      );
  }

  function createVerifiedDirectSession(params: {
    name: "alice" | "bob";
    sessionKey: string;
    sessionId: string;
  }) {
    createSession({ ...params, chatType: "direct" });
    const profile = ensureProfileForEmail(`${params.name}@example.test`);
    const admission = createChannelMemoryIdentityAdmission({
      pluginId: "telegram",
      adapterId: "plugin:telegram",
      ownsChannel: (channel) => channel === "telegram",
      isActive: () => true,
    });
    const linkingContext = {};
    admission.attachVerifiedDirectSender({
      context: linkingContext,
      channel: "telegram",
      accountId: "default",
      stableSenderId: params.name,
    });
    const proof = consumeAdmittedChannelMemoryIdentityFromContext(linkingContext);
    if (!proof) {
      throw new Error("fixture failed to mint a verified identity admission");
    }
    const binding = adminLinkAdmittedMemoryIdentity({
      admission: proof,
      authenticatedOperatorProfileId: profile.id,
      targetProfileId: profile.id,
      authenticatedOperatorScopes: ["operator.admin"],
    });
    const inboundContext = {};
    admission.attachVerifiedDirectSender({
      context: inboundContext,
      channel: "telegram",
      accountId: "default",
      stableSenderId: params.name,
    });
    const admitted = admitInboundMemorySessionContext({
      context: inboundContext,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      options: { agentId: "main" },
    });
    if (admitted.kind !== "current") {
      throw new Error("fixture failed to persist a verified direct subject");
    }
    return binding.principalId;
  }

  function createConversationSession(params: {
    sessionKey: string;
    sessionId: string;
    conversationId: string;
  }) {
    createSession({
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      chatType: "group",
      primaryConversationId: params.conversationId,
    });
    const admitted = admitInboundMemorySessionContext({
      context: {
        From: "telegram:alice",
        senderRole: "owner",
        toolsBySender: { alice: { role: "owner" } },
      },
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      options: { agentId: "main" },
    });
    if (admitted.kind !== "current" || admitted.context.subject.kind !== "conversation") {
      throw new Error("fixture failed to persist a conversation subject");
    }
    return admitted.context.principalId;
  }

  function createSpawnedChildSession(params: {
    sessionKey: string;
    sessionId: string;
    spawnedBy: string;
  }) {
    runOpenClawAgentWriteTransaction(
      (database) => {
        writeSessionEntry(database, params.sessionKey, {
          sessionId: params.sessionId,
          updatedAt: 1,
          createdVia: "spawn",
          createdActor: { type: "agent", id: "main" },
          spawnedBy: params.spawnedBy,
        });
      },
      { agentId: "main" },
      { operationLabel: "scoped-memory-runtime.test.spawned-child" },
    );
    const current = createCurrentMemorySessionContext({
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      options: { agentId: "main" },
    });
    if (current.kind !== "current" || current.context.subject.kind !== "agent") {
      throw new Error("fixture failed to create an operational child session");
    }
    return current.context;
  }

  function createContext(principalId: string): MemoryContentAccessContext<"read"> {
    return {
      version: 1,
      contextId: `context-${principalId}`,
      contextFingerprint: `fingerprint-${principalId}`,
      requestId: "request-1",
      runId: "run-1",
      agentId: "main",
      sessionKey: `agent:main:direct:${principalId}`,
      sessionId: `session-${principalId}`,
      sessionIdentityRevision: "session-revision-1",
      subjectRevision: "subject-revision-1",
      subject: {
        version: 1,
        kind: "user",
        principalId,
        creationEvidence: { kind: "gateway-profile", revision: `binding-${principalId}` },
      },
      actor: {
        kind: "principal",
        actorKind: "human",
        principalId,
        assurance: "gateway-profile",
        evidenceRevision: `binding-${principalId}`,
      },
      verifiedPrincipals: [
        {
          principalId,
          assurance: "gateway-profile",
          evidenceRevision: `binding-${principalId}`,
        },
      ],
      delivery: {
        sinkKind: "private",
        audiences: [{ kind: "user", id: principalId }],
        egressCapabilityIds: ["reply.final"],
        egressRegistryRevision: "egress-1",
        deliveryRevision: `delivery-${principalId}`,
      },
      collaboration: { kind: "not-applicable" },
      verifiedMemberships: [],
      operation: "read",
      hostFactsRevision: "host-1",
    };
  }

  function createPrivateResource(principalId: string, content: string) {
    const store = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: principalId,
      authorityKind: "user",
      authorityOwnerId: principalId,
      defaultCapabilities: ["retrieve", "read"],
      actor: { kind: "human", id: principalId },
      reason: "private placement",
    });
    return createBuiltinScopedMemoryResource({
      agentId: "main",
      store,
      logicalLocator: "MEMORY.md",
      content,
      actor: { kind: "human", id: principalId },
    });
  }

  function createWriteRecoveryFixture(params: {
    principalId: string;
    content: string;
    placement: "stage" | "final";
    policyRevisionId?: string;
    intentState?: "pending" | "renamed" | "active";
    revisionLifecycleState?: "pending" | "active";
  }) {
    const store = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: params.principalId,
      authorityKind: "user",
      authorityOwnerId: params.principalId,
      defaultCapabilities: ["retrieve", "read", "append"],
      actor: { kind: "human", id: params.principalId },
      reason: "recovery fixture",
    });
    const resourceId = randomUUID();
    const revisionId = randomUUID();
    const intentId = randomUUID();
    const finalLocator = `r1_${revisionId}.md`;
    const stageLocator = `mwst1_${intentId}.tmp`;
    const now = Date.now();
    const intentState = params.intentState ?? "pending";
    const revisionLifecycleState = params.revisionLifecycleState ?? "pending";
    let directory = "";
    let activePolicyRevisionId = "";
    withScopedMemoryDatabase("main", (database, databasePath) => {
      const row = database
        .prepare(
          `SELECT root.path_key, policy.policy_id, policy.current_revision_id, policy.revocation_epoch
             FROM memory_stores AS store
             JOIN memory_storage_roots AS root ON root.storage_root_id = store.storage_root_id
             JOIN memory_policies AS policy ON policy.policy_id = store.policy_id
            WHERE store.store_id = ?`,
        )
        .get(store.storeId) as {
        path_key: string;
        policy_id: string;
        current_revision_id: string;
        revocation_epoch: number;
      };
      activePolicyRevisionId = row.current_revision_id;
      directory = path.join(resolveScopedMemoryArtifactBase(databasePath), row.path_key);
      if (params.policyRevisionId && params.policyRevisionId !== row.current_revision_id) {
        database
          .prepare(
            `INSERT INTO memory_policy_revisions
               (revision_id, policy_id, revision_number, revocation_epoch, lifecycle_state,
                actor_kind, actor_id, reason, created_at)
             VALUES (?, ?, 2, ?, 'superseded', 'human', ?, 'recovery policy drift fixture', ?)`,
          )
          .run(
            params.policyRevisionId,
            row.policy_id,
            row.revocation_epoch,
            params.principalId,
            now,
          );
      }
      database
        .prepare(
          `INSERT INTO memory_resources
             (resource_id, agent_id, store_id, logical_locator, source, created_at)
           VALUES (?, 'main', ?, ?, 'memory', ?)`,
        )
        .run(resourceId, store.storeId, `memory/${revisionId}.md`, now);
      database
        .prepare(
          `INSERT INTO memory_resource_revisions
             (revision_id, resource_id, revision_number, artifact_locator, content_hash, content_bytes,
              policy_revision_id, policy_revocation_epoch, source_policy_set_id, lifecycle_state,
              actor_kind, actor_id, expires_at, created_at, activated_at, retired_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'human', ?, NULL, ?, ?, NULL)`,
        )
        .run(
          revisionId,
          resourceId,
          finalLocator,
          createHash("sha256").update(params.content).digest("hex"),
          Buffer.byteLength(params.content),
          params.policyRevisionId ?? row.current_revision_id,
          row.revocation_epoch,
          `mps1_${params.policyRevisionId ?? row.current_revision_id}`,
          revisionLifecycleState,
          params.principalId,
          now,
          revisionLifecycleState === "active" ? now : null,
        );
      database
        .prepare(
          `INSERT INTO memory_revision_policy_requirements
             (revision_id, policy_id, expected_revision_id, expected_revocation_epoch,
              requirement_kind, created_at)
           VALUES (?, ?, ?, ?, 'output-policy', ?)`,
        )
        .run(
          revisionId,
          row.policy_id,
          params.policyRevisionId ?? row.current_revision_id,
          row.revocation_epoch,
          now,
        );
      database
        .prepare(
          `INSERT INTO memory_write_intents
             (intent_id, idempotency_key, mutation_id, agent_id, request_id, run_id, context_fingerprint,
              plan_id, mutation_kind, store_id, resource_id, pending_revision_id, staged_locator,
              final_locator, content_hash, content_bytes, state, created_at, updated_at, activated_at, indexed_at)
           VALUES (?, ?, ?, 'main', 'request-recovery', 'run-recovery', 'context-recovery',
                   'plan-recovery', 'remember', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          intentId,
          `idempotency-${intentId}`,
          `mutation-${intentId}`,
          store.storeId,
          resourceId,
          revisionId,
          stageLocator,
          finalLocator,
          createHash("sha256").update(params.content).digest("hex"),
          Buffer.byteLength(params.content),
          intentState,
          now,
          now,
          intentState === "active" ? now : null,
          null,
        );
    });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(directory, params.placement === "stage" ? stageLocator : finalLocator),
      params.content,
      { mode: 0o600 },
    );
    return {
      activePolicyRevisionId,
      directory,
      finalLocator,
      intentId,
      revisionId,
      stageLocator,
      storeId: store.storeId,
    };
  }

  it("postfilters before result count and issues plan-bound exact-read handles", async () => {
    expect(MEMORY_CORE_AUTHORIZATION_CAPABILITIES).toMatchObject({
      exposureReceipts: true,
      egressReceipts: true,
    });
    const alice = createPrivateResource("alice", "shared signal from alice");
    createPrivateResource("bob", "shared signal from bob");
    const context = createContext("alice");
    const plan = await builtinScopedMemoryAuthorizedRuntime.authorize(context);
    const result = await builtinScopedMemoryAuthorizedRuntime.searchAuthorized({
      context,
      plan,
      query: "shared signal",
      limit: 10,
    });

    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({ snippet: "shared signal from alice" });
    expect(result.exposureReceipt.exposedRevisionHandles).toEqual([alice.revisionId]);
    expect(result.egressReceipt).toMatchObject({
      planId: plan.planId,
      runId: context.runId,
      allowedAudiences: context.delivery.audiences,
      deliveryRevision: context.delivery.deliveryRevision,
      egressRegistryRevision: context.delivery.egressRegistryRevision,
    });
    const hit = result.value[0];
    if (!hit) {
      return;
    }
    await expect(
      builtinScopedMemoryAuthorizedRuntime.readAuthorized({
        context,
        plan,
        handle: hit.resourceHandle,
      }),
    ).resolves.toMatchObject({ value: { text: "shared signal from alice" } });
    await expect(
      builtinScopedMemoryAuthorizedRuntime.readAuthorized({
        context,
        plan,
        handle: { ...hit.resourceHandle, resourceRevision: "forged" },
      }),
    ).rejects.toThrow("unavailable");
  });

  it("authorizes compaction sources with derive rather than downgrading them to read", async () => {
    const principalId = "derive-owner";
    const store = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: principalId,
      authorityKind: "user",
      authorityOwnerId: principalId,
      defaultCapabilities: ["retrieve", "read", "derive"],
      actor: { kind: "human", id: principalId },
      reason: "derive source fixture",
    });
    createBuiltinScopedMemoryResource({
      agentId: "main",
      store,
      logicalLocator: "MEMORY.md",
      content: "DERIVE_ONLY_SOURCE_SENTINEL",
      actor: { kind: "human", id: principalId },
    });
    const context = {
      ...createContext(principalId),
      operation: "derive" as const,
    } satisfies MemoryContentAccessContext<"derive">;
    const plan = await builtinScopedMemoryAuthorizedRuntime.authorize(context);

    const searched = await builtinScopedMemoryAuthorizedRuntime.searchAuthorized({
      context,
      plan,
      query: "DERIVE_ONLY_SOURCE_SENTINEL",
      limit: 10,
    });
    expect(searched).toMatchObject({ value: [{ snippet: "DERIVE_ONLY_SOURCE_SENTINEL" }] });
    const source = searched.value[0];
    if (!source) {
      throw new Error("fixture expected a derivation source");
    }
    const derived = await builtinScopedMemoryAuthorizedRuntime.writeAuthorized({
      context,
      plan,
      mutation: {
        version: 1,
        kind: "derive",
        derivationPurpose: "dreaming",
        mutationId: "derive-output",
        idempotencyKey: "derive-output-request",
        content: "DERIVED_OUTPUT_SENTINEL",
        contentType: "markdown",
        sourceHandles: [source.resourceHandle],
      },
    });
    const derivedRevisionId = derived.resourceHandle?.resourceRevision;
    if (!derivedRevisionId) {
      throw new Error("fixture expected a derived revision");
    }
    withScopedMemoryDatabase("main", (database) => {
      expect(
        database
          .prepare(
            "SELECT parent_kind, parent_id, relation_kind FROM memory_lineage_edges WHERE child_revision_id = ?",
          )
          .all(derivedRevisionId),
      ).toEqual([
        {
          parent_kind: "resource-revision",
          parent_id: source.resourceHandle.resourceRevision,
          relation_kind: "dreamed-from",
        },
      ]);
      expect(
        database
          .prepare(
            "SELECT count(*) AS count FROM memory_revision_policy_requirements WHERE revision_id = ?",
          )
          .get(derivedRevisionId),
      ).toEqual({ count: 1 });
    });
    setBuiltinScopedMemoryRevisionLifecycle({
      agentId: "main",
      revisionId: source.resourceHandle.resourceRevision,
      lifecycleState: "tombstoned",
    });
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId: "main",
        storeIds: [store.storeId],
        revisionId: derivedRevisionId,
      }),
    ).toBeUndefined();
    expect(plan.mounts[0]?.capabilities).toEqual(["retrieve", "read", "derive"]);
  });

  it("keeps derived output out of the next dreaming bootstrap and records promotion lineage", async () => {
    const principalId = "promotion-owner";
    const store = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: principalId,
      authorityKind: "user",
      authorityOwnerId: principalId,
      defaultCapabilities: ["retrieve", "read", "derive"],
      actor: { kind: "human", id: principalId },
      reason: "promotion source fixture",
    });
    const source = createBuiltinScopedMemoryResource({
      agentId: "main",
      store,
      logicalLocator: "source.md",
      content: "PROMOTION_SOURCE_SENTINEL",
      actor: { kind: "human", id: principalId },
    });
    const context = {
      ...createContext(principalId),
      operation: "derive" as const,
    } satisfies MemoryContentAccessContext<"derive">;
    const plan = await builtinScopedMemoryAuthorizedRuntime.authorize(context);
    const searched = await builtinScopedMemoryAuthorizedRuntime.searchAuthorized({
      context,
      plan,
      query: "PROMOTION_SOURCE_SENTINEL",
      limit: 1,
    });
    const sourceHit = searched.value[0];
    if (!sourceHit) {
      throw new Error("fixture expected a promotion source");
    }
    const promoted = await builtinScopedMemoryAuthorizedRuntime.writeAuthorized({
      context,
      plan,
      mutation: {
        version: 1,
        kind: "derive",
        derivationPurpose: "promotion",
        mutationId: "promotion-output",
        idempotencyKey: "promotion-output-request",
        content: "PROMOTED_OUTPUT_SENTINEL",
        contentType: "markdown",
        sourceHandles: [sourceHit.resourceHandle],
      },
    });
    const promotedRevisionId = promoted.resourceHandle?.resourceRevision;
    if (!promotedRevisionId) {
      throw new Error("fixture expected a promoted revision");
    }

    withScopedMemoryDatabase("main", (database) => {
      expect(
        database
          .prepare(
            "SELECT parent_kind, parent_id, relation_kind FROM memory_lineage_edges WHERE child_revision_id = ?",
          )
          .all(promotedRevisionId),
      ).toEqual([
        {
          parent_kind: "resource-revision",
          parent_id: source.revisionId,
          relation_kind: "promoted-from",
        },
      ]);
    });

    const nextPlan = await builtinScopedMemoryAuthorizedRuntime.authorize(context);
    const bootstrapRevisionIds = nextPlan.bootstrapResourceHandles.map(
      (handle) => handle.resourceRevision,
    );
    expect(bootstrapRevisionIds).toContain(source.revisionId);
    expect(bootstrapRevisionIds).not.toContain(promotedRevisionId);
  });

  it("does not activate a derivation after its source tombstones during finalization", async () => {
    const principalId = "activation-race-owner";
    const store = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: principalId,
      authorityKind: "user",
      authorityOwnerId: principalId,
      defaultCapabilities: ["retrieve", "read", "derive"],
      actor: { kind: "human", id: principalId },
      reason: "activation race source fixture",
    });
    const source = createBuiltinScopedMemoryResource({
      agentId: "main",
      store,
      logicalLocator: "source.md",
      content: "ACTIVATION_RACE_SOURCE_SENTINEL",
      actor: { kind: "human", id: principalId },
    });
    const context = {
      ...createContext(principalId),
      operation: "derive" as const,
    } satisfies MemoryContentAccessContext<"derive">;
    const plan = await builtinScopedMemoryAuthorizedRuntime.authorize(context);
    const searched = await builtinScopedMemoryAuthorizedRuntime.searchAuthorized({
      context,
      plan,
      query: "ACTIVATION_RACE_SOURCE_SENTINEL",
      limit: 1,
    });
    const sourceHit = searched.value[0];
    if (!sourceHit) {
      throw new Error("fixture expected an activation-race source");
    }
    const originalRenameSync = fs.renameSync;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      originalRenameSync(oldPath, newPath);
      setBuiltinScopedMemoryRevisionLifecycle({
        agentId: "main",
        revisionId: source.revisionId,
        lifecycleState: "tombstoned",
      });
    });
    try {
      await expect(
        builtinScopedMemoryAuthorizedRuntime.writeAuthorized({
          context,
          plan,
          mutation: {
            version: 1,
            kind: "derive",
            derivationPurpose: "dreaming",
            mutationId: "activation-race-output",
            idempotencyKey: "activation-race-output-request",
            content: "ACTIVATION_RACE_OUTPUT_SENTINEL",
            contentType: "markdown",
            sourceHandles: [sourceHit.resourceHandle],
          },
        }),
      ).rejects.toThrow("unavailable");
    } finally {
      renameSpy.mockRestore();
    }

    const recoveredPlan = await builtinScopedMemoryAuthorizedRuntime.authorize(context);
    const recovered = await builtinScopedMemoryAuthorizedRuntime.searchAuthorized({
      context,
      plan: recoveredPlan,
      query: "ACTIVATION_RACE_OUTPUT_SENTINEL",
      limit: 1,
    });
    expect(recovered.value).toEqual([]);
  });

  it("admits one scoped derivation store for each private or group subject", async () => {
    const aliceStore = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: "alice",
      authorityKind: "user",
      authorityOwnerId: "alice",
      defaultCapabilities: ["retrieve", "read", "derive"],
      actor: { kind: "human", id: "alice" },
      reason: "Alice derivation fixture",
    });
    const bobStore = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: "bob",
      authorityKind: "user",
      authorityOwnerId: "bob",
      defaultCapabilities: ["retrieve", "read", "derive"],
      actor: { kind: "human", id: "bob" },
      reason: "Bob derivation fixture",
    });
    const groupStore = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "conversation",
      audienceKind: "conversation",
      audienceId: "telegram-group-derive",
      authorityKind: "conversation",
      authorityOwnerId: "telegram-group-derive",
      defaultCapabilities: ["retrieve", "read", "derive"],
      actor: { kind: "unattributed" },
      reason: "group derivation fixture",
    });
    const alice = createBuiltinScopedMemoryResource({
      agentId: "main",
      store: aliceStore,
      logicalLocator: "alice.md",
      content: "ALICE_DERIVE_ONLY",
      actor: { kind: "human", id: "alice" },
    });
    const bob = createBuiltinScopedMemoryResource({
      agentId: "main",
      store: bobStore,
      logicalLocator: "bob.md",
      content: "BOB_DERIVE_ONLY",
      actor: { kind: "human", id: "bob" },
    });
    const group = createBuiltinScopedMemoryResource({
      agentId: "main",
      store: groupStore,
      logicalLocator: "group.md",
      content: "GROUP_DERIVE_ONLY",
      actor: { kind: "unattributed" },
    });
    const aliceContext = {
      ...createContext("alice"),
      operation: "derive" as const,
    } satisfies MemoryContentAccessContext<"derive">;
    const bobContext = {
      ...createContext("bob"),
      operation: "derive" as const,
    } satisfies MemoryContentAccessContext<"derive">;
    const groupContext = {
      ...createContext("group-sender"),
      sessionKey: "agent:main:telegram:group:derive",
      sessionId: "group-derive-session",
      subject: {
        version: 1 as const,
        kind: "conversation" as const,
        conversationPrincipalId: "telegram-group-derive",
        channel: "telegram",
        accountId: "default",
      },
      actor: {
        kind: "unattributed" as const,
        transportAuditRef: "group-derive-audit",
        evidenceRevision: "group-derive-revision",
      },
      verifiedPrincipals: [],
      delivery: {
        sinkKind: "channel" as const,
        audiences: [{ kind: "conversation" as const, id: "telegram-group-derive" }],
        egressCapabilityIds: ["reply.final"],
        egressRegistryRevision: "egress-group-derive",
        deliveryRevision: "delivery-group-derive",
      },
      operation: "derive" as const,
    } satisfies MemoryContentAccessContext<"derive">;

    for (const [context, source] of [
      [aliceContext, alice],
      [bobContext, bob],
      [groupContext, group],
    ] as const) {
      const plan = await builtinScopedMemoryAuthorizedRuntime.authorize(context);
      expect(plan.mounts).toHaveLength(1);
      expect(plan.bootstrapResourceHandles).toEqual([
        expect.objectContaining({ resourceRevision: source.revisionId }),
      ]);
    }
  });

  it("records transcript policy-set lineage for an authorized compaction derivation", async () => {
    const principalId = "compaction-owner";
    const sourceStore = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: principalId,
      authorityKind: "user",
      authorityOwnerId: principalId,
      defaultCapabilities: ["retrieve", "read", "derive"],
      actor: { kind: "human", id: principalId },
      reason: "compaction transcript fixture",
    });
    const source = createBuiltinScopedMemoryResource({
      agentId: "main",
      store: sourceStore,
      logicalLocator: "MEMORY.md",
      content: "COMPACTION_TRANSCRIPT_SOURCE_SENTINEL",
      actor: { kind: "human", id: principalId },
    });
    const context = {
      ...createContext(principalId),
      operation: "derive" as const,
    } satisfies MemoryContentAccessContext<"derive">;
    const plan = await builtinScopedMemoryAuthorizedRuntime.authorize(context);
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    markCutOver();
    database.db
      .prepare(
        `INSERT INTO session_memory_subjects
          (session_key, subject_kind, binding_id, principal_id, subject_revision, created_at)
         VALUES (?, 'user', ?, ?, ?, 1)`,
      )
      .run(context.sessionKey, `binding-${principalId}`, principalId, context.subjectRevision);
    database.db
      .prepare(
        `INSERT INTO session_memory_subject_snapshots
          (session_id, session_key, subject_revision, session_identity_revision, created_at)
         VALUES (?, ?, ?, ?, 1)`,
      )
      .run(
        context.sessionId,
        context.sessionKey,
        context.subjectRevision,
        context.sessionIdentityRevision,
      );
    const exposure = prepareMemoryRunExposure({
      agentId: context.agentId,
      sessionId: context.sessionId,
      sessionKey: context.sessionKey,
      runId: context.runId,
      contextFingerprint: context.contextFingerprint,
      planId: plan.planId,
      memoryPolicyRevision: plan.memoryPolicyRevision,
      sourcePolicySetIds: [source.sourcePolicySetId],
      exposedResourceRevisions: [source.revisionId],
      exposureReceiptIds: ["compaction-exposure-receipt"],
      egressReceiptIds: ["compaction-egress-receipt"],
      deliveryAudiences: context.delivery.audiences,
      deliveryRevision: context.delivery.deliveryRevision,
      egressRegistryRevision: context.delivery.egressRegistryRevision,
      sessionIdentityRevision: context.sessionIdentityRevision,
      subjectRevision: context.subjectRevision,
      actorEvidence: {
        version: 1,
        kind: "principal",
        actorKind: "human",
        principalId,
        assurance: "gateway-profile",
        evidenceRevision: `binding-${principalId}`,
      },
      delegationSnapshot: { version: 1, kind: "none" },
      hostFactsRevision: context.hostFactsRevision,
    });
    expect(persistMemoryRunExposureBeforeContentInDatabase({ database, snapshot: exposure })).toBe(
      true,
    );
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: {
          agentId: context.agentId,
          expectedWriterRunId: context.runId,
          sessionId: context.sessionId,
          sessionKey: context.sessionKey,
        },
        withTranscriptWrite: async (run) => await run(),
      },
      async () => {
        await appendSqliteTranscriptMessage(
          {
            agentId: context.agentId,
            sessionId: context.sessionId,
            sessionKey: context.sessionKey,
          },
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "COMPACTION_TRANSCRIPT_EVENT_SENTINEL" }],
            },
          },
        );
      },
    );
    const transcript = readAuthorizedTranscriptDerivation(database.db, context.sessionId);
    if (!transcript) {
      throw new Error("fixture expected an authorized transcript derivation");
    }

    const derived = await builtinScopedMemoryAuthorizedRuntime.writeAuthorized({
      context,
      plan,
      mutation: {
        version: 1,
        kind: "derive",
        derivationPurpose: "compaction",
        mutationId: "compaction-derived-output",
        idempotencyKey: "compaction-derived-output-request",
        content: "COMPACTION_DERIVED_OUTPUT_SENTINEL",
        contentType: "markdown",
        sourcePolicySetId: transcript.sourcePolicySetId,
        transcriptSource: {
          kind: "transcript",
          sessionId: context.sessionId,
          eventSeqs: transcript.eventSeqs,
          sourcePolicySetId: transcript.sourcePolicySetId,
          deliveryAudiencesJson: transcript.deliveryAudiencesJson,
        },
      },
    });
    const derivedRevisionId = derived.resourceHandle?.resourceRevision;
    if (!derivedRevisionId) {
      throw new Error("fixture expected a derived revision");
    }
    withScopedMemoryDatabase("main", (scopedDatabase) => {
      expect(
        scopedDatabase
          .prepare(
            `SELECT parent_kind, parent_id, relation_kind
               FROM memory_lineage_edges
              WHERE child_revision_id = ?
              ORDER BY parent_kind, parent_id, relation_kind`,
          )
          .all(derivedRevisionId),
      ).toEqual([
        {
          parent_kind: "resource-revision",
          parent_id: source.revisionId,
          relation_kind: "derived-from",
        },
        {
          parent_kind: "transcript-policy-set",
          parent_id: transcript.sourcePolicySetId,
          relation_kind: "compacted-from",
        },
      ]);
    });
  });

  it("keeps verified private stores isolated through the actual host and selected runtime", async () => {
    const aliceSession = { sessionKey: "agent:main:direct:alice", sessionId: "alice-session" };
    const bobSession = { sessionKey: "agent:main:direct:bob", sessionId: "bob-session" };
    const alicePrincipalId = createVerifiedDirectSession({ name: "alice", ...aliceSession });
    const bobPrincipalId = createVerifiedDirectSession({ name: "bob", ...bobSession });
    createPrivateResource(alicePrincipalId, "ALICE_PRIVATE_TITLE\nneedle only from Alice");
    for (let index = 0; index < 20; index += 1) {
      createPrivateResource(
        bobPrincipalId,
        `BOB_PRIVATE_TITLE_${index}\n${"needle ".repeat(index + 20)}BOB_SNIPPET_SCORE_COUNT_CITATION_CURSOR_${index}`,
      );
    }
    markCutOver();
    installBuiltinSelectedRuntime();
    await expect(
      admitMemoryAuthorizationReadRuntime({
        authorization: MEMORY_CORE_AUTHORIZATION_CAPABILITIES,
        authorizationConformance: builtinScopedMemoryConformanceAdapter,
        runtime: builtinScopedMemoryAuthorizedRuntime,
      }),
    ).resolves.toMatchObject({ ok: true });

    const aliceHost = createAuthorizedMemoryReadHost({
      agentId: "main",
      ...aliceSession,
      deliveryContext: { channel: "telegram", accountId: "default", to: "alice" },
    });
    const bobHost = createAuthorizedMemoryReadHost({
      agentId: "main",
      ...bobSession,
      deliveryContext: { channel: "telegram", accountId: "default", to: "bob" },
    });
    if (!aliceHost || !bobHost) {
      throw new Error("fixture failed to build an authorized memory host");
    }

    const aliceResults = await aliceHost.search({ query: "needle", limit: 1 });
    expect(aliceResults).toMatchObject({
      results: [{ path: "memory/MEMORY.md", snippet: "ALICE_PRIVATE_TITLE" }],
    });
    const alicePayload = JSON.stringify(aliceResults);
    expect(alicePayload).not.toContain("BOB_PRIVATE_TITLE");
    expect(alicePayload).not.toContain("BOB_SNIPPET_SCORE_COUNT_CITATION_CURSOR");

    const bobResults = await bobHost.search({ query: "needle", limit: 1 });
    if (!("results" in bobResults) || !bobResults.results[0]) {
      throw new Error("fixture failed to return Bob's own scoped handle");
    }
    await expect(aliceHost.read({ handleId: bobResults.results[0].handleId })).resolves.toEqual({
      disabled: true,
      unavailable: true,
      error: "memory unavailable",
    });
    await expect(aliceHost.read({ handleId: "mhandle1_forged" })).resolves.toEqual({
      disabled: true,
      unavailable: true,
      error: "memory unavailable",
    });
  });

  it("does not mount a parent private store for a spawned child without delegation", () => {
    const parentSession = { sessionKey: "agent:main:direct:alice", sessionId: "alice-session" };
    const alicePrincipalId = createVerifiedDirectSession({ name: "alice", ...parentSession });
    createPrivateResource(alicePrincipalId, "ALICE_CHILD_ISOLATION_SENTINEL");
    const childSession = {
      sessionKey: "agent:main:subagent:child",
      sessionId: "child-session",
    };
    const child = createSpawnedChildSession({
      ...childSession,
      spawnedBy: parentSession.sessionKey,
    });
    expect(child.isChildSession).toBe(true);

    markCutOver();
    installBuiltinSelectedRuntime();
    expect(
      createAuthorizedMemoryReadHost({
        agentId: "main",
        ...childSession,
        // A parent delivery route is not authority for a child memory mount.
        deliveryContext: { channel: "telegram", accountId: "default", to: "alice" },
      }),
    ).toBeUndefined();
  });

  it("invalidates materialized virtual views after binding revocation and plan expiry", async () => {
    const session = { sessionKey: "agent:main:direct:alice", sessionId: "alice-session" };
    const alicePrincipalId = createVerifiedDirectSession({ name: "alice", ...session });
    createPrivateResource(alicePrincipalId, "ALICE_VIRTUAL_VIEW_CONTENT");
    markCutOver();
    installBuiltinSelectedRuntime();

    const host = createAuthorizedMemoryReadHost({
      agentId: "main",
      ...session,
      deliveryContext: { channel: "telegram", accountId: "default", to: "alice" },
    });
    if (!host) {
      throw new Error("fixture failed to build an authorized memory host");
    }
    const broker = await resolveAuthorizedMemoryVirtualFileBroker(host);
    const virtualPath = broker?.view.files[0]?.virtualPath;
    if (!broker || !virtualPath) {
      throw new Error("fixture failed to materialize an authorized virtual view");
    }
    await expect(broker.readFile(virtualPath)).resolves.toBe("ALICE_VIRTUAL_VIEW_CONTENT");

    const sessionContext = createCurrentMemorySessionContext({
      ...session,
      options: { agentId: "main" },
    });
    if (sessionContext.kind !== "current" || !sessionContext.context.bindingId) {
      throw new Error("fixture failed to retain the direct identity binding");
    }
    expect(revokeMemoryIdentityBinding({ bindingId: sessionContext.context.bindingId })).toBe(true);
    await expect(broker.readFile(virtualPath)).resolves.toBeUndefined();

    // A fresh view starts with a live binding, then must become unusable once
    // its plan lease expires even though the broker object is still retained.
    const freshSession = { sessionKey: "agent:main:direct:bob", sessionId: "bob-session" };
    const bobPrincipalId = createVerifiedDirectSession({ name: "bob", ...freshSession });
    createPrivateResource(bobPrincipalId, "BOB_EXPIRED_VIRTUAL_VIEW_CONTENT");
    const freshHost = createAuthorizedMemoryReadHost({
      agentId: "main",
      ...freshSession,
      deliveryContext: { channel: "telegram", accountId: "default", to: "bob" },
    });
    const freshBroker = freshHost && (await resolveAuthorizedMemoryVirtualFileBroker(freshHost));
    const freshPath = freshBroker?.view.files[0]?.virtualPath;
    if (!freshBroker || !freshPath) {
      throw new Error("fixture failed to materialize an expiring authorized virtual view");
    }
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(60_001);
      await expect(freshBroker.readFile(freshPath)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers an exposed direct-memory result only through the attested final-reply gate", async () => {
    const session = { sessionKey: "agent:main:direct:alice", sessionId: "alice-session" };
    const runId = "authorized-memory-final-reply";
    const alicePrincipalId = createVerifiedDirectSession({ name: "alice", ...session });
    createPrivateResource(alicePrincipalId, "ALICE_FINAL_REPLY_AUTHORIZED_CONTENT");
    markCutOver();
    installBuiltinSelectedRuntime();
    registerAgentRunContext(runId, {
      agentId: "main",
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
    });

    const host = createAuthorizedMemoryReadHost({
      agentId: "main",
      ...session,
      runId,
      deliveryContext: { channel: "telegram", accountId: "default", to: "alice" },
    });
    if (!host) {
      throw new Error("fixture failed to build an authorized memory host");
    }
    const read = await host.search({ query: "ALICE_FINAL_REPLY_AUTHORIZED_CONTENT", limit: 1 });
    if (!("results" in read) || !read.results[0]) {
      throw new Error("fixture failed to expose the authorized direct-memory result");
    }
    expect(
      readLatestDurableMemoryRunExposure({ agentId: "main", sessionId: session.sessionId, runId }),
    ).toMatchObject({
      kind: "current",
      snapshot: {
        exposedResourceRevisions: [expect.any(String)],
        egressReceiptIds: [expect.any(String)],
        deliveryAudiences: [{ kind: "user", id: alicePrincipalId }],
      },
    });
    expect(
      prepareMemoryEgressAuthorization({
        capabilityId: "reply.final",
        agentId: "main",
        ...session,
        runId,
        deliveryContext: { channel: "telegram", accountId: "default", to: "alice" },
      }),
    ).toMatchObject({ allowed: true, authorization: { exposure: expect.any(Object) } });

    const delivered = vi.fn(async () => undefined);
    const dispatcher = createReplyDispatcher({ deliver: delivered });
    dispatchReplyFromConfig.mockImplementation(async ({ dispatcher: activeDispatcher }) => {
      expect(activeDispatcher.sendFinalReply({ text: read.results[0]!.snippet })).toBe(true);
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
    await dispatchInboundMessage({
      ctx: buildTestCtx({
        AgentId: "main",
        SessionId: session.sessionId,
        SessionKey: session.sessionKey,
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "alice",
        AccountId: "default",
      }),
      cfg: {} as never,
      dispatcher,
      replyOptions: { runId },
      outboundHooks: "disabled",
    });
    await dispatcher.waitForIdle();
    expect(delivered).toHaveBeenCalledWith(
      expect.objectContaining({ text: "ALICE_FINAL_REPLY_AUTHORIZED_CONTENT" }),
      expect.anything(),
    );

    const reboundDelivered = vi.fn(async () => undefined);
    const reboundDispatcher = createReplyDispatcher({ deliver: reboundDelivered });
    dispatchReplyFromConfig.mockImplementation(async ({ ctx, dispatcher: activeDispatcher }) => {
      activeDispatcher.sendFinalReply({ text: read.results[0]!.snippet });
      ctx.OriginatingTo = "mallory";
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
    await dispatchInboundMessage({
      ctx: buildTestCtx({
        AgentId: "main",
        SessionId: session.sessionId,
        SessionKey: session.sessionKey,
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "alice",
        AccountId: "default",
      }),
      cfg: {} as never,
      dispatcher: reboundDispatcher,
      replyOptions: { runId },
      outboundHooks: "disabled",
    });
    await reboundDispatcher.waitForIdle();
    expect(reboundDelivered).not.toHaveBeenCalled();
    expect(reboundDispatcher.getCancelledCounts?.().final).toBe(1);
  });

  it("mounts only channel and explicitly addressed copies for a group actor", async () => {
    const session = { sessionKey: "agent:main:telegram:group:1", sessionId: "group-session" };
    const conversationPrincipalId = createConversationSession({
      ...session,
      conversationId: "telegram-group-1",
    });
    const channelStore = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "conversation",
      audienceKind: "conversation",
      audienceId: conversationPrincipalId,
      authorityKind: "conversation",
      authorityOwnerId: conversationPrincipalId,
      defaultCapabilities: ["retrieve", "read"],
      actor: { kind: "unattributed" },
      reason: "channel placement",
    });
    const projectionStore = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "conversation",
      audienceKind: "conversation",
      audienceId: conversationPrincipalId,
      authorityKind: "conversation",
      authorityOwnerId: conversationPrincipalId,
      defaultCapabilities: ["retrieve", "read"],
      actor: { kind: "unattributed" },
      reason: "explicitly addressed projection placement",
    });
    const alicePrincipal = ensureMemoryOperationalPrincipal({
      kind: "service",
      stableRef: "alice-role-shaped-sender",
      options: { agentId: "main" },
    });
    const alicePrivate = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: alicePrincipal.principalId,
      authorityKind: "user",
      authorityOwnerId: alicePrincipal.principalId,
      defaultCapabilities: ["retrieve", "read"],
      actor: { kind: "human", id: alicePrincipal.principalId },
      reason: "private placement",
    });
    const ownerRole = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "role",
      audienceKind: "role",
      audienceId: "owners",
      authorityKind: "role",
      authorityOwnerId: "owners",
      defaultCapabilities: ["retrieve", "read"],
      actor: { kind: "system" },
      reason: "role placement",
    });
    for (const [store, logicalLocator, content, actor] of [
      [channelStore, "channel.md", "GROUP_CHANNEL_ONLY", { kind: "unattributed" }],
      [
        projectionStore,
        "projection.md",
        "GROUP_EXPLICITLY_ADDRESSED_PROJECTION",
        { kind: "unattributed" },
      ],
      [
        alicePrivate,
        "alice-private.md",
        "GROUP_DENIED_ALICE_PRIVATE_PATH_TITLE_SNIPPET_SCORE_COUNT_CITATION_CURSOR",
        { kind: "human", id: alicePrincipal.principalId },
      ],
      [ownerRole, "owner-role.md", "GROUP_DENIED_OWNER_ROLE_FROM_LATEST_ACTOR", { kind: "system" }],
    ] as const) {
      createBuiltinScopedMemoryResource({
        agentId: "main",
        store,
        logicalLocator,
        content,
        actor,
      });
    }
    markCutOver();
    installBuiltinSelectedRuntime();

    const host = createAuthorizedMemoryReadHost({
      agentId: "main",
      ...session,
      deliveryContext: { channel: "telegram", accountId: "default", to: "group-target" },
    });
    if (!host) {
      throw new Error("fixture failed to build a group memory host");
    }
    const result = await host.search({ query: "GROUP", limit: 10 });
    expect(result).toMatchObject({
      results: [
        { snippet: "GROUP_CHANNEL_ONLY" },
        { snippet: "GROUP_EXPLICITLY_ADDRESSED_PROJECTION" },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(
      "GROUP_DENIED_ALICE_PRIVATE_PATH_TITLE_SNIPPET_SCORE_COUNT_CITATION_CURSOR",
    );
    expect(serialized).not.toContain("GROUP_DENIED_OWNER_ROLE_FROM_LATEST_ACTOR");
  });

  it("selects the subject store itself and commits remember/delete through one durable lifecycle", async () => {
    const principalId = "writer";
    createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: principalId,
      authorityKind: "user",
      authorityOwnerId: principalId,
      defaultCapabilities: ["append", "replace", "delete"],
      actor: { kind: "human", id: principalId },
      reason: "authorized write fixture",
    });
    const appendContext = {
      ...createContext(principalId),
      operation: "append" as const,
    } satisfies MemoryAccessContext;
    const appendPlan = await builtinScopedMemoryAuthorizedRuntime.authorize(appendContext);
    const mutation = {
      version: 1 as const,
      kind: "remember" as const,
      mutationId: "remember-1",
      idempotencyKey: "remember-request-1",
      content: "durable write sentinel",
      contentType: "markdown" as const,
    };
    await expect(
      builtinScopedMemoryAuthorizedRuntime.writeAuthorized({
        context: appendContext,
        plan: appendPlan,
        mutation: { ...mutation, storeId: "attacker-selected" } as never,
      }),
    ).rejects.toThrow("unavailable");
    const written = await builtinScopedMemoryAuthorizedRuntime.writeAuthorized({
      context: appendContext,
      plan: appendPlan,
      mutation,
    });
    expect(written).toMatchObject({ status: "committed", resourceHandle: expect.any(Object) });
    const retried = await builtinScopedMemoryAuthorizedRuntime.writeAuthorized({
      context: appendContext,
      plan: appendPlan,
      mutation,
    });
    expect(retried.status).toBe("unchanged");
    const handle = written.resourceHandle;
    if (!handle) {
      throw new Error("fixture expected an authorized write handle");
    }
    withScopedMemoryDatabase("main", (database) => {
      expect(
        database
          .prepare("SELECT lifecycle_state FROM memory_resource_revisions WHERE revision_id = ?")
          .get(handle.resourceRevision),
      ).toEqual({ lifecycle_state: "active" });
      expect(
        database
          .prepare("SELECT text FROM memory_scoped_chunks WHERE revision_id = ?")
          .all(handle.resourceRevision),
      ).toEqual([{ text: "durable write sentinel" }]);
    });
    const audit = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    expect(
      audit.db
        .prepare(
          `SELECT operation, decision, content_hash
             FROM memory_access_audit
            WHERE resource_revision_id = ?`,
        )
        .all(handle.resourceRevision),
    ).toEqual([
      {
        operation: "append",
        decision: "committed",
        content_hash: createHash("sha256").update("durable write sentinel").digest("hex"),
      },
    ]);
    // A crash after shared delivery but before the local acknowledgement must be
    // safe to retry: the sink deduplicates by immutable event id and the outbox
    // eventually acknowledges the already-delivered event.
    let eventId = "";
    withScopedMemoryDatabase("main", (database) => {
      const event = database
        .prepare("SELECT event_id FROM memory_audit_outbox WHERE resource_revision_id = ?")
        .get(handle.resourceRevision) as { event_id: string };
      eventId = event.event_id;
      database
        .prepare(
          `UPDATE memory_audit_outbox
              SET state = 'pending', delivered_at = NULL, updated_at = updated_at + 1
            WHERE event_id = ?`,
        )
        .run(eventId);
    });
    await builtinScopedMemoryAuthorizedRuntime.authorize(appendContext);
    withScopedMemoryDatabase("main", (database) => {
      expect(
        database
          .prepare("SELECT state, attempts FROM memory_audit_outbox WHERE event_id = ?")
          .get(eventId),
      ).toMatchObject({ state: "delivered", attempts: expect.any(Number) });
    });
    expect(
      audit.db
        .prepare("SELECT count(*) AS count FROM memory_access_audit WHERE event_id = ?")
        .get(eventId),
    ).toEqual({ count: 1 });
    const deleteContext = {
      ...appendContext,
      operation: "delete" as const,
    } satisfies MemoryAccessContext;
    const deletePlan = await builtinScopedMemoryAuthorizedRuntime.authorize(deleteContext);
    await builtinScopedMemoryAuthorizedRuntime.writeAuthorized({
      context: deleteContext,
      plan: deletePlan,
      mutation: {
        version: 1,
        kind: "delete",
        mutationId: "delete-1",
        idempotencyKey: "delete-request-1",
        target: handle,
      },
    });
    withScopedMemoryDatabase("main", (database) => {
      expect(
        database
          .prepare("SELECT lifecycle_state FROM memory_resource_revisions WHERE revision_id = ?")
          .get(handle.resourceRevision),
      ).toEqual({ lifecycle_state: "tombstoned" });
      expect(
        database
          .prepare("SELECT * FROM memory_scoped_chunks WHERE revision_id = ?")
          .all(handle.resourceRevision),
      ).toEqual([]);
    });
  });

  it("recovers each interrupted write boundary without exposing a pending revision", async () => {
    const stageOnly = createWriteRecoveryFixture({
      principalId: "recovery-stage-only",
      content: "STAGE_ONLY_PENDING_SENTINEL",
      placement: "stage",
    });
    const pendingCommit = createWriteRecoveryFixture({
      principalId: "recovery-pending-commit",
      content: "PENDING_COMMIT_SENTINEL",
      placement: "stage",
    });
    const renamed = createWriteRecoveryFixture({
      principalId: "recovery-renamed",
      content: "RENAMED_SENTINEL",
      placement: "final",
    });
    const activatedBeforeIndex = createWriteRecoveryFixture({
      principalId: "recovery-activated",
      content: "ACTIVATED_INDEX_SENTINEL",
      placement: "final",
      intentState: "active",
      revisionLifecycleState: "active",
    });
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId: "main",
        storeIds: [pendingCommit.storeId],
        revisionId: pendingCommit.revisionId,
      }),
    ).toBeUndefined();
    withScopedMemoryDatabase("main", (database) => {
      expect(
        database
          .prepare("SELECT * FROM memory_scoped_chunks WHERE revision_id = ?")
          .all(activatedBeforeIndex.revisionId),
      ).toEqual([]);
    });

    await builtinScopedMemoryAuthorizedRuntime.authorize({
      ...createContext("recovery-pending-commit"),
      operation: "append" as const,
    });

    expect(fs.existsSync(path.join(stageOnly.directory, stageOnly.stageLocator))).toBe(false);
    expect(fs.existsSync(path.join(pendingCommit.directory, pendingCommit.finalLocator))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(renamed.directory, renamed.finalLocator))).toBe(true);
    withScopedMemoryDatabase("main", (database) => {
      for (const fixture of [pendingCommit, renamed, activatedBeforeIndex]) {
        expect(
          database
            .prepare(
              `SELECT revision.lifecycle_state, intent.state, intent.indexed_at
                 FROM memory_resource_revisions AS revision
                 JOIN memory_write_intents AS intent ON intent.pending_revision_id = revision.revision_id
                WHERE revision.revision_id = ?`,
            )
            .get(fixture.revisionId),
        ).toMatchObject({
          lifecycle_state: "active",
          state: "active",
          indexed_at: expect.any(Number),
        });
        expect(
          database
            .prepare("SELECT text FROM memory_scoped_chunks WHERE revision_id = ?")
            .all(fixture.revisionId),
        ).toEqual([{ text: expect.stringContaining("SENTINEL") }]);
      }
    });
  });

  it("tombstones before quarantining an artifact whose unlink fails", async () => {
    const principalId = "tombstone-quarantine";
    createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: principalId,
      authorityKind: "user",
      authorityOwnerId: principalId,
      defaultCapabilities: ["append", "delete"],
      actor: { kind: "human", id: principalId },
      reason: "tombstone quarantine fixture",
    });
    const appendContext = {
      ...createContext(principalId),
      operation: "append" as const,
    } satisfies MemoryAccessContext;
    const appendPlan = await builtinScopedMemoryAuthorizedRuntime.authorize(appendContext);
    const written = await builtinScopedMemoryAuthorizedRuntime.writeAuthorized({
      context: appendContext,
      plan: appendPlan,
      mutation: {
        version: 1,
        kind: "remember",
        mutationId: "tombstone-source",
        idempotencyKey: "tombstone-source-request",
        content: "TOMBSTONE_QUARANTINE_SENTINEL",
        contentType: "markdown",
      },
    });
    if (!written.resourceHandle) {
      throw new Error("fixture expected an authorized write handle");
    }
    const unlinkError = Object.assign(new Error("unlink denied"), { code: "EACCES" });
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
      throw unlinkError;
    });
    try {
      const deleteContext = {
        ...appendContext,
        operation: "delete" as const,
      } satisfies MemoryAccessContext;
      const deletePlan = await builtinScopedMemoryAuthorizedRuntime.authorize(deleteContext);
      await expect(
        builtinScopedMemoryAuthorizedRuntime.writeAuthorized({
          context: deleteContext,
          plan: deletePlan,
          mutation: {
            version: 1,
            kind: "delete",
            mutationId: "tombstone-delete",
            idempotencyKey: "tombstone-delete-request",
            target: written.resourceHandle,
          },
        }),
      ).resolves.toMatchObject({ status: "committed" });
    } finally {
      unlink.mockRestore();
    }
    withScopedMemoryDatabase("main", (database, databasePath) => {
      expect(
        database
          .prepare("SELECT lifecycle_state FROM memory_resource_revisions WHERE revision_id = ?")
          .get(written.resourceHandle.resourceRevision),
      ).toEqual({ lifecycle_state: "tombstoned" });
      expect(
        database
          .prepare("SELECT * FROM memory_scoped_chunks WHERE revision_id = ?")
          .all(written.resourceHandle.resourceRevision),
      ).toEqual([]);
      expect(
        database
          .prepare("SELECT state FROM memory_write_intents WHERE mutation_id = ?")
          .get("tombstone-delete"),
      ).toEqual({ state: "quarantined" });
      const root = database
        .prepare(
          `SELECT root.path_key
             FROM memory_stores AS store
             JOIN memory_storage_roots AS root ON root.storage_root_id = store.storage_root_id
            WHERE store.agent_id = 'main' AND store.audience_id = ?`,
        )
        .get(principalId) as { path_key: string };
      expect(
        fs.readdirSync(path.join(resolveScopedMemoryArtifactBase(databasePath), ".quarantine")),
      ).not.toEqual([]);
      expect(root.path_key).toBeTruthy();
    });
  });

  it("reaches the selected lifecycle only through a host-owned subject remember operation", async () => {
    const session = { sessionKey: "agent:main:direct:alice", sessionId: "writer-session" };
    const principalId = createVerifiedDirectSession({ name: "alice", ...session });
    createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: principalId,
      authorityKind: "user",
      authorityOwnerId: principalId,
      defaultCapabilities: ["retrieve", "read", "append"],
      actor: { kind: "human", id: principalId },
      reason: "host write fixture",
    });
    markCutOver();
    installBuiltinSelectedRuntime();
    const host = createAuthorizedMemoryWriteHost({
      agentId: "main",
      ...session,
      deliveryContext: { channel: "telegram", accountId: "default", to: "alice" },
    });
    if (!host) {
      throw new Error("fixture failed to create the authorized memory write host");
    }
    await expect(host.remember({ content: "HOST_OWNED_REMEMBER_SENTINEL" })).resolves.toMatchObject(
      { status: "committed" },
    );
    withScopedMemoryDatabase("main", (database) => {
      expect(database.prepare("SELECT text FROM memory_scoped_chunks").all()).toEqual([
        { text: "HOST_OWNED_REMEMBER_SENTINEL" },
      ]);
    });
  });

  it("keeps pending content unavailable, recovers a staged revision, and quarantines policy drift", async () => {
    const staged = createWriteRecoveryFixture({
      principalId: "recovery-stage",
      content: "STAGED_RECOVERY_SENTINEL",
      placement: "stage",
    });
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId: "main",
        storeIds: [staged.storeId],
        revisionId: staged.revisionId,
      }),
    ).toBeUndefined();

    const recoveryContext = {
      ...createContext("recovery-stage"),
      operation: "append" as const,
    } satisfies MemoryAccessContext;
    await builtinScopedMemoryAuthorizedRuntime.authorize(recoveryContext);
    expect(fs.existsSync(path.join(staged.directory, staged.stageLocator))).toBe(false);
    expect(fs.readFileSync(path.join(staged.directory, staged.finalLocator), "utf8")).toBe(
      "STAGED_RECOVERY_SENTINEL",
    );
    withScopedMemoryDatabase("main", (database) => {
      expect(
        database
          .prepare(
            `SELECT revision.lifecycle_state, intent.state, intent.indexed_at
               FROM memory_resource_revisions AS revision
               JOIN memory_write_intents AS intent ON intent.pending_revision_id = revision.revision_id
              WHERE revision.revision_id = ?`,
          )
          .get(staged.revisionId),
      ).toMatchObject({
        lifecycle_state: "active",
        state: "active",
        indexed_at: expect.any(Number),
      });
      expect(
        database
          .prepare("SELECT text FROM memory_scoped_chunks WHERE revision_id = ?")
          .all(staged.revisionId),
      ).toEqual([{ text: "STAGED_RECOVERY_SENTINEL" }]);
    });

    const policyChanged = createWriteRecoveryFixture({
      principalId: "recovery-policy",
      content: "POLICY_DRIFT_SENTINEL",
      placement: "final",
      policyRevisionId: "policy-revision-that-is-no-longer-current",
    });
    await builtinScopedMemoryAuthorizedRuntime.authorize({
      ...createContext("recovery-policy"),
      operation: "append" as const,
    });
    withScopedMemoryDatabase("main", (database) => {
      expect(
        database
          .prepare(
            `SELECT revision.lifecycle_state, intent.state
               FROM memory_resource_revisions AS revision
               JOIN memory_write_intents AS intent ON intent.pending_revision_id = revision.revision_id
              WHERE revision.revision_id = ?`,
          )
          .get(policyChanged.revisionId),
      ).toEqual({ lifecycle_state: "quarantined", state: "quarantined" });
      expect(
        database
          .prepare("SELECT * FROM memory_scoped_chunks WHERE revision_id = ?")
          .all(policyChanged.revisionId),
      ).toEqual([]);
    });
    expect(fs.existsSync(path.join(policyChanged.directory, policyChanged.finalLocator))).toBe(
      false,
    );
    expect(
      fs.readdirSync(path.join(path.dirname(policyChanged.directory), ".quarantine")),
    ).not.toEqual([]);
  });

  it("quarantines a staged artifact without a catalog mapping during startup recovery", async () => {
    const store = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: "orphaned-stage",
      authorityKind: "user",
      authorityOwnerId: "orphaned-stage",
      defaultCapabilities: ["retrieve", "read", "append"],
      actor: { kind: "human", id: "orphaned-stage" },
      reason: "orphan fixture",
    });
    let directory = "";
    withScopedMemoryDatabase("main", (database, databasePath) => {
      const row = database
        .prepare(
          `SELECT root.path_key
             FROM memory_stores AS store
             JOIN memory_storage_roots AS root ON root.storage_root_id = store.storage_root_id
            WHERE store.store_id = ?`,
        )
        .get(store.storeId) as { path_key: string };
      directory = path.join(resolveScopedMemoryArtifactBase(databasePath), row.path_key);
    });
    const orphan = path.join(directory, "mwst1_unmapped.tmp");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(orphan, "ORPHAN_STAGE_SENTINEL", { mode: 0o600 });

    await builtinScopedMemoryAuthorizedRuntime.authorize({
      ...createContext("orphaned-stage"),
      operation: "append" as const,
    });

    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.readdirSync(path.join(path.dirname(directory), ".quarantine"))).not.toEqual([]);
  });
});
