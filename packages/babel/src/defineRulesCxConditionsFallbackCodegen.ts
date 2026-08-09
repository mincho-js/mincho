import { type NodePath, types as t } from "@babel/core";
import { getProgramInsertionPoint } from "./defineRulesCxConditionsScope.js";
import type {
  FallbackChainPlan,
  FallbackExpression,
  FallbackOperandPlan
} from "./defineRulesCxConditionsFallbackTypes.js";

// allow: SIZE_OK — deterministic fallback-chain AST emission is one pipeline.

export function optimizeFallbackChainPlan(
  path: NodePath<t.CallExpression>,
  plan: FallbackChainPlan
): boolean {
  const insertionPoint = getProgramInsertionPoint(path, [
    plan.calleePath,
    ...plan.classPaths
  ]);

  if (insertionPoint === null) {
    return false;
  }
  const { programPath, programStatement } = insertionPoint;

  const hookPrefix = programPath.scope.generateUidIdentifier(
    "minchoDefineRulesCxHook"
  ).name;
  const resolvedIdentifiers = plan.resolvedWrites.map(() =>
    programPath.scope.generateUidIdentifier("minchoDefineRulesCxResolved")
  );
  const switchIdentifiers = plan.conditions.map(() =>
    programPath.scope.generateUidIdentifier("minchoDefineRulesCxSwitch")
  );
  const fallbackClassExpressions = createFallbackClassExpressions(
    plan.operands,
    plan.conditions
  );
  const switchClassExpressions = createSwitchClassExpressions(
    plan.conditions,
    switchIdentifiers
  );
  const resolvedDeclarations = createResolvedDeclarations(
    plan,
    resolvedIdentifiers,
    hookPrefix
  );
  const switchDeclarations = createSwitchDeclarations(
    plan,
    switchIdentifiers,
    hookPrefix
  );

  if (
    fallbackClassExpressions === null ||
    switchClassExpressions === null ||
    resolvedDeclarations === null ||
    switchDeclarations === null
  ) {
    return false;
  }

  const classExpressions = [
    ...fallbackClassExpressions,
    ...resolvedIdentifiers.map((identifier) => t.cloneNode(identifier)),
    ...switchClassExpressions
  ];

  programStatement.insertBefore([
    ...resolvedDeclarations,
    ...switchDeclarations
  ]);
  path.replaceWith(createClassNameJoinExpression(classExpressions));
  return true;
}

function createResolvedDeclarations(
  plan: FallbackChainPlan,
  identifiers: readonly t.Identifier[],
  hookPrefix: string
): readonly t.VariableDeclaration[] | null {
  const declarations: t.VariableDeclaration[] = [];

  for (let index = 0; index < plan.resolvedWrites.length; index += 1) {
    const write = plan.resolvedWrites[index];
    const identifier = identifiers[index];

    if (write === undefined || identifier === undefined) {
      return null;
    }

    declarations.push(
      t.variableDeclaration("const", [
        t.variableDeclarator(
          t.cloneNode(identifier),
          t.callExpression(t.cloneNode(plan.cssCallee), [
            createResolvedStyleExpression(
              write.property,
              write.value,
              hookPrefix
            )
          ])
        )
      ])
    );
  }

  return declarations;
}

function createSwitchDeclarations(
  plan: FallbackChainPlan,
  identifiers: readonly t.Identifier[],
  hookPrefix: string
): readonly t.VariableDeclaration[] | null {
  const declarations: t.VariableDeclaration[] = [];

  for (
    let conditionIndex = 0;
    conditionIndex < plan.conditions.length;
    conditionIndex += 1
  ) {
    const identifier = identifiers[conditionIndex];

    if (identifier === undefined) {
      return null;
    }

    declarations.push(
      t.variableDeclaration("const", [
        t.variableDeclarator(
          t.cloneNode(identifier),
          t.callExpression(t.cloneNode(plan.cssCallee), [
            createSwitchStyleExpression(hookPrefix, conditionIndex)
          ])
        )
      ])
    );
  }

  return declarations;
}

function createResolvedStyleExpression(
  property: string,
  value: FallbackExpression,
  hookPrefix: string
): t.ObjectExpression {
  const properties = collectFallbackExpressionConditionIndices(value).flatMap(
    (conditionIndex) => [
      createStringProperty(hookName(hookPrefix, conditionIndex, 0), "initial"),
      createStringProperty(hookName(hookPrefix, conditionIndex, 1), "")
    ]
  );

  properties.push(
    createStringProperty(
      property,
      serializeFallbackExpression(value, hookPrefix)
    )
  );
  return t.objectExpression(properties);
}

