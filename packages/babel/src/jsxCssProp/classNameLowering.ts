import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import { unwrapTransparentCssRuleExpression } from "../staticCssEval/candidates.js";
import type { ProgramScope } from "../types.js";
import { registerImportMethod } from "../utils.js";
import {
  canEmitCssClassNameDirectly,
  isArrayClassValueExpression,
  isConditionalArrayClassNameBranchExpression,
  isConditionalCssRuleBranchExpression,
  isDirectCssRuleExpression,
  isDirectCssRuleLiteralExpression,
  isLogicalArrayClassNameBranchExpression,
  isLogicalCssRuleBranchExpression,
  isStaticLeftLogicalCssRuleGuardOperator,
  isStaticLeftLogicalCssRuleOperator
} from "./classification.js";
import {
  classNameValueErrorMessage,
  cssModuleHelperImportCleanupScopes,
  cssModuleName
} from "./constants.js";
import { shouldCleanupCssModuleHelperImports } from "./metadata.js";
import type {
  CssClassNameArrayElementResultLoweringRequest,
  CssClassNameBranchResultLoweringRequest,
  CssClassNameLoweringRequest,
  CssClassNameRootResultLoweringRequest,
  DynamicCssVariableLowering,
  CssPropValueClassification
} from "./types.js";

type DynamicCssVariableRuntimeLowering = {
  readonly declarations: readonly t.VariableDeclaration[];
  readonly styleProperties: readonly t.ObjectExpression["properties"][number][];
};

const dynamicCssVariableRuntimeLowerings = new WeakMap<
  DynamicCssVariableLowering,
  DynamicCssVariableRuntimeLowering
>();

export function registerDynamicCssVariableRuntimeLowering(
  lowering: DynamicCssVariableLowering,
  runtimeLowering: DynamicCssVariableRuntimeLowering
): DynamicCssVariableLowering {
  dynamicCssVariableRuntimeLowerings.set(lowering, runtimeLowering);
  return lowering;
}

export function getDynamicCssVariableRuntimeLowering(
  lowering: DynamicCssVariableLowering
): DynamicCssVariableRuntimeLowering | null {
  return dynamicCssVariableRuntimeLowerings.get(lowering) ?? null;
}

export function createClassNameExpression(
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
    normalizedElement.cssValueClassification,
    path.scope
  );

  if (
    shouldCleanupCssModuleHelperImports(
      normalizedElement.cssExpression,
      normalizedElement.cssValueClassification,
      path.scope
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

export function createClassNameAttributeValue(
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

export function lowerCssClassNameExpression(
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
    (isConditionalCssRuleBranchExpression(
      unwrappedExpression,
      request.path.scope
    ) ||
      isConditionalArrayClassNameBranchExpression(
        unwrappedExpression,
        request.path.scope
      ))
  ) {
    return createConditionalCssRuleClassNameExpression(
      request.path,
      unwrappedExpression
    );
  }

  if (
    t.isLogicalExpression(unwrappedExpression) &&
    (isLogicalCssRuleBranchExpression(
      unwrappedExpression,
      request.path.scope
    ) ||
      isLogicalArrayClassNameBranchExpression(
        unwrappedExpression,
        request.path.scope
      ))
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

  if (isDirectCssRuleExpression(unwrappedExpression, request.path.scope)) {
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
    (isConditionalCssRuleBranchExpression(
      unwrappedExpression,
      request.path.scope
    ) ||
      isConditionalArrayClassNameBranchExpression(
        unwrappedExpression,
        request.path.scope
      ))
  ) {
    return createConditionalCssRuleClassNameExpression(
      request.path,
      unwrappedExpression
    );
  }

  if (
    t.isLogicalExpression(unwrappedExpression) &&
    (isLogicalCssRuleBranchExpression(
      unwrappedExpression,
      request.path.scope
    ) ||
      isLogicalArrayClassNameBranchExpression(
        unwrappedExpression,
        request.path.scope
      ))
  ) {
    return createLogicalCssRuleClassNameExpression(
      request.path,
      unwrappedExpression
    );
  }

  return t.cloneNode(request.expression);
}

export function createCssRuleClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  cssExpression: t.Expression
): t.Expression {
  const cssIdentifier = registerImportMethod(path, "css", cssModuleName);
  const cssRuleExpression = unwrapTransparentCssRuleExpression(cssExpression);
  return t.callExpression(cssIdentifier, [t.cloneNode(cssRuleExpression)]);
}

export function createConditionalCssRuleClassNameExpression(
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

export function createLogicalCssRuleClassNameExpression(
  path: NodePath<t.JSXOpeningElement>,
  cssExpression: t.LogicalExpression
): t.Expression {
  if (
    isStaticLeftLogicalCssRuleOperator(cssExpression.operator) &&
    isDirectCssRuleExpression(cssExpression.left, path.scope)
  ) {
    return lowerCssClassNameExpression({
      path,
      expression: cssExpression.left,
      context: "branch-result"
    });
  }

  if (
    isStaticLeftLogicalCssRuleGuardOperator(cssExpression.operator) &&
    isDirectCssRuleExpression(cssExpression.left, path.scope)
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

function createStaticStringExpression(
  expression: t.StringLiteral
): t.StringLiteral {
  return t.cloneNode(expression);
}

export function getClassNameExpression(
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
