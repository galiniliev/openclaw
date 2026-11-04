import { createHash } from "node:crypto";
import path from "node:path";
import {
  WorkerProviderError,
  type WorkerMachineOption,
  type WorkerProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  asOptionalRecord,
  normalizeOptionalString as nonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CrabboxProviderEnvironment } from "./crabbox-worker-command.js";
import {
  parseCrabboxSetupInitializer,
  parseCrabboxSetupSecrets,
  type CrabboxSetupInitializer,
  type CrabboxSetupSecrets,
} from "./crabbox-worker-setup-profile.js";
import { CRABBOX_HEARTBEAT_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

const PROFILE_KEYS = new Set([
  "azureSandboxDiskId",
  "azureSandboxSnapshotId",
  "azureSandboxSnapshotReceipt",
  "azureSandboxSnapshotGeneration",
  "binary",
  "class",
  "configFile",
  "desktop",
  "idleTimeout",
  "provider",
  "sdkPython",
  "sdkIdentity",
  "snapshotVerifier",
  "setup",
  "setupEnv",
  "setupSecrets",
  "setupInitializer",
  "ttl",
  "target",
  "warmImage",
]);
const GO_DURATION_PATTERN = /^\+?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+$/u;
const GO_DURATION_TOKEN_PATTERN = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/gu;
const MAX_GO_DURATION_NANOSECONDS = 9_223_372_036_854_775_807n;
const CRABBOX_LEASE_ID_DOMAIN = "openclaw:crabbox-worker-lease-id:v1\0";
const LEGACY_PROVISION_OPERATION_ID_PATTERN = /^provision:[a-f0-9]{64}$/u;
const DURATION_UNIT_NANOSECONDS: Readonly<Record<string, bigint>> = {
  h: 3_600_000_000_000n,
  m: 60_000_000_000n,
  s: 1_000_000_000n,
  ms: 1_000_000n,
  us: 1_000n,
  µs: 1_000n,
  μs: 1_000n,
  ns: 1n,
};

type CrabboxProfile = {
  azureSandboxDiskId?: string;
  azureSandboxSnapshotId?: string;
  azureSandboxSnapshotReceipt?: string;
  azureSandboxSnapshotGeneration?: string;
  binary?: string;
  sdkPython?: string;
  configFile?: string;
  sdkIdentity?: { kind: "azure-cli" } | { kind: "managed-identity"; clientId: string };
  snapshotVerifier?: string[];
  /** Resolved by the provider config owner, never accepted from profile input. */
  azureSandboxScope?: string;
  class?: string;
  desktop?: boolean;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  idleTimeout: string;
  idleTimeoutMs: number;
  provider: string;
  ttl: string;
  target: CrabboxOperatingSystem;
  setup?: string;
  setupSecrets?: CrabboxSetupSecrets;
  setupInitializer?: CrabboxSetupInitializer;
  warmImage?: boolean;
};

const MAX_CRABBOX_MACHINE_CLASS_LENGTH = 128;
const MAX_CRABBOX_MACHINE_OPTIONS = 64;
export const CRABBOX_ENROLLABLE_TARGETS = [
  "linux",
  "windows/wsl2",
  "windows/normal",
  "macos",
] as const;
export type CrabboxOperatingSystem = (typeof CRABBOX_ENROLLABLE_TARGETS)[number];
export const CRABBOX_OS_LABELS: Record<CrabboxOperatingSystem, string> = {
  linux: "Linux",
  "windows/wsl2": "Windows (WSL2)",
  "windows/normal": "Windows",
  macos: "macOS",
};

function parseCrabboxOperatingSystem(value: unknown): CrabboxOperatingSystem {
  if (value === undefined) {
    return "linux";
  }
  const target = nonEmptyString(value);
  const supported = CRABBOX_ENROLLABLE_TARGETS.find((os) => os === target);
  if (supported) {
    return supported;
  }
  throw new WorkerProviderError(
    `Crabbox target must be ${CRABBOX_ENROLLABLE_TARGETS.join(" or ")}`,
  );
}
const CRABBOX_DESKTOP_PROVIDERS = new Set(["aws", "azure", "hetzner"]);

export type CrabboxMachineShape = Readonly<{
  class: string;
  os: CrabboxOperatingSystem;
  cpu?: number;
  memoryGb?: number;
}>;

export const CRABBOX_WORKER_PROVIDER_ID = "crabbox";

function requirePositiveDuration(
  value: unknown,
  key: string,
): { duration: string; milliseconds: number } {
  const duration = nonEmptyString(value);
  const nanoseconds = duration ? parsePositiveGoDurationNanoseconds(duration) : undefined;
  if (!duration || nanoseconds === undefined) {
    throw new WorkerProviderError(
      `Crabbox profile ${key} must be a positive Go duration such as 60m`,
    );
  }
  return { duration, milliseconds: Number(nanoseconds) / 1_000_000 };
}

export function parseCrabboxDurationMs(value: unknown): number | undefined {
  const text = nonEmptyString(value);
  const nanoseconds = text ? parsePositiveGoDurationNanoseconds(text) : undefined;
  return nanoseconds === undefined ? undefined : Number(nanoseconds) / 1_000_000;
}

function parsePositiveGoDurationNanoseconds(duration: string): bigint | undefined {
  if (!GO_DURATION_PATTERN.test(duration)) {
    return undefined;
  }
  let total = 0n;
  for (const match of duration.matchAll(GO_DURATION_TOKEN_PATTERN)) {
    const numberText = match[1];
    const unit = match[2] ? DURATION_UNIT_NANOSECONDS[match[2]] : undefined;
    if (!numberText || unit === undefined) {
      return undefined;
    }
    const [wholeText = "", fractionText = ""] = numberText.split(".", 2);
    const whole = wholeText.replace(/^0+/u, "") || "0";
    if (whole.length > 19) {
      return undefined;
    }
    total += BigInt(whole) * unit;
    const fraction = fractionText.slice(0, 18);
    if (fraction) {
      total += (BigInt(fraction) * unit) / 10n ** BigInt(fraction.length);
    }
    if (total > MAX_GO_DURATION_NANOSECONDS) {
      return undefined;
    }
  }
  return total > 0n ? total : undefined;
}

export function heartbeatIntervalMs(idleTimeoutMs: number): number {
  const referenceIntervalMs = Math.max(5_000, Math.min(60_000, idleTimeoutMs / 3));
  // Crabbox's floor can exceed short accepted timeouts. Keep renewal ahead of
  // coordinator idle expiry without changing the profile contract.
  return Math.min(referenceIntervalMs, Math.max(1, Math.floor(idleTimeoutMs / 2)));
}

export function parseCrabboxProfile(profile: Readonly<Record<string, unknown>>): CrabboxProfile {
  for (const key of Object.keys(profile)) {
    if (!PROFILE_KEYS.has(key)) {
      throw new WorkerProviderError(`unknown Crabbox profile setting: ${key}`);
    }
  }

  const provider = nonEmptyString(profile.provider)?.toLowerCase();
  const machineClass = nonEmptyString(profile.class);
  const target = parseCrabboxOperatingSystem(profile.target);
  if (!provider) {
    throw new WorkerProviderError("Crabbox profile provider must be a non-empty string");
  }
  if (profile.class !== undefined && !machineClass) {
    throw new WorkerProviderError("Crabbox profile class must be a non-empty string");
  }
  const { duration: ttl } = requirePositiveDuration(profile.ttl, "ttl");
  const { duration: idleTimeout, milliseconds: idleTimeoutMs } = requirePositiveDuration(
    profile.idleTimeout,
    "idleTimeout",
  );
  const binary = nonEmptyString(profile.binary);
  if (profile.binary !== undefined && !binary) {
    throw new WorkerProviderError("Crabbox profile binary must be a non-empty string");
  }
  if (binary && !path.isAbsolute(binary)) {
    throw new WorkerProviderError("Crabbox profile binary must be an absolute path");
  }
  const configFile = nonEmptyString(profile.configFile);
  if (profile.configFile !== undefined && (!configFile || !path.isAbsolute(configFile))) {
    throw new WorkerProviderError("Crabbox configFile must be an absolute path");
  }
  const sdkPython = nonEmptyString(profile.sdkPython);
  if (
    profile.sdkPython !== undefined &&
    (provider !== "azure-sandbox" || !sdkPython || !path.isAbsolute(sdkPython))
  ) {
    throw new WorkerProviderError(
      "Crabbox sdkPython requires an azure-sandbox profile and an absolute qualified interpreter path",
    );
  }
  const sdkIdentity = parseCrabboxSdkIdentity(profile.sdkIdentity, provider);
  const snapshotVerifier = parseCrabboxSnapshotVerifier(profile.snapshotVerifier, provider);
  if (sdkPython && (!configFile || !sdkIdentity)) {
    throw new WorkerProviderError(
      "Crabbox sdkPython requires a selected credential-free configFile and explicit sdkIdentity",
    );
  }
  if (sdkIdentity?.kind === "azure-cli" && !configFile) {
    throw new WorkerProviderError(
      "Crabbox Azure CLI SDK identity requires its selected configFile",
    );
  }
  const setup = nonEmptyString(profile.setup);
  if (profile.setup !== undefined && !setup) {
    throw new WorkerProviderError("Crabbox profile setup must be a non-empty command string");
  }
  if (profile.setupEnv !== undefined) {
    throw new WorkerProviderError(
      "Crabbox profile setupEnv is retired; run openclaw doctor --fix to migrate protected, destination-bound store entries to setupSecrets. Repair any reported entries before provisioning; plaintext forwarding is unavailable.",
    );
  }
  const setupSecrets = parseCrabboxSetupSecrets(profile.setupSecrets);
  const setupInitializer = parseCrabboxSetupInitializer(
    profile.setupInitializer,
    target,
    setupSecrets,
  );
  const azureSandboxDiskId = nonEmptyString(profile.azureSandboxDiskId);
  if (
    profile.azureSandboxDiskId !== undefined &&
    (provider !== "azure-sandbox" || !azureSandboxDiskId || azureSandboxDiskId.length > 256)
  ) {
    throw new WorkerProviderError(
      "Crabbox Azure Sandbox disk ID requires an azure-sandbox profile and a non-empty string of at most 256 characters",
    );
  }
  const snapshotId = nonEmptyString(profile.azureSandboxSnapshotId);
  const snapshotReceipt = nonEmptyString(profile.azureSandboxSnapshotReceipt);
  const snapshotGeneration = nonEmptyString(profile.azureSandboxSnapshotGeneration);
  const snapshotSelected = [
    profile.azureSandboxSnapshotId,
    profile.azureSandboxSnapshotReceipt,
    profile.azureSandboxSnapshotGeneration,
  ].some((value) => value !== undefined);
  if (
    snapshotSelected &&
    (provider !== "azure-sandbox" ||
      !azureSandboxDiskId ||
      !snapshotId ||
      !/^[A-Za-z0-9._()-]{1,256}$/u.test(snapshotId) ||
      !snapshotReceipt ||
      !path.isAbsolute(snapshotReceipt) ||
      !snapshotGeneration ||
      !/^[a-f0-9]{64}$/u.test(snapshotGeneration))
  ) {
    throw new WorkerProviderError(
      "Crabbox Sandbox snapshot selection requires its exact disk, snapshot ID, absolute receipt path and SHA256 generation",
    );
  }
  const desktop = profile.desktop;
  if (desktop !== undefined && typeof desktop !== "boolean") {
    throw new WorkerProviderError("Crabbox profile desktop must be a boolean");
  }
  if (desktop && !CRABBOX_DESKTOP_PROVIDERS.has(provider)) {
    throw new WorkerProviderError(
      "Crabbox desktop profiles support only AWS, Azure, and coordinator-backed Hetzner",
    );
  }
  const warmImage = profile.warmImage;
  if (warmImage !== undefined && typeof warmImage !== "boolean") {
    throw new WorkerProviderError("Crabbox profile warmImage must be a boolean");
  }
  return {
    ...(azureSandboxDiskId ? { azureSandboxDiskId } : {}),
    ...(snapshotSelected
      ? {
          azureSandboxSnapshotId: snapshotId,
          azureSandboxSnapshotReceipt: snapshotReceipt,
          azureSandboxSnapshotGeneration: snapshotGeneration,
        }
      : {}),
    binary,
    ...(sdkPython ? { sdkPython } : {}),
    ...(configFile ? { configFile } : {}),
    ...(sdkIdentity ? { sdkIdentity } : {}),
    ...(snapshotVerifier ? { snapshotVerifier } : {}),
    class: machineClass,
    desktop,
    heartbeatIntervalMs: heartbeatIntervalMs(idleTimeoutMs),
    heartbeatTimeoutMs: Math.min(
      CRABBOX_HEARTBEAT_TIMEOUT_MS,
      Math.max(1, Math.floor(idleTimeoutMs / 2)),
    ),
    idleTimeout,
    idleTimeoutMs,
    provider,
    setup,
    setupSecrets,
    ...(setupInitializer ? { setupInitializer } : {}),
    ttl,
    target,
    warmImage,
  };
}

function parseCrabboxSdkIdentity(value: unknown, provider: string): CrabboxProfile["sdkIdentity"] {
  if (value === undefined) {
    return undefined;
  }
  const identity = asOptionalRecord(value);
  if (provider === "azure-sandbox" && identity) {
    if (identity.kind === "azure-cli" && Object.keys(identity).length === 1) {
      return { kind: "azure-cli" };
    }
    if (
      identity.kind === "managed-identity" &&
      Object.keys(identity).length === 2 &&
      typeof identity.clientId === "string" &&
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(identity.clientId)
    ) {
      return { kind: "managed-identity", clientId: identity.clientId };
    }
  }
  throw new WorkerProviderError(
    "Crabbox sdkIdentity requires an explicit Azure CLI or managed identity client ID on azure-sandbox",
  );
}

function parseCrabboxSnapshotVerifier(value: unknown, provider: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    provider !== "azure-sandbox" ||
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 16 ||
    !value.every(
      (arg): arg is string =>
        typeof arg === "string" && arg.length > 0 && arg.length <= 2048 && !arg.includes("\0"),
    )
  ) {
    throw new WorkerProviderError("Crabbox snapshotVerifier must be bounded executable arguments");
  }
  return value;
}

