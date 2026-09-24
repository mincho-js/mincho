import { MessageChannel } from "node:worker_threads";
import type Tinypool from "tinypool";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompilationExecution } from "./compilationExecution.js";
import { runCompilerJob } from "./compilerWorker.js";
import {
  CompilerPayloadCache,
  compilerPayloadContext
} from "./compilerPayload.js";
import type {
  CompilerJob,
  ProviderBatch,
  ProviderRequest
} from "./compilerProtocol.js";
import type { ScopedDependencyOptions } from "./compile.js";
import type { BabelTransformSourceOptions } from "./babel.js";

const transportIdentity = vi.hoisted(() =>
  vi.fn(async () => "transport-test-compiler")
);

vi.mock("./diskCache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./diskCache.js")>()),
  getCompilerIdentity: transportIdentity
}));

vi.mock("./babel.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./babel.js")>();

  return {
    ...original,

    transformSourceUncached: async (
      options: BabelTransformSourceOptions,
      cache: boolean
    ) => {
      if (options.filename !== "/virtual/batch-provider.ts")
        return original.transformSourceUncached(options, cache);

      const provider = options.babel!.staticCssEvalSourceProvider!;
      await Promise.all([
        provider.load("same"),
        provider.load("same"),
        provider.resolve("owner", "./third")
      ]);

      return { code: "export const value = 1;", result: ["", ""] };
    }
  };
});

vi.mock("./compile.js", () => ({
  transformScopedDependencySource: (input: ScopedDependencyOptions) =>
    input.contents
}));

const source = "/*" + "a".repeat(40 * 1024) + "*/ export const value = 1;";
const input: ScopedDependencyOptions = {
  contents: source,
  filePath: "/project/input.ts",
  loader: "ts",
  packageName: "test",
  rootPath: "/project"
};

const executions: CompilationExecution[] = [];

afterEach(async () => {
  await Promise.all(executions.splice(0).map((execution) => execution.close()));
  transportIdentity.mockReset().mockResolvedValue("transport-test-compiler");
});

function execution(cache = true) {
  const result = new CompilationExecution({ workers: 1 }, cache);
  executions.push(result);

  return result;
}

