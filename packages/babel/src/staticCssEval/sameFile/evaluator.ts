import { types as t } from "@babel/core";
import {
  getStaticObjectMemberValue,
  getStaticObjectPropertyName,
  preserveDirectBooleanReferenceValue
} from "../ast.js";
import {
  getStaticCssEvalMemberReference,
  unwrapTransparentCssRuleExpression
} from "../candidates.js";
import type { StaticMemberReference } from "../candidates.js";
import {
  createStaticCssEvalComputedMemberUnsupportedDiagnostic,
  createStaticCssEvalDynamicExpressionUnsupportedDiagnostic,
  createStaticCssEvalObjectSpreadUnsupportedDiagnostic
} from "../diagnostics.js";
import {
  enforceStaticCssEvalLiteralNodeCount,
  enforceStaticCssEvalObjectArrayRecursionDepth
} from "../limits.js";
import type { StaticCssEvalDiagnostic } from "../types.js";
import { resolveSameFileBindingExpression } from "./binding.js";
import {
  createSameFileArrayHoleDiagnostic,
  createSameFileStaticCssEvalDiagnostic,
  createUnsupportedLiteralDiagnostic,
  createUnsupportedMemberReferenceDiagnostic
} from "./diagnostics.js";
import {
  createSameFileDiagnosticContext,
  mergeSameFileMetadata
} from "./metadata.js";
import type {
  SameFileStaticCssEvalMetadata,
  SameFileStaticLiteralEvaluationOptions,
  SameFileStaticLiteralEvaluationResult
} from "./types.js";
import {
  createStaticObjectPropertyKey,
  getStaticStringOrNumberLiteralValue,
  getTemplateInterpolationPrimitiveValue,
  isSupportedStaticCssPrimitiveLiteral,
  normalizeSupportedStaticCssPrimitiveLiteral
} from "./primitives.js";
import { getStaticArrayMemberValue } from "./shapes.js";

export function evaluateSameFileStaticLiteralExpression(
  options: SameFileStaticLiteralEvaluationOptions
): SameFileStaticLiteralEvaluationResult {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    options.expression
  );
  options.state.count += 1;

  const countResult = enforceStaticCssEvalLiteralNodeCount({
    owner: options.context.owner,
    memberPath: options.context.memberPath,
    literalNodeCount: options.state.count
  });

  if (!countResult.ok) {
    return {
      kind: "error",
      diagnostic: countResult.diagnostic,
      metadata: options.metadata
    };
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    const depthResult = enforceStaticCssEvalObjectArrayRecursionDepth({
      owner: options.context.owner,
      memberPath: options.context.memberPath,
      recursionDepth: options.depth
    });

    if (!depthResult.ok) {
      return {
        kind: "error",
        diagnostic: depthResult.diagnostic,
        metadata: options.metadata
      };
    }

    return evaluateSameFileStaticObjectExpression({
      ...options,
      expression: unwrappedExpression
    });
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    const depthResult = enforceStaticCssEvalObjectArrayRecursionDepth({
      owner: options.context.owner,
      memberPath: options.context.memberPath,
      recursionDepth: options.depth
    });

    if (!depthResult.ok) {
      return {
        kind: "error",
        diagnostic: depthResult.diagnostic,
        metadata: options.metadata
      };
    }

    return evaluateSameFileStaticArrayExpression({
      ...options,
      expression: unwrappedExpression
    });
  }

  if (isSupportedStaticCssPrimitiveLiteral(unwrappedExpression)) {
    return {
      kind: "resolved",
      expression:
        normalizeSupportedStaticCssPrimitiveLiteral(unwrappedExpression),
      metadata: options.metadata
    };
  }

  if (t.isTemplateLiteral(unwrappedExpression)) {
    return evaluateSameFileStaticTemplateLiteral({
      ...options,
      expression: unwrappedExpression
    });
  }

  if (
    t.isMemberExpression(unwrappedExpression) ||
    t.isOptionalMemberExpression(unwrappedExpression)
  ) {
    return evaluateSameFileStaticMemberExpression({
      ...options,
      expression: unwrappedExpression
    });
  }

  const reference = getStaticCssEvalMemberReference(unwrappedExpression);

  if (reference) {
    return evaluateSameFileStaticLiteralReference(options, reference);
  }

  return {
    kind: "error",
    diagnostic: createUnsupportedLiteralDiagnostic(
      options.context,
      unwrappedExpression
    ),
    metadata: options.metadata
  };
}