/** The same selected route reaches every provider subprocess; never change host globals. */
export function resolveCrabboxProfileCommandEnv(
  profile: Pick<CrabboxProfile, "sdkIdentity"> & { configFile: string },
): CrabboxProviderEnvironment;
export function resolveCrabboxProfileCommandEnv(
  profile: Pick<CrabboxProfile, "configFile" | "sdkIdentity">,
): CrabboxProviderEnvironment | undefined;
export function resolveCrabboxProfileCommandEnv(
  profile: Pick<CrabboxProfile, "configFile" | "sdkIdentity">,
): CrabboxProviderEnvironment | undefined {
  if (!profile.configFile && !profile.sdkIdentity) {
    return undefined;
  }
  return {
    // Explicit Crabbox env inputs override config files. Snapshot SDK routing
    // consumes this same projection; it never parses the private config file.
    CRABBOX_AZURE_SANDBOX_REGION: process.env.CRABBOX_AZURE_SANDBOX_REGION,
    CRABBOX_AZURE_SANDBOX_SUBSCRIPTION_ID: process.env.CRABBOX_AZURE_SANDBOX_SUBSCRIPTION_ID,
    CRABBOX_AZURE_SANDBOX_RESOURCE_GROUP: process.env.CRABBOX_AZURE_SANDBOX_RESOURCE_GROUP,
    CRABBOX_AZURE_SANDBOX_GROUP: process.env.CRABBOX_AZURE_SANDBOX_GROUP,
    ...(profile.configFile ? { CRABBOX_CONFIG: profile.configFile } : {}),
    ...(profile.sdkIdentity
      ? {
          CRABBOX_AZURE_SANDBOX_CLIENT_ID:
            profile.sdkIdentity.kind === "managed-identity" ? profile.sdkIdentity.clientId : "",
        }
      : {}),
  };
}

