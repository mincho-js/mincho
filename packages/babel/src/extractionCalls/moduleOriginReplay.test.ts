import * as mutation from "../staticCssEval/sameFile/mutationAliases.js";
import { describe, expect, it, vi } from "vitest";
import { transformSync } from "@babel/core";
import { transformSync as compileModule } from "esbuild";
import { minchoBabelPlugin } from "../index.js";
import type { PreparedExtractCalls } from "./types.js";

// Validated graph contracts and exact registered literal loaders can establish
// provenance. Neither grants readonly, invocation purity, or fresh identity.
function transform(
  extra = "",
  validated = true,
  loader = "require('./factory')",
  before = ""
) {
  const proofs: string[] = [];
  const original = mutation.analyzeAliasedStaticCssEvalBindingMutation;
  const spy = vi
    .spyOn(mutation, "analyzeAliasedStaticCssEvalBindingMutation")
    .mockImplementation((program, binding, options) => {
      const proof = original(program, binding, options);
      if (binding.identifier.name === "defineStyle") proofs.push(proof.kind);
      return proof;
    });
  const endpoint = { id: "/compiler", version: "test", sourceHash: "test" };
  const prepared: PreparedExtractCalls = {
    imports: {},
    requires: { "./factory": ["defineStyle", "makeRecipe"] },
    localBindings: [],
    protectedFunctions: [],
    dependencies: [],
    fingerprint: "test",
    resolvedSources: {
      import: { "./other": "/factory" },
      require: { "./factory": "/factory", "./alias": "/factory" }
    },
    exportOrigins: validated
      ? {
          "/factory": {
            esModule: true,
            exports: { '["defineStyle"]': "style", '["makeRecipe"]': "recipe" },
            readablePaths: ['["defineStyle"]', '["makeRecipe"]'],
            authoringCalls: {
              '["defineStyle"]': {
                terminal: "style",
                parameterCount: 1,
                captures: "none",
                arguments: [{ kind: "parameter", index: 0 }],
                endpoint
              },
              '["makeRecipe"]': {
                terminal: "recipe",
                parameterCount: 1,
                captures: "argument-graph",
                arguments: [{ kind: "parameter", index: 0 }],
                endpoint
              }
            }
          }
        }
      : {}
  };
  const options = {
    preparedExtractCalls: prepared,
    extractCalls: { "./factory": ["defineStyle", "makeRecipe"] },
    result: ["", ""] as [string, string],
    optimize: { pureFunctions: false }
  };
  const source = `${before} const {defineStyle, makeRecipe} = ${loader}; ${extra}
      const className = defineStyle({color:'red'});
      const button = makeRecipe({base:className});
      exports.button = button;`;
  let code = "";
  try {
    code =
      transformSync(source, {
        filename: "/project/entry.cjs",
        babelrc: false,
        configFile: false,
        plugins: [[minchoBabelPlugin(), options]]
      })?.code ?? "";
  } catch {
    /* Rejection may precede the provenance query. */
  } finally {
    spy.mockRestore();
  }
  return { source, code, sidecar: options.result[1], proofs };
}

