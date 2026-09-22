import { PromisePool } from "@supercharge/promise-pool";
import { AsyncResource } from "node:async_hooks";

interface Job {
  run(): Promise<void>;
}

/** Only leaf I/O belongs here. Never hold a permit while invoking a provider. */
export class CompilationIoPool {
  private readonly jobs: Job[] = [];
  private scheduled = false;
  private activeLanes = 0;

  constructor(readonly concurrency?: number) {
    if (
      concurrency !== undefined &&
      (!Number.isSafeInteger(concurrency) || concurrency < 1)
    )
      throw new TypeError("ioConcurrency must be a positive integer");
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    // Native dispatch is the default: a cap trades throughput for I/O pressure.
    if (this.concurrency === undefined) {
      try {
        return operation();
      } catch (error) {
        return Promise.reject(error);
      }
    }

    return new Promise((resolve, reject) => {
      const run = AsyncResource.bind(async () => {
        try {
          resolve(await operation());
        } catch (error) {
          reject(error);
        }
      });

      this.jobs.push({ run });

      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => void this.drain());
      }
    });
  }

  private async drain(): Promise<void> {
    this.scheduled = false;
    const available = Math.min(
      this.concurrency! - this.activeLanes,
      this.jobs.length
    );
    if (!available) return;

    this.activeLanes += available;
    // Retain one PromisePool result per lane, not per file. Idle capacity can
    // admit new lanes while existing lanes keep draining the shared queue.
    await PromisePool.for(Array.from({ length: available }))
      .withConcurrency(available)
      .handleError((error) => {
        throw error;
      })
      .process(async () => {
        try {
          for (let job = this.jobs.shift(); job; job = this.jobs.shift())
            await job.run();
        } finally {
          this.activeLanes--;
        }
      });
  }
}

const pools = new Map<number | undefined, CompilationIoPool>();

export function getCompilationIoPool(concurrency?: number): CompilationIoPool {
  let pool = pools.get(concurrency);

  if (!pool)
    pools.set(concurrency, (pool = new CompilationIoPool(concurrency)));

  return pool;
}
