import { types as t, type NodePath } from "@babel/core";
import type { Binding, Scope } from "@babel/traverse";

/** Native-environment authority follows emitted JavaScript, not erased types.
 * Expression-bearing TS/Flow wrappers still execute their expression; enum,
 * namespace and parameter-property initializers are not blanket-skipped.
 */
export function isRuntimeSourceReference(path: NodePath<t.Node>): boolean {
  for (
    let current: NodePath<t.Node> | null = path;
    current;
    current = current.parentPath
  ) {
    const node = current.node;
    if (
      ("declare" in node && node.declare === true) ||
      t.isTSInterfaceDeclaration(node) ||
      t.isTSTypeAliasDeclaration(node) ||
      t.isTSDeclareFunction(node) ||
      // The FlowDeclaration alias excludes runtime casts and enums.
      (node.type.startsWith("Declare") && t.isFlowDeclaration(node)) ||
      node.type === "InterfaceDeclaration" ||
      node.type === "OpaqueType" ||
      node.type === "TypeAlias"
    )
      return false;
    if (
      (t.isImportDeclaration(node) &&
        (node.importKind === "type" || node.importKind === "typeof")) ||
      (t.isImportSpecifier(node) &&
        (node.importKind === "type" || node.importKind === "typeof")) ||
      (t.isExportNamedDeclaration(node) && node.exportKind === "type") ||
      (t.isExportSpecifier(node) && node.exportKind === "type") ||
      (t.isExportAllDeclaration(node) && node.exportKind === "type")
    )
      return false;
    const parent = current.parentPath;
    if (!parent) continue;
    if (
      t.isTSAsExpression(parent.node) ||
      t.isTSTypeAssertion(parent.node) ||
      t.isTSSatisfiesExpression(parent.node) ||
      t.isTSNonNullExpression(parent.node) ||
      t.isTSInstantiationExpression(parent.node) ||
      t.isTypeCastExpression(parent.node)
    ) {
      if (parent.node.expression !== node) return false;
      continue;
    }
    if (
      t.isTSType(parent.node) ||
      t.isTSTypeAnnotation(parent.node) ||
      t.isTSExpressionWithTypeArguments(parent.node) ||
      t.isTSTypeParameterInstantiation(parent.node) ||
      t.isTSTypeParameterDeclaration(parent.node) ||
      t.isFlow(parent.node)
    )
      return false;
  }
  return true;
}

/** Decorator expressions belong to the enclosing definition context, even
 * when their AST is attached under a strict class method. */
function hasStrictReceiverContext(path: NodePath<t.Node>): boolean {
  let decorator = false;
  for (
    let child = path, parent = path.parentPath;
    parent;
    child = parent, parent = parent.parentPath
  ) {
    if (parent.isDecorator()) decorator = true;
    if (parent.isClass()) {
      if (!decorator) return true;
      decorator = false;
    }
    if (
      parent.isFunction() &&
      !decorator &&
      !(
        child.key === "key" &&
        (parent.isObjectMethod() || parent.isClassMethod())
      )
    ) {
      const body = parent.node.body;
      if (
        t.isBlockStatement(body) &&
        body.directives.some((d) => d.value.value === "use strict")
      )
        return true;
    }
    if (parent.isProgram())
      return (
        parent.node.sourceType === "module" ||
        parent.node.directives.some((d) => d.value.value === "use strict")
      );
  }
  return false;
}

/** Identifier reference counts omit decorators and a class's own static
 * receiver. Do not call such a class unreachable merely because it is unnamed
 * at its use sites. Literal static initialization and deferred method bodies
 * alone do not expose the class. */
