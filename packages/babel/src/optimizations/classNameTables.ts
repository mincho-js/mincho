import { types as t, type NodePath } from "@babel/core";
import type {
  ModuleGraph,
  ModuleGraphFlow,
  SourceModule
} from "../moduleGraph.js";
import { readSidecarString } from "./sidecarStrings.js";
import { expressionKey } from "./pureFunctions.js";

interface Choices {
  values: string[];
  index: t.Expression;
  fromSidecar: boolean;
}

/** Per-module string payload bounds, not estimates of the JavaScript heap. */
const maxUnits = 4096;
const maxEntries = 256;

export function isClassNameJoin(path: NodePath<t.BinaryExpression>): boolean {
  return (
    path.node.operator === "+" &&
    !path.parentPath.isBinaryExpression({ operator: "+" }) &&
    !!path.findParent(
      (parent) =>
        parent.isJSXAttribute() &&
        t.isJSXIdentifier(parent.node.name, { name: "className" })
    )
  );
}

export function* createClassNameTables(
  graph: ModuleGraph,
  owner: SourceModule
): ModuleGraphFlow<{ key: string; expression: t.Expression }[]> {
  const candidates: NodePath<t.BinaryExpression>[] = [];
  owner.program.traverse({
    BinaryExpression(path) {
      if (isClassNameJoin(path)) candidates.push(path);
    }
  });

  const replacements: { key: string; expression: t.Expression }[] = [];
  let remainingUnits = maxUnits;
  let remainingEntries = maxEntries;

  for (const path of candidates) {
    try {
      const result = yield* choices(path, graph, owner);
      const units = result.values.reduce((sum, value) => sum + value.length, 0);
      if (
        !result.fromSidecar ||
        result.values.length < 2 ||
        units > remainingUnits ||
        result.values.length > remainingEntries
      )
        continue;

      const table =
        owner.program.scope.generateUidIdentifier("minchoClassNames");

      owner.program.scope.push({
        id: t.cloneNode(table),
        kind: "const",
        init: t.arrayExpression(
          result.values.map((value) => t.stringLiteral(value))
        )
      });
      replacements.push({
        key: expressionKey(path),
        expression: t.memberExpression(t.cloneNode(table), result.index, true)
      });
      remainingUnits -= units;
      remainingEntries -= result.values.length;
    } catch {
      // Unknown values, cyclic bindings and oversized products keep concatenation.
    }
  }

  return replacements;
}

function* choices(
  path: NodePath<t.Node>,
  graph: ModuleGraph,
  owner: SourceModule
): ModuleGraphFlow<Choices> {
  if (path.isStringLiteral())
    return bounded({
      values: [path.node.value],
      index: t.numericLiteral(0),
      fromSidecar: false
    });

  if (path.isConditionalExpression()) {
    const left = yield* choices(path.get("consequent"), graph, owner);
    const right = yield* choices(path.get("alternate"), graph, owner);

    return bounded({
      values: [...left.values, ...right.values],
      index: t.conditionalExpression(
        t.cloneNode(path.node.test),
        left.index,
        offset(right.index, left.values.length)
      ),
      fromSidecar: left.fromSidecar || right.fromSidecar
    });
  }

  if (path.isBinaryExpression({ operator: "+" })) {
    const left = yield* choices(path.get("left"), graph, owner);
    const right = yield* choices(path.get("right"), graph, owner);
    if (left.values.length * right.values.length > maxEntries)
      throw new Error("Class combination bound");

    const index =
      right.values.length === 1
        ? left.index
        : t.binaryExpression(
            "*",
            left.index,
            t.numericLiteral(right.values.length)
          );

    return bounded({
      values: left.values.flatMap((left) =>
        right.values.map((right) => left + right)
      ),
      index: t.isNumericLiteral(right.index, { value: 0 })
        ? index
        : t.binaryExpression("+", index, right.index),
      fromSidecar: left.fromSidecar || right.fromSidecar
    });
  }

  const value = yield* readSidecarString(graph, owner, path);

  return bounded({
    values: [value],
    index: t.numericLiteral(0),
    fromSidecar: true
  });
}

function offset(index: t.Expression, value: number): t.Expression {
  return t.isNumericLiteral(index)
    ? t.numericLiteral(index.value + value)
    : t.binaryExpression("+", index, t.numericLiteral(value));
}

function bounded(result: Choices): Choices {
  if (
    result.values.length > maxEntries ||
    result.values.reduce((sum, value) => sum + value.length, 0) > maxUnits
  )
    throw new Error("Class string payload bound");

  return result;
}
