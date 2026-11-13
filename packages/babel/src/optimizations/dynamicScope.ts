import { isTransparentCssRuleWrapperExpression } from "../staticCssEval/candidates.js";
import { types as t, type NodePath } from "@babel/core";

export function isDirectEvalCalleeWrapper(
  expression: t.Expression
): expression is Extract<t.Expression, { expression: t.Expression }> {
  return (
    t.isTSInstantiationExpression(expression) ||
    isTransparentCssRuleWrapperExpression(expression)
  );
}

/** Syntax only: a binding with this name may contain the intrinsic eval. */
export function isPossibleDirectEvalCallee(
  callee: t.CallExpression["callee"]
): boolean {
  if (!t.isExpression(callee)) return false;
  let current = callee;
  while (isDirectEvalCalleeWrapper(current)) current = current.expression;
  return t.isIdentifier(current, { name: "eval" });
}

/** Dynamic lexical access invalidates proofs based only on AST references. */
export function hasDynamicScope(program: NodePath<t.Program>): boolean {
  let dynamic = false;
  program.traverse({
    WithStatement() {
      dynamic = true;
    },

    CallExpression(path) {
      // A shadowed binding can still hold the intrinsic eval function.
      if (isPossibleDirectEvalCallee(path.node.callee)) dynamic = true;
    }
  });

  return dynamic;
}
