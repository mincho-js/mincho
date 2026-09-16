import { types as t, type NodePath } from "@babel/core";
import { isSupportedImportInterop } from "./interop.js";
import type { Binding } from "@babel/traverse";
import { getStaticCssEvalLiteralRequireImportPath } from "../staticCssEval/cjsBindings.js";

export interface ModuleReference {
  source: string;
  kind: "import" | "require";
  members: readonly (string | null)[];
  unsafe?: string;
  interop?: boolean | "node";
}

export function staticMemberName(
  node: t.MemberExpression | t.ObjectProperty
): string | null {
  const key = t.isMemberExpression(node) ? node.property : node.key;
  if (!node.computed && t.isIdentifier(key)) return key.name;

  return t.isStringLiteral(key) || t.isNumericLiteral(key)
    ? String(key.value)
    : null;
}

function namespaceMutation(
  binding: Binding,
  seen = new Set<Binding>()
): string | undefined {
  if (seen.has(binding)) return undefined;

  seen.add(binding);

  if (!binding.constant) return `Reassigned binding ${binding.identifier.name}`;

  for (const reference of binding.referencePaths) {
    const parent = reference.parentPath;
    if (
      !parent ||
      !t.VISITOR_KEYS[parent.node.type]?.some((key) => {
        const value = (parent.node as unknown as Record<string, unknown>)[key];

        return Array.isArray(value)
          ? value.includes(reference.node)
          : value === reference.node;
      })
    )
      continue;

    if (parent?.isMemberExpression() && parent.node.object === reference.node) {
      let member: NodePath<t.Node> = parent;

      while (
        member.parentPath?.isMemberExpression() &&
        member.parentPath.node.object === member.node
      )
        member = member.parentPath;

      if (isWriteTarget(member))
        return `Mutated CommonJS namespace ${binding.identifier.name}`;

      continue;
    }

    if (parent?.isVariableDeclarator() && parent.node.init === reference.node) {
      if (t.isIdentifier(parent.node.id)) {
        const alias = parent.scope.getBinding(parent.node.id.name);
        const mutation = alias && namespaceMutation(alias, seen);
        if (mutation) return mutation;
      }

      continue;
    }

    if (parent?.isCallExpression() && parent.node.callee === reference.node)
      continue;

    // Reading typeof does not expose the module object to another function.
    if (parent?.isUnaryExpression({ operator: "typeof" })) continue;

    return `Escaped CommonJS namespace ${binding.identifier.name}`;
  }

  return undefined;
}

export function isWriteTarget(path: NodePath<t.Node>): boolean {
  const parent = path.parentPath;
  if (!parent) return false;

  if (
    parent.isAssignmentExpression() ||
    parent.isForInStatement() ||
    parent.isForOfStatement()
  )
    return parent.node.left === path.node;

  if (
    parent.isUpdateExpression() ||
    parent.isUnaryExpression({ operator: "delete" })
  )
    return true;

  if (
    parent.isArrayPattern() ||
    parent.isObjectPattern() ||
    (parent.isObjectProperty() &&
      parent.parentPath.isObjectPattern() &&
      parent.node.value === path.node) ||
    (parent.isAssignmentPattern() && parent.node.left === path.node) ||
    parent.isRestElement() ||
    parent.isTSAsExpression() ||
    parent.isTSNonNullExpression() ||
    parent.isTSTypeAssertion() ||
    parent.isParenthesizedExpression()
  )
    return isWriteTarget(parent);

  return false;
}

