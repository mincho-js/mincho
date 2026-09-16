import { runInNewContext } from "node:vm";
import { transformWithEsbuild } from "vite";
import { transformSync, type TransformOptions } from "@babel/core";
import { describe, expect, it } from "vitest";
import { commonJsToEsmPlugin, inspectCommonJs } from "./esm.js";

function convert(
  source: string,
  parserPlugins: NonNullable<TransformOptions["parserOpts"]>["plugins"] = []
) {
  const description = inspectCommonJs(source, "input.cjs", parserPlugins);
  const result = transformSync(source, {
    filename: "input.cjs",
    configFile: false,
    babelrc: false,
    sourceType: "unambiguous",
    parserOpts: { plugins: parserPlugins },
    plugins: [
      commonJsToEsmPlugin({
        description,
        imports: {},
        exportNames: description.exports
      })
    ]
  });

  if (!result?.code) throw new Error("Missing converted code");
  return result.code;
}

async function execute(source: string) {
  const output = await transformWithEsbuild(convert(source), "output.js", {
    format: "cjs"
  });
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(output.code, { module, exports: module.exports });
  return module.exports;
}

describe("CommonJS runtime normalization", () => {
  it.each([
    'const { value = require("dep") } = { value: true };',
    'const [value = require("dep")] = [true];',
    'const value = null; value?.[require("dep")];',
    'const value = null; value?.method(require("dep"));'
  ])("does not make a skipped require eager: %s", (source) => {
    const description = inspectCommonJs(source, "input.cjs");

    expect(description.requires).toEqual(["dep"]);
    expect(description.topLevelRequires).toEqual([]);
    expect(description.diagnostics).toEqual([
      expect.stringMatching(/Conditional or lazy require/)
    ]);
  });

  it.each([
    "export const value = 1; exports.other = 2;",
    "export const value = 1; exports.value = 2;"
  ])("keeps existing ESM exports in a mixed module: %s", (source) => {
    const code = convert(source);

    expect(() =>
      transformSync(code, { configFile: false, babelrc: false })
    ).not.toThrow();
  });

  it("rejects a mixed default when the raw CommonJS value would be lost", () => {
    expect(() => convert("export default 1; exports.other = 2;")).toThrow(
      /mixed ESM default and CommonJS exports/
    );
  });

  it("preserves an ESM default when the module only uses require", () => {
    const source =
      'const dependency = require("dep"); export default dependency;';
    const description = inspectCommonJs(source, "input.js");
    expect(description.exportsObject).toBe(false);
    expect(description.diagnostics).toEqual([]);
    expect(convert(source)).toContain("export default dependency");
  });

  it.each([
    'export const load = () => require("dep");',
    'export const value = false && require("dep");',
    "export function load(name) { return require(name); }",
    'import "setup"; export const load = () => require("dep");'
  ])("leaves ESM requires in place when hoisting is unsafe: %s", (source) => {
    const baseline = transformSync(source, {
      configFile: false,
      babelrc: false
    });

    expect(convert(source)).toBe(baseline?.code);
  });

  it.each([
    'export const load = () => require("dep"); exports.value = 1;',
    "export function load(name) { return require(name); } exports.value = 1;"
  ])(
    "keeps require diagnostics for mixed ESM/CommonJS exports: %s",
    (source) => {
      expect(() => convert(source)).toThrow(/lazy require|Dynamic require/);
    }
  );

  it.each([
    "const require = () => 1; export const answer = require();",
    "export default 1;",
    "export const answer = 42;"
  ])("does not mistake ESM exports for CommonJS: %s", (source) => {
    expect(inspectCommonJs(source, "input.js").commonjs).toBe(false);
  });

  it("keeps explicit ESM values and the CommonJS module value", async () => {
    const code = convert(
      "export const value = 1; exports.value = 2; exports.other = 3;"
    );
    const output = await transformWithEsbuild(code, "output.js", {
      format: "cjs"
    });
    const module = { exports: {} as Record<string, unknown> };
    runInNewContext(output.code, { module, exports: module.exports });

    expect(module.exports.value).toBe(1);
    expect(module.exports.other).toBe(3);
    expect(module.exports.default).toEqual({ value: 2, other: 3 });
  });

  it("diagnoses reassignment of the CommonJS exports alias", () => {
    const source = "exports = { value: 1 };";
    const description = inspectCommonJs(source, "input.cjs");

    expect(description.commonjs).toBe(true);
    expect(description.exportsObject).toBe(true);
    expect(() => convert(source)).toThrow(
      /reassigning the CommonJS exports alias/
    );
  });
  it.each([
    'class A { [require("dep")]() {} }',
    'const object = { [require("dep")]() {} };'
  ])("recognizes eagerly evaluated method keys: %s", (source) => {
    expect(inspectCommonJs(source, "input.cjs").diagnostics).toEqual([]);
  });

  it.each([
    "exports.self = this;",
    "exports.self = (() => this)();",
    "module.exports = { self: this };"
  ])("preserves the CommonJS wrapper this value: %s", async (source) => {
    const output = await execute(source);
    const value = output.default as Record<string, unknown>;
    if (source.startsWith("module.exports")) expect(value.self).toEqual({});
    else expect(value.self).toBe(value);
  });

  it.each([
    "[exports] = [{ value: 1 }]; exports.after = 2;",
    "({ target: exports } = { target: { value: 1 } }); exports.after = 2;",
    "for (exports of [{ value: 1 }]) {} exports.after = 2;"
  ])("rejects reassignment of the exports alias: %s", (source) => {
    expect(() => convert(source)).toThrow(
      /reassigning the CommonJS exports alias/
    );
  });

  it.each([
    'events.push("ready"); module.exports = require("dep");',
    'const first = setup(), dep = require("dep");',
    '(setup(), require("dep"));',
    'consume(setup(), require("dep"));',
    'const [value] = require("first"); const second = require("second");',
    'const { value = setup() } = require("first"); const second = require("second");',
    'const { [setup()]: value } = require("first"); const second = require("second");',
    'const { ...values } = require("first"); const second = require("second");',
    'const object = { [setup()]() {}, value: require("dep") };'
  ])("rejects imports that would overtake a side effect: %s", (source) => {
    expect(inspectCommonJs(source, "input.cjs").diagnostics).toContainEqual(
      expect.stringMatching(/require.*before.*side effects/)
    );
  });

  it.each([
    'const first = require("first"); const second = require("second");',
    'const { style } = require("css"); const { recipe } = require("recipes");',
    'var first = require("extracted.css.ts").first; var second = require("extracted.css.ts").second;',
    'const { value } = require("dep"); exports.value = value;',
    'export default 1; require("dep");',
    'Object.defineProperty(exports, "__esModule", { value: true }); exports.value = void 0; const dep = require("dep");',
    'var __create = Object.create; function helper() { setup(); } const dep = require("dep");',
    'var helper = (this && this.helper) || function (obj) { return obj && obj.__esModule ? obj : { default: obj }; }; const dep = helper(require("dep"));'
  ])("allows require declarations and compiler prologues: %s", (source) => {
    expect(inspectCommonJs(source, "input.cjs").diagnostics).toEqual([]);
  });
  it.each(["module", "exports"])(
    "preserves ESM re-export names named %s",
    (name) => {
      const source = `export { value as ${name} } from "dep"; require("other");`;
      expect(inspectCommonJs(source, "input.js").exportsObject).toBe(false);
      expect(convert(source)).toContain(`value as ${name}`);
    }
  );

  it.each([
    ["export const value = this;", "value"],
    ["export default this;", "default"]
  ])("preserves ESM this semantics: %s", async (source, name) => {
    const description = inspectCommonJs(source, "input.mjs");
    expect(description.commonjs).toBe(false);
    expect(description.exportsObject).toBe(false);
    expect(description.diagnostics).toEqual([]);
    expect((await execute(source))[name]).toBeUndefined();
  });

  it("does not infer CommonJS solely from top-level this", () => {
    expect(inspectCommonJs("this.value = 1;", "input.js").commonjs).toBe(false);
  });

  it("keeps the initial this object when module.exports is replaced", async () => {
    const output = await execute(
      "module.exports = { value: 1 }; module.exports.self = this;"
    );
    expect(output.default).toEqual({ value: 1, self: {} });
  });

  it("keeps method and class initializer this separate from the wrapper", async () => {
    const output = await execute(
      "class C { field = this; static self = this; } exports.C = C; exports.object = { self() { return this; }, wrapper: () => this };"
    );
    const C = output.C as { new (): { field: unknown }; self: unknown };
    const object = output.object as { self(): unknown; wrapper(): unknown };
    const instance = new C();
    expect(instance.field).toBe(instance);
    expect(C.self).toBe(C);
    expect(object.self()).toBe(object);
    expect(object.wrapper()).toBe(output.default);
  });

  it("preserves auto-accessor initializer this", () => {
    const code = convert(
      "class C { accessor value = this; } module.exports = C;",
      ["decoratorAutoAccessors"]
    );
    expect(code).toContain("accessor value = this;");
  });

  it("keeps auto-accessor initializer requires lazy", () => {
    const description = inspectCommonJs(
      'class C { accessor value = require("dep"); }',
      "input.cjs",
      ["decoratorAutoAccessors"]
    );
    expect(description.diagnostics).toContainEqual(
      expect.stringMatching(/Conditional or lazy require/)
    );
  });
  it("allows actual esbuild export setup before import declarations", async () => {
    const { code } = await transformWithEsbuild(
      'import * as styles from "css"; import { recipe } from "recipes"; export const render = () => recipe(styles.rule);',
      "styles.ts",
      { loader: "ts", format: "cjs" }
    );
    expect(inspectCommonJs(code, "styles.cjs").diagnostics).toEqual([]);
    expect(
      inspectCommonJs(
        code.replace(
          "__export(styles_exports, {",
          "sideEffect(); __export(styles_exports, {"
        ),
        "styles.cjs"
      ).diagnostics
    ).toContainEqual(expect.stringMatching(/require.*before.*side effects/));
  });

  it("allows canonical interop declarations before later imports", () => {
    const source =
      'function helper(obj) { return obj && obj.__esModule ? obj : { default: obj }; } const first = helper(require("first")); const second = helper(require("second"));';
    expect(inspectCommonJs(source, "input.cjs").diagnostics).toEqual([]);
  });
});
