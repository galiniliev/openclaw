import { describe, expect, it } from "vitest";
import {
  createSessionEntryWithTranscript,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { readSessionCreationReceiptInWorker } from "../../config/sessions/session-creation-receipt-read.js";
import { createSessionTranscriptHeader } from "../../config/sessions/transcript-header.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL session creation receipts", () => {
  // This contract owns the agent writer; shared-state bootstrap is qualified separately.
  useMixedAgentPair("sqlite", "postgres");
  it("reopens the exact creation receipt and rolls back a competing row in its worker", async () => {
    const { path: storePath } = withEngineStoreAdmission(() =>
      openOpenClawAgentDatabase({ agentId: "main" }),
    );
    const scope = { agentId: "main", storePath };
    const operation = {
      digest: "postgres-creation",
      fingerprint: "original",
      authorization: { role: "operator", scopes: ["operator.write"] },
    };
    const create = (sessionKey: string) =>
      createSessionEntryWithTranscript(
        { ...scope, sessionKey },
        () => ({
          ok: true,
          entry: {
            sessionId: sessionKey,
            lifecycleRevision: "first-incarnation",
            updatedAt: Date.now(),
          },
        }),
        { creationOperation: operation },
      );
    const key = "agent:main:postgres-original";
    expect(await create(key)).toMatchObject({ ok: true });
    await closeOpenClawAgentDatabasesAsync();
    expect(
      await readSessionCreationReceiptInWorker(scope, operation.digest, () => {}),
    ).toMatchObject({
      receipt: { sessionKey: key, sessionId: key, lifecycleRevision: "first-incarnation" },
    });
    const competing = "agent:main:postgres-competing";
    await expect(create(competing)).rejects.toThrow();
    expect(
      withEngineStoreAdmission(() => loadSessionEntry({ ...scope, sessionKey: competing })),
    ).toBeUndefined();
  });
  it("serializes requested UUID claims and preserves an unexpired receipt after deletion", async () => {
    const { path: storePath } = withEngineStoreAdmission(() =>
      openOpenClawAgentDatabase({ agentId: "main" }),
    );
    const scope = { agentId: "main", storePath };
    const sessionId = randomUUID();
    const keys = ["agent:main:requested-one", "agent:main:requested-two"];
    const create = (sessionKey: string) =>
      createSessionEntryWithTranscript(
        { ...scope, sessionKey },
        () => ({
          ok: true,
          entry: { sessionId, lifecycleRevision: sessionKey, updatedAt: Date.now() },
          transcriptEvents: [createSessionTranscriptHeader({ sessionId })],
        }),
        {
          creationOperation: {
            digest: sessionKey,
            fingerprint: sessionId,
            requestedSessionId: sessionId,
            authorization: { role: "operator", scopes: ["operator.write"] },
          },
        },
      );
    const outcomes = await Promise.allSettled(keys.map(create));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = keys[outcomes.findIndex((result) => result.status === "fulfilled")]!;
    expect(await loadTranscriptEvents({ ...scope, sessionKey: winner, sessionId })).toHaveLength(1);
    await deleteSessionEntryLifecycle({
      ...scope,
      target: { canonicalKey: winner, storeKeys: [winner] },
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
    });
    await expect(create("agent:main:requested-after-delete")).rejects.toThrow();
    expect(await readSessionCreationReceiptInWorker(scope, winner, () => {})).toMatchObject({
      receipt: { sessionKey: winner, sessionId },
    });
    expect(await loadTranscriptEvents({ ...scope, sessionKey: winner, sessionId })).toEqual([]);
    for (const key of [...keys, "agent:main:requested-after-delete"]) {
      expect(
        withEngineStoreAdmission(() => loadSessionEntry({ ...scope, sessionKey: key })),
      ).toBeUndefined();
    }
  });
});
import { randomUUID } from "node:crypto";
