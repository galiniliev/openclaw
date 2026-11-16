// Public-source-only StoreSchema data for the one-time G119 -> Main7 migration.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import vm from "node:vm";

const pins = {
  source: "fdd4a988929c653a24f1ac791837d65f98f7a0ec",
  target: "88e813334f08ac0abb4171f199819d15271f40e2",
};
const appVersion = "2026.11.3";
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert(
    ["--repo", "--out"].includes(process.argv[i]) && process.argv[i + 1],
    "Use --repo PATH --out DIRECTORY",
  );
  assert(!args.has(process.argv[i]), "Duplicate argument");
  args.set(process.argv[i], process.argv[i + 1]);
}
const repo = args.get("--repo"),
  out = args.get("--out");
assert(repo && out, "Use --repo PATH --out DIRECTORY");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...argv) =>
  execFileSync("git", ["-C", repo, ...argv], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const sourceHashes = {};
const read = (role, file) => {
  const text = git("show", `${pins[role]}:${file}`);
  sourceHashes[`${role}:${file}`] = sha(text);
  return text;
};
const generated = (role, file) => {
  const text = read(role, `src/state/postgres-schema.generated/${file}`);
  return vm.runInNewContext(
    `(${text
      .slice(text.indexOf("= {") + 2)
      .trim()
      .replace(/;$/, "")})`,
    {},
    { timeout: 10_000 },
  );
};
const context = vm.createContext({});
const pure = (role, file, names, from) => {
  let text = read(role, file);
  if (from) {
    const at = text.indexOf(from);
    assert(at >= 0 && text.indexOf(from, at + 1) === -1, "Pure owner boundary changed");
    text = text.slice(at);
  }
  text = text.replace(/^import[\s\S]*?;\n/gm, "").replace(/\bexport /g, "");
  return vm.runInContext(
    `(() => {${stripTypeScriptTypes(text)};return {${names.join(",")}};})()`,
    context,
    { timeout: 10_000 },
  );
};
context.splitSqlList = pure("source", "src/infra/sqlite-schema-sql.ts", [
  "splitSqlList",
]).splitSqlList;
const retention = pure("source", "src/state/openclaw-state-db-schema-v37-worker-retention.ts", [
  "withStateWorkerRetentionLayout",
  "WORKER_RETENTION_COLUMNS",
]);
const layouts = new Map(
  [...new Set(retention.WORKER_RETENTION_COLUMNS.map(([table]) => table))].map((table) => [
    table,
    "qualified-v33",
  ]),
);
const fragments = (items, transform = (sql) => sql) =>
  items.map((fragment) => ({
    id: fragment.id,
    tables: fragment.tables,
    sql: transform(fragment.sql),
    dependencies: fragment.dependencies,
    activation: fragment.activation,
  }));
const versions = {};
for (const role of ["source", "target"]) {
  const text = read(role, "src/state/openclaw-schema-versions.ts");
  versions[role] = {
    state: Number(text.match(/export const OPENCLAW_STATE_SCHEMA_VERSION = (\d+);/)?.[1]),
    agent: Number(text.match(/export const OPENCLAW_AGENT_SCHEMA_VERSION = (\d+);/)?.[1]),
  };
}
assert.deepEqual(versions, { source: { state: 37, agent: 39 }, target: { state: 41, agent: 42 } });
assert.equal(JSON.parse(read("target", "package.json")).version, appVersion);
const schemas = { source: {}, target: {} };
for (const role of ["source", "target"]) {
  const state = generated(role, "runtime.ts");
  const adapt =
    role === "source"
      ? (sql) => retention.withStateWorkerRetentionLayout(sql, layouts)
      : (sql) => sql;
  schemas[role].state = {
    id: "state",
    version: versions[role].state,
    sqlite: "",
    postgres: adapt(state.eagerSql),
    postgresFragments: fragments(state.fragments, adapt),
  };
  const agent = generated(role, "agent-runtime.ts"),
    search = generated(role, "agent-search-runtime.ts");
  schemas[role].agent = {
    id: "agent",
    version: versions[role].agent,
    sqlite: "",
    postgres: `${agent.sql}\n${search.sql}`,
    postgresVectorDecoderVersion: 2,
    postgresVectorSearchVersion: 2,
    postgresTextSearchVersion: 2,
    search: pure(role, "src/state/openclaw-agent-search-schema.ts", ["agentTranscriptSearchSchema"])
      .agentTranscriptSearchSchema,
  };
}
const helpers = {};
for (const spec of [
  [
    "creation-operations",
    "const postgresObjects =",
    "withoutAgentPostgresCreationOperations",
    "agentCreationOperationsPostgresMigration",
  ],
  [
    "active-event-facts",
    "const postgresObjects =",
    "withoutAgentPostgresActiveEventFacts",
    "agentActiveEventFactsPostgresMigration",
  ],
  [
    "tool-usage",
    "const postgresTable =",
    "withoutAgentPostgresToolUsage",
    "agentToolUsagePostgresMigration",
  ],
]) {
  Object.assign(
    helpers,
    pure("target", `src/state/openclaw-agent-${spec[0]}-schema.ts`, spec.slice(2), spec[1]),
  );
}
const agentPostgresSql = schemas.target.agent.postgres;
const agentPostgresV41Sql = helpers.withoutAgentPostgresToolUsage(agentPostgresSql);
const agentPostgresV40Sql = helpers.withoutAgentPostgresActiveEventFacts(agentPostgresV41Sql);
const agentPostgresV39Sql = helpers.withoutAgentPostgresCreationOperations(agentPostgresV40Sql);
assert.equal(
  helpers.withoutAgentPostgresCreationOperations(schemas.source.agent.postgres),
  agentPostgresV39Sql,
  "G119 differs from canonical39 beyond the old receipt table/expiry index",
);
Object.assign(context, helpers, {
  VERSION: appVersion,
  agentPostgresSql,
  agentPostgresV39Sql,
  agentPostgresV40Sql,
  agentPostgresV41Sql,
  AGENT_CREATION_OPERATIONS_SCHEMA_VERSION: 40,
  AGENT_ACTIVE_EVENT_FACTS_SCHEMA_VERSION: 41,
  AGENT_TOOL_USAGE_SCHEMA_VERSION: 42,
});
const engine = read("target", "src/state/openclaw-agent-db-engine.ts");
const recipe = (constant) => {
  const marker = `version: ${constant},`,
    at = engine.indexOf(marker);
  assert(at >= 0 && engine.indexOf(marker, at + 1) === -1, "Canonical recipe entry changed");
  const start = engine.lastIndexOf("{", at);
  let depth = 0,
    quote,
    end;
  for (let i = start; i < engine.length; i++) {
    const char = engine[i];
    if (quote) {
      if (char === "\\") {
        i++;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (["'", '"', "`"].includes(char)) {
      quote = char;
    } else if (char === "{") {
      depth++;
    } else if (char === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  assert(end, "Unterminated canonical recipe entry");
  return vm.runInContext(`(${engine.slice(start, end)})`, context, { timeout: 10_000 });
};
schemas.target.agent.postgresMigrations = [
  recipe("AGENT_CREATION_OPERATIONS_SCHEMA_VERSION"),
  recipe("AGENT_ACTIVE_EVENT_FACTS_SCHEMA_VERSION"),
  recipe("AGENT_TOOL_USAGE_SCHEMA_VERSION"),
];
assert.deepEqual(
  Array.from(schemas.target.agent.postgresMigrations, (step) => step.version),
  [40, 41, 42],
);
for (const [index, before] of [
  agentPostgresV39Sql,
  agentPostgresV40Sql,
  agentPostgresV41Sql,
].entries()) {
  const step = schemas.target.agent.postgresMigrations[index];
  assert.equal(step.fromSchema.postgres, before);
  assert.equal(
    step.schema.postgres,
    [agentPostgresV40Sql, agentPostgresV41Sql, agentPostgresSql][index],
  );
}
for (const role of ["source", "target"]) {
  for (const schema of Object.values(schemas[role])) {
    assert(
      !Object.hasOwn(schema, "searchExtensions"),
      "Actual search extensions belong to the native metadata owner",
    );
    const all = schema.postgresFragments ?? [],
      ids = new Set(all.map((fragment) => fragment.id));
    assert.equal(ids.size, all.length);
    for (const fragment of all) {
      assert(["first-use", "version-additive"].includes(fragment.activation));
      assert(fragment.dependencies.every((id) => ids.has(id)));
    }
  }
}
const bytes = `${JSON.stringify(schemas, null, 2)}\n`;
// Rehearsal-only historical DDL. Create this fresh, then let Native verify and seal it;
// never edit an installed store's seal to manufacture a historical fixture.
const searchOwner = pure("source", "src/infra/database-engine/postgres-search-schema.ts", [
  "postgresSearchSql",
]);
const memoryOwner = pure("source", "packages/memory-host-sdk/src/host/memory-search-schema.ts", [
  "memoryTextSearchSchema",
  "memoryStandingIntentSearchSchema",
]);
const extensions = {
  "standing-intents": memoryOwner.memoryStandingIntentSearchSchema,
  memory: memoryOwner.memoryTextSearchSchema("unicode61"),
};
const shared = { text: false, vector: false };
const sourceAgent = schemas.source.agent;
const richSql = [
  sourceAgent.postgres,
  ...[sourceAgent.search, ...Object.values(extensions)].map((definition) => {
    const sql = searchOwner.postgresSearchSql(definition, "openclaw_schema", shared, 2, 2, 2);
    shared.text ||= Object.keys(definition.text ?? {}).length > 0;
    shared.vector ||=
      definition.mode !== "keyword-only" && Object.keys(definition.vector ?? {}).length > 0;
    return `;\n${sql}`;
  }),
].join("\n");
assert.equal(sha(richSql), "e5ecf166cba0f6cd1f0164ca6582a0b46a23d5eb723ada22a2dda88cbcf55846");
const manifest = {
  format: "openclaw-one-time-schema-descriptors-v1",
  pins,
  appVersion,
  trees: Object.fromEntries(
    Object.entries(pins).map(([role, commit]) => [
      role,
      git("rev-parse", `${commit}^{tree}`).trim(),
    ]),
  ),
  sourceHashes,
  schemas: { file: "schemas.json", sha256: sha(bytes), size: Buffer.byteLength(bytes) },
  sourceStateLayout: "qualified-v33",
  agentMigrationVersions: [40, 41, 42],
  sourceAfterReceiptRemovalEqualsCanonicalAgent39: true,
  metadataOwner:
    "Actual searchExtensions, catalog evidence, anchors and seals remain native-owner responsibilities.",
};
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "schemas.json"), bytes, { flag: "wx", mode: 0o600 });
fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
fs.writeFileSync(
  path.join(out, "fixture-agent39-rich.json"),
  `${JSON.stringify({ sql: richSql, extensions }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(
  JSON.stringify(
    { outputDirectory: out, schemasSha256: manifest.schemas.sha256, pins, appVersion },
    null,
    2,
  ),
);
