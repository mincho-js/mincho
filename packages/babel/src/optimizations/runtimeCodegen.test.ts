import {
  template,
  transformFromAstSync,
  transformSync,
  type NodePath,
  types as t
} from "@babel/core";
import { describe, expect, it } from "vitest";
import { optimizeRuntimeCodegen } from "./runtimeCodegen.js";
import { pruneRecipeMetadata } from "./recipeMetadata.js";
import { babelTransform } from "../testUtils/plugin.js";
import { analyzeRuntimeExpressions } from "./runtimeExpressions.js";
import { vx } from "@mincho-js/transform-runtime";
import { minchoBabelPlugin } from "../index.js";

function optimize(code: string) {
  return transformSync(code, {
    configFile: false,
    babelrc: false,
    sourceType: "unambiguous",
    plugins: [
      () => ({
        visitor: {
          Program(path: NodePath<t.Program>) {
            optimizeRuntimeCodegen(path);
            pruneRecipeMetadata(path);
          }
        }
      })
    ]
  })!.code!;
}

function analyze(source: string, modules: Record<string, string> = {}) {
  const flow = analyzeRuntimeExpressions({
    filename: "/app.tsx",
    source,
    runtimeCodegen: true,
    styledComponents: true
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

describe("runtime code generation", () => {
  it("imports generated class merging from the pure runtime and removes orphan css imports", () => {
    const result = babelTransform(
      'export function App(flag) {return <div className="base" css={flag ? "active" : "inactive"}/>;}',
      { jsxCssProp: true }
    );

    expect(result.code).toContain('from "@mincho-js/css/classname"');
    expect(result.code).not.toContain('from "@mincho-js/css"');

    const branch = babelTransform(
      'export function App(flag) {return <div css={{color: flag ? "red" : "blue"}}/>;}',
      { jsxCssProp: true }
    );

    expect(branch.code).not.toContain('from "@mincho-js/css"');
    expect(branch.result[1]).toContain("@mincho-js/css");
  });

  it("retains authored module effects while removing generated helpers", () => {
    const { code } = babelTransform(
      'import "@mincho-js/css"; export function App(flag) {return <div css={{color: flag ? "red" : "blue"}}/>;}',
      { jsxCssProp: true }
    );

    expect(code).toContain('import "@mincho-js/css"');
  });

  it.each([false, true])(
    "does not turn an empty type-only import into effects with authored effects %s",
    (authoredEffect) => {
      const { code, result } = babelTransform(
        `import type {} from "@mincho-js/css"; ${authoredEffect ? 'import "@mincho-js/css";' : ""} export function App(flag) {return <div css={{color: flag ? "red" : "blue"}}/>;}`,
        { jsxCssProp: true }
      );

      expect(result[1]).toContain("@mincho-js/css");
      expect(code.includes('import "@mincho-js/css"')).toBe(authoredEffect);
    }
  );

  it.each([false, true])(
    "removes generated CommonJS helpers with authored effects %s",
    (authoredEffect) => {
      const { code, result } = babelTransform(
        `${authoredEffect ? 'require("@mincho-js/css");' : ""}
         exports.App = function App(flag) {
           return <div css={{color: flag ? "red" : "blue"}}/>;
         };`,
        { jsxCssProp: true },
        { filename: "view.tsx", sourceType: "unambiguous" }
      );

      expect(result[1]).toContain("@mincho-js/css");
      expect(code).not.toMatch(/import\s/);
      expect(code).not.toMatch(/require\("@mincho-js\/css"\)\.css/);
      expect(code.includes('require("@mincho-js/css")')).toBe(authoredEffect);
    }
  );

  it("removes extracted authoring imports while preserving runtime references and explicit effects", () => {
    // No TypeScript preset: unused import elision must not hide this regression.
    const extract = (source: string) => {
      const options = { result: ["", ""], optimize: { runtimeCodegen: true } };
      const result = transformSync(source, {
        configFile: false,
        babelrc: false,
        plugins: [[minchoBabelPlugin, options]]
      })!;

      return { code: result.code!, result: options.result };
    };

    const source =
      'import {rules, cx} from "@mincho-js/css"; const recipe = rules({props:["width"]}); export function map(input) {return recipe.props(input);} export const cls = cx(input);';

    const result = extract(source);

    expect(result.code).not.toMatch(/import\s*\{[^}]*\brules\b/);
    expect(result.code).toContain('import { cx } from "@mincho-js/css"');
    expect(result.result[1]).toContain("rules({");
    expect(extract('import "@mincho-js/css";' + source).code).toContain(
      'import "@mincho-js/css"'
    );
    expect(extract(source + "export {rules};").code).toMatch(
      /import\s*\{[^}]*\brules\b/
    );
    expect(extract(source + 'eval("rules");').code).toMatch(
      /import\s*\{[^}]*\brules\b/
    );
    expect(
      extract('import {rules} from "@mincho-js/css"; export const value=1;')
        .code
    ).toContain("rules");
  });

  it("folds literal class runs without crossing dynamic evaluations or deduplicating", () => {
    const code = optimize(
      'import {cx} from "@mincho-js/css/classname"; export const value=cx("a", [false, ["b", "a"]], next(), "", "c");'
    );

    expect(code).toContain('cx("a b a", next(), "c")');
    expect(
      optimize(
        'import {cx} from "@mincho-js/css/classname"; const a=cx("a "," b",0);'
      )
    ).toContain('"a   b"');
    expect(
      optimize(
        'import {cx} from "@mincho-js/css/classname"; const a=cx({a:true});'
      )
    ).toContain("cx({");
    expect(optimize('function f(cx) {return cx("a","b");}')).toContain(
      'cx("a", "b")'
    );
  });

  it("specializes vx with syntax proofs and keeps unknown values guarded", () => {
    const code = optimize(
      'import {vx} from "@mincho-js/transform-runtime"; const a=vx(+size); const b=vx(+size,"px"); const c=vx(void touch()); const d=vx(value);'
    );

    expect(code).toContain("a = +size");
    expect(code).toContain("`${+size}px`");
    expect(code).toContain('void touch(), "var(--c-, )"');
    expect(code).toContain("d = vx(value)");
  });

  it.each(["`", "${literal}", "\\", "\r", "\r\n", "x\\`${literal}\r\n"])(
    "preserves vx suffix bytes: %j",
    (suffix) => {
      const input = template.program.ast`
        import {vx} from "@mincho-js/transform-runtime";
        function result(size) { return vx(+size, ${t.stringLiteral(suffix)}); }
      `;
      const code = optimize(
        transformFromAstSync(input, undefined, {
          configFile: false,
          babelrc: false
        })!.code!
      );

      expect(code).not.toContain("return vx(");

      const result = new Function(
        "size",
        code.replace(/^import[^;]+;/, "") + "\nreturn result(size);"
      );

      expect(result(12)).toBe(vx(12, suffix));
    }
  );

  it.each([
    'eval("r.props({ width: 1 })");',
    'function inspect(eval) { return eval("r.props({ width: 1 })"); }',
    'with (scope) { inspect("r.props"); }'
  ])(
    "preserves metadata and helper calls under dynamic lexical access: %s",
    (use) => {
      const code = optimize(`
      const {createCompiledRuntimeFn: make} = require("@mincho-js/css/rules/createRuntimeFn");
      let cx = require("@mincho-js/css/classname").cx;
      const r = make({ defaultClassName: "base" }, { width: "--width" });
      ${use}
      const result = cx("a", "b");
    `);

      expect(code).toContain('cx("a", "b")');
      expect(code).toContain("--width");
      expect(code).not.toContain("props: false");
    }
  );

  it("retains runtime calls when a local or imported module permits direct eval", () => {
    const factory =
      'const {createCompiledRuntimeFn: make} = require("@mincho-js/css/rules/createRuntimeFn"); const r = make({ defaultClassName: "base", variantClassNames: {}, defaultVariants: {}, compoundVariants: [] }, { width: "--width" });';

    const local = analyze(
      `${factory} const cls = r(); const style = r.props({width: 1});`
    );

    expect(local.calls).toHaveLength(1);
    expect(local.expressions).toHaveLength(1);

    const owner = analyze(
      `${factory} function inspect(eval) { eval("r.props = custom"); } const cls = r(); const style = r.props({width: 1});`
    );

    expect(owner.calls).toHaveLength(0);
    expect(owner.expressions).toHaveLength(0);

    const safeImport = analyze(
      'import {r} from "/bridge.js"; export const cls = r();',
      {
        "/bridge.js":
          'const {r} = require("/extracted_rules.css.ts"); exports.r = r;',
        "/extracted_rules.css.ts": `${factory} exports.r = r;`
      }
    );

    expect(safeImport.calls).toHaveLength(1);

    const imported = analyze(
      'import {r} from "/bridge.js"; export const cls = r();',
      {
        "/bridge.js":
          'const {r} = require("/extracted_rules.css.ts"); function inspect(eval) { return eval("r"); } exports.r = r;',
        "/extracted_rules.css.ts": `${factory} exports.r = r;`
      }
    );

    expect(imported.dependencies).toContain("/bridge.js");
    expect(imported.calls).toHaveLength(0);
    expect(imported.finiteCalls).toHaveLength(0);
  });

  it("removes only redundant copies of fresh data objects", () => {
    const code = optimize(
      "const a={...(test ? {x:read()} : {})}; const b={...input}; const c={...{get x(){return read()}}}; const d={...{__proto__:proto}};"
    );

    expect(code).toMatch(/a = test \?/);
    expect(code).toContain("...input");
    expect(code).toContain("get x()");
    expect(code).toMatch(/\.\.\.\{\s*__proto__/);
  });

  it("prunes unobserved compiled metadata only in closed local use graphs", () => {
    const factory =
      'import {createCompiledRuntimeFn as make} from "@mincho-js/css/rules/createRuntimeFn";';

    const code = optimize(
      factory +
        'const r=make({defaultClassName:"base"},{width:"--width"}); function render(value){return r(value)}'
    );

    expect(code).not.toContain("--width");
    expect(code).toContain("createCompiledClassRuntimeFn");
    expect(code).toContain("variants: false");
    expect(code).toContain("classNames: false");

    for (const use of [
      "export {r};",
      "escape(r);",
      "r.props = other;",
      "r[name];"
    ]) {
      const open = optimize(
        factory + 'const r=make({}, {width:"--width"});' + use
      );

      expect(open).not.toContain("props: false");
      expect(open).toContain("--width");
    }
  });

  it("retains constructor metadata assignments around observable prototype writes", () => {
    const factory =
      'import {createCompiledRuntimeFn as make} from "@mincho-js/css/rules/createRuntimeFn";';

    const recipe =
      'const r=make({defaultClassName:"base"},{width:"--width"}); r();';

    for (const mutation of [
      'Object.defineProperty(Function.prototype, "props", {set(value) { observe(value); }});',
      'Object.defineProperty(Object.prototype, "variants", {set(value) { observe(value); }});',
      "Function.prototype.classNames = replacement;",
      "const inherited = globalThis.Function.prototype; installSetter(inherited);",
      'Function.prototype.__defineSetter__("props", observe);'
    ]) {
      const code = optimize(factory + mutation + recipe);

      expect(code).toContain("--width");
      expect(code).not.toContain("props: false");
      expect(code).not.toContain("variants: false");
      expect(code).not.toContain("classNames: false");
    }

    const readOnly = optimize(
      factory + 'Object.prototype.hasOwnProperty.call(input, "id");' + recipe
    );

    expect(readOnly).toContain("createCompiledClassRuntimeFn");
  });

  it("registers private self-consumed vars only for supported intrinsic elements", () => {
    const transform = (tag: string, style: string) =>
      babelTransform(`function App(size) {return <${tag} css={${style}}/>;}`, {
        jsxCssProp: true,
        experimental: { nonInheritingCssVars: true }
      });

    expect(transform("div", "{width: +size}").result[1]).toContain(
      "inherits: false"
    );
    expect(
      transform("div", '{"@media": {"(min-width: 1px)": {width: +size}}}')
        .result[1]
    ).toContain("inherits: false");

    for (const tag of ["Component", "custom-element"])
      expect(transform(tag, "{width: +size}").result[1]).not.toContain(
        "inherits: false"
      );

    expect(
      transform("div", '{selectors: {"& > span": {width: +size}}}').result[1]
    ).not.toContain("inherits: false");
  });
});
