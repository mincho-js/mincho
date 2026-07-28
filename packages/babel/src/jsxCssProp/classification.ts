import { types as t } from "@babel/core";
import type { Scope } from "@babel/traverse";
import { unwrapTransparentCssRuleExpression } from "../staticCssEval/candidates.js";
import { cssModuleName } from "./constants.js";
import type { CssPropValueClassification } from "./types.js";

export function classifyCssPropValue(
  expression: t.Expression,
  scope: Scope
): CssPropValueClassification {
  const unsupportedArrayValueClassification =
    classifyUnsupportedCssPropArrayValue(expression);

  if (unsupportedArrayValueClassification) {
    return unsupportedArrayValueClassification;
  }

  if (containsUnsupportedSequenceCssRuleValue(expression)) {
    return "unsupported-dynamic-css-rule";
  }

  if (isDirectCssRuleExpression(expression, scope)) {
    return "css-rule";
  }

  if (isConditionalCssRuleBranchExpression(expression, scope)) {
    return "branch-css-rule";
  }

  if (isLogicalCssRuleBranchExpression(expression, scope)) {
    return "branch-css-rule";
  }

  if (isUnsupportedDynamicCssRuleValue(expression)) {
    return "unsupported-dynamic-css-rule";
  }

  if (
    t.isFunctionExpression(expression) ||
    t.isArrowFunctionExpression(expression)
  ) {
    return "unsupported-function";
  }

  return "class-value";
}

export function isDirectCssRuleExpression(
  expression: t.Expression,
  scope: Scope
): boolean {
  return (
    isDirectCssRuleLiteralExpression(expression) ||
    isTopLevelCssRuleCallExpression(expression, scope)
  );
}

export function isDirectCssRuleLiteralExpression(
  expression: t.Expression
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isObjectExpression(unwrappedExpression)) {
    return true;
  }

  return (
    t.isArrayExpression(unwrappedExpression) &&
    isDirectCssRuleArrayExpression(unwrappedExpression)
  );
}

export function isTopLevelCssRuleCallExpression(
  expression: t.Expression,
  scope: Scope
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  return (
    t.isCallExpression(unwrappedExpression) &&
    !isExplicitCxCallExpression(unwrappedExpression, scope)
  );
}

function isExplicitCxCallExpression(
  expression: t.CallExpression,
  scope: Scope
): boolean {
  if (!t.isIdentifier(expression.callee)) {
    return false;
  }

  const bindingPath = scope.getBinding(expression.callee.name)?.path;

  if (!bindingPath?.isImportSpecifier()) {
    return false;
  }

  const imported = bindingPath.node.imported;

  return (
    (t.isIdentifier(imported, { name: "cx" }) ||
      t.isStringLiteral(imported, { value: "cx" })) &&
    bindingPath.parentPath.isImportDeclaration() &&
    bindingPath.parentPath.node.source.value === cssModuleName
  );
}

function isDirectCssRuleArrayExpression(
  expression: t.ArrayExpression
): boolean {
  let hasClassValueBranch = false;

  for (const element of expression.elements) {
    if (!element || t.isSpreadElement(element)) {
      return true;
    }

    const unwrappedElement = unwrapTransparentCssRuleExpression(element);

    if (t.isObjectExpression(unwrappedElement)) {
      continue;
    }

    if (t.isArrayExpression(unwrappedElement)) {
      if (!isDirectCssRuleArrayExpression(unwrappedElement)) {
        hasClassValueBranch = true;
      }

      continue;
    }

    if (t.isStringLiteral(unwrappedElement)) {
      continue;
    }

    if (!isFirstLevelArrayClassValueBranch(unwrappedElement)) {
      return true;
    }

    hasClassValueBranch = true;
  }

  return !hasClassValueBranch;
}

export function isArrayClassValueExpression(
  expression: t.Expression
): expression is t.ArrayExpression {
  return (
    t.isArrayExpression(expression) &&
    !isDirectCssRuleArrayExpression(expression)
  );
}

function classifyUnsupportedCssPropArrayValue(
  expression: t.Expression
): Extract<CssPropValueClassification, "unsupported-array-spread"> | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (containsArraySpreadElement(unwrappedExpression)) {
    return "unsupported-array-spread";
  }

  return null;
}

function hasArraySpreadElement(expression: t.ArrayExpression): boolean {
  return expression.elements.some((element) => {
    if (!element) {
      return false;
    }

    if (t.isSpreadElement(element)) {
      return true;
    }

    return containsArraySpreadElement(element);
  });
}

