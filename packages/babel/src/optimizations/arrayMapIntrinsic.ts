import { branchEvaluationFacts } from "../extractionCalls/evaluation.js";
import {
  collectRuntimeSourceEvidence,
  createRealmSourceEvidence,
  isPossibleScriptGlobalBinding,
  mayExposeDocumentRealm,
  type RuntimeSourceEvidence,
  hasRuntimeBinding,
  hasLocalRuntimeShadow,
  isRuntimeSourceReference,
  isPossibleGlobalThis
} from "./runtimeSourceReference.js";
import { types as t, type NodePath } from "@babel/core";
import { hasDynamicScope } from "./dynamicScope.js";
import { initializedBefore } from "./initializedReferences.js";
import type { Binding } from "@babel/traverse";

const globals = new Set([
  "globalThis",
  "global",
  "window",
  "self",
  "top",
  "parent",
  "frames"
]);
const arrayObservationNames = [
  "Array",
  "Iterator",
  "Object",
  "Reflect",
  "Function",
  "eval"
];
function writesArrayRealmGlobal(evidence: RuntimeSourceEvidence): boolean {
  return (
    arrayObservationNames.some((name) => evidence.writesScriptGlobal(name)) ||
    [...globals].some((name) => evidence.writesScriptGlobal(name))
  );
}

// Calls through these prototype slots rely on native dispatch. Replacing one
// invalidates that premise across modules, including host-attested runtime views.
const nativePrototypeMethods = new Set([
  "hasOwnProperty",
  "propertyIsEnumerable",
  "isPrototypeOf",
  "toString",
  "toLocaleString"
]);
const dataDescriptorKeys = new Set([
  "value",
  "writable",
  "enumerable",
  "configurable"
]);
const descriptorReadKeys = new Set([...dataDescriptorKeys, "get", "set"]);

/** Describe only an own data descriptor. Arguments are still traversed. */
function isOwnDataDescriptor(node: t.Node | undefined): boolean {
  if (!t.isObjectExpression(node)) return false;
  let carriesData = false;
  for (const property of node.properties) {
    if (!t.isObjectProperty(property) || property.computed) return false;
    const key = t.isIdentifier(property.key)
      ? property.key.name
      : t.isStringLiteral(property.key)
        ? property.key.value
        : undefined;
    if (key === undefined || !dataDescriptorKeys.has(key)) return false;
    if (key === "value" || key === "writable") carriesData = true;
  }
  return carriesData;
}

const reflection = new Set([
  "defineProperty",
  "defineProperties",
  "assign",
  "set",
  "setPrototypeOf",
  "getPrototypeOf",
  "get"
]);
function name(
  path: NodePath<t.MemberExpression | t.OptionalMemberExpression>
): string | undefined {
  return !path.node.computed && t.isIdentifier(path.node.property)
    ? path.node.property.name
    : literalKey(path.get("property"));
}
// Bounded constant syntax only. Never use evaluator confidence as namespace authority.
function literalKey(
  path: NodePath<t.Node>,
  seen = new Set<t.Node>()
): string | undefined {
  // Exact literal concatenation only: no operand evaluation or coercion authority.
  if (
    path.isBinaryExpression({ operator: "+" }) &&
    t.isStringLiteral(path.node.left) &&
    t.isStringLiteral(path.node.right)
  )
    return path.node.left.value + path.node.right.value;
  if (path.isStringLiteral() || path.isNumericLiteral())
    return String(path.node.value);
  if (!path.isIdentifier() || seen.size >= 32 || seen.has(path.node))
    return undefined;
  const binding = path.scope.getBinding(path.node.name);
  if (
    !binding?.constant ||
    !binding.path.isVariableDeclarator() ||
    !t.isIdentifier(binding.path.node.id) ||
    !isRuntimeSourceReference(binding.path) ||
    !binding.path.parentPath.isVariableDeclaration({ kind: "const" }) ||
    binding.path.scope !== path.scope ||
    !initializedBefore(binding.path, path)
  )
    return undefined;
  const init = binding.path.get("init");
  return init.isExpression()
    ? literalKey(init, new Set(seen).add(path.node))
    : undefined;
}

// Follow only closed constant aliases. Unknown reads of a literal can acquire
// its inherited protected constructor; known unrelated keys stay independent.
function literalReceiver(
  path: NodePath<t.Node>,
  seen = new Set<t.Node>()
): boolean {
  if (path.isArrayExpression() || path.isObjectExpression()) return true;
  if (!path.isIdentifier() || seen.has(path.node) || seen.size >= 32)
    return false;
  const binding = path.scope.getBinding(path.node.name);
  if (
    !binding?.constant ||
    !binding.path.isVariableDeclarator() ||
    !t.isIdentifier(binding.path.node.id) ||
    !binding.path.parentPath.isVariableDeclaration({ kind: "const" })
  )
    return false;
  const init = binding.path.get("init");
  return (
    !!init.node &&
    literalReceiver(init as NodePath<t.Node>, new Set(seen).add(path.node))
  );
}

