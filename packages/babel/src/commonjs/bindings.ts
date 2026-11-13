import { types as t, type NodePath } from "@babel/core";
import { isSupportedImportInterop } from "./interop.js";
import type { Binding } from "@babel/traverse";
import { getStaticCssEvalLiteralRequireImportPath } from "../staticCssEval/cjsBindings.js";
import type { ProgramScope } from "../types.js";

export interface ModuleReference {
  source: string;
  kind: "import" | "require";
  members: readonly (string | null)[];
  unsafe?: string;
  interop?: boolean | "node";
}

export function staticMemberName(
  node: t.MemberExpression | t.ObjectProperty
): string | null {
  const key = t.isMemberExpression(node) ? node.property : node.key;
  if (!node.computed && t.isIdentifier(key)) return key.name;

  return t.isStringLiteral(key) || t.isNumericLiteral(key)
    ? String(key.value)
    : null;
}

function patternMemberPath(
  pattern: t.Node,
  name: string
): (string | null)[] | undefined {
  if (t.isIdentifier(pattern)) return pattern.name === name ? [] : undefined;
  if (t.isAssignmentPattern(pattern))
    return patternMemberPath(pattern.left, name);
  if (!t.isObjectPattern(pattern)) return undefined;

  for (const property of pattern.properties) {
    if (!t.isObjectProperty(property)) continue;

    const path = patternMemberPath(property.value, name);
    if (path) return [staticMemberName(property), ...path];
  }

  return undefined;
}

function overlapsMemberPath(
  target: readonly string[],
  members: readonly (string | null)[]
): boolean {
  return members.every(
    (member, index) =>
      index >= target.length || member === null || member === target[index]
  );
}

function isTruthinessRead(path: NodePath<t.Node>): boolean {
  const parent = path.parentPath;
  if (!parent) return false;

  if (parent.isUnaryExpression({ operator: "!" })) return true;
  if (
    (parent.isIfStatement() ||
      parent.isWhileStatement() ||
      parent.isDoWhileStatement() ||
      parent.isForStatement() ||
      parent.isConditionalExpression()) &&
    parent.node.test === path.node
  )
    return true;
  if (parent.isLogicalExpression())
    return (
      (parent.node.operator === "&&" && parent.node.left === path.node) ||
      isTruthinessRead(parent)
    );

  return false;
}

function isAttachedToProgram(path: NodePath<t.Node>): boolean {
  let current = path;

  while (!current.isProgram()) {
    const parent = current.parentPath;
    if (
      current.removed ||
      !parent?.node ||
      !t.VISITOR_KEYS[parent.node.type]?.some((key) => {
        const value = (parent.node as unknown as Record<string, unknown>)[key];

        return Array.isArray(value)
          ? value.includes(current.node)
          : value === current.node;
      })
    )
      return false;

    current = parent;
  }

  return true;
}

function namespaceMutation(
  binding: Binding,
  seen = new Set<Binding>(),
  trackedMembers?: readonly string[],
  memberWritesOnly = false,
  isRegisteredCall?: (callee: NodePath<t.Node>) => boolean
): string | undefined {
  if (seen.has(binding)) return undefined;

  seen.add(binding);

  if (!binding.constant && !memberWritesOnly)
    return `Reassigned binding ${binding.identifier.name}`;

  return namespaceReferencesMutation(
    binding.identifier.name,
    binding.referencePaths,
    seen,
    trackedMembers,
    memberWritesOnly,
    isRegisteredCall
  );
}

