import {
  collectRuntimeSourceEvidence,
  createRealmSourceEvidence,
  closedRuntimeString as closedString,
  mayExposeDocumentRealm,
  hasLocalRuntimeShadow,
  type RuntimeSourceEvidence,
  hasRuntimeBinding,
  isRuntimeSourceReference,
  isPossibleGlobalThis
} from "./runtimeSourceReference.js";
import { types as t, type NodePath } from "@babel/core";
import { hasDynamicScope } from "./dynamicScope.js";

// Result contracts only. In particular random is NOT deterministic, and every
// method can observe argument coercions or throw. Never use this as replay,
// readonly-call, constant-folding, or argument-elision permission.
const numericMethods = new Set([
  "abs",
  "acos",
  "acosh",
  "asin",
  "asinh",
  "atan",
  "atanh",
  "atan2",
  "cbrt",
  "ceil",
  "clz32",
  "cos",
  "cosh",
  "exp",
  "expm1",
  "floor",
  "fround",
  "hypot",
  "imul",
  "log",
  "log1p",
  "log2",
  "log10",
  "max",
  "min",
  "pow",
  "random",
  "round",
  "sign",
  "sin",
  "sinh",
  "sqrt",
  "tan",
  "tanh",
  "trunc"
]);
const numericConstants = new Set([
  "E",
  "LN10",
  "LN2",
  "LOG10E",
  "LOG2E",
  "PI",
  "SQRT1_2",
  "SQRT2"
]);

type ScopeShadowCheck = RuntimeSourceEvidence["mayHaveUnmodeledShadow"];

