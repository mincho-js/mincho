import { types as t } from "@babel/core";
import {
  getStaticObjectPropertyName,
  preserveDirectBooleanReferenceValue
} from "../staticCssEval/ast.js";
import {
  createStaticCssEvalCandidate,
  getStaticCssEvalMemberReference,
  unwrapTransparentCssRuleExpression
} from "../staticCssEval/candidates.js";
import {
  createStaticCssEvalComputedMemberUnsupportedDiagnostic,
  createStaticCssEvalDynamicExpressionUnsupportedDiagnostic,
  createStaticCssEvalObjectSpreadUnsupportedDiagnostic
} from "../staticCssEval/diagnostics.js";
import { createStaticCssLiteralExpression } from "../staticCssEval/importedModules.js";
import {
  enforceStaticCssEvalLiteralNodeCount,
  enforceStaticCssEvalObjectArrayRecursionDepth
} from "../staticCssEval/limits.js";
import {
  getStaticCssEvalConstBindingInitExpression,
  resolveSameFileStaticCssEvalExpression
} from "../staticCssEval/sameFile.js";
import type { StaticCssEvalDiagnostic } from "../staticCssEval/types.js";
import {
  containsArraySpreadElement,
  containsUnsupportedSequenceCssRuleValue
} from "./classification.js";
import type {
  InlineStaticCssArrayExpressionResult,
  InlineStaticCssEvaluationOptions,
  InlineStaticCssExpressionResult,
  InlineStaticCssLocalStackFrame,
  InlineStaticCssObjectExpressionResult,
  InlineStaticCssRuleLiteralResult,
  StaticCssEvalMetadataSource
} from "./types.js";

export function resolveDirectInlineStaticCssRuleLiteral(
  options: InlineStaticCssEvaluationOptions
): InlineStaticCssRuleLiteralResult {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    options.expression
  );

  if (
    !t.isObjectExpression(unwrappedExpression) &&
    !t.isArrayExpression(unwrappedExpression)
  ) {
    return { kind: "not-candidate" };
  }

  const result = evaluateInlineStaticCssExpression({
    ...options,
    expression: unwrappedExpression
  });

  if (result.kind === "error") {
    return result;
  }

  const { expression } = result;

  return t.isObjectExpression(expression) || t.isArrayExpression(expression)
    ? { ...result, expression }
    : { kind: "not-candidate" };
}

export function evaluateInlineStaticCssExpression(
  options: InlineStaticCssEvaluationOptions
): InlineStaticCssExpressionResult {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    options.expression
  );

  options.state.count += 1;
  const countResult = enforceStaticCssEvalLiteralNodeCount({
    ...createInlineStaticCssDiagnosticContext(options),
    literalNodeCount: options.state.count
  });

  if (!countResult.ok) {
    return {
      kind: "error",
      diagnostic: countResult.diagnostic,
      metadata: options.metadata
    };
  }

  if (
    t.isObjectExpression(unwrappedExpression) ||
    t.isArrayExpression(unwrappedExpression)
  ) {
    const depthResult = enforceStaticCssEvalObjectArrayRecursionDepth({
      ...createInlineStaticCssDiagnosticContext(options),
      recursionDepth: options.depth
    });

    if (!depthResult.ok) {
      return {
        kind: "error",
        diagnostic: depthResult.diagnostic,
        metadata: options.metadata
      };
    }
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    return evaluateInlineStaticCssObjectExpression({
      ...options,
      expression: unwrappedExpression
    });
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return evaluateInlineStaticCssArrayExpression({
      ...options,
      expression: unwrappedExpression
    });
  }

  if (isInlineStaticCssPrimitiveLiteral(unwrappedExpression)) {
    return {
      kind: "resolved",
      expression: normalizeInlineStaticCssPrimitiveLiteral(unwrappedExpression),
      metadata: options.metadata
    };
  }

  const providerReferenceResult = resolveProviderStaticCssExpression(options);

  if (providerReferenceResult.kind !== "not-candidate") {
    return providerReferenceResult;
  }

  const sameFileReferenceResult =
    resolveInlineSameFileStaticCssExpression(options);

  if (sameFileReferenceResult.kind !== "not-candidate") {
    return sameFileReferenceResult;
  }

  return resolveSameFileNestedStaticCssExpression(options);
}

