import type { Binding } from "@babel/traverse";
import { getDestructuredBindingSource } from "../staticCssEval/partialEvaluator/destructuring.js";
import {
  reduceFixture,
  setPartialEvalTestExpect
} from "../staticCssEval/partialEvaluator/__tests__/helpers.js";
import { createPartialEvalContext } from "../staticCssEval/partialEvaluator/context.js";
import { reducePartialEvalExpression } from "../staticCssEval/partialEvaluator/reducer.js";
import { babelTransform } from "../testUtils/plugin.js";
import { prepareModuleSourceFixture } from "../testUtils/moduleSourceFixture.js";
import { describe, expect, it } from "vitest";
import { analyzePureFunctions } from "./pureFunctions.js";
import {
  transformSync,
  transformFromAstSync,
  types as t,
  type TransformOptions
} from "@babel/core";
import { minchoBabelPlugin as mincho } from "../index.js";
import { SourceAstCache } from "../staticCssEval/moduleParser.js";

const generate = (expression: t.Expression) =>
  transformFromAstSync(
    t.file(t.program([t.expressionStatement(expression)])),
    "",
    { configFile: false, babelrc: false }
  )!;

function analyze(
  source: string,
  modules: Record<string, string> = {},
  options: {
    nativeArrayIteration?: boolean;
    parserCache?: SourceAstCache;
    parserPlugins?: NonNullable<TransformOptions["parserOpts"]>["plugins"];
  } = {}
) {
  const flow = analyzePureFunctions({
    filename: "/app.tsx",
    source,
    jsxCssProp: true,
    ...options
  });

  let step = flow.next();

  while (!step.done) {
    const request = step.value;
    step = flow.next(
      request.kind === "load"
        ? (modules[request.id] ?? null)
        : request.kind === "resolve" && modules[request.source]
          ? request.source
          : null
    );
  }

  return step.value;
}