/** Follow only an observed protected-property demand. Other parameter reads
 * are not assigned an intrinsic origin, but do not by themselves veto. */
function usesComputedReceiverCapability(
  path: NodePath<t.Node>,
  evidence: RuntimeSourceEvidence,
  seen = new Set<t.Node>()
): boolean {
  if (seen.size >= 32 || seen.has(path.node)) return true;
  const use = path.parentPath;
  if (
    (use?.isMemberExpression() || use?.isOptionalMemberExpression()) &&
    use.node.object === path.node
  ) {
    const key = name(use);
    return (
      key === "prototype" ||
      key === "constructor" ||
      key === "__proto__" ||
      (key === undefined &&
        usesComputedReceiverCapability(
          use,
          evidence,
          new Set(seen).add(path.node)
        ))
    );
  }
  if (
    use?.isVariableDeclarator() &&
    use.node.init === path.node &&
    t.isIdentifier(use.node.id)
  ) {
    const binding = use.scope.getBinding(use.node.id.name);
    return (
      !!binding &&
      evidence
        .references(binding)
        .some((ref) =>
          usesComputedReceiverCapability(
            ref,
            evidence,
            new Set(seen).add(path.node)
          )
        )
    );
  }
  return false;
}

function written(path: NodePath<t.Node>): boolean {
  const use = path.parentPath;
  if (!use) return false;
  if (use.isObjectProperty() && use.parentPath.isObjectPattern())
    return path.key === "value" && written(use.parentPath);
  if (
    use.isArrayPattern() ||
    use.isRestElement() ||
    use.isObjectPattern() ||
    (use.isAssignmentPattern() && use.node.left === path.node)
  )
    return written(use);
  return (
    (use.isAssignmentExpression() && use.node.left === path.node) ||
    use.isUpdateExpression() ||
    use.isUnaryExpression({ operator: "delete" }) ||
    ((use.isForInStatement() || use.isForOfStatement()) &&
      use.node.left === path.node)
  );
}
function unobserved(path: NodePath<t.Node>): boolean {
  return (
    !!path.parentPath?.isExpressionStatement() ||
    !!(
      path.parentPath?.isUnaryExpression() &&
      ["typeof", "void"].includes(path.parentPath.node.operator)
    )
  );
}
function safeRoot(
  root: NodePath<t.Node>,
  kind: string,
  evidence: RuntimeSourceEvidence
): boolean {
  if (written(root)) return false;
  if (unobserved(root)) return true;
  const member = root.parentPath;
  if (
    !member?.isMemberExpression() ||
    member.node.object !== root.node ||
    written(member)
  )
    return false;
  const key = name(member);
  if (!key) return false;
  if (globals.has(kind)) {
    if (key === "document") return !mayExposeDocumentRealm(member, evidence);
    if (
      [
        "valueOf",
        "__defineGetter__",
        "__defineSetter__",
        "__lookupGetter__",
        "__lookupSetter__",
        "__proto__",
        "constructor"
      ].includes(key)
    )
      return false;
    if (globals.has(key)) return safeRoot(member, key, evidence);
    if (
      ["Array", "Iterator", "Object", "Reflect", "Function", "eval"].includes(
        key
      )
    )
      return safeRoot(member, key, evidence);
    return true;
  }
  if (kind === "Function" || kind === "eval") return false;
  if (
    [
      "prototype",
      "valueOf",
      "constructor",
      "__proto__",
      "__lookupGetter__",
      "__lookupSetter__",
      "__defineGetter__",
      "__defineSetter__"
    ].includes(key)
  )
    return false;
  if (kind === "Array" && !["isArray", "from", "of"].includes(key))
    return false;
  if ((kind === "Object" || kind === "Reflect") && reflection.has(key))
    return false;
  // An ordinary native static invocation does not expose its namespace. Its
  // arguments are still visited and callbacks/effects remain caller obligations.
  return (
    !!member.parentPath?.isCallExpression() &&
    member.parentPath.node.callee === member.node
  );
}

/** Pattern properties perform Get without a MemberExpression in the AST. */
function hasProtectedPatternRead(path: NodePath<t.ObjectPattern>): boolean {
  return (
    isRuntimeSourceReference(path) &&
    path.get("properties").some((property) => {
      if (!property.isObjectProperty()) return false; // Rest copies own keys only.
      // These operators return only Number/BigInt on normal completion, so
      // ToPropertyKey cannot select a protected string or symbol. Their operands
      // are still traversed: this is not permission to omit coercion or effects.
      if (
        property.node.computed &&
        t.isBinaryExpression(property.node.key) &&
        ["-", "*", "/", "%", "**", "<<", ">>", ">>>", "|", "&", "^"].includes(
          property.node.key.operator
        )
      )
        return false;
      const key =
        !property.node.computed && t.isIdentifier(property.node.key)
          ? property.node.key.name
          : literalKey(property.get("key") as NodePath<t.Node>);
      return (
        key === undefined ||
        [
          "constructor",
          "__proto__",
          "__lookupGetter__",
          "__lookupSetter__",
          "__defineGetter__",
          "__defineSetter__"
        ].includes(key)
      );
    })
  );
}

