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
  type CompilerTransportMetrics,
  type ProviderBatch,
  type ProviderRequest,
  type ProviderRequestMessage,
  type ProviderResponse
} from "./compilerProtocol.js";
import { snapshotTransform } from "./transformSnapshot.js";
import {
  CompilerPayloadCache,
  compilerCacheBytes,
  compilerPayloadBytes,
  compilerPayloadProtocol
} from "./compilerPayload.js";

// One bounded parser cache per worker; source/content keys isolate environments.
let cache: CompilationCache | undefined;
let partitions = 0;
let payloads: CompilerPayloadCache | undefined;

export async function runCompilerJob(
  job: CompilerJob
): Promise<CompilerResponse> {
  const start = performance.now();
  let requestId = 0;
  const transport: CompilerTransportMetrics = {
    protocol: compilerPayloadProtocol,
    payloadHits: 0,
    payloadMisses: 0,
    payloadBytes: 0,
    providerRequests: 0,
    providerBatches: 0
  };

  const outbox: ProviderRequest[] = [];
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

  const request = (message: ProviderRequestMessage): Promise<never> =>
    new Promise((resolve, reject) => {
      const id = ++requestId;
      pending.set(id, { resolve, reject });

      const value = { ...message, id };

      if (message.kind !== "payload") transport.providerRequests++;

      if (!job.batchProviderRequests || message.kind === "payload") {
        job.port.postMessage(value);

        return;
      }

      outbox.push(value);

      if (outbox.length === 1)
        queueMicrotask(() => {
          while (outbox.length) {
            const requests = outbox.splice(0, 64);
            transport.providerBatches++;

            try {
              job.port.postMessage(
                requests.length === 1
                  ? requests[0]
                  : ({ kind: "batch", requests } satisfies ProviderBatch)
              );
            } catch (error) {
              for (const request of requests) {
                pending
                  .get(request.id)
                  ?.reject(
                    error instanceof Error ? error : new Error(String(error))
                  );
                pending.delete(request.id);
              }
            }
          }
        });
    });

  try {
    if (job.cache && partitions !== job.cachePartitions) {
      cache?.clear();
      partitions = job.cachePartitions;
      cache = new CompilationCache(
        Math.max(1, Math.floor(512 / partitions)),
        Math.floor((compilerCacheBytes - compilerPayloadBytes) / partitions)
      );
      payloads = new CompilerPayloadCache(
        Math.floor(compilerPayloadBytes / partitions),
        Math.max(1, Math.floor(128 / partitions))
      );
    }

    payloads?.reset(job.environment, job.generation);

    if (job.sourcePayload) {
      const { reference, inline } = job.sourcePayload;
      if (
        !job.cache ||
        reference.environment !== job.environment ||
        reference.generation !== job.generation
      )
        throw new Error(
          "Compiler source payload belongs to another generation"
        );

      let source: string | undefined;
      let validate = inline;

      if (inline)
        source =
          job.kind === "transform" ? job.input.source : job.input.contents;
      else {
        source = payloads?.get(reference);

        if (source !== undefined) transport.payloadHits++;
        else {
          transport.payloadMisses++;
          validate = true;
          source = await request({ kind: "payload", reference });

          if (typeof source !== "string")
            throw new Error("Compiler source payload was unavailable");

          transport.payloadBytes += Buffer.byteLength(source);
        }
      }

      if (validate) payloads?.accept(reference, source);

      job =
        job.kind === "transform"
          ? { ...job, input: { ...job.input, source } }
          : { ...job, input: { ...job.input, contents: source } };
    }

    if (job.kind === "scoped")
      return {
        ok: true,
        value: transformScopedDependencySource(job.input),
        duration: performance.now() - start,
        transport
      };

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
      duration: performance.now() - start,
      transport
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

    return {
      ok: false,
      error: failure,
      duration: performance.now() - start,
      transport
    };
  } finally {
    job.port.close();
  }
}
