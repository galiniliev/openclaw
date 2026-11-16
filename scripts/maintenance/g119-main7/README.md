# One-time G119 to Main7 maintenance artifact

This tool converts the exact G119 qualified state37 and agent39 dialects to
standard Main7 state41 and agent42 through runtimef1e20e's Native engine SDK.
It does not change ordinary runtime admission or require rebuilding OpenClaw.

The tool supports the explicitly approved archival retirement of exactly five
bound legacy receipts and canonical projection of retained-resource JSON from
hash-bound identity, immutable claim, and actual provider-read evidence. It
refuses other live receipts, pending disk results, pending retention operations,
and historical repository preparation. Migration does not repair placement or
resource lifecycle state, create claims, wake workers, or replay sessions.

## Prepare the artifact

Run with Node 24+ and the three exact Git objects available. The generator reads
only pinned public source, erases types in memory to call its pure SQL owners,
and emits data plus provenance. It does not import the application engine graph,
compile OpenClaw, install dependencies, or modify the checkout.

```sh
node scripts/maintenance/g119-main7/generate.mjs --repo . --out /private/new-artifact
cp scripts/maintenance/g119-main7/migrate.mjs /private/new-artifact/
cp scripts/maintenance/g119-main7/bindings.mjs /private/new-artifact/
```

The production artifact contains `migrate.mjs`, `bindings.mjs`, `validators.mjs`,
`schemas.json`, and `manifest.json`;
the generator also emits a historical rich-agent fixture for the rehearsal.
Preserve their hashes together with the source commit. The installed runtime must be the
qualified Linux/x64 runtimef1e20e with its existing matching worker artifacts.
The schema descriptors remain pinned to schema-owner88e813; the later runtime
adds the retained-orphan pruning rule without changing those schemas. Validator
module bodies come from runtimef1e20e, with only imports, exports, and erasable
TypeScript removed. Their source and generated hashes are recorded separately.
The SDK and `pg` dependency resolve from that runtime, without private chunk
exports or a new dependency installation.

## Operator custody and inputs

Root owns the ACA job, live database, backup, NFS, secrets, and release ledger.
Before either command against production, Root must stop and drain every writer,
hold the installation's existing exclusive maintenance custody, take and verify a
fresh matched PG/anchor/config backup, then supply a fresh complete inventory.
The tool's normal per-store Native advisory transactions complement that custody;
they do not stop a Gateway or provide cross-store exclusion. A receipt hash is
backup evidence, not authority to change state. Run no Gateway in the job and set
ACA `retryLimit` to zero.

Place durable backups and receipts on NFS. Copy the five tool files to private
local temporary storage; ordinary Doctor/config work also stays local. Existing
anchor files are opened read-only and never restored, replaced, or rewritten.

```json
{
  "version": 1,
  "runtimeRoot": "/app",
  "backupManifest": {
    "path": "/mnt/maintenance/fresh-backup/receipt.json",
    "sha256": "sha256-of-the-verified-fresh-backup-receipt"
  },
  "stores": [
    {
      "family": "state",
      "namespace": "namespace-from-the-fresh-inventory",
      "storeId": "original-store-id",
      "anchorPath": "/mnt/factory/openclaw/state/openclaw.sqlite"
    }
  ]
}
```

Include exactly one state store and every selected agent store. The example is
not a production inventory. Supply the connection URL only through the secret
environment variable `OPENCLAW_MAINTENANCE_PG_URL`; never put it in the input or
command arguments.

For the user's explicit five-request retirement decision, add
`"retirementManifest": { "path": "/mnt/maintenance/approved-five.private.json", "sha256": "..." }`.
Its version-1 object contains exactly five `entries`, each carrying `namespace`,
`storeId`, `operation_digest`, `request_fingerprint`, `session_id`, and `expires_at`
(epoch milliseconds, as an integer or decimal string). Export these exact rows
read-only, bind the manifest hash to the user's selected set, and retain them in
the fresh backup. The manifest is operation input; its existence is not approval
to retire a different set. No production row values belong in source control.

For retained rows, supply `retainedEvidence` with the exact source capture,
individual or grouped provider reads, and actual Crabbox state directory:

```json
{
  "identities": { "path": "/mnt/maintenance/identities.private.json", "sha256": "..." },
  "observations": [{ "path": "/mnt/maintenance/provider-read.private.json", "sha256": "..." }],
  "claimsRoot": "/mnt/factory/crabbox"
}
```

The capture must bind the exact state namespace and store ID. Every captured
claim is checked against its current immutable `claims/<leaseId>.json` file;
captured missing claims must remain missing. Acquired resources require real
successful provider reads with matching resource and immutable lease, attempt,
and fingerprint labels. Released tombstones retain their original labels even
when their attempt nonce has been cleared. The two missing-journal resources
can retain observed identity but remain held; the tool never creates a journal.
If the live Gateway changes captured facts, refresh evidence under stopped-writer
custody rather than weakening a comparison.

```sh
node /run/maintenance/migrate.mjs --preflight /run/maintenance/input.json /mnt/maintenance/preflight-NEW
node /run/maintenance/migrate.mjs --apply /run/maintenance/input.json /mnt/maintenance/apply-NEW
```

