import { types as t } from "@babel/core";
import type { Binding } from "@babel/traverse";
import { getStaticObjectMemberValue } from "../ast.js";
import { unwrapTransparentCssRuleExpression } from "../candidates.js";
import type { StaticCssEvalDiagnostic } from "../types.js";
import type { SameFileDeclarationKind } from "./types.js";

export function getExpressionRange(
  expression: t.Expression
): { start: number; end: number } | null {
  const { start, end } = expression;

  if (typeof start !== "number" || typeof end !== "number") {
    return null;
  }

  return { start, end };
}

export function getStaticCssEvalConstBindingInitExpression(
  binding: Binding
): t.Expression | null {
  if (getStaticCssEvalBindingDeclarationKind(binding) !== "const") {
    return null;
  }

  return getStaticCssEvalVariableBindingInitExpression(binding);
}

export function getStaticCssEvalBindingDeclarationKind(
  binding: Binding
): SameFileDeclarationKind | null {
  const bindingPath = binding.path;

  if (bindingPath.isVariableDeclarator()) {
    if (!t.isIdentifier(bindingPath.node.id)) {
      return null;
    }

    if (!bindingPath.parentPath.isVariableDeclaration()) {
      return null;
    }

    const { kind } = bindingPath.parentPath.node;
    return kind === "const" || kind === "let" || kind === "var" ? kind : null;
  }

  if (bindingPath.isFunctionDeclaration()) {
    return "function";
  }

  if (bindingPath.isClassDeclaration()) {
    return "class";
  }

  return null;
}

export function getStaticCssEvalVariableBindingInitExpression(
  binding: Binding
): t.Expression | null {
  const bindingPath = binding.path;

  if (
    !bindingPath.isVariableDeclarator() ||
    !t.isIdentifier(bindingPath.node.id)
  ) {
    return null;
  }

  const initPath = bindingPath.get("init");

  if (!initPath.node || !initPath.isExpression()) {
    return null;
  }

  return initPath.node;
}

export function resolveStaticMemberPath(
  expression: t.Expression,
  memberPath: readonly string[]
): t.Expression | null {
  let currentExpression: t.Expression | null =
    unwrapTransparentCssRuleExpression(expression);

  for (const memberName of memberPath) {
    if (!currentExpression) {
      return null;
    }

    const unwrappedExpression =
      unwrapTransparentCssRuleExpression(currentExpression);

    if (t.isObjectExpression(unwrappedExpression)) {
      currentExpression = getStaticObjectMemberValue(
        unwrappedExpression,
        memberName
      );
      continue;
    }

    return null;
  }

  return currentExpression
    ? unwrapTransparentCssRuleExpression(currentExpression)
    : null;
}

export function getStaticArrayMemberValue(
  expression: t.ArrayExpression,
  memberName: string
): t.Expression | null {
  const memberIndex = Number(memberName);

  if (
    !/^\d+$/.test(memberName) ||
    String(memberIndex) !== memberName ||
    memberIndex > 2 ** 32 - 2
  ) {
    return null;
  }

  const element = expression.elements[memberIndex];

  return element && t.isExpression(element) ? element : null;
}

export function isComputedOrOptionalMemberExpression(
  expression: t.Expression
): expression is t.MemberExpression | t.OptionalMemberExpression {
  return (
    (t.isMemberExpression(expression) && expression.computed) ||
    t.isOptionalMemberExpression(expression)
  );
}

export function shouldTreatStaticMemberMissAsNotCandidate(
  expression: t.MemberExpression | t.OptionalMemberExpression,
  diagnostic: StaticCssEvalDiagnostic
): boolean {
  return (
    t.isMemberExpression(expression) &&
    expression.computed &&
    (t.isStringLiteral(expression.property) ||
      t.isNumericLiteral(expression.property)) &&
    diagnostic.id === "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED" &&
    diagnostic.reason === "runtime-dynamic-value" &&
    diagnostic.expressionType === "MemberExpression"
  );
}

export function isStaticCssRuleLiteral(
  expression: t.Expression
): expression is t.ObjectExpression | t.ArrayExpression {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);
  return (
    t.isObjectExpression(unwrappedExpression) ||
    t.isArrayExpression(unwrappedExpression)
  );
}

export function isProvenStaticCssRuleMemberTarget(
  expression: t.Expression,
  unsupportedPropertyName?: string
): boolean {
  if (unsupportedPropertyName !== undefined) {
    const value = getStaticMemberValueForUnsupportedProperty(
      expression,
      unsupportedPropertyName
    );

    return Boolean(value && isStaticCssRuleLiteral(value));
  }

  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isObjectExpression(unwrappedExpression)) {
    return hasOnlyStaticCssRuleObjectValues(unwrappedExpression);
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return hasOnlyStaticCssRuleArrayValues(unwrappedExpression);
  }

  return false;
}

function getStaticMemberValueForUnsupportedProperty(
  expression: t.Expression,
  memberName: string
): t.Expression | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isObjectExpression(unwrappedExpression)) {
    return getStaticObjectMemberValue(unwrappedExpression, memberName);
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return getStaticArrayMemberValue(unwrappedExpression, memberName);
  }

  return null;
}

function hasOnlyStaticCssRuleObjectValues(
  expression: t.ObjectExpression
): boolean {
  if (expression.properties.length === 0) {
    return false;
  }

  return expression.properties.every((property) => {
    if (!t.isObjectProperty(property) || property.computed) {
      return false;
    }

    return (
      t.isExpression(property.value) && isStaticCssRuleLiteral(property.value)
    );
  });
}

function hasOnlyStaticCssRuleArrayValues(
  expression: t.ArrayExpression
): boolean {
  if (expression.elements.length === 0) {
    return false;
  }

  return expression.elements.every((element) => {
    return Boolean(
      element && !t.isSpreadElement(element) && isStaticCssRuleLiteral(element)
    );
  });
}
