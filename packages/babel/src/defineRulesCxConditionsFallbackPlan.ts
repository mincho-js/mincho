import { type NodePath, types as t } from "@babel/core";
import { createFallbackClassPlan } from "./defineRulesCxConditionsFallbackCss.js";
import { createFallbackResolvedWrites } from "./defineRulesCxConditionsFallbackResolve.js";
import type {
  FallbackChainPlan,
  FallbackOperandPlan,
  FallbackPlanBuilder
} from "./defineRulesCxConditionsFallbackTypes.js";
import { TABLE_CONDITION_LIMIT } from "./defineRulesCxConditionsTablePlan.js";
import type {
  DefineRulesCxOperandMetadata,
  DefineRulesRuntimeRef
} from "./defineRulesCxConditionsTypes.js";

export function createFallbackChainPlan(
  path: NodePath<t.CallExpression>,
  operands: readonly DefineRulesCxOperandMetadata[],
  runtime: DefineRulesRuntimeRef
): FallbackChainPlan | null {
  const cssCallee = createCssCallee(runtime);
  const calleePath = path.get("callee");

  if (cssCallee === null || !calleePath.isExpression()) {
    return null;
  }

  const builder: FallbackPlanBuilder = { conditions: [], classPaths: [] };
  const argumentPaths = path.get("arguments");
  const operandPlans: FallbackOperandPlan[] = [];

  if (operands.length !== argumentPaths.length) {
    return null;
  }

  for (let index = 0; index < operands.length; index += 1) {
    const argumentPath = argumentPaths[index];
    const metadata = operands[index];

    if (
      argumentPath === undefined ||
      metadata === undefined ||
      !argumentPath.isExpression()
    ) {
      return null;
    }

    const operandPlan = createOperandPlan(
      argumentPath,
      metadata,
      runtime,
      builder
    );

    if (operandPlan === null) {
      return null;
    }
    operandPlans.push(operandPlan);
  }

  if (builder.conditions.length <= TABLE_CONDITION_LIMIT) {
    return null;
  }

  const resolvedWrites = createFallbackResolvedWrites(operandPlans);

  if (resolvedWrites === null || resolvedWrites.length === 0) {
    return null;
  }

  return {
    callee: t.cloneNode(calleePath.node),
    calleePath,
    cssCallee,
    conditions: builder.conditions,
    operands: operandPlans,
    resolvedWrites,
    classPaths: builder.classPaths
  };
}

function createCssCallee(runtime: DefineRulesRuntimeRef): t.Expression | null {
  if (runtime.callee !== "local-defineRules") {
    return null;
  }

  if (runtime.cssBinding !== undefined) {
    return t.identifier(runtime.cssBinding.identifier.name);
  }

  if (runtime.namespaceBinding !== undefined) {
    return t.memberExpression(
      t.identifier(runtime.namespaceBinding.identifier.name),
      t.identifier("css")
    );
  }

  return null;
}

function createOperandPlan(
  path: NodePath<t.Expression>,
  metadata: DefineRulesCxOperandMetadata,
  runtime: DefineRulesRuntimeRef,
  builder: FallbackPlanBuilder
): FallbackOperandPlan | null {
  switch (metadata.kind) {
    case "class": {
      const classOperand = createFallbackClassPlan(
        path,
        metadata,
        runtime,
        builder
      );
      return classOperand === null ? null : { kind: "class", classOperand };
    }
    case "condition":
      return createConditionOperandPlan(path, metadata, runtime, builder);
    case "ternary":
      return createTernaryOperandPlan(path, metadata, runtime, builder);
    case "array":
      return createArrayOperandPlan(path, metadata.operands, runtime, builder);
  }
}

function createConditionOperandPlan(
  path: NodePath<t.Expression>,
  metadata: Extract<
    DefineRulesCxOperandMetadata,
    { readonly kind: "condition" }
  >,
  runtime: DefineRulesRuntimeRef,
  builder: FallbackPlanBuilder
): FallbackOperandPlan | null {
  if (
    !path.isLogicalExpression() ||
    path.node.operator !== "&&" ||
    !path.get("left").isIdentifier()
  ) {
    return null;
  }

  const conditionIndex = builder.conditions.length;
  const classOperand = createFallbackClassPlan(
    path.get("right"),
    metadata.classOperand,
    runtime,
    builder
  );

  if (classOperand === null) {
    return null;
  }

  builder.conditions.push(t.cloneNode(path.node.left));
  return { kind: "condition", conditionIndex, classOperand };
}

function createTernaryOperandPlan(
  path: NodePath<t.Expression>,
  metadata: Extract<DefineRulesCxOperandMetadata, { readonly kind: "ternary" }>,
  runtime: DefineRulesRuntimeRef,
  builder: FallbackPlanBuilder
): FallbackOperandPlan | null {
  if (!path.isConditionalExpression() || !path.get("test").isIdentifier()) {
    return null;
  }

  const conditionIndex = builder.conditions.length;
  const consequent = createFallbackClassPlan(
    path.get("consequent"),
    metadata.consequent,
    runtime,
    builder
  );
  const alternate = createFallbackClassPlan(
    path.get("alternate"),
    metadata.alternate,
    runtime,
    builder
  );

  if (consequent === null || alternate === null) {
    return null;
  }

  builder.conditions.push(t.cloneNode(path.node.test));
  return { kind: "ternary", conditionIndex, consequent, alternate };
}

function createArrayOperandPlan(
  path: NodePath<t.Expression>,
  operands: readonly DefineRulesCxOperandMetadata[],
  runtime: DefineRulesRuntimeRef,
  builder: FallbackPlanBuilder
): FallbackOperandPlan | null {
  if (!path.isArrayExpression()) {
    return null;
  }

  const elementPaths = path.get("elements");
  const operandPlans: FallbackOperandPlan[] = [];

  if (elementPaths.length !== operands.length) {
    return null;
  }

  for (let index = 0; index < operands.length; index += 1) {
    const elementPath = elementPaths[index];
    const metadata = operands[index];

    if (elementPath === undefined || metadata === undefined) {
      return null;
    }

    const expressionPath = elementPath.isExpression() ? elementPath : null;

    if (expressionPath === null) {
      return null;
    }

    const operandPlan = createOperandPlan(
      expressionPath,
      metadata,
      runtime,
      builder
    );

    if (operandPlan === null) {
      return null;
    }
    operandPlans.push(operandPlan);
  }

  return { kind: "array", operands: operandPlans };
}
