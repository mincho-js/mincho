import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import type { PluginState } from "./types.js";
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
const duplicateCssErrorMessage = "Mincho JSX css prop must appear only once";
const duplicateClassNameErrorMessage =
  "Mincho JSX css prop cannot merge duplicate className attributes";
const classNameValueErrorMessage =
  "Mincho JSX css prop requires className to be a string literal or expression";

type CssPropValueClassification =
  | "css-rule"
  | "class-value"
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

      const nextClassNameExpression = createClassNameExpression(
        openingElementPath,
        normalizedElement
      );

      const attributes = openingElementPath.node.attributes;
      const classNameValue = t.jsxExpressionContainer(nextClassNameExpression);

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
  const cssClassNameExpression = createCssClassNameExpression(
    path,
    normalizedElement.cssExpression,
    normalizedElement.cssValueClassification
  );

  if (
    !normalizedElement.aggregateClassNameExpression &&
    !normalizedElement.classNameAttribute &&
    normalizedElement.cssValueClassification === "css-rule"
  ) {
    return cssClassNameExpression;
  }

  const cxIdentifier = registerImportMethod(path, "cx", cssModuleName);

  if (
    !normalizedElement.aggregateClassNameExpression &&
    !normalizedElement.classNameAttribute
  ) {
    return t.callExpression(cxIdentifier, [cssClassNameExpression]);
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
    cssClassNameExpression
  ]);
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
  if (cssValueClassification === "css-rule") {
    const cssIdentifier = registerImportMethod(path, "css", cssModuleName);
    return t.callExpression(cssIdentifier, [t.cloneNode(cssExpression)]);
  }

  return t.cloneNode(cssExpression);
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
  if (t.isObjectExpression(expression)) {
    return "css-rule";
  }

  if (
    t.isFunctionExpression(expression) ||
    t.isArrowFunctionExpression(expression)
  ) {
    return "unsupported-function";
  }

  return "class-value";
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
