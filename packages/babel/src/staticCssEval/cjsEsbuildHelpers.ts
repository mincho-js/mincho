import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import {
  createBundleRuntimeUnsupportedOperation,
  createExpressionSetOperation,
  createHelperUnsupportedOperation
} from "./cjsExportOperationEntries.js";
import {
  getCjsAssignmentTarget,
  getCjsExportSurfaceExpression
} from "./cjsExportTargets.js";
import { getObjectKeyName } from "./cjsEsbuildHelperLookup.js";
import { isSupportedEsbuildExportHelper } from "./cjsEsbuildExportHelperFingerprint.js";
import { isSupportedEsbuildToCommonJsHelper } from "./cjsEsbuildToCommonJsHelperFingerprint.js";
import type {
  StaticCssEvalCjsExportMapOperation,
  StaticCssEvalCjsExportState
} from "./cjsExports.js";
import type { StaticCssEvalExportName } from "./types.js";

type StaticCssEvalBabelScope = NodePath<t.Node>["scope"];

const commonJsBundleRuntimeHelpers = new Set([
  "__commonJS",
  "__require",
  "__esm",
  "__webpack_modules__",
  "__webpack_require__",
  "__turbopack_context__",
  "__turbopack_require__",
  "$parcel$require",
  "parcelRequire",
  "webpackJsonp"
]);

export function collectEsbuildBundleRuntimeOperations(options: {
  readonly state: StaticCssEvalCjsExportState;
  readonly statementPath: NodePath<t.Statement>;
}): StaticCssEvalCjsExportMapOperation[] {
  const runtimeName = getEsbuildBundleRuntimeName(options.statementPath.node);

  return runtimeName
    ? [
        createBundleRuntimeUnsupportedOperation({
          declaration: options.statementPath.node,
          node: options.statementPath.node,
          runtimeName,
          state: options.state
        })
      ]
    : [];
}

export function collectEsbuildHelperOperations(options: {
  readonly expression: t.CallExpression;
  readonly state: StaticCssEvalCjsExportState;
  readonly statementPath: NodePath<t.Statement>;
}): StaticCssEvalCjsExportMapOperation[] | null {
  if (!t.isIdentifier(options.expression.callee, { name: "__export" })) {
    return null;
  }

  const [target, getters] = options.expression.arguments;
  const targetSurface = t.isExpression(target)
    ? getEsbuildExportTargetSurface(target, options.statementPath)
    : null;

  if (
    targetSurface === "pending" &&
    isSupportedEsbuildExportHelper("__export", options.statementPath.scope)
  )
    return [{ kind: "preserve-cjs-exports" }];

  if (
    !isSupportedEsbuildExportHelper("__export", options.statementPath.scope) ||
    !targetSurface ||
    (targetSurface === "exports"
      ? !options.state.exportsAliasSafe
      : !options.state.moduleObjectLike) ||
    !t.isObjectExpression(getters)
  ) {
    return [createEsbuildHelperUnsupportedOperation(options, null)];
  }

  return getters.properties.map((property) =>
    createEsbuildExportOperation({ ...options, property })
  );
}

