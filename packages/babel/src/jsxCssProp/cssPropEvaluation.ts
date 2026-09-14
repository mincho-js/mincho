import type { NodePath } from "@babel/core";
import { types as t } from "@babel/core";
import type { Scope } from "@babel/traverse";
import { isNestedCssObjectKey } from "../cssProperty.js";
import { unwrapTransparentCssRuleExpression } from "../staticCssEval/candidates.js";
import type { PartialEvalDeoptTaxonomyEntry } from "../staticCssEval/deopt.js";
import { PARTIAL_EVAL_DEOPT_TAXONOMY } from "../staticCssEval/deopt.js";
import { createStaticCssEvalPartialEvalDeoptDiagnostic } from "../staticCssEval/diagnostics.js";
import {
  findUnsupportedImportedStaticCssEvalReferenceDiagnostic,
  resolveImportedStaticCssEvalExpression
} from "../staticCssEval/importedModules.js";
import {
  createPartialEvalContext,
  getPartialEvalResultExpression,
  reducePartialEvalExpression,
  type PartialEvalDeoptReason,
  type PartialEvalDiagnostic,
  type PartialEvalResult
} from "../staticCssEval/partialEvaluator/index.js";
import type { StaticCssApiPolicy } from "../staticCssEval/policy.js";
import { STATIC_CSS_API_POLICIES } from "../staticCssEval/policy.js";
import { resolveSameFileStaticCssEvalExpression } from "../staticCssEval/sameFile.js";
import type { PluginState } from "../types.js";
import {
  classifyCssPropValue,
  containsArraySpreadElement,
  containsUnsupportedSequenceCssRuleValue,
  isArrayClassValueExpression,
  isTopLevelCssRuleCallExpression
} from "./classification.js";
import {
  unsupportedArraySpreadCssValueErrorMessage,
  unsupportedDynamicCssRuleValueErrorMessage,
  unsupportedFunctionCssValueErrorMessage
} from "./constants.js";
import {
  createDynamicCssVariableDeclarationBranchExpression,
  getDirectReferenceRootIdentifier,
  getDynamicCssVariableRule,
  isDirectReferenceExpression
} from "./dynamicCssVariableAnalysis.js";
import {
  getStaticObjectPropertyKeyName,
  isStaticCssPrimitiveExpression,
  isStaticCssShapeExpression
} from "./expressionShape.js";
import {
  registerImportedStaticCssEvalProviderResultMetadata,
  registerStaticCssEvalDiagnosticMetadata,
  registerStaticCssEvalResultMetadata
} from "./metadata.js";
import {
  analyzeCssPropSidecarHoistability,
  getSidecarCssRuleClassification
} from "./modeAnalysis.js";
import {
  normalizeResolvedCssRuleExpression,
  preserveDirectBooleanReferenceValues,
  resolveDirectInlineStaticCssRuleLiteral,
  shouldPreserveUnsupportedArraySpreadClassification,
  shouldPreserveUnsupportedDynamicCssRuleClassification
} from "./staticCssEval.js";
import type {
  CssPropLoweringMode,
  CssPropSidecarHoistability,
  CssPropValueClassification,
  DynamicCssVariableRule
} from "./types.js";

const staticCssShapeErrorMessage =
  "Mincho `css` requires statically known CSS shape";

const staticCssShapeReactStyleGuidance =
  "Plain runtime declaration objects belong in React `style={...}`.";

const complexConditionStaticCssShapeErrorMessage =
  "Complex conditions are supported only when branch CSS shape is static";

type CssPropPartialEvalPolicyResult = {
  readonly policy: StaticCssApiPolicy;
  readonly result: PartialEvalResult;
  readonly rawExpression: t.Expression;
  readonly reducedExpression: t.Expression;
  readonly metadata: PartialEvalResult["metadata"];
  readonly diagnostics: readonly PartialEvalDiagnostic[];
  readonly deoptReasons: readonly PartialEvalDeoptReason[];
  readonly deopts: readonly PartialEvalDeoptTaxonomyEntry[];
};