/** Existing pre-egress leases retain inspection/release, never new setup or capture. */
export function parseCrabboxCleanupProfile(profile: WorkerProfile): CrabboxProfile {
  const { setupEnv: retiredSetupEnv, ...settings } = profile;
  const parsed = parseCrabboxProfile(settings);
  if (retiredSetupEnv !== undefined) {
    parsed.warmImage = false;
  }
  return parsed;
}

// Resolve defaults only after sizing is known: placement and enrolled lease classes
// must share the same policy during provisioning and teardown.
export function resolveCrabboxWarmImageProfile(
  profile: CrabboxProfile,
  machineClass = profile.class,
  target = profile.target,
) {
  if (target === "windows/wsl2" && profile.desktop) {
    throw new WorkerProviderError(
      "Crabbox WSL2 does not support desktops; select native Windows for a desktop viewer",
    );
  }
  return {
    ...profile,
    class: machineClass,
    target,
    warmImage: target === "linux" && (profile.warmImage ?? machineClass !== undefined),
  };
}

export function resolveCrabboxWarmImageProfileKey(
  profile: CrabboxProfile,
  projectKey?: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        backendProvider: profile.provider,
        ...(profile.azureSandboxDiskId ? { azureSandboxDiskId: profile.azureSandboxDiskId } : {}),
        ...(profile.azureSandboxScope ? { azureSandboxScope: profile.azureSandboxScope } : {}),
        ...(profile.azureSandboxSnapshotGeneration
          ? { azureSandboxSnapshotGeneration: profile.azureSandboxSnapshotGeneration }
          : {}),
        ...(profile.snapshotVerifier ? { snapshotVerifier: profile.snapshotVerifier } : {}),
        // Missing target in persisted Linux keys already means Linux.
        ...(profile.target !== "linux" ? { target: profile.target } : {}),
        setup: profile.setup ?? "",
        ...(profile.setupInitializer ? { setupInitializer: profile.setupInitializer } : {}),
        setupSecretMode: "protected-egress-v1",
        setupSecrets: Object.entries(profile.setupSecrets ?? {}).toSorted(([left], [right]) =>
          left.localeCompare(right),
        ),
        desktop: profile.desktop ?? false,
        // Exact class is intentionally conservative; cross-class reuse comes later.
        machineClass: profile.class,
        ...(projectKey ? { projectKey } : {}),
      }),
    )
    .digest("hex");
}

