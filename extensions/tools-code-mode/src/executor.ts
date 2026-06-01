import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { CodeModeError } from "./errors.js";
import {
  classifyReturnValueKind,
  emit,
  emitJudgeInput,
  JUDGE_INPUT_RESULT_MAX_BYTES,
  safeStringifyForJudge,
  truncateUtf8,
  type ReturnValueKind,
} from "./telemetry.js";
import type { CodeModeNamespace, CodeModeExecutionResult } from "./types.js";

export const DEFAULT_MAX_CODE_BYTES = 100 * 1024;
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_TIMEOUT_MS = 120000;
const DEFAULT_MAX_MEMORY_MB = 1024;
export const DEFAULT_MAX_CONCURRENCY = 4;

const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

const EXTRA_GLOBALS_ROOT = "__extraGlobals__";

export interface ExecuteCodeModeOptions {
  timeoutMs?: number;
  extraGlobals?: Record<string, unknown>;
  toolCallId?: string;
}

export interface CodeModeExecutorConfig {
  maxConcurrency?: number;
}

/**
 * A single namespace participating in an execute_code call: the namespace
 * descriptor plus the resolved scope value (typically the object returned by
 * `namespace.createNamespace(api)`). Pass an array of these to
 * `executeCodeMode` to compose multiple namespaces into one sandbox.
 */
export interface NamespaceBinding<TApi = unknown, TNamespace = unknown> {
  namespace: CodeModeNamespace<TApi, TNamespace>;
  scope: TNamespace;
}

type SerializedScopeValue =
  | { kind: "function"; root: string; path: string[] }
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
  root: string;
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

  for (const [name, serialized] of workerData.namespaces) {
    context[name] = deserialize(serialized);
  }

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

  get queueDepth(): number {
    return this.queue.length;
  }
}

const executionSemaphore = new Semaphore(DEFAULT_MAX_CONCURRENCY);

const activeWorkers = new Set<Worker>();

export function shutdown(reason: "container_shutdown" | "explicit" = "explicit"): void {
  const count = activeWorkers.size;
  for (const worker of activeWorkers) {
    worker.terminate();
  }
  activeWorkers.clear();
  emit({
    event: "openclaw.code_mode.executor.shutdown",
    activeWorkers: count,
    reason,
  });
}

/**
 * Execute user code against one or more namespace bindings. The first binding
 * acts as the "primary" for the purpose of telemetry filename and code-size /
 * timeout limits — when multiple bindings disagree on a limit, the most
 * restrictive value wins (smallest maxCodeBytes / maxTimeoutMs, smallest
 * defaultTimeoutMs).
 */