describe("pure helper evaluation", () => {
  it.each([
    ["owner", false],
    ["owner", true],
    ["dependency", false],
    ["dependency", true]
  ] as const)(
    "preserves configured parser plugins in the %s with cached parsing=%s",
    (location, cached) => {
      const decorated =
        "export @sealed class View { render(): unknown { return <div />; } }";
      const helper = "const style = (n: number) => ({ padding: n * 4 });";
      const source = `${
        location === "owner"
          ? `${decorated} ${helper}`
          : 'import { style } from "/helper.tsx";'
      } const App = () => <div css={style(2)} />;`;
      const options = {
        parserCache: cached ? new SourceAstCache() : undefined,
        parserPlugins: [
          ["decorators", { decoratorsBeforeExport: false }]
        ] satisfies NonNullable<TransformOptions["parserOpts"]>["plugins"]
      };
      const result = analyze(
        source,
        { "/helper.tsx": `${decorated} export ${helper}` },
        options
      );

      expect(result.replacements).toHaveLength(1);
      expect(generate(result.replacements[0]!.expression).code).toContain(
        "padding: 8"
      );
    }
  );

  it("keeps immediate helper calls eligible while leaving function-valued rules intact", () => {
    const folded = analyze(
      'const App = () => <div css={{ color: (() => "red")() }} />;'
    );

    expect(folded.replacements).toHaveLength(1);
    expect(generate(folded.replacements[0]!.expression).code).toContain(
      'color: "red"'
    );

    const callbacks = analyze(
      'import { rules } from "@mincho-js/css"; const cls = rules({ base: { color: "red" }, compoundVariants: ({ size }) => [] });'
    );

    expect(callbacks.replacements).toHaveLength(0);
  });

  it("evaluates defaults, closures, nested helpers, arrays and expressions", () => {
    const result = analyze(`
      const scale = 4;
      function px(n = 2) { const value = n * scale; return value + "px"; }
      const styles = flag => ({ padding: px(), margin: [0, px(3)], color: flag ? "red" : "blue" });
      const App = () => <div css={styles(true)} />;
    `);

    expect(result.replacements).toHaveLength(1);
    expect(generate(result.replacements[0]!.expression).code).toContain(
      'padding: "8px"'
    );
    expect(generate(result.replacements[0]!.expression).code).toContain(
      'color: "red"'
    );
  });

  it.each([
    [
      'import * as helpers from "barrel";',
      "helpers.style(3)",
      'export { style } from "helper";',
      "export const style = n => ({ padding: n * 4 });"
    ],
    [
      'const { style: make } = require("barrel");',
      "make(3)",
      'module.exports = require("helper");',
      "exports.style = n => ({ padding: n * 4 });"
    ]
  ])(
    "follows lexical exports through ESM and CommonJS: %s",
    (imports, call, barrel, helper) => {
      const result = analyze(
        `${imports} const App = () => <div css={${call}} />;`,
        { barrel, helper }
      );

      expect(result.replacements).toHaveLength(1);
      expect(generate(result.replacements[0]!.expression).code).toContain(
        "padding: 12"
      );
      expect(result.dependencies).toEqual(
        expect.arrayContaining(["barrel", "helper"])
      );
    }
  );

  it.each([
    "const helper = n => unknown(n);",
    "const helper = n => ({ get padding() { return n; } });",
    "let helper = n => ({ padding: n });",
    "const helper = async n => ({ padding: n });",
    "const helper = n => helper(n);",
    "const helper = n => n ? helper(n - 1) : ({padding: 1});",
    "const helper = n => false ? unknown() : ({padding: 1});",
    "const helper = n => { let x = n; return { padding: x }; };",
    "const helper = n => { for (;;) {} return {}; };",
    "const helper = n => { const x = mutate(); return { padding: n }; };",
    "const helper = n => ({ padding: this.value });",
    "const object = { padding: 4 }; object.padding++; const helper = n => object;",
    "export const object = { padding: 4 }; const helper = n => object;",
    "const object = { padding: 4 }; export const shared = () => object; const helper = n => object;",
    "const object = { padding: 4 }; export { object }; const helper = n => object;",
    "const helper = n => ({ padding: runtime });"
  ])("deopts unsupported or effectful code: %s", (helper) => {
    expect(
      analyze(`${helper} const App = () => <div css={helper(2)} />;`)
        .replacements
    ).toHaveLength(0);
  });

  it("bounds nested calls and cumulative expansion", () => {
    const chain = Array.from(
      { length: 55 },
      (_, i) => `const f${i} = n => ${i ? `f${i - 1}(n)` : "n"};`
    ).join("\n");

    expect(
      analyze(`${chain} const App = () => <div css={f54(1)} />;`).replacements
    ).toHaveLength(0);

    const large = `const a = n => [${Array(101).fill("n").join(",")}]; const helper = n => a(a(n));`;

    expect(
      analyze(`${large} const App = () => <div css={helper(2)} />;`)
        .replacements
    ).toHaveLength(0);
  });

  it("does not fold shared aggregate state accessed through a namespace", () => {
    const result = analyze(
      'import * as tokens from "tokens"; const helper = () => ({ padding: tokens.object.padding }); const App = () => <div css={helper()} />;',
      {
        tokens: "export const object = { padding: 4 };"
      }
    );

    expect(result.replacements).toHaveLength(0);
  });

  it("enables local Babel evaluation by default and allows an opt out", () => {
    const code =
      "const helper = n => ({ padding: n * 4 }); export const App = () => <div css={helper(2)} />;";

    const run = (pureFunctions?: boolean) =>
      transformSync(code, {
        filename: "/app.tsx",
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["jsx"] },
        plugins: [[mincho, { jsxCssProp: true, optimize: { pureFunctions } }]]
      });

    expect(run()?.metadata).toHaveProperty(
      "minchoPureFunctions",
      expect.arrayContaining([expect.objectContaining({ result: "folded" })])
    );
    expect(() => run(false)).toThrow();
  });
});

it.each([true, false])(
  "respects observed native iteration for imported helper folding: %s",
  (intact) => {
    const result = analyze(
      'import {getStyles} from "/theme.ts";export const Box=()=>{const[size]=[4];return <div css={getStyles(size)}/>}',
      { "/theme.ts": "export function getStyles(size){return {padding:size}}" },
      { nativeArrayIteration: intact }
    );
    expect(result.replacements).toHaveLength(intact ? 1 : 0);
  }
);

