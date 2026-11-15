import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { PROXY_FIXTURE_CERTIFICATE, PROXY_FIXTURE_KEY } from "openclaw/plugin-sdk/test-env";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { expect } from "vitest";
import {
  createCrabboxNodeEnrollmentSetup,
  createCrabboxNodeRuntimeSetup,
  type CrabboxWorkerNodeEnrollment,
} from "./crabbox-worker-node-enrollment.js";
import {
  createNodeBootstrapFixture,
  type DesktopFixture,
} from "./crabbox-worker-node-enrollment.test-support.js";
import type { CrabboxOperatingSystem } from "./crabbox-worker-profile.js";

export const loginEnvironment = {
  DISPLAY: ":0",
  DBUS_SESSION_BUS_ADDRESS: "wrong-login-session",
  XDG_RUNTIME_DIR: "/run/wrong",
};

export function createNodeEnrollmentNativeFixture({
  leaseId,
  setupCode,
  registerCleanup,
}: {
  leaseId: string;
  setupCode: string;
  registerCleanup: (cleanup: () => void | Promise<void>) => void;
}) {
  async function serveArtifact(
    archive: Buffer,
    options: {
      tls?: boolean;
      redirect?: boolean;
      resetBeforeHeaders?: boolean;
      resetBeforeTls?: boolean;
      statusCodes?: number[];
      hold?: Promise<void>;
    } = {},
  ) {
    const tls =
      options.tls && !options.resetBeforeTls
        ? { cert: PROXY_FIXTURE_CERTIFICATE, key: PROXY_FIXTURE_KEY }
        : undefined;
    const authorizations: Array<string | undefined> = [];
    const requested = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const handle: http.RequestListener = (request, response) => {
      authorizations.push(request.headers.authorization);
      requested.resolve();
      const statusCode = options.statusCodes?.[authorizations.length - 1];
      if (statusCode) {
        response.writeHead(statusCode);
        response.end();
        return;
      }
      if (options.resetBeforeHeaders) {
        // End the connection before headers in every host runtime; the child must
        // diagnose the peer loss without relying on resetAndDestroy support.
        request.socket.destroy();
        return;
      }
      if (options.redirect) {
        response.writeHead(302, { location: "https://untrusted.example.test/artifact" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-length": archive.length });
      if (options.hold) {
        void options.hold.then(() => response.end(archive));
      } else {
        response.end(archive);
      }
    };
    const server = options.resetBeforeTls
      ? net.createServer((socket) => socket.once("data", () => socket.resetAndDestroy()))
      : tls
        ? https.createServer(tls, handle)
        : http.createServer(handle);
    const sockets = new Set<net.Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
        closed.resolve();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    registerCleanup(async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP artifact server");
    }
    const nodeBootstrap = createNodeBootstrapFixture({
      url: `${options.tls ? "https" : "http"}://127.0.0.1:${address.port}/artifact`,
      sha256: createHash("sha256").update(archive).digest("hex"),
      bytes: archive.length,
      ...(tls ? { tlsFingerprint: new X509Certificate(tls.cert).fingerprint256 } : {}),
    });
    return { nodeBootstrap, authorizations, requested: requested.promise, closed: closed.promise };
  }

  async function enroll(
    home: string,
    nodeBootstrap: CrabboxWorkerNodeEnrollment["nodeBootstrap"],
    desktop?: DesktopFixture,
    runtimeOnly = false,
    workerBundle?: CrabboxWorkerNodeEnrollment["nodeBootstrap"] & { packageRelativePath: string },
    options?: {
      credentials?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      trustBin?: string;
      target?: CrabboxOperatingSystem;
      setup?: ReturnType<typeof createCrabboxNodeEnrollmentSetup>;
    },
  ) {
    const bin = path.join(home, "bin");
    const proc = path.join(home, "proc");
    fs.mkdirSync(bin, { recursive: true });
    // Never update the test host\'s certificate store from a generated guest command.
    fs.writeFileSync(path.join(bin, "update-ca-certificates"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700,
    });
    fs.writeFileSync(
      path.join(bin, "sudo"),
      '#!/bin/sh\nset -eu\ntest "$1" = -n && test "$2" = --\nshift 2\nexec "$@"\n',
      { mode: 0o700 },
    );
    if (desktop) {
      fs.mkdirSync(bin, { recursive: true });
      fs.mkdirSync(path.join(proc, "123"), { recursive: true });
      fs.writeFileSync(path.join(home, "desktop.env"), "CRABBOX_DESKTOP_ENV=xfce\nDISPLAY=:99\n");
      fs.writeFileSync(
        path.join(proc, "123", "environ"),
        [
          `DISPLAY=${desktop.display ?? ":99"}`,
          `DBUS_SESSION_BUS_ADDRESS=${desktop.dbus ?? "unix:path=/run/fixture/bus"}`,
          `XDG_RUNTIME_DIR=${desktop.runtimeDir ?? "/run/fixture"}`,
          "UNRELATED_DESKTOP_VALUE=do-not-export",
          "",
        ].join("\0"),
      );
      fs.writeFileSync(
        path.join(bin, "pgrep"),
        `#!/bin/sh
  set -eu
  [ "$*" = "-u $(id -u) -x xfce4-session" ]
  [ -z "\${CRABBOX_WORKER_BOOTSTRAP_TOKEN-}" ]
  [ -z "\${CRABBOX_WORKER_SETUP_CODE-}" ]
  echo 123
  `,
        { mode: 0o700 },
      );
    }
    const setup =
      options?.setup ??
      (runtimeOnly
        ? createCrabboxNodeRuntimeSetup({
            leaseId,
            nodeBootstrap,
            workerBundle: workerBundle!,
            target: options?.target,
          })
        : createCrabboxNodeEnrollmentSetup({
            leaseId,
            target: options?.target,
            desktop: desktop?.enabled,
            desktopSetup: desktop?.setup,
            enrollment: {
              mode: "connect",
              setupCode,
              setupId: "bootstrap-test",
              openclawVersion: "2026.8.1",
              nodeBootstrap,
              displayName: "Bootstrap test",
              waitForDeviceId: async () => "device-test",
            },
          }));
    expect(setup.command).not.toContain(nodeBootstrap.token);
    expect(setup.command).not.toContain(setupCode);
    const hooks = path.join(home, "bootstrap-test-hooks.cjs");
    // Observe real npm launches even when Linux prepends Node's directory to PATH.
    fs.writeFileSync(
      hooks,
      `require("node:timers/promises").setTimeout = async () => {};
  const childProcess = require("node:child_process");
  const spawnSync = childProcess.spawnSync;
  // The desktop OS fixture must precede even a system-wide Node directory (such as /usr/bin).
  childProcess.spawnSync = (command, args, options) => {
    if (${JSON.stringify(Boolean(desktop))} && command === "bash" && args[0] === "-c") {
      options = { ...options, env: { ...options.env, PATH: ${JSON.stringify(bin)} + require("node:path").delimiter + options.env.PATH } };
    }
    return spawnSync(command, args, options);
  };
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    if (command === "npm") require("node:fs").appendFileSync(${JSON.stringify(path.join(home, "npm-calls"))}, args[0] + "\\n");
    return spawn(command, args, options);
  };
  `,
    );
    const child = spawn("/bin/sh", [], {
      env: {
        HOME: home,
        NODE_OPTIONS: `--require ${JSON.stringify(hooks)}`,
        PATH: `${options?.trustBin ?? bin}:${process.env.PATH}`,
        ...(desktop ? loginEnvironment : {}),
        ...setup.forwardedEnv,
        ...(options?.credentials ? { CRABBOX_WORKER_BOOTSTRAP_TOKEN: options.credentials } : {}),
        // Exercise the installer overriding an inherited package-manager default.
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
      },
      detached: true,
      stdio: "pipe",
    });
    const timeout = options?.timeoutMs
      ? setTimeout(() => {
          if (child.pid) {
            process.kill(-child.pid, "SIGKILL");
          }
        }, options.timeoutMs)
      : undefined;
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    // Replace only OS fixture roots; the generated bootstrap and credential flow execute unchanged.
    child.stdin.end(
      setup.command
        .replaceAll(
          "/usr/sbin/update-ca-certificates",
          path.join(options?.trustBin ?? bin, "update-ca-certificates"),
        )
        .replaceAll("/var/lib/crabbox/desktop.env", path.join(home, "desktop.env"))
        .replaceAll("/proc/$process_pid/environ", `${proc}/$process_pid/environ`),
    );
    const closed = once(child, "close");
    try {
      const [code] = await (options?.signal ? withinTest(closed, options.signal) : closed);
      return { code, output: Buffer.concat(output).toString("utf8") };
    } finally {
      clearTimeout(timeout);
      const active = child.exitCode === null && child.signalCode === null;
      if (options?.signal?.aborted && child.pid && active) {
        // The enrollment shell owns desktop setup; stop its group before releasing the FIFO.
        process.kill(-child.pid, "SIGKILL");
      }
      await closed;
    }
  }
  return { serveArtifact, enroll };
}
