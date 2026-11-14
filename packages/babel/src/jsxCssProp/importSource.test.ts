import { describe, expect, it } from "vitest";
import { babelTransform } from "../testUtils/plugin.js";

const jsxCssProp = { importSource: "custom-preset" };

describe("JSX css prop importSource", () => {
  it("extracts the configured css without a source import or extractCalls", () => {
    const { code, result } = babelTransform(
      `export const Button = () => <button css={[
        { bg: { base: "blue-500", _hover: "blue-700" },
          text: "white", font: "bold", py: 2, px: 3 },
        "rounded"
      ]} />;`,
      { jsxCssProp }
    );

    expect(result[1]).toMatch(/import \{ css as \w+ \} from "custom-preset"/);
    expect(result[1]).toContain('"rounded"');
    expect(result[1]).toContain('base: "blue-500"');
    expect(result[1]).toMatch(/= \w+\(\[\{/);
    expect(code).not.toContain("custom-preset");
    expect(code).not.toContain("bg:");
    expect(code).toContain("className=");
    expect(code).toContain(result[0]);
  });

  it("keeps ordered atomic arrays in one configured call under optimizations", () => {
    const { code, result } = babelTransform(
      `export const Box = () => <div className="external" css={[{p: 4}, {px: 3, py: 2}, {pl: 1}]} />;`,
      {
        jsxCssProp,
        optimize: { runtimeCodegen: true },
        experimental: { cssBooleanGates: true }
      }
    );

    expect(result[1]).toMatch(/= \w+\(\[\{/);
    expect(result[1]).toContain("p: 4");
    expect(result[1]).toContain("px: 3");
    expect(result[1]).toContain("pl: 1");
    expect(code).toContain('from "@mincho-js/css/classname"');
    expect(code).not.toContain("custom-preset");
  });

  it("compiles complete static branches without interpreting tokens as CSS properties", () => {
    const { code, result } = babelTransform(
      `export const Button = ({ active }) => <button css={active ? {bg: "blue-500"} : [{bg: "blue-700"}, "rounded"]} />;`,
      {
        jsxCssProp,
        optimize: { runtimeCodegen: true },
        experimental: { cssBooleanGates: true }
      }
    );

    expect(code).toMatch(/className=\{active \?/);
    expect(result[1]).toContain('bg: "blue-500"');
    expect(result[1]).toContain('bg: "blue-700"');
    expect(result[1]).toContain('"rounded"');
    expect(result[1]).not.toContain("--");
  });

  it.each(["bg: value", "padding: value", "bg: { _hover: value }"])(
    "rejects runtime leaves instead of bypassing custom resolvers: %s",
    (property) => {
      expect(() =>
        babelTransform(
          `export const Box = ({value}) => <div css={{${property}}} />;`,
          { jsxCssProp }
        )
      ).toThrow(/static token values/);
    }
  );

  it("combines explicit extraction registration and fingerprints the source", () => {
    const source = `import { rules } from "custom-preset";
      const recipe = rules({base: {p: 2}});
      export const Box = () => <div css={{px: 3}} className={recipe()} />;`;
    const options = {
      jsxCssProp,
      extractCalls: { "custom-preset": ["rules"] }
    };
    const configured = babelTransform(source, options);
    const alternate = babelTransform(source, {
      ...options,
      jsxCssProp: { importSource: "another-preset" }
    });

    expect(configured.result[1]).toContain("rules({");
    expect(configured.code).toContain("recipe()");
    expect(configured.result[0]).not.toBe(alternate.result[0]);
    expect(alternate.result[1]).toContain('from "another-preset"');
    expect(options.extractCalls).toEqual({ "custom-preset": ["rules"] });
  });

  it("preserves atomic precedence by expanding conditional arrays as complete branches", () => {
    const { code, result } = babelTransform(
      `export const Box = ({active, value}) => <div css={active ? [{p: 4}, value && {px: 3}] : {p: 2}} />;`,
      { jsxCssProp }
    );
    expect(code).toContain("active ? value ?");
    expect(result[1]).toMatch(/_css\(\[\{\s+p: 4\s+\}, \{\s+px: 3/);
    expect(result[1]).not.toContain("value");
    expect(result[1]).not.toContain("--");
    expect(() =>
      babelTransform(
        `export const Box = ({value}) => <div css={[{p: 4}, value]} />;`,
        { jsxCssProp }
      )
    ).toThrow(/complete static style arrays/);
  });

  it("preserves true and the explicit default source behavior", () => {
    const source = `export const Box = ({value}) => <div css={{padding: value}} />;`;
    expect(
      babelTransform(source, {
        jsxCssProp: { importSource: "@mincho-js/css" }
      })
    ).toEqual(babelTransform(source, { jsxCssProp: true }));
  });

  it.each([
    ['import {cx} from "custom-preset";', 'cx(active && "external")'],
    [
      'import {cx as merge} from "custom-preset";',
      'merge(active && "external")'
    ],
    [
      'import * as preset from "custom-preset";',
      'preset.cx(active && "external")'
    ],
    [
      'const {cx: merge} = require("custom-preset");',
      'merge(active && "external")'
    ],
    [
      'import {cx} from "custom-preset"; const merge = cx;',
      'merge(active && "external")'
    ]
  ])("keeps configured cx calls as class values: %s", (setup, expression) => {
    for (const registration of [
      undefined,
      { "custom-preset": ["css", "cx"] }
    ]) {
      const { code, result } = babelTransform(
        `
        ${setup}
        export const Box = ({active}) => <div css={${expression}} />;
      `,
        { jsxCssProp, extractCalls: registration }
      );

      expect(result[1]).not.toMatch(
        /import \{ css(?: as \w+)? \} from "custom-preset"/
      );
      expect(result[1]).not.toMatch(/\b_css\(/);
      expect(result[1]).not.toContain("active");
      expect(code).toContain("className");
    }
  });

  it("retains static configured cx extraction and serializes dynamic aliases once", () => {
    const { code, result } = babelTransform(
      `
      import {cx, rules} from "custom-preset";
      const recipe = rules({variants: {tone: {solid: {px: 3}}}});
      const staticClass = cx("external", false);
      export const Box = ({active, tone}) => {
        const merged = cx(active && recipe({tone}));
        return <><div css={merged} /><div css={cx(active && "second")} /><div css={staticClass} /></>;
      };
    `,
      { jsxCssProp, extractCalls: { "custom-preset": ["css", "rules", "cx"] } }
    );

    expect(result[1]).toContain('cx("external", false)');
    expect(result[1]).toContain("rules({");
    expect(result[1]).not.toContain("active");
    expect(result[1]).not.toMatch(/import \{ css/);
    // One shared cx callable and one recipe callable, despite two cx consumers.
    expect(result[1].match(/mincho\$\(/g)).toHaveLength(2);
    expect(code).toMatch(/\(\{\s+tone\s+\}\)/);
    expect(code).not.toContain("css=");
  });

  it("does not confuse an unrelated cx style factory with the configured merger", () => {
    const { result } = babelTransform(
      `
      function cx() { return {px: 3}; }
      export const Box = () => <div css={cx()} />;
    `,
      { jsxCssProp }
    );

    expect(result[1]).toMatch(/import \{ css.*from "custom-preset"/);
    expect(result[1]).toContain("px: 3");
  });

  it.each(["styles.button({tone})", "buttonClass"])(
    "keeps compiled recipe classes at runtime: %s",
    (expression) => {
      const result = babelTransform(
        `
        import {useState} from "react";
        import * as styles from "./theme.css.js";
        export function Box() {
          const [tone] = useState("solid");
          ${expression === "buttonClass" ? "const buttonClass = styles.button({tone});" : ""}
          return <div css={${expression}} />;
        }
      `,
        { jsxCssProp }
      );
      expect(result.result[1]).toContain("__recipe__");
      expect(result.result[1]).not.toContain("useState");
      expect(result.result[1]).not.toContain("tone");
      expect(result.code).toContain("useState");
      expect(result.code).toMatch(/\(\{\s+tone\s+\}\)/);
      expect(result.code).toContain("className");
      expect(result.code).not.toContain("css:");
    }
  );

  it.each([
    ['import {button as recipe} from "./theme.css";', "recipe({tone})"],
    ['const styles = require("./theme.css.cjs");', "styles.button({tone})"],
    [
      'import {mincho$, rules} from "@mincho-js/css"; const styles = mincho$(() => ({button: rules({variants:{tone:{solid:{color:"red"}}}})}));',
      "styles.button({tone})"
    ]
  ])(
    "preserves recipe provenance through aliases and extraction",
    (setup, expression) => {
      const { code, result } = babelTransform(
        `
      ${setup}
      export const Box = ({tone}) => <div css={${expression}} />;
    `,
        { jsxCssProp }
      );
      expect(code).toMatch(/\(\{\s+tone\s+\}\)/);
      expect(code).toContain("className");
      expect(result[1]).toContain("__recipe__");
      expect(result[1]).not.toContain("custom-preset");
      expect(result[1]).not.toContain("({tone})");
    }
  );

  it("keeps known style factories on the static authoring path", () => {
    const { result } = babelTransform(
      `
      function style() { return {px: 3}; }
      export const Box = () => <div css={style()} />;
    `,
      { jsxCssProp }
    );
    expect(result[1]).toContain('from "custom-preset"');
    expect(result[1]).toContain("px: 3");
  });

  it("validates import sources and treats source names as own configuration keys", () => {
    const source = `export const Box = () => <div css={{px: 3}} />;`;
    for (const importSource of ["", " ./preset", "./preset", "/preset"]) {
      expect(() =>
        babelTransform(source, { jsxCssProp: { importSource } })
      ).toThrow(/package or bundler alias/);
    }

    expect(
      babelTransform(source, {
        jsxCssProp: { importSource: "constructor" },
        extractCalls: {}
      }).result[1]
    ).toContain('from "constructor"');
  });
});
