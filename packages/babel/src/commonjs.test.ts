import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readFileSync
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { babelTransform } from "./testUtils/plugin.js";
import { transformWithEsbuild } from "vite";
import { transformSync } from "@babel/core";
import { minchoBabelPlugin } from "./index.js";
import { styledComponentPlugin } from "./styled.js";
import { typescriptPresetPath } from "./testUtils/babel.js";
import { inspectCommonJs } from "./commonjs/esm.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function transform(source: string, extractCalls?: Record<string, string[]>) {
  return babelTransform(
    source,
    { extractCalls },
    { filename: "test.cjs", sourceType: "unambiguous" }
  );
}

function fixture(
  files: Record<string, string>,
  registrations = { "./factory.cjs": ["make"] }
) {
  mkdirSync(".cache", { recursive: true });

  const root = mkdtempSync(join(process.cwd(), ".cache", "cjs-"));
  roots.push(root);

  for (const [name, source] of Object.entries(files))
    writeFileSync(join(root, name), source);

  return (file: string) =>
    babelTransform(
      readFileSync(join(root, file), "utf8"),
      { extractCalls: registrations },
      { filename: join(root, file), root, sourceType: "unambiguous" }
    );
}

describe("CommonJS extraction", () => {
  it.each(["node:fs", "external-build-helper"])(
    "protects factories that pass an external namespace to a helper: %s",
    (source) => {
      const transform = fixture({
        "factory.cjs": `
          const lib = require(${JSON.stringify(source)});
          const { style } = require("@vanilla-extract/css");
          exports.make = (rule) => { console.log(lib); return style(rule); };
        `
      });
      const result = transform("factory.cjs");

      expect(result.code).toContain("style(rule)");
      expect(result.result[1]).toBe("");
    }
  );

  it("still rejects an escaped local namespace in a protected factory", () => {
    const transform = fixture({
      "factory.cjs": `
        const lib = require("./helper.cjs");
        const { style } = require("@vanilla-extract/css");
        exports.make = (rule) => { console.log(lib); return style(rule); };
      `,
      "helper.cjs": "exports.value = 42;"
    });

    expect(() => transform("factory.cjs")).toThrow(
      /Escaped CommonJS namespace lib/
    );
  });

  it.each([
    ['const { style } = require("@vanilla-extract/css");', "style"],
    ['var ve = require("@vanilla-extract/css");', "ve.style"],
    ['let ve = require("@vanilla-extract/css");', "(0, ve.style)"],
    ['const { style: make } = require("@vanilla-extract/css");', "make"],
    [
      'const ve = require("@vanilla-extract/css"); const other = ve; const make = other.style;',
      "make"
    ],
    ["", 'require("@vanilla-extract/css")["style"]']
  ])("extracts %s %s", (declaration, call) => {
    const result = transform(
      `${declaration} exports.cls = ${call}({color: "red"});`
    );

    expect(result.result[1]).toContain('color: "red"');
    expect(result.code).not.toContain('color: "red"');
    expect(result.code).toContain('require("extracted_');
    expect(result.code).not.toContain("import ");
  });

  it.each(["make", "make.default"])("registers default: %s", (call) => {
    const result = transform(
      `const make = require("custom"); exports.cls = ${call}({ color: "blue" });`,
      { custom: ["default"] }
    );

    expect(result.result[1]).toContain('color: "blue"');
  });

  it.each([
    'const [make] = require("custom");',
    'const [, make] = require("custom");',
    'const [...make] = require("custom");',
    'const [{ make }] = require("custom");',
    'const namespace = require("custom"); const [make] = namespace;'
  ])("does not extract iterator elements as module exports: %s", (source) => {
    const result = transform(`${source} make({ color: "red" });`, {
      custom: ["default"]
    });

    expect(result.result[1]).toBe("");
    expect(result.code).toMatch(/make\(\{\s*color: "red"\s*\}\)/);
  });

  it("does not confuse shadowed require or unrelated exports with style APIs", () => {
    const result = transform(
      'function local(require) { return require("@vanilla-extract/css").style({}); } const { assignVars } = require("@vanilla-extract/css"); exports.value = assignVars({}, {});'
    );

    expect(result.result[1]).toBe("");
  });

  it.each([
    'let style = require("@vanilla-extract/css").style; style = other; style({});',
    'const ve = require("@vanilla-extract/css"); ve.style = other; ve.style({});',
    'const ve = require("@vanilla-extract/css"); const alias = ve; alias.style = other; ve.style({});',
    'const ve = require("@vanilla-extract/css"); leak(ve); ve.style({});',
    'const ve = require("@vanilla-extract/css"); ve[key]({});'
  ])("rejects ambiguous target calls: %s", (source) => {
    expect(() => transform(source)).toThrow(/Cannot safely extract/);
  });

  it("honors ignore before reporting an unsafe call", () => {
    const result = transform(
      'let style = require("@vanilla-extract/css").style; style = other; /* mincho-js-ignore */ style({});'
    );

    expect(result.result[1]).toBe("");
    expect(result.code).toContain("style({})");
  });

  it.each([
    "exports.make = make;",
    "module.exports = { make };",
    'Object.defineProperty(exports, "make", { enumerable: true, get: function () { return make; } });'
  ])("protects local implementation: %s", (declaration) => {
    const run = fixture({
      "factory.cjs": `const { helper } = require("./helper.cjs"); const make = rule => helper(rule); ${declaration}`,
      "helper.cjs":
        'const { style } = require("@vanilla-extract/css"); exports.helper = rule => style(rule); exports.unrelated = style({color:"blue"});',
      "entry.cjs":
        'const {make} = require("./factory.cjs"); exports.cls = make({color:"red"});'
    });

    expect(run("entry.cjs").result[1]).toContain('color: "red"');

    const helper = run("helper.cjs");

    expect(helper.code).toContain("style(rule)");
    expect(helper.result[1]).not.toContain("style(rule)");
    expect(helper.result[1]).toContain('color: "blue"');
  });

  it("follows module.exports forwarding", () => {
    const run = fixture({
      "factory.cjs": 'module.exports = require("./impl.cjs");',
      "impl.cjs":
        'const {style} = require("@vanilla-extract/css"); exports.make = rule => style(rule);',
      "entry.cjs":
        'const {make} = require("./factory.cjs"); exports.cls = make({color:"red"});'
    });

    expect(run("entry.cjs").result[1]).toContain('color: "red"');
    expect(run("impl.cjs").result[1]).toBe("");
  });

  it("protects a directly exported function registered as default", () => {
    const run = fixture(
      {
        "factory.cjs":
          'const {style} = require("@vanilla-extract/css"); module.exports = rule => style(rule);',
        "entry.cjs":
          'const make = require("./factory.cjs"); exports.cls = make({color:"red"});'
      },
      { "./factory.cjs": ["default"] }
    );

    expect(run("entry.cjs").result[1]).toContain('color: "red"');
    expect(run("factory.cjs").result[1]).toBe("");
  });

  it.each([
    "type Value = T;",
    "type Value = T.Member;",
    "type Value = typeof T;",
    "export type { T };",
    "export type { T as Value };",
    ""
  ])("removes type-only import-equals dependencies: %s", (usage) => {
    const result = babelTransform(
      `import T = require("missing-types"); ${usage} exports.answer = 42;`,
      {},
      { filename: "test.cts", sourceType: "unambiguous" }
    );

    expect(result.code).not.toContain("missing-types");
    expect(result.code).toContain("exports.answer = 42");
  });

  it.each([
    'export import T = require("runtime-module");',
    'import T = require("runtime-module"); exports.value = T as unknown;',
    'import T = require("runtime-module"); exports.value = T satisfies unknown;',
    'import T = require("runtime-module"); import Value = T.Member; exports.value = Value;'
  ])("preserves runtime import-equals dependencies: %s", (source) => {
    const result = babelTransform(
      source,
      {},
      {
        filename: "test.cts",
        sourceType: "unambiguous"
      }
    );

    expect(result.code).toContain('require("runtime-module")');
  });

  it.each([
    ["", "React", "<div />"],
    ["", "React", "<></>"],
    ["/** @jsx h */", "h", "<div />"],
    ["/** @jsx UI.createElement */", "UI", "<div />"],
    ["/** @jsxFrag Fragment */", "Fragment", "<></>"]
  ])("preserves the active JSX pragma binding: %s %s", (comment, name, jsx) => {
    const source = `${comment} import ${name} = require("classic-jsx"); export const view = ${jsx};`;
    const result = babelTransform(
      source,
      {},
      { filename: "test.tsx", sourceType: "unambiguous" }
    );

    expect(result.code).toContain('require("classic-jsx")');
    expect(inspectCommonJs(source, "test.tsx").requires).toEqual([
      "classic-jsx"
    ]);
  });

  it.each(["<div />", "<></>"])(
    "removes unrelated type-only imports alongside JSX: %s",
    (jsx) => {
      const result = babelTransform(
        `import T = require("missing-types"); type Value = T.Member; export const view = ${jsx};`
      );

      expect(result.code).not.toContain("missing-types");
      expect(result.code).toContain("export const view");
    }
  );

  it("uses custom JSX pragmas instead of retaining the default binding", () => {
    const result = babelTransform(`
      /** @jsx h */
      /** @jsxFrag Fragment */
      import React = require("missing-types");
      import h = require("jsx-factory");
      import Fragment = require("jsx-fragment");
      type Value = React.Member;
      export const view = <><div /></>;
    `);

    expect(result.code).not.toContain("missing-types");
    expect(result.code).toContain('require("jsx-factory")');
    expect(result.code).toContain('require("jsx-fragment")');
  });

  it.each([
    ["jsxPragma", "h", "<div />"],
    ["jsxPragmaFrag", "Fragment", "<></>"]
  ])("preserves the TypeScript preset's configured %s", (option, name, jsx) => {
    for (const plugin of [minchoBabelPlugin, styledComponentPlugin]) {
      const result = transformSync(
        `import ${name} = require("classic-jsx"); export const view = ${jsx};`,
        {
          filename: "test.tsx",
          configFile: false,
          babelrc: false,
          presets: [[typescriptPresetPath, { [option]: name }]],
          plugins: [plugin()]
        }
      );

      expect(result?.code).toContain('require("classic-jsx")');
    }
  });

  it("normalizes TypeScript CommonJS declarations", () => {
    const result = babelTransform(
      'import ve = require("@vanilla-extract/css"); const cls: string = ve.style({color:"red"}); export = cls;',
      {},
      { filename: "test.cts", sourceType: "unambiguous" }
    );

    expect(result.result[1]).toContain('color: "red"');
    expect(result.code).toContain("module.exports = cls");
  });
});