export function evaluateInlineStaticCssObjectExpression(
  options: InlineStaticCssEvaluationOptions & {
    expression: t.ObjectExpression;
  }
): InlineStaticCssObjectExpressionResult {
  const properties: t.ObjectExpression["properties"] = [];
  let metadata = options.metadata;

  for (const property of options.expression.properties) {
    if (t.isSpreadElement(property)) {
      const spreadResult = evaluateInlineStaticCssExpression({
        ...options,
        expression: property.argument,
        metadata,
        depth: options.depth + 1
      });

      if (spreadResult.kind === "error") {
        return spreadResult;
      }

      metadata = spreadResult.metadata;

      if (!t.isObjectExpression(spreadResult.expression)) {
        return {
          kind: "error",
          diagnostic: createStaticCssEvalObjectSpreadUnsupportedDiagnostic(
            createInlineStaticCssDiagnosticContext(options),
            "<inline>",
            "object"
          ),
          metadata
        };
      }

      properties.push(
        ...spreadResult.expression.properties.map((spreadProperty) =>
          t.cloneNode(spreadProperty)
        )
      );
      continue;
    }

    if (!t.isObjectProperty(property)) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          createInlineStaticCssDiagnosticContext(options),
          property.type
        ),
        metadata
      };
    }

    if (!t.isExpression(property.value)) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          createInlineStaticCssDiagnosticContext(options),
          property.value.type
        ),
        metadata
      };
    }

    const keyResult = resolveInlineStaticCssObjectPropertyKey({
      ...options,
      property,
      metadata
    });

    if (keyResult.kind === "error") {
      return keyResult;
    }

    metadata = keyResult.metadata;

    const valueResult = evaluateInlineStaticCssExpression({
      ...options,
      expression: property.value,
      metadata,
      depth: options.depth + 1
    });

    if (valueResult.kind === "error") {
      return valueResult;
    }

    metadata = valueResult.metadata;

    const nextProperty = t.cloneNode(property);
    nextProperty.key = createStaticObjectPropertyKey(keyResult.propertyName);
    nextProperty.computed = false;
    nextProperty.value = preserveDirectBooleanReferenceValue(
      property.value,
      valueResult.expression
    );
    nextProperty.shorthand = false;
    properties.push(nextProperty);
  }

  return {
    kind: "resolved",
    expression: normalizeResolvedObjectExpression(
      t.objectExpression(properties)
    ),
    metadata
  };
}

function resolveInlineStaticCssObjectPropertyKey(
  options: InlineStaticCssEvaluationOptions & {
    property: t.ObjectProperty;
  }
):
  | {
      kind: "resolved";
      propertyName: string;
      metadata: StaticCssEvalMetadataSource[];
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      metadata: StaticCssEvalMetadataSource[];
    } {
  const staticName = getStaticObjectPropertyName(options.property.key);

  if (!options.property.computed) {
    return staticName
      ? {
          kind: "resolved",
          propertyName: staticName,
          metadata: options.metadata
        }
      : {
          kind: "error",
          diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
            createInlineStaticCssDiagnosticContext(options)
          ),
          metadata: options.metadata
        };
  }

  if (!t.isExpression(options.property.key)) {
    return {
      kind: "error",
      diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
        createInlineStaticCssDiagnosticContext(options)
      ),
      metadata: options.metadata
    };
  }

  const keyResult = evaluateInlineStaticCssExpression({
    ...options,
    expression: options.property.key
  });

  if (keyResult.kind === "error") {
    return keyResult.diagnostic.id
      ? keyResult
      : {
          kind: "error",
          diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
            createInlineStaticCssDiagnosticContext(options)
          ),
          metadata: keyResult.metadata
        };
  }

  const propertyName = getInlineStaticStringOrNumberLiteralValue(
    keyResult.expression
  );

  return propertyName === null
    ? {
        kind: "error",
        diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
          createInlineStaticCssDiagnosticContext(options)
        ),
        metadata: keyResult.metadata
      }
    : {
        kind: "resolved",
        propertyName: String(propertyName),
        metadata: keyResult.metadata
      };
}