export function resolveCrabboxPreparationTarget(
  profile: WorkerProfile,
  machineClass?: string,
  os?: string,
) {
  const parsed = parseCrabboxProfile(profile);
  const effective = resolveCrabboxWarmImageProfile(
    parsed,
    machineClass ?? parsed.class,
    os === undefined ? parsed.target : parseCrabboxOperatingSystem(os),
  );
  return supportsResolvedCrabboxProjectPreparation(effective) &&
    effective.class &&
    effective.target === "linux"
    ? {
        machineClass: effective.class,
        platform: effective.target,
        profileKey: resolveCrabboxWarmImageProfileKey(effective),
      }
    : undefined;
}

export function supportsCrabboxProjectPreparation(
  profile: WorkerProfile,
  machineClass?: string,
  os?: string,
): boolean {
  const parsed = parseCrabboxProfile(profile);
  const resolved = resolveCrabboxWarmImageProfile(
    parsed,
    machineClass ?? parsed.class,
    os === undefined ? parsed.target : parseCrabboxOperatingSystem(os),
  );
  return supportsResolvedCrabboxProjectPreparation(resolved);
}

function supportsResolvedCrabboxProjectPreparation(resolved: CrabboxProfile): boolean {
  return (
    Boolean(resolved.warmImage) ||
    Object.keys(resolved.setupSecrets ?? {}).length > 0 ||
    Boolean(
      resolved.provider === "azure-sandbox" &&
      resolved.azureSandboxDiskId &&
      resolved.target === "linux" &&
      resolved.class,
    )
  );
}

