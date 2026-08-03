import { types as t } from "@babel/core";
import type { PartialEvalResult } from "./result.js";
import type { PartialEvalReducerNodeOptions } from "./reduction.js";
import {
  createStaticPrimitiveExpression,
  getStaticPrimitiveValue,
  type PartialEvalStaticPrimitive
} from "./literals.js";

type PartialEvalPrimitiveFoldResult =
  | { readonly kind: "folded"; readonly value: PartialEvalStaticPrimitive }
  | { readonly kind: "unsupported" };

export function reduceBinaryExpression(
  options: PartialEvalReducerNodeOptions<t.BinaryExpression>
): PartialEvalResult {
  if (!t.isExpression(options.node.left)) {
    return options.runtime.createDeoptResult({
      expression: options.expression,
      reason: "runtime-css-shape"
    });
  }

  const leftResult = options.runtime.reduceExpression({
    expression: options.node.left,
    depth: options.depth + 1,
    reductionContext: options.reductionContext
  });

  if (leftResult.kind === "deopt") {
    return options.runtime.createDeoptFromChild({
      expression: options.expression,
      result: leftResult
    });
  }

  const rightResult = options.runtime.reduceExpression({
    expression: options.node.right,
    depth: options.depth + 1,
    reductionContext: options.reductionContext
  });

  if (rightResult.kind === "deopt") {
    return options.runtime.createDeoptFromChild({
      expression: options.expression,
      result: rightResult
    });
  }

  const leftValue = getStaticPrimitiveValue(leftResult.expression);
  const rightValue = getStaticPrimitiveValue(rightResult.expression);

  if (leftValue === undefined || rightValue === undefined) {
    return options.runtime.createDeoptResult({
      expression: options.expression,
      reason: "runtime-css-shape"
    });
  }

  const foldResult = foldBinaryPrimitiveValue(
    options.node.operator,
    leftValue,
    rightValue
  );

  return foldResult.kind === "folded"
    ? options.runtime.createConfidentResult(
        createStaticPrimitiveExpression(foldResult.value)
      )
    : options.runtime.createDeoptResult({
        expression: options.expression,
        reason: "runtime-css-shape"
      });
}

function foldBinaryPrimitiveValue(
  operator: t.BinaryExpression["operator"],
  leftValue: PartialEvalStaticPrimitive,
  rightValue: PartialEvalStaticPrimitive
): PartialEvalPrimitiveFoldResult {
  switch (operator) {
    case "+":
      if (typeof leftValue === "number" && typeof rightValue === "number") {
        return createFiniteNumberFoldResult(leftValue + rightValue);
      }
      if (typeof leftValue === "string" || typeof rightValue === "string") {
        return { kind: "folded", value: `${leftValue}${rightValue}` };
      }
      return { kind: "unsupported" };
    case "-":
      return foldNumberBinaryPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left - right
      );
    case "*":
      return foldNumberBinaryPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left * right
      );
    case "/":
      return foldNumberBinaryPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left / right
      );
    case "%":
      return foldNumberBinaryPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left % right
      );
    case "**":
      return foldNumberBinaryPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left ** right
      );
    case "<":
      return foldNumberComparisonPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left < right
      );
    case "<=":
      return foldNumberComparisonPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left <= right
      );
    case ">":
      return foldNumberComparisonPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left > right
      );
    case ">=":
      return foldNumberComparisonPrimitiveValue(
        leftValue,
        rightValue,
        (left, right) => left >= right
      );
    case "===":
      return { kind: "folded", value: leftValue === rightValue };
    case "!==":
      return { kind: "folded", value: leftValue !== rightValue };
    case "==":
    case "!=":
    case "|":
    case "&":
    case "^":
    case "<<":
    case ">>":
    case ">>>":
    case "|>":
    case "in":
    case "instanceof":
      return { kind: "unsupported" };
    default: {
      const exhaustive: never = operator;
      return exhaustive;
    }
  }
}

function foldNumberBinaryPrimitiveValue(
  leftValue: PartialEvalStaticPrimitive,
  rightValue: PartialEvalStaticPrimitive,
  fold: (leftValue: number, rightValue: number) => number
): PartialEvalPrimitiveFoldResult {
  return typeof leftValue === "number" && typeof rightValue === "number"
    ? createFiniteNumberFoldResult(fold(leftValue, rightValue))
    : { kind: "unsupported" };
}

function foldNumberComparisonPrimitiveValue(
  leftValue: PartialEvalStaticPrimitive,
  rightValue: PartialEvalStaticPrimitive,
  fold: (leftValue: number, rightValue: number) => boolean
): PartialEvalPrimitiveFoldResult {
  return typeof leftValue === "number" && typeof rightValue === "number"
    ? { kind: "folded", value: fold(leftValue, rightValue) }
    : { kind: "unsupported" };
}

function createFiniteNumberFoldResult(
  value: number
): PartialEvalPrimitiveFoldResult {
  return Number.isFinite(value)
    ? { kind: "folded", value }
    : { kind: "unsupported" };
}
