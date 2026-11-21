import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CompilationExecution,
  currentCompilationExecution,
  executeTransform
} from "./compilationExecution.js";
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
import type {
  BabelTransformSourceOptions,
  ConsumerRuntimeSource
} from "./babel.js";
import { restoreTransform } from "./transformSnapshot.js";
import type { TransformSnapshot } from "./transformSnapshot.js";

type CompilerPool = Parameters<CompilationExecution["dispatch"]>[3];

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
      if (options.filename === "/virtual/consumer-runtime.ts") {
        const runtime = options.babel!.consumerRuntimeSource!;
        const [value, fallback, unavailable, raw] = await Promise.all([
          runtime("/theme.css.ts?runtime"),
          runtime("/ordinary.ts"),
          runtime("/pending.css.ts"),
          options.babel!.staticCssEvalSourceProvider!.load("/theme.css.ts")
        ]);
        return {
          code: JSON.stringify({
            value,
            raw,
            unavailable,
            fallback: fallback === undefined
          }),
          result: ["", ""]
        };
      }
      if (options.filename === "/virtual/runtime-generation.ts") {
        const value =
          await options.babel!.consumerRuntimeSource!("/theme.css.ts");
        return { code: value?.source ?? "unproven", result: ["", ""] };
      }
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
  transformScopedDependency: (input: ScopedDependencyOptions) => ({
    source: input.contents,
    cssScopeOrigins: []
  })
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
  it("chooses the in-process transform when requested by the host", async () => {
    const runtime = execution();
    const admit = vi.spyOn(runtime, "cpu");
    const expected = {
      code: "export const value = 1;",
      result: ["", ""] as [string, string]
    };
    const inline = vi.fn(async () => expected);

    const result = await runtime.run(() =>
      executeTransform(
        {
          filename: "/virtual/ordinary.ts",
          source: expected.code,
          keepRuntimeSourceInProcess: true
        },
        inline
      )
    );

    expect(result).toBe(expected);
    expect(inline).toHaveBeenCalledOnce();
    expect(admit).not.toHaveBeenCalled();
  });

  it("retains effective parser plugins through worker result snapshots", async () => {
    const runtime = execution();
    const pool: CompilerPool = { run: (job) => runCompilerJob(job) };
    const plugins: NonNullable<
      NonNullable<BabelTransformSourceOptions["babel"]>["parserOpts"]
    >["plugins"] = [["decorators", { decoratorsBeforeExport: false }]];
    const result = await runtime.dispatch(
      "transform",
      {
        filename: "/virtual/decorated.ts",
        source:
          "function sealed(value) { return value; } export @sealed class Factory {}",
        babel: { configFile: false, babelrc: false, parserOpts: { plugins } }
      },
      undefined,
      pool,
      2
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const transformed = restoreTransform(result.value as TransformSnapshot);
      expect(transformed.parserPlugins).toEqual(
        expect.arrayContaining(plugins!)
      );
    }
  });

  it("routes consumer runtime and ordinary source requests independently through worker RPC", async () => {
    const runtime = execution();
    const jobs: CompilerJob[] = [];
    const pool: CompilerPool = {
      run: async (job) => {
        jobs.push(job);
        return runCompilerJob(job);
      }
    };
    const dispatch = runtime.dispatch.bind(runtime);
    const dispatched = vi
      .spyOn(runtime, "dispatch")
      .mockImplementation(
        (kind, input, provider, _pool, partitions, consumer) =>
          dispatch(kind, input, provider, pool, partitions, consumer)
      );
    const nestedInline = vi.fn(async () => ({
      code: "nested",
      result: ["", ""] as [string, string]
    }));
    const generated: ConsumerRuntimeSource = {
      source: "export const className = 'generated';",
      sourceHash: "runtime-hash",
      version: "client:7",
      watchFiles: ["/tokens.json"]
    };
    const consumer = vi.fn(async (id: string) => {
      expect(currentCompilationExecution()).toBe(runtime);
      if (id === "/ordinary.ts") return undefined;
      if (id === "/pending.css.ts") return { watchFiles: ["/missing.json"] };
      await executeTransform(
        { filename: "/virtual/nested-runtime.ts", source: "" },
        nestedInline
      );
      return generated;
    });
    const rawLoad = vi.fn(() => ({ source: "raw authoring" }));
    const inline = vi.fn(async () => ({
      code: "unexpected inline bypass",
      result: ["", ""] as [string, string]
    }));

    const result = await runtime.run(() =>
      executeTransform(
        {
          filename: "/virtual/consumer-runtime.ts",
          source: "",
          babel: {
            consumerRuntimeSource: consumer,
            staticCssEvalSourceProvider: { resolve: () => null, load: rawLoad }
          }
        },
        inline
      )
    );

    expect(JSON.parse(result.code)).toEqual({
      value: generated,
      raw: { source: "raw authoring" },
      unavailable: { watchFiles: ["/missing.json"] },
      fallback: true
    });
    expect(inline).not.toHaveBeenCalled();
    expect(nestedInline).toHaveBeenCalledOnce();
    expect(dispatched).toHaveBeenCalledOnce();
    expect(consumer.mock.calls.map(([id]) => id)).toEqual([
      "/theme.css.ts?runtime",
      "/ordinary.ts",
      "/pending.css.ts"
    ]);
    expect(rawLoad).toHaveBeenCalledExactlyOnceWith("/theme.css.ts");
    expect(jobs[0]).toMatchObject({ provider: true, consumerRuntime: true });
    expect(
      (jobs[0].input as BabelTransformSourceOptions).babel
        ?.consumerRuntimeSource
    ).toBeUndefined();
  });

  it("rejects consumer runtime responses from an obsolete generation", async () => {
    const runtime = execution();
    let entered!: () => void;
    let release!: (value: ConsumerRuntimeSource) => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<ConsumerRuntimeSource>((resolve) => {
      release = resolve;
    });
    const consumer = () => {
      entered();
      return gate;
    };
    const pool: CompilerPool = { run: (job) => runCompilerJob(job) };
    const input = { filename: "/virtual/runtime-generation.ts", source: "" };
    const pending = runtime.run(() =>
      runtime.dispatch("transform", input, undefined, pool, 2, consumer)
    );
    await ready;
    runtime.begin();
    release({
      source: "stale",
      sourceHash: "stale",
      version: "old",
      watchFiles: []
    });
    expect(await pending).toMatchObject({
      ok: false,
      error: { name: "MinchoCompilationStaleGenerationError" }
    });

    const fresh = await runtime.dispatch(
      "transform",
      input,
      undefined,
      pool,
      2,
      () => ({
        source: "current",
        sourceHash: "current",
        version: "new",
        watchFiles: []
      })
    );
    expect(fresh.ok).toBe(true);
    if (fresh.ok)
      expect(restoreTransform(fresh.value as TransformSnapshot).code).toBe(
        "current"
      );
  });

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
    } satisfies CompilerPool;

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

      if (result.ok)
        expect(result.value).toEqual({ source, cssScopeOrigins: [] });
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
      value: { source, cssScopeOrigins: [] },
      transport: {
        payloadMisses: 1,
        payloadHits: 0,
        payloadBytes: Buffer.byteLength(source)
      }
    });

    const warm = await run();

    expect(warm).toMatchObject({
      ok: true,
      value: { source, cssScopeOrigins: [] },
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
      value: { source, cssScopeOrigins: [] },
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
    } satisfies CompilerPool;

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

    expect(await run()).toMatchObject({
      ok: true,
      value: { source, cssScopeOrigins: [] }
    });
    expect(await run()).toMatchObject({
      ok: true,
      value: { source, cssScopeOrigins: [] },
      transport: { payloadHits: 1 }
    });
    expect(jobs[0].sourcePayload?.inline).toBe(true);
    expect(jobs[1].sourcePayload?.inline).toBe(false);
    expect((jobs[1].input as ScopedDependencyOptions).contents).toBe("");

    runtime.begin();

    expect(await run()).toMatchObject({
      ok: true,
      value: { source, cssScopeOrigins: [] }
    });
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
    } satisfies CompilerPool;

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
      ).toMatchObject({ ok: true, value: { source, cssScopeOrigins: [] } });

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
          value: {
            source: (job.input as ScopedDependencyOptions).contents,
            cssScopeOrigins: []
          },
          duration: 0
        };
      }
    } satisfies CompilerPool;

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
      ).toMatchObject({ ok: true, value: { source, cssScopeOrigins: [] } });

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

        return {
          ok: true,
          value: { source, cssScopeOrigins: [] },
          duration: 0
        };
      }
    } satisfies CompilerPool;

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