function evaluateSameFileStaticObjectExpression(
  options: SameFileStaticLiteralEvaluationOptions & {
    expression: t.ObjectExpression;
  }
): SameFileStaticLiteralEvaluationResult {
  const properties: t.ObjectExpression["properties"] = [];
  let metadata = options.metadata;

  for (const property of options.expression.properties) {
    if (t.isSpreadElement(property)) {
      const spreadResult = evaluateSameFileStaticLiteralExpression({
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
            createSameFileDiagnosticContext(options.context),
            options.context.bindingName,
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
          createSameFileDiagnosticContext(options.context),
          property.type
        ),
        metadata
      };
    }

    if (!t.isExpression(property.value)) {
      return {
        kind: "error",
        diagnostic: createSameFileStaticCssEvalDiagnostic(
          options.context,
          "unsupported-syntax",
          "unsupported-literal",
          `same-file binding "${options.context.bindingName}" contains a non-expression object value`
        ),
        metadata
      };
    }

    const keyResult = resolveSameFileStaticObjectPropertyKey({
      ...options,
      property,
      metadata,
      depth: options.depth + 1
    });

    if (keyResult.kind === "error") {
      return keyResult;
    }

    metadata = keyResult.metadata;

    const valueResult = evaluateSameFileStaticLiteralExpression({
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

  const normalizedProperties: t.ObjectExpression["properties"] = [];
  const propertyIndexes = new Map<string, number>();

  for (const property of properties) {
    if (!t.isObjectProperty(property) || property.computed) {
      normalizedProperties.push(property);
      continue;
    }

    const propertyName = getStaticObjectPropertyName(property.key);
    const existingIndex =
      propertyName === null ? undefined : propertyIndexes.get(propertyName);

    if (existingIndex === undefined) {
      if (propertyName !== null) {
        propertyIndexes.set(propertyName, normalizedProperties.length);
      }

      normalizedProperties.push(property);
      continue;
    }

    normalizedProperties[existingIndex] = property;
  }

  return {
    kind: "resolved",
    expression: t.objectExpression(normalizedProperties),
    metadata
  };
}

function resolveSameFileStaticObjectPropertyKey(
  options: SameFileStaticLiteralEvaluationOptions & {
    property: t.ObjectProperty;
  }
):
  | {
      kind: "resolved";
      propertyName: string;
      metadata: SameFileStaticCssEvalMetadata;
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      metadata?: SameFileStaticCssEvalMetadata;
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
            createSameFileDiagnosticContext(options.context)
          ),
          metadata: options.metadata
        };
  }

  if (!t.isExpression(options.property.key)) {
    return {
      kind: "error",
      diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
        createSameFileDiagnosticContext(options.context)
      ),
      metadata: options.metadata
    };
  }

  const keyResult = evaluateSameFileStaticLiteralExpression({
    ...options,
    expression: options.property.key
  });

  if (keyResult.kind === "error") {
    return keyResult.diagnostic.id
      ? keyResult
      : {
          kind: "error",
          diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
            createSameFileDiagnosticContext(options.context)
          ),
          metadata: keyResult.metadata
        };
  }

  const propertyName = getStaticStringOrNumberLiteralValue(
    keyResult.expression
  );

  return propertyName === null
    ? {
        kind: "error",
        diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
          createSameFileDiagnosticContext(options.context)
        ),
        metadata: keyResult.metadata
      }
    : {
        kind: "resolved",
        propertyName: String(propertyName),
        metadata: keyResult.metadata
      };
}

