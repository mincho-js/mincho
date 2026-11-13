import { describe, expect, it, vi } from "vitest";
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
import { MinchoProjectEngine } from "./staticCssEvalProjectEngine.js";

describe("Babel transform cache", () => {
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