export function containsArraySpreadElement(expression: t.Expression): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isArrayExpression(unwrappedExpression)) {
    return hasArraySpreadElement(unwrappedExpression);
  }

  if (t.isSequenceExpression(unwrappedExpression)) {
    return unwrappedExpression.expressions.some((sequenceExpression) =>
      containsArraySpreadElement(sequenceExpression)
    );
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return (
      containsArraySpreadElement(unwrappedExpression.consequent) ||
      containsArraySpreadElement(unwrappedExpression.alternate)
    );
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return (
      containsArraySpreadElement(unwrappedExpression.left) ||
      containsArraySpreadElement(unwrappedExpression.right)
    );
  }

  return false;
}

export function containsUnsupportedSequenceCssRuleValue(
  expression: t.Expression
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isSequenceExpression(unwrappedExpression)) {
    return unwrappedExpression.expressions.some((sequenceExpression) => {
      const sequenceValue =
        unwrapTransparentCssRuleExpression(sequenceExpression);

      return (
        t.isObjectExpression(sequenceValue) ||
        (t.isArrayExpression(sequenceValue) &&
          isDirectCssRuleArrayExpression(sequenceValue)) ||
        containsUnsupportedSequenceCssRuleValue(sequenceValue)
      );
    });
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return unwrappedExpression.elements.some((element) => {
      return (
        !!element &&
        !t.isSpreadElement(element) &&
        containsUnsupportedSequenceCssRuleValue(element)
      );
    });
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return (
      containsUnsupportedSequenceCssRuleValue(unwrappedExpression.consequent) ||
      containsUnsupportedSequenceCssRuleValue(unwrappedExpression.alternate)
    );
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return (
      containsUnsupportedSequenceCssRuleValue(unwrappedExpression.left) ||
      containsUnsupportedSequenceCssRuleValue(unwrappedExpression.right)
    );
  }

  return false;
}

function isFirstLevelArrayClassValueBranch(expression: t.Expression): boolean {
  return (
    t.isBooleanLiteral(expression) ||
    t.isNullLiteral(expression) ||
    t.isIdentifier(expression) ||
    t.isNumericLiteral(expression) ||
    t.isBigIntLiteral(expression) ||
    t.isTemplateLiteral(expression) ||
    t.isMemberExpression(expression) ||
    t.isOptionalMemberExpression(expression) ||
    t.isCallExpression(expression) ||
    t.isOptionalCallExpression(expression) ||
    t.isLogicalExpression(expression) ||
    t.isConditionalExpression(expression)
  );
}

type ConditionalCssRuleBranchClassification = "css-rule" | "class-value";
type ArrayClassNameBranchClassification =
  | ConditionalCssRuleBranchClassification
  | "array-class-value";

export function isConditionalCssRuleBranchExpression(
  expression: t.Expression,
  scope: Scope
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (!t.isConditionalExpression(unwrappedExpression)) {
    return false;
  }

  const consequentClassification = classifyConditionalCssRuleBranch(
    unwrappedExpression.consequent,
    scope
  );
  const alternateClassification = classifyConditionalCssRuleBranch(
    unwrappedExpression.alternate,
    scope
  );

  if (!consequentClassification || !alternateClassification) {
    return false;
  }

  return (
    consequentClassification === "css-rule" ||
    alternateClassification === "css-rule"
  );
}

export function isConditionalArrayClassNameBranchExpression(
  expression: t.Expression,
  scope: Scope
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (!t.isConditionalExpression(unwrappedExpression)) {
    return false;
  }

  const consequentClassification = classifyArrayClassNameBranch(
    unwrappedExpression.consequent,
    scope
  );
  const alternateClassification = classifyArrayClassNameBranch(
    unwrappedExpression.alternate,
    scope
  );

  if (!consequentClassification || !alternateClassification) {
    return false;
  }

  return (
    consequentClassification === "array-class-value" ||
    alternateClassification === "array-class-value"
  );
}

