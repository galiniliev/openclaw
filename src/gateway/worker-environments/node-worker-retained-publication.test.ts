import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import {
  NODE_WORKSPACE_EMPTY_MANIFEST,
  NODE_WORKSPACE_EMPTY_MANIFEST_REF,
  NodeWorkerWorkspaceTransferError,
} from "../../worker/node-workspace-transfer-protocol.js";
import { resolveGitHubPublicationFailure } from "../github-publication-failure.js";
import {
  createManager,
  environment,
  startRequest,
  transport,
  workspaceReply,
} from "./node-worker-tunnel.test-support.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it("reopens retained publication transfer custody after Gateway replacement without synchronizing the private tree", async () => {
  const root = temporary.make("retained-publication-transfer-");
  const workspaceDir = path.join(root, "original-workspace");
  const inputRoot = path.join(root, "accepted-input");
  const outputRoot = path.join(root, "node-output");
  for (const dir of [workspaceDir, inputRoot, outputRoot]) {
    await fs.mkdir(dir);
  }
  await fs.writeFile(path.join(workspaceDir, "private.txt"), "uncheckpointed retained edit\n");
  const snapshot = {
    version: 1,
    baseCommit: "a".repeat(40),
    baseTree: "b".repeat(40),
    workspaceTree: "c".repeat(40),
    entries: [],
  };
  const input = JSON.stringify(snapshot);
  await fs.writeFile(path.join(inputRoot, "snapshot.json"), input);
  const mainCommit = "d".repeat(40);
  const integrated = { ...snapshot, baseCommit: mainCommit };
  await fs.writeFile(path.join(outputRoot, "snapshot.json"), JSON.stringify(integrated));
  await fs.writeFile(path.join(outputRoot, "known-blobs.json"), "[]");
  const manifestHome = path.join(root, "node-home");
  const manifests = path.join(manifestHome, ".openclaw-worker", "manifests");
  await fs.mkdir(manifests, { recursive: true });
  await fs.writeFile(
    path.join(manifests, `${NODE_WORKSPACE_EMPTY_MANIFEST_REF.slice(7)}.json`),
    NODE_WORKSPACE_EMPTY_MANIFEST,
  );
  const record = environment();
  assert(record.state === "attached");
  record.sharedHost = false;
  record.leaseId = "original-lease";
  let credential: { ownerEpoch: number; sessionId: string } | undefined = startRequest();
  const service = createNodeWorkspaceTransferService({
    temporaryRoot: path.join(root, "gateway-transfers"),
    getOwner: () => ({ environment: record, credential }),
  });
  const server = await startNodeWorkspaceTransferTestServer(service);
  const node = transport();
  const nodes = await node.listCurrentNodes();
  nodes[0]!.workerHost.publicationIntegration = 1;
  node.listCurrentNodes = async () => nodes;
  let publicationCommands = 0;
  node.invoke = async (request) => {
    expect(request.isDispatchAuthorized()).toBe(true);
    const command = parseNodeWorkerWorkspaceExecInput(JSON.stringify(request.params));
    if (!command.transfer) {
      // The only non-transfer command on reconnect is the existing workspace drain.
      expect(command.argv[0]).toBe("openclaw-internal-workspace-drain");
      return workspaceReply(workspaceDir, { stdout: "drained\n" });
    }
    assert(command.transfer.direction === "publication");
    publicationCommands++;
    const authorization = service.authorize({
      token: command.transfer.inputToken,
      route: {
        kind: "manifest",
        direction: "download",
        environmentId: record.environmentId,
        manifestRef: command.transfer.inputManifestRef,
      },
    });
    assert.isDefined(authorization);
    const downloaded = service.snapshot(authorization);
    assert.isDefined(downloaded);
    expect(await fs.readFile(path.join(downloaded.root, "snapshot.json"), "utf8")).toBe(input);
    // The external Node integrates in scratch; exercise the real Gateway upload receiver.
    const stdout = await runNodeWorkerWorkspaceTransfer({
      gatewayUrl: server.gatewayUrl,
      environmentId: record.environmentId,
      workspaceDir: outputRoot,
      manifestHome,
      transfer: {
        direction: "upload",
        token: command.transfer.token,
        baseManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
        referenceManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
      },
    });
    return workspaceReply(workspaceDir, { stdout });
  };
  const manager = createManager(record, {
    workspaceTransfer: service,
    getTransport: () => node,
  });
  const binding = {
    sessionKey: "agent:main:retained-publication",
    remoteWorkspaceDir: workspaceDir,
    manifestRef: `sha256:${"b".repeat(64)}`,
    source: {
      kind: "repository" as const,
      baseCommit: "a".repeat(40),
      baseManifestRef: `sha256:${"b".repeat(64)}`,
    },
    diskAuthority: {
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      sessionId: "session-1",
      ownerBinding: "original-owner",
      workspaceDir,
      identity: {
        leaseId: record.leaseId,
        attemptLeaseId: record.leaseId,
        resourceId: "original-disk",
        slug: "original",
      },
    },
  };
  manager.bindWorkspaceBindingResolver(async () => binding);
  const original = structuredClone({ record, binding });
  try {
    const handle = await manager.start(startRequest());
    assert.isDefined(handle.integratePublication);
    const publicationInput = {
      snapshotRoot: inputRoot,
      snapshotDigest: `sha256:${createHash("sha256").update(input).digest("hex")}`,
      mainCommit,
      sourceUrl: "https://github.com/example/repo.git",
      targetUrl: "https://github.com/example/repo.git",
      token: "synthetic-token",
      assertCurrent: () => {
        expect(manager.status(record.environmentId)).toBe("connected");
      },
    };
    const result = await handle.integratePublication(publicationInput);
    try {
      expect(result.snapshot).toEqual(integrated);
      expect(result.knownBlobs).toEqual([]);
      expect(publicationCommands).toBe(1);
      expect({ record, binding }).toEqual(original);
      expect(await fs.readFile(path.join(workspaceDir, "private.txt"), "utf8")).toBe(
        "uncheckpointed retained edit\n",
      );
      credential = undefined;
      const error = await handle
        .integratePublication(publicationInput)
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(NodeWorkerWorkspaceTransferError);
      expect(resolveGitHubPublicationFailure(error).code).toBe("unavailable");
      expect(publicationCommands).toBe(1);
      expect(() => service.prepareUpload(record.environmentId, binding.manifestRef)).toThrow(
        NodeWorkerWorkspaceTransferError,
      );
    } finally {
      await result.release();
    }
  } finally {
    await manager.stop(record.environmentId, record.ownerEpoch, "provider-destroyed");
    await service.closeAll();
    await server.close();
  }
});
