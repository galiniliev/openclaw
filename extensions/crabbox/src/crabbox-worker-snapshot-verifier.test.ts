import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createCrabboxSnapshotVerifierScript,
  readCrabboxSnapshotVerifierResult,
  type CrabboxSnapshotVerifierInput,
} from "./crabbox-worker-snapshot-verifier.js";

const input: CrabboxSnapshotVerifierInput = {
  schema: "openclaw.snapshot-verifier-input.v1",
  preparedProject: {
    namespace: "gateway",
    seedKey: "a".repeat(64),
    cacheKey: "b".repeat(64),
    baseCommit: "c".repeat(40),
    workspaceDir: "/synthetic/workspace",
    homeDir: "/synthetic/home",
    sourceManifestRef: "sha256:" + "d".repeat(64),
    preparedManifestRef: "sha256:" + "e".repeat(64),
  },
  currentRuntime: {
    nodeBootstrap: {
      sha256: "f".repeat(64),
      bytes: 1,
      openclawVersion: "2026.10.4",
      buildId: "current-build",
      manifestSha256: "1".repeat(64),
      enabledPluginIds: ["codex"],
    },
    workerBundle: {
      sha256: "2".repeat(64),
      bytes: 1,
      packageRelativePath: "worker-artifacts/runtime.tgz",
      bundleHash: "3".repeat(64),
    },
  },
};

function run(program: string) {
  return execFileSync(
    process.execPath,
    ["-e", createCrabboxSnapshotVerifierScript([process.execPath, "-e", program], input)],
    { encoding: "utf8" },
  );
}

describe("snapshot verifier private process boundary", () => {
  it("passes exact current descriptors on stdin and retains the complete successful receipt", () => {
    const result = readCrabboxSnapshotVerifierResult(
      run(
        `let input=""; process.stdin.on("data", bytes=>input+=bytes); process.stdin.on("end",()=>process.stdout.write(input));`,
      ),
    );
    expect(JSON.parse(result.receipt!)).toEqual(input);
    expect(result.child).toMatchObject({
      status: 0,
      signal: null,
      errorCode: null,
      stderrBytes: 0,
    });
  });

  it.each(["closed", "private", "oversize"] as const)(
    "keeps only closed metadata when verifier fails: %s",
    (kind) => {
      const stderr =
        kind === "closed"
          ? JSON.stringify({
              schema: "teamclaw.snapshot-verifier-diagnostic.v1",
              stage: "clean_state",
              predicate: "credential_paths",
              secret: "synthetic-private-value",
            })
          : "synthetic-private-value";
      const result = run(
        `process.stdout.write("private-stdout"); process.stderr.write(${JSON.stringify(stderr)}${kind === "oversize" ? ".repeat(100000)" : ""}); process.exitCode=7;`,
      );
      expect(result).not.toContain("synthetic-private-value");
      expect(result).not.toContain("private-stdout");
      const projected = readCrabboxSnapshotVerifierResult(result);
      expect(projected.receipt).toBeUndefined();
      if (kind === "closed") {
        expect(projected.child.diagnostic).toEqual({
          stage: "clean_state",
          predicate: "credential_paths",
        });
      } else {
        expect(projected.child.diagnostic).toBeUndefined();
      }
    },
  );

  it.each([
    { credentialRoot: "machine-home", credentialPath: ".npm", cleanCheck: "before-probes" },
    {
      credentialRoot: "project-home",
      credentialPath: ".cargo/credentials.toml",
      cleanCheck: "after-probes",
    },
    {
      credentialRoot: "project-workspace",
      credentialPath: ".scratch/npmrc",
      cleanCheck: "before-probes",
    },
  ])(
    "retains only fixed credential-path classes through both process boundaries ($credentialRoot)",
    (details) => {
      const diagnostic = {
        schema: "teamclaw.snapshot-verifier-diagnostic.v1",
        stage: "clean_state",
        predicate: "credential_paths",
        ...details,
        private: "synthetic-private-value",
      };
      const wire = run(
        `process.stderr.write(${JSON.stringify(JSON.stringify(diagnostic))}); process.exitCode=1;`,
      );
      const result = readCrabboxSnapshotVerifierResult(wire);
      expect(result.child.status).toBe(1);
      expect(result.receipt).toBeUndefined();
      expect(result.child.diagnostic).toEqual({
        stage: "clean_state",
        predicate: "credential_paths",
        ...details,
      });
      expect(wire).not.toContain("synthetic-private-value");
      // The host boundary must also discard untrusted fields without relying on the worker wrapper.
      const hostile = JSON.parse(wire);
      Object.assign(hostile.child.diagnostic, {
        credentialRoot: "/private/synthetic-home",
        credentialPath: "../synthetic-secret",
        cleanCheck: "unknown-check",
        private: "synthetic-private-value",
      });
      expect(readCrabboxSnapshotVerifierResult(JSON.stringify(hostile)).child.diagnostic).toEqual({
        stage: "clean_state",
        predicate: "credential_paths",
      });
    },
  );

  it.each([
    {
      stage: "clean_state",
      predicate: "credential_paths",
      credentialRoot: "/private/synthetic-home",
      credentialPath: "/synthetic/token",
      cleanCheck: "unknown-check",
    },
    {
      stage: "tooling",
      predicate: "credential_paths",
      credentialRoot: "machine-home",
      credentialPath: ".npm",
      cleanCheck: "before-probes",
    },
    {
      stage: "clean_state",
      predicate: "credential_environment",
      credentialRoot: "project-home",
      credentialPath: ".npmrc",
      cleanCheck: "after-probes",
    },
  ])("does not project unsafe or out-of-stage credential details (%j)", (details) => {
    const diagnostic = { schema: "teamclaw.snapshot-verifier-diagnostic.v1", ...details };
    const wire = run(
      `process.stderr.write(${JSON.stringify(JSON.stringify(diagnostic))}); process.exitCode=1;`,
    );
    const result = readCrabboxSnapshotVerifierResult(wire);
    expect(result.child.status).toBe(1);
    expect(result.child.diagnostic).toEqual({ stage: details.stage, predicate: details.predicate });
    const hostile = JSON.parse(wire);
    hostile.child.diagnostic = diagnostic;
    expect(readCrabboxSnapshotVerifierResult(JSON.stringify(hostile)).child.diagnostic).toEqual({
      stage: details.stage,
      predicate: details.predicate,
    });
  });

  it("projects away extra remote metadata and rejects invented error codes", () => {
    const result = JSON.parse(run("process.exitCode=1"));
    result.child.private = "synthetic-private-value";
    expect(JSON.stringify(readCrabboxSnapshotVerifierResult(JSON.stringify(result)))).not.toContain(
      "synthetic-private-value",
    );
    result.child.errorCode = "synthetic-private-value";
    expect(() => readCrabboxSnapshotVerifierResult(JSON.stringify(result))).toThrow(
      "invalid child metadata",
    );
  });
});
