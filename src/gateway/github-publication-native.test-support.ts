import fs from "node:fs/promises";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { expect, onTestFinished, vi } from "vitest";
import { runNodeWorkerWorkspaceTransfer } from "../node-host/node-worker-transfer-client.js";
import type { runCommandBuffered } from "../process/exec.js";
import { NODE_WORKSPACE_EMPTY_MANIFEST_REF } from "../worker/node-workspace-transfer-protocol.js";
import type { createRequesterPublicationFixture } from "./github-publication-requester.test-support.js";
import {
  commandResult,
  githubPublicationTestMocks,
  root,
} from "./github-publication.test-support.js";
import type { PrepareRepositoryPublicationIntegration } from "./repository-publication-integration.js";
import { hashWorkerCredential } from "./worker-environments/credential.js";
import { createNodeWorkerBundleTestNode } from "./worker-environments/node-worker-bundle.test-support.js";
import { prepareNodeWorkerPublicationIntegration } from "./worker-environments/node-worker-publication-transfer.js";
import { createNodeWorkspaceTransferCommand } from "./worker-environments/node-workspace-transfer-command.js";
import { createNodeWorkspaceTransferService } from "./worker-environments/node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./worker-environments/node-workspace-transfer.test-support.js";
import {
  createDispatchEnvironmentFixtures,
  REQUEST,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { writePlacementEnvironmentFixture } from "./worker-environments/placement-test-fixtures.js";
import { createRepositoryPublicationPreparation } from "./worker-environments/repository-publication-preparation.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";
import { WorkerTunnelOwnerDisconnectedError } from "./worker-environments/tunnel-contract.js";
import { createWorkerTurnTunnel } from "./worker-environments/worker-turn-launcher.test-support.js";
const mocks = githubPublicationTestMocks();
/** Real authority, receipts, Git and HTTP; checkpoint input, publisher and node enrollment remain synthetic. */
export async function createNativePublicationTransport(
  f: Pick<
    Awaited<ReturnType<typeof createRequesterPublicationFixture>>,
    "repository" | "database" | "session" | "placements" | "config"
  > & {
    guest: { signal: AbortSignal; assertCurrent: () => void };
  },
  events: string[],
  inspect?: {
    worker: (value: string) => void;
    publisher: (env: NodeJS.ProcessEnv | undefined, argv: string[]) => void;
  },
) {
  const repository = f.repository;
  if (!repository) {
    throw new Error("Native publication proof requires a repository fixture");
  }
  const environmentId = "combined-publication-worker";
  const ownerEpoch = 1;
  const environments = await createWorkerEnvironmentStore({ database: f.database });
  writePlacementEnvironmentFixture(f.database, {
    ...createDispatchEnvironmentFixtures().attached,
    environmentId,
    ownerEpoch,
    attachedSessionIds: [f.session.sessionId],
  });
  await environments.renewCredential({
    environmentId,
    expectedOwnerEpoch: ownerEpoch,
    credentialHash: hashWorkerCredential("synthetic-worker-transfer"),
    sessionId: f.session.sessionId,
    rpcSetVersion: 1,
    expiresAtMs: Date.now() + 60_000,
  });
  let seededPlacement = await f.placements.startDispatch({ ...REQUEST, ...f.session });
  for (const [from, to, patch] of [
    ["requested", "provisioning", { environmentId }],
    ["provisioning", "syncing", { workerBundleHash: "a".repeat(64) }],
    [
      "syncing",
      "starting",
      {
        workspaceBaseManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
        remoteWorkspaceDir: repository.remote,
      },
    ],
    ["starting", "active", { activeOwnerEpoch: ownerEpoch }],
  ] as const) {
    seededPlacement = await f.placements.transition({
      sessionId: f.session.sessionId,
      from,
      to,
      expectedGeneration: seededPlacement.generation,
      patch,
    });
  }
  const node = createNodeWorkerBundleTestNode({ workerHost: { publicationIntegration: 1 } });
  const service = createNodeWorkspaceTransferService({
    temporaryRoot: nodePath.join(root, "combined-transfers"),
    getOwner: (id) => environments.getTransferOwner(id),
  });
  const observed = {
    nativeExecutions: 0,
    httpRequests: 0,
    gitFetches: 0,
    physicalCas: 0,
    get admissions() {
      return events.filter((event) => event === "integration-admitted").length;
    },
  };
  const authorize = service.authorize.bind(service);
  vi.spyOn(service, "authorize").mockImplementation((input) => {
    observed.httpRequests++;
    return authorize(input);
  });
  const server = await startNodeWorkspaceTransferTestServer(service);
  onTestFinished(async () => {
    await server.close();
    await service.closeAll();
    await environments.close();
  });
  repository.git(["update-ref", "refs/heads/main", repository.baseCommit]);
  repository.git(["update-ref", "refs/heads/topic", repository.baseCommit]);
  const ref = "refs/heads/" + repository.workspace.branch;
  const readRef = () => repository.git(["for-each-ref", "--format=%(objectname)", ref]);
  const provider = mocks.runCommand.getMockImplementation()!;
  const native = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  let unavailable = true;
  // Same external-I/O seam as the canonical publication Git fixture: exact synthetic URL only,
  // file protocol only. All Git commands, object writes and compare-and-swap ref effects are real.
  const transport: typeof runCommandBuffered = async (argv, options) => {
    if (argv[0] === "git") {
      inspect?.worker(JSON.stringify({ argv, options }));
      if (argv.includes("fetch")) {
        observed.gitFetches++;
      }
      return native.runCommandBuffered(
        argv.map((arg) =>
          arg === "https://github.com/owner/repository.git"
            ? pathToFileURL(repository.remote).href
            : arg,
        ),
        { ...options, env: { ...options?.env, GIT_ALLOW_PROTOCOL: "file" } },
      );
    }
    if (argv[0] !== "gh") {
      throw new Error("Unexpected combined fixture command");
    }
    inspect?.publisher(options?.preparedEnv ?? options?.env, argv);
    if (unavailable && argv.some((arg) => arg.endsWith("/git/blobs"))) {
      return {
        ...commandResult("", 1),
        stderr: Buffer.from("synthetic-provider-canary (HTTP 503)"),
      };
    }
    if (argv.includes("graphql")) {
      if (typeof options?.input !== "string") {
        throw new Error("Expected fixed CAS payload");
      }
      const body = JSON.parse(options.input);
      const update = body.variables.input.refUpdates[0];
      expect(update.name).toBe(ref);
      expect(update.force).toBe(false);
      expect(update.beforeOid).toBe(readRef() || "0".repeat(40));
      repository.git(["update-ref", ref, update.afterOid, update.beforeOid]);
      observed.physicalCas++;
    }
    return provider(argv, options);
  };
  mocks.runCommand.mockImplementation(transport);
  const integrate = async (input: Parameters<PrepareRepositoryPublicationIntegration>[1]) => {
    input.assertCurrent();
    const isCurrent = () => {
      const placement = f.placements.get(f.session.sessionId);
      return (
        placement?.state === "active" &&
        placement.environmentId === environmentId &&
        placement.activeOwnerEpoch === ownerEpoch &&
        placement.agentId === "main" &&
        placement.sessionKey === f.session.sessionKey
      );
    };
    await service.prepareRepository({
      environmentId,
      ownerEpoch,
      sessionId: f.session.sessionId,
      baseCommit: repository.baseCommit,
      baseManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
      isAuthorized: isCurrent,
      authorize: input.assertCurrent,
    });
    const transfer = createNodeWorkspaceTransferCommand(async (command) => {
      command.assertCurrent?.();
      if (!command.transfer) {
        throw new Error("Expected native publication transfer");
      }
      observed.nativeExecutions++;
      inspect?.worker(JSON.stringify(command));
      if (inspect) {
        const files = [
          nodePath.join(input.snapshotRoot, "snapshot.json"),
          ...(await fs.readdir(nodePath.join(input.snapshotRoot, "blobs"))).map((name) =>
            nodePath.join(input.snapshotRoot, "blobs", name),
          ),
          ...(input.history?.gitPackPath ? [input.history.gitPackPath] : []),
        ];
        for (const file of files) {
          inspect.worker((await fs.readFile(file)).toString("utf8"));
        }
      }
      const stdout = await runNodeWorkerWorkspaceTransfer({
        gatewayUrl: server.gatewayUrl,
        environmentId,
        workspaceDir: repository.remote,
        manifestHome: nodePath.join(root, "combined-node-home"),
        transfer: command.transfer,
        signal: command.signal,
        assertCurrent: command.assertCurrent,
      });
      return {
        code: 0,
        termination: "exit",
        signal: null,
        killed: false,
        stdout,
        stderr: "",
        workspaceDir: repository.remote,
      };
    });
    return prepareNodeWorkerPublicationIntegration(
      {
        environmentId,
        signal: f.guest.signal,
        workspaceTransfer: service,
        supportsIntegration: async () => {
          input.assertCurrent();
          return isCurrent() && node.workerHost.publicationIntegration === 1;
        },
        transfer,
      },
      input,
    );
  };
  const tunnel = createWorkerTurnTunnel({
    environmentId,
    ownerEpoch,
    launchTurn: async () => {
      throw new Error("Publication must not launch a model turn");
    },
    reconcileWorkspace: async () => {
      throw new Error("Unexpected editing-workspace reconciliation");
    },
    integratePublication: integrate,
  });
  let disconnected = false;
  const preparation = createRepositoryPublicationPreparation({
    placements: f.placements,
    getConfig: () => f.config,
    ensurePlacement: async () => {
      throw new Error("Unexpected worker provisioning");
    },
    resolveDevicePlacementRequirement: async () => {
      throw new Error("Unexpected device selection");
    },
    environments: {
      get: (id) => {
        const current = environments.get(id);
        return (
          current && {
            ...current,
            desktopAvailable: false,
            desktopApps: [],
            tunnelStatus: "connected" as const,
          }
        );
      },
      startTunnel: async (input) => {
        input.authorize?.();
        if (disconnected) {
          disconnected = false;
          throw new WorkerTunnelOwnerDisconnectedError();
        }
        return tunnel;
      },
      inspectTurnLease: async () => {
        throw new Error("Fixture has no retained compute lease");
      },
    },
    waitForNode: async (input) => {
      input.assertCurrent();
      expect(node.workerHost.publicationIntegration).toBe(1);
    },
    reconcileActive: async (id) => {
      f.guest.assertCurrent();
      expect(environments.get(id)?.ownerEpoch).toBe(ownerEpoch);
    },
  });
  mocks.prepareRepositoryIntegration.mockImplementation((identity, input) => {
    disconnected = true;
    return preparation(identity, input);
  });
  return {
    observed,
    readRef,
    ref,
    recoverProvider: () => {
      unavailable = false;
    },
    revokeCustody: () => environments.revokeEnvironmentCredential(environmentId),
  };
}
