import { types as t } from "@babel/core";
import { describe, expect, it, vi } from "vitest";
import {
  createModuleGraph,
  parseModuleProgram,
  type ModuleGraphFlow
} from "../moduleGraph.js";
import { hasStaticCssEvalBindingMutation } from "../staticCssEval/sameFile/mutation.js";
import {
  createStaticExpressionBudget,
  evaluateStaticExpression,
  StaticExpressionDeopt
} from "./staticExpression.js";

function fixture(source: string) {
  const graph = createModuleGraph();
  const module = {
    id: "/owner.ts",
    program: parseModuleProgram("/owner.ts", source)
  };
  graph.modules.set(module.id, module);

  const statement = module.program.get("body").at(-1)!;
  if (!statement.isExpressionStatement())
    throw new Error("Expected expression");

  return { graph, module, expression: statement.get("expression") };
}

function run<T>(flow: ModuleGraphFlow<T>): T {
  let step = flow.next();

  while (!step.done) {
    if (step.value.kind !== "resolve")
      throw new Error("Unexpected module load");
    step = flow.next(step.value.source);
  }

  return step.value;
}

describe("static expression mutation analysis", () => {
  it.each(["local", "imported"])(
    "scans a repeated %s binding only once per evaluation",
    (kind) => {
      const { graph, module, expression } = fixture(
        (kind === "local"
          ? "const value = 4;"
          : 'import { value } from "/tokens.ts";') +
          `[${Array(40).fill("value").join(",")}];`
      );
      const target =
        kind === "local"
          ? module
          : {
              id: "/tokens.ts",
              program: parseModuleProgram(
                "/tokens.ts",
                "export const value = 4;"
              )
            };
      graph.modules.set(target.id, target);

      const traverse = vi.spyOn(target.program, "traverse");
      expect(
        hasStaticCssEvalBindingMutation(
          target.program,
          target.program.scope.getBinding("value")!
        )
      ).toBe(false);
      const singleCheckTraversals = traverse.mock.calls.length;
      expect(singleCheckTraversals).toBeGreaterThan(0);
      traverse.mockClear();

      const result = run(evaluateStaticExpression(graph, module, expression));

      expect(result).toMatchObject({
        type: "ArrayExpression",
        elements: Array.from({ length: 40 }, () => ({
          type: "NumericLiteral",
          value: 4
        }))
      });
      expect(traverse).toHaveBeenCalledTimes(singleCheckTraversals);
    }
  );

  it("reuses a mutation finding while continuing to deopt", () => {
    const { graph, module, expression } = fixture(
      'const value = { color: "red" }; value.color = "blue"; value;'
    );
    const traverse = vi.spyOn(module.program, "traverse");
    const budget = createStaticExpressionBudget();
    const evaluate = () =>
      run(evaluateStaticExpression(graph, module, expression, budget));

    expect(evaluate).toThrow(StaticExpressionDeopt);
    expect(traverse).toHaveBeenCalled();
    traverse.mockClear();

    expect(evaluate).toThrow(StaticExpressionDeopt);
    expect(traverse).not.toHaveBeenCalled();
  });

  it("checks the same binding again in a new evaluation after an AST edit", () => {
    const { graph, module, expression } = fixture(
      'const value = { color: "red" }; value;'
    );
    const binding = module.program.scope.getBinding("value");
    expect(
      run(evaluateStaticExpression(graph, module, expression))
    ).toMatchObject({
      type: "ObjectExpression"
    });

    module.program.pushContainer(
      "body",
      t.expressionStatement(
        t.assignmentExpression(
          "=",
          t.memberExpression(t.identifier("value"), t.identifier("color")),
          t.stringLiteral("blue")
        )
      )
    );

    expect(module.program.scope.getBinding("value")).toBe(binding);
    expect(() =>
      run(evaluateStaticExpression(graph, module, expression))
    ).toThrow(StaticExpressionDeopt);
  });
});
