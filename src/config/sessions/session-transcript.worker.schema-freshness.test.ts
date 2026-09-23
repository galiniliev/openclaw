import { expect, it, vi } from "vitest";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import * as readerLifecycle from "../../infra/sqlite-reader-lifecycle.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import type { SessionTranscriptWorkerInput } from "./session-transcript-worker.types.js";

const worker = vi.hoisted(() => ({
  read: vi.fn<(input: SessionTranscriptWorkerInput) => Promise<unknown>>(),
  close: vi.fn<(key?: string) => void>(),
}));
vi.mock("../../infra/worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/worker-task-server.js")>()),
  serveOwnedWorkerTasks(
    handler: (input: unknown) => Promise<unknown>,
    options: { closeResource: (key?: string) => void },
  ) {
    worker.read.mockImplementation(handler);
    worker.close.mockImplementation(options.closeResource);
  },
}));
import "./session-transcript.worker.js";

it.each([
  { change: "newer schema", sql: "PRAGMA user_version = 999", error: /newer schema version/ },
  {
    change: "missing table",
    sql: "DROP TABLE session_nodes",
    error: /Session metadata unavailable.*table-missing/,
  },
  {
    change: "ordinary commit",
    sql: "UPDATE schema_meta SET updated_at = updated_at + 1 WHERE meta_key = 'primary'",
    error: undefined,
  },
])("revalidates a warm worker listing after a foreign $change", async ({ sql, error }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const { path } = openOpenClawAgentDatabase(options);
    const sessionKey = "agent:main:main";
    replaceSessionEntrySync(
      { ...options, sessionKey },
      { sessionId: "retained-listing", updatedAt: 1 },
    );
    // The registered handler must use its real retained read-only scope, not a host writer.
    await closeOpenClawAgentDatabaseByPathAsync(path);
    const database = { agentId: "main", path };
    const request: SessionTranscriptWorkerInput = {
      kind: "session-entry-list",
      database,
      scope: { ...options, storePath: path, projection: "list" },
    };
    const expected = {
      ok: true,
      value: {
        kind: "session-entry-list",
        entries: [{ sessionKey, entry: { sessionId: "retained-listing" } }],
      },
    };
    const opens = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    const countOpens = () => opens.mock.calls.filter(([filename]) => filename === path).length;
    // Only the schema-probe turn is held; native SQLite and snapshot/reader owners stay real.
    vi.useFakeTimers({ toFake: ["setImmediate"] });
    let pending: Promise<unknown> | undefined;
    try {
      await expect(worker.read(request)).resolves.toMatchObject(expected);
      expect(countOpens()).toBe(1);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      // A raw native peer reproduces a different worker/process: no local schema publication.
      const writer = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(path);
      try {
        writer.exec(sql);
      } finally {
        writer.close();
      }

      const entered = createDeferredCore();
      const withOwner = readerLifecycle.withSqliteReaderOwner;
      vi.spyOn(readerLifecycle, "withSqliteReaderOwner").mockImplementation((owner, operation) => {
        try {
          return withOwner(owner, operation);
        } finally {
          if (owner.operation === "sessions.session-entry-list") {
            entered.resolve();
          }
        }
      });
      pending = worker.read(request);
      // Observe the real read boundary without replacing its callback or expiring the probe.
      await entered.promise;
      expect(countOpens()).toBe(1);
      vi.runOnlyPendingTimers();
      if (error) {
        await expect(pending).resolves.toMatchObject({
          ok: false,
          error: { kind: "read-error", message: expect.stringMatching(error) },
        });
      } else {
        await expect(pending).resolves.toMatchObject(expected);
      }
      // Refresh the retained admission, rather than hiding the bug with a cold reader.
      expect(countOpens()).toBe(1);
    } finally {
      vi.runOnlyPendingTimers();
      await Promise.allSettled([pending]);
      vi.useRealTimers();
      vi.restoreAllMocks();
      worker.close(JSON.stringify([{ path }]));
    }
  });
});
