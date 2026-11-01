import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { WorkerProfile } from "../../plugins/capability-provider.types.js";
import type { WorkerSessionDiskRetention } from "../../plugins/worker-retention.types.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { RetainedWorkspaceAuthority } from "../../state/retained-workspace-authority.js";
import { findSessionRepositoryWorkspaceInDatabase } from "../../state/session-repository-workspaces.kernel.js";
import { hasForcedWorkerEnvironmentAbandonment } from "./environment-errors.js";
import type {
  WorkerEnvironmentIntentInput,
  WorkerEnvironmentRecord,
} from "./environment-record.js";
import {
  FORCED_WORKER_ABANDONMENT_ERROR,
  type WorkerSessionPlacementIdentity,
} from "./placement-record.js";
import { find as findPlacement, updateTransition } from "./placement-row-codec.js";
import {
  matchesWorkerPlacementTarget,
  type WorkerPlacementCancellationTarget,
} from "./placement-target.js";
import {
  hasWorkerEnvironmentSessionAttachment,
  readWorkerEnvironmentSessionAttachment,
} from "./session-attachment-store.js";
import { nextGlobalOwnerEpoch, updateWorkerEnvironmentRecord } from "./store-mutations.js";
import { findWorkerEnvironment, getRequiredWorkerEnvironment } from "./store-row-codec.js";

export const RETAINED_WORKSPACE_OWNER_REPAIR_HOLD =
  "Original retained workspace owner parked for verified reattachment";
export const RESTORED_RETAINED_WORKSPACE_OWNER_HOLD =
  "Original retained workspace owner restored dormant for verified reattachment";
const marker = (at: number) =>
  `${RETAINED_WORKSPACE_OWNER_REPAIR_HOLD}; destroyRequestedAtMs=${at}`;

export function isRetainedWorkspaceOwnerRepairHold(value: string | null | undefined): boolean {
  if (value === RESTORED_RETAINED_WORKSPACE_OWNER_HOLD) {
    return true;
  }
  const prefix = `${RETAINED_WORKSPACE_OWNER_REPAIR_HOLD}; destroyRequestedAtMs=`;
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    return false;
  }
  const at = value.slice(prefix.length);
  return /^(?:0|[1-9][0-9]*)$/u.test(at) && Number.isSafeInteger(Number(at));
}

