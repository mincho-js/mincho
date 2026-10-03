import { types as t, type NodePath } from "@babel/core";
import { getObjectKeyName } from "./cjsExportDescriptors.js";
import {
  createExpressionSetOperation,
  createUnsupportedOperation
} from "./cjsExportOperationEntries.js";
import type {
  StaticCssEvalCjsExportMapOperation,
  StaticCssEvalCjsExportState
} from "./cjsExports.js";

export function collectModuleReplacementOperations(options: {
  readonly expression: t.AssignmentExpression;
  readonly declaration: t.Statement;
  readonly state: StaticCssEvalCjsExportState;
  readonly scope: NodePath<t.Node>["scope"];
}): StaticCssEvalCjsExportMapOperation[] {
  options.state.exportsAliasSafe = false;

  const operations: StaticCssEvalCjsExportMapOperation[] = [
    { kind: "clear-cjs-exports" }
  ];

  if (t.isArrayExpression(options.expression.right)) {
    options.state.moduleObjectLike = false;

    return [
      ...operations,
      createExpressionSetOperation(
        null,
        options.expression.right,
        options.declaration
      )
    ];
  }

  if (!t.isObjectExpression(options.expression.right)) {
    const right = options.expression.right;
    const binding = t.isIdentifier(right)
      ? options.scope.getBinding(right.name)
      : undefined;

    options.state.moduleObjectLike =
      t.isFunction(right) ||
      Boolean(
        binding?.constant &&
        (binding.path.isFunctionDeclaration() ||
          (binding.path.isVariableDeclarator() &&
            t.isFunction(binding.path.node.init)))
      );

    return [
      ...operations,
      createExpressionSetOperation(
        null,
        options.expression.right,
        options.declaration
      )
    ];
  }

  operations.push(
    createExpressionSetOperation(
      null,
      options.expression.right,
      options.declaration
    )
  );

  for (const property of options.expression.right.properties) {
    if (!t.isObjectProperty(property) || property.computed) {
      options.state.moduleObjectLike = false;

      return [
        ...operations,
        createUnsupportedOperation({
          declaration: options.declaration,
          exportName: null,
          mutation:
            "module.exports object replacement contains unsupported property",
          node: property,
          state: options.state
        })
      ];
    }

    const exportName = getObjectKeyName(property.key);

    if (!exportName || !t.isExpression(property.value)) {
      options.state.moduleObjectLike = false;

      return [
        ...operations,
        createUnsupportedOperation({
          declaration: options.declaration,
          exportName: exportName ?? null,
          mutation:
            "module.exports object replacement contains unsupported value",
          node: property,
          state: options.state
        })
      ];
    }

    operations.push(
      createExpressionSetOperation(
        exportName,
        property.value,
        options.declaration
      )
    );
  }

  options.state.moduleObjectLike = true;

  return operations;
}