function evaluateSameFileStaticArrayExpression(
  options: SameFileStaticLiteralEvaluationOptions & {
    expression: t.ArrayExpression;
  }
): SameFileStaticLiteralEvaluationResult {
  const elements: t.ArrayExpression["elements"] = [];
  let metadata = options.metadata;

  for (const element of options.expression.elements) {
    if (!element) {
      return {
        kind: "error",
        diagnostic: createSameFileArrayHoleDiagnostic(options.context),
        metadata
      };
    }

    if (t.isSpreadElement(element)) {
      const spreadResult = evaluateSameFileStaticLiteralExpression({
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
            createSameFileDiagnosticContext(options.context),
            options.context.bindingName,
            "array"
          ),
          metadata
        };
      }

      for (const spreadElement of spreadResult.expression.elements) {
        if (!spreadElement) {
          return {
            kind: "error",
            diagnostic: createSameFileArrayHoleDiagnostic(options.context),
            metadata
          };
        }

        if (t.isSpreadElement(spreadElement)) {
          return {
            kind: "error",
            diagnostic: createStaticCssEvalObjectSpreadUnsupportedDiagnostic(
              createSameFileDiagnosticContext(options.context),
              options.context.bindingName,
              "array"
            ),
            metadata
          };
        }

        elements.push(t.cloneNode(spreadElement));
      }
      continue;
    }

    const elementResult = evaluateSameFileStaticLiteralExpression({
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
    expression: t.arrayExpression(elements),
    metadata
  };
}

function evaluateSameFileStaticLiteralReference(
  options: SameFileStaticLiteralEvaluationOptions,
  reference: StaticMemberReference
): SameFileStaticLiteralEvaluationResult {
  if (reference.kind === "unsupported") {
    return {
      kind: "error",
      diagnostic: createUnsupportedMemberReferenceDiagnostic(
        reference,
        options.context
      ),
      metadata: options.metadata
    };
  }

  const binding = options.scope.getBinding(reference.bindingName);

  if (!binding) {
    return {
      kind: "error",
      diagnostic: createUnsupportedLiteralDiagnostic(
        options.context,
        options.expression
      ),
      metadata: options.metadata
    };
  }

  const bindingResolution = resolveSameFileBindingExpression({
    binding,
    bindingName: reference.bindingName,
    memberPath: reference.memberPath,
    ownerFile: options.ownerFile,
    owner: options.context.owner,
    programPath: options.programPath,
    stack: options.stack
  });

  if (bindingResolution.kind === "error") {
    return {
      kind: "error",
      diagnostic: bindingResolution.diagnostic,
      metadata: bindingResolution.metadata
        ? mergeSameFileMetadata(options.metadata, bindingResolution.metadata)
        : options.metadata
    };
  }

  if (bindingResolution.kind === "not-candidate") {
    return {
      kind: "error",
      diagnostic: createUnsupportedLiteralDiagnostic(
        options.context,
        options.expression
      ),
      metadata: options.metadata
    };
  }

  return evaluateSameFileStaticLiteralExpression({
    ...options,
    expression: bindingResolution.expression,
    scope: bindingResolution.scope,
    stack: [
      ...options.stack,
      {
        binding,
        bindingName: reference.bindingName,
        memberPath: [...reference.memberPath]
      }
    ],
    metadata: mergeSameFileMetadata(
      options.metadata,
      bindingResolution.metadata
    )
  });
}

function evaluateSameFileStaticTemplateLiteral(
  options: SameFileStaticLiteralEvaluationOptions & {
    expression: t.TemplateLiteral;
  }
): SameFileStaticLiteralEvaluationResult {
  let value = "";
  let metadata = options.metadata;

  for (let index = 0; index < options.expression.quasis.length; index += 1) {
    const quasi = options.expression.quasis[index];

    if (!quasi) {
      continue;
    }

    value += quasi.value.cooked ?? quasi.value.raw;

    const interpolation = options.expression.expressions[index];

    if (!interpolation) {
      continue;
    }

    if (!t.isExpression(interpolation)) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          createSameFileDiagnosticContext(options.context),
          interpolation.type
        ),
        metadata
      };
    }

    const interpolationResult = evaluateSameFileStaticLiteralExpression({
      ...options,
      expression: interpolation,
      metadata,
      depth: options.depth + 1
    });

    if (interpolationResult.kind === "error") {
      return interpolationResult;
    }

    metadata = interpolationResult.metadata;
    const primitiveValue = getTemplateInterpolationPrimitiveValue(
      interpolationResult.expression
    );

    if (primitiveValue === undefined) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          createSameFileDiagnosticContext(options.context),
          interpolation.type
        ),
        metadata
      };
    }

    value += String(primitiveValue);
  }

  return {
    kind: "resolved",
    expression: t.stringLiteral(value),
    metadata
  };
}

