import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const fail = (code) => {
  throw new Error(`retained-bindings:${code}`);
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const same = (left, right, code) => {
  if (!isDeepStrictEqual(left, right)) {
    fail(code);
  }
};
const json = (raw) => {
  if (typeof raw !== "string") {
    fail("expected-raw-json-string");
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fail("invalid-json");
  }
};
const index = (rows, key) => {
  if (!Array.isArray(rows)) {
    fail("missing-source-rows");
  }
  const out = new Map();
  for (const row of rows) {
    if (!object(row) || typeof row[key] !== "string" || out.has(row[key])) {
      fail("duplicate-or-invalid-source-key");
    }
    out.set(row[key], row);
  }
  return out;
};

async function readRegular(file, missing = false, limit = 16 * 1024 * 1024) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) {
      fail("input-not-bounded-regular-file");
    }
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) {
        break;
      }
      length += bytesRead;
    }
    if (length > limit) {
      fail("input-too-large");
    }
    return buffer.subarray(0, length);
  } catch (error) {
    if (missing && error?.code === "ENOENT") {
      return null;
    }
    if (error?.message?.startsWith("retained-bindings:")) {
      throw error;
    }
    return fail("input-read-failed");
  } finally {
    await handle?.close();
  }
}

async function readPinned(spec) {
  if (!object(spec) || typeof spec.path !== "string" || !/^[a-f0-9]{64}$/.test(spec.sha256)) {
    fail("invalid-evidence-spec");
  }
  const raw = await readRegular(spec.path);
  if (sha(raw) !== spec.sha256) {
    fail("evidence-hash-changed");
  }
  return json(raw.toString("utf8"));
}

