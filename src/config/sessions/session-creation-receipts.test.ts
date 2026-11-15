import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { acquireStateDatabaseSchemaLease } from "../../infra/gateway-state-owner.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createSessionEntryWithTranscript,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { readSessionTranscriptArchiveResetInventory } from "./session-accessor.sqlite-archive-store-kernel.js";
import { readSessionKeyBySessionIdInDatabase } from "./session-accessor.sqlite-entry-read.js";
import { readTranscriptStorageRows } from "./session-accessor.sqlite-read.js";
import { readSessionCreationReceiptInWorker } from "./session-creation-receipt-read.js";
import { readSessionCreationReceipt } from "./session-creation-receipts.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";

it("commits the receipt with its original incarnation and rolls back a competing creation", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { path: storePath } = openOpenClawAgentDatabase({ agentId: "main" });
    const operation = {
      digest: "creation-once",
      fingerprint: "original",
      authorization: { role: "operator", scopes: ["operator.write"] },
    };
    const scope = { agentId: "main", storePath };
    const lookup = () => readSessionCreationReceiptInWorker(scope, operation.digest, () => {});
    expect(await lookup()).toBeUndefined();
    const create = (key: string, sessionId: string) =>
      createSessionEntryWithTranscript(
        { ...scope, sessionKey: key },
        () => ({
          ok: true,
          entry: { sessionId, lifecycleRevision: "incarnation-one", updatedAt: Date.now() },
        }),
        { creationOperation: operation },
      );
    const key = "agent:main:receipt-original";
    expect(await create(key, "original-id")).toMatchObject({ ok: true });
    await closeOpenClawAgentDatabasesAsync();
    expect(await lookup()).toMatchObject({
      receipt: { sessionKey: key, sessionId: "original-id", lifecycleRevision: "incarnation-one" },
      entry: { sessionId: "original-id" },
    });
    const competingKey = "agent:main:receipt-competing";
    await expect(create(competingKey, "competing-id")).rejects.toThrow();
    expect(loadSessionEntry({ ...scope, sessionKey: competingKey })).toBeUndefined();
    expect(await lookup()).toMatchObject({
      receipt: { sessionKey: key, sessionId: "original-id" },
    });
  }));

function requestedCreationFixture() {
  const { path: storePath } = openOpenClawAgentDatabase({ agentId: "main" });
  const scope = { agentId: "main", storePath };
  const database = () => openOpenClawAgentDatabase({ agentId: "main", path: storePath });
  const header = (sessionId: string) =>
    createSessionTranscriptHeader({
      sessionId,
      cwd: "/requested",
      timestamp: "2026-11-16T00:00:00Z",
    });
  return {
    scope,
    header,
    entry: (sessionKey: string) => loadSessionEntry({ ...scope, sessionKey }),
    events: (sessionId: string) => readTranscriptStorageRows(database(), sessionId),
    archives: () => readSessionTranscriptArchiveResetInventory(database()),
    owner: (sessionId: string) => readSessionKeyBySessionIdInDatabase(database(), sessionId),
    receipt: (digest: string) => readSessionCreationReceiptInWorker(scope, digest, () => {}),
    create: (sessionKey: string, requestedSessionId: string, digest = sessionKey) => {
      const creationOperation = {
        digest,
        fingerprint: `requested:${requestedSessionId}`,
        requestedSessionId,
        authorization: { role: "operator", scopes: ["operator.write"] },
      };
      return createSessionEntryWithTranscript(
        { ...scope, sessionKey },
        () => ({
          ok: true,
          entry: { sessionId: requestedSessionId, lifecycleRevision: digest, updatedAt: 1 },
          transcriptEvents: [header(requestedSessionId)],
        }),
        { creationOperation },
      );
    },
  };
}

it("commits the requested UUID, transcript header and receipt as one incarnation", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = requestedCreationFixture();
    const id = randomUUID(),
      key = "agent:main:requested";
    expect(await f.create(key, id)).toMatchObject({ ok: true, entry: { sessionId: id } });
    await closeOpenClawAgentDatabasesAsync();
    expect(f.entry(key)).toMatchObject({ sessionId: id, lifecycleRevision: key });
    expect(f.events(id).map((row) => JSON.parse(row.eventJson))).toEqual([f.header(id)]);
    expect(await f.receipt(key)).toMatchObject({
      receipt: { sessionKey: key, sessionId: id, lifecycleRevision: key },
    });
  }));

