import { createReplayAnalysis } from "../extractionCalls/replayAnalysis.js";
import { describe, expect, it } from "vitest";
import { isSidecarSafeCssRuleExpression } from "./sidecarSafety.js";
import { parseModuleProgram } from "../moduleGraph.js";

describe("sidecar branch selection", () => {
  it.each([
    "Math[min](0, 1) ? window.innerWidth : 0",
    "Math[min](0, 1) && window.innerWidth",
    "Math[max](0, 1) || window.innerWidth",
    "(() => 0, Math[min](0, 1)) ? window.innerWidth : 0",
    "choice ? window.innerWidth : 0"
  ])(
    "does not trust evaluator assumptions for computed member calls: %s",
    (expression) => {
      const program = parseModuleProgram(
        "/branch.ts",
        `const min = "max", max = "min"; const choice = Math[min](0, 1); const value = ${expression};`
      );
      let checked = false;
      program.traverse({
        VariableDeclarator(path) {
          if (!path.get("id").isIdentifier({ name: "value" })) return;
          const init = path.get("init");
          if (!init.isExpression()) throw new Error("Expected expression");
          checked = true;
          expect(
            createReplayAnalysis(init.scope).branches.branches(init)
          ).toBeUndefined();
        }
      });
      expect(checked).toBe(true);
    }
  );
  it.each([
    ["if (false) { var enabled = true; }", "enabled"],
    ["Math.max = () => 0;", "Math.max(0, 1)"]
  ])(
    "requires the source binding and realm to support a branch decision: %s",
    (setup, test) => {
      const program = parseModuleProgram(
        "/branch.ts",
        `${setup} const value = ${test} ? 4 : perRender();`
      );
      program.traverse({
        ConditionalExpression(path) {
          expect(
            createReplayAnalysis(path.scope).branches.branches(path)
          ).toBeUndefined();
        }
      });
    }
  );
  it.each([
    "Math.max(0, 1) ? 4 : window.innerWidth",
    "true ? 4 : window.innerWidth"
  ])("retains supported branch proofs: %s", (expression) => {
    const program = parseModuleProgram(
      "/branch.ts",
      `const value = ${expression};`
    );
    program.traverse({
      ConditionalExpression(path) {
        expect(
          createReplayAnalysis(path.scope).branches.branches(path)?.[1].node
        ).toMatchObject({
          type: "NumericLiteral",
          value: 4
        });
      }
    });
  });
});

describe("sidecar iterable spread replay", () => {
  it.each(["[...[4]]", "{padding:[...[4]][0]}", "Math.max(...[4])"])(
    "requires iteration equivalence for %s",
    (expression) => {
      for (const mutation of [false, true]) {
        const program = parseModuleProgram(
          "/spread.ts",
          `const value=${expression}`
        );
        Object.assign(program.scope, {
          minchoData: {
            extractCalls: {
              arrayMapIntrinsics: {
                intact: !mutation,
                iterationIntact: !mutation
              }
            }
          }
        });
        program.traverse({
          VariableDeclarator(path) {
            if (!path.get("id").isIdentifier({ name: "value" })) return;
            const init = path.get("init");
            if (!init.isExpression()) throw Error("Expected expression");
            expect(
              isSidecarSafeCssRuleExpression({
                expression: init.node,
                path: init,
                state: {
                  scope: path.scope,
                  visiting: new Set(),
                  localNames: new Set()
                }
              })
            ).toBe(!mutation);
          }
        });
      }
    }
  );
  it.each([
    ["false", true],
    ["(record(), false)", true],
    ["true", false],
    ["enabled", false]
  ] as const)(
    "checks reachable iterator changes with a clean graph receipt (%s)",
    (condition, replayable) => {
      const program = parseModuleProgram(
        "/spread.ts",
        `if (${condition}) Array.prototype[Symbol.iterator]=other;const value=[...[4]]`
      );
      program.traverse({
        VariableDeclarator(path) {
          if (!path.get("id").isIdentifier({ name: "value" })) return;
          const init = path.get("init");
          if (!init.isExpression()) throw Error("Expected expression");
          expect(
            isSidecarSafeCssRuleExpression({
              expression: init.node,
              path: init,
              state: {
                scope: path.scope,
                visiting: new Set(),
                localNames: new Set()
              }
            })
          ).toBe(replayable);
        }
      });
    }
  );
});
