# Code Mode Engine: Quick Hydration API Plan

## Problem

Today, registering a code mode hydration requires writing a full OpenClaw extension: 7 files, plugin SDK knowledge, TypeScript boilerplate. A power user who just wants `Jira.issues.list()` to work inside `execute_code` has to understand `definePluginEntry`, manifests, and the full `CodeModeHydration` interface before seeing any result.

The gap between "I have an API" and "execute_code calls it" should be **5 minutes**, not 30.

## Target Personas

| Persona | Needs | Path |
|---------|-------|------|
| Power user / scripter | Zero-code REST integration | `code-mode-hydrations.json` |
| TS-savvy power user | Minimal code, custom logic | `quickHydration()` |
| Super-power user (agent-tools) | Plug existing namespace factories | `plugAdapter()` |
| Extension author (existing) | Full control | `CodeModeHydration` interface (unchanged) |

## Solution: Three-Tier Progressive Disclosure

```
Tier 0: code-mode-hydrations.json    (zero code, JSON config)
Tier 1: quickHydration()       (minimal TS, REST endpoints)
Tier 2: plugAdapter()          (existing namespace factories)
Tier 3: CodeModeHydration interface (full extension, unchanged)
```

Each tier builds on the one below. The engine reads Tier 0 at startup and converts it to Tier 1 internally. Tier 1 and 2 both call `registerHydration()` under the hood.

---

## Tier 0: JSON Config (`code-mode-hydrations.json`)

### Location

```
~/.openclaw/workspace/code-mode-hydrations.json              # main workspace
~/.openclaw/workspaces/[agent-name]/code-mode-hydrations.json # per-agent workspace
```

The engine resolves the active workspace at startup and reads the file if present.

### Schema

```json
{
  "$schema": "https://openclaw.dev/schemas/code-mode-hydrations.json",
  "hydrations": [
    {
      "id": "jira",
      "namespaceName": "Jira",
      "displayName": "Jira Code Mode",
      "baseUrl": "https://mysite.atlassian.net/rest/api/3",
      "auth": {
        "bearer": {
          "configPath": "plugins.entries.jira.config.apiKey",
          "env": "JIRA_TOKEN"
        }
      },
      "headers": {
        "Accept": "application/json"
      },
      "endpoints": {
        "issues.list": {
          "method": "GET",
          "path": "/search",
          "params": {
            "jql": { "type": "string", "required": true },
            "maxResults": { "type": "number", "default": 50 }
          }
        },
        "issues.get": {
          "method": "GET",
          "path": "/issue/{issueKey}",
          "params": {
            "issueKey": { "type": "string", "required": true, "in": "path" }
          }
        },
        "issues.create": {
          "method": "POST",
          "path": "/issue",
          "body": true
        }
      },
      "prompt": "You have the Jira namespace:\n- Jira.issues.list({ jql, maxResults? }) -> array of issues\n- Jira.issues.get(issueKey) -> issue object\n- Jira.issues.create(body) -> created issue",
      "timeoutMs": 15000,
      "maxTimeoutMs": 60000
    }
  ]
}
```

### Shorthand Endpoint Syntax

For simple cases, endpoints can use a shorthand string:

```json
{
  "endpoints": {
    "issues.list": "GET /search?jql={jql}&maxResults={maxResults}",
    "issues.get": "GET /issue/{issueKey}",
    "issues.create": "POST /issue"
  }
}
```

The shorthand is parsed as: `METHOD /path?query={param}&query2={param2}`
- Path params: `{name}` in the path segment
- Query params: `{name}` in query string
- Body: inferred from POST/PUT/PATCH (first argument is the body)

### Auth Resolution

The `auth` object conforms to OpenClaw's standard credential resolution:

```json
{
  "auth": {
    "bearer": {
      "configPath": "plugins.entries.jira.config.apiKey",
      "env": "JIRA_TOKEN"
    }
  }
}
```

Resolution order:
1. `configPath` — resolved via `resolveConfiguredSecretInputString()`
2. `env` — fallback to environment variable
3. If neither resolves, the hydration is skipped with a warning (not a hard error)

Supported auth types:
- `bearer` — `Authorization: Bearer <token>`
- `basic` — `Authorization: Basic <base64(user:pass)>`
- `header` — custom header name + value
- `query` — appends token as query parameter

```json
{ "auth": { "bearer": { "configPath": "...", "env": "..." } } }
{ "auth": { "basic": { "user": "...", "pass": { "configPath": "...", "env": "..." } } } }
{ "auth": { "header": { "name": "X-Api-Key", "value": { "configPath": "...", "env": "..." } } } }
{ "auth": { "query": { "param": "api_key", "value": { "configPath": "...", "env": "..." } } } }
```

