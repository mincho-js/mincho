import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import type { PluginState, ProgramScope } from "./types.js";
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
const spreadAfterCssErrorMessage =
  "Mincho JSX css prop does not support spreads after css in compile-away mode";
const keyRefSpreadErrorMessage =
  "Mincho JSX css prop does not support key/ref on spread elements in compile-away mode";
const spreadAggregationContextErrorMessage =
  "Mincho JSX css prop spread aggregation only supports direct return or expression statement JSX in compile-away mode";
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
const unsupportedFirstLevelArrayBranchCssValueErrorMessage =
  "Mincho JSX css prop array branch extraction only supports first-level dynamic branches";
const duplicateCssErrorMessage = "Mincho JSX css prop must appear only once";
const duplicateClassNameErrorMessage =
  "Mincho JSX css prop cannot merge duplicate className attributes";
const classNameValueErrorMessage =
  "Mincho JSX css prop requires className to be a string literal or expression";
const directLogicalCssRuleScopes = new WeakSet<ProgramScope>();

type CssPropValueClassification =
  | "css-rule"
  | "branch-css-rule"
  | "class-value"
  | "unsupported-dynamic-css-rule"
  | "unsupported-array-spread"
  | "unsupported-first-level-array-branch"
  | "unsupported-function";

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
      const normalizedElement = normalizeOpeningElement(openingElementPath);

      if (!normalizedElement) {
        return;
      }

      const { cssAttribute, classNameAttribute } = normalizedElement;
      if (normalizedElement.hasSpreadBeforeCss) {
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

  if (!directLogicalCssRuleScopes.has(programScope)) {
    return;
  }

  path.scope.crawl();

  for (const statementPath of path.get("body")) {
    if (
      !statementPath.isImportDeclaration() ||
      statementPath.node.source.value !== cssModuleName ||
      !isUnusedCssModuleHelperImport(statementPath)
    ) {
      continue;
    }

    statementPath.remove();
  }
}

function isUnusedCssModuleHelperImport(
  path: NodePath<t.ImportDeclaration>
): boolean {
  return (
    path.node.specifiers.length > 0 &&
    path.node.specifiers.every((specifier) => {
      if (
        !t.isImportSpecifier(specifier) ||
        !t.isIdentifier(specifier.imported) ||
        (specifier.imported.name !== "css" && specifier.imported.name !== "cx")
      ) {
        return false;
      }

      const binding = path.scope.getBinding(specifier.local.name);
      return !binding || binding.referencePaths.length === 0;
    })
  );
}