function hasImplicitClassExposure(
  owner: NodePath<t.ClassDeclaration>
): boolean {
  if (owner.node.decorators?.length) return true;
  const ownsReceiver = (path: NodePath<t.Node>): boolean => {
    let child = path;
    for (
      let parent = child.parentPath;
      parent;
      child = parent, parent = parent.parentPath
    ) {
      if (
        parent.isFunction() &&
        !parent.isArrowFunctionExpression() &&
        !(
          child.key === "key" &&
          "computed" in parent.node &&
          parent.node.computed
        ) &&
        !child.isDecorator()
      )
        return false;
      if (
        parent.isStaticBlock() ||
        ((parent.isClassProperty() ||
          parent.isClassPrivateProperty() ||
          parent.isClassAccessorProperty()) &&
          child.key === "value")
      )
        return parent.parentPath.parentPath?.node === owner.node;
    }
    return false;
  };
  for (const member of owner.get("body").get("body")) {
    if ("decorators" in member.node && member.node.decorators?.length)
      return true;
    if (
      (member.isClassMethod() || member.isClassPrivateMethod()) &&
      member.node.params.some(
        (param) => "decorators" in param && !!param.decorators?.length
      )
    )
      return true;
    const region = member.isStaticBlock()
      ? member
      : (member.isClassProperty() ||
            member.isClassPrivateProperty() ||
            member.isClassAccessorProperty()) &&
          member.node.static
        ? member.get("value")
        : undefined;
    if (!region || Array.isArray(region) || !region.node) continue;
    let exposed =
      (region.isThisExpression() || region.isSuper()) && ownsReceiver(region);
    region.traverse({
      "ThisExpression|Super"(path: NodePath<t.Node>) {
        if (ownsReceiver(path)) {
          exposed = true;
          path.stop();
        }
      }
    });
    if (exposed) return true;
  }
  return false;
}

function referencesOnlyPlainCall(
  binding: Binding,
  evidence: RuntimeSourceEvidence
): boolean {
  return evidence
    .references(binding)
    .every(
      (ref) =>
        ref.parentPath?.isCallExpression() &&
        ref.parentPath.node.callee === ref.node
    );
}

/** Whether lexical `this` may denote the realm object under normal invocation.
 * Script-level this remains global even in a strict script. Arrows inherit
 * their surrounding receiver; class field values/static blocks do not.
 */
export function isPossibleGlobalThis(
  path: NodePath<t.ThisExpression>,
  evidence?: RuntimeSourceEvidence
): boolean {
  let child: NodePath<t.Node> = path;
  let decorated = false;
  for (
    let parent = child.parentPath;
    parent;
    child = parent, parent = parent.parentPath
  ) {
    if (child.isDecorator()) decorated = true;
    if (parent.isClass()) decorated = false;
    if (parent.isFunction() && !parent.isArrowFunctionExpression()) {
      if (decorated) continue;
      // Method computed keys execute in the enclosing receiver context.
      if (
        child.key === "key" &&
        "computed" in parent.node &&
        parent.node.computed
      )
        continue;
      // A base class constructor cannot be called with a supplied receiver.
      // Derived constructors are different: super() may return the realm itself.
      if (parent.isClassMethod({ kind: "constructor" })) {
        const owner = parent.parentPath.parentPath;
        if (owner?.isClass() && !owner.node.superClass) return false;
      }
      const body = parent.node.body;
      const ownStrict =
        t.isBlockStatement(body) &&
        body.directives.some(
          (directive) => directive.value.value === "use strict"
        );
      if (!ownStrict && !hasStrictReceiverContext(parent)) return true;
      // Strictness controls default binding, not an explicitly supplied receiver.
      // Only a closed local function whose uses are plain calls can exclude it.
      if (parent.isFunctionExpression() && parent.node.id) {
        const self = parent.scope.getOwnBinding(parent.node.id.name);
        const current =
          evidence ??
          collectRuntimeSourceEvidence(
            parent.scope.getProgramParent().path as NodePath<t.Program>
          );
        if (
          !current.bindingsCurrent ||
          !self?.constant ||
          self.identifier !== parent.node.id ||
          !referencesOnlyPlainCall(self, current)
        )
          return true;
      }
      if (
        parent.isFunctionExpression() &&
        parent.parentPath?.isCallExpression() &&
        parent.parentPath.node.callee === parent.node
      )
        return false;
      let binding: Binding | undefined;
      if (parent.isFunctionDeclaration() && parent.node.id)
        binding = parent.parentPath?.scope.getBinding(parent.node.id.name);
      else if (
        parent.isFunctionExpression() &&
        parent.parentPath?.isVariableDeclarator() &&
        t.isIdentifier(parent.parentPath.node.id)
      )
        binding = parent.parentPath.scope.getBinding(
          parent.parentPath.node.id.name
        );
      if (parent.isClassMethod() || parent.isClassPrivateMethod()) {
        const owner = parent.findParent((p) => p.isClass());
        if (owner?.isClassDeclaration() && owner.node.id) {
          const classBinding = owner.parentPath?.scope.getBinding(
            owner.node.id.name
          );
          const current =
            evidence ??
            collectRuntimeSourceEvidence(
              parent.scope.getProgramParent().path as NodePath<t.Program>
            );
          if (
            !hasImplicitClassExposure(owner) &&
            classBinding?.constant &&
            current.bindingsCurrent &&
            !current.isExported(classBinding) &&
            current.references(classBinding).length === 0 &&
            current.hasSharedLexicalUse?.(classBinding) !== true
          )
            return false;
        }
      }
      if (!binding?.constant) return true;
      const current =
        evidence ??
        collectRuntimeSourceEvidence(
          parent.scope.getProgramParent().path as NodePath<t.Program>
        );
      if (
        !current.bindingsCurrent ||
        current.isExported(binding) ||
        isPossibleScriptGlobalBinding(binding) ||
        current.hasGlobalPropertyUse(binding)
      )
        return true;
      return (
        !referencesOnlyPlainCall(binding, current) ||
        current.hasSharedLexicalUse?.(binding) === true
      );
    }
    if (parent.isStaticBlock()) return false;
    if (
      (parent.isClassProperty() ||
        parent.isClassPrivateProperty() ||
        parent.isClassAccessorProperty()) &&
      child.key === "value"
    ) {
      if (parent.node.static) return false;
      const owner = parent.parentPath.parentPath;
      return !owner?.isClass() || !!owner.node.superClass;
    }
    if (parent.isProgram()) return parent.node.sourceType !== "module";
  }
  return false;
}