/** Native Array/map/constructor/species authority under standard realm semantics.
 * Any observed namespace/prototype/reflection escape withdraws it. The graph
 * owner must register every loaded source; this is not an arbitrary-code sandbox.
 */
export function hasObservableArrayMapMutation(
  program: NodePath<t.Program>,
  operation?: "iteration" | "prototype-absence"
): boolean {
  if (operation) {
    const observation = observePatternRealm(program);
    return operation === "iteration"
      ? !observation.iteration
      : observation.keys === null || observation.keys.length > 0;
  }
  return observeArrayMapMutation(
    program,
    collectRuntimeSourceEvidence(program)
  );
}
function observeArrayMapMutation(
  program: NodePath<t.Program>,
  evidence: RuntimeSourceEvidence
): boolean {
  if (!evidence.bindingsCurrent || writesArrayRealmGlobal(evidence))
    return true;
  if (hasDynamicScope(program)) return true;
  let observed = false;
  program.traverse({
    ObjectPattern(path) {
      if (!observed && hasProtectedPatternRead(path)) observed = true;
    },
    ThisExpression(path) {
      if (
        !observed &&
        isPossibleGlobalThis(path, evidence) &&
        isRuntimeSourceReference(path) &&
        !safeRoot(path, "globalThis", evidence)
      )
        observed = true;
    },
    "MemberExpression|OptionalMemberExpression"(path) {
      if (observed) return;
      if (!path.isMemberExpression() && !path.isOptionalMemberExpression())
        return;
      const member: NodePath<t.MemberExpression | t.OptionalMemberExpression> =
        path;
      const key = name(member);
      if (
        key === undefined &&
        member.node.computed &&
        isRuntimeSourceReference(member) &&
        (literalReceiver(member.get("object") as NodePath<t.Node>) ||
          usesComputedReceiverCapability(member, evidence))
      )
        observed = true;
      // Constructor recovery can expose Array or Function without their names.
      if (
        [
          "constructor",
          "__proto__",
          "__lookupGetter__",
          "__lookupSetter__",
          "__defineGetter__",
          "__defineSetter__"
        ].includes(key ?? "") &&
        isRuntimeSourceReference(path)
      )
        observed = true;
    },
    Identifier(path) {
      if (observed) return;
      const key = path.node.name;
      if (
        key === "document" &&
        path.isReferencedIdentifier() &&
        !hasLocalRuntimeShadow(path, key) &&
        isRuntimeSourceReference(path)
      ) {
        if (mayExposeDocumentRealm(path, evidence)) observed = true;
        return;
      }
      if (
        !globals.has(key) &&
        ![
          "Array",
          "Iterator",
          "Object",
          "Reflect",
          "Function",
          "eval"
        ].includes(key)
      )
        return;
      if (!path.isReferencedIdentifier() && !written(path)) return;
      if (hasLocalRuntimeShadow(path, key) || !isRuntimeSourceReference(path))
        return;
      if (
        key === "Function" ||
        key === "eval" ||
        !safeRoot(path, key, evidence)
      )
        observed = true;
    }
  });
  return observed;
}

function constructorDisplayAssignment(
  path: NodePath<t.MemberExpression | t.OptionalMemberExpression>,
  evidence: RuntimeSourceEvidence
): boolean {
  const capture = path.parentPath;
  if (
    !capture?.isAssignmentExpression({ operator: "=" }) ||
    capture.node.right !== path.node ||
    !t.isIdentifier(capture.node.left)
  )
    return false;
  const and = capture.parentPath;
  const fallback = and?.parentPath;
  const overwrite = fallback?.parentPath;
  if (
    !and?.isLogicalExpression({ operator: "&&" }) ||
    and.node.left !== capture.node ||
    !fallback?.isLogicalExpression({ operator: "||" }) ||
    fallback.node.left !== and.node ||
    !t.isStringLiteral(fallback.node.right) ||
    !overwrite?.isAssignmentExpression({ operator: "=" }) ||
    overwrite.node.right !== fallback.node ||
    !t.isIdentifier(overwrite.node.left, { name: capture.node.left.name })
  )
    return false;
  const localName = capture.node.left.name;
  const binding = capture.scope.getBinding(localName);
  if (!binding) return false;
  const display = (node: t.Node): boolean =>
    t.isLogicalExpression(node, { operator: "||" })
      ? display(node.left) && display(node.right)
      : t.isMemberExpression(node) &&
        !node.computed &&
        t.isIdentifier(node.object, { name: localName }) &&
        t.isIdentifier(node.property) &&
        ["name", "displayName"].includes(node.property.name);
  if (!display(and.node.right)) return false;
  return evidence
    .references(binding)
    .every(
      (ref) =>
        ref.getFunctionParent()?.node === path.getFunctionParent()?.node &&
        ((ref.node.end ?? Infinity) < (capture.node.start ?? -Infinity) ||
          (ref.node.start ?? -Infinity) > (overwrite.node.end ?? Infinity) ||
          ref.node === path.node.object ||
          ref.node === capture.node.left ||
          ref.node === overwrite.node.left ||
          (ref.parentPath?.isMemberExpression() &&
            ref.parentPath.node.object === ref.node &&
            ["name", "displayName"].includes(name(ref.parentPath) ?? "")))
    );
}

