import { transformSync, type NodePath, types as t } from "@babel/core";
import { describe, expect, it } from "vitest";
import {
  planEvaluation,
  isProvablyUnexecuted,
  proveEvaluationOrder,
  proveEvaluationSteps,
  proveStableEvaluationValue
} from "./evaluation.js";

function expression<T>(
  source: string,
  inspect: (path: NodePath<t.Expression>) => T
): T {
  let result: T | undefined;
  transformSync(`const value = ${source};`, {
    configFile: false,
    babelrc: false,
    plugins: [
      () => ({
        visitor: {
          VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
            if (!t.isIdentifier(path.node.id, { name: "value" })) return;
            const initializer = path.get("init");
            if (initializer.isExpression()) result = inspect(initializer);
          }
        }
      })
    ]
  });
  return result!;
}

describe("extraction evaluation contracts", () => {
  it.each(["&&", "||", "??"])(
    "bounds repeated proofs of deeply nested closed %s conditions",
    (operator) => {
      expression(
        `${Array.from({ length: 48 }, () => "true").join(` ${operator} `)} ? "selected" : "excluded"`,
        (path) => {
          expect(
            proveStableEvaluationValue(path, {
              replay: () => "unknown",
              binding: () => "unknown"
            })
          ).toBe("proven");
          expect(
            planEvaluation(path)
              .selectedBranches?.at(-1)
              ?.isStringLiteral({ value: "selected" })
          ).toBe(true);
        }
      );
    }
  );

  it("does not reuse condition proofs after an AST change", () => {
    expression('true ? "selected" : "excluded"', (path) => {
      if (!path.isConditionalExpression())
        throw new Error("Expected condition");
      expect(
        planEvaluation(path)
          .selectedBranches?.at(-1)
          ?.isStringLiteral({ value: "selected" })
      ).toBe(true);
      path.get("test").replaceWith(t.booleanLiteral(false));
      expect(
        planEvaluation(path)
          .selectedBranches?.at(-1)
          ?.isStringLiteral({ value: "excluded" })
      ).toBe(true);
    });
  });

  it.each(["=", "+=", "||="])(
    "separates reference formation from GetValue and writes for %s",
    (operator) => {
      expression(`owner.slot ${operator} call()`, (path) => {
        const plan = planEvaluation(path);
        const callIndex = plan.steps.findIndex(
          (step) =>
            step.kind === "evaluate" && step.operand.path.isCallExpression()
        );
        expect(callIndex).toBeGreaterThan(0);
        const prefix = plan.steps.slice(0, callIndex);
        const requirements = {
          replay: () => "unknown" as const,
          binding: () => "proven" as const
        };
        expect(proveEvaluationSteps(prefix, requirements)).toBe("unknown");
        for (const reference of ["pending", "proven"] as const) {
          const withReference = { ...requirements, reference: () => reference };
          expect(proveEvaluationSteps(prefix, withReference)).toBe(
            operator === "=" ? reference : "unknown"
          );
          expect(proveEvaluationOrder(path, withReference)).toBe("unknown");
        }
      });
    }
  );

  it.each([
    ["if (false) probe();", true],
    ["if (true) {} else probe();", true],
    ["false && probe();", true],
    ["true || probe();", true],
    ["0 ?? probe();", true],
    ["true ? 0 : probe();", true],
    ["false ? probe() : 0;", true],
    ["if (1 === 2) probe();", true],
    ["if (true) probe();", false],
    ["const enabled = false; if (enabled) probe();", false],
    [
      'let enabled = false; eval("enabled = true"); if (enabled) probe();',
      false
    ],
    ['import { enabled } from "outside"; if (enabled) probe();', false],
    ["if (undefined) probe();", false],
    ["if (NaN) probe();", false],
    ["if (Infinity) {} else probe();", false],
    ["function later() { if (false) probe(); }", true],
    ["class Later { value = false && probe(); }", true],
    ["function outer() { function inner() { if (false) probe(); } }", true],
    ["function outer() { function inner() { if (true) probe(); } }", false],
    ["if (false) { function later() { probe(); } }", false],
    ["if ((sideEffect(), false)) probe();", false]
  ] as const)(
    "certifies only closed literal branch exclusion: %s",
    (source, expected) => {
      let actual: boolean | undefined;
      transformSync(source, {
        configFile: false,
        babelrc: false,
        plugins: [
          () => ({
            visitor: {
              CallExpression(path: NodePath<t.CallExpression>) {
                if (path.get("callee").isIdentifier({ name: "probe" }))
                  actual = isProvablyUnexecuted(path);
              }
            }
          })
        ]
      });
      expect(actual).toBe(expected);
    }
  );

  it.each([
    ['"red"', "proven"],
    ["1 + 2", "proven"],
    ["(replay(), 'red')", "proven"],
    ["false ? {} : 'red'", "proven"],
    ["{}", "unknown"],
    ["[]", "unknown"],
    ["() => 1", "unknown"],
    ["/red/", "unknown"],
    ["replay()", "unknown"],
    ["replay() === replay()", "unknown"],
    ["replay() ? 'red' : 'blue'", "unknown"]
  ] as const)(
    "distinguishes inert evaluation from stable value evidence: %s",
    (source, expected) => {
      expression(source, (path) => {
        const requirements = {
          replay: () => "proven" as const,
          binding: () => "unknown" as const
        };
        expect(proveEvaluationOrder(path, requirements)).toBe("proven");
        expect(proveStableEvaluationValue(path, requirements)).toBe(expected);
      });
    }
  );

  it("accepts a shared value only with evidence for that exact generated binding", () => {
    expression("shared", (path) => {
      const requirements = {
        replay: () => "proven" as const,
        binding: () => "unknown" as const
      };
      expect(proveStableEvaluationValue(path, requirements)).toBe("unknown");
      expect(
        proveStableEvaluationValue(path, {
          ...requirements,
          sharedValue: (value) => (value === path ? "proven" : "unknown")
        })
      ).toBe("proven");
    });
  });

  it.each([
    ["owner.field", "observe"],
    ["`${owner}`", "coerce"]
  ] as const)(
    "accepts only supplied %s evidence and retains pending obligations",
    (source, operation) => {
      expression(source, (path) => {
        const requirements = {
          replay: () => "unknown" as const,
          binding: () => "proven" as const
        };
        expect(proveEvaluationOrder(path, requirements)).toBe("unknown");
        const step = planEvaluation(path).steps.find(
          (step) => step.kind === operation
        )!;
        if (step.kind === "evaluate") throw new Error("Missing evidence step");
        for (const proof of ["pending", "proven"] as const) {
          expect(
            proveEvaluationOrder(path, {
              ...requirements,
              [operation]: (value: NodePath<t.Node>) =>
                value === step.path ? proof : "unknown"
            })
          ).toBe(proof);
        }
      });
    }
  );

  it.each([
    ["left + call()", "proven"],
    ["`${left}${call()}`", "unknown"]
  ] as const)(
    "places coercion at its actual evaluation point: %s",
    (source, expected) => {
      expression(source, (path) => {
        const plan = planEvaluation(path);
        const callIndex = plan.steps.findIndex(
          (step) =>
            step.kind === "evaluate" && step.operand.path.isCallExpression()
        );
        expect(callIndex).toBeGreaterThan(0);
        const requirements = {
          replay: () => "unknown" as const,
          binding: () => "proven" as const
        };
        expect(
          proveEvaluationSteps(plan.steps.slice(0, callIndex), requirements)
        ).toBe(expected);
        expect(proveEvaluationOrder(path, requirements)).toBe("unknown");
      });
    }
  );

  it("retains dependencies below unknown operations without proving them safe", () => {
    expression("class { static color = system.color; }", (path) => {
      const references: string[] = [];
      const visit = (value: NodePath<t.Node>) => {
        if (value.isReferencedIdentifier()) references.push(value.node.name);
        for (const operand of planEvaluation(value).operands)
          visit(operand.path);
      };
      visit(path);
      expect(references).toContain("system");
      expect(planEvaluation(path).kind).toBe("unknown");
      expect(
        proveEvaluationOrder(path, {
          replay: () => "proven",
          binding: () => "proven"
        })
      ).toBe("unknown");
    });
  });

  it("separates computed method keys from deferred body captures", () => {
    expression("{ [key()]() { return body.color; } }", (path) => {
      const method = planEvaluation(path).operands[0]!.path;
      const plan = planEvaluation(method);
      expect(plan.operands.map(({ path }) => path.toString())).toEqual([
        "key()"
      ]);
      expect(plan.captures.map((path) => path.toString())).toEqual(["body"]);
      expect(
        proveEvaluationOrder(method, {
          replay: () => "proven",
          binding: () => "proven"
        })
      ).toBe("unknown");
    });
    expression("() => effect(owner)", (path) => {
      const plan = planEvaluation(path);
      expect(plan.operands).toEqual([]);
      expect(plan.captures.map((path) => path.toString())).toEqual([
        "effect",
        "owner"
      ]);
      expect(
        proveEvaluationOrder(path, {
          replay: () => "unknown",
          binding: () => "unknown"
        })
      ).toBe("proven");
    });
  });

  it.each([
    "`${replay()}`",
    "{ [replay()]: 1 }",
    "[...replay()]",
    "{ ...replay() }",
    "+replay()"
  ])(
    "does not turn replayed result hooks into inert evaluation: %s",
    (source) => {
      expression(source, (path) => {
        expect(
          proveEvaluationOrder(path, {
            replay: () => "proven",
            binding: () => "proven"
          })
        ).toBe("unknown");
      });
    }
  );

  it("retains pending replay obligations and does not execute an unselected branch", () => {
    expression("{ nested: [replay()] }", (path) => {
      expect(
        proveEvaluationOrder(path, {
          replay: () => "pending",
          binding: () => "unknown"
        })
      ).toBe("pending");
    });
    expression('false ? replay() : "safe"', (path) => {
      expect(
        proveEvaluationOrder(path, {
          replay() {
            throw new Error("Unselected replay must not be requested");
          },
          binding: () => "unknown"
        })
      ).toBe("proven");
    });
    expression('flag ? replay() : "safe"', (path) => {
      expect(
        proveEvaluationOrder(path, {
          replay: () => "proven",
          binding: () => "proven"
        })
      ).toBe("unknown");
    });
  });
});