export function resolveCrabboxPreparedIdleTimeoutMs(profile: WorkerProfile): number | undefined {
  const parsed = parseCrabboxProfile(profile);
  // The pool passes original settings; placement may supply the required machine class.
  return (parsed.warmImage === false && !parsed.azureSandboxDiskId) || parsed.target !== "linux"
    ? undefined
    : parsed.idleTimeoutMs;
}

// Setup belongs to the configured target's interpreter, not the requested OS.
// POSIX-to-POSIX portability remains the profile author's responsibility.
export function isCrabboxSetupTargetCompatible(
  profile: CrabboxProfile,
  target: CrabboxOperatingSystem,
): boolean {
  return !profile.setup || (profile.target === "windows/normal") === (target === "windows/normal");
}

type CrabboxProvisionProfile = CrabboxProfile &
  ({ warmImage: false } | { warmImage: true; class: string });

export function resolveCrabboxProvisionProfile(
  profile: WorkerProfile,
  requestedClassValue: unknown,
  requestedOsValue?: unknown,
): { profile: CrabboxProvisionProfile } {
  const configured = parseCrabboxProfile(profile);
  const requestedClass = nonEmptyString(requestedClassValue);
  if (
    requestedClassValue !== undefined &&
    (!requestedClass || requestedClass.length > MAX_CRABBOX_MACHINE_CLASS_LENGTH)
  ) {
    throw new WorkerProviderError(
      "Crabbox machine class must be a non-empty string of at most 128 characters",
    );
  }
  const resolved = resolveCrabboxWarmImageProfile(
    configured,
    requestedClass ?? configured.class,
    requestedOsValue === undefined
      ? configured.target
      : parseCrabboxOperatingSystem(requestedOsValue),
  );
  if (!isCrabboxSetupTargetCompatible(configured, resolved.target)) {
    const shell = resolved.target === "windows/normal" ? "PowerShell" : "POSIX";
    throw new WorkerProviderError(
      `Crabbox profile setup for ${configured.target} cannot run on ${resolved.target}; select a profile with settings.target=${resolved.target} and a compatible ${shell} setup command`,
    );
  }
  let provisionProfile: CrabboxProvisionProfile;
  if (!resolved.warmImage) {
    provisionProfile = { ...resolved, warmImage: false };
  } else {
    // Resolve immutable sizing before allocation and replay.
    if (!resolved.class) {
      throw new WorkerProviderError(
        "Crabbox warmImage requires a configured class or a placement machine class",
      );
    }
    provisionProfile = { ...resolved, class: resolved.class, warmImage: true };
  }
  return {
    profile: provisionProfile,
  };
}