/** Offline restoration imports ownership only; ordinary dispatch still owns fresh execution. */
export function restoreMissingRetainedWorkspaceOwnerInDatabase(
  db: EngineConnection,
  input: {
    owner: Owner;
    authority: RetainedWorkspaceAuthority;
    policy: WorkerSessionDiskRetention["policy"];
    profileId: string;
    profileSnapshot: WorkerProfile;
    sourcePlacementGeneration: number;
    providerScope: string;
    provisionOperationId: string;
  },
  createIntent: (input: WorkerEnvironmentIntentInput) => WorkerEnvironmentRecord,
  nowMs: number,
) {
  const { owner, authority } = input;
  const workspace = originalWorkspace(db, owner, authority);
  const placement = findPlacement(db, owner.sessionId);
  if (
    placement &&
    (placement.state !== "local" ||
      placement.environmentId !== null ||
      placement.activeOwnerEpoch !== null ||
      placement.confirmedLossRecovery)
  ) {
    refuse("a current placement already owns this session");
  }
  assertQuiet(db, authority.environmentId, owner, nowMs);
  if (readWorkerEnvironmentSessionAttachment(db, owner.sessionId)) {
    refuse("a current attachment already owns this session");
  }
  const existing = findWorkerEnvironment(db, authority.environmentId);
  const retention: WorkerSessionDiskRetention = {
    owner,
    ownerBinding: authority.ownerBinding,
    policy: input.policy,
    desiredState: "suspended",
    receipt: null,
    operation: null,
  };
  const operation = input.provisionOperationId;
  if (existing) {
    assertUnadmitted(db, existing, owner, authority);
    if (
      existing.state !== "orphaned" ||
      existing.lastError !== RESTORED_RETAINED_WORKSPACE_OWNER_HOLD ||
      existing.destroyRequestedAtMs !== null ||
      existing.teardownTerminalState !== null ||
      existing.profileId !== input.profileId ||
      !isDeepStrictEqual(existing.profileSnapshot, input.profileSnapshot) ||
      !isDeepStrictEqual(existing.retention, retention) ||
      existing.provisionOperationId !== operation
    ) {
      refuse("the retained target environment is occupied or changed");
    }
  } else {
    createIntent({
      environmentId: authority.environmentId,
      providerId: "crabbox",
      profileId: input.profileId,
      profileSnapshot: input.profileSnapshot,
      retention,
      provisionOperationId: operation,
    });
    updateWorkerEnvironmentRecord(db, authority.environmentId, "requested", {
      state: "orphaned",
      lease_id: authority.identity.leaseId,
      shared_host: 0,
      last_error: RESTORED_RETAINED_WORKSPACE_OWNER_HOLD,
      state_changed_at_ms: nowMs,
      updated_at_ms: nowMs,
    });
  }
  return {
    version: 2 as const,
    status: existing ? ("already-restored-dormant" as const) : ("restored-dormant" as const),
    ...owner,
    workspaceId: workspace.workspaceId,
    workspaceRevision: workspace.revision,
    environmentId: authority.environmentId,
    environmentState: "orphaned" as const,
    environmentOwnerEpoch: 0 as const,
    leaseId: authority.identity.leaseId,
    ownerBinding: authority.ownerBinding,
    identity: authority.identity,
    workspaceDir: authority.workspaceDir,
    originalDiskOwnerEpoch: authority.ownerEpoch,
    sourcePlacementGeneration: input.sourcePlacementGeneration,
    profileId: input.profileId,
    providerScope: input.providerScope,
    provisionOperationId: operation,
    cleanupDisarmed: true as const,
    executionReady: false as const,
    computeAuthorized: false as const,
  };
}

export const ParkRetainedWorkspaceOwnerInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  agentId: z.string().min(1),
  sessionKey: z.string().min(1),
  expectedDiskAuthority: RetainedWorkspaceAuthority,
  sessionId: z.string().min(1),
  environmentId: z.string().min(1),
  environmentState: z.literal("destroying"),
  environmentOwnerEpoch: z.literal(0),
  leaseId: z.string().min(1),
  destroyRequestedAtMs: z.number().int().nonnegative(),
  placementGeneration: z.number().int().nonnegative(),
  workspaceRevision: z.number().int().nonnegative(),
});
export type ParkRetainedWorkspaceOwnerInput = z.infer<typeof ParkRetainedWorkspaceOwnerInputSchema>;
type Owner = { agentId: string; sessionKey: string; sessionId: string };

function refuse(reason: string): never {
  throw new Error(`Retained workspace owner repair refused: ${reason}.`);
}

