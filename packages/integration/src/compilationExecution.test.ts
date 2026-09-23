import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Tinypool from "tinypool";
import {
  CompilationExecution,
  currentCompilationExecution,
  executeScopedTransform
} from "./compilationExecution.js";
import {
  babelTransformSource,
  type StaticCssEvalSourceProvider
} from "./babel.js";
import { CompilationDiagnostics } from "./diagnostics.js";
import { getCpuBudget } from "./cpuBudget.js";
import { MinchoProjectEngine } from "./staticCssEvalProjectEngine.js";
import { snapshotTransform } from "./transformSnapshot.js";

const executions: CompilationExecution[] = [];

afterEach(async () => {
  await Promise.all(executions.splice(0).map((execution) => execution.close()));
});

function execution(workers: number) {
  const value = new CompilationExecution({ workers });
  executions.push(value);

  return value;
}

describe("compiler workers", () => {
  it("preserves the options of a disabled execution nested inside an enabled one", async () => {
    const outer = execution(1);
    const inner = new CompilationExecution({ workers: 0 });
    executions.push(inner);
    await outer.run(async () => {
      await inner.run(async () =>
        expect(currentCompilationExecution()).toBe(inner)
      );

      expect(currentCompilationExecution()).toBe(outer);
    });
  });

  it("does not publish an engine snapshot after the generation changes during dispatch", async () => {
    const runtime = execution(1);
    const options = {
      filename: join(process.cwd(), "src/__fixtures__/worker-stale.ts"),
      source:
        'import {css} from "@mincho-js/css"; export const box = css({color: "red"});'
    };

    const value = snapshotTransform(await babelTransformSource(options));
    const engine = new MinchoProjectEngine();
    const refresh = vi.spyOn(engine, "refreshFile");
    vi.spyOn(runtime, "dispatch").mockImplementation(async () => {
      runtime.begin();

      return { ok: true, value, duration: 0 };
    });

    await expect(
      runtime.run(() =>
        babelTransformSource({
          ...options,
          babel: { staticCssEvalProjectEngine: engine }
        })
      )
    ).rejects.toMatchObject({ name: "MinchoCompilationStaleGenerationError" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("closes without waiting for a bundler-owned deferred publication", async () => {
    const runtime = execution(0);
    let release!: () => void;
    const pending = runtime.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    await runtime.close();
    release();
    await pending;
  });

  it("cancels a worker waiting for its main-thread provider during close", async () => {
    const runtime = execution(1);
    let release!: (value: { source: string }) => void;
    let started!: () => void;
    const gate = new Promise<{ source: string }>((resolve) => {
      release = resolve;
    });

    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });

    const pending = runtime.run(() =>
      babelTransformSource({
        filename: join(process.cwd(), "src/__fixtures__/worker-entry.tsx"),
        source:
          'import {color} from "./helper"; export const App = () => <div css={{color}} />;',
        babel: {
          jsxCssProp: true,
          staticCssEvalSourceProvider: {
            resolve: (_owner, request) =>
              request === "./helper"
                ? { id: "/virtual/worker-close-helper.ts" }
                : null,

            load: () => {
              started();

              return gate;
            }
          }
        }
      })
    );

    const rejected = expect(pending).rejects.toMatchObject({
      name: "MinchoCompilationStaleGenerationError"
    });

    await ready;
    await runtime.close();
    release({ source: 'export const color = "red";' });
    await rejected;
  });

  it("closes queued tasks, rejects stale results and can start a new generation", async () => {
    const runtime = execution(1);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });

    const first = runtime.externalCpu(
      1,
      async () => {
        started();
        await gate;

        return "stale";
      },
      async () => "inline"
    );

    await ready;

    const queued = runtime.externalCpu(
      1,
      async () => "queued",
      async () => "inline"
    );

    const firstRejected = expect(first).rejects.toMatchObject({
      name: "MinchoCompilationStaleGenerationError"
    });

    const queuedRejected = expect(queued).rejects.toMatchObject({
      name: "MinchoCompilationStaleGenerationError"
    });

    const closed = runtime.close();
    release();
    await Promise.all([closed, firstRejected, queuedRejected]);
    runtime.begin();

    expect(
      await runtime.externalCpu(
        1,
        async () => "new",
        async () => "inline"
      )
    ).toBe("new");
  });

  it("bounds the queue before serialization and preserves the concurrency cap", async () => {
    const runtime = execution(1);
    let release!: () => void;
    let saturated!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const ready = new Promise<void>((resolve) => {
      saturated = resolve;
    });

    let active = 0;
    let maximum = 0;
    let inline = 0;
    const count = 2 * (await getCpuBudget()).budget + 2;
    const pending = Array.from({ length: count }, () =>
      runtime.externalCpu(
        1,
        async () => {
          maximum = Math.max(maximum, ++active);
          await gate;
          active--;

          return 1;
        },
        async () => {
          inline++;
          saturated();

          return 1;
        }
      )
    );

    await ready;
    release();

    expect((await Promise.all(pending)).reduce((a, b) => a + b, 0)).toBe(count);
    expect(maximum).toBe(1);
    expect(inline).toBeGreaterThan(0);
  });

  it("matches inline Babel output, maps and dependency analysis with provider RPC", async () => {
    const diagnostics = new CompilationDiagnostics({ console: true });
    const engine = new MinchoProjectEngine();
    const provider: StaticCssEvalSourceProvider = {
      resolve: (_file, source) =>
        source === "./helper" ? { id: "/virtual/helper.ts" } : null,

      load: () => ({
        source: 'export const color = "red";'
      })
    };

    const options = {
      filename: join(process.cwd(), "src/__fixtures__/worker.tsx"),
      source:
        'import { color } from "./helper"; export const App = () => <div css={{color}} />;',
      sourceMaps: true,
      babel: {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider,
        staticCssEvalProjectEngine: engine
      }
    };

    const inline = await execution(0).run(() => babelTransformSource(options));
    const pooled = await diagnostics.run(options.filename, "test", () =>
      execution(1).run(() => babelTransformSource(options))
    );

    expect(pooled.code).toBe(inline.code);
    expect(pooled.map).toEqual(inline.map);
    expect(pooled.result).toEqual(inline.result);
    expect(pooled.staticCssEval?.dependencies).toEqual(
      inline.staticCssEval?.dependencies
    );
    expect(
      engine.getFileResult(options.filename)?.generatedArtifacts
    ).toHaveLength(1);
    expect(
      diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events)
        .some((event) => event.phase === "worker-run")
    ).toBe(true);
  });

  it("runs nested provider transforms inline even when its only worker is waiting", async () => {
    const runtime = execution(1);
    let nested = 0;
    const result = await runtime.run(() =>
      babelTransformSource({
        filename: join(process.cwd(), "src/__fixtures__/nested-worker.tsx"),
        source:
          'import { color } from "./helper"; export const App = () => <div css={{color}} />;',
        babel: {
          jsxCssProp: true,
          staticCssEvalSourceProvider: {
            resolve: (_file, source) =>
              source === "./helper" ? { id: "/virtual/helper.ts" } : null,

            load: async () => {
              nested++;
              await runtime.run(() =>
                babelTransformSource({
                  filename: "/virtual/nested.ts",
                  source: "export const n = 1;"
                })
              );

              return { source: 'export const color = "blue";' };
            }
          }
        }
      })
    );

    expect(nested).toBeGreaterThan(0);
    expect(result.result[1]).toContain('color: "blue"');
  });

  it.each(["external Babel configuration", "worker startup failure"])(
    "allows nested provider transforms after %s falls back inline",
    async (reason) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-worker-fallback-"));
      const runtime = execution(1);
      let pending: ReturnType<typeof babelTransformSource> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      try {
        if (reason === "external Babel configuration") {
          await writeFile(join(root, ".babelrc.json"), "{}");
        } else {
          const dispatch = runtime.dispatch.bind(runtime);
          const pool = {
            run: async () => {
              throw Object.assign(new Error("Worker entry unavailable"), {
                code: "ENOENT"
              });
            }
          } as unknown as Tinypool;

          vi.spyOn(runtime, "dispatch").mockImplementationOnce(
            (kind, input, provider, _pool, partitions) =>
              dispatch(kind, input, provider, pool, partitions)
          );
        }

        let nested = 0;
        pending = runtime.run(() =>
          babelTransformSource({
            filename: join(root, "entry.tsx"),
            source:
              'import { color } from "./helper"; export const App = () => <div css={{color}} />;',
            babel: {
              jsxCssProp: true,
              staticCssEvalSourceProvider: {
                resolve: (_file, source) =>
                  source === "./helper" ? { id: "/virtual/helper.ts" } : null,
                load: async () => {
                  nested++;
                  await runtime.run(() =>
                    babelTransformSource({
                      filename: "/virtual/nested-fallback.ts",
                      source: "export const n = 1;"
                    })
                  );

                  return { source: 'export const color = "blue";' };
                }
              }
            }
          })
        );

        const result = await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () =>
                reject(new Error("Nested provider transform did not finish")),
              5000
            );
          })
        ]);

        expect(nested).toBeGreaterThan(0);
        expect(result.result[1]).toContain('color: "blue"');
      } finally {
        clearTimeout(timeout);
        await runtime.close();
        await pending?.catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000
  );

  it("rejects inline fallback results after their generation changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mincho-worker-fallback-"));
    const runtime = execution(1);
    const inline = vi.fn(() => {
      runtime.begin();

      return "export const n = 1;";
    });

    try {
      await writeFile(join(root, ".babelrc.json"), "{}");
      await expect(
        runtime.run(() =>
          executeScopedTransform(
            {
              filePath: join(root, "entry.ts"),
              contents: "export const n = 1;",
              loader: "ts",
              packageName: "fixture",
              rootPath: root
            },
            inline
          )
        )
      ).rejects.toMatchObject({
        name: "MinchoCompilationStaleGenerationError"
      });
      expect(inline).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves compilation errors and recovers for subsequent tasks", async () => {
    const runtime = execution(1);

    await expect(
      runtime.run(() =>
        babelTransformSource({
          filename: "/virtual/broken.ts",
          source: "export const = ;"
        })
      )
    ).rejects.toMatchObject({
      name: "BabelTransformError",
      file: "/virtual/broken.ts"
    });
    expect(
      (
        await runtime.run(() =>
          babelTransformSource({
            filename: "/virtual/good.ts",
            source: "export const value = 1;"
          })
        )
      ).code
    ).toContain("value = 1");
  });

  it("keeps opaque Babel plugins inline", async () => {
    let calls = 0;
    await execution(1).run(() =>
      babelTransformSource({
        filename: "/virtual/custom.ts",
        source: "export const value = 1;",
        babel: {
          plugins: [
            () => ({
              visitor: {
                Program() {
                  calls++;
                }
              }
            })
          ]
        }
      })
    );

    expect(calls).toBe(1);
  });
});
