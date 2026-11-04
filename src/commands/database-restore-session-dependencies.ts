import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { readResolvedSessionEntryInWorker } from "../config/sessions/session-accessor.entry-read-runtime.js";
import {
  parkRetainedWorkspaceOwnerInDatabase,
  restoreMissingRetainedWorkspaceOwnerInDatabase,
} from "../gateway/worker-environments/retained-workspace-owner-repair.kernel.js";
import { createWorkerEnvironmentStoreKernel } from "../gateway/worker-environments/store.kernel.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import { ensureSkillLibrarySchema } from "../skills/library/store.js";
import { ensureSessionRepositoryWorkspaceSchema } from "../state/openclaw-state-db-schema-additive.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readRetainedWorkspaceAuthority } from "../state/retained-workspace-authority.js";
import { ensureUserProfilesSchema } from "../state/user-profiles-schema.js";
import { readConfigSnapshotForEngineSelection } from "./config-preflight-snapshot.js";
import {
  prepareSessionDependencyArtifacts,
  publishSessionDependencyArtifacts,
} from "./database-restore-session-dependencies.artifacts.js";
import { readSessionDependencyInput } from "./database-restore-session-dependencies.input.js";
import { restoreSessionDependencyRows } from "./database-restore-session-dependencies.kernel.js";
import {
  assertRetainedDependencySession,
  currentRetainedDependencyProfile,
} from "./database-restore-session-dependencies.retained.js";

/** Offline operator repair; never borrow a serving Gateway's database authority. */
export async function restoreSessionDependencies(options: { input: string; sha256: string }) {
  try {
    const input = await readSessionDependencyInput(options.input, options.sha256);
    const artifacts =
      input.request.version !== 2 ? await prepareSessionDependencyArtifacts(input) : undefined;
    const snapshot = await readConfigSnapshotForEngineSelection();
    if (!snapshot.valid) {
      throw new Error("Current configuration is not valid for dependency restoration.");
    }
    return await runWithLocalStateOwner({
      method: "database.restore-session-dependencies",
      params: {},
      target: resolveOpenClawStateSqlitePath(process.env),
      onForeignOwner: "refuse",
      databaseEngine: "configured",
      runLocal: async ({ env, config, assertCurrent }) => {
        const assertSessionTarget = async () => {
          if (input.request.version !== 3) {
            return;
          }
          const entry = await readResolvedSessionEntryInWorker({
            cfg: config,
            env,
            agentId: input.request.agentId,
            sessionKey: input.request.sessionKey,
          });
          assertCurrent();
          assertRetainedDependencySession(entry, input.request);
        };
        const retainedProfile =
          input.request.version === 3 && input.retained
            ? currentRetainedDependencyProfile(config, env, input.request.expected, input.retained)
            : undefined;
        await assertSessionTarget();
        const database = withEngineStoreAdmission(() => openOpenClawStateDatabase({ env }));
        await using resources = {
          database,
          async [Symbol.asyncDispose]() {
            await closeOpenClawStateDatabaseAsync();
          },
        };
        if (input.request.version !== 2) {
          withEngineStoreAdmission(() => {
            ensureUserProfilesSchema({ env, database: resources.database });
            ensureSkillLibrarySchema({ env, database: resources.database }, () => assertCurrent());
            ensureSessionRepositoryWorkspaceSchema(resources.database.db);
          });
        }
        const environments =
          input.request.version === 3
            ? withEngineStoreAdmission(() =>
                createWorkerEnvironmentStoreKernel(resources.database, Date.now),
              )
            : undefined;
        if (artifacts) {
          await publishSessionDependencyArtifacts(
            input,
            artifacts,
            database.path,
            env,
            assertCurrent,
          );
        }
        await assertSessionTarget();
        assertCurrent();
        const result = withEngineStoreAdmission(() =>
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              assertCurrent();
              if (input.request.version === 1) {
                return restoreSessionDependencyRows(db, input.rows, input.request);
              }
              if (input.request.version === 3) {
                if (!input.retained || !retainedProfile || !environments) {
                  throw new Error("Retained recovery source or current profile was not prepared.");
                }
                const restored = restoreSessionDependencyRows(db, input.rows, input.request);
                const owner = {
                  agentId: input.request.agentId,
                  sessionKey: input.request.sessionKey,
                  sessionId: input.request.expected.sessionId,
                };
                return {
                  ...restored,
                  retainedOwnerRepair: restoreMissingRetainedWorkspaceOwnerInDatabase(
                    db,
                    {
                      owner,
                      ...input.retained,
                      profileId: input.request.expected.profileId,
                      profileSnapshot: retainedProfile,
                      providerScope: input.request.expected.providerScope,
                    },
                    environments.createIntent,
                    Date.now(),
                  ),
                };
              }
              const verified = restoreSessionDependencyRows(db, input.rows, input.request, {
                verifyOnly: true,
              });
              if (!input.rows.workspace.disk_authority_json) {
                throw new Error("Selected original workspace has no retained disk authority.");
              }
              const disk = readRetainedWorkspaceAuthority(input.rows.workspace.disk_authority_json);
              const parked = parkRetainedWorkspaceOwnerInDatabase(
                db,
                {
                  ...input.request.expected,
                  workspaceId: input.request.workspaceId,
                  agentId: input.request.agentId,
                  sessionKey: input.request.sessionKey,
                  expectedDiskAuthority: disk,
                },
                Date.now(),
              );
              return {
                ...verified,
                retainedOwnerRepair: {
                  version: 1,
                  status: parked.changed ? "parked" : "already-parked",
                  ...parked,
                  identity: disk.identity,
                  workspaceDir: disk.workspaceDir,
                  originalDiskOwnerEpoch: disk.ownerEpoch,
                  cleanupDisarmed: true,
                  executionReady: false,
                },
              };
            },
            { env, database: resources.database },
            { operationLabel: "session-dependencies.restore" },
          ),
        );
        return {
          ok: true,
          sourceSha256: input.sourceSha256,
          sourceProfileId: input.request.sourceProfileId,
          currentProfileId: input.request.currentProfileId,
          skillId: input.request.skillId,
          skillRevision: input.request.skillRevision,
          workspaceId: input.request.workspaceId,
          ...result,
        };
      },
    });
  } catch (error) {
    throw new Error(
      `Session dependency restoration failed: ${formatErrorMessageWithCode(error).slice(0, 2048)}`,
      { cause: error },
    );
  }
}