function assertUnadmitted(
  db: EngineConnection,
  environment: WorkerEnvironmentRecord,
  owner: Owner,
  authority: RetainedWorkspaceAuthority,
  phase: "parked" | "pending" = "parked",
) {
  const retention = environment.retention;
  const settings = environment.profileSnapshot.settings;
  if (
    environment.providerId !== "crabbox" ||
    !isRecord(settings) ||
    settings.provider !== "azure-sandbox" ||
    environment.environmentId !== authority.environmentId ||
    (phase === "parked"
      ? environment.leaseId !== authority.identity.leaseId
      : environment.leaseId !== null) ||
    (phase === "parked"
      ? environment.ownerEpoch !== 0
      : environment.ownerEpoch <= authority.ownerEpoch) ||
    // Pending intent has no provider lease facts yet; only parked leases require
    // an already observed dedicated host. An explicitly shared host never qualifies.
    (phase === "parked" ? environment.sharedHost !== false : environment.sharedHost === true) ||
    (phase === "parked" ? environment.nodeSetupId !== null : !environment.nodeSetupId?.trim()) ||
    environment.nodeDeviceId !== null ||
    environment.sshEndpoint !== null ||
    environment.desktop !== null ||
    environment.bootstrapReceipt !== null ||
    environment.preparation !== null ||
    environment.attachedSessionIds.length !== 0 ||
    environment.lastActivatedAtMs !== null ||
    !retention ||
    retention.policy.mode !== "session-disk" ||
    !Number.isSafeInteger(retention.policy.computeWindowSeconds) ||
    retention.policy.computeWindowSeconds <= 0 ||
    !isDeepStrictEqual(retention.owner, owner) ||
    retention.ownerBinding !== authority.ownerBinding ||
    authority.sessionId !== owner.sessionId ||
    (phase === "parked" ? retention.receipt !== null : !retention.receipt) ||
    retention.operation !== null ||
    !["running", "suspended"].includes(retention.desiredState) ||
    hasForcedWorkerEnvironmentAbandonment(environment)
  ) {
    refuse("the original retained environment is not the exact unadmitted owner");
  }
  const query = getNodeSqliteKysely<DB>(db);
  const transport = executeSqliteQueryTakeFirstSync(
    db,
    query
      .selectFrom("worker_environments")
      .select([
        "ssh_host",
        "ssh_port",
        "ssh_user",
        "ssh_host_key",
        "ssh_key_ref_json",
        "desktop_json",
        "bootstrap_bundle_hash",
        "bootstrap_openclaw_version",
        "bootstrap_protocol_features_json",
        "bootstrap_install_kind",
      ])
      .where("environment_id", "=", environment.environmentId),
  );
  if (!transport || Object.values(transport).some((value) => value !== null)) {
    refuse("transport or bootstrap facts remain on the unadmitted owner");
  }
  if (
    executeSqliteQueryTakeFirstSync(
      db,
      query
        .selectFrom("worker_environment_credentials")
        .select("environment_id")
        .where("environment_id", "=", environment.environmentId),
    ) ||
    hasWorkerEnvironmentSessionAttachment(db, environment.environmentId)
  ) {
    refuse("credentials or session attachments still own the environment");
  }
}

