# Tools Code Mode

## Why Code Mode?

Traditional tool-calling gives the LLM one action per turn. For tasks that require filtering, combining, or iterating over API results, this means dozens of round-trips, each burning tokens and adding latency.

**Code mode** lets the LLM write a short script that runs multiple API calls in a single execution, with logic in between:

```js
// One tool call. One round-trip. Full result.
const products = ["Linear", "Shortcut", "Jira"];
const results = [];
for (const name of products) {
  const search = await Web.search({ query: `${name} pricing 2026` });
  const page = await Web.fetch({ url: search.results[0].url, prompt: "Extract pricing tiers" });
  results.push({ product: name, pricing: page.content });
}
return results;
```

### Benefits

| Benefit | Without code mode | With code mode |
|---------|------------------|----------------|
| **Multi-step operations** | 5-10 tool calls, 5-10 round-trips | 1 tool call, 1 round-trip |
| **Filtering and transforms** | LLM processes raw JSON in context | Logic runs server-side, only results returned |
| **Token efficiency** | Full API responses in context window | Only final result enters context |
| **Latency** | Sequential tool calls (seconds each) | Single execution (sub-second) |
| **Composability** | Each tool is isolated | Combine data from multiple API calls in one script |
| **Error handling** | LLM retries blindly | try/catch with programmatic recovery |

### When to use code mode

- Fetching + filtering (get messages, filter by date, return subjects)
- Aggregation (count items across multiple lists)
- Multi-step workflows (look up user, get their tasks, summarize)
- Conditional logic (if inbox > 50 unread, get top 10; otherwise get all)

### When NOT to use code mode

- Single API call with no logic (use a regular tool instead)
- User-facing write operations that need confirmation (use approval guards)

### Example: Direct Tool Calls vs. Code Mode

**Scenario:** "Compare pricing plans for three project management tools"

User asks: *"Compare pricing for Linear, Shortcut, and Jira. Show me the free tier limits and the per-seat cost for the team plan."*

##### Direct tool calls (9+ round-trips)

```
Turn 1 → web_search({ query: "Linear pricing plans 2026" })
       ← Returns 10 URLs
Turn 2 → web_fetch({ url: "https://linear.app/pricing" })
       ← Returns full pricing page (~4,000 tokens of markdown)
Turn 3 → web_search({ query: "Shortcut pricing plans 2026" })
       ← Returns 10 URLs
Turn 4 → web_fetch({ url: "https://shortcut.com/pricing" })
       ← Returns full pricing page (~3,500 tokens)
Turn 5 → web_search({ query: "Jira pricing plans 2026" })
       ← Returns 10 URLs
Turn 6 → web_fetch({ url: "https://www.atlassian.com/software/jira/pricing" })
       ← Returns full pricing page (~5,000 tokens)
Turn 7 → LLM reads all three pages from context, tries to extract free tier info
Turn 8 → LLM tries to find per-seat team plan cost from unstructured HTML
Turn 9 → LLM formats comparison table
       ← "Here's the comparison..."
```

**Cost:** 9 round-trips, ~12,500 tokens of raw page content sitting in context, 20-30 seconds total. The LLM has to parse pricing grids from unstructured markdown (often misses footnotes, annual vs. monthly, regional pricing).

##### Code mode (1 round-trip)

```js
// execute_code({ hydrationId: "web", code: "..." })
const products = ["Linear", "Shortcut", "Jira"];
const comparison = [];

for (const product of products) {
  const search = await Web.search({ query: `${product} pricing plans 2026` });
  const pricingUrl = search.results.find(r => r.url.includes("pricing"))?.url
    || search.results[0]?.url;
  if (!pricingUrl) continue;

  const page = await Web.fetch({ url: pricingUrl, prompt: "Extract: free tier limits and per-seat monthly cost for the team/standard plan" });

  comparison.push({
    product,
    url: pricingUrl,
    freeTier: page.freeTier || "not found",
    teamPlanCost: page.teamPlanCost || "not found",
    notes: page.notes || ""
  });
}

return comparison;
```