function getEsbuildExportTargetSurface(
  target: t.Expression,
  statementPath: NodePath<t.Statement>
) {
  const { scope } = statementPath;
  const targetSurface = getCjsExportSurfaceExpression(target, scope);

  if (targetSurface || !t.isIdentifier(target)) {
    return targetSurface;
  }

  const binding = scope.getBinding(target.name);

  if (!binding || !binding.constant || !binding.path.isVariableDeclarator()) {
    return null;
  }

  const declarationPath = binding.path.parentPath;
  const programPath = statementPath.parentPath;

  if (
    !declarationPath?.isVariableDeclaration() ||
    !programPath?.isProgram() ||
    declarationPath.parentPath?.node !== programPath.node
  ) {
    return null;
  }

  const statements = programPath.node.body;
  const declarationIndex = statements.indexOf(declarationPath.node);
  const statementIndex = statements.indexOf(statementPath.node);

  if (declarationIndex < 0 || declarationIndex >= statementIndex) {
    return null;
  }

  const { init } = binding.path.node;
  if (
    t.isObjectExpression(init) &&
    init.properties.length === 0 &&
    binding.referencePaths.every((reference) => {
      const call = reference.parentPath;

      return (
        call?.isCallExpression() &&
        call.node.arguments[0] === reference.node &&
        t.isIdentifier(call.node.callee) &&
        ["__export", "__toCommonJS"].includes(call.node.callee.name)
      );
    }) &&
    statements.slice(statementIndex + 1).some(
      (statement) =>
        t.isExpressionStatement(statement) &&
        t.isAssignmentExpression(statement.expression) &&
        getCjsAssignmentTarget(statement.expression.left, scope).kind ===
          "module-replacement" &&
        t.isCallExpression(statement.expression.right) &&
        t.isIdentifier(statement.expression.right.callee, {
          name: "__toCommonJS"
        }) &&
        t.isIdentifier(statement.expression.right.arguments[0], {
          name: target.name
        }) &&
        isSupportedEsbuildToCommonJsHelper("__toCommonJS", scope)
    )
  )
    return "pending";

  const aliasSurface =
    init && t.isExpression(init)
      ? getCjsExportSurfaceExpression(init, binding.scope)
      : null;

  return aliasSurface === "module.exports" &&
    statements
      .slice(declarationIndex + 1, statementIndex)
      .some(
        (statement) =>
          t.isExpressionStatement(statement) &&
          t.isAssignmentExpression(statement.expression) &&
          getCjsAssignmentTarget(statement.expression.left, scope).kind ===
            "module-replacement"
      )
    ? null
    : aliasSurface;
}

export function collectEsbuildModuleReplacementOperations(options: {
  readonly declaration: t.Statement;
  readonly expression: t.AssignmentExpression;
  readonly scope: StaticCssEvalBabelScope;
  readonly state: StaticCssEvalCjsExportState;
}): StaticCssEvalCjsExportMapOperation[] | null {
  const target = getCjsAssignmentTarget(options.expression.left, options.scope);

  if (target.kind !== "module-replacement") {
    return null;
  }

  const right = options.expression.right;

  if (!t.isCallExpression(right) || !t.isIdentifier(right.callee)) {
    return null;
  }

  if (commonJsBundleRuntimeHelpers.has(right.callee.name)) {
    options.state.exportsAliasSafe = false;
    options.state.moduleObjectLike = false;

    return [
      { kind: "clear-cjs-exports" },
      createBundleRuntimeUnsupportedOperation({
        declaration: options.declaration,
        node: options.expression,
        runtimeName: right.callee.name,
        state: options.state
      })
    ];
  }

  if (right.callee.name !== "__toCommonJS") {
    return null;
  }

  const previousState = { ...options.state };
  options.state.exportsAliasSafe = false;
  options.state.moduleObjectLike = false;

  if (
    isSupportedEsbuildToCommonJsHelper(right.callee.name, options.scope) &&
    t.isIdentifier(right.arguments[0])
  ) {
    const name = right.arguments[0].name;
    const binding = options.scope.getBinding(name);
    const program = binding?.path.findParent((path) => path.isProgram());
    const staged: StaticCssEvalCjsExportMapOperation[] = [];
    const emptyStagingObject =
      binding?.constant &&
      binding.path.isVariableDeclarator() &&
      t.isObjectExpression(binding.path.node.init) &&
      binding.path.node.init.properties.length === 0 &&
      binding.referencePaths.every((reference) => {
        const call = reference.parentPath;

        return (
          call?.isCallExpression() &&
          call.node.arguments[0] === reference.node &&
          ((t.isIdentifier(call.node.callee, { name: "__toCommonJS" }) &&
            isSupportedEsbuildToCommonJsHelper("__toCommonJS", call.scope)) ||
            (t.isIdentifier(call.node.callee, { name: "__export" }) &&
              isSupportedEsbuildExportHelper("__export", call.scope)))
        );
      });

    if (program?.isProgram()) {
      for (const statement of program.get("body")) {
        if (statement.node === options.declaration) break;
        if (
          !statement.isExpressionStatement() ||
          !t.isCallExpression(statement.node.expression)
        )
          continue;

        const call = statement.node.expression;
        if (
          !t.isIdentifier(call.callee, { name: "__export" }) ||
          !t.isIdentifier(call.arguments[0], { name }) ||
          getEsbuildExportTargetSurface(call.arguments[0], statement) !==
            "pending" ||
          !isSupportedEsbuildExportHelper("__export", statement.scope) ||
          !t.isObjectExpression(call.arguments[1])
        )
          continue;

        for (const property of call.arguments[1].properties)
          staged.push(
            createEsbuildExportOperation({
              expression: call,
              property,
              state: options.state,
              statementPath: statement
            })
          );
      }
    }

    if (staged.length || emptyStagingObject) {
      options.state.moduleObjectLike = true;

      return [{ kind: "clear-cjs-exports" }, ...staged];
    }
  }

  const statement = options.scope
    .getProgramParent()
    .path.get("body")
    .find((path) => path.node === options.declaration);

  const surface =
    statement?.isStatement() && t.isExpression(right.arguments[0])
      ? getEsbuildExportTargetSurface(right.arguments[0], statement)
      : null;

  const supported =
    isSupportedEsbuildToCommonJsHelper(right.callee.name, options.scope) &&
    (surface === "exports"
      ? previousState.exportsAliasSafe
      : surface === "module.exports" && previousState.moduleObjectLike);

  if (supported) options.state.moduleObjectLike = true;

  return supported
    ? [{ kind: "preserve-cjs-exports" }]
    : [
        { kind: "clear-cjs-exports" },
        createHelperUnsupportedOperation({
          declaration: options.declaration,
          exportName: null,
          helperName: right.callee.name,
          node: options.expression,
          state: options.state
        })
      ];
}

