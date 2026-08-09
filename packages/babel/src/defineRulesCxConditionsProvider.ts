import { type NodePath, types as t } from "@babel/core";
import type { Binding } from "@babel/traverse";
import type { StaticCssLiteral } from "./staticCssEval/types.js";
import type { PluginState } from "./types.js";
import {
  DEFINE_RULES_CX_RUNTIME_IMPORT_NAME,
  DEFINE_RULES_CX_RUNTIME_IMPORT_PATH,
  DEFINE_RULES_SEGMENT_MARKER_PREFIX,
  type DefineRulesCxExpressionRange,
  type StaticReference
} from "./defineRulesCxConditionsTypes.js";

export function resolveProviderStaticValue(
  path: NodePath<t.Expression>,
  state: PluginState
): StaticCssLiteral | null {
  const provider = state.opts.staticCssEvalProvider;
  const reference = getStaticReference(path.node);

  if (provider === undefined || reference === null) {
    return null;
  }

  const binding = path.scope.getBinding(reference.bindingName);

  if (binding === undefined || !isImportBinding(binding)) {
    return null;
  }

  const range = getExpressionRange(path.node);

  if (range === null) {
    return null;
  }

  const result = provider.getResolvedCssValue({
    importerId: state.file.opts.filename ?? "",
    expressionStart: range.start,
    expressionEnd: range.end,
    bindingName: reference.bindingName,
    ...(reference.memberPath.length > 0
      ? { memberPath: [...reference.memberPath] }
      : {})
  });

  return result.kind === "resolved" ? result.value : null;
}

export function isDefineRulesCxRuntimeRecipe(
  value: StaticCssLiteral | null
): boolean {
  if (!isStaticObject(value)) {
    return false;
  }

  return (
    value.importPath === DEFINE_RULES_CX_RUNTIME_IMPORT_PATH &&
    value.importName === DEFINE_RULES_CX_RUNTIME_IMPORT_NAME &&
    Array.isArray(value.args)
  );
}

export function isMarkerBearingClassName(
  value: StaticCssLiteral | null
): boolean {
  return (
    typeof value === "string" &&
    value
      .split(/\s+/)
      .some((token) => token.startsWith(DEFINE_RULES_SEGMENT_MARKER_PREFIX))
  );
}

export function getExpressionRange(
  node: t.Node
): DefineRulesCxExpressionRange | null {
  return typeof node.start === "number" && typeof node.end === "number"
    ? { start: node.start, end: node.end }
    : null;
}

function getStaticReference(node: t.Expression): StaticReference | null {
  if (t.isIdentifier(node)) {
    return { bindingName: node.name, memberPath: [] };
  }

  if (!t.isMemberExpression(node) || node.computed) {
    return null;
  }

  const propertyName = getMemberPropertyName(node.property);

  if (propertyName === null || !t.isExpression(node.object)) {
    return null;
  }

  const objectReference = getStaticReference(node.object);
  return objectReference === null
    ? null
    : {
        bindingName: objectReference.bindingName,
        memberPath: [...objectReference.memberPath, propertyName]
      };
}

function getMemberPropertyName(
  property: t.MemberExpression["property"]
): string | null {
  if (t.isIdentifier(property)) {
    return property.name;
  }

  if (t.isStringLiteral(property)) {
    return property.value;
  }

  return null;
}

function isStaticObject(
  value: StaticCssLiteral | null
): value is { readonly [key: string]: StaticCssLiteral } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImportBinding(binding: Binding): boolean {
  return (
    binding.path.isImportSpecifier() ||
    binding.path.isImportDefaultSpecifier() ||
    binding.path.isImportNamespaceSpecifier()
  );
}