**Result returned to LLM:**
```json
[
  { "product": "Linear", "url": "https://linear.app/pricing",
    "freeTier": "Up to 250 issues, unlimited members",
    "teamPlanCost": "$8/seat/month (billed annually)",
    "notes": "14-day trial for paid plans" },
  { "product": "Shortcut", "url": "https://shortcut.com/pricing",
    "freeTier": "Up to 10 members, all core features",
    "teamPlanCost": "$8.50/seat/month (billed annually)",
    "notes": "Free migration from Jira" },
  { "product": "Jira", "url": "https://www.atlassian.com/software/jira/pricing",
    "freeTier": "Up to 10 users, 2GB storage",
    "teamPlanCost": "$7.75/seat/month (billed annually, 1-100 users)",
    "notes": "Price decreases at higher tiers" }
]
```

**Cost:** 1 round-trip, ~300 tokens of structured result in context, 3-5 seconds. Extraction is targeted (only pulls what was asked), output is structured JSON ready for the LLM to present as a table.

#### The pattern

| Metric | Direct tools | Code mode |
|--------|-------------|-----------|
| Round-trips | N (one per API call) | 1 |
| Context tokens | All raw responses | Only final result |
| Filtering accuracy | LLM best-effort | Deterministic code |
| Latency | N * (LLM think + API call) | 1 * (API calls run in parallel) |
| Composability | None (each call isolated) | Full (variables, loops, conditionals) |

---

Generic code mode execution engine. Owner plugins register domain-specific **hydrations** (typed namespace + prompt + collection classes + API adapter). The engine provides sandboxed code execution, session-scoped mode switching, and prompt injection.

## How It Works

```
Owner plugin registers hydration + API adapter
  → tools-code-mode stores it in the global registry
  → execute_code tool becomes available
  → LLM generates JS code using the typed namespace
  → engine executes code in a worker-backed VM
  → result returned to LLM or Lobster workflow
```

The engine never imports domain code. Owner plugins bring their own namespace factories, prompts, and adapters.

## Public API

```ts
// Full hydration registration (Tier 3)
import {
  registerCodeModeHydration,
  unregisterCodeModeHydration,
  activateCodeModeSession,
  deactivateCodeModeSession,
} from "@openclaw/tools-code-mode/api";

import type { CodeModeHydration } from "@openclaw/tools-code-mode/api";

// Quick hydration helpers (Tier 1 & 2)
import { quickHydration, plugAdapter } from "@openclaw/tools-code-mode/quick";
```

## Registering a Hydration

Owner plugins call `registerCodeModeHydration` during their `register(api)` lifecycle:

```ts
// extensions/my-domain/index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerCodeModeHydration } from "@openclaw/tools-code-mode/api";
import { createMyNamespace, MyItemSet } from "./namespace.js";
import { getMySystemPrompt } from "./prompts.js";
import { createMyApiAdapter } from "./adapter.js";

export default definePluginEntry({
  id: "my-domain",
  name: "My Domain Agent",
  description: "Registers the MyDomain code mode hydration.",
  register(api) {
    const adapter = createMyApiAdapter(api);

    registerCodeModeHydration(
      {
        id: "my-domain",
        toolName: "execute_my_domain_code",
        displayName: "My Domain Copilot",
        namespaceName: "MyDomain",
        createNamespace: (apiAdapter) => createMyNamespace(apiAdapter),
        collectionClasses: { MyItemSet },
        getSystemPrompt: () => getMySystemPrompt(),
        maxCodeBytes: 100_000,
        defaultTimeoutMs: 30_000,
        maxTimeoutMs: 120_000,
      },
      adapter,
    );
  },
});
```

## The CodeModeHydration Interface

