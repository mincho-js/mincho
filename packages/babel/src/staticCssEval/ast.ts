import { types as t } from "@babel/core";
import { unwrapTransparentCssRuleExpression } from "./candidates.js";
import type { StaticCssEvalUnsupportedReason } from "./types.js";

export function preserveDirectBooleanReferenceValue(
  originalExpression: t.Expression,
  resolvedExpression: t.Expression
): t.Expression {
  const original = unwrapTransparentCssRuleExpression(originalExpression);

  return t.isBooleanLiteral(resolvedExpression) &&
    (t.isIdentifier(original) ||
      (t.isMemberExpression(original) &&
        !original.computed &&
        t.isIdentifier(original.property)))
    ? t.cloneNode(original)
    : t.cloneNode(resolvedExpression);
}

export function getStaticObjectMemberValue(
  expression: t.ObjectExpression,
  memberName: string
): t.Expression | null {
  for (let index = expression.properties.length - 1; index >= 0; index -= 1) {
    const property = expression.properties[index];

    if (!property || !t.isObjectProperty(property) || property.computed) {
      return null;
    }

    if (getStaticObjectPropertyName(property.key) !== memberName) {
      continue;
    }

    return t.isExpression(property.value) ? property.value : null;
  }

  return null;
}

export function getStaticObjectPropertyName(
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

export function getStaticMemberPropertyName(
  expression: t.MemberExpression | t.OptionalMemberExpression
): string | null {
  if (!expression.computed && t.isIdentifier(expression.property)) {
    return expression.property.name;
  }

  if (expression.computed && t.isStringLiteral(expression.property)) {
    return expression.property.value;
  }

  if (expression.computed && t.isNumericLiteral(expression.property)) {
    return String(expression.property.value);
  }

  return null;
}

export function getUnsupportedLiteralReason(
  expression: t.Expression
): StaticCssEvalUnsupportedReason {
  if (
    expression.type === "ImportExpression" ||
    (t.isCallExpression(expression) && t.isImport(expression.callee))
  ) {
    return "dynamic-import";
  }

  if (t.isIdentifier(expression)) {
    return "identifier-object-value";
  }

  if (
    t.isMemberExpression(expression) ||
    t.isOptionalMemberExpression(expression)
  ) {
    return "member-expression-object-value";
  }

  if (
    t.isCallExpression(expression) ||
    t.isOptionalCallExpression(expression)
  ) {
    return "function-or-call";
  }

  if (
    t.isConditionalExpression(expression) ||
    t.isLogicalExpression(expression)
  ) {
    return "conditional-or-logical-expression";
  }

  if (t.isBinaryExpression(expression)) {
    return "binary-expression";
  }

  if (
    t.isTemplateLiteral(expression) ||
    t.isTaggedTemplateExpression(expression)
  ) {
    return "template-expression";
  }

  return "unsupported-literal";
}
