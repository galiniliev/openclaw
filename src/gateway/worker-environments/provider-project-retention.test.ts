import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { NodeWorkerPreparedWorkspaceRuntime } from "../../node-host/node-worker-prepared-workspace.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import { createWorkerPreparationIdentity } from "./preparation-identity.js";
import { readWorkerPreparation } from "./preparation-identity.schema.js";
import { PRESENCE_REPOSITORY, usePreparedPoolFixture } from "./prepared-pool.test-support.js";
import {
  createWorkerProjectPreparation,
  readWorkerProjectEnvironmentRecipe,
} from "./project-preparation.js";
import {
  createProjectPreparationFixture,
  runProjectScriptWithGitProbe,
} from "./project-preparation.test-support.js";
import { createWorkerProviderIntent } from "./provider-intent.js";
import { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import { prepareWorkerProviderProject } from "./provider-project-preparation.js";
import { BUNDLE_ARTIFACT } from "./service.test-support.js";
import { prepareWorkerProjectSnapshot, workerProjectSeedKey } from "./workspace-git-base.js";

const sourceAdmission = vi.hoisted(() =>
  vi.fn<typeof import("./repository-project-admission.js").prepareRepositoryWorkerProjectSource>(),
);
vi.mock("./repository-project-admission.js", () => ({
  prepareRepositoryWorkerProjectSource: sourceAdmission,
}));

describe("prepared project retention compatibility", () => {
  const fixture = usePreparedPoolFixture();

  it("keeps reserve, pinned, cold and replayed preparation outside initial snapshot custody", async () => {
    const f = await createProjectPreparationFixture(
      await fs.mkdtemp(path.join(fixture.root, "custody-")),
    );
    const initial = await f.preparedOperation();
    const installed = await initial.project.prepare(f);
    await requireGit(installed.preparedWorkspace!.workspaceDir, [
      "remote",
      "add",
      "origin",
      PRESENCE_REPOSITORY.source.url,
    ]);
    initial.close();
    const recipe = await readWorkerProjectEnvironmentRecipe(f.project);
    const project = {
      key: f.project.key,
      baseCommit: f.project.baseCommit,
      source: PRESENCE_REPOSITORY.source,
    };
    for (const mode of ["fresh", "reserve", "pinned", "cold", "replay"] as const) {
      const operation = createWorkerProjectPreparation({
        project,
        namespace: "gateway",
        requireCurrent() {},
        revalidateRepositorySource: async () => {},
        setupAuthorized: true,
        snapshotStart: mode === "pinned" ? undefined : true,
        preparation: {
          key: "a".repeat(64),
          cacheKey: "c".repeat(64),
          purpose: mode === "reserve" ? "reserve" : "session",
          demandAtMs: 1,
          setupRecipe: recipe.identity,
          recipe,
        },
      });
      try {
        await operation.project.prepare({
          ...f,
          snapshotBaseCommit: mode === "cold" ? undefined : f.project.baseCommit,
          initialSnapshotCheckpointId:
            mode === "cold" || mode === "replay" ? undefined : "checkpoint-fresh",
        });
        expect(operation.getInitialSnapshot() !== undefined).toBe(mode === "fresh");
      } finally {
        operation.close();
      }
    }
  });

  it("starts admitted B on selected snapshot A and binds the actual prepared base without refreshing content", async () => {
    const f = await createProjectPreparationFixture(
      await fs.mkdtemp(path.join(fixture.root, "snapshot-start-")),
      '#!/bin/sh\nprintf "setup\\n" >> "$HOME/setup-count"\n',
    );
    const initialOperation = await f.preparedOperation();
    const initial = await initialOperation.project.prepare(f);
    initialOperation.close();
    const workspace = initial.preparedWorkspace!;
    await requireGit(workspace.workspaceDir, [
      "remote",
      "add",
      "origin",
      "https://github.com/acme/project.git",
    ]);
    await fs.writeFile(path.join(f.repository, "input.txt"), "latest main B\n");
    await requireGit(f.repository, ["commit", "--quiet", "-am", "main B"]);
    const latest = (await prepareWorkerProjectSnapshot({
      localPath: f.repository,
      namespace: "gateway",
    }))!;
    const revalidate = vi.fn(async () => {});
    const pack = vi.fn(async () => {
      throw new Error("snapshot start must not pack latest main");
    });
    const recipe = await readWorkerProjectEnvironmentRecipe(latest);
    const project: Parameters<typeof prepareWorkerProviderProject>[0]["project"] = {
      key: latest.key,
      baseCommit: latest.baseCommit,
      source: {
        kind: "repository",
        url: "https://github.com/acme/project.git",
        repositoryId: "R_fixture",
        owner: {
          agent: { agentId: "main", provenance: null },
          identity: { source: "anonymous" },
        },
      },
    };
    const repositorySource: NonNullable<
      Parameters<typeof prepareWorkerProviderProject>[0]["repositorySource"]
    > = {
      project,
      snapshotStart: true,
      setupRecipe: recipe.identity,
      recipe,
      recoverySource: undefined,
      assertCurrent() {},
      revalidate,
      prepareGitPack: pack,
    };
    const inputs: Parameters<typeof prepareWorkerProviderProject>[0] = {
      project,
      namespace: "gateway",
      preparation: {
        ...readWorkerPreparation(fixture.profile())!,
        key: "b".repeat(64),
        cacheKey: "c".repeat(64),
        setupRecipe: recipe.identity,
        recipe,
      },
      record: { preparation: null, createdAtMs: 2000, profileSnapshot: { settings: {} } },
      getConfig: () => fixture.config,
      repositorySource,
      requireCurrent() {},
    };
    const operation = await prepareWorkerProviderProject(inputs);
    onTestFinished(() => operation.close());
    const gitCommands: string[][] = [];
    const result = await operation.project.prepare({
      ...f,
      snapshotBaseCommit: f.project.baseCommit,
      initialSnapshotCheckpointId: "checkpoint-fresh-A",
      runScript: async (script) =>
        await runProjectScriptWithGitProbe(script, f.home, (args) => {
          gitCommands.push(args);
          return undefined;
        }),
    });
    expect(revalidate).not.toHaveBeenCalled();
    expect(pack).not.toHaveBeenCalled();
    expect(result.captureRequired).toBeUndefined();
    expect(operation.getInitialSnapshot()).toEqual({
      checkpointId: "checkpoint-fresh-A",
      baseCommit: f.project.baseCommit,
      sourceManifestRef: workspace.sourceManifestRef,
      preparedManifestRef: workspace.preparedManifestRef,
    });
    expect(
      gitCommands.some(
        (args) => args.includes("fsck") || args.includes("index-pack") || args.includes("checkout"),
      ),
    ).toBe(false);
    expect(await requireGit(workspace.workspaceDir, ["rev-parse", "HEAD"])).toBe(
      f.project.baseCommit,
    );
    expect(await fs.readFile(path.join(workspace.workspaceDir, "input.txt"), "utf8")).toBe(
      "prepared base\n",
    );
    expect(await fs.readFile(path.join(workspace.homeDir, "setup-count"), "utf8")).toBe("setup\n");
    const databasePath = path.join(f.home, "prepared-test.sqlite");
    onTestFinished(async () => {
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
    });
    const runtime = new NodeWorkerPreparedWorkspaceRuntime(
      f.home,
      { path: databasePath },
      new Map(),
      true,
    );
    const identity = {
      gatewayNamespace: "gateway",
      environmentId: "new-session",
      preparationKey: "b".repeat(64),
      cacheKey: "c".repeat(64),
    };
    await runtime.prepare({ action: "register", ...identity, ...result.preparedWorkspace! });
    const binding = {
      action: "bind" as const,
      ...identity,
      sessionId: "session",
      sessionKey: "agent:main:session",
      ownerEpoch: 1,
    };
    expect(await runtime.prepare(binding)).toMatchObject({
      baseCommit: f.project.baseCommit,
      workspaceDir: workspace.workspaceDir,
    });
    await fs.writeFile(path.join(workspace.workspaceDir, "input.txt"), "private edit\n");
    expect(await runtime.prepare(binding)).toMatchObject({ baseCommit: f.project.baseCommit });
    const replay = await prepareWorkerProviderProject({
      ...inputs,
      repositorySource: { ...repositorySource, snapshotStart: undefined },
    });
    onTestFinished(() => replay.close());
    await replay.project.inspectPreparedWorkspace!({
      baseCommit: f.project.baseCommit,
      runScript: async (script) =>
        await runProjectScriptWithGitProbe(script, f.home, () => undefined),
    });
    expect(await fs.readFile(path.join(workspace.workspaceDir, "input.txt"), "utf8")).toBe(
      "private edit\n",
    );
  });

  it.each(["fresh", "reused", "wrong runtime", "wrong mode", "post-start writer"] as const)(
    "carries completed runtime preparation only for an unchanged %s snapshot consumer",
    async (mode) => {
      const profile = fixture.profile();
      const preparation = profile.project.preparation;
      const recipe = {
        source: "none" as const,
        inputs: {},
        env: {},
        ...(mode === "post-start writer" ? { postStart: ["touch private-file"] } : {}),
      };
      const requested = await fixture.store.createIntent({
        environmentId: "runtime-reuse",
        providerId: fixture.provider.id,
        profileId: "development",
        provisionOperationId: "provision:runtime-reuse",
        profileSnapshot: {
          ...profile,
          project: { ...profile.project, preparation: { ...preparation, recipe } },
        },
      });
      await fixture.store.transition({
        environmentId: requested.environmentId,
        from: "requested",
        to: "provisioning",
      });
      const pending = await fixture.store.ensureNodeEnrollment(requested.environmentId);
      await completeWorkerNodeSetupForTest({
        baseDir: fixture.root,
        store: fixture.store,
        setupId: pending.nodeSetupId!,
        deviceId: "node",
        completedAtMs: 1,
      });
      const record = fixture.store.get(requested.environmentId)!;
      const ensureNodeWorkerBundle = vi.fn<
        NonNullable<Parameters<typeof createWorkerNodeProvisioning>[0]["ensureNodeWorkerBundle"]>
      >(async () => ({
        bundleHash: preparation.artifacts.workerBundleHash,
        openclawVersion: "2026.8.1",
        protocolFeatures: [],
      }));
      const owner = createWorkerNodeProvisioning({
        store: fixture.store,
        now: () => 1,
        isStopping: () => false,
        ownerSignal: fixture.abort.signal,
        prepareInstallation: async () => ({
          ...BUNDLE_ARTIFACT,
          tarballSha256: preparation.artifacts.workerArchiveSha256,
        }),
        ensureNodeWorkerBundle,
        registerPreparedWorkspace: async () => {},
        acceptInitial: async (current) => current,
        failBootstrap: async (_record, _lease, _provider, error) => {
          throw error;
        },
        commitReady: async (current) => current,
        move: vi.fn(),
        saveError: vi.fn(),
      });
      await owner.finish(
        record,
        {
          leaseId: "lease",
          sharedHost: false,
          node: {
            deviceId: "node",
            preparedRuntime: {
              nodeBootstrapSha256: preparation.artifacts.nodeBootstrapSha256,
              workerBundleSha256:
                mode === "wrong runtime"
                  ? "0".repeat(64)
                  : preparation.artifacts.workerArchiveSha256,
              executionMode: mode === "wrong mode" ? "remote-exec" : "worker-turn",
            },
          },
        },
        fixture.provider,
        fixture.abort.signal,
        { leaseId: "lease", sharedHost: false, desktop: null },
        undefined,
        undefined,
        {
          preparationKey: preparation.key,
          cacheKey: preparation.cacheKey,
          sourceManifestRef: "/source",
          preparedManifestRef: "/prepared",
          workspaceDir: "/workspace",
          homeDir: "/home",
        },
        undefined,
        mode === "reused"
          ? undefined
          : {
              checkpointId: "checkpoint",
              baseCommit: profile.project.baseCommit,
              sourceManifestRef: "/source",
              preparedManifestRef: "/prepared",
            },
      );
      expect(ensureNodeWorkerBundle).toHaveBeenCalledOnce();
      expect(ensureNodeWorkerBundle.mock.calls[0]?.[0].initialSnapshot).toBe(
        mode === "fresh" ? "checkpoint" : undefined,
      );
    },
  );

  async function setup() {
    sourceAdmission
      .mockReset()
      .mockRejectedValue(new Error("Retention must not access the repository"));
    fixture.config.agents = { entries: { main: {} } };
    const options = fixture.intentOwnerOptions("gateway");
    const { target, artifacts } = readWorkerPreparation(fixture.profile())!;
    fixture.provider.resolvePreparationTarget = () => target;
    const project = structuredClone(PRESENCE_REPOSITORY);
    const profileSnapshot = { settings: {}, install: "bundle", executionMode: "worker-turn" };
    const preparation = createWorkerPreparationIdentity({
      namespace: "gateway",
      providerId: fixture.provider.id,
      profileId: "development",
      profileSnapshot,
      project,
      target,
      artifacts,
      setupRecipe: "e".repeat(40),
      runSetupScript: false,
    });
    const preparedProfile = { ...profileSnapshot, project: { ...project, preparation } };
    const record = await fixture.store.createIntent({
      environmentId: "retained",
      providerId: fixture.provider.id,
      profileId: "development",
      provisionOperationId: "provision:retained",
      profileSnapshot: preparedProfile,
    });
    const prepareNodeArtifacts = vi.fn(async () => ({ artifacts, assertCurrent() {} }));
    const providerFor = vi.fn(() => fixture.provider);
    const owner = createWorkerProviderIntent({
      ...options,
      providerFor,
      prepareNodeArtifacts,
      resumeProvision: async (environment) => environment,
    });
    return {
      record,
      preparation: readWorkerPreparation(record.profileSnapshot)!,
      preparedProfile,
      owner,
      project,
      artifacts,
      prepareNodeArtifacts,
      providerFor,
    };
  }

  it("uses repository admission and fences a changed source owner before allocation", async () => {
    const { owner, project } = await setup();
    let current = true;
    sourceAdmission.mockResolvedValue({
      project,
      recoverySource: undefined,
      setupRecipe: "e".repeat(40),
      recipe: {
        source: "script",
        identity: "e".repeat(40),
        inputs: { ".openclaw/worktree-setup.sh": "e".repeat(40) },
        env: {},
        onCreate: ["./.openclaw/worktree-setup.sh"],
      },
      assertCurrent: () => {
        if (!current) {
          throw new Error("Repository owner changed");
        }
      },
      revalidate: async () => {},
    });
    const intent = await owner.prepareIntent("development", {
      executionMode: "worker-turn",
      projectRepository: project,
      runSetupScript: false,
    });
    expect(sourceAdmission).toHaveBeenCalledOnce();
    expect(sourceAdmission.mock.calls[0]?.[0].expected).toEqual(project);
    expect(intent.profileSnapshot.project).toMatchObject({
      ...project,
      preparation: { setupRecipe: "e".repeat(40), runSetupScript: false },
    });
    expect(intent.profileSnapshot.project).not.toHaveProperty("root");
    current = false;
    const before = fixture.store.list();
    await expect(
      owner.createWithProfile(
        "development",
        "changed-repository",
        { executionMode: "worker-turn" },
        intent,
      ),
    ).rejects.toThrow("Repository owner changed");
    expect(fixture.store.list()).toEqual(before);
  });

  it("passes private pack production through the provisioning owner instead of worker fetch", async () => {
    const { project, record } = await setup();
    const stopped = new Error("Private pack producer stopped before transfer");
    const prepareGitPack = vi.fn(async () => {
      throw stopped;
    });
    sourceAdmission.mockResolvedValue({
      project,
      recoverySource: undefined,
      setupRecipe: undefined,
      recipe: { source: "none", inputs: {}, env: {} },
      assertCurrent: () => {},
      revalidate: async () => {},
      prepareGitPack,
    });
    const operation = await prepareWorkerProviderProject({
      project,
      preparation: undefined,
      record,
      namespace: "gateway",
      getConfig: () => fixture.config,
      requireCurrent: () => {},
      signal: fixture.abort.signal,
    });
    const runScript = vi.fn(async () =>
      JSON.stringify({
        ready: false,
        directory: `/node/.openclaw-worker/git-seeds/gateway/.tmp-${workerProjectSeedKey(project)}-fixture`,
      }),
    );
    const upload = vi.fn();
    try {
      await expect(operation.project.prepare({ runScript, upload })).rejects.toBe(stopped);
      expect(prepareGitPack).toHaveBeenCalledOnce();
      expect(runScript).toHaveBeenCalledOnce();
      expect(upload).not.toHaveBeenCalled();
    } finally {
      operation.close();
    }
  });

  it("checks canonical retained contents without source admission or an allocation authority", async () => {
    const { record, preparation, preparedProfile, owner } = await setup();
    const retained = await owner.prepareRetention(record, preparation, fixture.abort.signal);
    expect(retained).toBeDefined();
    expect(retained!.isCurrent()).toBe(true);
    expect(sourceAdmission).not.toHaveBeenCalled();
    expect(fixture.store.get(record.environmentId)).toEqual(record);
    expect(() =>
      owner.assertPreparedIntentCurrent(record.profileId, {
        providerId: record.providerId,
        profileSnapshot: preparedProfile,
      }),
    ).toThrow("not owned by this lifecycle");
  });

  it.each(["provider", "target", "owner selection", "agent deletion"])(
    "rejects %s drift on the next retention pass without external source authority",
    async (mutation) => {
      const { record, preparation, owner, providerFor } = await setup();
      const retained = await owner.prepareRetention(record, preparation, fixture.abort.signal);
      expect(retained).toBeDefined();
      const unavailable = mutation === "owner selection" || mutation === "agent deletion";
      if (unavailable) {
        expect(retained?.isCurrent()).toBe(true);
        providerFor.mockClear().mockImplementation(() => {
          throw new Error("Worker provider registry temporarily unavailable");
        });
      }
      if (mutation === "provider") {
        fixture.developmentProfile.provider = "another-provider";
      } else if (mutation === "target") {
        fixture.provider.resolvePreparationTarget = () => ({
          machineClass: "large",
          platform: "linux",
          arch: "x64",
        });
      } else if (mutation === "owner selection") {
        fixture.config.tools = { github: { kind: "oauth", profileId: `ghp_${"a".repeat(32)}` } };
      } else {
        fixture.config.agents = { entries: { other: {} } };
      }
      if (unavailable) {
        expect(retained?.isCurrent()).toBe(false);
      }
      expect(
        await owner.prepareRetention(record, preparation, fixture.abort.signal),
      ).toBeUndefined();
      if (unavailable) {
        expect(providerFor).not.toHaveBeenCalled();
      }
      expect(sourceAdmission).not.toHaveBeenCalled();
    },
  );

  it("rejects agent removal during lifecycle preparation before preparing artifacts", async () => {
    const { record, preparation, owner, prepareNodeArtifacts } = await setup();
    const pending = owner.prepareRetention(record, preparation, fixture.abort.signal);
    fixture.config.agents = { entries: { other: {} } };

    await expect(pending).resolves.toBeUndefined();
    expect(prepareNodeArtifacts).not.toHaveBeenCalled();
    expect(sourceAdmission).not.toHaveBeenCalled();
  });

  it("rejects an old runtime fingerprint on the first retention pass after restart", async () => {
    const { record, preparation, owner, artifacts } = await setup();
    artifacts.workerArchiveSha256 = "1".repeat(64);
    expect(await owner.prepareRetention(record, preparation, fixture.abort.signal)).toBeUndefined();
    expect(sourceAdmission).not.toHaveBeenCalled();
  });

  it("reports why activation demand cannot refill after runtime artifacts change", async () => {
    const { record, owner, artifacts } = await setup();
    const activated = await fixture.attach(await fixture.ready(record));
    artifacts.workerArchiveSha256 = "1".repeat(64);
    const warn = vi.fn();
    const pool = fixture.pool({ prepareRetention: owner.prepareRetention, warn });
    await pool.maintain(activated.environmentId);
    expect(fixture.reserves()).toEqual([]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Prepared worker refill skipped (development, retained): runtime artifacts or preparation identity changed",
    );
  });
});
