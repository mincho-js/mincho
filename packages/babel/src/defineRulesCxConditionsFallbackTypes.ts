import type { NodePath, types as t } from "@babel/core";

export type FallbackExpression =
  | { readonly kind: "value"; readonly value: string }
  | {
      readonly kind: "condition";
      readonly conditionIndex: number;
      readonly whenTrue: FallbackExpression;
      readonly whenFalse: FallbackExpression;
    };

export type CssWrite = {
  readonly property: string;
  readonly value: FallbackExpression;
};

export type ClassPlan = {
  readonly expression: t.Expression;
  readonly path: NodePath<t.Expression>;
  readonly writes: readonly CssWrite[];
};

export type FallbackOperandPlan =
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
  | {
      readonly kind: "array";
      readonly operands: readonly FallbackOperandPlan[];
    };

export type FallbackResolvedWrite = {
  readonly property: string;
  readonly value: FallbackExpression;
};

export type FallbackChainPlan = {
  readonly callee: t.Expression;
  readonly calleePath: NodePath<t.Expression>;
  readonly cssCallee: t.Expression;
  readonly conditions: readonly t.Expression[];
  readonly operands: readonly FallbackOperandPlan[];
  readonly resolvedWrites: readonly FallbackResolvedWrite[];
  readonly classPaths: readonly NodePath<t.Expression>[];
};

export type FallbackPlanBuilder = {
  readonly conditions: t.Expression[];
  readonly classPaths: NodePath<t.Expression>[];
};