export function listCrabboxMachineOptions(
  configuredClass: string | undefined,
  shapes: readonly CrabboxMachineShape[] = [],
): readonly WorkerMachineOption[] {
  const seen = new Set<string>();
  const options: WorkerMachineOption[] = [];
  for (const os of CRABBOX_ENROLLABLE_TARGETS) {
    const candidates = shapes.filter((shape) => {
      const key = `${shape.os}:${shape.class}`;
      if (
        shape.os !== os ||
        shape.class.length > MAX_CRABBOX_MACHINE_CLASS_LENGTH ||
        seen.has(key)
      ) {
        return false;
      }
      seen.add(key);
      return true;
    });
    if (candidates.length === 0) {
      continue;
    }
    const remaining = MAX_CRABBOX_MACHINE_OPTIONS - options.length;
    const reserveDefault =
      configuredClass !== undefined &&
      !candidates.slice(0, remaining).some((shape) => shape.class === configuredClass);
    for (const shape of candidates.slice(0, Math.max(0, remaining - Number(reserveDefault)))) {
      options.push({
        id: shape.class,
        os,
        label: shape.class.replace(/^./u, (initial) => initial.toUpperCase()),
        ...(shape.cpu !== undefined ? { cpu: shape.cpu } : {}),
        ...(shape.memoryGb !== undefined ? { memoryGb: shape.memoryGb } : {}),
        ...(shape.class === configuredClass ? { default: true } : {}),
      });
    }
    if (reserveDefault && remaining > 0 && configuredClass !== undefined) {
      options.push({ id: configuredClass, os, label: configuredClass, default: true });
    }
  }
  return options;
}

