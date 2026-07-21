import { types as t } from "@babel/core";
import {
  getIdentifierParamName,
  getSingleBodyStatement,
  type StaticCssEvalBabelScope,
  type TscHelperFunction
} from "./cjsHelperLookup.js";

export function isTscCreateBindingFunction(
  helperFunction: TscHelperFunction,
  scope: StaticCssEvalBabelScope
): boolean {
  const objectName = getIdentifierParamName(helperFunction, 0);
  const moduleName = getIdentifierParamName(helperFunction, 1);
  const keyName = getIdentifierParamName(helperFunction, 2);
  const aliasName = getIdentifierParamName(helperFunction, 3);

  if (!objectName || !moduleName || !keyName || !aliasName) {
    return false;
  }

  const statements = helperFunction.body.body;
  const [first, second, third, fourth] = statements;
  const descriptorName = second
    ? getDescriptorDeclarationName(second, moduleName, keyName, scope)
    : null;

  return (
    (statements.length === 4 &&
      first !== undefined &&
      third !== undefined &&
      fourth !== undefined &&
      descriptorName !== null &&
      isDefaultAliasStatement(first, aliasName, keyName) &&
      isDescriptorRefreshStatement(
        third,
        descriptorName,
        moduleName,
        keyName
      ) &&
      isDefinePropertyStatement(
        fourth,
        objectName,
        aliasName,
        descriptorName,
        scope
      )) ||
    (statements.length === 2 &&
      first !== undefined &&
      second !== undefined &&
      isDefaultAliasStatement(first, aliasName, keyName) &&
      isBindingAssignmentStatement(
        second,
        objectName,
        aliasName,
        moduleName,
        keyName
      ))
  );
}

function getDescriptorDeclarationName(
  statement: t.Statement,
  moduleName: string,
  keyName: string,
  scope: StaticCssEvalBabelScope
): string | null {
  if (
    !t.isVariableDeclaration(statement) ||
    statement.declarations.length !== 1
  ) {
    return null;
  }

  const [declaration] = statement.declarations;

  return declaration &&
    t.isIdentifier(declaration.id) &&
    declaration.init &&
    isObjectGetOwnPropertyDescriptorCall(
      declaration.init,
      moduleName,
      keyName,
      scope
    )
    ? declaration.id.name
    : null;
}

function isDefaultAliasStatement(
  statement: t.Statement,
  aliasName: string,
  keyName: string
): boolean {
  return (
    t.isIfStatement(statement) &&
    !statement.alternate &&
    t.isBinaryExpression(statement.test, { operator: "===" }) &&
    isIdentifierAndUndefinedComparison(statement.test, aliasName) &&
    isAliasAssignmentStatement(statement.consequent, aliasName, keyName)
  );
}

function isIdentifierAndUndefinedComparison(
  expression: t.BinaryExpression,
  identifierName: string
): boolean {
  return (
    (t.isIdentifier(expression.left, { name: identifierName }) &&
      t.isIdentifier(expression.right, { name: "undefined" })) ||
    (t.isIdentifier(expression.right, { name: identifierName }) &&
      t.isIdentifier(expression.left, { name: "undefined" }))
  );
}

function isAliasAssignmentStatement(
  statement: t.Statement,
  aliasName: string,
  keyName: string
): boolean {
  return (
    t.isExpressionStatement(statement) &&
    t.isAssignmentExpression(statement.expression, { operator: "=" }) &&
    t.isIdentifier(statement.expression.left, { name: aliasName }) &&
    t.isIdentifier(statement.expression.right, { name: keyName })
  );
}

function isDescriptorRefreshStatement(
  statement: t.Statement,
  descriptorName: string,
  moduleName: string,
  keyName: string
): boolean {
  const bodyStatement = t.isIfStatement(statement)
    ? getSingleBodyStatement(statement.consequent)
    : null;

  return (
    t.isIfStatement(statement) &&
    !statement.alternate &&
    bodyStatement !== null &&
    isDescriptorAssignmentStatement(
      bodyStatement,
      descriptorName,
      moduleName,
      keyName
    )
  );
}

