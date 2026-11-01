import path from "node:path";
import vm from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { createCrabboxNodeProcessRuntime } from "./crabbox-worker-node-process.js";

afterEach(() => vi.useRealTimers());

it.each([
  "fresh",
  "resume",
  "foreign-runtime",
  "foreign-process",
  "non-exit",
  "preparation-failure",
] as const)(
  "keeps enrollment replacement bound to its owned Linux process group (%s)",
  async (scenario) => {
    vi.useFakeTimers();
    const home = "/owned";
    const root = path.join(home, ".openclaw-worker/node-runtimes");
    const runtimeDir = path.join(root, "b".repeat(64));
    const previous = scenario === "resume" ? runtimeDir : path.join(root, "a".repeat(64));
    const stateDir = path.join(home, ".openclaw/cloud-workers/lease");
    const runtimeLink = path.join(stateDir, "runtime");
    const pidFile = path.join(stateDir, "node.pid");
    const cli = path.join(runtimeDir, "node_modules/openclaw/openclaw.mjs");
    let signalled = false;
    const kill = vi.fn((_pid: number, signal: number | string) => {
      if (signal === "SIGTERM") {
        signalled = true;
      }
      if (signalled && signal === 0 && scenario !== "non-exit") {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
    });
    const unlink = vi.fn();
    const fs = {
      existsSync: (file: string) => file === pidFile,
      lstatSync: () => ({ isSymbolicLink: () => true }),
      statSync: () => ({ uid: 1000 }),
      realpathSync: (file: string) => {
        if (file === runtimeLink) {
          return scenario === "foreign-runtime" ? "/outside/runtime" : previous;
        }
        if (file === "/proc/123/cwd") {
          return scenario === "foreign-process" ? "/unrelated" : previous;
        }
        return file;
      },
      readFileSync: (file: string) => {
        if (file === pidFile) {
          return "123\n";
        }
        if (file === "/proc/123/stat") {
          return `123 (node) S 1 123 ${"0 ".repeat(16)}42`;
        }
        if (file === "/proc/123/cmdline") {
          return `node\0${path.join(previous, "node_modules/openclaw/openclaw.mjs")}\0`;
        }
        if (file === "/proc/123/environ") {
          return `OPENCLAW_STATE_DIR=${stateDir}\0`;
        }
        throw new Error(`Unexpected read: ${file}`);
      },
      unlinkSync: unlink,
    };
    const preparationError = new Error("runtime verification failed");
    const prepareLaunch = vi.fn(async () => {
      if (scenario === "preparation-failure") {
        throw preparationError;
      }
    });
    const reuse = vm.runInNewContext(
      `(() => { ${createCrabboxNodeProcessRuntime(undefined, "lease")} return reuseNodeProcess; })()`,
      {
        fs,
        path,
        home,
        runtimeDir,
        runtimeLink,
        stateDir,
        pidFile,
        cli,
        mode: scenario === "resume" ? "resume" : "connect",
        process: { execPath: "/node", platform: "linux", getuid: () => 1000, kill },
        Date,
        setTimeout,
      },
    ) as (prepare: () => Promise<void>) => Promise<boolean>;
    // Observe the callback rejection too: the old unawaited call must fail this
    // assertion without leaking an unrelated unhandled promise rejection.
    const prepare = () => {
      const result = prepareLaunch();
      void result.catch(() => {});
      return result;
    };
    const result = reuse(prepare);
    if (scenario === "preparation-failure") {
      await expect(result).rejects.toThrow(preparationError);
      expect(unlink).not.toHaveBeenCalled();
      prepareLaunch.mockResolvedValue(undefined);
      await expect(reuse(prepare)).resolves.toBe(false);
      expect(unlink).toHaveBeenCalledExactlyOnceWith(pidFile);
      expect(kill.mock.calls.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(1);
    } else if (scenario === "fresh") {
      await expect(result).resolves.toBe(false);
      expect(kill).toHaveBeenCalledWith(-123, "SIGTERM");
      expect(prepareLaunch).toHaveBeenCalledOnce();
      expect(unlink).toHaveBeenCalledExactlyOnceWith(pidFile);
    } else if (scenario === "resume") {
      await expect(result).resolves.toBe(true);
      expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
      expect(prepareLaunch).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
    } else {
      const rejected = expect(result).rejects.toThrow(
        scenario === "non-exit" ? "did not exit" : /runtime escapes|identity is unverified/,
      );
      if (scenario === "non-exit") {
        await vi.advanceTimersByTimeAsync(15000);
      }
      await rejected;
      expect(kill).not.toHaveBeenCalledWith(-123, "SIGKILL");
      if (scenario !== "non-exit") {
        expect(kill).not.toHaveBeenCalledWith(-123, "SIGTERM");
      }
      expect(prepareLaunch).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
    }
  },
);
