import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";

const key = "openclaw.test.sqliteWorkerFault";
const { entry, enabled: buffer, rules } = getEnvironmentData(key);
setEnvironmentData(key, undefined);
if (process.versions.bun) {
  const { ensureSqliteLibrarySelected } = await import("../../src/infra/bun-sqlite-library.ts");
  ensureSqliteLibrarySelected();
}
const { DatabaseSync, StatementSync } = await import("node:sqlite");
const enabled = new Int32Array(buffer);
const statements = new WeakMap();
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  statements.set(statement, {
    database: this,
    sql: sql.trimStart().toLowerCase().replaceAll('"', ""),
  });
  return statement;
};
const faults = rules.map((rule) => ({ ...rule, match: new RegExp(rule.pattern, rule.flags) }));
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  for (const [index, fault] of faults.entries()) {
    if (!Atomics.load(enabled, index) || !fault.pauseOnMatch || !fault.match.test(sql)) {
      continue;
    }
    const gate = new Int32Array(fault.pauseOnMatch);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    while (!Atomics.load(gate, 1)) {
      Atomics.wait(gate, 1, 0);
    }
    if (fault.errorOnResume) {
      throw new Error(fault.errorOnResume);
    }
  }
  return exec.call(this, sql);
};
function install(statement) {
  const prepared = statements.get(statement);
  if (!prepared) {
    return () => {};
  }
  const selected = faults.filter((fault, index) => {
    if (fault.pauseOnMatch || !Atomics.load(enabled, index) || !fault.match.test(prepared.sql)) {
      return false;
    }
    if ("exitOnMatch" in fault) {
      if (Atomics.sub(enabled, index, 1) === 1) {
        process.exit(1);
      }
      return false;
    }
    return true;
  });
  // TEMP triggers affect the actual write without invalidating the admitted main schema.
  for (const fault of selected) {
    prepared.database.exec(fault.sql);
  }
  return () => {
    for (const fault of selected.toReversed()) {
      prepared.database.exec(`DROP TRIGGER temp.${fault.name}`);
    }
  };
}
for (const method of ["run", "get", "all"]) {
  const original = StatementSync.prototype[method];
  StatementSync.prototype[method] = function (...args) {
    const restore = install(this);
    try {
      return Reflect.apply(original, this, args);
    } finally {
      restore();
    }
  };
}
const iterate = StatementSync.prototype.iterate;
StatementSync.prototype.iterate = function* (...args) {
  const restore = install(this);
  try {
    const iterator = Reflect.apply(iterate, this, args);
    try {
      yield* iterator;
    } finally {
      // yield* does not close its delegate when next() throws; reset the native statement.
      iterator.return?.();
    }
  } finally {
    restore();
  }
};
await import(entry);
