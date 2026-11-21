import type { NodePath, types as t } from "@babel/core";
import {
  getModuleReference,
  getExtractionModuleReference,
  type ExtractionReferenceRole
} from "../commonjs/bindings.js";
import type { ProgramScope } from "../types.js";
import { planEvaluation } from "./evaluation.js";
import { compiledRecipeResultProof } from "./compiledRecipeResult.js";
import { mathResultProof } from "./mathResult.js";
import { arrayIncludesResultProof } from "./arrayMapResult.js";

/** Normal-call result only: never authorizes invocation effects or movement. */
export function sourceInvocationResultProof(
  call: NodePath<t.CallExpression | t.OptionalCallExpression>,
  acceptUse?: (use: NodePath<t.Node>, role?: ExtractionReferenceRole) => boolean
): { kind: "primitive" } | undefined {
  const seen = new Set<t.Node>();
  let budget = 128;
  const primitive = (value: NodePath<t.Node>): boolean => {
    if (--budget < 0 || seen.has(value.node)) return false;
    seen.add(value.node);
    try {
      if (value.isIdentifier()) {
        const binding = value.scope.getBinding(value.node.name);
        if (!binding)
          return ["undefined", "NaN", "Infinity"].includes(value.node.name);
        if (
          !binding.constant ||
          !binding.path.isVariableDeclarator() ||
          !binding.path.get("id").isIdentifier()
        )
          return false;
        const init = binding.path.get("init");
        return init.isExpression() && primitive(init);
      }
      if (value.isCallExpression())
        return (
          Boolean(
            compiledRecipeResultProof(value) ??
            mathResultProof(value) ??
            arrayIncludesResultProof(value)
          ) || result(value)
        );
      const proof = planEvaluation(value).result;
      return (
        proof.kind === "primitive" ||
        (proof.kind === "operand" &&
          proof.paths.length > 0 &&
          proof.paths.every(primitive))
      );
    } finally {
      seen.delete(value.node);
    }
  };
  const result = (
    value: NodePath<t.CallExpression | t.OptionalCallExpression>
  ): boolean => {
    if (
      !value.isCallExpression() ||
      value.node.optional ||
      value.get("callee").isOptionalMemberExpression()
    )
      return false;
    const callee = value.get("callee");
    const reference = getModuleReference(callee);
    if (!reference || reference.members.includes(null)) return false;
    const config = (value.scope.getProgramParent() as ProgramScope).minchoData
      ?.extractCalls;
    const id = config?.resolvedSources?.[reference.kind][reference.source];
    const metadata = id ? config?.exportOrigins?.[id] : undefined;
    if (!metadata) return false;
    const syntheticDefault =
      reference.interop === "node" ||
      (Boolean(reference.interop) && !metadata.esModule);
    const members =
      syntheticDefault && reference.members[0] === "default"
        ? reference.members.slice(1)
        : reference.members;
    const summary = metadata.sourceInvocationResults?.[JSON.stringify(members)];
    if (!summary) return false;
    const safe = getExtractionModuleReference(
      callee,
      (use, role) => use.node === callee.node || acceptUse?.(use, role) === true
    );
    if (!safe || safe.unsafe) return false;
    if (summary.kind === "primitive") return true;
    const args = value.get("arguments");
    // A spread before the selected formal makes its actual position unknown.
    if (
      !Number.isInteger(summary.index) ||
      summary.index < 0 ||
      args.slice(0, summary.index + 1).some((arg) => arg.isSpreadElement())
    )
      return false;
    const argument = args[summary.index];
    return (
      argument === undefined || (argument.isExpression() && primitive(argument))
    );
  };
  return result(call) ? { kind: "primitive" } : undefined;
}