function namespaceReferencesMutation(
  namespaceName: string,
  references: readonly NodePath<t.Node>[],
  seen: Set<Binding>,
  trackedMembers?: readonly string[],
  memberWritesOnly = false,
  isRegisteredCall?: (callee: NodePath<t.Node>) => boolean
): string | undefined {
  for (const reference of references) {
    const container = reference.parentPath;
    // Replacing an extracted call can detach an ancestor while leaving the
    // reference itself connected to its former member expression.
    if (!container || !isAttachedToProgram(reference)) continue;
    if (trackedMembers && reference.findParent((path) => path.isTSType()))
      continue;
    if (
      container.isJSXMemberExpression() &&
      container.node.object === reference.node
    )
      continue;
    if (container.isJSXOpeningElement() || container.isJSXClosingElement())
      continue;

    let parent: NodePath<t.Node> | null = container;
    let value: NodePath<t.Node> = reference;
    const members: (string | null)[] = [];
    let writesOnly = memberWritesOnly;

    if (
      trackedMembers ||
      (parent.isMemberExpression() && parent.node.object === reference.node)
    ) {
      while (value.parentPath) {
        const next = value.parentPath;
        const member =
          next.isMemberExpression() && next.node.object === value.node;
        const wrapper =
          trackedMembers &&
          (next.isTSAsExpression() ||
            next.isTSTypeAssertion() ||
            next.isTSNonNullExpression() ||
            next.isTSSatisfiesExpression() ||
            next.isParenthesizedExpression()) &&
          next.node.expression === value.node;
        const sequence =
          trackedMembers &&
          next.isSequenceExpression() &&
          next.node.expressions[next.node.expressions.length - 1] ===
            value.node &&
          next.node.expressions
            .slice(0, -1)
            .every((expression) =>
              t.isNumericLiteral(expression, { value: 0 })
            );

        if (!member && !wrapper && !sequence) break;
        if (next.isMemberExpression())
          members.push(staticMemberName(next.node));

        value = next;
      }

      if (isWriteTarget(value)) {
        // Reassigning a sibling's copied value does not mutate the preset.
        if (writesOnly && members.length === 0) continue;
        // A method can read other fields on its owner through `this`.
        if (
          !trackedMembers ||
          overlapsMemberPath(trackedMembers.slice(0, -1), members)
        )
          return `Mutated CommonJS namespace ${namespaceName}`;

        continue;
      }
      if (trackedMembers && !overlapsMemberPath(trackedMembers, members)) {
        if (!overlapsMemberPath(trackedMembers.slice(0, -1), members)) continue;

        writesOnly = true;
      }
      if (!trackedMembers) continue;

      parent = value.parentPath;
    }

    const remainingMembers = writesOnly
      ? []
      : trackedMembers?.slice(members.length);
    // Function endpoints can still expose mutable properties through aliases.
    if (remainingMembers?.length === 0) writesOnly = true;
    if (trackedMembers && isTruthinessRead(value)) continue;

    if (parent?.isVariableDeclarator() && parent.node.init === value.node) {
      if (t.isIdentifier(parent.node.id)) {
        const alias = parent.scope.getBinding(parent.node.id.name);
        const mutation =
          alias &&
          namespaceMutation(
            alias,
            seen,
            remainingMembers,
            writesOnly,
            isRegisteredCall
          );
        if (mutation) return mutation;
      } else if (remainingMembers) {
        for (const name of Object.keys(
          t.getBindingIdentifiers(parent.node.id)
        )) {
          const members = patternMemberPath(parent.node.id, name);
          if (!members) {
            return `Escaped CommonJS namespace ${namespaceName}`;
          }
          const aliasWritesOnly =
            writesOnly || !overlapsMemberPath(remainingMembers, members);
          if (
            !writesOnly &&
            aliasWritesOnly &&
            !overlapsMemberPath(remainingMembers.slice(0, -1), members)
          )
            continue;

          const alias = parent.scope.getBinding(name);
          const mutation =
            alias &&
            namespaceMutation(
              alias,
              seen,
              aliasWritesOnly ? [] : remainingMembers.slice(members.length),
              aliasWritesOnly,
              isRegisteredCall
            );
          if (mutation) return mutation;
        }
      }

      continue;
    }

    if (
      parent?.isCallExpression() &&
      parent.node.callee === value.node &&
      (!trackedMembers || isRegisteredCall?.(value))
    )
      continue;

    // Registered authoring functions may consume sibling values without
    // exposing the preset to an unanalysed runtime function.
    if (
      trackedMembers &&
      parent?.isCallExpression() &&
      isRegisteredCall?.(parent.get("callee") as NodePath<t.Node>)
    )
      continue;

    // Reading typeof does not expose the module object to another function.
    if (parent?.isUnaryExpression({ operator: "typeof" })) continue;

    // JSX lowering can wrap an already-safe className read in its own cx call.
    // Keep that read safe without trusting user calls to the same runtime API.
    let classNameParent = parent;
    if (
      writesOnly &&
      parent?.isCallExpression() &&
      parent.node.arguments.some((argument) => argument === value.node)
    ) {
      const callee = parent.get("callee");
      const program = parent.scope.getProgramParent() as ProgramScope;
      const generatedCx = program.minchoData?.imports?.get(
        "@mincho-js/css/classname:cx"
      );

      if (generatedCx && callee.isIdentifier({ name: generatedCx.name })) {
        const binding = callee.scope.getBinding(generatedCx.name);

        if (binding && binding === program.getBinding(generatedCx.name))
          classNameParent = parent.parentPath;
      }
    }

    // An intrinsic className consumes the copied class string, not its owner.
    if (writesOnly && classNameParent?.isJSXExpressionContainer()) {
      const attribute = classNameParent.parentPath;
      const opening = attribute.parentPath;

      if (
        attribute.isJSXAttribute() &&
        t.isJSXIdentifier(attribute.node.name, { name: "className" }) &&
        opening?.isJSXOpeningElement() &&
        t.isJSXIdentifier(opening.node.name) &&
        /^[a-z]/.test(opening.node.name.name)
      )
        continue;
    }

    return `Escaped CommonJS namespace ${namespaceName}`;
  }

  return undefined;
}