type SharedPatternRealm = {
  shadowsDispatch(name: string): boolean;
  touchesBinding(binding: Binding): boolean;
};

/** Observation-only unreachable callbacks under the standard realm (including
 * globalThis, Object.keys and Array#forEach). Never a value/purity/hoist proof.
 * Namespace writes/escapes elsewhere still revoke the enclosing environment.
 */
function unexecutedPatternObservations(
  program: NodePath<t.Program>,
  evidence: RuntimeSourceEvidence,
  shared?: SharedPatternRealm
): Set<t.Node> {
  const skipped = new Set<t.Node>();
  program.traverse({
    CallExpression(path) {
      const callee = path.get("callee");
      if (
        !callee.isMemberExpression() ||
        name(callee) !== "forEach" ||
        path.node.arguments.length !== 1
      )
        return;
      const callback = path.get("arguments")[0];
      if (
        !callback.isArrowFunctionExpression() &&
        !callback.isFunctionExpression()
      )
        return;
      const keys = callee.get("object");
      if (!keys.isCallExpression() || keys.node.arguments.length !== 1) return;
      const method = keys.get("callee");
      if (
        !method.isMemberExpression() ||
        name(method) !== "keys" ||
        !method.get("object").isIdentifier({ name: "Object" }) ||
        hasRuntimeBinding(method, "Object")
      )
        return;
      let input: NodePath<t.Node> = keys.get("arguments")[0];
      const binding = input.isIdentifier()
        ? input.scope.getBinding(input.node.name)
        : undefined;
      if (input.isIdentifier()) {
        if (
          !binding?.constant ||
          evidence.isExported(binding) ||
          !binding.path.isVariableDeclarator() ||
          !t.isIdentifier(binding.path.node.id) ||
          !evidence
            .references(binding)
            .every(
              (ref) =>
                ref.node === input.node ||
                !!ref.findParent((owner) => owner.node === callback.node)
            ) ||
          !binding.path.parentPath.isVariableDeclaration({ kind: "const" }) ||
          binding.path.scope !== path.scope ||
          (binding.path.node.end ?? Infinity) >= (path.node.start ?? -Infinity)
        )
          return;
        const initializer = binding.path.get("init");
        if (!initializer.isExpression()) return;
        input = initializer;
      }
      if (
        input.isObjectExpression() &&
        input.node.properties.length === 0 &&
        (!binding || !shared?.touchesBinding(binding))
      )
        skipped.add(callback.node);
    }
  });
  const onlyUnexecutedUses = (
    path: NodePath<t.VariableDeclarator>
  ): boolean => {
    if (
      !t.isIdentifier(path.node.id) ||
      !path.parentPath.isVariableDeclaration({ kind: "const" }) ||
      path.parentPath.parentPath?.isExportNamedDeclaration()
    )
      return false;
    const binding = path.scope.getBinding(path.node.id.name);
    return (
      !!binding?.constant &&
      evidence
        .references(binding)
        .every((ref) => !!ref.findParent((owner) => skipped.has(owner.node))) &&
      !shared?.touchesBinding(binding)
    );
  };
  const isRealm = (path: NodePath<t.Node | null | undefined>) =>
    path.isIdentifier({ name: "globalThis" }) &&
    !hasRuntimeBinding(path, "globalThis");
  const realmExists = (path: NodePath<t.Node>): boolean => {
    if (!path.isBinaryExpression({ operator: "!==" })) return false;
    const left = path.get("left"),
      right = path.get("right");
    return (
      left.isUnaryExpression({ operator: "typeof" }) &&
      isRealm(left.get("argument")) &&
      right.isStringLiteral({ value: "undefined" })
    );
  };
  program.traverse({
    VariableDeclarator(path) {
      const init = path.get("init");
      // Recognize the exact local candidate before consulting other programs.
      // Fresh realm evidence may traverse their entire AST for this check.
      if (isRealm(init)) {
        if (onlyUnexecutedUses(path)) skipped.add(init.node!);
        return;
      }
      if (!init.isCallExpression() || init.node.arguments.length !== 0) return;
      const callee = init.get("callee");
      if (
        (!callee.isArrowFunctionExpression() &&
          !callee.isFunctionExpression()) ||
        callee.node.params.length !== 0 ||
        callee.node.async ||
        callee.node.generator
      )
        return;
      const fn: NodePath<t.ArrowFunctionExpression | t.FunctionExpression> =
        callee;
      const body = fn.get("body");
      if (!body.isBlockStatement()) return;
      const first = body.get("body")[0];
      if (!first?.isIfStatement() || !realmExists(first.get("test"))) return;
      let selected: NodePath<t.Node> = first.get("consequent");
      if (selected.isBlockStatement() && selected.node.body.length === 1)
        selected = selected.get("body")[0];
      if (
        selected.isReturnStatement() &&
        isRealm(selected.get("argument")) &&
        onlyUnexecutedUses(path)
      )
        skipped.add(init.node);
    }
  });
  return skipped;
}

