import { types as t } from "@babel/core";

export type PartialEvalStaticPrimitive = string | number | boolean | null;

type PartialEvalStringOrNumberMemberName = string | number;

export function isStaticPrimitiveLiteralExpression(
  expression: t.Expression
): expression is
  | t.StringLiteral
  | t.NumericLiteral
  | t.BooleanLiteral
  | t.NullLiteral {
  return (
    t.isStringLiteral(expression) ||
    t.isNumericLiteral(expression) ||
    t.isBooleanLiteral(expression) ||
    t.isNullLiteral(expression)
  );
}

export function getStaticStringOrNumberMemberName(
  expression: t.Expression
): PartialEvalStringOrNumberMemberName | null {
  const value = getStaticPrimitiveValue(expression);
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export function getStaticPrimitiveValue(
  expression: t.Expression
): PartialEvalStaticPrimitive | undefined {
  if (t.isStringLiteral(expression)) {
    return expression.value;
  }

  if (t.isNumericLiteral(expression)) {
    return expression.value;
  }

  if (t.isBooleanLiteral(expression)) {
    return expression.value;
  }

  if (t.isNullLiteral(expression)) {
    return null;
  }

  return undefined;
}

export function createStaticPrimitiveExpression(
  value: PartialEvalStaticPrimitive
): t.Expression {
  if (value === null) {
    return t.nullLiteral();
  }

  switch (typeof value) {
    case "string":
      return t.stringLiteral(value);
    case "number":
      return t.numericLiteral(value);
    case "boolean":
      return t.booleanLiteral(value);
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

export function isTruthyStaticPrimitive(
  value: PartialEvalStaticPrimitive
): boolean {
  return !!value;
}
