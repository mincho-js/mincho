import { type NodePath, types as t } from "@babel/core";
import type { PluginState } from "./types.js";
import {
  type DefineRulesCxClassOperandMetadata,
  type DefineRulesCxOperandMetadata,
  type DefineRulesRuntimeRef
} from "./defineRulesCxConditionsTypes.js";
import {
  getExpressionRange,
  isMarkerBearingClassName,
  resolveProviderStaticValue
} from "./defineRulesCxConditionsProvider.js";
import {
  getConstantBindingInitPath,
  isScopedCssCall
} from "./defineRulesCxConditionsRuntime.js";
import { hasUnsafeConditionExpression } from "./defineRulesCxConditionsSafety.js";

export function collectSupportedOperands(
  argumentPaths: readonly NodePath[],
  runtime: DefineRulesRuntimeRef,
  state: PluginState
): DefineRulesCxOperandMetadata[] | null {
  const operands: DefineRulesCxOperandMetadata[] = [];

  for (const argumentPath of argumentPaths) {
    if (!argumentPath.isExpression()) {
      return null;
    }

    const operand = collectSupportedOperand(argumentPath, runtime, state);

    if (operand === null) {
      return null;
    }
    operands.push(operand);
  }

  return operands;
}

export function countConditions(
  operands: readonly DefineRulesCxOperandMetadata[]
): number {
  return operands.reduce(
    (total, operand) => total + countOperandConditions(operand),
    0
  );
}

export function countClassOperands(
  operands: readonly DefineRulesCxOperandMetadata[]
): number {
  return operands.reduce(
    (total, operand) => total + countOperandClassOperands(operand),
    0
  );
}

function collectSupportedOperand(
  path: NodePath<t.Expression>,
  runtime: DefineRulesRuntimeRef,
  state: PluginState
): DefineRulesCxOperandMetadata | null {
  if (path.isArrayExpression()) {
    return collectArrayOperand(path, runtime, state);
  }

  if (path.isLogicalExpression()) {
    return collectLogicalOperand(path, runtime, state);
  }

  if (path.isConditionalExpression()) {
    return collectTernaryOperand(path, runtime, state);
  }

  return resolveKnownClassOperand(path, runtime, state);
}

function collectArrayOperand(
  path: NodePath<t.ArrayExpression>,
  runtime: DefineRulesRuntimeRef,
  state: PluginState
): DefineRulesCxOperandMetadata | null {
  const operands: DefineRulesCxOperandMetadata[] = [];
  const range = getExpressionRange(path.node);

  if (range === null) {
    return null;
  }

  for (const elementPath of path.get("elements")) {
    if (!elementPath.isExpression()) {
      return null;
    }

    const operand = collectSupportedOperand(elementPath, runtime, state);

    if (operand === null) {
      return null;
    }
    operands.push(operand);
  }

  return { kind: "array", operands, ...range };
}

function collectLogicalOperand(
  path: NodePath<t.LogicalExpression>,
  runtime: DefineRulesRuntimeRef,
  state: PluginState
): DefineRulesCxOperandMetadata | null {
  if (path.node.operator !== "&&") {
    return null;
  }

  const conditionPath = path.get("left");
  const condition = getExpressionRange(conditionPath.node);
  const classOperand = resolveKnownClassOperand(
    path.get("right"),
    runtime,
    state
  );

  if (
    condition === null ||
    classOperand === null ||
    hasUnsafeConditionExpression(conditionPath)
  ) {
    return null;
  }

  return {
    kind: "condition",
    operator: "&&",
    condition,
    classOperand
  };
}

function collectTernaryOperand(
  path: NodePath<t.ConditionalExpression>,
  runtime: DefineRulesRuntimeRef,
  state: PluginState
): DefineRulesCxOperandMetadata | null {
  const testPath = path.get("test");
  const condition = getExpressionRange(testPath.node);
  const consequent = resolveKnownClassOperand(
    path.get("consequent"),
    runtime,
    state
  );
  const alternate = resolveKnownClassOperand(
    path.get("alternate"),
    runtime,
    state
  );

  if (
    condition === null ||
    consequent === null ||
    alternate === null ||
    hasUnsafeConditionExpression(testPath)
  ) {
    return null;
  }

  return {
    kind: "ternary",
    condition,
    consequent,
    alternate
  };
}

function resolveKnownClassOperand(
  path: NodePath<t.Expression>,
  runtime: DefineRulesRuntimeRef,
  state: PluginState
): DefineRulesCxClassOperandMetadata | null {
  const range = getExpressionRange(path.node);

  if (range === null) {
    return null;
  }

  if (isMarkerBearingClassName(resolveProviderStaticValue(path, state))) {
    return { kind: "class", source: "provider-marker", ...range };
  }

  if (isScopedCssCall(path, runtime)) {
    return { kind: "class", source: "local-css-call", ...range };
  }

  if (!path.isIdentifier()) {
    return null;
  }

  const binding = path.scope.getBinding(path.node.name);
  const initPath = binding ? getConstantBindingInitPath(binding) : null;

  return initPath !== null && isScopedCssCall(initPath, runtime)
    ? { kind: "class", source: "local-css-call", ...range }
    : null;
}
function countOperandConditions(operand: DefineRulesCxOperandMetadata): number {
  switch (operand.kind) {
    case "class":
      return 0;
    case "condition":
    case "ternary":
      return 1;
    case "array":
      return countConditions(operand.operands);
  }
}

function countOperandClassOperands(
  operand: DefineRulesCxOperandMetadata
): number {
  switch (operand.kind) {
    case "class":
      return 1;
    case "condition":
      return 1;
    case "ternary":
      return 2;
    case "array":
      return countClassOperands(operand.operands);
  }
}
