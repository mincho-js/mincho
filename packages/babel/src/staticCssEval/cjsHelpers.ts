import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import { getStaticCssEvalLiteralRequireImportPath } from "./cjsBindings.js";
import {
  collectEsbuildBundleRuntimeOperations,
  collectEsbuildHelperOperations,
  collectEsbuildModuleReplacementOperations
} from "./cjsEsbuildHelpers.js";
import {
  isSupportedTscCreateBindingHelper,
  isSupportedTscExportStarHelper
} from "./cjsHelperFingerprints.js";
import { createHelperUnsupportedOperation } from "./cjsExportOperationEntries.js";
import { getCjsExportSurfaceExpression } from "./cjsExportTargets.js";
import type { ImportedStaticCssEvalCjsBinding } from "./cjsBindings.js";
import type {
  StaticCssEvalCjsExportMapOperation,
  StaticCssEvalCjsExportState
} from "./cjsExports.js";
import type { ExportMapReexportEntry } from "./moduleCache.js";

export function collectTopLevelCjsHelperOperations(options: {
  readonly cjsImports: ReadonlyMap<string, ImportedStaticCssEvalCjsBinding>;
  readonly state: StaticCssEvalCjsExportState;
  readonly statementPath: NodePath<t.Statement>;
}): StaticCssEvalCjsExportMapOperation[] {
  const bundleRuntimeOperations = collectEsbuildBundleRuntimeOperations({
    state: options.state,
    statementPath: options.statementPath
  });

  if (bundleRuntimeOperations.length > 0) {
    return bundleRuntimeOperations;
  }

  if (!options.statementPath.isExpressionStatement()) {
    return [];
  }

  const { expression } = options.statementPath.node;

  if (!t.isCallExpression(expression) || !t.isIdentifier(expression.callee)) {
    return [];
  }

  const esbuildOperations = collectEsbuildHelperOperations({
    expression,
    state: options.state,
    statementPath: options.statementPath
  });

  if (esbuildOperations !== null) {
    return esbuildOperations;
  }

  if (expression.callee.name === "__createBinding") {
    return [collectCreateBindingOperation({ ...options, expression })];
  }

  return expression.callee.name === "__exportStar"
    ? [collectExportStarOperation({ ...options, expression })]
    : [];
}

export function collectTopLevelCjsHelperAssignmentOperations(options: {
  readonly declaration: t.Statement;
  readonly expression: t.AssignmentExpression;
  readonly scope: NodePath<t.Node>["scope"];
  readonly state: StaticCssEvalCjsExportState;
}): StaticCssEvalCjsExportMapOperation[] | null {
  return collectEsbuildModuleReplacementOperations(options);
}

function collectCreateBindingOperation(options: {
  readonly cjsImports: ReadonlyMap<string, ImportedStaticCssEvalCjsBinding>;
  readonly expression: t.CallExpression;
  readonly state: StaticCssEvalCjsExportState;
  readonly statementPath: NodePath<t.Statement>;
}): StaticCssEvalCjsExportMapOperation {
  const helperName = "__createBinding";
  const [target, source, importedName, exportedName] =
    options.expression.arguments;
  const targetSurface = t.isExpression(target)
    ? getCjsExportSurfaceExpression(target, options.statementPath.scope)
    : null;
  const sourceBinding = t.isIdentifier(source)
    ? options.cjsImports.get(source.name)
    : undefined;

  if (
    !isSupportedTscCreateBindingHelper(
      helperName,
      options.statementPath.scope
    ) ||
    !targetSurface ||
    !isSurfaceAssignmentSafe(targetSurface, options.state) ||
    !sourceBinding ||
    sourceBinding.kind !== "cjs-module" ||
    !t.isStringLiteral(importedName) ||
    (exportedName !== undefined && !t.isStringLiteral(exportedName))
  ) {
    return createHelperUnsupportedOperation({
      declaration: options.statementPath.node,
      exportName: t.isStringLiteral(exportedName)
        ? exportedName.value
        : t.isStringLiteral(importedName)
          ? importedName.value
          : null,
      helperName,
      node: options.expression,
      state: options.state
    });
  }

  return {
    kind: "set",
    entry: createReexportEntry({
      declaration: options.statementPath.node,
      exportName: exportedName?.value ?? importedName.value,
      importedName: importedName.value,
      source: sourceBinding.importPath
    })
  };
}

function collectExportStarOperation(options: {
  readonly expression: t.CallExpression;
  readonly state: StaticCssEvalCjsExportState;
  readonly statementPath: NodePath<t.Statement>;
}): StaticCssEvalCjsExportMapOperation {
  const helperName = "__exportStar";
  const [source, target] = options.expression.arguments;
  const targetSurface = t.isExpression(target)
    ? getCjsExportSurfaceExpression(target, options.statementPath.scope)
    : null;
  const importPath = t.isExpression(source)
    ? getStaticCssEvalLiteralRequireImportPath(
        source,
        options.statementPath.scope
      )
    : null;

  if (
    !isSupportedTscExportStarHelper(helperName, options.statementPath.scope) ||
    !targetSurface ||
    !isSurfaceAssignmentSafe(targetSurface, options.state) ||
    !importPath
  ) {
    return createHelperUnsupportedOperation({
      declaration: options.statementPath.node,
      exportName: null,
      helperName,
      node: options.expression,
      state: options.state
    });
  }

  return {
    kind: "star-reexport",
    entry: {
      kind: "star-reexport",
      exportName: "*",
      source: importPath,
      declaration: options.statementPath.node
    }
  };
}

function createReexportEntry(options: {
  readonly declaration: t.Statement;
  readonly exportName: string;
  readonly importedName: string;
  readonly source: string;
}): ExportMapReexportEntry {
  return {
    kind: "reexport",
    exportName: options.exportName,
    importedName: options.importedName,
    source: options.source,
    declaration: options.declaration
  };
}

function isSurfaceAssignmentSafe(
  surface: "exports" | "module.exports",
  state: StaticCssEvalCjsExportState
): boolean {
  return surface === "exports"
    ? state.exportsAliasSafe
    : state.moduleObjectLike;
}
