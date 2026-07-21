import { types as t } from "@babel/core";
import type { StaticCssEvalBabelScope } from "./cjsHelperLookup.js";
import { getSingleBodyStatement } from "./cjsHelperLookup.js";
import {
  getObjectKeyName,
  isObjectDefinePropertyReference
} from "./cjsEsbuildHelperLookup.js";
import { isObjectGetOwnPropertyDescriptorReference } from "./cjsEsbuildObjectHelperReferences.js";

export function isCopyPropsDefinePropertyStatement(options: {
  readonly statement: t.Statement;
  readonly targetName: string;
  readonly sourceName: string;
  readonly keyName: string;
  readonly descriptorName: string;
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
    expression.arguments.length === 3 &&
    isObjectDefinePropertyReference(expression.callee, options.scope) &&
    t.isIdentifier(expression.arguments[0], { name: options.targetName }) &&
    t.isIdentifier(expression.arguments[1], { name: options.keyName }) &&
    t.isObjectExpression(descriptor) &&
    descriptorHasGetter({
      descriptor,
      sourceName: options.sourceName,
      keyName: options.keyName,
      descriptorName: options.descriptorName,
      scope: options.scope
    })
  );
}

function descriptorHasGetter(options: {
  readonly descriptor: t.ObjectExpression;
  readonly sourceName: string;
  readonly keyName: string;
  readonly descriptorName: string;
  readonly scope: StaticCssEvalBabelScope;
}): boolean {
  const [getter, enumerable] = options.descriptor.properties;

  return (
    options.descriptor.properties.length === 2 &&
    isExpectedGetterProperty(getter, options.sourceName, options.keyName) &&
    isExpectedEnumerableProperty({
      property: enumerable,
      sourceName: options.sourceName,
      keyName: options.keyName,
      descriptorName: options.descriptorName,
      scope: options.scope
    })
  );
}

function isExpectedGetterProperty(
  property: t.ObjectExpression["properties"][number] | undefined,
  sourceName: string,
  keyName: string
): boolean {
  return (
    t.isObjectProperty(property) &&
    !property.computed &&
    getObjectKeyName(property.key) === "get" &&
    t.isExpression(property.value) &&
    isZeroArgGetterForMember(property.value, sourceName, keyName)
  );
}

function isExpectedEnumerableProperty(options: {
  readonly property: t.ObjectExpression["properties"][number] | undefined;
  readonly sourceName: string;
  readonly keyName: string;
  readonly descriptorName: string;
  readonly scope: StaticCssEvalBabelScope;
}): boolean {
  return (
    t.isObjectProperty(options.property) &&
    !options.property.computed &&
    getObjectKeyName(options.property.key) === "enumerable" &&
    t.isExpression(options.property.value) &&
    isExpectedEnumerableExpression({
      expression: options.property.value,
      sourceName: options.sourceName,
      keyName: options.keyName,
      descriptorName: options.descriptorName,
      scope: options.scope
    })
  );
}

function isExpectedEnumerableExpression(options: {
  readonly expression: t.Expression;
  readonly sourceName: string;
  readonly keyName: string;
  readonly descriptorName: string;
  readonly scope: StaticCssEvalBabelScope;
}): boolean {
  return (
    t.isLogicalExpression(options.expression, { operator: "||" }) &&
    t.isUnaryExpression(options.expression.left, { operator: "!" }) &&
    isDescriptorAssignment({
      expression: options.expression.left.argument,
      sourceName: options.sourceName,
      keyName: options.keyName,
      descriptorName: options.descriptorName,
      scope: options.scope
    }) &&
    t.isMemberExpression(options.expression.right) &&
    !options.expression.right.computed &&
    t.isIdentifier(options.expression.right.object, {
      name: options.descriptorName
    }) &&
    t.isIdentifier(options.expression.right.property, { name: "enumerable" })
  );
}

function isDescriptorAssignment(options: {
  readonly expression: t.Node;
  readonly sourceName: string;
  readonly keyName: string;
  readonly descriptorName: string;
  readonly scope: StaticCssEvalBabelScope;
}): boolean {
  return (
    t.isAssignmentExpression(options.expression, { operator: "=" }) &&
    t.isIdentifier(options.expression.left, { name: options.descriptorName }) &&
    isOwnPropertyDescriptorCall({
      expression: options.expression.right,
      sourceName: options.sourceName,
      keyName: options.keyName,
      scope: options.scope
    })
  );
}

function isOwnPropertyDescriptorCall(options: {
  readonly expression: t.Expression;
  readonly sourceName: string;
  readonly keyName: string;
  readonly scope: StaticCssEvalBabelScope;
}): boolean {
  return (
    t.isCallExpression(options.expression) &&
    options.expression.arguments.length === 2 &&
    isObjectGetOwnPropertyDescriptorReference(
      options.expression.callee,
      options.scope
    ) &&
    t.isIdentifier(options.expression.arguments[0], {
      name: options.sourceName
    }) &&
    t.isIdentifier(options.expression.arguments[1], { name: options.keyName })
  );
}

function isZeroArgGetterForMember(
  expression: t.Expression,
  sourceName: string,
  keyName: string
): boolean {
  if (
    !t.isArrowFunctionExpression(expression) ||
    expression.params.length !== 0
  ) {
    return false;
  }

  return (
    t.isMemberExpression(expression.body) &&
    expression.body.computed &&
    t.isIdentifier(expression.body.object, { name: sourceName }) &&
    t.isIdentifier(expression.body.property, { name: keyName })
  );
}