function fingerprintLabel(raw) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const digest = createHash("sha256").update(raw, "utf8").digest();
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) {
    out += alphabet[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Local, private evidence only. This function never contacts a provider or writes a claim. */
export async function loadRetainedEvidence(spec, expectedStore) {
  const identities = await readPinned(spec.identities);
  const storeId = expectedStore?.storeId;
  if (
    !storeId ||
    !expectedStore?.namespace ||
    identities.readOnly !== true ||
    identities.namespace !== expectedStore.namespace
  ) {
    fail("source-namespace-mismatch");
  }
  const metadata = identities.metadata?.filter((item) => item.store === "state");
  if (metadata?.length !== 1 || metadata[0].store_id !== storeId) {
    fail("source-store-mismatch");
  }
  if (identities.problems?.length || identities.claimsDirectoryStatus !== "directory") {
    fail("identity-capture-has-problems");
  }
  if (typeof spec.claimsRoot !== "string" || !path.isAbsolute(spec.claimsRoot)) {
    fail("invalid-claims-root");
  }
  let directory;
  try {
    directory = await open(
      path.join(spec.claimsRoot, "claims"),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if (!(await directory.stat()).isDirectory()) {
      fail("claims-directory-changed");
    }
  } catch {
    fail("claims-directory-changed");
  } finally {
    await directory?.close();
  }
  const requests = index(identities.requests, "leaseId");
  const claims = index(identities.claims, "leaseId");
  if (requests.size !== claims.size || [...requests.keys()].some((id) => !claims.has(id))) {
    fail("claim-capture-incomplete");
  }
  const checked = new Map();
  for (const [leaseId, record] of claims) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(leaseId)) {
      fail("unsafe-claim-filename");
    }
    if (record.code !== "missing" && record.code !== "captured-unverified") {
      fail("unsupported-claim-capture");
    }
    const raw = await readRegular(
      path.join(spec.claimsRoot, "claims", `${leaseId}.json`),
      record.code === "missing",
      1024 * 1024,
    );
    if (record.code === "missing") {
      if (raw !== null) {
        fail("expected-missing-claim-appeared");
      }
      checked.set(leaseId, { kind: "missing" });
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(record.fileSha256) || sha(raw) !== record.fileSha256) {
      fail("claim-file-changed");
    }
    const claim = json(raw.toString("utf8"));
    if (
      claim.leaseID !== leaseId ||
      claim.provider !== "azure-sandbox" ||
      typeof claim.providerScope !== "string" ||
      !/^azure-sandbox:[^:]+:[^:]+:[^:]+:[^:]+$/.test(claim.providerScope) ||
      claim.providerScope !== claim.fixedCreateIntent?.providerScope ||
      claim.slug !== claim.fixedCreateIntent?.slug
    ) {
      fail("claim-owner-mismatch");
    }
    const intent = claim.fixedCreateIntent;
    if (
      intent.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(intent.fingerprint) ||
      !["acquired", "released"].includes(intent.state) ||
      intent.journal?.version !== 2 ||
      !object(intent.retention) ||
      !object(intent.journal.retention)
    ) {
      fail("unsupported-claim-dialect");
    }
    const labels = claim.labels;
    if (
      !object(labels) ||
      labels.crabbox_lease !== leaseId ||
      labels.crabbox_fingerprint !== fingerprintLabel(intent.fingerprint) ||
      typeof labels.crabbox_attempt !== "string" ||
      !labels.crabbox_attempt
    ) {
      fail("claim-label-mismatch");
    }
    if (
      intent.state === "acquired" &&
      (intent.attempt?.nonce !== labels.crabbox_attempt ||
        ["deleting", "released"].includes(intent.journal.phase))
    ) {
      fail("claim-attempt-mismatch");
    }
    if (intent.state === "released" && intent.journal.phase !== "released") {
      fail("terminal-claim-journal-mismatch");
    }
    checked.set(leaseId, { kind: intent.state, claim, fileSha256: record.fileSha256 });
  }
  const observations = new Map();
  for (const observationSpec of spec.observations ?? []) {
    const document = await readPinned(observationSpec);
    if (document.readOnly !== true) {
      fail("observation-not-read-only");
    }
    for (const observed of document.observations ?? [document]) {
      if (
        !object(observed) ||
        observed.exitCode !== 0 ||
        !object(observed.resource) ||
        typeof observed.leaseId !== "string" ||
        !checked.has(observed.leaseId)
      ) {
        fail("provider-observation-failed");
      }
      const captured = checked.get(observed.leaseId);
      if (
        captured.kind === "missing"
          ? observed.claimSha256 !== undefined
          : observed.claimSha256 !== captured.fileSha256
      ) {
        fail("observation-claim-mismatch");
      }
      if (observations.has(observed.leaseId)) {
        fail("duplicate-provider-observation");
      }
      observations.set(observed.leaseId, observed);
    }
  }
  return { namespace: expectedStore.namespace, storeId, identities, claims: checked, observations };
}

function tuple(value) {
  if (!object(value)) {
    fail("missing-old-identity");
  }
  const out = {};
  for (const field of ["leaseId", "attemptLeaseId", "slug", "resourceId"]) {
    if (typeof value[field] !== "string" || !value[field]) {
      fail("incomplete-old-identity");
    }
    out[field] = value[field];
  }
  if (out.attemptLeaseId !== out.leaseId) {
    fail("old-attempt-lease-mismatch");
  }
  return out;
}

function checkWindow(receipt, policy) {
  if (
    !object(receipt) ||
    receipt.schema !== "crabbox.session-disk.v1" ||
    receipt.mode !== "session-disk" ||
    receipt.ownerBinding !== policy.ownerBinding ||
    receipt.computeWindowSeconds !== policy.computeWindowSeconds
  ) {
    fail("old-receipt-policy-mismatch");
  }
  const window = receipt.computeWindow;
  if (
    !object(window) ||
    typeof window.id !== "string" ||
    !window.id ||
    !["active", "closed"].includes(window.state) ||
    !Number.isSafeInteger(Date.parse(window.authorizedAt)) ||
    Date.parse(window.authorizedAt) <= 0 ||
    Date.parse(window.expiresAt) - Date.parse(window.authorizedAt) !==
      policy.computeWindowSeconds * 1000 ||
    !["running", "suspended", "retired"].includes(receipt.desiredState) ||
    (receipt.desiredState !== "running" && window.state !== "closed")
  ) {
    fail("old-retained-window-invalid");
  }
}

/** Pure projection of one sealed source snapshot; all non-JSON owner fields remain untouched. */
export function prepareRetainedProjection(rows, evidence, validators) {
  const canonical = (name, value) => {
    if (typeof validators?.[name] !== "function") {
      fail("canonical-validator-unavailable");
    }
    try {
      return validators[name](value);
    } catch {
      return fail(`canonical-${name}-rejected`);
    }
  };
  const environments = index(rows.worker_environments ?? [], "environment_id");
  const workspaces = index(rows.session_repository_workspaces ?? [], "workspace_id");
  const placements = index(rows.worker_session_placements ?? [], "session_id");
  const pending = rows.worker_workspace_pending_results ?? [];
  if (pending.some((row) => row.disk_authority_json != null)) {
    fail("pending-disk-result-unsupported");
  }
  if (!evidence) {
    if (
      [...environments.values()].some((row) => row.session_retention_json != null) ||
      [...workspaces.values()].some((row) => row.disk_authority_json != null)
    ) {
      fail("retained-evidence-required");
    }
    return { environments: new Map(), workspaces: new Map(), originals: [] };
  }
  const selectedEnvironments = index(evidence.identities.environments, "environment_id");
  const selectedWorkspaces = index(evidence.identities.workspaces, "workspace_id");
  const selectedPlacements = index(evidence.identities.placements ?? [], "session_id");
  for (const [id, selected] of selectedPlacements) {
    const row = placements.get(id);
    if (!row) {
      fail("placement-selection-changed");
    }
    for (const field of [
      "agent_id",
      "session_key",
      "state",
      "environment_id",
      "remote_workspace_dir",
      "worker_bundle_hash",
      "workspace_base_manifest_ref",
    ]) {
      if (row[field] !== selected[field]) {
        fail("placement-selection-changed");
      }
    }
    if (
      String(row.transition_generation) !== String(selected.transition_generation) ||
      String(row.active_owner_epoch) !== String(selected.active_owner_epoch) ||
      (row.turn_claim_owner !== null) !== selected.has_turn_claim
    ) {
      fail("placement-selection-changed");
    }
  }
  const envResult = new Map(),
    workspaceResult = new Map(),
    originals = [];
  const authorityByEnv = new Map(),
    resourceByLease = new Map();
  const archive = (table, key, sourceColumn, targetColumn, oldRawJson, newRawJson) => {
    originals.push({
      table,
      key,
      sourceColumn,
      targetColumn,
      oldRawJson,
      newRawJson,
      oldSha256: oldRawJson === null ? null : sha(oldRawJson),
      newSha256: sha(newRawJson),
    });
  };
  const rawDisk = new Map();
  for (const [id, row] of workspaces) {
    if (row.disk_authority_json === null) {
      continue;
    }
    const disk = json(row.disk_authority_json);
    const selected = selectedWorkspaces.get(id);
    if (
      !selected ||
      selected.agent_id !== row.agent_id ||
      selected.session_key !== row.session_key
    ) {
      fail("workspace-selection-changed");
    }
    same(disk, selected.authority, "workspace-authority-changed");
    tuple(disk.identity);
    if (
      typeof disk.environmentId !== "string" ||
      typeof disk.sessionId !== "string" ||
      typeof disk.workspaceDir !== "string" ||
      !disk.workspaceDir ||
      !Number.isSafeInteger(disk.ownerEpoch) ||
      disk.ownerEpoch < 1 ||
      typeof disk.ownerBinding !== "string"
    ) {
      fail("old-disk-authority-invalid");
    }
    rawDisk.set(id, disk);
    const previous = authorityByEnv.get(disk.environmentId);
    if (previous && !isDeepStrictEqual(previous.identity, disk.identity)) {
      fail("environment-has-conflicting-disk-identities");
    }
    authorityByEnv.set(disk.environmentId, disk);
  }
  if (rawDisk.size !== selectedWorkspaces.size) {
    fail("workspace-evidence-cohort-changed");
  }
  const resourceFor = (oldIdentity) => {
    const identity = tuple(oldIdentity);
    const previous = resourceByLease.get(identity.leaseId);
    if (previous) {
      same(previous.oldIdentity, identity, "lease-identity-conflict");
      return previous;
    }
    const captured = evidence.claims.get(identity.leaseId);
    if (!captured) {
      fail("required-claim-not-captured");
    }
    const observed = evidence.observations.get(identity.leaseId);
    let resource;
    if (captured.kind === "released") {
      const { claim } = captured;
      if (claim.cloudID !== identity.resourceId || claim.slug !== identity.slug) {
        fail("terminal-identity-mismatch");
      }
      resource = { id: claim.cloudID, labels: claim.labels };
    } else {
      if (
        !observed ||
        observed.requestedCloudId !== identity.resourceId ||
        observed.resource.id !== identity.resourceId
      ) {
        fail("actual-resource-observation-missing");
      }
      resource = observed.resource;
      if (
        captured.kind === "acquired" &&
        (captured.claim.cloudID !== identity.resourceId || captured.claim.slug !== identity.slug)
      ) {
        fail("acquired-identity-mismatch");
      }
    }
    const labels = resource.labels;
    if (
      !object(labels) ||
      labels.crabbox_lease !== identity.leaseId ||
      typeof labels.crabbox_attempt !== "string" ||
      !labels.crabbox_attempt ||
      typeof labels.crabbox_fingerprint !== "string" ||
      !labels.crabbox_fingerprint
    ) {
      fail("actual-resource-labels-missing");
    }
    if (captured.kind !== "missing") {
      same(
        labels.crabbox_attempt,
        captured.claim.labels.crabbox_attempt,
        "actual-attempt-mismatch",
      );
      same(
        labels.crabbox_fingerprint,
        fingerprintLabel(captured.claim.fixedCreateIntent.fingerprint),
        "actual-fingerprint-mismatch",
      );
    }
    const receipt = canonical("requireWorkerResourceReceipt", {
      version: 1,
      leaseId: identity.leaseId,
      identity: {
        provider: "azure-sandbox",
        resourceId: identity.resourceId,
        slug: identity.slug,
        attempt: labels.crabbox_attempt,
        fingerprint: labels.crabbox_fingerprint,
      },
    });
    const result = { oldIdentity: identity, receipt, captured };
    resourceByLease.set(identity.leaseId, result);
    return result;
  };
  for (const [id, row] of environments) {
    if (row.session_retention_json === null) {
      continue;
    }
    const old = json(row.session_retention_json),
      selected = selectedEnvironments.get(id);
    if (!selected) {
      fail("environment-selection-changed");
    }
    same(old, selected.retention, "retention-selection-changed");
    for (const field of [
      "provider_id",
      "profile_id",
      "state",
      "lease_id",
      "node_device_id",
      "destroy_requested_at_ms",
      "teardown_terminal_state",
      "bootstrap_bundle_hash",
      "bootstrap_openclaw_version",
    ]) {
      if (row[field] !== selected[field]) {
        fail("environment-owner-changed");
      }
    }
    if (
      String(row.owner_epoch) !== String(selected.owner_epoch) ||
      String(row.shared_host) !== String(selected.shared_host)
    ) {
      fail("environment-epoch-changed");
    }
    same(
      json(row.attached_session_ids_json),
      selected.attached_session_ids,
      "environment-attachments-changed",
    );
    if (
      !object(old.policy) ||
      old.policy.mode !== "session-disk" ||
      !object(old.owner) ||
      !["running", "suspended"].includes(old.desiredState) ||
      old.operation !== null
    ) {
      fail("unsupported-local-retention-intent");
    }
    const policy = {
      version: 1,
      ownerBinding: old.ownerBinding,
      computeWindowSeconds: old.policy.computeWindowSeconds,
    };
    const disk = authorityByEnv.get(id);
    if (
      disk &&
      (disk.ownerBinding !== old.ownerBinding || disk.sessionId !== old.owner.sessionId)
    ) {
      fail("old-disk-retention-owner-mismatch");
    }
    const identity = old.receipt ? tuple(old.receipt.identity) : disk?.identity;
    if (!identity) {
      fail("retention-has-no-recorded-resource-identity");
    }
    if (row.lease_id !== null && row.lease_id !== identity.leaseId) {
      fail("environment-lease-changed");
    }
    if (old.receipt) {
      checkWindow(old.receipt, policy);
    }
    if (old.receipt?.operation?.phase === "pending") {
      fail("pending-provider-retention-operation");
    }
    const { receipt, captured } = resourceFor(identity);
    if (captured.kind !== "missing") {
      const intent = captured.claim.fixedCreateIntent;
      same(
        intent.retention,
        {
          mode: "session-disk",
          ownerBinding: policy.ownerBinding,
          computeWindowSeconds: policy.computeWindowSeconds,
        },
        "claim-retention-policy-mismatch",
      );
      const provider = intent.journal.retention;
      if (provider.operation?.phase === "pending") {
        fail("pending-provider-retention-operation");
      }
      checkWindow({ ...intent.retention, ...provider, schema: "crabbox.session-disk.v1" }, policy);
    }
    const retention = canonical("requireWorkerEnvironmentRetention", {
      policy,
      runtimeReady: false,
      operation: null,
      observation: null,
    });
    const placement = placements.get(old.owner.sessionId);
    const sourceWorkspace = [...workspaces.values()].find(
      (item) => item.agent_id === old.owner.agentId && item.session_key === old.owner.sessionKey,
    );
    const hasUnsettledWork =
      placement?.turn_claim_owner != null ||
      pending.some((item) => item.session_id === old.owner.sessionId) ||
      (rows.worker_session_placement_moves ?? []).some(
        (item) => item.session_id === old.owner.sessionId,
      ) ||
      (rows.worker_session_tool_operations ?? []).some(
        (item) => item.source_session_id === old.owner.sessionId && item.status === "running",
      );
    const exactOwner =
      row.state === "attached" &&
      row.destroy_requested_at_ms === null &&
      row.teardown_terminal_state === null &&
      row.node_device_id !== null &&
      Number(row.shared_host) === 0 &&
      row.preparation_key === null &&
      json(row.attached_session_ids_json).length === 1 &&
      selected.attached_session_ids[0] === old.owner.sessionId &&
      !hasUnsettledWork &&
      placement?.state === "active" &&
      placement.agent_id === old.owner.agentId &&
      placement.session_key === old.owner.sessionKey &&
      placement.environment_id === id &&
      Number(placement.active_owner_epoch) === Number(row.owner_epoch) &&
      placement.remote_workspace_dir === disk?.workspaceDir &&
      Number(row.owner_epoch) === disk?.ownerEpoch &&
      placement.worker_bundle_hash === row.bootstrap_bundle_hash &&
      disk?.sessionId === placement.session_id &&
      sourceWorkspace &&
      rawDisk.get(sourceWorkspace.workspace_id) === disk &&
      captured.kind === "acquired";
    const disposition =
      captured.kind === "missing"
        ? "held-missing-journal"
        : captured.kind === "released"
          ? "held-released-resource"
          : exactOwner
            ? "live-owner-runtime-closed"
            : "held-existing-owner-state";
    const resourceReceiptJson = JSON.stringify(receipt),
      retentionJson = JSON.stringify(retention);
    envResult.set(id, { resourceReceiptJson, retentionJson, disposition });
    archive(
      "worker_environments",
      id,
      "session_retention_json",
      "retention_json",
      row.session_retention_json,
      retentionJson,
    );
    archive("worker_environments", id, null, "resource_receipt_json", null, resourceReceiptJson);
  }
  if (envResult.size !== selectedEnvironments.size) {
    fail("environment-evidence-cohort-changed");
  }
  for (const [id, disk] of rawDisk) {
    const { receipt, captured } = resourceFor(disk.identity);
    const authority = canonical("requireRepositoryWorkspaceDiskAuthority", {
      environmentId: disk.environmentId,
      resourceReceipt: receipt,
    });
    const owner = envResult.get(disk.environmentId);
    const disposition = !owner
      ? "held-absent-environment"
      : captured.kind === "missing"
        ? "held-missing-journal"
        : owner.disposition;
    const diskAuthorityJson = JSON.stringify(authority);
    workspaceResult.set(id, { diskAuthorityJson, disposition });
    archive(
      "session_repository_workspaces",
      id,
      "disk_authority_json",
      "disk_authority_json",
      workspaces.get(id).disk_authority_json,
      diskAuthorityJson,
    );
  }
  return { environments: envResult, workspaces: workspaceResult, originals };
}
