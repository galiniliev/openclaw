import { spawn, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayClient } from "../../packages/gateway-client/src/client.js";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import {
  gatewayDirectStopEntrypoints,
  cliRecoveryEntrypoints,
} from "../cli/cli-entrypoint.test-support.js";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { buildBackupArchiveRoot } from "../commands/backup-shared.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { buildBackupArchivePath } from "../infra/backup-archive-path-policy.js";
import type { BackupCreateResult } from "../infra/backup-create.js";
import { generateStoredDeviceIdentity } from "../infra/device-identity-material.js";
import { publicKeyRawBase64UrlFromPem, signDevicePayload } from "../infra/device-identity.js";
import { sha256File } from "../infra/directory-durability.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const token = "rolling-release-synthetic-only-token";
const image = {
  type: "file",
  mimeType: "image/png",
  fileName: "fixture.png",
  content: createSolidPngBuffer(32, 32, { r: 24, g: 88, b: 146 }).toString("base64"),
};
let state: OpenClawTestState | undefined;
const children: Array<{ child: ChildProcess; closed: Promise<unknown> }> = [];
const clients: GatewayClient[] = [];
const servers: Array<net.Server | http.Server> = [];
const sockets = new Set<net.Socket>();
const namespaces = new Set<string>();

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stopAndWait()));
  await Promise.all(children.map(({ child }) => stopChildProcess(child, 5_000)));
  await Promise.all(children.splice(0).map(({ closed }) => closed));
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  if (state) {
    for (const file of [
      path.join(state.stateDir, "state/openclaw.sqlite"),
      path.join(state.stateDir, "agents/main/agent/openclaw-agent.sqlite"),
    ]) {
      try {
        using anchor = openNodeSqliteDatabase(file, { readOnly: true });
        const row = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get();
        if (typeof row?.schema === "string") {
          namespaces.add(row.schema);
        }
      } catch {
        /* a failed cold bootstrap may not have created this exact owned anchor */
      }
    }
  }
  if (connection && namespaces.size) {
    const cleanup = new pg.Client({ connectionString: connection });
    await cleanup.connect();
    try {
      for (const namespace of namespaces) {
        await cleanup.query(`DROP SCHEMA IF EXISTS "${namespace.replaceAll('"', '""')}" CASCADE`);
      }
    } finally {
      await cleanup.end();
      namespaces.clear();
    }
  }
  await state?.cleanup();
  state = undefined;
});

async function listen(server: net.Server | http.Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture listener did not bind loopback");
  }
  return address.port;
}

