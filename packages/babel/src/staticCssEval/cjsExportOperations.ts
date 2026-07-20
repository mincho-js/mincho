import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import { getDefinePropertyDescriptorExpression } from "./cjsExportDescriptors.js";
import { collectModuleReplacementOperations } from "./cjsExportModuleReplacement.js";
import { collectTopLevelCjsHelperAssignmentOperations } from "./cjsHelpers.js";
import {
  createExpressionSetOperation,
  createUnsupportedOperation
} from "./cjsExportOperationEntries.js";
import {
  formatAssignmentTarget,
  getCjsAssignmentTarget,
  getDefinePropertyExportName,
  getDefinePropertySurface,
  getTargetExportName,
  isObjectDefinePropertyCall,
  type StaticCssEvalCjsExportSurface
} from "./cjsExportTargets.js";
import type {
  StaticCssEvalCjsExportMapOperation,
  StaticCssEvalCjsExportState
} from "./cjsExports.js";

type StaticCssEvalBabelScope = NodePath<t.Node>["scope"];

export function collectAssignmentExpressionOperations(options: {
  readonly expression: t.AssignmentExpression;
  readonly declaration: t.Statement;
  readonly scope: StaticCssEvalBabelScope;
  readonly state: StaticCssEvalCjsExportState;
  readonly topLevel: boolean;
}): StaticCssEvalCjsExportMapOperation[] {
  const target = getCjsAssignmentTarget(options.expression.left, options.scope);

  if (target.kind === "not-cjs") {
    return [];
  }

  if (!options.topLevel) {
    if (target.kind === "module-replacement") {
      options.state.exportsAliasSafe = false;
      options.state.moduleObjectLike = false;
    }

    return [
      createUnsupportedOperation({
        declaration: options.declaration,
        exportName: getTargetExportName(target),
        mutation: `non-top-level ${formatAssignmentTarget(target)} assignment`,
        node: options.expression,
        state: options.state
      })
    ];
  }

  if (target.kind === "unsupported" || options.expression.operator !== "=") {
    const mutation =
      target.kind === "unsupported"
        ? target.mutation
        : `${formatAssignmentTarget(target)} ${options.expression.operator} assignment`;

    return [
      createUnsupportedOperation({
        declaration: options.declaration,
        exportName: getTargetExportName(target),
        mutation,
        node: options.expression,
        state: options.state
      })
    ];
  }

  if (target.kind === "module-replacement") {
    const helperOperations = collectTopLevelCjsHelperAssignmentOperations({
      declaration: options.declaration,
      expression: options.expression,
      scope: options.scope,
      state: options.state
    });

    if (helperOperations !== null) {
      return helperOperations;
    }

    return collectModuleReplacementOperations(options);
  }

  if (!isSurfaceAssignmentSafe(target.surface, options.state)) {
    return [
      createUnsupportedOperation({
        declaration: options.declaration,
        exportName: target.exportName,
        mutation: `${target.surface}.${target.exportName} assignment after module.exports replacement`,
        node: options.expression.left,
        state: options.state
      })
    ];
  }

  if (t.isAssignmentExpression(options.expression.right)) {
    return [
      { kind: "clear-cjs-exports" },
      createUnsupportedOperation({
        declaration: options.declaration,
        exportName: null,
        mutation: "chained CommonJS export assignment",
        node: options.expression,
        state: options.state
      })
    ];
  }

  return [
    createExpressionSetOperation(
      target.exportName,
      options.expression.right,
      options.declaration
    )
  ];
}

export function collectDefinePropertyOperations(options: {
  readonly expression: t.CallExpression;
  readonly declaration: t.Statement;
  readonly scope: StaticCssEvalBabelScope;
  readonly state: StaticCssEvalCjsExportState;
  readonly topLevel: boolean;
}): StaticCssEvalCjsExportMapOperation[] {
  if (!isObjectDefinePropertyCall(options.expression, options.scope)) {
    return [];
  }

  const surface = getDefinePropertySurface(options.expression, options.scope);

  if (!surface) {
    return [];
  }

  const exportName = getDefinePropertyExportName(options.expression);

  if (!options.topLevel || !exportName) {
    return [
      createUnsupportedOperation({
        declaration: options.declaration,
        exportName: exportName ?? null,
        mutation: options.topLevel
          ? "Object.defineProperty computed export name"
          : "non-top-level Object.defineProperty export descriptor",
        node: options.expression,
        state: options.state
      })
    ];
  }

  if (!isSurfaceAssignmentSafe(surface, options.state)) {
    return createAliasUnsafeDefinePropertyOperation({
      ...options,
      exportName,
      surface
    });
  }

  const descriptorResult = getDefinePropertyDescriptorExpression(
    options.expression
  );

  return descriptorResult.kind === "supported"
    ? [
        createExpressionSetOperation(
          exportName,
          descriptorResult.expression,
          options.declaration
        )
      ]
    : [
        createUnsupportedOperation({
          declaration: options.declaration,
          exportName,
          mutation: descriptorResult.mutation,
          node: options.expression,
          state: options.state
        })
      ];
}

function createAliasUnsafeDefinePropertyOperation(options: {
  readonly expression: t.CallExpression;
  readonly declaration: t.Statement;
  readonly exportName: string;
  readonly state: StaticCssEvalCjsExportState;
  readonly surface: StaticCssEvalCjsExportSurface;
}): StaticCssEvalCjsExportMapOperation[] {
  return [
    createUnsupportedOperation({
      declaration: options.declaration,
      exportName: options.exportName,
      mutation: `Object.defineProperty ${options.surface}.${options.exportName} after module.exports replacement`,
      node: options.expression,
      state: options.state
    })
  ];
}

function isSurfaceAssignmentSafe(
  surface: StaticCssEvalCjsExportSurface,
  state: StaticCssEvalCjsExportState
): boolean {
  return surface === "exports"
    ? state.exportsAliasSafe
    : state.moduleObjectLike;
}
