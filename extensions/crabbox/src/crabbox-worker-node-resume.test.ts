import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import {
  resolveTestNodeExecPath,
  useAutoCleanupTempDirTracker,
} from "openclaw/plugin-sdk/test-env";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  withinTest,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { createCrabboxNodeResumeScript } from "./crabbox-worker-node-resume.js";

const temporary = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

describe("enrolled node resume", () => {
  it.for(["retained", "wrong-device", "wrong-runtime", "setup-failed"] as const)(
    "preserves the lease workspace and resumes only its %s identity",
    async (scenario, { signal }) => {
      const receipts = await openFixtureReceiptChannel();
      const home = fs.realpathSync(temporary.make("crabbox-node-resume-"));
      const node = resolveTestNodeExecPath();
      const oldBin = path.join(home, "old-bin");
      const managedBin = path.join(home, "managed-bin");
      const binding = path.join(home, ".openclaw-worker", "runtime-node");
      const oldNode = path.join(oldBin, "node");
      const preload = path.join(home, "old-node.cjs");
      const preparation = path.join(home, "node-preparations");
      for (const directory of [oldBin, managedBin, binding]) {
        fs.mkdirSync(directory, { recursive: true });
      }
      fs.writeFileSync(
        preload,
        `Object.defineProperty(process, "execPath", { value: ${JSON.stringify(oldNode)} });\nObject.defineProperty(process.versions, "node", { value: "24.21.0" });\n`,
      );
      fs.writeFileSync(oldNode, `#!/bin/sh\nexec '${node}' --require '${preload}' "$@"\n`, {
        mode: 0o700,
      });
      fs.symlinkSync(node, path.join(managedBin, "node"));
      fs.symlinkSync(oldNode, path.join(binding, "node"));
      const request = {
        leaseId: "cbx_resume_fixture",
        deviceId: "retained-device",
        nodeBootstrapSha256: "a".repeat(64),
        openclawVersion: "2026.10.3",
        linuxToolchainSetup:
          scenario === "setup-failed"
            ? "exit 9\n"
            : `printf prepared >> '${preparation}'\nexport PATH='${managedBin}':"$PATH"\n`,
      };
      const state = path.join(home, ".openclaw", "cloud-workers", request.leaseId);
      const runtime = path.join(
        home,
        ".openclaw-worker",
        "node-runtimes",
        request.nodeBootstrapSha256,
      );
      const packageRoot = path.join(runtime, "node_modules", "openclaw");
      fs.mkdirSync(state, { recursive: true });
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.symlinkSync(runtime, path.join(state, "runtime"));
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: request.openclawVersion }),
      );
      fs.writeFileSync(path.join(state, "dirty-workspace"), "unpublished work and unknown effects");
      // A positively dead PID, not an absent launch receipt or a live unrelated process.
      const exited = spawn(process.execPath, ["-e", ""]);
      await once(exited, "close");
      fs.writeFileSync(path.join(state, "node.pid"), String(exited.pid));
      fs.writeFileSync(
        path.join(packageRoot, "openclaw.mjs"),
        `
import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}
if (process.argv[3] === "identity") {
  console.log(JSON.stringify({deviceId: ${JSON.stringify(scenario === "wrong-device" ? "other-device" : request.deviceId)}}));
} else {
  process.title = "openclaw-node";
  fs.writeFileSync(${JSON.stringify(path.join(state, "launched-node"))}, process.execPath);
  sendReceipt(${JSON.stringify(state)}, "ready");
  process.on("SIGTERM", () => { sendReceipt(${JSON.stringify(state)}, "stopped"); process.exit(0); });
  setInterval(() => {}, 60000);
}`,
      );
      let pid: number | undefined;
      const run = async () => {
        const child = spawn("/bin/sh", [], {
          env: { ...process.env, HOME: home },
          stdio: ["pipe", "ignore", "pipe"],
        });
        let error = "";
        child.stderr.on("data", (value: Buffer) => {
          error += value.toString();
        });
        child.stdin.end(
          createCrabboxNodeResumeScript({
            ...request,
            ...(scenario === "wrong-runtime" ? { nodeBootstrapSha256: "b".repeat(64) } : {}),
          }),
        );
        const [code] = await once(child, "close");
        return { code, error };
      };
      try {
        const result = await run();
        if (result.code === 0) {
          const actual = Number(fs.readFileSync(path.join(state, "node.pid"), "utf8"));
          if (actual !== exited.pid) {
            pid = actual;
          }
          await withinTest(receipts.waitFor(state, "ready"), signal);
        }
        if (scenario === "retained") {
          expect(result).toEqual({ code: 0, error: "" });
          expect(fs.readFileSync(path.join(state, "launched-node"), "utf8")).toBe(node);
          expect(fs.readlinkSync(path.join(binding, "node"))).toBe(node);
          expect(fs.readFileSync(preparation, "utf8")).toBe("prepared");
          expect(await run()).toEqual({ code: 0, error: "" });
          expect(fs.readFileSync(preparation, "utf8")).toBe("prepared");
          expect(Number(fs.readFileSync(path.join(state, "node.pid"), "utf8"))).toBe(pid);
          expect(fs.existsSync(path.join(state, "setup-code"))).toBe(false);
        } else {
          expect(result.code).toBe(1);
          expect(fs.readFileSync(path.join(state, "node.pid"), "utf8")).toBe(String(exited.pid));
          expect(fs.existsSync(preparation)).toBe(false);
        }
        expect(fs.readFileSync(path.join(state, "dirty-workspace"), "utf8")).toBe(
          "unpublished work and unknown effects",
        );
        expect(fs.realpathSync(path.join(state, "runtime"))).toBe(runtime);
      } finally {
        if (pid) {
          process.kill(pid, "SIGTERM");
          await withinTest(receipts.waitFor(state, "stopped"), signal);
        }
        await receipts.close();
      }
    },
  );
});