it.each([true, false])(
  "respects native iteration for spread-only pure helper folding: %s",
  (intact) => {
    const result = analyze(
      'import {getStyles} from "/theme.ts";export const Box=()=>{const values=[...[4]];const size=values[0];return <div css={getStyles(size)}/>}',
      { "/theme.ts": "export function getStyles(size){return {padding:size}}" },
      { nativeArrayIteration: intact }
    );
    expect(result.replacements).toHaveLength(intact ? 1 : 0);
  }
);

setPartialEvalTestExpect(expect);

function bindingFrom(source: string): Binding {
  let binding: Binding | undefined;
  transformSync(source, {
    configFile: false,
    babelrc: false,
    plugins: [
      {
        visitor: {
          Program(path) {
            binding = path.scope.getBinding("size");
          }
        }
      }
    ]
  });
  if (!binding) throw new Error("Missing size binding");
  return binding;
}
describe("destructuring operation evidence", () => {
  it.each([
    "const [size]=[4];",
    "const {values:[size]}={values:[4]};",
    "const [{size}]=[{size:4}];"
  ])(
    "does not replace iteration with indexed access when revoked: %s",
    (source) => {
      const binding = bindingFrom(source);
      expect(
        getDestructuredBindingSource(binding, "size", {
          nativeArrayIteration: false
        })
      ).toBeNull();
      expect(
        getDestructuredBindingSource(binding, "size", {
          nativeArrayIteration: true
        })
      ).not.toBeNull();
    }
  );
  it("observes local iterator mutation even with an incoming positive receipt", () => {
    const binding = bindingFrom(
      "Array.prototype[Symbol.iterator]=function*(){yield 9}; const [size]=[4];"
    );
    expect(
      getDestructuredBindingSource(binding, "size", {
        nativeArrayIteration: true
      })
    ).toBeNull();
  });
  it("keeps object own-property reads separate from native array iteration", () => {
    const binding = bindingFrom("const {0:size}=[4];");
    expect(
      getDestructuredBindingSource(binding, "size", {
        nativeArrayIteration: false
      })?.memberPath
    ).toEqual(["0"]);
  });
});

it("does not equate a custom iterable object with its numeric properties", () => {
  const binding = bindingFrom(
    "const [size]={0:4,*[Symbol.iterator](){yield 9}};"
  );
  expect(
    getDestructuredBindingSource(binding, "size", {
      nativeArrayIteration: true
    })
  ).toBeNull();
});

