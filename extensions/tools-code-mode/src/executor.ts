import { Worker } from "node:worker_threads";
import type { CodeModeHydration, CodeModeExecutionResult } from "./types.js";
import { CodeModeError } from "./errors.js";

const DEFAULT_MAX_CODE_BYTES = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_TIMEOUT_MS = 120000;
const DEFAULT_MAX_MEMORY_MB = 1024;
const DEFAULT_MAX_CONCURRENCY = 4;

const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export interface ExecuteCodeModeOptions {
  timeoutMs?: number;
  extraGlobals?: Record<string, unknown>;
  toolCallId?: string;
}

export interface CodeModeExecutorConfig {
  maxConcurrency?: number;
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

// P0 #1 fix: Promise and setTimeout are created inside the VM context via vm.runInContext,
// preventing realm leakage (attacker can't reach host via Promise.constructor.constructor).
const CODE_MODE_WORKER_SOURCE = String.raw`
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
    const result = Object.create(null);
    for (const [key, child] of value.entries) {
      result[key] = deserialize(child);
    }
    return result;
  }
  return value.value;
}

parentPort.on("message", (message) => {
  if (!message || message.type !== "callResult") return;
  const pending = pendingCalls.get(message.id);
  if (!pending) return;
  pendingCalls.delete(message.id);
  if (message.ok) {
    pending.resolve(message.result);
  } else {
    pending.reject(new Error(message.error || "code mode API call failed"));
  }
});

try {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });

  // SECURITY: No host-realm functions or objects are injected into the VM
  // context. Host closures would let sandboxed code escape via
  // .constructor.constructor("return process")(). Console output uses a
  // VM-created array; the host reads it after execution completes.

  const setupScript = new vm.Script([
    "const _setTimeout = (fn, ms) => {",
    "  return new Promise(resolve => {",
    "    const start = Date.now();",
    "    const check = () => {",
    "      if (Date.now() - start >= ms) { fn(); resolve(); }",
    "      else { Promise.resolve().then(check); }",
    "    };",
    "    check();",
    "  });",
    "};",
    "globalThis.setTimeout = (fn, ms) => { _setTimeout(fn, ms || 0); return 0; };",
    "globalThis.clearTimeout = () => {};",
    "globalThis.Promise = Promise;",
    "globalThis.JSON = JSON;",
    "const __cStringify = (arg) => {",
    "  if (typeof arg === 'string') return arg;",
    "  if (typeof arg === 'undefined') return 'undefined';",
    "  try { return JSON.stringify(arg); } catch { return String(arg); }",
    "};",
    "globalThis.console = {",
    "  log: (...args) => { globalThis.__consoleLines.push(args.map(__cStringify).join(' ')); },",
    "  warn: (...args) => { globalThis.__consoleLines.push('WARN: ' + args.map(__cStringify).join(' ')); },",
    "  error: (...args) => { globalThis.__consoleLines.push('ERROR: ' + args.map(__cStringify).join(' ')); },",
    "};",
  ].join("\n"));
  new vm.Script("globalThis.__consoleLines = [];").runInContext(context);
  setupScript.runInContext(context);
  const vmConsoleLines = context.__consoleLines;
  delete context.__consoleLines;

  context[workerData.namespaceName] = deserialize(workerData.namespace);

  for (const [name, source] of workerData.collectionClassSources) {
    const classScript = new vm.Script("(" + source + ")");
    context[name] = classScript.runInContext(context);
  }

  const extraGlobals = deserialize(workerData.extraGlobals);
  if (extraGlobals && typeof extraGlobals === "object") {
    for (const key of Object.keys(extraGlobals)) {
      context[key] = extraGlobals[key];
    }
  }

  const script = new vm.Script('"use strict"; (async () => {\n' + workerData.code + '\n})()', {
    filename: workerData.filename,
  });
  const resultPromise = script.runInContext(context, {
    timeout: workerData.timeoutMs,
  });

  resultPromise.then(
    (result) => {
      const lines = Array.from(vmConsoleLines);
      const finalResult = result === undefined && lines.length > 0 ? lines.join("\n") : result;
      parentPort.postMessage({ type: "done", result: finalResult, consoleOutput: lines });
    },
    (err) => {
      parentPort.postMessage({
        type: "failed",
        error: err && err.message ? err.message : String(err),
        consoleOutput: Array.from(vmConsoleLines),
      });
    },
  );
} catch (err) {
  parentPort.postMessage({
    type: "failed",
    error: err && err.message ? err.message : String(err),
    consoleOutput: consoleOutput || [],
  });
}
`;

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  get activeCount(): number {
    return this.active;
  }
}

const executionSemaphore = new Semaphore(DEFAULT_MAX_CONCURRENCY);

const activeWorkers = new Set<Worker>();

export function shutdown(): void {
  for (const worker of activeWorkers) {
    worker.terminate();
  }
  activeWorkers.clear();
}