/** Pattern replay uses the existing standard-intrinsics environment assumption,
 * not the stronger map/result proof. Generic reflection on ordinary unknown
 * targets is not evidence of intrinsic mutation, nor certified pure or fresh.
 * Explicit protected capability acquisition, mutation and escape withdraw it.
 */
export function observePatternRealm(
  program: NodePath<t.Program>,
  branches = branchEvaluationFacts(program)
): {
  iteration: boolean;
  keys: string[] | null;
  bindingsCurrent: boolean;
  hasGlobalEval: boolean;
  references: RuntimeSourceEvidence["references"];
  mayHaveUnmodeledShadow: RuntimeSourceEvidence["mayHaveUnmodeledShadow"];
} {
  const evidence = collectRuntimeSourceEvidence(program);
  return {
    ...observeFreshPatternRealm(program, evidence, undefined, branches),
    bindingsCurrent: evidence.bindingsCurrent,
    hasGlobalEval: evidence.hasGlobalEval,
    references: evidence.references,
    mayHaveUnmodeledShadow: evidence.mayHaveUnmodeledShadow
  };
}
function observeFreshPatternRealm(
  program: NodePath<t.Program>,
  evidence: RuntimeSourceEvidence,
  shared?: SharedPatternRealm,
  branches = branchEvaluationFacts(program)
): { iteration: boolean; keys: string[] | null } {
  if (!evidence.bindingsCurrent || writesArrayRealmGlobal(evidence))
    return { iteration: false, keys: null };
  let iteration = true;
  let keys: Set<string> | null = new Set();
  const revoke = () => {
    iteration = false;
    keys = null;
  };
  const change = (key: string | undefined) => {
    if (
      key === undefined ||
      key === "forEach" ||
      nativePrototypeMethods.has(key) ||
      descriptorReadKeys.has(key)
    ) {
      revoke();
      return;
    }
    keys?.add(key);
    if (
      /^(?:0|[1-9]\d*)$/.test(key) ||
      [
        "forEach",
        "next",
        "return",
        "throw",
        "__proto__",
        "prototype",
        "constructor"
      ].includes(key)
    )
      iteration = false;
  };
  const member = (path: NodePath<t.Node>) =>
    path.isMemberExpression() || path.isOptionalMemberExpression();
  // Native method aliases may only be called (or .call/.apply invoked), never
  // handed to opaque code. Arguments and callback bodies remain traversed.
  const methodUse = (
    path: NodePath<t.Node>,
    seen = new Set<t.Node>()
  ): boolean => {
    if (seen.size >= 32 || seen.has(path.node) || written(path)) return false;
    const use = path.parentPath;
    if (unobserved(path)) return true;
    if (use?.isCallExpression() && use.node.callee === path.node) return true;
    if (
      use &&
      member(use) &&
      use.node.object === path.node &&
      ["call", "apply"].includes(name(use) ?? "")
    )
      return (
        !!use.parentPath?.isCallExpression() &&
        use.parentPath.node.callee === use.node
      );
    if (
      use?.isLogicalExpression({ operator: "&&" }) &&
      use.node.left === path.node
    )
      return true;
    if (
      !use?.isVariableDeclarator() ||
      use.node.init !== path.node ||
      !t.isIdentifier(use.node.id)
    )
      return false;
    const binding = use.scope.getBinding(use.node.id.name);
    return (
      !!binding?.constant &&
      evidence
        .references(binding)
        .every((ref) => methodUse(ref, new Set(seen).add(path.node)))
    );
  };
  const prototypeUse = (path: NodePath<t.Node>): void => {
    if (written(path)) {
      revoke();
      return;
    }
    const use = path.parentPath;
    if (use && member(use) && use.node.object === path.node) {
      const key = name(use);
      if (written(use)) {
        change(key);
        return;
      }
      if (key === "constructor" || key === "__proto__" || key === undefined) {
        revoke();
        return;
      }
      if (["__defineGetter__", "__defineSetter__"].includes(key)) {
        revoke();
        return;
      }
      if (!nativePrototypeMethods.has(key) || !methodUse(use)) revoke();
      return;
    }
    if (use?.isCallExpression() && use.node.arguments[0] === path.node) {
      const callee = use.get("callee");
      // Only an unused defineProperty result cannot expose the prototype again.
      if (
        callee.isMemberExpression() &&
        name(callee) === "defineProperty" &&
        callee.get("object").isIdentifier() &&
        ["Object", "Reflect"].includes(
          callee.node.object.type === "Identifier"
            ? callee.node.object.name
            : ""
        ) &&
        !hasRuntimeBinding(callee, (callee.node.object as t.Identifier).name) &&
        !shared?.shadowsDispatch((callee.node.object as t.Identifier).name) &&
        unobserved(use)
      ) {
        if (
          use.node.arguments.length !== 3 ||
          !isOwnDataDescriptor(use.node.arguments[2])
        ) {
          revoke();
          return;
        }
        const key = use.get("arguments")[1];
        change(key ? literalKey(key) : undefined);
        return;
      }
    }
    if (!unobserved(path)) revoke();
  };
  const rootUse = (path: NodePath<t.Node>, kind: string): void => {
    if (written(path)) {
      revoke();
      return;
    }
    if (unobserved(path)) return;
    const use = path.parentPath;
    if (globals.has(kind)) {
      if (
        use?.isBinaryExpression({ operator: "in" }) &&
        use.node.right === path.node
      )
        return;
      if (
        use?.isVariableDeclarator() &&
        use.node.init === path.node &&
        t.isObjectPattern(use.node.id) &&
        use.node.id.properties.every(
          (property) =>
            t.isObjectProperty(property) &&
            !property.computed &&
            t.isIdentifier(property.key) &&
            !globals.has(property.key.name) &&
            ![
              "valueOf",
              "__defineGetter__",
              "__defineSetter__",
              "__lookupGetter__",
              "__lookupSetter__",
              "__proto__",
              "constructor"
            ].includes(property.key.name) &&
            ![
              "Array",
              "Iterator",
              "Object",
              "Function",
              "Reflect",
              "eval"
            ].includes(property.key.name) &&
            (property.key.name !== "document" ||
              (() => {
                if (!t.isIdentifier(property.value)) return false;
                const binding = use.scope.getBinding(property.value.name);
                return (
                  !!binding?.constant &&
                  !evidence.isExported(binding) &&
                  !isPossibleScriptGlobalBinding(binding) &&
                  evidence
                    .references(binding)
                    .every((ref) => !mayExposeDocumentRealm(ref, evidence)) &&
                  evidence.hasSharedLexicalUse?.(binding) !== true
                );
              })())
        )
      )
        return;
      if (!use || !member(use) || use.node.object !== path.node) {
        revoke();
        return;
      }
      const key = name(use);
      if (!key) {
        revoke();
        return;
      }
      if (
        [
          "valueOf",
          "__defineGetter__",
          "__defineSetter__",
          "__lookupGetter__",
          "__lookupSetter__",
          "__proto__",
          "constructor"
        ].includes(key)
      ) {
        revoke();
        return;
      }
      if (key === "document") {
        if (mayExposeDocumentRealm(use, evidence)) revoke();
        return;
      }
      if (
        globals.has(key) ||
        ["Array", "Iterator", "Object", "Reflect", "Function", "eval"].includes(
          key
        )
      )
        rootUse(use, key);
      return;
    }
    if (kind === "Function" || kind === "eval") {
      revoke();
      return;
    }
    if (
      (kind === "Array" || kind === "Object") &&
      (use?.isCallExpression() || use?.isNewExpression()) &&
      use.node.callee === path.node
    )
      return;
    if (!use || !member(use) || use.node.object !== path.node || written(use)) {
      revoke();
      return;
    }
    const key = name(use);
    if (key === "prototype") {
      prototypeUse(use);
      return;
    }
    if (
      !key ||
      ["getPrototypeOf", "get", "constructor", "__proto__", "valueOf"].includes(
        key
      )
    ) {
      revoke();
      return;
    }
    if (!methodUse(use)) revoke();
  };
  if (hasDynamicScope(program)) revoke();
  const skipped =
    shared?.shadowsDispatch("Object") || shared?.shadowsDispatch("globalThis")
      ? new Set<t.Node>()
      : unexecutedPatternObservations(program, evidence, shared);
  program.traverse({
    ObjectPattern(path) {
      if (hasProtectedPatternRead(path)) revoke();
    },
    enter(path) {
      if (skipped.has(path.node) || branches.excludesChild(path)) path.skip();
    },
    ThisExpression(path) {
      if (
        isPossibleGlobalThis(path, evidence) &&
        isRuntimeSourceReference(path)
      )
        rootUse(path, "globalThis");
    },
    Identifier(path) {
      const key = path.node.name;
      if (
        key === "document" &&
        path.isReferencedIdentifier() &&
        !hasLocalRuntimeShadow(path, key) &&
        isRuntimeSourceReference(path)
      ) {
        if (mayExposeDocumentRealm(path, evidence)) revoke();
        return;
      }
      if (
        (globals.has(key) ||
          [
            "Array",
            "Iterator",
            "Object",
            "Reflect",
            "Function",
            "eval"
          ].includes(key)) &&
        (path.isReferencedIdentifier() || written(path)) &&
        !hasLocalRuntimeShadow(path, key) &&
        isRuntimeSourceReference(path)
      )
        rootUse(path, key);
    },
    "MemberExpression|OptionalMemberExpression"(path) {
      if (!member(path) || !isRuntimeSourceReference(path)) return;
      const key = name(path);
      if (
        key === undefined &&
        path.node.computed &&
        (literalReceiver(path.get("object") as NodePath<t.Node>) ||
          usesComputedReceiverCapability(path, evidence))
      ) {
        revoke();
        return;
      }
      if (
        ![
          "constructor",
          "__proto__",
          "__lookupGetter__",
          "__lookupSetter__",
          "__defineGetter__",
          "__defineSetter__"
        ].includes(key ?? "")
      )
        return;
      // A write of an ordinary object's constructor does not acquire its identity.
      // Protected namespace writes are separately caught by rootUse above.
      if (
        key === "constructor" &&
        path.parentPath?.isAssignmentExpression({ operator: "=" }) &&
        path.parentPath.node.left === path.node
      )
        return;
      const use = path.parentPath;
      if (key === "constructor") {
        if (
          use?.isBinaryExpression() &&
          ["===", "!=="].includes(use.node.operator)
        )
          return;
        if (
          use?.isVariableDeclarator() &&
          use.node.init === path.node &&
          t.isIdentifier(use.node.id)
        ) {
          const binding = use.scope.getBinding(use.node.id.name);
          if (
            binding?.constant &&
            !evidence.isExported(binding) &&
            !evidence.hasGlobalPropertyUse(binding) &&
            !isPossibleScriptGlobalBinding(binding) &&
            evidence.references(binding).length === 0 &&
            !shared?.touchesBinding(binding)
          )
            return;
        }
        if (
          use &&
          member(use) &&
          use.node.object === path.node &&
          name(use) === "name" &&
          !written(use) &&
          !(
            (use.parentPath?.isCallExpression() ||
              use.parentPath?.isNewExpression()) &&
            use.parentPath.node.callee === use.node
          ) &&
          !(
            use.parentPath?.isTaggedTemplateExpression() &&
            use.parentPath.node.tag === use.node
          )
        )
          return;
        if (constructorDisplayAssignment(path, evidence)) return;
      }
      revoke();
    }
  });
  return { iteration, keys: keys === null ? null : [...keys].sort() };
}
export function observedPrototypeMutationKeys(
  program: NodePath<t.Program>
): readonly string[] | null {
  return observePatternRealm(program).keys;
}
/** Narrow input/result contract. Holes stay holes; callback cannot throw or
 * observe state. Element expressions may still throw/mutate and must not move.
 */
