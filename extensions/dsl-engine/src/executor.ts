import { Worker } from "node:worker_threads";
import type { DslHydration, DslExecutionResult } from "./types.js";

const DEFAULT_MAX_CODE_BYTES = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_TIMEOUT_MS = 120000;

export interface ExecuteDslOptions {
  timeoutMs?: number;
  extraGlobals?: Record<string, unknown>;
}

type ScopeRoot = "namespace" | "extraGlobals";

type SerializedScopeValue =
  | { kind: "function"; root: ScopeRoot; path: string[] }
  | { kind: "array"; items: SerializedScopeValue[] }
  | { kind: "object"; entries: Array<[string, SerializedScopeValue]> }
  | { kind: "value"; value: unknown };

type WorkerDoneMessage = {
  type: "done";
  result?: unknown;
  consoleOutput: string[];
};

type WorkerFailedMessage = {
  type: "failed";
  error: string;
  consoleOutput: string[];
};

type WorkerCallMessage = {
  type: "call";
  id: number;
  root: ScopeRoot;
  path: string[];
  args: unknown[];
};

type WorkerMessage = WorkerDoneMessage | WorkerFailedMessage | WorkerCallMessage;

const DSL_EXECUTOR_WORKER_SOURCE = String.raw`
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";

const pendingCalls = new Map();
let nextCallId = 1;
const consoleOutput = [];

function stringifyConsoleArg(arg) {
  if (typeof arg === "string") return arg;
  if (typeof arg === "undefined") return "undefined";
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function makeRemoteFunction(root, path) {
  return (...args) => new Promise((resolve, reject) => {
    const id = nextCallId++;
    pendingCalls.set(id, { resolve, reject });
    parentPort.postMessage({ type: "call", id, root, path, args });
  });
}

function deserialize(value) {
  if (!value || typeof value !== "object") return value;
  if (value.kind === "function") {
    return makeRemoteFunction(value.root, value.path);
  }
  if (value.kind === "array") {
    return value.items.map(deserialize);
  }
  if (value.kind === "object") {
    const result = {};
    for (const [key, child] of value.entries) {
      result[key] = deserialize(child);
    }
    return result;
  }
  return value.value;
}

function compileCollectionClass(name, source) {
  try {
    return Function('"use strict"; return (' + source + ');')();
  } catch (err) {
    throw new Error("Failed to compile collection class " + name + ": " + (err && err.message ? err.message : String(err)));
  }
}

parentPort.on("message", (message) => {
  if (!message || message.type !== "callResult") return;
  const pending = pendingCalls.get(message.id);
  if (!pending) return;
  pendingCalls.delete(message.id);
  if (message.ok) {
    pending.resolve(message.result);
  } else {
    pending.reject(new Error(message.error || "DSL API call failed"));
  }
});

try {
  try {
    const context = {
      [workerData.namespaceName]: deserialize(workerData.namespace),
      console: {
        log: (...args) => consoleOutput.push(args.map(stringifyConsoleArg).join(" ")),
        warn: (...args) => consoleOutput.push("WARN: " + args.map(stringifyConsoleArg).join(" ")),
        error: (...args) => consoleOutput.push("ERROR: " + args.map(stringifyConsoleArg).join(" ")),
      },
      JSON,
      setTimeout,
      clearTimeout,
      Promise,
    };

    for (const [name, source] of workerData.collectionClassSources) {
      context[name] = compileCollectionClass(name, source);
    }

    const extraGlobals = deserialize(workerData.extraGlobals);
    if (extraGlobals && typeof extraGlobals === "object") {
      Object.assign(context, extraGlobals);
    }

    const script = new vm.Script('"use strict"; (async () => {\n' + workerData.code + '\n})()', {
      filename: workerData.filename,
    });
    const resultPromise = script.runInNewContext(context, {
      timeout: workerData.timeoutMs,
    });

    resultPromise.then(
      (result) => {
        const finalResult = result === undefined && consoleOutput.length > 0 ? consoleOutput.join("\n") : result;
        parentPort.postMessage({ type: "done", result: finalResult, consoleOutput });
      },
      (err) => {
        parentPort.postMessage({
          type: "failed",
          error: err && err.message ? err.message : String(err),
          consoleOutput,
        });
      },
    );
  } catch (err) {
    parentPort.postMessage({
      type: "failed",
      error: err && err.message ? err.message : String(err),
      consoleOutput,
    });
  }
} catch (err) {
  parentPort.postMessage({
    type: "failed",
    error: err && err.message ? err.message : String(err),
    consoleOutput,
  });
}
`;

