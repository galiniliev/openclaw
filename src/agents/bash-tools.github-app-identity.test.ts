import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const grants = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../gateway/worker-environments/worker-github-binding.js", () => ({
  prepareWorkerGitHubBindingGrant: grants.prepare,
}));
const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  grants.prepare.mockReset();
});

describe("foreground local GitHub App execution", () => {
  it.each([false, true])(
    "delivers an ephemeral App credential to the command (PTY=%s)",
    async (pty) => {
      const root = roots.make("local-app-exec-");
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      const token = "synthetic-private-app-exec-token";
      const revoke = vi.fn(async () => {});
      grants.prepare.mockResolvedValue({
        binding: { token, host: "microsoft.ghe.com", login: "example-app[bot]" },
        signal: new AbortController().signal,
        assertCurrent: () => {},
        refresh: async () => undefined,
        revoke,
      });
      const config: OpenClawConfig = {
        tools: {
          github: {
            kind: "app-installation",
            profileId: "ghp_11111111111111111111111111111111",
            app: {
              appId: 1,
              installationId: 2,
              accountId: 3,
              repositories: [{ id: 4, fullName: "example/project" }],
              permissions: { contents: "write" },
              privateKey: "synthetic-key",
              keyVersion: "v1",
            },
          },
        },
      };
      const probe = path.join(root, "probe.cjs");
      await fs.writeFile(
        probe,
        `process.stdout.write(JSON.stringify({ selected: process.env.GH_TOKEN === ${JSON.stringify(token)}, host: process.env.GH_HOST, isolated: !process.env.GITHUB_TOKEN && !process.env.GH_ENTERPRISE_TOKEN && !process.env.GITHUB_ENTERPRISE_TOKEN, tty: !!process.stdout.isTTY }));`,
      );
      const tool = createExecTool({
        config,
        agentId: "borrowed-policy",
        executionAgentId: "main",
        sessionId: "local-app-session",
        sessionKey: "agent:borrowed-policy:policy",
        runSessionKey: "agent:main:local-app",
        host: "gateway",
        security: "full",
        ask: "off",
        bypassHostApprovalFloors: true,
        cwd: root,
        notifyOnExit: false,
        allowBackground: false,
        preparedStoreEnvironment: { env: {} },
      });
      const result = await withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:local-app" },
        () =>
          tool.execute("app-exec", {
            command: [process.execPath, probe].map((value) => JSON.stringify(value)).join(" "),
            pty,
          }),
      );
      expect(result.details).toMatchObject({ status: "completed" });
      const text = result.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      expect(text).not.toContain(token);
      expect(text).toContain(
        JSON.stringify({ selected: true, host: "microsoft.ghe.com", isolated: true, tty: pty }),
      );
      expect(grants.prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          sessionId: "local-app-session",
          sessionKey: "agent:main:local-app",
          expectedProfileId: "ghp_11111111111111111111111111111111",
        }),
      );
      expect(revoke).toHaveBeenCalledOnce();
    },
  );
});

async function launchAppProbe(params: {
  code: string;
  durable?: boolean;
  pty?: boolean;
  startupSignal?: AbortSignal;
  assertCurrent?: () => void;
  revoke?: () => Promise<void>;
}) {
  const root = roots.make("local-app-lifecycle-");
  const authority = new AbortController();
  const revoke = vi.fn(params.revoke ?? (async () => {}));
  grants.prepare.mockImplementation(async (request: { signal?: AbortSignal }) => ({
    binding: {
      token: "synthetic-private-app-exec-token",
      host: "microsoft.ghe.com",
      login: "example-app[bot]",
    },
    signal: AbortSignal.any([authority.signal, ...(request.signal ? [request.signal] : [])]),
    assertCurrent: params.assertCurrent ?? (() => authority.signal.throwIfAborted()),
    refresh: async () => undefined,
    revoke,
  }));
  const run = await runExecProcess({
    command: [process.execPath, "-e", params.code].map((value) => JSON.stringify(value)).join(" "),
    workdir: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GH_TOKEN: "",
      GH_ENTERPRISE_TOKEN: "",
      GITHUB_TOKEN: "",
      GITHUB_ENTERPRISE_TOKEN: "",
    },
    githubProfileDir: root,
    githubApp: {
      profileId: "ghp_11111111111111111111111111111111",
      agentId: "main",
      sessionId: "local-app-session",
      sessionKey: "agent:main:local-app",
    },
    usePty: params.pty ?? false,
    warnings: [],
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    notifyOnExit: false,
    timeoutSec: 10,
    ...(params.durable
      ? { durable: { notifyOnExit: false, notifyOnExitEmptySuccess: false } }
      : {}),
    startupSignal: params.startupSignal,
  });
  return { run, authority, revoke };
}

