import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";

export type StaticCssEvalBabelScope = NodePath<t.Node>["scope"];

export type TscHelperFunction = t.FunctionDeclaration | t.FunctionExpression;

export function getBoundHelperFunctions(
  helperName: string,
  scope: StaticCssEvalBabelScope
): TscHelperFunction[] {
  const binding = scope.getBinding(helperName);

  if (!binding?.constant) {
    return [];
  }

  if (
    binding.path.isFunctionDeclaration() &&
    binding.path.node.id?.name === helperName &&
    !binding.path.node.async &&
    !binding.path.node.generator
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

  return getFunctionExpressions(binding.path.node.init, helperName, scope);
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

function getFunctionExpressions(
  expression: t.Expression,
  helperName: string,
  scope: StaticCssEvalBabelScope
): TscHelperFunction[] {
  if (t.isFunctionExpression(expression)) {
    return expression.async || expression.generator ? [] : [expression];
  }

  if (t.isParenthesizedExpression(expression)) {
    return getFunctionExpressions(expression.expression, helperName, scope);
  }

  if (
    t.isLogicalExpression(expression, { operator: "||" }) &&
    t.isLogicalExpression(expression.left, { operator: "&&" }) &&
    t.isThisExpression(expression.left.left) &&
    t.isMemberExpression(expression.left.right, { computed: false }) &&
    t.isThisExpression(expression.left.right.object) &&
    t.isIdentifier(expression.left.right.property, { name: helperName })
  ) {
    return getFunctionExpressions(expression.right, helperName, scope);
  }

  if (
    t.isConditionalExpression(expression) &&
    t.isMemberExpression(expression.test, { computed: false }) &&
    t.isIdentifier(expression.test.object, { name: "Object" }) &&
    !scope.getBinding("Object") &&
    t.isIdentifier(expression.test.property, { name: "create" })
  ) {
    const consequent = getFunctionExpressions(
      expression.consequent,
      helperName,
      scope
    );
    const alternate = getFunctionExpressions(
      expression.alternate,
      helperName,
      scope
    );
    return consequent.length && alternate.length
      ? [...consequent, ...alternate]
      : [];
  }

  return [];
}