export function evaluateInlineStaticCssArrayExpression(
  options: InlineStaticCssEvaluationOptions & {
    expression: t.ArrayExpression;
  }
): InlineStaticCssArrayExpressionResult {
  const elements: t.ArrayExpression["elements"] = [];
  let metadata = options.metadata;

  for (const element of options.expression.elements) {
    if (!element) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          createInlineStaticCssDiagnosticContext(options),
          "ArrayHole"
        ),
        metadata
      };
    }

    if (t.isSpreadElement(element)) {
      const spreadResult = evaluateInlineStaticCssExpression({
        ...options,
        expression: element.argument,
        metadata,
        depth: options.depth + 1
      });

      if (spreadResult.kind === "error") {
        return spreadResult;
      }

      metadata = spreadResult.metadata;

      if (!t.isArrayExpression(spreadResult.expression)) {
        return {
          kind: "error",
          diagnostic: createStaticCssEvalObjectSpreadUnsupportedDiagnostic(
            createInlineStaticCssDiagnosticContext(options),
            "<inline>",
            "array"
          ),
          metadata
        };
      }

      for (const spreadElement of spreadResult.expression.elements) {
        if (!spreadElement || t.isSpreadElement(spreadElement)) {
          return {
            kind: "error",
            diagnostic: createStaticCssEvalObjectSpreadUnsupportedDiagnostic(
              createInlineStaticCssDiagnosticContext(options),
              "<inline>",
              "array"
            ),
            metadata
          };
        }

        elements.push(t.cloneNode(spreadElement));
      }
      continue;
    }

    const elementResult = evaluateInlineStaticCssExpression({
      ...options,
      expression: element,
      metadata,
      depth: options.depth + 1
    });

    if (elementResult.kind === "error") {
      return elementResult;
    }

    metadata = elementResult.metadata;
    elements.push(
      preserveDirectBooleanReferenceValue(element, elementResult.expression)
    );
  }

  return {
    kind: "resolved",
    expression: normalizeResolvedArrayExpression(t.arrayExpression(elements)),
    metadata
  };
}

export function resolveProviderStaticCssExpression(
  options: InlineStaticCssEvaluationOptions
): InlineStaticCssExpressionResult | { kind: "not-candidate" } {
  if (!options.provider) {
    return { kind: "not-candidate" };
  }

  const candidate = createStaticCssEvalCandidate(
    options.expression,
    options.ownerFile
  );

  if (!candidate) {
    return { kind: "not-candidate" };
  }

  const result = options.provider.getResolvedCssValue(candidate);

  if (result.kind === "not-candidate") {
    return { kind: "not-candidate" };
  }

  const metadata = [...options.metadata, result];

  if (result.kind === "error") {
    return { kind: "error", diagnostic: result.diagnostic, metadata };
  }

  return {
    kind: "resolved",
    expression: createStaticCssLiteralExpression(result.value),
    metadata
  };
}

