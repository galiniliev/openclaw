import type { ParsedEndpoint } from "./endpoint-parser.js";
import type { ResolvedAuth } from "./auth-resolver.js";
import { CodeModeError } from "../errors.js";

export function buildLazyNamespace(
  baseUrl: string,
  endpoints: Record<string, ParsedEndpoint>,
  headers: Record<string, string> | undefined,
  resolveAuthFn: () => Promise<ResolvedAuth>,
): Record<string, unknown> {
  let cached: ResolvedAuth | null = null;
  async function getAuth(): Promise<ResolvedAuth> {
    if (!cached) cached = await resolveAuthFn();
    return cached;
  }

  const namespace: Record<string, unknown> = Object.create(null);

  for (const [dotPath, endpoint] of Object.entries(endpoints)) {
    const segments = dotPath.split(".");
    let current = namespace;
    for (let i = 0; i < segments.length - 1; i++) {
      if (!(segments[i] in current)) {
        current[segments[i]] = Object.create(null);
      }
      current = current[segments[i]] as Record<string, unknown>;
    }

    const methodName = segments[segments.length - 1];
    current[methodName] = buildEndpointMethod(baseUrl, endpoint, headers, getAuth);
  }

  return namespace;
}

function buildEndpointMethod(
  baseUrl: string,
  endpoint: ParsedEndpoint,
  defaultHeaders: Record<string, string> | undefined,
  getAuth: () => Promise<ResolvedAuth>,
): (...args: unknown[]) => Promise<unknown> {
  return async (...args: unknown[]) => {
    const auth = await getAuth();

    let params: Record<string, unknown> = {};
    let body: unknown = undefined;

    if (endpoint.hasBody) {
      if (endpoint.pathParams.length > 0 || endpoint.queryParams.length > 0) {
        params = (args[0] as Record<string, unknown>) ?? {};
        body = args[1];
      } else {
        body = args[0];
      }
    } else {
      params = (args[0] as Record<string, unknown>) ?? {};
    }

    let path = endpoint.path;
    for (const p of endpoint.pathParams) {
      const val = params[p];
      if (val == null) {
        throw new CodeModeError("validationError", `Missing required path param: ${p}`);
      }
      path = path.replace(`{${p}}`, encodeURIComponent(String(val)));
    }

    const url = new URL(path, baseUrl);

    for (const q of endpoint.queryParams) {
      const val = params[q];
      if (val != null) {
        url.searchParams.set(q, String(val));
      }
    }

    const reqHeaders: Record<string, string> = {
      ...defaultHeaders,
      ...endpoint.headers,
    };

    if (body !== undefined) {
      reqHeaders["Content-Type"] = reqHeaders["Content-Type"] ?? "application/json";
    }

    auth.applyToRequest(reqHeaders, url);

    const response = await fetch(url.toString(), {
      method: endpoint.method,
      headers: reqHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const excerpt = text.length > 500 ? text.slice(0, 500) + "..." : text;
      throw new CodeModeError(
        "apiCallFailed",
        `${endpoint.method} ${path} returned ${response.status}: ${excerpt}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    return response.text();
  };
}
