import { types as t } from "@babel/core";
import type { StaticCssEvalBabelScope } from "./cjsHelperLookup.js";

export type EsbuildHelperFunction =
  | t.ArrowFunctionExpression
  | t.FunctionDeclaration
  | t.FunctionExpression;

type EsbuildHelperExpression = t.ArrowFunctionExpression | t.FunctionExpression;

export function getBoundEsbuildHelperFunctions(
  helperName: string,
  scope: StaticCssEvalBabelScope
): EsbuildHelperFunction[] {
  const binding = scope.getBinding(helperName);

  if (!binding) {
    return [];
  }

  if (
    binding.path.isFunctionDeclaration() &&
    binding.path.node.id?.name === helperName
  ) {
    return [binding.path.node];
  }

  if (
    binding.path.isVariableDeclarator() &&
    t.isIdentifier(binding.path.node.id, { name: helperName }) &&
    isEsbuildHelperFunction(binding.path.node.init)
  ) {
    return [binding.path.node.init];
  }

  return [];
}

export function getIdentifierParamName(
  helperFunction: EsbuildHelperFunction,
  index: number
): string | null {
  const param = helperFunction.params[index];
  return param && t.isIdentifier(param) ? param.name : null;
}

export function getOnlyBodyStatement(
  helperFunction: EsbuildHelperFunction
): t.Statement | null {
  if (!t.isBlockStatement(helperFunction.body)) {
    return null;
  }

  const [statement] = helperFunction.body.body;
  return helperFunction.body.body.length === 1 && statement ? statement : null;
}

export function getReturnExpression(
  helperFunction: EsbuildHelperFunction
): t.Expression | null {
  if (
    t.isArrowFunctionExpression(helperFunction) &&
    t.isExpression(helperFunction.body)
  ) {
    return helperFunction.body;
  }

  const statement = getOnlyBodyStatement(helperFunction);
  return statement &&
    t.isReturnStatement(statement) &&
    t.isExpression(statement.argument)
    ? statement.argument
    : null;
}

export function getForInKeyName(
  left: t.ForInStatement["left"] | t.ForOfStatement["left"]
): string | null {
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

export function getObjectKeyName(key: t.ObjectProperty["key"]): string | null {
  if (t.isIdentifier(key)) {
    return key.name;
  }

  return t.isStringLiteral(key) ? key.value : null;
}

export function isObjectDefinePropertyReference(
  expression: t.Expression | t.V8IntrinsicIdentifier,
  scope: StaticCssEvalBabelScope
): boolean {
  if (isObjectMethodReference(expression, "defineProperty", scope)) {
    return true;
  }

  if (!t.isIdentifier(expression)) {
    return false;
  }

  const binding = scope.getBinding(expression.name);
  return (
    binding?.path.isVariableDeclarator() === true &&
    isObjectMethodReference(binding.path.node.init, "defineProperty", scope)
  );
}

export function isReturnIdentifierStatement(
  statement: t.Statement,
  identifierName: string
): boolean {
  return (
    t.isReturnStatement(statement) &&
    t.isIdentifier(statement.argument, { name: identifierName })
  );
}

function isObjectMethodReference(
  expression: t.Node | null | undefined,
  methodName: string,
  scope: StaticCssEvalBabelScope
): boolean {
  return (
    t.isMemberExpression(expression) &&
    !expression.computed &&
    t.isIdentifier(expression.object, { name: "Object" }) &&
    !scope.getBinding("Object") &&
    t.isIdentifier(expression.property, { name: methodName })
  );
}

function isEsbuildHelperFunction(
  expression: t.Expression | null | undefined
): expression is EsbuildHelperExpression {
  return (
    t.isArrowFunctionExpression(expression) ||
    t.isFunctionExpression(expression)
  );
}