export function resolveInlineSameFileStaticCssExpression(
  options: InlineStaticCssEvaluationOptions
): InlineStaticCssExpressionResult | { kind: "not-candidate" } {
  const reference = getStaticCssEvalMemberReference(options.expression);

  if (reference?.kind !== "supported" || reference.memberPath.length > 0) {
    return { kind: "not-candidate" };
  }

  const binding = options.scope.getBinding(reference.bindingName);

  if (!binding) {
    return { kind: "not-candidate" };
  }

  const currentFrame: InlineStaticCssLocalStackFrame = {
    bindingName: reference.bindingName,
    memberPath: []
  };
  const currentKey = createInlineStaticCssLocalStackKey(currentFrame);
  const localStack = options.localStack ?? [];

  if (
    localStack.some(
      (frame) => createInlineStaticCssLocalStackKey(frame) === currentKey
    )
  ) {
    return { kind: "not-candidate" };
  }

  const initExpression = getStaticCssEvalConstBindingInitExpression(binding);

  if (!initExpression) {
    return { kind: "not-candidate" };
  }

  return evaluateInlineStaticCssExpression({
    ...options,
    expression: initExpression,
    scope: binding.scope,
    localStack: [...localStack, currentFrame],
    depth: options.depth
  });
}

function createInlineStaticCssLocalStackKey(
  frame: InlineStaticCssLocalStackFrame
): string {
  return `${frame.bindingName}\0${frame.memberPath.join(".")}`;
}

function resolveSameFileNestedStaticCssExpression(
  options: InlineStaticCssEvaluationOptions
): InlineStaticCssExpressionResult {
  const sameFileResult = resolveSameFileStaticCssEvalExpression({
    expression: createNestedStaticCssEvalWrapper(options.expression),
    ownerFile: options.ownerFile,
    programPath: options.programPath,
    scope: options.scope
  });
  const metadata = [...options.metadata, sameFileResult];

  if (sameFileResult.kind === "error") {
    return {
      kind: "error",
      diagnostic: sameFileResult.diagnostic,
      metadata
    };
  }

  if (sameFileResult.kind === "resolved") {
    const expression = getNestedStaticCssEvalWrapperValue(
      sameFileResult.expression
    );

    if (expression) {
      return {
        kind: "resolved",
        expression: normalizeResolvedCssExpression(expression),
        metadata
      };
    }
  }

  return {
    kind: "error",
    diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
      createInlineStaticCssDiagnosticContext(options),
      unwrapTransparentCssRuleExpression(options.expression).type
    ),
    metadata
  };
}

function createNestedStaticCssEvalWrapper(
  expression: t.Expression
): t.ObjectExpression {
  const wrapper = t.objectExpression([
    t.objectProperty(t.identifier("value"), t.cloneNode(expression))
  ]);
  wrapper.start = expression.start;
  wrapper.end = expression.end;
  wrapper.loc = expression.loc;
  return wrapper;
}

function getNestedStaticCssEvalWrapperValue(
  expression: t.ObjectExpression | t.ArrayExpression
): t.Expression | null {
  if (!t.isObjectExpression(expression)) {
    return null;
  }

  const [property] = expression.properties;

  if (!t.isObjectProperty(property) || !t.isExpression(property.value)) {
    return null;
  }

  return property.value;
}

function createInlineStaticCssDiagnosticContext(options: {
  expression: t.Expression;
  ownerFile: string;
}): {
  owner: { file: string; start?: number; end?: number };
} {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    options.expression
  );

  return {
    owner: {
      file: options.ownerFile,
      ...(typeof unwrappedExpression.start === "number"
        ? { start: unwrappedExpression.start }
        : {}),
      ...(typeof unwrappedExpression.end === "number"
        ? { end: unwrappedExpression.end }
        : {})
    }
  };
}

export function shouldPreserveUnsupportedArraySpreadClassification(
  expression: t.Expression
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  return (
    t.isArrayExpression(unwrappedExpression) &&
    containsArraySpreadElement(unwrappedExpression)
  );
}

export function shouldPreserveUnsupportedDynamicCssRuleClassification(
  expression: t.Expression
): boolean {
  return containsUnsupportedSequenceCssRuleValue(expression);
}

