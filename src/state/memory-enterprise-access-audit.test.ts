import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSecureUuid } from "../infra/secure-random.js";
import type { MemoryAccessContext } from "../memory-host-sdk/host/authorization.js";
import {
  deleteMemoryEnterpriseAuditForUserPrincipal,
  listMemoryEnterpriseAccessDecisionAudit,
  listMemoryEnterpriseEvidenceDenialAudit,
  listMemoryEnterprisePolicyDriftAlerts,
  recordMemoryEnterpriseEvidenceAdmissionDenials,
  recordMemoryEnterpriseRoleAccessDecisions,
  writeMemoryEnterpriseAccessDecisionAudit,
} from "./memory-enterprise-access-audit.js";
import {
  ensureMemoryEnterprisePrincipal,
  linkMemoryEnterpriseProfile,
  revokeMemoryEnterpriseProfileEvidence,
  writeMemoryEnterpriseMembershipSnapshot,
} from "./memory-enterprise-identity.js";
import { ensureMemoryOperationalPrincipal } from "./memory-identity.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const roots: string[] = [];

function opaqueAuditReference(value: "a" | "b" | "c" | "d" | "e"): string {
  return `hmac-sha256:v1:${value.repeat(32)}:${value.repeat(64)}`;
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-memory-enterprise-audit-"));
  roots.push(root);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: root } };
}

function createUserPrincipal(params: {
  principalId: string;
  profileId: string;
  env: NodeJS.ProcessEnv;
}) {
  openOpenClawStateDatabase({ env: params.env })
    .db.prepare(
      `INSERT INTO memory_principals
       (principal_id, principal_kind, user_profile_id, principal_lookup_hmac, state, revision, created_at, revoked_at)
       VALUES (?, 'user', ?, NULL, 'active', ?, ?, NULL)`,
    )
    .run(params.principalId, params.profileId, `revision:${params.principalId}`, 1_000);
}

