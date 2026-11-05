import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CrabboxRuntimeInstallation } from "./crabbox-worker-runtime-verification.js";

type Project = NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["project"]>;
export type CrabboxSnapshotProject = Exclude<
  Awaited<ReturnType<NonNullable<Project["inspectPreparedWorkspace"]>>>,
  void
>;

/** Owner-derived facts for the image verifier's private stdin, never a persisted grant. */
export type CrabboxSnapshotVerifierInput = {
  schema: "openclaw.snapshot-verifier-input.v1";
  preparedProject: CrabboxSnapshotProject;
  currentRuntime: {
    installationVerification?: CrabboxRuntimeInstallation;
    nodeBootstrap: {
      sha256: string;
      bytes: number;
      openclawVersion: string;
      buildId: string;
      manifestSha256: string;
      enabledPluginIds: readonly string[];
    };
    workerBundle: {
      sha256: string;
      bytes: number;
      packageRelativePath: string;
      bundleHash: string;
      protocolFeatures?: readonly string[];
    };
  };
};

const STAGES = [
  "input",
  "repository_inventory",
  "clean_state",
  "transient_state",
  "azure_state",
  "tooling",
  "base_runtime",
  "current_runtime",
  "projection",
];
const PREDICATES = [
  "input_invalid",
  "seed_inventory",
  "credential_environment",
  "credential_paths",
  "worker_cache",
  "runtime_node",
  "workspace",
  "transient_files",
  "azure_state",
  "tool_pins",
  "runtime_identity",
  "runtime_cache",
  "receipt_invalid",
  "check_failed",
];

// Diagnostic classes only: never accept an absolute path, listing, or file content.
const CREDENTIAL_DETAILS = {
  credentialRoot: ["machine-home", "project-home", "project-workspace"],
  credentialPath: [
    ".azure",
    ".npm",
    ".npmrc",
    ".env.cargo-auth",
    ".git-credentials",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".openclaw",
    ".codex",
    ".config/gh",
    ".ssh",
    ".openclaw-worker/leases",
    ".scratch/npmrc",
  ],
  cleanCheck: ["before-probes", "after-probes"],
};

const WORKER_CACHE_DETAILS = {
  cacheCheck: ["cache-root", "cache-inventory", "cache-path", "unapproved-entry"],
  cacheKind: [
    "machine",
    "git-seeds",
    "prepared",
    "manifests",
    "toolchains",
    "worker-bundle",
    "node-runtimes",
    "prepared-git-seeds",
    "runtime-node",
    "other",
  ],
  cleanCheck: CREDENTIAL_DETAILS.cleanCheck,
};

/** Keep verifier buffers inside the worker; only its closed result crosses the transport. */
export function createCrabboxSnapshotVerifierScript(
  verifier: readonly string[],
  input: CrabboxSnapshotVerifierInput,
): string {
  const stdin = JSON.stringify(input);
  if (Buffer.byteLength(stdin) > 32768) {
    throw new Error("Snapshot verifier input exceeds its bound");
  }
  return `const { spawnSync } = require("node:child_process");
const child = spawnSync(${JSON.stringify(verifier[0])}, ${JSON.stringify(verifier.slice(1))}, {
  input: ${JSON.stringify(stdin)}, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1024 * 1024,
});
const stages = ${JSON.stringify(STAGES)};
const predicates = ${JSON.stringify(PREDICATES)};
const cleanStateDetails = ${JSON.stringify({ credential_paths: CREDENTIAL_DETAILS, worker_cache: WORKER_CACHE_DETAILS })};
let diagnostic;
const stderr = child.stderr?.toString("utf8").trim() ?? "";
if (Buffer.byteLength(stderr) <= 512) {
  try {
    const value = JSON.parse(stderr);
    if (value?.schema === "teamclaw.snapshot-verifier-diagnostic.v1" && stages.includes(value.stage) && predicates.includes(value.predicate)) {
      diagnostic = { stage: value.stage, predicate: value.predicate };
      if (value.stage === "clean_state") {
        for (const [key, allowed] of Object.entries(cleanStateDetails[value.predicate] ?? {})) {
          if (allowed.includes(value[key])) diagnostic[key] = value[key];
        }
      }
    }
  } catch {}
}
const codes = ["ENOENT", "EACCES", "ENOBUFS", "ETIMEDOUT"];
const signals = ["SIGABRT", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGTERM", "SIGTRAP", "SIGUSR1", "SIGUSR2"];
process.stdout.write(JSON.stringify({
  schema: "openclaw.snapshot-verifier-result.v1",
  child: {
    status: Number.isInteger(child.status) ? child.status : null,
    signal: child.signal ? (signals.includes(child.signal) ? child.signal : "other") : null,
    errorCode: child.error ? (codes.includes(child.error.code) ? child.error.code : "other") : null,
    stdoutBytes: child.stdout?.length ?? 0, stderrBytes: child.stderr?.length ?? 0,
    ...(diagnostic ? { diagnostic } : {}),
  },
  ...(!child.error && !child.signal && child.status === 0 ? { receipt: child.stdout.toString("utf8") } : {}),
}));`;
}

