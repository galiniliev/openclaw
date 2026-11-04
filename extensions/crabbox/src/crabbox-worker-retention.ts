import type {
  WorkerProvider,
  WorkerRetainedLeaseReceipt,
  WorkerRetainedLeaseRequest,
  WorkerLeaseStatus,
} from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  runCrabboxCommand,
  crabboxCommandOutput,
  parseCrabboxJson,
  type LeaseCommandContext,
} from "./crabbox-worker-command.js";
import { parseCrabboxProfile, resolveCrabboxProfileCommandEnv } from "./crabbox-worker-profile.js";

export function parseCrabboxRetention(value: unknown): WorkerRetainedLeaseReceipt {
  if (
    !isRecord(value) ||
    value.schema !== "crabbox.session-disk.v1" ||
    value.mode !== "session-disk" ||
    typeof value.ownerBinding !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.ownerBinding) ||
    typeof value.claimRevision !== "string" ||
    !value.claimRevision ||
    typeof value.computeWindowSeconds !== "number" ||
    !Number.isSafeInteger(value.computeWindowSeconds) ||
    value.computeWindowSeconds <= 0 ||
    (value.desiredState !== "running" &&
      value.desiredState !== "suspended" &&
      value.desiredState !== "retired") ||
    typeof value.policyVerified !== "boolean" ||
    typeof value.observedState !== "string" ||
    typeof value.stopPending !== "boolean" ||
    !isRecord(value.identity) ||
    !isRecord(value.computeWindow)
  ) {
    throw new Error("Crabbox retained lease receipt is missing or invalid; replacement refused");
  }
  const identity = value.identity;
  for (const key of ["leaseId", "attemptLeaseId", "slug", "resourceId"] as const) {
    if (typeof identity[key] !== "string" || !identity[key] || identity[key].length > 2048) {
      throw new Error("Crabbox retained resource identity is incomplete");
    }
  }
  const window = value.computeWindow;
  if (
    typeof window.id !== "string" ||
    !window.id ||
    typeof window.authorizedAt !== "string" ||
    !Number.isFinite(Date.parse(window.authorizedAt)) ||
    typeof window.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(window.expiresAt)) ||
    Date.parse(window.expiresAt) <= Date.parse(window.authorizedAt) ||
    (window.state !== "active" && window.state !== "closed")
  ) {
    throw new Error("Crabbox retained compute window is invalid");
  }
  let operation: WorkerRetainedLeaseReceipt["operation"];
  if (value.operation !== undefined) {
    const op = value.operation;
    if (
      !isRecord(op) ||
      typeof op.id !== "string" ||
      !op.id ||
      (op.action !== "pause" && op.action !== "resume") ||
      (op.phase !== "pending" && op.phase !== "observed") ||
      typeof op.expectedClaimRevision !== "string" ||
      !op.expectedClaimRevision
    ) {
      throw new Error("Crabbox retained lifecycle operation is invalid");
    }
    operation = {
      id: op.id,
      action: op.action,
      phase: op.phase,
      expectedClaimRevision: op.expectedClaimRevision,
    };
  }
  // The boundary above admits the external CLI receipt once; core consumes typed facts.
  return {
    schema: value.schema,
    mode: "session-disk",
    ownerBinding: value.ownerBinding,
    claimRevision: value.claimRevision,
    computeWindowSeconds: value.computeWindowSeconds,
    desiredState: value.desiredState,
    identity: {
      leaseId: String(identity.leaseId),
      attemptLeaseId: String(identity.attemptLeaseId),
      slug: String(identity.slug),
      resourceId: String(identity.resourceId),
    },
    computeWindow: {
      id: window.id,
      authorizedAt: window.authorizedAt,
      expiresAt: window.expiresAt,
      state: window.state,
    },
    policyVerified: value.policyVerified,
    observedState: value.observedState,
    stopPending: value.stopPending,
    ...(operation ? { operation } : {}),
  };
}

