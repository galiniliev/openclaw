import type { ChildProcessWithoutNullStreams } from "node:child_process";
/** One placement-bound Codex app-server process on a managed cloud node. */
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import {
  managedGitHubIdentityEnvironment,
  writeManagedGitHubProfileFiles,
  type WorkerGitHubLaunchBinding,
} from "openclaw/plugin-sdk/github-worker-runtime";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import { sanitizeEnvVars } from "openclaw/plugin-sdk/sandbox";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parse as parseToml, type TomlTable } from "smol-toml";
import {
  isManagedCodexDesktopCommand,
  resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand,
} from "./app-server/managed-binary.js";
import { createStdioTransport } from "./app-server/transport-stdio.js";
import { createCodexNodeAppServerProcessOwner } from "./node-app-server-process-owner.js";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const PLATFORM_ENV = /^(?:SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR)$/iu;

async function readPrivateFile(file: string): Promise<string> {
  const stat = await fs.lstat(file);
  if (
    !stat.isFile() ||
    stat.size > 16 * 1024 ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error("Cloud worker Codex private configuration is unsafe");
  }
  return await fs.readFile(file, "utf8");
}

/** Only the worker process reads these lease-private settings. */
export async function readWorkerCodexRuntime() {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("Cloud worker Codex lease state is unavailable");
  }
  const directory = path.join(stateDir, "codex-runtime");
  const directoryStat = await fs.lstat(directory);
  if (
    !directoryStat.isDirectory() ||
    (await fs.realpath(directory)) !== directory ||
    (process.platform !== "win32" && (directoryStat.mode & 0o077) !== 0)
  ) {
    throw new Error("Cloud worker Codex settings directory is unsafe");
  }
  const [version, config] = await Promise.all([
    readPrivateFile(path.join(directory, "version")),
    readPrivateFile(path.join(directory, "config.toml")),
  ]);
  await readPrivateFile(path.join(directory, "autodev-token.mjs"));
  if (!/^[a-f0-9]{64}$/.test(version)) {
    throw new Error("Cloud worker Codex configuration version is invalid");
  }
  let native: TomlTable;
  try {
    native = parseToml(config);
  } catch {
    throw new Error("Cloud worker Codex configuration is invalid");
  }
  const providerId = native.model_provider;
  const providers = native.model_providers;
  const provider =
    typeof providerId === "string" && isRecord(providers) ? providers[providerId] : undefined;
  const selected = isRecord(provider) ? provider : undefined;
  const auth = isRecord(selected?.auth) ? selected.auth : undefined;
  const helper = path.join(directory, "autodev-token.mjs");
  if (
    selected?.wire_api !== "responses" ||
    auth?.command !== "node" ||
    !Array.isArray(auth.args) ||
    auth.args.length !== 1 ||
    auth.args[0] !== helper ||
    ["env_key", "experimental_bearer_token", "requires_openai_auth"].some((key) =>
      Object.hasOwn(selected, key),
    )
  ) {
    throw new Error("Cloud worker Codex command-auth provider is incomplete");
  }
  return { directory, config };
}

function nodeAppServerMessage(frame: Uint8Array): Buffer {
  if (frame.byteLength < 1 || frame.byteLength > MAX_FRAME_BYTES) {
    throw new Error("Codex node app-server frame is invalid");
  }
  const bytes = Buffer.from(frame);
  if (bytes.includes(0x0a) || bytes.includes(0x0d)) {
    throw new Error("Codex node app-server frame must be one JSON line");
  }
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Codex node app-server frame is not JSON");
  }
  return bytes;
}

