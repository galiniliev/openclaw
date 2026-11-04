import path from "node:path";
import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { isSecretRef, isValidSecretRef } from "openclaw/plugin-sdk/secret-input";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type CrabboxSetupSecrets = Record<string, SecretRef & { source: "store" }>;
export type CrabboxSetupInitializer = { command: string[]; envKeys: string[] };

export function parseCrabboxSetupInitializer(
  value: unknown,
  target: string,
  setupSecrets?: Readonly<Record<string, unknown>>,
): CrabboxSetupInitializer | undefined {
  if (value === undefined) {
    return undefined;
  }
  const spec = asOptionalRecord(value);
  if (
    !spec ||
    Object.keys(spec).some((key) => key !== "command" && key !== "envKeys") ||
    !Array.isArray(spec.command) ||
    !spec.command.length ||
    spec.command.length > 16 ||
    !spec.command.every(
      (arg) =>
        typeof arg === "string" && arg.length > 0 && arg.length <= 4096 && !arg.includes("\0"),
    ) ||
    !path.posix.isAbsolute(spec.command[0]) ||
    !Array.isArray(spec.envKeys) ||
    !spec.envKeys.length ||
    spec.envKeys.length > 16 ||
    !spec.envKeys.every(
      (key) => typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key),
    ) ||
    new Set(spec.envKeys).size !== spec.envKeys.length
  ) {
    throw new WorkerProviderError(
      "Crabbox setupInitializer requires absolute command argv and unique environment names",
    );
  }
  for (const key of spec.envKeys) {
    if (
      /^(?:IDENTITY_|MSI_|OPENCLAW_|NODE_|BASH_|GIT_|LD_|DYLD_)/u.test(key) ||
      [
        "PATH",
        "HOME",
        "LANG",
        "ENV",
        "SHELLOPTS",
        "PYTHONPATH",
        "PYTHONHOME",
        "AZURE_CONFIG_DIR",
        "AZURE_FEDERATED_TOKEN_FILE",
      ].includes(key) ||
      /^(?:https?|all|no)_proxy$/iu.test(key)
    ) {
      throw new WorkerProviderError(`Crabbox setupInitializer environment name ${key} is reserved`);
    }
  }
  if (target !== "linux") {
    throw new WorkerProviderError("Crabbox setupInitializer requires a prepared Linux workspace");
  }
  if (spec.envKeys.some((key) => setupSecrets && Object.hasOwn(setupSecrets, key))) {
    throw new WorkerProviderError(
      "Crabbox setupInitializer and setupSecrets must use distinct environment names",
    );
  }
  return {
    command: spec.command,
    envKeys: spec.envKeys.toSorted((left, right) => left.localeCompare(right)),
  };
}

export function parseCrabboxSetupSecrets(value: unknown): CrabboxSetupSecrets | undefined {
  if (value === undefined) {
    return undefined;
  }
  const entries = asOptionalRecord(value);
  if (!entries) {
    throw new WorkerProviderError("Crabbox profile setupSecrets must be a map of store SecretRefs");
  }
  if (Object.keys(entries).length > 16) {
    throw new WorkerProviderError("Crabbox profile setupSecrets must contain at most 16 names");
  }
  const parsed: NonNullable<CrabboxSetupSecrets> = {};
  for (const [name, ref] of Object.entries(entries)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new WorkerProviderError(
        "Crabbox profile setupSecrets keys must be valid POSIX environment variable names",
      );
    }
    if (
      [
        "CRABBOX_ENV_ALLOW",
        "HOME",
        "PATH",
        "LANG",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "CURL_CA_BUNDLE",
        "GIT_SSL_CAINFO",
        "REQUESTS_CA_BUNDLE",
        "NODE_USE_ENV_PROXY",
        "CRABBOX_SETUP_PROXY",
      ].includes(name) ||
      /^(?:https?|all|no)_proxy$/iu.test(name) ||
      name.startsWith("OPENCLAW_")
    ) {
      throw new WorkerProviderError(`Crabbox profile setupSecrets name ${name} is reserved`);
    }
    if (!isSecretRef(ref) || !isValidSecretRef(ref) || ref.source !== "store") {
      throw new WorkerProviderError(
        `Crabbox profile setupSecrets entry ${name} must use a store SecretRef { source: "store", provider, id }; inline values and other sources are unavailable`,
      );
    }
    parsed[name] = { source: "store", provider: ref.provider, id: ref.id };
  }
  return parsed;
}
