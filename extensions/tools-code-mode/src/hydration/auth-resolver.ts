import { CodeModeError } from "../errors.js";

export interface SecretRef {
  configPath?: string;
  env?: string;
}

export type AuthConfig =
  | { bearer: SecretRef }
  | { basic: { user: string; pass: SecretRef } }
  | { header: { name: string; value: SecretRef } }
  | { query: { param: string; value: SecretRef } };

export interface ResolvedAuth {
  applyToRequest(headers: Record<string, string>, url: URL): void;
}

async function resolveSecret(ref: SecretRef, config: unknown): Promise<string> {
  if (ref.configPath && config) {
    try {
      const { resolveConfiguredSecretInputString } = await import(
        "openclaw/plugin-sdk/secret-input-runtime"
      );
      const value = await resolveConfiguredSecretInputString(ref.configPath, config);
      if (value) return value;
    } catch {
      // fall through to env
    }
  }

  if (ref.env) {
    const value = process.env[ref.env];
    if (value) return value;
  }

  const source = ref.configPath ?? ref.env ?? "unknown";
  throw new CodeModeError(
    "validationError",
    `Failed to resolve secret: ${source} not set`,
  );
}

export async function resolveAuth(auth: AuthConfig, config: unknown): Promise<ResolvedAuth> {
  if ("bearer" in auth) {
    const token = await resolveSecret(auth.bearer, config);
    return {
      applyToRequest(headers) {
        headers["Authorization"] = `Bearer ${token}`;
      },
    };
  }

  if ("basic" in auth) {
    const pass = await resolveSecret(auth.basic.pass, config);
    const encoded = Buffer.from(`${auth.basic.user}:${pass}`).toString("base64");
    return {
      applyToRequest(headers) {
        headers["Authorization"] = `Basic ${encoded}`;
      },
    };
  }

  if ("header" in auth) {
    const value = await resolveSecret(auth.header.value, config);
    const name = auth.header.name;
    return {
      applyToRequest(headers) {
        headers[name] = value;
      },
    };
  }

  if ("query" in auth) {
    const value = await resolveSecret(auth.query.value, config);
    const param = auth.query.param;
    return {
      applyToRequest(_headers, url) {
        url.searchParams.set(param, value);
      },
    };
  }

  throw new CodeModeError("validationError", "Invalid auth config: no recognized auth type");
}
