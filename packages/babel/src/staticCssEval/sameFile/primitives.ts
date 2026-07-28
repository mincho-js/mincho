import { types as t } from "@babel/core";
import { unwrapTransparentCssRuleExpression } from "../candidates.js";

export function isSupportedStaticCssPrimitiveLiteral(
  expression: t.Expression
): boolean {
  return (
    t.isStringLiteral(expression) ||
    t.isNumericLiteral(expression) ||
    t.isBooleanLiteral(expression) ||
    t.isNullLiteral(expression) ||
    isUnaryNumericLiteral(expression) ||
    isNoExpressionTemplateLiteral(expression)
  );
}

export function isUnaryNumericLiteral(
  expression: t.Expression
): expression is t.UnaryExpression & { argument: t.NumericLiteral } {
  return (
    t.isUnaryExpression(expression) &&
    (expression.operator === "+" || expression.operator === "-") &&
    t.isNumericLiteral(expression.argument)
  );
}

export function isNoExpressionTemplateLiteral(
  expression: t.Expression
): expression is t.TemplateLiteral {
  return t.isTemplateLiteral(expression) && expression.expressions.length === 0;
}

export function getStaticStringOrNumberLiteralValue(
  expression: t.Expression
): string | number | null {
  if (t.isStringLiteral(expression)) {
    return expression.value;
  }

  if (t.isNumericLiteral(expression)) {
    return expression.value;
  }

  if (isUnaryNumericLiteral(expression)) {
    return expression.operator === "-"
      ? -expression.argument.value
      : expression.argument.value;
  }

  return null;
}

export function getTemplateInterpolationPrimitiveValue(
  expression: t.Expression
): string | number | boolean | null | undefined {
  if (t.isStringLiteral(expression)) {
    return expression.value;
  }

  if (t.isNumericLiteral(expression)) {
    return expression.value;
  }

  if (isUnaryNumericLiteral(expression)) {
    return expression.operator === "-"
      ? -expression.argument.value
      : expression.argument.value;
  }

  if (t.isBooleanLiteral(expression)) {
    return expression.value;
  }

  if (t.isNullLiteral(expression)) {
    return null;
  }

  return undefined;
}

export function createStaticObjectPropertyKey(
  propertyName: string
): t.Identifier | t.StringLiteral {
  return t.isValidIdentifier(propertyName)
    ? t.identifier(propertyName)
    : t.stringLiteral(propertyName);
}

export function normalizeSupportedStaticCssPrimitiveLiteral(
  expression: t.Expression
): t.Expression {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (isNoExpressionTemplateLiteral(unwrappedExpression)) {
    const [quasi] = unwrappedExpression.quasis;
    return t.stringLiteral(quasi?.value.cooked ?? quasi?.value.raw ?? "");
  }

  return t.cloneNode(unwrappedExpression);
}
