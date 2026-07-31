import { types as t } from "@babel/core";
import type { Scope } from "@babel/traverse";
import { unwrapTransparentCssRuleExpression } from "../staticCssEval/candidates.js";
import {
  isDirectCssRuleLiteralExpression,
  isTopLevelCssRuleCallExpression
} from "./classification.js";
import type { CssRuleLoweringClassification } from "./types.js";

export function getSidecarCssRuleClassification(
  expression: t.Expression,
  scope: Scope
): CssRuleLoweringClassification | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (isSidecarRuleCallExpression(unwrappedExpression, scope)) {
    return "css-rule";
  }

  if (
    t.isObjectExpression(unwrappedExpression) &&
    containsSidecarObjectShape(unwrappedExpression, scope)
  ) {
    return "css-rule";
  }

  if (
    t.isArrayExpression(unwrappedExpression) &&
    containsSidecarArrayShape(unwrappedExpression, scope)
  ) {
    return "css-rule";
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return hasSidecarBranch(unwrappedExpression.consequent, scope) ||
      hasSidecarBranch(unwrappedExpression.alternate, scope)
      ? "branch-css-rule"
      : null;
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return hasLogicalSidecarBranch(unwrappedExpression, scope)
      ? "branch-css-rule"
      : null;
  }

  return null;
}

export function hasSidecarBranch(
  expression: t.Expression,
  scope: Scope
): boolean {
  return getSidecarCssRuleClassification(expression, scope) !== null;
}

export function isSidecarRuleCallExpression(
  expression: t.Expression,
  scope: Scope
): expression is t.CallExpression {
  return (
    t.isCallExpression(expression) &&
    isTopLevelCssRuleCallExpression(expression, scope)
  );
}

export function isSidecarSafeLiteral(
  expression: t.Expression | t.Super
): boolean {
  return (
    t.isStringLiteral(expression) ||
    t.isNumericLiteral(expression) ||
    t.isBooleanLiteral(expression) ||
    t.isNullLiteral(expression) ||
    t.isBigIntLiteral(expression)
  );
}

function containsSidecarObjectShape(
  expression: t.ObjectExpression,
  scope: Scope
): boolean {
  return expression.properties.some((property) => {
    if (t.isSpreadElement(property)) {
      return isSidecarShapeOperand(property.argument, scope);
    }

    if (!t.isObjectProperty(property)) {
      return false;
    }

    return (
      (property.computed && isSidecarShapeOperand(property.key, scope)) ||
      (t.isExpression(property.value) &&
        isSidecarShapeOperand(property.value, scope))
    );
  });
}

function containsSidecarArrayShape(
  expression: t.ArrayExpression,
  scope: Scope
): boolean {
  return expression.elements.some((element) => {
    if (!element) {
      return false;
    }

    return (
      t.isSpreadElement(element) &&
      isSidecarShapeOperand(element.argument, scope)
    );
  });
}

function hasLogicalSidecarBranch(
  expression: t.LogicalExpression,
  scope: Scope
): boolean {
  if (isDirectCssRuleLiteralExpression(expression.left)) {
    return false;
  }

  return hasSidecarBranch(expression.right, scope);
}

function isSidecarShapeOperand(
  node: t.Node,
  scope: Scope
): node is t.Expression {
  if (!t.isExpression(node)) {
    return false;
  }

  const expression = unwrapTransparentCssRuleExpression(node);

  if (isSidecarRuleCallExpression(expression, scope)) {
    return true;
  }

  if (t.isObjectExpression(expression)) {
    return containsSidecarObjectShape(expression, scope);
  }

  return (
    t.isArrayExpression(expression) &&
    containsSidecarArrayShape(expression, scope)
  );
}