it("reduces an unchanged const-array alias before checking the iteration receiver", () => {
  const [result] = reduceFixture(
    "const array=[4];const [size]=array;capture(size);"
  );
  expect(result?.kind).toBe("confident");
  if (result?.kind === "confident")
    expect(result.expression).toMatchObject({
      type: "NumericLiteral",
      value: 4
    });
});
it("carries incoming iteration revocation through the partial evaluator context", () => {
  const binding = bindingFrom("const array=[4];const [size]=array;");
  const program = binding.scope.getProgramParent().path;
  if (!program.isProgram()) throw new Error("Expected Program");
  const result = reducePartialEvalExpression({
    expression: t.identifier("size"),
    scope: binding.scope,
    programPath: program,
    context: createPartialEvalContext({
      owner: { file: "/fixture.ts" },
      nativeArrayIteration: false
    })
  });
  expect(result.kind).toBe("deopt");
});
it.each([
  "const [size]=[4];",
  "const {slot:[size]}={slot:[4]};",
  "const [{size}]=[{size:4}];"
])(
  "does not publish stale JSX css from revoked no-default iteration: %s",
  (pattern) => {
    const source = `import {getStyles} from './theme.css.js';export const Box=()=>{${pattern}return <div css={getStyles(size)}/>}`;
    const modules = {
      "./theme.css.js":
        "export function getStyles(size){return {padding:size}}",
      "./mutator.js": "Array.prototype[Symbol.iterator]=function*(){yield 9};",
      "custom-preset": 'export function css(value){return "c"}'
    };
    const prepared = prepareModuleSourceFixture(
      "import './mutator.js';" + source,
      modules,
      {
        "custom-preset": ["css"]
      }
    );
    expect(prepared.arrayMapIntrinsics?.iterationIntact).toBe(false);
    let result: ReturnType<typeof babelTransform>;
    try {
      result = babelTransform(source, {
        jsxCssProp: true,
        preparedExtractCalls: prepared,
        optimize: { pureFunctions: true }
      });
    } catch (error) {
      expect(String(error)).toMatch(
        /Cannot|Unsupported|Configured|unsafe|static/
      );
      return;
    }
    expect(result.result[1]).toContain(
      "Configured JSX css prop accepts runtime calls only"
    );
    expect(result.result[1]).not.toContain("const [size]");
  }
);
it("preserves clean no-default destructuring in JSX css", () => {
  const source =
    'import {getStyles} from "./theme.css.js";export const Box=()=>{const array=[4];const[size]=array;return <div css={getStyles(size)}/>};';
  const prepared = prepareModuleSourceFixture(
    source,
    {
      "./theme.css.js":
        "export function getStyles(size){return {padding:size}}",
      "custom-preset": 'export function css(value){return "c"}'
    },
    { "custom-preset": ["css"] }
  );
  const result = babelTransform(source, {
    jsxCssProp: true,
    preparedExtractCalls: prepared,
    optimize: { pureFunctions: false }
  });
  expect(result.result[1]).not.toContain(
    "Configured JSX css prop accepts runtime calls only"
  );
  const values: unknown[] = [];
  const sidecar = result.result[1]
    .replace(/^import .*;$/gm, "")
    .replace(/export /g, "");
  new Function("_css", "getStyles", sidecar)(
    (value: unknown) => values.push(value),
    (size: number) => ({ padding: size })
  );
  expect(values).toEqual([{ padding: 4 }]);
});
it("does not let pure function preprocessing erase a revoked iterator operation", () => {
  const source =
    "function getStyles(size){return {padding:size}};export const Box=()=>{const[size]=[4];return <div css={getStyles(size)}/>};";
  const prepared = prepareModuleSourceFixture(
    "import './mutator.js';" + source,
    {
      "./mutator.js": "Array.prototype[Symbol.iterator]=function*(){yield 9};",
      "custom-preset": 'export function css(value){return "c"}'
    },
    { "custom-preset": ["css"] }
  );
  expect(prepared.arrayMapIntrinsics?.iterationIntact).toBe(false);
  expect(() =>
    babelTransform(source, {
      jsxCssProp: true,
      preparedExtractCalls: prepared,
      optimize: { pureFunctions: true }
    })
  ).toThrow(/Cannot statically evaluate/);
});

it.each([true, false])(
  "requires native iteration to flatten array spreads: %s",
  (intact) => {
    const result = reducePartialEvalExpression({
      expression: t.arrayExpression([
        t.spreadElement(t.arrayExpression([t.numericLiteral(4)]))
      ]),
      context: createPartialEvalContext({
        owner: { file: "/fixture.ts" },
        nativeArrayIteration: intact
      })
    });
    expect(result.kind).toBe(intact ? "confident" : "deopt");
    if (result.kind === "deopt")
      expect(result.fallbackExpression).toMatchObject({
        elements: [{ type: "SpreadElement" }]
      });
  }
);
it("does not flatten spreads after a source-observed iterator mutation", () => {
  const binding = bindingFrom(
    "Array.prototype[Symbol.iterator]=function*(){yield 9}; const size=4;"
  );
  const program = binding.scope.getProgramParent().path;
  if (!program.isProgram()) throw new Error("Expected Program");
  const result = reducePartialEvalExpression({
    expression: t.arrayExpression([
      t.spreadElement(t.arrayExpression([t.numericLiteral(4)]))
    ]),
    programPath: program,
    scope: binding.scope,
    context: createPartialEvalContext({
      owner: { file: "/fixture.ts" },
      nativeArrayIteration: true
    })
  });
  expect(result.kind).toBe("deopt");
});
