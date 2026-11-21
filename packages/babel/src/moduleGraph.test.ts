import { resolve, dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { transformSync as transformModule } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { transformWithEsbuild } from "vite";
import {
  transformSync as transformBabel,
  type TransformOptions
} from "@babel/core";
import { minchoBabelPlugin } from "./index.js";
import { retainRuntimeInvocation } from "./extractionCalls/index.js";
import * as commonJs from "./commonjs/modules.js";
import {
  createModuleGraph,
  parseModuleProgram,
  type ModuleGraphFlow,
  type ModuleGraphResponse,
  type RuntimeModuleSource
} from "./moduleGraph.js";
import { compilerRecipeFactoryFiles } from "./optimizations/recipeFactories.js";
import { analyzeExtractCalls } from "./extractionCalls/analysis.js";
import { SourceAstCache } from "./staticCssEval/moduleParser.js";
import { babelTransform } from "./testUtils/plugin.js";
import {
  evaluateStaticExpression,
  StaticExpressionDeopt
} from "./optimizations/staticExpression.js";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore This test runs as ESM; ignore import.meta for CJS declaration emission.
const fixtureRequire = createRequire(import.meta.url);

function fixture(
  files: Record<string, string | RuntimeModuleSource>,
  options: {
    runtime?: boolean;
    resolutions?: Record<string, string>;
  } = {}
) {
  const graph = createModuleGraph({
    ...(options.runtime ? { loadPurpose: "consumer-runtime" } : {})
  });
  const requests: Array<{ source: string; mode: string }> = [];

  function run<T>(flow: ModuleGraphFlow<T>): T {
    let step = flow.next();

    while (!step.done) {
      const request = step.value;
      let value: ModuleGraphResponse;

      if (request.kind === "load") value = files[request.id] ?? null;
      else if (request.kind === "token-reference") value = null;
      else {
        requests.push({
          source: request.source,
          mode: request.mode ?? "import"
        });

        const id =
          request.source === "package"
            ? `/project/${request.mode}.ts`
            : resolve(dirname(request.importer), request.source);

        value =
          options.resolutions?.[request.source] ??
          (Object.hasOwn(files, id) ? id : null);
      }

      step = flow.next(value);
    }

    return step.value;
  }

  return { graph, run, requests };
}

describe("shared module graph", () => {
  it("shares one fingerprint within a combined batch but reobserves AST edits", () => {
    const graph = createModuleGraph();
    const program = parseModuleProgram(
      "/project/a.ts",
      "const value=1;",
      false
    );
    graph.modules.set("/project/a.ts", { id: "/project/a.ts", program });
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const first = graph.combinedIntrinsicSnapshot();
      const fingerprintCalls = () =>
        stringify.mock.calls.filter(
          ([value]) =>
            Array.isArray(value) &&
            value[0]?.[0] === "/project/a.ts" &&
            value[0]?.[1] === program.node
        ).length;
      expect(fingerprintCalls()).toBe(1);
      expect(first.math.fingerprint).toBe(first.arrayMap.fingerprint);
      expect(first.math.intact).toBe(true);
      expect(first.arrayMap.iterationIntact).toBe(true);
      program.node.body.push(
        ...parseModuleProgram(
          "/mutation.ts",
          "Math.max=opaque;Array.prototype[Symbol.iterator]=opaque;",
          false
        ).node.body
      );
      const next = graph.combinedIntrinsicSnapshot();
      expect(fingerprintCalls()).toBe(2);
      expect(next.math.fingerprint).not.toBe(first.math.fingerprint);
      expect(next.math.intact).toBe(false);
      expect(next.arrayMap.iterationIntact).toBe(false);
      expect(graph.mathIntrinsicSnapshot().fingerprint).toBe(
        next.math.fingerprint
      );
      expect(graph.arrayMapIntrinsicSnapshot().fingerprint).toBe(
        next.arrayMap.fingerprint
      );
    } finally {
      stringify.mockRestore();
    }
  });

  it("retains operation-specific prototype keys across later graph loads", () => {
    const { graph, run } = fixture({
      "/project/a.ts":
        "Object.defineProperty(Object.prototype,'name',{value:1})",
      "/project/b.ts":
        "Object.defineProperty(Object.prototype,'color',{value:1})",
      "/project/c.ts": "Object.defineProperty(Object.prototype,key,{value:1})"
    });
    run(graph.load("/project/a.ts"));
    const first = graph.arrayMapIntrinsicSnapshot();
    expect(first).toMatchObject({
      intact: false,
      iterationIntact: true,
      prototypeAbsenceIntact: false,
      prototypeMutationKeys: ["name"]
    });
    run(graph.load("/project/b.ts"));
    const second = graph.arrayMapIntrinsicSnapshot();
    expect(second.prototypeMutationKeys).toEqual(["color", "name"]);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    run(graph.load("/project/c.ts"));
    expect(graph.arrayMapIntrinsicSnapshot()).toMatchObject({
      iterationIntact: false,
      prototypeMutationKeys: null
    });
  });

  it("withdraws the intrinsic snapshot when a later module mutates Math", () => {
    const { graph, run } = fixture({
      "/project/first.ts": "export const value=Math.max(1,2)",
      "/project/late.ts": "globalThis.Math.max = opaque;"
    });
    run(graph.load("/project/first.ts"));
    const first = graph.mathIntrinsicSnapshot();
    expect(first.intact).toBe(true);
    run(graph.load("/project/late.ts"));
    const next = graph.mathIntrinsicSnapshot();
    expect(next.intact).toBe(false);
    expect(next.revision).toBeGreaterThan(first.revision);
    expect(next.fingerprint).not.toBe(first.fingerprint);
  });

  it("withdraws Array map authority on a later graph load", () => {
    const { graph, run } = fixture({
      "/project/a.ts": "export const x=[1].map(x=>x)",
      "/project/b.ts": "Array.prototype.map=replacement"
    });
    run(graph.load("/project/a.ts"));
    const first = graph.arrayMapIntrinsicSnapshot();
    expect(first.intact).toBe(true);
    run(graph.load("/project/b.ts"));
    const next = graph.arrayMapIntrinsicSnapshot();
    expect(next.intact).toBe(false);
    expect(next.revision).toBeGreaterThan(first.revision);
    expect(next.fingerprint).not.toBe(first.fingerprint);
  });
  it.each([
    "get make() {return recipe({base:'x'})}",
    "set make(options) {return recipe(options)}"
  ])(
    "does not treat accessor execution as a callable forwarding wrapper: %s",
    (method) => {
      const { graph, run } = fixture(
        {
          "/project/wrapper.ts": `import {recipe} from '@vanilla-extract/recipes'; export const api={${method}};`
        },
        {
          resolutions: {
            "@vanilla-extract/recipes": fixtureRequire.resolve(
              "@vanilla-extract/recipes"
            )
          }
        }
      );
      const origins = run(
        graph.objectExportOrigins("/project/wrapper.ts", [["api", "make"]])
      );
      expect(origins.authoringCalls).toBeUndefined();
    }
  );

  it.each([
    ["@vanilla-extract/recipes", "recipe"],
    ["@vanilla-extract/css", "style"]
  ])(
    "summarizes source forwarding through a rewritten host endpoint: %s",
    (pkg, name) => {
      const endpoint = fixtureRequire.resolve(pkg);
      const source = `/@fs${endpoint}`;
      const { graph, run } = fixture(
        {
          "/project/wrapper.ts": `import {${name}} from ${JSON.stringify(source)}; export const make = options => ${name}(options);`
        },
        { resolutions: { [source]: endpoint } }
      );
      const origins = run(graph.objectExportOrigins("/project/wrapper.ts"));
      expect(origins.authoringCalls?.['["make"]']).toMatchObject({
        terminal: name,
        arguments: [{ kind: "parameter", index: 0 }],
        endpoint: { id: endpoint }
      });
      expect(origins.inertInvocations).toBeUndefined();
      expect(origins.unknownContents).toContain('["make"]');
    }
  );

  describe("raw CJS callable publication with closed primitive initialization", () => {
    const prefix = `exports.makeStyle=value=>value; function makeRecipe(value){return value+'-button'}; exports.makeRecipe=makeRecipe;`;
    it("proves exact local primitive coercion before publishing the arrow result summary", () => {
      const { graph, run } = fixture({
        "/project/factory.cjs": prefix + `exports.local=makeRecipe('local');`
      });
      const result = run(graph.objectExportOrigins("/project/factory.cjs"));
      expect(result.sourceInvocationResults?.['["makeStyle"]']).toEqual({
        kind: "argument",
        index: 0
      });
      expect(result.sourceInvocationResults?.['["makeRecipe"]']).toEqual({
        kind: "primitive"
      });
      expect(result.unknownExports ?? []).not.toContain('["makeStyle"]');
    });
    it.each([
      `exports.local=makeRecipe(unknown);`,
      `exports.local=makeRecipe({valueOf(){exports.makeStyle=other;return 1}});`,
      `escape(exports); exports.local=makeRecipe('local');`,
      `external(); exports.local=makeRecipe('local');`,
      `exports.local=late('local'); const late=value=>value+'!';`,
      `function mutate(value){exports.makeStyle=other;return value+'!'}; mutate('local');`
    ])(
      "does not infer an inert module from the primitive result alone: %s",
      (suffix) => {
        const { graph, run } = fixture({
          "/project/factory.cjs": prefix + suffix
        });
        const result = run(graph.objectExportOrigins("/project/factory.cjs"));
        expect(
          result.sourceInvocationResults?.['["makeStyle"]']
        ).toBeUndefined();
      }
    );
  });

  describe("source normal-call result contracts", () => {
    it("records primitive and conditional formal results without approving effects", () => {
      const { graph, run } = fixture({
        "/project/source.js": `observe(); export const literal=()=>{effect();return 'red'}; export const pass=(a,b)=>b; export function configure(state,color='blue'){state.color=color;return state.color;}`
      });
      const result = run(graph.objectExportOrigins("/project/source.js"));
      expect(result.sourceInvocationResults).toEqual({
        '["literal"]': { kind: "primitive" },
        '["pass"]': { kind: "argument", index: 1 }
      });
      expect(result.unknownContents).toContain('["literal"]');
      expect(result.inertInvocations?.['["literal"]']).toBeUndefined();
      expect(result.primitiveExports ?? []).not.toContain('["literal"]');
    });
    it("retains exact reexport identity for a result contract", () => {
      const { graph, run } = fixture({
        "/project/source.js": `export function make(){return 'red'}`,
        "/project/barrel.js": `export {make as renamed} from './source.js'`
      });
      expect(
        run(graph.objectExportOrigins("/project/barrel.js"))
          .sourceInvocationResults
      ).toEqual({ '["renamed"]': { kind: "primitive" } });
    });
    it.each([
      `export let make=()=>1; make=other;`,
      `eval(source); export const make=()=>1;`,
      `Object.prototype.x={}; export const make=()=>1;`,
      `export const make=async()=>1;`,
      `export const make=()=>unknown();`,
      `export function make(){const {constructor}=1; return constructor;}`,
      `export function make(){const {toString}='x'; return toString;}`,
      `export function make(){const {constructor:factory}=true; return factory;}`
    ])("rejects mutable or unproved source callable: %s", (source) => {
      const { graph, run } = fixture({ "/project/source.js": source });
      expect(
        run(graph.objectExportOrigins("/project/source.js"))
          .sourceInvocationResults
      ).toBeUndefined();
    });
    it("withdraws previously issued result contracts on late realm mutation", () => {
      const { graph, run } = fixture({
        "/project/source.js": `export const make=()=>1;`,
        "/project/later.js": `Object.prototype.x={};`
      });
      const result = run(graph.objectExportOrigins("/project/source.js"));
      expect(result.sourceInvocationResults?.['["make"]']).toBeDefined();
      run(graph.load("/project/later.js"));
      expect(result.sourceInvocationResults?.['["make"]']).toBeUndefined();
    });
  });

  describe("primitive export identity receipts", () => {
    it.each([
      ["source", `export const scalar='red';`],
      ["esm", `export const scalar=1+2;`],
      ["cjs", `exports.scalar='red';`]
    ])("records existing primitive proof for %s", (_kind, source) => {
      const { graph, run } = fixture({ "/project/values.js": source });
      expect(
        run(graph.objectExportOrigins("/project/values.js")).primitiveExports
      ).toContain('["scalar"]');
    });
    it("keeps primitive reexports and nested own paths separate from object identities", () => {
      const { graph, run } = fixture({
        "/project/values.js": `export const scalar='red'; export const object={own:1};`,
        "/project/barrel.js": `export {scalar as renamed,object} from './values.js';`
      });
      const origins = run(graph.objectExportOrigins("/project/barrel.js"));
      expect(origins.primitiveExports).toEqual([
        '["object","own"]',
        '["renamed"]'
      ]);
      expect(origins.exports['["object"]']).toBeDefined();
      expect(origins.primitiveExports).not.toContain('["object"]');
    });
    it.each([
      `export let scalar='red'; export function change(){scalar={};}`,
      `exports.scalar='red'; exports.scalar={};`,
      `Object.defineProperty(exports,'scalar',{get(){return unknown()}});`,
      `export const object={own:'red'}; mutate(object); export const scalar=object.own;`
    ])(
      "does not certify changed, accessor, or escaped values: %s",
      (source) => {
        const { graph, run } = fixture({ "/project/values.js": source });
        expect(
          run(graph.objectExportOrigins("/project/values.js"))
            .primitiveExports ?? []
        ).not.toContain('["scalar"]');
      }
    );
  });

  describe("closed own-allocation source contracts", () => {
    it("publishes only own shapes without erasing initialization uncertainty", () => {
      const { graph, run } = fixture({
        "/project/factory.ts": `observe(); export const make=()=>({own:{value:1},list:[()=>"red"]});`
      });
      const origins = run(graph.objectExportOrigins("/project/factory.ts"));
      expect(origins.closedOwnAllocations?.['["make"]']).toEqual({
        kind: "object",
        properties: {
          own: { kind: "object", properties: { value: { kind: "primitive" } } },
          list: { kind: "array", elements: [{ kind: "function" }] }
        }
      });
      expect(origins.unknownContents).toContain('["make"]');
      expect(origins.inertInvocations).toBeUndefined();
    });
    it.each([
      `const shared={}; export const make=()=>({value:shared});`,
      `export const make=()=>({get value(){return 1}});`,
      `export let make=()=>({value:1}); make=other;`,
      `eval(source); export const make=()=>({value:1});`,
      `Object.prototype.value=1; export const make=()=>({value:1});`
    ])(
      "rejects missing ownership, mutability, or realm evidence: %s",
      (source) => {
        const { graph, run } = fixture({ "/project/factory.ts": source });
        expect(
          run(graph.objectExportOrigins("/project/factory.ts"))
            .closedOwnAllocations
        ).toBeUndefined();
      }
    );
    it("revokes returned shape publications when a later graph load changes prototypes", () => {
      const { graph, run } = fixture({
        "/project/factory.ts": `export const make=()=>({value:1});`,
        "/project/later.ts": `Object.prototype.extra={};`
      });
      const origins = run(graph.objectExportOrigins("/project/factory.ts"));
      expect(origins.closedOwnAllocations?.['["make"]']).toBeDefined();
      run(graph.load("/project/later.ts"));
      expect(origins.closedOwnAllocations?.['["make"]']).toBeUndefined();
      expect(
        run(graph.objectExportOrigins("/project/factory.ts"))
          .closedOwnAllocations
      ).toBeUndefined();
    });
  });

  describe("source forwarding through stable raw CJS publications", () => {
    const implementation = `const {create}=require('./helper.cjs'); exports.makeStyle=rule=>create(rule);`;
    const helper = `const {style}=require('@vanilla-extract/css'); exports.create=function create(rule){return style({...rule,borderWidth:'3px'});}; exports.unrelated='class';`;
    function analyze(source: string) {
      const { graph, run } = fixture(
        {
          "/project/implementation.cjs": implementation,
          "/project/helper.cjs": source
        },
        {
          resolutions: {
            "@vanilla-extract/css": fixtureRequire.resolve(
              "@vanilla-extract/css"
            )
          }
        }
      );
      return run(graph.objectExportOrigins("/project/implementation.cjs"));
    }
    it("composes assigned arrow and helper only after full publication initialization proof", () => {
      expect(analyze(helper).authoringCalls?.['["makeStyle"]']).toMatchObject({
        terminal: "style",
        arguments: [
          {
            kind: "object",
            entries: [
              { kind: "spread", value: { kind: "parameter", index: 0 } },
              {
                kind: "property",
                key: "borderWidth",
                value: { kind: "literal", value: "3px" }
              }
            ]
          }
        ]
      });
    });
    it.each([
      helper + `exports.create=unknown;`,
      helper + `opaque();`,
      helper + `escape(exports);`,
      helper +
        `Object.defineProperty(exports,'create',{get(){return unknown}});`
    ])(
      "rejects replaced, opaque, escaped, or accessor publication: %s",
      (source) => {
        expect(
          analyze(source).authoringCalls?.['["makeStyle"]']
        ).toBeUndefined();
      }
    );
  });

  describe("source forwarding through validated emitted default slots", () => {
    const runtime = (source: string): RuntimeModuleSource => ({
      source,
      sourceHash: createHash("sha256").update(source).digest("hex"),
      watchFiles: [],
      version: "test-host:1"
    });
    const helper = `import {style} from '@vanilla-extract/css';
      var mod={exports:{}}, out=mod.exports;
      out.create=function create(rule){return style({...rule,borderWidth:'3px'});};
      const snapshot=mod.exports; export default snapshot;
      const create=snapshot.create; export {create};`;
    const implementation = `import * as helper from './helper.js';
      import {recipe} from '@vanilla-extract/recipes';
      const {create}=helper.default;
      export const makeStyle=rule=>create(rule);
      export function makeRecipe(options){return recipe(options);}`;
    function analyze(source: string | RuntimeModuleSource) {
      const { graph, run } = fixture(
        {
          "/project/helper.js": source,
          "/project/implementation.js": runtime(implementation),
          "/project/factory.js": runtime(
            "export {makeStyle as defineStyle,makeRecipe} from './implementation.js';"
          )
        },
        {
          runtime: true,
          resolutions: {
            "@vanilla-extract/css": fixtureRequire.resolve(
              "@vanilla-extract/css"
            ),
            "@vanilla-extract/recipes": fixtureRequire.resolve(
              "@vanilla-extract/recipes"
            )
          }
        }
      );
      return run(graph.objectExportOrigins("/project/factory.js"));
    }
    it("composes makeStyle through an actual default slot while preserving makeRecipe", () => {
      const origins = analyze(runtime(helper));
      expect(origins.authoringCalls?.['["defineStyle"]']).toMatchObject({
        terminal: "style",
        arguments: [
          {
            kind: "object",
            entries: [
              { kind: "spread", value: { kind: "parameter", index: 0 } },
              {
                kind: "property",
                key: "borderWidth",
                value: { kind: "literal", value: "3px" }
              }
            ]
          }
        ]
      });
      expect(origins.authoringCalls?.['["makeRecipe"]']).toMatchObject({
        terminal: "recipe"
      });
      expect(origins.inertInvocations).toBeUndefined();
      expect(origins.unknownContents).toContain('["defineStyle"]');
    });
    it.each([
      `import {style} from '@vanilla-extract/css'; export default {create: rule=>style(rule)};`,
      `import {style} from '@vanilla-extract/css'; export default {get create(){return rule=>style(rule)}};`,
      helper.replace("const snapshot=", "mutate(out); const snapshot="),
      helper
        .replace("out.create=", "out.other=")
        .replace("snapshot.create", "snapshot.other")
    ])(
      "does not infer default slot authority from arbitrary objects, escapes, or renamed exports: %s",
      (source) => {
        expect(
          analyze(runtime(source)).authoringCalls?.['["defineStyle"]']
        ).toBeUndefined();
      }
    );
    it("resolves whole-module forwarding through a normalized default-slot reexport", () => {
      const recipe = `import {recipe} from '@vanilla-extract/recipes';
        var mod={exports:{}}, out=mod.exports;
        function makeRecipe(options){return recipe(options);}
        out.makeRecipe=makeRecipe;
        const snapshot=mod.exports; export default snapshot;
        const renamed=snapshot.makeRecipe; export {renamed as makeRecipe};`;
      const alternate = `import * as implementation from './implementation.js';
        var mod={exports:{}}, out=mod.exports;
        out.makeRecipe=implementation.default.makeRecipe;
        const snapshot=mod.exports; export default snapshot;
        const forwarded=snapshot.makeRecipe; export {forwarded as makeRecipe};`;
      const { graph, run } = fixture(
        {
          "/project/factory.js": runtime(
            "export * from './alternate.js'; export {default} from './alternate.js';"
          ),
          "/project/alternate.js": runtime(alternate),
          "/project/implementation.js": runtime(recipe)
        },
        {
          runtime: true,
          resolutions: {
            "@vanilla-extract/recipes": fixtureRequire.resolve(
              "@vanilla-extract/recipes"
            )
          }
        }
      );
      const result = run(graph.objectExportOrigins("/project/factory.js"));
      expect(result.authoringCalls?.['["makeRecipe"]']).toMatchObject({
        terminal: "recipe"
      });
      expect(JSON.parse(result.exports['["makeRecipe"]'])[0]).toBe(
        "/project/implementation.js"
      );
      expect(result.unknownContents).toContain('["makeRecipe"]');
      expect(result.inertInvocations?.['["makeRecipe"]']).toBeUndefined();
    });

    it("requires an actual runtime source receipt for wrapper recovery", () => {
      expect(
        analyze(helper).authoringCalls?.['["defineStyle"]']
      ).toBeUndefined();
    });
  });

  it("summarizes source forwarding without certifying module initialization", () => {
    const require = fixtureRequire;
    const { graph, run } = fixture(
      {
        "/project/implementation.ts": `import {recipe} from '@vanilla-extract/recipes';
        import {create} from './helper.ts';
        export function makeRecipe(options) { return recipe(options); }
        export const makeStyle = rule => create(rule);
        export const localClassName = makeRecipe({base:{color:'orchid'}})();`,
        "/project/helper.ts": `import {style} from '@vanilla-extract/css';
        export function create(rule) { return style({...rule,borderWidth:'3px',borderStyle:'solid'}); }
        export const unrelated = style({outlineStyle:'dotted'});`
      },
      {
        resolutions: {
          "@vanilla-extract/recipes":
            require.resolve("@vanilla-extract/recipes"),
          "@vanilla-extract/css": require.resolve("@vanilla-extract/css")
        }
      }
    );
    const origins = run(
      graph.objectExportOrigins("/project/implementation.ts")
    );
    expect(origins.authoringCalls?.['["makeRecipe"]']).toMatchObject({
      terminal: "recipe",
      parameterCount: 1,
      arguments: [{ kind: "parameter", index: 0 }]
    });
    expect(origins.authoringCalls?.['["makeStyle"]']).toMatchObject({
      terminal: "style",
      parameterCount: 1,
      arguments: [
        {
          kind: "object",
          entries: [
            { kind: "spread", value: { kind: "parameter", index: 0 } },
            {
              kind: "property",
              key: "borderWidth",
              value: { kind: "literal", value: "3px" }
            },
            {
              kind: "property",
              key: "borderStyle",
              value: { kind: "literal", value: "solid" }
            }
          ]
        }
      ]
    });
    expect(origins.inertInvocations).toBeUndefined();
    expect(origins.unknownContents).toContain('["makeRecipe"]');
  });

  it.each([
    "export function makeRecipe(options) { observe(); return recipe(options); }",
    "export async function makeRecipe(options) { return recipe(options); }",
    "export function makeRecipe(options = observe()) { return recipe(options); }",
    "export function makeRecipe(options) { return recipe(shared); }",
    "export function makeRecipe(options) { return recipe({get base(){return options.base}}); }",
    "export function makeRecipe(options) { return makeRecipe(options); }",
    "export function makeRecipe(options) { return recipe(options); } makeRecipe = other;"
  ])(
    "does not grant a source contract to unsupported forwarding: %s",
    (source) => {
      const { graph, run } = fixture(
        {
          "/project/wrapper.ts": `import {recipe} from '@vanilla-extract/recipes'; ${source}`
        },
        {
          resolutions: {
            "@vanilla-extract/recipes": fixtureRequire.resolve(
              "@vanilla-extract/recipes"
            )
          }
        }
      );
      expect(
        run(graph.objectExportOrigins("/project/wrapper.ts")).authoringCalls
      ).toBeUndefined();
    }
  );

  it("rejects an authoring endpoint with the right spelling but wrong host identity", () => {
    const { graph, run } = fixture(
      {
        "/project/wrapper.ts":
          "import {recipe} from '@vanilla-extract/recipes'; export function make(options){return recipe(options);}"
      },
      { resolutions: { "@vanilla-extract/recipes": "/project/fake.js" } }
    );
    expect(
      run(graph.objectExportOrigins("/project/wrapper.ts")).authoringCalls
    ).toBeUndefined();
  });

  it.each([
    ["ordinary JSX", "export const app = <App />;", false],
    ["CSS prop", "export const app = <App css={{ color: 'red' }} />;", true],
    ["spread props", "export const app = <App {...props} />;", true],
    [
      "registered import",
      "import { css } from 'preset'; export const cls = css({});",
      true
    ]
  ] as const)(
    "requests host runtime output only for potential extraction consumers: %s",
    (_name, usage, expected) => {
      const files = {
        "/project/app.tsx": "export default function App() { return null; }",
        "/project/factory.ts": "export const make = value => value;"
      };
      const { run } = fixture(files);
      const analysis = analyzeExtractCalls({
        root: "/project",
        filename: "/project/main.tsx",
        source: `import App from './app.tsx'; ${usage}`,
        jsx: true,
        extractCalls: { "./factory.ts": ["make"], preset: ["css"] }
      });
      const runtimeLoads: string[] = [];
      function* observed(): typeof analysis {
        let step = analysis.next();

        while (!step.done) {
          const request = step.value;
          if (request.kind === "load" && request.purpose === "consumer-runtime")
            runtimeLoads.push(request.id);
          step = analysis.next(yield request);
        }

        return step.value;
      }

      expect(run(observed()).dependencies).toContain("/project/factory.ts");
      expect(runtimeLoads.includes("/project/app.tsx")).toBe(expected);

      // Invalid registrations must still fail in a consumer with no styles.
      expect(() =>
        run(
          analyzeExtractCalls({
            root: "/project",
            filename: "/project/main.tsx",
            source: "export const app = <div />;",
            jsx: true,
            extractCalls: { "./factory.ts": ["missing"] }
          })
        )
      ).toThrow(/Cannot statically identify a function implementation/);
    }
  );

  it.each([
    ["shadowed exports", "const exports = {};", "exports.slot = alias()"],
    ["reassigned exports", "exports = {};", "exports.slot = alias()"],
    ["null exports", "exports = null;", "exports.slot = alias()"],
    ["dynamic scope", "eval('exports = null');", "exports.slot = alias()"],
    [
      "computed key coercion",
      "const key = { toString() { system.css = () => 'blue'; return 'slot'; } };",
      "exports[key] = alias()"
    ],
    [
      "compound getter read",
      "Object.defineProperty(exports, 'slot', { get() { system.css = () => 'blue'; return 0; }, set(value) {} });",
      "exports.slot += alias()"
    ],
    [
      "nested module getter",
      "Object.defineProperty(module, 'exports', { get() { system.css = () => 'blue'; return {}; } });",
      "module.exports.slot = alias()"
    ],
    [
      "escaped module object",
      "opaque(module);",
      "module.exports.slot = alias()"
    ]
  ])(
    "does not borrow a publication record as a reference proof: %s",
    (_name, setup, assignment) => {
      const root = mkdtempSync(join(tmpdir(), "publication-reference-"));
      const entry = `const { alias } = require('./helper.ts');
        const { system } = require('./factory.ts');
        ${setup} ${assignment}; exports.color = system.css();`;
      try {
        writeFileSync(
          join(root, "factory.ts"),
          "export const system = { css: () => 'red' };"
        );
        writeFileSync(
          join(root, "helper.ts"),
          `import {system} from './factory.ts';
          export function alias() { system.css = () => 'blue'; }`
        );
        writeFileSync(join(root, "entry.cjs"), entry);
        expect(() =>
          babelTransform(
            entry,
            {
              extractCalls: {
                "./helper.ts": ["alias"],
                "./factory.ts": ["system.css"]
              }
            },
            { root, filename: join(root, "entry.cjs") }
          )
        ).toThrow(/Cannot safely extract/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    [
      "runtime-owned captured mutation",
      "export function alias() { system.css = () => 'blue'; }",
      "owned",
      true,
      "blue",
      false
    ],
    [
      "conditional captured mutation taken",
      "export function alias() { system.css = () => 'blue'; }",
      "conditional",
      true,
      "blue",
      false
    ],
    [
      "conditional captured mutation skipped",
      "export function alias() { system.css = () => 'blue'; }",
      "conditional",
      false,
      "red",
      false
    ],
    [
      "conditional parameter-default mutation",
      "export function alias(value = (system.css = () => 'blue')) { return value; }",
      "conditional",
      false,
      "red",
      false
    ],
    [
      "unconditional captured mutation",
      "export function alias() { system.css = () => 'blue'; }",
      "unconditional",
      true,
      "blue",
      true
    ],
    [
      "runtime-owned closed function",
      "export function alias() { return 'ok'; }",
      "owned",
      true,
      "red",
      true
    ]
  ] as const)(
    "preserves registered callable owner effects: %s",
    (_name, helper, mode, enabled, expected, extracted) => {
      const root = mkdtempSync(join(tmpdir(), "registered-owner-"));
      const files: Record<string, string> = {
        "factory.ts": "export const system = { css: () => 'red' };",
        "helper.ts": `import { system } from './factory.ts'; ${helper}`,
        "entry.ts": `import { system } from './factory.ts';
          import { alias } from './helper.ts';
          ${mode === "conditional" ? "if (enabled) alias();" : "alias();"}
          export const color = system.css();`
      };
      const execute = (extra: Record<string, string> = {}) => {
        const cache = new Map<string, { exports: Record<string, unknown> }>();
        const sources = { ...files, ...extra };
        const load = (name: string): Record<string, unknown> => {
          const id = name.replace(/^\.\//, "");
          const previous = cache.get(id);
          if (previous) return previous.exports;
          if (!(id in sources)) throw new Error(`Unexpected module ${id}`);
          const module = { exports: {} as Record<string, unknown> };
          cache.set(id, module);
          const { code } = transformModule(sources[id], { format: "cjs" });
          new Function("require", "exports", "module", "enabled", code)(
            load,
            module.exports,
            module,
            enabled
          );
          return module.exports;
        };
        return load("entry.ts");
      };

      try {
        for (const [name, source] of Object.entries(files))
          writeFileSync(join(root, name), source);
        const options = {
          result: ["", ""] as [string, string],
          extractCalls: {
            "./factory.ts": ["system.css"],
            "./helper.ts": ["alias"]
          },
          optimize: { pureFunctions: false }
        };
        const transformed = transformBabel(files["entry.ts"], {
          root,
          filename: join(root, "entry.ts"),
          plugins: [
            {
              visitor: {
                Program(path) {
                  if (mode !== "owned") return;
                  path.traverse({
                    CallExpression(call) {
                      if (call.get("callee").isIdentifier({ name: "alias" }))
                        retainRuntimeInvocation(call.node);
                    }
                  });
                }
              }
            },
            [minchoBabelPlugin(), options]
          ]
        });
        expect(transformed?.code).toBeDefined();
        const sidecar = options.result;
        const original = execute();
        const runtime = execute({
          "entry.ts": transformed!.code!,
          [sidecar[0]]: sidecar[1]
        });
        expect(original.color).toBe(expected);
        expect(runtime.color).toBe(original.color);
        expect(sidecar[1].includes("system.css()")).toBe(extracted);
        if (mode === "owned" || mode === "conditional")
          expect(sidecar[1]).not.toContain("alias()");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each(["() => 'ok'", "0"])(
    "keeps root identity unknown across direct-eval rebinding: %s",
    (initializer) => {
      const { graph, run } = fixture({
        "/project/factory.ts": "export const system = {css: () => 'red'};",
        "/project/helper.ts": `import {system} from './factory.ts';
        export let label = ${initializer}; eval('label = system');`,
        "/project/barrel.ts": "export {label} from './helper.ts';"
      });
      const origins = run(graph.objectExportOrigins("/project/barrel.ts"));
      expect(origins.exports['["label"]']).toBeUndefined();
      expect(origins.unknownExports).toContain('["label"]');
      expect(origins.inertInvocations?.['["label"]']).toBeUndefined();
    }
  );

  it("keeps a later CommonJS load in module initialization effects", () => {
    const { graph, run } = fixture({
      "/project/factory.cjs": "exports.system = {css: () => 'red'};",
      "/project/wrapper.cjs": `const box = {owner: {}}; exports.box = box;
        const ignored = require('./mutator.cjs'); exports.alias = box.owner;`,
      "/project/mutator.cjs": `const {box} = require('./wrapper.cjs');
        const {system} = require('./factory.cjs'); box.owner = system;`
    });
    const origins = run(graph.objectExportOrigins("/project/wrapper.cjs"));
    expect(origins.exports['["alias"]']).toBeUndefined();
    expect(origins.unknownExports).toContain('["alias"]');
  });

  describe("runtime consumer provenance", () => {
    it.each([
      "/project/node_modules/helper/index.js",
      "\0host:helper",
      "/project/helper.ts"
    ])(
      "retains explicit unavailable runtime ownership across repeated queries: %s",
      (id) => {
        const graph = createModuleGraph({ loadPurpose: "consumer-runtime" });
        const query = graph.objectExportOrigins(id);
        expect(query.next().value).toMatchObject({
          kind: "load",
          id,
          purpose: "consumer-runtime"
        });
        const result = query.next({ kind: "unavailable-runtime" });
        expect(result.done).toBe(true);
        expect(result.value).toMatchObject({ unknownExports: ["[]"] });
        const repeated = graph.objectExportOrigins(id).next();
        expect(repeated.done).toBe(true);
        expect(repeated.value).toEqual(result.value);
      }
    );

    it("preserves the ordinary external fallback boundary without an owned receipt", () => {
      const graph = createModuleGraph({ loadPurpose: "consumer-runtime" });
      const query = graph.objectExportOrigins(
        "/project/node_modules/helper/index.js"
      );
      query.next();
      const result = query.next(null);
      expect(result.done).toBe(true);
      expect(result.value).toEqual({ exports: {}, esModule: false });
    });

    it("keeps a rejected external runtime receipt unknown", () => {
      const graph = createModuleGraph({ loadPurpose: "consumer-runtime" });
      const query = graph.objectExportOrigins(
        "/project/node_modules/helper/index.js"
      );
      query.next();
      const result = query.next({
        source: "export const alias = {};",
        sourceHash: "invalid",
        version: "host-v1",
        watchFiles: []
      });
      expect(result.done).toBe(true);
      expect(result.value).toMatchObject({ unknownExports: ["[]"] });
    });

    const source = "@mincho-js/css/rules/createRuntimeFn";
    const config = `{defaultClassName:'red',variantClassNames:{tone:{solid:'red'}},
      defaultVariants:{tone:'solid'},compoundVariants:[],
      extension:{version:1,stylePackages:['test']}}`;
    const runtime = (source: string): RuntimeModuleSource => ({
      source,
      sourceHash: createHash("sha256").update(source).digest("hex"),
      watchFiles: ["/project/theme.tokens.ts"],
      version: "test-host:1"
    });

    it("keeps CommonJS export identity unknown across a later circular load", () => {
      const { graph, run } = fixture(
        {
          "/project/wrapper.cjs": runtime(
            "exports.alias = {}; require('./mutator.cjs');"
          ),
          "/project/mutator.cjs": runtime(
            `const wrapper = require('./wrapper.cjs');
            const {system} = require('./factory.cjs'); wrapper.alias = system;`
          ),
          "/project/factory.cjs": runtime(
            "exports.system = {css: () => 'red'};"
          )
        },
        { runtime: true }
      );
      const origins = run(graph.objectExportOrigins("/project/wrapper.cjs"));

      expect(origins.exports['["alias"]']).toBeUndefined();
      expect(origins.unknownExports).toContain('["alias"]');
      expect(origins.ownDataPaths ?? []).not.toContain('["alias"]');
    });

    it("follows a host-owned virtual export without treating its id as a file", () => {
      const id = "\0host:compiled-styles?theme=dark";
      const { graph, run } = fixture(
        {
          "/project/owner.ts": runtime(
            "export {styles} from 'compiled-styles';"
          ),
          [id]: runtime("export const styles = {color: 'red'};")
        },
        { runtime: true, resolutions: { "compiled-styles": id } }
      );
      const origins = run(graph.objectExportOrigins("/project/owner.ts"));

      expect(origins.exports['["styles"]']).toContain(
        id.replaceAll("\0", "\\u0000")
      );
      expect(origins.ownDataPaths).toContain('["styles","color"]');
      expect(origins.unknownExports).toBeUndefined();
      expect(graph.modules.has(id)).toBe(true);
      expect(graph.dependencies).not.toContain(id);
      expect(graph.dependencies).toContain("/project/theme.tokens.ts");
    });

    it.each(["authoring", "unowned runtime", "invalid receipt"] as const)(
      "does not promote opaque source text to a host receipt: %s",
      (mode) => {
        const id = "\0host:compiled-styles";
        const contents = "export const styles = {color: 'red'};";
        const { graph, run } = fixture(
          {
            "/project/owner.ts": "export {styles} from 'compiled-styles';",
            [id]:
              mode === "invalid receipt"
                ? { ...runtime(contents), sourceHash: "incorrect" }
                : contents
          },
          {
            runtime: mode !== "authoring",
            resolutions: { "compiled-styles": id }
          }
        );
        const origins = run(graph.objectExportOrigins("/project/owner.ts"));

        expect(origins.exports['["styles"]']).toBeUndefined();
        expect(origins.unknownExports).toContain('["styles"]');
        expect(origins.ownDataPaths).toBeUndefined();
      }
    );

    it.each([
      ["verified endpoint", "createCompiledRuntimeFn", true, true, true],
      ["unrelated endpoint", "unknownFactory", true, true, false],
      [
        "host alias to another file",
        "createCompiledRuntimeFn",
        false,
        true,
        false
      ],
      ["raw authoring bytes", "createCompiledRuntimeFn", true, false, false]
    ] as const)(
      "checks canonical ABI identity after host import rewriting: %s",
      (_name, factory, canonical, transformed, proven) => {
        const id = [...compilerRecipeFactoryFiles(source)][0];
        expect(id).toBeDefined();
        const rewritten = `/@fs${id}`;
        const contents = `import {${factory}} from '${rewritten}';
          export const button = ${factory}(${config}, {});`;
        const { graph, run } = fixture(
          {
            "/project/theme.css.ts": transformed ? runtime(contents) : contents
          },
          {
            runtime: true,
            resolutions: {
              [rewritten]: canonical ? id! : "/project/fake-runtime.ts"
            }
          }
        );
        const origins = run(graph.objectExportOrigins("/project/theme.css.ts"));

        expect(origins.exports['["button"]'] !== undefined).toBe(proven);
        expect(origins.recipeInvocations?.['["button"]']).toBe(
          proven ? "class-string" : undefined
        );
        expect((origins.unknownExports ?? []).includes('["button"]')).toBe(
          !proven
        );
      }
    );

    it.each([config, config.replace("tone:'solid'", "tone:-1")])(
      "keeps a verified runtime allocation distinct from descriptor shape: %s",
      (payload) => {
        const id = [...compilerRecipeFactoryFiles(source)][0];
        expect(id).toBeDefined();
        const contents =
          runtime(`import {createCompiledRuntimeFn as factory} from '${source}';
        export const button = factory(${payload}, {});`);
        const { graph, run } = fixture(
          { "/project/theme.css.ts": contents },
          {
            runtime: true,
            resolutions: { [source]: id! }
          }
        );
        const origins = run(graph.objectExportOrigins("/project/theme.css.ts"));
        expect(origins.exports['["button"]']).toBeDefined();
        expect(origins.unknownExports ?? []).not.toContain('["button"]');
        expect(origins.unknownContents ?? []).not.toContain('["button"]');
        expect(origins.ownDataPaths ?? []).not.toContain(
          '["button","classNames"]'
        );
        expect(origins.inertInvocations).toBeUndefined();
        expect(origins.recipeInvocations).toEqual({
          '["button"]': "class-string"
        });
        expect(
          run(
            graph.objectExportOrigins("/project/theme.css.ts", [
              ["button", "classNames"]
            ])
          ).unknownExports
        ).toContain('["button","classNames"]');
        expect(graph.dependencies).toContain("/project/theme.tokens.ts");
      }
    );

    it.each([
      [
        "@mincho-js/css/rules/createRuntimeFn",
        "createCompiledRuntimeFn",
        false
      ],
      ["@vanilla-extract/recipes/createRuntimeFn", "createRuntimeFn", false],
      ["@vanilla-extract/recipes/createRuntimeFn", "createRuntimeFn", true]
    ] as const)(
      "recognizes a serialized class result from %s (%s, cjs: %s)",
      (source, factory, commonjs) => {
        const id = [...compilerRecipeFactoryFiles(source)][0];
        expect(id).toBeDefined();
        const { graph, run } = fixture(
          {
            "/project/theme.css.ts":
              runtime(`import {${factory}} from '${source}';
            export var button = ${factory}(${config});`),
            "/project/helper.ts": runtime(
              commonjs
                ? `var button = require('./theme.css.ts').button;
                exports.className = button();`
                : `import {button} from './theme.css.ts';
                export const className = button();`
            )
          },
          { runtime: true, resolutions: { [source]: id! } }
        );

        const origins = run(graph.objectExportOrigins("/project/helper.ts"));
        // The result is a class string, not an unknown alias of an authoring API.
        expect(origins.exports).toEqual({});
        expect(origins.unknownExports).toBeUndefined();
        expect(origins.unknownContents).toBeUndefined();
      }
    );

    it.each(["{tone:'solid'}", "['tone', {tone:'solid'}]", "void 0"])(
      "recognizes closed option input without dropping its validation: %s",
      (options) => {
        const id = [...compilerRecipeFactoryFiles(source)][0]!;
        const { graph, run } = fixture(
          {
            "/project/theme.css.ts":
              runtime(`import {createCompiledRuntimeFn} from '${source}';
            export const button = createCompiledRuntimeFn(${config}, {});`),
            "/project/helper.ts":
              runtime(`import {button} from './theme.css.ts';
            export const className = button(${options});`)
          },
          { runtime: true, resolutions: { [source]: id } }
        );
        const origins = run(graph.objectExportOrigins("/project/helper.ts"));
        expect(origins.exports).toEqual({});
        expect(origins.unknownExports).toBeUndefined();
      }
    );

    it.each([
      ["host alias", "button()", true, true],
      ["authoring bytes", "button()", false, false],
      [
        "observed options",
        "button({get tone(){return opaque()}})",
        true,
        false
      ],
      ["replaced callable", "(button = opaque(), button())", true, false]
    ] as const)(
      "does not infer a closed class result from %s",
      (_name, expression, transformed, aliased) => {
        const source = "@vanilla-extract/recipes/createRuntimeFn";
        const id = [...compilerRecipeFactoryFiles(source)][0]!;
        const code = `import {createRuntimeFn} from '${source}';
          let button = createRuntimeFn(${config});
          export const className = ${expression};`;
        const { graph, run } = fixture(
          { "/project/helper.ts": transformed ? runtime(code) : code },
          {
            runtime: true,
            resolutions: { [source]: aliased ? "/project/alias.ts" : id }
          }
        );

        expect(
          run(graph.objectExportOrigins("/project/helper.ts")).unknownExports
        ).toContain('["className"]');
      }
    );

    it.each([
      [
        "raw author source",
        "createCompiledRuntimeFn",
        config,
        "{}",
        false,
        false
      ],
      [
        "an aliased runtime module",
        "createCompiledRuntimeFn",
        config,
        "{}",
        true,
        true
      ],
      [
        "a mutable direct factory",
        "createRuntimeFn",
        config,
        "{}",
        true,
        false
      ],
      [
        "a getter payload",
        "createCompiledRuntimeFn",
        `{get defaultClassName(){return 'red'}}`,
        "{}",
        true,
        false
      ],
      [
        "an aliased payload",
        "createCompiledRuntimeFn",
        "shared",
        "{}",
        true,
        false
      ],
      [
        "an unknown feature",
        "createCompiledRuntimeFn",
        config,
        "{}, {props: external}",
        true,
        false
      ],
      [
        "an incompatible extension",
        "createCompiledRuntimeFn",
        config.replace("version:1", "version:2"),
        "{}",
        true,
        false
      ]
    ] as const)(
      "keeps %s unproved",
      (_name, factory, payload, rest, transformed, aliased) => {
        const id = [...compilerRecipeFactoryFiles(source)][0];
        expect(id).toBeDefined();
        const contents = `import {${factory}} from '${source}';
        const shared = ${config};
        export const button = ${factory}(${payload}, ${rest});`;
        const { graph, run } = fixture(
          {
            "/project/theme.css.ts": transformed ? runtime(contents) : contents
          },
          {
            runtime: true,
            resolutions: {
              [source]: aliased ? "/project/fake-runtime.ts" : id!
            }
          }
        );
        const origins = run(graph.objectExportOrigins("/project/theme.css.ts"));
        expect(origins.exports['["button"]']).toBeUndefined();
        expect(origins.unknownExports).toContain('["button"]');
      }
    );
  });

  it.each([
    `{get tone() { system.css = () => 'blue'; return 'solid'; }}`,
    `{tone: {toString() { system.css = () => 'blue'; return 'solid'; }}}`
  ])("preserves runtime recipe option observations: %s", (options) => {
    const source = "@mincho-js/css/rules/createRuntimeFn";
    const id = [...compilerRecipeFactoryFiles(source)][0]!;
    const serialized = `import {createCompiledRuntimeFn} from '${source}';
      export const button = createCompiledRuntimeFn({defaultClassName:'red',
        variantClassNames:{tone:{solid:'red'}}, defaultVariants:{tone:'solid'},
        compoundVariants:[]}, {});`;
    const entry = `import {system} from './factory.ts';
      import {button} from './theme.css.ts';
      const options = ${options}; button(options);
      export const color = system.css();`;
    const files: Record<string, string> = {
      "/project/factory.ts": "export const system = {css: () => 'red'};",
      "/project/theme.css.ts": serialized,
      "/project/entry.ts": entry
    };
    const { run } = fixture(
      {
        ...files,
        "/project/theme.css.ts": {
          source: serialized,
          sourceHash: createHash("sha256").update(serialized).digest("hex"),
          watchFiles: [],
          version: "test-host:1"
        }
      },
      { runtime: true, resolutions: { [source]: id } }
    );
    const extractCalls = { "./factory.ts": ["system.css"] };
    const preparedExtractCalls = run(
      analyzeExtractCalls({
        extractCalls,
        root: "/project",
        filename: "/project/entry.ts",
        source: entry
      })
    );
    const pluginOptions = { extractCalls, preparedExtractCalls };
    const { code, result } = babelTransform(entry, pluginOptions, {
      root: "/project",
      filename: "/project/entry.ts"
    });
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore This test runs as ESM; ignore import.meta for CJS declaration emission.
    const external = createRequire(import.meta.url);
    const execute = (changed: Record<string, string> = {}) => {
      const sources = { ...files, ...changed };
      const cache = new Map<string, { exports: Record<string, unknown> }>();
      const load = (id: string): Record<string, unknown> => {
        if (!id.startsWith("/") && !id.startsWith(".")) return external(id);
        const filename = resolve("/project", id);
        const previous = cache.get(filename);
        if (previous) return previous.exports;
        const module = { exports: {} as Record<string, unknown> };
        cache.set(filename, module);
        const compiled = transformModule(sources[filename], {
          format: "cjs"
        }).code;
        new Function("require", "module", "exports", compiled)(
          load,
          module,
          module.exports
        );
        return module.exports;
      };
      return load("/project/entry.ts").color;
    };
    const original = execute();
    const transformed = execute({
      "/project/entry.ts": code,
      [resolve("/project", result[0])]: result[1]
    });
    expect(original).toBe("blue");
    expect(transformed).toBe(original);
    expect(result[1]).not.toContain("system.css");
  });

  describe("receiver provenance through selected and spread wrappers", () => {
    it.each([
      ["local forwarding", "export { box };"],
      ["direct re-export", "export { box } from './factory.ts';"],
      ["star re-export", "export * from './factory.ts';"]
    ])("retains initialization effects through %s", (_name, forwarding) => {
      const { graph, run } = fixture({
        "/project/factory.ts": `export const system = { css: () => 'red' };
          export const box = { owner: {} };`,
        "/project/barrel.ts": `import { box, system } from './factory.ts';
          box.owner = system;
          ${forwarding}`,
        "/project/wrapper.ts": `import { box } from './barrel.ts';
          export const alias = box.owner;
          export const { owner: selected } = box;
          export const copy = { ...box };`
      });
      const origins = run(graph.objectExportOrigins("/project/wrapper.ts"));

      expect(origins.exports['["alias"]']).toBeUndefined();
      expect(origins.unknownExports).toContain('["alias"]');
      expect(origins.exports['["selected"]']).toBeUndefined();
      expect(origins.unknownExports).toContain('["selected"]');
      expect(origins.exports['["copy","owner"]']).toBeUndefined();
      expect(origins.unknownContents).toContain('["copy"]');
    });

    it("includes sibling initialization along an imported value's forwarding path", () => {
      const { graph, run } = fixture({
        "/project/factory.ts": `export const system = { css: () => 'red' };
          export const box = { owner: {} };`,
        "/project/mutator.ts": `import { box, system } from './factory.ts'; box.owner = system;`,
        "/project/barrel.ts":
          "import './mutator.ts'; export { box } from './factory.ts';",
        "/project/wrapper.ts":
          "import { box } from './barrel.ts'; export const alias = box.owner;"
      });
      const origins = run(graph.objectExportOrigins("/project/wrapper.ts"));

      expect(origins.exports['["alias"]']).toBeUndefined();
      expect(origins.unknownExports).toContain('["alias"]');
    });

    it("preserves member proof through an inert re-export module", () => {
      const { graph, run } = fixture({
        "/project/factory.ts": `export const system = { css: () => 'red' };
          export const box = { owner: system };`,
        "/project/barrel.ts": "export { box } from './factory.ts';",
        "/project/wrapper.ts": `import { box } from './barrel.ts';
          export const alias = box.owner;`
      });
      const factory = run(graph.objectExportOrigins("/project/factory.ts"));
      const wrapper = run(graph.objectExportOrigins("/project/wrapper.ts"));

      expect(wrapper.exports['["alias"]']).toBe(factory.exports['["system"]']);
      expect(wrapper.unknownExports).toBeUndefined();
    });

    it("separates immutable spread identities from mutable owner snapshots", () => {
      const { graph, run } = fixture({
        "/project/factory.ts": "export const system = { css: () => 'red' };",
        "/project/wrapper.ts": `import { system } from './factory.ts';
          const shared = { system };
          export const wrapper = { ...shared };
          export const copy = { ...system };`,
        "/project/mutable.ts": `import { system } from './factory.ts';
          const box = { owner: system };
          export const alias = box.owner;
          box.owner = { css: () => 'other' };`
      });
      const factory = run(graph.objectExportOrigins("/project/factory.ts"));
      const wrapped = run(graph.objectExportOrigins("/project/wrapper.ts"));
      const mutable = run(graph.objectExportOrigins("/project/mutable.ts"));
      const origin = factory.exports['["system"]'];

      expect(origin).toBeDefined();
      expect(mutable.exports['["alias"]']).toBeUndefined();
      expect(mutable.unknownExports).toContain('["alias"]');
      expect(wrapped.exports['["wrapper","system"]']).toBe(origin);
      expect(wrapped.exports['["copy"]']).not.toBe(origin);
      expect(wrapped.unknownContents).toEqual([
        '["copy","css"]',
        '["wrapper","system","css"]'
      ]);
      expect(run(graph.objectExportOrigins("/project/wrapper.ts"))).toEqual(
        wrapped
      );
    });

    it("keeps unresolved receiver selections explicit and deterministic", () => {
      const { graph, run } = fixture({
        "/project/factory.ts": "export const system = { css: () => 'red' };",
        "/project/wrapper.ts": `import { system } from './factory.ts';
          const identity = value => value;
          const box = { owner: {} };
          box.owner = identity(system);
          export const alias = box.owner;
          export const wrapper = { ...identity({ system }) };`
      });
      const origins = run(graph.objectExportOrigins("/project/wrapper.ts"));

      expect(origins.exports['["alias"]']).toBeUndefined();
      expect(origins.unknownExports).toEqual(['["alias"]']);
      expect(origins.unknownContents).toEqual(['["wrapper"]']);
      expect(run(graph.objectExportOrigins("/project/wrapper.ts"))).toEqual(
        origins
      );
    });

    it("reports conditional and logical aliases at their exported paths", () => {
      const { graph, run } = fixture({
        "/project/factory.ts": "export const system = { css: () => 'red' };",
        "/project/wrapper.ts": `import { system } from './factory.ts';
          export const alias = true ? system : {};
          export const wrapper = { nested: { owner: false || system } };
          export const label = 'independent';
          export const create = () => system;`
      });
      const origins = run(graph.objectExportOrigins("/project/wrapper.ts"));

      expect(origins.unknownExports).toEqual([
        '["alias"]',
        '["wrapper","nested","owner"]'
      ]);
      expect(origins.unknownContents).toContain('["create"]');
      expect(origins.exports['["create"]']).toBeDefined();
      expect(run(graph.objectExportOrigins("/project/wrapper.ts"))).toEqual(
        origins
      );
    });

    it("does not compare capture positions across different modules", () => {
      const { graph, run } = fixture({
        "/project/factory.ts": `export const system = { css: () => 'red' };
          const independent = { css: () => 'independent' };
          export const box = { owner: independent };
          void 0;
          void 0;
          box.owner = system;`,
        "/project/wrapper.ts": `import { box } from './factory.ts';
          export const alias = box.owner;`
      });
      const result = run(graph.objectExportOrigins("/project/wrapper.ts"));

      expect(result.exports['["alias"]']).toBeUndefined();
      expect(result.unknownExports).toContain('["alias"]');
    });

    it("does not infer immutable members across opaque module initialization", () => {
      const { graph, run } = fixture({
        "/project/factory.ts": "export const system = { css: () => 'red' };",
        "/project/wrapper.ts": `import { mutate } from './mutator.ts';
          export const box = { owner: { css: () => 'independent' } };
          mutate();
          export const alias = box.owner;`,
        "/project/mutator.ts": `import { box } from './wrapper.ts';
          import { system } from './factory.ts';
          export function mutate() { box.owner = system; }`
      });
      const result = run(graph.objectExportOrigins("/project/wrapper.ts"));

      expect(result.exports['["box"]']).toBeDefined();
      expect(result.exports['["alias"]']).toBeUndefined();
      expect(result.unknownExports).toContain('["alias"]');
      expect(result.ownDataPaths).toBeUndefined();
    });

    it("keeps member snapshots uncertain after opaque prototype initialization", () => {
      const { graph, run } = fixture({
        "/project/factory.ts": "export const system = { css: () => 'red' };",
        "/project/wrapper.ts": `import { system } from './factory.ts';
          const box = { own: 'label' };
          Object.prototype.owner = system;
          export const alias = box.owner;
          export const label = box.own;`
      });
      const result = run(graph.objectExportOrigins("/project/wrapper.ts"));

      expect(result.exports['["alias"]']).toBeUndefined();
      expect(result.unknownExports).toContain('["alias"]');
      expect(result.unknownExports).toContain('["label"]');
    });

    it.each(["", "as const", "satisfies Record<string, unknown>"])(
      "certifies immutable own data paths independently of object origins: %s",
      (wrapper) => {
        const { graph, run } = fixture({
          "/project/value.ts": `export const value = {
          label: 'red', nested: { count: 1, style: () => 'red' }
        } ${wrapper};
        export const label = value.label;`
        });
        const result = run(graph.objectExportOrigins("/project/value.ts"));

        expect(result.ownDataPaths).toEqual([
          '["value","label"]',
          '["value","nested","count"]',
          '["value","nested","style"]',
          '["value","nested"]'
        ]);
        expect(result.exports['["value","label"]']).toBeUndefined();
        expect(result.exports['["value","nested"]']).toBeDefined();
        expect(result.unknownExports ?? []).not.toContain('["label"]');
        expect(run(graph.objectExportOrigins("/project/value.ts"))).toEqual(
          result
        );
      }
    );

    it.each([
      "const tag = (_strings, value) => { value.owner = system; }; tag`${box}`;",
      "const view = <View value={box} />;"
    ])(
      "does not prove a shape after an unclassified consumer: %s",
      (consume) => {
        const { graph, run } = fixture({
          "/project/factory.ts": "export const system = { css: () => 'red' };",
          "/project/wrapper.tsx": `import { system } from './factory.ts';
          const box = { owner: { css: () => 'independent' } };
          ${consume}
          export const alias = box.owner;`
        });
        const result = run(graph.objectExportOrigins("/project/wrapper.tsx"));

        expect(result.exports['["alias"]']).toBeUndefined();
        expect(result.unknownExports).toContain('["alias"]');
      }
    );

    it.each([
      ["get touch() { this.nested.owner = system; }", "box.touch;"],
      [
        "set touch(value) { this.nested.owner = value; }",
        "box.touch = system;"
      ],
      ["touch() { this.nested.owner = system; }", "box.touch();"]
    ])(
      "does not infer nested shape through executable siblings: %s",
      (member, use) => {
        const { graph, run } = fixture({
          "/project/factory.ts": "export const system = { css: () => 'red' };",
          "/project/wrapper.ts": `import { system } from './factory.ts';
          const box = { nested: { owner: { css: () => 'independent' } }, ${member} };
          const nested = box.nested;
          ${use}
          export const alias = nested.owner;`
        });
        const result = run(graph.objectExportOrigins("/project/wrapper.ts"));

        expect(result.exports['["alias"]']).toBeUndefined();
        expect(result.unknownExports).toContain('["alias"]');
      }
    );

    it.each([
      [
        "a closed function beside authoring",
        "export function alias() { return 'ok'; }",
        "alias();",
        true,
        "red"
      ],
      [
        "an empty class beside authoring",
        "export class alias {}",
        "new alias();",
        true,
        "red"
      ],
      [
        "an invoked function capturing the selected receiver",
        "export function alias() { system.css = () => 'blue'; }",
        "alias();",
        false,
        "blue"
      ],
      [
        "a function parameter default mutating the selected receiver",
        "export function alias(value = (system.css = () => 'blue')) { return 'ok'; }",
        "alias();",
        false,
        "blue"
      ],
      [
        "a closed function returning its receiver argument",
        "export function alias(value) { return value; }",
        "const receiver = alias(system); receiver.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "a closed function whose unknown properties escape through a cycle",
        "import './attach.ts'; export function alias() { return 'ok'; }",
        "function edit(value) { value.owner.css = () => 'blue'; } edit(alias);",
        false,
        "blue"
      ],
      ...[
        ["function", "() => {}", '["owner"]', "alias.owner = system;"],
        ["RegExp", "/pattern/", '["owner"]', "alias.owner = system;"],
        ["array", "[system]", '["0"]', ""]
      ].flatMap(([name, expression, access, initialize]) => [
        [
          `an opaque consumer of a fresh ${name}`,
          `export const alias = ${expression}; ${initialize}`,
          `function mutate(value) { value${access}.css = () => 'blue'; } mutate(alias);`,
          false,
          "blue"
        ] as const,
        [
          `a replaced slot in a fresh ${name}`,
          `export const alias = ${expression}; ${initialize}`,
          `alias${access} = {};`,
          false,
          "red"
        ] as const
      ]),
      ...[
        ["sequence", "(1, system)"],
        ["array selection", "[system][0]"],
        ["call", "(value => value)(system)"],
        ["optional call", "(value => value)?.(system)"],
        ["constructor", "new (function () { return system; })()"],
        ["tagged template", "(() => system)`owner`"],
        ["assignment", "(selected = system)"]
      ].flatMap(([name, expression]) => [
        [
          `an opaque ${name} receiver alias`,
          `let selected; export const alias = ${expression};`,
          "alias.css = () => 'blue';",
          false,
          "blue"
        ] as const,
        [
          `a readonly opaque ${name} receiver alias`,
          `let selected; export const alias = ${expression};`,
          "void typeof alias.css;",
          false,
          "red"
        ] as const
      ]),
      [
        "a property added after allocation",
        "export const wrapper = {}; wrapper.owner = system;",
        "wrapper.owner.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "a typeof read invokes an inherited getter on a retained child",
        `const box = { nested: { owner: { css: () => "independent" } } };
          const nested = box.nested;
          Object.defineProperty(Object.prototype, "provenanceTouch", {
            configurable: true, get() { this.owner = system; }
          });
          try { void typeof box.nested.provenanceTouch; }
          finally { delete Object.prototype.provenanceTouch; }
          export const alias = nested.owner;`,
        "alias.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "an opaque initialization callback mutates an exported owner through a cycle",
        `import { mutate } from './mutator.ts';
          export const box = { owner: { css: () => "independent" } };
          mutate();
          export const alias = box.owner;`,
        "alias.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "a property added through a local alias",
        "export const wrapper = {}; const alias = wrapper; alias.owner = system;",
        "wrapper.owner.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "a receiver inherited through a prototype",
        "export const wrapper = { __proto__: { owner: system } };",
        "wrapper.owner.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "a conditional receiver alias",
        "export const alias = true ? system : {};",
        "alias.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "a logical AND receiver alias",
        "export const alias = true && system;",
        "alias.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "a logical OR receiver alias",
        "export const alias = false || system;",
        "alias.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "a nullish receiver alias",
        "export const alias = null ?? system;",
        "alias.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "a nested conditional receiver alias",
        "export const wrapper = { nested: { owner: true ? system : {} } };",
        "wrapper.nested.owner.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "a readonly conditional receiver alias",
        "export const alias = true ? system : {};",
        "void typeof alias.css;",
        false,
        "red"
      ],
      [
        "captured owner followed by replacement",
        `const box = { owner: system };
          export const alias = box.owner;
          box.owner = { css: () => "independent" };`,
        "alias.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "nested captured owner followed by replacement",
        `const box = { nested: { owner: system } };
          export const alias = box.nested.owner;
          box.nested = { owner: { css: () => "independent" } };`,
        "alias.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "known inline object spread",
        "export const wrapper = { ...{ system } };",
        "wrapper.system.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "known aliased nested spread",
        `const shared = { system };
          const copy = { ...shared };
          export const wrapper = { nested: { ...copy } };`,
        "wrapper.nested.system.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "last spread wins over an independent member",
        `export const wrapper = {
          system: { css: () => "independent" }, ...{ ['system']: system }
        };`,
        "wrapper.system.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "an independent final member overrides a spread",
        `export const wrapper = {
          ...{ system }, system: { css: () => "independent" }
        };`,
        "wrapper.system.css = () => 'blue';",
        true,
        "red"
      ],
      [
        "a shallow copied receiver has an independent method slot",
        "export const wrapper = { ...system };",
        "wrapper.css = () => 'blue';",
        true,
        "red"
      ],
      [
        "a readonly spread wrapper",
        "export const wrapper = { ...{ system } };",
        "void typeof wrapper.system;",
        true,
        "red"
      ],
      [
        "an explicit missing-member read remains uncertified",
        "export const wrapper = { ...system };",
        "void typeof changed.missing; wrapper.css = () => 'blue';",
        false,
        "red"
      ],
      [
        "an independent owner selected before replacement",
        `const box = { owner: { css: () => "independent" } };
          export const alias = box.owner;
          box.owner = system;`,
        "alias.css = () => 'blue';",
        false,
        "red"
      ],
      [
        "a getter selected into a receiver alias",
        `const holder = { get current() { return system; } };
          export const alias = holder.current;`,
        "alias.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "a getter shadows an independent data property",
        `const other = { system: { css: () => 'independent' } };
          export const wrapper = { ...other, get system() { return system; } };`,
        "wrapper.system.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "a setter assignment does not replace a captured getter result",
        `const holder = {
          get current() { return system; }, set current(value) {}
        };
          holder.current = { css: () => 'independent' };
          export const alias = holder.current;`,
        "alias.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "an inherited setter does not create a data slot",
        `const holder = { __proto__: {
          get current() { return system; }, set current(value) {}
        } };
          holder.current = { css: () => 'independent' };
          export const alias = holder.current;`,
        "alias.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "a final data property shadows a getter",
        `export const wrapper = {
          get system() { return system; }, system: { css: () => 'independent' }
        };`,
        "wrapper.system.css = () => 'blue';",
        true,
        "red"
      ],
      [
        "an owner selected after replacement",
        `const box = { owner: { css: () => "independent" } };
          box.owner = system;
          export const alias = box.owner;`,
        "alias.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "an unresolved spread that can retain a receiver",
        `const identity = value => value;
          export const wrapper = { ...identity({ system }) };`,
        "wrapper.system.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "an unresolved spread before an explicit final receiver",
        `const identity = value => value;
          export const wrapper = { ...identity({}), system };`,
        "wrapper.system.css = () => 'blue';",
        false,
        "blue"
      ],
      [
        "an explicit independent member after an unresolved spread",
        `const identity = value => value;
          export const wrapper = {
            ...identity({ system }), system: { css: () => "independent" }
          };`,
        "wrapper.system.css = () => 'blue';",
        false,
        "red"
      ]
    ] as const)(
      "preserves runtime identity for %s",
      (_name, wrapper, mutation, extracted, expected) => {
        const root = mkdtempSync(join(tmpdir(), "module-origin-"));
        const files: Record<string, string> = {
          "factory.ts": "export const system = { css: () => 'red' };",
          "wrapper.ts": `import { system } from './factory.ts'; ${wrapper}`,
          "mutator.ts": `import { box } from './wrapper.ts';
            import { system } from './factory.ts';
            export function mutate() { box.owner = system; }`,
          "attach.ts": `import { alias } from './wrapper.ts';
            import { system } from './factory.ts'; alias.owner = system;`,
          "entry.ts": `import { system } from './factory.ts';
            import * as changed from './wrapper.ts';
            const { ${/\balias\b/.test(mutation) ? "alias" : "wrapper"} } = changed;
            ${mutation}
            export const color = system.css();`
        };

        const execute = (entry: string, extra: Record<string, string> = {}) => {
          const cache = new Map<string, { exports: Record<string, unknown> }>();
          const sources = { ...files, ...extra };
          const load = (name: string): Record<string, unknown> => {
            const id = name.replace(/^\.\//, "");
            const previous = cache.get(id);
            if (previous) return previous.exports;
            if (!(id in sources)) throw new Error(`Unexpected module ${id}`);

            const module = { exports: {} as Record<string, unknown> };
            cache.set(id, module);
            const { code } = transformModule(sources[id], { format: "cjs" });
            new Function("require", "exports", "module", code)(
              load,
              module.exports,
              module
            );
            return module.exports;
          };

          return load(entry);
        };

        try {
          for (const [name, source] of Object.entries(files))
            writeFileSync(join(root, name), source);

          const { code, result } = babelTransform(
            files["entry.ts"],
            { extractCalls: { "./factory.ts": ["system.css"] } },
            { root, filename: join(root, "entry.ts") }
          );
          const original = execute("entry.ts");
          const runtime = execute("entry.ts", {
            "entry.ts": code,
            [result[0]]: result[1]
          });

          expect(original.color).toBe(expected);
          expect(runtime.color).toBe(original.color);
          expect(result[1].includes("system.css")).toBe(extracted);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    );
  });

  it("bounds nested namespace diamonds while retaining demanded aliases", () => {
    const depth = 24;
    const files: Record<string, string> = {
      [`/project/layer-${depth}.ts`]:
        "export const system = { css: rule => rule };"
    };
    for (let index = 0; index < depth; index++)
      files[`/project/layer-${index}.ts`] =
        `export * as left from "./layer-${index + 1}.ts";
         export * as right from "./layer-${index + 1}.ts";`;

    const { graph, run } = fixture(files);
    const modules = Object.keys(files).map((id) => run(graph.load(id)));
    const budget = modules.length ** 2 * 32;
    let bodyReads = 0;
    for (const { program } of modules) {
      const body = program.node.body;
      Object.defineProperty(program.node, "body", {
        get() {
          if (++bodyReads > budget)
            throw new Error("Traversal budget exceeded");
          return body;
        }
      });
    }

    const leaf = run(graph.objectExportOrigins(`/project/layer-${depth}.ts`));
    const demanded = [
      [...Array<string>(depth).fill("left"), "system"],
      [...Array<string>(depth).fill("right"), "system"],
      [
        ...Array.from({ length: depth }, (_, index) =>
          index % 2 === 0 ? "left" : "right"
        ),
        "system"
      ]
    ];
    const origins = run(
      graph.objectExportOrigins("/project/layer-0.ts", demanded)
    );

    expect(leaf.exports['["system"]']).toBeDefined();
    for (const path of demanded)
      expect(origins.exports[JSON.stringify(path)]).toBe(
        leaf.exports['["system"]']
      );
    expect(Object.keys(origins.exports).length).toBeLessThanOrEqual(
      modules.length ** 2
    );
    expect(bodyReads).toBeLessThanOrEqual(budget);
  });

  it("retains sibling namespace reexports while bounding namespace cycles", () => {
    const { graph, run } = fixture({
      "/project/factory.ts": "export const system = { css: rule => rule };",
      "/project/aliases.ts": `export * as first from "./factory.ts";
        export * as second from "./factory.ts";
        export * as cycle from "./barrel.ts";`,
      "/project/barrel.ts": 'export * as ns from "./aliases.ts";'
    });
    const original = run(graph.objectExportOrigins("/project/factory.ts"));
    const { program } = run(graph.load("/project/aliases.ts"));
    const before = JSON.stringify(program.node);
    const origins = run(graph.objectExportOrigins("/project/barrel.ts"));

    expect(original.exports['["system"]']).toBeDefined();
    expect(origins.exports['["ns","first","system"]']).toBe(
      original.exports['["system"]']
    );
    expect(origins.exports['["ns","second","system"]']).toBe(
      original.exports['["system"]']
    );
    expect(Object.keys(origins.exports)).toEqual([
      '["ns","first","system"]',
      '["ns","first","system","css"]',
      '["ns","second","system"]',
      '["ns","second","system","css"]'
    ]);
    expect(JSON.stringify(program.node)).toBe(before);
  });

  it("follows namespace reexports to shared object origins without merging independent exports", () => {
    const { graph, run } = fixture({
      "/project/factory.ts": "export const system = { css: rule => rule };",
      "/project/independent.ts": "export const system = { css: rule => rule };",
      "/project/namespace.ts": `export * as ns from "./factory.ts";
        export * as other from "./independent.ts";`,
      "/project/barrel.ts":
        'export { ns as renamed, other } from "./namespace.ts";'
    });
    const original = run(graph.objectExportOrigins("/project/factory.ts"));
    const origins = run(
      graph.objectExportOrigins("/project/barrel.ts", [["renamed", "system"]])
    );

    expect(original.exports['["system"]']).toBeDefined();
    expect(origins.exports['["renamed","system"]']).toBe(
      original.exports['["system"]']
    );
    expect(origins.exports['["other","system"]']).toBeDefined();
    expect(origins.exports['["other","system"]']).not.toBe(
      original.exports['["system"]']
    );
    expect(origins.exports['["renamed"]']).toBeUndefined();
  });

  it("discovers immutable wrapper values and keeps opaque shapes separate", () => {
    const { graph, run } = fixture({
      "/project/factory.ts": "export const system = { css: rule => rule };",
      "/project/wrapper.ts": `import { system } from "./factory.ts";
        const shared = { system };
        export const wrapper = {
          first: shared, second: shared, copy: { ...system },
          label: "theme"
        };
        export const overwritten = { ['system']: system, system: { ...system } };
        export const selected = { system: { ...system }, ['system']: system };`,
      "/project/opaque.ts": `import { system } from "./factory.ts";
        export const getter = { get opaque() { return system; } };
        export const unknown = { system, [globalThis.key]: {} };`,
      "/project/barrel.ts": 'export { wrapper as renamed } from "./wrapper.ts";'
    });
    const { program } = run(graph.load("/project/wrapper.ts"));
    const { program: opaqueProgram } = run(graph.load("/project/opaque.ts"));
    const before = JSON.stringify(program.node);
    const opaqueBefore = JSON.stringify(opaqueProgram.node);
    const factory = run(graph.objectExportOrigins("/project/factory.ts"));
    const { exports: origins } = run(
      graph.objectExportOrigins("/project/barrel.ts", [["renamed", "second"]])
    );

    expect(factory.exports['["system"]']).toBeDefined();
    expect(origins['["renamed","first","system"]']).toBe(
      factory.exports['["system"]']
    );
    expect(origins['["renamed","second","system"]']).toBe(
      factory.exports['["system"]']
    );
    expect(origins['["renamed","copy"]']).toBeDefined();
    expect(origins['["renamed","copy"]']).not.toBe(
      factory.exports['["system"]']
    );
    expect(origins['["renamed","label"]']).toBeUndefined();
    const own = run(graph.objectExportOrigins("/project/wrapper.ts")).exports;
    expect(own['["overwritten","system"]']).toBeDefined();
    expect(own['["overwritten","system"]']).not.toBe(
      factory.exports['["system"]']
    );
    expect(own['["selected","system"]']).toBe(factory.exports['["system"]']);
    const opaque = run(graph.objectExportOrigins("/project/opaque.ts"));
    expect(opaque.exports['["getter"]']).toBeDefined();
    expect(opaque.exports['["getter","opaque"]']).toBeUndefined();
    expect(opaque.unknownContents).toContain('["getter"]');
    expect(opaque.exports['["unknown","system"]']).toBeUndefined();
    expect(JSON.stringify(program.node)).toBe(before);
    expect(JSON.stringify(opaqueProgram.node)).toBe(opaqueBefore);
  });

  it("bounds shared object discovery across repeated wrapper diamonds", () => {
    const depth = 20;
    const declarations = ["const base = { css: rule => rule };"];
    for (let index = 0; index < depth; index++) {
      const previous = index === 0 ? "base" : `layer${index - 1}`;
      declarations.push(
        `const layer${index} = { left: ${previous}, right: ${previous} };`
      );
    }
    declarations.push(`export { base, layer${depth - 1} as wrapper };`);
    const { graph, run } = fixture({
      "/project/wrapper.ts": declarations.join("\n")
    });
    const { program } = run(graph.load("/project/wrapper.ts"));
    const objects: Array<{
      node: { properties: unknown };
      properties: unknown;
    }> = [];
    program.traverse({
      ObjectExpression(path) {
        objects.push({ node: path.node, properties: path.node.properties });
      }
    });
    const budget = objects.length * 100;
    let propertyReads = 0;
    for (const { node, properties } of objects)
      Object.defineProperty(node, "properties", {
        get() {
          if (++propertyReads > budget)
            throw new Error("Traversal budget exceeded");
          return properties;
        }
      });

    const { exports: origins } = run(
      graph.objectExportOrigins("/project/wrapper.ts")
    );
    expect(origins['["base"]']).toBeDefined();
    expect(
      origins[JSON.stringify(["wrapper", ...Array<string>(depth).fill("left")])]
    ).toBe(origins['["base"]']);
    expect(propertyReads).toBeLessThanOrEqual(budget);
  });

  it("keeps destructured export origins distinct from their initializer", () => {
    const { graph, run } = fixture({
      "/project/factory.ts": `export const preset = { inner: { color: "red" } };
        export const { ...copy } = preset;
        export const { inner: selected } = preset;
        export const direct = preset.inner;`,
      "/project/barrel.ts":
        'export { preset, copy, selected, direct } from "./factory.ts";'
    });
    const {
      exports: origins,
      unknownExports,
      ownDataPaths,
      closedDataPaths
    } = run(
      graph.objectExportOrigins("/project/barrel.ts", [["preset", "inner"]])
    );

    expect(origins['["preset"]']).toBeDefined();
    expect(origins['["copy"]']).toBeDefined();
    expect(origins['["copy"]']).not.toBe(origins['["preset"]']);
    expect(unknownExports ?? []).not.toContain('["copy"]');
    expect(ownDataPaths).toContain('["copy","inner"]');
    expect(closedDataPaths).toContain('["copy"]');
    expect(origins['["selected"]']).toBe(origins['["direct"]']);
    expect(origins['["selected"]']).toBe(origins['["preset","inner"]']);
    expect(origins['["selected"]']).not.toBe(origins['["preset"]']);
  });

  it("does not infer a destructured origin from a mutable initializer", () => {
    const { graph, run } = fixture({
      "/project/factory.ts": `export const preset = { inner: { color: "red" } };
        preset.inner = { color: "blue" };
        export const { inner: selected } = preset;`
    });
    const { exports: origins } = run(
      graph.objectExportOrigins("/project/factory.ts")
    );

    expect(origins['["preset"]']).toBeDefined();
    expect(origins['["selected"]']).toBeUndefined();
  });

  it("certifies rest copies with independent roots, shared children and omitted own keys", () => {
    const { graph, run } = fixture({
      "/project/rest.ts": `export const original = {
        omit: { color: 'ignored' }, shared: { color: 'red' }, label: 'red'
      };
      export const { omit, ...copy } = original;`
    });
    const result = run(graph.objectExportOrigins("/project/rest.ts"));
    expect(result.exports['["copy"]']).toBeDefined();
    expect(result.exports['["copy"]']).not.toBe(result.exports['["original"]']);
    expect(result.exports['["copy","shared"]']).toBe(
      result.exports['["original","shared"]']
    );
    expect(result.exports['["copy","omit"]']).toBeUndefined();
    expect(result.ownDataPaths).toContain('["copy","label"]');
    expect(result.ownDataPaths).toContain('["copy","shared","color"]');
    expect(result.ownDataPaths).not.toContain('["copy","omit"]');
    expect(result.closedDataPaths).toContain('["copy"]');
    expect(result.unknownExports ?? []).not.toContain('["copy"]');
  });

  it.each([
    "const preset={get inner(){return opaque()}};export const {...copy}=preset;",
    "const preset=opaque();export const {...copy}=preset;",
    "const preset={inner:{color:'red'}};const {missing=opaque()}=preset;export const {...copy}=preset;",
    "const preset={inner:{color:'red'}};const {[opaque()]:value}=preset;export const {...copy}=preset;"
  ])(
    "does not turn own-read effects into default or initializer authority: %s",
    (source) => {
      const { graph, run } = fixture({ "/project/own-read.ts": source });
      const result = run(graph.objectExportOrigins("/project/own-read.ts"));
      expect(result.exports['["copy"]']).toBeUndefined();
    }
  );

  it("certifies a complete empty rest copy", () => {
    const { graph, run } = fixture({
      "/project/rest.ts": `const original = { label: 'red' };
        export const { label, ...copy } = original;`
    });
    const result = run(graph.objectExportOrigins("/project/rest.ts"));
    expect(result.exports['["copy"]']).toBeDefined();
    expect(result.closedDataPaths).toContain('["copy"]');
    expect(result.ownDataPaths ?? []).not.toContain('["copy","label"]');
    expect(result.unknownExports ?? []).not.toContain('["copy"]');
  });

  it.each([
    [
      "mutable source",
      `const original = { label: 'red' }; original.label = 'blue'; export const { ...copy } = original;`
    ],
    [
      "accessor source",
      `const original = { get label() { return 'red'; } }; export const { ...copy } = original;`
    ],
    [
      "computed exclusion",
      `const original = { label: 'red' }; export const { ['label']: label, ...copy } = original;`
    ],
    [
      "coercing exclusion",
      `const key = { toString() { return 'label'; } }; const original = { label: 'red' }; export const { [key]: label, ...copy } = original;`
    ],
    [
      "opaque source",
      `const original = { label: 'red' }; const identity = value => value; export const { ...copy } = identity(original);`
    ],
    [
      "iterator rest",
      `const original = [{ label: 'red' }]; export const [...copy] = original;`
    ]
  ])("does not certify an uncertain rest copy: %s", (_name, source) => {
    const { graph, run } = fixture({ "/project/rest.ts": source });
    const result = run(graph.objectExportOrigins("/project/rest.ts"));
    expect(result.closedDataPaths ?? []).not.toContain('["copy"]');
    expect([
      ...(result.unknownExports ?? []),
      ...(result.unknownContents ?? [])
    ]).toContain('["copy"]');
  });

  describe("imported destructured helper owners", () => {
    it.each([
      [
        "direct property replacement",
        `const helpers = { style: () => ({ color: "red" }) };
          helpers.style = () => ({ color: "blue" });`,
        "const { style } = helpers;",
        false,
        true
      ],
      [
        "replacement through an alias",
        `const helpers = { style: () => ({ color: "red" }) };
          const alias = helpers;
          alias.style = () => ({ color: "blue" });`,
        "const { style } = helpers;",
        false,
        true
      ],
      [
        "replacement behind a reexport",
        `const helpers = { style: () => ({ color: "red" }) };
          helpers.style = () => ({ color: "blue" });`,
        "const { style } = helpers;",
        true,
        true
      ],
      [
        "nested property replacement",
        `const helpers = { nested: { style: () => ({ color: "red" }) } };
          helpers.nested.style = () => ({ color: "blue" });`,
        "const { nested: { style } } = helpers;",
        false,
        true
      ],
      [
        "array element replacement",
        `const helpers = [() => ({ color: "red" })];
          helpers[0] = () => ({ color: "blue" });`,
        "const [style] = helpers;",
        false,
        true
      ],
      [
        "aliased exported owner",
        `const original = { style: () => ({ color: "red" }) };
          const helpers = original;
          original.style = () => ({ color: "blue" });`,
        "const { style } = helpers;",
        false,
        true
      ],
      [
        "type-wrapped initializer",
        `const helpers = ({ style: () => ({ color: "red" }) } as const);
          helpers.style = () => ({ color: "blue" });`,
        "const { style } = helpers;",
        false,
        true
      ],
      [
        "unchanged owner",
        'const helpers = { style: () => ({ color: "red" }) };',
        "const { style } = helpers;",
        false,
        false
      ],
      [
        "independent object replacement",
        `const helpers = { style: () => ({ color: "red" }) };
          const other = { style: helpers.style };
          other.style = () => ({ color: "blue" });`,
        "const { style } = helpers;",
        false,
        false
      ],
      [
        "unchanged array behind a reexport",
        'const helpers = [() => ({ color: "red" })];',
        "const [style] = helpers;",
        true,
        false
      ]
    ] as const)("%s", (_name, dependency, selection, barrel, mutated) => {
      const loader = "ts";
      const { code } = transformModule(dependency, { loader });
      const helpers = new Function(`${code}; return helpers;`)();
      const actual = new Function(
        "helpers",
        `${selection} return style().color;`
      )(helpers);

      expect(actual).toBe(mutated ? "blue" : "red");

      const { graph, run } = fixture({
        "/project/dependency.ts": `${dependency} export { helpers };`,
        "/project/barrel.ts": 'export { helpers } from "./dependency.ts";',
        "/project/entry.ts": `import { helpers } from "./${barrel ? "barrel" : "dependency"}.ts";
            ${selection} style();`
      });
      const module = run(graph.load("/project/entry.ts"));
      const statement = module.program.get("body").at(-1)!;
      if (!statement.isExpressionStatement())
        throw new Error("Expected a helper call");

      const evaluate = () =>
        run(
          evaluateStaticExpression(graph, module, statement.get("expression"))
        );

      if (mutated) {
        expect(evaluate).toThrow(StaticExpressionDeopt);
      } else {
        expect(evaluate()).toMatchObject({
          type: "ObjectExpression",
          properties: [{ value: { type: "StringLiteral", value: actual } }]
        });
      }
    });
  });

  it("bounds origin discovery across repeated diamond reexports", () => {
    const files: Record<string, string> = {
      "/project/layer-30.ts": 'export const preset = { color: "red" };'
    };

    for (let index = 0; index < 30; index++) {
      files[`/project/layer-${index}.ts`] =
        `export * from "./left-${index}.ts"; export * from "./right-${index}.ts";`;
      for (const side of ["left", "right"])
        files[`/project/${side}-${index}.ts`] =
          `export * from "./layer-${index + 1}.ts";`;
    }

    const { graph, run } = fixture(files);
    const modules = Object.keys(files).map((id) => run(graph.load(id)));
    const budget = modules.length * 20;
    let bodyReads = 0;

    // Bound actual traversal work, since cached loads hide repeated walks.
    for (const { program } of modules) {
      const body = program.node.body;
      Object.defineProperty(program.node, "body", {
        get() {
          if (++bodyReads > budget)
            throw new Error("Traversal budget exceeded");
          return body;
        }
      });
    }

    const leaf = run(graph.objectExportOrigins("/project/layer-30.ts"));
    const root = run(graph.objectExportOrigins("/project/layer-0.ts"));

    expect(leaf.exports['["preset"]']).toBeDefined();
    expect(root.exports['["preset"]']).toBe(leaf.exports['["preset"]']);
    expect(bodyReads).toBeLessThanOrEqual(budget);
  });

  it("retains origins through cycles and rejects ambiguous diamond exports", () => {
    const { graph, run } = fixture({
      "/project/root.ts": 'export * from "./a.ts"; export * from "./b.ts";',
      "/project/a.ts":
        'export * from "./root.ts"; export * from "./shared.ts";',
      "/project/b.ts": 'export * from "./shared.ts";',
      "/project/shared.ts": 'export const preset = { color: "red" };',
      "/project/other.ts": 'export const preset = { color: "blue" };',
      "/project/ambiguous.ts":
        'export * from "./root.ts"; export * from "./other.ts";'
    });
    const shared = run(graph.objectExportOrigins("/project/shared.ts"));

    expect(shared.exports['["preset"]']).toBeDefined();
    expect(run(graph.objectExportOrigins("/project/root.ts")).exports).toEqual(
      shared.exports
    );
    expect(run(graph.objectExportOrigins("/project/a.ts")).exports).toEqual(
      shared.exports
    );
    expect(
      run(graph.objectExportOrigins("/project/ambiguous.ts")).exports
    ).toEqual({});
  });

  it("resolves selected helper values without assigning primitive origins", () => {
    const { graph, run } = fixture({
      "/project/factory.ts": `const preset = {
        label: "theme", css: rule => rule
      };
      export const { label, css: make } = preset;`
    });
    const module = run(graph.load("/project/factory.ts"));
    const selected = run(graph.resolveExport(module, "make", new Set()));

    expect(
      selected &&
        !("external" in selected) &&
        selected.path.isArrowFunctionExpression()
    ).toBe(true);
    const origins = run(graph.objectExportOrigins(module.id));
    expect(origins.exports['["label"]']).toBeUndefined();
    expect(origins.exports['["make"]']).toBeDefined();
    expect(origins.unknownExports ?? []).not.toContain('["make"]');
    expect(origins.unknownContents).toEqual(['["make"]']);
    expect(origins.inertInvocations?.['["make"]']).toBe("call");
  });

  describe("destructured array helper selection", () => {
    const red = '() => ({ color: "red" })';
    const blue = '() => ({ color: "blue" })';
    const green = '() => ({ color: "green" })';

    it.each([
      `const [, make] = [...[${red}, ${blue}], ${green}];`,
      `const [[, make]] = [[...[${red}, ${blue}], ${green}]];`,
      `const { helpers: [, make] } = { helpers: [...[${red}, ${blue}], ${green}] };`,
      `const [, [make]] = [...[[${red}], [${blue}]], [${green}]];`
    ])(
      "defers a selection shifted by a preceding spread: %s",
      (declaration) => {
        expect(new Function(`${declaration} return make().color;`)()).toBe(
          "blue"
        );
        const source = `${declaration} export { make };`;
        const { graph, run } = fixture({ "/project/factory.ts": source });
        const module = run(graph.load("/project/factory.ts"));
        const selected = run(graph.resolveExport(module, "make", new Set()));
        const helper =
          selected && !("external" in selected)
            ? source.slice(selected.path.node.start!, selected.path.node.end!)
            : null;

        expect(helper).toBeNull();
      }
    );

    it("deopts static calls to a helper selected after a spread", () => {
      const declaration = `const [, make] = [...[${red}, ${blue}], ${green}];`;
      const { graph, run } = fixture({
        "/project/factory.ts": `${declaration} make();`
      });
      const module = run(graph.load("/project/factory.ts"));
      const statement = module.program.get("body").at(-1)!;
      if (!statement.isExpressionStatement())
        throw new Error("Expected a helper call");

      expect(new Function(`${declaration} return make().color;`)()).toBe(
        "blue"
      );
      expect(() =>
        run(
          evaluateStaticExpression(graph, module, statement.get("expression"))
        )
      ).toThrow(StaticExpressionDeopt);
    });

    it.each([
      `const [, make] = [${red}, ${blue}];`,
      `const [[, make]] = [[${red}, ${blue}]];`,
      `const [make] = [${blue}, ...[${red}, ${green}]];`,
      `const { helpers: [make] } = { helpers: [${blue}, ...[${red}, ${green}]] };`,
      `const [[make]] = [[${blue}, ...[${red}]], ...[[${green}]]];`
    ])("retains a selection unaffected by later spreads: %s", (declaration) => {
      expect(new Function(`${declaration} return make().color;`)()).toBe(
        "blue"
      );
      const source = `${declaration} export { make };`;
      const { graph, run } = fixture({ "/project/factory.ts": source });
      const module = run(graph.load("/project/factory.ts"));
      const selected = run(graph.resolveExport(module, "make", new Set()));

      expect(selected && !("external" in selected)).toBe(true);
      if (!selected || "external" in selected)
        throw new Error("Expected a local helper");
      const { start, end } = selected.path.node;
      expect(typeof start).toBe("number");
      expect(typeof end).toBe("number");
      const helper = source.slice(start!, end!);
      expect(new Function(`return (${helper})().color;`)()).toBe("blue");
    });
  });

  it.each([false, true])(
    "parses TypeScript dependencies despite forwarded Flow plugins with cached parsing=%s",
    (cached) => {
      const cache = cached ? new SourceAstCache() : undefined;
      const plugins = [
        "jsx",
        ["flow", { all: true }],
        "flowComments",
        ["decorators", { decoratorsBeforeExport: false }]
      ] satisfies NonNullable<
        NonNullable<TransformOptions["parserOpts"]>["plugins"]
      >;

      for (const extension of ["ts", "tsx", "mts", "cts"]) {
        const source = `export @sealed class Factory {}
          export const rule = ${extension === "tsx" ? '{ color: "red" } as const' : '<const>{ color: "red" }'};
          ${extension === "tsx" ? "export const view = <div />;" : ""}`;
        const program = parseModuleProgram(
          `/project/factory.${extension}`,
          source,
          undefined,
          cache,
          plugins
        );

        expect(program.scope.hasBinding("rule")).toBe(true);
        expect(program.node.body[0]).toMatchObject({
          type: "ExportNamedDeclaration",
          declaration: { type: "ClassDeclaration", decorators: [{}] }
        });
        if (extension === "tsx")
          expect(program.scope.hasBinding("view")).toBe(true);
      }

      expect(
        plugins.map((entry) => (typeof entry === "string" ? entry : entry[0]))
      ).toContain("flow");
    }
  );

  it.each([false, true])(
    "preserves Flow syntax instead of appending TypeScript with cached parsing=%s",
    (cached) => {
      const cache = cached ? new SourceAstCache() : undefined;
      const configurations = [
        ["flow"],
        [["flow", { all: true }]]
      ] satisfies NonNullable<
        NonNullable<TransformOptions["parserOpts"]>["plugins"]
      >[];

      for (const plugins of configurations) {
        const program = parseModuleProgram(
          "/project/view.jsx",
          `type Props = {| color: string |};
           export const View = (props: Props) => <div>{props.color}</div>;`,
          true,
          cache,
          plugins
        );

        expect(program.node.body[0]).toMatchObject({
          type: "TypeAlias",
          right: { type: "ObjectTypeAnnotation", exact: true }
        });
        expect(program.scope.hasBinding("View")).toBe(true);
      }
    }
  );

  it.each([false, true])(
    "preserves configured decorator syntax with cached parsing=%s",
    (cached) => {
      const program = parseModuleProgram(
        "/project/view.tsx",
        "export @sealed class View { render(): unknown { return <div />; } }",
        true,
        cached ? new SourceAstCache() : undefined,
        [["decorators", { decoratorsBeforeExport: false }]]
      );

      expect(program.node.body[0]).toMatchObject({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "ClassDeclaration",
          decorators: [{ expression: { name: "sealed" } }]
        }
      });
    }
  );

  it.each([false, true])(
    "keeps user TypeScript plugin options over defaults with cached parsing=%s",
    (cached) => {
      const cache = cached ? new SourceAstCache() : undefined;
      const parse = (disallowAmbiguousJSXLike: boolean) =>
        parseModuleProgram(
          "/project/generic.ts",
          "export const identity = <T>(value: T) => value;",
          false,
          cache,
          [["typescript", { disallowAmbiguousJSXLike }]]
        );

      expect(parse(false).scope.hasBinding("identity")).toBe(true);
      expect(() => parse(true)).toThrow("reserved in files with the .mts");
    }
  );

  it.each([false, true])(
    "keeps TS assertions and TSX syntax filename-specific with cached parsing=%s",
    (cached) => {
      const cache = cached ? new SourceAstCache() : undefined;
      const plugins = [
        "jsx",
        ["decorators", { decoratorsBeforeExport: false }]
      ] satisfies NonNullable<
        NonNullable<TransformOptions["parserOpts"]>["plugins"]
      >;
      const program = parseModuleProgram(
        "/project/factory.ts",
        'export @sealed class Factory {} export const rule = <const>{ color: "red" };',
        undefined,
        cache,
        plugins
      );
      const view = parseModuleProgram(
        "/project/view.tsx",
        "export const view = <div />;",
        undefined,
        cache,
        plugins
      );
      const javascript = parseModuleProgram(
        "/project/view.js",
        "export const view = <div />;",
        undefined,
        cache,
        plugins
      );

      expect(program.scope.hasBinding("rule")).toBe(true);
      expect(view.scope.hasBinding("view")).toBe(true);
      expect(javascript.scope.hasBinding("view")).toBe(true);
    }
  );

  it.each([
    ["entry.ts", true, "other"],
    ["entry.mts", true, "raw"],
    ["entry.ts", false, "raw"],
    ["entry.mts", false, "raw"]
  ] as const)(
    "resolves esbuild default interop for %s with __esModule=%s",
    async (filename, marker, expected) => {
      const { code } = await transformWithEsbuild(
        'import make from "./factory.cjs"; export const value = make();',
        filename,
        { format: "cjs" }
      );
      const { graph, run } = fixture({
        "/project/factory.cjs": `function raw() {} function other() {} module.exports = raw; module.exports.__esModule = ${marker}; module.exports.default = other;`
      });
      const program = parseModuleProgram("/project/entry.cjs", code);
      const owner = { id: "/project/entry.cjs", program };
      const targets: string[] = [];

      program.traverse({
        CallExpression(path) {
          if (!path.get("callee").isSequenceExpression()) return;

          const target = run(
            graph.valueTarget(owner, path.get("callee"), new Set())
          );
          if (
            target &&
            !("external" in target) &&
            target.path.isFunctionDeclaration()
          )
            targets.push(target.path.node.id!.name);
        }
      });

      expect(targets).toEqual([expected]);
    }
  );

  it("resolves namespace calls through reexports and keeps loading modes separate", () => {
    const { graph, run, requests } = fixture({
      "/project/import.ts": 'export { gap } from "./helper.ts";',
      "/project/helper.ts": "export const gap = n => n * 4;",
      "/project/require.ts": "exports.gap = n => n * 8;"
    });

    const program = parseModuleProgram(
      "/project/App.tsx",
      'import * as helpers from "package"; const cjs = require("package"); helpers.gap(2); cjs.gap(2);'
    );

    const owner = { id: "/project/App.tsx", program };
    const targets: string[] = [];
    program.traverse({
      CallExpression(path) {
        if (!path.get("callee").isMemberExpression()) return;

        const target = run(
          graph.valueTarget(owner, path.get("callee"), new Set())
        );

        if (target && !("external" in target)) targets.push(target.module.id);
      }
    });

    expect(targets).toEqual(["/project/helper.ts", "/project/require.ts"]);
    expect(
      requests
        .filter((request) => request.source === "package")
        .map((request) => request.mode)
    ).toEqual(["import", "require"]);
  });

  it("does not resolve cycles or ambiguous star exports to arbitrary definitions", () => {
    const { graph, run } = fixture({
      "/project/cycle.ts": 'export { gap } from "./cycle.ts";',
      "/project/barrel.ts": 'export * from "./a.ts"; export * from "./b.ts";',
      "/project/a.ts": "export const gap = n => n;",
      "/project/b.ts": "export const gap = n => n * 2;"
    });

    const cycle = run(graph.load("/project/cycle.ts"));

    expect(run(graph.resolveExport(cycle, "gap", new Set()))).toBeNull();

    const barrel = run(graph.load("/project/barrel.ts"));

    expect(() => run(graph.resolveExport(barrel, "gap", new Set()))).toThrow(
      "Ambiguous export"
    );
  });

  it("caches CommonJS export shapes within each graph, including default lookups", () => {
    const shape = vi.spyOn(commonJs, "commonJsExports");
    try {
      const files = {
        "/project/helper.cjs":
          "function make() {} module.exports = make; module.exports.named = make;"
      };
      const { graph, run } = fixture(files);
      const helper = run(graph.load("/project/helper.cjs"));

      for (const name of ["named", "default", "named", "default"]) {
        const target = run(
          graph.importTarget(helper, "./helper.cjs", name, new Set())
        );
        expect(
          target &&
            !("external" in target) &&
            target.path.isFunctionDeclaration()
        ).toBe(true);
      }
      expect(shape).toHaveBeenCalledTimes(1);

      const other = fixture(files);
      expect(
        other.run(other.graph.resolveExport(helper, "named", new Set()))
      ).not.toBeNull();
      expect(shape).toHaveBeenCalledTimes(2);
    } finally {
      shape.mockRestore();
    }
  });

  it("rejects reassigned exported helpers", () => {
    const { graph, run } = fixture({
      "/project/helper.ts": "export let gap = n => n; gap = other;"
    });

    const module = run(graph.load("/project/helper.ts"));

    expect(() => run(graph.resolveExport(module, "gap", new Set()))).toThrow(
      "Mutable binding"
    );
  });
});

it.each([false, true])(
  "projects authoring wrapper runtime arity through erased this: %s",
  (erased) => {
    const self = erased ? "this:void," : "";
    const { graph, run } = fixture(
      {
        "/project/provider.ts": `import {style} from '@vanilla-extract/css';function base(${self}color:string,fallback:string){return style({color})}export function wrap(${self}color:string,fallback:string){return base(color,fallback)}`
      },
      {
        resolutions: {
          "@vanilla-extract/css": fixtureRequire.resolve("@vanilla-extract/css")
        }
      }
    );
    expect(
      run(graph.objectExportOrigins("/project/provider.ts")).authoringCalls?.[
        '["wrap"]'
      ]
    ).toMatchObject({
      parameterCount: 2,
      arguments: [
        {
          kind: "object",
          entries: [
            {
              kind: "property",
              key: "color",
              value: { kind: "parameter", index: 0 }
            }
          ]
        }
      ]
    });
  }
);
