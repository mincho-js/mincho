import { types as t } from "@babel/core";
import type { StaticCssEvalBabelScope } from "./cjsHelperLookup.js";
import {
  isObjectGetOwnPropertyNamesReference,
  isObjectHasOwnPropertyReference
} from "./cjsEsbuildObjectHelperReferences.js";

export function isExpectedSourceTypeGuard(
  expression: t.Expression,
  sourceName: string
): boolean {
  return (
    t.isLogicalExpression(expression, { operator: "||" }) &&
    t.isLogicalExpression(expression.left, { operator: "&&" }) &&
    t.isIdentifier(expression.left.left, { name: sourceName }) &&
    isTypeofCheck(expression.left.right, sourceName, "object") &&
    isTypeofCheck(expression.right, sourceName, "function")
  );
}

export function isOwnPropertyNamesCall(options: {
  readonly expression: t.Expression;
  readonly sourceName: string;
  readonly scope: StaticCssEvalBabelScope;
}): boolean {
  return (
    t.isCallExpression(options.expression) &&
    options.expression.arguments.length === 1 &&
    isObjectGetOwnPropertyNamesReference(
      options.expression.callee,
      options.scope
    ) &&
    t.isIdentifier(options.expression.arguments[0], {
      name: options.sourceName
    })
  );
}

export function isExpectedCopyGuard(options: {
  readonly expression: t.Expression;
  readonly targetName: string;
  readonly keyName: string;
  readonly exceptName: string;
  readonly scope: StaticCssEvalBabelScope;
}): boolean {
  return (
    t.isLogicalExpression(options.expression, { operator: "&&" }) &&
    isNegatedHasOwnPropCall({
      expression: options.expression.left,
      targetName: options.targetName,
      keyName: options.keyName,
      scope: options.scope
    }) &&
    t.isBinaryExpression(options.expression.right, { operator: "!==" }) &&
    t.isIdentifier(options.expression.right.left, { name: options.keyName }) &&
    t.isIdentifier(options.expression.right.right, { name: options.exceptName })
  );
}

function isNegatedHasOwnPropCall(options: {
  readonly expression: t.Expression;
  readonly targetName: string;
  readonly keyName: string;
  readonly scope: StaticCssEvalBabelScope;
}): boolean {
  const callExpression = t.isUnaryExpression(options.expression, {
    operator: "!"
  })
    ? options.expression.argument
    : null;

  return (
    t.isCallExpression(callExpression) &&
    callExpression.arguments.length === 2 &&
    t.isMemberExpression(callExpression.callee) &&
    !callExpression.callee.computed &&
    t.isIdentifier(callExpression.callee.property, { name: "call" }) &&
    isObjectHasOwnPropertyReference(
      callExpression.callee.object,
      options.scope
    ) &&
    t.isIdentifier(callExpression.arguments[0], { name: options.targetName }) &&
    t.isIdentifier(callExpression.arguments[1], { name: options.keyName })
  );
}

function isTypeofCheck(
  expression: t.Expression,
  sourceName: string,
  typeName: "function" | "object"
): boolean {
  return (
    t.isBinaryExpression(expression, { operator: "===" }) &&
    t.isUnaryExpression(expression.left, { operator: "typeof" }) &&
    t.isIdentifier(expression.left.argument, { name: sourceName }) &&
    t.isStringLiteral(expression.right, { value: typeName })
  );
}
