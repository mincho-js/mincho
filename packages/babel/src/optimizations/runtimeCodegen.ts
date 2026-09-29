import { types as t, type NodePath } from "@babel/core";
import { getModuleReference } from "../commonjs/bindings.js";
import type { ProgramScope } from "../types.js";

/** Generated bindings have no user-requested module effects. Never infer ownership by name. */
export function removeUnusedGeneratedImports(
  program: NodePath<t.Program>
): void {
  const generated = (program.scope as ProgramScope).minchoData?.imports;
  if (!generated?.size) return;

  program.scope.crawl();

  for (const identifier of generated.values()) {
    const binding = program.scope.getBinding(identifier.name);
    if (!binding || binding.referenced || !binding.constant) continue;

    const path = binding.path;

    if (path.isImportSpecifier()) {
      const declaration = path.parentPath;
      path.remove();

      if (
        declaration.isImportDeclaration() &&
        !declaration.node.specifiers.length &&
        !(program.scope as ProgramScope).minchoData.effectImports?.has(
          declaration.node.source.value
        )
      )
        declaration.remove();
    } else if (path.isVariableDeclarator() && t.isIdentifier(path.node.id)) {
      // helper-module-imports emits a private `var _cx = require(...).cx` in CJS.
      const init = path.get("init");

      if (init.isExpression() && getModuleReference(init)) path.remove();
    }
  }
}
