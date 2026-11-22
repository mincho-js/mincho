import {
  isPossibleDirectEvalCallee,
  isDirectEvalCalleeWrapper
} from "../optimizations/dynamicScope.js";
import type { Binding, Scope } from "@babel/traverse";
import {
  collectRuntimeSourceEvidence,
  isRuntimeSourceReference,
  possibleIntrinsicEvalReference,
  type RuntimeSourceEvidence
} from "../optimizations/runtimeSourceReference.js";
import { type NodePath, types as t } from "@babel/core";
import { planEvaluation, runtimeParameterOffset } from "./evaluation.js";

function isDirectEval(call: NodePath<t.CallExpression>): boolean {
  return isPossibleDirectEvalCallee(call.node.callee);
}

/** Normal-call result only. This grants no effect, replay, or constructor proof. */
export function hasPrimitiveInvocationResult(
  path: NodePath<t.Node | null | undefined>
): boolean {
  if (!path.isFunction() || path.isClassMethod() || path.isClassPrivateMethod())
    return false;
  if (
    path.node.async ||
    path.node.generator ||
    (path.isObjectMethod() && path.node.kind !== "method")
  )
    return false;
  // Direct eval can mutate outer lexical bindings even in strict modules.
  // Only an exact locally defined function excludes intrinsic eval identity.
  let dynamicScope: { with: boolean; evalScopes: Scope[] } | undefined;
  const unsafeLexicalAccess = (
    immutable?: Binding,
    reference?: NodePath<t.Node>
  ): boolean => {
    const unsafe = (observed: { with: boolean; evalScopes: Scope[] }) => {
      if (observed.with) return true;
      if (immutable?.kind !== "const" || !reference)
        return observed.evalScopes.length > 0;
      // Eval cannot overwrite this const, but an intervening function scope
      // can introduce a new var binding which shadows the outer const.
      for (
        let scope: Scope | undefined = reference.scope;
        scope && scope !== immutable.scope;
        scope = scope.parent
      ) {
        if (observed.evalScopes.includes(scope)) return true;
      }
      return false;
    };
    if (dynamicScope) return unsafe(dynamicScope);
    const observed = { with: false, evalScopes: [] as Scope[] };
    dynamicScope = observed;
    path.scope.getProgramParent().path.traverse({
      WithStatement(statement) {
        observed.with = true;
        statement.stop();
      },
      CallExpression(call) {
        if (!isDirectEval(call)) return;
        let callee: NodePath<t.Node> = call.get("callee");
        while (
          t.isExpression(callee.node) &&
          isDirectEvalCalleeWrapper(callee.node)
        )
          callee = callee.get("expression") as NodePath<t.Node>;
        const program = path.scope.getProgramParent().path;
        if (
          callee.isIdentifier() &&
          program.isProgram() &&
          !possibleIntrinsicEvalReference(
            callee,
            (sourceEvidence ??= collectRuntimeSourceEvidence(program))
          )
        )
          return;
        observed.evalScopes.push(
          call.scope.getFunctionParent() ?? call.scope.getProgramParent()
        );
      }
    });
    return unsafe(observed);
  };
  let sourceEvidence: RuntimeSourceEvidence | undefined;
  const currentEvidence = () => {
    const program = path.scope.getProgramParent().path;
    return program.isProgram()
      ? (sourceEvidence ??= collectRuntimeSourceEvidence(program))
      : undefined;
  };
  const seen = new Set<t.Node>();
  let budget = 256;
  const primitive = (value: NodePath<t.Node>): boolean => {
    if (--budget < 0 || seen.has(value.node)) return false;
    seen.add(value.node);
    try {
      if (value.isIdentifier()) {
        const candidate = value.scope.getBinding(value.node.name);
        // Unsupported values do not need a whole-program observation.
        if (
          candidate
            ? !candidate.path.isVariableDeclarator()
            : !["undefined", "NaN", "Infinity"].includes(value.node.name)
        )
          return false;
        const evidence = currentEvidence();
        if (!evidence?.bindingsCurrent) return false;
        // New scopes can refresh cached metadata during observation itself.
        const binding = value.scope.getBinding(value.node.name);
        if (!binding)
          return (
            ["undefined", "NaN", "Infinity"].includes(value.node.name) &&
            !evidence.mayHaveUnmodeledShadow(value.scope, value.node.name) &&
            !unsafeLexicalAccess()
          );
        if (
          !binding.constant ||
          !binding.path.isVariableDeclarator() ||
          !isRuntimeSourceReference(binding.path) ||
          !binding.path.get("id").isIdentifier({ name: value.node.name })
        )
          return false;
        // A normal function starts with its implicit arguments object; a
        // redeclaring var's initializer may not have run at the return.
        if (
          value.node.name === "arguments" &&
          binding.kind === "var" &&
          binding.scope.path.isFunction() &&
          !binding.scope.path.isArrowFunctionExpression()
        )
          return false;
        // Script-global mutable bindings remain writable by indirect eval,
        // Function constructors and other external code unseen by Babel.
        // Module lexical bindings and function-local bindings are not globals.
        if (
          binding.scope.path.isProgram() &&
          binding.scope.path.node.sourceType === "script" &&
          binding.kind !== "const"
        )
          return false;
        if (
          evidence.mayHaveUnmodeledShadow(
            value.scope,
            value.node.name,
            binding.kind === "var" ? binding.scope.parent : binding.scope
          )
        )
          return false;
        const init = binding.path.get("init");
        // Unsupported bindings (notably parameters) need no whole-program
        // lexical check. Only scan when this lookup could supply authority.
        // Eval cannot replace a lexical const binding. Its initializer still
        // needs its own result proof, and with can shadow even immutable names.
        return (
          init.isExpression() &&
          !unsafeLexicalAccess(binding, value) &&
          primitive(init)
        );
      }
      // Check both value alternatives, without turning branch evaluation into
      // an authority to discard coercions, getters, or predicate effects.
      if (value.isConditionalExpression())
        return (
          primitive(value.get("consequent")) &&
          primitive(value.get("alternate"))
        );
      if (value.isLogicalExpression())
        return primitive(value.get("left")) && primitive(value.get("right"));
      // Update normal completion is Number/BigInt, but may still invoke hooks.
      if (value.isUpdateExpression()) return true;
      const result = planEvaluation(value).result;
      return (
        result.kind === "primitive" ||
        (result.kind === "operand" &&
          result.paths.length > 0 &&
          result.paths.every(primitive))
      );
    } finally {
      seen.delete(value.node);
    }
  };
  let proven = true;
  path.traverse({
    Function(inner) {
      inner.skip();
    },
    WithStatement(inner) {
      proven = false;
      inner.stop();
    },
    CallExpression(inner) {
      if (isDirectEval(inner)) {
        proven = false;
        inner.stop();
      }
    },
    TryStatement(inner) {
      // Finally may replace any completion. Keep this boundary explicit rather
      // than incorrectly certifying only the returns in the try body.
      if (inner.node.finalizer) {
        proven = false;
        inner.stop();
      }
    },
    ReturnStatement(inner) {
      const argument = inner.get("argument");
      if (argument.node && !primitive(argument as NodePath<t.Node>)) {
        proven = false;
        inner.stop();
      }
    }
  });
  if (!proven) return false;
  const body = path.get("body");
  return !Array.isArray(body) && (body.isBlockStatement() || primitive(body));
}

