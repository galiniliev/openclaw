// Task-owned scratch extension for the real, disposable-PG17 G119 migration rehearsal.
// Import and call rehearseRetainedBindings({fixture,client,snapshot,run,directory,
//   artifact,runtimeRoot,cases,sha,quote}) from the canonical rehearsal harness.
// This helper creates synthetic rows in its own new namespaces only. No provider calls/builds.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const now = 1794700800000;
const bundle = "c".repeat(64);
const manifest = `sha256:${"b".repeat(64)}`;
const fingerprints = [
  "GE4LXG6HRXZHYRZ6Z7IUCD332RPLVQPVTTZ77HH6JW3XVK325XJQ",
  "J4XI2ZKIHRSBMSGNWN2K5HMKXU3I2JU6JXP74CJKQI33QFRM3XLA",
  "PG6X276WQSZZTBL4LAVRW4LS3XZHPVH6DMBH5RJLFDNDVY4B4Z2Q",
  "6Q27EQQLKDDQ5SAIMXHY4IFRNGDUCZP3QV3LJBRTZLZKQF3NFZFA",
  "SEMHRMP7SSTNV3FLUHL66362BOLRC2QWFEJYSQT3IAVACORK46PQ",
  "44V32TKCTLERJKFGYW6USYZP62YA2T7PIKX3IQ7QXACH34DMQXJA",
  "YC3DAS6WZ2NT4ZIVAOJMSGR2U5UAHJM4FHSG7H5SXGVMENPFQODA",
];
const cohortNames = [
  "linked",
  "failed-placement",
  "released-absent",
  "orphan",
  "missing-journal",
  "destroyed-no-workspace",
  "failed-unleased",
];
const sortRecords = (rows) =>
  rows.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

