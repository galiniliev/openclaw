/**
 * Generic DSL Executor
 *
 * Executes LLM-generated async code with an injected namespace, collection classes, and console capture.
 */

import type { DslHydration, DslExecutionResult } from "./types.js";

const DEFAULT_MAX_CODE_BYTES = 100 * 1024; // 100KB
const DEFAULT_TIMEOUT_MS = 30000; // 30s
const DEFAULT_MAX_TIMEOUT_MS = 120000; // 120s

export interface ExecuteDslOptions {
  timeoutMs?: number;
  extraGlobals?: Record<string, any>;
}

/**
 * Executes DSL code in a sandboxed environment with the provided namespace and hydration configuration.
 *
 * @param code - The DSL code to execute
 * @param hydration - The DSL hydration configuration
 * @param namespace - The namespace object to inject into the code scope
 * @param opts - Optional execution options (timeout, extra globals)
 * @returns Execution result with output, result, or error
 */
export async function executeDsl<TApi, TNamespace>(
  code: string,
  hydration: DslHydration<TApi, TNamespace>,
  namespace: TNamespace,
  opts?: ExecuteDslOptions,
): Promise<DslExecutionResult> {
  const consoleOutput: string[] = [];

  try {
    // 1. Check code size
    const maxBytes = hydration.maxCodeBytes ?? DEFAULT_MAX_CODE_BYTES;
    const codeBytes = new TextEncoder().encode(code).length;
    if (codeBytes > maxBytes) {
      return {
        kind: "Failed",
        error: `Code size (${codeBytes} bytes) exceeds maximum allowed (${maxBytes} bytes)`,
        consoleOutput,
      };
    }

    // 2. Build sandboxed console
    const sandboxedConsole = {
      log: (...args: any[]) => {
        consoleOutput.push(args.map((arg) => String(arg)).join(" "));
      },
      warn: (...args: any[]) => {
        consoleOutput.push(`WARN: ${args.map((arg) => String(arg)).join(" ")}`);
      },
      error: (...args: any[]) => {
        consoleOutput.push(`ERROR: ${args.map((arg) => String(arg)).join(" ")}`);
      },
    };

    // 3. Build scope
    const scope: Record<string, any> = {
      [hydration.namespaceName]: namespace,
      ...hydration.collectionClasses,
      console: sandboxedConsole,
      JSON: JSON,
      ...opts?.extraGlobals,
    };

    const scopeNames = Object.keys(scope);
    const scopeValues = Object.values(scope);

    // 4. Wrap code in async IIFE
    const wrappedCode = `return (async () => {\n${code}\n})();`;
    const fn = new Function(...scopeNames, wrappedCode);

    // 5. Calculate timeout
    const defaultTimeout = hydration.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxTimeout = hydration.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
    const requestedTimeout = opts?.timeoutMs ?? defaultTimeout;
    const effectiveTimeout = Math.min(requestedTimeout, maxTimeout);

    // 6. Race execution against timeout
    const executionPromise = fn(...scopeValues);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Execution timed out after ${effectiveTimeout}ms`)), effectiveTimeout)
    );

    const result = await Promise.race([executionPromise, timeoutPromise]);

    // 7. Return success result
    // If result is undefined and console has output, use joined console as result
    const finalResult = result === undefined && consoleOutput.length > 0 ? consoleOutput.join("\n") : result;

    return {
      kind: "Succeeded",
      result: finalResult,
      consoleOutput,
    };
  } catch (err: any) {
    // 8. Return failure result
    return {
      kind: "Failed",
      error: err?.message ?? String(err),
      consoleOutput,
    };
  }
}
