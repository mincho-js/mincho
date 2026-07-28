import { types as t } from "@babel/core";
import { getStaticObjectPropertyName } from "../ast.js";
import {
  createStaticCssEvalCandidate,
  getStaticCssEvalMemberReference,
  unwrapTransparentCssRuleExpression
} from "../candidates.js";
import {
  createStaticCssEvalComputedMemberUnsupportedDiagnostic,
  createStaticCssEvalDynamicExpressionUnsupportedDiagnostic
} from "../diagnostics.js";
import type {
  StaticCssEvalDiagnostic,
  StaticCssEvalProvider,
  StaticCssLiteral
} from "../types.js";
import type {
  ImportedStaticCssEvalLiteralEvaluationOptions,
  ImportedStaticCssEvalLiteralResult
} from "./contracts.js";
import { formatExportName } from "./format.js";
import {
  createExpressionOwnerLocation,
  createImportedLiteralDiagnosticContext,
  createImportedObjectSpreadError,
  createStaticCssLiteralError,
  createUnsupportedImportedLiteralResult,
  enforceImportedStaticCssEvalDepth,
  enforceImportedStaticCssEvalLiteralCount
} from "./literalDiagnostics.js";
import {
  canUseImportedStaticMemberReferenceFastPath,
  isStaticCssLiteralObject
} from "./memberPath.js";

export function evaluateStaticCssLiteralExpression(
  options: ImportedStaticCssEvalLiteralEvaluationOptions
): ImportedStaticCssEvalLiteralResult {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    options.expression
  );
  options.literalState.count += 1;

  const countResult = enforceImportedStaticCssEvalLiteralCount(
    options.context,
    options.literalState
  );

  if (countResult) {
    return { kind: "error", diagnostic: countResult };
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    const depthResult = enforceImportedStaticCssEvalDepth(
      options.context,
      options.depth
    );

    if (depthResult) {
      return { kind: "error", diagnostic: depthResult };
    }

    return evaluateStaticCssObjectExpression({
      ...options,
      expression: unwrappedExpression
    });
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    const depthResult = enforceImportedStaticCssEvalDepth(
      options.context,
      options.depth
    );

    if (depthResult) {
      return { kind: "error", diagnostic: depthResult };
    }

    return evaluateStaticCssArrayExpression({
      ...options,
      expression: unwrappedExpression
    });
  }

  if (t.isStringLiteral(unwrappedExpression)) {
    return { kind: "resolved", value: unwrappedExpression.value };
  }

  if (t.isNumericLiteral(unwrappedExpression)) {
    return { kind: "resolved", value: unwrappedExpression.value };
  }

  if (t.isBooleanLiteral(unwrappedExpression)) {
    return { kind: "resolved", value: unwrappedExpression.value };
  }

  if (t.isNullLiteral(unwrappedExpression)) {
    return { kind: "resolved", value: null };
  }

  if (
    t.isUnaryExpression(unwrappedExpression) &&
    (unwrappedExpression.operator === "+" ||
      unwrappedExpression.operator === "-") &&
    t.isNumericLiteral(unwrappedExpression.argument)
  ) {
    return {
      kind: "resolved",
      value:
        unwrappedExpression.operator === "-"
          ? -unwrappedExpression.argument.value
          : unwrappedExpression.argument.value
    };
  }

  if (
    t.isTemplateLiteral(unwrappedExpression) &&
    unwrappedExpression.expressions.length === 0
  ) {
    const [quasi] = unwrappedExpression.quasis;
    return {
      kind: "resolved",
      value: quasi?.value.cooked ?? quasi?.value.raw ?? ""
    };
  }

  if (t.isTemplateLiteral(unwrappedExpression)) {
    return evaluateStaticCssTemplateLiteralExpression({
      ...options,
      expression: unwrappedExpression
    });
  }

  if (
    t.isMemberExpression(unwrappedExpression) ||
    t.isOptionalMemberExpression(unwrappedExpression)
  ) {
    if (
      t.isMemberExpression(unwrappedExpression) &&
      canUseImportedStaticMemberReferenceFastPath(unwrappedExpression)
    ) {
      const reference = getStaticCssEvalMemberReference(unwrappedExpression);

      if (reference) {
        return options.resolveReference({
          ...options,
          expression: unwrappedExpression,
          reference
        });
      }
    }

    return evaluateStaticCssMemberExpression({
      ...options,
      expression: unwrappedExpression
    });
  }

  const reference = getStaticCssEvalMemberReference(unwrappedExpression);

  if (reference) {
    return options.resolveReference({
      ...options,
      expression: unwrappedExpression,
      reference
    });
  }

  return createUnsupportedImportedLiteralResult(options, unwrappedExpression);
}

