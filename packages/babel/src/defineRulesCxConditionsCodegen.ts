import { type NodePath, types as t } from "@babel/core";
import { optimizeFallbackChainPlan } from "./defineRulesCxConditionsFallbackCodegen.js";
import { createFallbackChainPlan } from "./defineRulesCxConditionsFallbackPlan.js";
import {
  createTablePlan,
  type TablePlan
} from "./defineRulesCxConditionsTablePlan.js";
import { getProgramInsertionPoint } from "./defineRulesCxConditionsScope.js";
import type {
  DefineRulesCxOperandMetadata,
  DefineRulesRuntimeRef
} from "./defineRulesCxConditionsTypes.js";

const generatedOptimizedCalls = new WeakSet<t.CallExpression>();

export function optimizeDefineRulesCxConditionsCallExpression(
  path: NodePath<t.CallExpression>,
  operands: readonly DefineRulesCxOperandMetadata[],
  runtime: DefineRulesRuntimeRef
): boolean {
  const tablePlan = createTablePlan(path, operands);

  if (tablePlan !== null) {
    return optimizeTablePlan(path, tablePlan);
  }

  const fallbackPlan = createFallbackChainPlan(path, operands, runtime);
  return fallbackPlan === null
    ? false
    : optimizeFallbackChainPlan(path, fallbackPlan);
}

export function isGeneratedDefineRulesCxConditionsCall(
  path: NodePath<t.CallExpression>
): boolean {
  return generatedOptimizedCalls.has(path.node);
}

function optimizeTablePlan(
  path: NodePath<t.CallExpression>,
  plan: TablePlan
): boolean {
  const insertionPoint = getProgramInsertionPoint(path, [
    plan.calleePath,
    ...plan.classPaths
  ]);

  if (insertionPoint === null) {
    return false;
  }
  const { programPath, programStatement } = insertionPoint;

  const tableIdentifier = programPath.scope.generateUidIdentifier(
    "minchoDefineRulesCx"
  );
  const tableDeclaration = t.variableDeclaration("const", [
    t.variableDeclarator(tableIdentifier, createTableExpression(plan))
  ]);

  programStatement.insertBefore(tableDeclaration);
  path.replaceWith(
    t.memberExpression(
      t.cloneNode(tableIdentifier),
      createKeyExpression(plan.conditions),
      true
    )
  );
  return true;
}

function createTableExpression(plan: TablePlan): t.ArrayExpression {
  return t.arrayExpression(
    plan.entries.map((entry) => {
      const tableCall = t.callExpression(
        t.cloneNode(plan.callee),
        entry.map((item) => t.cloneNode(item))
      );
      generatedOptimizedCalls.add(tableCall);
      return tableCall;
    })
  );
}

function createKeyExpression(
  conditions: readonly t.Expression[]
): t.Expression {
  const expressions = conditions.map((condition, index) =>
    t.binaryExpression(
      "<<",
      t.unaryExpression(
        "!",
        t.unaryExpression("!", t.cloneNode(condition), true),
        true
      ),
      t.numericLiteral(index)
    )
  );
  const first = expressions[0];

  if (first === undefined) {
    return t.numericLiteral(0);
  }

  return expressions
    .slice(1)
    .reduce<t.Expression>(
      (left, right) => t.binaryExpression("|", left, right),
      first
    );
}
