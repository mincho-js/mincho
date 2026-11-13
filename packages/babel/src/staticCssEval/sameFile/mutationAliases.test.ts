import { describe, it, expect } from "vitest";
import { transformSync } from "@babel/core";
import type { NodePath, PluginObj } from "@babel/core";
import type { types as t } from "@babel/core";
import {
  analyzeAliasedStaticCssEvalBindingMutation,
  analyzeAliasedExpressionMutation,
  analyzeImportedValueOrigin,
  analyzeImportedMemberReadOrigin
} from "./mutationAliases.js";
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
  `const holder = { set nested(value) {}, ...{ get nested() { return style; } } }; holder.nested.color = "blue";`,
  `const proto = { getStyle() { return style; }, get nested() { return this.getStyle(); } }; const holder = { __proto__: proto }; holder.nested.color = "blue";`,
  `const holder = { getStyle() { return style; }, get nested() { return this.getStyle(); } }; holder.nested.color = "blue";`,
  `const holder = { get nested() { return style; }, set nested(value) {} }; holder.nested.color = "blue";`,
  `const holder = { set nested(value) {}, get nested() { return style; } }; holder.nested.color = "blue";`,
  `const holder = { get nested() { return style; }, set nested(value) {}, set nested(value) {} }; holder.nested.color = "blue";`,
  `const proto = { get nested() { return this.backing; } }; const holder = { __proto__: proto, backing: style }; holder.nested.color = "blue";`,
  `const proto = { get nested() { return this.backing; } }; const holder = { __proto__: { __proto__: proto }, backing: style }; holder.nested.color = "blue";`,
  `const holder = { ...{ backing: style, get nested() { return this.backing; } }, backing: {} }; holder.nested.color = "blue";`,
  `const holder = { backing: style, get nested() { return (() => this.backing)(); } }; holder.nested.color = "blue";`,
  `const holder = { backing: style, get nested() { return (() => { return this.backing; })(); } }; holder.nested.color = "blue";`,
  `const holder = { backing: style, get nested() { return this.backing; } }; holder.nested.color = "blue";`,
  `const holder = { ...{ nested: style }, get nested() { return style; } }; holder.nested.color = "blue";`,
  `const holder = { get nested() { return style; } }; const alias = holder.nested; alias.color = "blue";`,
  `const holder = { get nested() { return style; } }; holder[unknownKey].color = "blue";`,
  `const holder = { get nested() { return style; } }; const copy = { ...holder }; copy.nested.color = "blue";`,
  `const holder = {}; ({ value: holder.value } = { value: style });`,
  `const holder = {}; [holder.value] = [style];`,
  `const holder = {}; ({ nested: [holder.value] } = { nested: [style] });`,
  `const holder = {}; ({ ...holder.value } = { nested: style });`,

  `const holder = { __proto__: style, ["__proto__"]: {} }; delete holder.__proto__; holder.__proto__.color = "blue";`,
  `const holder = { __proto__: style, ["__proto__"]: {} }; delete holder?.__proto__; holder.__proto__.color = "blue";`,
  `const holder = { __proto__: { nested: style }, nested: {} }; delete holder[unknownKey]; holder.nested.color = "blue";`,
  `const holder = { __proto__: { nested: style }, nested: {} }; const alias = holder; delete alias.nested; holder.nested.color = "blue";`,

  `const alias = style; alias.color = 'blue';`,
  `let alias; alias = style; alias.color = 'blue';`,
  `function alias() {} alias = style; alias.color = 'blue';`,
  `class Alias {} Alias = style; Alias.color = 'blue';`,
  `const alias = style.nested; alias.color = 'blue';`,
  `const { nested: alias } = style; alias.color = 'blue';`,
  `const [alias] = [style]; delete alias.color;`,
  `const wrapped = { rule: style }; wrapped.rule.color = 'blue';`,
  `const inherited = { __proto__: { rule: style } }; inherited.rule.color = 'blue';`,
  `const inherited = { __proto__: style }; unknownFunction(inherited);`,
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
  it.each([
    "const helpers = { read: () => 4 }; const style = helpers.read();",
    "const helpers = { read() { return 4; } }; const style = helpers.read();",
    "const helpers = { make() { return {color:'red'}; } }; const style = helpers.make(); const other = helpers.make(); other.color='blue';",
    "function identity(value) { return value; } const style = identity({color:'red'});",
    "function read(value=4){return value} const style=read();",
    "const style={color:'red'}; function wrap(x){return ()=>x} const get=wrap({color:'green'}); get().color='blue';",
    "const style={color:'red'}; class Box {value={color:'green'}} new Box().value.color='blue';",
    "const style={color:'red'}; const other={color:'green'}; class Box {get value(){return other}} new Box().value.color='blue';",
    "const style={color:'red'}; function wrap(x){return {get(){return x}}} const box=wrap({color:'green'}); box.get().color='blue';",
    "const style={color:'red'}; try{throw {color:'green'}}catch(x){x.color='blue'}",
    "function read(depth=0){return depth ? 4 : read(1)} const style=read();",
    "function read(flag){return flag ? 4 : globalStyle} const style=read(true);",
    "const read=({nested:[value=4]=[]}={})=>value; const style=read();"
  ])(
    "retains proven local member and parameter return origins: %s",
    (source) => {
      expect(hasMutation(source)).toBe(false);
    }
  );
  it.each([
    "const shared={color:'red'}; const helpers={make(){return shared}}; const style=helpers.make(); const alias=helpers.make(); alias.color='blue';",
    "const helpers={read(){return 4}}; helpers.read=external; const style=helpers.read();",
    "const helpers={read(){return 4}}; mutate(helpers); const style=helpers.read();",
    "const helpers={read(){return this.value},value:{color:'red'}}; const style=helpers.read();",
    "function identity(value){return value} const shared={color:'red'}; const style=identity(shared); shared.color='blue';",
    "const shared={color:'red'}; function tick(){shared.color='blue'} function read(){tick();return shared} const style=read();",
    "const style=factory(); otherFactory().color='blue';",
    "const style=globalStyle; const alias=globalStyle; alias.color='blue';",
    "const style={color:'red'}; function wrap(x){return ()=>x} const get=wrap(style); get().color='blue';",
    "const style={color:'red'}; function wrap(x){return {value:x}} const box=wrap(style); box.value.color='blue';",
    "const style={color:'red'}; function wrap(x){return [x]} const box=wrap(style); box[0].color='blue';",
    "const style={color:'red'}; function wrap(x){return {get value(){return x}}} const box=wrap(style); box.value.color='blue';",
    "const style={color:'red'}; class Box {value=style} new Box().value.color='blue';",
    "const style={color:'red'}; class Box {get value(){return style}} new Box().value.color='blue';",
    "const style={color:'red'}; function wrap(x){return {get(){return x}}} const box=wrap(style); box.get().color='blue';",
    "const style={color:'red'}; try{throw style}catch(x){x.color='blue'}",
    "const shared={color:'red'}; function read(first,second=first){return second} const style=read(shared); shared.color='blue';",
    "const shared={color:'red'}; function read(first,second){return second} const style=read(...unknownArgs, 4);",
    "function read(depth=0){return read(depth)} const style=read();",
    "function f(flag){return g(flag)} function g(flag){return f(flag)} const style=f(true);",
    "function read(flag){return flag ? 4 : globalStyle} const style=read(false);",
    "const shared={color:'red'}; function read(depth=0){return depth ? shared : read(1)} const style=read(); shared.color='blue';",
    "const style={color:'red'}; function read(depth=0){return depth ? 4 : read(1)} read(style.color='blue');",
    "const shared={color:'red'}; function C(){return shared} const style=new C(); const alias=new C(); alias.color='blue';",
    "const style={color:'red'}; function identity(value){return value} identity((style.color='blue',style));",
    "const style={color:'red'}; const source={get value(){style.color='blue';return style}}; function identity(value){return value} identity(source.value);",
    "const style={color:'red'}; function identity(value=(style.color='blue',style)){return value} identity();",
    "const style={color:'red'}; const source={[Symbol.toPrimitive](){style.color='blue';return 1}}; function identity(value){return value} identity(+source);"
  ])(
    "does not confuse return origin with a receiver or effect proof: %s",
    (source) => {
      expect(hasMutation(source)).toBe(true);
    }
  );

  it("uses an exact skipped-default receipt without clearing other uncertainty", () => {
    transformSync("const {style = factory()} = {style: {color:'red'}};", {
      configFile: false,
      babelrc: false,
      plugins: [
        (): PluginObj => ({
          visitor: {
            Program(program) {
              const binding = program.scope.getBinding("style")!;
              const skippedPatternDefaults = new Set<t.AssignmentPattern>();
              program.traverse({
                AssignmentPattern(path) {
                  skippedPatternDefaults.add(path.node);
                }
              });
              expect(
                analyzeAliasedStaticCssEvalBindingMutation(program, binding)
                  .kind
              ).toBe("unknown");
              expect(
                analyzeAliasedStaticCssEvalBindingMutation(program, binding, {
                  skippedPatternDefaults
                }).kind
              ).toBe("proved-unmodified");
              expect(
                analyzeAliasedStaticCssEvalBindingMutation(program, binding, {
                  skippedPatternDefaults: new Set()
                }).kind
              ).toBe("unknown");
              program.stop();
            }
          }
        })
      ]
    });
  });

  it("accepts exact caller receipts without inventing per-call allocation identities", () => {
    transformSync(
      "const style = factory(); const alias = factory(); alias.color = 'blue'; style;",
      {
        configFile: false,
        babelrc: false,
        plugins: [
          (): PluginObj => ({
            visitor: {
              Program(program) {
                const binding = program.scope.getBinding("style")!;
                const sharedIdentity = {};
                expect(
                  analyzeAliasedStaticCssEvalBindingMutation(program, binding)
                    .kind
                ).toBe("unknown");
                expect(
                  analyzeAliasedStaticCssEvalBindingMutation(program, binding, {
                    callResultProof: () => ({
                      kind: "build-owned",
                      identity: sharedIdentity
                    })
                  }).kind
                ).toBe("may-mutate");
                expect(
                  analyzeAliasedStaticCssEvalBindingMutation(program, binding, {
                    callResultProof: () => ({
                      kind: "module-origin",
                      identity: sharedIdentity
                    })
                  }).kind
                ).toBe("may-mutate");
                expect(
                  analyzeImportedValueOrigin(binding.referencePaths[0], [], {
                    callResultProof: () => ({
                      kind: "module-origin",
                      identity: sharedIdentity
                    })
                  }).kind
                ).toBe("imported");
                expect(
                  analyzeAliasedStaticCssEvalBindingMutation(program, binding, {
                    callResultProof: () => ({ kind: "primitive" })
                  }).kind
                ).toBe("proved-unmodified");
                program.stop();
              }
            }
          })
        ]
      }
    );
  });

  it.each([
    ["const value = factory();", "unknown"],
    ["const value = {};", "local"],
    ["import value from './tokens';", "imported"],
    ["const value = require('./tokens');", "imported"]
  ])(
    "distinguishes import origin from an unproven origin: %s",
    (source, expected) => {
      transformSync(source + " value;", {
        configFile: false,
        babelrc: false,
        plugins: [
          (): PluginObj => ({
            visitor: {
              Program(program) {
                const binding = program.scope.getBinding("value")!;
                const value = binding.referencePaths[0];
                expect(
                  analyzeImportedValueOrigin(value as NodePath<t.Node>).kind
                ).toBe(expected);
                expect(
                  analyzeImportedMemberReadOrigin(
                    value as NodePath<t.Node>,
                    "color"
                  ).kind
                ).toBe(expected);
                if (expected === "unknown") {
                  expect(
                    analyzeImportedValueOrigin(value as NodePath<t.Node>, [], {
                      callResultProof: () => ({ kind: "primitive" })
                    }).kind
                  ).toBe("local");
                }
                program.stop();
              }
            }
          })
        ]
      });
    }
  );

  it.each([
    "const style = factory(); const alias = factory(); alias.color = 'blue';",
    "const style = factory();",
    "const style = require('./tokens'); const alias = require('./tokens'); alias.color = 'blue';",
    "const { style } = require('./tokens');",
    "const style = {color:'red'}; function tag(_parts,value){value.color='blue'} tag`${style}`;",
    "const style = {color:'red'}; const alias = await style; alias.color = 'blue';",
    "const style = {color:'red'}; async function get(){return style} const alias = await get(); alias.color = 'blue';",
    "const style = {color:'red'}; function tag(){return style} const alias = tag``; alias.color = 'blue';",
    "const style = {color:'red'}; function tag(_parts, value){return value} const alias = tag`${style}`; alias.color = 'blue';"
  ])("preserves unsupported target origins as unknown: %s", (source) => {
    transformSync(source, {
      configFile: false,
      babelrc: false,
      plugins: [
        (): PluginObj => ({
          visitor: {
            Program(program: NodePath<t.Program>) {
              const binding = program.scope.getBinding("style")!;
              const proof = analyzeAliasedStaticCssEvalBindingMutation(
                program,
                binding
              );
              expect(proof.kind).toBe("unknown");
              if (proof.kind === "unknown")
                expect(proof.reason).toBe("unsupported-origin");
              expect(hasStaticCssEvalBindingMutation(program, binding)).toBe(
                true
              );
              program.stop();
            }
          }
        })
      ]
    });
  });

  it.each([
    "const style={color:'red'}; const view=await {name:'view'}; console.log(view);",
    "const style={color:'red'}; function tag(){return {name:'view'}} const view=tag``; console.log(view);",
    "const style={color:'red'}; function tag(_parts,value){return value} const view=tag`${{name:'view'}}`; console.log(view);",
    "const style={color:'red'}; const view=await style.color; console.log(view);",
    "const style={color:'red'}; const view=`${style.color}`; console.log(view);"
  ])(
    "does not contaminate independent bindings with unknown origins: %s",
    (source) => {
      expect(hasMutation(source)).toBe(false);
    }
  );

  it.each(["@mincho-js/css", "@mincho-js/css/classname"])(
    "recognizes lexical cx imports from %s without trusting shadowed calls",
    (source) => {
      for (const declaration of [
        `import { cx as combine } from "${source}";`,
        `const { cx: combine } = require("${source}");`
      ]) {
        expect(
          hasMutation(
            `${declaration} const style = { color: "red" }; combine(style);`
          )
        ).toBe(false);
        expect(
          hasMutation(
            `${declaration} const style = externalValue(); function render(combine) { combine(style); }`
          )
        ).toBe(true);
      }
    }
  );

  it.each([
    'import { style } from "./tokens";',
    'import style from "./tokens";',
    'import * as style from "./tokens";'
  ])("tracks aliases of external values: %s", (declaration) => {
    expect(
      hasMutation(`${declaration} const alias = style; alias.color = "blue";`)
    ).toBe(true);
    expect(
      hasMutation(
        `${declaration} const alias = style; const color = alias.color;`
      )
    ).toBe(false);
  });

  it.each(mutations)("detects an alias write or escape: %s", (mutation) => {
    expect(
      hasMutation(
        `const style = { color: 'red', nested: { color: 'red' } }; ${mutation}`
      )
    ).toBe(true);
  });

  it.each([
    `const holder = { __proto__: { get nested() { return style; } }, set nested(value) {} }; unknownFunction(holder.nested);`,
    `const view = { get label() { return this.name; } }; console.log(view.label);`,
    `const view = { get label() { return (() => this.name)(); } }; console.log(view.label);`,
    `const proto = { get label() { return this.name; } }; const view = { __proto__: proto }; console.log(view.label);`,
    `const holder = { get nested() { return style; }, nested: {}, set nested(value) {} }; unknownFunction(holder.nested);`,
    `const holder = { get nested() { return style; }, ...{ nested: {} }, set nested(value) {} }; unknownFunction(holder.nested);`,
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
    `const copy = { __proto__: { nested: style }, nested: { color: 'blue' } }; copy.nested.color = 'green';`,
    `let color; ({ color } = style);`,
    `const holder = {}; ({ safe: holder.value } = { safe: {}, unused: style });`,
    `const holder = {}; [holder.value] = [{}, style];`,
    `const other = { nested: {} }; delete other.nested; const copy = { __proto__: { nested: style }, nested: { color: 'blue' } }; copy.nested.color = 'green';`,
    `const copy = { nested: { color: 'blue' }, __proto__: { nested: style } }; copy.nested.color = 'green';`,
    `const copy = { ...{ __proto__: { nested: style } } }; unknownFunction(copy);`,
    `const color = style.color; unknownFunction(color);`,
    `const { color } = style; unknownFunction(color);`,
    `Object.keys(style);`,
    `import { css as createCss } from '@mincho-js/css'; createCss(style);`,
    `import { style as createStyle } from '@vanilla-extract/css'; createStyle(style);`,
    `import * as vanilla from '@vanilla-extract/css'; vanilla.style(style);`,
    `import { recipe } from '@vanilla-extract/recipes'; recipe({ base: style });`,
    `import { defineProperties } from '@vanilla-extract/sprinkles'; defineProperties({ properties: { color: { red: style } } });`,
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

  it.each(["unknownFunction(holder);", 'holder.__proto__.color = "blue";'])(
    "retains the explicit prototype's possible alias identity: %s",
    (use) => {
      expect(
        hasMutation(
          `const style = { color: "red" }; const holder = { __proto__: style }; ${use}`
        )
      ).toBe(true);
    }
  );

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
  it.each([
    "function wrap(x){return ()=>x} const get=wrap(style); get().color='blue';",
    "function wrap(x){return {value:x}} const box=wrap(style); box.value.color='blue';",
    "function wrap(x){return [x]} const box=wrap(style); box[0].color='blue';",
    "function wrap(x){return {get value(){return x}}} const box=wrap(style); box.value.color='blue';",
    "class Box {value=style} new Box().value.color='blue';",
    "class Box {get value(){return style}} new Box().value.color='blue';",
    "function wrap(x){return {get(){return x}}} const box=wrap(style); box.get().color='blue';",
    "try{throw style}catch(x){x.color='blue'}"
  ])(
    "does not emit stale css across captured or unsupported sinks: %s",
    (effect) => {
      const { run, options } = cssTransform(
        "const style={color:'red'}; " + effect,
        "same-file"
      );
      expect(run).toThrow();
      expect(options.result[1]).toBe("");
    }
  );

  it("does not compile untrusted shared factory results as static rules", () => {
    const { run, options } = cssTransform(
      "const style = factory(); const alias = factory(); alias.color = 'blue';",
      "same-file"
    );
    const transformed = run();
    expect(options.result[1]).toBe("");
    expect(transformed?.code).toContain("factory()");
    expect(transformed?.code).toContain("alias.color = 'blue'");
    expect(transformed?.code).toMatch(/className=.*style/);
  });

  it("compiles a style beside an unrelated receiver-dependent getter", () => {
    const { run } = cssTransform(
      `const view = { get label() { return this.name; } }; console.log(view.label); const style = { color: 'red' };`,
      "same-file"
    );
    expect(run).not.toThrow();
  });
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

describe("expression result projection", () => {
  const inspect = (source: string) => {
    let proofs: string[] | undefined;
    transformSync(source, {
      configFile: false,
      babelrc: false,
      plugins: [
        () => ({
          visitor: {
            Program(program: NodePath<t.Program>) {
              const binding = program.scope.getBinding("style")!;
              if (!binding.path.isVariableDeclarator())
                throw new Error("declaration");
              const init = binding.path.get("init");
              if (!init.isLogicalExpression()) throw new Error("logical value");
              proofs = [
                analyzeAliasedStaticCssEvalBindingMutation(program, binding)
                  .kind,
                analyzeAliasedExpressionMutation(program, init.get("right"))
                  .kind
              ];
              program.stop();
            }
          }
        })
      ]
    });
    return proofs;
  };

  it("does not reinterpret an opaque falsy result as a primitive", () => {
    expect(
      inspect(
        `const shared = {color:'red'}; const style = document.all && shared;`
      )
    ).toEqual(["unknown", "proved-unmodified"]);
  });

  it.each([
    `const alias = shared; alias.color = 'blue';`,
    `const alias = style; alias.color = 'blue';`,
    `consume(shared);`,
    `const other = (shared.color = 'blue');`
  ])("retains whole-program alias and effect checks: %s", (effect) => {
    const result = inspect(
      `const shared = {color:'red'}; const style = document.all && shared; ${effect}`
    );
    expect(result?.[0]).toBe("unknown");
    expect(result?.[1]).not.toBe("proved-unmodified");
  });

  it("retains effects evaluated in the left condition", () => {
    expect(
      inspect(
        `const shared = {color:'red'}; const style = (shared.color = 'blue', document.all) && shared;`
      )
    ).toEqual(["unknown", "may-mutate"]);
  });
});

describe("source-verified closed own allocation receipts", () => {
  const inspect = (source: string, receipt = true) => {
    let kind: string | undefined;
    transformSync(source, {
      configFile: false,
      babelrc: false,
      plugins: [
        () => ({
          visitor: {
            Program(program: NodePath<t.Program>) {
              kind = analyzeAliasedStaticCssEvalBindingMutation(
                program,
                program.scope.getBinding("style")!,
                {
                  callResultProof(call) {
                    if (
                      !receipt ||
                      !call.get("callee").isIdentifier({ name: "make" })
                    )
                      return;
                    return {
                      kind: "closed-own-allocation",
                      identity: call.node,
                      shape: {
                        kind: "object",
                        properties: {
                          value: {
                            kind: "object",
                            properties: { color: { kind: "primitive" } }
                          },
                          fn: { kind: "function" },
                          ...(source.includes(".unresolved")
                            ? { unresolved: undefined }
                            : {})
                        }
                      }
                    };
                  }
                }
              ).kind;
              program.stop();
            }
          }
        })
      ]
    });
    return kind;
  };
  it("keeps exact own reads separate from a different fresh invocation", () => {
    expect(
      inspect(`const style = make().value; make().value.color = 'blue';`)
    ).toBe("proved-unmodified");
    expect(inspect(`const style = make().value;`, false)).toBe("unknown");
  });
  it("preserves alias writes through own descendants", () => {
    expect(
      inspect(
        `const owner = make(); const style = owner.value; owner.value.color = 'blue';`
      )
    ).toBe("may-mutate");
  });
  it.each([
    "constructor",
    "__proto__",
    "missing",
    "unresolved",
    "fn.prototype",
    "fn.constructor"
  ])("never grants inherited result authority: %s", (member) => {
    expect(inspect(`const style = make().${member};`)).toBe("unknown");
  });
  it("does not equate dynamic reads with internal own enumeration", () => {
    expect(inspect(`const style = make()[key];`)).toBe("unknown");
  });
  it("does not authorize invocation effects", () => {
    expect(inspect(`const style = make(); style.fn();`)).toBe("may-mutate");
  });
});

describe("validated primitive module members", () => {
  const inspect = (source: string, primitive = true) => {
    let kind: string | undefined;
    transformSync(source, {
      configFile: false,
      babelrc: false,
      plugins: [
        () => ({
          visitor: {
            Program(program: NodePath<t.Program>) {
              const identity = {};
              kind = analyzeAliasedStaticCssEvalBindingMutation(
                program,
                program.scope.getBinding("style")!,
                {
                  moduleOriginIdentity: identity,
                  callResultProof(call) {
                    if (!call.get("callee").isIdentifier({ name: "require" }))
                      return;
                    return {
                      kind: "module-origin",
                      identity,
                      primitivePaths: primitive ? [["unrelated"]] : []
                    };
                  }
                }
              ).kind;
              program.stop();
            }
          }
        })
      ]
    });
    return kind;
  };
  it("does not confuse a validated primitive with the shared module objects", () => {
    const source = `const style = require('factory').defineStyle; const {unrelated} = require('helper'); [unrelated].join(' ');`;
    expect(inspect(source)).toBe("proved-unmodified");
    expect(inspect(source, false)).toBe("may-mutate");
  });
  it.each([
    `require('forwarder').defineStyle.color = 'blue';`,
    `import {defineStyle as alias} from 'factory'; alias.color = 'blue';`,
    `require('helper')[dynamicKey].color = 'blue';`
  ])("keeps object and unknown aliases shared: %s", (mutation) => {
    expect(
      inspect(`const style = require('factory').defineStyle; ${mutation}`)
    ).toBe("may-mutate");
  });
});
