import { describe, it, expect } from "vitest";
import { transformSync } from "@babel/core";
import type { NodePath, PluginObj } from "@babel/core";
import type { types as t } from "@babel/core";
import { hasStaticCssEvalBindingMutation } from "./mutation.js";
import {
  minchoBabelPlugin,
  internalCreateImportedStaticCssEvalProvider
} from "../../index.js";
import type { PluginOptions } from "../../types.js";

function hasMutation(source: string): boolean {
  let result: boolean | undefined;
  transformSync(source, {
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript"] },
    plugins: [
      (): PluginObj => ({
        visitor: {
          Program(program: NodePath<t.Program>) {
            const binding = program.scope.getBinding("style");
            if (!binding) throw new Error("Expected style binding");

            result = hasStaticCssEvalBindingMutation(program, binding);
            program.stop();
          }
        }
      })
    ]
  });

  if (result === undefined) throw new Error("Expected mutation result");

  return result;
}

const mutations = [
  `const alias = style; alias.color = 'blue';`,
  `let alias; alias = style; alias.color = 'blue';`,
  `const alias = style.nested; alias.color = 'blue';`,
  `const { nested: alias } = style; alias.color = 'blue';`,
  `const [alias] = [style]; delete alias.color;`,
  `const wrapped = { rule: style }; wrapped.rule.color = 'blue';`,
  `const alias = { ...style }; alias.nested.color = 'blue';`,
  `const alias = style as Record<string, unknown>; alias.color = 'blue';`,
  `function mutate(rule) { rule.color = 'blue'; } mutate(style);`,
  `unknownFunction({ rule: style });`,
  `unknownFunction?.(style);`,
  `external.saved = style;`,
  `function getRule() { return style; } getRule().color = 'blue';`,
  `function wrap() { return { rule: style }; } wrap().rule.color = 'blue';`,
  `const { ...alias } = style; alias.nested.color = 'blue';`,
  `const { color, ...alias } = style; alias.nested.color = 'blue';`,
  `const { ...first } = style; const { ...alias } = first; alias.nested.color = 'blue';`,
  `const [...alias] = [style]; alias[0].color = 'blue';`,
  `const [, ...alias] = [{ color: 'green' }, style]; alias[0].color = 'blue';`,
  `const alias = [style]; alias[0].color++;`,
  `class Mutator { constructor(rule) { rule.color = 'blue'; } } new Mutator(style);`,
  `const alias = style; for (alias.color of ['blue']) {}`,
  `const alias = style; for (alias.color in { blue: 1 }) {}`,
  `for (const alias of [style]) { alias.color = 'blue'; }`,
  `let alias; for (alias of [style]) { alias.color = 'blue'; }`
];