export async function executeCodeMode(
  code: string,
  bindings: NamespaceBinding[],
  opts?: ExecuteCodeModeOptions,
): Promise<CodeModeExecutionResult> {
  const startMs = Date.now();
  const codeStr = typeof code === "string" ? code : "";
  const codeBytes = new TextEncoder().encode(codeStr).length;
  const codeSha256 = createHash("sha256").update(codeStr).digest("hex");
  const namespaceIdsArr = Array.isArray(bindings)
    ? bindings.map((b) => b?.namespace?.id).filter((id): id is string => typeof id === "string")
    : [];
  const toolCallId = opts?.toolCallId;

  let resolvedTimeoutMs = 0;
  let result: CodeModeExecutionResult = {
    kind: "Failed",
    errorKind: "executionError",
    error: "executeCodeMode did not complete",
    consoleOutput: [],
  };

  try {
    if (!Array.isArray(bindings) || bindings.length === 0) {
      emit({
        event: "openclaw.code_mode.execute_code.validation_rejected",
        errorKind: "validationError",
        reasonCode: "no_bindings",
        namespaceIds: namespaceIdsArr,
        codeBytes,
        toolCallId,
      });
      result = {
        kind: "Failed",
        errorKind: "validationError",
        error: "executeCodeMode requires at least one namespace binding",
        consoleOutput: [],
      };
      return result;
    }

    // Reject namespaceName collisions inside one call.
    const namespaceNames = new Map<string, string>();
    for (const b of bindings) {
      const name = b.namespace.namespaceName;
      const prevId = namespaceNames.get(name);
      if (prevId && prevId !== b.namespace.id) {
        emit({
          event: "openclaw.code_mode.execute_code.validation_rejected",
          errorKind: "validationError",
          reasonCode: "duplicate_namespace_name",
          namespaceIds: namespaceIdsArr,
          codeBytes,
          toolCallId,
        });
        result = {
          kind: "Failed",
          errorKind: "validationError",
          error: `Namespace name "${name}" collides between "${prevId}" and "${b.namespace.id}"`,
          consoleOutput: [],
        };
        return result;
      }
      namespaceNames.set(name, b.namespace.id);
    }

    const maxBytes = bindings.reduce(
      (acc, b) => Math.min(acc, b.namespace.maxCodeBytes ?? DEFAULT_MAX_CODE_BYTES),
      DEFAULT_MAX_CODE_BYTES,
    );
    if (codeBytes > maxBytes) {
      emit({
        event: "openclaw.code_mode.execute_code.validation_rejected",
        errorKind: "codeSizeExceeded",
        reasonCode: "size_exceeded",
        namespaceIds: namespaceIdsArr,
        codeBytes,
        maxCodeBytes: maxBytes,
        toolCallId,
      });
      result = {
        kind: "Failed",
        errorKind: "codeSizeExceeded",
        error: `Code size (${codeBytes} bytes) exceeds maximum allowed (${maxBytes} bytes)`,
        consoleOutput: [],
      };
      return result;
    }

    const timeoutMs = resolveTimeoutMs(bindings, opts?.timeoutMs);
    resolvedTimeoutMs = timeoutMs;
    const primary = bindings[0]!;

    await executionSemaphore.acquire();
    const concurrencyActiveAtStart = executionSemaphore.activeCount;
    const concurrencyQueueDepth = executionSemaphore.queueDepth;
    try {
      // Build per-namespace roots map for call-back resolution. The host side
      // looks up `roots[message.root]` to find the object whose method to call.
      const roots: Record<string, unknown> = {
        [EXTRA_GLOBALS_ROOT]: opts?.extraGlobals ?? {},
      };
      const namespacesSerialized: Array<[string, SerializedScopeValue]> = [];
      const collectionSources: Array<[string, string]> = [];

      for (const b of bindings) {
        let name: string;
        try {
          name = assertIdentifier(b.namespace.namespaceName, "namespaceName");
        } catch (err) {
          emit({
            event: "openclaw.code_mode.execute_code.validation_rejected",
            errorKind: "validationError",
            reasonCode: "identifier_invalid",
            namespaceIds: namespaceIdsArr,
            codeBytes,
            toolCallId,
          });
          throw err;
        }
        roots[name] = b.scope;
        namespacesSerialized.push([name, serializeScopeValue(b.scope, name, [])]);
        for (const [clsName, cls] of Object.entries(b.namespace.collectionClasses)) {
          let safeClsName: string;
          try {
            safeClsName = assertIdentifier(clsName, "collection class name");
          } catch (err) {
            emit({
              event: "openclaw.code_mode.execute_code.validation_rejected",
              errorKind: "validationError",
              reasonCode: "identifier_invalid",
              namespaceIds: namespaceIdsArr,
              codeBytes,
              toolCallId,
            });
            throw err;
          }
          collectionSources.push([safeClsName, serializeConstructorSource(cls)]);
        }
      }

      const workerData = {
        code: codeStr,
        filename: `${primary.namespace.id || "code"}-generated.js`,
        timeoutMs,
        namespaces: namespacesSerialized,
        collectionClassSources: collectionSources,
        extraGlobals: serializeScopeValue(opts?.extraGlobals ?? {}, EXTRA_GLOBALS_ROOT, []),
      };

      result = await runWorker(workerData, roots, timeoutMs);
      return result;
    } catch (err) {
      const error =
        err instanceof CodeModeError
          ? err
          : new CodeModeError("executionError", err instanceof Error ? err.message : String(err));
      result = {
        kind: "Failed",
        errorKind: error.kind,
        error: error.message,
        consoleOutput: [],
      };
      return result;
    } finally {
      executionSemaphore.release();
      // Judge-only emit channel: raw code+result paired with the
      // headline by codeSha256. MUST fire before the headline so the
      // adapter has the input buffered when the trigger arrives. The
      // adapter filters this event by equality at promoter entry; it
      // never reaches Geneva. Schema locked by
      // project-lobster-vault/Tech/Tools/Code-Mode/judge-input-emit-channel.md.
      const resultPayload = result.kind === "Succeeded" ? result.result : result.error;
      const resultStr = safeStringifyForJudge(resultPayload);
      const { value: resultCapped, truncated: resultTruncated } = truncateUtf8(
        resultStr,
        JUDGE_INPUT_RESULT_MAX_BYTES,
      );
      emitJudgeInput({
        event: "openclaw.code_mode.judge.input",
        toolCallId,
        codeSha256,
        code: codeStr,
        result: resultCapped,
        resultTruncated,
        consoleOutput: result.consoleOutput ?? [],
        namespaceIds: namespaceIdsArr,
        timestampMs: Date.now(),
      });
      emitExecuteCodeTerminal({
        ok: result.kind === "Succeeded",
        errorKind: result.kind === "Failed" ? result.errorKind : undefined,
        durationMs: Date.now() - startMs,
        codeBytes,
        codeSha256,
        timeoutMs: resolvedTimeoutMs,
        namespaceIds: namespaceIdsArr,
        consoleLineCount: result.consoleOutput?.length ?? 0,
        returnValue: result.kind === "Succeeded" ? result.result : undefined,
        concurrencyActiveAtStart,
        concurrencyQueueDepth,
        toolCallId,
      });
    }
  } catch (err) {
    // Pre-acquire validation already emitted its own validation_rejected.
    // Still emit a terminal record so the headline event count matches calls in.
    const error =
      err instanceof CodeModeError
        ? err
        : new CodeModeError("executionError", err instanceof Error ? err.message : String(err));
    result = {
      kind: "Failed",
      errorKind: error.kind,
      error: error.message,
      consoleOutput: [],
    };
    emitExecuteCodeTerminal({
      ok: false,
      errorKind: error.kind,
      durationMs: Date.now() - startMs,
      codeBytes,
      codeSha256,
      timeoutMs: resolvedTimeoutMs,
      namespaceIds: namespaceIdsArr,
      consoleLineCount: 0,
      returnValue: undefined,
      concurrencyActiveAtStart: 0,
      concurrencyQueueDepth: 0,
      toolCallId,
    });
    return result;
  }
}