function isDescriptorAssignmentStatement(
  statement: t.Statement,
  descriptorName: string,
  moduleName: string,
  keyName: string
): boolean {
  return (
    t.isExpressionStatement(statement) &&
    t.isAssignmentExpression(statement.expression, { operator: "=" }) &&
    t.isIdentifier(statement.expression.left, { name: descriptorName }) &&
    t.isObjectExpression(statement.expression.right) &&
    objectExpressionHasGetter(statement.expression.right, moduleName, keyName)
  );
}

function isDefinePropertyStatement(
  statement: t.Statement,
  objectName: string,
  aliasName: string,
  descriptorName: string,
  scope: StaticCssEvalBabelScope
): boolean {
  return (
    t.isExpressionStatement(statement) &&
    t.isCallExpression(statement.expression) &&
    isObjectMethodCall(statement.expression, "defineProperty", scope) &&
    t.isIdentifier(statement.expression.arguments[0], { name: objectName }) &&
    t.isIdentifier(statement.expression.arguments[1], { name: aliasName }) &&
    t.isIdentifier(statement.expression.arguments[2], { name: descriptorName })
  );
}

function isBindingAssignmentStatement(
  statement: t.Statement,
  objectName: string,
  aliasName: string,
  moduleName: string,
  keyName: string
): boolean {
  return (
    t.isExpressionStatement(statement) &&
    t.isAssignmentExpression(statement.expression, { operator: "=" }) &&
    isComputedMember(statement.expression.left, objectName, aliasName) &&
    isComputedMember(statement.expression.right, moduleName, keyName)
  );
}

function isObjectGetOwnPropertyDescriptorCall(
  expression: t.Expression,
  moduleName: string,
  keyName: string,
  scope: StaticCssEvalBabelScope
): boolean {
  return (
    t.isCallExpression(expression) &&
    isObjectMethodCall(expression, "getOwnPropertyDescriptor", scope) &&
    t.isIdentifier(expression.arguments[0], { name: moduleName }) &&
    t.isIdentifier(expression.arguments[1], { name: keyName })
  );
}

function isObjectMethodCall(
  expression: t.CallExpression,
  methodName: string,
  scope: StaticCssEvalBabelScope
): boolean {
  return (
    t.isMemberExpression(expression.callee) &&
    !expression.callee.computed &&
    t.isIdentifier(expression.callee.object, { name: "Object" }) &&
    !scope.getBinding("Object") &&
    t.isIdentifier(expression.callee.property, { name: methodName })
  );
}

function objectExpressionHasGetter(
  expression: t.ObjectExpression,
  moduleName: string,
  keyName: string
): boolean {
  return expression.properties.some(
    (property) =>
      t.isObjectProperty(property) &&
      !property.computed &&
      t.isIdentifier(property.key, { name: "get" }) &&
      t.isFunctionExpression(property.value) &&
      getterReturnsComputedMember(property.value, moduleName, keyName)
  );
}

function getterReturnsComputedMember(
  helperFunction: TscHelperFunction,
  moduleName: string,
  keyName: string
): boolean {
  const [statement] = helperFunction.body.body;

  return (
    helperFunction.params.length === 0 &&
    helperFunction.body.body.length === 1 &&
    statement !== undefined &&
    t.isReturnStatement(statement) &&
    isComputedMember(statement.argument, moduleName, keyName)
  );
}

function isComputedMember(
  expression: t.Node | null | undefined,
  objectName: string,
  propertyName: string
): boolean {
  return (
    expression !== null &&
    expression !== undefined &&
    t.isMemberExpression(expression) &&
    expression.computed &&
    t.isIdentifier(expression.object, { name: objectName }) &&
    t.isIdentifier(expression.property, { name: propertyName })
  );
}
