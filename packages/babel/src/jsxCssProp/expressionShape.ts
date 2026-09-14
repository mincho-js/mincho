import { types as t } from "@babel/core";
import { unwrapTransparentCssRuleExpression } from "../staticCssEval/candidates.js";

export function isStaticCssShapeExpression(expression: t.Expression): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (isStaticCssPrimitiveExpression(unwrappedExpression)) {
    return true;
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    return unwrappedExpression.properties.every((property) => {
      return (
        t.isObjectProperty(property) &&
        !property.computed &&
        !property.shorthand &&
        !!getStaticObjectPropertyKeyName(property.key) &&
        t.isExpression(property.value) &&
        isStaticCssShapeExpression(property.value)
      );
    });
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return unwrappedExpression.elements.every((element) => {
      return (
        !!element &&
        !t.isSpreadElement(element) &&
        isStaticCssShapeExpression(element)
      );
    });
  }

  return false;
}

export function isStaticCssPrimitiveExpression(
  expression: t.Expression
): boolean {
  return (
    t.isStringLiteral(expression) ||
    t.isNumericLiteral(expression) ||
    t.isBooleanLiteral(expression) ||
    t.isNullLiteral(expression) ||
    isUnaryNumericLiteral(expression) ||
    (t.isTemplateLiteral(expression) && expression.expressions.length === 0)
  );
}

function isUnaryNumericLiteral(
  expression: t.Expression
): expression is t.UnaryExpression & { argument: t.NumericLiteral } {
  return (
    t.isUnaryExpression(expression) &&
    (expression.operator === "+" || expression.operator === "-") &&
    t.isNumericLiteral(expression.argument)
  );
}

export function getStaticObjectPropertyKeyName(
  key: t.ObjectProperty["key"]
): string | null {
  if (t.isIdentifier(key)) {
    return key.name;
  }

  if (t.isStringLiteral(key)) {
    return key.value;
  }

  if (t.isNumericLiteral(key)) {
    return String(key.value);
  }

  return null;
}
