import type { NodePath } from "@babel/core";
import { types as t } from "@babel/core";
import type {
  StaticCssEvalQuery,
  StaticCssEvalUnsupportedReason
} from "./types.js";

const cssAttributeName = "css";

export type StaticCssEvalCandidate = StaticCssEvalQuery;

export interface CollectJsxCssPropStaticCssEvalCandidatesOptions {
  importerId: string;
}

export type StaticMemberReference =
  | SupportedStaticMemberReference
  | UnsupportedStaticMemberReference;

interface SupportedStaticMemberReference {
  kind: "supported";
  bindingName: string;
  memberPath: string[];
  expressionStart: number;
  expressionEnd: number;
}

interface UnsupportedStaticMemberReference {
  kind: "unsupported";
  bindingName: string;
  memberPath: string[];
  reason: StaticCssEvalUnsupportedReason;
  detail: string;
  unsupportedPropertyName?: string;
}

type TransparentCssRuleWrapperExpression = t.Expression & {
  expression: t.Expression;
};

export function collectJsxCssPropStaticCssEvalCandidates(
  path: NodePath<t.Program>,
  options: CollectJsxCssPropStaticCssEvalCandidatesOptions
): StaticCssEvalCandidate[] {
  const candidates: StaticCssEvalCandidate[] = [];

  path.traverse({
    JSXAttribute(attributePath) {
      if (!isCssPropAttribute(attributePath.node)) {
        return;
      }

      const expression = getJsxExpressionContainerValue(attributePath.node);

      if (!expression) {
        return;
      }

      const candidate = createStaticCssEvalCandidate(
        expression,
        options.importerId
      );

      if (candidate) {
        candidates.push(candidate);
      }
    }
  });

  return candidates;
}

export function createStaticCssEvalCandidate(
  expression: t.Expression,
  importerId: string
): StaticCssEvalCandidate | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);
  const range = getExpressionRange(unwrappedExpression);
  const reference = getStaticCssEvalMemberReference(unwrappedExpression);

  if (!range || !reference || reference.kind !== "supported") {
    return null;
  }

  return {
    importerId,
    expressionStart: range.start,
    expressionEnd: range.end,
    bindingName: reference.bindingName,
    ...(reference.memberPath.length > 0
      ? { memberPath: reference.memberPath }
      : {})
  };
}

export function unwrapTransparentCssRuleExpression(
  expression: t.Expression
): t.Expression {
  let currentExpression = expression;

  while (isTransparentCssRuleWrapperExpression(currentExpression)) {
    currentExpression = currentExpression.expression;
  }

  return currentExpression;
}

export function isTransparentCssRuleWrapperExpression(
  expression: t.Expression
): expression is TransparentCssRuleWrapperExpression {
  return (
    expression.type === "TSNonNullExpression" ||
    expression.type === "TSAsExpression" ||
    expression.type === "TSSatisfiesExpression" ||
    expression.type === "ParenthesizedExpression" ||
    expression.type === "TypeCastExpression" ||
    expression.type === "TSTypeAssertion"
  );
}

function isCssPropAttribute(attribute: t.JSXAttribute): boolean {
  return (
    t.isJSXIdentifier(attribute.name) &&
    attribute.name.name === cssAttributeName
  );
}

function getJsxExpressionContainerValue(
  attribute: t.JSXAttribute
): t.Expression | null {
  if (!t.isJSXExpressionContainer(attribute.value)) {
    return null;
  }

  const { expression } = attribute.value;

  if (t.isJSXEmptyExpression(expression)) {
    return null;
  }

  return expression;
}

function getExpressionRange(
  expression: t.Expression
): { start: number; end: number } | null {
  const { start, end } = expression;

  if (typeof start !== "number" || typeof end !== "number") {
    return null;
  }

  return { start, end };
}

export function getStaticCssEvalMemberReference(
  expression: t.Expression
): StaticMemberReference | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isIdentifier(unwrappedExpression)) {
    return {
      kind: "supported",
      bindingName: unwrappedExpression.name,
      memberPath: [],
      expressionStart: unwrappedExpression.start ?? 0,
      expressionEnd: unwrappedExpression.end ?? 0
    };
  }

  if (t.isMemberExpression(unwrappedExpression)) {
    return getMemberExpressionReference(unwrappedExpression);
  }

  if (t.isOptionalMemberExpression(unwrappedExpression)) {
    return getOptionalMemberExpressionReference(unwrappedExpression);
  }

  return null;
}

function getMemberExpressionReference(
  expression: t.MemberExpression
): StaticMemberReference | null {
  if (t.isSuper(expression.object)) {
    return null;
  }

  const objectReference = getStaticCssEvalMemberReference(expression.object);

  if (!objectReference) {
    return null;
  }

  if (objectReference.kind === "unsupported") {
    return objectReference;
  }

  const propertyName = getStaticMemberPropertyName(expression);

  if (!propertyName) {
    return createUnsupportedMemberPathReference(objectReference);
  }

  return {
    kind: "supported",
    bindingName: objectReference.bindingName,
    memberPath: [...objectReference.memberPath, propertyName],
    expressionStart: expression.start ?? objectReference.expressionStart,
    expressionEnd: expression.end ?? objectReference.expressionEnd
  };
}

function getOptionalMemberExpressionReference(
  expression: t.OptionalMemberExpression
): StaticMemberReference | null {
  if (t.isSuper(expression.object)) {
    return null;
  }

  const objectReference = getStaticCssEvalMemberReference(expression.object);

  if (!objectReference) {
    return null;
  }

  if (objectReference.kind === "unsupported") {
    return objectReference;
  }

  return {
    kind: "unsupported",
    bindingName: objectReference.bindingName,
    memberPath: objectReference.memberPath,
    reason: "optional-member-path",
    detail: "optional member paths are unsupported"
  };
}

function createUnsupportedMemberPathReference(
  objectReference: SupportedStaticMemberReference
): UnsupportedStaticMemberReference {
  return {
    kind: "unsupported",
    bindingName: objectReference.bindingName,
    memberPath: objectReference.memberPath,
    reason: "dynamic-member-path",
    detail: "dynamic computed member paths are unsupported"
  };
}

function getStaticMemberPropertyName(
  expression: t.MemberExpression
): string | null {
  const { computed, property } = expression;

  if (!computed && t.isIdentifier(property)) {
    return property.name;
  }

  if (computed && t.isStringLiteral(property)) {
    return property.value;
  }

  if (computed && t.isNumericLiteral(property)) {
    return String(property.value);
  }

  return null;
}
