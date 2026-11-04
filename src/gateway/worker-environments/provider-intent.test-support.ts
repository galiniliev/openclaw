import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createWorkerProviderIntent } from "./provider-intent.js";
import * as support from "./service.test-support.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export async function createProviderIntentFixture(
  setup = false,
  selectedProvider?: WorkerProvider,
) {
  const projectPath = path.join(support.testState.root, "project");
  await fs.mkdir(projectPath);
  await requireGit(projectPath, ["init", "--quiet"]);
  await requireGit(projectPath, ["config", "user.name", "Project Test"]);
  await requireGit(projectPath, ["config", "user.email", "project@example.invalid"]);
  await requireGit(projectPath, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(projectPath, "input.txt"), "base\n");
  if (setup) {
    await fs.mkdir(path.join(projectPath, ".openclaw"));
    await fs.writeFile(path.join(projectPath, ".openclaw/worktree-setup.sh"), "#!/bin/sh\ntrue\n", {
      mode: 0o755,
    });
  }
  await requireGit(projectPath, ["add", "."]);
  await requireGit(projectPath, ["commit", "--quiet", "-m", "base"]);
  const target = vi.fn<NonNullable<WorkerProvider["resolvePreparationTarget"]>>(
    (_profile, machineClass, os) => ({
      machineClass: machineClass ?? "small",
      platform: os ?? "linux",
      arch: "amd64",
    }),
  );
  const provider =
    selectedProvider ??
    support.createProvider({
      requiresNodeEnrollment: true,
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: target,
    });
  const artifacts = {
    nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
    workerBundleHash: support.BUNDLE_ARTIFACT.bundleHash,
    workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
    enabledPluginIds: ["runtime-plugin"],
    openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
    protocolFeatures: [],
  };
  const prepareNodeArtifacts = vi.fn(async () => ({
    artifacts,
    assertCurrent: () => {},
  }));
  const resumeProvision = vi.fn(async (record: WorkerEnvironmentRecord) => record);
  const owner = createWorkerProviderIntent({
    store: support.testState.store,
    getConfig: () => support.testState.config,
    projectNamespace: "gateway-test",
    providerFor: () => provider,
    prepareNodeArtifacts,
    resumeProvision,
    isStopping: () => false,
    withLock: async (_environmentId, task) => task(),
  });
  const prepare = (options: Parameters<typeof owner.prepareIntent>[1] = {}) =>
    owner.prepareIntent("development", { projectPath, ...options });
  const create = (
    key: string,
    options: Parameters<typeof owner.createWithProfile>[2] = {},
    admitted?: Parameters<typeof owner.createWithProfile>[3],
  ) => owner.createWithProfile("development", key, { projectPath, ...options }, admitted);
  return {
    prepare,
    create,
    spies: { target, prepareNodeArtifacts, resumeProvision },
    owner,
    provider,
    projectPath,
    target,
    prepareNodeArtifacts,
    resumeProvision,
  };
}
