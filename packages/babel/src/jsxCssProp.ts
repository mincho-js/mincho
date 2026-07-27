import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import {
  getStaticObjectPropertyName,
  preserveDirectBooleanReferenceValue
} from "./staticCssEval/ast.js";
import {
  createStaticCssEvalCandidate,
  getStaticCssEvalMemberReference,
  unwrapTransparentCssRuleExpression
} from "./staticCssEval/candidates.js";
import {
  createStaticCssLiteralExpression,
  findUnsupportedImportedStaticCssEvalReferenceDiagnostic,
  resolveImportedStaticCssEvalExpression
} from "./staticCssEval/importedModules.js";
import {
  createStaticCssEvalComputedMemberUnsupportedDiagnostic,
  createStaticCssEvalDynamicExpressionUnsupportedDiagnostic,
  createStaticCssEvalObjectSpreadUnsupportedDiagnostic
} from "./staticCssEval/diagnostics.js";
import {
  enforceStaticCssEvalLiteralNodeCount,
  enforceStaticCssEvalObjectArrayRecursionDepth
} from "./staticCssEval/limits.js";
import type {
  ResolutionDependency,
  StaticCssEvalCacheKey,
  StaticCssEvalDiagnostic,
  StaticCssEvalProvider
} from "./staticCssEval/types.js";
import {
  getStaticCssEvalConstBindingInitExpression,
  resolveSameFileStaticCssEvalExpression
} from "./staticCssEval/sameFile.js";
import type {
  MinchoStaticCssEvalMetadata,
  PluginState,
  ProgramScope
} from "./types.js";
import { registerImportMethod } from "./utils.js";

const cssAttributeName = "css";
const classNameAttributeName = "className";
const cssModuleName = "@mincho-js/css";

const fragmentTargetErrorMessage =
  "Mincho JSX css prop does not support fragments because fragments cannot receive className";
const namespacedTargetErrorMessage =
  "Mincho JSX css prop does not support namespaced JSX elements";
const unsupportedTargetErrorMessage =
  "Mincho JSX css prop only supports JSX identifiers and member expressions";
const keyRefSpreadErrorMessage =
  "Mincho JSX css prop does not support key/ref on spread elements in compile-away mode";
const spreadAggregationContextErrorMessage =
  "Mincho JSX css prop spread aggregation only supports statement-list JSX, replaceable expression JSX, JSX attribute values, or JSX children in compile-away mode";
const nestedAsyncGeneratorErrorMessage =
  "Mincho JSX css prop nested spread aggregation does not support await or yield expressions in compile-away mode";
const cssExpressionValueErrorMessage =
  "Mincho JSX css prop requires an expression value";
const cssValueErrorMessage =
  "Mincho JSX css prop expects a Mincho CSS object/expression";
const unsupportedFunctionCssValueErrorMessage =
  "Mincho JSX css prop does not support function values in compile-away mode";
const unsupportedDynamicCssRuleValueErrorMessage =
  "Mincho JSX css prop does not support conditional, logical, or wrapped object/array CSS rule values in compile-away mode";
const unsupportedArraySpreadCssValueErrorMessage =
  "Mincho JSX css prop array values do not support spread elements in compile-away mode";
const duplicateCssErrorMessage = "Mincho JSX css prop must appear only once";
const duplicateClassNameErrorMessage =
  "Mincho JSX css prop cannot merge duplicate className attributes";
const classNameValueErrorMessage =
  "Mincho JSX css prop requires className to be a string literal or expression";
const cssModuleHelperImportCleanupScopes = new WeakSet<ProgramScope>();

type CssPropValueClassification =
  | "css-rule"
  | "branch-css-rule"
  | "class-value"
  | "unsupported-dynamic-css-rule"
  | "unsupported-array-spread"
  | "unsupported-function";

type CssClassNameBaseLoweringRequest = {
  readonly path: NodePath<t.JSXOpeningElement>;
  readonly expression: t.Expression;
};

type AggregatePropsBinding = {
  readonly declarations: t.VariableDeclaration[];
  readonly classNameIdentifier: t.Identifier;
  readonly restIdentifier: t.Identifier;
};

type NormalizedJsxCssPropElement = {
  readonly cssAttribute: t.JSXAttribute;
  readonly cssExpression: t.Expression;
  readonly cssValueClassification: CssPropValueClassification;
  readonly classNameAttribute: t.JSXAttribute | null;
  readonly attributesBeforeCss: readonly (
    | t.JSXAttribute
    | t.JSXSpreadAttribute
  )[];
  readonly attributesAfterCss: readonly (
    | t.JSXAttribute
    | t.JSXSpreadAttribute
  )[];
  readonly hasSpreadBeforeCss: boolean;
  readonly hasSpreadAfterCss: boolean;
};

type SpreadAggregatedCssPropLowering = {
  readonly declarations: t.VariableDeclaration[];
  readonly attributes: Array<t.JSXAttribute | t.JSXSpreadAttribute>;
};

type CssClassNameRootResultLoweringRequest = CssClassNameBaseLoweringRequest & {
  readonly context: "root-result";
  readonly classification: CssPropValueClassification;
};

type CssClassNameBranchResultLoweringRequest =
  CssClassNameBaseLoweringRequest & {
    readonly context: "branch-result";
  };

type CssClassNameArrayElementResultLoweringRequest =
  CssClassNameBaseLoweringRequest & {
    readonly context: "array-element-result";
  };

type CssClassNameGuardLoweringRequest = CssClassNameBaseLoweringRequest & {
  readonly context: "guard";
};

type CssClassNameLoweringRequest =
  | CssClassNameRootResultLoweringRequest
  | CssClassNameBranchResultLoweringRequest
  | CssClassNameArrayElementResultLoweringRequest
  | CssClassNameGuardLoweringRequest;

type StaticCssEvalMetadataSource = {
  dependencies?: readonly (ResolutionDependency | string)[];
  diagnostics?: readonly StaticCssEvalDiagnostic[];
  diagnostic?: StaticCssEvalDiagnostic;
  cacheKey?: StaticCssEvalCacheKey;
};

type InlineStaticCssRuleLiteralResult =
  | { kind: "not-candidate" }
  | {
      kind: "resolved";
      expression: t.ObjectExpression | t.ArrayExpression;
      metadata: StaticCssEvalMetadataSource[];
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      metadata: StaticCssEvalMetadataSource[];
    };

type InlineStaticCssExpressionResult =
  | {
      kind: "resolved";
      expression: t.Expression;
      metadata: StaticCssEvalMetadataSource[];
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      metadata: StaticCssEvalMetadataSource[];
    };

type InlineStaticCssObjectExpressionResult =
  | {
      kind: "resolved";
      expression: t.ObjectExpression;
      metadata: StaticCssEvalMetadataSource[];
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      metadata: StaticCssEvalMetadataSource[];
    };

type InlineStaticCssArrayExpressionResult =
  | {
      kind: "resolved";
      expression: t.ArrayExpression;
      metadata: StaticCssEvalMetadataSource[];
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      metadata: StaticCssEvalMetadataSource[];
    };

interface InlineStaticCssEvaluationOptions {
  expression: t.Expression;
  ownerFile: string;
  programPath: NodePath<t.Program>;
  scope: NodePath<t.JSXOpeningElement>["scope"];
  provider?: StaticCssEvalProvider;
  metadata: StaticCssEvalMetadataSource[];
  localStack?: readonly InlineStaticCssLocalStackFrame[];
  state: InlineStaticCssEvaluationState;
  depth: number;
}

