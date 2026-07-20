import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import type { StaticCssEvalExportName } from "./types.js";

type StaticCssEvalBabelScope = NodePath<t.Node>["scope"];

export type StaticCssEvalCjsExportSurface = "exports" | "module.exports";

export type StaticCssEvalCjsAssignmentTarget =
  | { readonly kind: "not-cjs" }
  | { readonly kind: "module-replacement" }
  | {
      readonly kind: "property";
      readonly exportName: string;
      readonly surface: StaticCssEvalCjsExportSurface;
    }
  | {
      readonly kind: "unsupported";
      readonly exportName: StaticCssEvalExportName;
      readonly mutation: string;
    };

export function getCjsAssignmentTarget(
  left: t.LVal | t.OptionalMemberExpression,
  scope: StaticCssEvalBabelScope
): StaticCssEvalCjsAssignmentTarget {
  const directTarget = getDirectCjsAssignmentTarget(left, scope);

  if (directTarget.kind !== "not-cjs" || !t.isMemberExpression(left)) {
    return directTarget;
  }

  if (!t.isMemberExpression(left.object)) {
    return directTarget;
  }

  const outerTarget = getDirectCjsAssignmentTarget(left.object, scope);

  if (outerTarget.kind === "unsupported") {
    return outerTarget;
  }

  return outerTarget.kind === "property"
    ? {
        kind: "unsupported",
        exportName: outerTarget.exportName,
        mutation: `nested ${outerTarget.surface}.${outerTarget.exportName} property assignment`
      }
    : directTarget;
}

function getDirectCjsAssignmentTarget(
  left: t.LVal | t.OptionalMemberExpression,
  scope: StaticCssEvalBabelScope
): StaticCssEvalCjsAssignmentTarget {
  if (!t.isMemberExpression(left)) {
    return { kind: "not-cjs" };
  }

  if (isModuleExportsExpression(left, scope)) {
    return { kind: "module-replacement" };
  }

  if (t.isIdentifier(left.object) && isExportsIdentifier(left.object, scope)) {
    return getPropertyAssignmentTarget("exports", left);
  }

  return t.isExpression(left.object) &&
    isModuleExportsExpression(left.object, scope)
    ? getPropertyAssignmentTarget("module.exports", left)
    : { kind: "not-cjs" };
}

export function isObjectDefinePropertyCall(
  expression: t.CallExpression,
  scope: StaticCssEvalBabelScope
): boolean {
  return (
    t.isMemberExpression(expression.callee) &&
    !expression.callee.computed &&
    t.isIdentifier(expression.callee.object, { name: "Object" }) &&
    !scope.getBinding("Object") &&
    t.isIdentifier(expression.callee.property, { name: "defineProperty" })
  );
}

export function getDefinePropertySurface(
  expression: t.CallExpression,
  scope: StaticCssEvalBabelScope
): StaticCssEvalCjsExportSurface | null {
  const [target] = expression.arguments;

  if (!target || !t.isExpression(target)) {
    return null;
  }

  return getCjsExportSurfaceExpression(target, scope);
}

export function getCjsExportSurfaceExpression(
  expression: t.Expression,
  scope: StaticCssEvalBabelScope
): StaticCssEvalCjsExportSurface | null {
  if (t.isIdentifier(expression) && isExportsIdentifier(expression, scope)) {
    return "exports";
  }

  return isModuleExportsExpression(expression, scope) ? "module.exports" : null;
}

export function getDefinePropertyExportName(
  expression: t.CallExpression
): string | null {
  const [, exportName] = expression.arguments;

  return exportName && t.isStringLiteral(exportName) ? exportName.value : null;
}

export function getTargetExportName(
  target: Exclude<StaticCssEvalCjsAssignmentTarget, { kind: "not-cjs" }>
): StaticCssEvalExportName {
  return target.kind === "module-replacement" ? null : target.exportName;
}

export function formatAssignmentTarget(
  target: Exclude<StaticCssEvalCjsAssignmentTarget, { kind: "not-cjs" }>
): string {
  if (target.kind === "module-replacement") {
    return "module.exports";
  }

  return target.kind === "property"
    ? `${target.surface}.${target.exportName}`
    : "computed commonjs export";
}

function getPropertyAssignmentTarget(
  surface: StaticCssEvalCjsExportSurface,
  expression: t.MemberExpression
): StaticCssEvalCjsAssignmentTarget {
  const exportName = getNonComputedMemberPropertyName(expression);

  return exportName
    ? { kind: "property", exportName, surface }
    : {
        kind: "unsupported",
        exportName: null,
        mutation: `computed ${surface} export assignment`
      };
}

function isExportsIdentifier(
  expression: t.Identifier,
  scope: StaticCssEvalBabelScope
): boolean {
  return expression.name === "exports" && !scope.getBinding("exports");
}

function isModuleExportsExpression(
  expression: t.Expression,
  scope: StaticCssEvalBabelScope
): boolean {
  return (
    t.isMemberExpression(expression) &&
    !expression.computed &&
    t.isIdentifier(expression.object, { name: "module" }) &&
    !scope.getBinding("module") &&
    t.isIdentifier(expression.property, { name: "exports" })
  );
}

function getNonComputedMemberPropertyName(
  expression: t.MemberExpression
): string | null {
  return !expression.computed && t.isIdentifier(expression.property)
    ? expression.property.name
    : null;
}
