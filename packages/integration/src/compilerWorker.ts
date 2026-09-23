import {
  transformSourceUncached,
  type StaticCssEvalSourceProvider,
  type BabelTransformError
} from "./babel.js";
import { transformScopedDependencySource } from "./compile.js";
import { CompilationCache } from "./compilationCache.js";
import {
  restoreWorkerError,
  serializeWorkerError,
  type CompilerJob,
  type CompilerResponse,
  type ProviderRequest,
  type ProviderResponse
} from "./compilerProtocol.js";
import { snapshotTransform } from "./transformSnapshot.js";

// One bounded parser cache per worker; source/content keys isolate environments.
let cache: CompilationCache | undefined;
let partitions = 0;

export async function runCompilerJob(
  job: CompilerJob
): Promise<CompilerResponse> {
  const start = performance.now();
  let requestId = 0;
  const pending = new Map<
    number,
    { resolve(value: never): void; reject(error: Error): void }
  >();

  job.port.on("message", (response: ProviderResponse) => {
    const request = pending.get(response.id);
    if (!request) return;

    pending.delete(response.id);

    if (response.ok) request.resolve(response.value as never);
    else request.reject(restoreWorkerError(response.error));
  });

  const request = (message: Omit<ProviderRequest, "id">): Promise<never> =>
    new Promise((resolve, reject) => {
      const id = ++requestId;
      pending.set(id, { resolve, reject });
      job.port.postMessage({ ...message, id });
    });

  try {
    if (job.kind === "scoped")
      return {
        ok: true,
        value: transformScopedDependencySource(job.input),
        duration: performance.now() - start
      };

    if (job.cache && partitions !== job.cachePartitions) {
      cache?.clear();
      partitions = job.cachePartitions;
      cache = new CompilationCache(
        Math.max(1, Math.floor(512 / partitions)),
        Math.floor((64 * 1024 * 1024) / partitions)
      );
    }

    const provider: StaticCssEvalSourceProvider | undefined = job.provider
      ? {
          resolve: (...args) => request({ kind: "resolve", args }),

          load: (...args) => request({ kind: "load", args })
        }
      : undefined;

    const result = await transformSourceUncached(
      {
        ...job.input,
        babel: {
          ...job.input.babel,
          compilationCache: job.cache ? cache : undefined,
          staticCssEvalSourceProvider: provider
        }
      },
      job.cache
    );

    return {
      ok: true,
      value: snapshotTransform(result),
      duration: performance.now() - start
    };
  } catch (error) {
    const failure = serializeWorkerError(error);
    const staticCssEval = (error as BabelTransformError)?.staticCssEval;

    if (staticCssEval)
      failure.transform = snapshotTransform({
        code: "",
        result: ["", ""],
        staticCssEval
      });

    return { ok: false, error: failure, duration: performance.now() - start };
  } finally {
    job.port.close();
  }
}
