import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import { collectStaticCssEvalCjsRequireBindings } from "./cjsBindings.js";
import {
  collectAssignmentExpressionOperations,
  collectDefinePropertyOperations
} from "./cjsExportOperations.js";
import { collectTopLevelCjsHelperOperations } from "./cjsHelpers.js";
import type { ExportMapEntry } from "./moduleCache.js";
import type { ExportGraphStarReexportEntry } from "./moduleCache.js";
import { createUnsupportedOperation } from "./cjsExportOperationEntries.js";
import {
  getCjsAssignmentTarget,
  getTargetExportName,
  formatAssignmentTarget
} from "./cjsExportTargets.js";

export type StaticCssEvalCjsExportMapOperation =
  | { readonly kind: "clear-cjs-exports" }
  | { readonly kind: "preserve-cjs-exports" }
  | { readonly kind: "set"; readonly entry: ExportMapEntry }
  | {
      readonly kind: "star-reexport";
      readonly entry: ExportGraphStarReexportEntry;
    };

interface StaticCssEvalCjsExportCollectorOptions {
  readonly file: string;
  readonly programPath: NodePath<t.Program>;
}

export type StaticCssEvalCjsExportState = {
  readonly file: string;
  exportsAliasSafe: boolean;
  moduleObjectLike: boolean;
};

export function collectStaticCssEvalCjsExportMapOperations(
  options: StaticCssEvalCjsExportCollectorOptions
): StaticCssEvalCjsExportMapOperation[] {
  const state: StaticCssEvalCjsExportState = {
    file: options.file,
    exportsAliasSafe: true,
    moduleObjectLike: true
  };

  const operations: StaticCssEvalCjsExportMapOperation[] = [];
  const cjsImports = collectStaticCssEvalCjsRequireBindings(
    options.programPath
  );

  for (const statementPath of options.programPath.get("body")) {
    // esbuild emits this unreachable assignment for Node's named-export lexer.
    if (
      statementPath.isExpressionStatement() &&
      t.isLogicalExpression(statementPath.node.expression, {
        operator: "&&"
      }) &&
      t.isNumericLiteral(statementPath.node.expression.left, { value: 0 })
    )
      continue;

    const directOperations = collectTopLevelCjsExportOperations(
      statementPath,
      state
    );

    const helperOperations =
      directOperations.length === 0
        ? collectTopLevelCjsHelperOperations({
            cjsImports,
            state,
            statementPath
          })
        : [];

    const explicitOperations =
      directOperations.length > 0 ? directOperations : helperOperations;
    const statementOperations = [
      ...explicitOperations,
      ...collectNestedCjsExportUnsupportedOperations(
        statementPath,
        state,
        explicitOperations.length > 0 && statementPath.isExpressionStatement()
          ? statementPath.node.expression
          : undefined
      )
    ];

    for (const operation of statementOperations) {
      // An unknown export key or replacement can overwrite any earlier export.
      // Keep later definite writes eligible without retaining stale named values.
      if (
        operation.kind === "set" &&
        operation.entry.kind === "unsupported" &&
        operation.entry.exportName === null
      )
        operations.push({ kind: "clear-cjs-exports" });

      operations.push(operation);
    }
  }

  return operations;
}

function collectTopLevelCjsExportOperations(
  statementPath: NodePath<t.Statement>,
  state: StaticCssEvalCjsExportState
): StaticCssEvalCjsExportMapOperation[] {
  if (!statementPath.isExpressionStatement()) {
    return [];
  }

  const { expression } = statementPath.node;
  const baseOptions = {
    declaration: statementPath.node,
    scope: statementPath.scope,
    state,
    topLevel: true
  };

  if (t.isAssignmentExpression(expression)) {
    return collectAssignmentExpressionOperations({
      ...baseOptions,
      expression
    });
  }

  return t.isCallExpression(expression)
    ? collectDefinePropertyOperations({ ...baseOptions, expression })
    : [];
}

function collectNestedCjsExportUnsupportedOperations(
  statementPath: NodePath<t.Statement>,
  state: StaticCssEvalCjsExportState,
  handledExpression?: t.Expression
): StaticCssEvalCjsExportMapOperation[] {
  const operations: StaticCssEvalCjsExportMapOperation[] = [];

  function unsupportedTarget(
    targetNode: t.Node,
    scope: NodePath<t.Node>["scope"],
    node: t.Node,
    mutation: string
  ): void {
    if (
      t.isIdentifier(targetNode, { name: "exports" }) &&
      !scope.hasBinding("exports")
    ) {
      state.exportsAliasSafe = false;
      operations.push(
        createUnsupportedOperation({
          declaration: statementPath.node,
          exportName: null,
          mutation: "reassigning the CommonJS exports alias",
          node,
          state
        })
      );
      return;
    }
    if (t.isObjectPattern(targetNode)) {
      for (const property of targetNode.properties)
        unsupportedTarget(
          t.isRestElement(property) ? property.argument : property.value,
          scope,
          node,
          mutation
        );
      return;
    }
    if (t.isArrayPattern(targetNode)) {
      for (const element of targetNode.elements)
        if (element) unsupportedTarget(element, scope, node, mutation);
      return;
    }
    if (t.isAssignmentPattern(targetNode) || t.isRestElement(targetNode)) {
      unsupportedTarget(
        t.isRestElement(targetNode) ? targetNode.argument : targetNode.left,
        scope,
        node,
        mutation
      );
      return;
    }
    if (!t.isMemberExpression(targetNode)) return;

    const target = getCjsAssignmentTarget(targetNode, scope);
    if (target.kind === "not-cjs") return;
    if (target.kind === "module-replacement") {
      state.exportsAliasSafe = false;
      state.moduleObjectLike = false;
    }
    operations.push(
      createUnsupportedOperation({
        declaration: statementPath.node,
        exportName: getTargetExportName(target),
        mutation: `${mutation} ${formatAssignmentTarget(target)}`,
        node,
        state
      })
    );
  }

  if (statementPath.isForInStatement() || statementPath.isForOfStatement())
    unsupportedTarget(
      statementPath.node.left,
      statementPath.scope,
      statementPath.node,
      "loop assignment to"
    );

  statementPath.traverse({
    AssignmentExpression(path) {
      if (path.node === handledExpression) return;
      if (t.isPattern(path.node.left) || t.isIdentifier(path.node.left))
        unsupportedTarget(
          path.node.left,
          path.scope,
          path.node,
          "destructuring assignment to"
        );

      operations.push(
        ...collectAssignmentExpressionOperations({
          expression: path.node,
          declaration: statementPath.node,
          scope: path.scope,
          state,
          topLevel: false
        })
      );
    },

    CallExpression(path) {
      if (path.node === handledExpression) return;
      operations.push(
        ...collectDefinePropertyOperations({
          expression: path.node,
          declaration: statementPath.node,
          scope: path.scope,
          state,
          topLevel: false
        })
      );
    },

    UpdateExpression(path) {
      unsupportedTarget(path.node.argument, path.scope, path.node, "update of");
    },

    UnaryExpression(path) {
      if (path.node.operator === "delete")
        unsupportedTarget(
          path.node.argument,
          path.scope,
          path.node,
          "delete of"
        );
    },

    "ForInStatement|ForOfStatement"(path) {
      const statement = path.node as t.ForInStatement | t.ForOfStatement;
      unsupportedTarget(
        statement.left,
        path.scope,
        statement,
        "loop assignment to"
      );
    }
  });

  return operations;
}