/** Validate and project at the remote-process boundary; unknown fields never reach logs/errors. */
export function readCrabboxSnapshotVerifierResult(output: string) {
  const value: unknown = JSON.parse(output);
  if (
    !isRecord(value) ||
    value.schema !== "openclaw.snapshot-verifier-result.v1" ||
    !isRecord(value.child)
  ) {
    throw new Error("Clean snapshot verification returned an invalid result envelope");
  }
  const child = value.child;
  const signals = [
    "SIGABRT",
    "SIGBUS",
    "SIGFPE",
    "SIGHUP",
    "SIGILL",
    "SIGINT",
    "SIGKILL",
    "SIGPIPE",
    "SIGQUIT",
    "SIGSEGV",
    "SIGTERM",
    "SIGTRAP",
    "SIGUSR1",
    "SIGUSR2",
    "other",
  ];
  const codes = ["ENOENT", "EACCES", "ENOBUFS", "ETIMEDOUT", "other"];
  if (
    (child.status !== null &&
      (typeof child.status !== "number" || !Number.isSafeInteger(child.status))) ||
    (child.signal !== null &&
      (typeof child.signal !== "string" || !signals.includes(child.signal))) ||
    (child.errorCode !== null &&
      (typeof child.errorCode !== "string" || !codes.includes(child.errorCode))) ||
    typeof child.stdoutBytes !== "number" ||
    !Number.isSafeInteger(child.stdoutBytes) ||
    child.stdoutBytes < 0 ||
    typeof child.stderrBytes !== "number" ||
    !Number.isSafeInteger(child.stderrBytes) ||
    child.stderrBytes < 0
  ) {
    throw new Error("Clean snapshot verification returned invalid child metadata");
  }
  const diagnostic =
    isRecord(child.diagnostic) &&
    typeof child.diagnostic.stage === "string" &&
    STAGES.includes(child.diagnostic.stage) &&
    typeof child.diagnostic.predicate === "string" &&
    PREDICATES.includes(child.diagnostic.predicate)
      ? { stage: child.diagnostic.stage, predicate: child.diagnostic.predicate }
      : undefined;
  const details: {
    credentialRoot?: string;
    credentialPath?: string;
    cacheCheck?: string;
    cacheKind?: string;
    cleanCheck?: string;
  } = {};
  const allowedDetails: Partial<Record<keyof typeof details, readonly string[]>> | undefined =
    diagnostic?.stage !== "clean_state"
      ? undefined
      : diagnostic.predicate === "credential_paths"
        ? CREDENTIAL_DETAILS
        : diagnostic.predicate === "worker_cache"
          ? WORKER_CACHE_DETAILS
          : undefined;
  if (allowedDetails && isRecord(child.diagnostic)) {
    for (const key of [
      "credentialRoot",
      "credentialPath",
      "cleanCheck",
      "cacheCheck",
      "cacheKind",
    ] as const) {
      const detail = child.diagnostic[key];
      if (typeof detail === "string" && allowedDetails[key]?.includes(detail)) {
        details[key] = detail;
      }
    }
  }
  return {
    child: {
      status: child.status,
      signal: child.signal,
      errorCode: child.errorCode,
      stdoutBytes: child.stdoutBytes,
      stderrBytes: child.stderrBytes,
      ...(diagnostic ? { diagnostic: { ...diagnostic, ...details } } : {}),
    },
    receipt: typeof value.receipt === "string" ? value.receipt : undefined,
  };
}