export async function runCodexNodeAppServer(params: {
  workspace: { workspaceDir: string; homeDir?: string; release: () => void };
  io: OpenClawPluginNodeHostCommandIo;
  activeProcesses: Set<() => Promise<void>>;
  assertExecAuthorized: () => void;
  github?: WorkerGitHubLaunchBinding;
  sessionId: string;
}): Promise<string> {
  const { io, workspace } = params;
  const frames = io.frames;
  if (!frames) {
    workspace.release();
    throw new Error("Codex node app-server requires duplex frames");
  }
  let child: ChildProcessWithoutNullStreams | undefined;
  let unsubscribe: (() => void) | undefined;
  let tempGitHub: string | undefined;
  let executionFailed = false;
  let failure: unknown;
  const owner = createCodexNodeAppServerProcessOwner({
    child: () => child,
    unsubscribe: () => unsubscribe?.(),
    release: async () => {
      if (tempGitHub) {
        await fs.rm(tempGitHub, { recursive: true, force: true });
      }
      workspace.release();
    },
    activeProcesses: params.activeProcesses,
  });
  try {
    io.signal.throwIfAborted();
    const runtime = await readWorkerCodexRuntime();
    const sessionHome = path.join(
      runtime.directory,
      "sessions",
      createHash("sha256").update(params.sessionId).digest("hex"),
    );
    await fs.mkdir(sessionHome, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(sessionHome, "config.toml"), runtime.config, { mode: 0o600 });
    let githubEnv: Record<string, string> = {};
    if (params.github) {
      tempGitHub = await fs.mkdtemp(path.join(runtime.directory, "github-"));
      await fs.chmod(tempGitHub, 0o700);
      await writeManagedGitHubProfileFiles(tempGitHub, params.github);
      const host = params.github.host ?? "github.com";
      githubEnv = {
        ...managedGitHubIdentityEnvironment({
          profileDir: tempGitHub,
          gitAuthor: params.github.gitAuthor,
          gitConfig: [
            ["credential.helper", ""],
            ["credential.helper", "!gh auth git-credential"],
          ],
        }),
        GH_HOST: host,
        ...(host === "github.com"
          ? { GH_TOKEN: params.github.token, GH_ENTERPRISE_TOKEN: "" }
          : { GH_TOKEN: "", GH_ENTERPRISE_TOKEN: params.github.token }),
        GITHUB_TOKEN: "",
        GITHUB_ENTERPRISE_TOKEN: "",
      };
    }
    const resolved = await resolveManagedCodexAppServerStartOptions({
      transport: "stdio",
      command: "codex",
      commandSource: "managed",
      managedCommandOrder: "package-first",
      args: ["app-server", "--listen", "stdio://"],
      headers: {},
    });
    const native = resolveManagedCodexNativeCommand(resolved.command);
    if (!native || isManagedCodexDesktopCommand(resolved.command)) {
      throw new Error("Cloud worker requires its pinned Codex binary");
    }
    const baseEnv = sanitizeEnvVars(process.env, {
      strictMode: true,
      customAllowedPatterns: [PLATFORM_ENV],
    }).allowed;
    params.assertExecAuthorized();
    child = await createStdioTransport(
      {
        transport: "stdio",
        command: native,
        commandSource: "resolved-managed",
        args: resolved.args,
        headers: {},
        cwd: workspace.workspaceDir,
        env: {
          HOME: workspace.homeDir ?? sessionHome,
          CODEX_HOME: sessionHome,
          PATH: process.env.PATH ?? "",
          ...githubEnv,
          ...(process.platform === "win32"
            ? { USERPROFILE: workspace.homeDir ?? sessionHome }
            : {}),
        },
        clearEnv: ["NODE_OPTIONS", "OPENAI_API_KEY", "OPENAI_API_PROXY_KEY", "CODEX_API_KEY"],
      },
      baseEnv,
      params.assertExecAuthorized,
    );
    const activeChild = child;
    owner.observe(activeChild);
    const outgoing = (async () => {
      let pending = Buffer.alloc(0);
      for await (const chunk of activeChild.stdout) {
        pending = Buffer.concat([pending, Buffer.from(chunk)]);
        if (pending.length > MAX_FRAME_BYTES + 1) {
          throw new Error("Codex node app-server response exceeded 64 MiB");
        }
        let newline: number;
        while ((newline = pending.indexOf(0x0a)) !== -1) {
          const frame = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          await frames.send(nodeAppServerMessage(frame));
        }
      }
      if (pending.length) {
        throw new Error("Codex node app-server ended with an incomplete frame");
      }
    })();
    const stderr = (async () => {
      // Native tracing is private diagnostic output, not a process failure.
      // Drain it without retaining content or imposing a lifetime byte budget.
      for await (const chunk of activeChild.stderr) {
        void chunk;
        // Keep the pipe flowing while the app-server remains connected.
      }
    })();
    let writes = Promise.resolve();
    unsubscribe = frames.onMessage((frame) => {
      const message = nodeAppServerMessage(frame);
      writes = writes.then(async () => {
        if (!activeChild.stdin.write(Buffer.concat([message, Buffer.from("\n")]))) {
          await once(activeChild.stdin, "drain", { signal: io.signal });
        }
      });
      return writes;
    });
    const exit = once(activeChild, "exit", { signal: io.signal });
    await Promise.race([
      Promise.all([outgoing, stderr, exit]),
      new Promise<never>((_resolve, reject) => {
        io.signal.addEventListener(
          "abort",
          () => {
            const reason: unknown = io.signal.reason;
            let error: Error;
            try {
              error =
                reason instanceof Error
                  ? reason
                  : new Error("Codex worker aborted", { cause: reason });
            } catch {
              error = new Error("Codex worker aborted", { cause: reason });
            }
            reject(error);
          },
          { once: true },
        );
      }),
    ]);
  } catch (error) {
    executionFailed = true;
    failure = error;
  }
  try {
    await owner.stop();
  } catch (error) {
    if (executionFailed) {
      throw new AggregateError([failure, error], "Codex worker execution and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
  if (executionFailed) {
    throw failure instanceof Error
      ? failure
      : new Error("Codex worker execution failed", { cause: failure });
  }
  return "Codex node app-server exited";
}
