import { types as t } from "@babel/core";
import {
  expectBooleanLiteralExpression,
  expectConfidentExpression,
  expectFixtureConfidentExpression,
  expectNullLiteralExpression,
  expectNumericLiteralExpression,
  expectObjectExpression,
  expectStringLiteralExpression,
  reduceFixture,
  reduceForTest
} from "./helpers.js";

export function registerPartialEvalOperatorTests(
  vitest: NonNullable<ImportMeta["vitest"]>
): void {
  const { describe, it } = vitest;

  describe("partial evaluator operator reducer", () => {
    it("reduces safe literal folding binary primitive expressions", () => {
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("+", t.numericLiteral(1), t.numericLiteral(2))
          )
        ),
        3
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("-", t.numericLiteral(7), t.numericLiteral(2))
          )
        ),
        5
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("*", t.numericLiteral(3), t.numericLiteral(4))
          )
        ),
        12
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("/", t.numericLiteral(8), t.numericLiteral(2))
          )
        ),
        4
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("%", t.numericLiteral(5), t.numericLiteral(2))
          )
        ),
        1
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("**", t.numericLiteral(2), t.numericLiteral(3))
          )
        ),
        8
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression(
              "+",
              t.stringLiteral("gap-"),
              t.numericLiteral(2)
            )
          )
        ),
        "gap-2"
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression(
              "+",
              t.stringLiteral("enabled-"),
              t.booleanLiteral(true)
            )
          )
        ),
        "enabled-true"
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("+", t.nullLiteral(), t.stringLiteral("-value"))
          )
        ),
        "null-value"
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("<", t.numericLiteral(1), t.numericLiteral(2))
          )
        ),
        true
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("<=", t.numericLiteral(2), t.numericLiteral(2))
          )
        ),
        true
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression(">", t.numericLiteral(3), t.numericLiteral(2))
          )
        ),
        true
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression(">=", t.numericLiteral(3), t.numericLiteral(2))
          )
        ),
        true
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression(
              "===",
              t.stringLiteral("same"),
              t.stringLiteral("same")
            )
          )
        ),
        true
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression("===", t.nullLiteral(), t.nullLiteral())
          )
        ),
        true
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression(
              "!==",
              t.stringLiteral("same"),
              t.stringLiteral("other")
            )
          )
        ),
        true
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.binaryExpression(
              "!==",
              t.booleanLiteral(true),
              t.booleanLiteral(false)
            )
          )
        ),
        true
      );
    });

    it("reduces logical primitive expressions", () => {
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "&&",
              t.booleanLiteral(false),
              t.stringLiteral("right")
            )
          )
        ),
        false
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "&&",
              t.booleanLiteral(true),
              t.stringLiteral("right")
            )
          )
        ),
        "right"
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "&&",
              t.numericLiteral(1),
              t.stringLiteral("right")
            )
          )
        ),
        "right"
      );
      expectNullLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression("&&", t.nullLiteral(), t.stringLiteral("right"))
          )
        )
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "||",
              t.stringLiteral(""),
              t.stringLiteral("fallback")
            )
          )
        ),
        "fallback"
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression("||", t.numericLiteral(0), t.numericLiteral(2))
          )
        ),
        2
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "||",
              t.stringLiteral("left"),
              t.stringLiteral("fallback")
            )
          )
        ),
        "left"
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "??",
              t.nullLiteral(),
              t.stringLiteral("fallback")
            )
          )
        ),
        "fallback"
      );
      expectNumericLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression("??", t.numericLiteral(0), t.numericLiteral(1))
          )
        ),
        0
      );
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "??",
              t.booleanLiteral(false),
              t.stringLiteral("fallback")
            )
          )
        ),
        false
      );
    });

    it("short-circuits discarded logical branches and returns selected static shapes", () => {
      expectBooleanLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "&&",
              t.booleanLiteral(false),
              t.callExpression(t.identifier("discarded"), [])
            )
          )
        ),
        false
      );
      expectStringLiteralExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "||",
              t.stringLiteral("left"),
              t.callExpression(t.identifier("discarded"), [])
            )
          )
        ),
        "left"
      );
      expectObjectExpression(
        expectConfidentExpression(
          reduceForTest(
            t.logicalExpression(
              "??",
              t.nullLiteral(),
              t.objectExpression([
                t.objectProperty(t.identifier("color"), t.stringLiteral("red"))
              ])
            )
          )
        )
      );
    });

    it("short-circuits const-bound member left operands", () => {
      const result = expectFixtureConfidentExpression(
        reduceFixture(`
          const flags = { disabled: false };
          capture(flags.disabled && discarded());
        `),
        0
      );

      expectBooleanLiteralExpression(result, false);
    });
  });
}
