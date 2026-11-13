import { types as t, type NodePath } from "@babel/core";
import {
  referencesModuleExport,
  getModuleReference
} from "../commonjs/bindings.js";
import { hasDynamicScope } from "../optimizations/dynamicScope.js";
import { planExtractionBindings } from "../transforms/extractionBindings.js";
import { isIgnoredExtractionCall } from "../transforms/extractionPublication.js";
import { proveEvaluationOrder } from "./evaluation.js";

export interface CapturedAuthoringOwner {
  declaration: NodePath<t.VariableDeclarator>;
  consumers: NodePath<t.CallExpression>[];
}

// Creation-only evaluation is insufficient for closures: their free captures
// may pull effectful initializers into the sidecar. Keep this new receipt's
// auxiliary data closed and literal; existing broader proofs remain separate.
function closedData(node: t.Node): boolean {
  if (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node)
  )
    return true;
  if (t.isArrayExpression(node))
    return node.elements.every((value) => value !== null && closedData(value));
  return (
    t.isObjectExpression(node) &&
    node.properties.every(
      (property) =>
        t.isObjectProperty(property) &&
        !property.computed &&
        !property.shorthand &&
        closedData(property.value)
    )
  );
}

/** A compiler authoring owner moves as one instance, never as a pure/fresh value. */
export function capturedAuthoringOwner(
  producer: NodePath<t.CallExpression>,
  registered: (callee: NodePath<t.Node>) => boolean
): CapturedAuthoringOwner | undefined {
  const declaration = producer.parentPath;
  const statement = declaration.parentPath;
  const program = statement?.parentPath;
  if (
    producer.node.optional ||
    !declaration.isVariableDeclarator() ||
    declaration.node.init !== producer.node ||
    !t.isIdentifier(declaration.node.id) ||
    !statement?.isVariableDeclaration({ kind: "const" }) ||
    statement.node.declarations.length !== 1 ||
    !program?.isProgram() ||
    hasDynamicScope(program) ||
    isIgnoredExtractionCall(producer) ||
    getModuleReference(producer.get("callee"))?.unsafe !== undefined ||
    !referencesModuleExport(
      producer.get("callee"),
      "@mincho-js/css",
      "defineRules"
    ) ||
    producer.node.arguments.length !== 1 ||
    !closedData(producer.node.arguments[0]!) ||
    proveEvaluationOrder(producer.get("arguments")[0]!, {
      replay: () => "unknown",
      binding: () => "unknown"
    }) !== "proven"
  )
    return;
  const binding = declaration.scope.getBinding(declaration.node.id.name);
  if (!binding?.constant || !binding.referencePaths.length) return;
  const consumers = new Set<NodePath<t.CallExpression>>();
  for (const reference of binding.referencePaths) {
    const member = reference.parentPath;
    if (
      !member?.isMemberExpression() ||
      member.node.object !== reference.node ||
      member.node.computed ||
      !t.isIdentifier(member.node.property) ||
      !["css", "cx"].includes(member.node.property.name)
    )
      return;
    const callback = member.getFunctionParent();
    if (
      !callback ||
      !(
        callback.isArrowFunctionExpression() || callback.isFunctionExpression()
      ) ||
      callback.node.async ||
      callback.node.generator ||
      callback.node.params.length
    )
      return;
    const consumer = callback.parentPath;
    if (
      !consumer.isCallExpression() ||
      !consumer.node.arguments.includes(callback.node) ||
      consumer.getFunctionParent() ||
      consumer.node.optional ||
      isIgnoredExtractionCall(consumer) ||
      !registered(consumer.get("callee"))
    )
      return;
    const useStatement = consumer.getStatementParent();
    if (
      !useStatement ||
      useStatement.parentPath !== program ||
      !useStatement.isVariableDeclaration() ||
      useStatement.node.declarations.length !== 1 ||
      useStatement.node.declarations[0]?.init !== consumer.node
    )
      return;
    const plan = planExtractionBindings(consumer);
    if (plan.runtimeBinding || !plan.bindings.includes(binding)) return;
    if (
      plan.bindings.some((capture) => {
        if (capture === binding || capture.kind === "module") return false;
        const path = capture.path;
        return (
          !path.isVariableDeclarator() ||
          !t.isIdentifier(path.node.id) ||
          !path.parentPath.isVariableDeclaration({ kind: "const" }) ||
          path.parentPath.node.declarations.length !== 1 ||
          !path.node.init ||
          !closedData(path.node.init)
        );
      })
    )
      return;
    consumers.add(consumer);
  }
  // No intervening runtime work can be overtaken when this owner and its exact
  // consumers move together. Each wrapper remains verbatim (including effects).
  const statements = new Set(
    [...consumers].map((call) => call.getStatementParent()!.node)
  );
  const body = program.get("body");
  const first = body.findIndex((path) => path.node === statement.node);
  const last = Math.max(
    ...body.map((path, index) => (statements.has(path.node) ? index : -1))
  );
  if (
    last <= first ||
    [...consumers].some(
      (call) => (call.node.start ?? -1) <= (producer.node.end ?? Infinity)
    )
  )
    return;
  if (
    body.slice(first + 1, last + 1).some((path) => !statements.has(path.node))
  )
    return;
  return { declaration, consumers: [...consumers] };
}
