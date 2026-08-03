import { types as t } from "@babel/core";
import {
  createTemplateElement,
  expectBooleanLiteralExpression,
  expectConfidentExpression,
  expectDeoptResult,
  expectNullLiteralExpression,
  expectNumericLiteralExpression,
  expectStringLiteralExpression,
  reduceForTest
} from "./helpers.js";

export function registerPartialEvalLiteralTests(
  vitest: NonNullable<ImportMeta["vitest"]>
): void {
  const { describe, expect, it } = vitest;

  describe("partial evaluator primitive reducer", () => {
    it("reduces transparent wrapper expressions to their primitive literal AST", () => {
      const literal = t.stringLiteral("wrapped");
      const wrappedExpression = t.tsAsExpression(
        t.tsNonNullExpression(t.parenthesizedExpression(literal)),
        t.tsStringKeyword()
      );

      const expression = expectConfidentExpression(
        reduceForTest(wrappedExpression)
      );

      expectStringLiteralExpression(expression, "wrapped");
      expect(expression).not.toBe(wrappedExpression);
      expect(expression).not.toBe(literal);
    });

    it("reduces string number boolean and null literal expressions as cloned AST", () => {
      const stringLiteral = t.stringLiteral("red");
      const numericLiteral = t.numericLiteral(4);
      const booleanLiteral = t.booleanLiteral(true);
      const nullLiteral = t.nullLiteral();

      const stringExpression = expectConfidentExpression(
        reduceForTest(stringLiteral)
      );
      const numericExpression = expectConfidentExpression(
        reduceForTest(numericLiteral)
      );
      const booleanExpression = expectConfidentExpression(
        reduceForTest(booleanLiteral)
      );
      const nullExpression = expectConfidentExpression(
        reduceForTest(nullLiteral)
      );

      expectStringLiteralExpression(stringExpression, "red");
      expectNumericLiteralExpression(numericExpression, 4);
      expectBooleanLiteralExpression(booleanExpression, true);
      expectNullLiteralExpression(nullExpression);
      expect(stringExpression).not.toBe(stringLiteral);
      expect(numericExpression).not.toBe(numericLiteral);
      expect(booleanExpression).not.toBe(booleanLiteral);
      expect(nullExpression).not.toBe(nullLiteral);
    });

    it("reduces no-expression template literals to string literal AST", () => {
      const templateLiteral = t.templateLiteral(
        [createTemplateElement("plain", true)],
        []
      );

      expectStringLiteralExpression(
        expectConfidentExpression(reduceForTest(templateLiteral)),
        "plain"
      );
    });

    it("reduces static template literal interpolations to string literal AST", () => {
      const templateLiteral = t.templateLiteral(
        [
          createTemplateElement("color-", false),
          createTemplateElement("-", false),
          createTemplateElement("", true)
        ],
        [
          t.stringLiteral("red"),
          t.binaryExpression("+", t.numericLiteral(1), t.numericLiteral(2))
        ]
      );

      expectStringLiteralExpression(
        expectConfidentExpression(reduceForTest(templateLiteral)),
        "color-red-3"
      );
    });

    it("reduces unary numeric and boolean primitive expressions", () => {
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(t.unaryExpression("-", t.numericLiteral(2)))
        ),
        -2
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(t.unaryExpression("+", t.numericLiteral(3)))
        ),
        3
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(t.unaryExpression("!", t.booleanLiteral(false)))
        ),
        true
      );
    });

    it("deopts unsupported call expressions with original fallback AST", () => {
      const callExpression = t.callExpression(t.identifier("makeRule"), []);
      const deopt = expectDeoptResult(reduceForTest(callExpression));

      expect(deopt.reason).toBe("unsupported-call-expression");
      expect(deopt.originalExpression).toBe(callExpression);
      expect(deopt.fallbackExpression).toBe(callExpression);
      expect(deopt.diagnostic.message).toBe(
        "Cannot partially evaluate css prop value: call expressions are not evaluated by Babel"
      );
    });

    it("deopts unsupported template interpolation with original fallback AST", () => {
      const templateLiteral = t.templateLiteral(
        [createTemplateElement("", false), createTemplateElement("", true)],
        [t.objectExpression([])]
      );
      const deopt = expectDeoptResult(reduceForTest(templateLiteral));

      expect(deopt.reason).toBe("unsupported-template-interpolation");
      expect(deopt.originalExpression).toBe(templateLiteral);
      expect(deopt.fallbackExpression).toBe(templateLiteral);
      expect(deopt.diagnostic.message).toBe(
        "Cannot partially evaluate css prop value: template interpolation is not a static primitive"
      );
    });
  });
}
