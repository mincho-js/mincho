import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import type { Scope } from "@babel/traverse";
import { unwrapTransparentCssRuleExpression } from "../staticCssEval/candidates.js";
import {
  createPartialEvalContext,
  getPartialEvalResultExpression,
  reducePartialEvalExpression,
  type PartialEvalDiagnostic,
  type PartialEvalDeoptReason,
  type PartialEvalResult
} from "../staticCssEval/partialEvaluator/index.js";
import { createStaticCssEvalPartialEvalDeoptDiagnostic } from "../staticCssEval/diagnostics.js";
import {
  findUnsupportedImportedStaticCssEvalReferenceDiagnostic,
  resolveImportedStaticCssEvalExpression
} from "../staticCssEval/importedModules.js";
import { resolveSameFileStaticCssEvalExpression } from "../staticCssEval/sameFile.js";
import type { PluginState, ProgramScope } from "../types.js";
import {
  getNearestIdentifier,
  invariant,
  registerImportMethod
} from "../utils.js";
import {
  classifyCssPropValue,
  containsArraySpreadElement,
  isArrayClassValueExpression,
  isTopLevelCssRuleCallExpression
} from "./classification.js";
import {
  createClassNameAttributeValue,
  createClassNameExpression,
  getDynamicCssVariableRuntimeLowering,
  getClassNameExpression,
  registerDynamicCssVariableRuntimeLowering
} from "./classNameLowering.js";
import {
  classNameAttributeName,
  cssAttributeName,
  cssExpressionValueErrorMessage,
  cssModuleHelperImportCleanupScopes,
  cssModuleName,
  cssValueErrorMessage,
  duplicateClassNameErrorMessage,
  duplicateCssErrorMessage,
  fragmentTargetErrorMessage,
  keyRefSpreadErrorMessage,
  namespacedTargetErrorMessage,
  styleAttributeName,
  unsupportedArraySpreadCssValueErrorMessage,
  unsupportedDynamicCssRuleValueErrorMessage,
  unsupportedFunctionCssValueErrorMessage,
  unsupportedTargetErrorMessage
} from "./constants.js";
import { getStyleExpression } from "./styleExpression.js";
import {
  registerImportedStaticCssEvalProviderResultMetadata,
  registerStaticCssEvalDiagnosticMetadata,
  registerStaticCssEvalResultMetadata
} from "./metadata.js";
import {
  analyzeCssPropSidecarHoistability,
  getSidecarCssRuleClassification
} from "./modeAnalysis.js";
import { isSidecarSafeCssRuleExpression } from "./sidecarSafety.js";
import {
  normalizeResolvedCssRuleExpression,
  preserveDirectBooleanReferenceValues,
  resolveDirectInlineStaticCssRuleLiteral,
  shouldPreserveUnsupportedArraySpreadClassification,
  shouldPreserveUnsupportedDynamicCssRuleClassification
} from "./staticCssEval.js";
import {
  assertSupportedSpreadAggregationContext,
  transformSpreadAggregatedCssProp
} from "./spreadAggregation.js";
import type {
  DynamicCssVariableBranchRule,
  DynamicCssVariableDirectRule,
  DynamicCssVariableLowering,
  DynamicCssVariableLeaf,
  DynamicCssVariableRule,
  CssPropLoweringMode,
  CssPropSidecarHoistability,
  CssPropValueClassification,
  NormalizedJsxCssPropElement
} from "./types.js";

const duplicateStyleErrorMessage =
  "Mincho JSX css prop cannot merge duplicate style attributes";
type DynamicCssVariableHelperImportBindings = {
  readonly createVarIdentifier: t.Identifier;
  readonly getVarNameIdentifier: t.Identifier;
};
const dynamicCssVariableHelperImportBindings = new WeakMap<
  ProgramScope,
  DynamicCssVariableHelperImportBindings
>();
const dynamicCssVariableCssImportScopes = new WeakSet<ProgramScope>();
type CssPropPartialEvalPolicyResult = {
  readonly rawExpression: t.Expression;
  readonly reducedExpression: t.Expression;
  readonly metadata: PartialEvalResult["metadata"];
  readonly diagnostics: readonly PartialEvalDiagnostic[];
  readonly deoptReasons: readonly PartialEvalDeoptReason[];
};

export function preprocessJsxCssProp(
  path: NodePath<t.Program>,
  state: PluginState
): boolean {
  if (state.opts.jsxCssProp !== true) {
    return false;
  }

  let transformed = false;

  path.traverse({
    JSXOpeningElement(openingElementPath) {
      const normalizedElement = normalizeOpeningElement(
        openingElementPath,
        path,
        state
      );

      if (!normalizedElement) {
        return;
      }

      const { cssAttribute, classNameAttribute, styleAttribute } =
        normalizedElement;
      if (
        normalizedElement.hasSpreadBeforeCss ||
        normalizedElement.hasSpreadAfterCss
      ) {
        transformSpreadAggregatedCssProp(openingElementPath, normalizedElement);
        transformed = true;
        return;
      }

      const dynamicCssVariableLowering =
        normalizedElement.dynamicCssVariableLowering;
      const dynamicCssVariableRuntimeLowering = dynamicCssVariableLowering
        ? getDynamicCssVariableRuntimeLowering(dynamicCssVariableLowering)
        : null;

      if (
        dynamicCssVariableRuntimeLowering &&
        dynamicCssVariableRuntimeLowering.declarations.length > 0
      ) {
        transformSpreadAggregatedCssProp(openingElementPath, normalizedElement);
        transformed = true;
        return;
      }

      const classNameValue = dynamicCssVariableLowering
        ? createDynamicCssVariableClassNameAttributeValue(
            openingElementPath,
            classNameAttribute,
            dynamicCssVariableLowering
          )
        : createClassNameAttributeValue(openingElementPath, normalizedElement);

      const attributes = openingElementPath.node.attributes;

      if (classNameAttribute) {
        classNameAttribute.value = classNameValue;
      } else {
        const cssAttributeIndex = attributes.indexOf(cssAttribute);
        attributes.splice(
          cssAttributeIndex,
          0,
          t.jsxAttribute(
            t.jsxIdentifier(classNameAttributeName),
            classNameValue
          )
        );
      }

      attributes.splice(attributes.indexOf(cssAttribute), 1);

      if (dynamicCssVariableLowering) {
        const runtimeLowering = getDynamicCssVariableRuntimeLowering(
          dynamicCssVariableLowering
        );
        const styleAttributeValue = createDynamicCssVariableStyleAttributeValue(
          openingElementPath,
          styleAttribute,
          runtimeLowering?.styleProperties ??
            dynamicCssVariableLowering.styleProperties
        );

        if (styleAttribute) {
          styleAttribute.value = styleAttributeValue;
        } else {
          attributes.push(
            t.jsxAttribute(
              t.jsxIdentifier(styleAttributeName),
              styleAttributeValue
            )
          );
        }
      }

      transformed = true;
    }
  });

  if (transformed) {
    path.scope.crawl();
  }

  return transformed;
}

export function removeUnusedJsxCssPropCssModuleImports(
  path: NodePath<t.Program>
): void {
  const programScope = path.scope as ProgramScope;

  if (!cssModuleHelperImportCleanupScopes.has(programScope)) {
    return;
  }

  path.scope.crawl();

  for (const statementPath of path.get("body")) {
    if (
      !statementPath.isImportDeclaration() ||
      statementPath.node.source.value !== cssModuleName
    ) {
      continue;
    }

    const retainedSpecifiers = statementPath.node.specifiers.filter(
      (specifier) =>
        !isUnusedCssModuleHelperImportSpecifier(statementPath, specifier)
    );

    if (retainedSpecifiers.length === statementPath.node.specifiers.length) {
      continue;
    }

    if (retainedSpecifiers.length === 0) {
      statementPath.remove();
      continue;
    }

    const nextImportDeclaration = t.cloneNode(statementPath.node);
    nextImportDeclaration.specifiers = retainedSpecifiers.map((specifier) =>
      t.cloneNode(specifier)
    );
    statementPath.replaceWith(nextImportDeclaration);
  }
}

function isUnusedCssModuleHelperImportSpecifier(
  path: NodePath<t.ImportDeclaration>,
  specifier: t.ImportDeclaration["specifiers"][number]
): boolean {
  if (
    !t.isImportSpecifier(specifier) ||
    !t.isIdentifier(specifier.imported) ||
    (specifier.imported.name !== "css" && specifier.imported.name !== "cx")
  ) {
    return false;
  }

  const binding = path.scope.getBinding(specifier.local.name);
  return !binding || binding.referencePaths.length === 0;
}

