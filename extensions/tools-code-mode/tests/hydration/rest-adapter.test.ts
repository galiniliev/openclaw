import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildLazyNamespace } from "../../src/hydration/rest-adapter.js";
import type { ParsedEndpoint } from "../../src/hydration/endpoint-parser.js";
import type { ResolvedAuth } from "../../src/hydration/auth-resolver.js";

const mockAuth: ResolvedAuth = {
  applyToRequest(headers) {
    headers["Authorization"] = "Bearer test-token";
  },
};

function mockFetch(responseBody: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "application/json"]]) as any,
    json: () => Promise.resolve(responseBody),
    text: () => Promise.resolve(JSON.stringify(responseBody)),
  });
}

describe("rest-adapter", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds nested namespace from dot-separated keys", () => {
    const endpoints: Record<string, ParsedEndpoint> = {
      "issues.list": { method: "GET", path: "/search", pathParams: [], queryParams: ["jql"], hasBody: false },
      "issues.get": { method: "GET", path: "/issue/{issueKey}", pathParams: ["issueKey"], queryParams: [], hasBody: false },
      "repos.list": { method: "GET", path: "/repos", pathParams: [], queryParams: [], hasBody: false },
    };

    const ns = buildLazyNamespace("https://api.example.com", endpoints, undefined, async () => mockAuth);

    expect(ns).toHaveProperty("issues");
    expect(ns).toHaveProperty("repos");
    const issues = ns["issues"] as Record<string, unknown>;
    expect(issues).toHaveProperty("list");
    expect(issues).toHaveProperty("get");
    expect(typeof issues["list"]).toBe("function");
    expect(typeof issues["get"]).toBe("function");
    expect(typeof (ns["repos"] as Record<string, unknown>)["list"]).toBe("function");
  });

  it("resolves auth lazily on first call and caches", async () => {
    let resolveCount = 0;
    const resolveAuthFn = async () => {
      resolveCount++;
      return mockAuth;
    };

    const endpoints: Record<string, ParsedEndpoint> = {
      "ping": { method: "GET", path: "/ping", pathParams: [], queryParams: [], hasBody: false },
    };

    globalThis.fetch = mockFetch({ ok: true }) as any;
    const ns = buildLazyNamespace("https://api.example.com", endpoints, undefined, resolveAuthFn);

    expect(resolveCount).toBe(0);

    await (ns["ping"] as Function)();
    expect(resolveCount).toBe(1);

    await (ns["ping"] as Function)();
    expect(resolveCount).toBe(1);
  });

  it("substitutes path params", async () => {
    const endpoints: Record<string, ParsedEndpoint> = {
      "get": { method: "GET", path: "/issue/{issueKey}", pathParams: ["issueKey"], queryParams: [], hasBody: false },
    };

    const fetchMock = mockFetch({ id: "123" });
    globalThis.fetch = fetchMock as any;

    const ns = buildLazyNamespace("https://api.example.com", endpoints, undefined, async () => mockAuth);
    await (ns["get"] as Function)({ issueKey: "PROJ-42" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("/issue/PROJ-42");
  });

  it("appends query params for GET", async () => {
    const endpoints: Record<string, ParsedEndpoint> = {
      "search": { method: "GET", path: "/search", pathParams: [], queryParams: ["jql", "maxResults"], hasBody: false },
    };

    const fetchMock = mockFetch([]);
    globalThis.fetch = fetchMock as any;

    const ns = buildLazyNamespace("https://api.example.com", endpoints, undefined, async () => mockAuth);
    await (ns["search"] as Function)({ jql: "project=TEST", maxResults: 10 });

    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("jql=project%3DTEST");
    expect(url).toContain("maxResults=10");
  });

  it("sends JSON body for POST", async () => {
    const endpoints: Record<string, ParsedEndpoint> = {
      "create": { method: "POST", path: "/issue", pathParams: [], queryParams: [], hasBody: true },
    };

    const fetchMock = mockFetch({ id: "new-1" });
    globalThis.fetch = fetchMock as any;

    const ns = buildLazyNamespace("https://api.example.com", endpoints, undefined, async () => mockAuth);
    await (ns["create"] as Function)({ summary: "New issue", description: "Details" });

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ summary: "New issue", description: "Details" });
    expect(opts.headers["Content-Type"]).toBe("application/json");
  });

  it("applies auth headers", async () => {
    const endpoints: Record<string, ParsedEndpoint> = {
      "ping": { method: "GET", path: "/ping", pathParams: [], queryParams: [], hasBody: false },
    };

    const fetchMock = mockFetch({ ok: true });
    globalThis.fetch = fetchMock as any;

    const ns = buildLazyNamespace("https://api.example.com", endpoints, undefined, async () => mockAuth);
    await (ns["ping"] as Function)();

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers["Authorization"]).toBe("Bearer test-token");
  });

  it("applies default headers", async () => {
    const endpoints: Record<string, ParsedEndpoint> = {
      "ping": { method: "GET", path: "/ping", pathParams: [], queryParams: [], hasBody: false },
    };

    const fetchMock = mockFetch({ ok: true });
    globalThis.fetch = fetchMock as any;

    const ns = buildLazyNamespace(
      "https://api.example.com",
      endpoints,
      { "Accept": "application/json", "X-Custom": "val" },
      async () => mockAuth,
    );
    await (ns["ping"] as Function)();

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers["Accept"]).toBe("application/json");
    expect(opts.headers["X-Custom"]).toBe("val");
  });

  it("throws CodeModeError on non-2xx response", async () => {
    const endpoints: Record<string, ParsedEndpoint> = {
      "get": { method: "GET", path: "/fail", pathParams: [], queryParams: [], hasBody: false },
    };

    globalThis.fetch = mockFetch({ error: "not found" }, 404) as any;

    const ns = buildLazyNamespace("https://api.example.com", endpoints, undefined, async () => mockAuth);

    await expect((ns["get"] as Function)()).rejects.toThrow("returned 404");
  });

  it("throws on missing required path param", async () => {
    const endpoints: Record<string, ParsedEndpoint> = {
      "get": { method: "GET", path: "/issue/{issueKey}", pathParams: ["issueKey"], queryParams: [], hasBody: false },
    };

    globalThis.fetch = mockFetch({}) as any;

    const ns = buildLazyNamespace("https://api.example.com", endpoints, undefined, async () => mockAuth);

    await expect((ns["get"] as Function)({})).rejects.toThrow("Missing required path param: issueKey");
  });

  it("skips null/undefined query params", async () => {
    const endpoints: Record<string, ParsedEndpoint> = {
      "search": { method: "GET", path: "/search", pathParams: [], queryParams: ["q", "limit"], hasBody: false },
    };

    const fetchMock = mockFetch([]);
    globalThis.fetch = fetchMock as any;

    const ns = buildLazyNamespace("https://api.example.com", endpoints, undefined, async () => mockAuth);
    await (ns["search"] as Function)({ q: "test", limit: undefined });

    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("q=test");
    expect(url).not.toContain("limit");
  });
});
