import { types as t } from "@babel/core";
import { getStaticObjectMemberValue } from "../ast.js";
import { unwrapTransparentCssRuleExpression } from "../candidates.js";
import type { StaticCssLiteral } from "../types.js";

export function resolveStaticObjectMemberPath(
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

    if (t.isArrayExpression(unwrappedExpression)) {
      const index = getStaticArrayIndex(memberName);
      const element =
        index === null ? null : unwrappedExpression.elements[index];
      const hasSpreadBeforeOrAtIndex =
        index !== null &&
        unwrappedExpression.elements
          .slice(0, index + 1)
          .some((arrayElement) => t.isSpreadElement(arrayElement));
      currentExpression =
        !hasSpreadBeforeOrAtIndex && element && t.isExpression(element)
          ? element
          : null;
      continue;
    }

    return null;
  }

  return currentExpression
    ? unwrapTransparentCssRuleExpression(currentExpression)
    : null;
}

export function selectStaticCssEvalExpressionForMemberPath(
  expression: t.Expression,
  memberPath: readonly string[]
): {
  readonly expression: t.Expression;
  readonly deferredMemberPath: string[];
} {
  const selectedExpression = resolveStaticObjectMemberPath(
    expression,
    memberPath
  );

  if (selectedExpression) {
    return {
      expression: selectedExpression,
      deferredMemberPath: []
    };
  }

  return {
    expression: unwrapTransparentCssRuleExpression(expression),
    deferredMemberPath: [...memberPath]
  };
}

export function selectStaticCssLiteralMemberPath(
  value: StaticCssLiteral,
  memberPath: readonly string[]
): { kind: "resolved"; value: StaticCssLiteral } | { kind: "not-candidate" } {
  let currentValue = value;

  for (const memberName of memberPath) {
    const nextValue = Array.isArray(currentValue)
      ? currentValue[getStaticArrayIndex(memberName) ?? -1]
      : isStaticCssLiteralObject(currentValue) &&
          Object.prototype.hasOwnProperty.call(currentValue, memberName)
        ? currentValue[memberName]
        : undefined;

    if (nextValue === undefined) {
      return { kind: "not-candidate" };
    }

    currentValue = nextValue;
  }

  return { kind: "resolved", value: currentValue };
}

function getStaticArrayIndex(memberName: string): number | null {
  return /^\d+$/.test(memberName) && String(Number(memberName)) === memberName
    ? Number(memberName)
    : null;
}

export function canUseImportedStaticMemberReferenceFastPath(
  expression: t.MemberExpression
): boolean {
  if (t.isSuper(expression.object)) {
    return false;
  }

  if (!isDirectStaticMemberPropertyName(expression)) {
    return false;
  }

  const object = unwrapTransparentCssRuleExpression(expression.object);

  if (t.isIdentifier(object)) {
    return true;
  }

  return t.isMemberExpression(object)
    ? canUseImportedStaticMemberReferenceFastPath(object)
    : false;
}

export function isDirectStaticMemberPropertyName(
  expression: t.MemberExpression
): boolean {
  if (!expression.computed) {
    return t.isIdentifier(expression.property);
  }

  return (
    t.isStringLiteral(expression.property) ||
    t.isNumericLiteral(expression.property)
  );
}

export function isStaticCssLiteralObject(
  value: StaticCssLiteral
): value is { [key: string]: StaticCssLiteral } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
