import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { SESSION_CREATE_IDEMPOTENCY_RETENTION_MS } from "../../../packages/gateway-protocol/src/session-limits.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { SESSION_CREATION_OPERATIONS_TABLE } from "../../state/openclaw-agent-creation-operations-schema.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { SESSION_TRANSCRIPT_ARCHIVES_TABLE } from "../../state/openclaw-agent-session-transcript-archive-schema.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  readExactSessionEntryRow,
  readSessionKeyBySessionIdInDatabase,
} from "./session-accessor.sqlite-entry-read.js";
import { hasStoredTranscriptEvents } from "./session-accessor.sqlite-transcript-presence.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import type {
  SessionCreationOperation,
  SessionCreationReceipt,
} from "./session-creation-operation.js";
import type { InternalSessionEntry } from "./types.js";

type Database = Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">;

/** The existing store writer serializes this fresh claim before any header or row changes. */
export function assertRequestedSessionCreationAvailable(
  database: Database,
  operation: SessionCreationOperation,
  sessionKey: string,
  entry: InternalSessionEntry,
): void {
  const sessionId = operation.requestedSessionId;
  if (sessionId === undefined) {
    return;
  }
  const query = getNodeSqliteKysely<DB>(database.db);
  if (
    entry.sessionId !== sessionId ||
    executeSqliteQueryTakeFirstSync(
      database.db,
      query.selectFrom("session_nodes").select("session_key").where("session_key", "=", sessionKey),
    ) ||
    readSessionKeyBySessionIdInDatabase(database, sessionId) !== undefined ||
    hasStoredTranscriptEvents(database, sessionId) ||
    readSessionColdTranscript(database.db, sessionId) ||
    (tableExists(database.db, SESSION_TRANSCRIPT_ARCHIVES_TABLE) &&
      executeSqliteQueryTakeFirstSync(
        database.db,
        query
          .selectFrom(SESSION_TRANSCRIPT_ARCHIVES_TABLE)
          .select("session_id")
          .where("session_id", "=", sessionId)
          .limit(1),
      )) ||
    executeSqliteQueryTakeFirstSync(
      database.db,
      query
        .selectFrom(SESSION_CREATION_OPERATIONS_TABLE)
        .select("operation_digest")
        .where("session_id", "=", sessionId)
        .where("expires_at", ">", Date.now())
        .limit(1),
    )
  ) {
    // Replays belong to the authenticated receipt owner, never UUID equality or adoption.
    const error = new Error("Requested session ID is unavailable; use a new session ID.");
    error.name = "SessionRequestedIdentityConflictError";
    throw error;
  }
}

/** The existing history worker reads receipts; absence never creates a database or table. */
export function readSessionCreationReceipt(
  database: Database,
  digest: string,
): { receipt: SessionCreationReceipt; entry?: InternalSessionEntry } | undefined {
  const { db } = database;
  if (!tableExists(db, SESSION_CREATION_OPERATIONS_TABLE)) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom(SESSION_CREATION_OPERATIONS_TABLE)
      .selectAll()
      .where("operation_digest", "=", digest),
  );
  if (!row || row.expires_at <= Date.now()) {
    return undefined;
  }
  const scopes = safeParseJson(row.scopes_json);
  if (
    !Array.isArray(scopes) ||
    !scopes.every((scope): scope is string => typeof scope === "string")
  ) {
    throw new Error("Invalid session creation receipt scopes");
  }
  const receipt: SessionCreationReceipt = {
    sessionKey: row.session_key,
    sessionId: row.session_id,
    lifecycleRevision: row.lifecycle_revision,
    fingerprint: row.request_fingerprint,
    authorization: { role: row.role, scopes },
    expiresAt: row.expires_at,
  };
  return { receipt, entry: readExactSessionEntryRow(database, row.session_key)?.entry };
}

/** Called only inside the transaction writing this exact session incarnation. Never grants authority. */
export function commitSessionCreationReceipt(
  database: Database,
  operation: SessionCreationOperation,
  sessionKey: string,
  entry: InternalSessionEntry,
): void {
  const query = getNodeSqliteKysely<DB>(database.db);
  const now = Date.now();
  executeSqliteQuerySync(
    database.db,
    query.deleteFrom(SESSION_CREATION_OPERATIONS_TABLE).where("expires_at", "<=", now),
  );
  // A collision rolls back the competing row as well. The request owner reconciles its receipt;
  // it must never overwrite the original binding or replay resource preparation in this writer.
  executeSqliteQuerySync(
    database.db,
    query.insertInto(SESSION_CREATION_OPERATIONS_TABLE).values({
      operation_digest: operation.digest,
      request_fingerprint: operation.fingerprint,
      session_key: sessionKey,
      session_id: entry.sessionId,
      lifecycle_revision: entry.lifecycleRevision ?? null,
      role: operation.authorization.role,
      scopes_json: JSON.stringify(operation.authorization.scopes),
      expires_at: now + SESSION_CREATE_IDEMPOTENCY_RETENTION_MS,
    }),
  );
}