```ts
interface CodeModeHydration<TApi = unknown, TNamespace = unknown> {
  // Identity
  readonly id: string;              // "m365", "engage", "planner", "my-domain"
  readonly toolName: string;        // "execute_m365_code" (informational)
  readonly displayName: string;     // "M365 Copilot"
  readonly namespaceName: string;   // "M365" — injected as scope variable

  // Factories
  createNamespace(api: TApi): TNamespace;
  getSystemPrompt(context?: unknown): string;

  // Scope injection
  readonly collectionClasses: Record<string, new (...args: unknown[]) => unknown>;
  extraGlobals?(api: TApi, context?: unknown): Record<string, unknown>;

  // Limits
  readonly maxCodeBytes?: number;       // default 100KB
  readonly defaultTimeoutMs?: number;   // default 30s
  readonly maxTimeoutMs?: number;       // default 120s

  // Validation
  validateApi?(api: TApi): string | undefined;
}
```

## Tool: execute_code

Once at least one hydration is registered, the `execute_code` tool appears:

```json
{
  "name": "execute_code",
  "parameters": {
    "hydrationId": "m365",
    "code": "const msgs = await M365.messages.list({ top: 5 }); return msgs.summary();",
    "timeoutMs": 15000
  }
}
```

**Response:**

```json
{
  "ok": true,
  "returnValue": [
    { "subject": "Q3 Planning", "from": "boss@co.com", "date": "2026-05-14", "id": "abc" }
  ],
  "consoleOutput": [],
  "durationMs": 423
}
```

## Session Mode (Prompt Injection)

Activate a mode to inject the hydration's system prompt into the agent's context:

```ts
import {
  activateCodeModeSession,
  deactivateCodeModeSession,
} from "@openclaw/tools-code-mode/api";

// Activate — injects getSystemPrompt() on every agent turn for this session
activateCodeModeSession("m365", { user: "alice@contoso.com" }, sessionKey);

// Deactivate — removes prompt contribution
deactivateCodeModeSession(sessionKey);
```

The engine hooks into `agent_turn_prepare` and appends the active hydration's system prompt as context.

## Complete Example: Weather Code Mode

A minimal example showing how to create a hydration from scratch:

### 1. Define the API interface

```ts
// extensions/weather-agent/src/api.ts
export interface WeatherAPI {
  current(city: string): Promise<{ temp: number; conditions: string; humidity: number }>;
  forecast(city: string, days: number): Promise<{ date: string; high: number; low: number }[]>;
}
```

### 2. Create the namespace factory

```ts
// extensions/weather-agent/src/namespace.ts
import type { WeatherAPI } from "./api.js";

export function createWeatherNamespace(api: WeatherAPI) {
  return {
    current: async (city: string) => api.current(city),
    forecast: async (city: string, days = 5) => api.forecast(city, days),
  };
}

export type WeatherNamespace = ReturnType<typeof createWeatherNamespace>;
```

### 3. Write the system prompt

```ts
// extensions/weather-agent/src/prompts.ts
export function getWeatherSystemPrompt(): string {
  return `You have access to **execute_code** with hydrationId "weather".
The code has access to the \`Weather\` namespace:

| Method | Signature | Returns |
|--------|-----------|---------|
| current | \`current(city)\` | \`{ temp, conditions, humidity }\` |
| forecast | \`forecast(city, days?)\` | \`{ date, high, low }[]\` |

All methods are async — always use \`await\`.
Return the final value with \`return\`.`;
}
```

### 4. Create the API adapter

```ts
// extensions/weather-agent/src/adapter.ts
import type { WeatherAPI } from "./api.js";

export function createWeatherAdapter(apiKey: string): WeatherAPI {
  return {
    async current(city) {
      const res = await fetch(`https://api.weather.example/current?city=${city}&key=${apiKey}`);
      return res.json();
    },
    async forecast(city, days) {
      const res = await fetch(`https://api.weather.example/forecast?city=${city}&days=${days}&key=${apiKey}`);
      return res.json();
    },
  };
}
```

### 5. Register the hydration

```ts
// extensions/weather-agent/index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerCodeModeHydration } from "@openclaw/tools-code-mode/api";
import { createWeatherNamespace } from "./src/namespace.js";
import { getWeatherSystemPrompt } from "./src/prompts.js";
import { createWeatherAdapter } from "./src/adapter.js";

