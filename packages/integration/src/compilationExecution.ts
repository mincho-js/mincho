import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { MessageChannel } from "node:worker_threads";
import { internalResolveFromModule as resolveFromModule } from "@mincho-js/babel";
import type Tinypool from "tinypool";
import {
  BabelTransformError,
  type BabelTransformSourceOptions,
  type BabelTransformResult,
  type StaticCssEvalSourceProvider
} from "./babel.js";
import type { ScopedDependencyOptions } from "./compile.js";
import { getCpuBudget, type CpuBudget } from "./cpuBudget.js";
import { getCompilationIoPool } from "./ioPool.js";
import {
  recordCompilationDiagnostic,
  measureCompilationPhase
} from "./diagnostics.js";
import type { MinchoExecutionOptions } from "./executionOptions.js";
import {
  restoreTransform,
  type TransformSnapshot
} from "./transformSnapshot.js";
import {
  restoreWorkerError,
  serializeWorkerError,
  type CompilerJob,
  type CompilerResponse,
  type ProviderRequest,
  type ProviderResponse
} from "./compilerProtocol.js";
import {
  configurationFiles,
  fingerprintFiles,
  hasExternalBabelConfiguration
} from "./compilationInputs.js";
import type { CompilationCache } from "./compilationCache.js";

const active = new AsyncLocalStorage<CompilationExecution>();
const providerRequest = new AsyncLocalStorage<boolean>();
let environmentId = 0;

interface SharedPool {
  pool?: Promise<Tinypool>;
  filename: string;
  owners: Map<CompilationExecution, number>;
  active: number;
  waiting: (() => void)[];
}

const poolsKey = Symbol.for("@mincho-js/integration/compiler-pools/v1");
const globals = globalThis as typeof globalThis & {
  [poolsKey]?: Map<string, SharedPool>;
};

const pools = (globals[poolsKey] ??= new Map());

class WorkerStartupError extends Error {}

class InlineFallback extends Error {}

const runInline = Symbol("mincho-inline-fallback");

function workerFilename(): string {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: CJS declaration builds also check import.meta.
  const moduleUrl = import.meta.url;

  return resolveFromModule(moduleUrl, "@mincho-js/integration/compiler-worker");
}

function wake(shared: SharedPool) {
  shared.waiting.splice(0).forEach((notify) => notify());
}

export function currentCompilationExecution() {
  return active.getStore();
}

export class CompilationExecution {
  compilationCache?: CompilationCache;
  readonly io;
  readonly environment = `${process.pid}:${++environmentId}`;
  readonly cacheEnabled: boolean;
  private readonly workers: "auto" | number;
  private budget?: Promise<CpuBudget>;
  private shared?: SharedPool;
  private generation = 0;
  private closed = false;
  private abort = new AbortController();
  private running = 0;
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly cleanups = new Set<() => void>();

  constructor(options: MinchoExecutionOptions = {}, cacheEnabled = true) {
    this.workers = options.workers ?? "auto";

    if (
      this.workers !== "auto" &&
      (!Number.isSafeInteger(this.workers) || this.workers < 0)
    )
      throw new TypeError(
        "execution.workers must be auto or a non-negative integer"
      );

    this.io = getCompilationIoPool(options.ioConcurrency);
    this.cacheEnabled = cacheEnabled;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new Error("Mincho compilation execution is closed")
      );
    if (
      this.evaluation === "fresh" &&
      (this.workers === "auto" || this.workers === 0) &&
      !active.getStore()
    )
      return operation();