export async function rehearseRetainedBindings(ctx) {
  const { fixture, client, snapshot, run, artifact, runtimeRoot, cases, sha, quote } = ctx;
  const scenario = await fixture("retained-bindings-terminal", true);
  const store = scenario.input.stores.find((item) => item.family === "state");
  const ns = quote(store.namespace);
  const { bindNativeValidators } = await import(
    pathToFileURL(path.join(artifact, "validators.mjs")).href
  );
  const { isRecord } = await import(
    pathToFileURL(path.join(runtimeRoot, "dist/plugin-sdk/string-coerce-runtime.js")).href
  );
  const validators = bindNativeValidators({
    z: createRequire(path.join(runtimeRoot, "package.json"))("zod").z,
    isRecord,
  });
  const { loadRetainedEvidence, prepareRetainedProjection } = await import(
    pathToFileURL(path.join(artifact, "bindings.mjs")).href
  );
  const artifactManifest = JSON.parse(fs.readFileSync(path.join(artifact, "manifest.json")));
  const runtimeBuild = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "dist/build-info.json")));
  assert.equal(
    artifactManifest.pins.runtime,
    runtimeBuild.commit,
    "Rehearsal targets exact immutable runtime",
  );

  const cohorts = cohortNames.map((name, offset) => {
    const n = offset + 1;
    const terminal = name === "destroyed-no-workspace" || name === "failed-unleased";
    const released = terminal || name === "released-absent";
    const hasWorkspace = !terminal;
    const hasPlacement = hasWorkspace && name !== "orphan";
    const sessionId = `019a848b-7c00-7000-8000-00000000010${n}`;
    const environmentId = `fixture-retained-${name}`;
    const leaseId = `fixture-retained-lease-${n}`;
    const identity = {
      leaseId,
      attemptLeaseId: leaseId,
      slug: `fixture-retained-slug-${n}`,
      resourceId: `/subscriptions/fixture/resourceGroups/fixture/providers/Microsoft.Compute/virtualMachines/retained-${n}`,
    };
    const epoch = name === "orphan" ? 0 : n + 6;
    const oldEpoch = name === "orphan" ? 12 : epoch;
    const ownerBinding = (n + 4).toString(16).repeat(64);
    const sessionKey = `agent:main:dashboard:retained-${name}`;
    const workspaceId = `55555555-5555-4555-8555-55555555510${n}`;
    const workspaceDir = `/home/fixture/retained-${n}`;
    const oldReceipt = {
      schema: "crabbox.session-disk.v1",
      mode: "session-disk",
      ownerBinding,
      identity,
      claimRevision: `fixture-revision-${n}`,
      computeWindowSeconds: 14400,
      desiredState: released ? "retired" : "suspended",
      computeWindow: {
        id: `fixture-window-${n}`,
        authorizedAt: "2026-11-15T00:00:00.000Z",
        expiresAt: "2026-11-15T04:00:00.000Z",
        state: "closed",
      },
      policyVerified: true,
      observedState: "Stopped",
      stopPending: false,
    };
    const oldRetention = {
      policy: { mode: "session-disk", computeWindowSeconds: 14400 },
      owner: { sessionId, sessionKey, agentId: "main" },
      ownerBinding,
      desiredState: "suspended",
      receipt: name === "orphan" ? null : oldReceipt,
      operation: null,
    };
    const oldAuthority = {
      environmentId,
      sessionId,
      ownerEpoch: oldEpoch,
      ownerBinding,
      identity,
      workspaceDir,
    };
    const labels = {
      crabbox_lease: leaseId,
      crabbox_attempt: `fixture-attempt-${n}`,
      crabbox_fingerprint: fingerprints[offset],
    };
    const expectedReceipt = {
      version: 1,
      leaseId,
      identity: {
        provider: "azure-sandbox",
        resourceId: identity.resourceId,
        slug: identity.slug,
        attempt: labels.crabbox_attempt,
        fingerprint: fingerprints[offset],
      },
    };
    const expectedRetention = {
      policy: { version: 1, ownerBinding, computeWindowSeconds: 14400 },
      runtimeReady: false,
      operation: null,
      observation: null,
    };
    const expectedAuthority = { environmentId, resourceReceipt: expectedReceipt };
    const expectedDisposition =
      name === "linked"
        ? "live-owner-runtime-closed"
        : name === "missing-journal"
          ? "held-missing-journal"
          : name === "released-absent"
            ? "held-absent-environment"
            : terminal
              ? "held-released-resource"
              : "held-existing-owner-state";
    const claim = {
      leaseID: leaseId,
      provider: "azure-sandbox",
      providerScope: "azure-sandbox:sub:resourcegroup:group:region",
      cloudID: identity.resourceId,
      slug: identity.slug,
      labels,
      fixedCreateIntent: {
        version: 1,
        fingerprint: String(n).repeat(64),
        state: released ? "released" : "acquired",
        providerScope: "azure-sandbox:sub:resourcegroup:group:region",
        slug: identity.slug,
        attempt: { nonce: labels.crabbox_attempt },
        retention: { mode: "session-disk", ownerBinding, computeWindowSeconds: 14400 },
        journal: { version: 2, phase: released ? "released" : "acquired", retention: oldReceipt },
      },
    };
    if (released) {
      delete claim.fixedCreateIntent.attempt;
    }
    return {
      name,
      n,
      terminal,
      released,
      hasWorkspace,
      hasPlacement,
      sessionId,
      sessionKey,
      environmentId,
      leaseId,
      epoch,
      workspaceId,
      workspaceDir,
      identity,
      labels,
      oldReceipt,
      oldRetention,
      oldAuthority,
      claim,
      expectedReceipt,
      expectedRetention,
      expectedAuthority,
      expectedDisposition,
    };
  });

  for (const c of cohorts) {
    if (c.name !== "released-absent") {
      await client.query(
        `INSERT INTO ${ns}.worker_environments
        (environment_id,provider_id,profile_id,profile_snapshot_json,provision_operation_id,
         lease_id,node_setup_id,node_device_id,state,bootstrap_bundle_hash,bootstrap_openclaw_version,
         bootstrap_protocol_features_json,bootstrap_install_kind,owner_epoch,attached_session_ids_json,
         created_at_ms,updated_at_ms,state_changed_at_ms,shared_host,session_retention_json,last_error)
        VALUES($1,'crabbox','fixture-azure',$2,$3,$4,$5,$6,$7,$8,'2026.11.3','[]','bundle',$9,$10,$11,$11,$11,0,$12,$13)`,
        [
          c.environmentId,
          '{ "install": "bundle", "settings": {"provider":"azure","class":"small","ttl":"4h","idleTimeout":"15m","warmImage":false} }',
          `provision:v2:${sha(`retained-operation-${c.n}`)}`,
          c.name === "failed-unleased" ? null : c.leaseId,
          c.name === "orphan" || c.terminal ? null : `fixture-retained-setup-${c.n}`,
          c.name === "orphan" || c.terminal ? null : `fixture-retained-device-${c.n}`,
          c.name === "orphan"
            ? "orphaned"
            : c.name === "destroyed-no-workspace"
              ? "destroyed"
              : c.name === "failed-unleased"
                ? "failed"
                : "attached",
          bundle,
          c.epoch,
          JSON.stringify(c.name === "orphan" || c.terminal ? [] : [c.sessionId]),
          now,
          // Intentional whitespace proves archive and other JSON preserve original raw bytes.
          JSON.stringify(c.oldRetention, null, 2),
          c.name === "orphan" ? "fixture orphan diagnostic to preserve" : null,
        ],
      );
    }
    if (c.hasPlacement) {
      const failed = c.name === "failed-placement";
      await client.query(
        `INSERT INTO ${ns}.worker_session_placements
        (session_id,agent_id,session_key,execution_mode,state,environment_id,transition_generation,
         active_owner_epoch,workspace_base_manifest_ref,repository_preparation,confirmed_loss_recovery_json,
         remote_workspace_dir,worker_bundle_hash,last_transcript_ack_cursor,last_live_event_ack_cursor,
         recovery_error,created_at_ms,updated_at_ms,state_changed_at_ms)
        VALUES($1,'main',$2,'worker-turn',$3,$4,4,$5,$6,NULL,$7,$8,$9,$10,$11,$12,$13,$13,$13)`,
        [
          c.sessionId,
          c.sessionKey,
          failed ? "failed" : "active",
          c.environmentId,
          failed ? null : c.epoch,
          failed ? null : manifest,
          JSON.stringify({
            version: 1,
            predecessor: {
              agentId: "main",
              sessionKey: c.sessionKey,
              sessionId: c.sessionId,
              environmentId: `fixture-original-${c.n}`,
              ownerEpoch: 2,
            },
            predecessorGeneration: 3,
            replacementDispatchGeneration: 4,
          }),
          failed ? null : c.workspaceDir,
          failed ? null : bundle,
          failed ? null : 12,
          failed ? null : 19,
          failed ? "fixture failed placement: original disk retained" : null,
          now,
        ],
      );
    }
    if (!c.hasWorkspace) {
      continue;
    }
    await client.query(
      `INSERT INTO ${ns}.session_repository_workspaces
      (workspace_id,agent_id,session_key,url,requested_ref,run_setup_script,base_commit,
       base_manifest_hash,branch,checkpoint_ref,manifest_hash,recovery_json,disk_authority_json,
       revision,created_at_ms,updated_at_ms)
      VALUES($1,'main',$2,$3,$4,0,$5,$6,$7,$8,$6,$9,$10,3,$11,$11)`,
      [
        c.workspaceId,
        c.sessionKey,
        `https://github.com/fixture/retained-${c.n}.git`,
        `refs/heads/clawson/fixture-${c.n}`,
        "d".repeat(40),
        manifest,
        `clawson/fixture-${c.n}`,
        `refs/openclaw/worker-results/fixture-current-${c.n}`,
        JSON.stringify(
          {
            reason: "missing-worker",
            atMs: now,
            original: {
              revision: 2,
              baseCommit: "a".repeat(40),
              baseManifestHash: manifest,
              checkpointRef: `refs/openclaw/worker-results/fixture-prior-${c.n}`,
              manifestHash: manifest,
            },
            sourceCommit: "d".repeat(40),
            source: "published-branch",
            unrecoverablePrivateContent: true,
          },
          null,
          2,
        ),
        JSON.stringify(c.oldAuthority, null, 2),
        now,
      ],
    );
  }

  const readRows = async () => {
    const rows = {};
    for (const table of [
      "worker_environments",
      "session_repository_workspaces",
      "worker_session_placements",
      "worker_workspace_pending_results",
      "worker_session_placement_moves",
      "worker_session_tool_operations",
    ]) {
      rows[table] = (await client.query(`SELECT * FROM ${ns}.${quote(table)} ORDER BY 1`)).rows;
    }
    return rows;
  };
  const originalRows = await readRows();
  const identities = {
    readOnly: true,
    namespace: store.namespace,
    metadata: [{ store: "state", version: 37, store_id: store.storeId }],
    problems: [],
    claimsDirectoryStatus: "directory",
    environments: originalRows.worker_environments
      .filter((row) => row.session_retention_json !== null)
      .map((row) =>
        Object.assign(
          Object.fromEntries(
            [
              "environment_id",
              "provider_id",
              "profile_id",
              "state",
              "lease_id",
              "node_device_id",
              "destroy_requested_at_ms",
              "teardown_terminal_state",
              "bootstrap_bundle_hash",
              "bootstrap_openclaw_version",
              "owner_epoch",
              "shared_host",
            ].map((key) => [key, row[key]]),
          ),
          {
            attached_session_ids: JSON.parse(row.attached_session_ids_json),
            retention: JSON.parse(row.session_retention_json),
          },
        ),
      ),
    workspaces: originalRows.session_repository_workspaces
      .filter((row) => row.disk_authority_json !== null)
      .map((row) => ({
        workspace_id: row.workspace_id,
        agent_id: row.agent_id,
        session_key: row.session_key,
        authority: JSON.parse(row.disk_authority_json),
      })),
    placements: originalRows.worker_session_placements
      .filter((row) => cohorts.some((c) => c.sessionId === row.session_id))
      .map((row) =>
        Object.assign(
          Object.fromEntries(
            [
              "session_id",
              "agent_id",
              "session_key",
              "state",
              "environment_id",
              "remote_workspace_dir",
              "worker_bundle_hash",
              "workspace_base_manifest_ref",
              "transition_generation",
              "active_owner_epoch",
            ].map((key) => [key, row[key]]),
          ),
          { has_turn_claim: row.turn_claim_owner !== null },
        ),
      ),
    requests: cohorts.map((c) => ({ leaseId: c.leaseId })),
    claims: [],
  };
  const claimsRoot = path.join(scenario.root, "synthetic-claims");
  fs.mkdirSync(path.join(claimsRoot, "claims"), { recursive: true, mode: 0o700 });
  const observationDoc = { readOnly: true, observations: [] };
  for (const c of cohorts) {
    if (c.name === "missing-journal") {
      identities.claims.push({ leaseId: c.leaseId, code: "missing" });
    } else {
      c.claimPath = path.join(claimsRoot, "claims", `${c.leaseId}.json`);
      c.claimBytes = Buffer.from(`${JSON.stringify(c.claim, null, 2)}\n`);
      fs.writeFileSync(c.claimPath, c.claimBytes, { mode: 0o600 });
      identities.claims.push({
        leaseId: c.leaseId,
        code: "captured-unverified",
        fileSha256: sha(c.claimBytes),
      });
    }
    if (!c.released) {
      observationDoc.observations.push({
        leaseId: c.leaseId,
        exitCode: 0,
        ...(c.claimBytes ? { claimSha256: sha(c.claimBytes) } : {}),
        requestedCloudId: c.identity.resourceId,
        resource: { id: c.identity.resourceId, labels: c.labels },
      });
    }
  }
  const pin = (filename, document) => {
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
    const pathname = path.join(scenario.root, filename);
    fs.writeFileSync(pathname, bytes, { mode: 0o600 });
    return { path: pathname, sha256: sha(bytes) };
  };
  const pinEvidence = () => {
    scenario.input.retainedEvidence = {
      identities: pin("identities.synthetic.private.json", identities),
      observations: [pin("observations.synthetic.private.json", observationDoc)],
      claimsRoot,
    };
  };
  const refreshBackup = async () => {
    scenario.before = await snapshot(scenario.input.stores);
    const bytes = Buffer.from(JSON.stringify(scenario.before));
    fs.writeFileSync(scenario.input.backupManifest.path, bytes);
    scenario.input.backupManifest.sha256 = sha(bytes);
  };
  pinEvidence();
  await refreshBackup();
  const anchorHashes = () =>
    scenario.input.stores.map((item) => sha(fs.readFileSync(item.anchorPath)));
  const anchors = anchorHashes();
  const assertRun = (label, mode, expected) => {
    const result = run(scenario, label, mode);
    assert.equal(
      result.status,
      expected,
      `${label}: ${fs.readFileSync(path.join(scenario.root, `${label}.log`), "utf8")}`,
    );
    return result;
  };
  const refuse = async (label, error) => {
    const before = await snapshot(scenario.input.stores);
    const result = assertRun(label, "--apply", 1);
    assert.match(
      JSON.parse(fs.readFileSync(path.join(result.output, "failure.json"))).error,
      error,
    );
    assert.deepEqual(
      await snapshot(scenario.input.stores),
      before,
      `${label} changed a store before refusal`,
    );
    assert.deepEqual(anchorHashes(), anchors, `${label} changed anchors`);
  };

  // Refusals exercise the actual command before any migration can commit.
  const linked = cohorts[0];
  fs.appendFileSync(linked.claimPath, "\n");
  await refuse("changed-claim", /claim-file-changed/);
  fs.writeFileSync(linked.claimPath, linked.claimBytes);

  const firstObservation = observationDoc.observations.shift();
  pinEvidence();
  await refuse("missing-observation", /actual-resource-observation-missing/);
  observationDoc.observations.unshift(firstObservation);
  pinEvidence();

  firstObservation.resource.labels = { ...linked.labels, crabbox_attempt: "fixture-wrong-attempt" };
  pinEvidence();
  await refuse("changed-observation", /actual-attempt-mismatch/);
  firstObservation.resource.labels = linked.labels;
  pinEvidence();

  const selectedWorkspace = identities.workspaces.shift();
  pinEvidence();
  await refuse("missing-workspace-evidence", /workspace-selection-changed/);
  identities.workspaces.unshift(selectedWorkspace);
  const selectedEnvironment = identities.environments.shift();
  pinEvidence();
  await refuse("missing-environment-evidence", /environment-selection-changed/);
  identities.environments.unshift(selectedEnvironment);
  pinEvidence();

  const evidenceSpec = scenario.input.retainedEvidence;
  delete scenario.input.retainedEvidence;
  await refuse("missing-retained-evidence", /retained-evidence-required/);
  scenario.input.retainedEvidence = evidenceSpec;

  const linkedSource = originalRows.worker_environments.find(
    (row) => row.environment_id === linked.environmentId,
  );
  const linkedEvidence = identities.environments.find(
    (row) => row.environment_id === linked.environmentId,
  );
  const pendingRetention = {
    ...linked.oldRetention,
    operation: { phase: "pending", id: "fixture-pending-local-operation" },
  };
  await client.query(
    `UPDATE ${ns}.worker_environments SET session_retention_json=$1 WHERE environment_id=$2`,
    [JSON.stringify(pendingRetention), linked.environmentId],
  );
  linkedEvidence.retention = pendingRetention;
  pinEvidence();
  await refuse("pending-local-retention", /unsupported-local-retention-intent/);
  await client.query(
    `UPDATE ${ns}.worker_environments SET session_retention_json=$1 WHERE environment_id=$2`,
    [linkedSource.session_retention_json, linked.environmentId],
  );
  linkedEvidence.retention = linked.oldRetention;
  pinEvidence();

  const pendingClaim = structuredClone(linked.claim);
  pendingClaim.fixedCreateIntent.journal.retention.operation = {
    phase: "pending",
    id: "fixture-pending-provider-operation",
  };
  const pendingClaimBytes = Buffer.from(JSON.stringify(pendingClaim));
  fs.writeFileSync(linked.claimPath, pendingClaimBytes);
  const selectedClaim = identities.claims.find((item) => item.leaseId === linked.leaseId);
  selectedClaim.fileSha256 = sha(pendingClaimBytes);
  firstObservation.claimSha256 = sha(pendingClaimBytes);
  pinEvidence();
  await refuse("pending-provider-retention", /pending-provider-retention-operation/);
  fs.writeFileSync(linked.claimPath, linked.claimBytes);
  selectedClaim.fileSha256 = sha(linked.claimBytes);
  firstObservation.claimSha256 = sha(linked.claimBytes);
  pinEvidence();

  await client.query(
    `UPDATE ${ns}.worker_workspace_pending_results SET disk_authority_json=$1 WHERE session_id=$2`,
    [JSON.stringify(linked.oldAuthority), "019a848b-7c00-7000-8000-000000000001"],
  );
  await refuse(
    "pending-disk-custody",
    /Pending legacy disk custody|pending-disk-result-unsupported/,
  );
  await client.query(
    `UPDATE ${ns}.worker_workspace_pending_results SET disk_authority_json=NULL WHERE session_id=$1`,
    ["019a848b-7c00-7000-8000-000000000001"],
  );
  assert.deepEqual(
    await snapshot(scenario.input.stores),
    scenario.before,
    "Negative scenarios fully restored synthetic source",
  );

  const evidence = await loadRetainedEvidence(scenario.input.retainedEvidence, store);
  const projection = prepareRetainedProjection(await readRows(), evidence, validators);
  assert.equal(projection.environments.size, 6);
  assert.equal(projection.workspaces.size, 5);
  assert.equal(projection.originals.length, 17);
  for (const c of cohorts) {
    const workspace = projection.workspaces.get(c.workspaceId);
    if (c.hasWorkspace) {
      assert.equal(workspace.disposition, c.expectedDisposition);
      assert.deepEqual(JSON.parse(workspace.diskAuthorityJson), c.expectedAuthority);
    } else {
      assert.equal(
        workspace,
        undefined,
        "No workspace projection synthesized for terminal environment",
      );
    }
    const environment = projection.environments.get(c.environmentId);
    if (c.name === "released-absent") {
      assert.equal(environment, undefined);
    } else {
      assert.equal(environment.disposition, c.expectedDisposition);
      assert.deepEqual(JSON.parse(environment.resourceReceiptJson), c.expectedReceipt);
      assert.deepEqual(JSON.parse(environment.retentionJson), c.expectedRetention);
    }
  }

  // Ordinary pending custody is owned by the normal pipeline: retain it and classify held.
  await client.query(
    `INSERT INTO ${ns}.worker_workspace_pending_results
    (session_id,environment_id,owner_epoch,placement_generation,claim_id,run_id,gateway_instance_id,
     recovery_requested_at_ms,workspace_accepted_at_ms,staged_result_ref,repository_workspace_id,disk_authority_json,created_at_ms)
    VALUES($1,$2,$3,4,'fixture-linked-pending-claim','fixture-linked-pending-run','fixture-prior-gateway',$4,NULL,'fixture-linked-pending-result',$5,NULL,$4)`,
    [linked.sessionId, linked.environmentId, linked.epoch, now, linked.workspaceId],
  );
  const pendingProjection = prepareRetainedProjection(await readRows(), evidence, validators);
  assert.equal(
    pendingProjection.environments.get(linked.environmentId).disposition,
    "held-existing-owner-state",
  );
  const pendingBefore = await snapshot(scenario.input.stores);
  assertRun("ordinary-pending-preflight", "--preflight", 0);
  assert.deepEqual(await snapshot(scenario.input.stores), pendingBefore);
  await client.query(`DELETE FROM ${ns}.worker_workspace_pending_results WHERE session_id=$1`, [
    linked.sessionId,
  ]);
  await refreshBackup();

  const preflight = assertRun("retained-preflight", "--preflight", 0);
  assert.deepEqual(await snapshot(scenario.input.stores), scenario.before);
  assert.deepEqual(anchorHashes(), anchors);
  const applied = assertRun("retained-apply", "--apply", 0);
  const after = await snapshot(scenario.input.stores);
  // Every original column except the two replaced JSON contracts must survive byte-for-byte.
  for (const [index, beforeTables] of scenario.before.entries()) {
    const afterTables = after[index];
    for (const [table, rawRows] of Object.entries(beforeTables)) {
      if (
        [
          "schema_meta",
          "openclaw_schema_meta",
          "config_machine_state",
          "session_creation_operations",
        ].includes(table)
      ) {
        continue;
      }
      const originals = rawRows.map(JSON.parse);
      const actual = (afterTables[table] ?? []).map(JSON.parse);
      assert.equal(
        actual.length,
        originals.length,
        `Retained rehearsal preserved row count ${index}:${table}`,
      );
      const preservedColumns = Object.keys(originals[0] ?? {}).filter(
        (key) =>
          !(table === "worker_environments" && key === "session_retention_json") &&
          !(table === "session_repository_workspaces" && key === "disk_authority_json") &&
          !(table === "worker_session_placements" && key === "repository_preparation") &&
          !(table === "worker_workspace_pending_results" && key === "disk_authority_json"),
      );
      const pick = (row) =>
        Object.fromEntries(preservedColumns.toSorted().map((key) => [key, row[key]]));
      assert.deepEqual(
        sortRecords(actual.map(pick)),
        sortRecords(originals.map(pick)),
        `Retained rehearsal preserved every unrelated value in ${index}:${table}`,
      );
    }
  }
  const targetEnvironments = after[0].worker_environments.map(JSON.parse);
  const targetWorkspaces = after[0].session_repository_workspaces.map(JSON.parse);
  const targetPlacements = after[0].worker_session_placements.map(JSON.parse);
  for (const c of cohorts) {
    const workspace = targetWorkspaces.find((row) => row.workspace_id === c.workspaceId);
    if (c.hasWorkspace) {
      assert.notEqual(workspace.disk_authority_json, null, `${c.name} has canonical disk guard`);
      assert.deepEqual(
        validators.requireRepositoryWorkspaceDiskAuthority(
          JSON.parse(workspace.disk_authority_json),
        ),
        c.expectedAuthority,
      );
    } else {
      assert.equal(workspace, undefined, "No terminal workspace synthesized");
      assert.equal(
        targetPlacements.some((row) => row.session_id === c.sessionId),
        false,
        "No terminal placement synthesized",
      );
    }
    const environment = targetEnvironments.find((row) => row.environment_id === c.environmentId);
    if (c.name === "released-absent") {
      assert.equal(environment, undefined, "No missing environment synthesized");
    } else {
      assert.equal(
        environment.provision_source_json,
        null,
        `${c.name} preserves existing resource without provisioning intent`,
      );
      assert.notEqual(
        environment.resource_receipt_json,
        null,
        `${c.name} has canonical resource guard`,
      );
      assert.notEqual(environment.retention_json, null, `${c.name} has canonical retention guard`);
      assert.deepEqual(
        validators.requireWorkerResourceReceipt(JSON.parse(environment.resource_receipt_json)),
        c.expectedReceipt,
      );
      assert.deepEqual(
        validators.requireWorkerEnvironmentRetention(JSON.parse(environment.retention_json)),
        c.expectedRetention,
      );
    }
  }
  const failed = targetPlacements.find((row) => row.session_id === cohorts[1].sessionId);
  assert.equal(failed.state, "failed");
  assert.equal(failed.active_owner_epoch, null);
  assert.equal(failed.remote_workspace_dir, null);
  assert.equal(failed.recovery_error, "fixture failed placement: original disk retained");
  const orphan = targetEnvironments.find((row) => row.environment_id === cohorts[3].environmentId);
  assert.equal(orphan.state, "orphaned");
  assert.equal(Number(orphan.owner_epoch), 0);
  assert.equal(orphan.node_device_id, null);
  assert.equal(
    targetPlacements.some((row) => row.session_id === cohorts[3].sessionId),
    false,
  );
  for (const c of cohorts.filter((item) => item.terminal)) {
    const environment = targetEnvironments.find((row) => row.environment_id === c.environmentId);
    assert.equal(environment.state, c.name === "destroyed-no-workspace" ? "destroyed" : "failed");
    assert.equal(environment.node_device_id, null);
    assert.equal(c.claim.fixedCreateIntent.state, "released");
    assert.equal(Object.hasOwn(c.claim.fixedCreateIntent, "attempt"), false);
    if (c.name === "failed-unleased") {
      assert.equal(environment.lease_id, null);
    }
  }
  const baseEnvironment = targetEnvironments.find(
    (row) => row.environment_id === "fixture-environment",
  );
  assert.equal(baseEnvironment.resource_receipt_json, null);
  assert.equal(baseEnvironment.retention_json, null);
  assert.equal(
    after[0].worker_workspace_pending_results.length,
    1,
    "Unrelated pending custody preserved",
  );
  for (const raw of after[0].worker_workspace_pending_results) {
    assert.equal(
      JSON.parse(raw).repository_disk_authority_json,
      null,
      "No disk authority synthesized for unrelated pending result",
    );
  }

  const expectedArchive = [];
  for (const c of cohorts) {
    const oldEnvironment = originalRows.worker_environments.find(
      (row) => row.environment_id === c.environmentId,
    );
    if (oldEnvironment) {
      expectedArchive.push({
        table: "worker_environments",
        key: c.environmentId,
        sourceColumn: "session_retention_json",
        targetColumn: "retention_json",
        oldRawJson: oldEnvironment.session_retention_json,
        newRawJson: targetEnvironments.find((row) => row.environment_id === c.environmentId)
          .retention_json,
      });
      expectedArchive.push({
        table: "worker_environments",
        key: c.environmentId,
        sourceColumn: null,
        targetColumn: "resource_receipt_json",
        oldRawJson: null,
        newRawJson: targetEnvironments.find((row) => row.environment_id === c.environmentId)
          .resource_receipt_json,
      });
    }
    if (c.hasWorkspace) {
      expectedArchive.push({
        table: "session_repository_workspaces",
        key: c.workspaceId,
        sourceColumn: "disk_authority_json",
        targetColumn: "disk_authority_json",
        oldRawJson: originalRows.session_repository_workspaces.find(
          (row) => row.workspace_id === c.workspaceId,
        ).disk_authority_json,
        newRawJson: targetWorkspaces.find((row) => row.workspace_id === c.workspaceId)
          .disk_authority_json,
      });
    }
  }
  for (const entry of expectedArchive) {
    entry.oldSha256 = entry.oldRawJson === null ? null : sha(entry.oldRawJson);
    entry.newSha256 = sha(entry.newRawJson);
  }
  for (const result of [preflight, applied]) {
    const archived = JSON.parse(
      fs.readFileSync(path.join(result.output, "retained-originals.private.json")),
    );
    assert.equal(archived.version, 1);
    assert.deepEqual(archived.evidence, scenario.input.retainedEvidence);
    assert.equal(archived.entries.length, 17);
    assert.deepEqual(
      sortRecords(archived.entries),
      sortRecords(expectedArchive),
      "Archive preserves exact raw source bytes plus actual canonical target bytes and both hashes",
    );
    assert.equal(
      fs.statSync(path.join(result.output, "retained-originals.private.json")).mode & 0o777,
      0o600,
    );
  }
  assert.deepEqual(anchorHashes(), anchors);
  assertRun("retained-all-current", "--apply", 0);
  assert.deepEqual(
    await snapshot(scenario.input.stores),
    after,
    "Already-current retained run leaves every row unchanged",
  );
  assert.deepEqual(anchorHashes(), anchors);
  const summary = {
    runtime: artifactManifest.pins.runtime,
    cohortNames,
    environments: 6,
    diskBindings: 5,
    archivedRawEntries: 17,
    actualCommandRefusals: [
      "changed-claim",
      "missing-observation",
      "changed-observation",
      "missing-workspace-evidence",
      "missing-environment-evidence",
      "missing-retained-evidence",
      "pending-local-retention",
      "pending-provider-retention",
      "pending-disk-custody",
    ],
    preserved: [
      "all original noncontract fields",
      "failed placement null epoch/directory",
      "orphan epoch zero without node/placement",
      "absent environment",
      "released terminal environments without workspace/placement",
      "failed SQL lease null",
      "released tombstone without attempt nonce",
      "raw JSON archive",
      "nonretained custody",
      "anchors",
      "already-current resume",
    ],
    scope:
      "Actual disposable PostgreSQL17 migration; synthetic private evidence only. No cloud, production, build or Gateway lifecycle effects.",
  };
  fs.writeFileSync(
    path.join(scenario.root, "retained-rehearsal.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { mode: 0o600 },
  );
  cases.push(
    "retained linked, failed-placement, released-absent, orphan epoch0, missing-journal, destroyed and failed-unleased resources retain Native-valid nonnull guards and exact original archive",
  );
  cases.push(
    "changed/missing evidence and pending disk/local/provider operations refuse before store/anchor effects; ordinary pending custody held; all-current resume unchanged",
  );
  return summary;
}