export default definePluginEntry({
  id: "weather-agent",
  name: "Weather Agent",
  description: "Weather code mode hydration for tools-code-mode.",
  register(api) {
    const config = api.getPluginConfig();
    const adapter = createWeatherAdapter(config?.apiKey ?? process.env.WEATHER_API_KEY ?? "");

    registerCodeModeHydration(
      {
        id: "weather",
        toolName: "execute_weather_code",
        displayName: "Weather Copilot",
        namespaceName: "Weather",
        createNamespace: (a) => createWeatherNamespace(a),
        collectionClasses: {},
        getSystemPrompt: () => getWeatherSystemPrompt(),
        defaultTimeoutMs: 10_000,
      },
      adapter,
    );
  },
});
```

### 6. LLM usage

Once registered, the LLM can call:

```js
// execute_code({ hydrationId: "weather", code: "..." })
const current = await Weather.current("Seattle");
const forecast = await Weather.forecast("Seattle", 3);
return { current, forecast };
```

## Complete Example: Wrapping an Existing MCP Server

If you already have an MCP server exposing tools, you can create a thin code mode namespace over it:

```ts
// extensions/github-code-mode/index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerCodeModeHydration } from "@openclaw/tools-code-mode/api";

interface GitHubAPI {
  repos: { list(): Promise<{ name: string; url: string }[]> };
  issues: {
    list(repo: string, opts?: { state?: string }): Promise<{ id: number; title: string; state: string }[]>;
    create(repo: string, title: string, body: string): Promise<{ id: number; url: string }>;
  };
  prs: {
    list(repo: string): Promise<{ id: number; title: string; state: string }[]>;
  };
}

function createGitHubNamespace(api: GitHubAPI) {
  return {
    repos: { list: () => api.repos.list() },
    issues: {
      list: (repo: string, opts?: { state?: string }) => api.issues.list(repo, opts),
      create: (repo: string, title: string, body: string) => api.issues.create(repo, title, body),
    },
    prs: { list: (repo: string) => api.prs.list(repo) },
  };
}

function createGitHubAdapter(token: string): GitHubAPI {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  const base = "https://api.github.com";
  return {
    repos: {
      async list() {
        const res = await fetch(`${base}/user/repos?per_page=30`, { headers });
        const data = await res.json();
        return data.map((r: any) => ({ name: r.full_name, url: r.html_url }));
      },
    },
    issues: {
      async list(repo, opts) {
        const state = opts?.state ?? "open";
        const res = await fetch(`${base}/repos/${repo}/issues?state=${state}`, { headers });
        const data = await res.json();
        return data.map((i: any) => ({ id: i.number, title: i.title, state: i.state }));
      },
      async create(repo, title, body) {
        const res = await fetch(`${base}/repos/${repo}/issues`, {
          method: "POST", headers, body: JSON.stringify({ title, body }),
        });
        const data = await res.json();
        return { id: data.number, url: data.html_url };
      },
    },
    prs: {
      async list(repo) {
        const res = await fetch(`${base}/repos/${repo}/pulls`, { headers });
        const data = await res.json();
        return data.map((p: any) => ({ id: p.number, title: p.title, state: p.state }));
      },
    },
  };
}

export default definePluginEntry({
  id: "github-code-mode",
  name: "GitHub Code Mode",
  description: "GitHub code mode hydration — repos, issues, PRs via typed namespace.",
  register(api) {
    const token = process.env.GITHUB_TOKEN ?? "";
    if (!token) return;

    registerCodeModeHydration(
      {
        id: "github",
        toolName: "execute_github_code",
        displayName: "GitHub Copilot",
        namespaceName: "GitHub",
        createNamespace: (a) => createGitHubNamespace(a),
        collectionClasses: {},
        getSystemPrompt: () => `You have access to execute_code with hydrationId "github".

| Namespace | Method | Returns |
|-----------|--------|---------|
| GitHub.repos | list() | { name, url }[] |
| GitHub.issues | list(repo, { state? }) | { id, title, state }[] |
| GitHub.issues | create(repo, title, body) | { id, url } |
| GitHub.prs | list(repo) | { id, title, state }[] |

All methods are async. Use \`return\` to capture results.`,
        defaultTimeoutMs: 15_000,
      },
      createGitHubAdapter(token),
    );
  },
});
```

## Chainable Collection Classes

For richer code mode ergonomics, provide collection classes that extend Array:

```ts
export class IssueSet extends Array<Issue> {
  static get [Symbol.species]() { return Array; }