### How It Works Internally

1. Engine startup: resolve active workspace path
2. Read `code-mode-hydrations.json` if it exists
3. For each entry, validate schema
4. Resolve auth credentials via OpenClaw's secret resolution
5. Build a REST adapter (generic fetch wrapper with auth + baseUrl)
6. Build a namespace by parsing endpoint definitions into nested method objects
7. Auto-generate `toolName` as `execute_{id}_code`
8. Call `registerHydration()` with the constructed hydration + adapter

---

## Tier 1: `quickHydration()` — TS Helper

### Module

```ts
import { quickHydration } from "@openclaw/tools-code-mode/quick";
```

Exported from a new barrel: `extensions/tools-code-mode/quick.ts`

### Signature

```ts
interface QuickHydrationConfig {
  id: string;
  namespaceName: string;
  displayName?: string;                    // defaults to `${namespaceName} Code Mode`
  baseUrl: string;
  auth: AuthConfig;
  headers?: Record<string, string>;
  endpoints: Record<string, string | EndpointConfig>;
  prompt: string;
  timeoutMs?: number;                      // default 30_000
  maxTimeoutMs?: number;                   // default 120_000
  maxCodeBytes?: number;                   // default 100_000
}

interface EndpointConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  params?: Record<string, ParamConfig>;
  body?: boolean;
  headers?: Record<string, string>;
}

interface ParamConfig {
  type: "string" | "number" | "boolean";
  required?: boolean;
  default?: unknown;
  in?: "path" | "query" | "body";          // default: "query"
}

type AuthConfig =
  | { bearer: SecretRef }
  | { basic: { user: string; pass: SecretRef } }
  | { header: { name: string; value: SecretRef } }
  | { query: { param: string; value: SecretRef } };

interface SecretRef {
  configPath?: string;
  env?: string;
}

function quickHydration(config: QuickHydrationConfig): void;
```

### Behavior

1. Resolves auth via `resolveConfiguredSecretInputString()`
2. Creates a generic REST adapter: `{ [namespace.method]: (params) => fetch(...) }`
3. Constructs a `CodeModeHydration` object with:
   - `createNamespace` returns the REST adapter object nested by dot-separated endpoint keys
   - `collectionClasses` = `{}` (no custom collections in quick mode)
   - `getSystemPrompt` returns the `prompt` string
4. Calls `registerHydration(hydration, adapter)`

### Example

```ts
import { quickHydration } from "@openclaw/tools-code-mode/quick";

quickHydration({
  id: "github",
  namespaceName: "GitHub",
  baseUrl: "https://api.github.com",
  auth: { bearer: { configPath: "plugins.entries.github.config.token", env: "GITHUB_TOKEN" } },
  headers: { "Accept": "application/vnd.github+json" },
  endpoints: {
    "repos.list": "GET /user/repos?per_page={perPage}",
    "issues.list": "GET /repos/{owner}/{repo}/issues?state={state}",
    "issues.create": "POST /repos/{owner}/{repo}/issues",
  },
  prompt: `GitHub namespace:
- GitHub.repos.list({ perPage? }) -> { name, url }[]
- GitHub.issues.list({ owner, repo, state? }) -> { id, title, state }[]
- GitHub.issues.create({ owner, repo, ...body }) -> { id, url }`,
});
```

### Namespace Generation from Endpoints

Dot-separated endpoint keys become nested objects:

```ts
// "issues.list" -> namespace.issues.list(params)
// "issues.create" -> namespace.issues.create(body)
// "repos.list" -> namespace.repos.list(params)
```

The generated methods:
- **GET**: Accept an object of params. Path params substituted, rest become query string.
- **POST/PUT/PATCH**: First argument is the body. Path params extracted from URL template.
- **DELETE**: Path params from URL template. Optional body.
- All methods are async, return parsed JSON response.

---

## Tier 2: `plugAdapter()` — Existing Namespace Factories

### Module

```ts
import { plugAdapter } from "@openclaw/tools-code-mode/quick";
```

### Signature

```ts
interface PlugAdapterConfig<TApi, TNamespace> {
  id: string;
  namespaceName: string;
  displayName?: string;
  createNamespace: (api: TApi) => TNamespace;
  collectionClasses?: Record<string, new (...args: unknown[]) => unknown>;
  getSystemPrompt: (context?: unknown) => string;
  auth: AuthConfig;
  createAdapter: (resolvedCredentials: ResolvedCredentials) => TApi;
  extraGlobals?: (api: TApi, context?: unknown) => Record<string, unknown>;
  timeoutMs?: number;
  maxTimeoutMs?: number;
  maxCodeBytes?: number;
  validateApi?: (api: TApi) => string | undefined;
}

interface ResolvedCredentials {
  token?: string;
  user?: string;
  pass?: string;
  headerValue?: string;
  queryValue?: string;
}

function plugAdapter<TApi, TNamespace>(config: PlugAdapterConfig<TApi, TNamespace>): void;
```

