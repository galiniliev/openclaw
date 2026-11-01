import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  installDatabaseEngineSelection,
  setDatabaseEngineReadOnlyAdmission,
} from "./database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "./database-engine/context.test-support.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { acquireSqliteStagingToken, SqliteStagingRetiredError } from "./sqlite-staging-token.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("retires an owned private capture token while keeping portable files read-only", () => {
  const directory = tempDirs.make("sqlite-staging-token-fenced-");
  const source = path.join(tempDirs.make("sqlite-staging-source-"), "source.sqlite");
  using original = openNodeSqliteDatabase(source);
  original.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('preserved')");
  installDatabaseEngineSelection({ effectiveEngines: resolveDatabaseFamilyEngines({}) });
  setDatabaseEngineReadOnlyAdmission(true);
  try {
    const token = acquireSqliteStagingToken(directory, "create");
    token(true);
    expect(() => acquireSqliteStagingToken(directory, "read")).toThrow(SqliteStagingRetiredError);
    using guarded = openNodeSqliteDatabase(source);
    expect(guarded.prepare("SELECT value FROM retained").get()).toEqual({ value: "preserved" });
    expect(() => guarded.exec("INSERT INTO retained VALUES('forbidden')")).toThrow(
      /readonly|read.only/i,
    );
  } finally {
    resetDatabaseEngineSelectionForTest();
  }
});

it("keeps read custody after creator release and rejects late readers after retirement", () => {
  const directory = tempDirs.make("sqlite-staging-token-");
  const creator = acquireSqliteStagingToken(directory, "create");
  const reader = acquireSqliteStagingToken(directory, "read");
  try {
    creator();
    expect(() => acquireSqliteStagingToken(directory, "reclaim")).toThrow(/locked|busy/i);
  } finally {
    reader();
    creator();
  }
  const retirement = acquireSqliteStagingToken(directory, "reclaim");
  retirement(true);
  expect(() => acquireSqliteStagingToken(directory, "read")).toThrow(SqliteStagingRetiredError);
  expect(() => acquireSqliteStagingToken(directory, "create")).toThrow(SqliteStagingRetiredError);
  // Interrupted payload removal can reacquire an already committed retirement.
  acquireSqliteStagingToken(directory, "reclaim")(true);
});

it("refuses an existing WAL token even when acquired by a creator", () => {
  const directory = tempDirs.make("sqlite-staging-token-wal-");
  const database = openNodeSqliteDatabase(path.join(directory, "owner.sqlite"));
  database.exec("PRAGMA journal_mode=WAL; CREATE TABLE payload (value TEXT)");
  database.close();
  expect(() => acquireSqliteStagingToken(directory, "create")).toThrow(
    "SQLite snapshot token journal mode is unknown",
  );
});