function memberName(
  path: NodePath<t.MemberExpression | t.OptionalMemberExpression>,
  mayHaveUnmodeledShadow?: ScopeShadowCheck
): string | undefined {
  const { computed, property } = path.node;
  return !computed && t.isIdentifier(property)
    ? property.name
    : closedString(
        path.get("property") as NodePath<t.Node>,
        mayHaveUnmodeledShadow
      );
}
function written(path: NodePath<t.Node>): boolean {
  const parent = path.parentPath;
  if (
    (parent?.isObjectProperty() &&
      parent.node.value === path.node &&
      parent.parentPath.isObjectPattern()) ||
    parent?.isObjectPattern() ||
    parent?.isArrayPattern() ||
    parent?.isRestElement() ||
    (parent?.isAssignmentPattern() && parent.node.left === path.node)
  )
    return written(parent);
  const use = path.parentPath;
  return (
    !!use &&
    ((use.isAssignmentExpression() && use.node.left === path.node) ||
      use.isUpdateExpression() ||
      use.isUnaryExpression({ operator: "delete" }) ||
      ((use.isForInStatement() || use.isForOfStatement()) &&
        use.node.left === path.node))
  );
}
function unobservedReference(path: NodePath<t.Node>): boolean {
  const use = path.parentPath;
  return (
    !!use &&
    (use.isExpressionStatement() ||
      (use.isUnaryExpression() &&
        (use.node.operator === "typeof" || use.node.operator === "void")))
  );
}
type AliasKind = "namespace" | "method";
function constantAlias(
  path: NodePath<t.Node>,
  mayHaveUnmodeledShadow?: ScopeShadowCheck
) {
  if (!path.isIdentifier()) return;
  const binding = path.scope.getBinding(path.node.name);
  return binding?.constant &&
    binding.path.isVariableDeclarator() &&
    binding.path.parentPath.isVariableDeclaration({ kind: "const" }) &&
    isRuntimeSourceReference(binding.path) &&
    !mayHaveUnmodeledShadow?.(path.scope, path.node.name, binding.scope)
    ? binding
    : undefined;
}
/** Unknown values may be callable; only closed constant data rules that out. */
function possibleCallableOrigin(
  path: NodePath<t.Node>,
  seen = new Set<t.Node>(),
  budget = { remaining: 256 }
): boolean {
  if (--budget.remaining < 0 || seen.has(path.node) || seen.size > 32)
    return true;
  if (path.isObjectExpression())
    return path
      .get("properties")
      .some(
        (property) =>
          !property.isObjectProperty() ||
          property.node.computed ||
          t.isIdentifier(property.node.key, { name: "__proto__" }) ||
          t.isStringLiteral(property.node.key, { value: "__proto__" }) ||
          possibleCallableOrigin(
            property.get("value") as NodePath<t.Node>,
            new Set(seen).add(path.node),
            budget
          )
      );
  if (path.isArrayExpression())
    return path
      .get("elements")
      .some(
        (element) =>
          !!element.node &&
          (element.isSpreadElement() ||
            possibleCallableOrigin(
              element as NodePath<t.Node>,
              new Set(seen).add(path.node),
              budget
            ))
      );
  if (path.isLiteral()) return false;
  if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
    const object = (
      path as NodePath<t.MemberExpression | t.OptionalMemberExpression>
    ).get("object");
    const key = memberName(path);
    if (object.isObjectExpression() && key !== undefined) {
      const properties = object.get("properties");
      if (
        properties.every(
          (property) =>
            property.isObjectProperty() &&
            !property.node.computed &&
            (t.isIdentifier(property.node.key) ||
              t.isStringLiteral(property.node.key) ||
              t.isNumericLiteral(property.node.key)) &&
            !(
              t.isIdentifier(property.node.key, { name: "__proto__" }) ||
              t.isStringLiteral(property.node.key, { value: "__proto__" })
            )
        )
      ) {
        const selected = [...properties]
          .reverse()
          .find(
            (property) =>
              property.isObjectProperty() &&
              (t.isIdentifier(property.node.key)
                ? property.node.key.name
                : t.isStringLiteral(property.node.key)
                  ? property.node.key.value
                  : t.isNumericLiteral(property.node.key)
                    ? String(property.node.key.value)
                    : undefined) === key
          );
        if (selected?.isObjectProperty())
          return possibleCallableOrigin(
            selected.get("value") as NodePath<t.Node>,
            new Set(seen).add(path.node),
            budget
          );
      }
    }
  }
  if (!path.isIdentifier()) return true;
  const binding = path.scope.getBinding(path.node.name);
  if (!binding?.constant) return true;
  const alias = constantAlias(path);
  if (
    !alias ||
    !alias.path.isVariableDeclarator() ||
    !t.isIdentifier(alias.path.node.id)
  )
    return true;
  const init = alias.path.get("init");
  return (
    !init.node ||
    possibleCallableOrigin(
      init as NodePath<t.Node>,
      new Set(seen).add(path.node),
      budget
    )
  );
}
function namespaceOrigin(
  path: NodePath<t.Node>,
  shadow?: ScopeShadowCheck,
  seen = new Set<t.Node>()
): boolean {
  if (seen.size > 32 || seen.has(path.node)) return false;
  const next = new Set(seen).add(path.node);
  if (
    path.isIdentifier({ name: "Math" }) &&
    !hasRuntimeBinding(path, "Math") &&
    !shadow?.(path.scope, "Math")
  )
    return true;
  const binding = constantAlias(path, shadow);
  return (
    !!binding &&
    binding.path.isVariableDeclarator() &&
    t.isIdentifier(binding.path.node.id) &&
    namespaceOrigin(binding.path.get("init") as NodePath<t.Node>, shadow, next)
  );
}
function methodOrigin(
  path: NodePath<t.Node>,
  shadow?: ScopeShadowCheck,
  seen = new Set<t.Node>()
): { name: string; bound: boolean } | undefined {
  if (seen.size > 32 || seen.has(path.node)) return;
  const next = new Set(seen).add(path.node);
  if (
    (path.isMemberExpression() || path.isOptionalMemberExpression()) &&
    namespaceOrigin(
      (path as NodePath<t.MemberExpression | t.OptionalMemberExpression>).get(
        "object"
      ),
      shadow
    )
  ) {
    const name = memberName(path, shadow);
    return name && numericMethods.has(name)
      ? { name, bound: false }
      : undefined;
  }
  if (path.isCallExpression() || path.isOptionalCallExpression()) {
    const call = path as NodePath<t.CallExpression | t.OptionalCallExpression>;
    const callee = call.get("callee");
    const args = call.get("arguments");
    if (
      (callee.isMemberExpression() || callee.isOptionalMemberExpression()) &&
      memberName(callee, shadow) === "bind" &&
      args.length >= 1 &&
      !call.node.arguments.some((argument) =>
        t.isArgumentPlaceholder(argument)
      ) &&
      namespaceOrigin(args[0], shadow)
    ) {
      const origin = methodOrigin(
        (
          callee as NodePath<t.MemberExpression | t.OptionalMemberExpression>
        ).get("object"),
        shadow,
        next
      );
      return origin ? { ...origin, bound: true } : undefined;
    }
  }
  const binding = constantAlias(path, shadow);
  if (!binding) return;
  const declaration = binding.path;
  if (!declaration.isVariableDeclarator()) return;
  if (t.isIdentifier(declaration.node.id))
    return methodOrigin(
      declaration.get("init") as NodePath<t.Node>,
      shadow,
      next
    );
  if (
    !t.isObjectPattern(declaration.node.id) ||
    !namespaceOrigin(declaration.get("init") as NodePath<t.Node>, shadow)
  )
    return;
  for (const property of declaration.node.id.properties) {
    if (
      !t.isObjectProperty(property) ||
      property.computed ||
      !t.isIdentifier(property.value, { name: binding.identifier.name })
    )
      continue;
    const name = t.isIdentifier(property.key)
      ? property.key.name
      : t.isStringLiteral(property.key)
        ? property.key.value
        : undefined;
    if (name && numericMethods.has(name)) return { name, bound: false };
  }
}
function methodDependencies(
  path: NodePath<t.Node>,
  shadow?: ScopeShadowCheck,
  seen = new Set<t.Node>()
): NodePath<t.Node>[] {
  if (seen.size > 32 || seen.has(path.node)) return [];
  const next = new Set(seen).add(path.node);
  if (path.isCallExpression() || path.isOptionalCallExpression()) {
    const call = path as NodePath<t.CallExpression | t.OptionalCallExpression>;
    const callee = call.get("callee");
    if (
      (callee.isMemberExpression() || callee.isOptionalMemberExpression()) &&
      memberName(callee, shadow) === "bind"
    )
      return [
        ...methodDependencies(
          (
            callee as NodePath<t.MemberExpression | t.OptionalMemberExpression>
          ).get("object"),
          shadow,
          next
        ),
        ...call.get("arguments").slice(1)
      ];
  }
  const binding = constantAlias(path, shadow);
  if (
    binding?.path.isVariableDeclarator() &&
    t.isIdentifier(binding.path.node.id)
  )
    return methodDependencies(
      binding.path.get("init") as NodePath<t.Node>,
      shadow,
      next
    );
  return [];
}

