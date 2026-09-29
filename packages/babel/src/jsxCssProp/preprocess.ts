import type { NodePath } from "@babel/core";
import { types as t } from "@babel/core";
import type { PluginState, ProgramScope } from "../types.js";
import { isInsideExtractCallsImplementation } from "../extractionCalls/index.js";
import {
  createClassNameAttributeValue,
  getDynamicCssVariableRuntimeLowering
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
  namespacedTargetErrorMessage,
  styleAttributeName,
  unsupportedTargetErrorMessage
} from "./constants.js";
import {
  assertSupportedCssPropLoweringMode,
  evaluateCssPropPartialEvalPolicy,
  getCssPropDynamicCssVariableRule,
  getCssPropShapeBranchExpression,
  getCssPropSidecarHoistabilityRoute,
  getStaticCssEvalOwnerFile,
  routeCssPropLowering,
  throwHardPartialEvalDeoptIfNeeded
} from "./cssPropEvaluation.js";
import {
  assertDynamicCssVariableStyleAttributeValue,
  createDynamicCssVariableClassNameAttributeValue,
  createDynamicCssVariableLowering,
  createDynamicCssVariableStyleAttributeValue
} from "./dynamicCssVariableCodegen.js";
import {
  assertSupportedSpreadAggregationContext,
  transformSpreadAggregatedCssProp
} from "./spreadAggregation.js";
import type {
  CssPropSidecarHoistability,
  NormalizedJsxCssPropElement
} from "./types.js";

const duplicateStyleErrorMessage =
  "Mincho JSX css prop cannot merge duplicate style attributes";

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
      if (isInsideExtractCallsImplementation(openingElementPath)) return;

      const analyzedElement = analyzeOpeningElement(
        openingElementPath,
        path,
        state
      );

      if (!analyzedElement) {
        return;
      }

      // Emit only after attribute validation and CSS evaluation have succeeded.
      const rule = analyzedElement.dynamicCssVariableRule;
      const hasSpread =
        analyzedElement.hasSpreadBeforeCss || analyzedElement.hasSpreadAfterCss;

      const normalizedElement: NormalizedJsxCssPropElement = {
        ...analyzedElement,
        dynamicCssVariableLowering: rule
          ? createDynamicCssVariableLowering({
              path: openingElementPath,
              rule,
              needsClassNameMerge:
                analyzedElement.classNameAttribute !== null ||
                hasSpread ||
                (rule.kind === "branch" &&
                  (analyzedElement.attributesBeforeCss.length > 0 ||
                    analyzedElement.attributesAfterCss.length > 0))
            })
          : null
      };

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
      if (
        programScope.minchoData.effectImports?.has(
          statementPath.node.source.value
        )
      )
        statementPath.node.specifiers = [];
      else statementPath.remove();

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

function analyzeOpeningElement(
  openingElementPath: NodePath<t.JSXOpeningElement>,
  programPath: NodePath<t.Program>,
  state: PluginState
): Omit<NormalizedJsxCssPropElement, "dynamicCssVariableLowering"> | null {
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

  const cssShapeBranchExpression = getCssPropShapeBranchExpression({
    partialEvalResult,
    scope: openingElementPath.scope
  });

  const dynamicCssVariableRule = getCssPropDynamicCssVariableRule({
    expression: cssShapeBranchExpression,
    partialEvalResult,
    scope: openingElementPath.scope
  });

  const sidecarHoistability = dynamicCssVariableRule
    ? ({ kind: "not-candidate" } satisfies CssPropSidecarHoistability)
    : getCssPropSidecarHoistabilityRoute({
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

  const route = routeCssPropLowering({
    cssShapeBranchExpression,
    dynamicCssVariableRule,
    openingElementPath,
    partialEvalResult,
    programPath,
    sidecarHoistability,
    state
  });

  assertSupportedCssPropLoweringMode(
    openingElementPath,
    state,
    route.cssLoweringMode,
    partialEvalResult
  );

  return {
    cssAttribute,
    cssExpression: route.cssExpression,
    cssValueClassification: route.cssValueClassification,
    cssLoweringMode: route.cssLoweringMode,
    dynamicCssVariableRule,
    classNameAttribute: classNameAttributes[0] ?? null,
    styleAttribute: styleAttributes[0] ?? null,
    attributesBeforeCss,
    attributesAfterCss,
    hasSpreadBeforeCss,
    hasSpreadAfterCss
  };
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

export { getDynamicCssVariableRule } from "./dynamicCssVariableAnalysis.js";
