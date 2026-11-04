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
const credentialDetails = ${JSON.stringify(CREDENTIAL_DETAILS)};
let diagnostic;
const stderr = child.stderr?.toString("utf8").trim() ?? "";
if (Buffer.byteLength(stderr) <= 512) {
  try {
    const value = JSON.parse(stderr);
    if (value?.schema === "teamclaw.snapshot-verifier-diagnostic.v1" && stages.includes(value.stage) && predicates.includes(value.predicate)) {
      diagnostic = { stage: value.stage, predicate: value.predicate };
      if (value.stage === "clean_state" && value.predicate === "credential_paths") {
        for (const [key, allowed] of Object.entries(credentialDetails)) {
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
  const credentialDetails: {
    credentialRoot?: string;
    credentialPath?: string;
    cleanCheck?: string;
  } = {};
  if (
    diagnostic?.stage === "clean_state" &&
    diagnostic.predicate === "credential_paths" &&
    isRecord(child.diagnostic)
  ) {
    for (const key of ["credentialRoot", "credentialPath", "cleanCheck"] as const) {
      const detail = child.diagnostic[key];
      if (typeof detail === "string" && CREDENTIAL_DETAILS[key].includes(detail)) {
        credentialDetails[key] = detail;
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
      ...(diagnostic ? { diagnostic: { ...diagnostic, ...credentialDetails } } : {}),
    },
    receipt: typeof value.receipt === "string" ? value.receipt : undefined,
  };
}
