import { types as t } from "@babel/core";
import type { StaticData } from "./runtimeExpressions.js";

export type FiniteRecipeTree =
  | { argument: t.Expression; index: number }
  | {
      test: t.Expression;
      consequent: FiniteRecipeTree;
      alternate: FiniteRecipeTree;
    };

/** Expand only literal containers. All runtime effects remain in the original tests. */
export function finiteRecipeTree(
  expression: t.Expression
): FiniteRecipeTree | null {
  let leaves = 0;
  const tests = new Set<t.Node>();

  const scan = (node: t.Node): void => {
    if (t.isConditionalExpression(node)) {
      tests.add(node);
      scan(node.consequent);
      scan(node.alternate);
    } else if (t.isObjectExpression(node)) {
      for (const property of node.properties) {
        if (
          !t.isObjectProperty(property) ||
          property.computed ||
          !t.isExpression(property.value)
        )
          throw new Error("Unproved selection container");

        scan(property.value);
      }
    } else if (t.isArrayExpression(node)) {
      for (const item of node.elements) {
        if (!item || !t.isExpression(item))
          throw new Error("Unproved selection array");

        scan(item);
      }
    } else if (
      !t.isLiteral(node) &&
      !(
        t.isUnaryExpression(node) &&
        ((node.operator === "void" && t.isNumericLiteral(node.argument)) ||
          (node.operator === "-" && t.isNumericLiteral(node.argument)))
      )
    )
      throw new Error("Non-literal selection");
  };

  const expand = (node: t.Expression): FiniteRecipeTree => {
    const split = firstDecision(node);

    if (!split) {
      if (++leaves > 16) throw new Error("Finite selection budget");

      return { argument: node, index: leaves - 1 };
    }

    return {
      test: split.test,
      consequent: expand(split.consequent),
      alternate: expand(split.alternate)
    };
  };

  try {
    scan(expression);

    if (!tests.size || tests.size > 4) return null;

    return expand(expression);
  } catch {
    return null;
  }
}

function firstDecision(node: t.Expression): {
  test: t.Expression;
  consequent: t.Expression;
  alternate: t.Expression;
} | null {
  if (t.isConditionalExpression(node)) return node;

  if (t.isObjectExpression(node)) {
    for (let index = 0; index < node.properties.length; index++) {
      const property = node.properties[index]!;
      if (!t.isObjectProperty(property) || !t.isExpression(property.value))
        return null;

      const decision = firstDecision(property.value);
      if (!decision) continue;

      const replace = (value: t.Expression) => {
        const clone = t.cloneNode(node);
        (clone.properties[index] as t.ObjectProperty).value = value;

        return clone;
      };

      return {
        test: decision.test,
        consequent: replace(decision.consequent),
        alternate: replace(decision.alternate)
      };
    }
  }

  if (t.isArrayExpression(node)) {
    for (let index = 0; index < node.elements.length; index++) {
      const item = node.elements[index];
      if (!item || !t.isExpression(item)) return null;

      const decision = firstDecision(item);
      if (!decision) continue;

      const replace = (value: t.Expression) => {
        const clone = t.cloneNode(node);
        clone.elements[index] = value;

        return clone;
      };

      return {
        test: decision.test,
        consequent: replace(decision.consequent),
        alternate: replace(decision.alternate)
      };
    }
  }

  return null;
}

export function mapFiniteRecipeTree(
  tree: FiniteRecipeTree,
  values: readonly string[]
): t.Expression {
  return "index" in tree
    ? t.stringLiteral(values[tree.index]!)
    : t.conditionalExpression(
        t.cloneNode(tree.test),
        mapFiniteRecipeTree(tree.consequent, values),
        mapFiniteRecipeTree(tree.alternate, values)
      );
}

export function finiteArgument(node: t.Expression): StaticData {
  if (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node)
  )
    return node.value;
  if (t.isNullLiteral(node)) return null;

  if (t.isUnaryExpression(node)) {
    if (node.operator === "void") return undefined;
    if (node.operator === "-" && t.isNumericLiteral(node.argument))
      return -node.argument.value;
  }

  if (t.isArrayExpression(node))
    return node.elements.map((item) => finiteArgument(item as t.Expression));

  if (t.isObjectExpression(node)) {
    const result: Record<string, StaticData> = Object.create(null);

    for (const property of node.properties) {
      if (
        !t.isObjectProperty(property) ||
        property.computed ||
        !t.isExpression(property.value)
      )
        throw new Error("Non-literal property");

      const key = t.isIdentifier(property.key)
        ? property.key.name
        : t.isStringLiteral(property.key) || t.isNumericLiteral(property.key)
          ? String(property.key.value)
          : null;
      if (key === null || key === "__proto__")
        throw new Error("Non-literal key");

      result[key] = finiteArgument(property.value);
    }

    return result;
  }

  throw new Error("Non-literal leaf");
}