describe("validated loader origin during replay", () => {
  it("preserves CJS callee provenance through argument analysis (not full replay)", () => {
    expect(transform().proofs).toContain("proved-unmodified");
  });
  it("preserves exact registered literal loader provenance without source contracts", () => {
    expect(transform("", false).proofs).toContain("proved-unmodified");
  });
  it.each([
    ["literal", "const {defineStyle,makeRecipe}=require('test-preset');", true],
    [
      "initialized alias",
      "const request='test-preset'; const {defineStyle,makeRecipe}=require(request);",
      true
    ],
    [
      "const TDZ",
      "const {defineStyle,makeRecipe}=require(request); const request='test-preset';",
      false
    ],
    [
      "let TDZ",
      "const {defineStyle,makeRecipe}=require(request); let request='test-preset';",
      false
    ],
    [
      "var uninitialized",
      "const {defineStyle,makeRecipe}=require(request); var request='test-preset';",
      false
    ],
    [
      "alias initializer TDZ",
      "const alias=request; const request='test-preset'; const {defineStyle,makeRecipe}=require(alias);",
      false
    ]
  ] as const)(
    "preserves loader evaluation and provider effects: %s",
    (_label, prefix, extracts) => {
      const source = `${prefix} const cls=defineStyle({color:'red'}); export const button=makeRecipe({base:cls});`;
      const events: string[] = [];
      const provider = {
        defineStyle: (style: { color: string }) => {
          events.push("style");
          return style.color;
        },
        makeRecipe: (recipe: { base: string }) => {
          events.push("recipe");
          return recipe.base;
        }
      };
      const execute = (input: string, modules: Record<string, unknown>) => {
        const module = { exports: {} };
        const compiled = compileModule(input, {
          format: "cjs",
          target: "esnext"
        }).code;
        new Function("require", "exports", "module", compiled)(
          (request: string) => {
            events.push(`require:${String(request)}`);
            if (!(request in modules)) throw new TypeError("Unknown module");
            return modules[request];
          },
          module.exports,
          module
        );
        return module.exports;
      };
      const modules = { "test-preset": provider };
      let originalError: unknown;
      try {
        execute(source, modules);
      } catch (error) {
        originalError = error;
      }
      const originalEvents = [...events];
      events.length = 0;
      const options = {
        result: ["", ""] as [string, string],
        extractCalls: { "test-preset": ["defineStyle", "makeRecipe"] },
        optimize: { pureFunctions: false }
      };
      let output: ReturnType<typeof transformSync> = null;
      let compileError: unknown;
      try {
        output = transformSync(source, {
          filename: "/tmp/loader-order.ts",
          babelrc: false,
          configFile: false,
          plugins: [[minchoBabelPlugin(), options]]
        });
      } catch (error) {
        compileError = error;
      }
      const result = options.result;
      if (compileError) {
        expect(extracts).toBe(false);
        expect(compileError).toBeInstanceOf(SyntaxError);
        expect(result[1]).toBe("");
        expect(events).toEqual([]);
        return;
      }
      if (extracts) expect(result[1]).toContain("defineStyle(");
      else expect(result[1]).toBe("");
      let actualError: unknown;
      try {
        const sidecar = execute(result[1], modules);
        execute(output?.code ?? "", { ...modules, [result[0]]: sidecar });
      } catch (error) {
        actualError = error;
      }
      expect(
        actualError instanceof Error ? actualError.constructor : actualError
      ).toBe(
        originalError instanceof Error
          ? originalError.constructor
          : originalError
      );
      // Runtime imports can load the provider again. Factory calls must never
      // precede a failed original specifier evaluation, nor duplicate on success.
      expect(
        events.filter((event) => event === "style" || event === "recipe")
      ).toEqual(
        originalEvents.filter(
          (event) => event === "style" || event === "recipe"
        )
      );
      if (!extracts) expect(events).toEqual(originalEvents);
    }
  );
  it.each([
    `defineStyle.changed = true;`,
    `require('./factory').defineStyle.changed = true;`,
    `const namespace = require('./factory'); namespace.defineStyle = replacement;`
  ])("does not make source-less registered bindings readonly: %s", (extra) => {
    const result = transform(extra, false);
    expect(result.sidecar).toBe("");
    expect(result.proofs).not.toContain("proved-unmodified");
  });
  it.each([
    "require(dynamicSource)",
    "require('./unknown')",
    "unknownLoader('./factory')"
  ])("does not infer provenance for an unverified loader: %s", (loader) => {
    const result = transform("", false, loader);
    expect(result.sidecar).toBe("");
    expect(result.proofs).not.toContain("proved-unmodified");
  });
  it.each([
    `require('./alias').defineStyle.changed = true;`,
    `import {defineStyle as alias} from './other'; alias.changed = true;`,
    `const unknown = require(dynamicSource);`
  ])("rejects aliases or unvalidated loaders: %s", (extra) => {
    expect(transform(extra).sidecar).toBe("");
  });
});
