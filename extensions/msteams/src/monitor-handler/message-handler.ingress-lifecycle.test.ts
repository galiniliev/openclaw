import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import {
  createChannelIngressMonitor,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "openclaw/plugin-sdk/channel-outbound";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMockOpenAiResponsesProvider } from "../../../../src/gateway/test-openai-responses-model.js";
import { createPluginRuntime } from "../../../../src/plugins/runtime/index.js";
import { withOpenClawTestState } from "../../../../src/test-utils/openclaw-test-state.js";
import { writeOpenAiResponsesText } from "../../../../test/helpers/openai-responses-sse.js";
import type { OpenClawConfig } from "../../runtime-api.js";
import { createMSTeamsIngress } from "../msteams-ingress.js";
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import { setMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import { buildChannelActivity, createMessageHandlerDeps } from "./message-handler.test-support.js";

const runtimeApiMockState = getRuntimeApiMockState();

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return { ...actual, createChannelIngressMonitor: vi.fn(actual.createChannelIngressMonitor) };
});

function createLifecycle(): MSTeamsIngressLifecycle & {
  onAdopted: ReturnType<typeof vi.fn>;
  onAbandoned: ReturnType<typeof vi.fn>;
} {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onAbandoned: vi.fn(async () => {}),
    onDeferred: () => {},
    onAdoptionFinalizing: () => {},
  };
}