export function preserveDirectBooleanReferenceValues(
  originalExpression: t.Expression,
  resolvedExpression: t.ObjectExpression | t.ArrayExpression
): t.ObjectExpression | t.ArrayExpression {
  const unwrappedOriginal =
    unwrapTransparentCssRuleExpression(originalExpression);

  if (
    t.isObjectExpression(unwrappedOriginal) &&
    t.isObjectExpression(resolvedExpression)
  ) {
    if (
      unwrappedOriginal.properties.some((property) =>
        t.isSpreadElement(property)
      )
    ) {
      return resolvedExpression;
    }

    return preserveObjectBooleanReferenceValues(
      unwrappedOriginal,
      resolvedExpression
    );
  }

  if (
    t.isArrayExpression(unwrappedOriginal) &&
    t.isArrayExpression(resolvedExpression)
  ) {
    if (
      unwrappedOriginal.elements.some((element) => t.isSpreadElement(element))
    ) {
      return resolvedExpression;
    }

    return preserveArrayBooleanReferenceValues(
      unwrappedOriginal,
      resolvedExpression
    );
  }

  return resolvedExpression;
}

function preserveObjectBooleanReferenceValues(
  originalExpression: t.ObjectExpression,
  resolvedExpression: t.ObjectExpression
): t.ObjectExpression {
  const originalProperties = getDirectObjectPropertiesByKey(originalExpression);
  const properties = resolvedExpression.properties.map((property) => {
    if (!t.isObjectProperty(property) || property.computed) {
      return t.cloneNode(property);
    }

    const propertyName = getStaticObjectPropertyName(property.key);
    const originalProperty = propertyName
      ? originalProperties.get(propertyName)
      : undefined;
    const nextProperty = t.cloneNode(property);

    if (
      originalProperty &&
      t.isExpression(originalProperty.value) &&
      t.isExpression(property.value)
    ) {
      nextProperty.value = preserveBooleanReferenceValue(
        originalProperty.value,
        property.value
      );
    }

    return nextProperty;
  });

  return t.objectExpression(properties);
}

function getDirectObjectPropertiesByKey(
  expression: t.ObjectExpression
): Map<string, t.ObjectProperty> {
  const properties = new Map<string, t.ObjectProperty>();

  for (const property of expression.properties) {
    if (!t.isObjectProperty(property) || property.computed) {
      continue;
    }

    const propertyName = getStaticObjectPropertyName(property.key);

    if (propertyName) {
      properties.set(propertyName, property);
    }
  }

  return properties;
}

function preserveArrayBooleanReferenceValues(
  originalExpression: t.ArrayExpression,
  resolvedExpression: t.ArrayExpression
): t.ArrayExpression {
  const elements = resolvedExpression.elements.map((element, index) => {
    const originalElement = originalExpression.elements[index];

    if (!element || t.isSpreadElement(element)) {
      return element ? t.cloneNode(element) : null;
    }

    if (!originalElement || t.isSpreadElement(originalElement)) {
      return t.cloneNode(element);
    }

    return preserveBooleanReferenceValue(originalElement, element);
  });

  return t.arrayExpression(elements);
}

function preserveBooleanReferenceValue(
  originalExpression: t.Expression,
  resolvedExpression: t.Expression
): t.Expression {
  const unwrappedOriginal =
    unwrapTransparentCssRuleExpression(originalExpression);

  if (t.isBooleanLiteral(resolvedExpression)) {
    return preserveDirectBooleanReferenceValue(
      unwrappedOriginal,
      resolvedExpression
    );
  }

  if (
    t.isObjectExpression(unwrappedOriginal) &&
    t.isObjectExpression(resolvedExpression)
  ) {
    return preserveDirectBooleanReferenceValues(
      unwrappedOriginal,
      resolvedExpression
    );
  }

  if (
    t.isArrayExpression(unwrappedOriginal) &&
    t.isArrayExpression(resolvedExpression)
  ) {
    return preserveDirectBooleanReferenceValues(
      unwrappedOriginal,
      resolvedExpression
    );
  }

  return t.cloneNode(resolvedExpression);
}