function entry(
  subjectPrincipalId: string,
  overrides: Partial<Parameters<typeof writeMemoryEnterpriseAccessDecisionAudit>[0]> = {},
) {
  return {
    eventId: generateSecureUuid(),
    providerId: "entra",
    tenantRef: opaqueAuditReference("a"),
    actorPrincipalId: "principal:operator",
    subjectPrincipalId,
    operation: "memory.read",
    decision: "allowed" as const,
    reasonCode: "allowed" as const,
    ruleRef: opaqueAuditReference("b"),
    policyRevision: opaqueAuditReference("c"),
    principalEvidenceRevision: opaqueAuditReference("d"),
    membershipEvidenceRevision: opaqueAuditReference("e"),
    occurredAt: 1_000,
    receivedAt: 1_001,
    ...overrides,
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("enterprise memory access decision audit", () => {
  it("stores only redacted ids, revisions, reasons, and opaque policy references", () => {
    const { env } = fixture();
    const subjectPrincipalId = "principal:alice";
    const recorded = entry(subjectPrincipalId);
    writeMemoryEnterpriseAccessDecisionAudit(recorded, { env });

    const db = openOpenClawStateDatabase({ env }).db;
    const row = db
      .prepare("SELECT * FROM memory_enterprise_access_decisions WHERE event_id = ?")
      .get(recorded.eventId) as Record<string, unknown>;
    expect(row).toEqual({
      event_id: recorded.eventId,
      provider_id: "entra",
      tenant_ref: recorded.tenantRef,
      actor_principal_id: "principal:operator",
      subject_principal_id: subjectPrincipalId,
      operation: "memory.read",
      decision: "allowed",
      reason_code: "allowed",
      rule_ref: recorded.ruleRef,
      policy_revision: recorded.policyRevision,
      principal_evidence_revision: recorded.principalEvidenceRevision,
      membership_evidence_revision: recorded.membershipEvidenceRevision,
      occurred_at: 1_000,
      received_at: 1_001,
    });
    expect(Object.keys(row)).not.toContain("claims");
    expect(Object.keys(row)).not.toContain("group_id");
    expect(Object.keys(row)).not.toContain("content");
  });

  it("deduplicates an event and exposes only a bounded subject-scoped page", () => {
    const { env } = fixture();
    const subjectPrincipalId = "principal:subject";
    const first = entry(subjectPrincipalId, { occurredAt: 10 });
    const second = entry(subjectPrincipalId, { occurredAt: 20 });
    writeMemoryEnterpriseAccessDecisionAudit(first, { env });
    writeMemoryEnterpriseAccessDecisionAudit(first, { env });
    writeMemoryEnterpriseAccessDecisionAudit(second, { env });
    writeMemoryEnterpriseAccessDecisionAudit(entry("principal:other"), { env });

    expect(
      listMemoryEnterpriseAccessDecisionAudit({ subjectPrincipalId, limit: 1 }, { env }),
    ).toEqual([expect.objectContaining({ eventId: second.eventId, subjectPrincipalId })]);
    expect(
      listMemoryEnterpriseAccessDecisionAudit(
        { subjectPrincipalId, providerId: "other-provider" },
        { env },
      ),
    ).toEqual([]);
    expect(() =>
      listMemoryEnterpriseAccessDecisionAudit({ subjectPrincipalId, limit: 0 }, { env }),
    ).toThrow("limit must be a positive integer");
  });

  it("rejects a backend-provided audit reason outside the closed safe vocabulary", () => {
    const { env } = fixture();
    const context = {
      actor: { kind: "principal", principalId: "principal:user" },
      subject: { kind: "user", principalId: "principal:user" },
      verifiedMemberships: [],
    } as unknown as MemoryAccessContext;

    expect(() =>
      recordMemoryEnterpriseRoleAccessDecisions({
        context,
        decisions: [
          {
            groupId: "engineering",
            policyId: "restricted-memory-title",
            decision: "denied",
            reasonCode: "restricted-memory-content" as never,
            policyRevision: "revision:one",
          },
        ],
        options: { env },
      }),
    ).toThrow("reasonCode is not a permitted enterprise memory audit code");
  });

  it("derives role decision audit evidence from current reduced membership, never backend input", () => {
    const { env } = fixture();
    const enterprise = ensureMemoryEnterprisePrincipal(
      {
        providerId: "entra",
        issuer: "https://login.microsoftonline.com/tenant-raw/v2.0",
        tenant: "tenant-raw",
        subject: "alice-raw",
        evidenceRevision: "evidence:v1",
        observedAt: 1_000,
        expiresAt: 3_000,
      },
      { env },
    );
    const membership = writeMemoryEnterpriseMembershipSnapshot(
      {
        principalId: enterprise.principalId,
        providerId: "entra",
        tenant: "tenant-raw",
        group: "engineering-raw",
        evidenceRevision: "evidence:v1",
        observedAt: 1_000,
        expiresAt: 3_000,
      },
      { env },
    );
    const context = {
      requestId: "request:one",
      operation: "read",
      actor: { kind: "principal", principalId: "principal:user" },
      subject: { kind: "user", principalId: "principal:user" },
      verifiedMemberships: [
        {
          snapshotId: membership.snapshotId,
          principalId: "principal:user",
          sourcePrincipalId: enterprise.principalId,
          provider: "entra",
          groupId: "engineering-raw",
          evidenceRevision: "evidence:v1",
          profileLinkRevision: "profile:v1",
          observedAt: new Date(1_000).toISOString(),
          expiresAt: new Date(3_000).toISOString(),
        },
      ],
    } as unknown as MemoryAccessContext;

    recordMemoryEnterpriseRoleAccessDecisions({
      context,
      decisions: [
        {
          groupId: "engineering-raw",
          policyId: "policy:role-engineering:restricted-memory-title",
          decision: "allowed",
          reasonCode: "allowed",
          policyRevision: "policy:v4:restricted-memory-content",
        },
      ],
      now: 1_500,
      options: { env },
    });
    for (const decision of [
      {
        policyRevision: "policy:v4:restricted-memory-content",
        decision: "allowed" as const,
      },
      {
        policyRevision: "policy:v5:restricted-memory-content",
        decision: "denied" as const,
      },
      {
        policyRevision: "policy:v5:restricted-memory-content",
        decision: "denied" as const,
      },
      {
        policyRevision: "policy:v6:restricted-memory-content",
        decision: "denied" as const,
      },
    ]) {
      recordMemoryEnterpriseRoleAccessDecisions({
        context,
        decisions: [
          {
            groupId: "engineering-raw",
            policyId: "policy:role-engineering:restricted-memory-title",
            decision: decision.decision,
            reasonCode: decision.decision === "allowed" ? "allowed" : "default-deny",
            policyRevision: decision.policyRevision,
          },
        ],
        now: 1_500,
        options: { env },
      });
    }

    const auditEntries = listMemoryEnterpriseAccessDecisionAudit(
      { subjectPrincipalId: "principal:user" },
      { env },
    );
    expect(auditEntries).toHaveLength(3);
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "entra",
          tenantRef: membership.tenantRef,
          ruleRef: membership.groupRef,
          decision: "allowed",
          policyRevision: expect.stringMatching(/^hmac-sha256:v1:/u),
        }),
        expect.objectContaining({
          decision: "denied",
          policyRevision: expect.stringMatching(/^hmac-sha256:v1:/u),
        }),
        expect.objectContaining({
          decision: "denied",
          policyRevision: expect.stringMatching(/^hmac-sha256:v1:/u),
        }),
      ]),
    );
    const stored = JSON.stringify(
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT * FROM memory_enterprise_access_decisions")
        .all(),
    );
    expect(stored).not.toContain("tenant-raw");
    expect(stored).not.toContain("engineering-raw");
    expect(stored).not.toContain("policy:role-engineering:restricted-memory-title");
    expect(stored).not.toContain("policy:v4:restricted-memory-content");
    const alerts = openOpenClawStateDatabase({ env })
      .db.prepare("SELECT * FROM memory_enterprise_policy_drift_alerts")
      .all() as Array<Record<string, unknown>>;
    expect(alerts).toEqual([
      expect.objectContaining({
        provider_id: "entra",
        tenant_ref: membership.tenantRef,
        subject_principal_id: "principal:user",
        rule_ref: membership.groupRef,
        policy_id: expect.stringMatching(/^hmac-sha256:v1:/u),
        previous_policy_revision: expect.stringMatching(/^hmac-sha256:v1:/u),
        previous_decision: "allowed",
        policy_revision: expect.stringMatching(/^hmac-sha256:v1:/u),
        decision: "denied",
      }),
    ]);
    expect(JSON.stringify(alerts)).not.toContain("engineering-raw");
    expect(JSON.stringify(alerts)).not.toContain(
      "policy:role-engineering:restricted-memory-title",
    );
    expect(JSON.stringify(alerts)).not.toContain("policy:v5:restricted-memory-content");
    expect(
      listMemoryEnterprisePolicyDriftAlerts({ subjectPrincipalId: "principal:user" }, { env }),
    ).toEqual([
      expect.objectContaining({
        policyId: expect.stringMatching(/^hmac-sha256:v1:/u),
        previousPolicyRevision: expect.stringMatching(/^hmac-sha256:v1:/u),
        previousDecision: "allowed",
        policyRevision: expect.stringMatching(/^hmac-sha256:v1:/u),
        decision: "denied",
      }),
    ]);
  });

  it("deletes only an owner's redacted audit projections and preserves identity evidence", () => {
    const { env } = fixture();
    const options = { env };
    createUserPrincipal({ principalId: "user-alice", profileId: "profile-alice", env });
    const enterprise = ensureMemoryEnterprisePrincipal(
      {
        providerId: "entra",
        issuer: "https://login.microsoftonline.com/tenant-a/v2.0",
        tenant: "tenant-a",
        subject: "enterprise-alice",
        evidenceRevision: "evidence:v1",
        observedAt: 1_000,
        expiresAt: 5_000,
      },
      options,
    );
    const link = linkMemoryEnterpriseProfile({
      enterprisePrincipalId: enterprise.principalId,
      providerId: "entra",
      userPrincipalId: "user-alice",
      createdByPrincipalId: "user-alice",
      now: 1_000,
      options,
    });
    writeMemoryEnterpriseMembershipSnapshot(
      {
        principalId: enterprise.principalId,
        providerId: "entra",
        tenant: "tenant-a",
        group: "writers",
        evidenceRevision: "evidence:v1",
        observedAt: 1_000,
        expiresAt: 5_000,
      },
      options,
    );
    writeMemoryEnterpriseAccessDecisionAudit(entry("user-alice"), options);
    recordMemoryEnterpriseEvidenceAdmissionDenials({
      denials: [
        {
          providerId: "entra",
          tenant: "tenant-a",
          subjectPrincipalId: "user-alice",
          groupId: "writers",
          reasonCode: "principal-evidence-unavailable",
          principalEvidenceRevision: "evidence:v1",
        },
      ],
      now: 1_001,
      options,
    });
    const db = openOpenClawStateDatabase(options).db;
    db.prepare(
      `INSERT INTO memory_enterprise_role_policy_observations
       (provider_id, tenant_ref, subject_principal_id, rule_ref, policy_id, operation, policy_revision, decision, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "entra",
      opaqueAuditReference("a"),
      "user-alice",
      opaqueAuditReference("b"),
      opaqueAuditReference("c"),
      "memory.read",
      opaqueAuditReference("d"),
      "allowed",
      1_002,
    );
    db.prepare(
      `INSERT INTO memory_enterprise_policy_drift_alerts
       (alert_id, provider_id, tenant_ref, subject_principal_id, rule_ref, policy_id, operation,
        previous_policy_revision, previous_decision, policy_revision, decision, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "alert:alice",
      "entra",
      opaqueAuditReference("a"),
      "user-alice",
      opaqueAuditReference("b"),
      opaqueAuditReference("c"),
      "memory.read",
      opaqueAuditReference("d"),
      "allowed",
      opaqueAuditReference("e"),
      "denied",
      1_003,
    );
    revokeMemoryEnterpriseProfileEvidence({
      userPrincipalId: "user-alice",
      providerId: "entra",
      actorPrincipalId: "user-alice",
      now: 1_004,
      options,
    });

    expect(link.userPrincipalId).toBe("user-alice");
    const result = deleteMemoryEnterpriseAuditForUserPrincipal({
      userPrincipalId: "user-alice",
      actorPrincipalId: "user-alice",
      now: 1_005,
      options,
    });

    expect(result).toEqual({
      accessDecisionCount: 1,
      policyObservationCount: 1,
      policyDriftAlertCount: 1,
      evidenceTransitionProfileLinkCount: 1,
      identityActionCount: 1,
    });
    expect(listMemoryEnterpriseAccessDecisionAudit({ subjectPrincipalId: "user-alice" }, options)).toEqual([]);
    expect(listMemoryEnterpriseEvidenceDenialAudit({ subjectPrincipalId: "user-alice" }, options)).toEqual([]);
    for (const table of [
      "memory_enterprise_role_policy_observations",
      "memory_enterprise_policy_drift_alerts",
      "memory_enterprise_evidence_transition_profile_links",
      "memory_enterprise_identity_actions",
      "memory_enterprise_audit_deletion_grants",
    ]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    for (const table of [
      "memory_enterprise_principal_evidence",
      "memory_enterprise_membership_snapshots",
      "memory_enterprise_profile_links",
      "memory_enterprise_evidence_transitions",
      "memory_enterprise_evidence_transition_memberships",
    ]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 1 });
    }
    expect(() =>
      db.prepare("DELETE FROM memory_enterprise_evidence_transitions WHERE principal_id = ?").run(
        enterprise.principalId,
      ),
    ).toThrow("cannot be deleted");
  });

  it("allows an attributed system actor but rejects a non-admin operational actor", () => {
    const { env } = fixture();
    const options = { env };
    createUserPrincipal({ principalId: "user-alice", profileId: "profile-alice", env });
    const system = ensureMemoryOperationalPrincipal({
      kind: "system",
      stableRef: "gateway-admin",
      options,
    });
    const service = ensureMemoryOperationalPrincipal({
      kind: "service",
      stableRef: "not-an-admin",
      options,
    });

    expect(
      deleteMemoryEnterpriseAuditForUserPrincipal({
        userPrincipalId: "user-alice",
        actorPrincipalId: system.principalId,
        now: 1_000,
        options,
      }),
    ).toEqual({
      accessDecisionCount: 0,
      policyObservationCount: 0,
      policyDriftAlertCount: 0,
      evidenceTransitionProfileLinkCount: 0,
      identityActionCount: 0,
    });
    expect(() =>
      deleteMemoryEnterpriseAuditForUserPrincipal({
        userPrincipalId: "user-alice",
        actorPrincipalId: service.principalId,
        now: 1_001,
        options,
      }),
    ).toThrow("active Gateway user or system actor");
  });

  it("rolls back the transient deletion grant when a guarded projection purge fails", () => {
    const { env } = fixture();
    const options = { env };
    createUserPrincipal({ principalId: "user-alice", profileId: "profile-alice", env });
    writeMemoryEnterpriseAccessDecisionAudit(entry("user-alice"), options);
    const db = openOpenClawStateDatabase(options).db;
    db.exec(`
      CREATE TRIGGER test_enterprise_audit_delete_abort
      BEFORE DELETE ON memory_enterprise_access_decisions
      BEGIN
        SELECT RAISE(ABORT, 'test audit delete abort');
      END;
    `);

    expect(() =>
      deleteMemoryEnterpriseAuditForUserPrincipal({
        userPrincipalId: "user-alice",
        actorPrincipalId: "user-alice",
        now: 1_000,
        options,
      }),
    ).toThrow("test audit delete abort");
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_enterprise_access_decisions").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_enterprise_audit_deletion_grants").get()).toEqual({
      count: 0,
    });
  });
});
