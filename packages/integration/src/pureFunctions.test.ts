import { describe, expect, it } from "vitest";
import {
  babelTransformSource,
  type StaticCssEvalSourceProvider
} from "./babel.js";
import { CompilationCache } from "./compilationCache.js";

describe("cross-module pure helpers", () => {
  it("uses asynchronous source providers and tracks changed helper modules", async () => {
    let scale = 4;

    const sources = () => ({
      "/barrel.ts": 'export { spacing } from "./helpers";',
      "/helpers.ts": `export const spacing = n => ({ padding: n * ${scale} });`
    });

    const provider: StaticCssEvalSourceProvider = {
      resolve: (_importer, source) => ({
        id: source === "./helpers" ? "/helpers.ts" : "/barrel.ts"
      }),

      load: (id) => ({
        source: sources()[id as keyof ReturnType<typeof sources>]
      })
    };

    const compilationCache = new CompilationCache();

    const transform = () =>
      babelTransformSource({
        filename: "/virtual-pure/App.tsx",
        source:
          'import { spacing } from "./barrel"; export const App = () => <div css={spacing(2)} />;',
        babel: {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider,
          compilationCache
        }
      });

    const first = await transform();

    expect(first.result[1]).toContain("padding: 8");
    expect(first.code).toContain('import "./barrel";');
    expect(first.staticCssEval?.dependencyFiles).toEqual(
      expect.arrayContaining(["/barrel.ts", "/helpers.ts"])
    );

    scale = 8;

    expect((await transform()).result[1]).toContain("padding: 16");
  });
});
