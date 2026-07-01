import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import { supportedJsxCssPropTags } from "./jsxCssPropTags.js";
import type { PluginState } from "./types.js";
import { registerImportMethod } from "./utils.js";

const cssAttributeName = "css";
const classNameAttributeName = "className";
const cssModuleName = "@mincho-js/css";

const intrinsicElementErrorMessage =
  "Mincho JSX css prop only supports intrinsic elements in v1";
const supportedTagErrorMessage =
  "Mincho JSX css prop only supports supported React DOM/SVG tags in v1";
const spreadErrorMessage =
  "Mincho JSX css prop does not support spreads on elements with css in v1";
const cssExpressionValueErrorMessage =
  "Mincho JSX css prop requires an expression value";
const cssValueErrorMessage =
  "Mincho JSX css prop expects a Mincho CSS object/expression";
const duplicateCssErrorMessage = "Mincho JSX css prop must appear only once";
const duplicateClassNameErrorMessage =
  "Mincho JSX css prop cannot merge duplicate className attributes";
const classNameValueErrorMessage =
  "Mincho JSX css prop requires className to be a string literal or expression";

export function preprocessJsxCssProp(
  path: NodePath<t.Program>,
  state: PluginState
): void {
  if (state.opts.jsxCssProp !== true) {
    return;
  }

  let transformed = false;

  path.traverse({
    JSXOpeningElement(openingElementPath) {
      const normalizedElement = normalizeOpeningElement(openingElementPath);

      if (!normalizedElement) {
        return;
      }

      const { cssAttribute, cssExpression, classNameAttribute } =
        normalizedElement;

      const cssIdentifier = registerImportMethod(
        openingElementPath,
        "css",
        cssModuleName
      );
      const cssClassNameExpression = t.callExpression(cssIdentifier, [
        t.cloneNode(cssExpression)
      ]);
      const nextClassNameExpression = createClassNameExpression(
        openingElementPath,
        classNameAttribute,
        cssClassNameExpression
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
}

function normalizeOpeningElement(
  openingElementPath: NodePath<t.JSXOpeningElement>
): {
  cssAttribute: t.JSXAttribute;
  cssExpression: t.Expression;
  classNameAttribute: t.JSXAttribute | null;
} | null {
  const { node: openingElement } = openingElementPath;
  const cssAttributes = getJsxAttributes(openingElement, cssAttributeName);

  if (cssAttributes.length === 0) {
    return null;
  }

  assertSupportedCssPropElement(openingElementPath);

  if (
    openingElement.attributes.some((attribute) =>
      t.isJSXSpreadAttribute(attribute)
    )
  ) {
    throw openingElementPath.buildCodeFrameError(spreadErrorMessage);
  }

  if (cssAttributes.length > 1) {
    throw openingElementPath.buildCodeFrameError(duplicateCssErrorMessage);
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

  const cssAttribute = cssAttributes[0];
  const cssExpression = getCssExpression(openingElementPath, cssAttribute);

  return {
    cssAttribute,
    cssExpression,
    classNameAttribute: classNameAttributes[0] ?? null
  };
}

function assertSupportedCssPropElement(
  openingElementPath: NodePath<t.JSXOpeningElement>
): void {
  const { name } = openingElementPath.node;

  if (!t.isJSXIdentifier(name)) {
    throw openingElementPath.buildCodeFrameError(intrinsicElementErrorMessage);
  }

  if (supportedJsxCssPropTags.has(name.name)) {
    return;
  }

  if (isCustomComponentTagName(name.name)) {
    throw openingElementPath.buildCodeFrameError(intrinsicElementErrorMessage);
  }

  throw openingElementPath.buildCodeFrameError(supportedTagErrorMessage);
}

function isCustomComponentTagName(tagName: string): boolean {
  return /^[A-Z]/.test(tagName);
}

function createClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  classNameAttribute: t.JSXAttribute | null,
  cssClassNameExpression: t.Expression
): t.Expression {
  if (!classNameAttribute) {
    return cssClassNameExpression;
  }

  const classNameExpression = getClassNameExpression(path, classNameAttribute);
  const cxIdentifier = registerImportMethod(path, "cx", cssModuleName);

  return t.callExpression(cxIdentifier, [
    classNameExpression,
    cssClassNameExpression
  ]);
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

  if (!t.isJSXExpressionContainer(attribute.value)) {
    throw path.buildCodeFrameError(cssValueErrorMessage);
  }

  const { expression } = attribute.value;

  if (t.isJSXEmptyExpression(expression)) {
    throw path.buildCodeFrameError(cssExpressionValueErrorMessage);
  }

  if (isUnsupportedCssExpression(expression)) {
    throw path.buildCodeFrameError(cssValueErrorMessage);
  }

  return expression;
}

function isUnsupportedCssExpression(expression: t.Expression): boolean {
  return (
    t.isTemplateLiteral(expression) ||
    t.isStringLiteral(expression) ||
    t.isNumericLiteral(expression) ||
    t.isBooleanLiteral(expression) ||
    t.isNullLiteral(expression) ||
    t.isFunctionExpression(expression) ||
    t.isArrowFunctionExpression(expression)
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
