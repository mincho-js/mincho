import { types as t } from "@babel/core";
import { getBoundHelperFunctions } from "./cjsHelperLookup.js";
import {
  getIdentifierParamName,
  getSingleBodyStatement,
  type StaticCssEvalBabelScope,
  type TscHelperFunction
} from "./cjsHelperLookup.js";
import { isTscCreateBindingFunction } from "./cjsCreateBindingFingerprint.js";

export function isTscExportStarFunction(
  helperFunction: TscHelperFunction,
  scope: StaticCssEvalBabelScope
): boolean {
  const moduleName = getIdentifierParamName(helperFunction, 0);
  const exportsName = getIdentifierParamName(helperFunction, 1);
  const [statement] = helperFunction.body.body;

  if (!moduleName || !exportsName || helperFunction.body.body.length !== 1) {
    return false;
  }

  if (!statement || !t.isForInStatement(statement)) {
    return false;
  }

  const keyName = getForInKeyName(statement.left);
  const guard = getSingleIfStatement(statement.body);

  return (
    keyName !== null &&
    t.isIdentifier(statement.right, { name: moduleName }) &&
    guard !== null &&
    expressionContainsDefaultExclusion(guard.test, keyName) &&
    expressionContainsHasOwnPropertyGuard(
      guard.test,
      exportsName,
      keyName,
      scope
    ) &&
    isExportStarCreateBindingStatement(
      guard.consequent,
      exportsName,
      moduleName,
      keyName,
      scope
    )
  );
}

function getForInKeyName(left: t.ForInStatement["left"]): string | null {
  if (t.isIdentifier(left)) {
    return left.name;
  }

  if (!t.isVariableDeclaration(left) || left.declarations.length !== 1) {
    return null;
  }

  const [declaration] = left.declarations;
  return declaration && t.isIdentifier(declaration.id)
    ? declaration.id.name
    : null;
}

function getSingleIfStatement(statement: t.Statement): t.IfStatement | null {
  const bodyStatement = getSingleBodyStatement(statement);
  return bodyStatement &&
    t.isIfStatement(bodyStatement) &&
    bodyStatement.alternate === null
    ? bodyStatement
    : null;
}

function isExportStarCreateBindingStatement(
  statement: t.Statement,
  exportsName: string,
  moduleName: string,
  keyName: string,
  scope: StaticCssEvalBabelScope
): boolean {
  const bodyStatement = getSingleBodyStatement(statement);

  return (
    bodyStatement !== null &&
    t.isExpressionStatement(bodyStatement) &&
    t.isCallExpression(bodyStatement.expression) &&
    t.isIdentifier(bodyStatement.expression.callee) &&
    isBoundCreateBindingHelper(bodyStatement.expression.callee.name, scope) &&
    t.isIdentifier(bodyStatement.expression.arguments[0], {
      name: exportsName
    }) &&
    t.isIdentifier(bodyStatement.expression.arguments[1], {
      name: moduleName
    }) &&
    t.isIdentifier(bodyStatement.expression.arguments[2], { name: keyName })
  );
}

function isBoundCreateBindingHelper(
  helperName: string,
  scope: StaticCssEvalBabelScope
): boolean {
  const helperFunctions = getBoundHelperFunctions(helperName, scope);
  return (
    helperFunctions.length > 0 &&
    helperFunctions.every((helperFunction) =>
      isTscCreateBindingFunction(helperFunction, scope)
    )
  );
}

function expressionContainsDefaultExclusion(
  expression: t.Expression,
  keyName: string
): boolean {
  return expressionContains(
    expression,
    (candidate) =>
      t.isBinaryExpression(candidate, { operator: "!==" }) &&
      ((t.isIdentifier(candidate.left, { name: keyName }) &&
        t.isStringLiteral(candidate.right, { value: "default" })) ||
        (t.isIdentifier(candidate.right, { name: keyName }) &&
          t.isStringLiteral(candidate.left, { value: "default" })))
  );
}

function expressionContainsHasOwnPropertyGuard(
  expression: t.Expression,
  exportsName: string,
  keyName: string,
  scope: StaticCssEvalBabelScope
): boolean {
  return expressionContains(
    expression,
    (candidate) =>
      t.isCallExpression(candidate) &&
      isHasOwnPropertyCallCallee(candidate.callee, scope) &&
      t.isIdentifier(candidate.arguments[0], { name: exportsName }) &&
      t.isIdentifier(candidate.arguments[1], { name: keyName })
  );
}

function isHasOwnPropertyCallCallee(
  callee: t.Expression | t.V8IntrinsicIdentifier,
  scope: StaticCssEvalBabelScope
): boolean {
  if (
    !t.isMemberExpression(callee) ||
    callee.computed ||
    !t.isIdentifier(callee.property, { name: "call" }) ||
    !t.isMemberExpression(callee.object) ||
    callee.object.computed ||
    !t.isIdentifier(callee.object.property, { name: "hasOwnProperty" }) ||
    !t.isMemberExpression(callee.object.object) ||
    callee.object.object.computed
  ) {
    return false;
  }

  return (
    t.isIdentifier(callee.object.object.object, { name: "Object" }) &&
    !scope.getBinding("Object") &&
    t.isIdentifier(callee.object.object.property, { name: "prototype" })
  );
}

function expressionContains(
  expression: t.Expression,
  predicate: (candidate: t.Expression) => boolean
): boolean {
  if (predicate(expression)) {
    return true;
  }

  if (t.isLogicalExpression(expression) || t.isBinaryExpression(expression)) {
    return (
      (t.isExpression(expression.left) &&
        expressionContains(expression.left, predicate)) ||
      expressionContains(expression.right, predicate)
    );
  }

  if (t.isUnaryExpression(expression)) {
    return expressionContains(expression.argument, predicate);
  }

  if (t.isConditionalExpression(expression)) {
    return (
      expressionContains(expression.test, predicate) ||
      expressionContains(expression.consequent, predicate) ||
      expressionContains(expression.alternate, predicate)
    );
  }

  if (t.isMemberExpression(expression)) {
    return (
      (t.isExpression(expression.object) &&
        expressionContains(expression.object, predicate)) ||
      (t.isExpression(expression.property) &&
        expressionContains(expression.property, predicate))
    );
  }

  if (t.isCallExpression(expression)) {
    if (
      t.isExpression(expression.callee) &&
      expressionContains(expression.callee, predicate)
    ) {
      return true;
    }

    return expression.arguments.some(
      (argument) =>
        t.isExpression(argument) && expressionContains(argument, predicate)
    );
  }

  return t.isParenthesizedExpression(expression)
    ? expressionContains(expression.expression, predicate)
    : false;
}