interface InlineStaticCssEvaluationState {
  count: number;
}

interface InlineStaticCssLocalStackFrame {
  readonly bindingName: string;
  readonly memberPath: readonly string[];
}

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

      const { cssAttribute, classNameAttribute } = normalizedElement;
      if (
        normalizedElement.hasSpreadBeforeCss ||
        normalizedElement.hasSpreadAfterCss
      ) {
        transformSpreadAggregatedCssProp(openingElementPath, normalizedElement);
        transformed = true;
        return;
      }

      const classNameValue = createClassNameAttributeValue(
        openingElementPath,
        normalizedElement
      );

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

  if (classNameAttributes.length > 1) {
    throw openingElementPath.buildCodeFrameError(
      duplicateClassNameErrorMessage
    );
  }

  const cssExpression = getResolvedCssExpression(
    openingElementPath,
    programPath,
    state,
    cssAttribute
  );
  const cssValueClassification = classifyCssPropValue(cssExpression);

  if (cssValueClassification === "unsupported-function") {
    throw openingElementPath.buildCodeFrameError(
      unsupportedFunctionCssValueErrorMessage
    );
  }

  if (cssValueClassification === "unsupported-dynamic-css-rule") {
    throw openingElementPath.buildCodeFrameError(
      unsupportedDynamicCssRuleValueErrorMessage
    );
  }

  if (cssValueClassification === "unsupported-array-spread") {
    throw openingElementPath.buildCodeFrameError(
      unsupportedArraySpreadCssValueErrorMessage
    );
  }

  return {
    cssAttribute,
    cssExpression,
    cssValueClassification,
    classNameAttribute: classNameAttributes[0] ?? null,
    attributesBeforeCss,
    attributesAfterCss,
    hasSpreadBeforeCss,
    hasSpreadAfterCss
  };
}

function getResolvedCssExpression(
  path: NodePath<t.JSXOpeningElement>,
  programPath: NodePath<t.Program>,
  state: PluginState,
  attribute: t.JSXAttribute
): t.Expression {
  const cssExpression = getCssExpression(path, attribute);
  const ownerFile = getStaticCssEvalOwnerFile(state);
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
    throw path.buildCodeFrameError(staticCssEvalResult.diagnostic.message);
  }

  if (staticCssEvalResult.kind === "resolved") {
    registerStaticCssEvalResultMetadata(state, staticCssEvalResult);
    return preserveDirectBooleanReferenceValues(
      cssExpression,
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

  return resolvedCssExpression;
}

function getStaticCssEvalOwnerFile(state: PluginState): string {
  return state.file.opts.filename ?? "<unknown>";
}

function shouldResolveSameFileCssExpression(expression: t.Expression): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  return !(
    t.isArrayExpression(unwrappedExpression) &&
    !hasArraySpreadElement(unwrappedExpression) &&
    isArrayClassValueExpression(unwrappedExpression)
  );
}

