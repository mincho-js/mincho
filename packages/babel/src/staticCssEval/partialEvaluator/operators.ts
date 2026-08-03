import { types as t } from "@babel/core";
import type { PartialEvalResult } from "./result.js";
import type { PartialEvalReducerNodeOptions } from "./reduction.js";
import {
  getStaticPrimitiveValue,
  isTruthyStaticPrimitive
} from "./literals.js";

export function reduceUnaryExpression(
  options: PartialEvalReducerNodeOptions<t.UnaryExpression>
): PartialEvalResult {
  const argumentResult = options.runtime.reduceExpression({
    expression: options.node.argument,
    depth: options.depth + 1,
    reductionContext: options.reductionContext
  });

  if (argumentResult.kind === "deopt") {
    return options.runtime.createDeoptFromChild({
      expression: options.expression,
      result: argumentResult
    });
  }

  const primitiveValue = getStaticPrimitiveValue(argumentResult.expression);

  if (primitiveValue === undefined) {
    return options.runtime.createDeoptResult({
      expression: options.expression,
      reason: "runtime-css-shape"
    });
  }

  switch (options.node.operator) {
    case "+":
      return typeof primitiveValue === "number"
        ? options.runtime.createConfidentResult(
            t.numericLiteral(primitiveValue)
          )
        : options.runtime.createDeoptResult({
            expression: options.expression,
            reason: "runtime-css-shape"
          });
    case "-":
      return typeof primitiveValue === "number"
        ? options.runtime.createConfidentResult(
            t.numericLiteral(-primitiveValue)
          )
        : options.runtime.createDeoptResult({
            expression: options.expression,
            reason: "runtime-css-shape"
          });
    case "!":
      return options.runtime.createConfidentResult(
        t.booleanLiteral(!isTruthyStaticPrimitive(primitiveValue))
      );
    default:
      return options.runtime.createDeoptResult({
        expression: options.expression,
        reason: "runtime-css-shape"
      });
  }
}

export function reduceLogicalExpression(
  options: PartialEvalReducerNodeOptions<t.LogicalExpression>
): PartialEvalResult {
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

  const directLeftValue = getStaticPrimitiveValue(leftResult.expression);

  if (directLeftValue !== undefined) {
    switch (options.node.operator) {
      case "&&":
        if (!isTruthyStaticPrimitive(directLeftValue)) return leftResult;
        break;
      case "||":
        if (isTruthyStaticPrimitive(directLeftValue)) return leftResult;
        break;
      case "??":
        if (directLeftValue !== null) return leftResult;
        break;
      default: {
        const exhaustive: never = options.node.operator;
        return exhaustive;
      }
    }

    return options.runtime.reduceExpression({
      expression: options.node.right,
      depth: options.depth + 1,
      reductionContext: options.reductionContext
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

  switch (options.node.operator) {
    case "&&":
      return options.runtime.createConfidentResult(
        t.cloneNode(
          isTruthyStaticPrimitive(leftValue)
            ? rightResult.expression
            : leftResult.expression
        )
      );
    case "||":
      return options.runtime.createConfidentResult(
        t.cloneNode(
          isTruthyStaticPrimitive(leftValue)
            ? leftResult.expression
            : rightResult.expression
        )
      );
    case "??":
      return options.runtime.createConfidentResult(
        t.cloneNode(
          leftValue === null ? rightResult.expression : leftResult.expression
        )
      );
    default: {
      const exhaustive: never = options.node.operator;
      return exhaustive;
    }
  }
}
