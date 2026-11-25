import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createCrabboxNodeEnrollmentSetup } from "./crabbox-worker-node-enrollment.js";
import { cacheFixtureSource } from "./crabbox-worker-runtime-cache.test-support.js";

it.skipIf(process.platform !== "linux")(
  "bounds caches after real resume while preserving predecessor, saved and live runtimes",
  () => {
    const setup = createCrabboxNodeEnrollmentSetup({
      leaseId: "cbx_cache_fixture",
      target: "linux",
      enrollment: {
        mode: "resume",
        deviceId: "cache-device",
        displayName: "Cloud worker",
        openclawVersion: "2026.8.1",
        nodeBootstrap: {
          url: "https://unused.example.test/node",
          token: "synthetic",
          sha256: "b".repeat(64),
          bytes: 1,
          openclawVersion: "2026.8.1",
          install: "bundle",
          buildId: "cache-current",
          manifestSha256: createHash("sha256").update("[]").digest("hex"),
          enabledPluginIds: [],
        },
        waitForDeviceId: async () => "cache-device",
      },
    });
    const delimiter = "CRABBOX_NODE_ENROLLMENT_SCRIPT";
    const marker = "node <<'" + delimiter + "'\n";
    const begin = setup.command.indexOf(marker);
    const end = setup.command.lastIndexOf("\n" + delimiter);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const result = spawnSync(process.execPath, ["-"], {
      input: cacheFixtureSource(setup.command.slice(begin + marker.length, end)),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
  },
  35_000,
);