function resolveDirectInlineStaticCssRuleLiteral(
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

function evaluateInlineStaticCssExpression(
  options: InlineStaticCssEvaluationOptions
): InlineStaticCssExpressionResult {
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

  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    options.expression
  );

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

function evaluateInlineStaticCssObjectExpression(
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
  | { kind: "resolved"; propertyName: string }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      metadata: StaticCssEvalMetadataSource[];
    } {
  const staticName = getStaticObjectPropertyName(options.property.key);

  if (!options.property.computed) {
    return staticName
      ? { kind: "resolved", propertyName: staticName }
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
    : { kind: "resolved", propertyName: String(propertyName) };
}

function evaluateInlineStaticCssArrayExpression(
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

function resolveProviderStaticCssExpression(
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

function resolveInlineSameFileStaticCssExpression(
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

function shouldPreserveUnsupportedArraySpreadClassification(
  expression: t.Expression
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  return (
    t.isArrayExpression(unwrappedExpression) &&
    hasArraySpreadElement(unwrappedExpression)
  );
}

function shouldPreserveUnsupportedDynamicCssRuleClassification(
  expression: t.Expression
): boolean {
  return containsUnsupportedSequenceCssRuleValue(expression);
}

function preserveDirectBooleanReferenceValues(
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

function normalizeResolvedCssRuleExpression(
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

function registerImportedStaticCssEvalProviderResultMetadata(options: {
  expression: t.Expression;
  ownerFile: string;
  state: PluginState;
}): void {
  const { staticCssEvalProvider } = options.state.opts;

  if (!staticCssEvalProvider) {
    return;
  }

  const candidate = createStaticCssEvalCandidate(
    options.expression,
    options.ownerFile
  );

  if (!candidate) {
    return;
  }

  registerStaticCssEvalResultMetadata(
    options.state,
    staticCssEvalProvider.getResolvedCssValue(candidate)
  );
}

function registerStaticCssEvalResultMetadata(
  state: PluginState,
  result: StaticCssEvalMetadataSource
): void {
  const dependencies = (result.dependencies ?? []).filter(
    isResolutionDependency
  );
  const diagnostics =
    result.diagnostics ?? (result.diagnostic ? [result.diagnostic] : []);
  const cacheKeys = result.cacheKey ? [result.cacheKey] : [];

  if (
    dependencies.length === 0 &&
    diagnostics.length === 0 &&
    cacheKeys.length === 0
  ) {
    return;
  }

  const metadata = getMinchoStaticCssEvalMetadata(state);
  appendUniqueMetadataItems(
    metadata.dependencies,
    dependencies,
    createResolutionDependencyMetadataKey
  );
  appendUniqueMetadataItems(
    metadata.diagnostics,
    diagnostics,
    createStaticCssEvalDiagnosticMetadataKey
  );
  appendUniqueMetadataItems(
    metadata.cacheKeys,
    cacheKeys,
    createStaticCssEvalCacheKeyMetadataKey
  );
  appendUniqueResolvedModuleIds(metadata, dependencies, cacheKeys);
}

function registerStaticCssEvalDiagnosticMetadata(
  state: PluginState,
  diagnostic: StaticCssEvalDiagnostic
): void {
  registerStaticCssEvalResultMetadata(state, { diagnostics: [diagnostic] });
}

function getMinchoStaticCssEvalMetadata(
  state: PluginState
): MinchoStaticCssEvalMetadata {
  const metadata = state.file.metadata.minchoStaticCssEval;

  if (metadata) {
    return metadata;
  }

  const nextMetadata: MinchoStaticCssEvalMetadata = {
    dependencies: [],
    diagnostics: [],
    cacheKeys: [],
    resolvedModuleIds: []
  };
  state.file.metadata.minchoStaticCssEval = nextMetadata;
  return nextMetadata;
}

function isResolutionDependency(
  dependency: ResolutionDependency | string
): dependency is ResolutionDependency {
  return typeof dependency === "object" && dependency !== null;
}

export function appendUniqueMetadataItems<T>(
  target: T[],
  items: readonly T[],
  createKey: (item: T) => string
): void {
  const existingKeys = new Set(target.map(createKey));

  for (const item of items) {
    const key = createKey(item);

    if (existingKeys.has(key)) {
      continue;
    }

    existingKeys.add(key);
    target.push(item);
  }
}

export function appendUniqueResolvedModuleIds(
  metadata: MinchoStaticCssEvalMetadata,
  dependencies: readonly ResolutionDependency[],
  cacheKeys: readonly StaticCssEvalCacheKey[]
): void {
  const moduleIds = [
    ...cacheKeys.flatMap((cacheKey) => cacheKey.resolvedId ?? []),
    ...dependencies.flatMap((dependency) =>
      isResolvedModuleDependency(dependency) ? [dependency.file] : []
    )
  ];

  appendUniqueMetadataItems(
    metadata.resolvedModuleIds,
    moduleIds,
    (moduleId) => moduleId
  );
}

function isResolvedModuleDependency(dependency: ResolutionDependency): boolean {
  return (
    dependency.kind !== "local" &&
    dependency.kind !== "unresolved" &&
    dependency.inspected &&
    dependency.file.length > 0
  );
}

export function createResolutionDependencyMetadataKey(
  dependency: ResolutionDependency
): string {
  return JSON.stringify([
    dependency.file,
    dependency.kind,
    dependency.importer,
    dependency.specifier,
    dependency.exportName,
    dependency.memberPath,
    dependency.inspected,
    dependency.contributed,
    dependency.sourceKind,
    dependency.sourceOrigin,
    dependency.canonicalModuleId,
    dependency.normalizedPathKey,
    dependency.watchFiles,
    dependency.unsupportedReason
  ]);
}

export function createStaticCssEvalDiagnosticMetadataKey(
  diagnostic: StaticCssEvalDiagnostic
): string {
  return JSON.stringify([
    diagnostic.id,
    diagnostic.code,
    diagnostic.reason,
    diagnostic.message,
    diagnostic.owner.file,
    diagnostic.owner.start,
    diagnostic.owner.end,
    diagnostic.dependency?.file,
    diagnostic.importPath,
    diagnostic.exportName,
    diagnostic.memberPath,
    diagnostic.importChain
  ]);
}

export function createStaticCssEvalCacheKeyMetadataKey(
  cacheKey: StaticCssEvalCacheKey
): string {
  return JSON.stringify([
    cacheKey.importerFile,
    cacheKey.resolvedFile,
    cacheKey.exportName,
    cacheKey.memberPath,
    cacheKey.sourceHash,
    cacheKey.sourceVersion,
    cacheKey.pluginOptionsVersion,
    cacheKey.resolverOptionsVersion,
    cacheKey.parserVersion,
    cacheKey.staticEvalSupportVersion,
    cacheKey.resolvedId,
    cacheKey.sourceKind,
    cacheKey.sourceOrigin,
    cacheKey.canonicalModuleId,
    cacheKey.normalizedPathKey,
    cacheKey.watchFiles,
    cacheKey.unsupportedReason,
    cacheKey.parserOptions,
    cacheKey.projectLocalBoundary
  ]);
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

function createClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  normalizedElement: {
    cssExpression: t.Expression;
    cssValueClassification: CssPropValueClassification;
    classNameAttribute: t.JSXAttribute | null;
    preAggregateClassNameExpression?: t.Expression;
    postAggregateClassNameExpression?: t.Expression;
  }
): t.Expression {
  const cssClassNameExpressions = createCssClassNameExpressions(
    path,
    normalizedElement.cssExpression,
    normalizedElement.cssValueClassification
  );
  const canEmitDirectly = canEmitCssClassNameDirectly(
    normalizedElement.cssExpression,
    normalizedElement.cssValueClassification
  );

  if (
    shouldCleanupCssModuleHelperImports(
      normalizedElement.cssExpression,
      normalizedElement.cssValueClassification
    )
  ) {
    cssModuleHelperImportCleanupScopes.add(
      path.scope.getProgramParent() as ProgramScope
    );
  }

  if (
    !normalizedElement.preAggregateClassNameExpression &&
    !normalizedElement.postAggregateClassNameExpression &&
    !normalizedElement.classNameAttribute &&
    canEmitDirectly
  ) {
    return cssClassNameExpressions[0];
  }

  const cxIdentifier = registerImportMethod(path, "cx", cssModuleName);

  if (
    !normalizedElement.preAggregateClassNameExpression &&
    !normalizedElement.postAggregateClassNameExpression &&
    !normalizedElement.classNameAttribute
  ) {
    return t.callExpression(cxIdentifier, cssClassNameExpressions);
  }

  const classNameExpressions = [];

  if (normalizedElement.preAggregateClassNameExpression) {
    classNameExpressions.push(
      t.cloneNode(normalizedElement.preAggregateClassNameExpression)
    );
  }

  if (normalizedElement.classNameAttribute) {
    classNameExpressions.push(
      getClassNameExpression(path, normalizedElement.classNameAttribute)
    );
  }

  if (normalizedElement.postAggregateClassNameExpression) {
    return t.callExpression(cxIdentifier, [
      ...classNameExpressions,
      ...cssClassNameExpressions,
      t.cloneNode(normalizedElement.postAggregateClassNameExpression)
    ]);
  }

  return t.callExpression(cxIdentifier, [
    ...classNameExpressions,
    ...cssClassNameExpressions
  ]);
}

function createClassNameAttributeValue(
  path: NodePath<t.JSXOpeningElement>,
  normalizedElement: {
    cssExpression: t.Expression;
    cssValueClassification: CssPropValueClassification;
    classNameAttribute: t.JSXAttribute | null;
    preAggregateClassNameExpression?: t.Expression;
    postAggregateClassNameExpression?: t.Expression;
  }
): t.JSXAttribute["value"] {
  if (
    normalizedElement.cssValueClassification === "class-value" &&
    t.isStringLiteral(normalizedElement.cssExpression) &&
    !normalizedElement.preAggregateClassNameExpression &&
    !normalizedElement.postAggregateClassNameExpression &&
    !normalizedElement.classNameAttribute
  ) {
    return createStaticStringExpression(normalizedElement.cssExpression);
  }

  return t.jsxExpressionContainer(
    createClassNameExpression(path, normalizedElement)
  );
}

function transformSpreadAggregatedCssProp(
  path: NodePath<t.JSXOpeningElement>,
  normalizedElement: NormalizedJsxCssPropElement
): void {
  const statementPath = getDirectSpreadAggregationStatementPath(path);

  if (!statementPath) {
    transformNestedSpreadAggregatedCssProp(path, normalizedElement);
    return;
  }

  const lowering = createSpreadAggregatedCssPropLowering(
    path,
    normalizedElement
  );
  statementPath.insertBefore(lowering.declarations);
  path.node.attributes = lowering.attributes;
}

function transformNestedSpreadAggregatedCssProp(
  path: NodePath<t.JSXOpeningElement>,
  normalizedElement: NormalizedJsxCssPropElement
): void {
  const jsxElementPath = getSpreadAggregationJsxElementPath(path);

  if (
    !jsxElementPath ||
    !canReplaceJsxElementWithCallExpression(jsxElementPath)
  ) {
    throw path.buildCodeFrameError(spreadAggregationContextErrorMessage);
  }

  assertNestedSpreadAggregationIifeCompatible(jsxElementPath, path);

  const lowering = createSpreadAggregatedCssPropLowering(
    path,
    normalizedElement
  );
  const nextElement = t.cloneNode(jsxElementPath.node);
  nextElement.openingElement.attributes = lowering.attributes;
  const iifeExpression = t.callExpression(
    t.arrowFunctionExpression(
      [],
      t.blockStatement([
        ...lowering.declarations,
        t.returnStatement(nextElement)
      ])
    ),
    []
  );
  const replacement = isJsxChildReplacementContext(jsxElementPath)
    ? t.jsxExpressionContainer(iifeExpression)
    : iifeExpression;

  jsxElementPath.replaceWith(replacement);
}

function assertNestedSpreadAggregationIifeCompatible(
  jsxElementPath: NodePath<t.JSXElement>,
  diagnosticPath: NodePath<t.JSXOpeningElement>
): void {
  if (containsAwaitOrYieldExpression(jsxElementPath)) {
    throw diagnosticPath.buildCodeFrameError(nestedAsyncGeneratorErrorMessage);
  }
}

function containsAwaitOrYieldExpression(path: NodePath<t.Node>): boolean {
  let hasControlFlowExpression = false;

  path.traverse({
    AwaitExpression(awaitPath) {
      hasControlFlowExpression = true;
      awaitPath.stop();
    },
    YieldExpression(yieldPath) {
      hasControlFlowExpression = true;
      yieldPath.stop();
    },
    Function(functionPath) {
      functionPath.skip();
    }
  });

  return hasControlFlowExpression;
}

function createSpreadAggregatedCssPropLowering(
  path: NodePath<t.JSXOpeningElement>,
  normalizedElement: NormalizedJsxCssPropElement
): SpreadAggregatedCssPropLowering {
  if (!normalizedElement.hasSpreadAfterCss) {
    return createPreCssSpreadAggregatedCssPropLowering(path, normalizedElement);
  }

  return createPostCssSpreadAggregatedCssPropLowering(path, normalizedElement);
}

function createPreCssSpreadAggregatedCssPropLowering(
  path: NodePath<t.JSXOpeningElement>,
  normalizedElement: NormalizedJsxCssPropElement
): SpreadAggregatedCssPropLowering {
  const preCssBinding = createAggregatePropsBinding(
    path,
    normalizedElement.attributesBeforeCss,
    "mincho"
  );

  const classNameAttributeAfterCss = normalizedElement.attributesAfterCss.find(
    (attribute) => isNamedJsxAttribute(attribute, classNameAttributeName)
  );
  const nextClassNameExpression = createClassNameExpression(path, {
    cssExpression: normalizedElement.cssExpression,
    cssValueClassification: normalizedElement.cssValueClassification,
    classNameAttribute: t.isJSXAttribute(classNameAttributeAfterCss)
      ? classNameAttributeAfterCss
      : null,
    preAggregateClassNameExpression: t.cloneNode(
      preCssBinding.classNameIdentifier
    )
  });
  const classNameAttribute = t.jsxAttribute(
    t.jsxIdentifier(classNameAttributeName),
    t.jsxExpressionContainer(nextClassNameExpression)
  );

  return {
    declarations: preCssBinding.declarations,
    attributes: [
      t.jsxSpreadAttribute(t.cloneNode(preCssBinding.restIdentifier)),
      classNameAttribute,
      ...normalizedElement.attributesAfterCss.filter(
        (attribute) => !isNamedJsxAttribute(attribute, classNameAttributeName)
      )
    ]
  };
}

function createPostCssSpreadAggregatedCssPropLowering(
  path: NodePath<t.JSXOpeningElement>,
  normalizedElement: NormalizedJsxCssPropElement
): SpreadAggregatedCssPropLowering {
  const preCssBinding =
    normalizedElement.attributesBeforeCss.length > 0
      ? createAggregatePropsBinding(
          path,
          normalizedElement.attributesBeforeCss,
          "minchoPre"
        )
      : null;
  const postCssBinding = createAggregatePropsBinding(
    path,
    normalizedElement.attributesAfterCss,
    preCssBinding ? "minchoPost" : "mincho"
  );
  const canInlineExplicitCssClassName =
    t.isIdentifier(normalizedElement.cssExpression) ||
    t.isStringLiteral(normalizedElement.cssExpression);
  const explicitCssClassNameIdentifier = canInlineExplicitCssClassName
    ? null
    : path.scope.generateUidIdentifier("minchoCssClassName");
  const explicitCssClassNameDeclarations = explicitCssClassNameIdentifier
    ? [
        t.variableDeclaration("const", [
          t.variableDeclarator(
            t.cloneNode(explicitCssClassNameIdentifier),
            createClassNameExpression(path, {
              cssExpression: normalizedElement.cssExpression,
              cssValueClassification: normalizedElement.cssValueClassification,
              classNameAttribute: null
            })
          )
        ])
      ]
    : [];

  const nextClassNameExpression = createClassNameExpression(path, {
    cssExpression: explicitCssClassNameIdentifier
      ? t.cloneNode(explicitCssClassNameIdentifier)
      : normalizedElement.cssExpression,
    cssValueClassification: explicitCssClassNameIdentifier
      ? "class-value"
      : normalizedElement.cssValueClassification,
    classNameAttribute: null,
    ...(preCssBinding
      ? {
          preAggregateClassNameExpression: t.cloneNode(
            preCssBinding.classNameIdentifier
          )
        }
      : {}),
    postAggregateClassNameExpression: t.cloneNode(
      postCssBinding.classNameIdentifier
    )
  });
  const classNameAttribute = t.jsxAttribute(
    t.jsxIdentifier(classNameAttributeName),
    t.jsxExpressionContainer(nextClassNameExpression)
  );

  const nextAttributes: Array<t.JSXAttribute | t.JSXSpreadAttribute> = [
    ...(preCssBinding
      ? [t.jsxSpreadAttribute(t.cloneNode(preCssBinding.restIdentifier))]
      : []),
    t.jsxSpreadAttribute(t.cloneNode(postCssBinding.restIdentifier)),
    classNameAttribute
  ];

  return {
    declarations: [
      ...(preCssBinding?.declarations ?? []),
      ...explicitCssClassNameDeclarations,
      ...postCssBinding.declarations
    ],
    attributes: nextAttributes
  };
}

function createAggregatePropsBinding(
  path: NodePath<t.JSXOpeningElement>,
  attributes: readonly (t.JSXAttribute | t.JSXSpreadAttribute)[],
  uidPrefix: string
): AggregatePropsBinding {
  const aggregateIdentifier = path.scope.generateUidIdentifier(
    `${uidPrefix}Props`
  );
  const cssPropIdentifier = path.scope.generateUidIdentifier(
    `${uidPrefix}CssProp`
  );
  const classNameIdentifier = path.scope.generateUidIdentifier(
    `${uidPrefix}ClassName`
  );
  const restIdentifier = path.scope.generateUidIdentifier(`${uidPrefix}Rest`);

  return {
    declarations: [
      t.variableDeclaration("const", [
        t.variableDeclarator(
          t.cloneNode(aggregateIdentifier),
          createAggregatePropsExpression(path, attributes)
        )
      ]),
      t.variableDeclaration("const", [
        t.variableDeclarator(
          t.objectPattern([
            t.objectProperty(
              t.identifier(cssAttributeName),
              t.cloneNode(cssPropIdentifier)
            ),
            t.objectProperty(
              t.identifier(classNameAttributeName),
              t.cloneNode(classNameIdentifier)
            ),
            t.restElement(t.cloneNode(restIdentifier))
          ]),
          t.cloneNode(aggregateIdentifier)
        )
      ])
    ],
    classNameIdentifier,
    restIdentifier
  };
}

function assertSupportedSpreadAggregationContext(
  path: NodePath<t.JSXOpeningElement>
): void {
  if (
    getDirectSpreadAggregationStatementPath(path) ||
    isNestedSpreadAggregationExpressionContext(path)
  ) {
    return;
  }

  throw path.buildCodeFrameError(spreadAggregationContextErrorMessage);
}

function getDirectSpreadAggregationStatementPath(
  path: NodePath<t.JSXOpeningElement>
): NodePath<t.ReturnStatement | t.ExpressionStatement> | null {
  const jsxElementPath = getSpreadAggregationJsxElementPath(path);

  if (!jsxElementPath) {
    return null;
  }

  const expressionParentPath = jsxElementPath.parentPath;

  if (
    expressionParentPath.isReturnStatement() &&
    expressionParentPath.node.argument === jsxElementPath.node &&
    hasStatementListParent(expressionParentPath)
  ) {
    return expressionParentPath;
  }

  if (
    expressionParentPath.isExpressionStatement() &&
    expressionParentPath.node.expression === jsxElementPath.node &&
    hasStatementListParent(expressionParentPath)
  ) {
    return expressionParentPath;
  }

  return null;
}

function isNestedSpreadAggregationExpressionContext(
  path: NodePath<t.JSXOpeningElement>
): boolean {
  const jsxElementPath = getSpreadAggregationJsxElementPath(path);

  if (!jsxElementPath) {
    return false;
  }

  return canReplaceJsxElementWithCallExpression(jsxElementPath);
}

function getSpreadAggregationJsxElementPath(
  path: NodePath<t.JSXOpeningElement>
): NodePath<t.JSXElement> | null {
  const jsxElementPath = path.parentPath;

  if (!jsxElementPath.isJSXElement()) {
    return null;
  }

  return jsxElementPath;
}

function canReplaceJsxElementWithCallExpression(
  jsxElementPath: NodePath<t.JSXElement>
): boolean {
  const expressionParentPath = jsxElementPath.parentPath;

  if (isJsxChildReplacementContext(jsxElementPath)) {
    return true;
  }

  if (expressionParentPath.isJSXExpressionContainer()) {
    return true;
  }

  return true;
}

function isJsxChildReplacementContext(
  jsxElementPath: NodePath<t.JSXElement>
): boolean {
  const expressionParentPath = jsxElementPath.parentPath;

  return (
    expressionParentPath.isJSXElement() || expressionParentPath.isJSXFragment()
  );
}

function hasStatementListParent(statementPath: NodePath<t.Node>): boolean {
  const statementParentPath = statementPath.parentPath;

  return !!(
    statementParentPath &&
    (statementParentPath.isProgram() ||
      statementParentPath.isBlockStatement() ||
      statementParentPath.isSwitchCase())
  );
}

function createAggregatePropsExpression(
  path: NodePath<t.JSXOpeningElement>,
  attributes: readonly (t.JSXAttribute | t.JSXSpreadAttribute)[]
): t.ObjectExpression {
  return t.objectExpression(
    attributes.map((attribute) => {
      if (t.isJSXSpreadAttribute(attribute)) {
        return t.spreadElement(t.cloneNode(attribute.argument));
      }

      return createAggregateObjectProperty(path, attribute);
    })
  );
}

function createAggregateObjectProperty(
  path: NodePath<t.JSXOpeningElement>,
  attribute: t.JSXAttribute
): t.ObjectProperty {
  return t.objectProperty(
    createObjectPropertyKey(attribute.name),
    getAggregateAttributeValue(path, attribute)
  );
}

function createObjectPropertyKey(
  name: t.JSXAttribute["name"]
): t.Identifier | t.StringLiteral {
  if (t.isJSXNamespacedName(name)) {
    return t.stringLiteral(`${name.namespace.name}:${name.name.name}`);
  }

  if (t.isValidIdentifier(name.name)) {
    return t.identifier(name.name);
  }

  return t.stringLiteral(name.name);
}

function getAggregateAttributeValue(
  path: NodePath<t.JSXOpeningElement>,
  attribute: t.JSXAttribute
): t.Expression {
  if (isNamedJsxAttribute(attribute, classNameAttributeName)) {
    return getClassNameExpression(path, attribute);
  }

  if (attribute.value === null) {
    return t.booleanLiteral(true);
  }

  if (t.isStringLiteral(attribute.value)) {
    return t.cloneNode(attribute.value);
  }

  if (t.isJSXExpressionContainer(attribute.value)) {
    const { expression } = attribute.value;

    if (t.isJSXEmptyExpression(expression)) {
      throw path.buildCodeFrameError(classNameValueErrorMessage);
    }

    return t.cloneNode(expression);
  }

  if (t.isJSXElement(attribute.value) || t.isJSXFragment(attribute.value)) {
    return t.cloneNode(attribute.value);
  }

  throw path.buildCodeFrameError(classNameValueErrorMessage);
}

function createCssClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  cssExpression: t.Expression,
  cssValueClassification: CssPropValueClassification
): t.Expression {
  return lowerCssClassNameExpression({
    path,
    expression: cssExpression,
    classification: cssValueClassification,
    context: "root-result"
  });
}

function lowerCssClassNameExpression(
  request: CssClassNameLoweringRequest
): t.Expression {
  switch (request.context) {
    case "guard":
      return t.cloneNode(request.expression);
    case "root-result":
      return lowerRootCssResultClassNameExpression(request);
    case "branch-result":
      return lowerBranchCssResultClassNameExpression(request);
    case "array-element-result":
      return lowerArrayElementCssResultClassNameExpression(request);
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

function lowerRootCssResultClassNameExpression(
  request: CssClassNameRootResultLoweringRequest
): t.Expression {
  const cssRuleExpression = unwrapTransparentCssRuleExpression(
    request.expression
  );

  if (request.classification === "css-rule") {
    return createCssRuleClassNameExpression(request.path, cssRuleExpression);
  }

  if (
    request.classification === "branch-css-rule" &&
    t.isConditionalExpression(cssRuleExpression)
  ) {
    return createConditionalCssRuleClassNameExpression(
      request.path,
      cssRuleExpression
    );
  }

  if (
    request.classification === "branch-css-rule" &&
    t.isLogicalExpression(cssRuleExpression)
  ) {
    return createLogicalCssRuleClassNameExpression(
      request.path,
      cssRuleExpression
    );
  }

  return t.cloneNode(request.expression);
}

function createCssClassNameExpressions(
  path: NodePath<t.JSXOpeningElement>,
  cssExpression: t.Expression,
  cssValueClassification: CssPropValueClassification
): t.Expression[] {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(cssExpression);

  if (
    cssValueClassification === "class-value" &&
    isArrayClassValueExpression(unwrappedExpression)
  ) {
    return createArrayClassNameExpressions(path, unwrappedExpression);
  }

  return [
    createCssClassNameExpression(path, cssExpression, cssValueClassification)
  ];
}

function createArrayClassNameExpressions(
  path: NodePath<t.JSXOpeningElement>,
  expression: t.ArrayExpression
): t.Expression[] {
  return expression.elements.map((element) => {
    return createArrayClassNameExpression(path, element as t.Expression);
  });
}

function createArrayClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  expression: t.Expression
): t.Expression {
  return lowerCssClassNameExpression({
    path,
    expression,
    context: "array-element-result"
  });
}

function createArrayClassNameCallExpression(
  path: NodePath<t.JSXOpeningElement>,
  expression: t.ArrayExpression
): t.Expression {
  const cxIdentifier = registerImportMethod(path, "cx", cssModuleName);
  return t.callExpression(
    cxIdentifier,
    createArrayClassNameExpressions(path, expression)
  );
}

function lowerArrayElementCssResultClassNameExpression(
  request: CssClassNameArrayElementResultLoweringRequest
): t.Expression {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    request.expression
  );

  if (t.isStringLiteral(unwrappedExpression)) {
    return createStaticStringExpression(unwrappedExpression);
  }

  if (isDirectCssRuleLiteralExpression(unwrappedExpression)) {
    return createCssRuleClassNameExpression(request.path, unwrappedExpression);
  }

  if (isArrayClassValueExpression(unwrappedExpression)) {
    return createArrayClassNameCallExpression(
      request.path,
      unwrappedExpression
    );
  }

  if (
    t.isConditionalExpression(unwrappedExpression) &&
    (isConditionalCssRuleBranchExpression(unwrappedExpression) ||
      isConditionalArrayClassNameBranchExpression(unwrappedExpression))
  ) {
    return createConditionalCssRuleClassNameExpression(
      request.path,
      unwrappedExpression
    );
  }

  if (
    t.isLogicalExpression(unwrappedExpression) &&
    (isLogicalCssRuleBranchExpression(unwrappedExpression) ||
      isLogicalArrayClassNameBranchExpression(unwrappedExpression))
  ) {
    return createLogicalCssRuleClassNameExpression(
      request.path,
      unwrappedExpression
    );
  }

  return t.cloneNode(request.expression);
}

function lowerBranchCssResultClassNameExpression(
  request: CssClassNameBranchResultLoweringRequest
): t.Expression {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    request.expression
  );

  if (isDirectCssRuleExpression(unwrappedExpression)) {
    return createCssRuleClassNameExpression(request.path, unwrappedExpression);
  }

  if (isArrayClassValueExpression(unwrappedExpression)) {
    return createArrayClassNameCallExpression(
      request.path,
      unwrappedExpression
    );
  }

  if (
    t.isConditionalExpression(unwrappedExpression) &&
    (isConditionalCssRuleBranchExpression(unwrappedExpression) ||
      isConditionalArrayClassNameBranchExpression(unwrappedExpression))
  ) {
    return createConditionalCssRuleClassNameExpression(
      request.path,
      unwrappedExpression
    );
  }

  if (
    t.isLogicalExpression(unwrappedExpression) &&
    (isLogicalCssRuleBranchExpression(unwrappedExpression) ||
      isLogicalArrayClassNameBranchExpression(unwrappedExpression))
  ) {
    return createLogicalCssRuleClassNameExpression(
      request.path,
      unwrappedExpression
    );
  }

  return t.cloneNode(request.expression);
}

function createCssRuleClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  cssExpression: t.Expression
): t.Expression {
  const cssIdentifier = registerImportMethod(path, "css", cssModuleName);
  const cssRuleExpression = unwrapTransparentCssRuleExpression(cssExpression);
  return t.callExpression(cssIdentifier, [t.cloneNode(cssRuleExpression)]);
}

function createConditionalCssRuleClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  cssExpression: t.ConditionalExpression
): t.Expression {
  return t.conditionalExpression(
    lowerCssClassNameExpression({
      path,
      expression: cssExpression.test,
      context: "guard"
    }),
    createConditionalBranchClassNameExpression(path, cssExpression.consequent),
    createConditionalBranchClassNameExpression(path, cssExpression.alternate)
  );
}

function createConditionalBranchClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  expression: t.Expression
): t.Expression {
  return lowerCssClassNameExpression({
    path,
    expression,
    context: "branch-result"
  });
}

function createLogicalCssRuleClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  cssExpression: t.LogicalExpression
): t.Expression {
  if (
    isStaticLeftLogicalCssRuleOperator(cssExpression.operator) &&
    isDirectCssRuleExpression(cssExpression.left)
  ) {
    return lowerCssClassNameExpression({
      path,
      expression: cssExpression.left,
      context: "branch-result"
    });
  }

  if (
    isStaticLeftLogicalCssRuleGuardOperator(cssExpression.operator) &&
    isDirectCssRuleExpression(cssExpression.left)
  ) {
    return createLogicalAndRightClassNameExpression(path, cssExpression.right);
  }

  return t.logicalExpression(
    cssExpression.operator,
    lowerCssClassNameExpression({
      path,
      expression: cssExpression.left,
      context: "guard"
    }),
    lowerCssClassNameExpression({
      path,
      expression: cssExpression.right,
      context: "branch-result"
    })
  );
}

function createLogicalAndRightClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  expression: t.Expression
): t.Expression {
  return lowerCssClassNameExpression({
    path,
    expression,
    context: "branch-result"
  });
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

function classifyCssPropValue(
  expression: t.Expression
): CssPropValueClassification {
  const unsupportedArrayValueClassification =
    classifyUnsupportedCssPropArrayValue(expression);

  if (unsupportedArrayValueClassification) {
    return unsupportedArrayValueClassification;
  }

  if (containsUnsupportedSequenceCssRuleValue(expression)) {
    return "unsupported-dynamic-css-rule";
  }

  if (isDirectCssRuleExpression(expression)) {
    return "css-rule";
  }

  if (isConditionalCssRuleBranchExpression(expression)) {
    return "branch-css-rule";
  }

  if (isLogicalCssRuleBranchExpression(expression)) {
    return "branch-css-rule";
  }

  if (isUnsupportedDynamicCssRuleValue(expression)) {
    return "unsupported-dynamic-css-rule";
  }

  if (
    t.isFunctionExpression(expression) ||
    t.isArrowFunctionExpression(expression)
  ) {
    return "unsupported-function";
  }

  return "class-value";
}

function isDirectCssRuleExpression(expression: t.Expression): boolean {
  return (
    isDirectCssRuleLiteralExpression(expression) ||
    isTopLevelCssRuleCallExpression(expression)
  );
}

function isDirectCssRuleLiteralExpression(expression: t.Expression): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isObjectExpression(unwrappedExpression)) {
    return true;
  }

  return (
    t.isArrayExpression(unwrappedExpression) &&
    isDirectCssRuleArrayExpression(unwrappedExpression)
  );
}

