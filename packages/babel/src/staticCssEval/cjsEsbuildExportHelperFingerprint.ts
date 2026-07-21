import { types as t } from "@babel/core";
import type { StaticCssEvalBabelScope } from "./cjsHelperLookup.js";
import { getSingleBodyStatement } from "./cjsHelperLookup.js";
import {
  getBoundEsbuildHelperFunctions,
  getForInKeyName,
  getIdentifierParamName,
  getObjectKeyName,
  getOnlyBodyStatement,
  isObjectDefinePropertyReference,
  type EsbuildHelperFunction
} from "./cjsEsbuildHelperLookup.js";

export function isSupportedEsbuildExportHelper(
  helperName: string,
  scope: StaticCssEvalBabelScope
): boolean {
  const helperFunctions = getBoundEsbuildHelperFunctions(helperName, scope);
  return (
    helperFunctions.length > 0 &&
    helperFunctions.every((helperFunction) =>
      isExportFunction(helperFunction, scope)
    )
  );
}

function isExportFunction(
  helperFunction: EsbuildHelperFunction,
  scope: StaticCssEvalBabelScope
): boolean {
  const targetName = getIdentifierParamName(helperFunction, 0);
  const allName = getIdentifierParamName(helperFunction, 1);
  const statement = getOnlyBodyStatement(helperFunction);

  if (!targetName || !allName || !statement || !t.isForInStatement(statement)) {
    return false;
  }

  const keyName = getForInKeyName(statement.left);

  return (
    keyName !== null &&
    t.isIdentifier(statement.right, { name: allName }) &&
    isExportDefinePropertyStatement({
      statement: statement.body,
      targetName,
      allName,
      keyName,
      scope
    })
  );
}

function isExportDefinePropertyStatement(options: {
  readonly statement: t.Statement;
  readonly targetName: string;
  readonly allName: string;
  readonly keyName: string;
  readonly scope: StaticCssEvalBabelScope;
}): boolean {
  const bodyStatement = getSingleBodyStatement(options.statement);

  if (!bodyStatement || !t.isExpressionStatement(bodyStatement)) {
    return false;
  }

  const expression = bodyStatement.expression;
  const descriptor = t.isCallExpression(expression)
    ? expression.arguments[2]
    : null;

  return (
    t.isCallExpression(expression) &&
    isObjectDefinePropertyReference(expression.callee, options.scope) &&
    t.isIdentifier(expression.arguments[0], { name: options.targetName }) &&
    t.isIdentifier(expression.arguments[1], { name: options.keyName }) &&
    t.isObjectExpression(descriptor) &&
    descriptorHasExportGetter(descriptor, options.allName, options.keyName)
  );
}

function descriptorHasExportGetter(
  descriptor: t.ObjectExpression,
  allName: string,
  keyName: string
): boolean {
  let hasExportGetter = false;

  for (const property of descriptor.properties) {
    if (!t.isObjectProperty(property) || property.computed) {
      return false;
    }

    if (getObjectKeyName(property.key) !== "get") {
      continue;
    }

    if (
      hasExportGetter ||
      !t.isMemberExpression(property.value) ||
      !property.value.computed ||
      !t.isIdentifier(property.value.object, { name: allName }) ||
      !t.isIdentifier(property.value.property, { name: keyName })
    ) {
      return false;
    }

    hasExportGetter = true;
  }

  return hasExportGetter;
}
