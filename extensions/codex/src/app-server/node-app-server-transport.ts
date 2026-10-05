/** Gateway-side stdio facade over one authorized worker app-server duplex. */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { prepareWorkerGitHubBindingGrant } from "openclaw/plugin-sdk/github-worker-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { resolveCodexWorkerAppServerCommand } from "../node-app-server-command.js";
import { CodexAppServerClient } from "./client.js";
import { readCodexPlacementWorkspaceIdentity } from "./sandbox-exec-server.js";
import { trackIsolatedCodexAppServerClient } from "./shared-client.js";
import type { CodexAppServerTransport } from "./transport.js";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
type DuplexCloseOrigin =
  | "remote_resolved"
  | "remote_rejected"
  | "local_stdin_final"
  | "local_response_too_large"
  | "local_kill"
  | "local_abort";

function duplexRejectionCode(error: unknown): string {
  const message = formatErrorMessage(error);
  if (message.includes("Codex node app-server diagnostic exceeded 4 KiB")) {
    return "node_stderr_limit";
  }
  if (message.includes("Node command completed without opening a ready duplex invocation.")) {
    return "duplex_not_ready";
  }
  return "unclassified";
}

export async function startWorkerCodexAppServerClient(params: {
  runtime: PluginRuntime;
  sandbox: SandboxContext;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<CodexAppServerClient> {
  const { sandbox, runtime, signal, assertCurrent } = params;
  if (
    !sandbox.enabled ||
    !("placementNodeId" in sandbox) ||
    typeof sandbox.placementNodeId !== "string"
  ) {
    throw new Error("Codex worker app-server requires an exact managed placement node");
  }
  const placement = readCodexPlacementWorkspaceIdentity(sandbox);
  const { agentId, ...workspace } = placement;
  assertCurrent();
  signal.throwIfAborted();
  const grant = agentId
    ? await prepareWorkerGitHubBindingGrant({
        sessionId: workspace.sessionId,
        sessionKey: workspace.sessionKey,
        agentId,
        signal,
        assertCurrent: () => {
          signal.throwIfAborted();
          assertCurrent();
          return true;
        },
      })
    : undefined;
  let acquiredChannel: Awaited<ReturnType<PluginRuntime["nodes"]["openDuplex"]>> | undefined;
  try {
    assertCurrent();
    grant?.assertCurrent?.();
    acquiredChannel = await runtime.nodes.openDuplex({
      nodeId: sandbox.placementNodeId,
      command: resolveCodexWorkerAppServerCommand(process.env, true),
      params: {
        placement: { cwd: sandbox.containerWorkdir, ...workspace },
        authorization: "session-full",
        ...(grant ? { github: grant.binding } : {}),
      },
      sessionKey: sandbox.sessionKey,
      timeoutMs: 0,
      maxMessageBytes: MAX_FRAME_BYTES,
      maxOutstandingDeliveryBytes: MAX_FRAME_BYTES + 2 * 1024 * 1024,
      signal: grant?.signal ? AbortSignal.any([signal, grant.signal]) : signal,
      assertCurrent: () => {
        assertCurrent();
        grant?.assertCurrent?.();
      },
    });
    assertCurrent();
    grant?.assertCurrent?.();
  } catch (error) {
    try {
      acquiredChannel?.close();
    } finally {
      await grant?.revoke();
    }
    throw error;
  }
  const channel = acquiredChannel;
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exitCode: number | null = null;
  const signalCode: string | null = null;
  let closed = false;
  const openedAtMs = Date.now();
  let pending = Buffer.alloc(0);
  const close = (origin: DuplexCloseOrigin, error?: unknown) => {
    if (closed) {
      return;
    }
    closed = true;
    const syntheticExitCode = error ? 1 : 0;
    const observation = {
      nodeId: sandbox.placementNodeId,
      environmentId: workspace.environmentId,
      sessionId: workspace.sessionId,
      origin,
      syntheticExitCode,
      openedAtMs,
      lifetimeMs: Date.now() - openedAtMs,
      ...(origin === "remote_rejected" ? { errorCode: duplexRejectionCode(error) } : {}),
    };
    if (origin === "remote_rejected") {
      embeddedAgentLog.warn("worker_codex_duplex_closed", observation);
    } else {
      embeddedAgentLog.info("worker_codex_duplex_closed", observation);
    }
    channel.close();
    stdout.end();
    stderr.end();
    exitCode = syntheticExitCode;
    events.emit("exit", exitCode, signalCode);
    void grant?.revoke();
  };
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      if (closed) {
        callback(new Error("Codex worker app-server channel is closed"));
        return;
      }
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      if (pending.length > MAX_FRAME_BYTES + 1) {
        callback(new Error("Codex worker app-server request exceeds 64 MiB"));
        return;
      }
      const messages: Buffer[] = [];
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const frame = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        messages.push(frame);
      }
      void (async () => {
        for (const message of messages) {
          await channel.send(message);
        }
      })().then(
        () => callback(),
        (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
      );
    },
    final(callback) {
      close("local_stdin_final");
      callback();
    },
  });
  const unsubscribe = channel.onMessage(async (message) => {
    if (closed) {
      return;
    }
    if (message.byteLength > MAX_FRAME_BYTES) {
      close(
        "local_response_too_large",
        new Error("Codex worker app-server response exceeds 64 MiB"),
      );
      return;
    }
    if (!stdout.write(Buffer.concat([Buffer.from(message), Buffer.from("\n")]))) {
      await new Promise<void>((resolve) => {
        stdout.once("drain", resolve);
      });
    }
  });
  void channel.closed.then(
    () => close("remote_resolved"),
    (error: unknown) => close("remote_rejected", error),
  );
  const transport: CodexAppServerTransport = {
    stdin,
    stdout,
    stderr,
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    kill: () => {
      close("local_kill", new Error("Codex worker app-server stopped"));
      return true;
    },
    once: (event, listener) => events.once(event, listener),
    off: (event, listener) => events.off(event, listener),
  };
  const client = CodexAppServerClient.fromTransport(transport);
  trackIsolatedCodexAppServerClient(client);
  client.addTransportExitHandler(() => unsubscribe());
  if (signal.aborted) {
    close("local_abort", signal.reason);
  }
  try {
    await client.initialize();
    assertCurrent();
    return client;
  } catch (error) {
    await client.closeAndWait();
    throw error;
  }
}