function isTopLevelCssRuleCallExpression(expression: t.Expression): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  return (
    t.isCallExpression(unwrappedExpression) &&
    !isExplicitCxCallExpression(unwrappedExpression)
  );
}

function isExplicitCxCallExpression(expression: t.CallExpression): boolean {
  return t.isIdentifier(expression.callee) && expression.callee.name === "cx";
}

function isDirectCssRuleArrayExpression(
  expression: t.ArrayExpression
): boolean {
  let hasClassValueBranch = false;

  for (const element of expression.elements) {
    if (!element || t.isSpreadElement(element)) {
      return true;
    }

    const unwrappedElement = unwrapTransparentCssRuleExpression(element);

    if (t.isObjectExpression(unwrappedElement)) {
      continue;
    }

    if (t.isArrayExpression(unwrappedElement)) {
      if (!isDirectCssRuleArrayExpression(unwrappedElement)) {
        hasClassValueBranch = true;
      }

      continue;
    }

    if (t.isStringLiteral(unwrappedElement)) {
      continue;
    }

    if (!isFirstLevelArrayClassValueBranch(unwrappedElement)) {
      return true;
    }

    hasClassValueBranch = true;
  }

  return !hasClassValueBranch;
}

function isArrayClassValueExpression(
  expression: t.Expression
): expression is t.ArrayExpression {
  return (
    t.isArrayExpression(expression) &&
    !isDirectCssRuleArrayExpression(expression)
  );
}

