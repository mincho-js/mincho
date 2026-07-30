import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import { unwrapTransparentCssRuleExpression } from "../staticCssEval/candidates.js";
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

  const unresolvedCssExpression = getCssExpression(
    openingElementPath,
    cssAttribute
  );
  const dynamicCssVariableRule = getDynamicCssVariableRule({
    expression: unresolvedCssExpression,
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

  const cssExpression = dynamicCssVariableRule
    ? dynamicCssVariableRule.expression
    : getResolvedCssExpression(
        openingElementPath,
        programPath,
        state,
        cssAttribute
      );
  const cssValueClassification = classifyCssPropValue(
    cssExpression,
    openingElementPath.scope
  );

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

  if (!isDirectMemberReferenceExpression(expression)) {
    return false;
  }

  const rootIdentifier = getDirectReferenceRootIdentifier(expression.object);

  return rootIdentifier
    ? !isImportedBindingIdentifier(options.scope, rootIdentifier)
    : true;
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

  if (
    containsDynamicCssVariableRuleBranch({
      expression: resolvedCssExpression,
      scope: path.scope
    })
  ) {
    throw path.buildCodeFrameError(unsupportedDynamicCssRuleValueErrorMessage);
  }

  if (
    isUnsupportedDynamicCssRuleCallExpression({
      expression: resolvedCssExpression,
      scope: path.scope
    })
  ) {
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
