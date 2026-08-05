import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import { invariant } from "../utils.js";
import {
  createClassNameExpression,
  getDynamicCssVariableRuntimeLowering,
  getClassNameExpression
} from "./classNameLowering.js";
import {
  classNameAttributeName,
  classNameValueErrorMessage,
  cssAttributeName,
  nestedAsyncGeneratorErrorMessage,
  spreadAggregationContextErrorMessage,
  styleAttributeName
} from "./constants.js";
import { getStyleExpression } from "./styleExpression.js";
import type {
  AggregatePropsBinding,
  NormalizedJsxCssPropElement,
  SpreadAggregatedCssPropLowering
} from "./types.js";

const keyAttributeName = "key";
const refAttributeName = "ref";
export function transformSpreadAggregatedCssProp(
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

export function transformNestedSpreadAggregatedCssProp(
  path: NodePath<t.JSXOpeningElement>,
  normalizedElement: NormalizedJsxCssPropElement
): void {
  const jsxElementPath = getSpreadAggregationJsxElementPath(path);

  if (!jsxElementPath) {
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

export function createSpreadAggregatedCssPropLowering(
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
  if (normalizedElement.dynamicCssVariableLowering) {
    return createDynamicCssVariableSpreadAggregatedCssPropLowering(
      path,
      normalizedElement
    );
  }

  const explicitKeyRefAttributesBeforeCss = getExplicitKeyRefAttributes(
    normalizedElement.attributesBeforeCss
  );
  const preCssBinding = createAggregatePropsBinding(
    path,
    getAggregateAttributes(normalizedElement.attributesBeforeCss),
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
      ...explicitKeyRefAttributesBeforeCss.beforeSpread,
      t.jsxSpreadAttribute(t.cloneNode(preCssBinding.restIdentifier)),
      ...explicitKeyRefAttributesBeforeCss.afterSpread,
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
  if (normalizedElement.dynamicCssVariableLowering) {
    return createDynamicCssVariableSpreadAggregatedCssPropLowering(
      path,
      normalizedElement
    );
  }

  const explicitKeyRefAttributesBeforeCss = getExplicitKeyRefAttributes(
    normalizedElement.attributesBeforeCss
  );
  const explicitKeyRefAttributesAfterCss = getExplicitKeyRefAttributes(
    normalizedElement.attributesAfterCss
  );
  const preCssBinding =
    normalizedElement.attributesBeforeCss.length > 0
      ? createAggregatePropsBinding(
          path,
          getAggregateAttributes(normalizedElement.attributesBeforeCss),
          "minchoPre"
        )
      : null;
  const postCssBinding = createAggregatePropsBinding(
    path,
    getAggregateAttributes(normalizedElement.attributesAfterCss),
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
    ...explicitKeyRefAttributesBeforeCss.beforeSpread,
    ...(preCssBinding
      ? [t.jsxSpreadAttribute(t.cloneNode(preCssBinding.restIdentifier))]
      : []),
    ...explicitKeyRefAttributesBeforeCss.afterSpread,
    ...explicitKeyRefAttributesAfterCss.beforeSpread,
    t.jsxSpreadAttribute(t.cloneNode(postCssBinding.restIdentifier)),
    ...explicitKeyRefAttributesAfterCss.afterSpread,
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

function createDynamicCssVariableSpreadAggregatedCssPropLowering(
  path: NodePath<t.JSXOpeningElement>,
  normalizedElement: NormalizedJsxCssPropElement
): SpreadAggregatedCssPropLowering {
  const lowering = normalizedElement.dynamicCssVariableLowering;

  invariant(
    lowering !== null,
    "Dynamic CSS variable spread aggregation requires dynamic lowering"
  );

  const runtimeLowering = getDynamicCssVariableRuntimeLowering(lowering);
  const explicitKeyRefAttributesBeforeCss = getExplicitKeyRefAttributes(
    normalizedElement.attributesBeforeCss
  );
  const explicitKeyRefAttributesAfterCss = getExplicitKeyRefAttributes(
    normalizedElement.attributesAfterCss
  );
  const preCssBinding =
    normalizedElement.attributesBeforeCss.length > 0
      ? createAggregatePropsBindingWithStyle(
          path,
          getAggregateAttributes(normalizedElement.attributesBeforeCss),
          "minchoPre"
        )
      : null;
  const postCssBinding =
    normalizedElement.attributesAfterCss.length > 0
      ? createAggregatePropsBindingWithStyle(
          path,
          getAggregateAttributes(normalizedElement.attributesAfterCss),
          preCssBinding ? "minchoPost" : "mincho"
        )
      : null;
  const classNameAttribute = t.jsxAttribute(
    t.jsxIdentifier(classNameAttributeName),
    t.jsxExpressionContainer(
      createDynamicCssVariableClassNameExpression(
        normalizedElement,
        preCssBinding,
        postCssBinding
      )
    )
  );
  const styleAttribute = t.jsxAttribute(
    t.jsxIdentifier(styleAttributeName),
    t.jsxExpressionContainer(
      createDynamicCssVariableStyleExpression(
        normalizedElement,
        preCssBinding,
        postCssBinding
      )
    )
  );

  return {
    declarations: [
      ...(preCssBinding?.declarations ?? []),
      ...(runtimeLowering?.declarations ?? []),
      ...(postCssBinding?.declarations ?? [])
    ],
    attributes: [
      ...explicitKeyRefAttributesBeforeCss.beforeSpread,
      ...(preCssBinding
        ? [t.jsxSpreadAttribute(t.cloneNode(preCssBinding.restIdentifier))]
        : []),
      ...explicitKeyRefAttributesBeforeCss.afterSpread,
      ...explicitKeyRefAttributesAfterCss.beforeSpread,
      ...(postCssBinding
        ? [t.jsxSpreadAttribute(t.cloneNode(postCssBinding.restIdentifier))]
        : []),
      ...explicitKeyRefAttributesAfterCss.afterSpread,
      classNameAttribute,
      styleAttribute
    ]
  };
}

function createDynamicCssVariableClassNameExpression(
  normalizedElement: NormalizedJsxCssPropElement,
  preCssBinding: AggregatePropsBinding | null,
  postCssBinding: AggregatePropsBinding | null
): t.Expression {
  const lowering = normalizedElement.dynamicCssVariableLowering;

  invariant(
    lowering !== null,
    "Dynamic CSS variable spread aggregation requires dynamic lowering"
  );

  if (!preCssBinding && !postCssBinding) {
    return t.cloneNode(lowering.classNameExpression);
  }

  invariant(
    lowering.cxExpression !== null,
    "Dynamic CSS variable spread aggregation requires generated cx"
  );

  return t.callExpression(t.cloneNode(lowering.cxExpression), [
    ...(preCssBinding ? [t.cloneNode(preCssBinding.classNameIdentifier)] : []),
    t.cloneNode(lowering.classNameExpression),
    ...(postCssBinding ? [t.cloneNode(postCssBinding.classNameIdentifier)] : [])
  ]);
}

function createDynamicCssVariableStyleExpression(
  normalizedElement: NormalizedJsxCssPropElement,
  preCssBinding: AggregatePropsBinding | null,
  postCssBinding: AggregatePropsBinding | null
): t.ObjectExpression {
  const lowering = normalizedElement.dynamicCssVariableLowering;

  invariant(
    lowering !== null,
    "Dynamic CSS variable spread aggregation requires dynamic lowering"
  );

  const runtimeLowering = getDynamicCssVariableRuntimeLowering(lowering);
  const styleProperties =
    runtimeLowering?.styleProperties ?? lowering.styleProperties;

  return t.objectExpression([
    ...(preCssBinding?.styleExpressions.map((expression) =>
      t.spreadElement(t.cloneNode(expression))
    ) ?? []),
    ...(postCssBinding?.styleExpressions.map((expression) =>
      t.spreadElement(t.cloneNode(expression))
    ) ?? []),
    ...styleProperties.map((property) => t.cloneNode(property))
  ]);
}

export function createAggregatePropsBinding(
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
    restIdentifier,
    styleExpressions: []
  };
}

function createAggregatePropsBindingWithStyle(
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
  const styleIdentifier = path.scope.generateUidIdentifier(`${uidPrefix}Style`);
  const restIdentifier = path.scope.generateUidIdentifier(`${uidPrefix}Rest`);
  const aggregateExpression = createAggregatePropsExpressionWithStyle(
    path,
    attributes,
    uidPrefix
  );

  return {
    declarations: [
      ...aggregateExpression.declarations,
      t.variableDeclaration("const", [
        t.variableDeclarator(
          t.cloneNode(aggregateIdentifier),
          aggregateExpression.expression
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
            t.objectProperty(
              t.identifier(styleAttributeName),
              t.cloneNode(styleIdentifier)
            ),
            t.restElement(t.cloneNode(restIdentifier))
          ]),
          t.cloneNode(aggregateIdentifier)
        )
      ])
    ],
    classNameIdentifier,
    restIdentifier,
    styleExpressions: aggregateExpression.styleExpressions
  };
}

export function assertSupportedSpreadAggregationContext(
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
  return getSpreadAggregationJsxElementPath(path) !== null;
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

export function createAggregatePropsExpression(
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

function getAggregateAttributes(
  attributes: readonly (t.JSXAttribute | t.JSXSpreadAttribute)[]
): readonly (t.JSXAttribute | t.JSXSpreadAttribute)[] {
  return attributes.filter((attribute) => !isKeyOrRefAttribute(attribute));
}

function getExplicitKeyRefAttributes(
  attributes: readonly (t.JSXAttribute | t.JSXSpreadAttribute)[]
): {
  readonly beforeSpread: t.JSXAttribute[];
  readonly afterSpread: t.JSXAttribute[];
} {
  const firstSpreadIndex = attributes.findIndex((attribute) =>
    t.isJSXSpreadAttribute(attribute)
  );
  const beforeSpread: t.JSXAttribute[] = [];
  const afterSpread: t.JSXAttribute[] = [];

  attributes.forEach((attribute, index) => {
    if (!isKeyOrRefAttribute(attribute)) {
      return;
    }

    (firstSpreadIndex === -1 || index < firstSpreadIndex
      ? beforeSpread
      : afterSpread
    ).push(t.cloneNode(attribute));
  });

  return { beforeSpread, afterSpread };
}

type AggregatePropsExpressionWithStyle = {
  readonly declarations: t.VariableDeclaration[];
  readonly expression: t.ObjectExpression;
  readonly styleExpressions: readonly t.Expression[];
};

function createAggregatePropsExpressionWithStyle(
  path: NodePath<t.JSXOpeningElement>,
  attributes: readonly (t.JSXAttribute | t.JSXSpreadAttribute)[],
  uidPrefix: string
): AggregatePropsExpressionWithStyle {
  const declarations: t.VariableDeclaration[] = [];
  const properties: t.ObjectExpression["properties"] = [];
  const styleExpressions: t.Expression[] = [];

  for (const attribute of attributes) {
    if (t.isJSXSpreadAttribute(attribute)) {
      const spreadIdentifier = path.scope.generateUidIdentifier(
        `${uidPrefix}Spread`
      );
      declarations.push(
        t.variableDeclaration("let", [
          t.variableDeclarator(t.cloneNode(spreadIdentifier))
        ])
      );
      properties.push(
        t.spreadElement(
          t.assignmentExpression(
            "=",
            t.cloneNode(spreadIdentifier),
            t.objectExpression([
              t.spreadElement(t.cloneNode(attribute.argument))
            ])
          )
        )
      );
      styleExpressions.push(
        t.memberExpression(
          t.cloneNode(spreadIdentifier),
          t.identifier(styleAttributeName)
        )
      );
      continue;
    }

    if (isNamedJsxAttribute(attribute, styleAttributeName)) {
      const explicitStyleIdentifier = path.scope.generateUidIdentifier(
        `${uidPrefix}Style`
      );
      declarations.push(
        t.variableDeclaration("let", [
          t.variableDeclarator(t.cloneNode(explicitStyleIdentifier))
        ])
      );
      properties.push(
        t.objectProperty(
          t.identifier(styleAttributeName),
          t.assignmentExpression(
            "=",
            t.cloneNode(explicitStyleIdentifier),
            t.cloneNode(getStyleExpression(path, attribute))
          )
        )
      );
      styleExpressions.push(t.cloneNode(explicitStyleIdentifier));
      continue;
    }

    properties.push(createAggregateObjectProperty(path, attribute));
  }

  return {
    declarations,
    expression: t.objectExpression(properties),
    styleExpressions
  };
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

function isKeyOrRefAttribute(
  attribute: t.JSXAttribute | t.JSXSpreadAttribute
): attribute is t.JSXAttribute {
  return (
    isNamedJsxAttribute(attribute, keyAttributeName) ||
    isNamedJsxAttribute(attribute, refAttributeName)
  );
}
