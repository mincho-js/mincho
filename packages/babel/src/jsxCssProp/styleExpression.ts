import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import { styleValueErrorMessage } from "./constants.js";

export function getStyleExpression(
  path: NodePath<t.JSXOpeningElement>,
  attribute: t.JSXAttribute
): t.Expression {
  if (attribute.value === null || t.isStringLiteral(attribute.value)) {
    throw path.buildCodeFrameError(styleValueErrorMessage);
  }

  if (!t.isJSXExpressionContainer(attribute.value)) {
    throw path.buildCodeFrameError(styleValueErrorMessage);
  }

  const { expression } = attribute.value;

  if (
    t.isJSXEmptyExpression(expression) ||
    t.isStringLiteral(expression) ||
    t.isTemplateLiteral(expression)
  ) {
    throw path.buildCodeFrameError(styleValueErrorMessage);
  }

  return expression;
}