export interface MathReferenceIdentity {
  kind: "namespace" | "method" | "bind";
  /** Bound arguments still execute and may contain runtime reads/coercions. */
  dependencies: readonly NodePath<t.Node>[];
}

function safeAliasDeclaration(
  value: NodePath<t.Node>,
  kind: AliasKind,
  seen: Set<t.Node>,
  evidence: RuntimeSourceEvidence
): boolean {
  const declaration = value.parentPath;
  if (
    !declaration?.isVariableDeclarator() ||
    declaration.node.init !== value.node ||
    !declaration.parentPath.isVariableDeclaration({ kind: "const" }) ||
    declaration.parentPath.parentPath?.isExportNamedDeclaration()
  )
    return false;
  const check = (name: string, aliasKind: AliasKind) => {
    const binding = declaration.scope.getBinding(name);
    return (
      !!binding?.constant &&
      evidence
        .references(binding)
        .every((reference) =>
          aliasKind === "namespace"
            ? safeNamespaceUse(reference, seen, evidence)
            : safeMethodUse(reference, seen, evidence)
        ) &&
      evidence.hasSharedLexicalUse?.(binding) !== true
    );
  };
  if (t.isIdentifier(declaration.node.id))
    return check(declaration.node.id.name, kind);
  return (
    kind === "namespace" &&
    t.isObjectPattern(declaration.node.id) &&
    declaration.node.id.properties.every((property) => {
      if (
        !t.isObjectProperty(property) ||
        property.computed ||
        !t.isIdentifier(property.value)
      )
        return false;
      const name = t.isIdentifier(property.key)
        ? property.key.name
        : t.isStringLiteral(property.key)
          ? property.key.value
          : undefined;
      return (
        !!name &&
        numericMethods.has(name) &&
        check(property.value.name, "method")
      );
    })
  );
}
function safeMethodUse(
  method: NodePath<t.Node>,
  seen: Set<t.Node>,
  evidence: RuntimeSourceEvidence
): boolean {
  if (seen.size > 64 || seen.has(method.node) || written(method)) return false;
  const next = new Set(seen).add(method.node);
  if (unobservedReference(method)) return true;
  const use = method.parentPath;
  if (
    (use?.isCallExpression() || use?.isOptionalCallExpression()) &&
    use.node.callee === method.node
  )
    return true;
  if (
    (use?.isMemberExpression() || use?.isOptionalMemberExpression()) &&
    use.node.object === method.node &&
    memberName(use, evidence.mayHaveUnmodeledShadow) === "bind"
  ) {
    const call = use.parentPath;
    return (
      (call?.isCallExpression() || call?.isOptionalCallExpression()) &&
      call.node.callee === use.node &&
      !!methodOrigin(call, evidence.mayHaveUnmodeledShadow) &&
      safeMethodUse(call, next, evidence)
    );
  }
  return safeAliasDeclaration(method, "method", next, evidence);
}
function safeNamespaceUse(
  namespace: NodePath<t.Node>,
  seen: Set<t.Node>,
  evidence: RuntimeSourceEvidence
): boolean {
  if (seen.size > 64 || seen.has(namespace.node) || written(namespace))
    return false;
  const next = new Set(seen).add(namespace.node);
  if (unobservedReference(namespace)) return true;
  const member = namespace.parentPath;
  // Native bind observes its receiver as thisArg but does not expose it. The
  // bound-result references and Function.prototype.bind authority are checked.
  if (
    (member?.isCallExpression() || member?.isOptionalCallExpression()) &&
    member.node.arguments[0] === namespace.node &&
    methodOrigin(member, evidence.mayHaveUnmodeledShadow)
  )
    return safeMethodUse(member, next, evidence);
  if (
    !(member?.isMemberExpression() || member?.isOptionalMemberExpression()) ||
    member.node.object !== namespace.node
  )
    return safeAliasDeclaration(namespace, "namespace", next, evidence);
  if (written(member)) return false;
  const name = memberName(member, evidence.mayHaveUnmodeledShadow);
  if (!name) return false;
  if (numericConstants.has(name)) return true;
  return numericMethods.has(name) && safeMethodUse(member, next, evidence);
}