describe("worker source transport", () => {
  it("retains direct delivery when optional compiler identity cannot be read", async () => {
    transportIdentity.mockRejectedValueOnce(
      new Error("compiler artifacts unavailable")
    );

    const runtime = execution();
    const jobs: CompilerJob[] = [];
    const pool = {
      run: async (job: CompilerJob) => {
        jobs.push(job);

        return runCompilerJob(job);
      }
    } as unknown as Tinypool;

    for (let index = 0; index < 2; index++) {
      const result = await runtime.cpu(
        input.filePath,
        source,
        async (_pool, partitions) =>
          runtime.dispatch("scoped", input, undefined, pool, partitions),
        async () => {
          throw new Error("Unexpected inline fallback");
        }
      );

      expect(result.ok).toBe(true);

      if (result.ok) expect(result.value).toBe(source);
    }

    expect(
      jobs.every(
        (job) =>
          !job.sourcePayload &&
          (job.input as ScopedDependencyOptions).contents === source
      )
    ).toBe(true);
    expect(transportIdentity).toHaveBeenCalledTimes(1);
  });

  it("microtask-batches provider transport without dropping duplicate requests", async () => {
    const { port1, port2 } = new MessageChannel();
    const batches: ProviderBatch[] = [];
    port1.on("message", (message: ProviderBatch) => {
      batches.push(message);

      for (const request of message.requests)
        port1.postMessage({ id: request.id, ok: true, value: null });
    });

    try {
      const result = await runCompilerJob({
        kind: "transform",
        input: { filename: "/virtual/batch-provider.ts", source: "" },
        environment: "provider-batch",
        generation: 1,
        cache: true,
        cachePartitions: 2,
        provider: true,
        batchProviderRequests: true,
        port: port2
      });

      expect(result).toMatchObject({
        ok: true,
        transport: { providerRequests: 3, providerBatches: 1 }
      });
      expect(batches).toHaveLength(1);
      expect(batches[0].requests.map((request) => request.kind)).toEqual([
        "load",
        "load",
        "resolve"
      ]);
    } finally {
      port1.close();
    }
  });

  it("reports a failed batched postMessage as a compilation error instead of an unhandled microtask", async () => {
    const { port1, port2 } = new MessageChannel();
    vi.spyOn(port2, "postMessage").mockImplementation(() => {
      throw new Error("closed transport");
    });

    try {
      expect(
        await runCompilerJob({
          kind: "transform",
          input: { filename: "/virtual/batch-provider.ts", source: "" },
          environment: "provider-batch-failure",
          generation: 1,
          cache: true,
          cachePartitions: 2,
          provider: true,
          batchProviderRequests: true,
          port: port2
        })
      ).toMatchObject({ ok: false, error: { message: "closed transport" } });
    } finally {
      port1.close();
    }
  });

  it("fetches from the original job on an arbitrary worker miss, then reuses verified bytes", async () => {
    const sender = new CompilerPayloadCache(1_000_000);
    const scope = {
      environment: "transport-worker",
      generation: 1,
      context: compilerPayloadContext(["compiler", input.filePath])
    };

    const first = sender.prepare(scope, source)!;
    const sourcePayload = { ...first, inline: false };
    let requests = 0;

    async function run(value = source, partitions = 2) {
      const { port1, port2 } = new MessageChannel();
      port1.on("message", (request: ProviderRequest) => {
        expect(request.kind).toBe("payload");

        requests++;
        port1.postMessage({ id: request.id, ok: true, value });
      });

      try {
        return await runCompilerJob({
          kind: "scoped",
          input: { ...input, contents: "" },
          ...scope,
          cache: true,
          cachePartitions: partitions,
          sourcePayload,
          port: port2
        });
      } finally {
        port1.close();
      }
    }

    // Simulate sender eviction before a worker asks for the content.
    sender.reset(scope.environment);

    expect(sender.get(first.reference)).toBeUndefined();

    const cold = await run();

    expect(cold).toMatchObject({
      ok: true,
      value: source,
      transport: {
        payloadMisses: 1,
        payloadHits: 0,
        payloadBytes: Buffer.byteLength(source)
      }
    });

    const warm = await run();

    expect(warm).toMatchObject({
      ok: true,
      value: source,
      transport: { payloadHits: 1, payloadMisses: 0, payloadBytes: 0 }
    });
    expect(requests).toBe(1);

    // Repartitioning represents a fresh worker and cannot assume a sender hit implies a receiver hit.
    expect(await run(source, 3)).toMatchObject({
      ok: true,
      transport: { payloadMisses: 1 }
    });
    expect(requests).toBe(2);
  });

  it("rejects a mismatched fetch without retaining it and recovers on the next job", async () => {
    const sender = new CompilerPayloadCache(1_000_000);
    const scope = {
      environment: "transport-corruption",
      generation: 1,
      context: "compiler"
    };

    const sourcePayload = { ...sender.prepare(scope, source)!, inline: false };

    async function run(value: string) {
      const { port1, port2 } = new MessageChannel();
      port1.on("message", (request: ProviderRequest) =>
        port1.postMessage({ id: request.id, ok: true, value })
      );

      try {
        return await runCompilerJob({
          kind: "scoped",
          input: { ...input, contents: "" },
          ...scope,
          cache: true,
          cachePartitions: 2,
          sourcePayload,
          port: port2
        });
      } finally {
        port1.close();
      }
    }

    expect(await run(source + "bad")).toMatchObject({
      ok: false,
      error: {
        message: "Compiler source payload did not match its content address"
      }
    });
    expect(await run(source)).toMatchObject({
      ok: true,
      value: source,
      transport: { payloadMisses: 1 }
    });
  });

  it("uses references only after protocol confirmation and resets on generation changes", async () => {
    const runtime = execution();
    const jobs: CompilerJob[] = [];
    const pool = {
      run: async (job: CompilerJob) => {
        jobs.push(job);

        return runCompilerJob(job);
      }
    } as unknown as Tinypool;

    const run = () =>
      runtime.cpu(
        input.filePath,
        source,
        async (_pool, partitions) =>
          runtime.dispatch("scoped", input, undefined, pool, partitions),
        async () => {
          throw new Error("Unexpected inline fallback");
        }
      );

    expect(await run()).toMatchObject({ ok: true, value: source });
    expect(await run()).toMatchObject({
      ok: true,
      value: source,
      transport: { payloadHits: 1 }
    });
    expect(jobs[0].sourcePayload?.inline).toBe(true);
    expect(jobs[1].sourcePayload?.inline).toBe(false);
    expect((jobs[1].input as ScopedDependencyOptions).contents).toBe("");

    runtime.begin();

    expect(await run()).toMatchObject({ ok: true, value: source });
    expect(jobs[2].sourcePayload?.inline).toBe(true);
    expect(jobs[2].sourcePayload?.reference.id).not.toBe(
      jobs[0].sourcePayload?.reference.id
    );
  });

  it("keeps direct DTOs with cache disabled", async () => {
    const runtime = execution(false);
    const jobs: CompilerJob[] = [];
    const pool = {
      run: async (job: CompilerJob) => {
        jobs.push(job);

        return runCompilerJob(job);
      }
    } as unknown as Tinypool;

    for (let index = 0; index < 2; index++)
      expect(
        await runtime.cpu(
          input.filePath,
          source,
          async (_pool, partitions) =>
            runtime.dispatch("scoped", input, undefined, pool, partitions),
          async () => {
            throw new Error("Unexpected inline fallback");
          }
        )
      ).toMatchObject({ ok: true, value: source });

    expect(
      jobs.every(
        (job) =>
          !job.sourcePayload &&
          !job.batchProviderRequests &&
          (job.input as ScopedDependencyOptions).contents === source
      )
    ).toBe(true);
  });

  it("falls back to direct sources with a worker that lacks the payload protocol", async () => {
    const runtime = execution();
    const jobs: CompilerJob[] = [];
    const pool = {
      run: async (job: CompilerJob) => {
        jobs.push(job);

        return {
          ok: true,
          value: (job.input as ScopedDependencyOptions).contents,
          duration: 0
        };
      }
    } as unknown as Tinypool;

    for (let index = 0; index < 2; index++)
      expect(
        await runtime.cpu(
          input.filePath,
          source,
          async (_pool, partitions) =>
            runtime.dispatch("scoped", input, undefined, pool, partitions),
          async () => {
            throw new Error("Unexpected inline fallback");
          }
        )
      ).toMatchObject({ ok: true, value: source });

    expect(jobs[0].sourcePayload?.inline).toBe(true);
    expect(jobs[1].sourcePayload).toBeUndefined();
  });

  it("preserves every provider invocation and its order within a transport batch", async () => {
    const runtime = execution();
    const calls: string[] = [];
    const pool = {
      run: async (job: CompilerJob) => {
        const pending = new Promise<void>((resolve) => {
          let responses = 0;
          job.port.on("message", () => {
            if (++responses === 3) resolve();
          });
        });

        const requests: ProviderRequest[] = [
          { id: 1, kind: "load", args: ["same"] },
          { id: 2, kind: "load", args: ["same"] },
          { id: 3, kind: "resolve", args: ["owner", "./third"] }
        ];

        job.port.postMessage({
          kind: "batch",
          requests
        } satisfies ProviderBatch);
        await pending;
        job.port.close();

        return { ok: true, value: source, duration: 0 };
      }
    } as unknown as Tinypool;

    const provider = {
      load: (id: string) => {
        calls.push(`load:${id}`);

        return null;
      },

      resolve: (owner: string, id: string) => {
        calls.push(`resolve:${owner}:${id}`);

        return null;
      }
    };

    await runtime.dispatch("scoped", input, provider, pool, 2);

    expect(calls).toEqual(["load:same", "load:same", "resolve:owner:./third"]);
  });
});
