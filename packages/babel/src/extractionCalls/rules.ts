import type { NodePath, types as t } from "@babel/core";
import {
  referencesModuleExport,
  staticMemberName
} from "../commonjs/bindings.js";

export function referencesMinchoMember(
  path: NodePath<t.Node>,
  api: string,
  member: string,
  strict = false
): boolean {
  return (
    path.isMemberExpression() &&
    staticMemberName(path.node) === member &&
    referencesModuleExport(path.get("object"), "@mincho-js/css", api, strict)
  );
}

export function isRulesExtractionCall(
  path: NodePath<t.Node>,
  strict: boolean
): boolean {
  if (referencesMinchoMember(path, "rules", "extends", strict)) return true;

  if (path.isMemberExpression() && staticMemberName(path.node) === "extends")
    path = path.get("object");

  const seen = new Set<t.Node>();

  while (!seen.has(path.node)) {
    seen.add(path.node);

    if (path.isCallExpression())
      return referencesMinchoMember(
        path.get("callee"),
        "rules",
        "with",
        strict
      );
    if (!path.isIdentifier()) return false;

    const binding = path.scope.getBinding(path.node.name);
    if (
      binding?.kind !== "const" ||
      !binding.constant ||
      !binding.path.isVariableDeclarator()
    )
      return false;

    const init = binding.path.get("init");
    if (!init.isExpression()) return false;

    path = init;
  }

  return false;
}
