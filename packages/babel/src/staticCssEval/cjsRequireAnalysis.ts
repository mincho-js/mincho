import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import { isStaticCssEvalRequireCallExpression } from "./cjsBindings.js";

type StaticCssEvalBabelScope = NodePath<t.Node>["scope"];

export function containsStaticCssEvalRequireCallExpression(
  expression: t.Expression,
  scope: StaticCssEvalBabelScope
): boolean {
  const unwrappedExpression = unwrapTransparentExpression(expression);

  if (isStaticCssEvalRequireCallExpression(unwrappedExpression, scope)) {
    return true;
  }

  if (
    t.isFunctionExpression(unwrappedExpression) ||
    t.isArrowFunctionExpression(unwrappedExpression) ||
    t.isClassExpression(unwrappedExpression)
  ) {
    return false;
  }

  if (t.isTemplateLiteral(unwrappedExpression)) {
    return unwrappedExpression.expressions.some((item) =>
      containsExpressionNode(item, scope)
    );
  }

  if (t.isTaggedTemplateExpression(unwrappedExpression)) {
    return (
      containsExpressionNode(unwrappedExpression.tag, scope) ||
      containsExpressionNode(unwrappedExpression.quasi, scope)
    );
  }

  if (
    t.isCallExpression(unwrappedExpression) ||
    t.isOptionalCallExpression(unwrappedExpression)
  ) {
    return (
      containsExpressionNode(unwrappedExpression.callee, scope) ||
      unwrappedExpression.arguments.some((argument) =>
        containsExpressionNode(argument, scope)
      )
    );
  }

  if (t.isNewExpression(unwrappedExpression)) {
    return (
      containsExpressionNode(unwrappedExpression.callee, scope) ||
      unwrappedExpression.arguments.some((argument) =>
        containsExpressionNode(argument, scope)
      )
    );
  }

  if (t.isAwaitExpression(unwrappedExpression)) {
    return containsExpressionNode(unwrappedExpression.argument, scope);
  }

  if (t.isAssignmentExpression(unwrappedExpression)) {
    return (
      containsExpressionNode(unwrappedExpression.left, scope) ||
      containsExpressionNode(unwrappedExpression.right, scope)
    );
  }

  if (t.isTSInstantiationExpression(unwrappedExpression)) {
    return containsExpressionNode(unwrappedExpression.expression, scope);
  }

  if (
    t.isMemberExpression(unwrappedExpression) ||
    t.isOptionalMemberExpression(unwrappedExpression)
  ) {
    return (
      containsExpressionNode(unwrappedExpression.object, scope) ||
      (unwrappedExpression.computed &&
        containsExpressionNode(unwrappedExpression.property, scope))
    );
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return (
      containsStaticCssEvalRequireCallExpression(
        unwrappedExpression.test,
        scope
      ) ||
      containsStaticCssEvalRequireCallExpression(
        unwrappedExpression.consequent,
        scope
      ) ||
      containsStaticCssEvalRequireCallExpression(
        unwrappedExpression.alternate,
        scope
      )
    );
  }

  if (
    t.isLogicalExpression(unwrappedExpression) ||
    t.isBinaryExpression(unwrappedExpression)
  ) {
    return (
      containsExpressionNode(unwrappedExpression.left, scope) ||
      containsStaticCssEvalRequireCallExpression(
        unwrappedExpression.right,
        scope
      )
    );
  }

  if (t.isSequenceExpression(unwrappedExpression)) {
    return unwrappedExpression.expressions.some((item) =>
      containsStaticCssEvalRequireCallExpression(item, scope)
    );
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return unwrappedExpression.elements.some((element) =>
      containsExpressionNode(element, scope)
    );
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    return unwrappedExpression.properties.some((property) =>
      containsObjectPropertyRequireCall(property, scope)
    );
  }

  if (t.isUnaryExpression(unwrappedExpression)) {
    return containsStaticCssEvalRequireCallExpression(
      unwrappedExpression.argument,
      scope
    );
  }

  return false;
}

function containsObjectPropertyRequireCall(
  property: t.ObjectExpression["properties"][number],
  scope: StaticCssEvalBabelScope
): boolean {
  if (t.isSpreadElement(property)) {
    return containsExpressionNode(property.argument, scope);
  }

  if (!t.isObjectProperty(property)) {
    return false;
  }

  return (
    (property.computed && containsExpressionNode(property.key, scope)) ||
    containsExpressionNode(property.value, scope)
  );
}

function containsExpressionNode(
  node: t.Node | null | undefined,
  scope: StaticCssEvalBabelScope
): boolean {
  if (t.isSpreadElement(node)) {
    return containsExpressionNode(node.argument, scope);
  }

  return t.isExpression(node)
    ? containsStaticCssEvalRequireCallExpression(node, scope)
    : false;
}

function unwrapTransparentExpression(expression: t.Expression): t.Expression {
  let currentExpression = expression;

  while (
    t.isParenthesizedExpression(currentExpression) ||
    t.isTSAsExpression(currentExpression) ||
    t.isTSSatisfiesExpression(currentExpression) ||
    t.isTSNonNullExpression(currentExpression) ||
    t.isTSTypeAssertion(currentExpression) ||
    t.isTypeCastExpression(currentExpression)
  ) {
    currentExpression = currentExpression.expression;
  }

  return currentExpression;
}