  constructor(items: Issue[] | number) {
    if (typeof items === "number") { super(items); return; }
    super(...items);
    Object.setPrototypeOf(this, IssueSet.prototype);
  }

  where(predicate: (i: Issue) => boolean): IssueSet {
    return new IssueSet(this.filter(predicate));
  }

  open(): IssueSet { return this.where((i) => i.state === "open"); }
  closed(): IssueSet { return this.where((i) => i.state === "closed"); }

  summary(): { id: number; title: string }[] {
    return this.map((i) => ({ id: i.id, title: i.title }));
  }

  get total(): number { return this.length; }
}
```

Register it in `collectionClasses: { IssueSet }` so LLM-generated code can use:

```js
const issues = await GitHub.issues.list("org/repo");
const urgent = new IssueSet(issues).open().where(i => i.title.includes("urgent"));
return urgent.summary();
```

## Lobster Workflow Integration

Lobster workflows invoke code mode scripts through the Gateway `tools.invoke`
model-tool path. `execute_code` is not an `exec` tool call and not an
`openclaw execute_code` CLI command.

```yaml
steps:
  - id: fetch
    tool: execute_code
    args:
      hydrationId: m365
      code: return (await M365.messages.list({ top: 20 })).summary();

  - id: summarize
    tool: llm-task
    args:
      prompt: Summarize these messages
      inputFrom: fetch
```

## Adding Approval Guards (Future)

Wrap the API adapter before registration to intercept write operations:

```ts
import { registerCodeModeHydration } from "@openclaw/tools-code-mode/api";

const rawAdapter = createLiveGraphAdapter(config);

const guardedAdapter = wrapWithApprovalGuard(rawAdapter, {
  classify: (namespace, method) => {
    if (["list", "get", "search", "count"].includes(method)) return "read";
    if (["createDraft", "createReplyDraft"].includes(method)) return "draft";
    if (["delete", "deleteAll"].includes(method)) return "destructive";
    return "write";
  },
  onProtected: (method, args) => {
    // Halt execution, return needs_approval to Lobster
    throw new ApprovalRequiredError({ method, args });
  },
});

registerCodeModeHydration(m365Hydration, guardedAdapter);
```

The engine never knows about approvals — it just runs code against whatever adapter was registered.

## Configuration

Plugin manifest (`openclaw.plugin.json`):

```json
{
  "id": "tools-code-mode",
  "activation": { "onStartup": true },
  "contracts": { "tools": ["execute_code"] }
}
```

The `execute_code` tool only appears when at least one hydration is registered.

For packaged or bundled plugins, import the API via the package path (`@openclaw/tools-code-mode/api` or the package name configured for the engine). For local side-by-side plugins loaded with `plugins.load.paths`, use a relative import to the colocated engine plugin, for example `../tools-code-mode/api.js`, so both plugins share the same registry instance.

---

## Quick Hydration: Register Without Writing a Plugin

You don't need a full extension to add a hydration. The engine supports three progressively powerful shortcuts:

### Tier 0: JSON Config (zero code)

Drop a `code-mode-hydrations.json` in your OpenClaw workspace:

```
~/.openclaw/workspace/code-mode-hydrations.json              # main workspace
~/.openclaw/workspaces/[agent-name]/code-mode-hydrations.json # per-agent
```

```json
{
  "hydrations": [
    {
      "id": "github",
      "namespaceName": "GitHub",
      "baseUrl": "https://api.github.com",
      "auth": { "bearer": { "env": "GITHUB_TOKEN" } },
      "headers": { "Accept": "application/vnd.github+json" },
      "endpoints": {
        "repos.list": "GET /user/repos?per_page={perPage}",
        "issues.list": "GET /repos/{owner}/{repo}/issues?state={state}",
        "issues.create": "POST /repos/{owner}/{repo}/issues"
      },
      "prompt": "GitHub.repos.list({ perPage? })\nGitHub.issues.list({ owner, repo, state? })\nGitHub.issues.create({ owner, repo, ...body })"
    }
  ]
}
```

Restart OpenClaw — `execute_code` with `hydrationId: "github"` is ready.

**Auth** uses OpenClaw's standard resolution: `configPath` (resolved via `resolveConfiguredSecretInputString`) with `env` fallback. Auth is resolved lazily on first execution, not at startup.

**Endpoint shorthand:** `METHOD /path?query={param}` — path params from `{name}` in path, query params from `{name}` in query string, body inferred from POST/PUT/PATCH.

If `prompt` is omitted, one is auto-generated from endpoint definitions.

### Tier 1: `quickHydration()` (minimal TS)

```ts
import { quickHydration } from "@openclaw/tools-code-mode/quick";