export function isWriteTarget(path: NodePath<t.Node>): boolean {
  const parent = path.parentPath;
  if (!parent) return false;

  if (
    parent.isAssignmentExpression() ||
    parent.isForInStatement() ||
    parent.isForOfStatement()
  )
    return parent.node.left === path.node;

  if (
    parent.isUpdateExpression() ||
    parent.isUnaryExpression({ operator: "delete" })
  )
    return true;

  if (
    parent.isArrayPattern() ||
    parent.isObjectPattern() ||
    (parent.isObjectProperty() &&
      parent.parentPath.isObjectPattern() &&
      parent.node.value === path.node) ||
    (parent.isAssignmentPattern() && parent.node.left === path.node) ||
    parent.isRestElement() ||
    parent.isTSAsExpression() ||
    parent.isTSNonNullExpression() ||
    parent.isTSTypeAssertion() ||
    parent.isParenthesizedExpression()
  )
    return isWriteTarget(parent);

  return false;
}

/** Resolve the actual binding, including compiler comma calls and local aliases. */
export function getModuleReference(
  path: NodePath<t.Node>,
  seen = new Set<t.Node>()
): ModuleReference | null {
  return resolveModuleReference(path, seen);
}

/** Check the nested extraction's export path and its ancestor objects. */
export function getExtractionModuleReference(
  path: NodePath<t.Node>,
  isRegisteredCall?: (callee: NodePath<t.Node>) => boolean
): ModuleReference | null {
  const reference = getModuleReference(path);
  const members = reference?.members.filter((member) => member !== null);
  if (!reference || !members || members.length !== reference.members.length)
    return reference;

  const resolved = resolveModuleReference(
    path,
    new Set(),
    members,
    isRegisteredCall
  );
  if (!resolved || resolved.unsafe) return resolved;

  // Separate declarations can still refer to the same module export. Include
  // require bindings in nested scopes because require shares its cached object.
  const program = path.scope.getProgramParent() as ProgramScope;
  const sources = program.minchoData?.extractCalls?.resolvedSources;
  const resolvedId = sources?.[resolved.kind][resolved.source];
  const sameModule = (source: string, kind: ModuleReference["kind"]) =>
    // Matching IDs prove aliases, but different import/require entry files
    // cannot prove that the same specifier exports independent receivers.
    source === resolved.source ||
    (resolvedId !== undefined && sources?.[kind][source] === resolvedId);
  const bindings = new Set(Object.values(program.bindings));
  const directRequires = new Set<NodePath<t.CallExpression>>();

  // Different import/require entrypoints can re-export the same receiver.
  program.path.traverse({
    CallExpression(call) {
      const source = getStaticCssEvalLiteralRequireImportPath(
        call.node,
        call.scope
      );
      if (!source || !sameModule(source, "require")) return;

      let reference = call;
      // Known interop helpers preserve the module reference. Check the
      // resulting namespace without treating their argument as an escape.
      while (
        reference.parentPath.isCallExpression() &&
        reference.parentPath.node.arguments[0] === reference.node &&
        isSupportedImportInterop(reference.parentPath)
      )
        reference = reference.parentPath;

      // Loading a module without consuming its value exposes no namespace.
      if (!reference.parentPath.isExpressionStatement())
        directRequires.add(reference);
    },
    VariableDeclarator(declaration) {
      for (const name of Object.keys(
        t.getBindingIdentifiers(declaration.node.id)
      )) {
        const binding = declaration.scope.getBinding(name);
        if (binding) bindings.add(binding);
      }
    }
  });

  for (const binding of bindings) {
    const declaration = binding.path;
    const reference =
      declaration.isImportSpecifier() ||
      declaration.isImportDefaultSpecifier() ||
      declaration.isImportNamespaceSpecifier()
        ? declaration.get("local")
        : declaration.isVariableDeclarator()
          ? binding.referencePaths.find(isAttachedToProgram)
          : undefined;
    if (!reference || Array.isArray(reference)) continue;

    const imported = getModuleReference(reference);
    if (
      !imported ||
      !sameModule(imported.source, imported.kind) ||
      !overlapsMemberPath(members.slice(0, -1), imported.members)
    )
      continue;

    const memberWritesOnly =
      !overlapsMemberPath(members, imported.members) ||
      imported.members.length >= members.length;
    const unsafe = namespaceMutation(
      binding,
      new Set(),
      memberWritesOnly ? [] : members.slice(imported.members.length),
      memberWritesOnly,
      isRegisteredCall
    );
    if (unsafe) return { ...resolved, unsafe };
  }

  const unsafe = namespaceReferencesMutation(
    resolved.source,
    [...directRequires],
    new Set(),
    members,
    false,
    isRegisteredCall
  );
  if (unsafe) return { ...resolved, unsafe };

  return resolved;
}

