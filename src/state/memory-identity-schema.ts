import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const START = "CREATE TABLE IF NOT EXISTS memory_principals (";
// Native conversation receipts are a separately owned, first-use schema. Keep
// them out of identity setup so a channel adapter remains responsible for
// creating its evidence table only when it actually admits a conversation.
const END = "-- Native-channel evidence is distinct from sender/profile bindings and from";

function extractSchema(): string {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(START);
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(END, start);
  if (start < 0 || end <= start) {
    throw new Error("memory identity schema markers are missing");
  }
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end).trim();
}

export const MEMORY_IDENTITY_SCHEMA_SQL = extractSchema();