function createEsbuildExportOperation(options: {
  readonly expression: t.CallExpression;
  readonly property: t.ObjectExpression["properties"][number];
  readonly state: StaticCssEvalCjsExportState;
  readonly statementPath: NodePath<t.Statement>;
}): StaticCssEvalCjsExportMapOperation {
  const exportName = getEsbuildExportName(options.property);
  const expression = getEsbuildGetterExpression(options.property);

  return exportName && expression
    ? createExpressionSetOperation(
        exportName,
        expression,
        options.statementPath.node
      )
    : createEsbuildHelperUnsupportedOperation(options, exportName);
}

function getEsbuildExportName(
  property: t.ObjectExpression["properties"][number]
): StaticCssEvalExportName {
  return t.isObjectProperty(property) && !property.computed
    ? getObjectKeyName(property.key)
    : null;
}

function getEsbuildGetterExpression(
  property: t.ObjectExpression["properties"][number]
): t.Expression | null {
  if (
    !t.isObjectProperty(property) ||
    !t.isArrowFunctionExpression(property.value) ||
    property.value.params.length !== 0 ||
    !t.isExpression(property.value.body)
  ) {
    return null;
  }

  return t.isIdentifier(property.value.body) ||
    t.isMemberExpression(property.value.body)
    ? property.value.body
    : null;
}

function createEsbuildHelperUnsupportedOperation(
  options: {
    readonly expression: t.CallExpression;
    readonly state: StaticCssEvalCjsExportState;
    readonly statementPath: NodePath<t.Statement>;
  },
  exportName: StaticCssEvalExportName
): StaticCssEvalCjsExportMapOperation {
  return createHelperUnsupportedOperation({
    declaration: options.statementPath.node,
    exportName,
    helperName: "__export",
    node: options.expression,
    state: options.state
  });
}

function getEsbuildBundleRuntimeName(statement: t.Statement): string | null {
  if (t.isFunctionDeclaration(statement) && statement.id) {
    return commonJsBundleRuntimeHelpers.has(statement.id.name)
      ? statement.id.name
      : null;
  }

  if (t.isVariableDeclaration(statement)) {
    for (const declaration of statement.declarations) {
      const idName = t.isIdentifier(declaration.id)
        ? declaration.id.name
        : null;

      const calleeName = getCallCalleeName(declaration.init);

      if (idName && commonJsBundleRuntimeHelpers.has(idName)) {
        return idName;
      }

      if (calleeName && commonJsBundleRuntimeHelpers.has(calleeName)) {
        return calleeName;
      }
    }
  }

  if (!t.isExpressionStatement(statement)) {
    return null;
  }

  const calleeName = t.isAssignmentExpression(statement.expression)
    ? getCallCalleeName(statement.expression.right)
    : getCallCalleeName(statement.expression);

  return calleeName && commonJsBundleRuntimeHelpers.has(calleeName)
    ? calleeName
    : null;
}

function getCallCalleeName(node: t.Node | null | undefined): string | null {
  return t.isCallExpression(node) && t.isIdentifier(node.callee)
    ? node.callee.name
    : null;
}
