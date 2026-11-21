import type { Binding } from "@babel/traverse";
import type { NodePath, types as t } from "@babel/core";
import type { ProgramScope } from "../types.js";
import { createMathIntrinsicEnvironment } from "../optimizations/mathIntrinsic.js";

/** Native numeric result only, never a replay/determinism/coercion certificate. */
export function mathResultProof(
  call: NodePath<t.CallExpression | t.OptionalCallExpression>
): { kind: "primitive" } | undefined {
  const program = call.scope.getProgramParent().path;
  const graph = (call.scope.getProgramParent() as ProgramScope).minchoData
    ?.extractCalls?.mathIntrinsics;
  if (!graph?.intact || !program.isProgram()) return;
  // No positive AST-identity cache: lowerers can introduce mutations after the
  // completed graph snapshot. The matching intrinsic query validates its program.
  const environment = createMathIntrinsicEnvironment({
    bindIntact: graph.bindIntact
  });
  if (environment.provesPrimitiveResult(call)) return { kind: "primitive" };
}

/** Native identity read only; callers must still visit every dependency. */
export function mathReferenceProof(path: NodePath<t.Node>) {
  const program = path.scope.getProgramParent().path;
  const graph = (path.scope.getProgramParent() as ProgramScope).minchoData
    ?.extractCalls?.mathIntrinsics;
  if (!graph?.intact || !program.isProgram()) return;
  const environment = createMathIntrinsicEnvironment({
    bindIntact: graph.bindIntact
  });
  return environment.referenceIdentity(path);
}

/** Native object/function identity and unchanged slot, never primitive origin. */
export function mathBindingIdentityProof(binding: Binding) {
  if (!binding.constant || !binding.path.isVariableDeclarator()) return;
  const reference = binding.referencePaths.find((path) => path.isIdentifier());
  if (!reference) return;
  // The environment validates every alias use, including mutation and escape.
  // Bound inputs remain separate dependencies and must be checked by the caller.
  return mathReferenceProof(reference);
}

/** Native namespace own Get/rest effects only, not result or relocation authority.
 * Direct Babel callers retain their standard-realm fallback; a loaded revocation
 * is intersected with a fresh observation rather than treated as missing data.
 */
export function mathNamespaceOwnReadProof(path: NodePath<t.Node>): boolean {
  const program = path.scope.getProgramParent().path;
  const graph = (path.scope.getProgramParent() as ProgramScope).minchoData
    ?.extractCalls?.mathIntrinsics;
  if (!program.isProgram() || (graph !== undefined && !graph.intact))
    return false;
  const environment = createMathIntrinsicEnvironment({
    bindIntact: graph?.bindIntact
  });
  return environment.referenceIdentity(path)?.kind === "namespace";
}
