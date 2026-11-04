import { EventEmitter } from "node:events";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { WorkerProvider } from "../../plugins/capability-provider.types.js";
import type { SpawnResult } from "../../process/exec.js";
import { result as spawnResult } from "./bootstrap.test-support.js";
import type { EnvironmentRecipe } from "./environment-recipe.js";
import { runWorkerProjectLifecycle } from "./project-setup-script.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";

function lifecycleTransport(
  failExecutable?: string,
  initializer?: { output: string; cancel?: boolean },
  fault?: { mode?: "spawn" | "signal" | "timeout"; chunks?: string[] },
) {
  const events: string[] = [];
  const killedGroups: number[] = [];
  const initializerInputs: unknown[] = [];
  const invocations: {
    executable: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  }[] = [];
  const tunnel: Pick<WorkerTunnelHandle, "runWorkspaceCommand"> = {
    runWorkspaceCommand: vi.fn(async (command): Promise<SpawnResult> => {
      command.assertCurrent?.();
      const process = Object.assign(new EventEmitter(), {
        env: {
          PATH: "/worker/bin",
          HOME: "/worker/home",
          PRIVATE_FIXTURE: "not inherited",
          IDENTITY_HEADER: "synthetic-platform-header",
        },
        cwd: () => "/worker/project",
        kill: vi.fn((pid: number) => killedGroups.push(pid)),
        exitCode: 0,
      });
      let stderr = "";
      const spawn = (
        executable: string,
        args: string[],
        options: { cwd: string; env: Record<string, string> },
      ) => {
        if (fault?.mode === "spawn") {
          throw new Error("private executable detail");
        }
        invocations.push({ executable, args, cwd: options.cwd, env: options.env });
        events.push(`spawn:${executable}`);
        const child = Object.assign(new EventEmitter(), {
          pid: 123,
          stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
          stdout: new EventEmitter(),
          stdin: Object.assign(new EventEmitter(), {
            end: (input: string) => initializerInputs.push(JSON.parse(input)),
          }),
        });
        queueMicrotask(() => {
          if (executable === "/trusted/initializer" && initializer) {
            if (initializer.cancel) {
              process.emit("SIGTERM");
            }
            child.stdout.emit("data", Buffer.from(initializer.output));
          }
          for (const chunk of fault?.chunks ?? []) {
            child.stderr.emit("data", Buffer.from(chunk));
          }
          const code = fault?.mode === "signal" ? null : executable === failExecutable ? 1 : 0;
          if (code) {
            child.stderr.emit("data", Buffer.from("declared lifecycle failure"));
          }
          events.push(`close:${executable}`);
          child.emit("exit", code);
          child.emit("close", code, fault?.mode === "signal" ? "SIGTERM" : null);
        });
        return child;
      };
      await vm.runInNewContext(command.argv[2]!, {
        Buffer,
        process,
        require: (name: string) =>
          name === "node:os" ? { homedir: () => "/worker/home" } : { spawn },
        performance: { now: () => 0 },
        setTimeout: vi.fn((callback: () => void) => {
          if (fault?.mode === "timeout") {
            callback();
          }
        }),
        clearTimeout: vi.fn(),
        console: {
          error: (message: string) => {
            stderr = message;
          },
        },
      });
      return spawnResult({ stderr, code: process.exitCode });
    }),
  };
  return { tunnel, events, invocations, killedGroups, initializerInputs };
}

const recipe: EnvironmentRecipe = {
  source: "devcontainer",
  identity: "a".repeat(40),
  inputs: { ".devcontainer/devcontainer.json": "a".repeat(40) },
  env: { LANG: null, MODE: "development", LITERAL: "${localEnv:EXAMPLE}" },
  postCreate: {
    lint: ["lint", "argument;with spaces"],
    build: "compile && generate",
  },
  postStart: ["serve", "--foreground"],
};

function runLifecycle(
  tunnel: Pick<WorkerTunnelHandle, "runWorkspaceCommand">,
  overrides: Partial<Parameters<typeof runWorkerProjectLifecycle>[0]> = {},
) {
  return runWorkerProjectLifecycle({
    recipe,
    tunnel,
    postCreate: true,
    assertCurrent: () => {},
    ...overrides,
  });
}

const boundWorkspace = { workspaceDir: "/worker/project", homeDir: "/worker/home" };

