import type { NodePath, types as t } from "@babel/core";
import type { ProgramScope } from "../types.js";
import { createArrayMapIntrinsicEnvironment } from "../optimizations/arrayMapIntrinsic.js";

/** Result/alias contract only. Input expressions retain their original effects. */
export function arrayMapResultProof(
  call: NodePath<t.CallExpression | t.OptionalCallExpression>
): { kind: "identity-array-map" } | undefined {
  const program = call.scope.getProgramParent().path;
  const graph = (call.scope.getProgramParent() as ProgramScope).minchoData
    ?.extractCalls?.arrayMapIntrinsics;
  if (!graph?.intact || !program.isProgram()) return;
  const environment = createArrayMapIntrinsicEnvironment();
  if (environment.provesNativeMap(call)) return { kind: "identity-array-map" };
}

/** The includes invocation itself is read-only; argument evaluation is not. */
export function arrayIncludesResultProof(
  call: NodePath<t.CallExpression | t.OptionalCallExpression>
): { kind: "primitive"; readOnlyInvocation: "array-includes" } | undefined {
  const program = call.scope.getProgramParent().path;
  const graph = (call.scope.getProgramParent() as ProgramScope).minchoData
    ?.extractCalls?.arrayMapIntrinsics;
  if (!graph?.intact || !program.isProgram()) return;
  const environment = createArrayMapIntrinsicEnvironment();
  if (environment.provesNativeIncludes(call))
    return { kind: "primitive", readOnlyInvocation: "array-includes" };
}
