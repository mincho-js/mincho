import { describe, expect, it } from "vitest";
import { parseModuleProgram } from "../moduleGraph.js";
import type { ProgramScope } from "../types.js";
import { babelTransform } from "../testUtils/plugin.js";
import { compiledRecipeResultProof } from "./compiledRecipeResult.js";

function proof(source: string, receipt = true) {
  const program = parseModuleProgram("/project/consumer.ts", source);
  (program.scope as ProgramScope).minchoData = {
    imports: new Map(),
    bindings: [],
    nodes: [],
    cssFile: "",
    extractCalls: {
      imports: {},
      localBindings: [],
      protectedFunctions: [],
      dependencies: [],
      fingerprint: "receipt",
      resolvedSources: {
        import: { "./theme.css": "/project/theme.css" },
        require: { "./theme.css": "/project/theme.css" }
      },
      exportOrigins: {
        "/project/theme.css": {
          exports: { '["recipe"]': "recipe" },
          esModule: true,
          readablePaths: ['["recipe"]'],
          ...(receipt
            ? { recipeInvocations: { '["recipe"]': "class-string" as const } }
            : {})
        }
      }
    }
  };
  let result;
  let visited = false;
  program.traverse({
    CallExpression(call) {
      if (
        ["recipe", "ns.recipe", "recipe.props"].includes(
          call.get("callee").toString()
        )
      ) {
        visited = true;
        result = compiledRecipeResultProof(call);
      }
    }
  });
  expect(visited).toBe(true);
  return result;
}

describe("compiled recipe result receipts", () => {
  it("certifies only the result while preserving unknown argument effects", () => {
    expect(
      proof(
        'import {recipe} from "./theme.css"; recipe({get tone() { return observe(); }});'
      )
    ).toEqual({ kind: "primitive" });
  });
  it("does not infer a receipt from an import name or CSS suffix", () => {
    expect(
      proof('import {recipe} from "./theme.css"; recipe();', false)
    ).toBeUndefined();
  });
  it("rejects a reassigned callable", () => {
    expect(
      proof(
        'import {recipe as original} from "./theme.css"; let recipe=original; recipe=()=>({}); recipe();'
      )
    ).toBeUndefined();
  });
  it("rejects mutated namespace endpoints", () => {
    expect(
      proof(
        'import * as ns from "./theme.css"; ns.recipe=()=>({}); ns.recipe();'
      )
    ).toBeUndefined();
  });
  it("rejects an escaped namespace even with a result receipt", () => {
    expect(
      proof('import * as ns from "./theme.css"; observe(ns); ns.recipe();')
    ).toBeUndefined();
  });
  it("does not certify the recipe's props method", () => {
    expect(
      proof('import {recipe} from "./theme.css"; recipe.props({size: 4});')
    ).toBeUndefined();
  });

  it("does not hide argument getter mutations from call extraction", () => {
    expect(() =>
      babelTransform(
        `
      import {recipe} from "./theme.css";
      const {css} = require("test-preset");
      const style = { color: "red" };
      recipe({get tone() { style.color = "blue"; return "quiet"; }});
      export const cls = css(style);`,
        {
          preparedExtractCalls: {
            imports: {},
            requires: { "test-preset": ["css"] },
            localBindings: [],
            protectedFunctions: [],
            dependencies: [],
            fingerprint: "getter-receipt",
            resolvedSources: {
              import: { "./theme.css": "/project/theme.css" },
              require: {}
            },
            exportOrigins: {
              "/project/theme.css": {
                exports: { '["recipe"]': "recipe" },
                esModule: true,
                readablePaths: ['["recipe"]'],
                recipeInvocations: { '["recipe"]': "class-string" }
              }
            }
          }
        }
      )
    ).toThrow(/Mutated argument binding style/);
  });
});