function launch(
  mode: "predecessor" | "candidate",
  stateDir: string,
  configPath: string,
  port: number,
  signal: AbortSignal,
  contractPath?: string,
) {
  const node = resolveTestNodeExecPath();
  const entrypoint =
    mode === "candidate"
      ? cliRecoveryEntrypoints.cli
      : gatewayDirectStopEntrypoints.rollingReleaseFixture;
  const args =
    mode === "candidate"
      ? [
          "gateway",
          "run",
          "--rolling-standby",
          "rolling-fixture",
          "--rolling-contract",
          contractPath!,
          "--port",
          String(port),
        ]
      : ["predecessor"];
  const child = spawn(
    node,
    [...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(entrypoint), node), ...args],
    {
      cwd: state!.root,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(stateDir, "fixture-home"),
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_PORT: String(port),
        OPENCLAW_ROLLING_FIXTURE_DSN: connection,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_HIDE_BANNER: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
      },
      stdio: mode === "candidate" ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "ipc"],
    },
  );
  let privateStderr = Buffer.alloc(0);
  child.stderr?.on("data", (value: Buffer) => {
    privateStderr = Buffer.concat([privateStderr, value]).subarray(-16_384);
  });
  const closed = once(child, "close").then(async (result) => {
    const evidence = process.env.OPENCLAW_ROLLING_FIXTURE_EVIDENCE_DIR;
    if (evidence) {
      await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(evidence, `${mode}-${child.pid}.stderr.private.log`),
        privateStderr,
        { mode: 0o600 },
      );
    }
    return result;
  });
  children.push({ child, closed });
  const ready = createDeferredCore();
  const replies = new Map<string, ReturnType<typeof createDeferredCore<Record<string, unknown>>>>();
  let output = "";
  child.stdout?.setEncoding("utf8").on("data", (text: string) => {
    output += text;
    let end: number;
    while ((end = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, end);
      output = output.slice(end + 1);
      try {
        accept(JSON.parse(line));
      } catch {
        /* ordinary startup diagnostics are not control replies */
      }
    }
  });
  function accept(value: Record<string, unknown>) {
    if (value.type === "ready") {
      ready.resolve();
    }
    if (typeof value.id === "string") {
      replies.get(value.id)?.resolve(value);
      replies.delete(value.id);
    }
  }
  if (mode === "predecessor") {
    child.on("message", (value: Record<string, unknown>) => accept(value));
  }
  void closed.then(() => {
    ready.reject(new Error("Gateway fixture exited before readiness"));
    for (const reply of replies.values()) {
      reply.reject(new Error("Gateway fixture exited before its control receipt"));
    }
  });
  let sequence = 0;
  const readiness = racePromiseWithAbortSignal(ready.promise, signal);
  void readiness.catch(() => undefined);
  return {
    child,
    closed,
    ready: readiness,
    async command(action: string, extra: Record<string, unknown> = {}) {
      const id = `fixture-${++sequence}`;
      const response = createDeferredCore<Record<string, unknown>>();
      replies.set(id, response);
      const message = { version: 1, id, releaseId: "rolling-fixture", action, ...extra };
      if (mode === "candidate") {
        child.stdin!.write(`${JSON.stringify(message)}\n`);
      } else {
        child.send(message);
      }
      const value = await racePromiseWithAbortSignal(response.promise, signal);
      expect(value.ok, `Control action ${action} failed`).toBe(true);
      return value;
    },
  };
}

function connect(
  port: number,
  identity: ReturnType<typeof generateStoredDeviceIdentity>,
  signal: AbortSignal,
) {
  const hello = createDeferredCore();
  let bootId: string | undefined;
  let nextHello: ReturnType<typeof createDeferredCore<string | undefined>> | undefined;
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token,
    clientName: "test",
    mode: "test",
    platform: "test",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    deviceIdentity: identity,
    requestTimeoutMs: 90_000,
    hostDeps: { signDevicePayload, publicKeyRawBase64UrlFromPem },
    onHelloOk: (accepted) => {
      bootId = accepted.server.bootId;
      hello.resolve();
      nextHello?.resolve(bootId);
      nextHello = undefined;
    },
  });
  clients.push(client);
  client.start();
  return {
    client,
    ready: racePromiseWithAbortSignal(hello.promise, signal),
    get bootId() {
      return bootId;
    },
    observeNextHello() {
      nextHello = createDeferredCore<string | undefined>();
      return racePromiseWithAbortSignal(nextHello.promise, signal);
    },
  };
}