/** Resolve emitted declarations, rather than type-only Babel binding shadows. */
function resolveRuntimeBinding(
  candidate: Binding | undefined,
  name: string,
  isCurrent: (binding: Binding) => boolean
): Binding | undefined {
  for (
    let binding = candidate;
    binding;
    binding = binding.scope.parent?.getBinding(name)
  ) {
    if (!isCurrent(binding)) return;
    if (isRuntimeSourceReference(binding.path)) return binding;
  }
}

/** Ambient/type-only declarations are not emitted runtime shadows. */
export function hasRuntimeBinding(
  path: NodePath<t.Node>,
  name: string
): boolean {
  return (
    resolveRuntimeBinding(path.scope.getBinding(name), name, (binding) =>
      attachedPath(binding.path)
    ) !== undefined
  );
}

function attachedPath(
  path: NodePath<t.Node>,
  children?: Map<t.Node, Set<t.Node>>
): boolean {
  for (
    let current: NodePath<t.Node> | null = path;
    current?.parentPath;
    current = current.parentPath
  ) {
    const parent = current.parentPath.node;
    let identities = children?.get(parent);
    if (!identities) {
      const keys = t.VISITOR_KEYS[parent.type] ?? [];
      const record = parent as unknown as Record<string, unknown>;
      const slot = current.listKey ?? current.key;
      // Usual attached paths identify an exact current slot in O(1), even for
      // large sibling lists. Raw edits can move a node without updating its
      // path, so a nonmatch still uses the current child-identity scan.
      if (typeof slot === "string" && keys.includes(slot)) {
        const value = record[slot];
        if (
          (current.listKey &&
            Array.isArray(value) &&
            typeof current.key === "number" &&
            value[current.key] === current.node) ||
          (!current.listKey && value === current.node)
        )
          continue;
      }
      identities = new Set();
      for (const key of keys) {
        const value = record[key];
        if (Array.isArray(value))
          for (const child of value) {
            if (child) identities.add(child as t.Node);
          }
        else if (value) identities.add(value as t.Node);
      }
      children?.set(parent, identities);
    }
    if (!identities.has(current.node)) return false;
  }
  return true;
}
/** A Program parsed as script may be CommonJS or a classic script. Without an
 * explicit wrapper receipt, these emitted bindings can be properties of the realm. */
export function isPossibleScriptGlobalBinding(binding: Binding): boolean {
  return (
    binding.scope.path.isProgram() &&
    binding.scope.path.node.sourceType === "script" &&
    (binding.kind === "var" || binding.kind === "hoisted") &&
    isRuntimeSourceReference(binding.path)
  );
}

/** Observation only: a possible classic-script global is not a local shadow. */
export function hasLocalRuntimeShadow(
  path: NodePath<t.Node>,
  name: string
): boolean {
  const binding = resolveRuntimeBinding(
    path.scope.getBinding(name),
    name,
    (candidate) => attachedPath(candidate.path)
  );
  return !!binding && !isPossibleScriptGlobalBinding(binding);
}

