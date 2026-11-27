import { createHash } from "node:crypto";
import { hasValidatedPatternIntrinsicEffects } from "./staticCssEvalSource.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cachedTransform } from "./transformCache.js";
import {
  babelTransformSource,
  type BabelOptions,
  type BabelTransformSourceOptions,
  type ConsumerRuntimeSource,
  type StaticCssEvalSourceProvider
} from "./babel.js";
import { CompilationCache } from "./compilationCache.js";
import { CompilationDiagnostics } from "./diagnostics.js";
import { retainRuntimeSourceDependencies } from "./extractCalls.js";
import { createStaticCssEvalPrepass } from "./staticCssEvalPrepass.js";
import { MinchoProjectEngine } from "./staticCssEvalProjectEngine.js";

describe("Babel transform cache", () => {
  it("revalidates a host pattern contract on cache hits even with unchanged bytes/version", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-pattern-cache-"));
    try {
      const filename = join(root, "entry.ts");
      const source = "export const value=4;";
      await writeFile(filename, source);
      let current = true;
      const runtime: ConsumerRuntimeSource = {
        source,
        sourceHash: createHash("sha256").update(source).digest("hex"),
        version: "same",
        watchFiles: [filename],
        validatesPatternIntrinsicEffects: () => current
      };
      const cache = new CompilationCache();
      const transform = vi.fn(async (input: BabelTransformSourceOptions) => {
        const observed = await input.babel!.consumerRuntimeSource!(filename, {
          purpose: "intrinsic-runtime"
        });
        return {
          code: hasValidatedPatternIntrinsicEffects(observed)
            ? "approved"
            : "observed",
          result: ["", ""] as [string, string]
        };
      });
      const run = () =>
        cachedTransform(
          cache,
          { filename, source, babel: { consumerRuntimeSource: () => runtime } },
          transform
        );
      expect((await run()).code).toBe("approved");
      expect((await run()).code).toBe("approved");
      expect(transform).toHaveBeenCalledTimes(1);
      current = false;
      expect((await run()).code).toBe("observed");
      expect(transform).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "retains raw and runtime closure cache inputs without per-view rediscovery (persistent: %s)",
    async (persistent) => {
      const root = await mkdtemp(join(tmpdir(), "intrinsic-closure-cache-"));
      try {
        const filename = join(root, "entry.ts");
        const raw = join(root, "raw.ts");
        const generated = join(root, "generated.ts");
        const watch = join(root, "host-config.json");
        const source = "import './raw';const [value=1]=[4];";
        const mutation =
          "Array.prototype[Symbol.iterator]=function*(){yield undefined};";
        await Promise.all(
          [filename, raw, generated, watch].map((file) =>
            writeFile(file, source)
          )
        );
        let rawSource = "export const value=4;";
        let runtimeSource = "export const generated=1;";
        let version = "v1";
        let available = true;
        const load = vi.fn((id: string) => ({
          source:
            id === filename
              ? source
              : id === raw
                ? rawSource
                : "export const template=0;",
          version,
          watchFiles: [id]
        }));
        const provider: StaticCssEvalSourceProvider = {
          resolve: (_importer, specifier) => ({
            id: specifier === "./raw" ? raw : generated,
            version
          }),
          load
        };
        const runtime: NonNullable<BabelOptions["consumerRuntimeSource"]> = (
          id,
          request
        ) => {
          if (request?.purpose === "intrinsic-owner") return undefined;
          if (!available && id === generated) return { watchFiles: [watch] };
          return {
            source:
              id === raw
                ? "import './generated';export const value=4;"
                : runtimeSource,
            sourceHash: "unchanged-declared-host-hash",
            version: "unchanged-declared-host-version",
            watchFiles: [watch]
          };
        };
        const makeCache = () => {
          const cache = new CompilationCache();
          if (persistent)
            cache.configure(
              undefined,
              join(root, "cache"),
              "intrinsic-closure"
            );
          return cache;
        };
        const cache = makeCache();
        const transform = vi.fn(async (input: BabelTransformSourceOptions) => {
          const result = await createStaticCssEvalPrepass(
            filename,
            input.babel!.staticCssEvalSourceProvider!,
            undefined,
            undefined,
            "values",
            undefined,
            undefined,
            { consumerRuntimeSource: input.babel!.consumerRuntimeSource }
          );
          expect(result.result.dependencyFiles).toEqual(
            expect.arrayContaining([raw, generated, watch])
          );
          return {
            code: JSON.stringify(
              result.intrinsicEnvironment?.arrayMapIntrinsics?.iterationIntact
            ),
            result: ["", ""] as [string, string]
          };
        });
        const run = () =>
          cachedTransform(
            persistent ? makeCache() : cache,
            {
              filename,
              source,
              babel: {
                cwd: root,
                staticCssEvalSourceProvider: provider,
                consumerRuntimeSource: retainRuntimeSourceDependencies(
                  runtime,
                  provider
                )
              }
            },
            transform
          );
        expect((await run()).code).toBe("true");
        // The prepass loads each exact source once. The retention wrapper must
        // not add a second discovery of every transitive dependency closure.
        expect(load.mock.calls.map(([id]) => id).sort()).toEqual(
          [filename, raw, generated].sort()
        );
        await run();
        expect(transform).toHaveBeenCalledTimes(1);
        rawSource = mutation;
        expect((await run()).code).toBe("false");
        expect(transform).toHaveBeenCalledTimes(2);
        rawSource = "export const value=5;";
        runtimeSource = mutation;
        expect((await run()).code).toBe("false");
        expect(transform).toHaveBeenCalledTimes(3);
        runtimeSource = "export const generated=2;";
        expect((await run()).code).toBe("true");
        expect(transform).toHaveBeenCalledTimes(4);
        version = "v2";
        await run();
        expect(transform).toHaveBeenCalledTimes(5);
        await writeFile(watch, "changed host config");
        await run();
        expect(transform).toHaveBeenCalledTimes(6);
        available = false;
        expect((await run()).code).toBe("false");
        await run();
        expect(transform).toHaveBeenCalledTimes(8);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([false, true])(
    "replays effect-only purposes and invalidates host views (persistent: %s)",
    async (persistent) => {
      const root = await mkdtemp(join(tmpdir(), "effect-view-cache-"));
      try {
        const filename = join(root, "entry.ts");
        const watched = join(root, "policy.ts");
        const source = "export const value=1;";
        await writeFile(filename, source);
        await writeFile(watched, "first");
        let view = "export const view=1;";
        let available = true;
        const requests = [
          { purpose: "intrinsic-owner" as const, sourceHash: "owner-hash" },
          { purpose: "intrinsic-runtime" as const },
          {
            purpose: "intrinsic-effects" as const,
            importerId: filename,
            specifier: "./asset.css",
            resolutionMode: "import" as const,
            attributes: "none" as const
          }
        ];
        const runtime = vi.fn<
          NonNullable<BabelOptions["consumerRuntimeSource"]>
        >(async (_id, request) => {
          expect(requests).toContainEqual(request);
          return available
            ? {
                source: view,
                sourceHash: view,
                version: "host",
                watchFiles: [watched]
              }
            : { watchFiles: [watched] };
        });
        const provider: StaticCssEvalSourceProvider = {
          resolve: () => null,
          load: () => ({ source: "require(opaque);", watchFiles: [watched] })
        };
        const makeCache = () => {
          const cache = new CompilationCache();
          if (persistent)
            cache.configure(undefined, join(root, "cache"), "effect-view");
          return cache;
        };
        const cache = makeCache();
        const transform = vi.fn(
          async (options: BabelTransformSourceOptions) => {
            const views = [];
            for (const request of requests)
              views.push(
                (await options.babel!.consumerRuntimeSource!(filename, request))
                  ?.source ?? null
              );
            return {
              code: JSON.stringify(views),
              result: ["", ""] as [string, string]
            };
          }
        );
        const run = () =>
          cachedTransform(
            persistent ? makeCache() : cache,
            {
              filename,
              source,
              babel: {
                cwd: root,
                consumerRuntimeSource: retainRuntimeSourceDependencies(
                  runtime,
                  provider
                )
              }
            },
            transform
          );
        await run();
        runtime.mockClear();
        await run();
        expect(transform).toHaveBeenCalledTimes(1);
        for (const request of requests)
          expect(runtime).toHaveBeenCalledWith(filename, request);
        view = "export const view=2;";
        expect((await run()).code).toContain("view=2");
        expect(transform).toHaveBeenCalledTimes(2);
        await writeFile(watched, "second");
        await run();
        expect(transform).toHaveBeenCalledTimes(3);
        available = false;
        expect((await run()).code).toBe("[null,null,null]");
        await run();
        expect(transform).toHaveBeenCalledTimes(5);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([false, true])(
    "revalidates native CSS effect receipts and exact edge args (persistent: %s)",
    async (persistent) => {
      const root = await mkdtemp(join(tmpdir(), "native-css-receipt-cache-"));
      try {
        const filename = join(root, "entry.ts");
        const css = join(root, "plain.css");
        const source = "export const value=1;";
        await writeFile(filename, source);
        await writeFile(css, ".plain{color:red}");
        let loader: "css" | "local-css" = "css";
        let hash = "first-bytes";
        let available = true;
        const request = {
          purpose: "intrinsic-effects" as const,
          importerId: filename,
          specifier: "./plain.css",
          resolutionMode: "import" as const,
          attributes: "none" as const
        };
        const runtime = vi.fn<
          NonNullable<BabelOptions["consumerRuntimeSource"]>
        >(async (_id, edge) => {
          expect(edge).toEqual(request);
          return {
            watchFiles: [css],
            ...(available
              ? {
                  intrinsicEffects: {
                    kind: "native-css" as const,
                    loader,
                    sourceHash: hash,
                    version: "same-host-version"
                  }
                }
              : {})
          };
        });
        const newCache = () => {
          const cache = new CompilationCache();
          if (persistent)
            cache.configure(
              undefined,
              join(root, "cache"),
              "native-css-effects"
            );
          return cache;
        };
        const cache = newCache();
        const transform = vi.fn(async (input: BabelTransformSourceOptions) => {
          const value = await input.babel!.consumerRuntimeSource!(css, request);
          return {
            code: JSON.stringify(value?.intrinsicEffects ?? null),
            result: ["", ""] as [string, string]
          };
        });
        const run = () =>
          cachedTransform(
            persistent ? newCache() : cache,
            {
              filename,
              source,
              babel: {
                cwd: root,
                consumerRuntimeSource: retainRuntimeSourceDependencies(runtime)
              }
            },
            transform
          );
        const first = await run();
        expect((await run()).code).toBe(first.code);
        expect(transform).toHaveBeenCalledTimes(1);
        hash = "new-bytes";
        expect((await run()).code).toContain("new-bytes");
        expect(transform).toHaveBeenCalledTimes(2);
        loader = "local-css";
        expect((await run()).code).toContain("local-css");
        expect(transform).toHaveBeenCalledTimes(3);
        await writeFile(css, ".plain{color:blue}");
        await run();
        expect(transform).toHaveBeenCalledTimes(4);
        available = false;
        expect((await run()).code).toBe("null");
        await run();
        expect(transform).toHaveBeenCalledTimes(6);
        available = true;
        const restored = await run();
        expect(restored.code).toContain("local-css");
        expect((await run()).code).toBe(restored.code);
        // A persistent prior artifact may be reused only after the current exact
        // receipt is valid again. Unavailable runs above were never cached.
        expect(transform).toHaveBeenCalledTimes(persistent ? 6 : 7);
        expect(runtime).toHaveBeenCalledWith(css, request);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([false, true])(
    "observes completed runtime dependency receipts before caching with persistence=%s",
    async (persistent) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-runtime-receipt-"));

      try {
        const filename = join(root, "entry.ts");
        const theme = join(root, "theme.css.ts");
        const tokens = join(root, "tokens.ts");
        const source = "export const value = 1;";
        const tokenSource = 'export const selected = "stable";';
        const themeSource = 'import "./tokens.ts"; export const theme = "raw";';
        await writeFile(filename, source);
        await writeFile(theme, themeSource);
        await writeFile(tokens, tokenSource);
        let available = true;
        let providerVersion = 1;
        const provider: StaticCssEvalSourceProvider = {
          resolve: () => (available ? { id: tokens } : null),
          load: (id) => ({
            source: id === theme ? themeSource : tokenSource,
            version: providerVersion
          })
        };
        const runtimeSource = () => ({
          source: 'export const theme = "compiled";',
          sourceHash: "unchanged-host-hash",
          version: "client",
          watchFiles: []
        });
        const createCache = () => {
          const cache = new CompilationCache();
          if (persistent)
            cache.configure(undefined, join(root, "cache"), "runtime-receipt");
          return cache;
        };
        const cache = createCache();
        const transform = vi.fn(async (input: BabelTransformSourceOptions) => {
          const runtime = await input.babel!.consumerRuntimeSource!(theme);
          // An unrelated semantic demand must not weaken runtime watches.
          await input.babel!.staticCssEvalSourceProvider!.load(tokens);
          return {
            code: runtime?.source ?? "unproven",
            result: ["", ""] as [string, string],
            semanticDemands: [{ file: tokens, name: "selected", members: [] }]
          };
        });
        const run = () =>
          cachedTransform(
            persistent ? createCache() : cache,
            {
              filename,
              source,
              babel: {
                cwd: root,
                staticCssEvalSourceProvider: provider,
                consumerRuntimeSource: retainRuntimeSourceDependencies(
                  runtimeSource,
                  provider
                )
              }
            },
            transform
          );

        expect((await run()).code).toContain("compiled");
        await run();
        expect(transform).toHaveBeenCalledTimes(1);

        // Host output and provider snapshots stay identical: the erased file
        // is nevertheless a hard input, even with an unchanged export witness.
        await writeFile(tokens, `${tokenSource}\n// changed authoring input`);
        await run();
        expect(transform).toHaveBeenCalledTimes(2);

        // Provider-only changes are included in the final receipt's context.
        providerVersion++;
        await run();
        expect(transform).toHaveBeenCalledTimes(3);

        available = false;
        expect((await run()).code).toBe("unproven");
        expect((await run()).code).toBe("unproven");
        expect(transform).toHaveBeenCalledTimes(5);
        available = true;
        expect((await run()).code).toContain("compiled");
        await run();
        // The persisted prior success is valid again only after its complete
        // receipt has been revalidated; no unavailable result was retained.
        expect(transform).toHaveBeenCalledTimes(persistent ? 5 : 6);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([false, true])(
    "revalidates emitted runtime bytes, context and transitive watches with persistence=%s",
    async (persistent) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-runtime-transform-"));

      try {
        const filename = join(root, "entry.ts");
        const dependency = join(root, "tokens.json");
        const source = "export const value = 1;";
        await writeFile(filename, source);
        await writeFile(dependency, "red");
        let color = "red";
        let context = "client";
        const runtimeSource = vi.fn<
          NonNullable<BabelOptions["consumerRuntimeSource"]>
        >(async (id) => ({
          source: `export const color = "${color}:${id.endsWith("?require") ? "require" : "import"}";`,
          sourceHash: "unchanged-host-hash",
          version: context,
          watchFiles: [dependency]
        }));
        const createCache = () => {
          const cache = new CompilationCache();
          if (persistent)
            cache.configure(undefined, join(root, "cache"), "runtime-source");
          return cache;
        };
        const cache = createCache();
        const transform = vi.fn(async (input: BabelTransformSourceOptions) => {
          const runtime = input.babel!.consumerRuntimeSource!;
          const imported = await runtime("/virtual/theme.css.ts?import");
          const required = await runtime("/virtual/theme.css.ts?require");

          return {
            code: `${imported?.source}\n${required?.source}`,
            result: ["", ""] as [string, string]
          };
        });
        const run = () =>
          cachedTransform(
            persistent ? createCache() : cache,
            {
              filename,
              source,
              babel: { cwd: root, consumerRuntimeSource: runtimeSource }
            },
            transform
          );

        const first = await run();
        expect((await run()).code).toBe(first.code);
        expect(transform).toHaveBeenCalledTimes(1);

        // Authoring bytes and even the host's declared digest stay unchanged.
        color = "blue";
        expect((await run()).code).toContain("blue:import");
        expect((await run()).code).toContain("blue:require");
        expect(transform).toHaveBeenCalledTimes(2);

        context = "server";
        await run();
        expect(transform).toHaveBeenCalledTimes(3);
        await writeFile(dependency, "changed transitive input");
        await run();
        expect(transform).toHaveBeenCalledTimes(4);
        expect(runtimeSource).toHaveBeenCalledWith(
          "/virtual/theme.css.ts?import"
        );
        expect(runtimeSource).toHaveBeenCalledWith(
          "/virtual/theme.css.ts?require"
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([false, true])(
    "does not retain an unavailable runtime surface with persistence=%s",
    async (persistent) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-runtime-unavailable-"));

      try {
        const filename = join(root, "entry.ts");
        const source = "export const value = 1;";
        await writeFile(filename, source);
        let runtime: ConsumerRuntimeSource = { watchFiles: [] };
        const createCache = () => {
          const cache = new CompilationCache();
          if (persistent)
            cache.configure(undefined, join(root, "cache"), "runtime-source");
          return cache;
        };
        const cache = createCache();
        const transform = vi.fn(async (input: BabelTransformSourceOptions) => {
          const value = await input.babel!.consumerRuntimeSource!("/runtime");
          return {
            code: value?.source ?? "unproven",
            result: ["", ""] as [string, string]
          };
        });
        const run = () =>
          cachedTransform(
            persistent ? createCache() : cache,
            {
              filename,
              source,
              babel: { cwd: root, consumerRuntimeSource: () => runtime }
            },
            transform
          );

        expect((await run()).code).toBe("unproven");
        expect((await run()).code).toBe("unproven");
        expect(transform).toHaveBeenCalledTimes(2);
        runtime = {
          source: "export const color = 'red';",
          sourceHash: "red",
          version: "client",
          watchFiles: []
        };
        expect((await run()).code).toContain("red");
        expect((await run()).code).toContain("red");
        expect(transform).toHaveBeenCalledTimes(3);
        runtime = { watchFiles: [] };
        expect((await run()).code).toBe("unproven");
        expect((await run()).code).toBe("unproven");
        expect(transform).toHaveBeenCalledTimes(5);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("rechecks raw fallback ownership and retries a failed runtime observation", async () => {
    const cache = new CompilationCache();
    const provider: StaticCssEvalSourceProvider = {
      resolve: (_owner, id) => ({ id }),
      load: () => ({ source: "raw authoring" })
    };
    let runtime: ConsumerRuntimeSource | undefined = undefined;
    let fail = false;
    const transform = vi.fn(async (input: BabelTransformSourceOptions) => {
      let code: string;
      try {
        const value = await input.babel!.consumerRuntimeSource!("/runtime");
        code =
          value?.source ??
          (await input.babel!.staticCssEvalSourceProvider!.load("/runtime"))!
            .source!;
      } catch {
        code = "unproven";
      }
      return { code, result: ["", ""] as [string, string] };
    });
    const run = () =>
      cachedTransform(
        cache,
        {
          filename: "/virtual-runtime-owner.ts",
          source: "export const value = 1;",
          babel: {
            staticCssEvalSourceProvider: provider,
            consumerRuntimeSource: () => {
              if (fail) throw new Error("host transform unavailable");
              return runtime;
            }
          }
        },
        transform
      );

    expect((await run()).code).toBe("raw authoring");
    expect((await run()).code).toBe("raw authoring");
    expect(transform).toHaveBeenCalledTimes(1);
    runtime = {
      source: "serialized runtime",
      sourceHash: "runtime",
      version: "client",
      watchFiles: []
    };
    expect((await run()).code).toBe("serialized runtime");
    expect(transform).toHaveBeenCalledTimes(2);
    fail = true;
    expect((await run()).code).toBe("unproven");
    expect((await run()).code).toBe("unproven");
    expect(transform).toHaveBeenCalledTimes(4);
    fail = false;
    expect((await run()).code).toBe("serialized runtime");
    expect(transform).toHaveBeenCalledTimes(5);
  });

  it("rejects an owner edit while its supplied source is being transformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "mincho-transform-input-"));

    try {
      const filename = join(root, "entry.ts");
      const source = "export const value = 1;";
      await writeFile(filename, source);

      let started!: () => void;
      let finish!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });

      const ready = new Promise<void>((resolve) => {
        finish = resolve;
      });

      const pending = cachedTransform(
        new CompilationCache(),
        { filename, source },
        async () => {
          started();
          await ready;

          return { code: source, result: ["", ""] };
        }
      );

      await entered;
      await writeFile(filename, "export const value = 2;");
      finish();

      await expect(pending).rejects.toThrow(
        "inputs changed during compilation"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries helper analysis after a transient provider failure", async () => {
    const load = vi
      .fn(async () => ({
        source: 'export function make() { return { color: "red" }; }'
      }))
      .mockRejectedValueOnce(new Error("temporary provider failure"));

    const options = {
      filename: "/virtual-cache/helpers.ts",
      source:
        'import { css } from "@mincho-js/css"; import { make } from "./helper"; export const cls = css(make());',
      babel: {
        compilationCache: new CompilationCache(),
        staticCssEvalSourceProvider: {
          resolve: () => ({ id: "/virtual-cache/helper.ts" }),

          load
        }
      }
    };

    expect((await babelTransformSource(options)).result[1]).toContain("make()");
    expect((await babelTransformSource(options)).result[1]).toContain(
      'color: "red"'
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retries CSS extraction after a transient provider failure", async () => {
    const load = vi
      .fn(async () => ({
        source: 'export const styles = { color: "red" };'
      }))
      .mockRejectedValueOnce(new Error("temporary provider failure"));

    const options = {
      filename: "/virtual-cache/helpers.tsx",
      source:
        'import { styles } from "./helper"; export const App = () => <div css={styles} />;',
      babel: {
        jsxCssProp: true,
        compilationCache: new CompilationCache(),
        staticCssEvalSourceProvider: {
          resolve: () => ({ id: "/virtual-cache/helper.ts" }),

          load
        }
      }
    };

    await expect(babelTransformSource(options)).rejects.toThrow(
      "temporary provider failure"
    );
    expect((await babelTransformSource(options)).result[1]).toContain(
      'color: "red"'
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reuses results with fresh ASTs and revalidates virtual modules and reexports", async () => {
    // The cache observes Babel's cwd. Other integration fixtures can create
    // outputs in the workspace, which is not an input to this virtual test.
    const cwd = await mkdtemp(join(tmpdir(), "mincho-transform-cache-cwd-"));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    let color = "red";
    const provider: StaticCssEvalSourceProvider = {
      resolve: (_importer, source) => ({ id: source }),

      load: (id) => ({
        source:
          id === "barrel"
            ? 'export { styles } from "leaf"'
            : `export const styles = { color: "${color}" };`
      })
    };

    const cache = new CompilationCache();
    const engine = new MinchoProjectEngine();
    const diagnostics = new CompilationDiagnostics({ console: true });
    diagnostics.begin();

    const transform = () =>
      diagnostics.run("/App.tsx", "transform", () =>
        babelTransformSource({
          filename: "/virtual-cache/App.tsx",
          source:
            'import { styles } from "barrel"; export const App = () => <div css={styles} />;',
          babel: {
            cwd,
            jsxCssProp: true,
            compilationCache: cache,
            staticCssEvalSourceProvider: provider,
            staticCssEvalProjectEngine: engine
          }
        })
      );

    const first = await transform();
    const second = await transform();

    expect(second.code).toBe(first.code);
    expect(second.staticCssEval?.resolvedModuleCache).not.toBe(
      first.staticCssEval?.resolvedModuleCache
    );
    expect(
      second.staticCssEval?.resolvedModuleCache.get("leaf")?.programPath
    ).not.toBe(
      first.staticCssEval?.resolvedModuleCache.get("leaf")?.programPath
    );
    expect(
      diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events)
        .filter((event) => event.phase === "cache-hit")
    ).toHaveLength(1);
    expect(
      engine.getFileResult("/virtual-cache/App.tsx")?.providerSnapshot.length
    ).toBeGreaterThan(0);

    color = "blue";

    const third = await transform();

    expect(third.result[1]).toContain("blue");
    expect(third.result[1]).not.toContain('"red"');
  });
});
