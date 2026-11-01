import fs from "node:fs/promises";
import path from "node:path";
import type { Selectable } from "kysely";
import {
  requireWorkspaceResultGit as git,
  workspaceResultCheckpointInitArgs,
  withWorkspaceResultRefMutation,
} from "../gateway/worker-environments/workspace-result-git.js";
import { readStagedWorkerWorkspaceResult } from "../gateway/worker-environments/workspace-result-staging.js";
import {
  pinDirectory,
  requireDirectorySync,
  syncDirectory,
} from "../infra/directory-durability.js";
import { hasErrnoCode } from "../infra/errno.js";
import {
  prepareSkillLibraryBundle,
  readSkillLibraryManifestTree,
  stageSkillLibraryBundle,
} from "../skills/library/bundle.js";
import type { SessionRepositoryWorkspaces } from "../state/openclaw-state-db.generated.js";
import type { readSessionDependencyInput } from "./database-restore-session-dependencies.input.js";

function checkCheckpoint(
  snapshot: Awaited<ReturnType<typeof readStagedWorkerWorkspaceResult>>,
  row: Selectable<SessionRepositoryWorkspaces>,
) {
  if (
    snapshot.base.baseCommit !== row.base_commit ||
    snapshot.current.baseCommit !== row.base_commit ||
    snapshot.baseManifestRef !== row.base_manifest_hash ||
    snapshot.currentManifestRef !== row.manifest_hash
  ) {
    throw new Error("Repository checkpoint does not match the selected original workspace.");
  }
}
export async function prepareSessionDependencyArtifacts(
  input: Awaited<ReturnType<typeof readSessionDependencyInput>>,
) {
  const files = await readSkillLibraryManifestTree(
    path.join(input.root, "skill-revision"),
    input.rows.skillRevision.files_json,
    input.request.skillRevision,
  );
  const skill = prepareSkillLibraryBundle(files);
  if (skill.revision !== input.request.skillRevision) {
    throw new Error("Pinned skill content differs from its original revision.");
  }
  const source = path.join(input.root, "workspace.git");
  const checkpointRef = input.rows.workspace.checkpoint_ref;
  if (!checkpointRef) {
    if (
      input.request.version === 3 &&
      input.retained &&
      input.rows.workspace.manifest_hash === null
    ) {
      return { skill, source, checkpointRef: null };
    }
    throw new Error("Original workspace has no accepted checkpoint.");
  }
  checkCheckpoint(
    await readStagedWorkerWorkspaceResult(source, checkpointRef),
    input.rows.workspace,
  );
  return { skill, source, checkpointRef };
}

/** Publish immutable artifacts before their metadata becomes reachable; retain them on refusal. */
export async function publishSessionDependencyArtifacts(
  input: Awaited<ReturnType<typeof readSessionDependencyInput>>,
  prepared: Awaited<ReturnType<typeof prepareSessionDependencyArtifacts>>,
  statePath: string,
  env: NodeJS.ProcessEnv,
  assertCurrent: () => void,
) {
  const staged = await stageSkillLibraryBundle(
    input.request.skillId,
    prepared.skill,
    env,
    assertCurrent,
  );
  try {
    await staged.publish();
  } finally {
    await staged.cleanup();
  }
  if (prepared.checkpointRef === null) {
    return;
  }
  const parent = path.join(path.dirname(statePath), "repository-workspaces");
  const destination = path.join(parent, `${input.request.workspaceId}.git`);
  if (
    await fs.lstat(destination).then(
      () => true,
      (error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return false;
        }
        throw error;
      },
    )
  ) {
    checkCheckpoint(
      await readStagedWorkerWorkspaceResult(destination, prepared.checkpointRef),
      input.rows.workspace,
    );
    return;
  }
  assertCurrent();
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await fs.mkdtemp(path.join(parent, ".dependency-restore-"));
  // Failed private staging remains recoverable; never replace an existing checkpoint store.
  await git(staging, workspaceResultCheckpointInitArgs());
  await withWorkspaceResultRefMutation(staging, async (baseEnv) => {
    assertCurrent();
    await git(
      staging,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--",
        prepared.source,
        `${prepared.checkpointRef}:${prepared.checkpointRef}`,
      ],
      { baseEnv },
    );
  });
  checkCheckpoint(
    await readStagedWorkerWorkspaceResult(staging, prepared.checkpointRef),
    input.rows.workspace,
  );
  assertCurrent();
  const held = await pinDirectory(parent, { label: "repository dependency publication" });
  try {
    assertCurrent();
    await fs.rename(staging, destination);
    requireDirectorySync(await syncDirectory(held.receipt), "Repository dependency publication");
  } finally {
    await held.close();
  }
}