export function evaluateStaticCssTemplateLiteralExpression(
  options: ImportedStaticCssEvalLiteralEvaluationOptions & {
    readonly expression: t.TemplateLiteral;
  }
): ImportedStaticCssEvalLiteralResult {
  let value = "";

  for (let index = 0; index < options.expression.quasis.length; index += 1) {
    const quasi = options.expression.quasis[index];

    if (quasi) {
      value += quasi.value.cooked ?? quasi.value.raw;
    }

    const interpolation = options.expression.expressions[index];

    if (!interpolation) {
      continue;
    }

    if (!t.isExpression(interpolation)) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          createImportedLiteralDiagnosticContext(options.context),
          interpolation.type
        )
      };
    }

    const interpolationResult = evaluateStaticCssLiteralExpression({
      ...options,
      expression: interpolation,
      depth: options.depth + 1
    });

    if (interpolationResult.kind === "error") {
      return interpolationResult;
    }

    const primitiveValue = getTemplateInterpolationPrimitiveValue(
      interpolationResult.value
    );

    if (primitiveValue === undefined) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          createImportedLiteralDiagnosticContext(options.context),
          interpolation.type
        )
      };
    }

    value += String(primitiveValue);
  }

  return { kind: "resolved", value };
}

export function evaluateStaticCssMemberExpression(
  options: ImportedStaticCssEvalLiteralEvaluationOptions & {
    readonly expression: t.MemberExpression | t.OptionalMemberExpression;
  }
): ImportedStaticCssEvalLiteralResult {
  if (t.isSuper(options.expression.object)) {
    return {
      kind: "error",
      diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
        createImportedLiteralDiagnosticContext(options.context),
        options.expression.type
      )
    };
  }

  const objectResult = evaluateStaticCssLiteralExpression({
    ...options,
    expression: options.expression.object,
    depth: options.depth + 1
  });

  if (objectResult.kind === "error") {
    return objectResult;
  }

  const memberNameResult = resolveImportedStaticMemberName({
    ...options,
    depth: options.depth + 1
  });

  if (memberNameResult.kind === "error") {
    return memberNameResult;
  }

  const memberValue = selectStaticCssLiteralMemberValue(
    objectResult.value,
    memberNameResult.memberName
  );

  return memberValue.kind === "resolved"
    ? memberValue
    : {
        kind: "error",
        diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          createImportedLiteralDiagnosticContext(options.context),
          options.expression.type
        )
      };
}

export function evaluateStaticCssObjectExpression(
  options: ImportedStaticCssEvalLiteralEvaluationOptions & {
    readonly expression: t.ObjectExpression;
  }
): ImportedStaticCssEvalLiteralResult {
  const value: Record<string, StaticCssLiteral> = Object.create(null);

  for (const property of options.expression.properties) {
    if (t.isSpreadElement(property)) {
      const spreadResult = evaluateStaticCssLiteralExpression({
        ...options,
        expression: property.argument,
        depth: options.depth + 1
      });

      if (spreadResult.kind === "error") {
        return spreadResult;
      }

      if (!isStaticCssLiteralObject(spreadResult.value)) {
        return createImportedObjectSpreadError(options.context, "object");
      }

      Object.assign(value, spreadResult.value);
      continue;
    }

    if (!t.isObjectProperty(property)) {
      return createStaticCssLiteralError(
        options.context,
        "function-or-call",
        `imported export "${formatExportName(
          options.context.exportName
        )}" contains an object method`
      );
    }

    if (!t.isExpression(property.value)) {
      return createStaticCssLiteralError(
        options.context,
        "unsupported-literal",
        `imported export "${formatExportName(
          options.context.exportName
        )}" contains a non-expression object value`
      );
    }

    const keyResult = resolveImportedStaticObjectPropertyKey({
      ...options,
      property,
      depth: options.depth + 1
    });

    if (keyResult.kind === "error") {
      return keyResult;
    }

    const propertyResult = evaluateStaticCssLiteralExpression({
      ...options,
      expression: property.value,
      depth: options.depth + 1
    });

    if (propertyResult.kind === "error") {
      return propertyResult;
    }

    value[keyResult.propertyName] = propertyResult.value;
  }

  return { kind: "resolved", value };
}