function evaluateSameFileStaticMemberExpression(
  options: SameFileStaticLiteralEvaluationOptions & {
    expression: t.MemberExpression | t.OptionalMemberExpression;
  }
): SameFileStaticLiteralEvaluationResult {
  if (t.isSuper(options.expression.object)) {
    return {
      kind: "error",
      diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
        createSameFileDiagnosticContext(options.context),
        options.expression.type
      ),
      metadata: options.metadata
    };
  }

  const objectResult = evaluateSameFileStaticLiteralExpression({
    ...options,
    expression: options.expression.object,
    depth: options.depth + 1
  });

  if (objectResult.kind === "error") {
    return objectResult;
  }

  const memberNameResult = resolveSameFileStaticMemberName({
    ...options,
    metadata: objectResult.metadata
  });

  if (memberNameResult.kind === "error") {
    return memberNameResult;
  }

  const target = unwrapTransparentCssRuleExpression(objectResult.expression);
  const memberValue = t.isObjectExpression(target)
    ? getStaticObjectMemberValue(target, memberNameResult.memberName)
    : t.isArrayExpression(target)
      ? getStaticArrayMemberValue(target, memberNameResult.memberName)
      : null;

  if (!memberValue) {
    return {
      kind: "error",
      diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
        createSameFileDiagnosticContext(options.context),
        options.expression.type
      ),
      metadata: memberNameResult.metadata
    };
  }

  return evaluateSameFileStaticLiteralExpression({
    ...options,
    expression: memberValue,
    metadata: memberNameResult.metadata,
    depth: options.depth + 1
  });
}

function resolveSameFileStaticMemberName(
  options: SameFileStaticLiteralEvaluationOptions & {
    expression: t.MemberExpression | t.OptionalMemberExpression;
  }
):
  | {
      kind: "resolved";
      memberName: string;
      metadata: SameFileStaticCssEvalMetadata;
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      metadata?: SameFileStaticCssEvalMetadata;
    } {
  if (
    !options.expression.computed &&
    t.isIdentifier(options.expression.property)
  ) {
    return {
      kind: "resolved",
      memberName: options.expression.property.name,
      metadata: options.metadata
    };
  }

  if (!t.isExpression(options.expression.property)) {
    return {
      kind: "error",
      diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
        createSameFileDiagnosticContext(options.context)
      ),
      metadata: options.metadata
    };
  }

  const keyResult = evaluateSameFileStaticLiteralExpression({
    ...options,
    expression: options.expression.property,
    depth: options.depth + 1
  });

  if (keyResult.kind === "error") {
    return keyResult.diagnostic.id
      ? keyResult
      : {
          kind: "error",
          diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
            createSameFileDiagnosticContext(options.context)
          ),
          metadata: keyResult.metadata
        };
  }

  const memberName = getStaticStringOrNumberLiteralValue(keyResult.expression);

  return memberName === null
    ? {
        kind: "error",
        diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic(
          createSameFileDiagnosticContext(options.context)
        ),
        metadata: keyResult.metadata
      }
    : {
        kind: "resolved",
        memberName: String(memberName),
        metadata: keyResult.metadata
      };
}