describe("CommonJS require evaluation", () => {
  it.each([
    'const value = require("dep") || fallback;',
    'const value = require("dep") && fallback;',
    'const value = require("dep") ?? fallback;',
    'const value = require("dep") ? a : b;',
    'if (require("dep")) run();',
    'if (check(require("dep")) || fallback) run();',
    'target[require("dep")] ||= fallback;',
    'require("dep")?.();'
  ])("recognizes an unconditional condition: %s", (source) => {
    const description = inspectCommonJs(source, "conditions.cjs");

    expect(description.requires).toEqual(["dep"]);
    expect(description.topLevelRequires).toEqual(["dep"]);
    expect(description.diagnostics).toEqual([]);
  });

  it.each([
    'const value = enabled && require("dep");',
    'const value = enabled || require("dep");',
    'const value = enabled ?? require("dep");',
    'const value = enabled ? require("dep") : fallback;',
    'const value = enabled ? fallback : require("dep");',
    'if (enabled) require("dep");',
    'if (enabled) {} else require("dep");',
    'const value = enabled && (require("dep") || fallback);',
    'if (enabled) { if (require("dep")) run(); }',
    'function load() { return require("dep") || fallback; }',
    'class A { field = require("dep"); }',
    'class A { #field = require("dep"); }',
    'value ||= require("dep");',
    'value &&= require("dep");',
    'value ??= require("dep");',
    'fn?.(require("dep"));',
    'fn?.method(require("dep"));',
    'fn?.(wrap(require("dep")));',
    'while (require("dep")) run();',
    'try { require("dep"); } catch {}',
    'switch (value) { case 1: require("dep"); }'
  ])("keeps a conditional or deferred load in place: %s", (source) => {
    const description = inspectCommonJs(source, "conditions.cjs");

    expect(description.requires).toEqual(["dep"]);
    expect(description.topLevelRequires).toEqual([]);
    expect(description.diagnostics).toHaveLength(1);
    expect(description.diagnostics[0]).toMatch(/Conditional or lazy require/);
  });

  it.each([
    'class A { [require("dep")] = 1; }',
    'class A { static field = require("dep"); }',
    'class A { static #field = require("dep"); }'
  ])("preserves eager class evaluation: %s", (source) => {
    const description = inspectCommonJs(source, "conditions.cjs");

    expect(description.requires).toEqual(["dep"]);
    expect(description.diagnostics).toEqual([]);
  });
});