it("refuses durable App execution before issuing a credential", async () => {
  await expect(
    launchAppProbe({ code: "process.stdout.write('must not run')", durable: true }),
  ).rejects.toThrow("GitHub App credentials require non-durable execution");
  expect(grants.prepare).not.toHaveBeenCalled();
});

it("releases an issued grant when final authority rejects launch", async () => {
  const revoke = vi.fn(async () => {});
  await expect(
    launchAppProbe({
      code: "process.stdout.write('must not run')",
      assertCurrent: () => {
        throw new Error("App authority retired");
      },
      revoke,
    }),
  ).rejects.toThrow("App authority retired");
  expect(revoke).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "cancels on App authority loss and joins cleanup after process extinction (PTY=%s)",
  async (pty) => {
    const root = roots.make("local-app-process-");
    const pidFile = path.join(root, "pid");
    let pid: number | undefined;
    const revoke = async () => {
      const currentPid = pid;
      if (currentPid !== undefined) {
        expect(() => process.kill(currentPid, 0)).toThrow();
      }
    };
    const {
      run,
      authority,
      revoke: revoked,
    } = await launchAppProbe({
      code: `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
      pty,
      revoke,
    });
    try {
      await vi.waitFor(async () => {
        pid = Number(await fs.readFile(pidFile, "utf8"));
        expect(pid).toBeGreaterThan(0);
      });
      authority.abort(new Error("App authority retired"));
      expect((await run.promise).status).toBe("failed");
      expect(revoked).toHaveBeenCalledOnce();
    } finally {
      run.kill();
      await run.promise;
    }
  },
);

it.each([false, true])(
  "keeps an already launched command after its startup signal aborts (PTY=%s)",
  async (pty) => {
    const startup = new AbortController();
    const { run, revoke } = await launchAppProbe({
      code: "setTimeout(() => process.stdout.write('retained command'), 100)",
      pty,
      startupSignal: startup.signal,
    });
    startup.abort();
    const outcome = await run.promise;
    expect(outcome.status).toBe("completed");
    expect(outcome.aggregated).toContain("retained command");
    expect(revoke).toHaveBeenCalledOnce();
  },
);

it("refuses App issuance without a matching foreground caller", async () => {
  const root = roots.make("local-app-no-caller-");
  const tool = createExecTool({
    agentId: "main",
    sessionId: "local-app-session",
    sessionKey: "agent:main:local-app",
    host: "gateway",
    security: "full",
    ask: "off",
    bypassHostApprovalFloors: true,
    cwd: root,
    notifyOnExit: false,
    preparedStoreEnvironment: { env: {} },
    preparedRunEnvironment: {
      credentialScrubEnv: {},
      localIdentityEnv: { GH_CONFIG_DIR: root },
      managedLocalIdentity: true,
      appInstallationProfileId: "ghp_11111111111111111111111111111111",
      excludedStoreNames: [],
    },
  });
  await expect(tool.execute("unowned-app-exec", { command: "echo must-not-run" })).rejects.toThrow(
    "current agent and session",
  );
  expect(grants.prepare).not.toHaveBeenCalled();
});