// Reflection is a protected acquisition operation, not a purity certificate.
function safeReflectUse(
  path: NodePath<t.Node>,
  kind: "namespace" | "get",
  evidence: RuntimeSourceEvidence,
  seen = new Set<t.Node>()
): boolean {
  if (seen.has(path.node) || seen.size >= 32 || written(path)) return false;
  if (unobservedReference(path)) return true;
  const next = new Set(seen).add(path.node);
  const use = path.parentPath;
  if (
    kind === "namespace" &&
    (use?.isMemberExpression() || use?.isOptionalMemberExpression()) &&
    use.node.object === path.node
  ) {
    const key = memberName(use);
    return (
      key !== undefined &&
      (key !== "get" || safeReflectUse(use, "get", evidence, next))
    );
  }
  if (
    kind === "get" &&
    (use?.isCallExpression() || use?.isOptionalCallExpression()) &&
    use.node.callee === path.node
  ) {
    const args = use.get("arguments");
    if (
      !Array.isArray(args) ||
      args.some((argument) => argument.isSpreadElement())
    )
      return false;
    const key = args[1] && closedString(args[1] as NodePath<t.Node>);
    return key !== undefined && key !== "constructor";
  }
  if (!use?.isVariableDeclarator() || use.node.init !== path.node) return false;
  if (t.isIdentifier(use.node.id)) {
    const binding = use.scope.getBinding(use.node.id.name);
    return (
      !!binding?.constant &&
      !evidence.isExported(binding) &&
      evidence
        .references(binding)
        .every((ref) => safeReflectUse(ref, kind, evidence, next))
    );
  }
  if (kind === "namespace" && t.isObjectPattern(use.node.id))
    return use.node.id.properties.every((property) => {
      if (
        !t.isObjectProperty(property) ||
        property.computed ||
        !t.isIdentifier(property.key) ||
        !t.isIdentifier(property.value)
      )
        return false;
      if (property.key.name !== "get") return true;
      const binding = use.scope.getBinding(property.value.name);
      return (
        !!binding?.constant &&
        !evidence.isExported(binding) &&
        evidence
          .references(binding)
          .every((ref) => safeReflectUse(ref, "get", evidence, next))
      );
    });
  return false;
}

