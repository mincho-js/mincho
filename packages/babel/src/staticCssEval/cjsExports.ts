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

    operations.push(
      ...(directOperations.length > 0
        ? directOperations
        : helperOperations.length > 0
          ? helperOperations
          : collectNestedCjsExportUnsupportedOperations(statementPath, state))
    );
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
  state: StaticCssEvalCjsExportState
): StaticCssEvalCjsExportMapOperation[] {
  const operations: StaticCssEvalCjsExportMapOperation[] = [];

  statementPath.traverse({
    AssignmentExpression(path) {
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
      operations.push(
        ...collectDefinePropertyOperations({
          expression: path.node,
          declaration: statementPath.node,
          scope: path.scope,
          state,
          topLevel: false
        })
      );
    }
  });

  return operations;
}