export function resolveImportedStaticObjectPropertyKey(
  options: ImportedStaticCssEvalLiteralEvaluationOptions & {
    readonly property: t.ObjectProperty;
  }
):
  | { kind: "resolved"; propertyName: string }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  const staticName = getStaticObjectPropertyName(options.property.key);

  if (!options.property.computed) {
    return staticName
      ? { kind: "resolved", propertyName: staticName }
      : createStaticCssLiteralError(
          options.context,
          "unsupported-literal",
          `imported export "${formatExportName(
            options.context.exportName
          )}" contains an unsupported object key`
        );
  }

  if (!t.isExpression(options.property.key)) {
    return {
      kind: "error",
      diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
        createImportedLiteralDiagnosticContext(options.context)
      )
    };
  }

  const keyResult = evaluateStaticCssLiteralExpression({
    ...options,
    expression: options.property.key
  });

  if (keyResult.kind === "error") {
    return keyResult.diagnostic.id
      ? keyResult
      : {
          kind: "error",
          diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
            createImportedLiteralDiagnosticContext(options.context),
            options.property.key.type
          )
        };
  }

  const propertyName = getStaticStringOrNumberLiteralValue(keyResult.value);

  return propertyName === null
    ? {
        kind: "error",
        diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
          createImportedLiteralDiagnosticContext(options.context)
        )
      }
    : { kind: "resolved", propertyName: String(propertyName) };
}

export function resolveImportedStaticMemberName(
  options: ImportedStaticCssEvalLiteralEvaluationOptions & {
    readonly expression: t.MemberExpression | t.OptionalMemberExpression;
  }
):
  | { kind: "resolved"; memberName: string }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  if (
    !options.expression.computed &&
    t.isIdentifier(options.expression.property)
  ) {
    return { kind: "resolved", memberName: options.expression.property.name };
  }

  if (!t.isExpression(options.expression.property)) {
    return {
      kind: "error",
      diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
        createImportedLiteralDiagnosticContext(options.context)
      )
    };
  }

  const keyResult = evaluateStaticCssLiteralExpression({
    ...options,
    expression: options.expression.property
  });

  if (keyResult.kind === "error") {
    return keyResult.diagnostic.id
      ? keyResult
      : {
          kind: "error",
          diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
            createImportedLiteralDiagnosticContext(options.context),
            options.expression.property.type
          )
        };
  }

  const memberName = getStaticStringOrNumberLiteralValue(keyResult.value);

  return memberName === null
    ? {
        kind: "error",
        diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
          createImportedLiteralDiagnosticContext(options.context)
        )
      }
    : { kind: "resolved", memberName: String(memberName) };
}

export function evaluateStaticCssArrayExpression(
  options: ImportedStaticCssEvalLiteralEvaluationOptions & {
    readonly expression: t.ArrayExpression;
  }
): ImportedStaticCssEvalLiteralResult {
  const value: StaticCssLiteral[] = [];

  for (const element of options.expression.elements) {
    if (!element) {
      return createStaticCssLiteralError(
        options.context,
        "unsupported-literal",
        `imported export "${formatExportName(
          options.context.exportName
        )}" contains an array hole`
      );
    }

    if (t.isSpreadElement(element)) {
      const spreadResult = evaluateStaticCssLiteralExpression({
        ...options,
        expression: element.argument,
        depth: options.depth + 1
      });

      if (spreadResult.kind === "error") {
        return spreadResult;
      }

      if (!Array.isArray(spreadResult.value)) {
        return createImportedObjectSpreadError(options.context, "array");
      }

      value.push(...spreadResult.value);
      continue;
    }

    const elementResult = evaluateStaticCssLiteralExpression({
      ...options,
      expression: element,
      depth: options.depth + 1
    });

    if (elementResult.kind === "error") {
      return elementResult;
    }

    value.push(elementResult.value);
  }

  return { kind: "resolved", value };
}

export function selectStaticCssLiteralMemberValue(
  value: StaticCssLiteral,
  memberName: string
): { kind: "resolved"; value: StaticCssLiteral } | { kind: "not-candidate" } {
  if (isStaticCssLiteralObject(value)) {
    if (!Object.prototype.hasOwnProperty.call(value, memberName)) {
      return { kind: "not-candidate" };
    }

    const memberValue = value[memberName];

    return memberValue === undefined
      ? { kind: "not-candidate" }
      : { kind: "resolved", value: memberValue };
  }

  if (
    Array.isArray(value) &&
    /^\d+$/.test(memberName) &&
    String(Number(memberName)) === memberName
  ) {
    const memberValue = value[Number(memberName)];

    return memberValue === undefined
      ? { kind: "not-candidate" }
      : { kind: "resolved", value: memberValue };
  }

  return { kind: "not-candidate" };
}