export function crabboxRetentionIdentityArgs(receipt: WorkerRetainedLeaseReceipt): string[] {
  return [
    "--expected-provider-lease-id",
    receipt.identity.leaseId,
    "--expected-provider-attempt-lease-id",
    receipt.identity.attemptLeaseId,
    "--expected-provider-slug",
    receipt.identity.slug,
    "--expected-provider-resource-id",
    receipt.identity.resourceId,
  ];
}

export function createCrabboxRetainedLeaseOperations(
  resolveBinary: (binary?: string, signal?: AbortSignal) => Promise<{ binary: string }>,
  onImageLeaseDestroyed?: (
    context: LeaseCommandContext & { assertCurrent: () => void; signal?: AbortSignal },
  ) => Promise<void>,
  releaseRejectedSnapshot?: (
    context: LeaseCommandContext & {
      retention: WorkerRetainedLeaseRequest["retention"];
      assertCurrent: () => void;
      signal: AbortSignal;
    },
  ) => Promise<boolean>,
): NonNullable<WorkerProvider["retainedLease"]> {
  const run = async (
    action: "inspect" | "pause" | "resume",
    request: WorkerRetainedLeaseRequest & { operationId?: string },
  ) => {
    request.assertCurrent();
    const profile = parseCrabboxProfile(request.profile);
    if (profile.provider !== "azure-sandbox" || profile.target !== "linux") {
      throw new Error("Session disk retention requires Linux Azure Sandbox");
    }
    const { binary } = await resolveBinary(profile.binary, request.signal);
    request.assertCurrent();
    const receipt = request.retention.receipt;
    if (
      action !== "inspect" &&
      (!receipt || !request.retention.operation || !request.operationId)
    ) {
      throw new Error("Retained lifecycle operation has no durable exact receipt");
    }
    const result = await runCrabboxCommand({
      binary,
      providerEnv: resolveCrabboxProfileCommandEnv(profile),
      action: `retained ${action}`,
      args: [
        action === "inspect" ? "status" : action,
        "--provider",
        profile.provider,
        "--id",
        request.leaseId,
        "--json",
        ...(action === "inspect"
          ? []
          : [
              "--operation-id",
              request.operationId!,
              "--owner-binding",
              request.retention.ownerBinding,
              "--expected-claim-revision",
              request.retention.operation!.expectedClaimRevision,
              ...crabboxRetentionIdentityArgs(receipt!),
            ]),
      ],
      timeoutMs: 120_000,
      signal: request.signal,
    });
    request.assertCurrent();
    const value = parseCrabboxJson(crabboxCommandOutput(`retained ${action}`, result), action);
    if (!isRecord(value) || value.id !== request.leaseId) {
      throw new Error("Retained lease status identity changed");
    }
    return { receipt: parseCrabboxRetention(value.retention), state: value.state };
  };
  return {
    async destroy(request) {
      request.assertCurrent();
      const profile = parseCrabboxProfile(request.profile);
      const { binary } = await resolveBinary(profile.binary, request.signal);
      request.assertCurrent();
      if (
        await releaseRejectedSnapshot?.({
          binary,
          id: request.leaseId,
          provider: profile.provider,
          providerEnv: resolveCrabboxProfileCommandEnv(profile),
          retention: request.retention,
          assertCurrent: request.assertCurrent,
          signal: request.signal,
        })
      ) {
        request.assertCurrent();
        return;
      }
      const { receipt: observed } = await run("inspect", request);
      if (
        observed.ownerBinding !== request.retention.ownerBinding ||
        (request.retention.receipt &&
          JSON.stringify(observed.identity) !== JSON.stringify(request.retention.receipt.identity))
      ) {
        throw new Error("Retained cleanup resource identity changed");
      }
      request.assertCurrent();
      const stopped = await runCrabboxCommand({
        binary,
        providerEnv: resolveCrabboxProfileCommandEnv(profile),
        action: "retained delete",
        args: [
          "stop",
          "--provider",
          profile.provider,
          "--id",
          request.leaseId,
          ...crabboxRetentionIdentityArgs(observed),
        ],
        signal: request.signal,
        timeoutMs: 120_000,
      });
      crabboxCommandOutput("retained delete", stopped);
      request.assertCurrent();
      const confirmed = await run("inspect", request);
      if (confirmed.state !== "deleted" || confirmed.receipt.desiredState !== "retired") {
        throw new Error(
          "Retained deletion is not independently confirmed; cleanup remains pending",
        );
      }
      if (profile.sdkPython) {
        request.assertCurrent();
        await onImageLeaseDestroyed?.({
          binary,
          id: request.leaseId,
          provider: profile.provider,
          providerEnv: resolveCrabboxProfileCommandEnv(profile),
          assertCurrent: request.assertCurrent,
          signal: request.signal,
        });
      }
    },
    inspect: async (request) => {
      const observed = await run("inspect", request);
      if (observed.state === "unknown") {
        throw new Error("Retained worker resource observation is unknown; ownership is preserved");
      }
      // A missing exact resource is an observation, not deletion finality.
      return observed.state === "missing"
        ? { ...observed.receipt, observedState: "missing" }
        : observed.receipt;
    },
    pause: async (request) => (await run("pause", request)).receipt,
    resume: async (request) => (await run("resume", request)).receipt,
  };
}

