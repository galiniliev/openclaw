import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  HelloOkSchema,
  PROTOCOL_VERSION,
  ResponseFrameSchema,
  type ResponseFrame,
} from "../../packages/gateway-protocol/src/index.js";
import { loadChatRoute } from "../../ui/src/pages/chat/route-loader.ts";
import { createSessionRouteContext } from "../../ui/src/pages/chat/route-resolution.test-support.ts";
import { createGatewayHostLifecycle } from "../cli/gateway-cli/host-lifecycle.js";
import {
  upsertSessionEntryCore,
  appendTranscriptMessage,
} from "../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import { isMissingPathError } from "../infra/errors.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import {
  resetGatewayWorkAdmission,
  isGatewayWriterRetired,
  runWithGatewayWriterRetirementCleanup,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  ensureCanonicalFactoryGitHubProfile,
  setCanonicalUserProfileRole,
  setCanonicalUserProfileAvatar,
} from "../state/user-profile-writes.js";
import { getGatewayProcessInstanceId } from "./process-instance.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { gatewayKernelLogs } from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";
import { loadSessionEntry } from "./session-utils.js";

// One isolated process owns one irreversible transition; no writer reset follows it.
it("joins native writer custody before the registered reader receipt and retains authenticated reads until expiry", async () => {
  const fixture = await createGatewayMetadataCloseFixture("suspended-reader");
  const closeErrors = vi.spyOn(gatewayKernelLogs.log, "error");
  const sockets = new Set<WebSocket>();
  const principal = "github:microsoft.ghe.com:101";
  const missingPrincipal = "github:microsoft.ghe.com:102";
  const guestPrincipal = "github:microsoft.ghe.com:103";
  const noReadPrincipal = "github:microsoft.ghe.com:104";
  const privatePassword = "reader-fixture-private-control";
  const origin = "https://reader.example.test";
  const scopes: GatewayOperatorRoleDefinition["scopes"] = [
    "operator.admin",
    "operator.read",
    "operator.write",
  ];
  const auth = {
    mode: "trusted-proxy" as const,
    password: privatePassword,
    identityScopes: { [principal]: scopes },
    trustedProxy: {
      userHeader: "x-factory-principal",
      requiredHeaders: ["x-forwarded-proto"],
      allowUsers: [principal, missingPrincipal, guestPrincipal, noReadPrincipal],
      allowLoopback: true,
    },
  };
  fixture.config.gateway = {
    auth,
    roles: {
      default: "guest",
      definitions: {
        admin: { scopes, sessions: { others: "write" }, agents: ["main"] },
        guest: { scopes: ["operator.read"], sessions: { others: "none" }, agents: [] },
        noRead: { scopes: [], sessions: { others: "none" }, agents: [] },
      },
    },
    trustedProxies: ["127.0.0.1"],
    controlUi: { enabled: true, allowedOrigins: [origin], root: fixture.state.path("reader-ui") },
  };
  await fs.mkdir(fixture.state.path("reader-ui"));
  await fs.writeFile(
    fixture.state.path("reader-ui/index.html"),
    "<html>Frozen authenticated reader</html>",
  );
  fixture.state.applyEnv();
  const port = await fixture.reservePort();
  await fixture.state.writeConfig(fixture.config);
  const lock = await acquireGatewayLock({
    allowInTests: true,
    port,
    listenerMode: "supervised",
    supervisor: { kind: "external", name: "reader-fixture" },
  });
  assert(lock?.retireWriter);
  const enteredWriterJoin = createDeferredCore();
  const finishWriterJoin = createDeferredCore();
  const expireReader = vi.fn();
  let server: GatewayServer | undefined;
  let writerSettled = false;
  const host = createGatewayHostLifecycle({
    processOwner: { ownsProcessLifecycle: true, supervisor: "external" },
    isCurrent: () => true,
    isServing: () => true,
    acceptStop: () => {},
    prepareReader: (request, current) => {
      assert(server?.prepareReader);
      return server.prepareReader(request, current);
    },
    retireWriter: async () => {
      enteredWriterJoin.resolve();
      await finishWriterJoin.promise;
      await lock.retireWriter!();
    },
    retireReader: expireReader,
  });
  const headers = {
    origin,
    "x-forwarded-for": "203.0.113.35",
    "x-forwarded-proto": "https",
    "x-factory-principal": principal,
    "x-factory-github-login": "reader-fixture",
    "x-openclaw-scopes": scopes.join(","),
  };
  const open = async (
    authenticated = true,
    controlPassword?: string,
    personalPrincipal = principal,
  ) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers:
        controlPassword !== undefined
          ? {}
          : authenticated
            ? { ...headers, "x-factory-principal": personalPrincipal }
            : { origin },
    });
    sockets.add(socket);
    const pending = new Map<string, ReturnType<typeof createDeferredCore<ResponseFrame>>>();
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(rawDataToString(data));
      if (Value.Check(ResponseFrameSchema, frame)) {
        pending.get(frame.id)?.resolve(frame);
        pending.delete(frame.id);
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const request = (method: string, params: unknown) => {
      const id = randomUUID();
      const result = createDeferredCore<ResponseFrame>();
      pending.set(id, result);
      socket.send(JSON.stringify({ type: "req", id, method, params }));
      return result.promise;
    };
    const hello = await request("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client:
        controlPassword !== undefined
          ? { id: "cli", version: "1.0.0", platform: "test", mode: "cli" }
          : { id: "openclaw-control-ui", version: "1.0.0", platform: "test", mode: "webchat" },
      role: "operator",
      scopes,
      ...(controlPassword !== undefined ? { auth: { password: controlPassword } } : {}),
    });
    return { socket, request, hello };
  };
  try {
    await lock.run(async () => {
      const profile = await ensureCanonicalFactoryGitHubProfile(principal, "Reader fixture");
      await setCanonicalUserProfileRole(profile.id, "admin");
      const avatarBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      expect((await setCanonicalUserProfileAvatar(profile.id, avatarBytes, "image/png")).ok).toBe(
        true,
      );
      const blank = await ensureCanonicalFactoryGitHubProfile(
        "github:microsoft.ghe.com:105",
        "No uploaded image",
      );
      await ensureCanonicalFactoryGitHubProfile(guestPrincipal, "Guest fixture");
      const noRead = await ensureCanonicalFactoryGitHubProfile(noReadPrincipal, "No read access");
      await setCanonicalUserProfileRole(noRead.id, "noRead");
      server = await fixture.start(port, {
        auth,
        hostLifecycle: host.capability,
        controlUiEnabled: true,
      });
      const sessionKey = "agent:main:reader-fixture";
      const sessionId = "reader-accepted-turn";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId, updatedAt: Date.now() },
      );
      const saved = loadSessionEntry(sessionKey, { agentId: "main" });
      await appendTranscriptMessage(
        { agentId: "main", sessionKey, sessionId, storePath: saved.storePath },
        { message: { role: "user", content: "Retain this accepted turn" } },
      );
      const shortSessionId = "12345678-90ab-cdef-1234-567890abcdef";
      const shortSessionKey = `agent:main:dashboard:${shortSessionId}`;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: shortSessionKey },
        {
          sessionId: shortSessionId,
          updatedAt: Date.now(),
          createdActor: { type: "human", source: "profile", id: profile.id },
        },
      );
      const shortSaved = loadSessionEntry(shortSessionKey, { agentId: "main" });
      await appendTranscriptMessage(
        {
          agentId: "main",
          sessionKey: shortSessionKey,
          sessionId: shortSessionId,
          storePath: shortSaved.storePath,
        },
        { message: { role: "user", content: "Accepted cold-route history" } },
      );
      const ambiguousKey = "agent:main:dashboard:12345678-1111-2222-3333-444444444444";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: ambiguousKey },
        { sessionId: "12345678-1111-2222-3333-444444444444", updatedAt: Date.now() },
      );
      const resolveColdRoute = async (connected: Awaited<ReturnType<typeof open>>) => {
        const { context, request: uiRequest } = createSessionRouteContext();
        assert(Value.Check(HelloOkSchema, connected.hello.payload));
        context.gateway.snapshot.hello = connected.hello.payload;
        uiRequest.mockImplementation(async (method, params) => {
          const frame = await connected.request(method, params);
          if (!frame.ok) {
            throw new Error(frame.error?.message ?? "Gateway read failed");
          }
          return frame.payload;
        });
        const resolved = await loadChatRoute(
          context,
          { pathname: `/chat/main/${shortSessionId.replaceAll("-", "")}`, search: "", hash: "" },
          "chat",
          new AbortController().signal,
        );
        expect(uiRequest).toHaveBeenCalledOnce();
        return resolved;
      };
      const client = await open();
      expect(client.hello.ok, JSON.stringify(client.hello)).toBe(true);
      expect(await resolveColdRoute(client)).toMatchObject({
        kind: "session",
        sessionKey: shortSessionKey,
        agentId: "main",
      });
      const accepted = await client.request("chat.history", { sessionKey });
      expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
      expect(JSON.stringify(accepted.payload)).toContain("Retain this accepted turn");
      const prepared = await client.request("gateway.suspend.prepare", {
        requestId: "reader-replacement",
        drain: true,
        terminalPolicy: "terminate",
      });
      expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
      const payload = prepared.payload as { suspensionId: string; status: string };
      expect(payload.status).toBe("ready");
      const privateControl = await open(true, privatePassword);
      expect(privateControl.hello.ok, JSON.stringify(privateControl.hello)).toBe(true);
      const controlStatus = await privateControl.request("gateway.suspend.status", {
        suspensionId: payload.suspensionId,
      });
      expect(controlStatus.ok, JSON.stringify(controlStatus)).toBe(true);
      const controlClient = [...fixture.kernels.get(port)!.clients].find(
        (connected) => connected.connect.client.id === "cli",
      );
      expect(controlClient).toMatchObject({
        internal: { authenticatedOperator: true, operatorRoleActor: { kind: "system" } },
      });
      expect(controlClient?.authenticatedUserProfile).toBeUndefined();
      expect(controlClient?.authenticatedUserId).toBeUndefined();
      for (const path of [
        "/",
        "/readyz",
        "/startupz",
        "/sessions/agent%3Amain%3Areader-fixture/history",
      ]) {
        expect((await fetch(`http://127.0.0.1:${port}${path}`, { headers })).status).toBe(200);
      }
      const request = {
        suspensionId: payload.suspensionId,
        target: { pid: process.pid, processInstanceId: getGatewayProcessInstanceId() },
        expiresAtMs: Date.now() + 60_000,
      };
      const wrongTarget = await client.request("gateway.suspend.reader", {
        ...request,
        target: { ...request.target, processInstanceId: "wrong-instance" },
      });
      expect(wrongTarget.ok).toBe(false);
      const wrongLease = await client.request("gateway.suspend.reader", {
        ...request,
        suspensionId: "wrong-lease",
      });
      expect(wrongLease.ok).toBe(false);
      let delivered = false;
      const nativeClient = [...fixture.kernels.get(port)!.clients][0]!;
      const before = {
        profile: nativeClient.authenticatedUserProfile?.profileId,
        canonical: nativeClient.preparedSessionProfile?.profileId,
        user: nativeClient.authenticatedUserId,
        role: nativeClient.connect.role,
        scopes: [...(nativeClient.connect.scopes ?? [])],
      };
      const retirement = client.request("gateway.suspend.reader", request).then((receipt) => {
        delivered = true;
        return receipt;
      });
      await Promise.race([
        enteredWriterJoin.promise,
        retirement.then((receipt) => {
          throw new Error(
            `Reader returned before host join: ${JSON.stringify({ receipt, before, after: { profile: nativeClient.authenticatedUserProfile?.profileId, canonical: nativeClient.preparedSessionProfile?.profileId, user: nativeClient.authenticatedUserId, role: nativeClient.connect.role, scopes: nativeClient.connect.scopes, invalidated: nativeClient.invalidated } })}`,
          );
        }),
      ]);
      expect(delivered).toBe(false);
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      const joining = await open();
      expect(joining.hello.ok, JSON.stringify(joining.hello)).toBe(true);
      expect(
        (await joining.request("chat.history", { sessionKey: "agent:main:reader-fixture" })).ok,
      ).toBe(true);
      for (const path of [
        "/",
        "/readyz",
        "/startupz",
        "/sessions/agent%3Amain%3Areader-fixture/history",
      ]) {
        expect((await fetch(`http://127.0.0.1:${port}${path}`, { headers })).status).toBe(200);
      }
      expect(
        (await fetch(`http://127.0.0.1:${port}/tools/invoke`, { method: "POST", headers })).status,
      ).toBe(503);
      expect(delivered).toBe(false);
      const deniedUi = await fetch(`http://127.0.0.1:${port}/`, { headers: { origin } });
      expect(deniedUi.status).toBe(401);
      finishWriterJoin.resolve();
      const receipt = await retirement;
      expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
      writerSettled = true;
      expect(receipt.payload).toMatchObject({
        version: 1,
        status: "reader-ready",
        ...request.target,
        expiresAtMs: request.expiresAtMs,
      });
      const frozen = await fs.readFile(resolveOpenClawStateSqlitePath());
      const readWal = (path: string) =>
        fs.readFile(`${path}-wal`).catch((error: unknown) => {
          if (isMissingPathError(error)) {
            return null;
          }
          throw error;
        });
      const frozenWal = await readWal(resolveOpenClawStateSqlitePath());
      const readAgentBytes = async () => {
        const path = resolveOpenClawAgentSqlitePath({ agentId: "main" });
        return {
          database: await fs.readFile(path),
          wal: await readWal(path),
        };
      };
      const frozenAgent = await readAgentBytes();
      const frozenControl = await open(true, privatePassword);
      expect(frozenControl.hello.ok, JSON.stringify(frozenControl.hello)).toBe(true);
      const frozenStatus = await frozenControl.request("gateway.suspend.status", {
        suspensionId: payload.suspensionId,
      });
      expect(frozenStatus.ok, JSON.stringify(frozenStatus)).toBe(true);
      expect((await frozenControl.request("config.patch", { raw: "{}" })).ok).toBe(false);
      expect(
        (
          await frozenControl.request("users.prefs.set", {
            entries: { "git.coauthor.enabled": true },
          })
        ).ok,
      ).toBe(false);
      expect((await open(true, "incorrect-private-control")).hello.ok).toBe(false);
      const missing = await open(true, undefined, missingPrincipal);
      expect(missing.hello.ok).toBe(false);
      expect(missing.hello.error?.details).toMatchObject({
        code: "AUTHENTICATED_PROFILE_UNAVAILABLE",
        method: "connect",
      });
      const guest = await open(true, undefined, guestPrincipal);
      expect(guest.hello.ok, JSON.stringify(guest.hello)).toBe(true);
      expect((await guest.request("chat.history", { sessionKey })).ok).toBe(false);
      const reconnected = await open();
      expect(reconnected.hello.ok, JSON.stringify(reconnected.hello)).toBe(true);
      expect(await resolveColdRoute(reconnected)).toMatchObject({
        kind: "session",
        sessionKey: shortSessionKey,
        agentId: "main",
      });
      const guestResolution = await guest.request("sessions.resolve", {
        shortId: "12345678",
        agentId: "main",
        allowMissing: true,
      });
      expect(guestResolution.ok).toBe(false);
      expect(guestResolution.error?.code).toBe("FORBIDDEN");
      const ambiguous = await reconnected.request("sessions.resolve", {
        shortId: "12345678",
        agentId: "main",
        allowMissing: true,
      });
      expect(ambiguous.ok).toBe(true);
      expect(ambiguous.payload).toMatchObject({
        ok: false,
        candidates: expect.arrayContaining([
          expect.objectContaining({ key: shortSessionKey }),
          expect.objectContaining({ key: ambiguousKey }),
        ]),
      });
      const coldHistory = await reconnected.request("chat.history", {
        sessionKey: shortSessionKey,
      });
      expect(coldHistory.ok).toBe(true);
      expect(JSON.stringify(coldHistory.payload)).toContain("Accepted cold-route history");
      expect(
        (
          await reconnected.request("sessions.resolve", {
            shortId: "ffffffff",
            agentId: "main",
            allowMissing: true,
          })
        ).payload,
      ).toEqual({ ok: false });
      const retained = await reconnected.request("chat.history", { sessionKey });
      expect(retained.ok, JSON.stringify(retained)).toBe(true);
      expect(JSON.stringify(retained.payload)).toContain("Retain this accepted turn");
      expect((await reconnected.request("sessions.list", {})).ok).toBe(true);
      const avatarUrl = `http://127.0.0.1:${port}/api/users/${profile.id}/avatar`;
      const image = await fetch(avatarUrl, { headers });
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await image.arrayBuffer())).toEqual(avatarBytes);
      const head = await fetch(avatarUrl, { method: "HEAD", headers });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(
        (
          await fetch(avatarUrl, {
            headers: { ...headers, "if-none-match": image.headers.get("etag")! },
          })
        ).status,
      ).toBe(304);
      expect((await fetch(avatarUrl, { headers: { origin } })).status).toBe(401);
      const guestAvatar = await fetch(avatarUrl, {
        headers: { ...headers, "x-factory-principal": guestPrincipal },
      });
      expect(guestAvatar.status).toBe(200);
      expect(Buffer.from(await guestAvatar.arrayBuffer())).toEqual(avatarBytes);
      expect(
        (
          await fetch(avatarUrl, {
            headers: { ...headers, "x-factory-principal": noReadPrincipal },
          })
        ).status,
      ).toBe(403);
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/users/${blank.id}/avatar`, { headers })).status,
      ).toBe(404);
      expect(
        (
          await reconnected.request("chat.send", {
            sessionKey: "agent:main:reader-fixture",
            message: "must not execute",
            idempotencyKey: "reader-denied",
          })
        ).ok,
      ).toBe(false);
      expect((await open(false)).hello.ok).toBe(false);
      for (const path of ["/healthz", "/readyz", "/startupz"]) {
        expect((await fetch(`http://127.0.0.1:${port}${path}`, { headers })).status).toBe(200);
      }
      expect(
        (await fetch(`http://127.0.0.1:${port}/tools/invoke`, { method: "POST", headers })).status,
      ).toBe(503);
      expect(await fs.readFile(resolveOpenClawStateSqlitePath())).toEqual(frozen);
      expect(await readWal(resolveOpenClawStateSqlitePath())).toEqual(frozenWal);
      expect(await readAgentBytes()).toEqual(frozenAgent);
      vi.useFakeTimers({ toFake: ["Date", "performance"] });
      vi.setSystemTime(request.expiresAtMs);
      expect((await fetch(avatarUrl, { headers })).status).toBe(503);
      await expect(resolveColdRoute(reconnected)).rejects.toThrow();
      expect(
        (await reconnected.request("chat.history", { sessionKey: "agent:main:reader-fixture" })).ok,
      ).toBe(false);
      expect((await fetch(`http://127.0.0.1:${port}/startupz`, { headers })).status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${port}/readyz`, { headers })).status).toBe(503);
      vi.setSystemTime(request.expiresAtMs - 30_000);
      expect(
        (await reconnected.request("chat.history", { sessionKey: "agent:main:reader-fixture" })).ok,
      ).toBe(false);
      expect(() => resetGatewayWorkAdmission()).toThrow("irreversible reader");
      vi.useRealTimers();
    });
  } finally {
    vi.useRealTimers();
    finishWriterJoin.resolve();
    for (const socket of sockets) {
      socket.terminate();
    }
    await server?.close();
    if (writerSettled) {
      await expect(fetch(`http://127.0.0.1:${port}/startupz`, { headers })).rejects.toThrow();
    }
    await host.retire();
    if (isGatewayWriterRetired() && !writerSettled) {
      await runWithGatewayWriterRetirementCleanup(() => lock.release());
    } else {
      await lock.release();
    }
    await fixture.cleanup();
    expect(
      closeErrors.mock.calls.filter(([message]) =>
        message.includes("websocket close cleanup failed"),
      ),
    ).toEqual([]);
    closeErrors.mockRestore();
  }
});
