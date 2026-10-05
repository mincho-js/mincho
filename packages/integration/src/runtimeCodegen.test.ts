import { describe, expect, it } from "vitest";
import {
  createRuntimeFn,
  createCompiledRuntimeFn
} from "@mincho-js/css/rules/createRuntimeFn";
import { mapVarProps } from "@mincho-js/css/rules/mapVarProps";
import { createCompiledClassRuntimeFn } from "@mincho-js/css/rules/createClassRuntimeFn";
import { $$styled, $$styledChain } from "@mincho-js/react/runtime";
import { createElement, type ReactElement } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { transformSync } from "esbuild";
import { RuntimeOptimizations } from "./runtimeOptimizations.js";
import { CompilationCache } from "./compilationCache.js";

const config = {
  defaultClassName: "base",
  variantClassNames: {
    size: { small: "small", large: "large" },
    active: { true: "active" }
  },
  defaultVariants: { size: "small" },
  compoundVariants: [
    [{ active: true, size: "large" }, "compound"] as [
      { active: boolean; size: string },
      string
    ]
  ],
  propVars: { width: "--width" as const }
};

const { propVars, ...classConfig } = config;
const factory = `import {createCompiledRuntimeFn as make} from "@mincho-js/css/rules/createRuntimeFn"; export const recipe = make(${JSON.stringify(classConfig)}, ${JSON.stringify(propVars)});`;

async function optimize(code: string, compilationCache?: CompilationCache) {
  const result = await new RuntimeOptimizations().transform(
    {
      filename: "/app.tsx",
      source: code,
      babel: {
        compilationCache,
        optimize: {
          runtimeCodegen: true,
          staticRecipes: true,
          styledComponents: true
        }
      }
    },
    { code, result: ["", ""] },
    {
      resolve: (_owner, name) =>
        name === "/extracted_rules.css.ts" ? { id: name } : null,

      load: (id) =>
        id === "/extracted_rules.css.ts" ? { source: factory } : null
    }
  );

  return result.code;
}

const recipeImport = 'import {recipe} from "/extracted_rules.css.ts";';
const styledImport = 'import {$$styled} from "@mincho-js/react/runtime";';

function styledModule(source: string) {
  const code = transformSync(source, {
    loader: "tsx",
    format: "cjs",
    target: "esnext",
    jsx: "automatic",
    jsxImportSource: "react"
  }).code;

  const exports: Record<string, (...args: unknown[]) => ReactElement> = {};
  const module = { exports };
  const modules: Record<string, unknown> = {
    "/extracted_rules.css.ts": {
      recipe: createCompiledRuntimeFn(
        config as unknown as Parameters<typeof createCompiledRuntimeFn>[0],
        config.propVars
      )
    },
    "@mincho-js/css/rules/createRuntimeFn": { createCompiledRuntimeFn },
    "@mincho-js/css/rules/mapVarProps": { mapVarProps },
    "@mincho-js/css/rules/createClassRuntimeFn": {
      createCompiledClassRuntimeFn
    },
    "@mincho-js/react/runtime": { $$styled, $$styledChain },
    "react/jsx-runtime": jsxRuntime,
    react: { createElement }
  };

  new Function("require", "module", "exports", code)(
    (name: string) => {
      if (!(name in modules))
        throw new Error(`Unexpected test import: ${name}`);

      return modules[name];
    },
    module,
    exports
  );

  return module.exports;
}

function renderStyled(
  element: ReactElement
): ReactElement<Record<string, unknown>> {
  let result = element;

  while (typeof result.type !== "string") {
    const type = result.type as unknown as {
      render(props: unknown, ref: null): ReactElement;
    };

    result = type.render(result.props, null);
  }

  return result as ReactElement<Record<string, unknown>>;
}

