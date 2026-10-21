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

describe("private recipe resource proofs", () => {
  const serialized = `import {createCompiledRuntimeFn} from "@mincho-js/css/rules/createRuntimeFn"; export const button = createCompiledRuntimeFn(${JSON.stringify(config)}, {});`;

  async function proof(body: string, cache?: CompilationCache) {
    const code = `import {button} from "/extracted_rules.css.ts"; ${body}`;
    const input = {
      ...result(code),
      result: ["/extracted_rules.css.ts", ""] as [string, string]
    };

    return new RuntimeOptimizations().transform(
      {
        filename: "/app.ts",
        source: code,
        babel: {
          privateRecipes: true,
          compilationCache: cache,
          optimize: { staticRecipes: false, styledComponents: false }
        }
      },
      input,
      provider({ "/extracted_rules.css.ts": serialized })
    );
  }

  it("retains all literal branches, defaults, toggles and compound results before JS folding", async () => {
    const output = await proof(
      'const alias=button; export function render(flag){return alias({size:flag?"small":"large",active:true})}; const first=button();'
    );

    expect(output.privateRecipeUses).toEqual([
      { id: "base", used: ["active", "base", "compound", "large", "small"] }
    ]);
    expect(output.code).toContain("alias(");
  });

  it.each([
    "export {button};",
    "export const alias=button;",
    "globalThis.button=button;",
    "button.classNames.variants;",
    "button.variants();",
    "button.props({});",
    "button(value);",
    'button({get size(){return "small"}});',
    'button.size="large";',
    'const selection={size:"small"}; mutate(selection);button(selection);',
    "const before=alias;const alias=button;before();",
    "button(...values);",
    'eval("button(value)");'
  ])(
    "does not prove escaping, dynamic, metadata, mutation or early use: %s",
    async (body) => {
      expect(
        (await proof(body)).privateRecipeUses?.[0]?.used ?? null
      ).toBeNull();
    }
  );

  it("replays build-only use metadata from the bounded analysis cache", async () => {
    const cache = new CompilationCache();
    const first = await proof('const cls=button({size:"small"});', cache);
    const second = await proof('const cls=button({size:"small"});', cache);

    expect(second.privateRecipeUses).toEqual(first.privateRecipeUses);
    expect(second.privateRecipeUses?.[0]?.used).toEqual(["base", "small"]);
    expect(JSON.stringify(second.code)).not.toContain("privateRecipeUses");
  });

  it("keeps classes exposed outside serialized recipe metadata", async () => {
    const source = `import {button, leaked} from '/extracted_rules.css.ts'; export const outside=leaked; export const selected=button({size:'small'});`;
    const output = await new RuntimeOptimizations().transform(
      { filename: "/app.ts", source, babel: { privateRecipes: true } },
      { ...result(source), result: ["/extracted_rules.css.ts", ""] },
      provider({
        "/extracted_rules.css.ts": serialized + 'export const leaked="large";'
      })
    );

    expect(output.privateRecipeUses?.[0]?.used).toEqual([
      "base",
      "large",
      "small"
    ]);
  });

  it.each([
    [
      'export const first="frame"; export const second="frame";',
      "const unused=first; export const publicValue=second;"
    ],
    [
      'export const first="frame"; export const second={name:"frame"};',
      "const unused=first; export const publicValue=second;"
    ]
  ])(
    "keeps keyframes exposed through another auto export",
    async (serialized, use) => {
      const source = `import {first,second} from '/extracted_values.css.ts'; ${use}`;
      const output = await new RuntimeOptimizations().transform(
        { filename: "/app.ts", source, babel: { privateRecipes: true } },
        { ...result(source), result: ["/extracted_values.css.ts", ""] },
        provider({ "/extracted_values.css.ts": serialized })
      );

      expect(output.privateResourceReferences).toEqual([]);
    }
  );
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

const component = `import { $$styled } from "@mincho-js/react/runtime";
import { button } from "/extracted_rules.css.ts";
export const Button = /*#__PURE__*/ $$styled("button", button);`;

const componentModules = {
  components: component,
  barrel: 'export { Button } from "components";',
  "/extracted_rules.css.ts": factory
};

async function styledResult(
  code: string,
  modules = componentModules,
  optimize?: {
    styledComponents?: boolean;
    staticRecipes?: boolean;
    pureFunctions?: boolean;
  }
) {
  return new RuntimeOptimizations().transform(
    {
      filename: "/app.tsx",
      source: code,
      sourceMaps: true,
      babel: { optimize }
    },
    result(code),
    provider(modules)
  );
}

describe("static styled JSX", () => {
  it("rechecks repeated components when later JSX loads an identity observer", async () => {
    const code =
      'import { Button } from "components"; import { Button as Later } from "late"; export const App = () => <><Button /><Button /><Later /></>;';

    const modules = {
      ...componentModules,
      late: 'import { Button } from "components"; Button.defaultProps = { size: "large" }; export { Button };'
    };

    expect((await styledResult(code, modules)).code).toBe(code);
  });

  it.each([
    ['import { Button } from "barrel";', "Button"],
    ['import * as ui from "barrel";', "ui.Button"],
    ['const { Button } = require("barrel");', "Button"],
    ['const ui = require("barrel");', "ui.Button"]
  ])("flattens lexical JSX references: %s", async (imports, tag) => {
    const code = `${imports} export const App = () => <${tag} id={track("id")} size="large" active title={track("title")} className="explicit">{track("child")}</${tag}>;`;
    const transformed = await styledResult(code);

    expect(transformed.code).toContain(
      '<button id={track("id")} title={track("title")} className={"base large active compound explicit"}>'
    );
    expect(transformed.code).toContain('{track("child")}</button>');
    expect(transformed.map?.sources).toContain("app.tsx");
    expect(transformed.staticCssEval?.dependencyFiles).toEqual(
      expect.arrayContaining(["components", "/extracted_rules.css.ts"])
    );
  });

  it("preserves dynamic uses and public component exports while flattening defaults and nested JSX", async () => {
    const code =
      'import { Button } from "components"; export { Button }; export const Dynamic = size => <Button size={size} />; export const App = () => <Button><Button active={false} /></Button>;';

    const transformed = await styledResult(code);

    expect(transformed.code).toContain("export { Button }");
    expect(transformed.code).toContain("<Button size={size}");
    expect(
      transformed.code.match(/<button className={"base small "}/g)
    ).toHaveLength(2);
  });

  it.each([
    "<Button {...props} />",
    '<Button as="a" />',
    "<Button ref={undefined} />",
    "<Button className={unknown} />",
    "<Button size={unknown()} />",
    '<Button size="large" size="small" />',
    '<Button size={{ toString: () => "large" }} />'
  ])("retains unsupported props: %s", async (jsx) => {
    const code = `import { Button } from "components"; export const App = () => ${jsx};`;

    expect((await styledResult(code)).code).toBe(code);
  });

  it.each([
    "observe(Button);",
    'Button.defaultProps = { size: "large" };',
    "const identity = Button;",
    "const Alias = Button; observe(Alias);",
    'const Alias = Button; Alias.displayName = "changed";',
    "const componentBag = { Button };"
  ])(
    "retains observed or escaped component identity: %s",
    async (observation) => {
      const code = `import { Button } from "components"; ${observation} export const App = () => <Button />;`;

      // An unused const alias is harmless. Exporting or passing it is observable.
      const observed =
        observation === "const identity = Button;"
          ? code + " export { identity }; identity.defaultProps = {};"
          : code;

      expect((await styledResult(observed)).code).toBe(observed);
    }
  );

  it("detects observations in producers and reexport aliases", async () => {
    for (const modules of [
      {
        ...componentModules,
        components: component + ' Button.defaultProps = { size: "large" };'
      },
      {
        ...componentModules,
        components: component + " button.variants = () => [];"
      },
      {
        ...componentModules,
        barrel:
          'import { Button as Original } from "components"; const Button = Original; Button.defaultProps = {}; export { Button };'
      }
    ]) {
      const code =
        'import { Button } from "barrel"; export const App = () => <Button />;';

      expect((await styledResult(code, modules)).code).toBe(code);
    }
  });

  it("retains custom components, initialization errors and element type observations", async () => {
    const imported =
      'import { Button } from "components"; export const App = () => <Button />;';

    expect(
      (
        await styledResult(imported, {
          ...componentModules,
          components: component.replace('"button", button', "Custom, button")
        })
      ).code
    ).toBe(imported);

    const observed =
      'import { Button } from "components"; const element = <Button />; export const type = element.type;';

    expect((await styledResult(observed)).code).toBe(observed);

    const early = component.replace(
      "export const Button",
      "const element = <Button />; export const Button"
    );

    expect((await styledResult(early)).code).toBe(early);
  });

  it("controls recipe and styled optimizations independently", async () => {
    const code =
      'import { Button } from "components"; export const App = () => <Button />;';

    expect(
      (await styledResult(code, componentModules, { styledComponents: false }))
        .code
    ).toBe(code);
    expect(
      (await styledResult(code, componentModules, { staticRecipes: false }))
        .code
    ).toContain('<button className={"base small "}');
  });

  it("uses JavaScript string escapes for static class names containing quotes", async () => {
    const code = `import { Button } from "components"; export const App = () => <Button className={'a"b'} />;`;
    const transformed = await styledResult(code);

    expect(transformed.code).toContain(
      `className={${JSON.stringify('base small a"b')}}`
    );
  });
});
