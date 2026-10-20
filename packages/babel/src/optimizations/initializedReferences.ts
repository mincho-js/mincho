import type { NodePath, types as t } from "@babel/core";

/** A completed declaration must dominate the read in the same execution scope. */
function initializedBefore(
  declaration: NodePath<t.VariableDeclarator>,
  reference: NodePath<t.Node>
): boolean {
  let statement: NodePath<t.Node> = declaration.parentPath;
  if (!statement.isVariableDeclaration()) return false;
  if (statement.parentPath?.isExportNamedDeclaration())
    statement = statement.parentPath;

  const container = statement.parentPath;
  if (!container?.isProgram() && !container?.isBlockStatement()) return false;

  let use = reference;

  while (use.parentPath !== container) {
    // A function can be invoked before a textually earlier outer declaration.
    // Class bodies also mix deferred fields/methods and immediate evaluation.
    if (use.isFunction() || use.isClass() || !use.parentPath) return false;

    use = use.parentPath;
  }

  if (use.isFunction() || use.isClass()) return false;

  return (
    statement.inList &&
    use.inList &&
    statement.listKey === use.listKey &&
    typeof statement.key === "number" &&
    typeof use.key === "number" &&
    statement.key < use.key
  );
}

/**
 * Guard only the opt-in literal substitutions. Alias initializers must satisfy
 * the same proof; immutable bindings alone do not establish evaluation order.
 */
export function hasInitializedReferences(path: NodePath<t.Node>): boolean {
  const active = new Set<t.Node>();
  let remaining = 10000;

  const inspect = (value: NodePath<t.Node>, depth: number): boolean => {
    if (--remaining < 0 || depth > 50) return false;

    const reference = (read: NodePath<t.Node>): boolean => {
      if (!read.isReferencedIdentifier()) return true;

      const binding = read.scope.getBinding(read.node.name);
      if (!binding) return true;
      if (!binding.constant) return false;

      const declaration = binding.path;
      if (
        declaration.isImportSpecifier() ||
        declaration.isImportDefaultSpecifier() ||
        declaration.isImportNamespaceSpecifier()
      )
        return true;
      if (
        !declaration.isVariableDeclarator() ||
        active.has(declaration.node) ||
        !initializedBefore(declaration, read)
      )
        return false;

      const init = declaration.get("init");
      if (!init.node) return false;

      active.add(declaration.node);

      const safe = inspect(init as NodePath<t.Node>, depth + 1);
      active.delete(declaration.node);

      return safe;
    };

    if (!reference(value)) return false;

    let safe = true;
    value.traverse({
      enter(child) {
        if (--remaining < 0 || !reference(child)) {
          safe = false;
          child.stop();
        }
      }
    });

    return safe;
  };

  return inspect(path, 0);
}
