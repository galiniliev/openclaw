import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { insertRepositoryGitHubPublicationAsync } from "../gateway/github-publication-request-async.js";
import { readRepositoryGitHubPublicationAsync } from "../gateway/github-publication-store-async.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { preparePublicationSourceFixture } from "./github-publication.worker.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { ensureProfileForEmail } from "./user-profiles.js";

let context: OpenClawStateWorkerContext;
let root: string;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
    vi.unstubAllEnvs();
    cleanup();
  }),
);
beforeAll(() => {
  root = tempDirs.make("publication-source-progress-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const options = { env: { ...process.env, OPENCLAW_STATE_DIR: root } };
  openOpenClawStateDatabase(options);
  context = captureOpenClawStateWorkerContext(options);
});
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  setRuntimeConfigSnapshot({});
});
afterEach(() => clearRuntimeConfigSnapshot());

it.each(["runtime", "session progress", "unrelated profile"] as const)(
  "admits a publication after harmless %s facts without replacing its source",
  async (change) => {
    const { row, source } = await preparePublicationSourceFixture(
      context,
      `benign-source-${change.replaceAll(" ", "-")}`,
    );
    try {
      if (change === "runtime") {
        sessionChanges.emit({ all: true, scope: "runtime" });
      } else if (change === "session progress") {
        await upsertSessionEntryCore(
          { agentId: row.agent_id, sessionKey: row.session_key },
          { sessionId: row.session_id, updatedAt: 2000, displayName: "Current progress" },
        );
      } else {
        ensureProfileForEmail("unrelated-publication-profile@example.test");
      }
      await expect(insertRepositoryGitHubPublicationAsync(row, source)).resolves.toMatchObject({
        request_id: row.request_id,
        status: "requested",
      });
      expect(await readRepositoryGitHubPublicationAsync(row.request_id)).toMatchObject({
        request_id: row.request_id,
        status: "requested",
      });
    } finally {
      await source.release();
    }
  },
);
