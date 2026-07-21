import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";

export type StaticCssEvalBabelScope = NodePath<t.Node>["scope"];
export type TscHelperFunction = t.FunctionDeclaration | t.FunctionExpression;

export function getBoundHelperFunctions(
  helperName: string,
  scope: StaticCssEvalBabelScope
): TscHelperFunction[] {
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
    !binding.path.isVariableDeclarator() ||
    !t.isIdentifier(binding.path.node.id, { name: helperName }) ||
    !binding.path.node.init ||
    !t.isExpression(binding.path.node.init)
  ) {
    return [];
  }

  const helperFunctions: TscHelperFunction[] = [];
  collectFunctionExpressions(binding.path.node.init, helperFunctions);
  return helperFunctions;
}

export function getIdentifierParamName(
  helperFunction: TscHelperFunction,
  index: number
): string | null {
  const param = helperFunction.params[index];
  return param && t.isIdentifier(param) ? param.name : null;
}

export function getSingleBodyStatement(
  statement: t.Statement
): t.Statement | null {
  if (t.isBlockStatement(statement)) {
    const [bodyStatement] = statement.body;
    return statement.body.length === 1 && bodyStatement ? bodyStatement : null;
  }

  return statement;
}

function collectFunctionExpressions(
  expression: t.Expression,
  helperFunctions: TscHelperFunction[]
): void {
  if (t.isFunctionExpression(expression)) {
    helperFunctions.push(expression);
    return;
  }

  if (t.isLogicalExpression(expression) || t.isBinaryExpression(expression)) {
    if (t.isExpression(expression.left)) {
      collectFunctionExpressions(expression.left, helperFunctions);
    }
    collectFunctionExpressions(expression.right, helperFunctions);
    return;
  }

  if (t.isConditionalExpression(expression)) {
    collectFunctionExpressions(expression.test, helperFunctions);
    collectFunctionExpressions(expression.consequent, helperFunctions);
    collectFunctionExpressions(expression.alternate, helperFunctions);
    return;
  }

  if (t.isParenthesizedExpression(expression)) {
    collectFunctionExpressions(expression.expression, helperFunctions);
    return;
  }

  if (t.isSequenceExpression(expression)) {
    for (const item of expression.expressions) {
      collectFunctionExpressions(item, helperFunctions);
    }
  }
}