export function normalizeResolvedCssRuleExpression(
  expression: t.ObjectExpression | t.ArrayExpression
): t.ObjectExpression | t.ArrayExpression {
  return t.isObjectExpression(expression)
    ? normalizeResolvedObjectExpression(expression)
    : normalizeResolvedArrayExpression(expression);
}

function normalizeResolvedCssExpression(
  expression: t.Expression
): t.Expression {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isObjectExpression(unwrappedExpression)) {
    return normalizeResolvedObjectExpression(unwrappedExpression);
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return normalizeResolvedArrayExpression(unwrappedExpression);
  }

  return normalizeInlineStaticCssPrimitiveLiteral(unwrappedExpression);
}

function normalizeResolvedObjectExpression(
  expression: t.ObjectExpression
): t.ObjectExpression {
  const properties: t.ObjectExpression["properties"] = [];
  const propertyIndexes = new Map<string, number>();

  for (const property of expression.properties) {
    if (!t.isObjectProperty(property) || property.computed) {
      properties.push(t.cloneNode(property));
      continue;
    }

    const nextProperty = t.cloneNode(property);

    if (t.isExpression(nextProperty.value)) {
      nextProperty.value = normalizeResolvedCssExpression(nextProperty.value);
    }

    const propertyName = getStaticObjectPropertyName(nextProperty.key);

    if (!propertyName) {
      properties.push(nextProperty);
      continue;
    }

    const existingIndex = propertyIndexes.get(propertyName);

    if (existingIndex === undefined) {
      propertyIndexes.set(propertyName, properties.length);
      properties.push(nextProperty);
      continue;
    }

    properties[existingIndex] = nextProperty;
  }

  return t.objectExpression(properties);
}

function normalizeResolvedArrayExpression(
  expression: t.ArrayExpression
): t.ArrayExpression {
  return t.arrayExpression(
    expression.elements.map((element) => {
      if (!element || t.isSpreadElement(element)) {
        return element ? t.cloneNode(element) : null;
      }

      return normalizeResolvedCssExpression(element);
    })
  );
}

function getInlineStaticStringOrNumberLiteralValue(
  expression: t.Expression
): string | number | null {
  if (t.isStringLiteral(expression)) {
    return expression.value;
  }

  if (t.isNumericLiteral(expression)) {
    return expression.value;
  }

  if (isInlineUnaryNumericLiteral(expression)) {
    return expression.operator === "-"
      ? -expression.argument.value
      : expression.argument.value;
  }

  return null;
}

function createStaticObjectPropertyKey(
  propertyName: string
): t.Identifier | t.StringLiteral {
  return t.isValidIdentifier(propertyName)
    ? t.identifier(propertyName)
    : t.stringLiteral(propertyName);
}

function isInlineStaticCssPrimitiveLiteral(expression: t.Expression): boolean {
  return (
    t.isStringLiteral(expression) ||
    t.isNumericLiteral(expression) ||
    t.isBooleanLiteral(expression) ||
    t.isNullLiteral(expression) ||
    isInlineUnaryNumericLiteral(expression) ||
    isInlineNoExpressionTemplateLiteral(expression)
  );
}

function isInlineUnaryNumericLiteral(
  expression: t.Expression
): expression is t.UnaryExpression & { argument: t.NumericLiteral } {
  return (
    t.isUnaryExpression(expression) &&
    (expression.operator === "+" || expression.operator === "-") &&
    t.isNumericLiteral(expression.argument)
  );
}

function isInlineNoExpressionTemplateLiteral(
  expression: t.Expression
): expression is t.TemplateLiteral {
  return t.isTemplateLiteral(expression) && expression.expressions.length === 0;
}

function normalizeInlineStaticCssPrimitiveLiteral(
  expression: t.Expression
): t.Expression {
  if (isInlineNoExpressionTemplateLiteral(expression)) {
    const [quasi] = expression.quasis;
    return t.stringLiteral(quasi?.value.cooked ?? quasi?.value.raw ?? "");
  }

  return t.cloneNode(expression);
}