function classifyUnsupportedCssPropArrayValue(
  expression: t.Expression
): Extract<CssPropValueClassification, "unsupported-array-spread"> | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (containsArraySpreadElement(unwrappedExpression)) {
    return "unsupported-array-spread";
  }

  return null;
}

function hasArraySpreadElement(expression: t.ArrayExpression): boolean {
  return expression.elements.some((element) => {
    if (!element) {
      return false;
    }

    if (t.isSpreadElement(element)) {
      return true;
    }

    return containsArraySpreadElement(element);
  });
}

function containsArraySpreadElement(expression: t.Expression): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isArrayExpression(unwrappedExpression)) {
    return hasArraySpreadElement(unwrappedExpression);
  }

  if (t.isSequenceExpression(unwrappedExpression)) {
    return unwrappedExpression.expressions.some((sequenceExpression) =>
      containsArraySpreadElement(sequenceExpression)
    );
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return (
      containsArraySpreadElement(unwrappedExpression.consequent) ||
      containsArraySpreadElement(unwrappedExpression.alternate)
    );
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return (
      containsArraySpreadElement(unwrappedExpression.left) ||
      containsArraySpreadElement(unwrappedExpression.right)
    );
  }

  return false;
}

function containsUnsupportedSequenceCssRuleValue(
  expression: t.Expression
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isSequenceExpression(unwrappedExpression)) {
    return unwrappedExpression.expressions.some((sequenceExpression) => {
      const sequenceValue =
        unwrapTransparentCssRuleExpression(sequenceExpression);

      return (
        t.isObjectExpression(sequenceValue) ||
        (t.isArrayExpression(sequenceValue) &&
          isDirectCssRuleArrayExpression(sequenceValue)) ||
        containsUnsupportedSequenceCssRuleValue(sequenceValue)
      );
    });
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return unwrappedExpression.elements.some((element) => {
      return (
        !!element &&
        !t.isSpreadElement(element) &&
        containsUnsupportedSequenceCssRuleValue(element)
      );
    });
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return (
      containsUnsupportedSequenceCssRuleValue(unwrappedExpression.consequent) ||
      containsUnsupportedSequenceCssRuleValue(unwrappedExpression.alternate)
    );
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return (
      containsUnsupportedSequenceCssRuleValue(unwrappedExpression.left) ||
      containsUnsupportedSequenceCssRuleValue(unwrappedExpression.right)
    );
  }

  return false;
}