describe("mutable object reference analysis", () => {
  it.each(mutations)("detects an alias write or escape: %s", (mutation) => {
    expect(
      hasMutation(
        `const style = { color: 'red', nested: { color: 'red' } }; ${mutation}`
      )
    ).toBe(true);
  });

  it.each([
    `const alias = style; const color = alias.color;`,
    `const copy = { ...style }; copy.color = 'blue';`,
    `const { ...copy } = style; copy.color = 'blue';`,
    `const { ...copy } = style; copy.nested = { color: 'blue' };`,
    `const { nested, ...copy } = style; unknownFunction(copy);`,
    `const { nested, ...first } = style; const { ...copy } = first; unknownFunction(copy);`,
    `const [...copy] = [style]; copy[0] = { color: 'blue' };`,
    `const [, ...copy] = [style, { color: 'green' }]; copy[0].color = 'blue';`,
    `const [, ...first] = [style, style.nested, { color: 'green' }]; const [, ...copy] = first; copy[0].color = 'blue';`,
    `const copy = { nested: { color: 'blue' } }; copy.nested.color = 'green';`,
    `const color = style.color; unknownFunction(color);`,
    `const { color } = style; unknownFunction(color);`,
    `Object.keys(style);`,
    `import { css as createCss } from '@mincho-js/css'; createCss(style);`,
    `function local() { const style = { color: 'blue' }; style.color = 'green'; }`
  ])("retains read-only uses and independent objects: %s", (usage) => {
    expect(
      hasMutation(
        `const style = { color: 'red', nested: { color: 'red' } }; ${usage}`
      )
    ).toBe(false);
  });

  it("distinguishes fresh objects returned by separate factory calls", () => {
    expect(
      hasMutation(`
      function makeRule() { return { nested: { color: 'red' } }; }
      const style = makeRule();
      const other = makeRule();
      other.nested.color = 'blue';
    `)
    ).toBe(false);
  });

  it("does not treat a primitive passed to a function as a mutable object", () => {
    expect(hasMutation(`const style = 'red'; unknownFunction(style);`)).toBe(
      false
    );
  });

  it.each([
    `const style = [{ color: 'red' }]; const [...copy] = style; copy[0] = { color: 'blue' };`,
    `const source = [{ color: 'red' }]; const [...style] = source; source[0] = { color: 'blue' };`,
    `const source = { nested: { color: 'red' } }; const { ...style } = source; source.nested = { color: 'blue' };`
  ])(
    "distinguishes rest copies from their source allocations: %s",
    (source) => {
      expect(hasMutation(source)).toBe(false);
    }
  );

  it.each([
    `const source = [{ color: 'red' }]; const [...style] = source; source[0].color = 'blue';`,
    `const source = { nested: { color: 'red' } }; const { ...style } = source; source.nested.color = 'blue';`
  ])("retains nested references shared by rest copies: %s", (source) => {
    expect(hasMutation(source)).toBe(true);
  });
});

function cssTransform(styles: string, kind: string) {
  const ownerId = "/project/src/App.tsx";
  const stylesId = "/project/src/styles.ts";
  const source =
    kind === "same-file"
      ? `${styles} export const App = () => <div css={style} />;`
      : `import { style } from './styles'; export const App = () => <div css={style} />;`;

  const options: PluginOptions = {
    result: ["", ""],
    jsxCssProp: true,
    staticCssEvalProvider:
      kind === "imported"
        ? internalCreateImportedStaticCssEvalProvider({
            modules: [
              { id: ownerId, source },
              { id: stylesId, source: styles }
            ],
            importResolutions: [
              {
                importerId: ownerId,
                importPath: "./styles",
                resolvedId: stylesId
              }
            ]
          })
        : undefined
  };

  return {
    options,

    run: () =>
      transformSync(source, {
        filename: ownerId,
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["jsx"] },
        plugins: [[minchoBabelPlugin(), options]]
      })
  };
}

describe("css prop alias mutation diagnostics", () => {
  it.each(["same-file", "imported"])(
    "rejects changed %s rules before emitting stale CSS",
    (kind) => {
      const styles = `export const style = { color: 'red' }; const alias = style; alias.color = 'blue';`;
      const { options, run } = cssTransform(styles, kind);

      expect(run).toThrow(/binding "style".*mutated/);
      expect(options.result[1]).toBe("");
    }
  );

  describe.each(["same-file", "imported"])("%s rest copies", (kind) => {
    it.each([
      `const { ...copy } = style; copy.color = 'blue';`,
      `const [...copy] = [style]; copy[0] = { color: 'blue' };`,
      `const [, ...copy] = [style, { color: 'green' }]; copy[0].color = 'blue';`
    ])("emits the unchanged source rule after %s", (usage) => {
      const { options, run } = cssTransform(
        `export const style = { color: 'red' }; ${usage}`,
        kind
      );

      run();

      expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
      expect(options.result[1]).not.toContain("blue");
    });

    it.each([
      `const { ...copy } = { nested: style }; copy.nested.color = 'blue';`,
      `const [, ...copy] = [{ color: 'green' }, style]; copy[0].color = 'blue';`
    ])("rejects a retained nested reference changed by %s", (usage) => {
      const { options, run } = cssTransform(
        `export const style = { color: 'red' }; ${usage}`,
        kind
      );

      expect(run).toThrow(/binding "style".*mutated/);
      expect(options.result[1]).toBe("");
    });
  });
});