    return active.run(this, operation);
  }

  begin(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.closed = false;
    this.generation++;

    if (this.shared) wake(this.shared);
  }

  onClose(cleanup: () => void): void {
    this.cleanups.add(cleanup);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.generation++;
    this.abort.abort();

    if (this.shared) wake(this.shared);

    // Providers and deferred registry publication belong to the bundler's
    // lifecycle. Waiting on them here can prevent that lifecycle from closing.
    await Promise.allSettled([...this.tasks]);
    this.cleanups.forEach((cleanup) => cleanup());
    this.cleanups.clear();

    const shared = this.shared;
    this.shared = undefined;

    if (!shared) return;

    shared.owners.delete(this);
    wake(shared);

    if (!shared.owners.size) {
      pools.delete(shared.filename);

      const pool = await shared.pool?.catch(() => undefined);
      await pool?.destroy();
    }
  }

  private stale(generation: number): void {
    if (this.closed || generation !== this.generation) {
      const error = new Error(
        "Mincho compilation generation is no longer current"
      );

      error.name = "MinchoCompilationStaleGenerationError";

      throw error;
    }
  }

  async externalCpu<T>(
    bytes: number,
    operation: () => Promise<T>,
    inline: () => Promise<T>
  ): Promise<T> {
    return this.run(() =>
      this.cpu("<package-graph>", bytes, operation, inline, true)
    );
  }

  async cpu<T>(
    file: string,
    source: string | number,
    operation: (
      pool: () => Promise<Tinypool>,
      partitions: number,
      assertCurrent: () => void
    ) => Promise<T>,
    inline: () => Promise<T>,
    external = false
  ): Promise<T> {
    if (
      this.workers === 0 ||
      providerRequest.getStore() ||
      // Compiler workers remain opt-in until startup/IPC passes the timing gate.
      (this.workers === "auto" && !external)
    )
      return inline();

    const generation = this.generation;
    recordCompilationDiagnostic("worker-candidate", {
      file,
      bytes: typeof source === "number" ? source : Buffer.byteLength(source)
    });

    const budget = await (this.budget ??= getCpuBudget());
    this.stale(generation);

    const limit =
      this.workers === "auto"
        ? budget.automaticWorkers
        : Math.min(this.workers, budget.budget);

    recordCompilationDiagnostic("cpu-budget", { ...budget, workers: limit });

    if (!limit) return inline();
    if (!external)
      this.compilationCache?.parser.resize(
        Math.max(1, Math.floor(512 / (budget.budget + 1))),
        Math.floor((64 * 1024 * 1024) / (budget.budget + 1))
      );

    let filename: string;

    try {
      filename = workerFilename();
    } catch {
      recordCompilationDiagnostic("worker-bypass", {
        reason: "worker-entry-unavailable"
      });

      return inline();
    }

    const shared: SharedPool = this.shared ??
      pools.get(filename) ?? {
        filename,
        owners: new Map(),
        active: 0,
        waiting: []
      };

    this.shared = shared;
    pools.set(filename, shared);
    shared.owners.set(this, limit);

    // Admission is bounded before creating DTOs or transferring source text.
    if (shared.waiting.length >= 2 * budget.budget) {
      recordCompilationDiagnostic("worker-bypass", { reason: "queue-full" });

      return inline();
    }

    const task = (async (): Promise<T | typeof runInline> => {
      const queued = performance.now();

      while (
        shared.active >= Math.max(...shared.owners.values()) ||
        this.running >= limit
      ) {
        await new Promise<void>((resolve) => shared.waiting.push(resolve));
        this.stale(generation);
      }

      this.stale(generation);
      shared.active++;
      this.running++;
      recordCompilationDiagnostic("worker-wait", {
        milliseconds: performance.now() - queued
      });

      try {
        const getPool = async () => {
          shared.pool ??= measureCompilationPhase(
            "worker-pool-initialize",
            async () => {
              const { Tinypool } = await import("tinypool");

              return new Tinypool({
                filename,
                name: "runCompilerJob",
                minThreads: 0,
                maxThreads: budget.budget,
                concurrentTasksPerWorker: 1,
                idleTimeout: 30_000,
                maxQueue: 2 * budget.budget,
                isolateWorkers: false
              });
            }
          );

          let pool: Tinypool;

          try {
            pool = await shared.pool;
          } catch (error) {
            throw new WorkerStartupError(
              "Compiler pool initialization failed",
              {
                cause: error
              }
            );
          }

          this.stale(generation);

          return pool;
        };

        const result = await operation(getPool, budget.budget + 1, () =>
          this.stale(generation)
        );

        this.stale(generation);

        return result;
      } catch (error) {
        this.stale(generation);

        if (error instanceof WorkerStartupError) {
          recordCompilationDiagnostic("worker-bypass", {
            reason: "worker-start-failed"
          });

          return runInline;
        }

        if (error instanceof InlineFallback) return runInline;

        throw error;
      } finally {
        shared.active--;
        this.running--;
        wake(shared);
      }
    })();

    this.tasks.add(task);

    try {
      const result = await task;
      if (result !== runInline) return result;

      // Inline providers may re-enter the scheduler, so release admission first.
      this.stale(generation);
      const fallback = await inline();
      this.stale(generation);

      return fallback;
    } finally {
      this.tasks.delete(task);
    }
  }

  async dispatch(
    kind: "transform" | "scoped",
    input: BabelTransformSourceOptions | ScopedDependencyOptions,
    provider: StaticCssEvalSourceProvider | undefined,
    pool: Tinypool,
    partitions: number
  ): Promise<CompilerResponse> {
    const { port1, port2 } = new MessageChannel();
    const respond = AsyncResource.bind(async (request: ProviderRequest) => {
      let response: ProviderResponse;

      try {
        const value = await providerRequest.run(true, () =>
          request.kind === "resolve"
            ? provider!.resolve(...request.args)
            : provider!.load(...request.args)
        );

        response = { id: request.id, ok: true, value };
      } catch (error) {
        response = {
          id: request.id,
          ok: false,
          error: serializeWorkerError(error)
        };
      }

      try {
        port1.postMessage(response);
      } catch (error) {
        port1.postMessage({
          id: request.id,
          ok: false,
          error: serializeWorkerError(error)
        } satisfies ProviderResponse);
      }
    });

    port1.on("message", (request: ProviderRequest) => {
      void respond(request);
    });

    try {
      const start = performance.now();

      // Tinypool 2 types use the last postMessage overload, which changed in Node 25.
      const transferList = [port2] as unknown as NonNullable<
        Parameters<Tinypool["run"]>[1]
      >["transferList"];

      const response = (await pool
        .run(
          {
            kind,
            input,
            provider: !!provider,
            environment: this.environment,
            generation: this.generation,
            cache: this.cacheEnabled,
            cachePartitions: partitions,
            port: port2
          } as CompilerJob,
          { transferList, signal: this.abort.signal }
        )
        .catch((error: NodeJS.ErrnoException) => {
          // User compilation failures are returned as CompilerResponse objects.
          // Only failure to load the worker module can take the inline fallback.
          if (
            ["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ENOENT"].includes(
              error.code ?? ""
            )
          )
            throw new WorkerStartupError("Compiler worker could not load", {
              cause: error
            });

          throw error;
        })) as CompilerResponse;

      recordCompilationDiagnostic("worker-run", {
        milliseconds: response.duration,
        kind
      });
      recordCompilationDiagnostic("worker-overhead", {
        milliseconds: Math.max(
          0,
          performance.now() - start - response.duration
        ),
        kind
      });

      return response;
    } finally {
      port1.close();
      port2.close();
    }
  }
}

