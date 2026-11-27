import { expect, it } from "vitest";
import { parseModuleProgram } from "../moduleGraph.js";
import type { ProgramScope } from "../types.js";
import {
  proveAuthoringCallSite,
  sourceRecipeInvocationResult
} from "./authoringCallSite.js";

function inspect(setup: string) {
  const program = parseModuleProgram(
    "/project/entry.ts",
    `import {makeStyle, makeRecipe} from './factory'; ${setup}`
  );
  const endpoint = {
    id: "/compiler/endpoint",
    version: "test",
    sourceHash: "test"
  };
  (program.scope as ProgramScope).minchoData = {
    imports: new Map(),
    bindings: [],
    nodes: [],
    cssFile: "",
    extractCalls: {
      imports: { "./factory": ["makeStyle", "makeRecipe"] },
      localBindings: [],
      protectedFunctions: [],
      dependencies: [],
      fingerprint: "source-summary",
      resolvedSources: {
        import: { "./factory": "/project/factory.ts" },
        require: {}
      },
      exportOrigins: {
        "/project/factory.ts": {
          esModule: true,
          exports: { '["makeStyle"]': "style", '["makeRecipe"]': "recipe" },
          authoringCalls: {
            '["makeStyle"]': {
              terminal: "style",
              parameterCount: 1,
              arguments: [{ kind: "parameter", index: 0 }],
              captures: "none",
              endpoint
            },
            '["makeRecipe"]': {
              terminal: "recipe",
              parameterCount: 1,
              arguments: [{ kind: "parameter", index: 0 }],
              captures: "argument-graph",
              endpoint
            }
          }
        }
      }
    }
  };
  const proofs: Array<string | undefined> = [];
  program.traverse({
    CallExpression(call) {
      if (call.get("callee").isIdentifier({ name: "makeRecipe" }))
        proofs.push(proveAuthoringCallSite(call)?.terminal);
      if (call.get("callee").isIdentifier({ name: "button" }))
        proofs.push(sourceRecipeInvocationResult(call)?.kind);
    }
  });
  return proofs;
}
it("accepts private literal recipe inputs with a source-proved style result", () => {
  expect(
    inspect(
      `const base=makeStyle({color:'red'}); const button=makeRecipe({base,variants:{tone:{quiet:{opacity:0.5}}}}); button({get tone(){return observe();}});`
    )
  ).toEqual(["recipe", "primitive"]);
});
it.each([
  "const variants={tone:{quiet:{opacity:0.5}}}; const button=makeRecipe({variants});",
  'const options={base:{color:"red"}}; const button=makeRecipe(options);',
  "const button=makeRecipe({get base(){return observe();}});",
  'const button=makeRecipe({[key]:{color:"red"}});',
  "const button=makeRecipe({...unknown});",
  "const button=makeRecipe({base:unknown()});",
  'const button=makeRecipe({__proto__:null,base:{color:"red"}});'
])("rejects aliased or observable recipe configuration: %s", (source) => {
  expect(inspect(source)).toEqual([undefined]);
});