describe("cloud project lifecycle command transport", () => {
  it("runs parallel creation commands with spec command forms before start at the bound workspace", async () => {
    const { tunnel, events, invocations, killedGroups } = lifecycleTransport();

    await runLifecycle(tunnel);

    expect(killedGroups).toEqual([]);
    expect(events).toEqual([
      "spawn:lint",
      "spawn:/bin/sh",
      "close:lint",
      "close:/bin/sh",
      "spawn:serve",
      "close:serve",
    ]);
    expect(invocations.map(({ executable, args }) => ({ executable, args }))).toEqual([
      { executable: "lint", args: ["argument;with spaces"] },
      { executable: "/bin/sh", args: ["-c", "compile && generate"] },
      { executable: "serve", args: ["--foreground"] },
    ]);
    for (const { cwd, env } of invocations) {
      expect(cwd).toBe("/worker/project");
      expect(env).toEqual({
        PATH: "/worker/bin",
        HOME: "/worker/home",
        MODE: "development",
        LITERAL: "${localEnv:EXAMPLE}",
        OPENCLAW_SOURCE_TREE_PATH: "/worker/project",
        OPENCLAW_WORKTREE_PATH: "/worker/project",
      });
    }
  });

  it("uses the provider lease runner and passes protected environment after recipe values", async () => {
    const { tunnel, invocations } = lifecycleTransport();
    const provider = vi.fn(
      async (command: Parameters<NonNullable<WorkerProvider["runSetupCommand"]>>[1]) => {
        command.assertCurrent();
        expect(command).toMatchObject(boundWorkspace);
        return tunnel.runWorkspaceCommand({
          argv: [
            "node",
            "-e",
            command.createScript({
              TOKEN: "sentinel_fixture",
              HTTPS_PROXY: "http://127.0.0.1:3131",
              NODE_EXTRA_CA_CERTS: "/tmp/owned/ca.pem",
            }),
          ],
          transportRetry: "never",
        });
      },
    );
    await runLifecycle(tunnel, {
      recipe: { ...recipe, env: { ...recipe.env, TOKEN: null, HTTPS_PROXY: "untrusted" } },
      ...boundWorkspace,
      runSetupCommand: provider,
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(tunnel.runWorkspaceCommand).toHaveBeenCalledTimes(1);
    for (const invocation of invocations) {
      expect(invocation.env).toMatchObject({
        TOKEN: "sentinel_fixture",
        HTTPS_PROXY: "http://127.0.0.1:3131",
        NODE_EXTRA_CA_CERTS: "/tmp/owned/ca.pem",
      });
      expect(invocation.env).not.toHaveProperty("PRIVATE_FIXTURE");
    }
  });

  it("initializes every lifecycle leaf in worker context and projects only the allowed environment", async () => {
    const transport = lifecycleTransport(undefined, {
      output: JSON.stringify({ FEED_TOKEN: "synthetic-feed" }),
    });
    await runWorkerProjectLifecycle({
      recipe: { ...recipe, env: { FEED_TOKEN: "untrusted" } },
      tunnel: transport.tunnel,
      postCreate: true,
      workspaceDir: "/worker/project",
      homeDir: "/worker/home",
      assertCurrent: () => {},
      runSetupCommand: (command) =>
        transport.tunnel.runWorkspaceCommand({
          argv: [
            "node",
            "-e",
            command.createScript(undefined, {
              command: ["/trusted/initializer"],
              envKeys: ["FEED_TOKEN"],
            }),
          ],
          transportRetry: "never",
        }),
    });
    expect(transport.initializerInputs).toEqual(
      Array.from({ length: 3 }, () => ({ timeoutMs: 600_000 })),
    );
    expect(
      transport.invocations.filter((entry) => entry.executable === "/trusted/initializer"),
    ).toHaveLength(3);
    for (const invocation of transport.invocations) {
      if (invocation.executable === "/trusted/initializer") {
        expect(invocation.cwd).toBe("/worker/home");
        expect(invocation.env.IDENTITY_HEADER).toBe("synthetic-platform-header");
      } else {
        expect(invocation.env.FEED_TOKEN).toBe("synthetic-feed");
        expect(invocation.env).not.toHaveProperty("IDENTITY_HEADER");
        expect(invocation.env).not.toHaveProperty("PRIVATE_FIXTURE");
      }
    }
    // Initializer groups settle even though successful post-binding services may continue.
    expect(transport.killedGroups).toHaveLength(3);
  });

  it.each([
    { name: "invalid JSON", output: "not-json" },
    {
      name: "unexpected transport key",
      output: JSON.stringify({ FEED_TOKEN: "synthetic-feed", IDENTITY_HEADER: "never-forward" }),
    },
    { name: "oversized output", output: "x".repeat(32769) },
    {
      name: "cancelled initializer",
      output: JSON.stringify({ FEED_TOKEN: "synthetic-feed" }),
      cancel: true,
    },
  ])(
    "rejects initializer failure before any repository command and returns no credential output ($name)",
    async (initializer) => {
      const transport = lifecycleTransport(undefined, initializer);
      await expect(
        runWorkerProjectLifecycle({
          recipe: { ...recipe, postCreate: undefined, postStart: ["serve"] },
          tunnel: transport.tunnel,
          postCreate: false,
          workspaceDir: "/worker/project",
          homeDir: "/worker/home",
          assertCurrent: () => {},
          runSetupCommand: (command) =>
            transport.tunnel.runWorkspaceCommand({
              argv: [
                "node",
                "-e",
                command.createScript(undefined, {
                  command: ["/trusted/initializer"],
                  envKeys: ["FEED_TOKEN"],
                }),
              ],
              transportRetry: "never",
            }),
        }),
      ).rejects.toThrow(/Prepared project initializer/);
      expect(transport.invocations.map((entry) => entry.executable)).toEqual([
        "/trusted/initializer",
      ]);
    },
  );

  it.each(["spawn", "signal", "timeout"] as const)(
    "records a closed native reason without leaking executable details (%s)",
    async (mode) => {
      const transport = lifecycleTransport("serve", undefined, { mode });
      await expect(
        runWorkerProjectLifecycle({
          recipe,
          tunnel: transport.tunnel,
          postCreate: false,
          assertCurrent: () => {},
        }),
      ).rejects.toThrow("Cloud environment lifecycle command failed");
      const result = await vi.mocked(transport.tunnel.runWorkspaceCommand).mock.results[0]!.value;
      const saved = JSON.parse(result.stderr.trim().split("\n").at(-1)!);
      expect(saved.events).toContainEqual(
        expect.objectContaining({
          origin: "native",
          stage: "postStart",
          outcome: "failed",
          elapsedMs: 0,
          reason: mode === "spawn" ? "spawn_failed" : mode,
        }),
      );
      if (mode === "signal") {
        expect(saved.events.at(-1).signal).toBe("SIGTERM");
      }
      expect(result.stderr).not.toContain("private executable detail");
    },
  );

  it("bounds streamed marker capture and attributes repository claims to their actual channel", async () => {
    const chunks = [
      "TEAMCLAW_SETUP_V1 stage=credential_",
      "transport outcome=failed exit=7 elapsedMs=2\r\n",
      "TEAMCLAW_SETUP_V1 stage=private_secret outcome=failed exit=7\n",
      "TEAMCLAW_SETUP_V1 stage=setup_contract outcome=failed exit=1 private=secret\n",
      "TEAMCLAW_SETUP_V1 stage=setup_contract outcome=failed exit=1 reason=private_secret\n",
      "x".repeat(20000) + "\n",
      ...Array.from(
        { length: 40 },
        () => "TEAMCLAW_SETUP_V1 stage=setup_contract outcome=succeeded\n",
      ),
    ];
    const transport = lifecycleTransport("serve", undefined, { chunks });
    await expect(
      runWorkerProjectLifecycle({
        recipe,
        tunnel: transport.tunnel,
        postCreate: false,
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("Cloud environment lifecycle command failed");
    const result = await vi.mocked(transport.tunnel.runWorkspaceCommand).mock.results[0]!.value;
    const saved = JSON.parse(result.stderr.trim().split("\n").at(-1)!);
    expect(saved.events).toHaveLength(32);
    expect(saved.truncatedEvents).toBe(10);
    expect(
      saved.events.slice(0, -1).every((event: { origin: string }) => event.origin === "repository"),
    ).toBe(true);
    expect(saved.events).toContainEqual(
      expect.objectContaining({
        origin: "repository",
        stage: "credential_transport",
        outcome: "failed",
        exit: 7,
        elapsedMs: 2,
      }),
    );
    expect(saved.events.at(-1)).toMatchObject({ origin: "native", stage: "postStart", exit: 1 });
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(16384);
    expect(JSON.stringify(saved.events)).not.toMatch(/private_secret|private=secret/);
  });

  it("keeps the ordinary tunnel when the provider has no protected setup transport", async () => {
    const { tunnel, events } = lifecycleTransport();
    await runLifecycle(tunnel, {
      postCreate: false,
      ...boundWorkspace,
      runSetupCommand: async () => undefined,
    });
    expect(tunnel.runWorkspaceCommand).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["spawn:serve", "close:serve"]);
  });

  it("does not fall back to the tunnel after a provider runner rejects", async () => {
    const { tunnel } = lifecycleTransport();
    await expect(
      runLifecycle(tunnel, {
        ...boundWorkspace,
        runSetupCommand: async () => {
          throw new Error("Protected setup egress is unavailable");
        },
      }),
    ).rejects.toThrow("Protected setup egress is unavailable");
    expect(tunnel.runWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("settles every parallel command and reports failure before starting the next phase", async () => {
    const { tunnel, events } = lifecycleTransport("lint");

    await expect(runLifecycle(tunnel)).rejects.toThrow("declared lifecycle failure");

    expect(events).toEqual(["spawn:lint", "spawn:/bin/sh", "close:lint", "close:/bin/sh"]);
  });
});
