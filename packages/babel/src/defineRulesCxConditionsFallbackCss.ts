import { type NodePath, types as t } from "@babel/core";
import {
  getConstantBindingInitPath,
  isScopedCssCall
} from "./defineRulesCxConditionsRuntime.js";
import type {
  DefineRulesCxClassOperandMetadata,
  DefineRulesRuntimeRef
} from "./defineRulesCxConditionsTypes.js";
import type {
  ClassPlan,
  CssWrite,
  FallbackPlanBuilder
} from "./defineRulesCxConditionsFallbackTypes.js";
import { isSupportedCssDeclarationProperty } from "./cssProperty.js";
import { mayHaveShorthandConflict } from "./defineRulesCxConditionsShorthands.js";

export function createFallbackClassPlan(
  path: NodePath<t.Expression>,
  metadata: DefineRulesCxClassOperandMetadata,
  runtime: DefineRulesRuntimeRef,
  builder: FallbackPlanBuilder
): ClassPlan | null {
  if (
    !path.isExpression() ||
    path.node.start !== metadata.start ||
    path.node.end !== metadata.end
  ) {
    return null;
  }

  const cssCallPath = getCssCallForClassOperand(path, runtime);

  if (cssCallPath === null) {
    return null;
  }

  const writes = getCssCallWrites(cssCallPath);

  if (writes === null || writes.length === 0) {
    return null;
  }

  builder.classPaths.push(path);
  return { expression: t.cloneNode(path.node), path, writes };
}

function getCssCallForClassOperand(
  path: NodePath<t.Expression>,
  runtime: DefineRulesRuntimeRef
): NodePath<t.CallExpression> | null {
  if (!path.isIdentifier()) {
    return null;
  }

  const binding = path.scope.getBinding(path.node.name);
  const initPath =
    binding === undefined ? null : getConstantBindingInitPath(binding);

  return initPath !== null &&
    initPath.isCallExpression() &&
    isScopedCssCall(initPath, runtime)
    ? initPath
    : null;
}

function getCssCallWrites(
  path: NodePath<t.CallExpression>
): readonly CssWrite[] | null {
  const argumentPaths = path.get("arguments");
  const firstArgument = argumentPaths[0];

  if (argumentPaths.length !== 1 || firstArgument === undefined) {
    return null;
  }

  if (!firstArgument.isObjectExpression()) {
    return null;
  }

  const writes: CssWrite[] = [];

  for (const propertyPath of firstArgument.get("properties")) {
    if (!propertyPath.isObjectProperty() || propertyPath.node.computed) {
      return null;
    }

    const property = getObjectPropertyName(propertyPath.node.key);
    const valuePath = propertyPath.get("value");

    if (
      property === null ||
      !isSupportedCssDeclarationProperty(property) ||
      !valuePath.isStringLiteral() ||
      valuePath.node.value.endsWith("!")
    ) {
      return null;
    }

    writes.push({
      property,
      value: { kind: "value", value: valuePath.node.value }
    });
  }

  return hasPossibleShorthandConflict(writes.map((write) => write.property))
    ? null
    : writes;
}

function getObjectPropertyName(
  property: t.ObjectProperty["key"]
): string | null {
  if (t.isIdentifier(property)) {
    return property.name;
  }

  if (t.isStringLiteral(property)) {
    return property.value;
  }

  return null;
}

function hasPossibleShorthandConflict(properties: readonly string[]): boolean {
  for (let leftIndex = 0; leftIndex < properties.length; leftIndex += 1) {
    const left = properties[leftIndex];

    if (left === undefined) {
      continue;
    }

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < properties.length;
      rightIndex += 1
    ) {
      const right = properties[rightIndex];

      if (right !== undefined && mayHaveShorthandConflict(left, right)) {
        return true;
      }
    }
  }

  return false;
}
