import { types as t, type NodePath } from "@babel/core";
import type { Binding, Scope } from "@babel/traverse";

/** Native-environment authority follows emitted JavaScript, not erased types.
 * Expression-bearing TS/Flow wrappers still execute their expression; enum,
 * namespace and parameter-property initializers are not blanket-skipped.
 */
export function isRuntimeSourceReference(path: NodePath<t.Node>): boolean {
  for (
    let current: NodePath<t.Node> | null = path;
    current;
    current = current.parentPath
  ) {
    const node = current.node;
    if (
      ("declare" in node && node.declare === true) ||
      t.isTSInterfaceDeclaration(node) ||
      t.isTSTypeAliasDeclaration(node) ||
      t.isTSDeclareFunction(node) ||
      // The FlowDeclaration alias excludes runtime casts and enums.
      (node.type.startsWith("Declare") && t.isFlowDeclaration(node)) ||
      node.type === "InterfaceDeclaration" ||
      node.type === "OpaqueType" ||
      node.type === "TypeAlias"
    )
      return false;
    if (
      (t.isImportDeclaration(node) &&
        (node.importKind === "type" || node.importKind === "typeof")) ||
      (t.isImportSpecifier(node) &&
        (node.importKind === "type" || node.importKind === "typeof")) ||
      (t.isExportNamedDeclaration(node) && node.exportKind === "type") ||
      (t.isExportSpecifier(node) && node.exportKind === "type") ||
      (t.isExportAllDeclaration(node) && node.exportKind === "type")
    )
      return false;
    const parent = current.parentPath;
    if (!parent) continue;
    if (
      t.isTSAsExpression(parent.node) ||
      t.isTSTypeAssertion(parent.node) ||
      t.isTSSatisfiesExpression(parent.node) ||
      t.isTSNonNullExpression(parent.node) ||
      t.isTSInstantiationExpression(parent.node) ||
      t.isTypeCastExpression(parent.node)
    ) {
      if (parent.node.expression !== node) return false;
      continue;
    }
    if (
      t.isTSType(parent.node) ||
      t.isTSTypeAnnotation(parent.node) ||
      t.isTSExpressionWithTypeArguments(parent.node) ||
      t.isTSTypeParameterInstantiation(parent.node) ||
      t.isTSTypeParameterDeclaration(parent.node) ||
      t.isFlow(parent.node)
    )
      return false;
  }
  return true;
}