it("protects both the module value and its distinct default property", () => {
  const run = fixture(
    {
      "factory.cjs":
        'const {style} = require("@vanilla-extract/css"); const raw = rule => style(rule); module.exports = raw; module.exports.default = rule => style({...rule, color:"blue"});',
      "entry.cjs":
        'const make = require("./factory.cjs"); exports.a = make({color:"red"}); exports.b = make.default({color:"green"});'
    },
    { "./factory.cjs": ["default"] }
  );

  expect(run("factory.cjs").result[1]).toBe("");
  expect(run("entry.cjs").result[1]).toContain('color: "green"');
});

it("supports a Babel default interop wrapper and rejects a forged helper", () => {
  const source =
    'function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; } var make = _interopRequireDefault(require("custom")); exports.cls = (0, make.default)({color:"red"});';

  expect(transform(source, { custom: ["default"] }).result[1]).toContain(
    'color: "red"'
  );
  expect(() =>
    transform(
      source.replace(
        "return obj && obj.__esModule ? obj : { default: obj };",
        "return other(obj);"
      ),
      { custom: ["default"] }
    )
  ).toThrow(/Unsupported CommonJS interop helper/);
});

it("supports CommonJS styled and dynamic JSX css variables", () => {
  const styled = transform(
    'const {styled} = require("@mincho-js/react"); exports.Button = styled.button({color:"red"});'
  );

  expect(styled.result[1]).toContain('color: "red"');
  expect(styled.code).toContain("$$styled");

  const jsx = babelTransform(
    "exports.View = ({color}) => <div css={{color}} />;",
    { jsxCssProp: true },
    { filename: "view.tsx", sourceType: "unambiguous" }
  );

  expect(jsx.result[1]).toContain("createVar");
  expect(jsx.code).not.toContain(" css=");
});