/** Resolve the actual binding, including compiler comma calls and local aliases. */
export function getModuleReference(
  path: NodePath<t.Node>,
  seen = new Set<t.Node>()
): ModuleReference | null {
  if (seen.has(path.node)) return null;

  const next = new Set(seen).add(path.node);
  if (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isParenthesizedExpression()
  )
    return getModuleReference(path.get("expression") as NodePath<t.Node>, next);

  if (path.isSequenceExpression()) {
    const expressions = path.get("expressions");
    if (
      expressions
        .slice(0, -1)
        .every((item) => item.isNumericLiteral({ value: 0 }))
    )
      return getModuleReference(expressions[expressions.length - 1]!, next);

    return null;
  }

  if (path.isCallExpression()) {
    const source = getStaticCssEvalLiteralRequireImportPath(
      path.node,
      path.scope
    );
    if (source) return { source, kind: "require", members: [] };

    const argument = path.get("arguments")[0];
    const wrapped = argument?.isExpression()
      ? getModuleReference(argument, next)
      : null;
    if (wrapped?.kind === "require" && wrapped.members.length === 0)
      return {
        ...wrapped,
        interop: t.isNumericLiteral(path.node.arguments[1], { value: 1 })
          ? "node"
          : true,
        ...(isSupportedImportInterop(path)
          ? {}
          : { unsafe: "Unsupported CommonJS interop helper" })
      };

    return null;
  }

  if (path.isMemberExpression()) {
    const reference = getModuleReference(
      path.get("object") as NodePath<t.Node>,
      next
    );
    if (!reference) return null;

    const member = staticMemberName(path.node);

    return {
      ...reference,
      members: [...reference.members, member],
      ...(member === null ? { unsafe: "Dynamic CommonJS member access" } : {})
    };
  }

  if (!path.isIdentifier()) return null;

  const binding = path.scope.getBinding(path.node.name);
  if (!binding) return null;

  const declaration = binding.path;

  if (
    declaration.isImportSpecifier() ||
    declaration.isImportDefaultSpecifier() ||
    declaration.isImportNamespaceSpecifier()
  ) {
    const parent = declaration.parentPath;
    if (!parent.isImportDeclaration() || parent.node.importKind === "type")
      return null;

    return {
      source: parent.node.source.value,
      kind: "import",
      members: declaration.isImportNamespaceSpecifier()
        ? []
        : [
            declaration.isImportDefaultSpecifier()
              ? "default"
              : t.isIdentifier(declaration.node.imported)
                ? declaration.node.imported.name
                : declaration.node.imported.value
          ]
    };
  }

  if (!declaration.isVariableDeclarator()) return null;

  // Array destructuring consumes iterator elements, not module exports.
  if (
    !t.isIdentifier(declaration.node.id) &&
    !t.isObjectPattern(declaration.node.id)
  )
    return null;

  const init = declaration.get("init");
  if (!init.node) return null;

  let reference = getModuleReference(init as NodePath<t.Node>, next);
  if (!reference) return null;

  if (t.isObjectPattern(declaration.node.id)) {
    const property = declaration.node.id.properties.find(
      (item) =>
        t.isObjectProperty(item) &&
        t.isIdentifier(item.value, { name: path.node.name })
    );
    if (!property || !t.isObjectProperty(property)) return null;

    reference = {
      ...reference,
      members: [...reference.members, staticMemberName(property)]
    };
  }

  let unsafe = reference.unsafe;

  if (!binding.constant) unsafe = `Reassigned binding ${path.node.name}`;
  if (
    reference.kind === "require" &&
    path.node.start != null &&
    declaration.node.end != null &&
    path.node.start < declaration.node.end &&
    path.getFunctionParent() === declaration.getFunctionParent()
  )
    unsafe ??= `CommonJS binding ${path.node.name} used before initialization`;
  if (reference.kind === "require" && reference.members.length === 0)
    unsafe ??= namespaceMutation(binding);

  return { ...reference, ...(unsafe ? { unsafe } : {}) };
}

export function referencesModuleExport(
  path: NodePath<t.Node>,
  source: string,
  name: string,
  strict = false
): boolean {
  if (path.referencesImport(source, name)) return true;

  const reference = getModuleReference(path);
  if (!reference || reference.source !== source) return false;

  const member =
    reference.members.length === 0 && reference.kind === "require"
      ? "default"
      : reference.members[0];
  if (reference.members.length > 1 || (member !== null && member !== name))
    return false;

  if (reference.unsafe || member === null) {
    if (reference.kind === "import") return false;
    if (strict)
      throw path.buildCodeFrameError(
        `Cannot safely extract ${JSON.stringify(source)} export ${JSON.stringify(name)}: ${reference.unsafe ?? "dynamic member"}. Use mincho-js-ignore to leave this call in place.`
      );

    return false;
  }

  return true;
}
