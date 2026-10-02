import { describe, expect, it, vi } from "vitest";
import { RuntimeOptimizations } from "./runtimeOptimizations.js";
import { CompilationCache } from "./compilationCache.js";
import type {
  BabelTransformResult,
  StaticCssEvalSourceProvider
} from "./babel.js";

const config = {
  defaultClassName: "base",
  variantClassNames: {
    size: { large: "large", small: "small" },
    active: { true: "active" }
  },
  defaultVariants: { size: "small" },
  compoundVariants: [[{ size: "large", active: true }, "compound"]],
  propVars: {}
};

const factory = `import { createRuntimeFn } from "@mincho-js/css/rules/createRuntimeFn"; export const button = /*#__PURE__*/ createRuntimeFn(${JSON.stringify(config)});`;

const provider = (
  modules: Record<string, string>
): StaticCssEvalSourceProvider => ({
  resolve: (_owner, source) => (modules[source] ? { id: source } : null),

  load: (id) => (modules[id] ? { source: modules[id] } : null)
});

const result = (code: string): BabelTransformResult => ({
  code,
  result: ["", ""]
});

describe("static recipe invocations", () => {
  it("validates concurrent requests against their own provider and environment", async () => {
    const code =
      'import { button } from "/extracted_rules.css.ts"; export const cls = button();';

    const cache = new CompilationCache();
    const optimization = new RuntimeOptimizations();
    const options = {
      filename: "/app.ts",
      source: code,
      babel: { compilationCache: cache }
    };

    const firstProvider = provider({ "/extracted_rules.css.ts": factory });
    const secondProvider = provider({
      "/extracted_rules.css.ts": factory.replace('"base"', '"server"')
    });

    const [first, second] = await Promise.all([
      optimization.transform(options, result(code), firstProvider),
      optimization.transform(options, result(code), secondProvider)
    ]);

    expect(first.code).toContain('"base small"');
    expect(second.code).toContain('"server small"');

    const client = await optimization.transform(
      options,
      result(code),
      firstProvider
    );

    expect(client.code).toBe(first.code);
  });

  it("reuses analysis while observing fresh sidecar outputs every generation", async () => {
    const code =
      'import { button } from "/extracted_rules.css.ts"; export const cls = button();';

    const cache = new CompilationCache();
    const parse = vi.spyOn(cache.parser, "parse");
    const modules = { "/extracted_rules.css.ts": factory };
    const sourceProvider = provider(modules);
    const load = vi.spyOn(sourceProvider, "load");
    const optimization = new RuntimeOptimizations();
    const options = {
      filename: "/app.ts",
      source: code,
      babel: { compilationCache: cache }
    };

    cache.begin();

    const first = await optimization.transform(
      options,
      result(code),
      sourceProvider
    );

    await cache.end();

    const parsed = parse.mock.calls.length;

    expect(parsed).toBeGreaterThan(0);

    const loaded = load.mock.calls.length;

    optimization.clear();
    cache.begin();

    const second = await optimization.transform(
      options,
      result(code),
      sourceProvider
    );

    await cache.end();

    expect(second.code).toBe(first.code);
    expect(parse).toHaveBeenCalledTimes(parsed);
    expect(load.mock.calls.length).toBeGreaterThan(loaded);

    modules["/extracted_rules.css.ts"] = factory.replace('"base"', '"changed"');
    optimization.clear();
    cache.begin();

    const third = await optimization.transform(
      options,
      result(code),
      sourceProvider
    );

    await cache.end();

    expect(third.code).toContain('"changed small"');
    expect(parse.mock.calls.length).toBeGreaterThan(parsed);
  });

  it("does not remember provider failures and skips proven non-consumers", async () => {
    const code =
      'import { button } from "/extracted_rules.css.ts"; export const cls = button();';

    const cache = new CompilationCache();
    const options = {
      filename: "/app.ts",
      source: code,
      babel: { compilationCache: cache }
    };

    const optimization = new RuntimeOptimizations();
    const sourceProvider = provider({ "/extracted_rules.css.ts": factory });
    const load = vi
      .spyOn(sourceProvider, "load")
      .mockRejectedValueOnce(new Error("temporary"));

    const first = result(code);

    expect(await optimization.transform(options, first, sourceProvider)).toBe(
      first
    );
    expect(
      (await optimization.transform(options, result(code), sourceProvider)).code
    ).toContain('"base small"');

    const original: BabelTransformResult = {
      ...result("export const value = 1;"),
      runtimeCandidates: { recipes: false, styled: false }
    };

    load.mockClear();

    expect(
      await optimization.transform(options, original, sourceProvider)
    ).toBe(original);
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    [
      'import { button } from "barrel";',
      'export { button } from "/extracted_rules.css.ts";'
    ],
    [
      'const { button } = require("barrel");',
      'module.exports = require("/extracted_rules.css.ts");'
    ]
  ])(
    "folds observed ESM/CommonJS calls and retains dynamic calls and CSS edges: %s",
    async (imports, barrel) => {
      const code = `${imports}
      export const a = button({ size: "large", active: true });
      export const b = button({ size: "large", active: true });
      export const defaultClass = button();
      export const dynamic = input => button(input);
      export const api = button.variants;
    `;

      const optimized = await new RuntimeOptimizations().transform(
        { filename: "/app.ts", source: code },
        result(code),
        provider({ barrel, "/extracted_rules.css.ts": factory })
      );

      expect(
        optimized.code.match(/"base large active compound"/g)
      ).toHaveLength(2);
      expect(optimized.code).toContain('"base small"');
      expect(optimized.code).toContain("button(input)");
      expect(optimized.code).toContain("button.variants");
      expect(optimized.staticCssEval?.dependencyFiles).toEqual(
        expect.arrayContaining(["barrel", "/extracted_rules.css.ts"])
      );
    }
  );

  it("keeps original module effects when its last value import disappears", async () => {
    const code =
      'import { button } from "/extracted_rules.css.ts"; export const cls = button();';

    const optimized = await new RuntimeOptimizations().transform(
      { filename: "/app.ts", source: code },
      result(code),
      provider({ "/extracted_rules.css.ts": factory })
    );

    expect(optimized.code).toContain('import "/extracted_rules.css.ts";');
    expect(optimized.code).not.toContain("button()");
  });

  it("does not execute unknown functions, recipe packages, mutations or spreads", async () => {
    for (const code of [
      'import { button } from "other"; export const cls = button();',
      'import { button } from "/extracted_rules.css.ts"; export const cls = button(unknown());',
      'import { button } from "/extracted_rules.css.ts"; const options = { size: "large" }; mutate(options); export const cls = button(options);',
      'import { button } from "/extracted_rules.css.ts"; export const cls = button(...args);'
    ]) {
      const original = result(code);

      expect(
        await new RuntimeOptimizations().transform(
          { filename: "/app.ts", source: code },
          original,
          provider({
            other: factory.replace(
              "@mincho-js/css/rules/createRuntimeFn",
              "@vanilla-extract/recipes/createRuntimeFn"
            ),
            "/extracted_rules.css.ts": factory
          })
        )
      ).toBe(original);
    }
  });

  it("respects opt out and changed serialized configuration", async () => {
    const code =
      'import { button } from "/extracted_rules.css.ts"; export const cls = button();';

    const original = result(code);
    const optimization = new RuntimeOptimizations();

    expect(
      await optimization.transform(
        {
          filename: "/app.ts",
          source: code,
          babel: { optimize: { staticRecipes: false } }
        },
        original,
        provider({})
      )
    ).toBe(original);
    expect(
      (
        await optimization.transform(
          { filename: "/app.ts", source: code },
          original,
          provider({ "/extracted_rules.css.ts": factory })
        )
      ).code
    ).toContain('"base small"');
    expect(
      (
        await optimization.transform(
          { filename: "/app.ts", source: code },
          original,
          provider({
            "/extracted_rules.css.ts": factory.replace('"base"', '"changed"')
          })
        )
      ).code
    ).toContain('"changed small"');
  });
});
