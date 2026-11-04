import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { listDirectoryTreeStrict } from "../../infra/directory-walk.js";
import { saveMediaBuffer } from "../../media/store.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { environment, workspaceCommandResult } from "./node-worker-tunnel.test-support.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import {
  startNodeWorkspaceTransferTestServer,
  transferOwner,
} from "./node-workspace-transfer.test-support.js";
import { prepareWorkerTurnMedia } from "./worker-turn-media.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const identity = { environmentId: "environment-1", ownerEpoch: 2, sessionId: "session-1" };

function restoredDiskBinding(remote: string, sessionKey = "agent:main:restored-media") {
  return {
    sessionKey,
    remoteWorkspaceDir: remote,
    manifestRef: `sha256:${"b".repeat(64)}`,
    source: {
      kind: "repository" as const,
      baseCommit: "a".repeat(40),
      baseManifestRef: `sha256:${"b".repeat(64)}`,
    },
    diskAuthority: {
      environmentId: identity.environmentId,
      sessionId: identity.sessionId,
      ownerEpoch: identity.ownerEpoch,
      ownerBinding: "synthetic-disk-owner",
      identity: {
        leaseId: "synthetic-lease",
        attemptLeaseId: "synthetic-lease",
        resourceId: "synthetic-disk",
        slug: "synthetic",
      },
      workspaceDir: remote,
    },
  };
}

async function workspaceFixture(beforeDownload?: () => Promise<void>) {
  const localPath = tempDirs.make("node-workspace-authority-");
  await fs.writeFile(path.join(localPath, "input.txt"), "workspace input\n");
  const transfer = createNodeWorkspaceTransferService({
    getOwner: () => ({ environment: environment(), credential: identity }),
    temporaryRoot: tempDirs.make("node-workspace-transfer-"),
  });
  const owner = new AbortController();
  const turn = new AbortController();
  const downloadAuthority = (token: string, manifestRef: string) =>
    transfer.authorize({
      token,
      route: {
        kind: "manifest",
        direction: "download",
        environmentId: identity.environmentId,
        manifestRef,
      },
    });
  const actions = createNodeWorkerWorkspaceActions({
    ...identity,
    ownerSignal: owner.signal,
    isOwnerCurrent: () => !owner.signal.aborted,
    workspaceTransfer: transfer,
    runWorkspaceCommand: async (command) => {
      // The real node command defaults to 60 seconds if its caller drops this budget.
      expect(command.timeoutMs).toBe(600_000);
      command.assertCurrent?.();
      if (!command.transfer || command.transfer.direction !== "download") {
        throw new Error("Expected a workspace download");
      }
      await beforeDownload?.();
      const authorization = downloadAuthority(command.transfer.token, command.transfer.manifestRef);
      if (!authorization || !transfer.snapshot(authorization)) {
        throw new Error("Workspace download authority closed");
      }
      return workspaceCommandResult("/node/workspace", { stdout: command.transfer.manifestRef });
    },
  });
  return {
    actions,
    transfer,
    localPath,
    downloadAuthority,
    closeTurn: () => turn.abort(new Error("Initiating dispatch turn closed")),
    transferRequest: { ...identity, localPath, isAuthorized: () => true },
    sync: (authorize = () => turn.signal.throwIfAborted()) =>
      actions.syncWorkspace({
        source: { kind: "local" as const, path: localPath, projectKey: "a".repeat(64) },
        sessionId: "session-1",
        generation: 1,
        authorize,
      }),
    [Symbol.asyncDispose]: async () => {
      owner.abort();
      await transfer.closeAll();
    },
  };
}

it.each(
  (["local", "repository"] as const).flatMap((source) =>
    (["turn", "owner", "signal"] as const).map((boundary) => ({ source, boundary })),
  ),
)(
  "rejects a queued $source sync with closed $boundary authority without replacing its predecessor",
  async ({ source, boundary }) => {
    await using fixture = await workspaceFixture();
    const preparing = createDeferred();
    const releasePreparation = createDeferred();
    const originalRealpath = fs.realpath.bind(fs);
    let blocked = false;
    const realpath = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      if (!blocked && args[0] === fixture.localPath) {
        blocked = true;
        preparing.resolve();
        await releasePreparation.promise;
      }
      return await originalRealpath(...args);
    });
    const signal = new AbortController();
    try {
      const first = fixture.transfer.prepareSync(fixture.transferRequest);
      await preparing.promise;
      const pending = {
        ...fixture.transferRequest,
        signal: boundary === "signal" ? signal.signal : undefined,
        isAuthorized: () => boundary !== "owner" || !signal.signal.aborted,
        authorize: boundary === "turn" ? () => signal.signal.throwIfAborted() : undefined,
      };
      const second =
        source === "local"
          ? fixture.transfer.prepareSync(pending)
          : fixture.transfer.prepareRepository({
              ...pending,
              baseCommit: "a".repeat(40),
              baseManifestRef: `sha256:${"b".repeat(64)}`,
            });
      const rejected = expect(second).rejects.toThrow();
      signal.abort(new Error("Initiating dispatch turn closed"));
      releasePreparation.resolve();
      const prepared = await first;
      await rejected;
      expect(
        fixture.downloadAuthority(prepared.token, prepared.snapshot.manifestRef),
      ).toBeDefined();
    } finally {
      releasePreparation.resolve();
      realpath.mockRestore();
    }
  },
);