it("protects factory implementations across actual esbuild re-exports", async () => {
  const compile = async (source: string) =>
    (
      await transformWithEsbuild(source, "input.ts", {
        loader: "ts",
        format: "cjs"
      })
    ).code;

  const run = fixture({
    "factory.cjs": await compile('export { make } from "./impl.cjs";'),
    "impl.cjs": await compile(
      'import { style } from "@vanilla-extract/css"; export const make = rule => style(rule);'
    ),
    "entry.cjs": await compile(
      'import { make } from "./factory.cjs"; export const cls = make({color:"red"});'
    )
  });

  expect(run("entry.cjs").result[1]).toContain('color: "red"');
  expect(run("impl.cjs").result[1]).toBe("");
});

it("reports captured runtime parameters before generating invalid sidecars", () => {
  expect(() =>
    transform(
      'const {style} = require("@vanilla-extract/css"); exports.make = rule => style(rule);'
    )
  ).toThrow(/captures runtime binding rule/);
});

it("follows verified TypeScript export-star helpers", () => {
  const helpers = `      var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
          desc = { enumerable: true, get: function() { return m[k]; } };
        }
        Object.defineProperty(o, k2, desc);
      }) : (function(o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      }));
      var __exportStar = (this && this.__exportStar) || function(m, exports) {
        for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
      };
`;

  const run = fixture({
    "factory.cjs": helpers + '__exportStar(require("./impl.cjs"), exports);',
    "impl.cjs":
      'const {style} = require("@vanilla-extract/css"); exports.make = rule => style(rule);',
    "entry.cjs":
      'const factory = require("./factory.cjs"); exports.cls = factory.make({color:"red"});'
  });

  expect(run("entry.cjs").result[1]).toContain('color: "red"');
  expect(run("impl.cjs").result[1]).toBe("");
});

it.each([
  "[ve.style] = [replacement];",
  "({ style: ve.style } = { style: replacement });",
  "for (ve.style of [replacement]) {}",
  "for (ve.style in { replacement: true }) {}"
])(
  "rejects namespace mutation through assignment targets: %s",
  (assignment) => {
    expect(() =>
      babelTransform(`
    const ve = require("@vanilla-extract/css");
    const replacement = () => "runtime";
    ${assignment}
    exports.value = ve.style({ color: "red" });
  `)
    ).toThrow(/Mutated CommonJS namespace/);
  }
);

it.each([
  "forged || function (obj) { return obj && obj.__esModule ? obj : { default: obj }; }",
  "async function (obj) { return obj && obj.__esModule ? obj : { default: obj }; }",
  "function* (obj) { return obj && obj.__esModule ? obj : { default: obj }; }",
  "async obj => obj && obj.__esModule ? obj : { default: obj }"
])("rejects a non-canonical interop helper: %s", (helper) => {
  expect(() =>
    babelTransform(
      `
    const forged = obj => ({ default: () => "runtime" });
    const helper = ${helper};
    const make = helper(require("custom-style"));
    exports.value = make.default({ color: "red" });
  `,
      { extractCalls: { "custom-style": ["default"] } }
    )
  ).toThrow(/Unsupported CommonJS interop helper/);
});

it("recognizes the TypeScript default interop fallback", () => {
  const result = babelTransform(
    `
    var __importDefault = (this && this.__importDefault) || function (obj) {
      return obj && obj.__esModule ? obj : { default: obj };
    };
    const make = __importDefault(require("custom-style"));
    exports.value = make.default({ color: "red" });
  `,
    { extractCalls: { "custom-style": ["default"] } }
  );
  expect(result.result[1]).toContain('color: "red"');
});