export function isIdentityArrayMapCall(
  path: NodePath<t.CallExpression | t.OptionalCallExpression>
): path is NodePath<t.CallExpression> {
  if (
    !path.isCallExpression() ||
    path.node.optional ||
    path.node.arguments.length !== 1
  )
    return false;
  const callee = path.get("callee");
  if (!callee.isMemberExpression() || name(callee) !== "map") return false;
  const receiver = callee.get("object");
  if (
    !receiver.isArrayExpression() ||
    receiver.node.elements.some((element) => t.isSpreadElement(element))
  )
    return false;
  const callback = path.get("arguments")[0];
  if (
    (!callback.isArrowFunctionExpression() &&
      !callback.isFunctionExpression()) ||
    callback.node.async ||
    callback.node.generator ||
    callback.node.params.length !== 1 ||
    !t.isIdentifier(callback.node.params[0])
  )
    return false;
  const parameter = callback.node.params[0].name;
  const body = callback.node.body;
  return (
    t.isIdentifier(body, { name: parameter }) ||
    (t.isBlockStatement(body) &&
      body.body.length === 1 &&
      t.isReturnStatement(body.body[0]) &&
      t.isIdentifier(body.body[0].argument, { name: parameter }))
  );
}

/** Dense fresh slots and one search argument: SameValueZero does not coerce
 * elements/search. Extra fromIndex coercion is deliberately outside this proof. */
