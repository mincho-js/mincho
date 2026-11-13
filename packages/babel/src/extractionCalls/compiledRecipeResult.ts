import type { NodePath, types as t } from "@babel/core";
import { getExtractionModuleReference } from "../commonjs/bindings.js";
import type { ProgramScope } from "../types.js";
import type { CallResultProof } from "../staticCssEval/sameFile/mutationAliases.js";

/** A result receipt only: arguments, coercions and invocation effects still run. */
export function compiledRecipeResultProof(
  call: NodePath<t.CallExpression | t.OptionalCallExpression>
): CallResultProof | undefined {
  const callee = call.get("callee");
  // The inspected invocation remains at its original site. This permits only
  // that use during namespace validation; it does not approve other escapes.
  const reference = getExtractionModuleReference(
    callee,
    (use) => use.node === callee.node
  );
  if (!reference || reference.unsafe || reference.members.includes(null))
    return;
  const config = (call.scope.getProgramParent() as ProgramScope).minchoData
    ?.extractCalls;
  const id = config?.resolvedSources?.[reference.kind][reference.source];
  const metadata = id ? config?.exportOrigins?.[id] : undefined;
  if (!metadata) return;

  const syntheticDefault =
    reference.interop === "node" ||
    (Boolean(reference.interop) && !metadata.esModule);
  const members =
    syntheticDefault && reference.members[0] === "default"
      ? reference.members.slice(1)
      : reference.members;
  if (metadata.recipeInvocations?.[JSON.stringify(members)] === "class-string")
    return { kind: "primitive" };
}