/** Literal string keys and closed const aliases; no coercion or evaluation. */
export function closedRuntimeString(
  path: NodePath<t.Node>,
  mayHaveUnmodeledShadow?: RuntimeSourceEvidence["mayHaveUnmodeledShadow"],
  seen = new Set<t.Node>()
): string | undefined {
  if (path.isStringLiteral()) return path.node.value;
  if (
    path.isBinaryExpression({ operator: "+" }) &&
    t.isStringLiteral(path.node.left) &&
    t.isStringLiteral(path.node.right)
  )
    return path.node.left.value + path.node.right.value;
  if (!path.isIdentifier() || seen.size >= 32 || seen.has(path.node)) return;
  const binding = path.scope.getBinding(path.node.name);
  if (
    !binding?.constant ||
    !binding.path.isVariableDeclarator() ||
    !binding.path.parentPath.isVariableDeclaration({ kind: "const" }) ||
    !t.isIdentifier(binding.path.node.id) ||
    !isRuntimeSourceReference(binding.path) ||
    mayHaveUnmodeledShadow?.(path.scope, path.node.name, binding.scope) ||
    (binding.path.node.end ?? Infinity) >= (path.node.start ?? -Infinity)
  )
    return;
  return closedRuntimeString(
    binding.path.get("init") as NodePath<t.Node>,
    mayHaveUnmodeledShadow,
    new Set(seen).add(path.node)
  );
}

export function closedRuntimeMemberName(
  path: NodePath<t.MemberExpression | t.OptionalMemberExpression>
): string | undefined {
  return !path.node.computed && t.isIdentifier(path.node.property)
    ? path.node.property.name
    : closedRuntimeString(path.get("property") as NodePath<t.Node>);
}

function preservesDocumentRealm(key: string, derived: boolean): boolean {
  return (
    key === "ownerDocument" ||
    (!derived && ["documentElement", "body", "head"].includes(key))
  );
}

/** `document.defaultView` may expose the realm in a browser. Restrict this
 * check to already-observed document acquisition, not arbitrary DOM objects. */
export function mayExposeDocumentRealm(
  path: NodePath<t.Node>,
  evidence: RuntimeSourceEvidence,
  seen = new Set<t.Node>(),
  derived = false
): boolean {
  if (seen.size >= 32 || seen.has(path.node)) return true;
  const use = path.parentPath;
  if (
    use?.isUnaryExpression({ operator: "typeof" }) ||
    use?.isExpressionStatement()
  )
    return false;
  if (
    (use?.isMemberExpression() || use?.isOptionalMemberExpression()) &&
    use.node.object === path.node
  ) {
    const key = closedRuntimeMemberName(use);
    if (key === undefined || key === "defaultView") return true;
    // Follow the value (not just the first slot) back through ownerDocument,
    // element properties, or a method result to an observed realm access.
    const next = use.parentPath;
    if (
      (next?.isCallExpression() || next?.isOptionalCallExpression()) &&
      next.node.callee === use.node
    )
      return mayExposeDocumentRealm(
        next,
        evidence,
        new Set(seen).add(path.node),
        !["querySelector", "getElementById"].includes(key) || derived
      );
    return mayExposeDocumentRealm(
      use,
      evidence,
      new Set(seen).add(path.node),
      !preservesDocumentRealm(key, derived)
    );
  }
  const followsDocumentBinding = (
    target: t.Node,
    declaration: NodePath<t.Node>,
    selectionDerived = derived
  ): boolean => {
    if (!t.isIdentifier(target)) return true;
    const binding = declaration.scope.getBinding(target.name);
    if (
      !binding?.constant ||
      binding.identifier !== target ||
      evidence.isExported(binding) ||
      isPossibleScriptGlobalBinding(binding)
    )
      return true;
    const visited = new Set(seen).add(path.node);
    return (
      evidence
        .references(binding)
        .some((ref) =>
          mayExposeDocumentRealm(ref, evidence, visited, selectionDerived)
        ) ||
      (!selectionDerived && evidence.hasSharedLexicalUse?.(binding) === true)
    );
  };
  if (use?.isVariableDeclarator() && use.node.init === path.node) {
    if (t.isObjectPattern(use.node.id))
      return (use.get("id") as NodePath<t.ObjectPattern>)
        .get("properties")
        .some((property) => {
          if (!property.isObjectProperty()) return true;
          const key =
            !property.node.computed && t.isIdentifier(property.node.key)
              ? property.node.key.name
              : closedRuntimeString(property.get("key") as NodePath<t.Node>);
          if (key === undefined || key === "defaultView") return true;
          return (
            preservesDocumentRealm(key, derived) &&
            followsDocumentBinding(property.node.value, property, false)
          );
        });
    if (t.isIdentifier(use.node.id))
      return followsDocumentBinding(use.node.id, use);
  }
  // Ordinary scalar DOM reads and method arguments are not certified pure.
  // Only explicit continued navigation is attributed to derived DOM values.
  return !derived;
}

