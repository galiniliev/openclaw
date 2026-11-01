import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const SESSION_CREATION_OPERATIONS_TABLE = "session_creation_operations";

export const ensureSessionCreationOperationsSchema = createSqliteSchemaEnsurer(
  () =>
    extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, SESSION_CREATION_OPERATIONS_TABLE, {
      endMarker: "-- END SESSION CREATION OPERATIONS",
      includeEndMarker: false,
      errorMessage: "Native creation operation schema markers are missing.",
    }),
  {
    tables: [SESSION_CREATION_OPERATIONS_TABLE],
    indexes: ["idx_agent_session_creation_operations_expiry"],
  },
);
