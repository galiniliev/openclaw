---
summary: "Capture, reuse, refresh, and recover prepared cloud-worker images"
title: "Cloud worker warm images"
read_when: "You want later cloud dispatches to start from a prepared image, or you are recovering a paused capture."
doc-schema-version: 1
---

OpenClaw saves a prepared repository as a snapshot so later cloud sessions can reuse its dependencies and tools. The first session prepares its own machine; later sessions fork the snapshot or adopt an already-running ready worker.

## Warm images

Snapshots are enabled by default for Linux when the profile or session selects a machine class. Setup secrets do not disable them. Without a class, automatic selection stays cold; explicit `settings.warmImage: true` requires a class. Set `false` to disable capture and reuse. macOS and Windows always start cold. Snapshots incur provider storage charges and retain repository content and machine caches, so share them only between mutually trusted workloads.

### First session for a repository

For an eligible repository with committed content, OpenClaw:

1. Provisions the session's machine and runs optional profile setup.
2. Prepares the selected commit and its [repository environment recipe](/gateway/cloud-workers/environment-file), with a verified Node toolchain and the current OpenClaw runtime.
3. Removes worker identity and session state, then fixes the snapshot capture point before node enrollment.
4. Enrolls the node, binds the session workspace, runs post-create/start commands, and starts the first turn.

With Crabbox 0.79.0 or newer on AWS, the first session continues to enrollment once Crabbox confirms the capture point is fixed. The snapshot upload finishes in the background; later sessions start cold until it is available. Older Crabbox, refresh captures, reserves, and other backends still wait for completion. Daytona may stop and restore the source machine during capture.

This works for both Gateway checkouts and repository-only GitHub sessions. Only committed repository content enters preparation. Session edits and enrollment credentials arrive after the capture point is fixed. Private repository preparation transfers Git content without putting GitHub credentials in worker files or snapshots; it needs temporary Gateway disk space, and the outgoing pack is limited to 4 GiB.

Setup-generated dependencies and build output survive into the session. Session changes are applied over that prepared content, with session edits taking precedence. Explicit checkpoint restores and accepted reconciliation snapshots retain their exact contents, including deletions.

An empty committed workspace uses the profile's shared runtime image instead of a repository snapshot. With no prepared project, capture happens at eligible worker teardown. A failed detected dependency install skips capture and lets the session start cold; a failed declared recipe stops dispatch. Explicitly skipped setup has a separate snapshot identity.

Environment status reports `stopping` while teardown is pending. Stop cloud worker can finish after session shutdown and a claimed warm-image capture, while the environment remains `destroying`. Capture and confirmed lease release continue under the environment lifecycle owner; only confirmed release changes the environment to `destroyed`. Failures remain visible and retryable. If the Gateway exits mid-capture, Crabbox's idle timeout or TTL can reap the lease, and the next Gateway reconciles the retained cleanup request.

### Azure Sandbox snapshots

