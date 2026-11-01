---
summary: "Native ownership and validation of machine caches admitted to prepared snapshots"
title: "Prepared snapshot cache admission"
read_when:
  - Changing repository Node installation or snapshot verification
  - Adding a machine cache to prepared image capture
---

# Prepared snapshot cache admission

The native project preparation owner validates caches before image capture. A
provider's image verifier consumes its closed inspection facts; directory names,
self-written checksum lists, and cache presence alone are not admission proof.
This contract restores prepared repository snapshots whose selected Node release
and current worker bundle are legitimate machine caches. It adds no execution
grant, model tool, credential forwarding, or general cache allowlist.

Repository Node installation retains the already verified official distribution
archive as `.archive.tgz` inside its existing content-addressed cache. Inspection
compares the complete extracted inventory, bytes, permissions, directories, and
contained symbolic links against that archive and the selected distribution
identity. It also checks the installer's existing checksum metadata. Unknown
files, escaping links, changed bytes, and unsupported entries fail admission.
The image verifier never parses the installer's private checksum format.

Node-bearing preparations publish a content-addressed completion envelope linking
the original source and prepared workspace manifests to the selected toolchain
inventory. The envelope schema is `openclaw.prepared-completion.v1`; its fields
are `schema`, `baseCommit`, `sourceManifestRef`, `preparedManifestRef`, and
`nodeToolchain`. Its own content digest names the completion artifact, while
`sourceManifestRef` and `preparedManifestRef` continue naming the original
workspace manifests. Unknown envelope versions fail closed. Preparations without these facts retain the original completion
format. Old caches lacking complete proof remain usable by their existing command
owner, but cannot be captured as verified snapshots. Inspection never fetches,
reinstalls, or removes an active toolchain to manufacture proof.

`inspectPreparedWorkspace({ snapshot: true })` may return
`validatedMachineCaches`. Its optional `nodeToolchain` fact contains `version`,
`platform` (`linux`), `arch`, `archiveSha256`, and `inventorySha256`. Its optional
`workerBundle` fact contains `bundleHash`. The bundle fact comes from the existing
native receipt and complete bundle-manifest validators, against the current
producer identity supplied by the capture owner. Older or unknown digest-named
caches are not implicitly accepted.

Providers derive only the known cache roots from these identities. Unknown caches,
session state, staging files, and credential paths retain their rejection rules.
The facts travel through the existing private snapshot-verifier input; they are
not persisted grants or arbitrary filesystem paths. The current worker's
`protocolFeatures` accompany bundle verification. Legacy inputs may omit that
field only when they do not claim a new worker-bundle cache fact.

The native inspector and provider verifier must agree on this data contract before
activation. Source qualification does not imply deployment or a successful
snapshot. Rollback disables the whole warm-image feature through its existing
policy; it never relaxes cache, credential, or session-state guards.

## Reusing installed setup

Ordinary prepared-workspace reuse checks the content-addressed completion receipt,
its admitted cache location, directory ownership, standalone Git directory, and
current `HEAD`. A matching receipt means setup was installed for that cache; it
does not attest that every checkout or toolchain file is still unchanged. Reuse
neither walks and hashes the checkout nor runs full Git object verification. It
does not rerun setup or overwrite existing workspace edits or HOME.

A different requested revision still uses the canonical preparation path, with
content verification before refreshing a previous checkout. Shared snapshot
publication keeps the full workspace, seed, and machine-cache verification above.
Cache compatibility and requested-revision admission remain unchanged.