type CssPropLoweringRouteResult = {
  readonly cssExpression: t.Expression;
  readonly cssValueClassification: CssPropValueClassification;
  readonly cssLoweringMode: CssPropLoweringMode;
};

const jsxCssPropStaticEvalPolicy = STATIC_CSS_API_POLICIES["jsx-css-prop"];

export function evaluateCssPropPartialEvalPolicy(options: {
  readonly expression: t.Expression;
  readonly ownerFile: string;
  readonly programPath: NodePath<t.Program>;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): CssPropPartialEvalPolicyResult {
  const policy = jsxCssPropStaticEvalPolicy;
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

  return adaptCssPropPartialEvalPolicyResult({
    policy,
    rawExpression: options.expression,
    result
  });
}

function adaptCssPropPartialEvalPolicyResult(options: {
  readonly policy: StaticCssApiPolicy;
  readonly rawExpression: t.Expression;
  readonly result: PartialEvalResult;
}): CssPropPartialEvalPolicyResult {
  const diagnostics = options.result.diagnostics;

  return {
    policy: options.policy,
    result: options.result,
    rawExpression: options.rawExpression,
    reducedExpression: getPartialEvalResultExpression(options.result),
    metadata: options.result.metadata,
    diagnostics,
    deoptReasons: diagnostics.map(({ reason }) => reason),
    deopts: diagnostics.map(({ reason }) => PARTIAL_EVAL_DEOPT_TAXONOMY[reason])
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

export function throwHardPartialEvalDeoptIfNeeded(
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
    case "non-static-object-key":
    case "unsupported-spread":
    case "unsupported-computed-member":
    case "unsupported-template-interpolation":
    case "runtime-css-shape":
      return false;
    case "unsupported-call-expression":
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

export function getCssPropShapeBranchExpression(options: {
  readonly partialEvalResult: CssPropPartialEvalPolicyResult;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): t.Expression | null {
  return createDynamicCssVariableDeclarationBranchExpression({
    expression: getCssPropShapeExpression(options.partialEvalResult),
    scope: options.scope
  });
}

export function getCssPropDynamicCssVariableRule(options: {
  readonly expression: t.Expression | null;
  readonly partialEvalResult: CssPropPartialEvalPolicyResult;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableRule | null {
  if (!options.partialEvalResult.policy.dynamicLeaves.cssVariables) {
    return null;
  }

  return getDynamicCssVariableRule({
    expression:
      options.expression ??
      getCssPropShapeExpression(options.partialEvalResult),
    scope: options.scope
  });
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
  if (
    rawExpression.properties.some((property) => t.isSpreadElement(property))
  ) {
    return t.cloneNode(reducedExpression);
  }

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

export function getCssPropSidecarHoistabilityRoute(options: {
  readonly partialEvalResult: CssPropPartialEvalPolicyResult;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): CssPropSidecarHoistability {
  if (!options.partialEvalResult.policy.sidecarDelegation.enabled) {
    return { kind: "not-candidate" };
  }

  const hoistability = analyzeCssPropSidecarHoistability({
    expression: options.partialEvalResult.rawExpression,
    reducedExpression: options.partialEvalResult.reducedExpression,
    scope: options.scope
  });

  if (
    hoistability.kind === "unsafe" &&
    shouldRouteUnsafeSidecarCallThroughAstStatic(
      options.partialEvalResult,
      options.scope
    )
  ) {
    return { kind: "not-candidate" };
  }

  return hoistability;
}

export function routeCssPropLowering(options: {
  readonly cssShapeBranchExpression: t.Expression | null;
  readonly dynamicCssVariableRule: DynamicCssVariableRule | null;
  readonly openingElementPath: NodePath<t.JSXOpeningElement>;
  readonly partialEvalResult: CssPropPartialEvalPolicyResult;
  readonly programPath: NodePath<t.Program>;
  readonly sidecarHoistability: CssPropSidecarHoistability;
  readonly state: PluginState;
}): CssPropLoweringRouteResult {
  let routedCssExpression: t.Expression;

  if (options.dynamicCssVariableRule) {
    routedCssExpression = options.dynamicCssVariableRule.fragment.expression;
  } else if (options.cssShapeBranchExpression) {
    routedCssExpression = options.cssShapeBranchExpression;
  } else if (
    options.sidecarHoistability.kind === "hoistable" ||
    options.sidecarHoistability.kind === "unsafe"
  ) {
    routedCssExpression = getCssPropSidecarExpression(
      options.partialEvalResult,
      options.openingElementPath.scope
    );
  } else {
    routedCssExpression = getResolvedCssExpression(
      options.openingElementPath,
      options.programPath,
      options.state,
      options.partialEvalResult
    );
  }

  const cssValueClassification = getCssValueClassification({
    expression: routedCssExpression,
    sidecarHoistability: options.sidecarHoistability,
    scope: options.openingElementPath.scope
  });

  return {
    cssExpression: getCssPropLoweringExpression({
      classification: cssValueClassification,
      partialEvalResult: options.partialEvalResult,
      routedExpression: routedCssExpression
    }),
    cssValueClassification,
    cssLoweringMode: getCssPropLoweringMode({
      cssValueClassification,
      dynamicCssVariableRule: options.dynamicCssVariableRule,
      sidecarHoistability: options.sidecarHoistability
    })
  };
}

function getCssPropSidecarExpression(
  result: CssPropPartialEvalPolicyResult,
  scope: Scope
): t.Expression {
  return getSidecarCssRuleClassification(result.reducedExpression, scope)
    ? result.reducedExpression
    : result.rawExpression;
}

function shouldRouteUnsafeSidecarCallThroughAstStatic(
  result: CssPropPartialEvalPolicyResult,
  scope: Scope
): boolean {
  if (!result.deoptReasons.includes("unsupported-call-expression")) {
    return false;
  }

  const expression = unwrapTransparentCssRuleExpression(
    getCssPropSidecarExpression(result, scope)
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

  if (containsOptionalCallExpression(options.expression)) {
    return "unsupported-dynamic-css-rule";
  }

  return classifyCssPropValue(options.expression, options.scope);
}

function containsOptionalCallExpression(expression: t.Expression): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isOptionalCallExpression(unwrappedExpression)) {
    return true;
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    return unwrappedExpression.properties.some((property) => {
      if (t.isSpreadElement(property)) {
        return containsOptionalCallExpression(property.argument);
      }

      return (
        t.isObjectProperty(property) &&
        ((property.computed &&
          t.isExpression(property.key) &&
          containsOptionalCallExpression(property.key)) ||
          (t.isExpression(property.value) &&
            containsOptionalCallExpression(property.value)))
      );
    });
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return unwrappedExpression.elements.some((element) => {
      if (!element) {
        return false;
      }

      return t.isSpreadElement(element)
        ? containsOptionalCallExpression(element.argument)
        : containsOptionalCallExpression(element);
    });
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return (
      containsOptionalCallExpression(unwrappedExpression.test) ||
      containsOptionalCallExpression(unwrappedExpression.consequent) ||
      containsOptionalCallExpression(unwrappedExpression.alternate)
    );
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return (
      containsOptionalCallExpression(unwrappedExpression.left) ||
      containsOptionalCallExpression(unwrappedExpression.right)
    );
  }

  return false;
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

export function assertSupportedCssPropLoweringMode(
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
  const staticShapeDiagnosticMessage =
    classification === "unsupported-dynamic-css-rule"
      ? createUnsupportedStaticCssShapeDiagnosticMessage(partialEvalResult)
      : null;

  if (staticShapeDiagnosticMessage) {
    throw path.buildCodeFrameError(staticShapeDiagnosticMessage);
  }

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

      const staticShapeDiagnosticMessage =
        createUnsupportedStaticCssShapeDiagnosticMessage(partialEvalResult);

      if (staticShapeDiagnosticMessage) {
        throw path.buildCodeFrameError(staticShapeDiagnosticMessage);
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

    const staticShapeDiagnosticMessage =
      createUnsupportedStaticCssShapeDiagnosticMessage(partialEvalResult);

    if (staticShapeDiagnosticMessage) {
      throw path.buildCodeFrameError(staticShapeDiagnosticMessage);
    }

    registerStaticCssEvalResultMetadata(state, staticCssEvalResult);

    if (
      partialEvalDiagnostic &&
      partialEvalResult.deoptReasons[0] !== "unsupported-call-expression"
    ) {
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

    throw path.buildCodeFrameError(complexConditionStaticCssShapeErrorMessage);
  }

  if (
    containsUnsupportedDynamicCssVariableRuleBranch({
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

function createUnsupportedStaticCssShapeDiagnosticMessage(
  result: CssPropPartialEvalPolicyResult
): string | null {
  const expression = unwrapTransparentCssRuleExpression(result.rawExpression);
  const hasStaticShapeDeopt = result.deoptReasons.some(
    isStaticCssShapeDiagnosticReason
  );

  const hasUnsupportedBranchShape =
    containsUnsupportedStaticCssShapeBranch(expression);

  const hasUnsupportedShapeSpread =
    result.deoptReasons.length > 0 &&
    containsUnsupportedStaticCssShapeSpread(expression);

  if (
    !hasStaticShapeDeopt &&
    !hasUnsupportedBranchShape &&
    !hasUnsupportedShapeSpread
  ) {
    return null;
  }

  if (hasUnsupportedBranchShape) {
    return complexConditionStaticCssShapeErrorMessage;
  }

  if (
    !result.deoptReasons.includes("unsupported-spread") &&
    !hasUnsupportedShapeSpread
  ) {
    return null;
  }

  return shouldSuggestReactStyleForStaticCssShape(expression)
    ? `${staticCssShapeErrorMessage}. ${staticCssShapeReactStyleGuidance}`
    : staticCssShapeErrorMessage;
}

function isStaticCssShapeDiagnosticReason(
  reason: PartialEvalDeoptReason
): boolean {
  return reason === "non-static-object-key" || reason === "unsupported-spread";
}

function containsUnsupportedStaticCssShapeSpread(
  expression: t.Expression
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isObjectExpression(unwrappedExpression)) {
    return unwrappedExpression.properties.some((property) => {
      if (t.isSpreadElement(property)) {
        return true;
      }

      return (
        t.isObjectProperty(property) &&
        t.isExpression(property.value) &&
        containsUnsupportedStaticCssShapeSpread(property.value)
      );
    });
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return unwrappedExpression.elements.some((element) => {
      if (!element) {
        return false;
      }

      return t.isSpreadElement(element)
        ? true
        : containsUnsupportedStaticCssShapeSpread(element);
    });
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return (
      containsUnsupportedStaticCssShapeSpread(unwrappedExpression.consequent) ||
      containsUnsupportedStaticCssShapeSpread(unwrappedExpression.alternate)
    );
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return containsUnsupportedStaticCssShapeSpread(unwrappedExpression.right);
  }

  return false;
}

function containsUnsupportedStaticCssShapeBranch(
  expression: t.Expression
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (containsUnsupportedSequenceCssRuleValue(unwrappedExpression)) {
    return false;
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return (
      isUnsupportedStaticCssShapeBranchExpression(
        unwrappedExpression.consequent
      ) ||
      isUnsupportedStaticCssShapeBranchExpression(unwrappedExpression.alternate)
    );
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return isUnsupportedStaticCssShapeBranchExpression(
      unwrappedExpression.right
    );
  }

  if (!t.isObjectExpression(unwrappedExpression)) {
    return false;
  }

  return unwrappedExpression.properties.some((property) => {
    return (
      t.isSpreadElement(property) &&
      containsUnsupportedStaticCssShapeBranch(property.argument)
    );
  });
}

function isUnsupportedStaticCssShapeBranchExpression(
  expression: t.Expression
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  return (
    !t.isFunctionExpression(unwrappedExpression) &&
    !t.isArrowFunctionExpression(unwrappedExpression) &&
    !isStaticCssRuleShapeExpression(unwrappedExpression)
  );
}

function isStaticCssRuleShapeExpression(expression: t.Expression): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isObjectExpression(unwrappedExpression)) {
    return unwrappedExpression.properties.every((property) => {
      return (
        t.isObjectProperty(property) &&
        !property.computed &&
        !property.shorthand &&
        !!getStaticObjectPropertyKeyName(property.key) &&
        t.isExpression(property.value) &&
        isStaticCssRuleNestedShapeExpression(property.value)
      );
    });
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return unwrappedExpression.elements.every((element) => {
      return (
        !!element &&
        !t.isSpreadElement(element) &&
        isStaticCssRuleNestedShapeExpression(element)
      );
    });
  }

  return false;
}

function isStaticCssRuleNestedShapeExpression(
  expression: t.Expression
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  return t.isObjectExpression(unwrappedExpression) ||
    t.isArrayExpression(unwrappedExpression)
    ? isStaticCssRuleShapeExpression(unwrappedExpression)
    : true;
}

function shouldSuggestReactStyleForStaticCssShape(
  expression: t.Expression
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  return (
    t.isObjectExpression(unwrappedExpression) &&
    unwrappedExpression.properties.some((property) =>
      t.isSpreadElement(property)
    ) &&
    unwrappedExpression.properties.every(isReactStyleCompatibleShapeProperty)
  );
}

function isReactStyleCompatibleShapeProperty(
  property: t.ObjectExpression["properties"][number]
): boolean {
  if (t.isSpreadElement(property)) {
    return isDirectRuntimeStyleSpreadArgument(property.argument);
  }

  if (
    !t.isObjectProperty(property) ||
    property.computed ||
    property.shorthand ||
    !t.isExpression(property.value)
  ) {
    return false;
  }

  const propertyName = getStaticObjectPropertyKeyName(property.key);

  return (
    !!propertyName &&
    !isNestedCssObjectKey(propertyName) &&
    !t.isObjectExpression(unwrapTransparentCssRuleExpression(property.value)) &&
    !t.isArrayExpression(unwrapTransparentCssRuleExpression(property.value))
  );
}

function isDirectRuntimeStyleSpreadArgument(expression: t.Expression): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  return (
    isDirectReferenceExpression(unwrappedExpression) ||
    t.isCallExpression(unwrappedExpression) ||
    t.isOptionalCallExpression(unwrappedExpression)
  );
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
      }) !== null || !isStaticCssRuleShapeExpression(expression)
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

function containsUnsupportedDynamicCssVariableRuleBranch(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): boolean {
  const expression = unwrapTransparentCssRuleExpression(options.expression);

  if (t.isConditionalExpression(expression)) {
    return (
      isUnsupportedDynamicCssVariableRuleBranchExpression({
        expression: expression.consequent,
        scope: options.scope
      }) ||
      isUnsupportedDynamicCssVariableRuleBranchExpression({
        expression: expression.alternate,
        scope: options.scope
      })
    );
  }

  if (t.isLogicalExpression(expression)) {
    return isUnsupportedDynamicCssVariableRuleBranchExpression({
      expression: expression.right,
      scope: options.scope
    });
  }

  return false;
}

function isUnsupportedDynamicCssVariableRuleBranchExpression(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): boolean {
  const expression = unwrapTransparentCssRuleExpression(options.expression);

  if (
    t.isConditionalExpression(expression) ||
    t.isLogicalExpression(expression)
  ) {
    return containsUnsupportedDynamicCssVariableRuleBranch(options);
  }

  if (!t.isObjectExpression(expression) && !t.isArrayExpression(expression)) {
    return false;
  }

  if (containsArraySpreadElement(expression)) {
    return false;
  }

  return (
    !isStaticCssShapeExpression(expression) &&
    getDynamicCssVariableRule({
      expression,
      scope: options.scope
    }) === null &&
    createDynamicCssVariableDeclarationBranchExpression({
      expression,
      scope: options.scope
    }) === null
  );
}

export function getStaticCssEvalOwnerFile(state: PluginState): string {
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