// Standard host aliases can designate the same realm. Their namespace escape
// is as consequential as passing globalThis itself to opaque code.
const globalAliases = new Set([
  "globalThis",
  "global",
  "window",
  "self",
  "top",
  "parent",
  "frames"
]);
function safeGlobalUse(
  root: NodePath<t.Node>,
  evidence: RuntimeSourceEvidence
): boolean {
  let current = root;
  while (true) {
    if (unobservedReference(current)) return true;
    const member = current.parentPath;
    if (
      !member?.isMemberExpression() ||
      member.node.object !== current.node ||
      written(member)
    )
      return false;
    const name = memberName(member);
    if (!name) return false;
    if (name === "document") return !mayExposeDocumentRealm(member, evidence);
    if (name === "Math") return safeNamespaceUse(member, new Set(), evidence);
    if (name === "Reflect")
      return safeReflectUse(member, "namespace", evidence);
    if (
      [
        "eval",
        "Function",
        "valueOf",
        "__defineGetter__",
        "__defineSetter__"
      ].includes(name)
    )
      return false;
    if (globalAliases.has(name)) {
      current = member;
      continue;
    }
    // Other fixed global slots are not intrinsically Math aliases. If they
    // are assigned a realm alias, its RHS escape is caught independently.
    return true;
  }
}

function directReflectionOperation(
  callee: NodePath<t.Node>
): string | undefined {
  if (!callee.isMemberExpression() && !callee.isOptionalMemberExpression())
    return;
  const member = callee as NodePath<
    t.MemberExpression | t.OptionalMemberExpression
  >;
  const receiver = member.get("object");
  if (
    receiver.isIdentifier() &&
    ["Object", "Reflect"].includes(receiver.node.name) &&
    !hasLocalRuntimeShadow(receiver, receiver.node.name)
  )
    return memberName(member);
}

/** An explicit callable prototype can expose a constructor through its own
 * descriptor without a syntactic constructor property access. */
function possibleCallablePrototype(
  path: NodePath<t.Node>,
  seen = new Set<t.Node>()
): boolean {
  if (seen.has(path.node) || seen.size >= 32) return false;
  if (path.isCallExpression() || path.isOptionalCallExpression()) {
    const invocation = path as NodePath<
      t.CallExpression | t.OptionalCallExpression
    >;
    const [target] = invocation.get("arguments");
    return (
      target?.isExpression() === true &&
      directReflectionOperation(invocation.get("callee")) ===
        "getPrototypeOf" &&
      possibleCallableOrigin(target)
    );
  }
  const binding = constantAlias(path);
  return (
    binding?.path.isVariableDeclarator() === true &&
    binding.path.get("init").isExpression() &&
    possibleCallablePrototype(
      binding.path.get("init") as NodePath<t.Node>,
      new Set(seen).add(path.node)
    )
  );
}

function readsCallableConstructorDescriptor(
  callee: NodePath<t.Node>,
  args: readonly NodePath<t.Node>[]
): boolean {
  const method = directReflectionOperation(callee);
  if (
    !["getOwnPropertyDescriptor", "getOwnPropertyDescriptors"].includes(
      method ?? ""
    )
  )
    return false;
  const [target, property] = args;
  if (!target || !possibleCallablePrototype(target)) return false;
  const key = property && closedString(property);
  return (
    method === "getOwnPropertyDescriptors" ||
    key === undefined ||
    key === "constructor"
  );
}

/** Under the compiler's standard-intrinsics assumption, withdraw the contract
 * on observed mutation or escape. This does not prove arbitrary imported code
 * cannot mutate ambient state; callers must register every loaded graph source.
 */