export function buildCrabboxAllocationArgs(
  profile: CrabboxProfile,
  leaseId: string,
  slug: string,
): string[] {
  const args = [
    "--provider",
    profile.provider,
    ...(profile.azureSandboxDiskId ? ["--azure-sandbox-disk-id", profile.azureSandboxDiskId] : []),
    ...(profile.azureSandboxSnapshotId
      ? ["--azure-sandbox-snapshot-id", profile.azureSandboxSnapshotId]
      : []),
    ...(profile.azureSandboxSnapshotReceipt
      ? ["--azure-sandbox-snapshot-receipt", profile.azureSandboxSnapshotReceipt]
      : []),
    ...(profile.azureSandboxSnapshotGeneration
      ? ["--azure-sandbox-snapshot-generation", profile.azureSandboxSnapshotGeneration]
      : []),
    "--network",
    "public",
    "--tailscale=false",
    ...(profile.class ? ["--class", profile.class] : []),
    ...(profile.target === "linux" ? ["--target", "linux"] : []),
    ...(profile.target === "windows/wsl2" ? ["--target", "windows", "--windows-mode", "wsl2"] : []),
    ...(profile.target === "windows/normal"
      ? ["--target", "windows", "--windows-mode", "normal"]
      : []),
    ...(profile.target === "macos" ? ["--target", "macos", "--market", "on-demand"] : []),
    "--ttl",
    profile.ttl,
    "--idle-timeout",
    profile.idleTimeout,
    "--lease-id",
    leaseId,
    "--slug",
    slug,
    "--keep=true",
  ];
  if (profile.desktop) {
    args.push("--desktop");
    if (profile.target === "linux") {
      args.push("--browser", "--desktop-env", "xfce");
    }
  }
  return args;
}

export function resolveOpenClawRoot(pluginRoot: string | undefined): string {
  if (!pluginRoot) {
    return process.cwd();
  }
  const extensionsDir = path.dirname(pluginRoot);
  if (path.basename(extensionsDir) !== "extensions") {
    return process.cwd();
  }
  const extensionParent = path.dirname(extensionsDir);
  return path.basename(extensionParent) === "dist" ||
    path.basename(extensionParent) === "dist-runtime"
    ? path.dirname(extensionParent)
    : extensionParent;
}

export function operationSlug(operationId: string): string {
  return `openclaw-${createHash("sha256").update(operationId).digest("hex").slice(0, 32)}`;
}

const LEASE_ID_PATTERN = /^(?:cbx_|tbx_)[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export function assertCrabboxLeaseId(leaseId: string): void {
  if (!LEASE_ID_PATTERN.test(leaseId)) {
    throw new Error("Crabbox lease id is invalid");
  }
}

export function operationLeaseId(operationId: string): string {
  if (!operationId.trim()) {
    throw new Error("Crabbox provision requires an operation id");
  }
  if (LEGACY_PROVISION_OPERATION_ID_PATTERN.test(operationId)) {
    // Historical random allocation can exist without a recorded handle; refusing replay
    // must not terminalize unresolved cleanup responsibility.
    throw new Error(
      "Legacy Crabbox provision state cannot be replayed safely; clean up any prior lease and dispatch again",
    );
  }
  return `cbx_${createHash("sha256")
    .update(CRABBOX_LEASE_ID_DOMAIN)
    .update(operationId)
    .digest("hex")
    .slice(0, 12)}`;
}
