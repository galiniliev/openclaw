import type { AuthConfig, ResolvedAuth } from "./auth-resolver.js";
import { resolveAuth } from "./auth-resolver.js";
import { registerCodeModeNamespace } from "../../api.js";
import { CodeModeError } from "../errors.js";
import type { CodeModeNamespace } from "../types.js";

export interface PlugAdapterConfig<TApi, TNamespace> {
  id: string;
  namespaceName: string;
  displayName?: string;
  createNamespace: (api: TApi) => TNamespace;
  collectionClasses?: Record<string, new (...args: unknown[]) => unknown>;
  getSystemPrompt: (context?: unknown) => string;
  auth: AuthConfig;
  createAdapter: (auth: ResolvedAuth) => TApi;
  extraGlobals?: (api: TApi, context?: unknown) => Record<string, unknown>;
  validateApi?: (api: TApi) => string | undefined;
  timeoutMs?: number;
  maxTimeoutMs?: number;
  maxCodeBytes?: number;
}

export function plugAdapter<TApi, TNamespace>(
  config: PlugAdapterConfig<TApi, TNamespace>,
  openclawConfig?: unknown,
): void {
  let cachedNamespace: TNamespace | null = null;
  let cachedApi: TApi | null = null;

  async function ensureInitialized(): Promise<{ api: TApi; namespace: TNamespace }> {
    if (cachedNamespace && cachedApi) return { api: cachedApi, namespace: cachedNamespace };
    const auth = await resolveAuth(config.auth, openclawConfig);
    cachedApi = config.createAdapter(auth);
    if (config.validateApi) {
      const err = config.validateApi(cachedApi);
      if (err) {
        cachedApi = null;
        throw new CodeModeError("validationError", err);
      }
    }
    cachedNamespace = config.createNamespace(cachedApi);
    return { api: cachedApi, namespace: cachedNamespace };
  }

  // Build a proxy namespace that lazily initializes on any property access
  const lazyNamespace = new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      return async (...args: unknown[]) => {
        const { namespace } = await ensureInitialized();
        const segments = prop.split(".");
        let current: unknown = namespace;
        for (const seg of segments) {
          current = (current as Record<string, unknown>)[seg];
        }
        if (typeof current === "function") {
          return (current as Function)(...args);
        }
        return current;
      };
    },
    has() {
      return true;
    },
    ownKeys() {
      if (cachedNamespace && typeof cachedNamespace === "object") {
        return Reflect.ownKeys(cachedNamespace as object);
      }
      return [];
    },
  });

  const ns: CodeModeNamespace<unknown, unknown> = {
    id: config.id,
    toolName: `execute_${config.id}_code`,
    displayName: config.displayName ?? `${config.namespaceName} Code Mode`,
    namespaceName: config.namespaceName,
    createNamespace: () => lazyNamespace,
    collectionClasses: config.collectionClasses ?? {},
    getSystemPrompt: config.getSystemPrompt,
    defaultTimeoutMs: config.timeoutMs ?? 30_000,
    maxTimeoutMs: config.maxTimeoutMs ?? 120_000,
    maxCodeBytes: config.maxCodeBytes ?? 100_000,
    extraGlobals: config.extraGlobals
      ? (_api, context) => {
          if (!cachedApi) return {};
          return config.extraGlobals!(cachedApi, context);
        }
      : undefined,
  };

  registerCodeModeNamespace(ns, null);
}