export interface RuntimeSourceEvidence {
  readonly bindingsCurrent: boolean;
  /** Possible intrinsic eval access, including shadowed aliases. This is not
   * limited to unbound global identifiers; only exact local functions exclude it. */
  readonly hasGlobalEval: boolean;
  references(
    binding: Binding
  ): readonly NodePath<t.Identifier | t.JSXIdentifier>[];
  isExported(binding: Binding): boolean;
  hasGlobalPropertyUse(binding: Binding): boolean;
  writesScriptGlobal(name: string): boolean;
  shadowsScriptGlobal(name: string): boolean;
  /** An emitted name use without a lexical binding in this observed program. */
  usesUnboundName(name: string): boolean;
  /** Only supplied by an observation spanning the participating programs. */
  hasSharedLexicalUse?(binding: Binding): boolean;
  mayHaveUnmodeledShadow(
    scope: Scope,
    name: string,
    stopBefore?: Scope
  ): boolean;
}
/** Fresh references without rebuilding Scope/Binding identities used by callers.
 * New/replaced declarations without matching scope evidence withdraw authority.
 * Evidence is local to one synchronous observation, never cached across queries. */
export function collectRuntimeSourceEvidence(
  program: NodePath<t.Program>
): RuntimeSourceEvidence {
  const children = new Map<t.Node, Set<t.Node>>();
  const refs = new Map<Binding, NodePath<t.Identifier | t.JSXIdentifier>[]>();
  const exported = new Set<Binding>();
  const globalPropertyUses = new Set<Binding>();
  let unknownGlobalPropertyUse = false;
  const writtenGlobals = new Set<string>();
  const lexicalGlobals = new Set<string>();
  const unboundNames = new Set<string>();
  const unmodeledNames = new Map<Scope, Set<string>>();
  const recordUnmodeledName = (scope: Scope, name: string) => {
    const names = unmodeledNames.get(scope) ?? new Set<string>();
    names.add(name);
    unmodeledNames.set(scope, names);
  };
  let bindingsCurrent = true;
  const evalReferences: NodePath<t.Identifier>[] = [];
  const observeWrite = (path: NodePath<t.Node>, target: t.Node): void => {
    if (!isRuntimeSourceReference(path)) return;
    // Assignment targets may be wrapped in erased TypeScript expressions.
    while (
      t.isTSAsExpression(target) ||
      t.isTSTypeAssertion(target) ||
      t.isTSNonNullExpression(target) ||
      t.isTSSatisfiesExpression(target) ||
      t.isParenthesizedExpression(target) ||
      t.isTypeCastExpression(target)
    )
      target = target.expression;
    // GetBindingIdentifiers does not descend through expression wrappers at
    // nested pattern leaves. Only assignment targets count, never computed keys,
    // default RHS expressions, or a member receiver's binding.
    if (t.isArrayPattern(target)) {
      for (const element of target.elements)
        if (element) observeWrite(path, element);
    } else if (t.isObjectPattern(target)) {
      for (const property of target.properties)
        observeWrite(
          path,
          t.isRestElement(property) ? property.argument : property.value
        );
    } else if (t.isRestElement(target)) observeWrite(path, target.argument);
    else if (t.isAssignmentPattern(target)) observeWrite(path, target.left);
    else if (t.isIdentifier(target)) {
      const scope =
        path.isForInStatement() || path.isForOfStatement()
          ? (path.parentPath?.scope ?? path.scope)
          : path.scope;
      const binding = scope.getBinding(target.name);
      // An actual write contradicts cached constant authority after a raw edit.
      // Do not mutate Binding/Scope or equate ordinary reads with assignments.
      if (binding?.constant) bindingsCurrent = false;
      if (binding && isPossibleScriptGlobalBinding(binding))
        writtenGlobals.add(binding.identifier.name);
    }
  };
  const recordReference = (
    path: NodePath<t.Identifier | t.JSXIdentifier>,
    used: boolean
  ): void => {
    const name = path.node.name;
    const candidate = path.scope.getBinding(name);
    const isCurrent = (binding: Binding) => {
      const current =
        binding.scope.getProgramParent().path.node === program.node &&
        attachedPath(binding.path, children);
      if (!current) bindingsCurrent = false;
      return current;
    };
    if (!used || candidate?.identifier === path.node) {
      if (candidate) isCurrent(candidate);
      return;
    }
    const binding = resolveRuntimeBinding(candidate, name, isCurrent);
    if (!binding) {
      unboundNames.add(path.node.name);
      return;
    }
    const list = refs.get(binding) ?? [];
    list.push(path);
    refs.set(binding, list);
  };
  program.traverse({
    "TSEnumDeclaration|TSModuleDeclaration"(path: NodePath<t.Node>) {
      if (!path.isTSEnumDeclaration() && !path.isTSModuleDeclaration()) return;
      const id = path.node.id;
      if (!t.isIdentifier(id) || !isRuntimeSourceReference(path)) return;
      // Babel's scope table may omit these emitted declarations entirely. When
      // it instead returns an outer binding, its initializer is not evidence
      // for a read that might resolve to this declaration after lowering.
      const candidate = path.scope.getBinding(id.name);
      if (candidate?.identifier !== id) {
        recordUnmodeledName(path.scope, id.name);
        if (candidate) bindingsCurrent = false;
      }
    },
    "MemberExpression|OptionalMemberExpression"(path) {
      if (
        program.node.sourceType !== "script" ||
        !isRuntimeSourceReference(path)
      )
        return;
      const member = path as NodePath<
        t.MemberExpression | t.OptionalMemberExpression
      >;
      const globals = [
        "globalThis",
        "window",
        "self",
        "global",
        "top",
        "parent",
        "frames"
      ];
      let object = member.get("object") as NodePath<t.Node>;
      while (
        object.isMemberExpression() ||
        object.isOptionalMemberExpression()
      ) {
        const key = closedRuntimeMemberName(object);
        if (!key || !globals.includes(key)) return;
        object = object.get("object") as NodePath<t.Node>;
      }
      if (
        !object.isThisExpression() &&
        (!object.isIdentifier() ||
          !globals.includes(object.node.name) ||
          hasLocalRuntimeShadow(object, object.node.name))
      )
        return;
      const key = closedRuntimeMemberName(member);
      if (key === undefined) {
        unknownGlobalPropertyUse = true;
        return;
      }
      const binding = program.scope.getBinding(key);
      if (binding && isPossibleScriptGlobalBinding(binding))
        globalPropertyUses.add(binding);
    },
    "ExportNamedDeclaration|ExportDefaultDeclaration"(path) {
      if (!isRuntimeSourceReference(path)) return;
      const node = path.node as
        t.ExportNamedDeclaration | t.ExportDefaultDeclaration;
      const declaration = node.declaration;
      if (declaration) {
        const names = t.isIdentifier(declaration)
          ? [declaration.name]
          : t.isFunctionDeclaration(declaration) ||
              t.isClassDeclaration(declaration)
            ? declaration.id
              ? [declaration.id.name]
              : []
            : t.isVariableDeclaration(declaration)
              ? Object.keys(t.getBindingIdentifiers(declaration))
              : [];
        for (const name of names) {
          const binding = path.scope.getBinding(name);
          if (binding) exported.add(binding);
        }
      }
      if (t.isExportNamedDeclaration(node) && !node.source)
        for (const specifier of path.get(
          "specifiers"
        ) as NodePath<t.ExportSpecifier>[]) {
          if (
            !specifier.isExportSpecifier() ||
            !isRuntimeSourceReference(specifier)
          )
            continue;
          const binding = specifier.scope.getBinding(specifier.node.local.name);
          if (binding) exported.add(binding);
        }
    },
    VariableDeclarator(path) {
      if (!isRuntimeSourceReference(path)) return;
      for (const name of Object.keys(t.getBindingIdentifiers(path.node.id))) {
        const binding = path.scope.getBinding(name);
        if (!binding) continue;
        if (
          program.node.sourceType === "script" &&
          binding.scope.path.node === program.node &&
          (binding.kind === "let" || binding.kind === "const")
        )
          lexicalGlobals.add(name);
        if (
          isPossibleScriptGlobalBinding(binding) &&
          (path.node.init ||
            path.parentPath.parentPath?.isForInStatement() ||
            path.parentPath.parentPath?.isForOfStatement())
        )
          writtenGlobals.add(name);
      }
    },
    ClassDeclaration(path) {
      if (
        program.node.sourceType === "script" &&
        path.node.id &&
        isRuntimeSourceReference(path) &&
        path.parentPath.scope.getBinding(path.node.id.name)?.scope.path.node ===
          program.node
      )
        lexicalGlobals.add(path.node.id.name);
    },
    FunctionDeclaration(path) {
      if (!path.node.id || !isRuntimeSourceReference(path)) return;
      const name = path.node.id.name;
      const parent = path.parentPath;
      const binding = parent.scope.getBinding(name);
      if (binding && isPossibleScriptGlobalBinding(binding))
        writtenGlobals.add(name);
      // Sloppy regular functions declared in nested blocks and switch cases
      // can also introduce a var-scope binding outside their Babel block binding.
      if (
        !path.node.async &&
        !path.node.generator &&
        !parent.isInStrictMode() &&
        ((parent.isBlockStatement() && !parent.parentPath?.isFunction()) ||
          parent.isSwitchCase())
      ) {
        recordUnmodeledName(
          parent.scope.getFunctionParent() ?? parent.scope.getProgramParent(),
          name
        );
      }
    },
    AssignmentExpression(path) {
      observeWrite(path, path.node.left);
    },
    UpdateExpression(path) {
      observeWrite(path, path.node.argument);
    },
    "ForInStatement|ForOfStatement"(path) {
      const node = path.node as t.ForInStatement | t.ForOfStatement;
      if (!t.isVariableDeclaration(node.left)) observeWrite(path, node.left);
    },
    enter(path) {
      // A raw transplanted scope node can retain the donor Program's Scope.
      // Such lookups cannot establish current lexical binding authority.
      if (
        path.isScope() &&
        path.scope.getProgramParent().path.node !== program.node
      )
        bindingsCurrent = false;
      // Export wrappers introduce no lexical binding. Their declaration child
      // is checked in its own scope, including function parameters.
      if (
        (path.isDeclaration() &&
          !path.isExportNamedDeclaration() &&
          !path.isExportDefaultDeclaration() &&
          !path.isExportAllDeclaration()) ||
        path.isFunction() ||
        path.isCatchClause()
      ) {
        if (!isRuntimeSourceReference(path)) return;
        const ids = t.getBindingIdentifiers(path.node);
        for (const [name, id] of Object.entries(ids)) {
          const binding = path.scope.getBinding(name);
          if (
            path.isVariableDeclaration() &&
            ["const", "let", "var"].includes(path.node.kind) &&
            binding?.kind !== path.node.kind
          )
            bindingsCurrent = false;
          if (
            !binding ||
            binding.identifier !== id ||
            binding.scope.getProgramParent().path.node !== program.node ||
            !attachedPath(binding.path, children)
          )
            bindingsCurrent = false;
        }
      }
    },
    Identifier(path) {
      if (!isRuntimeSourceReference(path)) return;
      if (path.node.name === "eval" && path.isReferencedIdentifier())
        evalReferences.push(path);
      // Keep actual assignments even when Babel does not classify them as reads.
      const property = path.parentPath;
      const isPatternKey =
        path.key === "key" &&
        property.isObjectProperty() &&
        property.parentPath.isObjectPattern();
      const writeTarget = !isPatternKey && path.isBindingIdentifier();
      recordReference(path, path.isReferencedIdentifier() || writeTarget);
    },
    JSXIdentifier(path) {
      if (!isRuntimeSourceReference(path) || path.node.name === "this") return;
      // The opening tag evaluates only a component name or a member-chain root.
      // Closing tags, property names, attributes and intrinsic tags are not reads.
      let tag: NodePath<t.Node> = path;
      while (
        tag.parentPath?.isJSXMemberExpression() &&
        tag.parentPath.node.object === tag.node
      )
        tag = tag.parentPath;
      if (
        tag.parentPath?.isJSXOpeningElement() &&
        tag.parentPath.node.name === tag.node &&
        (tag !== path || !t.react.isCompatTag(path.node.name))
      )
        recordReference(path, true);
    }
  });
  const evidence: RuntimeSourceEvidence = {
    bindingsCurrent,
    hasGlobalEval: false,
    references: (binding) => refs.get(binding) ?? [],
    isExported: (binding) => exported.has(binding),
    hasGlobalPropertyUse: (binding) =>
      globalPropertyUses.has(binding) ||
      (unknownGlobalPropertyUse && isPossibleScriptGlobalBinding(binding)),
    writesScriptGlobal: (name) => writtenGlobals.has(name),
    shadowsScriptGlobal: (name) => lexicalGlobals.has(name),
    usesUnboundName: (name) => unboundNames.has(name),
    mayHaveUnmodeledShadow(scope, name, stopBefore) {
      for (
        let current: Scope | undefined = scope;
        current && current !== stopBefore;
        current = current.parent
      )
        if (unmodeledNames.get(current)?.has(name)) return true;
      return false;
    }
  };
  const hasGlobalEval = evalReferences.some((path) =>
    possibleIntrinsicEvalReference(path, evidence)
  );
  return {
    bindingsCurrent,
    hasGlobalEval,
    references: evidence.references,
    isExported: evidence.isExported,
    hasGlobalPropertyUse: evidence.hasGlobalPropertyUse,
    writesScriptGlobal: evidence.writesScriptGlobal,
    shadowsScriptGlobal: evidence.shadowsScriptGlobal,
    usesUnboundName: evidence.usesUnboundName,
    mayHaveUnmodeledShadow: evidence.mayHaveUnmodeledShadow
  };
}