function resolveModuleReference(
  path: NodePath<t.Node>,
  seen: Set<t.Node>,
  trackedMembers?: readonly string[],
  isRegisteredCall?: (callee: NodePath<t.Node>) => boolean
): ModuleReference | null {
  if (seen.has(path.node)) return null;

  const next = new Set(seen).add(path.node);
  if (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isParenthesizedExpression()
  )
    return resolveModuleReference(
      path.get("expression") as NodePath<t.Node>,
      next,
      trackedMembers,
      isRegisteredCall
    );

  if (path.isSequenceExpression()) {
    const expressions = path.get("expressions");
    if (
      expressions
        .slice(0, -1)
        .every((item) => item.isNumericLiteral({ value: 0 }))
    )
      return resolveModuleReference(
        expressions[expressions.length - 1]!,
        next,
        trackedMembers,
        isRegisteredCall
      );

    return null;
  }

  if (path.isCallExpression()) {
    const source = getStaticCssEvalLiteralRequireImportPath(
      path.node,
      path.scope
    );
    if (source) return { source, kind: "require", members: [] };

    const argument = path.get("arguments")[0];
    const wrapped = argument?.isExpression()
      ? resolveModuleReference(argument, next, trackedMembers, isRegisteredCall)
      : null;
    if (wrapped?.kind === "require" && wrapped.members.length === 0)
      return {
        ...wrapped,
        interop: t.isNumericLiteral(path.node.arguments[1], { value: 1 })
          ? "node"
          : true,
        ...(isSupportedImportInterop(path)
          ? {}
          : { unsafe: "Unsupported CommonJS interop helper" })
      };

    return null;
  }

  if (path.isMemberExpression() || path.isJSXMemberExpression()) {
    const reference = resolveModuleReference(
      path.get("object") as NodePath<t.Node>,
      next,
      trackedMembers,
      isRegisteredCall
    );
    if (!reference) return null;

    const member = t.isJSXMemberExpression(path.node)
      ? path.node.property.name
      : staticMemberName(path.node);

    return {
      ...reference,
      members: [...reference.members, member],
      ...(member === null ? { unsafe: "Dynamic CommonJS member access" } : {})
    };
  }

  if (!path.isIdentifier() && !path.isJSXIdentifier()) return null;

  const binding = path.scope.getBinding(path.node.name);
  if (!binding) return null;

  const declaration = binding.path;

  if (
    declaration.isImportSpecifier() ||
    declaration.isImportDefaultSpecifier() ||
    declaration.isImportNamespaceSpecifier()
  ) {
    const parent = declaration.parentPath;
    if (!parent.isImportDeclaration() || parent.node.importKind === "type")
      return null;

    const members = declaration.isImportNamespaceSpecifier()
      ? []
      : [
          declaration.isImportDefaultSpecifier()
            ? "default"
            : t.isIdentifier(declaration.node.imported)
              ? declaration.node.imported.name
              : declaration.node.imported.value
        ];
    const unsafe = trackedMembers
      ? namespaceMutation(
          binding,
          new Set(),
          trackedMembers.slice(members.length),
          false,
          isRegisteredCall
        )
      : undefined;

    return {
      source: parent.node.source.value,
      kind: "import",
      members,
      ...(unsafe ? { unsafe } : {})
    };
  }

  if (!declaration.isVariableDeclarator()) return null;

  // Array destructuring consumes iterator elements, not module exports.
  if (
    !t.isIdentifier(declaration.node.id) &&
    !t.isObjectPattern(declaration.node.id)
  )
    return null;

  const init = declaration.get("init");
  if (!init.node) return null;

  let reference = resolveModuleReference(
    init as NodePath<t.Node>,
    next,
    trackedMembers,
    isRegisteredCall
  );
  if (!reference) return null;

  if (t.isObjectPattern(declaration.node.id)) {
    const property = declaration.node.id.properties.find(
      (item) =>
        t.isObjectProperty(item) &&
        t.isIdentifier(item.value, { name: path.node.name })
    );
    if (!property || !t.isObjectProperty(property)) return null;

    reference = {
      ...reference,
      members: [...reference.members, staticMemberName(property)]
    };
  }

  let unsafe = reference.unsafe;

  if (!binding.constant) unsafe = `Reassigned binding ${path.node.name}`;
  if (
    reference.kind === "require" &&
    path.node.start != null &&
    declaration.node.end != null &&
    path.node.start < declaration.node.end &&
    path.getFunctionParent() === declaration.getFunctionParent()
  )
    unsafe ??= `CommonJS binding ${path.node.name} used before initialization`;
  if (trackedMembers)
    unsafe ??= namespaceMutation(
      binding,
      new Set(),
      trackedMembers.slice(reference.members.length),
      false,
      isRegisteredCall
    );
  else if (reference.kind === "require" && reference.members.length === 0)
    unsafe ??= namespaceMutation(binding);

  return { ...reference, ...(unsafe ? { unsafe } : {}) };
}

export function referencesModuleExport(
  path: NodePath<t.Node>,
  source: string,
  name: string,
  strict = false
): boolean {
  if (path.referencesImport(source, name)) return true;

  const reference = getModuleReference(path);
  if (!reference || reference.source !== source) return false;

  const member =
    reference.members.length === 0 && reference.kind === "require"
      ? "default"
      : reference.members[0];
  if (reference.members.length > 1 || (member !== null && member !== name))
    return false;

  if (reference.unsafe || member === null) {
    if (reference.kind === "import") return false;
    if (strict)
      throw path.buildCodeFrameError(
        `Cannot safely extract ${JSON.stringify(source)} export ${JSON.stringify(name)}: ${reference.unsafe ?? "dynamic member"}. Use mincho-js-ignore to leave this call in place.`
      );

    return false;
  }

  return true;
}