function isFirstLevelArrayClassValueBranch(expression: t.Expression): boolean {
  return (
    t.isBooleanLiteral(expression) ||
    t.isNullLiteral(expression) ||
    t.isIdentifier(expression) ||
    t.isNumericLiteral(expression) ||
    t.isBigIntLiteral(expression) ||
    t.isTemplateLiteral(expression) ||
    t.isMemberExpression(expression) ||
    t.isOptionalMemberExpression(expression) ||
    t.isCallExpression(expression) ||
    t.isOptionalCallExpression(expression) ||
    t.isLogicalExpression(expression) ||
    t.isConditionalExpression(expression)
  );
}

type ConditionalCssRuleBranchClassification = "css-rule" | "class-value";
type ArrayClassNameBranchClassification =
  | ConditionalCssRuleBranchClassification
  | "array-class-value";

function isConditionalCssRuleBranchExpression(
  expression: t.Expression
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (!t.isConditionalExpression(unwrappedExpression)) {
    return false;
  }

  const consequentClassification = classifyConditionalCssRuleBranch(
    unwrappedExpression.consequent
  );
  const alternateClassification = classifyConditionalCssRuleBranch(
    unwrappedExpression.alternate
  );

  if (!consequentClassification || !alternateClassification) {
    return false;
  }

  return (
    consequentClassification === "css-rule" ||
    alternateClassification === "css-rule"
  );
}

