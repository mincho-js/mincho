import { types as t } from "@babel/core";
import { getUnsupportedLiteralReason } from "../ast.js";
import {
  getStaticCssEvalMemberReference,
  unwrapTransparentCssRuleExpression
} from "../candidates.js";
import type { StaticMemberReference } from "../candidates.js";
import {
  createStaticCssEvalDynamicExpressionUnsupportedDiagnostic,
  createStaticCssEvalDiagnostic
} from "../diagnostics.js";
import type {
  StaticCssEvalDiagnostic,
  StaticCssEvalUnsupportedReason
} from "../types.js";
import { createSameFileDiagnosticContext } from "./metadata.js";
import type { SameFileStaticCssEvalContext } from "./types.js";
import { isSupportedStaticCssPrimitiveLiteral } from "./primitives.js";

export function createUnsupportedMemberReferenceDiagnostic(
  reference: Extract<StaticMemberReference, { kind: "unsupported" }>,
  context: SameFileStaticCssEvalContext
): StaticCssEvalDiagnostic {
  if (reference.reason === "optional-member-path") {
    return createSameFileStaticCssEvalDiagnostic(
      context,
      "unsupported-syntax",
      reference.reason,
      `same-file binding "${context.bindingName}" contains unsupported ${reference.reason}: ${reference.detail}`,
      "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
    );
  }

  return createSameFileStaticCssEvalDiagnostic(
    context,
    "unsupported-syntax",
    reference.reason,
    `same-file binding "${context.bindingName}" contains unsupported ${reference.reason}: ${reference.detail}`,
    "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED"
  );
}

export function createUnsupportedDynamicExpressionDiagnostic(
  context: SameFileStaticCssEvalContext,
  expression: t.Expression
): StaticCssEvalDiagnostic | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  const memberReference = getStaticCssEvalMemberReference(unwrappedExpression);

  if (memberReference?.kind === "unsupported") {
    return createUnsupportedMemberReferenceDiagnostic(memberReference, context);
  }

  if (isSupportedStaticCssPrimitiveLiteral(unwrappedExpression)) {
    return null;
  }

  if (
    t.isCallExpression(unwrappedExpression) ||
    t.isOptionalCallExpression(unwrappedExpression) ||
    t.isNewExpression(unwrappedExpression) ||
    t.isFunctionExpression(unwrappedExpression) ||
    t.isArrowFunctionExpression(unwrappedExpression) ||
    t.isConditionalExpression(unwrappedExpression) ||
    t.isLogicalExpression(unwrappedExpression) ||
    t.isBinaryExpression(unwrappedExpression) ||
    t.isTaggedTemplateExpression(unwrappedExpression) ||
    t.isOptionalMemberExpression(unwrappedExpression)
  ) {
    return createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
      createSameFileDiagnosticContext(context),
      unwrappedExpression.type
    );
  }

  return null;
}

export function createSameFileArrayHoleDiagnostic(
  context: SameFileStaticCssEvalContext
): StaticCssEvalDiagnostic {
  return createSameFileStaticCssEvalDiagnostic(
    context,
    "unsupported-syntax",
    "unsupported-literal",
    `same-file binding "${context.bindingName}" contains an array hole`
  );
}

export function createUnsupportedLiteralDiagnostic(
  context: SameFileStaticCssEvalContext,
  expression: t.Expression
): StaticCssEvalDiagnostic {
  const dynamicDiagnostic = createUnsupportedDynamicExpressionDiagnostic(
    context,
    expression
  );

  if (dynamicDiagnostic) {
    return dynamicDiagnostic;
  }

  const reason = getUnsupportedLiteralReason(expression);

  return createSameFileStaticCssEvalDiagnostic(
    context,
    "unsupported-syntax",
    reason,
    `same-file binding "${context.bindingName}" contains unsupported ${reason}: ${expression.type}`
  );
}

export function createSameFileStaticCssEvalDiagnostic(
  context: SameFileStaticCssEvalContext,
  code: StaticCssEvalDiagnostic["code"],
  reason: StaticCssEvalUnsupportedReason,
  detail: string,
  id?: StaticCssEvalDiagnostic["id"]
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    ...(id !== undefined ? { id } : {}),
    code,
    reason,
    detail,
    owner: context.owner,
    ...(context.memberPath.length > 0 ? { memberPath: context.memberPath } : {})
  });
}
