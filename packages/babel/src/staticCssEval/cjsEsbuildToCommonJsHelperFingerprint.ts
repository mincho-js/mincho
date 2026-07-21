import { types as t } from "@babel/core";
import { isCopyPropsDefinePropertyStatement } from "./cjsEsbuildCopyPropsDescriptorFingerprint.js";
import {
  isExpectedCopyGuard,
  isExpectedSourceTypeGuard,
  isOwnPropertyNamesCall
} from "./cjsEsbuildCopyPropsGuards.js";
import type { StaticCssEvalBabelScope } from "./cjsHelperLookup.js";
import { getSingleBodyStatement } from "./cjsHelperLookup.js";
import {
  getBoundEsbuildHelperFunctions,
  getForInKeyName,
  getIdentifierParamName,
  getObjectKeyName,
  getReturnExpression,
  isObjectDefinePropertyReference,
  isReturnIdentifierStatement,
  type EsbuildHelperFunction
} from "./cjsEsbuildHelperLookup.js";

export function isSupportedEsbuildToCommonJsHelper(
  helperName: string,
  scope: StaticCssEvalBabelScope
): boolean {
  const helperFunctions = getBoundEsbuildHelperFunctions(helperName, scope);
  return (
    helperFunctions.length > 0 &&
    helperFunctions.every((helperFunction) =>
      isToCommonJsFunction(helperFunction, scope)
    )
  );
}

function isToCommonJsFunction(
  helperFunction: EsbuildHelperFunction,
  scope: StaticCssEvalBabelScope
): boolean {
  const moduleName = getIdentifierParamName(helperFunction, 0);
  const expression = getReturnExpression(helperFunction);

  return (
    moduleName !== null &&
    expression !== null &&
    isCopyPropsWrapperExpression({ expression, moduleName, scope })
  );
}

function isCopyPropsWrapperExpression(options: {
  readonly expression: t.Expression;
  readonly moduleName: string;
  readonly scope: StaticCssEvalBabelScope;
}): boolean {
  if (!t.isCallExpression(options.expression)) {
    return false;
  }

  const [target, source] = options.expression.arguments;
  return (
    t.isIdentifier(options.expression.callee) &&
    isSupportedEsbuildCopyPropsHelper(
      options.expression.callee.name,
      options.scope
    ) &&
    t.isExpression(target) &&
    isEsModuleMarkerExpression(target, options.scope) &&
    t.isIdentifier(source, { name: options.moduleName })
  );
}

function isSupportedEsbuildCopyPropsHelper(
  helperName: string,
  scope: StaticCssEvalBabelScope
): boolean {
  const helperFunctions = getBoundEsbuildHelperFunctions(helperName, scope);
  return (
    helperFunctions.length > 0 &&
    helperFunctions.every((helperFunction) =>
      isCopyPropsFunction(helperFunction, scope)
    )
  );
}

function isCopyPropsFunction(
  helperFunction: EsbuildHelperFunction,
  scope: StaticCssEvalBabelScope
): boolean {
  const parts = getCopyPropsFunctionParts(helperFunction);

  return (
    parts !== null &&
    isCopyPropsGuardedLoop({
      statement: parts.guardStatement,
      targetName: parts.targetName,
      sourceName: parts.sourceName,
      exceptName: parts.exceptName,
      descriptorName: parts.descriptorName,
      scope
    }) &&
    isReturnIdentifierStatement(parts.returnStatement, parts.targetName)
  );
}

type CopyPropsFunctionParts = {
  readonly targetName: string;
  readonly sourceName: string;
  readonly exceptName: string;
  readonly descriptorName: string;
  readonly guardStatement: t.IfStatement;
  readonly returnStatement: t.Statement;
};

function getCopyPropsFunctionParts(
  helperFunction: EsbuildHelperFunction
): CopyPropsFunctionParts | null {
  const targetName = getIdentifierParamName(helperFunction, 0);
  const sourceName = getIdentifierParamName(helperFunction, 1);
  const exceptName = getIdentifierParamName(helperFunction, 2);
  const descriptorName = getIdentifierParamName(helperFunction, 3);

  if (
    !targetName ||
    !sourceName ||
    !exceptName ||
    !descriptorName ||
    !t.isBlockStatement(helperFunction.body)
  ) {
    return null;
  }

  const [guardStatement, returnStatement] = helperFunction.body.body;

  return helperFunction.body.body.length === 2 &&
    t.isIfStatement(guardStatement) &&
    returnStatement
    ? {
        targetName,
        sourceName,
        exceptName,
        descriptorName,
        guardStatement,
        returnStatement
      }
    : null;
}

function isCopyPropsGuardedLoop(options: {
  readonly statement: t.IfStatement;
  readonly targetName: string;
  readonly sourceName: string;
  readonly exceptName: string;
  readonly descriptorName: string;
  readonly scope: StaticCssEvalBabelScope;
}): boolean {
  if (!isExpectedSourceTypeGuard(options.statement.test, options.sourceName)) {
    return false;
  }

  const bodyStatement = getSingleBodyStatement(options.statement.consequent);

  return (
    t.isForOfStatement(bodyStatement) &&
    isCopyPropsForOfStatement({
      statement: bodyStatement,
      targetName: options.targetName,
      sourceName: options.sourceName,
      exceptName: options.exceptName,
      descriptorName: options.descriptorName,
      scope: options.scope
    })
  );
}

function isCopyPropsForOfStatement(options: {
  readonly statement: t.ForOfStatement;
  readonly targetName: string;
  readonly sourceName: string;
  readonly exceptName: string;
  readonly descriptorName: string;
  readonly scope: StaticCssEvalBabelScope;
}): boolean {
  const keyName = getForInKeyName(options.statement.left);
  const bodyStatement = getSingleBodyStatement(options.statement.body);

  return (
    keyName !== null &&
    isOwnPropertyNamesCall({
      expression: options.statement.right,
      sourceName: options.sourceName,
      scope: options.scope
    }) &&
    bodyStatement !== null &&
    t.isIfStatement(bodyStatement) &&
    isExpectedCopyGuard({
      expression: bodyStatement.test,
      targetName: options.targetName,
      keyName,
      exceptName: options.exceptName,
      scope: options.scope
    }) &&
    isCopyPropsDefinePropertyStatement({
      statement: bodyStatement.consequent,
      targetName: options.targetName,
      sourceName: options.sourceName,
      keyName,
      descriptorName: options.descriptorName,
      scope: options.scope
    })
  );
}

function isEsModuleMarkerExpression(
  expression: t.Expression,
  scope: StaticCssEvalBabelScope
): boolean {
  const [target, key, descriptor] = t.isCallExpression(expression)
    ? expression.arguments
    : [];

  return (
    t.isCallExpression(expression) &&
    expression.arguments.length === 3 &&
    isObjectDefinePropertyReference(expression.callee, scope) &&
    t.isObjectExpression(target) &&
    target.properties.length === 0 &&
    t.isStringLiteral(key, { value: "__esModule" }) &&
    t.isObjectExpression(descriptor) &&
    hasTrueValueDescriptor(descriptor)
  );
}

function hasTrueValueDescriptor(descriptor: t.ObjectExpression): boolean {
  return (
    descriptor.properties.length === 1 &&
    descriptor.properties.some(
      (property) =>
        t.isObjectProperty(property) &&
        !property.computed &&
        getObjectKeyName(property.key) === "value" &&
        t.isBooleanLiteral(property.value, { value: true })
    )
  );
}