it.each(["reconciliation", "attachments"] as const)(
  "preserves independent %s after the initiating dispatch turn closes",
  async (operation) => {
    await using fixture = await workspaceFixture();
    const synced = await fixture.sync();
    fixture.closeTurn();
    if (operation === "reconciliation") {
      const token = fixture.transfer.prepareUpload("environment-1", synced.manifestRef);
      expect(token).toBeTruthy();
      await fixture.transfer.revoke("environment-1", token);
    } else {
      assert.isDefined(fixture.actions.stageAttachments);
      await expect(
        fixture.actions.stageAttachments({
          localPath: fixture.localPath,
          isAuthorized: () => true,
          signal: new AbortController().signal,
        }),
      ).resolves.toBeUndefined();
    }
  },
);

it("rejects a download after its initiating turn closes but permits a fresh sync", async () => {
  const downloading = createDeferred();
  const releaseDownload = createDeferred();
  await using fixture = await workspaceFixture(async () => {
    downloading.resolve();
    await releaseDownload.promise;
  });
  try {
    const syncing = fixture.sync();
    const rejected = expect(syncing).rejects.toThrow(/authority closed|dispatch turn closed/u);
    await downloading.promise;
    fixture.closeTurn();
    releaseDownload.resolve();
    await rejected;

    const synced = await fixture.sync(() => {});
    const token = fixture.transfer.prepareUpload("environment-1", synced.manifestRef);
    expect(token).toBeTruthy();
    await fixture.transfer.revoke("environment-1", token);
  } finally {
    releaseDownload.resolve();
  }
});