export function isLogicalCssRuleBranchExpression(
  expression: t.Expression,
  scope: Scope
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (!t.isLogicalExpression(unwrappedExpression)) {
    return false;
  }

  const leftClassification = classifyLogicalCssRuleLeftOperand(
    unwrappedExpression.left,
    scope
  );
  const rightClassification = classifyLogicalCssRuleRightOperand(
    unwrappedExpression.right,
    scope
  );

  if (!leftClassification || !rightClassification) {
    return false;
  }

  if (
    isStaticLeftLogicalCssRuleOperator(unwrappedExpression.operator) &&
    leftClassification === "css-rule"
  ) {
    return true;
  }

  if (
    isStaticLeftLogicalCssRuleGuardOperator(unwrappedExpression.operator) &&
    leftClassification === "css-rule"
  ) {
    return true;
  }

  return (
    isSupportedRightLogicalCssRuleOperator(unwrappedExpression.operator) &&
    leftClassification === "class-value" &&
    rightClassification === "css-rule"
  );
}

export function isLogicalArrayClassNameBranchExpression(
  expression: t.Expression,
  scope: Scope
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (!t.isLogicalExpression(unwrappedExpression)) {
    return false;
  }

  const leftClassification = classifyArrayClassNameLogicalLeftOperand(
    unwrappedExpression.left,
    scope
  );
  const rightClassification = classifyArrayClassNameBranch(
    unwrappedExpression.right,
    scope
  );

  if (!leftClassification || !rightClassification) {
    return false;
  }

  if (
    isStaticLeftLogicalCssRuleOperator(unwrappedExpression.operator) &&
    leftClassification === "css-rule"
  ) {
    return true;
  }

  if (
    isStaticLeftLogicalCssRuleGuardOperator(unwrappedExpression.operator) &&
    leftClassification === "css-rule"
  ) {
    return rightClassification === "array-class-value";
  }

  return (
    isSupportedRightLogicalCssRuleOperator(unwrappedExpression.operator) &&
    leftClassification === "class-value" &&
    rightClassification === "array-class-value"
  );
}

export function isStaticLeftLogicalCssRuleOperator(
  operator: t.LogicalExpression["operator"]
): boolean {
  return operator === "||" || operator === "??";
}

export function isStaticLeftLogicalCssRuleGuardOperator(
  operator: t.LogicalExpression["operator"]
): boolean {
  return operator === "&&";
}

export function isSupportedRightLogicalCssRuleOperator(
  operator: t.LogicalExpression["operator"]
): boolean {
  return operator === "&&" || operator === "||" || operator === "??";
}

function classifyLogicalCssRuleLeftOperand(
  expression: t.Expression,
  scope: Scope
): ConditionalCssRuleBranchClassification | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (isDirectCssRuleExpression(unwrappedExpression, scope)) {
    return "css-rule";
  }

  if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
    return null;
  }

  return "class-value";
}

function classifyLogicalCssRuleRightOperand(
  expression: t.Expression,
  scope: Scope
): ConditionalCssRuleBranchClassification | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (isDirectCssRuleExpression(unwrappedExpression, scope)) {
    return "css-rule";
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    if (isConditionalCssRuleBranchExpression(unwrappedExpression, scope)) {
      return "css-rule";
    }

    if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
      return null;
    }

    return "class-value";
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    if (isLogicalCssRuleBranchExpression(unwrappedExpression, scope)) {
      return "css-rule";
    }

    if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
      return null;
    }

    return "class-value";
  }

  if (
    t.isFunctionExpression(unwrappedExpression) ||
    t.isArrowFunctionExpression(unwrappedExpression) ||
    isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)
  ) {
    return null;
  }

  return "class-value";
}

function classifyArrayClassNameLogicalLeftOperand(
  expression: t.Expression,
  scope: Scope
): ConditionalCssRuleBranchClassification | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (isDirectCssRuleExpression(unwrappedExpression, scope)) {
    return "css-rule";
  }

  if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
    return null;
  }

  return "class-value";
}

function classifyArrayClassNameBranch(
  expression: t.Expression,
  scope: Scope
): ArrayClassNameBranchClassification | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (isDirectCssRuleExpression(unwrappedExpression, scope)) {
    return "css-rule";
  }

  if (isArrayClassValueExpression(unwrappedExpression)) {
    return "array-class-value";
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    if (isConditionalCssRuleBranchExpression(unwrappedExpression, scope)) {
      return "css-rule";
    }

    if (
      isConditionalArrayClassNameBranchExpression(unwrappedExpression, scope)
    ) {
      return "array-class-value";
    }

    if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
      return null;
    }

    return "class-value";
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    if (isLogicalCssRuleBranchExpression(unwrappedExpression, scope)) {
      return "css-rule";
    }

    if (isLogicalArrayClassNameBranchExpression(unwrappedExpression, scope)) {
      return "array-class-value";
    }

    if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
      return null;
    }

    return "class-value";
  }

  if (
    t.isFunctionExpression(unwrappedExpression) ||
    t.isArrowFunctionExpression(unwrappedExpression) ||
    isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)
  ) {
    return null;
  }

  return "class-value";
}