### Behavior

1. Resolves auth via OpenClaw's standard secret resolution
2. Calls `config.createAdapter(resolvedCredentials)` to get the API object
3. Constructs a full `CodeModeHydration` from the config fields
4. Calls `registerHydration(hydration, apiAdapter)`

### Example: Plugging agent-tools M365

```ts
import { plugAdapter } from "@openclaw/tools-code-mode/quick";
import { createM365Namespace, MessageSet, EventSet, ChatSet } from "agent-tools/m365Dsl";
import { getM365SystemPrompt } from "agent-tools/m365PromptBuilder";
import { createGraphApiAdapter } from "./graph-adapter.js";

plugAdapter({
  id: "m365",
  namespaceName: "M365",
  displayName: "M365 Copilot",
  createNamespace: createM365Namespace,
  collectionClasses: { MessageSet, EventSet, ChatSet },
  getSystemPrompt: getM365SystemPrompt,
  auth: {
    bearer: {
      configPath: "plugins.entries.m365.config.accessToken",
      env: "M365_ACCESS_TOKEN",
    },
  },
  createAdapter: (creds) => createGraphApiAdapter(creds.token!),
});
```

### Example: Plugging agent-tools Engage

```ts
import { plugAdapter } from "@openclaw/tools-code-mode/quick";
import { createEngageNamespace, ThreadSet, CommunitySet, EngageUserSet } from "agent-tools/engageDsl";
import { getEngageSystemPrompt } from "agent-tools/engagePromptBuilder";
import { createEngageApiAdapter } from "./engage-adapter.js";

plugAdapter({
  id: "engage",
  namespaceName: "Engage",
  displayName: "Engage Copilot",
  createNamespace: createEngageNamespace,
  collectionClasses: { ThreadSet, CommunitySet, EngageUserSet },
  getSystemPrompt: getEngageSystemPrompt,
  auth: {
    bearer: {
      configPath: "plugins.entries.engage.config.accessToken",
      env: "ENGAGE_TOKEN",
    },
  },
  createAdapter: (creds) => createEngageApiAdapter(creds.token!),
});
```

---

## File Structure

```
extensions/tools-code-mode/
├── api.ts                          # existing public barrel (unchanged)
├── quick.ts                        # NEW: exports quickHydration, plugAdapter
├── index.ts                        # updated: loads code-mode-hydrations.json at startup
├── src/
│   ├── hydration/                  # NEW: quick hydration subsystem
│   │   ├── quick-hydration.ts      # quickHydration() implementation
│   │   ├── plug-adapter.ts         # plugAdapter() implementation
│   │   ├── rest-adapter.ts         # generic REST adapter factory
│   │   ├── endpoint-parser.ts      # shorthand endpoint string parser
│   │   ├── auth-resolver.ts        # wraps resolveConfiguredSecretInputString
│   │   ├── json-loader.ts          # loads + validates code-mode-hydrations.json
│   │   └── index.ts                # barrel for the hydration/ folder
│   ├── executor.ts                 # existing (unchanged)
│   ├── tool-factory.ts             # existing (unchanged)
│   ├── mode-manager.ts             # existing (unchanged)
│   ├── registry.ts                 # existing (unchanged)
│   ├── types.ts                    # existing (unchanged)
│   └── errors.ts                   # existing (unchanged)
├── tests/
│   ├── hydration/                  # NEW: tests for hydration subsystem
│   │   ├── quick-hydration.test.ts
│   │   ├── plug-adapter.test.ts
│   │   ├── rest-adapter.test.ts
│   │   ├── endpoint-parser.test.ts
│   │   └── json-loader.test.ts
│   └── ...existing tests...
└── docs/
    └── quick-hydration-plan.md     # this document
```

## Package Exports

Update `package.json`:

```json
{
  "exports": {
    ".": "./index.ts",
    "./api": "./api.ts",
    "./quick": "./quick.ts"
  }
}
```

---

## JSON Loader: Startup Behavior

In `index.ts` `register(api)`:

```ts
register(api) {
  // 1. Load JSON hydrations from workspace
  const workspacePath = api.getActiveWorkspacePath(); // or however OC resolves this
  loadJsonHydrations(workspacePath, api);

  // 2. Existing: register modes, tool, dispose hook
  ...
}
```