interface TerminalEmitInput {
  ok: boolean;
  errorKind?: import("./errors.js").CodeModeErrorKind;
  durationMs: number;
  codeBytes: number;
  codeSha256: string;
  timeoutMs: number;
  namespaceIds: string[];
  consoleLineCount: number;
  returnValue: unknown;
  concurrencyActiveAtStart: number;
  concurrencyQueueDepth: number;
  toolCallId?: string;
}

function emitExecuteCodeTerminal(input: TerminalEmitInput): void {
  let returnValueKind: ReturnValueKind = "undefined";
  let returnValueBytes = 0;
  if (input.ok) {
    returnValueKind = classifyReturnValueKind(input.returnValue);
    if (input.returnValue !== undefined) {
      try {
        returnValueBytes = new TextEncoder().encode(JSON.stringify(input.returnValue) ?? "").length;
      } catch {
        returnValueBytes = 0;
      }
    }
  }
  emit({
    event: "openclaw.code_mode.execute_code",
    ok: input.ok,
    errorKind: input.errorKind,
    durationMs: input.durationMs,
    codeBytes: input.codeBytes,
    codeSha256: input.codeSha256,
    timeoutMs: input.timeoutMs,
    namespaceIds: input.namespaceIds,
    namespaceCount: input.namespaceIds.length,
    consoleLineCount: input.consoleLineCount,
    returnValueKind,
    returnValueBytes,
    concurrencyActiveAtStart: input.concurrencyActiveAtStart,
    concurrencyQueueDepth: input.concurrencyQueueDepth,
    toolCallId: input.toolCallId,
  });
}