function classifyConditionalCssRuleBranch(
  expression: t.Expression,
  scope: Scope
): ConditionalCssRuleBranchClassification | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (isDirectCssRuleExpression(unwrappedExpression, scope)) {
    return "css-rule";
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    if (isConditionalCssRuleBranchExpression(unwrappedExpression, scope)) {
      return "css-rule";
    }

    if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
      return null;
    }

    return "class-value";
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    if (isLogicalCssRuleBranchExpression(unwrappedExpression, scope)) {
      return "css-rule";
    }

    if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
      return null;
    }

    return "class-value";
  }

  if (
    t.isFunctionExpression(unwrappedExpression) ||
    t.isArrowFunctionExpression(unwrappedExpression) ||
    isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)
  ) {
    return null;
  }

  return "class-value";
}

export function hasTopLevelCssRuleCallBranchExpression(
  expression: t.Expression,
  scope: Scope
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isConditionalExpression(unwrappedExpression)) {
    return (
      isTopLevelCssRuleCallExpression(unwrappedExpression.consequent, scope) ||
      isTopLevelCssRuleCallExpression(unwrappedExpression.alternate, scope)
    );
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return (
      isTopLevelCssRuleCallExpression(unwrappedExpression.left, scope) ||
      isTopLevelCssRuleCallExpression(unwrappedExpression.right, scope)
    );
  }

  return false;
}

export function hasTopLevelCssRuleCallArrayBranchExpression(
  expression: t.Expression,
  scope: Scope
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (!t.isArrayExpression(unwrappedExpression)) {
    return false;
  }

  return unwrappedExpression.elements.some((element) => {
    if (!element || t.isSpreadElement(element)) {
      return false;
    }

    return hasTopLevelCssRuleCallBranchExpression(element, scope);
  });
}

export function canEmitCssClassNameDirectly(
  expression: t.Expression,
  classification: CssPropValueClassification,
  scope: Scope
): boolean {
  if (classification === "css-rule") {
    return true;
  }

  if (classification !== "branch-css-rule") {
    return false;
  }

  if (isPureConditionalCssRuleExpression(expression, scope)) {
    return true;
  }

  return isDirectLogicalCssRuleExpression(expression, scope);
}

export function isDirectLogicalCssRuleExpression(
  expression: t.Expression,
  scope: Scope
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (!t.isLogicalExpression(unwrappedExpression)) {
    return false;
  }

  if (isStaticLeftLogicalCssRuleOperator(unwrappedExpression.operator)) {
    return isDirectCssRuleExpression(unwrappedExpression.left, scope);
  }

  return (
    isStaticLeftLogicalCssRuleGuardOperator(unwrappedExpression.operator) &&
    isDirectCssRuleExpression(unwrappedExpression.left, scope) &&
    isDirectCssRuleExpression(unwrappedExpression.right, scope)
  );
}

function isPureConditionalCssRuleExpression(
  expression: t.Expression,
  scope: Scope
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  return (
    t.isConditionalExpression(unwrappedExpression) &&
    isDirectCssRuleExpression(unwrappedExpression.consequent, scope) &&
    isDirectCssRuleExpression(unwrappedExpression.alternate, scope)
  );
}

export function isUnsupportedDynamicCssRuleValue(
  expression: t.Expression,
  isBranchExpression = false
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (
    t.isObjectExpression(unwrappedExpression) ||
    t.isArrayExpression(unwrappedExpression)
  ) {
    return (
      isBranchExpression ||
      (unwrappedExpression !== expression &&
        (!t.isArrayExpression(unwrappedExpression) ||
          isDirectCssRuleArrayExpression(unwrappedExpression)))
    );
  }

  if (t.isSequenceExpression(unwrappedExpression)) {
    return unwrappedExpression.expressions.some((sequenceExpression) =>
      isUnsupportedDynamicCssRuleValue(sequenceExpression, true)
    );
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return (
      isUnsupportedDynamicCssRuleValue(unwrappedExpression.consequent, true) ||
      isUnsupportedDynamicCssRuleValue(unwrappedExpression.alternate, true)
    );
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return (
      isUnsupportedDynamicCssRuleValue(unwrappedExpression.left, true) ||
      isUnsupportedDynamicCssRuleValue(unwrappedExpression.right, true)
    );
  }

  return false;
}