export function hasObservableMathMutation(
  program: NodePath<t.Program>
): boolean {
  const evidence = collectRuntimeSourceEvidence(program);
  return (
    !evidence.bindingsCurrent ||
    observeMathMutation(
      program,
      !observeBindMutation(program, evidence),
      evidence
    )
  );
}
function observeMathMutation(
  program: NodePath<t.Program>,
  nativeBindIntact: boolean,
  evidence: RuntimeSourceEvidence
): boolean {
  if (
    ["Math", "Reflect", "Function", "eval", ...globalAliases].some((name) =>
      evidence.writesScriptGlobal(name)
    ) ||
    evidence.shadowsScriptGlobal("Math") ||
    (program.node.sourceType === "script" &&
      evidence.mayHaveUnmodeledShadow(program.scope, "Math")) ||
    hasDynamicScope(program)
  )
    return true;
  let observed = false;
  program.traverse({
    "CallExpression|OptionalCallExpression"(path) {
      if (!isRuntimeSourceReference(path)) return;
      if (
        !nativeBindIntact &&
        methodOrigin(path, evidence.mayHaveUnmodeledShadow)
      ) {
        observed = true;
        return;
      }
      const invocation = path as NodePath<
        t.CallExpression | t.OptionalCallExpression
      >;
      if (
        readsCallableConstructorDescriptor(
          invocation.get("callee"),
          invocation.get("arguments")
        )
      )
        observed = true;
    },
    ObjectPattern(path) {
      if (observed || !isRuntimeSourceReference(path)) return;
      const parent = path.parentPath;
      const source =
        parent?.isVariableDeclarator() && parent.node.id === path.node
          ? parent.get("init")
          : parent?.isAssignmentExpression() && parent.node.left === path.node
            ? parent.get("right")
            : undefined;
      for (const property of path.get("properties")) {
        if (!property.isObjectProperty()) continue; // Rest cannot recover inherited constructor.
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
          continue;
        const key =
          !property.node.computed && t.isIdentifier(property.node.key)
            ? property.node.key.name
            : closedString(property.get("key") as NodePath<t.Node>);
        if (
          key === "constructor" ||
          (key === undefined &&
            property.node.computed &&
            (!source?.node ||
              possibleCallableOrigin(source as NodePath<t.Node>)))
        ) {
          observed = true;
          return;
        }
      }
    },
    ThisExpression(path) {
      if (
        !observed &&
        isPossibleGlobalThis(path, evidence) &&
        isRuntimeSourceReference(path) &&
        !safeGlobalUse(path, evidence)
      )
        observed = true;
    },
    "MemberExpression|OptionalMemberExpression"(path) {
      if (observed) return;
      // Function can be recovered through arbitrary callable.constructor
      // chains. An observed read/escape of that property is not a closed realm.
      const name = memberName(
        path as NodePath<t.MemberExpression | t.OptionalMemberExpression>
      );
      if (
        (name === "constructor" ||
          (name === undefined &&
            (path.node as t.MemberExpression | t.OptionalMemberExpression)
              .computed &&
            possibleCallableOrigin(path.get("object") as NodePath<t.Node>))) &&
        !(
          path.parentPath?.isAssignmentExpression({ operator: "=" }) &&
          path.parentPath.node.left === path.node
        ) &&
        isRuntimeSourceReference(path)
      )
        observed = true;
    },
    Identifier(path) {
      if (
        !observed &&
        path.isIdentifier({ name: "document" }) &&
        path.isReferencedIdentifier() &&
        !hasLocalRuntimeShadow(path, "document") &&
        isRuntimeSourceReference(path)
      ) {
        if (mayExposeDocumentRealm(path, evidence)) observed = true;
        return;
      }
      if (
        observed ||
        (!["Math", "Object", "Reflect", "Function", "eval"].includes(
          path.node.name
        ) &&
          !globalAliases.has(path.node.name))
      )
        return;
      if (!isRuntimeSourceReference(path)) return;
      if (hasLocalRuntimeShadow(path, path.node.name)) return;
      if (
        (path.node.name === "eval" || path.node.name === "Function") &&
        (path.isReferencedIdentifier() || written(path))
      ) {
        observed = true;
        return;
      }
      if (path.node.name === "Reflect" && path.isReferencedIdentifier()) {
        if (!safeReflectUse(path, "namespace", evidence)) observed = true;
        return;
      }
      if (path.node.name !== "Math" && !globalAliases.has(path.node.name))
        return;
      // Ignore property names, labels and type syntax, but include write-only
      // references (Babel's ReferencedIdentifier excludes some assignment LHS).
      if (!path.isReferencedIdentifier() && !written(path)) return;
      if (path.node.name === "Math") {
        if (!safeNamespaceUse(path, new Set(), evidence)) observed = true;
        return;
      }
      if (!safeGlobalUse(path, evidence)) observed = true;
    }
  });
  return observed;
}

function safeBindGlobalUse(
  root: NodePath<t.Node>,
  evidence: RuntimeSourceEvidence
): boolean {
  let current = root;
  while (true) {
    const member = current.parentPath;
    if (!member?.isMemberExpression() || member.node.object !== current.node)
      return false;
    const name = memberName(member);
    if (!name || ["Object", "Reflect", "Function", "valueOf"].includes(name))
      return false;
    if (name === "document") return !mayExposeDocumentRealm(member, evidence);
    if (!globalAliases.has(name)) return true;
    current = member;
  }
}

/** A separate authority: loss of native bind must not reject unrelated direct
 * Math calls. Prototype/reflection escapes conservatively revoke bound aliases. */