describe.skipIf(!connection)("PostgreSQL rolling release preservation", () => {
  it(
    "defers busy work, preserves final companion/history/input, and transfers one writer without a read outage",
    { timeout: 180_000 },
    async ({ signal }) => {
      state = await createOpenClawTestState({
        label: "pg-rolling",
        layout: "state-only",
        scenario: "empty",
        env: { OPENCLAW_ROLLING_FIXTURE_DSN: connection },
      });
      let modelCalls = 0;
      const modelBodies: string[] = [];
      const modelEntered = createDeferredCore();
      const releaseModel = createDeferredCore();
      const serveModel = async (req: http.IncomingMessage, res: http.ServerResponse) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        modelBodies.push(Buffer.concat(chunks).toString("utf8"));
        modelCalls += 1;
        if (modelCalls === 1) {
          modelEntered.resolve();
          await releaseModel.promise;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const payload of [
          {
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "synthetic reply" },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]) {
          res.write(
            `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: "synthetic", ...payload })}\n\n`,
          );
        }
        res.end("data: [DONE]\n\n");
      };
      const modelPort = await listen(
        http.createServer((req, res) => {
          void serveModel(req, res).catch((error: unknown) =>
            res.destroy(error instanceof Error ? error : new Error(String(error))),
          );
        }),
      );
      const freePort = async () => {
        const claim = net.createServer();
        const port = await listen(claim);
        await new Promise<void>((resolve) => {
          claim.close(() => resolve());
        });
        return port;
      };
      const oldPort = await freePort();
      const nextPort = await freePort();
      let route = oldPort;
      const routePort = await listen(
        net.createServer((socket) => {
          const upstream = net.connect(route, "127.0.0.1");
          sockets.add(socket);
          sockets.add(upstream);
          socket.on("error", () => upstream.destroy());
          upstream.on("error", () => socket.destroy());
          socket.on("close", () => {
            upstream.destroy();
            sockets.delete(socket);
          });
          upstream.on("close", () => {
            socket.destroy();
            sockets.delete(upstream);
          });
          socket.pipe(upstream).pipe(socket);
        }),
      );
      await state.writeConfig({
        database: {
          engine: "postgres",
          postgres: {
            connection: { source: "env", provider: "default", id: "OPENCLAW_ROLLING_FIXTURE_DSN" },
            schemaPrefix: "rolling_fixture",
          },
        },
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "token", token },
          controlUi: { enabled: false },
        },
        plugins: { enabled: false },
        skills: { load: { watch: false } },
        cron: { enabled: false },
        discovery: { mdns: { mode: "off" } },
        models: {
          providers: {
            "rolling-fixture": {
              api: "openai-completions",
              baseUrl: `http://127.0.0.1:${modelPort}/v1`,
              apiKey: "synthetic-loopback-only",
              models: [
                {
                  id: "synthetic",
                  name: "Synthetic",
                  input: ["text", "image"],
                  contextWindow: 32_000,
                  maxTokens: 1_024,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
        agents: { defaults: { model: "rolling-fixture/synthetic", utilityModel: "" } },
        tools: { profile: "minimal" },
      });
      const old = launch("predecessor", state.stateDir, state.configPath, oldPort, signal);
      await old.ready;
      console.info("[rolling-proof] predecessor ready");
      const identity = generateStoredDeviceIdentity();
      const routed = connect(routePort, identity, signal);
      await routed.ready;
      const first = await routed.client.request<{ runId: string }>("chat.send", {
        sessionKey: "main",
        message: "accepted before handoff",
        attachments: [image],
        idempotencyKey: "rolling-before",
      });
      console.info("[rolling-proof] first input response", JSON.stringify(first));
      const entered = await Promise.race([
        racePromiseWithAbortSignal(modelEntered.promise, signal).then(() => ({
          modelEntered: true,
        })),
        routed.client
          .request("agent.wait", { runId: first.runId, timeoutMs: 20_000 })
          .then((terminal) => ({ terminal })),
      ]);
      expect(entered).toEqual({ modelEntered: true });
      const facts = await routed.client.request<{
        rollingRelease: {
          compatibilityDigest: string;
          storeIdentity: string;
          bootId: string;
          executionOwner: string;
        };
        pid: number;
        processInstanceId: string;
      }>("system.info", { includeRollingRelease: true });
      const contract = {
        version: 1,
        releaseId: "rolling-fixture",
        predecessorBootId: facts.rollingRelease.bootId,
        candidateBootId: "fixture-next-boot",
        predecessorOwner: facts.rollingRelease.executionOwner,
        compatibilityDigest: facts.rollingRelease.compatibilityDigest,
        expiresAtMs: Date.now() + 120_000,
      };
      const captureAtMs = Date.now();
      const restoredRoot = state.path("restored");
      const futureState = path.join(
        restoredRoot,
        buildBackupArchivePath(
          buildBackupArchiveRoot(captureAtMs),
          await fs.realpath(state.stateDir),
        ),
      );
      const contractPath = state.path("candidate-contract.json");
      await fs.writeFile(contractPath, JSON.stringify(contract), { mode: 0o600 });
      const next = launch(
        "candidate",
        futureState,
        path.join(futureState, "openclaw.json"),
        nextPort,
        signal,
        contractPath,
      );
      expect(await next.command("status")).toMatchObject({
        phase: "prewarmed",
        immutableReady: true,
        readReady: false,
      });
      await expect(fs.stat(futureState)).rejects.toMatchObject({ code: "ENOENT" });
      console.info("[rolling-proof] immutable prewarm complete while old model remains active");
      const prepare = {
        requestId: "same-release-operation",
        rollingReleaseId: "rolling-fixture",
        terminalPolicy: "preserve",
      };
      expect(await routed.client.request("gateway.suspend.prepare", prepare)).toMatchObject({
        status: "busy",
      });
      releaseModel.resolve();
      expect(
        await routed.client.request("agent.wait", { runId: first.runId, timeoutMs: 30_000 }),
      ).toMatchObject({ status: "ok" });
      const seeded = await old.command("seed-companion");
      let prepared = await routed.client.request<{
        status: string;
        suspensionId: string;
        retryAfterMs?: number;
      }>("gateway.suspend.prepare", prepare);
      while (prepared.status === "busy") {
        await delay(prepared.retryAfterMs ?? 20_000, undefined, { signal });
        prepared = await routed.client.request("gateway.suspend.prepare", prepare);
      }
      expect(prepared.status).toBe("ready");
      console.info("[rolling-proof] busy then quiet, final mutation fence ready");
      const pending = routed.client.request<{ runId: string }>(
        "chat.send",
        {
          sessionKey: "main",
          message: "retained during handoff",
          attachments: [image],
          idempotencyKey: "rolling-during",
        },
        { timeoutMs: 90_000 },
      );
      void pending.catch(() => undefined);
      const reading = { stopped: false };
      let readCount = 0;
      const reads = (async () => {
        while (!reading.stopped) {
          await routed.client.request("sessions.list", { limit: 10 });
          expect(
            JSON.stringify(
              await routed.client.request("chat.history", { sessionKey: "main", limit: 10 }),
            ),
          ).toContain("accepted before handoff");
          readCount += 1;
        }
      })();
      void reads.catch(() => undefined);
      const captured = await old.command("capture", {
        output: state.path("final-companion.tar.gz"),
        captureAtMs,
      });
      const archive = captured.archive as BackupCreateResult;
      console.info("[rolling-proof] canonical companion captured");
      const restored = await backupRestoreCommand(createTestRuntime(), {
        archive: archive.archivePath,
        target: restoredRoot,
        localCompanion: true,
      });
      const stateAsset = archive.assets.find((asset) => asset.kind === "state");
      expect(stateAsset).toBeDefined();
      const restoredState = path.join(restoredRoot, stateAsset!.archivePath);
      expect(restoredState).toBe(futureState);
      const configAsset = archive.assets.find((asset) => asset.kind === "config");
      const restoredConfig = configAsset
        ? path.join(restoredRoot, configAsset.archivePath)
        : path.join(restoredState, "openclaw.json");
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(restoredState, "rolling-fixture/provider-journal.json"),
            "utf8",
          ),
        ),
      ).toEqual({ fixture: true, epoch: "final-before-fence" });
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(restoredState, "rolling-fixture/file-credential.json"),
            "utf8",
          ),
        ),
      ).toEqual({ synthetic: "final-before-fence" });
      const head = await promisify(execFile)(
        "git",
        ["-C", path.join(restoredState, "rolling-fixture/checkpoint"), "rev-parse", "HEAD"],
        {
          env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        },
      );
      expect(head.stdout.trim()).toBe(seeded.gitHead);
      const media = seeded.media as { relativeRoot: string; files: string[] };
      expect(media.files.length).toBeGreaterThan(0);
      for (const file of media.files) {
        expect(
          (await fs.stat(path.join(restoredState, media.relativeRoot, file))).size,
        ).toBeGreaterThan(0);
      }
      expect(restoredConfig).toBe(path.join(futureState, "openclaw.json"));
      const companion = {
        generation: (await sha256File(archive.archivePath)).digest,
        restoreReceiptId: restored.archiveRoot,
      };
      expect(await next.command("bind-read-only", { companion })).toMatchObject({
        phase: "read-only",
        readReady: true,
        writerReady: false,
      });
      console.info("[rolling-proof] candidate read-only ready");
      const readOnlyClient = connect(nextPort, identity, signal);
      await readOnlyClient.ready;
      expect(
        JSON.stringify(
          await readOnlyClient.client.request("chat.history", { sessionKey: "main", limit: 10 }),
        ),
      ).toContain("accepted before handoff");
      await readOnlyClient.client.stopAndWait();
      expect(modelCalls).toBe(1);
      await routed.client.request("gateway.suspend.handoff", {
        suspensionId: prepared.suspensionId,
        target: { pid: facts.pid, processInstanceId: facts.processInstanceId },
        yieldExecution: { ...contract, companionGeneration: companion.generation },
      });
      expect(await next.command("prepare-writer")).toMatchObject({
        phase: "writer-prepared",
        readReady: true,
        writerReady: false,
      });
      console.info("[rolling-proof] candidate writer-prepared read ready");
      const preparedClient = connect(nextPort, identity, signal);
      await preparedClient.ready;
      expect(
        JSON.stringify(
          await preparedClient.client.request("chat.history", { sessionKey: "main", limit: 10 }),
        ),
      ).toContain("accepted before handoff");
      await preparedClient.client.request("users.list", {});
      await preparedClient.client.stopAndWait();
      expect(modelCalls).toBe(1);
      route = nextPort;
      await old.command("close");
      expect(await racePromiseWithAbortSignal(old.closed, signal)).toEqual([0, null]);
      expect(
        await next.command("activate", {
          predecessorRetirement: {
            bootId: contract.predecessorBootId,
            releaseId: contract.releaseId,
            childIdentity: `owned-child-${old.child.pid}`,
            exited: true,
          },
        }),
      ).toMatchObject({ phase: "writer-ready", writerReady: true });
      const admitted = await pending;
      expect(
        await routed.client.request("agent.wait", { runId: admitted.runId, timeoutMs: 30_000 }),
      ).toMatchObject({ status: "ok" });
      reading.stopped = true;
      await reads;
      expect(readCount).toBeGreaterThan(0);
      expect(modelCalls).toBe(2);
      expect(modelBodies).toHaveLength(2);
      for (const body of modelBodies) {
        expect(body).toContain("data:image/");
      }
      const history = await routed.client.request("chat.history", {
        sessionKey: "main",
        limit: 30,
      });
      expect(JSON.stringify(history)).toContain("accepted before handoff");
      expect(JSON.stringify(history)).toContain("retained during handoff");
      const activeBoot = routed.bootId;
      const restarted = routed.observeNextHello();
      expect(
        await routed.client.request("gateway.restart.request", {
          safe: true,
          reason: "rolling-fixture-ordinary-restart",
        }),
      ).toMatchObject({ ok: true });
      const restartedBoot = await restarted;
      expect(restartedBoot).toBeTruthy();
      expect(restartedBoot).not.toBe(activeBoot);
      const restartedFacts = await routed.client.request<{
        rollingRelease: { bootId: string; executionOwner: string };
      }>("system.info", { includeRollingRelease: true });
      expect(restartedFacts.rollingRelease.bootId).toBe(restartedBoot);
      expect(restartedFacts.rollingRelease.executionOwner).toBeTruthy();
      expect(
        JSON.stringify(
          await routed.client.request("chat.history", { sessionKey: "main", limit: 30 }),
        ),
      ).toContain("retained during handoff");
      expect(modelCalls).toBe(2);
      console.info(
        "[rolling-proof] activated writer ordinary restart preserved history and did not replay input",
      );
      await routed.client.stopAndWait();
      await next.command("abort");
      next.child.stdin!.end();
      expect(await racePromiseWithAbortSignal(next.closed, signal)).toEqual([0, null]);
      using anchor = openNodeSqliteDatabase(path.join(state.stateDir, "state/openclaw.sqlite"), {
        readOnly: true,
      });
      const namespace = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get()?.schema;
      expect(typeof namespace).toBe("string");
      const observer = new pg.Client({
        connectionString: connection,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 5_000,
      });
      await observer.connect();
      try {
        expect(
          (
            await observer.query(
              `SELECT owner FROM "${String(namespace).replaceAll('"', '""')}".state_leases WHERE scope='gateway-owner' AND lease_key='global'`,
            )
          ).rows,
        ).toEqual([]);
      } finally {
        await observer.end();
      }
    },
  );
});