export async function executeTransform(
  options: BabelTransformSourceOptions,
  inline: () => Promise<BabelTransformResult>
): Promise<BabelTransformResult> {
  const execution = active.getStore();
  if (!execution || providerRequest.getStore()) return inline();

  const {
    compilationCache,
    staticCssEvalSourceProvider: provider,
    staticCssEvalProjectEngine: engine,
    ...babel
  } = options.babel ?? {};
  if (
    babel.staticCssEvalProvider ||
    babel.plugins?.length ||
    babel.presets?.length ||
    babel.configFile ||
    babel.extends ||
    babel.env ||
    babel.overrides ||
    !serializable(babel)
  )
    return inline();

  return execution.cpu(
    options.filename,
    options.source,
    async (pool, partitions, assertCurrent) => {
      // Even cache:false must respect external Babel configuration and its inputs.
      const files = configurationFiles([options.filename]);
      const fingerprints = compilationCache
        ? await compilationCache.fingerprint(files)
        : await fingerprintFiles(files);
      if (
        await (compilationCache?.hasExternalBabelConfiguration(fingerprints) ??
          hasExternalBabelConfiguration(fingerprints))
      )
        throw new InlineFallback();

      const currentProvider =
        engine && provider
          ? engine.getBabelStaticEvalProvider(options.filename, provider)
          : provider;

      const compiler = await pool();
      assertCurrent();

      const response = await execution.dispatch(
        "transform",
        { ...options, babel },
        currentProvider,
        compiler,
        partitions
      );

      assertCurrent();

      if (!response.ok) {
        const result = response.error.transform
          ? restoreTransform(response.error.transform, compilationCache)
          : undefined;

        engine?.refreshFile({
          fileId: options.filename,
          result: result?.staticCssEval,
          preserveProviderRecords: true
        });

        const error = new BabelTransformError(
          options.filename,
          restoreWorkerError(response.error.cause ?? response.error),
          result?.staticCssEval
        );

        error.message = response.error.message;

        if (response.error.stack) error.stack = response.error.stack;

        throw error;
      }

      const result = restoreTransform(
        response.value as TransformSnapshot,
        compilationCache
      );

      engine?.refreshFile({
        fileId: options.filename,
        result: result.staticCssEval,
        generatedArtifacts: result.result[1]
          ? [
              {
                kind: "sidecar-css-ts",
                ownerFile: options.filename,
                artifactFile: result.result[0],
                source: result.result[1]
              }
            ]
          : [],
        preserveProviderRecords: true
      });

      return result;
    },
    inline
  );
}

export async function executeScopedTransform(
  input: ScopedDependencyOptions,
  inline: () => string
): Promise<string> {
  const execution = active.getStore();
  if (!execution) return inline();

  return execution.cpu(
    input.filePath,
    input.contents,
    async (pool, partitions) => {
      const cache = execution.compilationCache;
      const files = configurationFiles([input.filePath]);
      const fingerprints = cache
        ? await cache.fingerprint(files)
        : await fingerprintFiles(files);
      if (
        await (cache?.hasExternalBabelConfiguration(fingerprints) ??
          hasExternalBabelConfiguration(fingerprints))
      )
        throw new InlineFallback();

      const result = await execution.dispatch(
        "scoped",
        input,
        undefined,
        await pool(),
        partitions
      );
      if (!result.ok) throw restoreWorkerError(result.error);

      return result.value as string;
    },
    async () => inline()
  );
}

function serializable(value: unknown): boolean {
  if (
    value === null ||
    value === undefined ||
    ["string", "number", "boolean"].includes(typeof value)
  )
    return true;
  if (Array.isArray(value)) return value.every(serializable);

  return (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(serializable)
  );
}