export function isDenseArrayIncludesCall(
  path: NodePath<t.CallExpression | t.OptionalCallExpression>
): path is NodePath<t.CallExpression> {
  if (
    !path.isCallExpression() ||
    path.node.optional ||
    path.node.arguments.length !== 1 ||
    t.isSpreadElement(path.node.arguments[0])
  )
    return false;
  const callee = path.get("callee");
  if (!callee.isMemberExpression() || name(callee) !== "includes") return false;
  const receiver = callee.get("object");
  return (
    receiver.isArrayExpression() &&
    receiver.node.elements.every(
      (element) => !!element && !t.isSpreadElement(element)
    )
  );
}

export function createArrayMapIntrinsicEnvironment(
  options: {
    /** Internal host observation only. The issuer must revalidate the exact current
     * runtime AST/source and generation on every query. Never affects native map,
     * result ownership, purity, or another program's observations. */
    validatesPatternIntrinsicEffects?: (
      program: NodePath<t.Program>
    ) => boolean;
  } = {}
) {
  const programs = new Set<NodePath<t.Program>>();
  let revision = 0;
  let invalidated = false;
  let iterationInvalidated = false;
  let absenceInvalidated = false;
  let prototypeKeys: Set<string> | null = new Set();
  const validate = () => {
    const evidenceFor = createRealmSourceEvidence(programs);
    if (
      !invalidated &&
      [...programs].some((program) => {
        return observeArrayMapMutation(program, evidenceFor(program));
      })
    ) {
      invalidated = true;
      revision++;
    }
    // Share only this synchronous pass; AST edits require a fresh next pass.
    if (
      !iterationInvalidated ||
      !absenceInvalidated ||
      prototypeKeys !== null
    ) {
      // Use one current realm view for every narrow authority below, not
      // program-local references for bindings classic scripts may share.
      const lexicalOwners = new Map<string, Set<t.Program>>();
      if (programs.size > 1) {
        for (const { node } of programs) {
          if (node.sourceType !== "script") continue;
          for (const statement of node.body) {
            if (
              (!t.isVariableDeclaration(statement) &&
                !t.isClassDeclaration(statement)) ||
              statement.declare ||
              (t.isVariableDeclaration(statement) &&
                statement.kind !== "const" &&
                statement.kind !== "let")
            )
              continue;
            for (const name of Object.keys(
              t.getBindingIdentifiers(statement)
            )) {
              const owners = lexicalOwners.get(name) ?? new Set<t.Program>();
              owners.add(node);
              lexicalOwners.set(name, owners);
            }
          }
        }
      }
      for (const program of programs) {
        if (
          iterationInvalidated &&
          absenceInvalidated &&
          prototypeKeys === null
        )
          break;
        const current = evidenceFor(program);
        const shared: SharedPatternRealm = {
          shadowsDispatch(name) {
            const owners = lexicalOwners.get(name);
            return !!owners && (owners.size > 1 || !owners.has(program.node));
          },
          touchesBinding(binding) {
            return current.hasSharedLexicalUse?.(binding) === true;
          }
        };
        const observation =
          current.bindingsCurrent &&
          !["Object", "Reflect", "globalThis"].some(shared.shadowsDispatch) &&
          (program.node.sourceType !== "script" || programs.size === 1) &&
          options.validatesPatternIntrinsicEffects?.(program) === true
            ? { iteration: true, keys: [] }
            : observeFreshPatternRealm(program, current, shared);
        if (!iterationInvalidated && !observation.iteration) {
          iterationInvalidated = true;
          revision++;
        }
        if (
          !absenceInvalidated &&
          (observation.keys === null || observation.keys.length > 0)
        ) {
          absenceInvalidated = true;
          revision++;
        }
        if (prototypeKeys !== null) {
          if (observation.keys === null) {
            prototypeKeys = null;
            revision++;
          } else
            for (const key of observation.keys)
              if (!prototypeKeys.has(key)) {
                prototypeKeys.add(key);
                revision++;
              }
        }
      }
    }
    return !invalidated;
  };
  return {
    observe(program: NodePath<t.Program>) {
      if (!programs.has(program)) {
        programs.add(program);
        revision++;
      }
    },
    snapshot() {
      const intact = validate();
      return {
        intact,
        iterationIntact: !iterationInvalidated,
        prototypeAbsenceIntact: !absenceInvalidated,
        prototypeMutationKeys:
          prototypeKeys === null ? null : [...prototypeKeys].sort(),
        revision
      };
    },
    provesNativeIncludes(
      call: NodePath<t.CallExpression | t.OptionalCallExpression>
    ) {
      const program = call.scope.getProgramParent().path;
      if (!program.isProgram() || !isDenseArrayIncludesCall(call)) return false;
      if (!programs.has(program)) {
        programs.add(program);
        revision++;
      }
      return validate();
    },
    provesNativeMap(
      call: NodePath<t.CallExpression | t.OptionalCallExpression>
    ) {
      const program = call.scope.getProgramParent().path;
      if (!program.isProgram() || !isIdentityArrayMapCall(call)) return false;
      if (!programs.has(program)) {
        programs.add(program);
        revision++;
      }
      return validate();
    }
  };
}
