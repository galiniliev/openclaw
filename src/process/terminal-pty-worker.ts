import { createReadStream } from "node:fs";
import { mergeProcessEnv } from "../infra/process-env.js";
import { enterAgentExecCgroup } from "./linux-exec-cgroup.js";
import type { TerminalPtyControl, TerminalPtyEvent } from "./terminal-pty-protocol.js";
import { prepareTerminalPty, type TerminalPtyHandle } from "./terminal-pty.js";

// The descriptor is owned by the launching host, separate from the control IPC channel.
const privateInput = process.argv.includes("--private-env-fd=4")
  ? createReadStream("", { fd: 4, autoClose: true })
  : undefined;
const privateEnvironment = (async (): Promise<Record<string, string> | undefined> => {
  if (!privateInput) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of privateInput) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    try {
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid private environment");
      }
      const env: Record<string, string> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== "string") {
          throw new Error("Invalid private environment");
        }
        env[key] = entry;
      }
      return env;
    } finally {
      bytes.fill(0);
    }
  } catch {
    // Parsing and I/O diagnostics must never quote private input bytes.
    throw new Error("Terminal private environment is unavailable");
  } finally {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
  }
})();
void privateEnvironment.catch(() => {});

let pty: TerminalPtyHandle | undefined;
let starting = false;
let parentLost = false;
let finished = false;
let authorizeLaunch: (() => void) | undefined;

function report(message: TerminalPtyEvent, done?: () => void): void {
  if (!process.connected) {
    done?.();
    return;
  }
  process.send?.(message, () => done?.());
}

function finish(message: TerminalPtyEvent): void {
  if (finished) {
    return;
  }
  finished = true;
  pty?.kill();
  process.stdout.end(() => {
    report(message, () => {
      if (process.connected) {
        process.disconnect?.();
      }
    });
  });
}

function close(): void {
  parentLost = true;
  privateInput?.destroy();
  pty?.kill();
}

process.once("disconnect", close);
process.once("SIGTERM", close);
process.once("SIGINT", close);
process.stdout.on("error", close);
process.stdout.on("drain", () => pty?.resume());
// Only the spawning host writes this channel; launch authority is checked separately.
process.on("message", (message: TerminalPtyControl) => {
  if (message.type === "start" || message.type === "prepare") {
    if (starting || parentLost) {
      return;
    }
    starting = true;
    if (process.versions.bun) {
      finish({
        type: "error",
        message: "Terminal worker requires Node; PATH resolves node to Bun.",
      });
      return;
    }
    if (message.params.executionIntent === "agent-tool") {
      enterAgentExecCgroup();
    }
    const startup = privateEnvironment
      .then((env) => {
        if (parentLost || finished) {
          throw new Error("Terminal host retired before launch");
        }
        const params = env
          ? { ...message.params, env: mergeProcessEnv([message.params.env ?? process.env, env]) }
          : message.params;
        return prepareTerminalPty(params);
      })
      .then((launch) => {
        if (message.type === "start") {
          if (parentLost || finished) {
            throw new Error("Terminal host retired before launch");
          }
          return launch();
        }
        return new Promise<TerminalPtyHandle>((resolve, reject) => {
          authorizeLaunch = () => {
            try {
              if (parentLost || finished) {
                throw new Error("Terminal host retired before launch");
              }
              resolve(launch());
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          };
          report({ type: "prepared" });
        });
      });
    void startup.then(
      (handle) => {
        pty = handle;
        pty.onData((data) => {
          if (!process.stdout.write(data)) {
            handle.pause();
          }
        });
        pty.onExit((event) => finish({ type: "exit", ...event }));
        if (parentLost || finished) {
          pty.kill();
        } else {
          report({ type: "ready", pid: pty.pid });
        }
      },
      (error: unknown) =>
        finish({ type: "error", message: error instanceof Error ? error.message : String(error) }),
    );
  } else if (message.type === "launch") {
    const launch = authorizeLaunch;
    authorizeLaunch = undefined;
    launch?.();
  } else if (message.type === "input") {
    pty?.write("data" in message ? message.data : Buffer.from(message.dataBase64, "base64"));
  } else if (message.type === "resize") {
    pty?.resize(message.cols, message.rows);
  } else {
    pty?.kill(message.signal);
  }
});

// A source loader can yield before installing the IPC listener; admit starts only now.
report({ type: "boot" });
