import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { quickHydration } from "../../src/hydration/quick-hydration.js";
import { globalCodeModeRegistry, globalCodeModeSessionManager } from "../../src/registry.js";
import { createCodeModeTool } from "../../src/tool-factory.js";

function mockFetchResponses(responses: Record<string, unknown>) {
  return vi.fn().mockImplementation((url: string, opts: any) => {
    for (const [pattern, body] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([["content-type", "application/json"]]),
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(JSON.stringify(body)),
        });
      }
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      headers: new Map([["content-type", "application/json"]]),
      json: () => Promise.resolve({ error: "not found" }),
      text: () => Promise.resolve('{"error":"not found"}'),
    });
  });
}

describe("quickHydration e2e", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalCodeModeRegistry.unregister("test-api");
  });

  it("registers a hydration and executes code against it", async () => {
    globalThis.fetch = mockFetchResponses({
      "/users": [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }],
    }) as any;

    // Mock the auth resolution (env var)
    process.env.TEST_API_TOKEN = "secret-123";

    quickHydration({
      id: "test-api",
      namespaceName: "TestApi",
      baseUrl: "https://api.example.com",
      auth: { bearer: { env: "TEST_API_TOKEN" } },
      endpoints: {
        "users.list": "GET /users?limit={limit}",
      },
      prompt: "TestApi.users.list({ limit? }) -> user[]",
    });

    const reg = globalCodeModeRegistry.get("test-api");
    expect(reg).toBeDefined();
    expect(reg!.hydration.toolName).toBe("execute_test-api_code");
    expect(reg!.hydration.displayName).toBe("TestApi Code Mode");

    const tool = createCodeModeTool(reg!.hydration, reg!.apiAdapter);
    const result = await tool.execute("call-1", {
      code: `
        const users = await TestApi.users.list({ limit: 10 });
        return users.map(u => u.name);
      `,
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.returnValue).toEqual(["Alice", "Bob"]);

    // Verify fetch was called with correct URL and auth
    const fetchMock = globalThis.fetch as any;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/users");
    expect(url).toContain("limit=10");
    expect(opts.headers["Authorization"]).toBe("Bearer secret-123");

    delete process.env.TEST_API_TOKEN;
  });

  it("supports multiple endpoints with nested namespace", async () => {
    globalThis.fetch = mockFetchResponses({
      "/repos": [{ name: "repo-a" }],
      "/repos/owner/repo-a/issues": [{ id: 1, title: "Bug" }],
    }) as any;

    process.env.GH_TOKEN = "ghp_test";

    quickHydration({
      id: "test-api",
      namespaceName: "GitHub",
      baseUrl: "https://api.github.com",
      auth: { bearer: { env: "GH_TOKEN" } },
      headers: { "Accept": "application/vnd.github+json" },
      endpoints: {
        "repos.list": "GET /repos?per_page={perPage}",
        "repos.issues": "GET /repos/{owner}/{repo}/issues?state={state}",
      },
      prompt: "GitHub namespace",
    });

    const reg = globalCodeModeRegistry.get("test-api")!;
    const tool = createCodeModeTool(reg.hydration, reg.apiAdapter);

    const result = await tool.execute("call-2", {
      code: `
        const issues = await GitHub.repos.issues({ owner: "owner", repo: "repo-a", state: "open" });
        return issues[0].title;
      `,
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.returnValue).toBe("Bug");

    delete process.env.GH_TOKEN;
  });

  it("auto-generates prompt when omitted", () => {
    process.env.TEST_TOKEN = "x";

    quickHydration({
      id: "test-api",
      namespaceName: "Svc",
      baseUrl: "https://example.com",
      auth: { bearer: { env: "TEST_TOKEN" } },
      endpoints: {
        "items.list": "GET /items?q={q}",
        "items.create": "POST /items",
      },
    });

    const reg = globalCodeModeRegistry.get("test-api")!;
    const prompt = reg.hydration.getSystemPrompt();
    expect(prompt).toContain("Svc namespace:");
    expect(prompt).toContain("Svc.items.list");
    expect(prompt).toContain("Svc.items.create");

    delete process.env.TEST_TOKEN;
  });

  it("returns auth error when env var missing", async () => {
    delete process.env.MISSING_TOKEN;

    quickHydration({
      id: "test-api",
      namespaceName: "Broken",
      baseUrl: "https://example.com",
      auth: { bearer: { env: "MISSING_TOKEN" } },
      endpoints: {
        "ping": "GET /ping",
      },
      prompt: "test",
    });

    const reg = globalCodeModeRegistry.get("test-api")!;
    const tool = createCodeModeTool(reg.hydration, reg.apiAdapter);

    const result = await tool.execute("call-err", {
      code: `return await Broken.ping();`,
    });

    expect(result.details.ok).toBe(false);
    expect(result.details.error).toContain("MISSING_TOKEN");
  });

  it("caches auth across multiple executions", async () => {
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      fetchCount++;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "application/json"]]),
        json: () => Promise.resolve({ pong: true }),
        text: () => Promise.resolve('{"pong":true}'),
      });
    }) as any;

    process.env.CACHE_TOKEN = "cached";

    quickHydration({
      id: "test-api",
      namespaceName: "Svc",
      baseUrl: "https://example.com",
      auth: { bearer: { env: "CACHE_TOKEN" } },
      endpoints: { "ping": "GET /ping" },
      prompt: "test",
    });

    const reg = globalCodeModeRegistry.get("test-api")!;
    const tool = createCodeModeTool(reg.hydration, reg.apiAdapter);

    await tool.execute("c1", { code: `return await Svc.ping();` });
    await tool.execute("c2", { code: `return await Svc.ping();` });
    await tool.execute("c3", { code: `return await Svc.ping();` });

    // Auth resolved once, all 3 fetches succeed
    expect(fetchCount).toBe(3);

    delete process.env.CACHE_TOKEN;
  });

  it("supports POST with body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Map([["content-type", "application/json"]]),
      json: () => Promise.resolve({ id: "new-1", title: "Created" }),
      text: () => Promise.resolve('{"id":"new-1","title":"Created"}'),
    });
    globalThis.fetch = fetchMock as any;
    process.env.POST_TOKEN = "t";

    quickHydration({
      id: "test-api",
      namespaceName: "Api",
      baseUrl: "https://example.com",
      auth: { bearer: { env: "POST_TOKEN" } },
      endpoints: { "items.create": "POST /items" },
      prompt: "test",
    });

    const reg = globalCodeModeRegistry.get("test-api")!;
    const tool = createCodeModeTool(reg.hydration, reg.apiAdapter);

    const result = await tool.execute("post-1", {
      code: `return await Api.items.create({ title: "New item", priority: "high" });`,
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.returnValue).toEqual({ id: "new-1", title: "Created" });

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ title: "New item", priority: "high" });

    delete process.env.POST_TOKEN;
  });
});