function isConditionalArrayClassNameBranchExpression(
  expression: t.Expression
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (!t.isConditionalExpression(unwrappedExpression)) {
    return false;
  }

  const consequentClassification = classifyArrayClassNameBranch(
    unwrappedExpression.consequent
  );
  const alternateClassification = classifyArrayClassNameBranch(
    unwrappedExpression.alternate
  );

  if (!consequentClassification || !alternateClassification) {
    return false;
  }

  return (
    consequentClassification === "array-class-value" ||
    alternateClassification === "array-class-value"
  );
}

function isLogicalCssRuleBranchExpression(expression: t.Expression): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (!t.isLogicalExpression(unwrappedExpression)) {
    return false;
  }

  const leftClassification = classifyLogicalCssRuleLeftOperand(
    unwrappedExpression.left
  );
  const rightClassification = classifyLogicalCssRuleRightOperand(
    unwrappedExpression.right
  );

  if (!leftClassification || !rightClassification) {
    return false;
  }

  if (
    isStaticLeftLogicalCssRuleOperator(unwrappedExpression.operator) &&
    leftClassification === "css-rule"
  ) {
    return true;
  }

  if (
    isStaticLeftLogicalCssRuleGuardOperator(unwrappedExpression.operator) &&
    leftClassification === "css-rule"
  ) {
    return true;
  }

  return (
    isSupportedRightLogicalCssRuleOperator(unwrappedExpression.operator) &&
    leftClassification === "class-value" &&
    rightClassification === "css-rule"
  );
}

function isLogicalArrayClassNameBranchExpression(
  expression: t.Expression
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (!t.isLogicalExpression(unwrappedExpression)) {
    return false;
  }

  const leftClassification = classifyArrayClassNameLogicalLeftOperand(
    unwrappedExpression.left
  );
  const rightClassification = classifyArrayClassNameBranch(
    unwrappedExpression.right
  );

  if (!leftClassification || !rightClassification) {
    return false;
  }

  if (
    isStaticLeftLogicalCssRuleOperator(unwrappedExpression.operator) &&
    leftClassification === "css-rule"
  ) {
    return true;
  }

  if (
    isStaticLeftLogicalCssRuleGuardOperator(unwrappedExpression.operator) &&
    leftClassification === "css-rule"
  ) {
    return rightClassification === "array-class-value";
  }

  return (
    isSupportedRightLogicalCssRuleOperator(unwrappedExpression.operator) &&
    leftClassification === "class-value" &&
    rightClassification === "array-class-value"
  );
}

function isStaticLeftLogicalCssRuleOperator(
  operator: t.LogicalExpression["operator"]
): boolean {
  return operator === "||" || operator === "??";
}

function isStaticLeftLogicalCssRuleGuardOperator(
  operator: t.LogicalExpression["operator"]
): boolean {
  return operator === "&&";
}

function isSupportedRightLogicalCssRuleOperator(
  operator: t.LogicalExpression["operator"]
): boolean {
  return operator === "&&" || operator === "||" || operator === "??";
}

