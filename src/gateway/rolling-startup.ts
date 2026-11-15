import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createDeferredCore } from "../shared/deferred.js";

/** One startup's deferred mutable producers; no requests or user inputs are stored here. */
export class GatewayRollingStartup {
  private readonly mutableReady = createDeferredCore();
  private readonly writerReady = createDeferredCore();
  private readonly stopped = new AbortController();
  private tasks: Array<() => Promise<void>> = [];
  private activation?: Promise<void>;
  private retired = false;
  private mutableStarted = false;
  private readsPublished = false;
  private writerPublished = false;

  constructor(
    private readonly onReadReady: () => void,
    readonly releaseId: string,
  ) {
    void this.mutableReady.promise.catch(() => {});
    void this.writerReady.promise.catch(() => {});
  }
  get signal(): AbortSignal {
    return this.stopped.signal;
  }
  get readReady(): boolean {
    return this.readsPublished && !this.stopped.signal.aborted;
  }
  get mutableActivationStarted(): boolean {
    return this.mutableStarted;
  }
  get writableReady(): boolean {
    return this.writerPublished && !this.stopped.signal.aborted;
  }

  publishWriterReady(): void {
    this.stopped.signal.throwIfAborted();
    if (!this.mutableStarted) {
      throw new Error("Gateway writer readiness precedes mutable activation");
    }
    this.writerPublished = true;
    this.writerReady.resolve();
  }

  async waitForWriterReady(signal?: AbortSignal): Promise<void> {
    await racePromiseWithAbortSignal(
      this.writerReady.promise,
      signal ? AbortSignal.any([signal, this.stopped.signal]) : this.stopped.signal,
    );
  }

  async runOrDefer(task: () => Promise<void>): Promise<void> {
    this.stopped.signal.throwIfAborted();
    if (this.mutableStarted) {
      await task();
    } else {
      this.defer(task);
    }
  }

  defer(task: () => Promise<void>): void {
    this.stopped.signal.throwIfAborted();
    if (this.retired) {
      throw new Error("Gateway mutable startup registration is already complete");
    }
    this.tasks.push(task);
  }

  publishReadReady(): void {
    this.stopped.signal.throwIfAborted();
    this.readsPublished = true;
    this.onReadReady();
  }

  async waitForMutableStartup(signal?: AbortSignal): Promise<void> {
    await racePromiseWithAbortSignal(
      this.mutableReady.promise,
      signal ? AbortSignal.any([signal, this.stopped.signal]) : this.stopped.signal,
    );
  }

  /** The existing host must prove writer custody and positive old-reader retirement first. */
  activate(
    assertWriterAndRetiredReaders: () => void,
    beforeMutable?: () => void,
    afterDeferred?: () => void,
  ): Promise<void> {
    if (this.activation) {
      return this.activation;
    }
    this.stopped.signal.throwIfAborted();
    assertWriterAndRetiredReaders();
    this.mutableStarted = true;
    return (this.activation ??= (async () => {
      this.stopped.signal.throwIfAborted();
      assertWriterAndRetiredReaders();
      try {
        beforeMutable?.();
        for (const task of this.tasks) {
          this.stopped.signal.throwIfAborted();
          assertWriterAndRetiredReaders();
          await task();
        }
        this.retired = true;
        this.tasks = [];
        this.stopped.signal.throwIfAborted();
        assertWriterAndRetiredReaders();
        afterDeferred?.();
        this.mutableReady.resolve();
      } catch (error) {
        this.mutableReady.reject(error);
        throw error;
      }
    })());
  }

  beginClose(): void {
    this.stopped.abort(new Error("Gateway rolling startup closed"));
    this.mutableReady.reject(this.stopped.signal.reason);
    this.writerReady.reject(this.stopped.signal.reason);
    this.tasks = [];
  }

  async close(): Promise<void> {
    this.beginClose();
    await this.activation?.catch(() => undefined);
  }
}

export async function runOrDeferGatewayMutableStartup(
  rolling: GatewayRollingStartup | undefined,
  task: () => Promise<void>,
): Promise<void> {
  if (rolling) {
    await rolling.runOrDefer(task);
  } else {
    await task();
  }
}
