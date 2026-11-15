import { existsSync } from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cronRunLogEntryToDetail } from "../cron/run-history-detail.js";
import { recordCronRun } from "../cron/store/run-history.js";
import { setDatabaseEngineReadOnlyAdmission } from "../infra/database-engine/context.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  resetGatewayWorkAdmission,
  setGatewayRollingAdmission,
} from "../process/gateway-work-admission.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import { createKernelFixture } from "./server-kernel.fixture-test-support.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
let fixture: Awaited<ReturnType<typeof createKernelFixture>>;
let kernel: Awaited<ReturnType<typeof fixture.open>>;
const request = (
  method: string,
  options: Partial<Parameters<typeof dispatchGatewayRequestInProcessRaw>[2]> = {},
  params: unknown = {},
) =>
  dispatchGatewayRequestInProcessRaw(method, params, {
    context: kernel.gatewayRequestContext,
    client: createOperatorWsClient(),
    ...options,
  });

beforeAll(async () => {
  fixture = await createKernelFixture("rolling-dashboard-reads", {
    layout: "home",
    env: { OPENCLAW_ENTRY_FIXTURE_DSN: connection },
  });
  await fixture.configure(
    connection
      ? {
          database: {
            engine: "postgres",
            postgres: {
              connection: { source: "env", provider: "default", id: "OPENCLAW_ENTRY_FIXTURE_DSN" },
              schemaPrefix: "entry_read_fixture",
            },
          },
        }
      : {},
  );
  kernel = await fixture.open();
  kernel.kernel.setDispatchReady(true);
});
afterAll(async () => {
  await kernel?.closeOnStartupFailure();
  try {
    if (connection) {
      const cleanup = new pg.Client({ connectionString: connection });
      await cleanup.connect();
      try {
        for (const relative of [
          "state/openclaw.sqlite",
          "agents/main/agent/openclaw-agent.sqlite",
        ]) {
          const file = path.join(fixture.state.stateDir, relative);
          if (!existsSync(file)) {
            continue;
          }
          using anchor = openNodeSqliteDatabase(file, { readOnly: true });
          if (
            !anchor.prepare("SELECT 1 FROM sqlite_master WHERE name='openclaw_engine_anchor'").get()
          ) {
            continue;
          }
          const schema = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get()?.schema;
          if (typeof schema !== "string") {
            throw new Error("Missing owned PostgreSQL anchor");
          }
          await cleanup.query(`DROP SCHEMA "${schema.replaceAll('"', '""')}" CASCADE`);
        }
      } finally {
        await cleanup.end();
      }
    }
  } finally {
    await fixture.state.cleanup();
  }
});

it("keeps dashboard and automation reads available during a read-only rolling handoff", async () => {
  // This fixture owns the socket-free kernel; HTML is read through its real board worker.
  kernel.gatewayRequestContext.ensureSandboxHostPort = undefined;
  const sessionKey = "agent:main:dashboard:rolling-read";
  const created = await request("sessions.create", {}, { key: sessionKey });
  expect(created).toMatchObject({ ok: true });
  if (
    !isRecord(created.payload) ||
    !isRecord(created.payload.entry) ||
    typeof created.payload.entry.sessionId !== "string"
  ) {
    throw new Error("Missing created session identity");
  }
  expect(
    await request("chat.inject", {}, { sessionKey, message: "Preserved automation transcript" }),
  ).toMatchObject({ ok: true });
  const added = await request(
    "cron.add",
    {},
    {
      name: "Preserved automation",
      enabled: false,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "Not executed" },
    },
  );
  expect(added).toMatchObject({ ok: true });
  if (!isRecord(added.payload) || typeof added.payload.id !== "string") {
    throw new Error("Missing job identity");
  }
  const jobId = added.payload.id;
  const storeKey = kernel.gatewayRequestContext.cron.getStoreKey?.();
  if (!storeKey) {
    throw new Error("Missing admitted cron store");
  }
  await recordCronRun({
    storeKey,
    jobId,
    runId: "rolling-read-run",
    agentId: "main",
    sessionKey,
    startedAt: 10,
    endedAt: 20,
    status: "succeeded",
    summary: "Retained outcome",
    detail: cronRunLogEntryToDetail(
      {
        jobId,
        action: "finished",
        ts: 20,
        runAtMs: 10,
        runId: "rolling-read-run",
        sessionKey,
        sessionId: created.payload.entry.sessionId,
        status: "ok",
      },
      { storeKey },
    ),
  });
  expect(
    await request(
      "board.widget.put",
      {},
      {
        sessionKey,
        name: "status",
        content: { kind: "html", html: "Preserved dashboard" },
        declared: { tools: ["cron.list"] },
      },
    ),
  ).toMatchObject({ ok: true });
  const before = await request("board.get", {}, { sessionKey });
  expect(before, JSON.stringify(before)).toMatchObject({
    ok: true,
    payload: { widgets: [{ name: "status" }] },
  });
  // Close only writer admission: the production request envelope still owns each read.
  setGatewayRollingAdmission("dashboard-release", true);
  setDatabaseEngineReadOnlyAdmission(true);
  const context = kernel.gatewayRequestContext;
  context.getPendingRollingReleaseId = () => "dashboard-release";
  try {
    const read = await request("board.get", { context }, { sessionKey });
    expect(read).toMatchObject({
      ok: true,
      payload: { revision: 2, widgets: [{ name: "status", contentKind: "html" }] },
    });
    const payload = read.payload;
    if (!isRecord(payload) || !Array.isArray(payload.widgets) || !isRecord(payload.widgets[0])) {
      throw new Error("Missing dashboard widget");
    }
    expect(
      await request(
        "board.data.read",
        { context },
        {
          ticket: payload.widgets[0].viewTicket,
          bindingId: "cron.list",
          params: { includeDisabled: true },
        },
      ),
    ).toMatchObject({ ok: true, payload: { jobs: [{ name: "Preserved automation" }] } });
    expect(await request("cron.get", { context }, { id: jobId })).toMatchObject({
      ok: true,
      payload: { name: "Preserved automation" },
    });
    expect(await request("cron.runs", { context }, { id: jobId })).toMatchObject({
      ok: true,
      payload: { entries: [{ runId: "rolling-read-run" }] },
    });
    const history = await request(
      "cron.history",
      { context },
      { id: jobId, runId: "rolling-read-run" },
    );
    expect(history).toMatchObject({ ok: true });
    expect(JSON.stringify(history.payload)).toContain("Preserved automation transcript");
    for (const method of [
      "cron.list",
      "cron.status",
      "cron.runs",
      "agents.list",
      "users.prefs.get",
    ]) {
      expect(
        await request(method, { context }, method === "cron.runs" ? { scope: "all" } : {}),
        method,
      ).toMatchObject({ ok: true });
    }
    for (const method of [
      "config.patch",
      "board.update",
      "board.widget.put",
      "board.action",
      "cron.run",
      "cron.update",
    ]) {
      expect(await request(method, { context }), method).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          details: {
            reason: "gateway-planned-handoff",
            rollingReleaseId: "dashboard-release",
            handlerNotEntered: true,
          },
        },
      });
    }
  } finally {
    resetGatewayWorkAdmission();
    setDatabaseEngineReadOnlyAdmission(false, () => {});
  }
});
