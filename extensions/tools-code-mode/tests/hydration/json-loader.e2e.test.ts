import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadJsonHydrations } from "../../src/hydration/json-loader.js";
import { globalCodeModeRegistry } from "../../src/registry.js";
import { createCodeModeTool } from "../../src/tool-factory.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "code-mode-test-"));
}

function writeJsonConfig(dir: string, config: unknown): void {
  fs.writeFileSync(path.join(dir, "code-mode-hydrations.json"), JSON.stringify(config, null, 2));
}

describe("json-loader e2e", () => {
  let tempDir: string;
  let originalFetch: typeof globalThis.fetch;
  const registeredIds: string[] = [];

  beforeEach(() => {
    tempDir = createTempDir();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const id of registeredIds) {
      globalCodeModeRegistry.unregister(id);
    }
    registeredIds.length = 0;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads hydrations from JSON and executes code against them", async () => {
    process.env.JSON_TEST_TOKEN = "json-secret";

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      json: () => Promise.resolve([{ id: 1, name: "Widget" }, { id: 2, name: "Gadget" }]),
      text: () => Promise.resolve('[{"id":1,"name":"Widget"},{"id":2,"name":"Gadget"}]'),
    }) as any;

    writeJsonConfig(tempDir, {
      hydrations: [
        {
          id: "products",
          namespaceName: "Shop",
          baseUrl: "https://api.shop.com",
          auth: { bearer: { env: "JSON_TEST_TOKEN" } },
          endpoints: {
            "products.list": "GET /products?category={category}",
            "products.get": "GET /products/{productId}",
          },
          prompt: "Shop.products.list({ category? }) -> product[]\nShop.products.get({ productId }) -> product",
        },
      ],
    });
    registeredIds.push("products");

    loadJsonHydrations(tempDir);

    const reg = globalCodeModeRegistry.get("products");
    expect(reg).toBeDefined();
    expect(reg!.hydration.namespaceName).toBe("Shop");
    expect(reg!.hydration.toolName).toBe("execute_products_code");

    const tool = createCodeModeTool(reg!.hydration, reg!.apiAdapter);
    const result = await tool.execute("json-e2e-1", {
      code: `
        const products = await Shop.products.list({ category: "electronics" });
        return products.map(p => p.name);
      `,
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.returnValue).toEqual(["Widget", "Gadget"]);

    delete process.env.JSON_TEST_TOKEN;
  });

  it("loads multiple hydrations from one JSON file", () => {
    process.env.TOKEN_A = "a";
    process.env.TOKEN_B = "b";

    writeJsonConfig(tempDir, {
      hydrations: [
        {
          id: "svc-a",
          namespaceName: "SvcA",
          baseUrl: "https://a.example.com",
          auth: { bearer: { env: "TOKEN_A" } },
          endpoints: { "ping": "GET /ping" },
        },
        {
          id: "svc-b",
          namespaceName: "SvcB",
          baseUrl: "https://b.example.com",
          auth: { bearer: { env: "TOKEN_B" } },
          endpoints: { "ping": "GET /ping" },
        },
      ],
    });
    registeredIds.push("svc-a", "svc-b");

    loadJsonHydrations(tempDir);

    expect(globalCodeModeRegistry.get("svc-a")).toBeDefined();
    expect(globalCodeModeRegistry.get("svc-b")).toBeDefined();

    delete process.env.TOKEN_A;
    delete process.env.TOKEN_B;
  });

  it("silently skips when no JSON file exists", () => {
    const emptyDir = createTempDir();
    loadJsonHydrations(emptyDir);
    // No error thrown, no hydrations registered
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it("warns and skips on invalid JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(path.join(tempDir, "code-mode-hydrations.json"), "not valid json {{{");

    loadJsonHydrations(tempDir);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[code-mode] Invalid JSON"),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it("warns and skips entries with missing required fields", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.VALID_TOKEN = "v";

    writeJsonConfig(tempDir, {
      hydrations: [
        { id: "incomplete" }, // missing namespaceName, baseUrl, auth, endpoints
        {
          id: "valid",
          namespaceName: "Valid",
          baseUrl: "https://example.com",
          auth: { bearer: { env: "VALID_TOKEN" } },
          endpoints: { "ping": "GET /ping" },
        },
      ],
    });
    registeredIds.push("valid");

    loadJsonHydrations(tempDir);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping invalid hydration entry"));
    expect(globalCodeModeRegistry.get("incomplete")).toBeUndefined();
    expect(globalCodeModeRegistry.get("valid")).toBeDefined();

    warnSpy.mockRestore();
    delete process.env.VALID_TOKEN;
  });

  it("skips duplicate IDs when extension already registered", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.DUP_TOKEN = "d";

    // Pre-register via extension
    globalCodeModeRegistry.register(
      {
        id: "existing",
        toolName: "execute_existing_code",
        displayName: "Existing",
        namespaceName: "Existing",
        createNamespace: () => ({}),
        collectionClasses: {},
        getSystemPrompt: () => "existing",
      },
      null,
    );
    registeredIds.push("existing");

    writeJsonConfig(tempDir, {
      hydrations: [
        {
          id: "existing",
          namespaceName: "Duplicate",
          baseUrl: "https://example.com",
          auth: { bearer: { env: "DUP_TOKEN" } },
          endpoints: { "ping": "GET /ping" },
        },
      ],
    });

    loadJsonHydrations(tempDir);

    // Extension registration should be preserved
    const reg = globalCodeModeRegistry.get("existing")!;
    expect(reg.hydration.namespaceName).toBe("Existing"); // not "Duplicate"
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("already registered by extension"));

    warnSpy.mockRestore();
    delete process.env.DUP_TOKEN;
  });

  it("supports EndpointConfig object format in JSON", async () => {
    process.env.OBJ_TOKEN = "obj";

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      json: () => Promise.resolve({ status: "ok" }),
      text: () => Promise.resolve('{"status":"ok"}'),
    }) as any;

    writeJsonConfig(tempDir, {
      hydrations: [
        {
          id: "obj-api",
          namespaceName: "ObjApi",
          baseUrl: "https://api.example.com",
          auth: { bearer: { env: "OBJ_TOKEN" } },
          endpoints: {
            "items.search": {
              method: "GET",
              path: "/items",
              params: {
                q: { type: "string", required: true, in: "query" },
                limit: { type: "number", default: 20, in: "query" },
              },
            },
          },
          prompt: "ObjApi.items.search({ q, limit? })",
        },
      ],
    });
    registeredIds.push("obj-api");

    loadJsonHydrations(tempDir);

    const reg = globalCodeModeRegistry.get("obj-api")!;
    const tool = createCodeModeTool(reg.hydration, reg.apiAdapter);

    const result = await tool.execute("obj-1", {
      code: `return await ObjApi.items.search({ q: "test" });`,
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.returnValue).toEqual({ status: "ok" });

    const fetchMock = globalThis.fetch as any;
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("q=test");

    delete process.env.OBJ_TOKEN;
  });

  it("full e2e: JSON config → register → execute → multi-step code", async () => {
    process.env.SHOP_TOKEN = "shop-secret";

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/products") && url.includes("category=phones")) {
        return Promise.resolve({
          ok: true, status: 200,
          headers: new Map([["content-type", "application/json"]]),
          json: () => Promise.resolve([
            { id: "p1", name: "Phone A", price: 999 },
            { id: "p2", name: "Phone B", price: 799 },
            { id: "p3", name: "Phone C", price: 1199 },
          ]),
          text: () => Promise.resolve("[]"),
        });
      }
      if (url.includes("/products/p1")) {
        return Promise.resolve({
          ok: true, status: 200,
          headers: new Map([["content-type", "application/json"]]),
          json: () => Promise.resolve({ id: "p1", name: "Phone A", price: 999, specs: { ram: "8GB" } }),
          text: () => Promise.resolve("{}"),
        });
      }
      return Promise.resolve({
        ok: false, status: 404,
        headers: new Map([["content-type", "application/json"]]),
        json: () => Promise.resolve({ error: "not found" }),
        text: () => Promise.resolve('{"error":"not found"}'),
      });
    });
    globalThis.fetch = fetchMock as any;

    writeJsonConfig(tempDir, {
      hydrations: [
        {
          id: "shop",
          namespaceName: "Shop",
          baseUrl: "https://api.shop.io/v2",
          auth: { bearer: { env: "SHOP_TOKEN" } },
          headers: { "Accept": "application/json" },
          endpoints: {
            "products.list": "GET /products?category={category}&limit={limit}",
            "products.get": "GET /products/{productId}",
          },
          prompt: "Shop.products.list/get",
        },
      ],
    });
    registeredIds.push("shop");

    loadJsonHydrations(tempDir);

    const reg = globalCodeModeRegistry.get("shop")!;
    const tool = createCodeModeTool(reg.hydration, reg.apiAdapter);

    const result = await tool.execute("e2e-multi", {
      code: `
        const phones = await Shop.products.list({ category: "phones", limit: 3 });
        const cheapest = phones.reduce((a, b) => a.price < b.price ? a : b);
        const details = await Shop.products.get({ productId: cheapest.id });
        return { name: details.name, price: details.price, ram: details.specs.ram };
      `,
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.returnValue).toEqual({
      name: "Phone B",
      price: 799,
      ram: "8GB",
    });

    // Verify 2 fetch calls (list + get for cheapest)
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Verify auth applied to both calls
    for (const [, opts] of fetchMock.mock.calls) {
      expect(opts.headers["Authorization"]).toBe("Bearer shop-secret");
      expect(opts.headers["Accept"]).toBe("application/json");
    }

    delete process.env.SHOP_TOKEN;
  });
});
