import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseEndpointShorthand, parseEndpointConfig } from "../../src/hydration/endpoint-parser.js";

describe("endpoint-parser", () => {
  describe("parseEndpointShorthand", () => {
    it("parses GET with query params", () => {
      const result = parseEndpointShorthand("GET /search?jql={jql}&maxResults={maxResults}");
      expect(result).toEqual({
        method: "GET",
        path: "/search",
        pathParams: [],
        queryParams: ["jql", "maxResults"],
        hasBody: false,
      });
    });

    it("parses GET with path params", () => {
      const result = parseEndpointShorthand("GET /issue/{issueKey}");
      expect(result).toEqual({
        method: "GET",
        path: "/issue/{issueKey}",
        pathParams: ["issueKey"],
        queryParams: [],
        hasBody: false,
      });
    });

    it("parses POST (infers hasBody)", () => {
      const result = parseEndpointShorthand("POST /issue");
      expect(result).toEqual({
        method: "POST",
        path: "/issue",
        pathParams: [],
        queryParams: [],
        hasBody: true,
      });
    });

    it("parses PUT with path param", () => {
      const result = parseEndpointShorthand("PUT /issue/{issueKey}");
      expect(result).toEqual({
        method: "PUT",
        path: "/issue/{issueKey}",
        pathParams: ["issueKey"],
        queryParams: [],
        hasBody: true,
      });
    });

    it("parses DELETE", () => {
      const result = parseEndpointShorthand("DELETE /issue/{issueKey}");
      expect(result).toEqual({
        method: "DELETE",
        path: "/issue/{issueKey}",
        pathParams: ["issueKey"],
        queryParams: [],
        hasBody: false,
      });
    });

    it("parses mixed path and query params", () => {
      const result = parseEndpointShorthand("GET /repos/{owner}/{repo}/issues?state={state}&per_page={perPage}");
      expect(result).toEqual({
        method: "GET",
        path: "/repos/{owner}/{repo}/issues",
        pathParams: ["owner", "repo"],
        queryParams: ["state", "perPage"],
        hasBody: false,
      });
    });

    it("normalizes method to uppercase", () => {
      const result = parseEndpointShorthand("get /ping");
      expect(result.method).toBe("GET");
    });

    it("throws on invalid shorthand (no space)", () => {
      expect(() => parseEndpointShorthand("GET/ping")).toThrow("Invalid endpoint shorthand");
    });
  });

  describe("parseEndpointConfig", () => {
    it("delegates strings to parseEndpointShorthand", () => {
      const result = parseEndpointConfig("GET /ping");
      expect(result.method).toBe("GET");
      expect(result.path).toBe("/ping");
    });

    it("parses EndpointConfig object with explicit params", () => {
      const result = parseEndpointConfig({
        method: "GET",
        path: "/search",
        params: {
          jql: { type: "string", required: true, in: "query" },
          maxResults: { type: "number", default: 50, in: "query" },
        },
      });
      expect(result.method).toBe("GET");
      expect(result.path).toBe("/search");
      expect(result.queryParams).toEqual(["jql", "maxResults"]);
      expect(result.pathParams).toEqual([]);
      expect(result.hasBody).toBe(false);
    });

    it("infers path params from path template when in is not specified", () => {
      const result = parseEndpointConfig({
        method: "GET",
        path: "/issue/{issueKey}",
        params: {
          issueKey: { type: "string", required: true },
        },
      });
      expect(result.pathParams).toEqual(["issueKey"]);
      expect(result.queryParams).toEqual([]);
    });

    it("respects explicit body flag", () => {
      const result = parseEndpointConfig({
        method: "GET",
        path: "/search",
        body: true,
      });
      expect(result.hasBody).toBe(true);
    });

    it("preserves endpoint-level headers", () => {
      const result = parseEndpointConfig({
        method: "GET",
        path: "/search",
        headers: { "X-Custom": "value" },
      });
      expect(result.headers).toEqual({ "X-Custom": "value" });
    });
  });
});
