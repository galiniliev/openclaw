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
// execute_code({ namespaceIds: ["web"], code: "..." })
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

#### Reproducible micro-benchmark

[`tests/comparison.test.ts`](./tests/comparison.test.ts) runs the same task —
"list users with more than 5 posts, sorted by post count descending" — two ways
against an instrumented mock API. It records concrete numbers so the table above
can be quoted with proof rather than estimates:

```
metric                | direct tool calls | code mode
----------------------|-------------------|----------
agent round-trips     |                12 | 1
underlying API calls  |                11 | 11
bytes into LLM context|             14076 | 163
wall-clock ms         |                 1 | 43
```

Reading the numbers:

- **agent round-trips** is the headline metric: 12 LLM turns vs. 1. Every extra
  turn costs prefill (whole growing context re-encoded) plus decoding plus
  network — typically the dominant cost in a real run.
- **underlying API calls** is identical (11). Code mode does not skip work; it
  just keeps it inside one execute_code turn.
- **bytes into LLM context** drops ~86x (14,076 → 163). In direct mode every
  intermediate tool result is appended to the conversation; in code mode only
  the final filtered/sorted return value lands in the prompt.
- **wall-clock ms** is *not* a fair LLM-cost comparison in this micro-benchmark
  — the direct path is a synchronous in-process loop with no LLM and no real
  network, while code mode pays a worker-thread spin-up cost. Against a real
  agent + real network the round-trip and context-bytes columns dominate and
  code mode wins by a large margin.

Run it locally:

```bash
node node_modules/vitest/vitest.mjs run extensions/tools-code-mode/tests/comparison.test.ts --reporter=verbose
```

The test asserts that both modes return the **same result**, that direct mode
uses exactly 12 round-trips and code mode uses 1, that the underlying API call
count is identical, and that code mode's context payload is at least 5x smaller.

#### Reproducing the same comparison in a live OpenClaw agent

The unit test above proves the mechanics. To see the same effect end-to-end
against a real model + real network, point both modes at a public API — this
recipe uses JSONPlaceholder (`https://jsonplaceholder.typicode.com`) because it
exposes `/users` (10 users) and `/posts?userId=X`, which matches the test
fixture without auth.

**1. Set up the code-mode side.** Drop a namespace in the workspace:

`~/.openclaw/workspace/code-mode-namespaces.json`

```json
{
  "namespaces": [
    {
      "id": "demo",
      "namespaceName": "Demo",
      "baseUrl": "https://jsonplaceholder.typicode.com",
      "auth": { "type": "none" },
      "endpoints": {
        "users.list":   "GET /users",
        "posts.byUser": "GET /posts?{userId}"
      },
      "prompt": "Demo.users.list() → User[]; Demo.posts.byUser({userId}) → Post[]. Use these to answer the task."
    }
  ]
}
```

This registers a Tier 0 namespace; the engine activates `execute_code` on
startup as soon as it sees this file. (`tools-code-mode`'s manifest sets
`activation.onStartup: true`, and the JSON loader runs at register time.)

**2. Set up the direct-tools side.** Configure a generic HTTP MCP server so
the same two endpoints are reachable as discrete agent tools. Any MCP fetch
server works; the widely-published `@modelcontextprotocol/server-fetch` is the
simplest:

`~/.openclaw/config/openclaw.mcp.json`

```json
{
  "mcp": {
    "servers": {
      "jsonplaceholder": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-fetch"]
      }
    }
  }
}
```

The agent now has a `fetch` tool that, like any per-call tool, lands one
response in the LLM context per invocation.

**3. Run the same prompt under each configuration.** Use identical model,
prompt, and seed; only vary the tool allowlist:

```bash
# Code mode: only execute_code is allowed.
openclaw run \
  --tools-allow "execute_code" \
  "List the JSONPlaceholder users who have more than 5 posts, sorted by post count descending. Return name and post count."

# Direct mode: only the MCP fetch tool is allowed.
openclaw run \
  --tools-allow "jsonplaceholder/*" \
  "List the JSONPlaceholder users who have more than 5 posts, sorted by post count descending. Return name and post count."
```

**4. Compare telemetry.** OpenClaw records tool calls, turn counts, and token
usage per session. Inspect either run with:

```bash
openclaw sessions list --limit 2
openclaw sessions show <session-id> --json | jq '.turns | length, .usage'
```

You should see roughly the same shape as the unit test:

| Metric | Direct (fetch tool) | Code mode (`execute_code`) |
|---|---|---|
| Tool-call turns | ~11–12 (one per resource) | 1 |
| Prompt tokens (cumulative) | high — every response re-encoded each turn | low — only final return value |
| Wall-clock | dominated by N × (model think + HTTP) | dominated by 1 × model think + parallel HTTP inside worker |

The direct path's prompt-token total typically dwarfs code mode by 10–100x on
this scenario because each user-posts response (~1–4 KB of JSON) is re-encoded
into every subsequent turn's prompt; code mode reduces the same workload to a
single structured return value (~150–300 bytes in our fixture).