Azure Sandbox capture uses the profile's preinstalled snapshot SDK runtime and
canonical clean-image verifier. Configure `sdkPython`, `configFile`, `sdkIdentity`,
and `snapshotVerifier` as described in the
[Crabbox profile reference](/gateway/config-cloud-workers#crabbox-profile).
The Gateway must supply the complete explicit Crabbox routing environment:
`CRABBOX_AZURE_SANDBOX_REGION`, `CRABBOX_AZURE_SANDBOX_SUBSCRIPTION_ID`,
`CRABBOX_AZURE_SANDBOX_RESOURCE_GROUP`, and `CRABBOX_AZURE_SANDBOX_GROUP`.
These existing Crabbox inputs override file configuration and bind SDK snapshot
operations to the same provider scope. Scope stored only in a Crabbox config file
is insufficient for snapshot preparation; OpenClaw does not parse private YAML
or infer missing routing fields.
The verifier runs on the clean worker before node enrollment. Capture waits for
the exact snapshot to become readable in its original provider scope before
publishing it for reuse.

Before capture, the native project owner rechecks the admitted source and completed
workspace manifests. The verifier receives that exact root set and the current
runtime artifact descriptors over bounded private stdin. It checks credential and
session-state absence in both machine and prepared homes, rejects unknown cache
roots, and verifies the current installed runtime with the native cache predicate.
The baked runtime remains separate base-image provenance after a runtime top-up.
Verifier failures report closed phase/process metadata, never child output or
repository content. A capture without a current verification owner fails closed;
an optional teardown capture is skipped visibly.

New session-private retained allocations may borrow a compatible clean template
for the exact admitted repository. Their immutable snapshot receipt is recorded
before Crabbox's fixed allocation command. Missing receipt exports are regenerated
from that recorded binding; retries keep the same generation. A new retained fork
uses canonical project preparation and registers its checked paths with the new
node owner before session binding. A completed cache at the requested revision
does not upload source or rerun setup. Private allocations are never recaptured. Cold initial allocations prepare
their own checkout; existing retained sessions resume their saved private lease
without choosing another template or resetting private files.
Private session state never becomes a capture source. Deleting one session
releases its template borrow after physical cleanup; it does not delete a template
shared with other allocations.

Provider scope and the selected source disk participate in compatibility. Snapshot
deletion retains its original route and remains pending until a scoped read
confirms absence. An interrupted capture keeps its recorded source and operation
ownership; a lost response never triggers another capture automatically.

### Later sessions and refresh

A matching ready worker skips provisioning. Otherwise, a compatible snapshot starts a new machine and New Session shows **Starting from snapshot…**. New forks update their checkout to the requested commit and install the current runtime when needed before enrollment. Profile setup is already captured; post-create/start commands run after session binding.

Shared clean project snapshots do not bind the moving repository commit. A new
session-private retained fork uses the same canonical project preparation as other
new forks: a completed checkout at the requested revision needs no source upload
or setup; a different revision verifies the captured baseline, advances the
checkout, and runs the existing content-update setup before enrollment. Recipe,
setup, machine, ABI, and source-access compatibility still apply. Ready workers
continue to bind the exact requested commit and runtime.

This applies only while preparing a new allocation from a clean shared snapshot.
Existing retained sessions resume their exact private disk and owner binding;
ordinary resume and settlement never refresh that checkout from a Gateway mirror
or rerun old input. Private allocations remain ineligible for shared capture,
including after revision reconciliation. Persisted revision-bound cache keys are
not relabeled or rewritten: a new request starts cold once when its snapshot has
that older incompatible key, then subsequent commits can reuse the new clean
snapshot. Existing allocation choices, pins, borrowers, and cleanup debt remain
with their original owners.

Snapshot compatibility covers the repository and source-access scope, backend, exact machine class, operating system, desktop setting, profile setup command, setup-secret names and store references, repository recipe, and whether setup was skipped. Linked worktrees of one local repository share snapshots; separate clones do not. Repository-only sources also bind their repository instance, agent and selected GitHub identity. A changed recipe, machine configuration, or source-access scope needs compatible preparation, usually a cold build. Secret values and temporary sentinels never participate in the key.

The OpenClaw runtime is separate from snapshot compatibility. Gateway updates, runtime archives, enabled plugins, execution mode, profile names, lease durations, and reserve limits do not invalidate an otherwise compatible snapshot. Ready workers, however, must match the current runtime, profile, and commit before use.

A foreground non-retained project fork can refresh a changed commit or top up its runtime without capturing a replacement just for that change. Background reserves and explicit builds can publish refreshed snapshots. A cold build can replace the image generation recorded when it was admitted; a later publication prevents that older build from replacing the newer image. Initial capture, interrupted capture recovery, required setup repair, and age refresh still use the capture boundary. Unpinned images become eligible for refresh after `refreshAfter` (24 hours by default); runtime-only images refresh at eligible teardown. Disabling reserves also disables automatic background refresh.

Retries and Gateway restarts keep the originally selected cold allocation or checkpoint. A failed fork reports an error rather than silently allocating another machine. Missing, retiring, or incompatible snapshots cause new allocations to start cold. A failed fork that finds its snapshot missing retires it, so later allocations start cold.

If the backend definitively refuses native capture, OpenClaw records the reason and continues enrollment on the prepared machine. Existing compatible snapshots remain usable. Capture is retried after `refreshAfter`; a successful capture clears the refusal. An uncertain capture instead pauses further capture and blocks enrollment on its source until [recovery](/gateway/cloud-workers/warm-images#recover-a-paused-capture).

### Capture lifetime

A 45-minute checkpoint wait is an operation budget, not extra lease lifetime. Before source-dependent capture, OpenClaw checks the effective remaining total lifetime and keeps the existing source heartbeat active while the provider requires the source. Heartbeats protect idle time only. If the source needs more total lifetime, OpenClaw requests a bounded `crabbox extend <lease-id> --ttl <desired-total> --json`, within the configured duration and effective maximum. Extension does not reset idle time. On the supported nonblocking AWS path, fixing the capture point permits enrollment while upload continues; lifetime checks do not turn that upload into a blocking wait. Renewal stops before source release, and allocation holds remain until cleanup is confirmed.

Crabbox owns extension authority, policy, and budget. `lease_extension_denied` and `lease_extension_budget_exceeded` grant no extra time; `lease_extension_not_advancing` means the target or cap cannot advance, and `lease_not_active` cannot revive the lease. Creation-fixed providers, including Daytona, return `lease_extension_unsupported_provider` and need sufficient TTL at creation. OpenClaw visibly skips an optional capture when the source window cannot be secured; required project capture fails preparation with that reason. It does not bypass policy, switch providers, or chain leases indefinitely.

A direct extension can commit a longer provider deadline but fail to refresh the guest expiry guard. That is a failed preparation outcome until reconciled: the guest can still shut down at its old deadline. Retry only the same fixed total TTL in the same Crabbox state to repair the pending refresh; do not add another duration blindly. See [Crabbox extend](https://crabbox.sh/commands/extend.html).

### Retention policy

Set the plugin-wide policy under `plugins.entries.crabbox.config.warmImages`, or
use **Advanced → Snapshot retention** under **Cloud environments**. These controls
apply to all repositories. Saving reloads the Crabbox plugin without restarting
the Gateway. Worker lease lifetimes and the 128-profile capacity limit stay
unchanged. Unused, unpinned images expire after `retainUnused`; images held by allocations wait for those workers to stop. Replaced snapshots retire after allocations release them unless retained as a previous generation or pinned. Failed deletion stays pending and retries during the Gateway's periodic maintenance (every 60 seconds by default). Pending retirements run before capture reconciliation so a slow capture cannot block their retries. Each failed deletion attempt logs the provider error in the Gateway log; successful deletion clears the pending retirement. Maintenance checks allocation leases that hold a pending retirement and releases their holds only after confirming the lease is gone. Live dispatches keep their holds even before the provider creates the lease. Live or unconfirmed holding leases remain protected and are named in the Gateway log and Doctor finding.

| Key            | Default | Accepted values                                                   |
| -------------- | ------- | ----------------------------------------------------------------- |
| `refreshAfter` | `24h`   | Whole minutes, hours, or days (`m`, `h`, `d`), at least `1h`.     |
| `retainUnused` | `14d`   | Whole minutes, hours, or days (`m`, `h`, `d`), at least `1d`.     |
| `keepPrevious` | `0`     | `0` retires replaced images; `1` retains one previous generation. |

Duration values accept one to eight digits followed by one unit, such as `90m`
or `14d`; composite and fractional durations are invalid.

```json5
{
  plugins: {
    entries: {
      crabbox: {
        config: {
          warmImages: {
            refreshAfter: "24h",
            retainUnused: "14d",
            keepPrevious: 1,
          },
        },
      },
    },
  },
}
```

Pinned checkpoints are exempt from age refresh, unused expiry, capacity eviction,
and replacement retirement. For prepared project images, a pin keeps a checkpoint
available across runtime updates; workers top up the runtime after forking it. A
recipe change still starts workers cold until a compatible capture publishes.
Other allocation compatibility rules also remain unchanged. A newer capture for
the same profile record moves a pinned current checkpoint to **Previous**, even
with `keepPrevious: 0`; rollback can restore it. Unpinning restores ordinary
policy at the next maintenance pass or capture boundary. Previous generations
can expire when unused, and lowering `keepPrevious` to `0` permits their
retirement unless pinned or still held by an allocation.

### Ready workers

After a successful session activation, OpenClaw can prepare an unassigned worker in the background for the next matching session. Defaults are one worker per repository and profile, with a Gateway-wide cap of four. A ready worker is consumed once and then refilled. If none is ready, the session provisions normally, using a compatible snapshot when available. Paired devices do not use this pool.

When the repository integration prepares repository-specific capacity, an authorized Control UI browser also keeps the configured default repository's reserve target prepared. Read-only browsers do not allocate workers. After the last eligible browser disconnects, presence-driven refill stops and unused reserves retire after 15 minutes. Repository access and identity are checked again before reuse; changed visibility or lost access prevents reuse of earlier capacity.

Empty workspaces share a separate runtime-only reserve per provider and profile, containing no session files or credentials. The first empty session provisions normally; activation can refill its reserve. Browser presence alone does not warm empty workspaces.

A repository integration can select image-only capacity for repository dispatch. These workers contain the runtime, not a repository checkout or GitHub credentials, and have a different identity from empty-workspace reserves. Dispatch claims matching image capacity before resolving repository credentials, then restores the repository through normal startup under the current request's authority. Without a matching reserve, it provisions the runtime first and uses the same repository startup path. This requires a profile that supports runtime image preparation; integrations that select repository capacity retain repository-specific preparation. Image-capacity policy keeps the configured default profile's target prepared without browser presence, refills after claims, and reconstructs demand on Gateway restart using the existing environment inventory. While reconstruction is pending, unchanged-policy reserves keep their identities without allocating replacements; expiry and explicitly requested cleanup still run. A stored reserve is not itself a session activation or permission to allocate after policy withdrawal.

Set `cloudWorkers.profiles.<id>.readyWorkers` for the per-project target and `cloudWorkers.preparedPool.maxTotal` for the shared cap. Zero drains unused reserves and disables the corresponding refill, preserving active sessions and snapshot reuse. Preparing workers and unconfirmed cleanup count toward both limits. Reserves require an eligible dedicated Linux profile with warm images and a known machine class.

Ready workers incur running-machine charges until deletion is confirmed. Activation-driven demand expires using the provider's idle timeout; refill and Gateway restart do not extend it. Standing runtime-image demand remains while its policy is enabled, but never extends an existing worker's finite reserve deadline. Expired, incompatible, disabled, and surplus workers retire. Temporary provider or artifact-observation failures defer maintenance, retaining existing capacity and its expiry. Check the pool limits and Gateway's refill diagnostic if no reserve appears after activation.

**Build on demand:** `environments.prepare` accepts `{ profileId, projectPath }` with `operator.admin`, prepares a local Git checkout's committed `HEAD`, and authorizes its setup recipe. It returns `{ environmentId, preparationKey, cacheKey, reused }`, reusing matching work already in progress. It requires an eligible profile and room under the pool cap. A build can finish with `readyWorkers: 0`, then ordinary reserve policy may retire it as surplus. `environments.destroy` cancels an unused build or reserve and waits for provider work and cleanup to settle.

Repository-only callers can instead pass
`{ profileId, repository: { agentId, url, ref? } }`; `projectPath` and `repository`
are exclusive. This mode keeps the original authenticated request and repository
access current through preparation and returns the same fields plus
`status: "ready"` only after the native lifecycle supplies its final readiness
receipt. `preparationKey` binds the exact commit/runtime ready-worker intent;
`cacheKey` identifies compatible clean snapshot setup independently of the moving
commit. Retain the returned key when correlating `crabbox.images.list` after an
unused builder retires. Image `preparationKey` and `baseCommit` describe the
captured generation, so they need not match a later request. The key alone does
not prove provider readability or authorize allocation; the provider still owns
selection and its existing scope, generation, retirement, and pin checks. Older
responses may omit `cacheKey`; consumers must report that missing fact instead of
reconstructing it or treating a repository label as compatibility proof. It does not dispatch a conversation turn. Repository credentials remain
on the Gateway, and background refill cannot reuse the caller's reader after
the request closes. A canceled or timed-out call is not proof that an admitted
provider effect did not happen: inspect its durable environment and snapshot
ownership before retrying. For a known unused build, `environments.destroy` uses
that exact environment ID; it does not acknowledge or erase uncertain capture
debt.

An already-admitted capture can finish after reserve-demand expiry within its secured source lifetime and provider budget, while its worker remains counted. Reserve-demand expiry does not grant more provider lifetime or allow later enrollment, readiness, or consumption; cleanup follows settled capture custody.

### Inspect snapshots in the Control UI

Open **Settings → Connections → Cloud environments**. Each repository has one row showing **Ready**, **Building**, **Cold only**, or **Needs attention**. Select it to inspect its snapshots, recorded setup source, step timings, and failures. **Machine → Change** sets the repository's default profile. Inventory refreshes while builds, captures, or ready workers are present, and after deferred plugin activation.

Either `environments.prepare` selector also accepts optional `executionMode`:
`"remote-exec"` or `"worker-turn"`. An explicit target must be supported by the
configured provider and is checked before source or runtime-artifact preparation.
Without it, preparation retains the existing preference for `worker-turn` when
supported, otherwise `remote-exec`. Select `remote-exec` when preparing for a
Codex cloud session: runtime/plugin selection and preparation identity must match
the later session's mode; a `worker-turn` build is not equivalent.

**Rebuild** prepares the recorded local project's committed `HEAD` without a session. It requires administrator access, a local project root, an eligible profile, and pool capacity. Repository-only sources cannot use this action. Rebuild follows normal refresh policy and may reuse a matching build or reserve; it does not force snapshot replacement. Active builds offer **Cancel**; failed builds offer **Dismiss**, which hides the row until reload while the terminal record remains retained. Orphaned builds still awaiting cleanup cannot be dismissed.

Snapshot overflow actions offer **Pin**, **Unpin**, **Delete**, and, when a previous generation exists, **Roll back**. Pinning protects an image from automatic retirement. Delete requires confirmation and is unavailable for pinned, held, or capturing images. Pin changes and rollback are unavailable during capture or when an affected generation already has a retirement obligation. Failed deletion remains pending and retries during maintenance.

Rollback restores the previous checkpoint as current. The demoted current image is retained when pinned or when `keepPrevious: 1`; otherwise it retires after allocations release it. A retained previous checkpoint can still be rolled back after lowering `keepPrevious` to `0`. If both generations are pinned, unpin one before publishing another replacement.

The collapsed **Advanced** section contains **Machines**, **Pool**, **Snapshot retention**, and **Machine images**. Machines manages profiles; Pool shows reserve counts and limits; Snapshot retention applies to all repositories. Machine images holds snapshots and builds without repository metadata, including uncertain captures. Saving machine settings refreshes eligibility without leaving the page.

Snapshot inspection and actions require `operator.admin` and the enabled Crabbox provider. Actions appear only when their methods are advertised. API clients use `crabbox.images.list` for local snapshot state and `includePreparedDetails: true` on `environments.list` or `environments.status` for pool details. Listing snapshots does not contact the provider or expose setup commands or secret values.

**Recover** appears only for uncertain captures. Its acknowledgement has the same meaning as the CLI's `--acknowledge-provider-cleanup`: follow the cleanup steps below first. Recovery clears the reservation; it does not stop a worker or delete provider artifacts.

### Recover a paused capture

Inspect local ownership without contacting the cloud:

```bash
openclaw crabbox warm-images --json
```

Status identifies the capture selector, source lease, checkpoint references, and recorded setup diagnostics without exposing setup commands or environment values. Doctor reports pending captures and retirements but does not clear them with `doctor --fix`. A capture older than 20 minutes can still be working; elapsed time alone is not a reason to recover it. Only an explicitly uncertain outcome requires recovery. If status asks for migration, follow [Upgrade warm-image state](/gateway/cloud-workers/warm-images#upgrade-warm-image-state) first.

A paused capture does not prevent source-lease cleanup, but enrollment on its uncertain source remains blocked until recovery clears the reservation.

Gateway warm-image maintenance runs at startup and during the periodic worker
environment sweep (every minute by default), including when the prepared pool is
disabled and no worker sessions are active. Maintenance follows the configured
provider's plugin activation policy. It retries uncertain captures until
their source lease is absent, stopped, released, or expired. Released and expired
leases cannot start another checkpoint; lease teardown still owns physical resource
cleanup. Maintenance matches the exact recorded lease ID in Crabbox's checkpoint
catalog. If no checkpoint exists, it
clears the capture reservation. If exactly one exists, it deletes that unvalidated
checkpoint before clearing the reservation, and logs the outcome. It never adopts
an interrupted capture's snapshot.

Multiple matching checkpoints, checkpoints already referenced by a published image
or allocation, failed lookups or deletions, unexpected responses,
and sources that are still running or unconfirmed keep the capture paused for
manual recovery. Doctor and warm-image inspection include the candidate checkpoint
IDs discovered during maintenance; warnings explain why automatic recovery stopped.

Azure SDK snapshot captures remain held for reconciliation in their original Azure scope.

Before manual recovery, stop the owning Gateway, any original capture processes, and the recovered worker. Inspect the reported candidate checkpoint IDs, or use the source lease and capture time to reconcile the uncertain operation in Crabbox's checkpoint catalog or the original Azure snapshot inventory, and resolve any untracked provider artifact. Only after those steps, copy the exact capture selector from status:

```bash
openclaw crabbox warm-images --recover <capture-selector> --acknowledge-provider-cleanup
```

The acknowledgement attests that the original capture and worker are stopped and untracked artifacts are resolved; elapsed time alone does not establish those facts. Recovery clears that capture reservation and its source lease's allocation, preserves known checkpoint references and all other allocation choices, and rejects a replaced selector. It does not stop processes, run provider commands, delete snapshots, or allocate a worker. Restart the Gateway afterward; the next eligible worker can capture again. Failed checkpoint retirements retry during periodic maintenance or that profile's later capture or warm-image-enabled worker teardown after provider deletion errors are resolved; they do not use capture recovery.

### V4 retirement and cutover contract

The existing SQLite-backed profile row owns one capture operation and a bounded
collection of independent retirement obligations. A held, detached retirement does
not block another capture. Capture publication atomically preserves all prior debt
and records any displaced generation. Allocation choices, generation fences, slots,
pins, provider scope, original operation/effect identities, and retained disk owners
remain authoritative; session completion never releases a borrower.

The collection is limited to 64 obligations and the existing 1 MiB value budget.
Capture admission reserves two 64 KiB descriptors before provider capture; oversized
new descriptors refuse before submission or retain uncertain capture ownership on
an invalid provider response. Status reports structural capture eligibility and
held retirements separately; it does not replace project/runtime verification.

Capture admission reserves debt and row capacity before provider capture. Active or
uncertain captures, retiring selectable slots, two pinned slots, and exhausted
capacity still block publication. Only the existing retirement owner can delete an
unheld, unpinned generation, using its original route and independently confirmed
result. Failure or unknown outcome retains the obligation. Pin and rollback cannot
revive a retiring generation or discard unrelated debt.

Doctor migrates v3 to v4 under exclusive maintenance using the existing single-row
comparison update, without provider effects. V4 is not writable by c43: its writer
refuses the version and its Doctor must leave it unchanged. No downgrade or backup
restore may discard obligations created after cutover. Promotion therefore requires
quiescing the old plugin writer, backing up its state, migrating with the successor,
and activating that same successor; a reload is suitable only if its owner proves
that exact serialized migration boundary. Local deployment owns this operation.
The public plugin reload route replaces code but does not run the required data
migration. Plugin updates and force replacement refuse activation when recorded
state migration still needs maintenance. Therefore live reload alone is not a
qualified v3-to-v4 cutover. Use a package-only successor only when the installation
owner can select it through the public package owner; otherwise use the canonical
immutable distribution successor. In both cases stop the old writer and capture
processes, back up, run the selected successor's Doctor, then start that successor.
No capture, borrower release, or destructive cleanup is authorized by migration.

### Upgrade warm-image state

If warm-image status requests migration, stop the owning Gateway and original capture processes, then run:

```bash
openclaw doctor --fix
```

Doctor migrates state under the exclusive maintenance lock, preserving checkpoints, allocation choices, and cleanup obligations. Older empty capture markers become uncertain captures with their original recovery selector. Unsupported records remain unchanged with a warning; provisioning waits for required migration.

Older `warm-leases` rows record an enrolled class but cannot establish whether a lease originally started cold or from a checkpoint. These rows block new warm-image allocations until resolved. Doctor reports their count and exact recovery commands. Resolve each lease through its original Gateway or provider, stop its worker and owning processes, and reconcile provider artifacts before using the reported selector:

```bash
openclaw crabbox warm-images --recover <legacy-allocation-selector> --acknowledge-provider-cleanup
openclaw doctor --fix
```

This recovery deletes only the unchanged legacy row matching that selector. It does not establish provider absence or clean up a machine for you. Keep the row when cleanup is uncertain. Checkpoints already forgotten by older code are not rediscovered; reconcile those manually through Crabbox. Do not run older and newer writers against the same state or downgrade while allocations, captures, or retirements remain unresolved.

Offline image preparation consumes the first native installer's typed
`openclaw.runtime-installation.v1` result through the Crabbox CLI runtime API.
The image producer carries that result in its existing prepared-runtime manifest;
it does not run a second setup command to manufacture a cache hit. Snapshot
capture carries the current preparation's result through the existing verifier
input, so a runtime top-up never borrows the baked image's result. The resulting
snapshot records `installationVerified: true`; existing durable receipts with an
actual `cacheHitVerified: true` remain readable. These are installation facts,
not permission to skip enrollment verification or any credential and ownership check.

A snapshot startup rejected before allocation can finish cleanup without deleting a worker that never existed. The allocation owner requalifies its original pinned binding and requires a complete local claim inventory with no matching lease. Legacy attempts also require the qualified consumer contract; a missing contract keeps cleanup pending. This releases only the failed allocation bookkeeping and preserves the shared snapshot and rejected binding exports. Timeouts, ambiguous failures, changed evidence, and existing claims retain their normal cleanup fences.