export async function executeCodeMode<TApi, TNamespace>(
  code: string,
  hydration: CodeModeHydration<TApi, TNamespace>,
  namespace: TNamespace,
  opts?: ExecuteCodeModeOptions,
): Promise<CodeModeExecutionResult> {
  const maxBytes = hydration.maxCodeBytes ?? DEFAULT_MAX_CODE_BYTES;
  const codeBytes = new TextEncoder().encode(code).length;
  if (codeBytes > maxBytes) {
    return {
      kind: "Failed",
      errorKind: "codeSizeExceeded",
      error: `Code size (${codeBytes} bytes) exceeds maximum allowed (${maxBytes} bytes)`,
      consoleOutput: [],
    };
  }

  const timeoutMs = resolveTimeoutMs(hydration, opts?.timeoutMs);

  await executionSemaphore.acquire();
  try {
    const workerData = {
      code,
      filename: `${hydration.id || "code"}-generated.js`,
      timeoutMs,
      namespaceName: assertIdentifier(hydration.namespaceName, "namespaceName"),
      namespace: serializeScopeValue(namespace, "namespace", []),
      collectionClassSources: Object.entries(hydration.collectionClasses).map(([name, cls]) => [
        assertIdentifier(name, "collection class name"),
        serializeConstructorSource(cls),
      ]),
      extraGlobals: serializeScopeValue(opts?.extraGlobals ?? {}, "extraGlobals", []),
    };

    return await runWorker(workerData, { namespace, extraGlobals: opts?.extraGlobals ?? {} }, timeoutMs);
  } catch (err) {
    const error = err instanceof CodeModeError ? err : new CodeModeError("executionError", err instanceof Error ? err.message : String(err));
    return {
      kind: "Failed",
      errorKind: error.kind,
      error: error.message,
      consoleOutput: [],
    };
  } finally {
    executionSemaphore.release();
  }
}

function serializeConstructorSource(cls: Function): string {
  return Function.prototype.toString
    .call(cls)
    .replace(/static\s*\{\s*__name\(this,\s*["'][^"']+["']\)\s*;?\s*\}/g, "");
}

function resolveTimeoutMs<TApi, TNamespace>(
  hydration: CodeModeHydration<TApi, TNamespace>,
  requestedTimeoutMs: number | undefined,
): number {
  const defaultTimeout = hydration.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeout = hydration.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const timeout = requestedTimeoutMs ?? defaultTimeout;
  return Math.max(1, Math.min(timeout, maxTimeout));
}

function assertIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
    throw new CodeModeError("validationError", `Invalid code mode ${label}: ${value}`);
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
    throw new CodeModeError("validationError", `Cannot inject circular code mode scope value at ${path.join(".") || root}`);
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
): Promise<CodeModeExecutionResult> {
  return await new Promise<CodeModeExecutionResult>((resolve) => {
    const worker = new Worker(CODE_MODE_WORKER_SOURCE, {
      eval: true,
      type: "module",
      workerData,
      resourceLimits: {
        maxOldGenerationSizeMb: DEFAULT_MAX_MEMORY_MB,
        maxYoungGenerationSizeMb: Math.floor(DEFAULT_MAX_MEMORY_MB / 4),
      },
    });

    activeWorkers.add(worker);
    let settled = false;

    const timeout = setTimeout(() => {
      settle({
        kind: "Failed",
        errorKind: "timeout",
        error: `Execution timed out after ${timeoutMs}ms`,
        consoleOutput: [],
      });
      void worker.terminate();
    }, timeoutMs);

    const settle = (result: CodeModeExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeWorkers.delete(worker);
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
          errorKind: "executionError",
          error: message.error,
          consoleOutput: message.consoleOutput,
        });
        void worker.terminate();
        return;
      }
      if (message.type === "call") {
        void handleWorkerCall(worker, roots, message, settled);
      }
    });

    worker.on("error", (err) => {
      settle({
        kind: "Failed",
        errorKind: "executionError",
        error: err.message,
        consoleOutput: [],
      });
    });

    worker.on("exit", (code) => {
      if (!settled && code !== 0) {
        settle({
          kind: "Failed",
          errorKind: "executionError",
          error: `code mode worker exited with code ${code}`,
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
  isSettled: boolean,
): Promise<void> {
  if (isSettled) return;

  try {
    // P0 #4: Reject prototype pollution paths
    for (const segment of message.path) {
      if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
        throw new CodeModeError("sandboxViolation", `Access to '${segment}' is forbidden in code mode scope paths`);
      }
    }

    const root = message.root === "namespace" ? roots.namespace : roots.extraGlobals;
    const target = resolvePath(root, message.path);
    if (typeof target !== "function") {
      throw new CodeModeError("apiCallFailed", `code mode scope path is not callable: ${message.path.join(".")}`);
    }
    const parent = message.path.length > 0 ? resolvePath(root, message.path.slice(0, -1)) : undefined;
    const result = await target.apply(parent, message.args);
    try {
      worker.postMessage({ type: "callResult", id: message.id, ok: true, result });
    } catch { /* worker already terminated */ }
  } catch (err) {
    try {
      worker.postMessage({
        type: "callResult",
        id: message.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch { /* worker already terminated */ }
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