export function hasObservableBindMutation(
  program: NodePath<t.Program>
): boolean {
  const evidence = collectRuntimeSourceEvidence(program);
  return !evidence.bindingsCurrent || observeBindMutation(program, evidence);
}
function readsLegacyPrototypeDescriptor(
  callee: NodePath<t.Node>,
  invocation: NodePath<t.CallExpression | t.OptionalCallExpression>,
  shadow: ScopeShadowCheck
): boolean {
  const method = directReflectionOperation(callee);
  if (
    method !== "getOwnPropertyDescriptor" &&
    method !== "getOwnPropertyDescriptors"
  )
    return false;
  const [target, property] = invocation.get("arguments");
  if (
    !target?.isMemberExpression() ||
    memberName(target, shadow) !== "prototype"
  )
    return false;
  const object = target.get("object");
  if (
    !object.isIdentifier({ name: "Object" }) ||
    hasLocalRuntimeShadow(object, "Object") ||
    shadow(object.scope, "Object")
  )
    return false;
  const key = property && closedString(property, shadow);
  return (
    method === "getOwnPropertyDescriptors" ||
    key === undefined ||
    key === "__proto__"
  );
}

function observeBindMutation(
  program: NodePath<t.Program>,
  evidence: RuntimeSourceEvidence
): boolean {
  if (
    ["Object", "Reflect", "Function", "eval", ...globalAliases].some((name) =>
      evidence.writesScriptGlobal(name)
    ) ||
    evidence.hasGlobalEval ||
    hasDynamicScope(program)
  )
    return true;
  let observed = false;
  program.traverse({
    ObjectPattern(path) {
      if (observed || !isRuntimeSourceReference(path)) return;
      for (const property of path.get("properties")) {
        if (!property.isObjectProperty()) continue;
        const key =
          !property.node.computed && t.isIdentifier(property.node.key)
            ? property.node.key.name
            : closedString(property.get("key") as NodePath<t.Node>);
        if (
          ["__proto__", "__defineGetter__", "__defineSetter__"].includes(
            key ?? ""
          )
        ) {
          observed = true;
          return;
        }
      }
    },
    ThisExpression(path) {
      if (
        !observed &&
        isPossibleGlobalThis(path, evidence) &&
        isRuntimeSourceReference(path) &&
        !safeBindGlobalUse(path, evidence)
      )
        observed = true;
    },
    "MemberExpression|OptionalMemberExpression"(path) {
      if (!isRuntimeSourceReference(path)) return;
      const name = memberName(
        path as NodePath<t.MemberExpression | t.OptionalMemberExpression>
      );
      if (
        ["__proto__", "__defineGetter__", "__defineSetter__"].includes(
          name ?? ""
        ) ||
        (name === "bind" && written(path))
      )
        observed = true;
    },
    "CallExpression|OptionalCallExpression"(path) {
      if (observed || !isRuntimeSourceReference(path)) return;
      const invocation = path as NodePath<
        t.CallExpression | t.OptionalCallExpression
      >;
      const callee = invocation.get("callee");
      if (
        readsLegacyPrototypeDescriptor(
          callee,
          invocation,
          evidence.mayHaveUnmodeledShadow
        )
      ) {
        observed = true;
        return;
      }
      if (!invocation.isCallExpression() || !callee.isMemberExpression())
        return;
      const object = (
        callee as NodePath<t.MemberExpression | t.OptionalMemberExpression>
      ).get("object");
      if (
        object.isIdentifier() &&
        ["Object", "Reflect"].includes(object.node.name) &&
        !hasLocalRuntimeShadow(object, object.node.name) &&
        [
          "defineProperty",
          "defineProperties",
          "assign",
          "set",
          "setPrototypeOf",
          "getPrototypeOf",
          "get"
        ].includes(memberName(callee) ?? "")
      ) {
        // An opaque target could be Function.prototype. Direct Math calls could
        // eventually use a narrower authority, but bound aliases must fail closed.
        observed = true;
      }
    },
    Identifier(path) {
      if (
        !observed &&
        path.isIdentifier({ name: "document" }) &&
        path.isReferencedIdentifier() &&
        !hasLocalRuntimeShadow(path, "document") &&
        isRuntimeSourceReference(path)
      ) {
        if (mayExposeDocumentRealm(path, evidence)) observed = true;
        return;
      }
      if (
        observed ||
        (!["Math", "Object", "Reflect", "Function", "eval"].includes(
          path.node.name
        ) &&
          !globalAliases.has(path.node.name))
      )
        return;
      if (
        hasLocalRuntimeShadow(path, path.node.name) ||
        !isRuntimeSourceReference(path)
      )
        return;
      if (
        ["Object", "Reflect"].includes(path.node.name) &&
        path.isReferencedIdentifier()
      ) {
        const use = path.parentPath;
        if (
          !use?.isMemberExpression() ||
          use.node.object !== path.node ||
          [
            "defineProperty",
            "defineProperties",
            "assign",
            "set",
            "setPrototypeOf",
            "getPrototypeOf",
            "get"
          ].includes(memberName(use) ?? "")
        )
          observed = true;
        return;
      }
      if (path.node.name === "Function" && path.isReferencedIdentifier())
        observed = true;
      if (globalAliases.has(path.node.name) && path.isReferencedIdentifier()) {
        if (!safeBindGlobalUse(path, evidence)) observed = true;
      }
    }
  });
  return observed;
}