function normalizeOpeningElement(
  openingElementPath: NodePath<t.JSXOpeningElement>,
  programPath: NodePath<t.Program>,
  state: PluginState
): NormalizedJsxCssPropElement | null {
  const { node: openingElement } = openingElementPath;
  const { attributes } = openingElement;
  const cssAttributes = getJsxAttributes(openingElement, cssAttributeName);

  if (cssAttributes.length === 0) {
    return null;
  }

  assertSupportedCssPropElement(openingElementPath);

  if (cssAttributes.length > 1) {
    throw openingElementPath.buildCodeFrameError(duplicateCssErrorMessage);
  }

  const cssAttribute = cssAttributes[0];
  const cssAttributeIndex = attributes.indexOf(cssAttribute);
  const attributesBeforeCss = attributes.slice(0, cssAttributeIndex);
  const attributesAfterCss = attributes.slice(cssAttributeIndex + 1);
  const hasSpreadBeforeCss = attributesBeforeCss.some((attribute) =>
    t.isJSXSpreadAttribute(attribute)
  );
  const hasSpreadAfterCss = attributesAfterCss.some((attribute) =>
    t.isJSXSpreadAttribute(attribute)
  );

  const requiresSpreadAggregation = hasSpreadBeforeCss || hasSpreadAfterCss;

  if (requiresSpreadAggregation && hasExplicitKeyOrRefAttribute(attributes)) {
    throw openingElementPath.buildCodeFrameError(keyRefSpreadErrorMessage);
  }

  if (requiresSpreadAggregation) {
    assertSupportedSpreadAggregationContext(openingElementPath);
  }

  const classNameAttributes = getJsxAttributes(
    openingElement,
    classNameAttributeName
  );
  const styleAttributes = getJsxAttributes(openingElement, styleAttributeName);

  if (classNameAttributes.length > 1) {
    throw openingElementPath.buildCodeFrameError(
      duplicateClassNameErrorMessage
    );
  }

  const rawCssExpression = getCssExpression(openingElementPath, cssAttribute);
  const partialEvalResult = evaluateCssPropPartialEvalPolicy({
    expression: rawCssExpression,
    ownerFile: getStaticCssEvalOwnerFile(state),
    programPath,
    scope: openingElementPath.scope
  });

  throwHardPartialEvalDeoptIfNeeded(
    openingElementPath,
    state,
    partialEvalResult
  );

  const cssShapeExpression = getCssPropShapeExpression(partialEvalResult);
  const dynamicCssVariableRule = getDynamicCssVariableRule({
    expression: cssShapeExpression,
    scope: openingElementPath.scope
  });
  const sidecarHoistability = dynamicCssVariableRule
    ? ({ kind: "not-candidate" } satisfies CssPropSidecarHoistability)
    : analyzeCssPropSidecarHoistabilityForRouting({
        partialEvalResult,
        scope: openingElementPath.scope
      });

  if (dynamicCssVariableRule && styleAttributes.length > 1) {
    throw openingElementPath.buildCodeFrameError(duplicateStyleErrorMessage);
  }

  if (dynamicCssVariableRule) {
    assertDynamicCssVariableStyleAttributeValue(
      openingElementPath,
      styleAttributes[0] ?? null
    );
  }

  const routedCssExpression = dynamicCssVariableRule
    ? dynamicCssVariableRule.expression
    : sidecarHoistability.kind === "hoistable" ||
        sidecarHoistability.kind === "unsafe"
      ? getCssPropSidecarExpression(partialEvalResult)
      : getResolvedCssExpression(
          openingElementPath,
          programPath,
          state,
          partialEvalResult
        );
  const cssValueClassification = getCssValueClassification({
    expression: routedCssExpression,
    sidecarHoistability,
    scope: openingElementPath.scope
  });
  const cssExpression = getCssPropLoweringExpression({
    classification: cssValueClassification,
    partialEvalResult,
    routedExpression: routedCssExpression
  });
  const cssLoweringMode = getCssPropLoweringMode({
    cssValueClassification,
    dynamicCssVariableRule,
    sidecarHoistability
  });

  assertSupportedCssPropLoweringMode(
    openingElementPath,
    state,
    cssLoweringMode,
    partialEvalResult
  );

  const dynamicCssVariableLowering = dynamicCssVariableRule
    ? createDynamicCssVariableLowering({
        path: openingElementPath,
        rule: dynamicCssVariableRule,
        needsClassNameMerge:
          classNameAttributes.length > 0 ||
          requiresSpreadAggregation ||
          (dynamicCssVariableRule.kind === "branch" &&
            (attributesBeforeCss.length > 0 || attributesAfterCss.length > 0))
      })
    : null;

  return {
    cssAttribute,
    cssExpression,
    cssValueClassification,
    cssLoweringMode,
    dynamicCssVariableRule,
    dynamicCssVariableLowering,
    classNameAttribute: classNameAttributes[0] ?? null,
    styleAttribute: styleAttributes[0] ?? null,
    attributesBeforeCss,
    attributesAfterCss,
    hasSpreadBeforeCss,
    hasSpreadAfterCss
  };
}

