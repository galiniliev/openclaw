import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { crabboxCommandError, leaseRunArgs, runCrabboxCommand } from "./crabbox-worker-command.js";
import { createCrabboxNodeProcessRuntime } from "./crabbox-worker-node-process.js";
import {
  assertCrabboxLeaseId,
  parseCrabboxProfile,
  resolveCrabboxProfileCommandEnv,
} from "./crabbox-worker-profile.js";
import { wrapCrabboxNodeScript } from "./crabbox-worker-script.js";
import {
  CRABBOX_LIFECYCLE_TIMEOUT_MS,
  CRABBOX_SETUP_TIMEOUT_MS,
} from "./crabbox-worker-timeouts.js";

/** Resume the enrolled runtime without reinstalling OpenClaw, pairing, or touching the repository. */
export function createCrabboxNodeResumeScript(request: {
  leaseId: string;
  deviceId: string;
  nodeBootstrapSha256: string;
  openclawVersion: string;
  linuxToolchainSetup?: string;
}): string {
  const nodeSetup =
    request.linuxToolchainSetup &&
    request.linuxToolchainSetup +
      "\n" +
      wrapCrabboxNodeScript(
        "process.stdout.write(process.execPath);",
        "linux",
        "CRABBOX_RESUME_NODE_PATH",
        "bootstrap",
      );
  const script = `const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
(async () => {
  process.umask(0o077);
  const leaseId = ${JSON.stringify(request.leaseId)};
  const mode = "resume";
  const displayName = "Cloud worker";
  const setPhase = () => {};
  const home = fs.realpathSync(os.homedir());
  const stateDir = path.join(home, ".openclaw", "cloud-workers", leaseId);
  const runtimeDir = path.join(home, ".openclaw-worker", "node-runtimes", ${JSON.stringify(request.nodeBootstrapSha256)});
  const runtimeLink = path.join(stateDir, "runtime");
  const cli = path.join(runtimeDir, "node_modules", "openclaw", "openclaw.mjs");
  const pidFile = path.join(stateDir, "node.pid");
  const launchFile = path.join(stateDir, "node-launch.json");
  const setupFile = path.join(stateDir, "setup-code");
  if (!fs.lstatSync(stateDir).isDirectory() || fs.realpathSync(stateDir) !== stateDir || !fs.lstatSync(runtimeDir).isDirectory() || fs.realpathSync(runtimeDir) !== runtimeDir || !fs.lstatSync(runtimeLink).isSymbolicLink() || fs.realpathSync(runtimeLink) !== runtimeDir) throw new Error("Cloud worker retained node runtime is unavailable or mismatched");
  const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, "node_modules", "openclaw", "package.json"), "utf8"));
  if (manifest.name !== "openclaw" || manifest.version !== ${JSON.stringify(request.openclawVersion)}) throw new Error("Cloud worker retained node package identity changed");
  const nodeEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  nodeEnv.PATH = path.dirname(process.execPath) + path.delimiter + path.join(runtimeDir, "node_modules", "openclaw", "dist", "worker-tools", "bin") + path.delimiter + (nodeEnv.PATH || "");
  // This supported read-only command never creates a missing identity.
  const identity = spawnSync(process.execPath, [cli, "node", "identity", "--json"], { cwd: runtimeDir, env: nodeEnv, encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
  if (identity.status !== 0 || JSON.parse(identity.stdout).deviceId !== ${JSON.stringify(request.deviceId)}) throw new Error("Cloud worker retained node identity is missing or changed; resume refused");
  ${createCrabboxNodeProcessRuntime(undefined, request.leaseId)}
  // A live process owns reconnect; never kill or duplicate it to repair transport.
  if (!await reuseNodeProcess(() => {
    const setup = ${JSON.stringify(nodeSetup)};
    if (!setup) return;
    const selected = spawnSync("sh", ["-s"], { input: setup, env: nodeEnv, encoding: "utf8", timeout: ${CRABBOX_SETUP_TIMEOUT_MS}, maxBuffer: 65536 });
    if (selected.status !== 0 || selected.error) throw new Error("Cloud worker Node prerequisite preparation failed; fix Linux prerequisites and retry retained node recovery");
    nodeExecutable = fs.realpathSync(selected.stdout.trim());
    nodeEnv.PATH = path.dirname(nodeExecutable) + path.delimiter + nodeEnv.PATH;
  })) await launchNodeProcess();
})().catch((error) => { console.error(error.message); process.exitCode = 1; });`;
  return wrapCrabboxNodeScript(script, "linux", "CRABBOX_NODE_RESUME_SCRIPT", "runtime");
}

export function createCrabboxNodeResumer(options: {
  resolveBinary: (binary?: string, signal?: AbortSignal) => Promise<{ binary: string }>;
}): NonNullable<WorkerProvider["resumeNode"]> {
  return async (request) => {
    request.assertCurrent();
    const profile = parseCrabboxProfile(request.profile);
    if (profile.target !== "linux") {
      return;
    }
    assertCrabboxLeaseId(request.leaseId);
    const { binary } = await options.resolveBinary(profile.binary, request.signal);
    request.assertCurrent();
    const result = await runCrabboxCommand({
      action: "node resume",
      binary,
      providerEnv: resolveCrabboxProfileCommandEnv(profile),
      args: leaseRunArgs({ binary, provider: profile.provider, id: request.leaseId }),
      input: createCrabboxNodeResumeScript(request),
      signal: request.signal,
      timeoutMs: request.linuxToolchainSetup
        ? CRABBOX_SETUP_TIMEOUT_MS + CRABBOX_LIFECYCLE_TIMEOUT_MS
        : 60_000,
    });
    request.assertCurrent();
    if (result.termination !== "exit" || result.code !== 0) {
      // A failed/unknown launch retains the lease and all workspace custody.
      throw crabboxCommandError("node resume", result);
    }
  };
}