/** Compiled provider metadata is process-stable for this provider generation. */
export function createCrabboxRetentionCapabilityReader() {
  const admitted = new Map<string, Promise<void>>();
  return (binary: string, signal?: AbortSignal): Promise<void> => {
    let pending = admitted.get(binary);
    if (!pending) {
      pending = (async () => {
        const { runCrabboxProcess } = await import("./crabbox-process.js");
        const result = await runCrabboxProcess([binary, "providers", "--json"], {
          timeoutMs: 15_000,
          maxOutputBytes: 1024 * 1024,
          killProcessTree: true,
          signal,
        });
        const catalog = parseCrabboxJson(
          crabboxCommandOutput("provider capabilities", result),
          "provider capabilities",
        );
        const provider = Array.isArray(catalog)
          ? catalog.find((entry: unknown) => isRecord(entry) && entry.provider === "azure-sandbox")
          : undefined;
        if (
          !isRecord(provider) ||
          !Array.isArray(provider.features) ||
          !provider.features.includes("session-disk-retention-v1") ||
          !provider.features.includes("pause-resume")
        ) {
          throw new Error(
            "Installed Crabbox does not support session disk retention; update the matched controller/runtime pack",
          );
        }
      })().catch((error: unknown) => {
        admitted.delete(binary);
        throw error;
      });
      admitted.set(binary, pending);
    }
    return pending;
  };
}

/** Generic lease inspection consumes the same retained receipt as lifecycle operations. */
export async function inspectCrabboxRetainedLease(
  request: WorkerRetainedLeaseRequest,
  operations: NonNullable<WorkerProvider["retainedLease"]>,
): Promise<WorkerLeaseStatus> {
  const receipt = await operations.inspect(request);
  const missing = receipt.observedState === "missing";
  if (
    receipt.ownerBinding !== request.retention.ownerBinding ||
    (!receipt.policyVerified && !missing) ||
    (request.retention.receipt &&
      JSON.stringify(receipt.identity) !== JSON.stringify(request.retention.receipt.identity))
  ) {
    throw new Error("Retained lease identity or policy is unavailable; replacement refused");
  }
  return {
    status: missing
      ? "unknown"
      : receipt.desiredState === "running" &&
          !receipt.stopPending &&
          receipt.computeWindow.state === "active" &&
          Date.parse(receipt.computeWindow.expiresAt) > Date.now()
        ? "active"
        : "dormant",
  };
}