it.each(["next-turn", "reconnect", "gateway-restart"] as const)(
  "stages current and historical media on the same restored disk after %s without workspace synchronization",
  async (boundary) => {
    const root = await fs.realpath(tempDirs.make("restored-disk-attachments-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "gateway-state"));
    const node = new NodeWorkerWorkspaceRuntime({
      root: path.join(root, "node"),
      env: { PATH: process.env.PATH, HOME: root },
    });
    const nativeOwner = {
      ...identity,
      gatewayNamespace: "restored-attachments",
      generation: identity.ownerEpoch,
    };
    const initialized = await node.exec({
      ...nativeOwner,
      argv: ["node", "-e", "require('fs').writeFileSync('disk-only.txt', 'retained edit')"],
    });
    const remote = initialized.workspaceDir;
    const pdf = Buffer.from("%PDF-1.7\nmanaged current PDF");
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
      "base64",
    );
    const current = await saveMediaBuffer(pdf, "application/pdf", "inbound");
    const historical = await saveMediaBuffer(image, "image/png", "inbound");
    const facts = [
      { path: current.path, contentType: "application/pdf" },
      { path: historical.path, contentType: "image/png" },
    ];
    const repository = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      agentId: "main",
      sessionKey: "agent:main:restored-media",
      url: "https://example.invalid/repository.git",
      requestedRef: "main",
      runSetupScript: false,
      baseCommit: "a".repeat(40),
      baseManifestHash: `sha256:${"b".repeat(64)}`,
      branch: "session",
      checkpointRef: null,
      manifestHash: null,
      revision: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const binding = restoredDiskBinding(remote, repository.sessionKey);
    const open = async (epoch: number) => {
      const service = createNodeWorkspaceTransferService({
        getOwner: () => transferOwner(identity.sessionId, identity.ownerEpoch),
        temporaryRoot: path.join(root, `transfer-${epoch}`),
      });
      const server = await startNodeWorkspaceTransferTestServer(service);
      const synced = [vi.spyOn(service, "prepareRepository"), vi.spyOn(service, "prepareSync")];
      const connect = () => {
        const owner = new AbortController();
        const commands = vi.fn(
          async (
            command: Parameters<
              Parameters<typeof createNodeWorkerWorkspaceActions>[0]["runWorkspaceCommand"]
            >[0],
          ) =>
            node.exec({ ...nativeOwner, ...command, argv: [...command.argv] }, owner.signal, {
              url: server.gatewayUrl,
            }),
        );
        const actions = createNodeWorkerWorkspaceActions({
          ...identity,
          ownerSignal: owner.signal,
          isOwnerCurrent: () => !owner.signal.aborted,
          restoredWorkspace: binding,
          workspaceTransfer: service,
          runWorkspaceCommand: commands,
        });
        return { owner, commands, actions };
      };
      return { service, server, synced, connect };
    };
    let gateway = await open(1);
    let connection = gateway.connect();
    const prepare = async (media: typeof facts, replay: typeof facts, signal: AbortSignal) => {
      const previous = {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Previous managed originals" }],
        timestamp: 1,
        __openclaw: { media: replay },
      };
      return prepareWorkerTurnMedia({
        turn: {
          sessionId: identity.sessionId,
          sessionKey: repository.sessionKey,
          sessionFile: path.join(root, "unused-transcript"),
          workspaceDir: remote,
          prompt: "Read the originals",
          timeoutMs: 5000,
          runId: "synthetic-media-turn",
          modelHasVision: false,
          config: { tools: { fs: { workspaceOnly: true } } },
          media,
        },
        history: [previous],
        workspace: { kind: "repository", repository },
        remoteWorkspaceDir: remote,
        tunnel: { ...connection.actions, ...identity, stop: async () => {} },
        signal,
        isAuthorized: () => !signal.aborted,
      });
    };
    const assertBytesAndNoMirror = async () => {
      const originals: Buffer[] = [];
      for (const { relativePath: file, dirent } of await listDirectoryTreeStrict(remote)) {
        if (file.endsWith(".gitignore") || file === "disk-only.txt") {
          continue;
        }
        const source = path.join(remote, file);
        if (dirent.isFile()) {
          originals.push(await fs.readFile(source));
        }
      }
      expect(originals).toHaveLength(2);
      expect(originals).toEqual(expect.arrayContaining([pdf, image]));
      expect(await fs.readFile(path.join(remote, "disk-only.txt"), "utf8")).toBe("retained edit");
      for (const operation of gateway.synced) {
        expect(operation).not.toHaveBeenCalled();
      }
      expect(
        connection.commands.mock.calls.every(
          ([command]) =>
            command.transfer?.direction === "download" && command.transfer.attachments === true,
        ),
      ).toBe(true);
    };
    try {
      await connection.actions.validateRestoredWorkspace();
      await prepare([], [], new AbortController().signal);
      expect(connection.commands).not.toHaveBeenCalled();
      const first = new AbortController();
      await prepare([facts[0]!], [facts[1]!], first.signal);
      expect(connection.commands).toHaveBeenCalledOnce();
      await assertBytesAndNoMirror();
      first.abort(new Error("Original turn ended"));
      if (boundary !== "next-turn") {
        connection.owner.abort();
        await gateway.service.close(identity.environmentId);
        if (boundary === "gateway-restart") {
          await gateway.service.closeAll();
          await gateway.server.close();
          gateway = await open(2);
        }
        connection = gateway.connect();
        await connection.actions.validateRestoredWorkspace();
      }
      await prepare([], facts, new AbortController().signal);
      expect(connection.commands).toHaveBeenCalledTimes(boundary === "next-turn" ? 2 : 1);
      await assertBytesAndNoMirror();
    } finally {
      connection.owner.abort();
      await gateway.service.closeAll();
      await gateway.server.close();
      vi.unstubAllEnvs();
    }
  },
);

it.each(["epoch", "credential", "owner-signal", "turn-signal", "turn-authority"] as const)(
  "refuses restored attachment custody when %s is stale",
  async (boundary) => {
    const input = tempDirs.make("restored-attachment-refusal-");
    await fs.writeFile(path.join(input, "attachment.txt"), "private attachment");
    const current = transferOwner(identity.sessionId, identity.ownerEpoch);
    const owner = new AbortController();
    const turn = new AbortController();
    const service = createNodeWorkspaceTransferService({
      getOwner: () => current,
      temporaryRoot: tempDirs.make("restored-attachment-refusal-transfer-"),
    });
    const run = vi.fn(async () => workspaceCommandResult("/node/workspace"));
    const actions = createNodeWorkerWorkspaceActions({
      ...identity,
      ownerSignal: owner.signal,
      isOwnerCurrent: () => !owner.signal.aborted,
      restoredWorkspace: restoredDiskBinding("/node/workspace"),
      workspaceTransfer: service,
      runWorkspaceCommand: run,
    });
    if (boundary === "epoch") {
      current.environment.ownerEpoch++;
    }
    if (boundary === "credential") {
      current.credential.sessionId = "other-session";
    }
    if (boundary === "owner-signal") {
      owner.abort(new Error("Owner closed"));
    }
    if (boundary === "turn-signal") {
      turn.abort(new Error("Turn closed"));
    }
    try {
      await expect(
        actions.stageAttachments({
          localPath: input,
          isAuthorized: () => boundary !== "turn-authority",
          signal: turn.signal,
        }),
      ).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    } finally {
      owner.abort();
      await service.closeAll();
    }
  },
);