function evaluateCssPropPartialEvalPolicy(options: {
  readonly expression: t.Expression;
  readonly ownerFile: string;
  readonly programPath: NodePath<t.Program>;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): CssPropPartialEvalPolicyResult {
  const result = reducePartialEvalExpression({
    expression: options.expression,
    context: createPartialEvalContext({
      owner: createCssPropPartialEvalOwner({
        expression: options.expression,
        ownerFile: options.ownerFile
      })
    }),
    programPath: options.programPath,
    scope: options.scope
  });

  return {
    rawExpression: options.expression,
    reducedExpression: getPartialEvalResultExpression(result),
    metadata: result.metadata,
    diagnostics: result.diagnostics,
    deoptReasons: result.diagnostics.map(({ reason }) => reason)
  };
}

function createCssPropPartialEvalOwner(options: {
  readonly expression: t.Expression;
  readonly ownerFile: string;
}) {
  return {
    file: options.ownerFile,
    ...(typeof options.expression.start === "number"
      ? { start: options.expression.start }
      : {}),
    ...(typeof options.expression.end === "number"
      ? { end: options.expression.end }
      : {})
  };
}

function createPreferredStaticCssEvalDeoptDiagnostic(
  result: CssPropPartialEvalPolicyResult
) {
  const diagnostic = result.diagnostics[0];

  if (
    !diagnostic ||
    !shouldPreferPartialEvalDeoptDiagnostic(diagnostic.reason)
  ) {
    return null;
  }

  return createStaticCssEvalPartialEvalDeoptDiagnostic(diagnostic);
}

function throwHardPartialEvalDeoptIfNeeded(
  path: NodePath<t.JSXOpeningElement>,
  state: PluginState,
  result: CssPropPartialEvalPolicyResult
): void {
  const diagnostic = result.diagnostics.find(({ reason }) => {
    return isHardPartialEvalDeoptReason(reason);
  });

  if (!diagnostic) {
    return;
  }

  const staticDiagnostic =
    createStaticCssEvalPartialEvalDeoptDiagnostic(diagnostic);
  registerStaticCssEvalDiagnosticMetadata(state, staticDiagnostic);
  throw path.buildCodeFrameError(staticDiagnostic.message);
}

function isHardPartialEvalDeoptReason(reason: PartialEvalDeoptReason): boolean {
  switch (reason) {
    case "cycle-detected":
    case "depth-limit":
    case "node-count-limit":
      return true;
    case "mutated-binding":
    case "unsupported-import":
    case "unsupported-call-expression":
    case "non-static-object-key":
    case "unsupported-spread":
    case "unsupported-computed-member":
    case "runtime-css-shape":
    case "unsupported-template-interpolation":
      return false;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function shouldPreferPartialEvalDeoptDiagnostic(
  reason: PartialEvalDeoptReason
): boolean {
  switch (reason) {
    case "mutated-binding":
    case "unsupported-import":
    case "unsupported-call-expression":
    case "non-static-object-key":
    case "unsupported-spread":
    case "unsupported-computed-member":
    case "unsupported-template-interpolation":
    case "runtime-css-shape":
      return false;
    case "cycle-detected":
    case "depth-limit":
    case "node-count-limit":
      return true;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function getCssPropShapeExpression(
  result: CssPropPartialEvalPolicyResult
): t.Expression {
  return result.deoptReasons.some(isFailClosedShapeDeoptReason)
    ? result.rawExpression
    : preserveDynamicLeafValues(result.rawExpression, result.reducedExpression);
}

function getCssPropStaticEvalExpression(
  result: CssPropPartialEvalPolicyResult
): t.Expression {
  if (result.deoptReasons.length > 0) {
    return result.rawExpression;
  }

  if (isRawArrayClassValueExpression(result.rawExpression)) {
    return result.rawExpression;
  }

  const rawExpression = unwrapTransparentCssRuleExpression(
    result.rawExpression
  );
  const reducedExpression = unwrapTransparentCssRuleExpression(
    result.reducedExpression
  );

  if (
    (t.isObjectExpression(rawExpression) &&
      t.isObjectExpression(reducedExpression)) ||
    (t.isArrayExpression(rawExpression) &&
      t.isArrayExpression(reducedExpression))
  ) {
    return preserveDirectBooleanReferenceValues(
      rawExpression,
      reducedExpression
    );
  }

  return result.reducedExpression;
}

function getBooleanPreservationExpression(
  result: CssPropPartialEvalPolicyResult,
  cssExpression: t.Expression
): t.Expression {
  return t.isObjectExpression(
    unwrapTransparentCssRuleExpression(result.rawExpression)
  )
    ? result.rawExpression
    : cssExpression;
}

function isRawArrayClassValueExpression(expression: t.Expression): boolean {
  return isArrayClassValueExpression(
    unwrapTransparentCssRuleExpression(expression)
  );
}

function isFailClosedShapeDeoptReason(reason: PartialEvalDeoptReason): boolean {
  return reason === "non-static-object-key" || reason === "unsupported-spread";
}

function preserveDynamicLeafValues(
  rawExpression: t.Expression,
  reducedExpression: t.Expression
): t.Expression {
  const raw = unwrapTransparentCssRuleExpression(rawExpression);
  const reduced = unwrapTransparentCssRuleExpression(reducedExpression);

  if (t.isObjectExpression(raw) && t.isObjectExpression(reduced)) {
    return preserveObjectDynamicLeafValues(raw, reduced);
  }

  if (t.isArrayExpression(raw) && t.isArrayExpression(reduced)) {
    return preserveArrayDynamicLeafValues(raw, reduced);
  }

  if (t.isConditionalExpression(raw) && t.isConditionalExpression(reduced)) {
    return t.conditionalExpression(
      t.cloneNode(raw.test),
      preserveDynamicLeafValues(raw.consequent, reduced.consequent),
      preserveDynamicLeafValues(raw.alternate, reduced.alternate)
    );
  }

  if (t.isLogicalExpression(raw) && t.isLogicalExpression(reduced)) {
    return t.logicalExpression(
      raw.operator,
      preserveDynamicLeafValues(raw.left, reduced.left),
      preserveDynamicLeafValues(raw.right, reduced.right)
    );
  }

  return t.cloneNode(rawExpression);
}

function preserveObjectDynamicLeafValues(
  rawExpression: t.ObjectExpression,
  reducedExpression: t.ObjectExpression
): t.ObjectExpression {
  const properties: t.ObjectExpression["properties"] = [];
  let reducedIndex = 0;

  for (
    let rawIndex = 0;
    rawIndex < rawExpression.properties.length;
    rawIndex += 1
  ) {
    const rawProperty = rawExpression.properties[rawIndex];

    if (!rawProperty) {
      continue;
    }

    if (t.isSpreadElement(rawProperty)) {
      const nextRawKey = getNextRawObjectPropertyKeyName(
        rawExpression.properties,
        rawIndex + 1
      );

      if (!nextRawKey) {
        const spreadPropertyCount = Math.max(
          0,
          reducedExpression.properties.length -
            reducedIndex -
            countRemainingRawObjectProperties(
              rawExpression.properties,
              rawIndex + 1
            )
        );

        for (let index = 0; index < spreadPropertyCount; index += 1) {
          const reducedProperty = reducedExpression.properties[reducedIndex];

          if (reducedProperty) {
            properties.push(t.cloneNode(reducedProperty));
          }

          reducedIndex += 1;
        }

        continue;
      }

      while (reducedIndex < reducedExpression.properties.length) {
        const reducedProperty = reducedExpression.properties[reducedIndex];

        if (
          reducedProperty &&
          t.isObjectProperty(reducedProperty) &&
          getStaticObjectPropertyKeyName(reducedProperty.key) === nextRawKey
        ) {
          break;
        }

        if (reducedProperty) {
          properties.push(t.cloneNode(reducedProperty));
        }

        reducedIndex += 1;
      }

      continue;
    }

    const reducedProperty = reducedExpression.properties[reducedIndex];

    if (
      !t.isObjectProperty(rawProperty) ||
      !t.isExpression(rawProperty.value) ||
      !reducedProperty ||
      !t.isObjectProperty(reducedProperty) ||
      !t.isExpression(reducedProperty.value)
    ) {
      properties.push(t.cloneNode(rawProperty));
      reducedIndex += 1;
      continue;
    }

    const nextProperty = t.cloneNode(reducedProperty);
    nextProperty.value = preserveDynamicLeafValues(
      rawProperty.value,
      reducedProperty.value
    );
    properties.push(nextProperty);
    reducedIndex += 1;
  }

  for (
    ;
    reducedIndex < reducedExpression.properties.length;
    reducedIndex += 1
  ) {
    const reducedProperty = reducedExpression.properties[reducedIndex];

    if (reducedProperty) {
      properties.push(t.cloneNode(reducedProperty));
    }
  }

  return t.objectExpression(properties);
}

function preserveArrayDynamicLeafValues(
  rawExpression: t.ArrayExpression,
  reducedExpression: t.ArrayExpression
): t.ArrayExpression {
  const elements: t.ArrayExpression["elements"] = [];
  let reducedIndex = 0;

  for (
    let rawIndex = 0;
    rawIndex < rawExpression.elements.length;
    rawIndex += 1
  ) {
    const rawElement = rawExpression.elements[rawIndex];

    if (!rawElement) {
      elements.push(null);
      continue;
    }

    if (t.isSpreadElement(rawElement)) {
      const remainingRawElements = countRemainingRawArrayElements(
        rawExpression.elements,
        rawIndex + 1
      );
      const spreadElementCount = Math.max(
        0,
        reducedExpression.elements.length - reducedIndex - remainingRawElements
      );

      for (let index = 0; index < spreadElementCount; index += 1) {
        const reducedElement = reducedExpression.elements[reducedIndex];

        if (reducedElement) {
          elements.push(t.cloneNode(reducedElement));
        } else {
          elements.push(null);
        }

        reducedIndex += 1;
      }

      continue;
    }

    const reducedElement = reducedExpression.elements[reducedIndex];

    if (!reducedElement || t.isSpreadElement(reducedElement)) {
      elements.push(t.cloneNode(rawElement));
      reducedIndex += 1;
      continue;
    }

    elements.push(preserveDynamicLeafValues(rawElement, reducedElement));
    reducedIndex += 1;
  }

  for (; reducedIndex < reducedExpression.elements.length; reducedIndex += 1) {
    const reducedElement = reducedExpression.elements[reducedIndex];

    if (reducedElement) {
      elements.push(t.cloneNode(reducedElement));
    } else {
      elements.push(null);
    }
  }

  return t.arrayExpression(elements);
}

function getNextRawObjectPropertyKeyName(
  properties: t.ObjectExpression["properties"],
  startIndex: number
): string | null {
  for (let index = startIndex; index < properties.length; index += 1) {
    const property = properties[index];

    if (property && t.isObjectProperty(property) && !property.computed) {
      return getStaticObjectPropertyKeyName(property.key);
    }
  }

  return null;
}

function countRemainingRawObjectProperties(
  properties: t.ObjectExpression["properties"],
  startIndex: number
): number {
  let count = 0;

  for (let index = startIndex; index < properties.length; index += 1) {
    const property = properties[index];

    if (property && !t.isSpreadElement(property)) {
      count += 1;
    }
  }

  return count;
}

function countRemainingRawArrayElements(
  elements: t.ArrayExpression["elements"],
  startIndex: number
): number {
  let count = 0;

  for (let index = startIndex; index < elements.length; index += 1) {
    const element = elements[index];

    if (element && !t.isSpreadElement(element)) {
      count += 1;
    }
  }

  return count;
}

function analyzeCssPropSidecarHoistabilityForRouting(options: {
  readonly partialEvalResult: CssPropPartialEvalPolicyResult;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): CssPropSidecarHoistability {
  const hoistability = analyzeCssPropSidecarHoistability({
    expression: options.partialEvalResult.rawExpression,
    reducedExpression: options.partialEvalResult.reducedExpression,
    scope: options.scope
  });

  if (
    hoistability.kind === "unsafe" &&
    shouldRouteUnsafeSidecarCallThroughAstStatic(options.partialEvalResult)
  ) {
    return { kind: "not-candidate" };
  }

  return hoistability;
}

function getCssPropSidecarExpression(
  result: CssPropPartialEvalPolicyResult
): t.Expression {
  return getSidecarCssRuleClassification(result.reducedExpression)
    ? result.reducedExpression
    : result.rawExpression;
}

function shouldRouteUnsafeSidecarCallThroughAstStatic(
  result: CssPropPartialEvalPolicyResult
): boolean {
  if (!result.deoptReasons.includes("unsupported-call-expression")) {
    return false;
  }

  const expression = unwrapTransparentCssRuleExpression(
    getCssPropSidecarExpression(result)
  );

  return (
    t.isCallExpression(expression) &&
    t.isIdentifier(expression.callee) &&
    expression.arguments.length === 0
  );
}

function getCssPropLoweringExpression(options: {
  readonly classification: CssPropValueClassification;
  readonly partialEvalResult: CssPropPartialEvalPolicyResult;
  readonly routedExpression: t.Expression;
}): t.Expression {
  if (
    options.classification === "class-value" &&
    (!containsArraySpreadElement(options.partialEvalResult.rawExpression) ||
      containsArraySpreadElement(options.routedExpression))
  ) {
    return options.partialEvalResult.rawExpression;
  }

  return options.routedExpression;
}

function getCssValueClassification(options: {
  readonly expression: t.Expression;
  readonly sidecarHoistability: CssPropSidecarHoistability;
  readonly scope: Scope;
}): CssPropValueClassification {
  if (options.sidecarHoistability.kind === "hoistable") {
    return options.sidecarHoistability.cssValueClassification;
  }

  if (options.sidecarHoistability.kind === "unsafe") {
    return containsArraySpreadElement(options.expression)
      ? "unsupported-array-spread"
      : "unsupported-dynamic-css-rule";
  }

  return classifyCssPropValue(options.expression, options.scope);
}

function getCssPropLoweringMode(options: {
  readonly cssValueClassification: CssPropValueClassification;
  readonly dynamicCssVariableRule: DynamicCssVariableRule | null;
  readonly sidecarHoistability: CssPropSidecarHoistability;
}): CssPropLoweringMode {
  if (options.dynamicCssVariableRule) {
    return {
      kind: "dynamic-leaf-rule",
      cssValueClassification: "css-rule"
    };
  }

  if (options.sidecarHoistability.kind === "hoistable") {
    return {
      kind: "sidecar-build-time-rule",
      cssValueClassification: options.sidecarHoistability.cssValueClassification
    };
  }

  switch (options.cssValueClassification) {
    case "css-rule":
    case "branch-css-rule":
      return {
        kind: "ast-static-rule",
        cssValueClassification: options.cssValueClassification
      };
    case "class-value":
      return { kind: "class-value", cssValueClassification: "class-value" };
    case "unsupported-array-spread":
    case "unsupported-dynamic-css-rule":
    case "unsupported-function":
      return {
        kind: "unsupported",
        cssValueClassification: options.cssValueClassification
      };
    default: {
      const exhaustive: never = options.cssValueClassification;
      return exhaustive;
    }
  }
}

function assertSupportedCssPropLoweringMode(
  path: NodePath<t.JSXOpeningElement>,
  state: PluginState,
  mode: CssPropLoweringMode,
  partialEvalResult: CssPropPartialEvalPolicyResult
): void {
  switch (mode.kind) {
    case "ast-static-rule":
    case "sidecar-build-time-rule":
    case "dynamic-leaf-rule":
    case "class-value":
      return;
    case "unsupported":
      return throwUnsupportedCssPropLoweringMode(
        path,
        state,
        mode.cssValueClassification,
        partialEvalResult
      );
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

function throwUnsupportedCssPropLoweringMode(
  path: NodePath<t.JSXOpeningElement>,
  state: PluginState,
  classification: Extract<CssPropValueClassification, `unsupported-${string}`>,
  partialEvalResult: CssPropPartialEvalPolicyResult
): never {
  const partialEvalDiagnostic =
    createPreferredStaticCssEvalDeoptDiagnostic(partialEvalResult);

  if (partialEvalDiagnostic) {
    registerStaticCssEvalDiagnosticMetadata(state, partialEvalDiagnostic);
    throw path.buildCodeFrameError(partialEvalDiagnostic.message);
  }

  switch (classification) {
    case "unsupported-function":
      throw path.buildCodeFrameError(unsupportedFunctionCssValueErrorMessage);
    case "unsupported-dynamic-css-rule":
      throw path.buildCodeFrameError(
        unsupportedDynamicCssRuleValueErrorMessage
      );
    case "unsupported-array-spread":
      throw path.buildCodeFrameError(
        unsupportedArraySpreadCssValueErrorMessage
      );
    default: {
      const exhaustive: never = classification;
      return exhaustive;
    }
  }
}

function createDynamicCssVariableLowering(options: {
  readonly path: NodePath<t.JSXOpeningElement>;
  readonly rule: DynamicCssVariableRule;
  readonly needsClassNameMerge: boolean;
}): DynamicCssVariableLowering {
  const programParent = options.path.scope.getProgramParent() as ProgramScope;
  const nearestIdentifier = getNearestIdentifier(options.path);
  const identifierBase = nearestIdentifier
    ? `$mincho$$${nearestIdentifier.node.name}`
    : "$mincho$$unknown";
  const classNameIdentifier =
    programParent.generateUidIdentifier(identifierBase);
  const cxIdentifier = options.needsClassNameMerge
    ? programParent.generateUidIdentifier(`${identifierBase}Cx`)
    : null;
  const preparedLeaves = options.rule.leaves.map((leaf) => {
    const propertyFragment = createIdentifierNameFragment(leaf.propertyName);
    const variableIdentifier = programParent.generateUidIdentifier(
      `${identifierBase}${propertyFragment}Var`
    );
    const variableKeyIdentifier = programParent.generateUidIdentifier(
      `${identifierBase}${propertyFragment}VarKey`
    );

    leaf.variableIdentifier.name = variableIdentifier.name;

    return {
      leaf,
      variableKeyIdentifier,
      importedVariableKeyIdentifier: registerImportMethod(
        options.path,
        variableKeyIdentifier.name,
        programParent.minchoData.cssFile
      )
    };
  });
  const importedCxIdentifier = cxIdentifier
    ? registerImportMethod(
        options.path,
        cxIdentifier.name,
        programParent.minchoData.cssFile
      )
    : null;
  const generatedNodes: t.Statement[] = [];
  let helperImportBindings =
    dynamicCssVariableHelperImportBindings.get(programParent);

  if (!helperImportBindings) {
    helperImportBindings = {
      createVarIdentifier:
        programParent.generateUidIdentifier("minchoCreateVar"),
      getVarNameIdentifier:
        programParent.generateUidIdentifier("minchoGetVarName")
    };
    dynamicCssVariableHelperImportBindings.set(
      programParent,
      helperImportBindings
    );
    cssModuleHelperImportCleanupScopes.add(programParent);

    generatedNodes.push(
      createDynamicCssVariableHelperImportDeclaration(helperImportBindings)
    );
  }

  invariant(
    helperImportBindings !== undefined,
    "Dynamic CSS variable lowering requires helper import bindings"
  );

  const stylePropertyByLeaf = new Map<DynamicCssVariableLeaf, t.ObjectProperty>(
    preparedLeaves.map(({ leaf, importedVariableKeyIdentifier }) => [
      leaf,
      t.objectProperty(
        t.cloneNode(importedVariableKeyIdentifier),
        t.cloneNode(leaf.value),
        true
      )
    ])
  );
  const branchLowering =
    options.rule.kind === "branch"
      ? createDynamicCssVariableBranchLowering({
          path: options.path,
          rule: options.rule,
          stylePropertyByLeaf
        })
      : null;

  generatedNodes.push(
    ...(cxIdentifier
      ? [createDynamicCssVariableCxExportDeclaration(cxIdentifier)]
      : []),
    ...preparedLeaves.map(({ leaf }) =>
      t.exportNamedDeclaration(
        t.variableDeclaration("var", [
          t.variableDeclarator(
            t.cloneNode(leaf.variableIdentifier),
            t.callExpression(
              t.cloneNode(helperImportBindings.createVarIdentifier),
              [t.stringLiteral(leaf.propertyName)]
            )
          )
        ])
      )
    ),
    ...preparedLeaves.map(({ leaf, variableKeyIdentifier }) =>
      t.exportNamedDeclaration(
        t.variableDeclaration("var", [
          t.variableDeclarator(
            variableKeyIdentifier,
            t.callExpression(
              t.cloneNode(helperImportBindings.getVarNameIdentifier),
              [t.cloneNode(leaf.variableIdentifier)]
            )
          )
        ])
      )
    )
  );

  if (options.rule.kind === "direct") {
    const cssIdentifier = registerImportMethod(
      options.path,
      "css",
      cssModuleName
    );

    if (!dynamicCssVariableCssImportScopes.has(programParent)) {
      generatedNodes.unshift(
        createDynamicCssVariableCssImportDeclaration(
          options.path,
          cssIdentifier
        )
      );
      dynamicCssVariableCssImportScopes.add(programParent);
    }

    generatedNodes.push(
      t.exportNamedDeclaration(
        t.variableDeclaration("var", [
          t.variableDeclarator(
            classNameIdentifier,
            t.callExpression(t.cloneNode(cssIdentifier), [
              t.cloneNode(options.rule.expression)
            ])
          )
        ])
      )
    );
  }

  programParent.minchoData.nodes.push(...generatedNodes);

  if (branchLowering) {
    return registerDynamicCssVariableRuntimeLowering(
      {
        classNameExpression: branchLowering.classNameExpression,
        cxExpression: importedCxIdentifier,
        styleProperties: []
      },
      {
        declarations: branchLowering.declarations,
        styleProperties: branchLowering.styleProperties
      }
    );
  }

  const importedClassNameIdentifier = registerImportMethod(
    options.path,
    classNameIdentifier.name,
    programParent.minchoData.cssFile
  );

  return {
    classNameExpression: importedClassNameIdentifier,
    cxExpression: importedCxIdentifier,
    styleProperties: options.rule.leaves.map((leaf) =>
      cloneDynamicCssVariableStyleProperty(stylePropertyByLeaf, leaf)
    )
  };
}

function createDynamicCssVariableCssImportDeclaration(
  path: NodePath<t.JSXOpeningElement>,
  cssIdentifier: t.Identifier
): t.ImportDeclaration {
  const programParent = path.scope.getProgramParent() as ProgramScope;
  let cssBinding = programParent.getBinding(cssIdentifier.name);

  if (!cssBinding) {
    programParent.crawl();
    cssBinding = programParent.getBinding(cssIdentifier.name);
  }

  invariant(
    cssBinding !== undefined,
    "Dynamic CSS variable lowering requires a registered css import binding"
  );

  programParent.minchoData.bindings.push(cssBinding.path);

  const cssImportSpecifierPath = cssBinding.path;

  invariant(
    cssImportSpecifierPath.isImportSpecifier(),
    "Dynamic CSS variable css import binding must be an import specifier"
  );

  return t.importDeclaration(
    [t.cloneNode(cssImportSpecifierPath.node)],
    t.stringLiteral(cssModuleName)
  );
}

function createDynamicCssVariableBranchLowering(options: {
  readonly path: NodePath<t.JSXOpeningElement>;
  readonly rule: DynamicCssVariableBranchRule;
  readonly stylePropertyByLeaf: ReadonlyMap<
    DynamicCssVariableLeaf,
    t.ObjectProperty
  >;
}): {
  readonly declarations: readonly t.VariableDeclaration[];
  readonly classNameExpression: t.Expression;
  readonly styleProperties: readonly t.ObjectExpression["properties"][number][];
} {
  const declarations: t.VariableDeclaration[] = [];
  const decisionIdentifierByRule = new Map<
    DynamicCssVariableBranchRule,
    t.Identifier
  >();
  const branchRules: Array<{
    readonly rule: DynamicCssVariableBranchRule;
    readonly activeExpression: t.Expression | null;
  }> = [{ rule: options.rule, activeExpression: null }];

  for (const { rule, activeExpression } of branchRules) {
    const decisionIdentifier =
      options.path.scope.generateUidIdentifier("minchoCssBranch");
    const decisionExpression =
      createDynamicCssVariableBranchDecisionExpression(rule);

    declarations.push(
      t.variableDeclaration("const", [
        t.variableDeclarator(
          t.cloneNode(decisionIdentifier),
          activeExpression
            ? t.conditionalExpression(
                t.cloneNode(activeExpression),
                t.cloneNode(decisionExpression),
                t.unaryExpression("void", t.numericLiteral(0))
              )
            : t.cloneNode(decisionExpression)
        )
      ])
    );
    decisionIdentifierByRule.set(rule, decisionIdentifier);

    for (const [branchIndex, branch] of rule.branches.entries()) {
      if (branch.kind === "branch") {
        const branchActiveExpression =
          createDynamicCssVariableNestedBranchActiveExpression(
            rule,
            decisionIdentifier,
            branchIndex
          );
        branchRules.push({
          rule: branch,
          activeExpression: activeExpression
            ? t.logicalExpression(
                "&&",
                t.cloneNode(activeExpression),
                branchActiveExpression
              )
            : branchActiveExpression
        });
      }
    }
  }

  const decisionIdentifier = getDynamicCssVariableBranchDecisionIdentifier(
    decisionIdentifierByRule,
    options.rule
  );
  const cssExpression = createDynamicCssVariableBranchClassNameExpression({
    rule: options.rule,
    decisionExpression: decisionIdentifier,
    decisionIdentifierByRule
  });
  const classNameExpression = createClassNameExpression(options.path, {
    cssExpression,
    cssValueClassification: "branch-css-rule",
    classNameAttribute: null
  });
  const styleProperties = [
    t.spreadElement(
      createDynamicCssVariableBranchStyleExpression({
        rule: options.rule,
        stylePropertyByLeaf: options.stylePropertyByLeaf,
        decisionExpression: decisionIdentifier,
        decisionIdentifierByRule
      })
    )
  ];

  return { declarations, classNameExpression, styleProperties };
}

function createDynamicCssVariableBranchDecisionExpression(
  rule: DynamicCssVariableBranchRule
): t.Expression {
  if (t.isConditionalExpression(rule.expression)) {
    return t.cloneNode(rule.expression.test);
  }

  return t.cloneNode(rule.expression.left);
}

function createDynamicCssVariableNestedBranchActiveExpression(
  rule: DynamicCssVariableBranchRule,
  decisionIdentifier: t.Identifier,
  branchIndex: number
): t.Expression {
  if (t.isConditionalExpression(rule.expression)) {
    return branchIndex === 0
      ? t.cloneNode(decisionIdentifier)
      : t.unaryExpression("!", t.cloneNode(decisionIdentifier));
  }

  if (rule.expression.operator === "&&") {
    return t.cloneNode(decisionIdentifier);
  }

  if (rule.expression.operator === "??") {
    return createDynamicCssVariableNullishDecisionExpression(
      decisionIdentifier
    );
  }

  return t.unaryExpression("!", t.cloneNode(decisionIdentifier));
}

function createDynamicCssVariableNullishDecisionExpression(
  decisionExpression: t.Expression
): t.LogicalExpression {
  return t.logicalExpression(
    "||",
    t.binaryExpression("===", t.cloneNode(decisionExpression), t.nullLiteral()),
    t.binaryExpression(
      "===",
      t.cloneNode(decisionExpression),
      t.unaryExpression("void", t.numericLiteral(0))
    )
  );
}

function createDynamicCssVariableBranchClassNameExpression(options: {
  readonly rule: DynamicCssVariableBranchRule;
  readonly decisionExpression: t.Expression;
  readonly decisionIdentifierByRule: ReadonlyMap<
    DynamicCssVariableBranchRule,
    t.Identifier
  >;
}): t.ConditionalExpression | t.LogicalExpression {
  if (t.isConditionalExpression(options.rule.expression)) {
    const consequent = options.rule.branches[0];
    const alternate = options.rule.branches[1];

    invariant(
      consequent !== undefined && alternate !== undefined,
      "Conditional dynamic CSS variable branch requires both branches"
    );

    return t.conditionalExpression(
      t.cloneNode(options.decisionExpression),
      createDynamicCssVariableRuleClassNameExpression(
        consequent,
        options.decisionIdentifierByRule
      ),
      createDynamicCssVariableRuleClassNameExpression(
        alternate,
        options.decisionIdentifierByRule
      )
    );
  }

  const right = options.rule.branches[0];

  invariant(
    right !== undefined,
    "Logical dynamic CSS variable branch requires a right branch"
  );

  return t.logicalExpression(
    options.rule.expression.operator,
    t.cloneNode(options.decisionExpression),
    createDynamicCssVariableRuleClassNameExpression(
      right,
      options.decisionIdentifierByRule
    )
  );
}

function createDynamicCssVariableRuleClassNameExpression(
  rule: DynamicCssVariableRule,
  decisionIdentifierByRule: ReadonlyMap<
    DynamicCssVariableBranchRule,
    t.Identifier
  >
): t.Expression {
  if (rule.kind === "direct") {
    return t.cloneNode(rule.expression);
  }

  return createDynamicCssVariableBranchClassNameExpression({
    rule,
    decisionExpression: getDynamicCssVariableBranchDecisionIdentifier(
      decisionIdentifierByRule,
      rule
    ),
    decisionIdentifierByRule
  });
}

function getDynamicCssVariableBranchDecisionIdentifier(
  decisionIdentifierByRule: ReadonlyMap<
    DynamicCssVariableBranchRule,
    t.Identifier
  >,
  rule: DynamicCssVariableBranchRule
): t.Identifier {
  const identifier = decisionIdentifierByRule.get(rule);

  invariant(
    identifier !== undefined,
    "Dynamic CSS variable branch requires a prepared decision binding"
  );

  return identifier;
}

function createDynamicCssVariableBranchStyleExpression(options: {
  readonly rule: DynamicCssVariableBranchRule;
  readonly stylePropertyByLeaf: ReadonlyMap<
    DynamicCssVariableLeaf,
    t.ObjectProperty
  >;
  readonly decisionExpression: t.Expression;
  readonly decisionIdentifierByRule: ReadonlyMap<
    DynamicCssVariableBranchRule,
    t.Identifier
  >;
}): t.Expression {
  if (t.isConditionalExpression(options.rule.expression)) {
    const consequent = options.rule.branches[0];
    const alternate = options.rule.branches[1];

    invariant(
      consequent !== undefined && alternate !== undefined,
      "Conditional dynamic CSS variable style requires both branches"
    );

    return t.conditionalExpression(
      t.cloneNode(options.decisionExpression),
      createDynamicCssVariableStyleObjectExpression({
        rule: consequent,
        stylePropertyByLeaf: options.stylePropertyByLeaf,
        decisionExpression:
          consequent.kind === "branch"
            ? getDynamicCssVariableBranchDecisionIdentifier(
                options.decisionIdentifierByRule,
                consequent
              )
            : null,
        decisionIdentifierByRule: options.decisionIdentifierByRule
      }),
      createDynamicCssVariableStyleObjectExpression({
        rule: alternate,
        stylePropertyByLeaf: options.stylePropertyByLeaf,
        decisionExpression:
          alternate.kind === "branch"
            ? getDynamicCssVariableBranchDecisionIdentifier(
                options.decisionIdentifierByRule,
                alternate
              )
            : null,
        decisionIdentifierByRule: options.decisionIdentifierByRule
      })
    );
  }

  const right = options.rule.branches[0];

  invariant(
    right !== undefined,
    "Logical dynamic CSS variable style requires a right branch"
  );

  const decisionExpression = t.cloneNode(options.decisionExpression);
  const rightStyle = createDynamicCssVariableStyleObjectExpression({
    rule: right,
    stylePropertyByLeaf: options.stylePropertyByLeaf,
    decisionExpression:
      right.kind === "branch"
        ? getDynamicCssVariableBranchDecisionIdentifier(
            options.decisionIdentifierByRule,
            right
          )
        : null,
    decisionIdentifierByRule: options.decisionIdentifierByRule
  });
  const emptyStyle = t.objectExpression([]);

  if (options.rule.expression.operator === "&&") {
    return t.conditionalExpression(decisionExpression, rightStyle, emptyStyle);
  }

  if (options.rule.expression.operator === "??") {
    return t.conditionalExpression(
      createDynamicCssVariableNullishDecisionExpression(decisionExpression),
      rightStyle,
      emptyStyle
    );
  }

  return t.conditionalExpression(decisionExpression, emptyStyle, rightStyle);
}

function createDynamicCssVariableStyleObjectExpression(options: {
  readonly rule: DynamicCssVariableRule;
  readonly stylePropertyByLeaf: ReadonlyMap<
    DynamicCssVariableLeaf,
    t.ObjectProperty
  >;
  readonly decisionExpression: t.Expression | null;
  readonly decisionIdentifierByRule: ReadonlyMap<
    DynamicCssVariableBranchRule,
    t.Identifier
  >;
}): t.ObjectExpression {
  switch (options.rule.kind) {
    case "direct":
      return t.objectExpression(
        options.rule.leaves.map((leaf) =>
          cloneDynamicCssVariableStyleProperty(
            options.stylePropertyByLeaf,
            leaf
          )
        )
      );
    case "branch":
      invariant(
        options.decisionExpression !== null,
        "Dynamic CSS variable branch style requires a decision expression"
      );
      return t.objectExpression([
        t.spreadElement(
          createDynamicCssVariableBranchStyleExpression({
            rule: options.rule,
            stylePropertyByLeaf: options.stylePropertyByLeaf,
            decisionExpression: options.decisionExpression,
            decisionIdentifierByRule: options.decisionIdentifierByRule
          })
        )
      ]);
    default: {
      const exhaustive: never = options.rule;
      return exhaustive;
    }
  }
}

function cloneDynamicCssVariableStyleProperty(
  stylePropertyByLeaf: ReadonlyMap<DynamicCssVariableLeaf, t.ObjectProperty>,
  leaf: DynamicCssVariableLeaf
): t.ObjectProperty {
  const property = stylePropertyByLeaf.get(leaf);

  invariant(
    property !== undefined,
    "Dynamic CSS variable style property requires a prepared leaf"
  );

  return t.cloneNode(property);
}

function createDynamicCssVariableClassNameAttributeValue(
  path: NodePath<t.JSXOpeningElement>,
  classNameAttribute: t.JSXAttribute | null,
  lowering: DynamicCssVariableLowering
): t.JSXAttribute["value"] {
  if (!classNameAttribute) {
    return t.jsxExpressionContainer(t.cloneNode(lowering.classNameExpression));
  }

  invariant(
    lowering.cxExpression !== null,
    "Dynamic CSS variable className merge requires a generated cx export"
  );

  return t.jsxExpressionContainer(
    t.callExpression(t.cloneNode(lowering.cxExpression), [
      getClassNameExpression(path, classNameAttribute),
      t.cloneNode(lowering.classNameExpression)
    ])
  );
}

function createDynamicCssVariableStyleAttributeValue(
  path: NodePath<t.JSXOpeningElement>,
  styleAttribute: t.JSXAttribute | null,
  styleProperties: readonly t.ObjectExpression["properties"][number][]
): t.JSXAttribute["value"] {
  if (!styleAttribute) {
    return t.jsxExpressionContainer(
      t.objectExpression(
        styleProperties.map((property) => t.cloneNode(property))
      )
    );
  }

  const styleExpression = getStyleExpression(path, styleAttribute);
  const userStyleProperties = t.isObjectExpression(styleExpression)
    ? styleExpression.properties.map((property) => t.cloneNode(property))
    : [t.spreadElement(t.cloneNode(styleExpression))];

  return t.jsxExpressionContainer(
    t.objectExpression([
      ...userStyleProperties,
      ...styleProperties.map((property) => t.cloneNode(property))
    ])
  );
}

function assertDynamicCssVariableStyleAttributeValue(
  path: NodePath<t.JSXOpeningElement>,
  styleAttribute: t.JSXAttribute | null
): void {
  if (!styleAttribute) {
    return;
  }

  getStyleExpression(path, styleAttribute);
}

function createDynamicCssVariableCxExportDeclaration(
  exportedIdentifier: t.Identifier
): t.ExportNamedDeclaration {
  return t.exportNamedDeclaration(
    null,
    [t.exportSpecifier(t.identifier("cx"), t.cloneNode(exportedIdentifier))],
    t.stringLiteral(cssModuleName)
  );
}

function createDynamicCssVariableHelperImportDeclaration(
  bindings: DynamicCssVariableHelperImportBindings
): t.ImportDeclaration {
  return t.importDeclaration(
    [
      t.importSpecifier(
        t.cloneNode(bindings.createVarIdentifier),
        t.identifier("createVar")
      ),
      t.importSpecifier(
        t.cloneNode(bindings.getVarNameIdentifier),
        t.identifier("getVarName")
      )
    ],
    t.stringLiteral(cssModuleName)
  );
}

export function getDynamicCssVariableRule(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableRule | null {
  const rule = collectDynamicCssVariableRule(options);

  if (!rule || rule.leaves.length === 0) {
    return null;
  }

  return rule;
}

function collectDynamicCssVariableRule(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableRule | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    options.expression
  );

  if (
    t.isObjectExpression(unwrappedExpression) ||
    t.isArrayExpression(unwrappedExpression)
  ) {
    return collectDirectDynamicCssVariableRule({
      expression: unwrappedExpression,
      scope: options.scope
    });
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return collectConditionalDynamicCssVariableRule({
      expression: unwrappedExpression,
      scope: options.scope
    });
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return collectLogicalDynamicCssVariableRule({
      expression: unwrappedExpression,
      scope: options.scope
    });
  }

  return null;
}

function collectDirectDynamicCssVariableRule(options: {
  readonly expression: t.ObjectExpression | t.ArrayExpression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableDirectRule | null {
  const result = t.isObjectExpression(options.expression)
    ? collectDynamicCssVariableObjectExpression({
        expression: options.expression,
        declarationName: null,
        scope: options.scope
      })
    : collectDynamicCssVariableArrayExpression({
        expression: options.expression,
        scope: options.scope
      });

  return result
    ? { kind: "direct", expression: result.expression, leaves: result.leaves }
    : null;
}

function collectConditionalDynamicCssVariableRule(options: {
  readonly expression: t.ConditionalExpression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableRule | null {
  const consequent = collectDynamicCssVariableRule({
    expression: options.expression.consequent,
    scope: options.scope
  });
  const alternate = collectDynamicCssVariableRule({
    expression: options.expression.alternate,
    scope: options.scope
  });

  if (!consequent || !alternate) {
    return null;
  }

  return {
    kind: "branch",
    expression: t.conditionalExpression(
      t.cloneNode(options.expression.test),
      t.cloneNode(consequent.expression),
      t.cloneNode(alternate.expression)
    ),
    leaves: [...consequent.leaves, ...alternate.leaves],
    branches: [consequent, alternate]
  };
}

function collectLogicalDynamicCssVariableRule(options: {
  readonly expression: t.LogicalExpression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableRule | null {
  const right = collectDynamicCssVariableRule({
    expression: options.expression.right,
    scope: options.scope
  });

  if (!right) {
    return null;
  }

  return {
    kind: "branch",
    expression: t.logicalExpression(
      options.expression.operator,
      t.cloneNode(options.expression.left),
      t.cloneNode(right.expression)
    ),
    leaves: right.leaves,
    branches: [right]
  };
}

type DynamicCssVariableObjectWalkResult = {
  readonly expression: t.ObjectExpression;
  readonly leaves: DynamicCssVariableRule["leaves"];
};

type DynamicCssVariableArrayWalkResult = {
  readonly expression: t.ArrayExpression;
  readonly leaves: DynamicCssVariableRule["leaves"];
};

function collectDynamicCssVariableObjectExpression(options: {
  readonly expression: t.ObjectExpression;
  readonly declarationName: string | null;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableObjectWalkResult | null {
  const properties: t.ObjectExpression["properties"] = [];
  const leaves: DynamicCssVariableLeaf[] = [];

  for (const property of options.expression.properties) {
    if (
      !t.isObjectProperty(property) ||
      property.computed ||
      property.shorthand ||
      !t.isExpression(property.value)
    ) {
      return null;
    }

    const propertyName = getStaticObjectPropertyKeyName(property.key);

    if (!propertyName) {
      return null;
    }

    const value = unwrapTransparentCssRuleExpression(property.value);
    const nextProperty = t.cloneNode(property);
    nextProperty.shorthand = false;

    if (t.isObjectExpression(value)) {
      const nestedResult = collectDynamicCssVariableObjectExpression({
        expression: value,
        declarationName: getNestedDeclarationName({
          propertyName,
          declarationName: options.declarationName
        }),
        scope: options.scope
      });

      if (!nestedResult) {
        return null;
      }

      nextProperty.value = nestedResult.expression;
      properties.push(nextProperty);
      leaves.push(...nestedResult.leaves);
      continue;
    }

    if (t.isArrayExpression(value)) {
      if (!isStaticCssShapeExpression(value)) {
        return null;
      }

      nextProperty.value = t.cloneNode(property.value);
      properties.push(nextProperty);
      continue;
    }

    if (isStaticCssPrimitiveExpression(value)) {
      nextProperty.value = t.cloneNode(property.value);
      properties.push(nextProperty);
      continue;
    }

    const leafPropertyName = getLeafDeclarationName({
      propertyName,
      declarationName: options.declarationName
    });

    if (
      !leafPropertyName ||
      !isSupportedDynamicCssVariableValueExpression({
        expression: property.value,
        scope: options.scope
      })
    ) {
      return null;
    }

    const leaf = {
      propertyName: leafPropertyName,
      value: t.cloneNode(property.value),
      variableIdentifier: t.identifier("minchoDynamicCssVariable")
    };
    nextProperty.value = leaf.variableIdentifier;
    properties.push(nextProperty);
    leaves.push(leaf);
  }

  return { expression: t.objectExpression(properties), leaves };
}

function collectDynamicCssVariableArrayExpression(options: {
  readonly expression: t.ArrayExpression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableArrayWalkResult | null {
  const elements: t.ArrayExpression["elements"] = [];
  const leaves: DynamicCssVariableLeaf[] = [];

  for (const element of options.expression.elements) {
    if (!element || t.isSpreadElement(element)) {
      return null;
    }

    const value = unwrapTransparentCssRuleExpression(element);

    if (!t.isObjectExpression(value)) {
      return null;
    }

    const elementResult = collectDynamicCssVariableObjectExpression({
      expression: value,
      declarationName: null,
      scope: options.scope
    });

    if (!elementResult) {
      return null;
    }

    elements.push(elementResult.expression);
    leaves.push(...elementResult.leaves);
  }

  return { expression: t.arrayExpression(elements), leaves };
}

function getNestedDeclarationName(options: {
  readonly propertyName: string;
  readonly declarationName: string | null;
}): string | null {
  if (options.declarationName) {
    return options.declarationName;
  }

  return isNestedCssObjectKey(options.propertyName)
    ? null
    : options.propertyName;
}

function getLeafDeclarationName(options: {
  readonly propertyName: string;
  readonly declarationName: string | null;
}): string | null {
  return (
    options.declarationName ??
    (isNestedCssObjectKey(options.propertyName) ? null : options.propertyName)
  );
}

function isNestedCssObjectKey(propertyName: string): boolean {
  return (
    propertyName === "selectors" ||
    propertyName === "vars" ||
    propertyName.startsWith("@") ||
    propertyName.startsWith("_") ||
    propertyName.startsWith("$") ||
    propertyName.includes("&") ||
    propertyName.includes(":") ||
    propertyName.includes(" ")
  );
}

function isSupportedDynamicCssVariableValueExpression(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): boolean {
  const expression = unwrapTransparentCssRuleExpression(options.expression);

  if (isDirectMemberReferenceExpression(expression)) {
    const rootIdentifier = getDirectReferenceRootIdentifier(expression.object);

    return rootIdentifier
      ? !isImportedBindingIdentifier(options.scope, rootIdentifier)
      : true;
  }

  if (!t.isCallExpression(expression)) {
    return false;
  }

  return !isSidecarSafeDynamicCssVariableCallExpression({
    expression,
    scope: options.scope
  });
}

function isSidecarSafeDynamicCssVariableCallExpression(options: {
  readonly expression: t.CallExpression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): boolean {
  return isSidecarSafeCssRuleExpression({
    expression: t.objectExpression([
      t.objectProperty(t.identifier("value"), t.cloneNode(options.expression))
    ]),
    state: {
      scope: options.scope,
      visiting: new Set(),
      localNames: new Set()
    }
  });
}

function isDirectMemberReferenceExpression(
  expression: t.Expression
): expression is t.MemberExpression | t.OptionalMemberExpression {
  if (t.isMemberExpression(expression)) {
    return (
      !expression.computed &&
      isDirectReferenceObjectExpression(expression.object)
    );
  }

  if (t.isOptionalMemberExpression(expression)) {
    return (
      !expression.computed &&
      isDirectReferenceObjectExpression(expression.object)
    );
  }

  return false;
}

function isDirectReferenceExpression(expression: t.Expression): boolean {
  if (t.isIdentifier(expression) || t.isThisExpression(expression)) {
    return true;
  }

  return isDirectMemberReferenceExpression(expression);
}

function isDirectReferenceObjectExpression(
  expression: t.Expression | t.Super
): boolean {
  return !t.isSuper(expression) && isDirectReferenceExpression(expression);
}

function getDirectReferenceRootIdentifier(
  expression: t.Expression | t.Super
): t.Identifier | null {
  if (t.isSuper(expression) || t.isThisExpression(expression)) {
    return null;
  }

  if (t.isIdentifier(expression)) {
    return expression;
  }

  if (!isDirectMemberReferenceExpression(expression)) {
    return null;
  }

  return getDirectReferenceRootIdentifier(expression.object);
}

function isImportedBindingIdentifier(
  scope: NodePath<t.JSXOpeningElement>["scope"],
  identifier: t.Identifier
): boolean {
  const binding = scope.getBinding(identifier.name);
  const bindingPath = binding?.path;

  return !!(
    bindingPath &&
    (bindingPath.isImportSpecifier() ||
      bindingPath.isImportDefaultSpecifier() ||
      bindingPath.isImportNamespaceSpecifier())
  );
}

function isStaticCssShapeExpression(expression: t.Expression): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (isStaticCssPrimitiveExpression(unwrappedExpression)) {
    return true;
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    return unwrappedExpression.properties.every((property) => {
      return (
        t.isObjectProperty(property) &&
        !property.computed &&
        !property.shorthand &&
        !!getStaticObjectPropertyKeyName(property.key) &&
        t.isExpression(property.value) &&
        isStaticCssShapeExpression(property.value)
      );
    });
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return unwrappedExpression.elements.every((element) => {
      return (
        !!element &&
        !t.isSpreadElement(element) &&
        isStaticCssShapeExpression(element)
      );
    });
  }

  return false;
}

function isStaticCssPrimitiveExpression(expression: t.Expression): boolean {
  return (
    t.isStringLiteral(expression) ||
    t.isNumericLiteral(expression) ||
    t.isBooleanLiteral(expression) ||
    t.isNullLiteral(expression) ||
    isUnaryNumericLiteral(expression) ||
    (t.isTemplateLiteral(expression) && expression.expressions.length === 0)
  );
}

function isUnaryNumericLiteral(
  expression: t.Expression
): expression is t.UnaryExpression & { argument: t.NumericLiteral } {
  return (
    t.isUnaryExpression(expression) &&
    (expression.operator === "+" || expression.operator === "-") &&
    t.isNumericLiteral(expression.argument)
  );
}

function createIdentifierNameFragment(value: string): string {
  const fragments = value.match(/[A-Za-z0-9_$]+/g);

  if (!fragments) {
    return "Value";
  }

  return fragments.map(capitalizeIdentifierFragment).join("");
}

function capitalizeIdentifierFragment(fragment: string): string {
  return `${fragment.charAt(0).toUpperCase()}${fragment.slice(1)}`;
}

function getStaticObjectPropertyKeyName(
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

function getResolvedCssExpression(
  path: NodePath<t.JSXOpeningElement>,
  programPath: NodePath<t.Program>,
  state: PluginState,
  partialEvalResult: CssPropPartialEvalPolicyResult
): t.Expression {
  if (isStaticCssPrimitiveExpression(partialEvalResult.reducedExpression)) {
    return partialEvalResult.rawExpression;
  }

  const ownerFile = getStaticCssEvalOwnerFile(state);
  const cssExpression = getCssPropStaticEvalExpression(partialEvalResult);
  const partialEvalDiagnostic =
    createPreferredStaticCssEvalDeoptDiagnostic(partialEvalResult);
  const staticCssEvalResult = shouldResolveSameFileCssExpression(cssExpression)
    ? resolveSameFileStaticCssEvalExpression({
        expression: cssExpression,
        ownerFile,
        programPath,
        scope: path.scope
      })
    : { kind: "not-candidate" as const };

  if (staticCssEvalResult.kind === "error") {
    const inlineStaticCssEvalResult = resolveDirectInlineStaticCssRuleLiteral({
      expression: cssExpression,
      ownerFile,
      programPath,
      scope: path.scope,
      provider: state.opts.staticCssEvalProvider,
      metadata: [],
      state: { count: 0 },
      depth: 1
    });

    if (inlineStaticCssEvalResult.kind === "resolved") {
      for (const metadata of inlineStaticCssEvalResult.metadata) {
        registerStaticCssEvalResultMetadata(state, metadata);
      }

      return preserveDirectBooleanReferenceValues(
        cssExpression,
        inlineStaticCssEvalResult.expression
      );
    }

    if (inlineStaticCssEvalResult.kind === "error") {
      if (inlineStaticCssEvalResult.diagnostic.code === "limit-exceeded") {
        for (const metadata of inlineStaticCssEvalResult.metadata) {
          registerStaticCssEvalResultMetadata(state, metadata);
        }

        throw path.buildCodeFrameError(
          inlineStaticCssEvalResult.diagnostic.message
        );
      }

      if (shouldPreserveUnsupportedArraySpreadClassification(cssExpression)) {
        return cssExpression;
      }

      if (
        shouldPreserveUnsupportedDynamicCssRuleClassification(cssExpression)
      ) {
        return cssExpression;
      }

      for (const metadata of inlineStaticCssEvalResult.metadata) {
        registerStaticCssEvalResultMetadata(state, metadata);
      }

      if (partialEvalDiagnostic) {
        registerStaticCssEvalDiagnosticMetadata(state, partialEvalDiagnostic);
        throw path.buildCodeFrameError(partialEvalDiagnostic.message);
      }

      throw path.buildCodeFrameError(
        inlineStaticCssEvalResult.diagnostic.message
      );
    }

    if (shouldPreserveUnsupportedArraySpreadClassification(cssExpression)) {
      return cssExpression;
    }

    if (shouldPreserveUnsupportedDynamicCssRuleClassification(cssExpression)) {
      return cssExpression;
    }

    registerStaticCssEvalResultMetadata(state, staticCssEvalResult);
    if (partialEvalDiagnostic) {
      registerStaticCssEvalDiagnosticMetadata(state, partialEvalDiagnostic);
      throw path.buildCodeFrameError(partialEvalDiagnostic.message);
    }

    throw path.buildCodeFrameError(staticCssEvalResult.diagnostic.message);
  }

  if (staticCssEvalResult.kind === "resolved") {
    registerStaticCssEvalResultMetadata(state, staticCssEvalResult);
    return preserveDirectBooleanReferenceValues(
      getBooleanPreservationExpression(partialEvalResult, cssExpression),
      normalizeResolvedCssRuleExpression(staticCssEvalResult.expression)
    );
  }

  registerStaticCssEvalResultMetadata(state, staticCssEvalResult);

  registerImportedStaticCssEvalProviderResultMetadata({
    expression: cssExpression,
    ownerFile,
    state
  });

  const importedStaticCssEvalResult = resolveImportedStaticCssEvalExpression({
    expression: cssExpression,
    ownerFile,
    provider: state.opts.staticCssEvalProvider,
    allowUnsupportedSourceFallback: true
  });

  if (importedStaticCssEvalResult.kind === "error") {
    registerStaticCssEvalDiagnosticMetadata(
      state,
      importedStaticCssEvalResult.diagnostic
    );
    throw path.buildCodeFrameError(
      importedStaticCssEvalResult.diagnostic.message
    );
  }

  const resolvedCssExpression =
    importedStaticCssEvalResult.kind === "resolved"
      ? importedStaticCssEvalResult.expression
      : cssExpression;

  const unsupportedImportedReferenceDiagnostic =
    findUnsupportedImportedStaticCssEvalReferenceDiagnostic({
      expression: resolvedCssExpression,
      ownerFile,
      provider: state.opts.staticCssEvalProvider
    });

  if (unsupportedImportedReferenceDiagnostic) {
    registerStaticCssEvalDiagnosticMetadata(
      state,
      unsupportedImportedReferenceDiagnostic
    );
    throw path.buildCodeFrameError(
      unsupportedImportedReferenceDiagnostic.message
    );
  }

  if (
    containsDynamicCssVariableRuleBranch({
      expression: resolvedCssExpression,
      scope: path.scope
    })
  ) {
    if (partialEvalDiagnostic) {
      registerStaticCssEvalDiagnosticMetadata(state, partialEvalDiagnostic);
      throw path.buildCodeFrameError(partialEvalDiagnostic.message);
    }

    throw path.buildCodeFrameError(unsupportedDynamicCssRuleValueErrorMessage);
  }

  if (
    isUnsupportedDynamicCssRuleCallExpression({
      expression: resolvedCssExpression,
      scope: path.scope
    })
  ) {
    if (partialEvalDiagnostic) {
      registerStaticCssEvalDiagnosticMetadata(state, partialEvalDiagnostic);
      throw path.buildCodeFrameError(partialEvalDiagnostic.message);
    }

    throw path.buildCodeFrameError(unsupportedDynamicCssRuleValueErrorMessage);
  }

  return resolvedCssExpression;
}

function isUnsupportedDynamicCssRuleCallExpression(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    options.expression
  );

  if (
    !t.isCallExpression(unwrappedExpression) ||
    !isTopLevelCssRuleCallExpression(unwrappedExpression, options.scope)
  ) {
    return false;
  }

  if (
    t.isMemberExpression(unwrappedExpression.callee) ||
    t.isOptionalMemberExpression(unwrappedExpression.callee)
  ) {
    const rootIdentifier = getDirectReferenceRootIdentifier(
      unwrappedExpression.callee.object
    );
    const bindingPath = rootIdentifier
      ? options.scope.getBinding(rootIdentifier.name)?.path
      : null;

    return !bindingPath?.isVariableDeclarator();
  }

  return unwrappedExpression.arguments.some((argument) => {
    return (
      t.isSpreadElement(argument) ||
      !t.isExpression(argument) ||
      !isStaticCssShapeExpression(argument)
    );
  });
}

function containsDynamicCssVariableRuleBranch(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): boolean {
  const expression = unwrapTransparentCssRuleExpression(options.expression);

  if (t.isObjectExpression(expression)) {
    return (
      getDynamicCssVariableRule({
        expression,
        scope: options.scope
      }) !== null || !isStaticCssShapeExpression(expression)
    );
  }

  if (t.isArrayExpression(expression)) {
    return (
      getDynamicCssVariableRule({
        expression,
        scope: options.scope
      }) !== null
    );
  }

  if (t.isConditionalExpression(expression)) {
    return (
      containsDynamicCssVariableRuleBranch({
        expression: expression.consequent,
        scope: options.scope
      }) ||
      containsDynamicCssVariableRuleBranch({
        expression: expression.alternate,
        scope: options.scope
      })
    );
  }

  if (t.isLogicalExpression(expression)) {
    return (
      containsDynamicCssVariableRuleBranch({
        expression: expression.left,
        scope: options.scope
      }) ||
      containsDynamicCssVariableRuleBranch({
        expression: expression.right,
        scope: options.scope
      })
    );
  }

  return false;
}

function getStaticCssEvalOwnerFile(state: PluginState): string {
  return state.file.opts.filename ?? "<unknown>";
}

function shouldResolveSameFileCssExpression(expression: t.Expression): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  return !(
    t.isArrayExpression(unwrappedExpression) &&
    !containsArraySpreadElement(unwrappedExpression) &&
    isArrayClassValueExpression(unwrappedExpression)
  );
}

function assertSupportedCssPropElement(
  openingElementPath: NodePath<t.JSXOpeningElement>
): void {
  const { name } = openingElementPath.node;

  if (t.isJSXNamespacedName(name)) {
    throw openingElementPath.buildCodeFrameError(namespacedTargetErrorMessage);
  }

  if (isFragmentTarget(name)) {
    throw openingElementPath.buildCodeFrameError(fragmentTargetErrorMessage);
  }

  if (t.isJSXIdentifier(name) || t.isJSXMemberExpression(name)) {
    return;
  }

  throw openingElementPath.buildCodeFrameError(unsupportedTargetErrorMessage);
}

function isFragmentTarget(name: t.JSXOpeningElement["name"]): boolean {
  return (
    (t.isJSXIdentifier(name) && name.name === "Fragment") ||
    (t.isJSXMemberExpression(name) &&
      t.isJSXIdentifier(name.object) &&
      name.object.name === "React" &&
      name.property.name === "Fragment")
  );
}

function getJsxAttributes(
  openingElement: t.JSXOpeningElement,
  attributeName: string
): t.JSXAttribute[] {
  return openingElement.attributes.filter(
    (attribute): attribute is t.JSXAttribute =>
      t.isJSXAttribute(attribute) &&
      t.isJSXIdentifier(attribute.name) &&
      attribute.name.name === attributeName
  );
}

function isNamedJsxAttribute(
  attribute: t.JSXAttribute | t.JSXSpreadAttribute,
  attributeName: string
): boolean {
  return (
    t.isJSXAttribute(attribute) &&
    t.isJSXIdentifier(attribute.name) &&
    attribute.name.name === attributeName
  );
}

function hasExplicitKeyOrRefAttribute(
  attributes: Array<t.JSXAttribute | t.JSXSpreadAttribute>
): boolean {
  return attributes.some(
    (attribute) =>
      isNamedJsxAttribute(attribute, "key") ||
      isNamedJsxAttribute(attribute, "ref")
  );
}

function getCssExpression(
  path: NodePath<t.JSXOpeningElement>,
  attribute: t.JSXAttribute
): t.Expression {
  if (attribute.value === null) {
    throw path.buildCodeFrameError(cssExpressionValueErrorMessage);
  }

  if (t.isStringLiteral(attribute.value)) {
    return attribute.value;
  }

  if (!t.isJSXExpressionContainer(attribute.value)) {
    throw path.buildCodeFrameError(cssValueErrorMessage);
  }

  const { expression } = attribute.value;

  if (t.isJSXEmptyExpression(expression)) {
    throw path.buildCodeFrameError(cssExpressionValueErrorMessage);
  }

  return expression;
}