function createSwitchStyleExpression(
  hookPrefix: string,
  conditionIndex: number
): t.ObjectExpression {
  return t.objectExpression([
    createStringProperty(hookName(hookPrefix, conditionIndex, 0), ""),
    createStringProperty(hookName(hookPrefix, conditionIndex, 1), "initial")
  ]);
}

function createStringProperty(
  property: string,
  value: string
): t.ObjectProperty {
  return t.objectProperty(t.stringLiteral(property), t.stringLiteral(value));
}

function collectFallbackExpressionConditionIndices(
  expression: FallbackExpression
): readonly number[] {
  const indices = new Set<number>();
  collectFallbackExpressionConditionIndex(expression, indices);
  return [...indices].sort((left, right) => left - right);
}

function collectFallbackExpressionConditionIndex(
  expression: FallbackExpression,
  indices: Set<number>
): void {
  if (expression.kind === "value") {
    return;
  }

  indices.add(expression.conditionIndex);
  collectFallbackExpressionConditionIndex(expression.whenTrue, indices);
  collectFallbackExpressionConditionIndex(expression.whenFalse, indices);
}

function serializeFallbackExpression(
  expression: FallbackExpression,
  hookPrefix: string
): string {
  if (expression.kind === "value") {
    return expression.value;
  }

  return `var(${hookName(
    hookPrefix,
    expression.conditionIndex,
    1
  )}, ${serializeFallbackExpression(expression.whenTrue, hookPrefix)}) var(${hookName(
    hookPrefix,
    expression.conditionIndex,
    0
  )}, ${serializeFallbackExpression(expression.whenFalse, hookPrefix)})`;
}

function hookName(
  hookPrefix: string,
  conditionIndex: number,
  branch: 0 | 1
): string {
  return `--${hookPrefix}-${conditionIndex}-${branch}`;
}

function createFallbackClassExpressions(
  operands: readonly FallbackOperandPlan[],
  conditions: readonly t.Expression[]
): readonly t.Expression[] | null {
  const expressions: t.Expression[] = [];

  for (const operand of operands) {
    if (!appendFallbackClassExpression(operand, conditions, expressions)) {
      return null;
    }
  }

  return expressions;
}

function appendFallbackClassExpression(
  operand: FallbackOperandPlan,
  conditions: readonly t.Expression[],
  expressions: t.Expression[]
): boolean {
  switch (operand.kind) {
    case "class":
      expressions.push(t.cloneNode(operand.classOperand.expression));
      return true;
    case "condition": {
      const condition = conditions[operand.conditionIndex];

      if (condition === undefined) {
        return false;
      }

      expressions.push(
        t.logicalExpression(
          "&&",
          t.cloneNode(condition),
          t.cloneNode(operand.classOperand.expression)
        )
      );
      return true;
    }
    case "ternary": {
      const condition = conditions[operand.conditionIndex];

      if (condition === undefined) {
        return false;
      }

      expressions.push(
        t.conditionalExpression(
          t.cloneNode(condition),
          t.cloneNode(operand.consequent.expression),
          t.cloneNode(operand.alternate.expression)
        )
      );
      return true;
    }
    case "array":
      for (const child of operand.operands) {
        if (!appendFallbackClassExpression(child, conditions, expressions)) {
          return false;
        }
      }
      return true;
  }
}

function createSwitchClassExpressions(
  conditions: readonly t.Expression[],
  identifiers: readonly t.Identifier[]
): readonly t.Expression[] | null {
  const expressions: t.Expression[] = [];

  for (
    let conditionIndex = 0;
    conditionIndex < identifiers.length;
    conditionIndex += 1
  ) {
    const condition = conditions[conditionIndex];
    const identifier = identifiers[conditionIndex];

    if (condition === undefined || identifier === undefined) {
      return null;
    }

    expressions.push(
      t.logicalExpression("&&", t.cloneNode(condition), t.cloneNode(identifier))
    );
  }

  return expressions;
}

function createClassNameJoinExpression(
  classExpressions: readonly t.Expression[]
): t.Expression {
  return t.callExpression(
    t.memberExpression(
      t.callExpression(
        t.memberExpression(
          t.arrayExpression([...classExpressions]),
          t.identifier("filter")
        ),
        [t.identifier("Boolean")]
      ),
      t.identifier("join")
    ),
    [t.stringLiteral(" ")]
  );
}