export function findUnsupportedImportedObjectReferenceDiagnostic(
  expression: t.ObjectExpression,
  options: {
    ownerFile: string;
    provider: StaticCssEvalProvider;
    includeSupportedReferenceErrors?: boolean;
  }
): StaticCssEvalDiagnostic | null {
  for (const property of expression.properties) {
    const valueExpression = t.isSpreadElement(property)
      ? property.argument
      : t.isObjectProperty(property) && t.isExpression(property.value)
        ? property.value
        : null;

    if (!valueExpression) {
      continue;
    }

    const diagnostic = findUnsupportedImportedExpressionReferenceDiagnostic(
      valueExpression,
      options
    );

    if (diagnostic) {
      return diagnostic;
    }
  }

  return null;
}

export function findUnsupportedImportedArrayReferenceDiagnostic(
  expression: t.ArrayExpression,
  options: {
    ownerFile: string;
    provider: StaticCssEvalProvider;
    includeSupportedReferenceErrors?: boolean;
  }
): StaticCssEvalDiagnostic | null {
  for (const element of expression.elements) {
    if (!element) {
      continue;
    }

    const valueExpression = t.isSpreadElement(element)
      ? element.argument
      : element;

    const diagnostic = findUnsupportedImportedExpressionReferenceDiagnostic(
      valueExpression,
      options
    );

    if (diagnostic) {
      return diagnostic;
    }
  }

  return null;
}

export function findUnsupportedImportedExpressionReferenceDiagnostic(
  expression: t.Expression,
  options: {
    ownerFile: string;
    provider: StaticCssEvalProvider;
    includeSupportedReferenceErrors?: boolean;
  }
): StaticCssEvalDiagnostic | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);
  const reference = getStaticCssEvalMemberReference(unwrappedExpression);

  if (reference?.kind === "unsupported") {
    const result = options.provider.getResolvedCssValue({
      importerId: options.ownerFile,
      expressionStart: unwrappedExpression.start ?? 0,
      expressionEnd: unwrappedExpression.end ?? 0,
      bindingName: reference.bindingName,
      ...(reference.memberPath.length > 0
        ? { memberPath: reference.memberPath }
        : {})
    });

    if (result.kind === "not-candidate") {
      return null;
    }

    if (reference.reason === "dynamic-member-path") {
      return createStaticCssEvalComputedMemberUnsupportedDiagnostic({
        owner: createExpressionOwnerLocation(
          unwrappedExpression,
          options.ownerFile
        ),
        memberPath: reference.memberPath
      });
    }

    return result.kind === "error"
      ? result.diagnostic
      : createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          {
            owner: createExpressionOwnerLocation(
              unwrappedExpression,
              options.ownerFile
            )
          },
          unwrappedExpression.type,
          reference.detail
        );
  }

  const candidate = createStaticCssEvalCandidate(
    unwrappedExpression,
    options.ownerFile
  );

  if (
    !candidate &&
    t.isMemberExpression(unwrappedExpression) &&
    unwrappedExpression.computed &&
    t.isIdentifier(unwrappedExpression.property)
  ) {
    return createStaticCssEvalComputedMemberUnsupportedDiagnostic({
      owner: createExpressionOwnerLocation(
        unwrappedExpression,
        options.ownerFile
      )
    });
  }

  if (
    options.includeSupportedReferenceErrors !== false &&
    candidate?.bindingName
  ) {
    const result = options.provider.getResolvedCssValue(candidate);

    if (result.kind === "error") {
      return result.diagnostic;
    }
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    return findUnsupportedImportedObjectReferenceDiagnostic(
      unwrappedExpression,
      options
    );
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return findUnsupportedImportedArrayReferenceDiagnostic(
      unwrappedExpression,
      options
    );
  }

  return null;
}

export function getStaticStringOrNumberLiteralValue(
  value: StaticCssLiteral
): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export function getTemplateInterpolationPrimitiveValue(
  value: StaticCssLiteral
): string | number | boolean | null | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  return undefined;
}

export function isStaticCssRuleLiteralValue(
  value: StaticCssLiteral
): value is StaticCssLiteral[] | { [key: string]: StaticCssLiteral } {
  return value !== null && typeof value === "object";
}
