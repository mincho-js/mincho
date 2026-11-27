import { runInNewContext } from "node:vm";
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
import { planEvaluation } from "../../extractionCalls/evaluation.js";
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

function cssTransform(styles: string, kind: string, typed = false) {
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
        parserOpts: { plugins: typed ? ["jsx", "typescript"] : ["jsx"] },
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

  const returnedSetter = `const wrap = rule => ({ rule, set paint(value) { this.rule.color = value; } });
    const holder = wrap(style);`;
  const returnedMethod = `const wrap = rule => ({ paint() { rule.color = "blue"; } });
    const holder = wrap(style);`;
  const nestedMethod = `const wrap = rule => ({
    expose() { return rule; },
    paint() { this.expose().color = "blue"; }
  }); const holder = wrap(style);`;
  const computedSetter = `const wrap = rule => ({ set paint(value) { rule.color = value; } });
    const holder = wrap(style);`;
  const returnedDefault = `const make = rule => (target = rule) => { target.color = "blue"; };
    const paint = make(style);`;
  const getterReturnsCallable = `const make = rule => ({
    get paint() { return () => { rule.color = "blue"; }; }
  }); const holder = make(style);`;
  const defaultRule = `function read(value = style) { return value; }`;

  it.each([
    ["selected own setter", returnedSetter + `holder.paint = "blue";`, true],
    ["uninvoked own setter", returnedSetter, false],
    [
      "own setter deleted immediately before assignment",
      returnedSetter + `delete holder.paint; holder.paint = "blue";`,
      false
    ],
    [
      "own setter deleted after assignment",
      returnedSetter + `holder.paint = "blue"; delete holder.paint;`,
      true
    ],
    [
      "unrelated selected setter",
      `const wrap = rule => ({ rule, set paint(value) { this.rule.color = value; } });
      const holder = wrap({color:"green"}); holder.paint = "blue";`,
      false
    ],
    [
      "own method deleted only after its invocation",
      returnedMethod + `holder.paint(); delete holder.paint;`,
      true
    ],
    [
      "deletion without invocation",
      returnedMethod + `delete holder.paint;`,
      false
    ],
    [
      "selected method resolves its own receiver",
      nestedMethod + `holder.paint();`,
      true
    ],
    ["uninvoked nested method", nestedMethod, false],
    [
      "nested method result read without a write",
      nestedMethod + `holder.expose();`,
      false
    ],
    [
      "unknown own setter key",
      computedSetter + `const key = supplied; holder[key] = "blue";`,
      true
    ],
    [
      "known unrelated own key",
      computedSetter + `const key = "other"; holder[key] = "blue";`,
      false
    ],
    [
      "method selected by a bound computed key",
      returnedMethod + `const key = "paint"; holder[key]();`,
      true
    ],
    [
      "method possibly selected by an unknown key",
      returnedMethod + `const key = supplied; holder[key]();`,
      true
    ],
    [
      "known unrelated computed method",
      `const wrap = rule => ({ ready() {}, paint() { rule.color = "blue"; } });
       const holder = wrap(style); const key = "ready"; holder[key]();`,
      false
    ],
    [
      "computed method in an unexecuted branch",
      returnedMethod + `const key = supplied; false && holder[key]();`,
      false
    ],
    [
      "selected own function value",
      `const wrap = rule => ({ paint: () => { rule.color = "blue"; } });
       const holder = wrap(style); holder.paint();`,
      true
    ],
    [
      "uninvoked own function value",
      `const wrap = rule => ({ paint: () => { rule.color = "blue"; } });
       const holder = wrap(style);`,
      false
    ],
    [
      "invoked lexical helper in the captured method",
      `const wrap = rule => ({ paint() {
         function apply() { rule.color = "blue"; }
         apply();
       } }); const holder = wrap(style); holder.paint();`,
      true
    ],
    [
      "unreachable lexical helper in the captured method",
      `const wrap = rule => ({ paint() {
         function apply() { rule.color = "blue"; }
         false && apply();
       } }); const holder = wrap(style); holder.paint();`,
      false
    ],
    [
      "invoked unrelated lexical helper in the captured method",
      `const wrap = rule => ({ paint() {
         function apply() { const own = { color: "green" }; own.color = "blue"; }
         apply();
       } }); const holder = wrap(style); holder.paint();`,
      false
    ],
    [
      "invoked lexical helper with a dead write",
      `const wrap = rule => ({ paint() {
         function apply() { if (false) rule.color = "blue"; }
         apply();
       } }); const holder = wrap(style); holder.paint();`,
      false
    ],
    [
      "invoked read-only lexical helper with a plain parameter",
      `const wrap = rule => ({ paint() {
         function observe(flag) { return flag ? rule.color : "none"; }
         observe(true);
       } }); const holder = wrap(style); holder.paint();`,
      false
    ],
    [
      "selected generator function value without resumption",
      `const wrap = rule => ({ paint: function* () { rule.color = "blue"; } });
       const holder = wrap(style); holder.paint();`,
      false
    ],
    ["selected returned default", returnedDefault + "paint();", true],
    [
      "explicit undefined returned default",
      returnedDefault + "paint(undefined);",
      true
    ],
    [
      "defined fresh argument to returned callable",
      returnedDefault + "paint({});",
      false
    ],
    ["uninvoked returned default", returnedDefault, false],
    [
      "invoked conditional capture with a possible write",
      `const make = rule => () => { rule.color = "blue"; };
       const paint = globalThis.active ? make(style) : () => {}; paint();`,
      true
    ],
    [
      "invoked conditional capture with a selected write",
      `const make = rule => () => { rule.color = "blue"; };
       const paint = true ? make(style) : () => {}; const run = paint; run();`,
      true
    ],
    [
      "invoked conditional capture with a dead write",
      `const make = rule => () => { rule.color = "blue"; };
       const paint = false ? make(style) : () => {}; paint();`,
      false
    ],
    [
      "uninvoked conditional capture",
      `const make = rule => () => { rule.color = "blue"; };
       const paint = globalThis.active ? make(style) : () => {};`,
      false
    ],
    [
      "invoked conditional with an unrelated capture",
      `const other = { color: "green" };
       const make = rule => () => { rule.color = "blue"; };
       const paint = globalThis.active ? make(other) : () => {}; paint();`,
      false
    ],
    [
      "returned callback reads the replacement parameter",
      `const make = rule => target => {target = rule; target.color = "blue";};
       const paint = make(style); paint({});`,
      true
    ],
    [
      "returned callback may read the replacement parameter",
      `const make = rule => target => {if (globalThis.active) target = rule; target.color = "blue";};
       const paint = make(style); paint({});`,
      true
    ],
    [
      "invoked nested callback reads later outer assignment",
      `const make = rule => target => {
         const apply = () => (target.color = "blue");
         target = rule; apply();
       }; const paint = make(style); paint({});`,
      true
    ],
    [
      "write before replacing a fresh parameter",
      `const make = rule => target => {target.color = "blue"; target = rule;};
       const paint = make(style); paint({});`,
      false
    ],
    [
      "known fresh replacement kills the previous parameter alias",
      `const make = rule => target => {target = rule; target = {}; target.color = "blue";};
       const paint = make(style); paint({});`,
      false
    ],
    [
      "uninvoked callback with replacement parameter",
      `const make = rule => target => {target = rule; target.color = "blue";};
       const paint = make(style);`,
      false
    ],
    [
      "local construction in the selected frame",
      `const make = rule => ({paint() {
        function Apply() {rule.color = "blue";} new Apply();
       }}); make(style).paint();`,
      true
    ],
    [
      "uninvoked local constructor",
      `const make = rule => ({paint() {
        function Apply() {rule.color = "blue";}
       }}); make(style).paint();`,
      false
    ],
    [
      "unrelated local construction in the selected frame",
      `const make = rule => ({paint() {
        function Apply() {const local = {color:rule.color}; local.color = "blue";}
        new Apply();
       }}); make(style).paint();`,
      false
    ],
    ["invoked getter result", getterReturnsCallable + "holder.paint();", true],
    ["getter lookup alone", getterReturnsCallable + "holder.paint;", false],
    ["unread returned getter", getterReturnsCallable, false],
    ["fresh defined argument", defaultRule + `read({}).color = "blue";`, false],
    ["omitted argument", defaultRule + `read().color = "blue";`, true],
    [
      "undefined argument",
      defaultRule + `read(undefined).color = "blue";`,
      true
    ]
  ] as const)(
    "keeps the actual rule origin for %s",
    (_name, effect, mutated) => {
      const { run, options } = cssTransform(
        `const style = { color: "red" }; ${effect}`,
        "same-file"
      );
      if (mutated) {
        expect(run).toThrow(/binding "style".*mutated/);
        expect(options.result[1]).toBe("");
      } else {
        const app = run();
        expect(app?.code).toContain("className");
        expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
        expect(options.result[1]).not.toContain("blue");
      }
    }
  );

  it.each([
    [
      "abstract equality uses a non-null primitive on the right",
      'const wrap = rule => ({valueOf(){rule.color = "blue"; return 1;}}); wrap(style) == 1;',
      true
    ],
    [
      "abstract inequality uses a non-null primitive on the left",
      'const wrap = rule => ({valueOf(){rule.color = "blue"; return 1;}}); 1 != wrap(style);',
      true
    ],
    [
      "abstract equality against nullish does not coerce",
      'const wrap = rule => ({valueOf(){rule.color = "blue"; return 1;}}); wrap(style) == null;',
      false
    ],
    [
      "numeric coercion follows the binary evaluation plan",
      'const wrap = rule => ({valueOf(){rule.color = "blue"; return 1;}}); wrap(style) * 2;',
      true
    ],
    [
      "strict equality does not coerce",
      'const wrap = rule => ({valueOf(){rule.color = "blue"; return 1;}}); wrap(style) === 2;',
      false
    ],
    [
      "abstract equality between two objects does not coerce",
      'const wrap = rule => ({valueOf(){rule.color = "blue"; return 1;}}); wrap(style) == {};',
      false
    ],
    [
      "default conversion of the right operand of addition",
      'const wrap = rule => ({toString(){rule.color = "blue"; return "";}}); "" + wrap(style);',
      true
    ],
    [
      "default conversion of the left operand of addition",
      'const wrap = rule => ({valueOf(){rule.color = "blue"; return 0;}}); wrap(style) + 1;',
      true
    ],
    [
      "addition of primitives does not invoke the dormant object converter",
      'const wrap = rule => ({toString(){rule.color = "blue"; return "";}}); const held = wrap(style); "" + "value";',
      false
    ],
    [
      "addition invokes only the unrelated object converter",
      'const wrap = rule => ({toString(){rule.color = "blue"; return "";}}); "" + wrap({});',
      false
    ],
    [
      "addition in an unselected branch does not invoke the converter",
      'const wrap = rule => ({toString(){rule.color = "blue"; return "";}}); false && ("" + wrap(style));',
      false
    ],
    ["indirect invocation", "make(style).call(null);", true],
    ["dormant closure", "const paint = make(style);", false],
    [
      "store before invocation",
      "const holder = {run(){}}; holder.run = make(style); holder.run();",
      true
    ],
    [
      "assignment pattern stores a closure before the selected call",
      "const holder = {run(){}}; [holder.run] = [make(style)]; holder.run();",
      true
    ],
    [
      "call precedes assignment pattern",
      "const holder = {run(){}}; holder.run(); [holder.run] = [make(style)];",
      false
    ],
    [
      "assignment pattern keeps the selected destination distinct",
      "const holder = {run(){}, other(){}}; [holder.run, holder.other] = [make({}), make(style)]; holder.run();",
      false
    ],
    [
      "invocation before store",
      "const holder = {run(){}}; holder.run(); holder.run = make(style);",
      false
    ],
    [
      "interpolation",
      'const wrap = rule => ({toString(){rule.color = "blue"; return "";}}); `${wrap(style)}`;',
      true
    ],
    [
      "unknown consumer of the returned wrapper",
      'const wrap = rule => ({toString(){rule.color = "blue"; return "";}}); String(wrap(style));',
      true
    ],
    [
      "coercion of an unrelated method holder",
      'const wrap = rule => ({paint(){rule.color = "blue";}}); `${wrap(style)}`;',
      false
    ],
    [
      "object construction without coercion",
      'const wrap = rule => ({toString(){rule.color = "blue"; return "";}}); const held = wrap(style);',
      false
    ],
    ...["+", "-", "~"].map(
      (operator) =>
        [
          "numeric observation " + operator,
          `const wrap = rule => ({valueOf(){rule.color = "blue"; return 0;}}); ${operator}wrap(style);`,
          true
        ] as const
    ),
    [
      "numeric conversion of a primitive",
      'const wrap = rule => ({valueOf(){rule.color = "blue"; return 0;}}); const held = wrap(style); +1;',
      false
    ]
  ] as const)("requires a stable rule for %s", (_name, effect, unknown) => {
    const { run, options } = cssTransform(
      `const style = {color: "red"};
       const make = rule => () => {rule.color = "blue";};
       ${effect}`,
      "same-file"
    );
    if (unknown) {
      expect(run).toThrow(/same-file binding "style".*unproven object origin/);
      expect(options.result[1]).toBe("");
    } else {
      expect(run()?.code).toContain("className");
      expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
      expect(options.result[1]).not.toContain("blue");
    }
  });

  it.each([
    [
      "lexically stored closure is invoked",
      "let paint; paint = make(style); paint();",
      true
    ],
    [
      "lexical closure store is dormant",
      "let paint; paint = make(style);",
      false
    ],
    [
      "unrelated lexical closure is invoked",
      "let paint; paint = make({}); paint();",
      false
    ],
    [
      "lexical closure writes after the call",
      "let paint = () => {}; paint(); paint = make(style);",
      false
    ],
    [
      "lexical closure is overwritten before the call",
      "let paint = make(style); paint = () => {}; paint();",
      false
    ],
    [
      "lexically stored closure is called before a later overwrite",
      "let paint; paint = make(style); paint(); paint = () => {};",
      true
    ],
    [
      "immutable alias reads the lexical callable before reassignment",
      "let paint; paint = make(style); const captured = paint; paint = () => {}; captured();",
      true
    ],
    [
      "earlier var write cannot replace the later initializer",
      "paint = () => {}; var paint = make(style); paint();",
      true
    ]
  ] as const)(
    "uses the callable at the selected lexical read: %s",
    (_name, effect, mutated) => {
      const { run, options } = cssTransform(
        `const style = {color: "red"};
       const make = rule => () => {rule.color = "blue";};
       ${effect}`,
        "same-file"
      );
      if (mutated) {
        expect(run).toThrow(/same-file binding "style".*is mutated/);
        expect(options.result[1]).toBe("");
      } else {
        expect(run()?.code).toContain("className");
        expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
        expect(options.result[1]).not.toContain("blue");
      }
    }
  );

  const primitiveHook =
    'const make = rule => () => { rule.color = "blue"; return 1; };';
  const ownHook =
    'const input = { [Symbol.toPrimitive]: make(style), valueOf(){return 0;}, toString(){return "0";} };';
  it.each([
    [
      "coerces through the stored own hook",
      primitiveHook + ownHook + "+input;",
      true
    ],
    [
      "the selected getter hook returns a captured callable",
      'const make = rule => ({ get [Symbol.toPrimitive]() { return () => { rule.color = "blue"; return 1; }; }, valueOf(){return 0;}, toString(){return "0";} }); +make(style);',
      true
    ],
    ["the own hook is stored but not invoked", primitiveHook + ownHook, false],
    [
      "the own hook is only a reader",
      "const make = rule => () => rule.color.length;" + ownHook + "+input;",
      false
    ],
    [
      "a shadowed Symbol does not define the runtime hook",
      'const Symbol = {toPrimitive:"ordinary"};' +
        primitiveHook +
        ownHook +
        "+input;",
      false
    ],
    [
      "coercion invokes a hook for another allocation",
      primitiveHook + ownHook.replace("make(style)", "make({})") + "+input;",
      false
    ],
    [
      "the live callback evaluates its computed method key",
      'const make = rule => () => { ({ [rule.color = "blue"]() {} }); }; make(style)();',
      true
    ],
    [
      "the callback leaves its nested method body deferred",
      'const make = rule => () => { ({ method() { rule.color = "blue"; } }); }; make(style)();',
      false
    ],
    [
      "the callback leaves computed method parameter defaults deferred",
      'const make = rule => () => { ({ ["name"](value = (rule.color = "blue")) {} }); }; make(style)();',
      false
    ],
    [
      "the same computed key remains deferred when the callback is uninvoked",
      'const make = rule => () => { ({ [rule.color = "blue"]() {} }); }; const held = make(style);',
      false
    ]
  ] as const)(
    "observes only eager effects in the selected frame: %s",
    (_name, effect, mutated) => {
      const { run, options } = cssTransform(
        `const style = {color: "red"}; ${effect}`,
        "same-file"
      );
      if (mutated) {
        expect(run).toThrow(/same-file binding "style".*mutated/);
        expect(options.result[1]).toBe("");
      } else {
        expect(run()?.code).toContain("className");
        expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
        expect(options.result[1]).not.toContain("blue");
      }
    }
  );

  describe("eager own property key conversion", () => {
    const factory =
      'const wrap = rule => ({ toString() { trace.push("key"); rule.color = "blue"; return "name"; } });';

    it("uses the ordered conversion phase from the shared evaluation plan", () => {
      const plans: Record<string, Array<string>> = {};
      transformSync("({[x]: y, [x]() { z() }}); x in y;", {
        configFile: false,
        babelrc: false,
        plugins: [
          () => ({
            visitor: {
              "ObjectProperty|ObjectMethod|BinaryExpression"(
                path: NodePath<t.Node>
              ) {
                plans[path.type] = planEvaluation(path).steps.map((step) =>
                  step.kind === "evaluate"
                    ? `eval:${step.operand.path.key}`
                    : step.kind === "coerce"
                      ? `coerce:${step.path.key}:after:${step.propertyKey?.after.key}`
                      : step.kind
                );
              }
            }
          })
        ]
      });
      expect(plans).toEqual({
        ObjectProperty: ["eval:key", "coerce:key:after:key", "eval:value"],
        ObjectMethod: ["eval:key", "coerce:key:after:key"],
        BinaryExpression: [
          "eval:left",
          "eval:right",
          "coerce:left:after:right",
          "observe"
        ]
      });
    });

    it.each([
      [
        "object data key before the value",
        '({ [wrap(style)]: trace.push("value") });',
        ["key", "value"],
        true
      ],
      [
        "computed method key, not the method body",
        '({ [wrap(style)]() { trace.push("body"); } });',
        ["key"],
        true
      ],
      [
        "computed key in an actually invoked callback",
        "const make = rule => () => { ({ [wrap(rule)]() {} }); }; make(style)();",
        ["key"],
        true
      ],
      [
        "an inline selected key method uses the active caller capture",
        'const make = rule => () => { ({ [{ toString() { trace.push("key"); rule.color = "blue"; return "name"; } }]: 1 }); }; make(style)();',
        ["key"],
        true
      ],
      [
        "an inline method in a dormant caller does not capture eagerly",
        'const make = rule => () => { ({ [{ toString() { rule.color = "blue"; return "name"; } }]: 1 }); }; const held = make(style);',
        [],
        false
      ],
      [
        "the inline object stored as data is not a selected key method",
        'const make = rule => () => { ({ name: { toString() { rule.color = "blue"; return "name"; } } }); }; make(style)();',
        [],
        false
      ],
      [
        "in converts its left value only after the right has evaluated",
        'wrap(style) in (trace.push("rhs"), { name: 1 });',
        ["rhs", "key"],
        true
      ],
      [
        "in does not convert a key when the right is not an object",
        'try { wrap(style) in null; } catch { trace.push("caught"); }',
        ["caught"],
        false
      ],
      ["named value store", "({ name: wrap(style) });", [], false],
      [
        "computed primitive key store",
        '({ ["name"]: wrap(style) });',
        [],
        false
      ],
      [
        "in only observes the object on the right",
        '"name" in wrap(style);',
        [],
        false
      ],
      ["dead key", "false && ({ [wrap(style)]: 1 });", [], false],
      ["unrelated captured rule", "({ [wrap({})]: 1 });", ["key"], false],
      [
        "a definitely selected string hook leaves the numeric hook dormant",
        '({ [{ toString() { return "name"; }, valueOf: wrapValue(style) }]: 1 });',
        [],
        false
      ],
      [
        "an object result continues to the numeric hook",
        "({ [{ toString() { return {}; }, valueOf: wrapValue(style) }]: 1 });",
        ["fallback"],
        true
      ]
    ] as const)("%s", (_name, operation, order, unsafe) => {
      const source = `
        const style = { color: "red" };
        const trace = [];
        const wrapValue = rule => () => {
          trace.push("fallback"); rule.color = "blue"; return 1;
        };
        ${factory}
        ${operation}
      `;
      expect(runInNewContext(`${source}; [style.color, trace];`)).toEqual([
        unsafe ? "blue" : "red",
        [...order]
      ]);
      const { run, options } = cssTransform(source, "same-file");
      if (unsafe) {
        expect(run).toThrow(
          /same-file binding "style".*(mutated|unproven object origin)/
        );
        expect(options.result[1]).toBe("");
      } else {
        expect(run()?.code).toContain("className");
        expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
      }
    });
  });

  it.each([
    ["selected", "h.paint()", "style", "blue", ["paint"]],
    ["dormant", "void h", "style", "red", []],
    ["unrelated", "h.paint()", "{}", "red", ["paint"]]
  ] as const)(
    "uses the active frame for a %s function-local own method",
    (_kind, call, input, color, trace) => {
      const source = `
        const style = { color: "red" };
        const trace = [];
        const make = rule => () => {
          const h = { paint() { trace.push("paint"); rule.color = "blue"; } };
          ${call};
        };
        make(${input})();
      `;
      expect(runInNewContext(`${source} [style.color, trace];`)).toEqual([
        color,
        [...trace]
      ]);
      const { run, options } = cssTransform(source, "same-file");
      if (color === "blue") {
        expect(run).toThrow(/same-file binding "style".*mutated/);
        expect(options.result[1]).toBe("");
      } else {
        expect(run()?.code).toContain("className");
        expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
      }
    }
  );

  describe("ordered consumption of captured style values", () => {
    const callback =
      'const make = rule => () => { trace.push("call"); rule.color = "blue"; };';
    const key =
      'const wrap = rule => ({ toString() { trace.push("convert"); rule.color = "blue"; return "name"; } });';
    const iterator =
      'const make = rule => () => { trace.push("iterator"); rule.color = "blue"; return [][Symbol.iterator](); };';

    it("separates read, write formation, iteration and yielded operands in the plan", () => {
      const phases: unknown[] = [];
      transformSync(
        "obj[key]; obj[key] = rhs(); [...iterable]; (prefix(), final());",
        {
          configFile: false,
          babelrc: false,
          plugins: [
            () => ({
              visitor: {
                "MemberExpression|SpreadElement|SequenceExpression"(
                  path: NodePath<t.Node>
                ) {
                  const plan = planEvaluation(path);
                  phases.push({
                    key: plan.steps.some(
                      (step) =>
                        step.kind === "coerce" && !!step.propertyKey?.receiver
                    ),
                    iteration:
                      plan.steps.at(-1)?.kind === "observe" &&
                      plan.steps.some(
                        (step) =>
                          step.kind === "observe" &&
                          step.sourceDelivery?.after.key === "argument"
                      ),
                    yielded:
                      plan.result.kind === "operand"
                        ? plan.result.paths.map((value) => value.key)
                        : []
                  });
                }
              }
            })
          ]
        }
      );
      expect(phases).toEqual([
        { key: true, iteration: false, yielded: [] },
        { key: false, iteration: false, yielded: [] },
        { key: false, iteration: true, yielded: [] },
        { key: false, iteration: false, yielded: [1] }
      ]);
    });

    it.each([
      [
        "sequence's selected callable",
        callback + 'const run = (trace.push("prefix"), make(style)); run();',
        ["prefix", "call"],
        true
      ],
      [
        "sequence callable is dormant until invocation",
        callback + 'const run = (trace.push("prefix"), make(style));',
        ["prefix"],
        false
      ],
      [
        "member reads convert after evaluating the key",
        key +
          'const holder = { name: 1 }; holder[(trace.push("key"), wrap(style))];',
        ["key", "convert"],
        true
      ],
      [
        "optional present member converts",
        key + "const holder = { name: 1 }; holder?.[wrap(style)];",
        ["convert"],
        true
      ],
      [
        "optional nullish member skips the key expression",
        key +
          'const holder = null; holder?.[(trace.push("key"), wrap(style))];',
        [],
        false
      ],
      [
        "nullish ordinary read evaluates the key but does not convert",
        key +
          'const holder = null; try { holder[(trace.push("key"), wrap(style))]; } catch { trace.push("caught"); }',
        ["key", "caught"],
        false
      ],
      [
        "literal key has nothing to convert",
        key + 'const holder = { name: 1 }; holder["name"];',
        [],
        false
      ],
      [
        "only the selected key holder is observed",
        key + "const holder = { name: 1 }; holder[wrap({})];",
        ["convert"],
        false
      ],
      [
        "array spread consumes the stored iterator",
        iterator +
          "const iterable = { [Symbol.iterator]: make(style) }; [...iterable];",
        ["iterator"],
        true
      ],
      [
        "storing an iterator is not consumption",
        iterator + "const iterable = { [Symbol.iterator]: make(style) };",
        [],
        false
      ],
      [
        "dead spread does not consume an iterator",
        iterator +
          "const iterable = { [Symbol.iterator]: make(style) }; false && [...iterable];",
        [],
        false
      ],
      [
        "unrelated iterator capture",
        iterator +
          "const iterable = { [Symbol.iterator]: make({}) }; [...iterable];",
        ["iterator"],
        false
      ]
    ] as const)("%s", (_label, effect, order, unsafe) => {
      const source = `const style = { color: "red" }; const trace = []; ${effect}`;
      expect(runInNewContext(`${source}; [style.color, trace];`)).toEqual([
        unsafe ? "blue" : "red",
        [...order]
      ]);
      const { run, options } = cssTransform(source, "same-file");
      if (unsafe) {
        expect(run).toThrow(
          /same-file binding "style".*(mutated|unproven object origin)/
        );
        expect(options.result[1]).toBe("");
      } else {
        expect(run()?.code).toContain("className");
        expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
      }
    });
  });

  describe("selected synchronous iteration and logical calls", () => {
    const closure =
      'const make = rule => () => { trace.push("call"); rule.color = "blue"; };';
    const iterator =
      'const make = rule => () => { trace.push("iterator"); rule.color = "blue"; return [][Symbol.iterator](); };';
    const inert =
      "const iterable = { [Symbol.iterator]: () => [][Symbol.iterator]() };";
    const store = "iterable[Symbol.iterator] = make(style);";
    const captured = "const iterable = { [Symbol.iterator]: make(style) };";
    const returnedArray =
      'const make = rule => [() => { trace.push("call"); rule.color = "blue"; }, () => trace.push("other")];';
    const returnedObject =
      'const make = rule => ({ get label() { trace.push("getter"); rule.color = "blue"; return "x"; }, data: 1 });';
    const coercible =
      'const make = rule => ({ valueOf() { trace.push("coerce"); rule.color = "blue"; return 1; } });';

    const setter =
      'const make = rule => ({ set paint(value = rule) { trace.push("setter"); value.color = "blue"; } }); const holder = make(style);';
    const consume = "const consume = () => [...iterable];";
    const paired = (value: string, rhs: string) =>
      `const make = rule => ({ get paint() { return ${value}; }, set paint(value = rule) { trace.push("setter"); value.color = "blue"; } }); const holder = make(style); holder.paint ??= ${rhs};`;

    const key =
      'const makeKey = rule => ({ toString() { trace.push("key"); rule.color = "blue"; return "entry"; } }); const holder = { entry: 1 };';

    it.each([
      [
        "holder[key] = rhs();",
        ["eval:left", "eval:right", "key:right", "observe"]
      ],
      [
        "holder[key] += rhs();",
        [
          "eval:left",
          "key:property",
          "observe",
          "eval:right",
          "convert:default:left:right",
          "convert:default:right:right",
          "key:right",
          "observe"
        ]
      ],
      [
        "box.value++;",
        [
          "eval:argument",
          "observe",
          "convert:number:argument:argument",
          "observe"
        ]
      ],
      ["[value] = iterable;", ["eval:right", "iterate:right"]],
      ["const [value] = iterable;", ["eval:init", "iterate:init", "eval:id"]]
    ] as const)(
      "plans the selected operation in native order: %s",
      (source, expected) => {
        let seen: string[] | undefined;
        const capture = (path: NodePath) => {
          seen = planEvaluation(path).steps.map((step) => {
            if (step.kind === "evaluate")
              return `eval:${step.operand.path.key}`;
            if (step.kind === "coerce")
              return step.valueConversion
                ? `convert:${step.valueConversion.hint}:${step.path.key}:${step.valueConversion.after.key}`
                : `key:${step.propertyKey?.after.key}`;
            if (step.kind === "observe" && step.sourceDelivery)
              return `iterate:${step.sourceDelivery.after.key}`;
            return step.kind;
          });
        };
        transformSync(source, {
          configFile: false,
          babelrc: false,
          plugins: [
            () => ({
              visitor: {
                AssignmentExpression: capture,
                UpdateExpression: capture,
                VariableDeclarator: capture
              }
            })
          ]
        });
        expect(seen).toEqual([...expected]);
      }
    );

    it.each([
      ["export const paint = make(style);", true],
      ["const paint = make(style); export { paint };", true],
      ["export default make(style);", true],
      ["const paint = make(style);", false],
      ['export const paint = make({ color: "green" });', false]
    ] as const)(
      "checks only an escaping callback's relevant capture: %s",
      (declaration, unsafe) => {
        const source = `const style = { color: "red" }; const trace = []; ${closure} ${declaration}`;
        const { run, options } = cssTransform(source, "same-file");
        if (unsafe) {
          expect(run).toThrow(
            /same-file binding "style".*unproven object origin/
          );
          expect(options.result[1]).toBe("");
        } else {
          expect(run()?.code).toContain("className");
          expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
        }
      }
    );

    it.each([
      ['pick(input).color = "blue";', true],
      ["const retained = input;", false],
      ['pick([{}]).color = "blue";', false],
      ['pick([style]).color = "blue";', true]
    ] as const)(
      "uses actual parameter delivery for returned aliases: %s",
      (use, mutates) => {
        const source = `const style={color:"red"};
        const wrap=rule=>()=>{let done=false; return {
          next:()=> done ? {done:true} : (done=true,{value:rule,done:false})
        };};
        const input={[Symbol.iterator]:wrap(style),0:{}};
        function pick([value]) { return value; }
        ${use}`;
        expect(runInNewContext(`${source}; style.color`)).toBe(
          mutates ? "blue" : "red"
        );
        const { run, options } = cssTransform(source, "same-file");
        if (mutates) {
          expect(run).toThrow(
            /same-file binding "style".*(mutated|unproven object origin)/
          );
          expect(options.result[1]).toBe("");
        } else {
          expect(run()?.code).toContain("className");
          expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
        }
      }
    );

    it("does not revisit a rule producer for each ordinary export alias", () => {
      const source =
        "const f0 = () => ({ color: 'red' });" +
        Array.from(
          { length: 10 },
          (_, index) =>
            `const f${index + 1} = () => flag ? f${index}() : f${index}();`
        ).join("") +
        "const style = f10(); export { style, style as first, style as second };";
      expect(hasMutation(source)).toBe(false);
    });

    it("uses one synchronous iteration plan step for RHS before the loop body", () => {
      let seen: string[] | undefined;
      transformSync("for (const item of iterable) body(item);", {
        configFile: false,
        babelrc: false,
        plugins: [
          () => ({
            visitor: {
              ForOfStatement(path: NodePath<t.ForOfStatement>) {
                seen = planEvaluation(path).steps.map((step) =>
                  step.kind === "observe"
                    ? `iteration:${step.sourceDelivery?.after.key}`
                    : step.kind === "evaluate"
                      ? `eval:${step.operand.path.key}:${step.operand.execution}`
                      : step.kind
                );
              }
            }
          })
        ]
      });
      expect(seen).toEqual([
        "eval:right:eager",
        "iteration:right",
        "eval:left:possible",
        "eval:body:possible"
      ]);
    });

    it.each([
      ["for await (const value of iterable) {}", ["async-iterator"], true],
      ["const retained = iterable;", [], false]
    ] as const)(
      "an async iterator only enters the live delivery trace: %s",
      async (observation, trace, unsafe) => {
        const source = `const style = { color: "red" }; const trace = [];
        const make = rule => () => { trace.push("async-iterator"); rule.color = "blue";
          return { next: async () => ({done: true}) }; };
        const iterable = { [Symbol.asyncIterator]: make(style) }; ${observation}`;
        const output = await runInNewContext(
          `(async () => { ${source}; return [style.color, trace]; })()`
        );
        expect(output).toEqual([unsafe ? "blue" : "red", [...trace]]);
        const { run, options } = cssTransform(source, "same-file");
        if (unsafe) {
          expect(run).toThrow(
            /same-file binding "style".*unproven object origin/
          );
          expect(options.result[1]).toBe("");
        } else {
          expect(run()?.code).toContain("className");
          expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
        }
      }
    );

    it.each([
      [
        "a computed binding key converts after receiving its object",
        key +
          'const { [makeKey(style)]: ignored } = (trace.push("rhs"), holder);',
        ["rhs", "key"],
        true
      ],
      [
        "a literal object binding does not consume a dormant computed key",
        key + "const idle = makeKey(style); const {entry: ignored} = holder;",
        [],
        false
      ],
      [
        "native delivery of undefined selects the existing setter default",
        setter + "for (holder.paint of [undefined]) {}",
        ["setter"],
        true
      ],
      [
        "native delivery of a fresh value bypasses the setter default",
        setter + "for (holder.paint of [{}]) {}",
        ["setter"],
        false
      ],
      [
        "an empty delivery does not activate the setter",
        setter + "for (holder.paint of []) {}",
        [],
        false
      ],
      [
        "computed delete consumes the evaluated key once",
        key + "delete holder[makeKey(style)];",
        ["key"],
        true
      ],
      [
        "computed update consumes the same key in read and write order",
        key + "holder[makeKey(style)]++;",
        ["key", "key"],
        true
      ],
      [
        "ordinary property delete does not convert a dormant key",
        key + "const dormant = makeKey(style); delete holder.entry;",
        [],
        false
      ],
      [
        "nested array declaration consumes its projected own value",
        iterator + captured + "const { slot: [ignored] } = { slot: iterable };",
        ["iterator"],
        true
      ],
      [
        "nested array assignment consumes the same projected own value",
        iterator +
          captured +
          "let ignored; ({ slot: [ignored] } = { slot: iterable });",
        ["iterator"],
        true
      ],
      [
        "projecting that own value without an array pattern stays inert",
        iterator + captured + "const { slot: retained } = { slot: iterable };",
        [],
        false
      ],
      [
        "the selected paired getter activates the same setter default binder",
        paired("null", "undefined"),
        ["setter"],
        true
      ],
      [
        "a defined paired getter skips its setter",
        paired("1", "undefined"),
        [],
        false
      ],
      [
        "a fresh provided value bypasses the paired setter default",
        paired("null", "{}"),
        ["setter"],
        false
      ],
      [
        "an unproved getter does not activate an unrelated sibling capture",
        'const make = rule => ({ get paint() { return 1 + 0; }, set paint(value = rule) { value.color = "blue"; }, other() { rule.color = "blue"; } }); const holder = make(style); holder.paint ??= {};',
        [],
        false
      ],
      [
        "array assignment also consumes the iterator even without a value read",
        iterator + captured + "let ignored; [ignored] = iterable;",
        ["iterator"],
        true
      ],
      [
        "assigning the iterator without consuming it stays inert",
        iterator + captured + "let retained; retained = iterable;",
        [],
        false
      ],
      [
        "numeric conversion observes an inline receiver in the invoked frame",
        'const make = rule => () => { +{ valueOf() { trace.push("coerce"); rule.color = "blue"; return 1; } }; }; make(style)();',
        ["coerce"],
        true
      ],
      [
        "constructing that inline object without converting it remains inert",
        'const make = rule => () => { ({ valueOf() { trace.push("coerce"); rule.color = "blue"; return 1; } }); }; make(style)();',
        [],
        false
      ],
      [
        "copying an inline getter observes the invoked frame at access",
        'const make = rule => () => ({ ...{ get label() { trace.push("getter"); rule.color = "blue"; return "x"; } } }); make(style)();',
        ["getter"],
        true
      ],
      [
        "calling the selected framed array slot activates its capture",
        returnedArray + "make(style)[0]();",
        ["call"],
        true
      ],
      [
        "a different array slot only calls the other callback",
        returnedArray + "make(style)[1]();",
        ["other"],
        false
      ],
      [
        "creating the same callable array does not invoke either slot",
        returnedArray + "const held = make(style);",
        [],
        false
      ],
      [
        "an unframed array holds a selected callback with its own frame",
        closure +
          'const actions=[make(style),()=>trace.push("other")]; actions[0]();',
        ["call"],
        true
      ],
      [
        "the unframed array can instead select its sibling callback",
        closure +
          'const actions=[make(style),()=>trace.push("other")]; actions[1]();',
        ["other"],
        false
      ],
      [
        "the unframed array can retain a closure without invoking it",
        closure + 'const actions=[make(style),()=>trace.push("other")];',
        [],
        false
      ],
      [
        "method parameter delivery reads the selected incoming getter before its body",
        'const input=rule=>({get color(){trace.push("get");rule.color="blue";return 1},plain:1});' +
          'const make=()=>({read({color}){trace.push("body:"+color)}}); make().read(input(style));',
        ["get", "body:1"],
        true
      ],
      [
        "method parameter delivery uses its matching caller argument",
        'const input=rule=>({get color(){trace.push("get");rule.color="blue";return 1}});' +
          'const make=()=>({read(_first,{color}){trace.push("body:"+color)}}); make().read({},input(style));',
        ["get", "body:1"],
        true
      ],
      [
        "method parameter delivery leaves an unselected getter dormant",
        'const input=rule=>({get color(){trace.push("get");rule.color="blue";return 1},plain:1});' +
          'const make=()=>({read({plain}){trace.push("body:"+plain)}}); make().read(input(style));',
        ["body:1"],
        false
      ],
      [
        "method parameter getter observes only the delivered caller capture",
        'const input=rule=>({get color(){trace.push("get");rule.color="blue";return 1}});' +
          'const make=()=>({read({color}){trace.push("body:"+color)}}); make().read(input({}));',
        ["get", "body:1"],
        false
      ],
      [
        "setter parameter delivery reads the selected incoming getter before its body",
        'const input=rule=>({get color(){trace.push("get");rule.color="blue";return 1},plain:1});' +
          'const make=()=>({set paint({color}){trace.push("put:"+color)}}); make().paint=input(style);',
        ["get", "put:1"],
        true
      ],
      [
        "setter parameter delivery ignores the unselected incoming getter",
        'const input=rule=>({get color(){trace.push("get");rule.color="blue";return 1},plain:1});' +
          'const make=()=>({set paint({plain}){trace.push("put:"+plain)}}); make().paint=input(style);',
        ["put:1"],
        false
      ],
      [
        "setter parameter getter observes only its actual caller capture",
        'const input=rule=>({get color(){trace.push("get");rule.color="blue";return 1}});' +
          'const make=()=>({set paint({color}){trace.push("put:"+color)}}); make().paint=input({});',
        ["get", "put:1"],
        false
      ],
      [
        "binding a named property reads the actual captured getter",
        returnedObject + "const {label} = make(style);",
        ["getter"],
        true
      ],
      [
        "named assignment reads the same captured getter",
        returnedObject + "let label; ({label} = make(style));",
        ["getter"],
        true
      ],
      [
        "binding an ordinary data property skips its sibling getter",
        returnedObject + "const {data} = make(style);",
        [],
        false
      ],
      [
        "object rest consumes the selected captured getter",
        returnedObject + "const {...copy} = make(style);",
        ["getter"],
        true
      ],
      [
        "an explicit property followed by rest reads that getter once",
        returnedObject + "const {label,...copy} = make(style);",
        ["getter"],
        true
      ],
      [
        "a rest getter with an unrelated capture cannot write the rule",
        returnedObject + 'const {...copy} = make({color: "green"});',
        ["getter"],
        false
      ],
      [
        "default-hint compound operator converts after evaluating the RHS",
        coercible + 'let n=1; n+=(trace.push("rhs"), make(style));',
        ["rhs", "coerce"],
        true
      ],
      [
        "numeric compound operator invokes the selected converter",
        coercible + "let n=2; n*=make(style);",
        ["coerce"],
        true
      ],
      [
        "numeric conversion uses the selected named hook receiver",
        'const make=rule=>({rule,valueOf(){trace.push("coerce");this.rule.color="blue";return 1}}); let n=2; n*=make(style); trace.push("put:"+n);',
        ["coerce", "put:2"],
        true
      ],
      [
        "merely storing the named hook receiver does not invoke it",
        'const make=rule=>({rule,valueOf(){trace.push("coerce");this.rule.color="blue";return 1}}); const box=make(style);',
        [],
        false
      ],
      [
        "named hook conversion only writes its unrelated receiver data",
        'const make=rule=>({rule,valueOf(){trace.push("coerce");this.rule.color="blue";return 1}}); let n=2; n*=make({}); trace.push("put:"+n);',
        ["coerce", "put:2"],
        false
      ],
      [
        "simple assignment only stores the same conversion object",
        coercible + "let n=0; n=make(style);",
        [],
        false
      ],
      [
        "logical assignment does not convert its selected argument",
        coercible + "let n=null; n??=make(style);",
        [],
        false
      ],
      [
        "compound conversion consumes the value read before its RHS",
        coercible +
          'const box={value:0}; box.value=make(style); box.value+=(trace.push("rhs"), box.value=0, 1); trace.push("put:"+box.value);',
        ["rhs", "coerce", "put:2"],
        true
      ],
      [
        "a pre-RHS converter with an unrelated capture leaves the rule unchanged",
        coercible +
          'const box={value:0}; box.value=make({}); box.value+=(trace.push("rhs"), box.value=0, 1); trace.push("put:"+box.value);',
        ["rhs", "coerce", "put:2"],
        false
      ],
      [
        "a future RHS store is not the earlier selected value",
        coercible +
          'const box={value:0}; const held=make(style); box.value+=(trace.push("rhs"), box.value=held, 1);',
        ["rhs"],
        false
      ],
      [
        "postfix update consumes the selected stored value before writing",
        coercible +
          'const box={value:0}; box.value=make(style); const old=box.value++; trace.push("old:"+old,"put:"+box.value);',
        ["coerce", "old:1", "put:2"],
        true
      ],
      [
        "prefix update exposes the new primitive after the selected conversion",
        coercible +
          'const box={value:0}; box.value=make(style); const value=--box.value; trace.push("new:"+value,"put:"+box.value);',
        ["coerce", "new:0", "put:0"],
        true
      ],
      [
        "a primitive member update does not consume a converter with no prior store",
        coercible +
          'const box={value:0}; const held=make(style); box.value++; trace.push("put:"+box.value);',
        ["put:1"],
        false
      ],
      [
        "primitive compound operands do not consume a dormant converter",
        coercible + "const held=make(style); let n=0; n+=2;",
        [],
        false
      ],
      [
        "an outer default does not suppress a nested getter read",
        returnedObject + "const {outer:{label}={}} = {outer:make(style)};",
        ["getter"],
        true
      ],
      [
        "a nested data read through an outer default leaves its getter dormant",
        returnedObject + "const {outer:{data}={}} = {outer:make(style)};",
        [],
        false
      ],
      [
        "for-of binding reads the selected getter of a stock yielded value",
        returnedObject + "for (const {label} of [make(style)]) {}",
        ["getter"],
        true
      ],
      [
        "for-of binding reads only the selected yielded property",
        returnedObject + "for (const {data} of [make(style)]) {}",
        [],
        false
      ],
      [
        "an empty iteration delivers no binding values",
        returnedObject + "for (const {label} of []) {}",
        [],
        false
      ],
      [
        "postfix update converts the previously read value",
        coercible + "const box={value:make(style)}; box.value++;",
        ["coerce"],
        true
      ],
      [
        "prefix computed update converts the selected value",
        coercible + 'const box={value:make(style)}; --box["value"];',
        ["coerce"],
        true
      ],
      [
        "a primitive update does not consume a dormant converter",
        coercible + "const held=make(style); const box={value:1}; box.value++;",
        [],
        false
      ],
      [
        "computed key conversion uses the active allocation's frame",
        'const make=rule=>()=>{const key={toString(){trace.push("key");rule.color="blue";return "name";}};({[key]:1});}; make(style)();',
        ["key"],
        true
      ],
      [
        "storing the same active key allocation does not convert it",
        'const make=rule=>()=>{const key={toString(){trace.push("key");rule.color="blue";return "name";}};({named:key});}; make(style)();',
        [],
        false
      ],
      [
        "holding the returned object leaves its getter dormant",
        returnedObject + "const held = make(style);",
        [],
        false
      ],
      [
        "copying data never invokes an unrelated inline setter",
        'const make = rule => () => ({ ...{ label: "x", set label(x) { trace.push("setter"); rule.color = "blue"; } } }); make(style)();',
        [],
        false
      ],
      [
        "an invoked TypeScript-asserted returned closure has its captured effects",
        closure + "const run = make(style) as () => void; run();",
        ["call"],
        true
      ],
      [
        "an uninvoked TypeScript-asserted returned closure stays dormant",
        closure + "const run = make(style) as () => void;",
        [],
        false
      ],
      [
        "simple computed write converts only after evaluating the RHS",
        key + 'holder[makeKey(style)] = (trace.push("rhs"), 1);',
        ["rhs", "key"],
        true
      ],
      [
        "compound computed write reads before and stores after RHS",
        key + 'holder[makeKey(style)] += (trace.push("rhs"), 1);',
        ["key", "rhs", "key"],
        true
      ],
      [
        "creating a key object without converting it stays dormant",
        key +
          'const idle = makeKey(style); holder.entry = (trace.push("rhs"), 1);',
        ["rhs"],
        false
      ],
      [
        "an unused array-binding slot still consumes the selected iterator",
        iterator + captured + "const [ignored] = iterable;",
        ["iterator"],
        true
      ],
      [
        "holding the same iterator object without destructuring remains inert",
        iterator + captured + "const held = iterable;",
        [],
        false
      ],
      [
        "invocation observes the selected destructured closure",
        closure + "const [run] = [make(style)]; run();",
        ["call"],
        true
      ],
      [
        "destructured closure remains dormant",
        closure + "const [run] = [make(style)];",
        [],
        false
      ],
      [
        "invocation of an unrelated destructured closure does not touch the rule",
        closure + 'const [run] = [make({ color: "green" })]; run();',
        ["call"],
        false
      ],
      [
        "an undefined destructured setter argument selects its captured default",
        setter + "[holder.paint] = [undefined];",
        ["setter"],
        true
      ],
      [
        "a defined destructured setter argument bypasses its captured default",
        setter + "[holder.paint] = [{}];",
        ["setter"],
        false
      ],
      [
        "iterator writes follow actual consumption, not function declaration order",
        iterator + inert + consume + store + "consume();",
        ["iterator"],
        true
      ],
      [
        "uninvoked iterator spread remains unconsumed",
        iterator + inert + consume + store,
        [],
        false
      ],
      [
        "selected logical closure is actually invoked",
        closure + "const run = true && make(style); run();",
        ["call"],
        true
      ],
      [
        "selected logical closure stays dormant without call",
        closure + "const run = true && make(style);",
        [],
        false
      ],
      [
        "a closed skipped RHS is not a callable result",
        closure +
          'const enabled = false; const run = (enabled && make(style)) || (() => trace.push("skip")); run();',
        ["skip"],
        false
      ],
      [
        "a later plain object spread supplies the selected own iterator",
        iterator +
          'const iterable={[Symbol.iterator]:()=>{trace.push("inert");return {next:()=>({done:true})}},...{[Symbol.iterator]:make(style)}}; [...iterable];',
        ["iterator"],
        true
      ],
      [
        "a later direct own iterator overwrites the spread without running it",
        iterator +
          'const iterable={...{[Symbol.iterator]:make(style)},[Symbol.iterator]:()=>{trace.push("inert");return {next:()=>({done:true})}}}; [...iterable];',
        ["inert"],
        false
      ],
      [
        "the selected spread iterator only observes its unrelated capture",
        iterator +
          'const iterable={[Symbol.iterator]:()=>{trace.push("inert");return {next:()=>({done:true})}},...{[Symbol.iterator]:make({})}}; [...iterable];',
        ["iterator"],
        false
      ],
      [
        "a selected prior symbol store reaches the spread",
        iterator + inert + store + "[...iterable];",
        ["iterator"],
        true
      ],
      ["a symbol store alone is inert", iterator + inert + store, [], false],
      [
        "a later store cannot reach the earlier spread",
        iterator + inert + "const first = [...iterable];" + store,
        [],
        false
      ],
      [
        "only the consumed holder is observed",
        iterator +
          inert +
          "const other = { ...iterable }; other[Symbol.iterator] = make(style); [...iterable];",
        [],
        false
      ],
      [
        "the string key is not the well-known iterator",
        iterator + inert + "iterable.iterator = make(style); [...iterable];",
        [],
        false
      ],
      [
        "plain synchronous for-of consumes the own iterator",
        iterator + captured + "for (const item of iterable) {}",
        ["iterator"],
        true
      ],
      [
        "prior symbol store also reaches for-of",
        iterator + inert + store + "for (const item of iterable) {}",
        ["iterator"],
        true
      ],
      [
        "dead for-of remains unconsumed",
        iterator + captured + "if (false) for (const item of iterable) {}",
        [],
        false
      ]
    ] as const)("%s", (_label, effect, order, unsafe) => {
      const source = `const style = { color: "red" }; const trace = []; ${effect}`;
      const native = source.replace(" as () => void", "");
      expect(runInNewContext(`${native}; [style.color, trace];`)).toEqual([
        unsafe ? "blue" : "red",
        [...order]
      ]);
      const { run, options } = cssTransform(
        source,
        "same-file",
        native !== source
      );
      if (unsafe) {
        expect(run).toThrow(
          /same-file binding "style".*(mutated|unproven object origin)/
        );
        expect(options.result[1]).toBe("");
      } else {
        expect(run()?.code).toContain("className");
        expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
      }
    });
  });

  describe("selected stored calls and loose equality through source bindings", () => {
    const store = 'const make = rule => () => { rule.color = "blue"; };';
    const coercion =
      'const wrap = rule => ({ valueOf() { rule.color = "blue"; return 1; } });';
    it.each([
      [
        "nullish store and invocation",
        store +
          "const holder = { run: null }; holder.run ??= make(style); holder.run();",
        true
      ],
      [
        "already present member",
        store +
          "const holder = { run: () => {} }; holder.run ??= make(style); holder.run();",
        false
      ],
      [
        "uninvoked nullish store",
        store + "const holder = { run: null }; holder.run ??= make(style);",
        false
      ],
      [
        "unrelated holder invocation",
        store +
          "const holder = { run: null }; const other = { run: () => {} }; holder.run ??= make(style); other.run();",
        false
      ],
      [
        "definitely skipped truthy/falsy selected stores",
        store +
          "const holder = { doNot: false }; holder.doNot &&= make(style);",
        false
      ],
      [
        "short-circuit assignment before the call",
        store +
          "const holder = { run: true }; holder.run &&= make(style); holder.run();",
        true
      ],
      [
        "primitive const selects valueOf",
        coercion + "const one = 1; wrap(style) == one;",
        true
      ],
      [
        "primitive const aliases before read",
        coercion +
          "const literal = 1; const one = literal; wrap(style) == one;",
        true
      ],
      [
        "nullish const does not select valueOf",
        coercion + "const nil = null; wrap(style) == nil;",
        false
      ],
      [
        "object const does not select valueOf",
        coercion + "const other = {}; wrap(style) == other;",
        false
      ],
      [
        "typed input does not prove a noncoercing runtime value",
        coercion + "const other = unknownInput; wrap(style) == other;",
        true
      ],
      [
        "a later const cannot settle earlier comparison",
        coercion + "wrap(style) == other; const other = {};",
        true
      ]
    ] as const)("%s", (_label, effect, unsafe) => {
      const source = `const style = { color: "red" }; ${effect}`;
      const { run, options } = cssTransform(source, "same-file");
      if (unsafe) {
        expect(run).toThrow(
          /same-file binding "style".*(mutated|unproven object origin)/
        );
        expect(options.result[1]).toBe("");
      } else {
        expect(run()?.code).toContain("className");
        expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
      }
    });
  });

  const dormantPrimitiveFallback =
    'const make = rule => () => { rule.color = "blue"; return 1; };';
  const plainPrimitiveHolder =
    '{ [Symbol.toPrimitive](){ return 1; }, valueOf: make(style), toString(){ return "1"; } }';
  it.each([
    [
      "fresh operand with an own callable",
      `(${plainPrimitiveHolder}) == 1;`,
      false
    ],
    [
      "unescaped const operand with an own callable",
      `const input = ${plainPrimitiveHolder}; input == 1;`,
      false
    ],
    [
      "nullish own hook keeps named fallback",
      `const input = ${plainPrimitiveHolder.replace("[Symbol.toPrimitive](){ return 1; }", "[Symbol.toPrimitive]: null")}; input == 1;`,
      true
    ],
    [
      "an own getter can select the named fallback",
      `const input = ${plainPrimitiveHolder.replace("[Symbol.toPrimitive](){ return 1; }", "get [Symbol.toPrimitive](){ return undefined; }")}; input == 1;`,
      true
    ],
    [
      "a descriptor write can select the named fallback",
      `const input = ${plainPrimitiveHolder}; input[Symbol.toPrimitive] = undefined; input == 1;`,
      true
    ],
    [
      "a later literal descriptor can select the named fallback",
      `const input = ${plainPrimitiveHolder.slice(0, -1)}, [Symbol.toPrimitive]: undefined }; input == 1;`,
      true
    ],
    [
      "an unrelated fallback and a nullish hook remain eligible",
      `const input = ${plainPrimitiveHolder.replace("[Symbol.toPrimitive](){ return 1; }", "[Symbol.toPrimitive]: null").replace("make(style)", "make({})")}; input == 1;`,
      false
    ],
    [
      "no conversion on object comparison",
      `const input = ${plainPrimitiveHolder}; input == {};`,
      false
    ]
  ] as const)(
    "checks only the selected coercion continuation: %s",
    (_name, effect, unsafe) => {
      const { run, options } = cssTransform(
        `const style = {color: "red"}; ${dormantPrimitiveFallback} ${effect}`,
        "same-file"
      );
      if (unsafe) {
        expect(run).toThrow(
          /same-file binding "style".*unproven object origin/
        );
        expect(options.result[1]).toBe("");
      } else {
        expect(run()?.code).toContain("className");
        expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
        expect(options.result[1]).not.toContain("blue");
      }
    }
  );

  const copiedMethod =
    'const make = rule => ({ paint() { rule.color = "blue"; } });';
  const storedCallable = 'const make = rule => () => { rule.color = "blue"; };';
  const getter =
    'const make = rule => ({ get label() { rule.color = "blue"; return "x"; } });';
  const setterOnly =
    'const make = rule => ({ set paint(target = rule) { target.color = "blue"; } });';
  it.each([
    [
      "invoke the stored callable",
      storedCallable,
      "const holder = {paint: make(style)}; holder.paint();",
      true
    ],
    [
      "leave the stored callable dormant",
      storedCallable,
      "const holder = {paint: make(style)};",
      false
    ],
    [
      "the stored callable reaches only an unrelated object",
      storedCallable,
      "const holder = {paint: make({})}; holder.paint();",
      false
    ],
    [
      "object spread observes its getter",
      getter,
      "const copy = {...make(style)};",
      true
    ],
    [
      "constructing without copying does not read the getter",
      getter,
      "const held = make(style);",
      false
    ],
    [
      "copying an unrelated getter does not change style",
      getter,
      "const copy = {...make({})};",
      false
    ],
    [
      "an own field already shadows the factory getter",
      'const make = rule => ({ get label() { rule.color = "blue"; return "x"; }, label: "fixed" });',
      "const copy = {...make(style)};",
      false
    ],
    [
      "an undefined read selects the logical OR setter",
      setterOnly,
      "const holder = make(style); holder.paint ||= undefined;",
      true
    ],
    [
      "invoke the copied method",
      copiedMethod,
      "const holder = {...make(style)}; holder.paint();",
      true
    ],
    [
      "copy without invoking",
      copiedMethod,
      "const holder = {...make(style)};",
      false
    ],
    [
      "invoke an unrelated copy",
      copiedMethod,
      "const holder = {...make({})}; holder.paint();",
      false
    ],
    [
      "invoke the own overriding instead of the copied method",
      copiedMethod,
      "const holder = {...make(style), paint(){}}; holder.paint();",
      false
    ],
    [
      "initialize the selected setter default",
      setterOnly,
      "const holder = make(style); holder.paint ??= undefined;",
      true
    ],
    [
      "pass a defined argument to the selected setter",
      setterOnly,
      "const holder = make(style); holder.paint ??= {};",
      false
    ],
    [
      "retain the unselected setter guard",
      setterOnly,
      "const holder = make(style); holder.paint &&= undefined;",
      false
    ],
    [
      "do not invoke the setter behind a non-null getter",
      'const make = rule => ({ get paint(){ return true; }, set paint(target = rule) { target.color = "blue"; } });',
      "const holder = make(style); holder.paint ??= undefined;",
      false
    ]
  ] as const)(
    "only observes the selected callable: %s",
    (_name, factory, operation, mutated) => {
      const { run, options } = cssTransform(
        `const style = {color: "red"}; ${factory} ${operation}`,
        "same-file"
      );
      if (mutated) {
        expect(run).toThrow(/same-file binding "style".*mutated/);
        expect(options.result[1]).toBe("");
      } else {
        expect(run()?.code).toContain("className");
        expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
        expect(options.result[1]).not.toContain("blue");
      }
    }
  );

  it.each([
    [
      "write and invoke a selected for-of callback",
      storedCallable,
      "const holder = {run(){}}; for(holder.run of [make(style)]) {} holder.run();",
      "blue"
    ],
    [
      "leave the callback uninvoked after its store",
      storedCallable,
      "const holder = {run(){}}; for(holder.run of [make(style)]) {}",
      "red"
    ],
    [
      "invoke a delivered read-only callback",
      "const make = rule => () => rule.color;",
      "const holder = {run(){}}; for(holder.run of [make(style)]) {} holder.run();",
      "red"
    ],
    [
      "an empty array delivers no callback",
      storedCallable,
      "const holder = {run(){}}; for(holder.run of []) {} holder.run();",
      "red"
    ],
    [
      "only a later loop can store the callback",
      storedCallable,
      "const holder = {run(){}}; holder.run(); for(holder.run of [make(style)]) {}",
      "red"
    ],
    [
      "a prior own descriptor edit may enable the setter through an alias",
      "const make = rule => ({set paint(value) { rule.color = value; }});",
      'const base = make(style); const holder = base; Object.defineProperty(base, "paint", {get: () => true}); holder.paint &&= "blue";',
      "blue"
    ],
    [
      "an unchanged absent getter through an alias skips the setter",
      "const make = rule => ({set paint(value) { rule.color = value; }});",
      'const base = make(style); const holder = base; holder.paint &&= "blue";',
      "red"
    ],
    [
      "an unchanged false getter through an alias skips the setter",
      "const make = rule => ({get paint() { return false; }, set paint(value) { rule.color = value; }});",
      'const base = make(style); const holder = base; holder.paint &&= "blue";',
      "red"
    ]
  ] as const)(
    "uses the live member value at consumption: %s",
    (_case, factory, operation, color) => {
      const authored = `const style = {color: "red"}; ${factory} ${operation}`;
      expect(new Function(`${authored}; return style.color;`)()).toBe(color);
      const { run, options } = cssTransform(authored, "same-file");
      if (color === "blue") {
        expect(run).toThrow(/same-file binding "style".*mutated/);
        expect(options.result[1]).toBe("");
      } else {
        expect(run()?.code).toContain("className");
        expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
      }
    }
  );

  it.each([
    [
      "live earlier property-key conversion invokes the stored callable",
      'const make = rule => () => {rule.color = "blue"; return "slot";}; const key = {toString(){return "slot";}}; const holder = {slot:true}; key.toString = make(style); const read = holder[key];',
      "blue"
    ],
    [
      "reading a different slot does not convert the stored key",
      'const make = rule => () => {rule.color = "blue"; return "slot";}; const key = {toString(){return "slot";}}; const holder = {slot:true}; key.toString = make(style); const read = holder.slot;',
      "red"
    ],
    [
      "key conversion before the store keeps the original method",
      'const make = rule => () => {rule.color = "blue"; return "slot";}; const key = {toString(){return "slot";}}; const holder = {slot:true}; const read = holder[key]; key.toString = make(style);',
      "red"
    ],
    [
      "the selected returned-arrow parameter getter runs before its body",
      'const make = () => ({label}) => {}; const run = make(); const input = rule => ({get label(){rule.color="blue";return 1;}, data:1}); run(input(style));',
      "blue"
    ],
    [
      "a returned arrow selecting only data does not read the getter",
      'const make = () => ({data}) => {}; const run = make(); const input = rule => ({get label(){rule.color="blue";return 1;}, data:1}); run(input(style));',
      "red"
    ],
    [
      "the selected returned-arrow getter can belong to an unrelated rule",
      'const make = () => ({label}) => {}; const run = make(); const input = rule => ({get label(){rule.color="blue";return 1;}, data:1}); run(input({}));',
      "red"
    ],
    [
      "select an earlier store on the same array slot",
      'const make = rule => () => {rule.color="blue";}; const actions = [() => {}]; actions[0] = make(style); actions[0]();',
      "blue"
    ],
    [
      "array invocation before the store uses the original callback",
      'const make = rule => () => {rule.color="blue";}; const actions = [() => {}]; actions[0](); actions[0] = make(style);',
      "red"
    ],
    [
      "an unrelated rule is not changed by the stored array callback",
      'const make = rule => () => {rule.color="blue";}; const actions = [() => {}]; actions[0] = make({}); actions[0]();',
      "red"
    ],
    [
      "the selected ordinary returned-function parameter getter precedes its body",
      'const make = () => function ({label}) {}; const input = rule => ({get label(){rule.color="blue";return 1;}, data:1}); make()(input(style));',
      "blue"
    ],
    [
      "the unselected returned-function parameter getter stays dormant",
      'const make = () => function ({data}) {}; const input = rule => ({get label(){rule.color="blue";return 1;}, data:1}); make()(input(style));',
      "red"
    ],
    [
      "a named object property consumes the delivered array element",
      'const input = rule => [{get label(){rule.color="blue";return 1;}, data:1}]; const [{label}] = input(style);',
      "blue"
    ],
    [
      "object rest consumes the delivered array element",
      'const input = rule => [{get label(){rule.color="blue";return 1;}, data:1}]; const [{...all}] = input(style);',
      "blue"
    ],
    [
      "a different object property leaves the delivered getter dormant",
      'const input = rule => [{get label(){rule.color="blue";return 1;}, data:1}]; const [{data}] = input(style);',
      "red"
    ],
    [
      "selected nested parameter reads its actual inner getter once",
      'let reads = 0; const input = rule => ({outer:{get label(){rule.color="blue"; if (++reads !== 1) throw Error("repeated getter");return 1;}, data:1}}); const reader = { read({outer:{label}}){} }; reader.read(input(style));',
      "blue"
    ],
    [
      "selected object rest copies its actual enumerable getter once",
      'let reads = 0; const input = rule => ({get label(){rule.color="blue"; if (++reads !== 1) throw Error("repeated getter");return 1;}, data:1}); const reader = { read({...rest}){} }; reader.read(input(style));',
      "blue"
    ],
    [
      "same nested argument selecting data leaves its getter dormant",
      'const input = rule => ({outer:{get label(){rule.color="blue";return 1;}, data:1}}); const reader = { read({outer:{data}}){} }; reader.read(input(style));',
      "red"
    ],
    [
      "a synchronous inner IIFE runs in the captured rule frame",
      'const make = rule => () => { (() => {rule.color="blue";})(); }; make(style)();',
      "blue"
    ],
    [
      "allocating the inner arrow does not activate its capture",
      'const make = rule => () => { const idle = () => {rule.color="blue";}; }; make(style)();',
      "red"
    ],
    [
      "the enclosing assignment has not yet committed during its RHS call",
      'const make = (rule=style) => () => {rule.color="blue";}; const holder = {run(){}}; holder.run = (holder.run(), make());',
      "red"
    ]
  ] as const)(
    "observes the selected eager input and its frame: %s",
    (_case, operation, color) => {
      const authored = `const style = {color: "red"}; ${operation}`;
      expect(new Function(`${authored}; return style.color;`)()).toBe(color);
      const { run, options } = cssTransform(authored, "same-file");
      if (color === "blue") {
        expect(run).toThrow(/same-file binding "style".*mutated/);
        expect(options.result[1]).toBe("");
      } else {
        expect(run()?.code).toContain("className");
        expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
      }
    }
  );

  it("does not discard a preceding completed store while evaluating the next RHS", () => {
    const authored =
      'const style={color:"red"}; const make=(rule=style)=>()=>{rule.color="blue";}; const holder={run(){}}; holder.run=make(); holder.run=(holder.run(),make());';
    expect(new Function(authored + ";return style.color;")()).toBe("blue");
    const { run, options } = cssTransform(authored, "same-file");
    expect(run).toThrow(/same-file binding "style"/);
    expect(options.result[1]).toBe("");
  });

  it.each([
    ["defined primitive", "holder.paint = 1;", false],
    ["defined allocation", "holder.paint = {};", false],
    ["undefined", "holder.paint = undefined;", true],
    ["unknown", "holder.paint = globalThis.maybeValue;", true],
    ["uninvoked", "", false]
  ] as const)(
    "examines the selected setter default only when reachable: %s",
    (_case, operation, mutated) => {
      const { run, options } = cssTransform(
        `const style = {color: "red"};
         const make = () => ({rule: style, set paint(value = (this.rule.color = "blue")){}});
         const holder = make(); ${operation}`,
        "same-file"
      );
      if (mutated) {
        expect(run).toThrow(/same-file binding "style".*mutated/);
        expect(options.result[1]).toBe("");
      } else {
        expect(run()?.code).toContain("className");
        expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
        expect(options.result[1]).not.toContain("blue");
      }
    }
  );

  it.each([
    [
      "selected member constructor writes",
      "function(){rule.color = 'blue';}",
      "new holder.Paint();",
      true
    ],
    [
      "member constructor only allocated",
      "function(){rule.color = 'blue';}",
      "",
      false
    ],
    [
      "unrelated local write in member constructor",
      "function(){const local = {color:rule.color}; local.color = 'blue';}",
      "new holder.Paint();",
      false
    ],
    [
      "constructor does not use the holder as this",
      "function(){this.color = 'blue';}",
      "new holder.Paint();",
      false
    ]
  ] as const)(
    "observes only the selected constructor: %s",
    (_case, factory, operation, mutated) => {
      const { run, options } = cssTransform(
        `const style = {color: "red"};
         const make = rule => ({Paint:${factory}}); const holder = make(style);
         ${operation}`,
        "same-file"
      );
      if (mutated) {
        expect(run).toThrow(/same-file binding "style".*mutated/);
        expect(options.result[1]).toBe("");
      } else {
        expect(run()?.code).toContain("className");
        expect(options.result[1]).toMatch(/"?color"?:\s*["']red["']/);
        expect(options.result[1]).not.toContain("blue");
      }
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