function serializeConstructorSource(cls: Function): string {
  return Function.prototype.toString
    .call(cls)
    .replace(/static\s*\{\s*__name\(this,\s*["'][^"']+["']\)\s*;?\s*\}/g, "");
}

function resolveTimeoutMs(
  bindings: NamespaceBinding[],
  requestedTimeoutMs: number | undefined,
): number {
  const defaultTimeout = bindings.reduce(
    (acc, b) => Math.min(acc, b.namespace.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS),
    DEFAULT_TIMEOUT_MS,
  );
  const maxTimeout = bindings.reduce(
    (acc, b) => Math.min(acc, b.namespace.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS),
    DEFAULT_MAX_TIMEOUT_MS,
  );
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
  root: string,
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
    throw new CodeModeError(
      "validationError",
      `Cannot inject circular code mode scope value at ${path.join(".") || root}`,
    );
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return {
      kind: "array",
      items: value.map((item, index) =>
        serializeScopeValue(item, root, [...path, String(index)], seen),
      ),
    };
  }

  const entries = Object.entries(value as Record<string, unknown>).map(
    ([key, child]) =>
      [key, serializeScopeValue(child, root, [...path, key], seen)] satisfies [
        string,
        SerializedScopeValue,
      ],
  );
  return { kind: "object", entries };
}

async function runWorker(
  workerData: unknown,
  roots: Record<string, unknown>,
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
  roots: Record<string, unknown>,
  message: WorkerCallMessage,
  isSettled: boolean,
): Promise<void> {
  if (isSettled) return;

  try {
    // P0 #4: Reject prototype pollution paths
    for (const segment of message.path) {
      if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
        throw new CodeModeError(
          "sandboxViolation",
          `Access to '${segment}' is forbidden in code mode scope paths`,
        );
      }
    }

    const root = roots[message.root];
    if (root === undefined) {
      throw new CodeModeError("apiCallFailed", `unknown code mode scope root: ${message.root}`);
    }
    const target = resolvePath(root, message.path);
    if (typeof target !== "function") {
      throw new CodeModeError(
        "apiCallFailed",
        `code mode scope path is not callable: ${message.path.join(".")}`,
      );
    }
    const parent =
      message.path.length > 0 ? resolvePath(root, message.path.slice(0, -1)) : undefined;
    const result = await target.apply(parent, message.args);
    // Try a normal postMessage first (fast path — structured clone on plain
    // objects/numbers/strings). Fall back to a JSON round-trip when the
    // result holds non-clonable references (e.g. domain namespace methods
    // like `M365.messages.list()` return a `MessageSet` whose `this.api` is
    // a Proxy with closures over a live HTTP client; structured clone
    // throws `DataCloneError` on it, and the legacy bare `catch` arm
    // misattributed the failure to "worker already terminated", which left
    // the worker's pending call unresolved → 30s sandbox timeout). JSON
    // round-trip preserves the data the namespace methods actually want
    // to surface (Graph / REST response shapes are pure JSON) and strips
    // the non-clonable references; collection classes are reconstructed
    // from `collectionClassSources` inside the sandbox, so the prototype
    // loss on the wire is harmless.
    try {
      worker.postMessage({ type: "callResult", id: message.id, ok: true, result });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "DataCloneError" || /could not be cloned/i.test(err.message))
      ) {
        try {
          const sanitized = JSON.parse(JSON.stringify(result ?? null));
          worker.postMessage({
            type: "callResult",
            id: message.id,
            ok: true,
            result: sanitized,
          });
        } catch (jsonErr) {
          try {
            worker.postMessage({
              type: "callResult",
              id: message.id,
              ok: false,
              error: `result not serialisable across worker boundary: ${
                jsonErr instanceof Error ? jsonErr.message : String(jsonErr)
              }`,
            });
          } catch {
            /* worker already terminated */
          }
        }
      }
      // Any other postMessage failure means the worker is gone; nothing to do.
    }
  } catch (err) {
    try {
      worker.postMessage({
        type: "callResult",
        id: message.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* worker already terminated */
    }
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