export async function executeDsl<TApi, TNamespace>(
  code: string,
  hydration: DslHydration<TApi, TNamespace>,
  namespace: TNamespace,
  opts?: ExecuteDslOptions,
): Promise<DslExecutionResult> {
  const maxBytes = hydration.maxCodeBytes ?? DEFAULT_MAX_CODE_BYTES;
  const codeBytes = new TextEncoder().encode(code).length;
  if (codeBytes > maxBytes) {
    return {
      kind: "Failed",
      error: `Code size (${codeBytes} bytes) exceeds maximum allowed (${maxBytes} bytes)`,
      consoleOutput: [],
    };
  }

  const timeoutMs = resolveTimeoutMs(hydration, opts?.timeoutMs);

  try {
    const workerData = {
      code,
      filename: `${hydration.id || "dsl"}-generated.js`,
      timeoutMs,
      namespaceName: assertIdentifier(hydration.namespaceName, "namespaceName"),
      namespace: serializeScopeValue(namespace, "namespace", []),
      collectionClassSources: Object.entries(hydration.collectionClasses).map(([name, cls]) => [
        assertIdentifier(name, "collection class name"),
        Function.prototype.toString.call(cls),
      ]),
      extraGlobals: serializeScopeValue(opts?.extraGlobals ?? {}, "extraGlobals", []),
    };

    return await runWorker(workerData, { namespace, extraGlobals: opts?.extraGlobals ?? {} }, timeoutMs);
  } catch (err) {
    return {
      kind: "Failed",
      error: err instanceof Error ? err.message : String(err),
      consoleOutput: [],
    };
  }
}

function resolveTimeoutMs<TApi, TNamespace>(
  hydration: DslHydration<TApi, TNamespace>,
  requestedTimeoutMs: number | undefined,
): number {
  const defaultTimeout = hydration.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeout = hydration.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const timeout = requestedTimeoutMs ?? defaultTimeout;
  return Math.max(1, Math.min(timeout, maxTimeout));
}

function assertIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error(`Invalid DSL ${label}: ${value}`);
  }
  return value;
}

function serializeScopeValue(
  value: unknown,
  root: ScopeRoot,
  path: string[],
  seen = new WeakSet<object>(),
): SerializedScopeValue {
  if (typeof value === "function") {
    return { kind: "function", root, path };
  }

  if (value === null || typeof value !== "object") {
    return { kind: "value", value };
  }

  if (seen.has(value)) {
    throw new Error(`Cannot inject circular DSL scope value at ${path.join(".") || root}`);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return {
      kind: "array",
      items: value.map((item, index) => serializeScopeValue(item, root, [...path, String(index)], seen)),
    };
  }

  const entries = Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    serializeScopeValue(child, root, [...path, key], seen),
  ] satisfies [string, SerializedScopeValue]);
  return { kind: "object", entries };
}

async function runWorker(
  workerData: unknown,
  roots: { namespace: unknown; extraGlobals: Record<string, unknown> },
  timeoutMs: number,
): Promise<DslExecutionResult> {
  return await new Promise<DslExecutionResult>((resolve) => {
    const worker = new Worker(DSL_EXECUTOR_WORKER_SOURCE, {
      eval: true,
      type: "module",
      workerData,
    });
    let settled = false;
    const timeout = setTimeout(() => {
      settle({
        kind: "Failed",
        error: `Execution timed out after ${timeoutMs}ms`,
        consoleOutput: [],
      });
      void worker.terminate();
    }, timeoutMs);

    const settle = (result: DslExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    worker.on("message", (message: WorkerMessage) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "done") {
        settle({
          kind: "Succeeded",
          result: message.result,
          consoleOutput: message.consoleOutput,
        });
        void worker.terminate();
        return;
      }
      if (message.type === "failed") {
        settle({
          kind: "Failed",
          error: message.error,
          consoleOutput: message.consoleOutput,
        });
        void worker.terminate();
        return;
      }
      if (message.type === "call") {
        void handleWorkerCall(worker, roots, message);
      }
    });

    worker.on("error", (err) => {
      settle({
        kind: "Failed",
        error: err.message,
        consoleOutput: [],
      });
    });

    worker.on("exit", (code) => {
      if (!settled && code !== 0) {
        settle({
          kind: "Failed",
          error: `DSL worker exited with code ${code}`,
          consoleOutput: [],
        });
      }
    });
  });
}

async function handleWorkerCall(
  worker: Worker,
  roots: { namespace: unknown; extraGlobals: Record<string, unknown> },
  message: WorkerCallMessage,
): Promise<void> {
  try {
    const root = message.root === "namespace" ? roots.namespace : roots.extraGlobals;
    const target = resolvePath(root, message.path);
    if (typeof target !== "function") {
      throw new Error(`DSL scope path is not callable: ${message.path.join(".")}`);
    }
    const parent = message.path.length > 0 ? resolvePath(root, message.path.slice(0, -1)) : undefined;
    const result = await target.apply(parent, message.args);
    worker.postMessage({ type: "callResult", id: message.id, ok: true, result });
  } catch (err) {
    worker.postMessage({
      type: "callResult",
      id: message.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function resolvePath(root: unknown, path: string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
