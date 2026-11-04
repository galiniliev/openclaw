import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { insertRepositoryGitHubPublicationAsync } from "../../gateway/github-publication-request-async.js";
import {
  bindGitHubPublicationSource,
  prepareGitHubPublicationSource,
} from "../../gateway/github-publication-source.js";
import { listRepositoryGitHubPublicationsInDatabase } from "../../gateway/github-repository-publication-read.worker.js";
import { repositoryGitHubPublicationDigest } from "../../gateway/github-repository-publication.kernel.js";
import { waitForPublicationGate } from "../../state/github-publication-fixtures.test-support.js";
import { createGitHubPublicationWorkerScope } from "../../state/github-publication-worker.js";
import {
  publicationCommand,
  repositoryRow,
} from "../../state/github-publication.worker.test-support.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createSessionRepositoryWorkspaceInDatabase } from "../../state/session-repository-workspaces.kernel.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import {
  mixedAgentConnection,
  mixedAgentPairs,
  useMixedAgentPair,
} from "./mixed-agent.conformance.test-support.js";
import { getPostgresPhysicalFactsForPath } from "./physical-facts.js";

afterEach(() => vi.restoreAllMocks());
describe.skipIf(!mixedAgentConnection).each(mixedAgentPairs)(
  "state=$stateEngine agent=$agentEngine publication conformance",
  ({ stateEngine, agentEngine }) => {
    const commitGate = new Int32Array(new SharedArrayBuffer(8));
    const commitFault = useSqliteWorkerFault([
      { match: /^COMMIT$/, pauseOnMatch: commitGate.buffer },
      {
        match: /^COMMIT$/,
        pauseOnMatch: commitGate.buffer,
        errorOnResume: "fixture commit rollback",
      },
    ]);
    useMixedAgentPair(stateEngine, agentEngine);
    async function fixture() {
      await captureRuntimeConfigAsyncReader()();
      const row = repositoryRow(randomUUID());
      row.session_id = row.request_id;
      row.session_key = `agent:main:${row.request_id}`;
      const workspace = withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(({ db }) =>
          createSessionRepositoryWorkspaceInDatabase(
            db,
            {
              agentId: row.agent_id,
              sessionKey: row.session_key,
              url: "https://github.com/example/repository",
              branch: row.branch,
            },
            1000,
          ),
        ),
      );
      row.workspace_id = workspace.workspaceId;
      const entry = await upsertSessionEntryCore(
        { agentId: row.agent_id, sessionKey: row.session_key },
        { sessionId: row.session_id, updatedAt: 1000, repositoryWorkspaceId: row.workspace_id },
      );
      row.session_lifecycle_revision = entry!.lifecycleRevision ?? null;
      row.request_digest = repositoryGitHubPublicationDigest(row);
      const controller = new AbortController();
      const prepare = () =>
        prepareGitHubPublicationSource({
          sourcePath: resolveOpenClawAgentSqlitePath({ agentId: row.agent_id }),
          selector: {
            agentId: row.agent_id,
            sessionKey: row.session_key,
            sessionId: row.session_id,
            lifecycleRevision: row.session_lifecycle_revision,
            repositoryWorkspaceId: row.workspace_id,
            repositoryBranch: row.branch,
          },
          signal: controller.signal,
          assertCurrent() {},
        });
      const source = await prepare();
      const read = () =>
        withEngineStoreAdmission(() =>
          listRepositoryGitHubPublicationsInDatabase(openOpenClawStateDatabase().db, {
            idempotencyKey: row.idempotency_key,
          }),
        );
      return { row, source, controller, read, prepare };
    }

    it("prepares the configured source and commits its publication and checkpoint", async () => {
      const { row, source, read, prepare } = await fixture();
      const checkpoint = {
        checkpoint_ref: row.checkpoint_ref,
        checkpoint_digest: row.checkpoint_digest,
        source_head_commit: row.source_head_commit,
        source_index_tree: row.source_index_tree,
        workspace_tree: row.workspace_tree,
      };
      row.checkpoint_ref = null;
      row.checkpoint_digest = null;
      row.request_digest = repositoryGitHubPublicationDigest(row);
      try {
        expect(bindGitHubPublicationSource(source).predicate.expected.entry).toMatchObject({
          sessionId: row.session_id,
          repositoryWorkspaceId: row.workspace_id,
        });
        expect(await insertRepositoryGitHubPublicationAsync(row, source)).toMatchObject({
          request_id: row.request_id,
          session_id: row.session_id,
          status: "requested",
        });
        expect(read()).toHaveLength(1);
        const checkpointSource = await prepare();
        const scope = createGitHubPublicationWorkerScope(
          bindGitHubPublicationSource(checkpointSource).context,
        );
        try {
          await scope.mutate(
            publicationCommand({ operation: "checkpoint", row, checkpoint }),
            scope.assertCurrent,
            () => {},
            checkpointSource,
          );
          expect(read()).toEqual([expect.objectContaining(checkpoint)]);
        } finally {
          await scope.close();
          await checkpointSource.release();
        }
      } finally {
        await source.release();
      }
    });

    it.for(["commit", "rollback"] as const)(
      "holds the source through real engine %s and releases after settlement",
      async (settlement, { signal }) => {
        const { row, source, controller, read } = await fixture();
        const binding = bindGitHubPublicationSource(source);
        const stateFacts = getPostgresPhysicalFactsForPath(binding.context.admission.databasePath);
        const sourcePath = resolveOpenClawAgentSqlitePath({ agentId: row.agent_id });
        const agentFacts = getPostgresPhysicalFactsForPath(sourcePath);
        const schema = stateFacts && `"${stateFacts.namespace.replaceAll('"', '""')}"`;
        const gate = 2147483647;
        const admin = new Client({ connectionString: mixedAgentConnection });
        await admin.connect();
        let inserting: ReturnType<typeof insertRepositoryGitHubPublicationAsync> | undefined;
        const competitor = agentFacts ? undefined : openNodeSqliteDatabase(sourcePath);
        competitor?.exec("PRAGMA busy_timeout = 0");
        try {
          // Pause the real engine COMMIT after the fence accepts custody.
          commitGate.fill(0);
          if (schema) {
            await admin.query(`CREATE FUNCTION ${schema}.publication_commit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(${gate});
          ${settlement === "rollback" ? "RAISE EXCEPTION 'fixture commit rollback';" : "RETURN NEW;"} END $$;
          CREATE CONSTRAINT TRIGGER publication_commit_gate AFTER INSERT ON ${schema}.github_repository_publication_requests
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${schema}.publication_commit_gate()`);
            await admin.query("SELECT pg_advisory_lock($1)", [gate]);
          } else {
            commitFault.enable(settlement === "rollback" ? 1 : 0);
          }
          inserting = insertRepositoryGitHubPublicationAsync(row, source);
          let earlyFailure: Error | undefined;
          void inserting.catch((error: unknown) => {
            earlyFailure = error instanceof Error ? error : new Error(String(error));
          });
          const observedCommit = async () => {
            if (!schema) {
              const waiting = Atomics.waitAsync(commitGate, 0, 0);
              if (waiting.async) {
                await waiting.value;
              }
              expect(Atomics.load(commitGate, 0)).toBe(1);
              return;
            }
            for (;;) {
              signal.throwIfAborted();
              if (earlyFailure) {
                throw earlyFailure;
              }
              const { rows } = await admin.query<{ waiting: boolean }>(
                "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND NOT granted) AS waiting",
                [gate],
              );
              if (rows[0]?.waiting) {
                return;
              }
            }
          };
          await waitForPublicationGate(signal, inserting, observedCommit());
          if (agentFacts) {
            const key = createHash("sha256")
              .update(agentFacts.storeId)
              .digest()
              .readBigInt64BE()
              .toString();
            expect(
              (await admin.query("SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired", [key]))
                .rows,
            ).toEqual([{ acquired: false }]);
          } else {
            expect(() => competitor!.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
          }
          expect(read()).toEqual([]);
          controller.abort(new Error("revoked after acceptance"));
          await admin.query("SELECT pg_advisory_unlock($1)", [gate]);
          commitFault.disable();
          Atomics.store(commitGate, 1, 1);
          Atomics.notify(commitGate, 1);
          if (settlement === "commit") {
            await expect(inserting).resolves.toMatchObject({ request_id: row.request_id });
            expect(read()).toHaveLength(1);
          } else {
            await expect(inserting).rejects.toThrow("fixture commit rollback");
            expect(read()).toEqual([]);
          }
          // A real source mutation now succeeds, demonstrating release after settlement.
          await upsertSessionEntryCore(
            { agentId: row.agent_id, sessionKey: row.session_key },
            { archivedAt: 3000 },
          );
        } finally {
          commitFault.disable();
          Atomics.store(commitGate, 1, 1);
          Atomics.notify(commitGate, 1);
          await admin.query("SELECT pg_advisory_unlock_all()");
          await inserting?.catch(() => {});
          if (schema) {
            await admin.query(
              `DROP TRIGGER IF EXISTS publication_commit_gate ON ${schema}.github_repository_publication_requests; DROP FUNCTION IF EXISTS ${schema}.publication_commit_gate()`,
            );
          }
          await admin.end();
          competitor?.close();
          await source.release();
        }
      },
    );

    it("refuses revoked or changed source authority without committing a publication", async () => {
      for (const mutation of ["revoke", "session"] as const) {
        const { row, source, controller, read } = await fixture();
        try {
          if (mutation === "revoke") {
            controller.abort(new Error("fixture revoked source"));
          } else {
            await upsertSessionEntryCore(
              { agentId: row.agent_id, sessionKey: row.session_key },
              { archivedAt: 2000 },
            );
          }
          await expect(insertRepositoryGitHubPublicationAsync(row, source)).rejects.toThrow(
            /revoked|changed|expired/,
          );
          expect(read()).toEqual([]);
        } finally {
          await source.release();
        }
      }
    });
  },
);