describe("runtime compiler optimizations", () => {
  it("folds finite recipe selections with canonical output and exact short circuit evaluation", async () => {
    const source =
      recipeImport +
      'export function run(next){return recipe({active: next(0) ? true : false, size: next(1) ? "large" : next(2) ? "small" : "large"});}';

    const code = await optimize(source);

    expect(code).not.toContain("recipe({");
    expect(code).toContain("base large active compound");

    const runtime = createRuntimeFn(
      config as unknown as Parameters<typeof createRuntimeFn>[0]
    );

    const evaluate = (text: string) =>
      new Function(
        "recipe",
        text
          .replace(/^import[^;]+;/gm, "")
          .replace("export function", "function") + ";return run;"
      )(runtime) as (next: (index: number) => boolean) => string;

    for (let mask = 0; mask < 8; mask++) {
      const originalReads: number[] = [];
      const optimizedReads: number[] = [];
      const expected = evaluate(source)((index) => {
        originalReads.push(index);

        return !!(mask & (1 << index));
      });

      const actual = evaluate(code)((index) => {
        optimizedReads.push(index);

        return !!(mask & (1 << index));
      });

      expect(actual).toBe(expected);
      expect(optimizedReads).toEqual(originalReads);
    }
  });

  it("uses the class-only runtime for unbounded or nonliteral selections", async () => {
    const code = await optimize(
      recipeImport + "export const run = (value) => recipe({size: value});"
    );

    expect(code).toContain("_recipeClasses({");
    expect(code).not.toContain("mapVarProps");
    expect(code).not.toContain("--width");

    const before = styledModule(
      recipeImport + "export const run=value=>recipe({size:value});"
    ).run;

    const after = styledModule(code).run;

    for (const value of ["small", "large", "missing", true, null, undefined])
      expect(after(value)).toEqual(before(value));

    const properties = Array.from(
      { length: 5 },
      (_, index) => `p${index}: flags[${index}] ? "a" : "b"`
    ).join(",");

    expect(
      await optimize(
        recipeImport +
          `export function run(flags){return recipe({${properties}});}`
      )
    ).toContain("_recipeClasses({");
  });

  it("retains observed recipe metadata and escaped recipe identities", async () => {
    for (const use of [
      "export const names=recipe.classNames;",
      "export const variantKeys=recipe.variants();",
      "observe(recipe);",
      "export {recipe};"
    ]) {
      const code = await optimize(
        recipeImport + use + "export const run=input=>recipe(input);"
      );

      expect(code).toContain("recipe(input)");
      expect(code).not.toContain("_recipeClasses");
    }
  });

  it("inlines known recipe props while preserving value evaluation", async () => {
    const code = await optimize(
      recipeImport + "export const style = recipe.props({width: read()});"
    );

    expect(code).toContain("= read()");
    expect(code).toMatch(/\["--width"\] = _recipeProp/);
    expect(code).not.toContain("recipe.props");
    expect(
      await optimize(
        recipeImport + "export const style = recipe.props({...source});"
      )
    ).toContain("mapVarProps");
    expect(
      await optimize(
        recipeImport + "export const style = recipe.props({unknown: read()});"
      )
    ).toContain("mapVarProps");
  });

  it.each([
    [
      "function",
      "export function run(w, style = recipe.props({width: w})) { return style; }",
      4
    ],
    [
      "destructuring",
      "export function run({w, style = recipe.props({width: w})}) { return style; }",
      { w: 4 }
    ],
    [
      "array pattern",
      "export function run([w, style = recipe.props({width: w})]) { return style; }",
      [4]
    ],
    [
      "arrow",
      "export const run = (w, style = recipe.props({width: w})) => style;",
      4
    ],
    [
      "method",
      "const object = { method(w, style = recipe.props({width: w})) { return style; } }; export const run = w => object.method(w);",
      4
    ],
    [
      "constructor",
      "class Box { constructor(w, style = recipe.props({width: w})) { this.style = style; } } export const run = w => new Box(w).style;",
      4
    ],
    [
      "nested default",
      "export function run(w, getStyle = (style = recipe.props({width: w})) => style) { return getStyle(); }",
      4
    ]
  ])(
    "keeps recipe props defaults valid in a %s parameter scope",
    async (_kind, declaration, input) => {
      const source = '"use strict"; ' + recipeImport + declaration;
      const code = await optimize(source);
      const expected = styledModule(source).run!(input);

      expect(styledModule(code).run!(input)).toEqual(expected);
      expect(expected).toEqual({ "--width": 4 });
      expect(code).toContain('from "@mincho-js/css/rules/mapVarProps"');
      expect(code).not.toMatch(/\b_recipeProp\d*\b/);
    }
  );

  it("still inlines props inside a function body nested in a parameter default", async () => {
    const source =
      '"use strict"; ' +
      recipeImport +
      "export function run(w, getStyle = () => recipe.props({width: w})) { return getStyle(); }";
    const code = await optimize(source);

    expect(styledModule(code).run!(4)).toEqual(styledModule(source).run!(4));
    expect(code).toContain("_recipeProp");
    expect(code).not.toContain("mapVarProps");
  });

  it("keeps parameter default values isolated during reentrant calls", async () => {
    const source = `
      "use strict";
      import { createCompiledRuntimeFn as make } from "@mincho-js/css/rules/createRuntimeFn";
      const recipe = make({ defaultClassName: "base", variantClassNames: {}, defaultVariants: {}, compoundVariants: [] }, { width: "--width", height: "--height" });
      export function run(width, next, style = recipe.props({ width, height: next() })) { return style; }
    `;
    const code = await optimize(source);
    const before = styledModule(source).run!;
    const after = styledModule(code).run!;
    const expected = before(4, () => {
      before(8, () => 16);
      return 32;
    });

    expect(expected).toEqual({ "--width": 4, "--height": 32 });
    expect(
      after(4, () => {
        after(8, () => 16);
        return 32;
      })
    ).toEqual(expected);
  });

  it("maps aliased dynamic inputs with identical Proxy traps and exceptions", async () => {
    const source =
      recipeImport +
      "const alias=recipe; export const run=input=>alias.props(input);";

    const code = await optimize(source);

    expect(code).toContain('from "@mincho-js/css/rules/mapVarProps"');
    expect(code).not.toContain("alias.props(");

    const before = styledModule(source).run;
    const after = styledModule(code).run;
    const events: string[] = [];
    const input = new Proxy(
      { width: 0, unknown: false, [Symbol("ignored")]: 1 },
      {
        ownKeys(target) {
          events.push("keys");

          return Reflect.ownKeys(target);
        },

        getOwnPropertyDescriptor(target, key) {
          events.push(`descriptor:${String(key)}`);

          return Reflect.getOwnPropertyDescriptor(target, key);
        },

        get(target, key, receiver) {
          events.push(`get:${String(key)}`);

          return Reflect.get(target, key, receiver);
        }
      }
    );

    const expected = before(input);
    const expectedEvents = events.splice(0);

    expect(after(input)).toEqual(expected);
    expect(events).toEqual(expectedEvents);
    expect(after(input)).not.toBe(after(input));
    expect(() => after(null)).toThrow(TypeError);
    expect(() =>
      after({
        get unknown() {
          throw new Error("unknown getter");
        }
      })
    ).toThrow("unknown getter");
  });

  it("keeps unknown-key expressions ahead of mapped result assignments", async () => {
    const source =
      recipeImport +
      'export const run=read=>recipe.props({width:read("width"),unknown:read("unknown")});';

    const after = styledModule(await optimize(source)).run;
    const events: string[] = [];
    Object.defineProperty(Object.prototype, "--width", {
      configurable: true,

      set() {
        events.push("write");
      }
    });

    try {
      expect(
        after((key: string) => {
          events.push(key);

          return 4;
        })
      ).toEqual({});
      expect(events).toEqual(["width", "unknown", "write"]);
    } finally {
      Reflect.deleteProperty(Object.prototype, "--width");
    }
  });

  it("preserves inherited setters when inlining recipe props", async () => {
    const source =
      recipeImport +
      "export function run(read){return recipe.props({width: read()});}";

    const code = await optimize(source);
    const runtime = createRuntimeFn(
      config as unknown as Parameters<typeof createRuntimeFn>[0]
    );

    const evaluate = (text: string) =>
      new Function(
        "recipe",
        text
          .replace(/^import[^;]+;/gm, "")
          .replace("export function", "function") + ";return run;"
      )(runtime) as (read: () => number) => object;

    const expected: unknown[] = [];
    const actual: unknown[] = [];
    let observed = expected;

    const read = () => {
      observed.push("read");
      Object.defineProperty(Object.prototype, "--width", {
        configurable: true,

        set(value) {
          observed.push(value);
        }
      });

      return 4;
    };

    try {
      expect(evaluate(source)(read)).toEqual({});

      observed = actual;

      expect(evaluate(code)(read)).toEqual({});
      expect(actual).toEqual(expected);
    } finally {
      Reflect.deleteProperty(Object.prototype, "--width");
    }
  });

  it("distinguishes elements and factories after cached AST cloning", async () => {
    const source =
      recipeImport +
      styledImport +
      'const Box=$$styled("div",recipe); const Label=$$styled("span",recipe); export function App(flag){return <main><Box size={flag ? "large" : "small"}/><Label active={flag === true}/><aside/></main>;}';

    const cache = new CompilationCache();
    const first = await optimize(source, cache);
    const second = await optimize(source, cache);

    expect(first).toContain("<main>");
    expect(first).toContain("<aside");
    expect(first).toContain('?? "div"');
    expect(first).toContain('?? "span"');
    expect(first).not.toContain("<Box");
    expect(first).not.toContain("<Label");
    expect(second).toBe(first);
  });

  it("flattens closed dynamic intrinsic styled calls with evaluation snapshots", async () => {
    const source =
      recipeImport +
      styledImport +
      'const Box=$$styled("div",recipe); export function App(flag){return <Box size={flag ? "large" : "small"} title={+touch(1)}>{+touch(2)}</Box>;}';

    const code = await optimize(source);

    expect(code).not.toContain("<Box");
    expect(code).toContain('?? "div"');
    expect(code).not.toMatch(/<div[^>]*size=/);
    expect(code.indexOf("= +touch(1)")).toBeLessThan(
      code.indexOf("= +touch(2)")
    );
    expect(code.indexOf("= +touch(2)")).toBeLessThan(
      code.lastIndexOf("recipe(")
    );
  });

  it.each([
    ["Tom &amp; Jerry", "Tom & Jerry"],
    [String.raw`C:\new`, String.raw`C:\new`],
    ["&quot;quoted&quot;", '"quoted"']
  ])("preserves decoded JSX string attributes: %s", async (raw, expected) => {
    const source =
      recipeImport +
      styledImport +
      `const Box=$$styled("div",recipe); export function App(flag){return <Box size={flag ? "large" : "small"} title="${raw}"/>;}`;
    const code = await optimize(source);

    expect(code).not.toContain("<Box");
    const before = styledModule(source).App!;
    const after = styledModule(code).App!;

    for (const flag of [false, true]) {
      const original = renderStyled(before(flag));
      const optimized = renderStyled(after(flag));

      expect(original.props.title).toBe(expected);
      expect(optimized.props).toEqual(original.props);
    }
  });

  it("uses decoded JSX strings when selecting recipe variants", async () => {
    const source =
      recipeImport +
      styledImport +
      'const Box=$$styled("div",recipe); export function App(flag){return <Box size="s&#109;all" title={flag ? "on" : "off"}/>;}';
    const code = await optimize(source);

    expect(code).not.toContain("<Box");
    const before = styledModule(source).App!;
    const after = styledModule(code).App!;

    for (const flag of [false, true])
      expect(renderStyled(after(flag)).props.className).toBe(
        renderStyled(before(flag)).props.className
      );
  });

  it("keeps recipe bindings when a dynamic use or a nested stage shadows their names", async () => {
    const shadow =
      recipeImport +
      styledImport +
      'const Box=$$styled("div",recipe); export function App(flag,recipe){return <Box size={flag ? "large" : "small"}/>;}';

    const shadowCode = await optimize(shadow);

    expect(shadowCode).toContain("<Box");
    expect(
      renderStyled(styledModule(shadowCode).App!(true, () => "wrong")).props
        .className
    ).toBe(
      renderStyled(styledModule(shadow).App!(true, () => "wrong")).props
        .className
    );

    const nested =
      recipeImport +
      styledImport +
      'import {createCompiledRuntimeFn as make} from "@mincho-js/css/rules/createRuntimeFn";' +
      'const Parent=$$styled("div",recipe); export function App(flag){' +
      `const recipe=make(${JSON.stringify({ ...config, defaultClassName: "inner" })}, ${JSON.stringify(config.propVars)});` +
      'const Child=$$styled(Parent,recipe); return <Child size={flag ? "large" : "small"}/>;}';

    const nestedCode = await optimize(nested);

    expect(nestedCode).not.toContain("$$styledChain");
    expect(
      renderStyled(styledModule(nestedCode).App!(true)).props.className
    ).toBe(renderStyled(styledModule(nested).App!(true)).props.className);
  });

  it("preserves ordinary variant/rest assignments and evaluates every input before splitting", async () => {
    const source =
      recipeImport +
      styledImport +
      'const Box=$$styled("div",recipe); export function App(touch){return <Box size={touch("size") ? "large" : "small"} title={`title-${touch("title")}`} className={touch("class") ? "chosen" : ""}>{+touch("child")}</Box>;}';

    const code = await optimize(source);

    expect(code).not.toContain("<Box");

    const before = styledModule(source).App!;
    const after = styledModule(code).App!;
    let events: unknown[] = [];

    try {
      Object.defineProperty(Object.prototype, "size", {
        configurable: true,

        set(value) {
          events.push(["size:set", value]);
        }
      });
      Object.defineProperty(Object.prototype, "title", {
        configurable: true,

        set(value) {
          events.push(["title:set", value]);
          Object.defineProperty(this, "title", {
            configurable: true,
            enumerable: true,

            get() {
              events.push("title:get");

              return value;
            }
          });
        }
      });

      const run = (app: typeof before) => {
        events = [];

        const rendered = renderStyled(
          app((name: string) => {
            events.push(name);

            return 1;
          })
        );

        return {
          type: rendered.type,
          className: rendered.props.className,
          title: rendered.props.title,
          children: rendered.props.children,
          events: [...events]
        };
      };

      const expected = run(before);
      const actual = run(after);

      expect(actual).toEqual(expected);
      expect(actual.className).toBe("base small chosen");
      expect(actual.events.slice(0, 4)).toEqual([
        "size",
        "title",
        "class",
        "child"
      ]);
    } finally {
      Reflect.deleteProperty(Object.prototype, "size");
      Reflect.deleteProperty(Object.prototype, "title");
    }
  });

  it("retains inherited as/className reads and exact class joining", async () => {
    const source =
      recipeImport +
      styledImport +
      'const Box=$$styled("div",recipe); export function App(flag){return <Box size={flag ? "large" : "small"}/>;}';

    const before = styledModule(source).App!;
    const after = styledModule(await optimize(source)).App!;
    let events: string[] = [];

    try {
      Object.defineProperty(Object.prototype, "as", {
        configurable: true,

        get() {
          events.push(`as:${this.size}`);

          return "span";
        }
      });
      Object.defineProperty(Object.prototype, "className", {
        configurable: true,

        get() {
          events.push(`className:${this.size}`);

          return "ambient";
        },

        set(value) {
          Object.defineProperty(this, "className", {
            configurable: true,
            enumerable: true,
            writable: true,
            value
          });
        }
      });

      const run = (app: typeof before) => {
        events = [];

        const result = renderStyled(app(true));

        return {
          type: result.type,
          className: result.props.className,
          events: [...events]
        };
      };

      expect(run(after)).toEqual(run(before));
      expect(run(after)).toMatchObject({
        type: "span",
        className: "base large ambient"
      });
    } finally {
      Reflect.deleteProperty(Object.prototype, "as");
      Reflect.deleteProperty(Object.prototype, "className");
    }
  });

  it("keeps strict runtime assignment failures for a CommonJS consumer", async () => {
    const source =
      'const {recipe}=require("/extracted_rules.css.ts"); const {$$styled}=require("@mincho-js/react/runtime");' +
      'const Box=$$styled("div",recipe); function App(flag){return <Box size={flag ? "large" : "small"}/>;} module.exports.App=App;';

    const code = await optimize(source);

    expect(code).not.toContain("<Box");

    const before = styledModule(source).App!;
    const after = styledModule(code).App!;

    try {
      Object.defineProperty(Object.prototype, "size", {
        configurable: true,

        get() {
          return "small";
        }
      });

      expect(() => renderStyled(before(true))).toThrow(TypeError);
      expect(() => renderStyled(after(true))).toThrow(TypeError);
    } finally {
      Reflect.deleteProperty(Object.prototype, "size");
    }
  });

  it("preserves the styled binding read before evaluating its attributes", async () => {
    const source =
      recipeImport +
      styledImport +
      'export const result=App(true); const Box=$$styled("div",recipe); function App(flag){return <Box size={flag ? "large" : "small"}/>;}';

    const code = await optimize(source);

    expect(() => styledModule(source)).toThrow(ReferenceError);
    expect(() => styledModule(code)).toThrow(ReferenceError);
  });

  it.each([
    'export { Box }; export function App(flag){return <Box size={flag ? "large" : "small"}/>;}',
    "export function App(value){return <Box size={value}/>;}",
    'export function App(flag){return flag ? <Box size={flag ? "large" : "small"}/> : <span/>;}',
    'export function App(flag){return <Box ref={ref} size={flag ? "large" : "small"}/>;}',
    'export function App(flag){return <Box {...props} size={flag ? "large" : "small"}/>;}',
    'export function App(flag){return <Wrapper><Box size={flag ? "large" : "small"}/></Wrapper>;}',
    'export function App(flag){return <Box size={flag ? "large" : "small"}><Child/></Box>;}',
    'export function App(flag){return <><Box size={flag ? "large" : "small"}/><Box as="span"/></>;}',
    'export {recipe}; export function App(flag){return <Box size={flag ? "large" : "small"}/>;}',
    'recipe.variants = () => []; export function App(flag){return <Box size={flag ? "large" : "small"}/>;}'
  ])("retains wrappers when any closed-use proof fails: %s", async (use) => {
    const code = await optimize(
      recipeImport + styledImport + 'const Box=$$styled("div",recipe);' + use
    );

    expect(code).toContain("<Box");
  });

  it("combines nested wrappers as ordered stages without merging recipe configurations", async () => {
    const code = await optimize(
      recipeImport +
        styledImport +
        'const Parent=$$styled("div",recipe); const Child=$$styled(Parent,recipe); export function App(flag){return <Child size={flag ? "large" : "small"}/>;}'
    );

    expect(code).toContain("$$styledChain");
    expect(code).toContain('variantKeys: ["size", "active"]');
    expect(code).toContain("<Child");
    expect(code).not.toContain("$$styled(Parent");
  });
});