The loader:
1. Resolves `{workspacePath}/code-mode-hydrations.json`
2. Parses and validates against schema
3. For each entry, calls `quickHydration()` internally
4. Logs registration results (success/skip with reason)

Hydrations from JSON are registered BEFORE the `execute_code` tool becomes available, so they're immediately usable.

### Error Handling

- Missing file: silent (not an error)
- Parse error: warn + skip entire file
- Invalid entry: warn + skip that entry, continue with others
- Auth resolution failure: warn + skip that entry (don't block other hydrations)
- Duplicate ID (conflicts with extension-registered hydration): extension wins, warn

---

## Auth Resolver Module

```ts
// src/auth-resolver.ts
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";

export interface SecretRef {
  configPath?: string;
  env?: string;
}

export interface ResolvedCredentials {
  token?: string;
  user?: string;
  pass?: string;
  headerValue?: string;
  queryValue?: string;
}

export async function resolveAuth(
  auth: AuthConfig,
  config: unknown,
): Promise<ResolvedCredentials | null> {
  // Resolves using OpenClaw's standard pattern:
  // 1. Try configPath via resolveConfiguredSecretInputString
  // 2. Fall back to env var
  // 3. Return null if neither resolves
}
```

---

## REST Adapter Factory

```ts
// src/rest-adapter.ts

export interface RestAdapterConfig {
  baseUrl: string;
  auth: ResolvedCredentials;
  authType: AuthConfig;
  headers?: Record<string, string>;
}

export function createRestAdapter(
  config: RestAdapterConfig,
  endpoints: Record<string, string | EndpointConfig>,
): Record<string, unknown> {
  // Returns a nested object matching endpoint dot-paths
  // Each leaf is an async function that:
  // 1. Substitutes path params
  // 2. Builds query string from remaining params
  // 3. Sends body for POST/PUT/PATCH
  // 4. Applies auth headers
  // 5. Returns parsed JSON
}
```

---

## Endpoint Parser

```ts
// src/endpoint-parser.ts

export interface ParsedEndpoint {
  method: string;
  path: string;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
}

export function parseEndpointShorthand(shorthand: string): ParsedEndpoint {
  // "GET /search?jql={jql}&maxResults={maxResults}"
  // -> { method: "GET", path: "/search", pathParams: [], queryParams: ["jql", "maxResults"], hasBody: false }
  //
  // "POST /issue"
  // -> { method: "POST", path: "/issue", pathParams: [], queryParams: [], hasBody: true }
  //
  // "GET /issue/{issueKey}"
  // -> { method: "GET", path: "/issue/{issueKey}", pathParams: ["issueKey"], queryParams: [], hasBody: false }
}
```

---

## Implementation Order

1. **`endpoint-parser.ts`** + tests — pure string parsing, no dependencies
2. **`auth-resolver.ts`** + tests — wraps OpenClaw secret resolution
3. **`rest-adapter.ts`** + tests — generic fetch wrapper
4. **`quick-hydration.ts`** + tests — composes parser + resolver + adapter + registerHydration
5. **`plug-adapter.ts`** + tests — simpler, just resolver + registerHydration
6. **`json-loader.ts`** + tests — file read + validation + calls quickHydration
7. **`quick.ts`** barrel — re-exports quickHydration and plugAdapter
8. **Update `index.ts`** — call json-loader at startup
9. **Update `package.json`** — add `./quick` export
10. **Update README** — add Tier 0/1/2 getting started sections

## TTHW Targets

| Tier | Time | Steps |
|------|------|-------|
| JSON config | < 2 min | Write JSON, restart OpenClaw |
| quickHydration | < 5 min | One TS file, import, call |
| plugAdapter | < 5 min | Import existing exports, call |
| Full extension | 15-30 min | 7 files, plugin SDK knowledge |

## Open Questions

1. **Workspace path resolution**: How does the engine get the active workspace path at startup? Need to confirm the plugin SDK provides this (likely via `api.getWorkspacePath()` or similar).

2. **Hot reload**: Should the JSON loader watch for file changes and re-register? Or require restart? (Recommend: restart for v1, watch for v2.)

3. **Prompt auto-generation**: For JSON configs, should the engine auto-generate the system prompt from endpoint definitions if `prompt` is omitted? (Recommend: yes, as a best-effort fallback.)

4. **Response transforms**: Should endpoints support a `transform` field for reshaping API responses before they reach the LLM? (Recommend: defer to v2, keep v1 simple.)

5. **Pagination**: Should the REST adapter support automatic pagination? (Recommend: no, let users handle it in code mode script for now.)