function assertQuiet(db: EngineConnection, environmentId: string, owner: Owner, nowMs: number) {
  const query = getNodeSqliteKysely<DB>(db);
  const placements = query
    .selectFrom("worker_session_placements")
    .select("session_id")
    .where((eb) =>
      eb.or([eb("environment_id", "=", environmentId), eb("session_id", "=", owner.sessionId)]),
    );
  if (
    executeSqliteQueryTakeFirstSync(
      db,
      placements.where((eb) =>
        eb.or([
          eb("session_id", "!=", owner.sessionId),
          eb("turn_claim_owner", "is not", null),
          eb("turn_claim_id", "is not", null),
          eb("turn_claim_run_id", "is not", null),
          eb("turn_claim_generation", "is not", null),
          eb("turn_claim_owner_epoch", "is not", null),
        ]),
      ),
    )
  ) {
    refuse("another placement or turn claim owns the environment");
  }
  if (
    tableExists(db, "worker_session_placement_moves") &&
    executeSqliteQueryTakeFirstSync(
      db,
      query
        .selectFrom("worker_session_placement_moves")
        .select("session_id")
        .where((eb) =>
          eb.or([
            eb("session_id", "=", owner.sessionId),
            eb("source_environment_id", "=", environmentId),
            eb("target_id", "=", environmentId),
          ]),
        ),
    )
  ) {
    refuse("a placement move is unsettled");
  }
  if (
    tableExists(db, "worker_workspace_pending_results") &&
    executeSqliteQueryTakeFirstSync(
      db,
      query
        .selectFrom("worker_workspace_pending_results")
        .select("session_id")
        .where((eb) =>
          eb.or([eb("session_id", "=", owner.sessionId), eb("environment_id", "=", environmentId)]),
        ),
    )
  ) {
    refuse("a workspace result is unsettled");
  }
  if (
    tableExists(db, "worker_workspace_reconciliations") &&
    executeSqliteQueryTakeFirstSync(
      db,
      query
        .selectFrom("worker_workspace_reconciliations")
        .select("session_id")
        .where((eb) =>
          eb.or([eb("session_id", "=", owner.sessionId), eb("environment_id", "=", environmentId)]),
        ),
    )
  ) {
    refuse("a workspace reconciliation owns the source");
  }
  if (
    tableExists(db, "worker_turn_tool_authorities") &&
    executeSqliteQueryTakeFirstSync(
      db,
      query
        .selectFrom("worker_turn_tool_authorities")
        .select("session_id")
        .where((eb) =>
          eb.or([eb("session_id", "=", owner.sessionId), eb("environment_id", "=", environmentId)]),
        ),
    )
  ) {
    refuse("worker tool authority remains live");
  }
  if (
    tableExists(db, "worker_session_tool_operations") &&
    executeSqliteQueryTakeFirstSync(
      db,
      query
        .selectFrom("worker_session_tool_operations")
        .select("source_session_id")
        .where("source_session_id", "=", owner.sessionId)
        .where("status", "in", ["running", "unknown"]),
    )
  ) {
    refuse("a session tool operation is unsettled");
  }
  if (
    tableExists(db, "worker_inference_turns") &&
    executeSqliteQueryTakeFirstSync(
      db,
      query
        .selectFrom("worker_inference_turns")
        .select("session_id")
        .where("state", "=", "pending")
        .where((eb) =>
          eb.or([eb("session_id", "=", owner.sessionId), eb("environment_id", "=", environmentId)]),
        ),
    )
  ) {
    refuse("worker inference is unsettled");
  }
  if (
    tableExists(db, "worker_transcript_commits") &&
    executeSqliteQueryTakeFirstSync(
      db,
      query
        .selectFrom("worker_transcript_commits")
        .select("session_id")
        .where("session_id", "=", owner.sessionId)
        .where("state", "=", "pending"),
    )
  ) {
    refuse("a transcript commit is unsettled");
  }
  if (
    executeSqliteQueryTakeFirstSync(
      db,
      query
        .selectFrom("state_leases")
        .select("owner")
        .where("lease_key", "=", owner.sessionId)
        .where("scope", "in", [
          "session-workspace-action",
          "session-workspace-personal-publication",
        ])
        .where("expires_at", ">", nowMs),
    )
  ) {
    refuse("a workspace reservation owns the source");
  }
}

function originalWorkspace(
  db: EngineConnection,
  owner: Owner,
  authority: RetainedWorkspaceAuthority,
) {
  const workspace = findSessionRepositoryWorkspaceInDatabase(db, owner);
  if (
    !workspace ||
    !isDeepStrictEqual(workspace.diskAuthority, authority) ||
    authority.sessionId !== owner.sessionId
  ) {
    refuse("the repository no longer owns the exact retained disk authority");
  }
  return workspace;
}

