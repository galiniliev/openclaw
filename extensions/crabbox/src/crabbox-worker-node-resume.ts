import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { crabboxCommandError, leaseRunArgs, runCrabboxCommand } from "./crabbox-worker-command.js";
import { createCrabboxNodeEnrollmentSetup } from "./crabbox-worker-node-enrollment.js";
import { createCrabboxNodeResumeScript } from "./crabbox-worker-node-process.js";
import {
  assertCrabboxLeaseId,
  parseCrabboxProfile,
  resolveCrabboxProfileCommandEnv,
} from "./crabbox-worker-profile.js";

// Both ordinary command lifecycles include remote preparation and retirement.
// The caller’s admission signal can end work earlier; cleanup retains custody.
const RESUME_WORK_TIMEOUT_MS = 120_000;
// Let Crabbox finish its 15-second remote cleanup before forcing the local tree.
const RESUME_KILL_GRACE_MS = 20_000;

export function createCrabboxNodeResumer(options: {
  signal: AbortSignal;
  resolveBinary: (binary?: string, signal?: AbortSignal) => Promise<{ binary: string }>;
}): NonNullable<WorkerProvider["resumeNode"]> {
  return async (request) => {
    const signal = AbortSignal.any([request.signal, options.signal]);
    const assertCurrent = () => {
      signal.throwIfAborted();
      request.assertCurrent();
    };
    assertCurrent();
    const profile = parseCrabboxProfile(request.profile);
    // Linux upgrades reuse enrollment's XFCE environment owner. Other desktop
    // resumes keep their platform launcher's environment and process receipts.
    if (request.platform !== "linux" || (profile.desktop && !request.runtime)) {
      return;
    }
    assertCrabboxLeaseId(request.leaseId);
    const { binary } = await options.resolveBinary(profile.binary, signal);
    if (request.runtime) {
      const setup = createCrabboxNodeEnrollmentSetup({
        leaseId: request.leaseId,
        desktop: profile.desktop,
        target: "linux",
        workerBundle: request.runtime.workerBundle,
        enrollment: {
          mode: "resume",
          deviceId: request.deviceId,
          nodeBootstrap: request.runtime.nodeBootstrap,
          bootstrapTimeoutMs: request.runtime.bootstrapTimeoutMs,
          openclawVersion: request.openclawVersion,
          displayName: "Cloud worker",
          waitForDeviceId: async () => request.deviceId,
        },
      });
      const result = await runCrabboxCommand({
        action: "node runtime upgrade",
        binary,
        providerEnv: resolveCrabboxProfileCommandEnv(profile),
        args: [
          ...leaseRunArgs(
            { binary, provider: profile.provider, id: request.leaseId },
            Object.keys(setup.forwardedEnv),
          ),
          "--no-hydrate",
        ],
        input: setup.command,
        env: { ...process.env, ...setup.forwardedEnv },
        signal: request.runtime.signal ? AbortSignal.any([signal, request.runtime.signal]) : signal,
        timeoutMs: request.runtime.bootstrapTimeoutMs ?? 10 * 60_000,
        killGraceMs: RESUME_KILL_GRACE_MS,
      });
      assertCurrent();
      if (result.termination !== "exit" || result.code !== 0) {
        throw crabboxCommandError("node runtime upgrade", result);
      }
      return;
    }
    const deadline = performance.now() + RESUME_WORK_TIMEOUT_MS;
    for (const phase of ["inspect", "launch"] as const) {
      // The read-only identity probe can await runtime startup. Its completion
      // never carries authority into the separately admitted write invocation.
      assertCurrent();
      const timeoutMs = Math.ceil(deadline - performance.now());
      if (timeoutMs <= 0) {
        throw new Error(`Crabbox node resume exceeded its ${RESUME_WORK_TIMEOUT_MS}ms deadline`);
      }
      const result = await runCrabboxCommand({
        action: "node resume",
        binary,
        providerEnv: resolveCrabboxProfileCommandEnv(profile),
        args: [
          ...leaseRunArgs({ binary, provider: profile.provider, id: request.leaseId }),
          "--no-hydrate",
        ],
        input: createCrabboxNodeResumeScript(request, phase),
        signal,
        timeoutMs,
        killGraceMs: RESUME_KILL_GRACE_MS,
      });
      assertCurrent();
      if (result.termination !== "exit" || result.code !== 0) {
        throw crabboxCommandError("node resume", result);
      }
    }
  };
}
