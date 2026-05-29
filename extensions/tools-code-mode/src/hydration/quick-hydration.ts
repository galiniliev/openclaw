import type { AuthConfig } from "./auth-resolver.js";
import type { EndpointConfig } from "./endpoint-parser.js";
import { parseEndpointConfig } from "./endpoint-parser.js";
import { resolveAuth } from "./auth-resolver.js";
import { buildLazyNamespace } from "./rest-adapter.js";
import { registerCodeModeNamespace } from "../../api.js";
import type { CodeModeNamespace } from "../types.js";

export interface QuickHydrationConfig {
  id: string;
  namespaceName: string;
  displayName?: string;
  baseUrl: string;
  auth: AuthConfig;
  headers?: Record<string, string>;
  endpoints: Record<string, string | EndpointConfig>;
  prompt?: string;
  timeoutMs?: number;
  maxTimeoutMs?: number;
  maxCodeBytes?: number;
}

export function quickHydration(config: QuickHydrationConfig, openclawConfig?: unknown): void {
  const parsed = Object.fromEntries(
    Object.entries(config.endpoints).map(([key, ep]) => [key, parseEndpointConfig(ep)]),
  );

  const prompt = config.prompt ?? generatePrompt(config.namespaceName, config.endpoints);

  const namespace = buildLazyNamespace(
    config.baseUrl,
    parsed,
    config.headers,
    () => resolveAuth(config.auth, openclawConfig),
  );

  const ns: CodeModeNamespace<null, Record<string, unknown>> = {
    id: config.id,
    toolName: `execute_${config.id}_code`,
    displayName: config.displayName ?? `${config.namespaceName} Code Mode`,
    namespaceName: config.namespaceName,
    createNamespace: () => namespace,
    collectionClasses: {},
    getSystemPrompt: () => prompt,
    defaultTimeoutMs: config.timeoutMs ?? 30_000,
    maxTimeoutMs: config.maxTimeoutMs ?? 120_000,
    maxCodeBytes: config.maxCodeBytes ?? 100_000,
  };

  registerCodeModeNamespace(ns, null);
}

function generatePrompt(namespaceName: string, endpoints: Record<string, string | EndpointConfig>): string {
  const lines = [`${namespaceName} namespace:`];
  for (const [dotPath, ep] of Object.entries(endpoints)) {
    const parsed = parseEndpointConfig(ep);
    const allParams = [...parsed.pathParams, ...parsed.queryParams];
    const paramStr = allParams.length > 0 ? `{ ${allParams.join(", ")} }` : "";
    const bodyStr = parsed.hasBody ? (paramStr ? ", body" : "body") : "";
    lines.push(`- ${namespaceName}.${dotPath}(${paramStr}${bodyStr})`);
  }
  return lines.join("\n");
}