/** Offline caller owns the surrounding canonical state write transaction and final admission. */
export function parkRetainedWorkspaceOwnerInDatabase(
  db: EngineConnection,
  input: ParkRetainedWorkspaceOwnerInput,
  nowMs: number,
) {
  ParkRetainedWorkspaceOwnerInputSchema.parse(input);
  z.number().int().nonnegative().parse(nowMs);
  const owner = {
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
  };
  const workspace = originalWorkspace(db, owner, input.expectedDiskAuthority);
  if (
    workspace.workspaceId !== input.workspaceId ||
    workspace.revision !== input.workspaceRevision ||
    input.environmentId !== input.expectedDiskAuthority.environmentId ||
    input.leaseId !== input.expectedDiskAuthority.identity.leaseId
  ) {
    refuse("the selected source revision changed");
  }
  const environment = getRequiredWorkerEnvironment(db, input.environmentId);
  assertUnadmitted(db, environment, owner, input.expectedDiskAuthority);
  assertQuiet(db, input.environmentId, owner, nowMs);
  const placement = findPlacement(db, input.sessionId);
  if (
    !placement ||
    placement.agentId !== owner.agentId ||
    placement.sessionKey !== owner.sessionKey ||
    placement.recoveryError === FORCED_WORKER_ABANDONMENT_ERROR ||
    placement.confirmedLossRecovery
  ) {
    refuse("the selected placement identity or preservation disposition changed");
  }
  const held =
    environment.state === "orphaned" &&
    environment.lastError === marker(input.destroyRequestedAtMs) &&
    environment.destroyRequestedAtMs === null &&
    environment.teardownTerminalState === null &&
    placement.state === "local" &&
    placement.generation === input.placementGeneration + 1;
  if (!held) {
    if (
      environment.state !== input.environmentState ||
      environment.destroyRequestedAtMs !== input.destroyRequestedAtMs ||
      environment.teardownTerminalState !== "destroyed" ||
      placement.state !== "failed" ||
      placement.environmentId !== input.environmentId ||
      placement.activeOwnerEpoch !== null ||
      placement.generation !== input.placementGeneration
    ) {
      refuse("the preallocation teardown or failed placement changed");
    }
    updateWorkerEnvironmentRecord(db, input.environmentId, "destroying", {
      state: "orphaned",
      destroy_requested_at_ms: null,
      teardown_terminal_state: null,
      last_error: marker(input.destroyRequestedAtMs),
      state_changed_at_ms: nowMs,
      updated_at_ms: nowMs,
    });
    updateTransition(db, placement, "local", {}, nowMs);
  }
  return {
    changed: !held,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    environmentId: input.environmentId,
    leaseId: input.leaseId,
    ownerBinding: input.expectedDiskAuthority.ownerBinding,
    workspaceRevision: workspace.revision,
    placementGeneration: held ? placement.generation : placement.generation + 1,
    environmentState: "orphaned" as const,
    environmentOwnerEpoch: 0 as const,
    cleanupCanceled: true as const,
  };
}

/** Shared read-only preflight; only the dispatch owner may consume its verified result. */
function requireParkedRetainedWorkspaceOwner(
  db: EngineConnection,
  input: {
    environmentId: string;
    expectedOwnerEpoch: number;
    owner: Owner;
    expectedDiskAuthority: RetainedWorkspaceAuthority;
  },
  nowMs: number,
  placementStates: readonly string[],
): WorkerEnvironmentRecord {
  z.number().int().nonnegative().parse(nowMs);
  RetainedWorkspaceAuthority.parse(input.expectedDiskAuthority);
  originalWorkspace(db, input.owner, input.expectedDiskAuthority);
  const environment = getRequiredWorkerEnvironment(db, input.environmentId);
  assertUnadmitted(db, environment, input.owner, input.expectedDiskAuthority);
  assertQuiet(db, input.environmentId, input.owner, nowMs);
  const placement = findPlacement(db, input.owner.sessionId);
  if (
    input.expectedOwnerEpoch !== 0 ||
    environment.ownerEpoch !== input.expectedOwnerEpoch ||
    environment.state !== "orphaned" ||
    !isRetainedWorkspaceOwnerRepairHold(environment.lastError) ||
    environment.destroyRequestedAtMs !== null ||
    environment.teardownTerminalState !== null ||
    !placement ||
    placement.agentId !== input.owner.agentId ||
    placement.sessionKey !== input.owner.sessionKey ||
    !placementStates.includes(placement.state) ||
    (placement.environmentId !== null && placement.environmentId !== input.environmentId) ||
    placement.activeOwnerEpoch !== null ||
    placement.recoveryError === FORCED_WORKER_ABANDONMENT_ERROR ||
    placement.confirmedLossRecovery
  ) {
    refuse("the original parked owner is not awaiting this fresh dispatch");
  }
  return environment;
}