**Caveats for honest measurement.** Pin the same model + temperature on both
runs, disable any caching, and run each at least 3 times — model token usage
varies turn-to-turn even for identical prompts. The unit test stays the
reproducible "lower bound" proof; the live agent run shows the real LLM-cost
impact those numbers translate to.

---

Generic code mode execution engine. Owner plugins register domain-specific **namespaces** (typed scope + prompt + collection classes + API adapter). The engine provides sandboxed code execution, session-scoped mode switching, and prompt injection. A single `execute_code` call can compose multiple registered namespaces by passing their ids in `namespaceIds`.

## How It Works

```
Owner plugin registers namespace + API adapter
  → tools-code-mode stores it in the global registry
  → execute_code tool becomes available
  → LLM generates JS code using the typed namespace
  → engine executes code in a worker-backed VM
  → result returned to LLM or Lobster workflow
```

The engine never imports domain code. Owner plugins bring their own namespace factories, prompts, and adapters.

## Sandbox & Security Model

`execute_code` runs in a Node.js `worker_thread` with a `vm.createContext`
sandbox. The host process never injects host-realm functions or objects into
the VM context — doing so would let sandboxed code escape via
`.constructor.constructor("return process")()`.

Concrete properties enforced by the executor:

- **No host closures inside the VM.** `console`, `setTimeout`, `Promise`, and
  `JSON` are reconstructed *inside* the VM realm. Console output is collected
  into a VM-side array (`__consoleLines`) and read back from the host only
  after the script resolves.
- **`codeGeneration: { strings: false, wasm: false }`** — `eval`, `new
  Function`, and WebAssembly compilation are disabled in the sandbox.
- **Forbidden path segments.** Scope traversal rejects `__proto__`,
  `constructor`, and `prototype` keys to prevent prototype-pollution probes
  against the bridged namespace object.
- **Bridged calls only.** Namespace methods are serialized to thin proxies
  that `postMessage` a `{ type: "call", root, path, args }` request back to
  the host. The host invokes the real adapter and returns the result. Args
  and return values must round-trip through structured clone — non-cloneable
  values (functions, class instances with private state) will fail at the
  boundary by design.
- **Collection class injection.** Classes from `collectionClasses` are
  serialized via `Function.prototype.toString` and re-evaluated in the VM
  realm so `instanceof` checks work inside the sandbox without leaking the
  host-realm constructor.
- **Resource limits.** Per-namespace `maxCodeBytes` (default 100 KB),
  `defaultTimeoutMs` (30 s), and `maxTimeoutMs` (120 s) are enforced; when
  multiple namespaces are composed, the *most restrictive* value wins. A
  per-process semaphore caps concurrent executions (default 4).
- **Clean shutdown.** The `dispose` plugin event terminates any live worker
  threads.

## Public API

```ts
// Full namespace registration
import {
  registerCodeModeNamespace,
  unregisterCodeModeNamespace,
  activateCodeModeSession,
  deactivateCodeModeSession,
} from "@openclaw/tools-code-mode/api";

import type { CodeModeNamespace } from "@openclaw/tools-code-mode/api";

// Quick helpers
import { quickHydration, plugAdapter } from "@openclaw/tools-code-mode/quick";
```

## Registering a Namespace

Owner plugins call `registerCodeModeNamespace` during their `register(api)` lifecycle:

```ts
// extensions/my-domain/index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerCodeModeNamespace } from "@openclaw/tools-code-mode/api";
import { createMyNamespace, MyItemSet } from "./namespace.js";
import { getMySystemPrompt } from "./prompts.js";
import { createMyApiAdapter } from "./adapter.js";

export default definePluginEntry({
  id: "my-domain",
  name: "My Domain Agent",
  description: "Registers the MyDomain code mode namespace.",
  register(api) {
    const adapter = createMyApiAdapter(api);

    registerCodeModeNamespace(
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

## The CodeModeNamespace Interface

```ts
interface CodeModeNamespace<TApi = unknown, TNamespace = unknown> {
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

Once at least one namespace is registered, the `execute_code` tool appears:

```json
{
  "name": "execute_code",
  "parameters": {
    "namespaceIds": ["m365"],
    "code": "const msgs = await M365.messages.list({ top: 5 }); return msgs.summary();",
    "timeoutMs": 15000
  }
}
```

`namespaceIds` is always an array. To compose multiple namespaces in a single sandbox, pass more than one id:

```json
{
  "name": "execute_code",
  "parameters": {
    "namespaceIds": ["m365", "outlook"],
    "code": "const inbox = await M365.messages.list({ top: 5 }); return Outlook.summarize(inbox);"
  }
}
```

When multiple namespaces are composed:
- Each namespace's `namespaceName` becomes a top-level scope variable. Names must be unique across the composed set; collisions reject the call with `errorKind: "validationError"`.
- `maxCodeBytes`, `defaultTimeoutMs`, and `maxTimeoutMs` resolve to the **most restrictive** value across the composed namespaces.
- `extraGlobals` from each namespace are merged into a single object; later entries override earlier on key collisions.
- `collectionClasses` from all namespaces are injected; same-name collisions take the last one in iteration order.

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

Activate a mode to inject the namespace's system prompt into the agent's context:

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

The engine hooks into `agent_turn_prepare` and appends the active namespace's system prompt as context.

## Complete Example: Weather Code Mode

A minimal example showing how to create a namespace from scratch:

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
  return `You have access to **execute_code** with namespaceIds: ["weather"].
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

### 5. Register the namespace

```ts
// extensions/weather-agent/index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerCodeModeNamespace } from "@openclaw/tools-code-mode/api";
import { createWeatherNamespace } from "./src/namespace.js";
import { getWeatherSystemPrompt } from "./src/prompts.js";
import { createWeatherAdapter } from "./src/adapter.js";

export default definePluginEntry({
  id: "weather-agent",
  name: "Weather Agent",
  description: "Weather code mode namespace for tools-code-mode.",
  register(api) {
    const config = api.getPluginConfig();
    const adapter = createWeatherAdapter(config?.apiKey ?? process.env.WEATHER_API_KEY ?? "");

    registerCodeModeNamespace(
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
// execute_code({ namespaceIds: ["weather"], code: "..." })
const current = await Weather.current("Seattle");
const forecast = await Weather.forecast("Seattle", 3);
return { current, forecast };
```

## Complete Example: Wrapping an Existing MCP Server

If you already have an MCP server exposing tools, you can create a thin code mode namespace over it:

```ts
// extensions/github-code-mode/index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerCodeModeNamespace } from "@openclaw/tools-code-mode/api";

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
  description: "GitHub code mode namespace — repos, issues, PRs via typed scope.",
  register(api) {
    const token = process.env.GITHUB_TOKEN ?? "";
    if (!token) return;

    registerCodeModeNamespace(
      {
        id: "github",
        toolName: "execute_github_code",
        displayName: "GitHub Copilot",
        namespaceName: "GitHub",
        createNamespace: (a) => createGitHubNamespace(a),
        collectionClasses: {},
        getSystemPrompt: () => `You have access to execute_code with namespaceIds: ["github"].

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
      namespaceIds: [m365]
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
import { registerCodeModeNamespace } from "@openclaw/tools-code-mode/api";

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

registerCodeModeNamespace(m365Namespace, guardedAdapter);
```

The engine never knows about approvals — it just runs code against whatever adapter was registered.

## Configuration

Plugin manifest (`openclaw.plugin.json`):

```json
{
  "id": "tools-code-mode",
  "name": "Tools Code Mode",
  "description": "Generic code mode execution engine for registered domain namespaces",
  "activation": { "onStartup": true },
  "contracts": { "tools": ["execute_code"] },
  "toolMetadata": {
    "execute_code": { "optional": true }
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

The `execute_code` tool only appears when at least one namespace is registered.
`toolMetadata.execute_code.optional: true` is intentionally aligned with the
runtime `api.registerTool(..., { optional: true })` call so OpenClaw skips
loading the engine (and the workspace JSON hydration scan) for sessions that
do not allowlist the tool.

For packaged or bundled plugins, import the API via the package path (`@openclaw/tools-code-mode/api` or the package name configured for the engine). For local side-by-side plugins loaded with `plugins.load.paths`, use a relative import to the colocated engine plugin, for example `../tools-code-mode/api.js`, so both plugins share the same registry instance.

---

## Quick Hydration: Register Without Writing a Plugin

You don't need a full extension to add a namespace. The engine supports three progressively powerful shortcuts:

### Tier 0: JSON Config (zero code)

Drop a `code-mode-namespaces.json` in your OpenClaw workspace:

```
~/.openclaw/workspace/code-mode-namespaces.json              # main workspace
~/.openclaw/workspaces/[agent-name]/code-mode-namespaces.json # per-agent
```

```json
{
  "namespaces": [
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

Restart OpenClaw — `execute_code` with `namespaceIds: ["github"]` is ready.

**Auth** uses OpenClaw's standard resolution: `configPath` (resolved via `resolveConfiguredSecretInputString`) with `env` fallback. Auth is resolved lazily on first execution, not at startup.

**Endpoint shorthand:** `METHOD /path?query={param}` — path params from `{name}` in path, query params from `{name}` in query string, body inferred from POST/PUT/PATCH.

**Structured form** (use when the shorthand isn't expressive enough — e.g. to
declare param types, override body inference, or set per-endpoint headers):

```json
"issues.create": {
  "method": "POST",
  "path": "/repos/{owner}/{repo}/issues",
  "params": {
    "owner": { "type": "string", "required": true, "in": "path" },
    "repo":  { "type": "string", "required": true, "in": "path" }
  },
  "body": true,
  "headers": { "X-GitHub-Api-Version": "2022-11-28" }
}
```

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
  extensions/tools-code-mode/tests/index.test.ts \
  extensions/tools-code-mode/tests/comparison.test.ts \
  extensions/tools-code-mode/tests/hydration/endpoint-parser.test.ts \
  extensions/tools-code-mode/tests/hydration/rest-adapter.test.ts \
  extensions/tools-code-mode/tests/hydration/quick-hydration.e2e.test.ts \
  extensions/tools-code-mode/tests/hydration/json-loader.e2e.test.ts
```
