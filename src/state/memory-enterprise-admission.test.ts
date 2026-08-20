import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitVerifiedEnterpriseIdentityForMemory,
  clearMemoryEnterpriseAdmissionsForTest,
  readCurrentEnterpriseMemoryFactsForUser,
} from "./memory-enterprise-admission.js";
import { listMemoryEnterpriseEvidenceDenialAudit } from "./memory-enterprise-access-audit.js";
import {
  ensureMemoryEnterprisePrincipal,
  linkMemoryEnterpriseProfile,
  persistMemoryEnterpriseIdentity,
  revokeMemoryEnterpriseMembershipSnapshot,
  writeMemoryEnterpriseMembershipSnapshot,
} from "./memory-enterprise-identity.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-memory-enterprise-admission-"));
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

afterEach(() => {
  clearMemoryEnterpriseAdmissionsForTest();
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("enterprise memory admission", () => {
  it("projects current linked enterprise groups onto the Gateway user, not the enterprise principal", () => {
    const { env } = fixture();
    const now = Date.now();
    const principal = ensureMemoryEnterprisePrincipal(
      {
        providerId: "entra",
        issuer: "https://login.microsoftonline.com/tenant-a/v2.0",
        tenant: "tenant-a",
        subject: "enterprise-alice",
        evidenceRevision: "oidc-evidence-1",
        observedAt: now,
        expiresAt: now + 60_000,
      },
      { env },
    );
    const membership = writeMemoryEnterpriseMembershipSnapshot(
      {
        principalId: principal.principalId,
        providerId: "entra",
        tenant: "tenant-a",
        group: "writers",
        evidenceRevision: "oidc-evidence-1",
        observedAt: now,
        expiresAt: now + 60_000,
      },
      { env },
    );
    createUserPrincipal({ principalId: "user-alice", profileId: "profile-alice", env });
    const link = linkMemoryEnterpriseProfile({
      enterprisePrincipalId: principal.principalId,
      providerId: "entra",
      userPrincipalId: "user-alice",
      createdByPrincipalId: "user-alice",
      options: { env },
    });
    admitVerifiedEnterpriseIdentityForMemory({
      userPrincipalId: "user-alice",
      principal,
      profileLink: link,
      identity: {
        providerId: "entra",
        issuer: "https://login.microsoftonline.com/tenant-a/v2.0",
        tenant: "tenant-a",
        subject: "enterprise-alice",
        groups: ["writers"],
        evidenceRevision: "oidc-evidence-1",
        observedAt: now,
        expiresAt: now + 60_000,
      },
    });

    expect(
      readCurrentEnterpriseMemoryFactsForUser({
        userPrincipalId: "user-alice",
        now: now + 2_000,
        options: { env },
      }),
    ).toMatchObject({
      verifiedPrincipals: [
        {
          principalId: principal.principalId,
          assurance: "oidc",
          evidenceRevision: "oidc-evidence-1",
        },
      ],
      verifiedMemberships: [
        {
          principalId: "user-alice",
          sourcePrincipalId: principal.principalId,
          groupId: "writers",
          profileLinkRevision: link.revision,
        },
      ],
    });
    expect(
      readCurrentEnterpriseMemoryFactsForUser({
        userPrincipalId: "user-bob",
        now: now + 2_000,
        options: { env },
      }),
    ).toEqual({ verifiedPrincipals: [], verifiedMemberships: [] });

    revokeMemoryEnterpriseMembershipSnapshot({
      snapshotId: membership.snapshotId,
      revokedAt: now + 2_001,
      options: { env },
    });
    expect(
      readCurrentEnterpriseMemoryFactsForUser({
        userPrincipalId: "user-alice",
        now: now + 2_002,
        options: { env },
      }),
    ).toEqual({ verifiedPrincipals: [], verifiedMemberships: [] });
  });

  it("removes an old admission immediately when a verified refresh replaces its membership evidence", () => {
    const { env } = fixture();
    const now = Date.now();
    const initialIdentity = {
      providerId: "entra",
      issuer: "https://login.microsoftonline.com/tenant-a/v2.0",
      tenant: "tenant-a",
      subject: "enterprise-alice",
      groups: ["writers"],
      evidenceRevision: "oidc-evidence-1",
      observedAt: now,
      expiresAt: now + 60_000,
    };
    const initial = persistMemoryEnterpriseIdentity({
      verified: initialIdentity,
      groups: initialIdentity.groups,
      options: { env },
    });
    createUserPrincipal({ principalId: "user-alice", profileId: "profile-alice", env });
    const link = linkMemoryEnterpriseProfile({
      enterprisePrincipalId: initial.principal.principalId,
      providerId: "entra",
      userPrincipalId: "user-alice",
      createdByPrincipalId: "user-alice",
      options: { env },
      now,
    });
    admitVerifiedEnterpriseIdentityForMemory({
      userPrincipalId: "user-alice",
      principal: initial.principal,
      profileLink: link,
      identity: initialIdentity,
    });

    const refreshedIdentity = {
      ...initialIdentity,
      groups: ["reviewers"],
      evidenceRevision: "oidc-evidence-2",
      observedAt: now + 1_000,
      expiresAt: now + 61_000,
    };
    const refreshed = persistMemoryEnterpriseIdentity({
      verified: refreshedIdentity,
      groups: refreshedIdentity.groups,
      options: { env },
    });
    expect(
      readCurrentEnterpriseMemoryFactsForUser({
        userPrincipalId: "user-alice",
        now: now + 2_000,
        options: { env },
      }),
    ).toEqual({ verifiedPrincipals: [], verifiedMemberships: [] });

    admitVerifiedEnterpriseIdentityForMemory({
      userPrincipalId: "user-alice",
      principal: refreshed.principal,
      profileLink: link,
      identity: refreshedIdentity,
    });
    expect(
      readCurrentEnterpriseMemoryFactsForUser({
        userPrincipalId: "user-alice",
        now: now + 2_000,
        options: { env },
      }),
    ).toMatchObject({
      verifiedMemberships: [{ groupId: "reviewers", evidenceRevision: "oidc-evidence-2" }],
    });
  });

  it("records stale, missing, and expired provider evidence as redacted denial projections", () => {
    const { env } = fixture();
    const options = { env };
    const now = 1_000;
    const identity = {
      providerId: "entra",
      issuer: "https://login.microsoftonline.com/tenant-private/v2.0",
      tenant: "tenant-private",
      subject: "enterprise-alice-private",
      groups: ["writers-private", "missing-private"],
      evidenceRevision: "evidence-private:v1",
      observedAt: now,
      expiresAt: now + 1_000,
    };
    const persisted = persistMemoryEnterpriseIdentity({
      verified: identity,
      groups: ["writers-private"],
      options,
    });
    createUserPrincipal({ principalId: "user-alice", profileId: "profile-alice", env });
    const link = linkMemoryEnterpriseProfile({
      enterprisePrincipalId: persisted.principal.principalId,
      providerId: "entra",
      userPrincipalId: "user-alice",
      createdByPrincipalId: "user-alice",
      now,
      options,
    });
    admitVerifiedEnterpriseIdentityForMemory({
      userPrincipalId: "user-alice",
      principal: persisted.principal,
      profileLink: link,
      identity,
    });

    expect(
      readCurrentEnterpriseMemoryFactsForUser({ userPrincipalId: "user-alice", now: now + 1, options }),
    ).toMatchObject({ verifiedMemberships: [{ groupId: "writers-private" }] });
    const snapshot = openOpenClawStateDatabase(options)
      .db.prepare(
        `SELECT snapshot_id FROM memory_enterprise_membership_snapshots
         WHERE principal_id = ?`,
      )
      .get(persisted.principal.principalId) as { snapshot_id: string };
    revokeMemoryEnterpriseMembershipSnapshot({
      snapshotId: snapshot.snapshot_id,
      revokedAt: now + 2,
      options,
    });
    expect(
      readCurrentEnterpriseMemoryFactsForUser({ userPrincipalId: "user-alice", now: now + 3, options }),
    ).toEqual({ verifiedPrincipals: [], verifiedMemberships: [] });
    expect(
      readCurrentEnterpriseMemoryFactsForUser({
        userPrincipalId: "user-alice",
        now: identity.expiresAt,
        options,
      }),
    ).toEqual({ verifiedPrincipals: [], verifiedMemberships: [] });

    const denials = listMemoryEnterpriseEvidenceDenialAudit(
      { subjectPrincipalId: "user-alice" },
      options,
    );
    expect(denials.map((denial) => denial.reasonCode).sort()).toEqual([
      "membership-stale",
      "principal-evidence-unavailable",
      "principal-evidence-unavailable",
      "role-membership-unavailable",
    ]);
    const persistedDenials = JSON.stringify(
      openOpenClawStateDatabase(options)
        .db.prepare("SELECT * FROM memory_enterprise_evidence_denials")
        .all(),
    );
    for (const rawValue of [
      identity.tenant,
      identity.subject,
      identity.groups[0],
      identity.groups[1],
      identity.evidenceRevision,
    ]) {
      expect(persistedDenials).not.toContain(rawValue);
    }
  });
});