function classifyLogicalCssRuleLeftOperand(
  expression: t.Expression
): ConditionalCssRuleBranchClassification | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (isDirectCssRuleExpression(unwrappedExpression)) {
    return "css-rule";
  }

  if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
    return null;
  }

  return "class-value";
}

function classifyLogicalCssRuleRightOperand(
  expression: t.Expression
): ConditionalCssRuleBranchClassification | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (isDirectCssRuleExpression(unwrappedExpression)) {
    return "css-rule";
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    if (isConditionalCssRuleBranchExpression(unwrappedExpression)) {
      return "css-rule";
    }

    if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
      return null;
    }

    return "class-value";
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    if (isLogicalCssRuleBranchExpression(unwrappedExpression)) {
      return "css-rule";
    }

    if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
      return null;
    }

    return "class-value";
  }

  if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
    return null;
  }

  return "class-value";
}

function classifyArrayClassNameLogicalLeftOperand(
  expression: t.Expression
): ConditionalCssRuleBranchClassification | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (isDirectCssRuleExpression(unwrappedExpression)) {
    return "css-rule";
  }

  if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
    return null;
  }

  return "class-value";
}

function classifyArrayClassNameBranch(
  expression: t.Expression
): ArrayClassNameBranchClassification | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (isDirectCssRuleExpression(unwrappedExpression)) {
    return "css-rule";
  }

  if (isArrayClassValueExpression(unwrappedExpression)) {
    return "array-class-value";
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    if (isConditionalCssRuleBranchExpression(unwrappedExpression)) {
      return "css-rule";
    }

    if (isConditionalArrayClassNameBranchExpression(unwrappedExpression)) {
      return "array-class-value";
    }

    if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
      return null;
    }

    return "class-value";
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    if (isLogicalCssRuleBranchExpression(unwrappedExpression)) {
      return "css-rule";
    }

    if (isLogicalArrayClassNameBranchExpression(unwrappedExpression)) {
      return "array-class-value";
    }

    if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
      return null;
    }

    return "class-value";
  }

  if (
    t.isFunctionExpression(unwrappedExpression) ||
    t.isArrowFunctionExpression(unwrappedExpression) ||
    isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)
  ) {
    return null;
  }

  return "class-value";
}

function classifyConditionalCssRuleBranch(
  expression: t.Expression
): ConditionalCssRuleBranchClassification | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (isDirectCssRuleExpression(unwrappedExpression)) {
    return "css-rule";
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    if (isConditionalCssRuleBranchExpression(unwrappedExpression)) {
      return "css-rule";
    }

    if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
      return null;
    }

    return "class-value";
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    if (isLogicalCssRuleBranchExpression(unwrappedExpression)) {
      return "css-rule";
    }

    if (isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)) {
      return null;
    }

    return "class-value";
  }

  if (
    t.isFunctionExpression(unwrappedExpression) ||
    t.isArrowFunctionExpression(unwrappedExpression) ||
    isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)
  ) {
    return null;
  }

  return "class-value";
}

function shouldCleanupCssModuleHelperImports(
  expression: t.Expression,
  classification: CssPropValueClassification
): boolean {
  if (isDirectLogicalCssRuleExpression(expression)) {
    return true;
  }

  if (classification === "css-rule") {
    return isTopLevelCssRuleCallExpression(expression);
  }

  if (classification === "branch-css-rule") {
    return hasTopLevelCssRuleCallBranchExpression(expression);
  }

  return (
    classification === "class-value" &&
    hasTopLevelCssRuleCallArrayBranchExpression(expression)
  );
}

function hasTopLevelCssRuleCallBranchExpression(
  expression: t.Expression
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isConditionalExpression(unwrappedExpression)) {
    return (
      isTopLevelCssRuleCallExpression(unwrappedExpression.consequent) ||
      isTopLevelCssRuleCallExpression(unwrappedExpression.alternate)
    );
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return (
      isTopLevelCssRuleCallExpression(unwrappedExpression.left) ||
      isTopLevelCssRuleCallExpression(unwrappedExpression.right)
    );
  }

  return false;
}

function hasTopLevelCssRuleCallArrayBranchExpression(
  expression: t.Expression
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (!t.isArrayExpression(unwrappedExpression)) {
    return false;
  }

  return unwrappedExpression.elements.some((element) => {
    if (!element || t.isSpreadElement(element)) {
      return false;
    }

    return hasTopLevelCssRuleCallBranchExpression(element);
  });
}

function canEmitCssClassNameDirectly(
  expression: t.Expression,
  classification: CssPropValueClassification
): boolean {
  if (classification === "css-rule") {
    return true;
  }

  if (classification !== "branch-css-rule") {
    return false;
  }

  if (isPureConditionalCssRuleExpression(expression)) {
    return true;
  }

  return isDirectLogicalCssRuleExpression(expression);
}

function isDirectLogicalCssRuleExpression(expression: t.Expression): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (!t.isLogicalExpression(unwrappedExpression)) {
    return false;
  }

  if (isStaticLeftLogicalCssRuleOperator(unwrappedExpression.operator)) {
    return isDirectCssRuleExpression(unwrappedExpression.left);
  }

  return (
    isStaticLeftLogicalCssRuleGuardOperator(unwrappedExpression.operator) &&
    isDirectCssRuleExpression(unwrappedExpression.left) &&
    isDirectCssRuleExpression(unwrappedExpression.right)
  );
}

function isPureConditionalCssRuleExpression(expression: t.Expression): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  return (
    t.isConditionalExpression(unwrappedExpression) &&
    isDirectCssRuleExpression(unwrappedExpression.consequent) &&
    isDirectCssRuleExpression(unwrappedExpression.alternate)
  );
}

function isUnsupportedDynamicCssRuleValue(
  expression: t.Expression,
  isBranchExpression = false
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (
    t.isObjectExpression(unwrappedExpression) ||
    t.isArrayExpression(unwrappedExpression)
  ) {
    return (
      isBranchExpression ||
      (unwrappedExpression !== expression &&
        (!t.isArrayExpression(unwrappedExpression) ||
          isDirectCssRuleArrayExpression(unwrappedExpression)))
    );
  }

  if (t.isSequenceExpression(unwrappedExpression)) {
    return unwrappedExpression.expressions.some((sequenceExpression) =>
      isUnsupportedDynamicCssRuleValue(sequenceExpression, true)
    );
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return (
      isUnsupportedDynamicCssRuleValue(unwrappedExpression.consequent, true) ||
      isUnsupportedDynamicCssRuleValue(unwrappedExpression.alternate, true)
    );
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return (
      isUnsupportedDynamicCssRuleValue(unwrappedExpression.left, true) ||
      isUnsupportedDynamicCssRuleValue(unwrappedExpression.right, true)
    );
  }

  return false;
}

function createStaticStringExpression(
  expression: t.StringLiteral
): t.StringLiteral {
  return t.cloneNode(expression);
}

function getClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  attribute: t.JSXAttribute
): t.Expression {
  if (t.isStringLiteral(attribute.value)) {
    return t.cloneNode(attribute.value);
  }

  if (!t.isJSXExpressionContainer(attribute.value)) {
    throw path.buildCodeFrameError(classNameValueErrorMessage);
  }

  const { expression } = attribute.value;

  if (t.isJSXEmptyExpression(expression)) {
    throw path.buildCodeFrameError(classNameValueErrorMessage);
  }

  return t.cloneNode(expression);
}
