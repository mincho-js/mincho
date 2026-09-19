import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cachedTransform } from "./transformCache.js";
import {
  babelTransformSource,
  type StaticCssEvalSourceProvider
} from "./babel.js";
import { CompilationCache } from "./compilationCache.js";
import { CompilationDiagnostics } from "./diagnostics.js";
import { MinchoProjectEngine } from "./staticCssEvalProjectEngine.js";

describe("Babel transform cache", () => {
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
