import { types as t } from "@babel/core";
import {
  createStaticCssEvalCandidate,
  unwrapTransparentCssRuleExpression
} from "../candidates.js";
import type {
  StaticCssEvalDiagnostic,
  StaticCssEvalProvider,
  StaticCssLiteral
} from "../types.js";
import type { ResolveImportedStaticCssEvalExpressionResult } from "./contracts.js";
import {
  findUnsupportedImportedArrayReferenceDiagnostic,
  findUnsupportedImportedExpressionReferenceDiagnostic,
  findUnsupportedImportedObjectReferenceDiagnostic,
  isStaticCssRuleLiteralValue
} from "./literalEval.js";

export function resolveImportedStaticCssEvalExpression(options: {
  expression: t.Expression;
  ownerFile: string;
  provider?: StaticCssEvalProvider;
  allowUnsupportedSourceFallback?: boolean;
}): ResolveImportedStaticCssEvalExpressionResult {
  if (!options.provider) {
    return { kind: "not-candidate" };
  }

  const candidate = createStaticCssEvalCandidate(
    options.expression,
    options.ownerFile
  );

  if (!candidate?.bindingName) {
    return { kind: "not-candidate" };
  }

  const result = options.provider.getResolvedCssValue(candidate);

  if (result.kind === "not-candidate") {
    return { kind: "not-candidate" };
  }

  if (result.kind === "error") {
    if (
      options.allowUnsupportedSourceFallback === true &&
      result.diagnostic.reason === "reexport-or-barrel" &&
      result.diagnostic.id === undefined
    ) {
      return { kind: "not-candidate" };
    }

    return { kind: "error", diagnostic: result.diagnostic };
  }

  if (!isStaticCssRuleLiteralValue(result.value)) {
    return { kind: "not-candidate" };
  }

  const expression = createStaticCssLiteralExpression(result.value);

  return t.isObjectExpression(expression) || t.isArrayExpression(expression)
    ? { kind: "resolved", expression }
    : { kind: "not-candidate" };
}

export function findUnsupportedImportedStaticCssEvalReferenceDiagnostic(options: {
  expression: t.Expression;
  ownerFile: string;
  provider?: StaticCssEvalProvider;
}): StaticCssEvalDiagnostic | null {
  const { provider } = options;

  if (!provider) {
    return null;
  }

  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    options.expression
  );

  if (t.isObjectExpression(unwrappedExpression)) {
    return findUnsupportedImportedObjectReferenceDiagnostic(
      unwrappedExpression,
      { ownerFile: options.ownerFile, provider }
    );
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return findUnsupportedImportedArrayReferenceDiagnostic(
      unwrappedExpression,
      { ownerFile: options.ownerFile, provider }
    );
  }

  return findUnsupportedImportedExpressionReferenceDiagnostic(
    unwrappedExpression,
    {
      ownerFile: options.ownerFile,
      provider,
      includeSupportedReferenceErrors: false
    }
  );
}

export function createStaticCssLiteralExpression(
  value: StaticCssLiteral
): t.Expression {
  if (Array.isArray(value)) {
    return t.arrayExpression(value.map(createStaticCssLiteralExpression));
  }

  if (value && typeof value === "object") {
    return t.objectExpression(
      Object.entries(value).map(([key, propertyValue]) =>
        t.objectProperty(
          t.isValidIdentifier(key) ? t.identifier(key) : t.stringLiteral(key),
          createStaticCssLiteralExpression(propertyValue)
        )
      )
    );
  }

  if (typeof value === "string") {
    return t.stringLiteral(value);
  }

  if (typeof value === "number") {
    return t.numericLiteral(value);
  }

  if (typeof value === "boolean") {
    return t.booleanLiteral(value);
  }

  return t.nullLiteral();
}