function context(activity: MSTeamsTurnContext["activity"]): MSTeamsTurnContext {
  return {
    activity,
    sendActivity: vi.fn(async () => ({ id: "sent" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => ({ id: "updated" })),
    deleteActivity: vi.fn(async () => {}),
  };
}

function directActivity(id: string, text: string): MSTeamsTurnContext["activity"] {
  return {
    ...buildChannelActivity({
      id,
      text,
      conversation: { id: "dm-conversation", conversationType: "personal" },
      channelData: {},
      entities: [],
    }),
  } as MSTeamsTurnContext["activity"];
}

function createHandler(cfg: OpenClawConfig, createDebouncer = createInboundDebouncer) {
  const { deps } = createMessageHandlerDeps(cfg, {
    createInboundDebouncer: createDebouncer,
    resolveInboundDebounceMs: vi.fn(() => 40),
  });
  return createMSTeamsMessageHandler(deps);
}

async function withIntegratedIngress(
  cfg: OpenClawConfig,
  options: Parameters<typeof createMessageHandlerDeps>[1],
  run: (params: {
    accept: (activity: MSTeamsTurnContext["activity"]) => Promise<void>;
    drain: (beforeFlush?: () => void | Promise<void>) => Promise<void>;
    dispatchMock: typeof runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher;
  }) => Promise<void>,
) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-proof-"));
  const stateDir = await fs.realpath(created);
  type Queue = NonNullable<Parameters<typeof createMSTeamsIngress>[0]["queue"]>;
  type Payload = Parameters<Queue["enqueue"]>[1];
  const queue = createChannelIngressQueueForTests<Payload>({
    channelId: "msteams",
    accountId: "test-app",
    stateDir,
  });
  const dispatchMock = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher;
  let capturedDrain: (() => Promise<void>) | undefined;
  let capturedFlushKey: ((key: string) => Promise<void>) | undefined;
  let acceptedCount = 0;
  let debouncedEntryCount = 0;
  const debounceKeys = new Set<string>();
  const createDebouncer: typeof createInboundDebouncer = (debouncerOptions) => {
    const debouncer = createInboundDebouncer({
      ...debouncerOptions,
      buildKey: (item) => {
        const key = debouncerOptions.buildKey(item);
        if (key) {
          debounceKeys.add(key);
        }
        return key;
      },
    });
    capturedDrain = debouncer.drain;
    capturedFlushKey = debouncer.flushKey;
    const enqueue: typeof debouncer.enqueue = async (item) => {
      await debouncer.enqueue(item);
      debouncedEntryCount += 1;
    };
    return { ...debouncer, enqueue };
  };
  const { deps } = createMessageHandlerDeps(cfg, {
    ...options,
    createInboundDebouncer: createDebouncer,
    resolveInboundDebounceMs: vi.fn(() => 60_000),
  });
  const handler = createMSTeamsMessageHandler(deps);
  const ingress = createMSTeamsIngress({
    accountId: "test-app",
    queue,
    runtime: { error: vi.fn(), log: vi.fn() },
    dispatch: async (activity, lifecycle) => await handler(context(activity), lifecycle),
  });
  const monitorResult = vi.mocked(createChannelIngressMonitor).mock.results.at(-1);
  if (monitorResult?.type !== "return" || !capturedDrain || !capturedFlushKey) {
    throw new Error("Expected the Microsoft Teams ingress and debounce owners");
  }
  const monitor = monitorResult.value;
  const drainDebounce = capturedDrain;
  const flushDebounceKey = capturedFlushKey;
  const drain = async (beforeFlush?: () => void | Promise<void>) => {
    ingress.start();
    await monitor.waitForIdle();
    expect(debouncedEntryCount).toBe(acceptedCount);
    await beforeFlush?.();
    for (const key of debounceKeys) {
      await flushDebounceKey(key);
    }
    await drainDebounce();
  };
  try {
    await run({
      accept: async (activity) => {
        await ingress.accept(activity);
        acceptedCount += 1;
      },
      drain,
      dispatchMock,
    });
  } finally {
    await monitor.pause();
    await monitor.waitForIdle();
    await drainDebounce();
    await ingress.stop();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function withRealAgentInputIngress(
  cfg: OpenClawConfig,
  run: (params: {
    accept: (activity: MSTeamsTurnContext["activity"]) => Promise<void>;
    drain: (beforeFlush?: () => void | Promise<void>) => Promise<void>;
    modelRequests: unknown[];
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    {
      label: "msteams-final-agent-input",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_SKIP_PROVIDERS: undefined },
    },
    async (state) => {
      const modelRequests: unknown[] = [];
      const server = createServer((request, response) => {
        void (async () => {
          if (request.method === "GET" && request.url === "/v1/models") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ data: [{ id: "msteams-proof", object: "model" }] }));
            return;
          }
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          modelRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
          writeOpenAiResponsesText(response, {
            text: "Teams proof observed.",
            responseId: `response_msteams_${modelRequests.length}`,
            messageId: `message_msteams_${modelRequests.length}`,
          });
        })().catch((error: unknown) => {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      });
      let stopIngress: (() => Promise<void>) | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Microsoft Teams proof provider did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${address.port}/v1`,
          "msteams-proof",
        );
        const proofCfg = {
          ...cfg,
          plugins: { enabled: false },
          agents: {
            entries: { main: { workspace: state.workspaceDir } },
            defaults: {
              model: { primary: provider.modelRef, fallbacks: [] },
              models: { [provider.modelRef]: { agentRuntime: { id: "openclaw" } } },
              skills: [],
              skipBootstrap: true,
              heartbeat: { every: "0m" },
            },
          },
          tools: {
            allow: [],
            codeMode: { enabled: false },
            toolSearch: false,
          },
          models: {
            mode: "replace",
            providers: {
              [provider.providerId]: {
                ...provider.config,
                request: { allowPrivateNetwork: true },
              },
            },
          },
        } satisfies OpenClawConfig;
        await state.writeConfig(proofCfg);
        const runtime = createPluginRuntime();
        let capturedDrain: (() => Promise<void>) | undefined;
        let capturedFlushKey: ((key: string) => Promise<void>) | undefined;
        let acceptedCount = 0;
        let debouncedEntryCount = 0;
        const debounceKeys = new Set<string>();
        runtime.channel.debounce.createInboundDebouncer = (debouncerOptions) => {
          const debouncer = createInboundDebouncer({
            ...debouncerOptions,
            buildKey: (item) => {
              const key = debouncerOptions.buildKey(item);
              if (key) {
                debounceKeys.add(key);
              }
              return key;
            },
          });
          capturedDrain = debouncer.drain;
          capturedFlushKey = debouncer.flushKey;
          const enqueue: typeof debouncer.enqueue = async (item) => {
            await debouncer.enqueue(item);
            debouncedEntryCount += 1;
          };
          return { ...debouncer, enqueue };
        };
        runtime.channel.debounce.resolveInboundDebounceMs = vi.fn(() => 60_000);
        runtime.channel.routing.resolveAgentRoute = vi.fn(({ peer }) => ({
          sessionKey: `agent:main:msteams:${peer.kind}:${peer.id}`,
          agentId: "main",
          accountId: "default",
          mainSessionKey: "agent:main:main",
          lastRoutePolicy: "session" as const,
          matchedBy: "default" as const,
        }));
        runtime.channel.pairing.readAllowFromStore = vi.fn(async () => []);
        runtime.channel.pairing.upsertPairingRequest = vi.fn(async () => null);
        setMSTeamsRuntime(runtime);

        const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-agent-"));
        const stateDir = await fs.realpath(created);
        type Queue = NonNullable<Parameters<typeof createMSTeamsIngress>[0]["queue"]>;
        type Payload = Parameters<Queue["enqueue"]>[1];
        const queue = createChannelIngressQueueForTests<Payload>({
          channelId: "msteams",
          accountId: "test-app",
          stateDir,
        });
        const conversationStore = {
          get: vi.fn<MSTeamsMessageHandlerDeps["conversationStore"]["get"]>(async () => null),
          upsert: vi.fn(async () => undefined),
          list: vi.fn(async () => []),
          remove: vi.fn(async () => false),
          findPreferredDmByUserId: vi.fn(async () => null),
        } satisfies MSTeamsMessageHandlerDeps["conversationStore"];
        const deps: MSTeamsMessageHandlerDeps = {
          cfg: proofCfg,
          runtime: { error: vi.fn() },
          appId: "test-app",
          app: {} as MSTeamsMessageHandlerDeps["app"],
          tokenProvider: {
            getAccessToken: vi.fn(async () => "token"),
          },
          textLimit: 4000,
          mediaMaxBytes: 1024 * 1024,
          conversationStore,
          pollStore: {
            recordVote: vi.fn(async () => null),
          } as unknown as MSTeamsMessageHandlerDeps["pollStore"],
          log: {
            info: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
          } as unknown as MSTeamsMessageHandlerDeps["log"],
        };
        const handler = createMSTeamsMessageHandler(deps);
        const ingress = createMSTeamsIngress({
          accountId: "test-app",
          queue,
          runtime: { error: vi.fn(), log: vi.fn() },
          dispatch: async (activity, lifecycle) => await handler(context(activity), lifecycle),
        });
        const monitorResult = vi.mocked(createChannelIngressMonitor).mock.results.at(-1);
        if (monitorResult?.type !== "return" || !capturedDrain || !capturedFlushKey) {
          throw new Error("Expected the Microsoft Teams real-agent ingress and debounce owners");
        }
        const monitor = monitorResult.value;
        const drainDebounce = capturedDrain;
        const flushDebounceKey = capturedFlushKey;
        const drain = async (beforeFlush?: () => void | Promise<void>) => {
          ingress.start();
          await monitor.waitForIdle();
          expect(debouncedEntryCount).toBe(acceptedCount);
          await beforeFlush?.();
          for (const key of debounceKeys) {
            await flushDebounceKey(key);
          }
          await drainDebounce();
        };
        stopIngress = async () => {
          await monitor.pause();
          await monitor.waitForIdle();
          await drainDebounce();
          await ingress.stop();
          await closeOpenClawStateDatabaseAsync();
          closeOpenClawStateDatabaseForTest();
          await fs.rm(stateDir, { recursive: true, force: true });
        };
        await run({
          accept: async (activity) => {
            await ingress.accept(activity);
            acceptedCount += 1;
          },
          drain,
          modelRequests,
        });
      } finally {
        await stopIngress?.();
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  );
}

function groupActivity(
  id: string,
  text: string,
  entities: MSTeamsTurnContext["activity"]["entities"] = [],
): MSTeamsTurnContext["activity"] {
  return {
    ...buildChannelActivity({
      id,
      text,
      from: { id: "bob-id", aadObjectId: "bob-aad", name: "Bob" },
      conversation: { id: "19:proof-group@thread.v2", conversationType: "groupChat" },
      channelData: {},
      entities,
    }),
  } as MSTeamsTurnContext["activity"];
}

describe("Microsoft Teams drain claim ownership", () => {
  beforeEach(() => {
    runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
  });

  it("fans merged-flush adoption to every constituent claim", async () => {
    const handler = createHandler({
      messages: { inbound: { debounceMs: 40 } },
      channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
    } as OpenClawConfig);
    const first = createLifecycle();
    const second = createLifecycle();

    const results = [
      await handler(context(directActivity("activity-first", "part one")), first),
      await handler(context(directActivity("activity-second", "part two")), second),
    ];

    expect(results).toEqual([{ kind: "deferred" }, { kind: "deferred" }]);
    await vi.waitFor(
      () => {
        expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(
          1,
        );
        expect(first.onAdopted).toHaveBeenCalledTimes(1);
        expect(second.onAdopted).toHaveBeenCalledTimes(1);
      },
      { timeout: 5_000 },
    );
    const dispatchParams = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mock
      .calls[0]?.[0] as { ctx?: { BodyForAgent?: string } } | undefined;
    expect(dispatchParams?.ctx?.BodyForAgent).toContain("part one\npart two");
    expect(first.onAbandoned).not.toHaveBeenCalled();
    expect(second.onAbandoned).not.toHaveBeenCalled();
  });

  it("dispatches HTML-only text through the immediate debounce flush without double stripping", async () => {
    const handler = createHandler({
      channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    const lifecycle = createLifecycle();

    await handler(
      context({
        ...directActivity("activity-html", ""),
        attachments: [
          {
            contentType: "TEXT/HTML",
            content: "<at>Bot</at><p>Use x &lt; 5 &copy;; literal &lt;at&gt;Alice&lt;/at&gt;</p>",
          },
        ],
      }),
      lifecycle,
    );

    expect(
      runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          BodyForAgent: expect.stringContaining("Use x < 5 ©; literal <at>Alice</at>"),
        }),
      }),
    );
    expect(
      runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0].replyOptions
        ?.turnAdoptionLifecycle,
    ).toMatchObject({ admission: "exclusive" });
    expect(lifecycle.onAdopted).toHaveBeenCalledTimes(1);
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
  });

  it("proves allowed quotedReply context through queued ingress and debounce", async () => {
    await withIntegratedIngress(
      {
        messages: { inbound: { debounceMs: 40 } },
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["bob-aad", "alice-aad"],
            contextVisibility: "allowlist",
            requireMention: false,
          },
        },
      } as OpenClawConfig,
      {},
      async ({ accept, drain, dispatchMock }) => {
        await accept(
          groupActivity("activity-quote-allowed", "<at>Bot</at> ask <at>Alice</at>", [
            { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
            {
              type: "mention",
              text: "<at>Alice</at>",
              mentioned: { id: "alice-aad", name: "Alice" },
            },
            {
              type: "quotedReply",
              quotedReply: {
                senderId: "alice-aad",
                senderName: "Alice",
                preview: "Allowed quoted preview",
              },
            },
          ]),
        );
        await drain();

        expect(dispatchMock).toHaveBeenCalledTimes(1);
        const ctx = dispatchMock.mock.calls[0]?.[0].ctx;
        expect(ctx).toMatchObject({
          BodyForAgent: "ask @Alice",
          ReplyToBody: "Allowed quoted preview",
          ReplyToSender: "Alice",
        });
      },
    );
  });

  it("omits blocked quotedReply context through queued ingress and debounce", async () => {
    await withIntegratedIngress(
      {
        messages: { inbound: { debounceMs: 40 } },
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["bob-aad", "alice-aad"],
            contextVisibility: "allowlist",
            requireMention: false,
          },
        },
      } as OpenClawConfig,
      {},
      async ({ accept, drain, dispatchMock }) => {
        await accept(
          groupActivity("activity-quote-blocked", "<at>Bot</at> ask <at>Mallory</at>", [
            { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
            {
              type: "mention",
              text: "<at>Mallory</at>",
              mentioned: { id: "mallory-aad", name: "Mallory" },
            },
            {
              type: "quotedReply",
              quotedReply: {
                senderId: "mallory-aad",
                senderName: "Mallory",
                preview: "Blocked quoted preview",
              },
            },
          ]),
        );
        await drain();

        expect(dispatchMock).toHaveBeenCalledTimes(1);
        const ctx = dispatchMock.mock.calls[0]?.[0].ctx;
        expect(ctx).toMatchObject({ BodyForAgent: "ask @Mallory" });
        expect(ctx?.ReplyToBody).toBeUndefined();
        expect(ctx?.ReplyToSender).toBeUndefined();
      },
    );
  });

  it("ignores mismatched quotedReply entity and attachment body through queued ingress", async () => {
    await withIntegratedIngress(
      {
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["bob-aad", "alice-aad"],
            contextVisibility: "allowlist",
            requireMention: false,
          },
        },
      } as OpenClawConfig,
      {},
      async ({ accept, drain, dispatchMock }) => {
        await accept({
          ...groupActivity("activity-quote-mismatched", "<at>Bot</at> ask <at>Alice</at>", [
            { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
            {
              type: "mention",
              text: "<at>Alice</at>",
              mentioned: { id: "alice-aad", name: "Alice" },
            },
            {
              type: "quotedReply",
              quotedReply: {
                messageId: "quote-a",
                senderId: "alice-aad",
                senderName: "Alice",
              },
            },
          ]),
          attachments: [
            {
              contentType: "text/html",
              content:
                '<blockquote itemtype="http://schema.skype.com/Reply" itemid="quote-b">' +
                '<strong itemprop="mri">Mallory</strong>' +
                '<p itemprop="copy">Blocked attachment body</p></blockquote>',
            },
          ],
        });
        await drain();

        expect(dispatchMock).toHaveBeenCalledTimes(1);
        const ctx = dispatchMock.mock.calls[0]?.[0].ctx;
        expect(ctx).toMatchObject({ BodyForAgent: "ask @Alice" });
        expect(ctx?.ReplyToBody).toBeUndefined();
        expect(ctx?.ReplyToSender).toBeUndefined();
      },
    );
  });

  it("rechecks quote sender permission before a queued ingress debounce flush", async () => {
    const groupAllowFrom = ["bob-aad", "alice-aad"];
    await withIntegratedIngress(
      {
        messages: { inbound: { debounceMs: 40 } },
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom,
            contextVisibility: "allowlist",
            requireMention: false,
          },
        },
      } as OpenClawConfig,
      {},
      async ({ accept, drain, dispatchMock }) => {
        await accept(
          groupActivity("activity-quote-revoked", "<at>Bot</at> ask <at>Alice</at>", [
            { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
            {
              type: "mention",
              text: "<at>Alice</at>",
              mentioned: { id: "alice-aad", name: "Alice" },
            },
            {
              type: "quotedReply",
              quotedReply: {
                senderId: "alice-aad",
                senderName: "Alice",
                preview: "Revoked quoted preview",
              },
            },
          ]),
        );
        await drain(() => {
          groupAllowFrom.splice(0, groupAllowFrom.length, "bob-aad");
        });

        expect(dispatchMock).toHaveBeenCalledTimes(1);
        const ctx = dispatchMock.mock.calls[0]?.[0].ctx;
        expect(ctx).toMatchObject({ BodyForAgent: "ask @Alice" });
        expect(ctx?.ReplyToBody).toBeUndefined();
        expect(ctx?.ReplyToSender).toBeUndefined();
      },
    );
  });

  it("proves matching quotedReply context through a multi-entry debounce batch", async () => {
    const dispatchMock = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher;
    let capturedDrain: (() => Promise<void>) | undefined;
    let capturedFlushKey: ((key: string) => Promise<void>) | undefined;
    const debounceKeys = new Set<string>();
    const createDebouncer: typeof createInboundDebouncer = (debouncerOptions) => {
      const debouncer = createInboundDebouncer({
        ...debouncerOptions,
        buildKey: (item) => {
          const key = debouncerOptions.buildKey(item);
          if (key) {
            debounceKeys.add(key);
          }
          return key;
        },
      });
      capturedDrain = debouncer.drain;
      capturedFlushKey = debouncer.flushKey;
      return debouncer;
    };
    const handler = createHandler(
      {
        messages: { inbound: { debounceMs: 40 } },
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["bob-aad", "alice-aad"],
            contextVisibility: "allowlist",
            requireMention: false,
          },
        },
      } as OpenClawConfig,
      createDebouncer,
    );
    const first = createLifecycle();
    const second = createLifecycle();
    const quoteEntity = {
      type: "quotedReply",
      quotedReply: {
        senderId: "alice-aad",
        senderName: "Alice",
        preview: "Batched quoted preview",
      },
    };

    expect(
      await handler(
        context(
          groupActivity("activity-quote-batch-1", "<at>Bot</at> first question", [
            { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
            quoteEntity,
          ]),
        ),
        first,
      ),
    ).toEqual({ kind: "deferred" });
    expect(
      await handler(
        context(
          groupActivity("activity-quote-batch-2", "<at>Bot</at> second question", [
            { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
            quoteEntity,
          ]),
        ),
        second,
      ),
    ).toEqual({ kind: "deferred" });

    if (!capturedDrain || !capturedFlushKey) {
      throw new Error("Expected the Microsoft Teams debounce owner");
    }
    for (const key of debounceKeys) {
      await capturedFlushKey(key);
    }
    await capturedDrain();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const ctx = dispatchMock.mock.calls[0]?.[0].ctx;
    expect(ctx).toMatchObject({
      BodyForAgent: "first question\nsecond question",
      ReplyToBody: "Batched quoted preview",
      ReplyToSender: "Alice",
    });
    expect(first.onAdopted).toHaveBeenCalledTimes(1);
    expect(second.onAdopted).toHaveBeenCalledTimes(1);
    expect(first.onAbandoned).not.toHaveBeenCalled();
    expect(second.onAbandoned).not.toHaveBeenCalled();
  });

  it(
    "proves quotedReply authority at final agent input through production inbound execution",
    { timeout: 90_000 },
    async () => {
      const groupAllowFrom = ["bob-aad", "alice-aad"];
      await withRealAgentInputIngress(
        {
          messages: { inbound: { debounceMs: 40 } },
          channels: {
            msteams: {
              groupPolicy: "allowlist",
              groupAllowFrom,
              contextVisibility: "allowlist",
              requireMention: false,
            },
          },
        } as OpenClawConfig,
        async ({ accept, drain, modelRequests }) => {
          const latestModelInput = () => JSON.stringify(modelRequests.at(-1));

          await accept(
            groupActivity("activity-agent-quote-allowed", "<at>Bot</at> ask <at>Alice</at>", [
              { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
              {
                type: "mention",
                text: "<at>Alice</at>",
                mentioned: { id: "alice-aad", name: "Alice" },
              },
              {
                type: "quotedReply",
                quotedReply: {
                  senderId: "alice-aad",
                  senderName: "Alice",
                  preview: "Allowed final-agent quoted preview",
                },
              },
            ]),
          );
          await drain();
          expect(latestModelInput()).toContain("ask @Alice");
          expect(latestModelInput()).toContain("Allowed final-agent quoted preview");
          expect(latestModelInput()).toContain("Alice");

          await accept(
            groupActivity("activity-agent-quote-blocked", "<at>Bot</at> ask <at>Mallory</at>", [
              { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
              {
                type: "mention",
                text: "<at>Mallory</at>",
                mentioned: { id: "mallory-aad", name: "Mallory" },
              },
              {
                type: "quotedReply",
                quotedReply: {
                  senderId: "mallory-aad",
                  senderName: "Mallory",
                  preview: "Blocked final-agent quoted preview",
                },
              },
            ]),
          );
          await drain();
          expect(latestModelInput()).toContain("ask @Mallory");
          expect(latestModelInput()).not.toContain("Blocked final-agent quoted preview");

          await accept({
            ...groupActivity("activity-agent-quote-mismatched", "<at>Bot</at> ask <at>Alice</at>", [
              { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
              {
                type: "mention",
                text: "<at>Alice</at>",
                mentioned: { id: "alice-aad", name: "Alice" },
              },
              {
                type: "quotedReply",
                quotedReply: {
                  messageId: "quote-agent-a",
                  senderId: "alice-aad",
                  senderName: "Alice",
                },
              },
            ]),
            attachments: [
              {
                contentType: "text/html",
                content:
                  '<blockquote itemtype="http://schema.skype.com/Reply" itemid="quote-agent-b">' +
                  '<strong itemprop="mri">Mallory</strong>' +
                  '<p itemprop="copy">Mismatched final-agent attachment body</p></blockquote>',
              },
            ],
          });
          await drain();
          expect(latestModelInput()).toContain("ask @Alice");
          expect(latestModelInput()).not.toContain("Mismatched final-agent attachment body");

          await accept(
            groupActivity("activity-agent-quote-revoked", "<at>Bot</at> ask <at>Alice</at>", [
              { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
              {
                type: "mention",
                text: "<at>Alice</at>",
                mentioned: { id: "alice-aad", name: "Alice" },
              },
              {
                type: "quotedReply",
                quotedReply: {
                  senderId: "alice-aad",
                  senderName: "Alice",
                  preview: "Revoked final-agent quoted preview",
                },
              },
            ]),
          );
          await drain(() => {
            groupAllowFrom.splice(0, groupAllowFrom.length, "bob-aad");
          });
          expect(latestModelInput()).toContain("ask @Alice");
          expect(latestModelInput()).not.toContain("Revoked final-agent quoted preview");

          groupAllowFrom.splice(0, groupAllowFrom.length, "bob-aad", "alice-aad");
          const quoteEntity = {
            type: "quotedReply",
            quotedReply: {
              senderId: "alice-aad",
              senderName: "Alice",
              preview: "Batched final-agent quoted preview",
            },
          };
          await accept(
            groupActivity("activity-agent-quote-batch-1", "<at>Bot</at> first question", [
              { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
              quoteEntity,
            ]),
          );
          await accept(
            groupActivity("activity-agent-quote-batch-2", "<at>Bot</at> second question", [
              { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
              quoteEntity,
            ]),
          );
          await drain();
          expect(latestModelInput()).toContain("first question");
          expect(latestModelInput()).toContain("second question");
          expect(latestModelInput()).toContain("Batched final-agent quoted preview");
          expect(modelRequests).toHaveLength(5);
        },
      );
    },
  );

  it("completes a gated no-dispatch turn instead of stalling its claim", async () => {
    const { deps } = createMessageHandlerDeps(
      {
        channels: {
          msteams: {
            groupPolicy: "open",
            requireMention: true,
          },
        },
      } as OpenClawConfig,
      {
        createInboundDebouncer,
        resolveInboundDebounceMs: vi.fn(() => 20),
      },
    );
    const handler = createMSTeamsMessageHandler(deps);
    const lifecycle = createLifecycle();
    const gatedActivity = buildChannelActivity({
      id: "activity-gated",
      text: "not for the bot",
      entities: [],
    }) as MSTeamsTurnContext["activity"];

    const result = await handler(context(gatedActivity), lifecycle);

    expect(result).toEqual({ kind: "deferred" });
    await vi.waitFor(() => expect(lifecycle.onAdopted).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
  });

  it("preserves abandon retry accounting, backoff, threshold, and restart behavior", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 2);
    vi.setSystemTime(now);
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-abandon-"));
    const stateDir = await fs.realpath(created);
    type Queue = NonNullable<Parameters<typeof createMSTeamsIngress>[0]["queue"]>;
    type Payload = Parameters<Queue["enqueue"]>[1];
    const queue = createChannelIngressQueueForTests<Payload>({
      channelId: "msteams",
      accountId: "test-app",
      stateDir,
    });
    const incoming = directActivity("activity-abandon", "retry me");
    await queue.enqueue(
      "activity-abandon",
      { version: 1, receivedAt: now - 2 * 24 * 60 * 60_000, rawActivity: JSON.stringify(incoming) },
      { laneKey: "dm-conversation", receivedAt: now - 2 * 24 * 60 * 60_000 },
    );
    const dispatchMock = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher;
    const priorImplementation = dispatchMock.getMockImplementation();
    dispatchMock.mockRejectedValue(new Error("Microsoft Teams dispatch failed before adoption"));

    let stopCurrent: (() => Promise<void>) | undefined;
    const createIntegratedIngress = () => {
      let capturedDrain: (() => Promise<void>) | undefined;
      const createDebouncer: typeof createInboundDebouncer = (options) => {
        const debouncer = createInboundDebouncer(options);
        capturedDrain = debouncer.drain;
        return debouncer;
      };
      const handler = createHandler(
        { channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } } },
        createDebouncer,
      );
      const ingress = createMSTeamsIngress({
        accountId: "test-app",
        queue,
        runtime: { error: vi.fn(), log: vi.fn() },
        dispatch: async (activity, lifecycle) => await handler(context(activity), lifecycle),
      });
      const monitorResult = vi.mocked(createChannelIngressMonitor).mock.results.at(-1);
      if (monitorResult?.type !== "return" || !capturedDrain) {
        throw new Error("Expected the Microsoft Teams ingress and debounce owners");
      }
      const monitor = monitorResult.value;
      const drainDebounce = capturedDrain;
      stopCurrent = async () => {
        await monitor.pause();
        await monitor.waitForIdle();
        await vi.advanceTimersByTimeAsync(40);
        await drainDebounce();
        await ingress.stop();
      };
      return { ...ingress, waitForIdle: monitor.waitForIdle, drainDebounce };
    };
    const expectPendingAttempt = async (
      ingress: ReturnType<typeof createIntegratedIngress>,
      attempts: number,
    ) => {
      await ingress.waitForIdle();
      await vi.advanceTimersByTimeAsync(40);
      await ingress.drainDebounce();
      const pending = await queue.listPending({ limit: "all" });
      expect(pending).toEqual([
        expect.objectContaining({
          id: "activity-abandon",
          attempts,
          lastAttemptAt: expect.any(Number),
          lastError: "turn-abandoned",
        }),
      ]);
      const observed = pending[0];
      const lastAttemptAt = observed?.lastAttemptAt;
      if (lastAttemptAt === undefined) {
        throw new Error(`Missing Microsoft Teams retry timestamp for attempt ${attempts}`);
      }
      return { ...observed, lastAttemptAt };
    };

    try {
      const first = createIntegratedIngress();
      first.start();
      const firstAttempt = await expectPendingAttempt(first, 1);
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      await first.stop();

      vi.setSystemTime(firstAttempt.lastAttemptAt + 999);
      const second = createIntegratedIngress();
      second.start();
      await second.accept(incoming);
      await second.waitForIdle();
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(await queue.listPending({ limit: "all" })).toEqual([firstAttempt]);
      await second.stop();
      vi.setSystemTime(firstAttempt.lastAttemptAt + 1_001);
      const afterBackoff = createIntegratedIngress();
      afterBackoff.start();
      await afterBackoff.accept(incoming);
      const secondAttempt = await expectPendingAttempt(afterBackoff, 2);
      expect(dispatchMock).toHaveBeenCalledTimes(2);
      await afterBackoff.stop();

      for (let attempt = 3; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
        const claim = await queue.claim("activity-abandon", { ownerId: `seed-${attempt}` });
        if (!claim) {
          throw new Error(`Expected Microsoft Teams seed claim ${attempt}`);
        }
        await queue.release(claim, {
          lastError: "turn-abandoned",
          releasedAt: secondAttempt.lastAttemptAt,
        });
      }
      vi.setSystemTime(secondAttempt.lastAttemptAt + 64_001);
      const threshold = createIntegratedIngress();
      threshold.start();
      await threshold.accept(incoming);
      const thresholdAttempt = await expectPendingAttempt(
        threshold,
        DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
      );
      expect(dispatchMock).toHaveBeenCalledTimes(3);
      await threshold.stop();

      vi.setSystemTime(thresholdAttempt.lastAttemptAt + 128_001);
      const beyond = createIntegratedIngress();
      beyond.start();
      await beyond.accept(incoming);
      const beyondAttempt = await expectPendingAttempt(
        beyond,
        DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS + 1,
      );
      expect(dispatchMock).toHaveBeenCalledTimes(4);
      await beyond.stop();

      vi.setSystemTime(beyondAttempt.lastAttemptAt + 1_000);
      const blockedRestart = createIntegratedIngress();
      blockedRestart.start();
      await blockedRestart.accept(incoming);
      await blockedRestart.waitForIdle();
      expect(dispatchMock).toHaveBeenCalledTimes(4);
      expect(await queue.listPending({ limit: "all" })).toEqual([beyondAttempt]);
      await blockedRestart.stop();
    } finally {
      try {
        await stopCurrent?.();
      } finally {
        vi.useRealTimers();
        dispatchMock.mockReset();
        if (priorImplementation) {
          dispatchMock.mockImplementation(priorImplementation);
        }
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    }
  });
});
