import type { CrabboxOperatingSystem } from "./crabbox-worker-profile.js";

export const CRABBOX_RUNTIME_NODE_PATH = 'export PATH="$HOME/.openclaw-worker/runtime-node:$PATH"';

export const CLOUD_SETUP_CODE_ENV = "CRABBOX_WORKER_SETUP_CODE";
export const CLOUD_BOOTSTRAP_TOKEN_ENV = "CRABBOX_WORKER_BOOTSTRAP_TOKEN";
export const CLOUD_WORKER_CODEX_ENV = "CRABBOX_WORKER_CODEX_CONFIG";

// A snapshot fork skips profile setup, but its provider may inject fresh platform CAs.
// Refresh OS trust per idempotent Linux enrollment attempt, with no bootstrap credentials.
export const CRABBOX_LINUX_PLATFORM_TRUST_SETUP = `set -eu
if [ -x /usr/sbin/update-ca-certificates ]; then
  (
    unset ${CLOUD_SETUP_CODE_ENV} ${CLOUD_BOOTSTRAP_TOKEN_ENV} ${CLOUD_WORKER_CODEX_ENV}
    if [ "$(id -u)" = 0 ]; then
      /usr/sbin/update-ca-certificates
    else
      sudo -n -- /usr/sbin/update-ca-certificates
    fi
  ) || {
    echo 'Cloud worker platform trust registration failed; repair system certificate setup before enrollment' >&2
    exit 1
  }
fi
`;

/** Guest expression evaluated with fs, path, and the canonical home directory. */
export function createCrabboxWorkerStateDirScript(leaseId: string): string {
  return `(() => {
  const previous = path.join(home, ".openclaw", ${JSON.stringify(`cloud-workers/${leaseId}`)});
  // Retained leases keep their state, workspace identities, and process receipts.
  if (process.platform !== "win32" || fs.existsSync(previous)) return previous;
  const key = require("node:crypto").createHash("sha256").update(home).update("\\0").update(${JSON.stringify(leaseId)}).digest("hex").slice(0, 32);
  return path.join(path.parse(home).root, "ocw", key);
})()`;
}

const BIND_RUNTIME_NODE = `node <<'CRABBOX_BIND_RUNTIME_NODE'
const fs = require("node:fs");
const path = require("node:path");
try {
  const directory = path.join(require("node:os").homedir(), ".openclaw-worker", "runtime-node");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const link = path.join(directory, "node");
  let previous;
  try { previous = fs.readlinkSync(link); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous !== process.execPath) {
    if (previous !== undefined) fs.unlinkSync(link);
    fs.symlinkSync(process.execPath, link);
  }
} catch (error) {
  console.error("Cannot retain cloud runtime Node: " + error.message + "; repair ~/.openclaw-worker/runtime-node and reprovision the worker");
  process.exitCode = 1;
}
CRABBOX_BIND_RUNTIME_NODE`;

/** Crabbox executes script-stdin with the target's native shell. */
export function wrapCrabboxNodeScript(
  script: string,
  target: CrabboxOperatingSystem = "linux",
  delimiter = "CRABBOX_NODE_SCRIPT",
  purpose: "runtime" | "bootstrap" = "runtime",
): string {
  if (target !== "windows/normal") {
    // Bind the bootstrap-selected executable before an older snapshot's link can shadow it.
    const nodePath =
      target === "linux"
        ? `${purpose === "bootstrap" ? `${BIND_RUNTIME_NODE}\n` : ""}${CRABBOX_RUNTIME_NODE_PATH}\n`
        : "";
    return `set -eu\n${nodePath}node <<'${delimiter}'\n${script}\n${delimiter}`;
  }
  return `$ErrorActionPreference = 'Stop'
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if (-not $node) { throw 'Cloud worker requires Node.js on PATH; update the Crabbox Windows bootstrap image and reprovision the worker' }
$scriptPath = Join-Path $env:TEMP ('openclaw-' + [Guid]::NewGuid().ToString('N') + '.cjs')
try {
  $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString("base64")}'))
  [IO.File]::WriteAllText($scriptPath, $source, [Text.UTF8Encoding]::new($false))
  & $node.Source $scriptPath
  $code = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
}
exit $code`;
}
