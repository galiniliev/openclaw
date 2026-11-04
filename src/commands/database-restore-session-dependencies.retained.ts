import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { retainedRepositoryDisk } from "../gateway/worker-environments/retained-workspace.js";
import { configuredWorkerProfileSnapshot } from "../gateway/worker-environments/service-validation.js";
import type { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { WorkerSessionDiskRetention } from "../plugins/worker-retention.types.js";
import { RetainedWorkspaceAuthority } from "../state/retained-workspace-authority.js";
import type { PreparedSessionDependencyRows } from "./database-restore-session-dependencies.kernel.js";

const text = z.string().min(1).max(4096);
const epoch = z.number().int().positive();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const identitySchema = z.object({
  leaseId: text,
  attemptLeaseId: text,
  slug: text,
  resourceId: z.uuid(),
});
const ownerSchema = z.object({ agentId: text, sessionKey: text, sessionId: z.uuid() });
const policySchema = z.object({
  mode: z.literal("session-disk"),
  computeWindowSeconds: epoch,
});
const operationSchema = z.object({
  id: text,
  action: z.enum(["pause", "resume"]),
  expectedClaimRevision: text,
});
const retentionSchema = z.object({
  policy: policySchema,
  owner: ownerSchema,
  ownerBinding: hash,
  desiredState: z.enum(["running", "suspended"]),
  operation: z.null(),
  receipt: z.object({
    schema: z.literal("crabbox.session-disk.v1"),
    mode: z.literal("session-disk"),
    ownerBinding: hash,
    identity: identitySchema,
    claimRevision: text,
    computeWindowSeconds: epoch,
    desiredState: z.enum(["running", "suspended", "retired"]),
    observedState: z.literal("Stopped"),
    policyVerified: z.literal(true),
    stopPending: z.literal(false),
    operation: operationSchema.extend({ phase: z.literal("observed") }).optional(),
    computeWindow: z.object({
      id: text,
      authorizedAt: text,
      expiresAt: text,
      state: z.enum(["active", "closed"]),
    }),
  }),
});

export const RestoreMissingBindingsExpectedSchema = z.strictObject({
  sessionId: z.uuid(),
  environmentId: text,
  sourceOwnerEpoch: epoch,
  sourcePlacementGeneration: epoch,
  workspaceRevision: z.number().int().nonnegative(),
  leaseId: text,
  ownerBinding: hash,
  resourceId: z.uuid(),
  workspaceDir: text,
  profileId: text,
  providerScope: z
    .string()
    .regex(/^azure-sandbox:[A-Za-z0-9._-]+:[a-f0-9-]{36}:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/iu),
});
export type RestoreMissingBindingsExpected = z.infer<typeof RestoreMissingBindingsExpectedSchema>;
export type RetainedDependencySource = {
  authority: RetainedWorkspaceAuthority;
  policy: WorkerSessionDiskRetention["policy"];
  sourcePlacementGeneration: number;
  provisionOperationId: string;
};

/** Read public ownership from the sealed source, never its credentials or transports. */
export function readRetainedDependencySource(
  db: ReturnType<typeof openNodeSqliteDatabase>,
  request: { agentId: string; sessionKey: string; expected: RestoreMissingBindingsExpected },
  workspace: PreparedSessionDependencyRows["workspace"],
): RetainedDependencySource {
  const { expected } = request;
  const placement = z
    .object({
      session_id: z.uuid(),
      agent_id: text,
      session_key: text,
      state: z.literal("active"),
      environment_id: text,
      transition_generation: epoch,
      active_owner_epoch: epoch,
      remote_workspace_dir: text,
    })
    .parse(
      db
        .prepare(`SELECT session_id,agent_id,session_key,state,environment_id,
    transition_generation,active_owner_epoch,remote_workspace_dir
    FROM worker_session_placements WHERE session_id=?`)
        .get(expected.sessionId),
    );
  const row = z
    .object({
      environment_id: text,
      provider_id: z.literal("crabbox"),
      state: z.literal("attached"),
      owner_epoch: epoch,
      lease_id: text,
      shared_host: z.literal(0),
      provision_operation_id: text,
      destroy_requested_at_ms: z.null(),
      profile_snapshot_json: z.string(),
      session_retention_json: z.string(),
      attached_session_ids_json: z.string(),
    })
    .parse(
      db
        .prepare(`SELECT environment_id,provider_id,state,owner_epoch,lease_id,shared_host,
    provision_operation_id,destroy_requested_at_ms,profile_snapshot_json,session_retention_json,attached_session_ids_json
    FROM worker_environments WHERE environment_id=?`)
        .get(expected.environmentId),
    );
  const profile = z
    .object({ settings: z.object({ provider: z.literal("azure-sandbox") }) })
    .parse(JSON.parse(row.profile_snapshot_json));
  const retention = retentionSchema.parse(JSON.parse(row.session_retention_json));
  const attached = z.array(z.uuid()).length(1).parse(JSON.parse(row.attached_session_ids_json));
  const owner = {
    agentId: request.agentId,
    sessionKey: request.sessionKey,
    sessionId: expected.sessionId,
  };
  const authority = retainedRepositoryDisk(
    {
      environmentId: row.environment_id,
      providerId: row.provider_id,
      profileSnapshot: profile,
      retention,
      leaseId: row.lease_id,
      ownerEpoch: row.owner_epoch,
      destroyRequestedAtMs: null,
    },
    owner,
    placement.remote_workspace_dir,
  );
  if (
    !authority ||
    attached[0] !== owner.sessionId ||
    placement.agent_id !== owner.agentId ||
    placement.session_key !== owner.sessionKey ||
    placement.environment_id !== expected.environmentId ||
    placement.active_owner_epoch !== row.owner_epoch ||
    placement.transition_generation !== expected.sourcePlacementGeneration ||
    row.owner_epoch !== expected.sourceOwnerEpoch ||
    row.lease_id !== expected.leaseId ||
    authority.ownerBinding !== expected.ownerBinding ||
    authority.identity.resourceId !== expected.resourceId ||
    authority.workspaceDir !== expected.workspaceDir ||
    workspace.revision !== expected.workspaceRevision ||
    retention.receipt.computeWindowSeconds !== retention.policy.computeWindowSeconds ||
    retention.receipt.identity.attemptLeaseId !== expected.leaseId ||
    (workspace.disk_authority_json !== null &&
      !isDeepStrictEqual(JSON.parse(workspace.disk_authority_json), authority))
  ) {
    throw new Error("Selected retained dependency ownership differs from its sealed source.");
  }
  RetainedWorkspaceAuthority.parse(authority);
  return {
    authority,
    policy: retention.policy,
    sourcePlacementGeneration: placement.transition_generation,
    provisionOperationId: row.provision_operation_id,
  };
}

export function assertRetainedDependencySession(
  entry: InternalSessionEntry | undefined,
  request: { workspaceId: string; expected: RestoreMissingBindingsExpected },
) {
  if (
    !entry ||
    entry.sessionId !== request.expected.sessionId ||
    entry.archivedAt !== undefined ||
    entry.repositoryWorkspaceId !== request.workspaceId
  ) {
    throw new Error("Current recovery session was deleted, archived or rebound.");
  }
}

/** The Factory's canonical explicit route environment overrides its controller file. */
export function currentRetainedDependencyProfile(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  expected: RestoreMissingBindingsExpected,
  source: RetainedDependencySource,
) {
  const profile = config.cloudWorkers?.profiles?.[expected.profileId];
  const route = ["REGION", "SUBSCRIPTION_ID", "RESOURCE_GROUP", "GROUP"].map((field) =>
    env[`CRABBOX_AZURE_SANDBOX_${field}`]?.trim(),
  );
  if (
    !profile ||
    profile.provider !== "crabbox" ||
    route.some((value) => !value) ||
    `azure-sandbox:${route.join(":")}` !== expected.providerScope
  ) {
    throw new Error(
      "Current retained worker profile or explicit provider route differs from recovery selection.",
    );
  }
  const snapshot = configuredWorkerProfileSnapshot(profile);
  if (
    !isRecord(snapshot.settings) ||
    snapshot.settings.provider !== "azure-sandbox" ||
    !isDeepStrictEqual(snapshot.retention, source.policy)
  ) {
    throw new Error(
      "Current retained worker provider or retention policy differs from the original owner.",
    );
  }
  return snapshot;
}
