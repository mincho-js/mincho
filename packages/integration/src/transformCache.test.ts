import { describe, expect, it } from "vitest";
import {
  babelTransformSource,
  type StaticCssEvalSourceProvider
} from "./babel.js";
import { CompilationCache } from "./compilationCache.js";
import { CompilationDiagnostics } from "./diagnostics.js";
import { MinchoProjectEngine } from "./staticCssEvalProjectEngine.js";

describe("Babel transform cache", () => {
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
