import { describe, expect, it } from "vitest";
import { babelTransform } from "./testUtils/plugin.js";

describe("vanilla-extract sidecar extraction", () => {
  it.each([
    ["style", '{ color: "red" }'],
    ["styleVariants", '{ red: { color: "red" } }'],
    ["globalStyle", '"body", { margin: 0 }'],
    ["createTheme", '{ color: "red" }'],
    ["createGlobalTheme", '":root", { color: "red" }'],
    ["createThemeContract", "{ color: null }"],
    ["createGlobalThemeContract", '{ color: "color" }'],
    ["createVar", ""],
    ["createGlobalVar", '"accent"'],
    ["fontFace", '{ src: "local(Arial)" }'],
    ["globalFontFace", '"Body", { src: "local(Arial)" }'],
    ["keyframes", "{ to: { opacity: 1 } }"],
    ["globalKeyframes", '"fade", { to: { opacity: 1 } }'],
    ["layer", ""],
    ["globalLayer", '"reset"'],
    ["createContainer", ""],
    ["createViewTransition", ""],
    ["generateIdentifier", ""]
  ])("extracts @vanilla-extract/css %s", (name, args) => {
    const { code, result } = babelTransform(`
      import { ${name} } from "@vanilla-extract/css";
      export const value = ${name}(${args});
    `);

    expect(code).toContain(result[0]);
    expect(code).not.toContain(`${name}(`);
    expect(result[1]).toContain(`${name}(`);
    expect(result[1]).toContain('from "@vanilla-extract/css"');
  });

  it.each([
    ["@vanilla-extract/recipes", "recipe"],
    ["@vanilla-extract/sprinkles", "defineProperties"],
    ["@vanilla-extract/sprinkles", "createSprinkles"],
    ["@vanilla-extract/sprinkles", "createNormalizeValueFn"],
    ["@vanilla-extract/sprinkles", "createMapValueFn"],
    ["@vanilla-extract/sprinkles", "createAtomicStyles"],
    ["@vanilla-extract/sprinkles", "createAtomsFn"],
    ["@vanilla-extract/sprinkles/createUtils", "createNormalizeValueFn"],
    ["@vanilla-extract/sprinkles/createUtils", "createMapValueFn"],
    ["@mincho-js/css/compat", "style"],
    ["@mincho-js/css/compat", "recipe"]
  ])("extracts %s %s via an aliased import", (source, name) => {
    const { code, result } = babelTransform(`
      import { ${name} as define } from "${source}";
      const options = {};
      export const value = define(options);
    `);

    expect(code).not.toContain("define(options)");
    expect(result[1]).toContain(`from "${source}"`);
    expect(result[1]).toContain("const options = {}");
    expect(result[1]).toContain("define(options)");
  });

  it.each(["styles.style", 'styles["style"]'])(
    "extracts a namespace call: %s",
    (callee) => {
      const { code, result } = babelTransform(`
        import * as styles from "@vanilla-extract/css";
        export const red = ${callee}({ color: "red" });
      `);

      expect(code).not.toContain(`${callee}(`);
      expect(result[1]).toContain(`${callee}(`);
      expect(result[1]).toContain(
        'import * as styles from "@vanilla-extract/css"'
      );
    }
  );

  it("preserves runtime helpers and calls to generated functions", () => {
    const { code, result } = babelTransform(`
      import { composeStyles, assignVars, fallbackVar, assertVarName } from "@vanilla-extract/css";
      import { assignInlineVars, setElementVars } from "@vanilla-extract/dynamic";
      import { recipe } from "@vanilla-extract/recipes";
      import { createSprinkles as createRuntimeSprinkles } from "@vanilla-extract/sprinkles/createRuntimeSprinkles";

      const button = recipe({ base: { display: "flex" } });
      export function render(element, vars, value, config) {
        assertVarName(value);
        setElementVars(element, vars, value);
        const sprinkles = createRuntimeSprinkles(config);
        return [button(value), sprinkles(value), composeStyles(value), assignVars(vars, value), fallbackVar(value), assignInlineVars(vars, value)];
      }
    `);

    expect(result[1]).toContain("recipe({");
    expect(result[1]).not.toContain("render");

    for (const call of [
      "assertVarName(value)",
      "setElementVars(element, vars, value)",
      "createRuntimeSprinkles(config)",
      "button(value)",
      "sprinkles(value)",
      "composeStyles(value)",
      "assignVars(vars, value)",
      "fallbackVar(value)",
      "assignInlineVars(vars, value)"
    ])
      expect(code).toContain(call);
  });

  it("ignores shadowed imports, unrelated sources and computed runtime names", () => {
    const { code, result } = babelTransform(`
      import { style } from "@vanilla-extract/css";
      import * as styles from "@vanilla-extract/css";
      import { recipe } from "another-package";

      export function render(style, name) {
        return [style({ color: "red" }), styles[name]({}), recipe({})];
      }
    `);

    expect(result[1]).toBe("");
    expect(code).toContain("style({");
    expect(code).toContain("styles[name]({})");
    expect(code).toContain("recipe({})");
  });

  it("preserves ignore comments for native calls", () => {
    const { code, result } = babelTransform(`
      import { style } from "@vanilla-extract/css";
      export const red = /* mincho-js-ignore */ style({ color: "red" });
    `);

    expect(code).toContain("style({");
    expect(result[1]).not.toContain("style({");
  });

  it("orders mixed dependencies and side effects in one sidecar", () => {
    const { code, result } = babelTransform(`
      import { css } from "@mincho-js/css";
      import { createTheme, globalStyle, style } from "@vanilla-extract/css";
      import { recipe } from "@vanilla-extract/recipes";
      import { defineProperties, createSprinkles } from "@vanilla-extract/sprinkles";

      const [theme, vars] = createTheme({ color: "red" });
      globalStyle("body", { color: vars.color });
      const base = css({ padding: 4 });
      const native = style([base, { color: vars.color }]);
      const properties = defineProperties({ properties: { display: ["flex"] } });
      const sprinkles = createSprinkles(properties);
      const button = recipe({ base: [native, sprinkles({ display: "flex" })] });
      export const render = (options) => [theme, button(options)];
    `);

    const sidecar = result[1];
    const orderedCalls = [
      "createTheme(",
      "globalStyle(",
      "css(",
      "style(",
      "defineProperties(",
      "createSprinkles(",
      "recipe("
    ];

    for (const [index, call] of orderedCalls.entries()) {
      expect(code).not.toContain(call);
      expect(sidecar.indexOf(call)).toBeGreaterThan(
        index === 0 ? -1 : sidecar.indexOf(orderedCalls[index - 1]!)
      );
    }

    expect(code).toContain("button(options)");
    expect(sidecar).not.toContain("button(options)");
    expect(sidecar).not.toContain('from "extracted_');
  });
});
