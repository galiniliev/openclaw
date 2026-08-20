import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeAdmittedNativeChannelMemoryEvidenceFromContext,
  createNativeChannelMemoryEvidenceAdmission,
} from "../channels/message-access/memory-native-channel-evidence-admission.js";
import { ensureMemoryOperationalPrincipal } from "./memory-identity.js";
import {
  inspectMemoryNativeChannelEvidence,
  persistAdmittedNativeChannelMemoryEvidence,
  readCurrentMemoryNativeChannelEvidence,
  recordMemoryNativeChannelEvidenceDenial,
  revokeMemoryNativeChannelEvidence,
} from "./memory-native-channel-evidence.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-native-channel-evidence-"));
  roots.push(root);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: root } };
}

function admitted(params: { channel?: string; accountId?: string; nativeChannelId?: string } = {}) {
  const admission = createNativeChannelMemoryEvidenceAdmission({
    pluginId: "telegram",
    adapterId: "plugin:telegram",
    ownsChannel: (channel) => channel === "telegram",
    isActive: () => true,
  });
  const context = {};
  admission.attachVerifiedNativeConversation({
    context,
    channel: params.channel ?? "telegram",
    accountId: params.accountId ?? "default",
    nativeChannelId: params.nativeChannelId ?? "-100123",
  });
  const proof = consumeAdmittedNativeChannelMemoryEvidenceFromContext(context);
  if (!proof) {
    throw new Error("fixture failed to mint a native conversation proof");
  }
  return proof;
}