quickHydration({
  id: "jira",
  namespaceName: "Jira",
  baseUrl: "https://mysite.atlassian.net/rest/api/3",
  auth: { bearer: { configPath: "plugins.entries.jira.config.apiKey", env: "JIRA_TOKEN" } },
  headers: { "Accept": "application/json" },
  endpoints: {
    "issues.list": "GET /search?jql={jql}&maxResults={maxResults}",
    "issues.get": "GET /issue/{issueKey}",
    "issues.create": "POST /issue",
  },
  prompt: `Jira namespace:
- Jira.issues.list({ jql, maxResults? }) -> issue[]
- Jira.issues.get({ issueKey }) -> issue
- Jira.issues.create(body) -> created issue`,
});
```

Same lazy auth, same REST adapter, but callable from any TS file in your extension.

### Tier 2: `plugAdapter()` (existing namespace factories)

For teams that already have typed namespace factories (e.g., from agent-tools):

```ts
import { plugAdapter } from "@openclaw/tools-code-mode/quick";
import { createM365Namespace, MessageSet, EventSet } from "agent-tools/m365Dsl";
import { getM365SystemPrompt } from "agent-tools/m365PromptBuilder";

plugAdapter({
  id: "m365",
  namespaceName: "M365",
  displayName: "M365 Copilot",
  createNamespace: createM365Namespace,
  collectionClasses: { MessageSet, EventSet },
  getSystemPrompt: getM365SystemPrompt,
  auth: { bearer: { configPath: "plugins.entries.m365.config.accessToken", env: "M365_TOKEN" } },
  createAdapter: (auth) => createGraphApiAdapter(auth),
});
```

Auth resolves lazily. The adapter is created once and cached. Optional `validateApi` runs after adapter creation.

### Auth Types

```json
{ "bearer": { "configPath": "...", "env": "..." } }
{ "basic": { "user": "admin", "pass": { "configPath": "...", "env": "..." } } }
{ "header": { "name": "X-Api-Key", "value": { "configPath": "...", "env": "..." } } }
{ "query": { "param": "api_key", "value": { "configPath": "...", "env": "..." } } }
```

---

## Testing

```bash
node scripts/run-vitest.mjs \
  extensions/tools-code-mode/tests/executor.test.ts \
  extensions/tools-code-mode/tests/tool-factory.test.ts \
  extensions/tools-code-mode/tests/mode-manager.test.ts \
  extensions/tools-code-mode/tests/integration.test.ts \
  extensions/tools-code-mode/tests/hydration/endpoint-parser.test.ts \
  extensions/tools-code-mode/tests/hydration/rest-adapter.test.ts \
  extensions/tools-code-mode/tests/hydration/quick-hydration.e2e.test.ts \
  extensions/tools-code-mode/tests/hydration/json-loader.e2e.test.ts
```
