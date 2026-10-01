import { describe, expect, it } from "vitest";
import { analyzePureFunctions } from "./pureFunctions.js";
import { transformSync, transformFromAstSync, types as t } from "@babel/core";
import { minchoBabelPlugin as mincho } from "../index.js";

const generate = (expression: t.Expression) =>
  transformFromAstSync(
    t.file(t.program([t.expressionStatement(expression)])),
    "",
    { configFile: false, babelrc: false }
  )!;

function analyze(source: string, modules: Record<string, string> = {}) {
  const flow = analyzePureFunctions({
    filename: "/app.tsx",
    source,
    jsxCssProp: true
  });

  let step = flow.next();

  while (!step.done) {
    const request = step.value;
    step = flow.next(
      request.kind === "load"
        ? (modules[request.id] ?? null)
        : modules[request.source]
          ? request.source
          : null
    );
  }

  return step.value;
}

describe("pure helper evaluation", () => {
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
