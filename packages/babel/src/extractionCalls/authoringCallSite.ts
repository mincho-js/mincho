import { types as t, type NodePath } from "@babel/core";
import {
  getModuleReference,
  getExtractionModuleReference,
  type ExtractionReferenceRole
} from "../commonjs/bindings.js";
import type { ProgramScope } from "../types.js";
import type {
  AuthoringArgumentPlan,
  AuthoringCallContract
} from "./authoringContract.js";

export interface AuthoringCallSiteProof {
  terminal: "style" | "recipe";
  /** Exact calls whose invocation/order obligations remain with the caller. */
  calls: readonly NodePath<t.CallExpression>[];
}

/** Apply a source summary only to private literal data, never arbitrary objects. */
export function proveAuthoringCallSite(
  call: NodePath<t.CallExpression>,
  acceptUse?: (
    callee: NodePath<t.Node>,
    role?: ExtractionReferenceRole
  ) => boolean,
  seen = new Set<t.Node>()
): AuthoringCallSiteProof | undefined {
  if (call.node.optional || seen.has(call.node) || seen.size >= 32) return;
  const next = new Set(seen).add(call.node);
  const callee = call.get("callee");
  const reference = getModuleReference(callee);
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
  const contract: AuthoringCallContract | undefined =
    metadata.authoringCalls?.[JSON.stringify(members)];
  if (!contract || call.node.arguments.length !== contract.parameterCount)
    return;
  const safe = getExtractionModuleReference(
    callee,
    (use, role) => use.node === callee.node || acceptUse?.(use, role) === true
  );
  if (!safe || safe.unsafe) return;
  const calls: NodePath<t.CallExpression>[] = [call];
  let budget = 256;
  const actual = (
    value: NodePath<t.Node>,
    visiting = new Set<t.Node>()
  ): boolean => {
    if (--budget < 0 || visiting.has(value.node)) return false;
    const nested = new Set(visiting).add(value.node);
    if (
      value.isStringLiteral() ||
      value.isBooleanLiteral() ||
      value.isNullLiteral() ||
      (value.isNumericLiteral() && Number.isFinite(value.node.value))
    )
      return true;
    if (
      value.isTSAsExpression() ||
      value.isTSTypeAssertion() ||
      value.isTSNonNullExpression() ||
      value.isTSSatisfiesExpression() ||
      value.isParenthesizedExpression()
    )
      return actual(value.get("expression") as NodePath<t.Node>, nested);
    if (value.isObjectExpression())
      return value.get("properties").every((property) => {
        if (property.isSpreadElement())
          return (
            property.get("argument").isObjectExpression() &&
            actual(property.get("argument"), nested)
          );
        if (!property.isObjectProperty() || property.node.computed)
          return false;
        const key = property.node.key;
        if (
          (t.isIdentifier(key) && key.name === "__proto__") ||
          (t.isStringLiteral(key) && key.value === "__proto__")
        )
          return false;
        return actual(property.get("value") as NodePath<t.Node>, nested);
      });
    if (value.isArrayExpression())
      return value
        .get("elements")
        .every((element) => element.isExpression() && actual(element, nested));
    if (value.isIdentifier()) {
      const binding = value.scope.getBinding(value.node.name);
      if (
        !binding?.constant ||
        binding.kind !== "const" ||
        !binding.path.isVariableDeclarator() ||
        !t.isIdentifier(binding.path.node.id)
      )
        return false;
      const init = binding.path.get("init");
      // Object aliases can escape or be captured by recipe configuration. Only
      // primitive literals and separately proved style-call results may cross.
      if (
        init.isStringLiteral() ||
        init.isBooleanLiteral() ||
        init.isNullLiteral() ||
        init.isNumericLiteral()
      )
        return actual(init, nested);
      if (init.isCallExpression()) {
        const proof = proveAuthoringCallSite(init, acceptUse, next);
        if (proof?.terminal !== "style") return false;
        calls.push(...proof.calls);
        return true;
      }
    }
    return false;
  };
  const args = call.get("arguments");
  const plan = (value: AuthoringArgumentPlan): boolean => {
    if (--budget < 0) return false;
    if (value.kind === "literal") return true;
    if (value.kind === "parameter")
      return (
        args[value.index]?.isExpression() === true && actual(args[value.index])
      );
    if (value.kind === "array") return value.elements.every(plan);
    return value.entries.every((entry) =>
      entry.kind === "spread"
        ? plan(entry.value)
        : entry.key !== "__proto__" && plan(entry.value)
    );
  };
  if (
    !contract.arguments.every(plan) ||
    !args.every((argument) => argument.isExpression() && actual(argument))
  )
    return;
  return { terminal: contract.terminal, calls };
}

/** Result typing does not authorize moving the factory or its runtime calls. */
export function sourceRecipeInvocationResult(
  call: NodePath<t.CallExpression | t.OptionalCallExpression>
): { kind: "primitive" } | undefined {
  if (!call.isCallExpression()) return;
  const callee = call.get("callee");
  if (!callee.isIdentifier()) return;
  const binding = callee.scope.getBinding(callee.node.name);
  if (
    !binding?.constant ||
    binding.kind !== "const" ||
    !binding.path.isVariableDeclarator()
  )
    return;
  const initializer = binding.path.get("init");
  if (!initializer.isCallExpression()) return;
  const producer = proveAuthoringCallSite(initializer);
  if (producer?.terminal === "recipe") return { kind: "primitive" };
}
