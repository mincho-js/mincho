import { types as t } from "@babel/core";
import type { StaticCssEvalBabelScope } from "./cjsHelperLookup.js";

export function isObjectGetOwnPropertyNamesReference(
  expression: t.Expression | t.V8IntrinsicIdentifier,
  scope: StaticCssEvalBabelScope
): boolean {
  return isObjectMethodReference(expression, "getOwnPropertyNames", scope);
}

export function isObjectGetOwnPropertyDescriptorReference(
  expression: t.Expression | t.V8IntrinsicIdentifier,
  scope: StaticCssEvalBabelScope
): boolean {
  return isObjectMethodReference(expression, "getOwnPropertyDescriptor", scope);
}

export function isObjectHasOwnPropertyReference(
  expression: t.Expression | t.Super,
  scope: StaticCssEvalBabelScope
): boolean {
  if (isObjectHasOwnPropertyMemberExpression(expression, scope)) {
    return true;
  }

  if (!t.isIdentifier(expression)) {
    return false;
  }

  const binding = scope.getBinding(expression.name);
  return (
    binding?.path.isVariableDeclarator() === true &&
    isObjectHasOwnPropertyMemberExpression(binding.path.node.init, scope)
  );
}

function isObjectMethodReference(
  expression: t.Expression | t.V8IntrinsicIdentifier,
  methodName: string,
  scope: StaticCssEvalBabelScope
): boolean {
  if (isObjectMethodMemberExpression(expression, methodName, scope)) {
    return true;
  }

  if (!t.isIdentifier(expression)) {
    return false;
  }

  const binding = scope.getBinding(expression.name);
  return (
    binding?.path.isVariableDeclarator() === true &&
    isObjectMethodMemberExpression(binding.path.node.init, methodName, scope)
  );
}

function isObjectMethodMemberExpression(
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

function isObjectHasOwnPropertyMemberExpression(
  expression: t.Node | null | undefined,
  scope: StaticCssEvalBabelScope
): boolean {
  return (
    t.isMemberExpression(expression) &&
    !expression.computed &&
    t.isMemberExpression(expression.object) &&
    !expression.object.computed &&
    t.isIdentifier(expression.object.object, { name: "Object" }) &&
    !scope.getBinding("Object") &&
    t.isIdentifier(expression.object.property, { name: "prototype" }) &&
    t.isIdentifier(expression.property, { name: "hasOwnProperty" })
  );
}