export interface MathIntrinsicEnvironment {
  /** Changes on every newly loaded source and on irreversible invalidation. */
  readonly revision: number;
  observe(program: NodePath<t.Program>): void;
  snapshot(): { intact: boolean; bindIntact: boolean; revision: number };
  referenceIdentity(path: NodePath<t.Node>): MathReferenceIdentity | undefined;
  provesPrimitiveResult(
    call: NodePath<t.CallExpression | t.OptionalCallExpression>
  ): boolean;
}

export function createMathIntrinsicEnvironment(
  initial: { bindIntact?: boolean } = {}
): MathIntrinsicEnvironment {
  const programs = new Set<NodePath<t.Program>>();
  let revision = 0;
  let invalidated = false;
  let bindInvalidated = initial.bindIntact === false;
  function validate(evidenceFor = createRealmSourceEvidence(programs)) {
    // AST transforms can introduce writes after registration. Do not cache a
    // positive result by Program identity, or by the first queried call.
    if (invalidated && bindInvalidated) return false;
    if (
      !bindInvalidated &&
      [...programs].some((program) => {
        const evidence = evidenceFor(program);
        return (
          !evidence.bindingsCurrent || observeBindMutation(program, evidence)
        );
      })
    ) {
      bindInvalidated = true;
      revision++;
    }
    if (
      !invalidated &&
      [...programs].some((program) => {
        const evidence = evidenceFor(program);
        return (
          !evidence.bindingsCurrent ||
          observeMathMutation(program, !bindInvalidated, evidence)
        );
      })
    ) {
      invalidated = true;
      revision++;
    }
    return !invalidated;
  }
  return {
    get revision() {
      validate();
      return revision;
    },
    observe(program) {
      if (!programs.has(program)) {
        programs.add(program);
        revision++;
      }
      validate();
    },
    snapshot() {
      return { intact: validate(), bindIntact: !bindInvalidated, revision };
    },
    referenceIdentity(path) {
      const program = path.scope.getProgramParent().path;
      if (!program.isProgram()) return;
      if (!programs.has(program)) {
        programs.add(program);
        revision++;
      }
      const evidenceFor = createRealmSourceEvidence(programs);
      if (!validate(evidenceFor)) return;
      const shadow = evidenceFor(program).mayHaveUnmodeledShadow;
      if (namespaceOrigin(path, shadow))
        return { kind: "namespace", dependencies: [] };
      const origin = methodOrigin(path, shadow);
      if (origin && (!origin.bound || !bindInvalidated))
        return {
          kind: "method",
          dependencies: methodDependencies(path, shadow)
        };
      if (
        !bindInvalidated &&
        (path.isMemberExpression() || path.isOptionalMemberExpression()) &&
        memberName(path, shadow) === "bind"
      ) {
        const object = (
          path as NodePath<t.MemberExpression | t.OptionalMemberExpression>
        ).get("object");
        if (methodOrigin(object, shadow))
          return {
            kind: "bind",
            dependencies: methodDependencies(object, shadow)
          };
      }
    },
    provesPrimitiveResult(call) {
      if (
        call.node.arguments.some((argument) =>
          t.isArgumentPlaceholder(argument)
        )
      )
        return false;
      const callee = call.get("callee");
      // Keep the cheap shape prefilter for unrelated calls; only the fresh
      // lexical observation below can authorize a native result.
      if (!methodOrigin(callee)) return false;
      const program = call.scope.getProgramParent().path;
      if (!program.isProgram()) return false;
      if (!programs.has(program)) {
        programs.add(program);
        revision++;
      }
      const evidenceFor = createRealmSourceEvidence(programs);
      if (!validate(evidenceFor)) return false;
      const name = methodOrigin(
        callee,
        evidenceFor(program).mayHaveUnmodeledShadow
      );
      return !!name && (!name.bound || !bindInvalidated);
    }
  };
}
