import { types as t, type NodePath } from "@babel/core";

/** Dynamic lexical access invalidates proofs based only on AST references. */
export function hasDynamicScope(program: NodePath<t.Program>): boolean {
  let dynamic = false;
  program.traverse({
    WithStatement() {
      dynamic = true;
    },

    CallExpression(path) {
      // A shadowed binding can still hold the intrinsic eval function.
      if (t.isIdentifier(path.node.callee, { name: "eval" })) dynamic = true;
    }
  });

  return dynamic;
}