/** Conditional result contract: only a primitive actual argument may consume it.
 * Object arguments are not fresh and receive no ownership or alias permission.
 */
export function describeArgumentPrimitiveInvocation(
  path: NodePath<t.Node | null | undefined>
): { kind: "argument-primitive"; index: number } | undefined {
  if (
    (!path.isFunctionDeclaration() &&
      !path.isFunctionExpression() &&
      !path.isArrowFunctionExpression() &&
      !path.isObjectMethod()) ||
    path.node.async ||
    path.node.generator ||
    (path.isObjectMethod() && path.node.kind !== "method") ||
    !path.node.params.every(
      (parameter) =>
        t.isIdentifier(parameter) &&
        !["eval", "arguments"].includes(parameter.name)
    )
  )
    return;
  const body = path.get("body");
  if (Array.isArray(body)) return;
  const statements = body.isBlockStatement() ? body.get("body") : [];
  const result = body.isIdentifier()
    ? body
    : statements.length === 1 && statements[0].isReturnStatement()
      ? statements[0].get("argument")
      : undefined;
  if (!result?.isIdentifier()) return;
  const binding = result.scope.getBinding(result.node.name);
  const offset = runtimeParameterOffset(path.node.params);
  if (offset === undefined) return;
  const runtimeParameters = path.node.params.slice(offset);
  const index = runtimeParameters.findIndex((parameter) =>
    t.isIdentifier(parameter, { name: result.node.name })
  );
  if (
    index < 0 ||
    !binding?.constant ||
    binding.kind !== "param" ||
    binding.scope !== path.scope
  )
    return;
  return { kind: "argument-primitive", index };
}