function normalizeOpeningElement(
  openingElementPath: NodePath<t.JSXOpeningElement>
): {
  cssAttribute: t.JSXAttribute;
  cssExpression: t.Expression;
  cssValueClassification: CssPropValueClassification;
  classNameAttribute: t.JSXAttribute | null;
  attributesBeforeCss: Array<t.JSXAttribute | t.JSXSpreadAttribute>;
  attributesAfterCss: Array<t.JSXAttribute | t.JSXSpreadAttribute>;
  hasSpreadBeforeCss: boolean;
} | null {
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

  if (
    attributesAfterCss.some((attribute) => t.isJSXSpreadAttribute(attribute))
  ) {
    throw openingElementPath.buildCodeFrameError(spreadAfterCssErrorMessage);
  }

  if (hasSpreadBeforeCss && hasExplicitKeyOrRefAttribute(attributes)) {
    throw openingElementPath.buildCodeFrameError(keyRefSpreadErrorMessage);
  }

  if (hasSpreadBeforeCss) {
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

  const cssExpression = getCssExpression(openingElementPath, cssAttribute);
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

  if (cssValueClassification === "unsupported-first-level-array-branch") {
    throw openingElementPath.buildCodeFrameError(
      unsupportedFirstLevelArrayBranchCssValueErrorMessage
    );
  }

  return {
    cssAttribute,
    cssExpression,
    cssValueClassification,
    classNameAttribute: classNameAttributes[0] ?? null,
    attributesBeforeCss,
    attributesAfterCss,
    hasSpreadBeforeCss
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

function createClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  normalizedElement: {
    cssExpression: t.Expression;
    cssValueClassification: CssPropValueClassification;
    classNameAttribute: t.JSXAttribute | null;
    aggregateClassNameExpression?: t.Expression;
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

  if (isDirectLogicalCssRuleExpression(normalizedElement.cssExpression)) {
    directLogicalCssRuleScopes.add(
      path.scope.getProgramParent() as ProgramScope
    );
  }

  if (
    !normalizedElement.aggregateClassNameExpression &&
    !normalizedElement.classNameAttribute &&
    canEmitDirectly
  ) {
    return cssClassNameExpressions[0];
  }

  const cxIdentifier = registerImportMethod(path, "cx", cssModuleName);

  if (
    !normalizedElement.aggregateClassNameExpression &&
    !normalizedElement.classNameAttribute
  ) {
    return t.callExpression(cxIdentifier, cssClassNameExpressions);
  }

  const classNameExpressions = [];

  if (normalizedElement.aggregateClassNameExpression) {
    classNameExpressions.push(
      t.cloneNode(normalizedElement.aggregateClassNameExpression)
    );
  }

  if (normalizedElement.classNameAttribute) {
    classNameExpressions.push(
      getClassNameExpression(path, normalizedElement.classNameAttribute)
    );
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
    aggregateClassNameExpression?: t.Expression;
  }
): t.JSXAttribute["value"] {
  if (
    normalizedElement.cssValueClassification === "class-value" &&
    t.isStringLiteral(normalizedElement.cssExpression) &&
    !normalizedElement.aggregateClassNameExpression &&
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
  normalizedElement: {
    cssAttribute: t.JSXAttribute;
    cssExpression: t.Expression;
    cssValueClassification: CssPropValueClassification;
    classNameAttribute: t.JSXAttribute | null;
    attributesBeforeCss: Array<t.JSXAttribute | t.JSXSpreadAttribute>;
    attributesAfterCss: Array<t.JSXAttribute | t.JSXSpreadAttribute>;
  }
): void {
  const aggregateIdentifier = path.scope.generateUidIdentifier("minchoProps");
  const cssPropIdentifier = path.scope.generateUidIdentifier("minchoCssProp");
  const classNameIdentifier =
    path.scope.generateUidIdentifier("minchoClassName");
  const restIdentifier = path.scope.generateUidIdentifier("minchoRest");
  const statementPath = path.getStatementParent();

  if (!statementPath) {
    throw path.buildCodeFrameError(
      "Mincho JSX css prop could not find a statement for spread aggregation"
    );
  }

  statementPath.insertBefore([
    t.variableDeclaration("const", [
      t.variableDeclarator(
        t.cloneNode(aggregateIdentifier),
        createAggregatePropsExpression(
          path,
          normalizedElement.attributesBeforeCss
        )
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
  ]);

  const classNameAttributeAfterCss = normalizedElement.attributesAfterCss.find(
    (attribute) => isNamedJsxAttribute(attribute, classNameAttributeName)
  );
  const nextClassNameExpression = createClassNameExpression(path, {
    cssExpression: normalizedElement.cssExpression,
    cssValueClassification: normalizedElement.cssValueClassification,
    classNameAttribute: t.isJSXAttribute(classNameAttributeAfterCss)
      ? classNameAttributeAfterCss
      : null,
    aggregateClassNameExpression: t.cloneNode(classNameIdentifier)
  });
  const nextAttributes: Array<t.JSXAttribute | t.JSXSpreadAttribute> = [
    t.jsxSpreadAttribute(t.cloneNode(restIdentifier)),
    t.jsxAttribute(
      t.jsxIdentifier(classNameAttributeName),
      t.jsxExpressionContainer(nextClassNameExpression)
    ),
    ...normalizedElement.attributesAfterCss.filter(
      (attribute) => !isNamedJsxAttribute(attribute, classNameAttributeName)
    )
  ];

  path.node.attributes = nextAttributes;
}

function assertSupportedSpreadAggregationContext(
  path: NodePath<t.JSXOpeningElement>
): void {
  const jsxElementPath = path.parentPath;

  if (!jsxElementPath.isJSXElement()) {
    throw path.buildCodeFrameError(spreadAggregationContextErrorMessage);
  }

  const expressionParentPath = jsxElementPath.parentPath;

  if (
    expressionParentPath.isReturnStatement() &&
    expressionParentPath.node.argument === jsxElementPath.node
  ) {
    assertStatementListParent(path, expressionParentPath);
    return;
  }

  if (
    expressionParentPath.isExpressionStatement() &&
    expressionParentPath.node.expression === jsxElementPath.node
  ) {
    assertStatementListParent(path, expressionParentPath);
    return;
  }

  throw path.buildCodeFrameError(spreadAggregationContextErrorMessage);
}

function assertStatementListParent(
  sourcePath: NodePath<t.JSXOpeningElement>,
  statementPath: NodePath<t.Node>
): void {
  const statementParentPath = statementPath.parentPath;

  if (!statementParentPath) {
    throw sourcePath.buildCodeFrameError(spreadAggregationContextErrorMessage);
  }

  if (
    statementParentPath.isProgram() ||
    statementParentPath.isBlockStatement() ||
    statementParentPath.isSwitchCase()
  ) {
    return;
  }

  throw sourcePath.buildCodeFrameError(spreadAggregationContextErrorMessage);
}

function createAggregatePropsExpression(
  path: NodePath<t.JSXOpeningElement>,
  attributes: Array<t.JSXAttribute | t.JSXSpreadAttribute>
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
  const cssRuleExpression = unwrapTransparentCssRuleExpression(cssExpression);

  if (cssValueClassification === "css-rule") {
    return createCssRuleClassNameExpression(path, cssRuleExpression);
  }

  if (
    cssValueClassification === "branch-css-rule" &&
    t.isConditionalExpression(cssRuleExpression)
  ) {
    return createConditionalCssRuleClassNameExpression(path, cssRuleExpression);
  }

  if (
    cssValueClassification === "branch-css-rule" &&
    t.isLogicalExpression(cssRuleExpression)
  ) {
    return createLogicalCssRuleClassNameExpression(path, cssRuleExpression);
  }

  return t.cloneNode(cssExpression);
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
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isStringLiteral(unwrappedExpression)) {
    return createStaticStringExpression(unwrappedExpression);
  }

  if (isDirectCssRuleExpression(unwrappedExpression)) {
    return createCssRuleClassNameExpression(path, unwrappedExpression);
  }

  if (
    t.isConditionalExpression(unwrappedExpression) &&
    isConditionalCssRuleBranchExpression(unwrappedExpression)
  ) {
    return createConditionalCssRuleClassNameExpression(
      path,
      unwrappedExpression
    );
  }

  if (
    t.isLogicalExpression(unwrappedExpression) &&
    isLogicalCssRuleBranchExpression(unwrappedExpression)
  ) {
    return createLogicalCssRuleClassNameExpression(path, unwrappedExpression);
  }

  return t.cloneNode(expression);
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
    t.cloneNode(cssExpression.test),
    createConditionalBranchClassNameExpression(path, cssExpression.consequent),
    createConditionalBranchClassNameExpression(path, cssExpression.alternate)
  );
}

function createConditionalBranchClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  expression: t.Expression
): t.Expression {
  if (isDirectCssRuleExpression(expression)) {
    return createCssRuleClassNameExpression(path, expression);
  }

  return t.cloneNode(expression);
}

function createLogicalCssRuleClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  cssExpression: t.LogicalExpression
): t.Expression {
  if (
    isStaticLeftLogicalCssRuleOperator(cssExpression.operator) &&
    isDirectCssRuleExpression(cssExpression.left)
  ) {
    return createCssRuleClassNameExpression(path, cssExpression.left);
  }

  if (
    isStaticLeftLogicalCssRuleGuardOperator(cssExpression.operator) &&
    isDirectCssRuleExpression(cssExpression.left)
  ) {
    return createLogicalAndRightClassNameExpression(path, cssExpression.right);
  }

  return t.logicalExpression(
    cssExpression.operator,
    t.cloneNode(cssExpression.left),
    createCssRuleClassNameExpression(path, cssExpression.right)
  );
}

function createLogicalAndRightClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  expression: t.Expression
): t.Expression {
  if (isDirectCssRuleExpression(expression)) {
    return createCssRuleClassNameExpression(path, expression);
  }

  return t.cloneNode(expression);
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
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isObjectExpression(unwrappedExpression)) {
    return true;
  }

  return (
    t.isArrayExpression(unwrappedExpression) &&
    isDirectCssRuleArrayExpression(unwrappedExpression)
  );
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
): Extract<
  CssPropValueClassification,
  "unsupported-array-spread" | "unsupported-first-level-array-branch"
> | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (!t.isArrayExpression(unwrappedExpression)) {
    return null;
  }

  if (hasArraySpreadElement(unwrappedExpression)) {
    return "unsupported-array-spread";
  }

  if (hasUnsupportedNestedDynamicArray(unwrappedExpression)) {
    return "unsupported-first-level-array-branch";
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

function hasUnsupportedNestedDynamicArray(
  expression: t.ArrayExpression
): boolean {
  return expression.elements.some((element) => {
    if (!element || t.isSpreadElement(element)) {
      return false;
    }

    return containsUnsupportedNestedDynamicArray(element, true);
  });
}

function containsUnsupportedNestedDynamicArray(
  expression: t.Expression,
  isNestedArray: boolean
): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isArrayExpression(unwrappedExpression)) {
    if (isNestedArray && !isDirectCssRuleArrayExpression(unwrappedExpression)) {
      return true;
    }

    return hasUnsupportedNestedDynamicArray(unwrappedExpression);
  }

  if (t.isSequenceExpression(unwrappedExpression)) {
    return unwrappedExpression.expressions.some((sequenceExpression) =>
      containsUnsupportedNestedDynamicArray(sequenceExpression, isNestedArray)
    );
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return (
      containsUnsupportedNestedDynamicArray(
        unwrappedExpression.consequent,
        isNestedArray
      ) ||
      containsUnsupportedNestedDynamicArray(
        unwrappedExpression.alternate,
        isNestedArray
      )
    );
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return (
      containsUnsupportedNestedDynamicArray(
        unwrappedExpression.left,
        isNestedArray
      ) ||
      containsUnsupportedNestedDynamicArray(
        unwrappedExpression.right,
        isNestedArray
      )
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

function isLogicalCssRuleBranchExpression(expression: t.Expression): boolean {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (!t.isLogicalExpression(unwrappedExpression)) {
    return false;
  }

  const leftClassification = classifyLogicalCssRuleOperand(
    unwrappedExpression.left
  );
  const rightClassification = classifyLogicalCssRuleOperand(
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

function classifyLogicalCssRuleOperand(
  expression: t.Expression
): ConditionalCssRuleBranchClassification | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (isDirectCssRuleExpression(unwrappedExpression)) {
    return "css-rule";
  }

  if (
    t.isLogicalExpression(unwrappedExpression) ||
    isUnsupportedDynamicCssRuleValue(unwrappedExpression, true)
  ) {
    return null;
  }

  return "class-value";
}

function classifyConditionalCssRuleBranch(
  expression: t.Expression
): ConditionalCssRuleBranchClassification | null {
  if (isDirectCssRuleExpression(expression)) {
    return "css-rule";
  }

  if (
    t.isFunctionExpression(expression) ||
    t.isArrowFunctionExpression(expression) ||
    isUnsupportedDynamicCssRuleValue(expression, true)
  ) {
    return null;
  }

  return "class-value";
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

type TransparentCssRuleWrapperExpression = t.Expression & {
  expression: t.Expression;
};

function unwrapTransparentCssRuleExpression(
  expression: t.Expression
): t.Expression {
  let currentExpression = expression;

  while (isTransparentCssRuleWrapperExpression(currentExpression)) {
    currentExpression = currentExpression.expression;
  }

  return currentExpression;
}

function createStaticStringExpression(
  expression: t.StringLiteral
): t.StringLiteral {
  return t.cloneNode(expression);
}

function isTransparentCssRuleWrapperExpression(
  expression: t.Expression
): expression is TransparentCssRuleWrapperExpression {
  return (
    expression.type === "TSNonNullExpression" ||
    expression.type === "TSAsExpression" ||
    expression.type === "TSSatisfiesExpression" ||
    expression.type === "ParenthesizedExpression" ||
    expression.type === "TypeCastExpression" ||
    expression.type === "TSTypeAssertion"
  );
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