/** Classification never treats the original disk as gone or grants provider execution. */
export function canResumeRetainedWorkspaceOwnerInDatabase(
  db: EngineConnection,
  owner: WorkerSessionPlacementIdentity,
  expected: WorkerPlacementCancellationTarget,
  nowMs: number,
): boolean {
  const placement = findPlacement(db, owner.sessionId);
  if (
    placement?.state !== "failed" ||
    !matchesWorkerPlacementTarget(placement, expected) ||
    placement.agentId !== owner.agentId ||
    placement.sessionKey !== owner.sessionKey
  ) {
    return false;
  }
  const authority = findSessionRepositoryWorkspaceInDatabase(db, owner)?.diskAuthority;
  if (!authority || placement.environmentId !== authority.environmentId) {
    return false;
  }
  try {
    const environment = getRequiredWorkerEnvironment(db, authority.environmentId);
    if (environment.state === "provisioning") {
      assertUnadmitted(db, environment, owner, authority, "pending");
      assertQuiet(db, authority.environmentId, owner, nowMs);
      const retention = environment.retention!;
      const receipt = retention.receipt!;
      const authorized = Date.parse(receipt.computeWindow.authorizedAt);
      const expires = Date.parse(receipt.computeWindow.expiresAt);
      return (
        environment.destroyRequestedAtMs === null &&
        environment.teardownTerminalState === null &&
        placement.activeOwnerEpoch === null &&
        placement.recoveryError !== FORCED_WORKER_ABANDONMENT_ERROR &&
        !placement.confirmedLossRecovery &&
        placement.workspaceBaseManifestRef === null &&
        placement.remoteWorkspaceDir === null &&
        retention.desiredState === "running" &&
        receipt.policyVerified &&
        !receipt.stopPending &&
        receipt.ownerBinding === authority.ownerBinding &&
        isDeepStrictEqual(receipt.identity, authority.identity) &&
        receipt.computeWindowSeconds === retention.policy.computeWindowSeconds &&
        receipt.desiredState === "running" &&
        receipt.observedState.toLowerCase() === "running" &&
        (!receipt.operation || receipt.operation.phase === "observed") &&
        receipt.computeWindow.state === "active" &&
        Number.isFinite(authorized) &&
        authorized <= nowMs &&
        Number.isFinite(expires) &&
        expires > nowMs
      );
    }
    requireParkedRetainedWorkspaceOwner(
      db,
      {
        environmentId: authority.environmentId,
        expectedOwnerEpoch: 0,
        owner,
        expectedDiskAuthority: authority,
      },
      nowMs,
      ["failed"],
    );
    return true;
  } catch {
    return false;
  }
}

/** Only an authenticated dispatch may consume the parked owner; this does not admit execution. */
export function resumeParkedRetainedWorkspaceOwnerInDatabase(
  db: EngineConnection,
  input: {
    environmentId: string;
    expectedOwnerEpoch: number;
    owner: Owner;
    expectedDiskAuthority: RetainedWorkspaceAuthority;
  },
  nowMs: number,
): WorkerEnvironmentRecord {
  requireParkedRetainedWorkspaceOwner(db, input, nowMs, ["local", "requested", "provisioning"]);
  return updateWorkerEnvironmentRecord(db, input.environmentId, "orphaned", {
    state: "requested",
    lease_id: null,
    owner_epoch: nextGlobalOwnerEpoch(db, input.expectedDiskAuthority.ownerEpoch),
    last_error: null,
    state_changed_at_ms: nowMs,
    updated_at_ms: nowMs,
  });
}