function address(params: { principalId: string; options: { env: NodeJS.ProcessEnv } }) {
  return {
    agentId: "main",
    conversationPrincipalId: params.principalId,
    channel: "telegram",
    accountId: "default",
    conversationId: "conversation-1",
    nativeChannelId: "-100123",
    options: params.options,
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("native channel memory evidence", () => {
  it("accepts one opaque proof only for its exact persisted conversation address", () => {
    const { env } = fixture();
    const options = { env };
    const principal = ensureMemoryOperationalPrincipal({
      kind: "conversation",
      stableRef: "main\u0000conversation-1",
      options,
    });
    const exact = address({ principalId: principal.principalId, options });
    const oneUseProof = admitted();
    const evidence = persistAdmittedNativeChannelMemoryEvidence({
      admission: oneUseProof,
      ...exact,
      observedAt: 1_000,
      expiresAt: 2_000,
    });

    expect(readCurrentMemoryNativeChannelEvidence({ ...exact, now: 1_500 })).toEqual(evidence);
    for (const mismatch of [
      { channel: "discord" },
      { accountId: "another" },
      { conversationId: "conversation-2" },
      { nativeChannelId: "-100999" },
      { conversationPrincipalId: "another-principal" },
    ]) {
      expect(readCurrentMemoryNativeChannelEvidence({ ...exact, ...mismatch, now: 1_500 })).toBeUndefined();
    }
    expect(() =>
      persistAdmittedNativeChannelMemoryEvidence({
        admission: oneUseProof,
        ...exact,
        observedAt: 1_000,
        expiresAt: 2_000,
      }),
    ).toThrow("admitted channel proof");
    expect(() =>
      persistAdmittedNativeChannelMemoryEvidence({
        admission: {} as never,
        ...exact,
        observedAt: 1_000,
        expiresAt: 2_000,
      }),
    ).toThrow("admitted channel proof");
    expect(() =>
      persistAdmittedNativeChannelMemoryEvidence({
        admission: admitted(),
        ...exact,
        nativeChannelId: "-100999",
        observedAt: 1_000,
        expiresAt: 2_000,
      }),
    ).toThrow("does not match the persisted conversation");
  });

  it("expires and revokes current evidence without retaining native identifiers", () => {
    const { env } = fixture();
    const options = { env };
    const principal = ensureMemoryOperationalPrincipal({
      kind: "conversation",
      stableRef: "main\u0000conversation-1",
      options,
    });
    const exact = address({ principalId: principal.principalId, options });
    const evidence = persistAdmittedNativeChannelMemoryEvidence({
      admission: admitted(),
      ...exact,
      observedAt: 1_000,
      expiresAt: 2_000,
    });

    expect(readCurrentMemoryNativeChannelEvidence({ ...exact, now: 1_999 })).toEqual(evidence);
    // No new adapter receipt is synthesized during an outage, so the expired
    // proof cannot keep conversation memory available.
    expect(readCurrentMemoryNativeChannelEvidence({ ...exact, now: 2_000 })).toBeUndefined();
    expect(revokeMemoryNativeChannelEvidence({ evidenceId: evidence.evidenceId, revokedAt: 1_500, options })).toBe(
      true,
    );
    expect(readCurrentMemoryNativeChannelEvidence({ ...exact, now: 1_600 })).toBeUndefined();
    expect(revokeMemoryNativeChannelEvidence({ evidenceId: evidence.evidenceId, options })).toBe(false);

    const row = openOpenClawStateDatabase(options)
      .db.prepare(
        "SELECT conversation_ref, native_channel_ref FROM memory_native_channel_evidence WHERE evidence_id = ?",
      )
      .get(evidence.evidenceId) as { conversation_ref: string; native_channel_ref: string };
    expect(row.conversation_ref).not.toContain(exact.conversationId);
    expect(row.native_channel_ref).not.toContain(exact.nativeChannelId);
  });

  it("classifies missing, expired, and revoked receipts and records only opaque denial references", () => {
    const { env } = fixture();
    const options = { env };
    const principal = ensureMemoryOperationalPrincipal({
      kind: "conversation",
      stableRef: "main\u0000conversation-private",
      options,
    });
    const exact = address({ principalId: principal.principalId, options });
    const evidence = persistAdmittedNativeChannelMemoryEvidence({
      admission: admitted({ nativeChannelId: "native-private" }),
      ...exact,
      conversationId: "conversation-private",
      nativeChannelId: "native-private",
      observedAt: 1_000,
      expiresAt: 2_000,
    });
    const privateAddress = {
      ...exact,
      conversationId: "conversation-private",
      nativeChannelId: "native-private",
    };
    const missing = inspectMemoryNativeChannelEvidence({
      ...privateAddress,
      conversationId: "another-conversation-private",
      now: 1_500,
    });
    const expired = inspectMemoryNativeChannelEvidence({ ...privateAddress, now: 2_000 });
    expect(missing).toEqual({ kind: "missing" });
    expect(expired).toEqual({ kind: "expired", evidenceId: evidence.evidenceId });
    recordMemoryNativeChannelEvidenceDenial({
      ...privateAddress,
      inspection: missing,
      now: 2_001,
    });
    recordMemoryNativeChannelEvidenceDenial({
      ...privateAddress,
      inspection: expired,
      now: 2_001,
    });
    expect(revokeMemoryNativeChannelEvidence({ evidenceId: evidence.evidenceId, revokedAt: 1_500, options })).toBe(
      true,
    );
    const revoked = inspectMemoryNativeChannelEvidence({ ...privateAddress, now: 1_600 });
    expect(revoked).toEqual({ kind: "revoked", evidenceId: evidence.evidenceId });
    recordMemoryNativeChannelEvidenceDenial({
      ...privateAddress,
      inspection: revoked,
      now: 2_002,
    });

    const denials = openOpenClawStateDatabase(options)
      .db.prepare("SELECT * FROM memory_native_channel_evidence_denials ORDER BY reason_code")
      .all();
    expect(denials).toHaveLength(3);
    const stored = JSON.stringify(denials);
    for (const rawValue of [
      privateAddress.conversationId,
      privateAddress.nativeChannelId,
      "sender-private",
      "session-member-private",
    ]) {
      expect(stored).not.toContain(rawValue);
    }
  });

  it("replaces an address receipt with a new revision instead of accumulating per-message evidence", () => {
    const { env } = fixture();
    const options = { env };
    const principal = ensureMemoryOperationalPrincipal({
      kind: "conversation",
      stableRef: "main\u0000conversation-1",
      options,
    });
    const exact = address({ principalId: principal.principalId, options });
    const first = persistAdmittedNativeChannelMemoryEvidence({
      admission: admitted(),
      ...exact,
      observedAt: 1_000,
      expiresAt: 2_000,
    });
    const refreshed = persistAdmittedNativeChannelMemoryEvidence({
      admission: admitted(),
      ...exact,
      observedAt: 1_500,
      expiresAt: 2_500,
    });

    expect(refreshed.evidenceRevision).not.toBe(first.evidenceRevision);
    expect(readCurrentMemoryNativeChannelEvidence({ ...exact, now: 1_600 })).toEqual(refreshed);
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare("SELECT COUNT(*) AS count FROM memory_native_channel_evidence")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("first-use creates the additive table for an existing current-version state database", () => {
    const { env } = fixture();
    const options = { env };
    const state = openOpenClawStateDatabase(options);
    state.db.exec(`
      DROP INDEX IF EXISTS idx_memory_native_channel_evidence_current;
      DROP TABLE memory_native_channel_evidence;
    `);
    closeOpenClawStateDatabaseForTest();

    const principal = ensureMemoryOperationalPrincipal({
      kind: "conversation",
      stableRef: "main\u0000conversation-1",
      options,
    });
    const exact = address({ principalId: principal.principalId, options });
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'memory_native_channel_evidence'",
        )
        .get(),
    ).toBeUndefined();

    persistAdmittedNativeChannelMemoryEvidence({
      admission: admitted(),
      ...exact,
      observedAt: 1_000,
      expiresAt: 2_000,
    });
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'memory_native_channel_evidence'",
        )
        .get(),
    ).toEqual({ name: "memory_native_channel_evidence" });
  });
});