/** Share fresh binding observations during one synchronous realm query.
 * Do not load sibling evidence until a recognized classic lexical capture
 * passes its local checks. A later query must see raw AST edits. */
export function createRealmSourceEvidence(
  programs: ReadonlySet<NodePath<t.Program>>
): (program: NodePath<t.Program>) => RuntimeSourceEvidence {
  const observed = new Map<NodePath<t.Program>, RuntimeSourceEvidence>();
  const evidenceFor = (program: NodePath<t.Program>): RuntimeSourceEvidence => {
    let evidence = observed.get(program);
    if (!evidence) {
      evidence = collectRuntimeSourceEvidence(program);
      if (programs.size > 1 && program.node.sourceType === "script")
        evidence.hasSharedLexicalUse = (binding) => {
          if (binding.scope.path.node !== program.node) return false;
          const declaration = binding.path;
          const parent = declaration.parentPath;
          if (!parent) return false;
          if (
            !(
              (declaration.isClassDeclaration() &&
                parent.node === program.node) ||
              (declaration.isVariableDeclarator() &&
                parent.isVariableDeclaration() &&
                (parent.node.kind === "const" || parent.node.kind === "let") &&
                parent.parentPath?.node === program.node)
            ) ||
            !isRuntimeSourceReference(declaration)
          )
            return false;
          for (const other of programs)
            if (
              other !== program &&
              evidenceFor(other).usesUnboundName(binding.identifier.name)
            )
              return true;
          return false;
        };
      observed.set(program, evidence);
    }
    return evidence;
  };
  return evidenceFor;
}

/** Possible intrinsic eval; only a current, immutable local function excludes it. */
export function possibleIntrinsicEvalReference(
  path: NodePath<t.Identifier>,
  evidence: Pick<RuntimeSourceEvidence, "bindingsCurrent" | "references">
): boolean {
  if (!evidence.bindingsCurrent) return true;
  const binding = path.scope.getBinding(path.node.name);
  if (
    !binding?.constant ||
    !attachedPath(binding.path) ||
    !isRuntimeSourceReference(binding.path)
  )
    return true;
  if (
    binding.scope.path.isProgram() &&
    binding.scope.path.node.sourceType === "script" &&
    binding.kind !== "const"
  )
    return true;
  if (evidence.references(binding).some((ref) => ref.isBindingIdentifier()))
    return true;
  if (binding.path.isFunctionDeclaration()) return false;
  if (
    !binding.path.isVariableDeclarator() ||
    !t.isIdentifier(binding.path.node.id)
  )
    return true;
  const init = binding.path.get("init");
  return !init.isFunctionExpression() && !init.isArrowFunctionExpression();
}