it.each(["key", "other-key", "retained-window", "transcript-only", "other-receipt"] as const)(
  "refuses requested physical identity occupied by %s without changing its row, header or receipt",
  (collision) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = requestedCreationFixture();
      const id = randomUUID(),
        origin = "agent:main:original",
        target = collision === "key" ? origin : "agent:main:target";
      if (collision === "retained-window") {
        replaceSessionEntrySync(
          { ...f.scope, sessionKey: origin },
          { sessionId: id, updatedAt: 1 },
        );
        replaceSessionEntrySync(
          { ...f.scope, sessionKey: origin },
          { sessionId: randomUUID(), updatedAt: 2 },
        );
        expect(f.owner(id)).toBe(origin);
        expect(f.events(id)).toEqual([]);
      } else if (collision === "transcript-only") {
        await createSessionEntryWithTranscript({ ...f.scope, sessionKey: origin }, () => ({
          ok: true,
          entry: { sessionId: id, updatedAt: 1 },
          transcriptEvents: [f.header(id)],
        }));
        await deleteSessionEntryLifecycle({
          ...f.scope,
          target: { canonicalKey: origin, storeKeys: [origin] },
          archiveTranscript: true,
        });
        expect(f.owner(id)).toBeUndefined();
        expect(f.events(id)).toEqual([]);
        expect(f.archives()).toMatchObject([{ session_id: id }]);
      } else {
        await f.create(origin, id, "accepted-original");
        if (collision === "other-receipt") {
          await deleteSessionEntryLifecycle({
            ...f.scope,
            target: { canonicalKey: origin, storeKeys: [origin] },
            archiveTranscript: false,
            deleteTranscriptWithoutArchive: true,
          });
          expect(f.entry(origin)).toBeUndefined();
          expect(f.owner(id)).toBeUndefined();
          expect(f.events(id)).toEqual([]);
          expect(await f.receipt("accepted-original")).toBeDefined();
        }
      }
      const before = {
        entry: f.entry(origin),
        owner: f.owner(id),
        events: f.events(id),
        archives: f.archives(),
        receipt: await f.receipt("accepted-original"),
      };
      await expect(f.create(target, id, "refused-operation")).rejects.toThrow();
      expect({
        entry: f.entry(origin),
        owner: f.owner(id),
        events: f.events(id),
        archives: f.archives(),
        receipt: await f.receipt("accepted-original"),
      }).toEqual(before);
      if (target !== origin) {
        expect(f.entry(target)).toBeUndefined();
      }
      expect(await f.receipt("refused-operation")).toBeUndefined();
    }),
);

it("commits exactly one of two actual writers requesting the same physical UUID", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = requestedCreationFixture(),
      id = randomUUID();
    const keys = ["agent:main:writer-one", "agent:main:writer-two"];
    const results = await Promise.allSettled(keys.map((key) => f.create(key, id)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = keys[results.findIndex((result) => result.status === "fulfilled")]!;
    expect(f.owner(id)).toBe(winner);
    expect(f.events(id).map((row) => JSON.parse(row.eventJson))).toEqual([f.header(id)]);
    for (const key of keys) {
      expect(f.entry(key)?.sessionId).toBe(key === winner ? id : undefined);
      expect((await f.receipt(key))?.receipt.sessionKey).toBe(key === winner ? winner : undefined);
    }
  }));

it("keeps native maintenance creation atomic when only an unexpired receipt owns the UUID", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = requestedCreationFixture(),
      id = randomUUID(),
      origin = "agent:main:native-original";
    const database = openOpenClawAgentDatabase({ agentId: "main", path: f.scope.storePath });
    const schemaLease = acquireStateDatabaseSchemaLease(database.path);
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => schemaLease.assertCurrent(),
      assertDatabaseAccess: schemaLease.assertDatabaseAccess,
    });
    try {
      await maintenance.run(async () => {
        expect(await f.create(origin, id)).toMatchObject({ ok: true });
        const receipt = readSessionCreationReceipt(database, origin);
        expect(receipt).toMatchObject({ receipt: { sessionKey: origin, sessionId: id } });
        expect(f.events(id).map((row) => JSON.parse(row.eventJson))).toEqual([f.header(id)]);
        await deleteSessionEntryLifecycle({
          ...f.scope,
          target: { canonicalKey: origin, storeKeys: [origin] },
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
        });
        expect(f.owner(id)).toBeUndefined();
        expect(f.events(id)).toEqual([]);
        const target = "agent:main:native-competing";
        await expect(f.create(target, id)).rejects.toThrow();
        expect(f.entry(target)).toBeUndefined();
        expect(f.events(id)).toEqual([]);
        expect(readSessionCreationReceipt(database, origin)).toEqual({
          receipt: receipt!.receipt,
          entry: undefined,
        });
        expect(readSessionCreationReceipt(database, target)).toBeUndefined();
      });
    } finally {
      try {
        await maintenance.close();
      } finally {
        schemaLease.release();
      }
    }
  }));
