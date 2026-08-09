import { type NodePath, types as t } from "@babel/core";
import type {
  DefineRulesCxClassOperandMetadata,
  DefineRulesCxOperandMetadata
} from "./defineRulesCxConditionsTypes.js";

export const TABLE_CONDITION_LIMIT = 4;

type ClassPlan = {
  readonly expression: t.Expression;
  readonly path: NodePath<t.Expression>;
};

type OperandPlan =
  | { readonly kind: "class"; readonly classOperand: ClassPlan }
  | {
      readonly kind: "condition";
      readonly conditionIndex: number;
      readonly classOperand: ClassPlan;
    }
  | {
      readonly kind: "ternary";
      readonly conditionIndex: number;
      readonly consequent: ClassPlan;
      readonly alternate: ClassPlan;
    }
  | { readonly kind: "array"; readonly operands: readonly OperandPlan[] };

type PlanBuilder = {
  readonly conditions: t.Expression[];
  readonly classPaths: NodePath<t.Expression>[];
};

export type TablePlan = {
  readonly callee: t.Expression;
  readonly calleePath: NodePath<t.Expression>;
  readonly conditions: readonly t.Expression[];
  readonly entries: readonly (readonly t.Expression[])[];
  readonly classPaths: readonly NodePath<t.Expression>[];
};

export function createTablePlan(
  path: NodePath<t.CallExpression>,
  operands: readonly DefineRulesCxOperandMetadata[]
): TablePlan | null {
  const builder: PlanBuilder = { conditions: [], classPaths: [] };
  const argumentPaths = path.get("arguments");
  const operandPlans: OperandPlan[] = [];
  const calleePath = path.get("callee");

  if (!calleePath.isExpression() || operands.length !== argumentPaths.length) {
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

    const operandPlan = createOperandPlan({
      path: argumentPath,
      metadata,
      builder
    });

    if (operandPlan === null) {
      return null;
    }
    operandPlans.push(operandPlan);
  }

  if (
    builder.conditions.length === 0 ||
    builder.conditions.length > TABLE_CONDITION_LIMIT
  ) {
    return null;
  }

  return {
    callee: t.cloneNode(calleePath.node),
    calleePath,
    conditions: builder.conditions,
    entries: createPermutationEntries(operandPlans, builder.conditions.length),
    classPaths: builder.classPaths
  };
}

function createOperandPlan(input: {
  readonly path: NodePath<t.Expression>;
  readonly metadata: DefineRulesCxOperandMetadata;
  readonly builder: PlanBuilder;
}): OperandPlan | null {
  switch (input.metadata.kind) {
    case "class":
      return createClassOperandPlan(input.path, input.metadata, input.builder);
    case "condition":
      return createConditionOperandPlan(
        input.path,
        input.metadata,
        input.builder
      );
    case "ternary":
      return createTernaryOperandPlan(
        input.path,
        input.metadata,
        input.builder
      );
    case "array":
      return createArrayOperandPlan(
        input.path,
        input.metadata.operands,
        input.builder
      );
  }
}

function createClassOperandPlan(
  path: NodePath<t.Expression>,
  metadata: DefineRulesCxClassOperandMetadata,
  builder: PlanBuilder
): OperandPlan | null {
  const classOperand = createClassPlan(path, metadata, builder);

  return classOperand === null ? null : { kind: "class", classOperand };
}

function createConditionOperandPlan(
  path: NodePath<t.Expression>,
  metadata: Extract<
    DefineRulesCxOperandMetadata,
    { readonly kind: "condition" }
  >,
  builder: PlanBuilder
): OperandPlan | null {
  if (!path.isLogicalExpression() || path.node.operator !== "&&") {
    return null;
  }

  const conditionPath = path.get("left");
  const conditionIndex = builder.conditions.length;
  const classOperand = createClassPlan(
    path.get("right"),
    metadata.classOperand,
    builder
  );

  if (classOperand === null) {
    return null;
  }

  builder.conditions.push(t.cloneNode(conditionPath.node));
  return { kind: "condition", conditionIndex, classOperand };
}

function createTernaryOperandPlan(
  path: NodePath<t.Expression>,
  metadata: Extract<DefineRulesCxOperandMetadata, { readonly kind: "ternary" }>,
  builder: PlanBuilder
): OperandPlan | null {
  if (!path.isConditionalExpression()) {
    return null;
  }

  const conditionIndex = builder.conditions.length;
  const consequent = createClassPlan(
    path.get("consequent"),
    metadata.consequent,
    builder
  );
  const alternate = createClassPlan(
    path.get("alternate"),
    metadata.alternate,
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
  builder: PlanBuilder
): OperandPlan | null {
  if (!path.isArrayExpression()) {
    return null;
  }

  const elementPaths = path.get("elements");
  const operandPlans: OperandPlan[] = [];

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

    const operandPlan = createOperandPlan({
      path: expressionPath,
      metadata,
      builder
    });

    if (operandPlan === null) {
      return null;
    }
    operandPlans.push(operandPlan);
  }

  return { kind: "array", operands: operandPlans };
}

function createClassPlan(
  path: NodePath<t.Expression>,
  metadata: DefineRulesCxClassOperandMetadata,
  builder: PlanBuilder
): ClassPlan | null {
  if (!path.isExpression() || !path.isIdentifier()) {
    return null;
  }

  if (path.node.start !== metadata.start || path.node.end !== metadata.end) {
    return null;
  }

  builder.classPaths.push(path);
  return { expression: t.cloneNode(path.node), path };
}

function createPermutationEntries(
  operands: readonly OperandPlan[],
  conditionCount: number
): readonly (readonly t.Expression[])[] {
  const entries: (readonly t.Expression[])[] = [];

  for (let mask = 0; mask < 1 << conditionCount; mask += 1) {
    const output: t.Expression[] = [];

    for (const operand of operands) {
      appendOperandEntry(operand, { mask, output });
    }
    entries.push(output);
  }

  return entries;
}

function appendOperandEntry(
  operand: OperandPlan,
  context: { readonly mask: number; readonly output: t.Expression[] }
): void {
  switch (operand.kind) {
    case "class":
      context.output.push(t.cloneNode(operand.classOperand.expression));
      return;
    case "condition":
      if (isConditionEnabled(context.mask, operand.conditionIndex)) {
        context.output.push(t.cloneNode(operand.classOperand.expression));
      }
      return;
    case "ternary":
      context.output.push(
        t.cloneNode(
          isConditionEnabled(context.mask, operand.conditionIndex)
            ? operand.consequent.expression
            : operand.alternate.expression
        )
      );
      return;
    case "array":
      for (const child of operand.operands) {
        appendOperandEntry(child, context);
      }
      return;
  }
}

function isConditionEnabled(mask: number, conditionIndex: number): boolean {
  return (mask & (1 << conditionIndex)) !== 0;
}