Both commands verify every selected source with the existing fingerprint and
generated-DDL seals before the first store commit. Metadata versions only choose
the known source/current definition; they never admit an unknown catalog.
`retention-inventory.sql` is an optional read-only metadata projection for Root's
existing inspection job, with a quoted state namespace as its search path.

## Conversion and recovery

State rebuilds only the four affected worker/repository tables using declared
canonical columns, checks both directions of the copied row bags, restores their
declared indexes/foreign keys, and appends `bootstrap_deferred`. Original custody,
epochs, pending results, recovery provenance, and unrelated tables remain intact.
An external dependency refuses the transaction; there is no `CASCADE`, namespace
swap, schema reset, or catalog edit.

Legacy retention becomes canonical policy with the original owner binding and
compute window, `runtimeReady: false`, `operation: null`, and `observation: null`.
Recorded resource tuples become validated resource receipts; repository disk
authority keeps its original environment ID and a non-null canonical receipt.
All replaced raw JSON and both hashes are fsynced in
`retained-originals.private.json` before the first database commit. No environment
state, lease, epoch, node, attachment, placement, directory, or timestamp is
reconstructed. Failed placements, absent environments, released resources, and
orphaned rows remain in their original state with non-null disk guards. The
qualified runtime's retained-orphan pruning rule must remain present.

The first explicit normal use must observe the original provider/claim before
refreshing the worker runtime and marking it ready. This migration neither
certifies current provider readiness nor authorizes replacement allocation.
Root owns real session continuity and refresh-on-use acceptance after deployment.

For agent39, every old receipt must either satisfy `expires_at <= captured_cutoff`
or exactly match the approved five-request manifest, including all four original
receipt fields and the store binding. Any extra live row or changed tuple refuses
all-store preflight. The originals are archived in the private, durable
`approved-retirements.private.json` before the first database commit. Retirement
explicitly ends those five retry guarantees, with sessions and history preserved;
it is not replay compatibility.

The cutoff is the real process wall clock; there is no clock override. G119's
30-day lifetime rejects replay at that same boundary. The explicit one-time
expiry/approved-retirement step checks emptiness, then replaces its
obsolete receipt table through the canonical agent40/41/42 recipes. It creates
no dummy session and invents no requester role, scopes, or digest preimages.
Retain the original receipt rows in the fresh backup. This is not a pre-existing
cleanup CLI. No other live retry guarantee may be retired.

Main7's closed `sessions.create` schema rejects `creationOperationId`, `sessionId`,
and `purpose`. Callers must discard the explicitly retired request envelope and
open the preserved session by its existing key, or submit a **new explicit intent**
using the current `idempotencyKey` flow. Never silently strip the old fields and
auto-resubmit a create.

Each store commits separately through the Native migration runner, destination
DDL verification, and new seal publication. The consecutive state38–41 recipes
are wholly inside one outer transaction; only canonical41 can commit. There is
no cross-store atomicity claim. Source rows are rechecked in that store's writer
transaction before its first conversion step.

After any error or interruption, inspect the private failure and store receipts
and actual catalogs under the same custody before retrying. A commit can precede
its receipt; rerunning with a fresh inventory admits an already canonical store
and continues remaining recognized predecessors. Never infer rollback from a
nonzero exit. Failed outputs are retained, and every invocation requires a new
receipt directory. After any forward commit, standalone G119 is no longer a
rollback reader for that store; rollback requires Root's matched backup.

Root must separately qualify the Main7 Factory configuration: convert retention
to `workspaceDurability`, move `runSetupScript` into settings, migrate Workshop to
its plugin configuration while retaining autonomous mode off, and fit setup bytes
within Main7's current limits. This tool changes none of those limits or values.

## Disposable PG17 rehearsal

Generate the artifact, copy `rehearse.mjs`, `rehearse-retained.mjs`, and `fixtures/` together, and set
`OPENCLAW_MAINTENANCE_REHEARSAL_PG_URL` to an owned disposable PG17 database.
Run under the retained Linux/x64 Node 24 runtime image without its Gateway
entrypoint, cloud credentials, real NFS, or live configuration:

```sh
node rehearse.mjs /tmp/artifact /app /tmp/rehearsal-NEW
```

The rehearsal creates uniquely named source namespaces and synthetic anchors,
exercises the actual tool and Native PG bridge, and retains its evidence. It
proves all-store refusal for a valid receipt and unknown catalog, nonempty source
preservation across all three dialects, canonical seals, anchor/sequence retention,
expired-only cleanup, exact five-request archival retirement, rejection of a
changed receipt or extra live row, and resuming partial/current stores. Retained
cases cover linked, failed-placement, released/absent, orphaned, missing-journal,
destroyed, and failed/unleased resources. Changed or missing evidence and pending
disk/retention operations refuse before store or anchor effects. Canonical guards,
unrelated row values, and the original raw-JSON archive are checked after apply.
This does not prove old Gateway wire replay, live worker readiness, cloud effects,
configuration repair, or the next Gateway startup. Root owns those release gates.
