import { types as t, type NodePath } from "@babel/core";
import {
  createModuleGraph,
  isExternalModule as isExternal,
  parseModuleProgram as parseProgram,
  exportedName,
  type SourceModule as Module,
  type ModuleTarget as Target
} from "../moduleGraph.js";
import {
  getModuleReference,
  isWriteTarget,
  staticMemberName
} from "../commonjs/bindings.js";
import { getStaticCssEvalLiteralRequireImportPath } from "../staticCssEval/cjsBindings.js";
import {
  getDestructuredBindingSource,
  resolveStaticMemberPath
} from "../staticCssEval/partialEvaluator/destructuring.js";
import type { Binding } from "@babel/traverse";
import { relative, resolve } from "node:path";
import { isLocalExtractCallsSource, normalizeExtractCalls } from "./config.js";
import { canonicalExtractCallsFile } from "./filesystem.js";
import {
  ExtractCallsError,
  type ExtractCallsAnalysis,
  type ExtractCallsAnalysisOptions,
  type ExtractCallsRequest
} from "./types.js";

type Flow<T> = Generator<ExtractCallsRequest, T, string | null>;

function referencedMemberName(
  reference: NodePath<t.Identifier>
): string | null {
  const member = reference.parentPath;
  if (!member.isMemberExpression() || member.node.object !== reference.node)
    return null;
  if (!member.node.computed && t.isIdentifier(member.node.property))
    return member.node.property.name;

  return t.isStringLiteral(member.node.property)
    ? member.node.property.value
    : null;
}

type Receiver = { module: Module; path: NodePath<t.ObjectExpression> };
type RegisteredTarget = { target: Target; receiver?: Receiver };
type LocalRootVisit = { active: boolean; selections: Set<string> };
type LocalBindingSource = {
  path: NodePath<t.Node>;
  selection: readonly (string | null)[];
};

function localBindingSources(binding: Binding): LocalBindingSource[] {
  const declaration = binding.path;
  if (!declaration.isVariableDeclarator()) return [];

  const init = declaration.get("init");
  if (!init.isExpression()) return [];

  const source = getDestructuredBindingSource(binding, binding.identifier.name);
  if (source) return [{ path: init, selection: source.memberPath }];

  return localPatternSources(
    declaration.get("id"),
    init,
    binding.identifier.name
  );
}

function hasDefinedLiteralSelection(
  init: NodePath<t.Expression>,
  selection: readonly (string | null)[]
): boolean {
  let value: t.Expression | null = init.node;

  for (const member of selection) {
    if (member === null || !value) return false;
    if (
      t.isArrayExpression(value) &&
      value.elements
        .slice(0, Number(member) + 1)
        .some((element) => t.isSpreadElement(element))
    )
      return false;

    value = resolveStaticMemberPath(value, [member]);
  }

  return (
    t.isLiteral(value) ||
    t.isObjectExpression(value) ||
    t.isArrayExpression(value) ||
    t.isFunctionExpression(value) ||
    t.isArrowFunctionExpression(value)
  );
}

function localPatternSources(
  pattern: NodePath<t.Node>,
  init: NodePath<t.Expression>,
  name: string
): LocalBindingSource[] {
  let current: NodePath<t.Node> | undefined =
    pattern.getBindingIdentifierPaths()[name];
  if (!current) return [];

  const selection: (string | null)[] = [];
  const sources: LocalBindingSource[] = [];

  while (current && current.node !== pattern.node) {
    const parent: NodePath<t.Node> | null = current.parentPath;
    if (parent?.isAssignmentPattern()) {
      sources.push({ path: parent.get("right"), selection: [...selection] });
      current = parent;
    } else if (parent?.isObjectProperty()) {
      selection.unshift(staticMemberName(parent.node));
      current = parent.parentPath;
    } else if (parent?.isArrayPattern()) {
      selection.unshift(String(current.key));
      current = parent;
    } else if (parent?.isRestElement()) {
      selection.unshift(null);
      current = parent.parentPath ?? undefined;
    } else return [...sources, { path: init, selection: [] }];
  }

  // Defaults stay possible unless an inline literal proves that the selected
  // value is defined. Referenced objects may have been mutated in the module.
  return [
    ...sources.filter(
      (source) =>
        !hasDefinedLiteralSelection(
          init,
          selection.slice(0, selection.length - source.selection.length)
        )
    ),
    { path: init, selection }
  ];
}

function localObjectRoots(
  path: NodePath<t.Node>,
  roots: Set<t.ObjectExpression>,
  memberOwner = true,
  seen = new Map<t.Node, LocalRootVisit>(),
  selection: readonly (string | null)[] = [],
  copiedPropertyExclusions?: ReadonlySet<string>
): ReadonlyMap<string, "data" | "accessor"> | undefined {
  const visited = seen.get(path.node) ?? {
    active: false,
    selections: new Set<string>()
  };
  const key = JSON.stringify([
    selection,
    copiedPropertyExclusions ? [...copiedPropertyExclusions].sort() : null
  ]);
  if (visited.active || visited.selections.has(key)) return;
  visited.active = true;
  visited.selections.add(key);
  seen.set(path.node, visited);

  try {
    if (path.isObjectExpression()) {
      if (selection.length === 0) {
        if (!copiedPropertyExclusions) roots.add(path.node);

        if (!memberOwner) {
          const names = new Set(copiedPropertyExclusions);
          const copiedKeys = new Map<string, "data" | "accessor">();

          for (const property of path.get("properties").toReversed()) {
            if (property.isSpreadElement()) {
              // A spread copies property values, not the source identity.
              const spreadKeys = localObjectRoots(
                property.get("argument"),
                roots,
                memberOwner,
                seen,
                [],
                names
              );

              for (const [name, kind] of spreadKeys ?? []) {
                if (names.has(name)) continue;
                if (!copiedKeys.has(name)) copiedKeys.set(name, kind);
                if (copiedKeys.get(name) === "data") names.add(name);
              }

              continue;
            }

            const node = property.node;
            if (!t.isObjectProperty(node) && !t.isObjectMethod(node)) continue;

            const name = t.isObjectProperty(node)
              ? staticMemberName(node)
              : !node.computed && t.isIdentifier(node.key)
                ? node.key.name
                : t.isStringLiteral(node.key) || t.isNumericLiteral(node.key)
                  ? String(node.key.value)
                  : null;

            if (name !== null) {
              if (names.has(name)) continue;
              names.add(name);

              // An accessor key alone does not prove a safe overwrite.
              if (!copiedKeys.has(name))
                copiedKeys.set(
                  name,
                  t.isObjectProperty(node) || node.kind === "method"
                    ? "data"
                    : "accessor"
                );
            }

            if (property.isObjectProperty()) {
              const value = property.get("value");

              if (value.isExpression())
                localObjectRoots(value, roots, memberOwner, seen);
            } else if (property.isObjectMethod({ kind: "get" })) {
              property.traverse({
                Function(nested) {
                  nested.skip();
                },
                ReturnStatement(result) {
                  const value = result.get("argument");

                  if (value.isExpression())
                    localObjectRoots(value, roots, memberOwner, seen);
                }
              });
            }
          }

          return copiedKeys;
        }
      } else if (selection[0] === null) roots.add(path.node);
      else {
        const property = path.get("properties").findLast((property) => {
          const node = property.node;
          if (t.isSpreadElement(node)) return true;

          const name = t.isObjectProperty(node)
            ? staticMemberName(node)
            : !node.computed && t.isIdentifier(node.key)
              ? node.key.name
              : t.isStringLiteral(node.key) || t.isNumericLiteral(node.key)
                ? String(node.key.value)
                : null;

          return name === null || name === selection[0];
        });

        if (
          property?.isObjectProperty() &&
          staticMemberName(property.node) !== null
        ) {
          const value = property.get("value");
          if (value.isExpression())
            localObjectRoots(
              value,
              roots,
              memberOwner,
              seen,
              selection.slice(1),
              copiedPropertyExclusions
            );
        } else if (
          property &&
          !(property.isObjectMethod() && property.node.kind === "method")
        )
          roots.add(path.node);
      }
    }

    if (path.isArrayExpression() && !memberOwner && selection.length === 0) {
      for (const [index, element] of path.get("elements").entries()) {
        if (
          !copiedPropertyExclusions?.has(String(index)) &&
          element.isExpression()
        )
          localObjectRoots(element, roots, memberOwner, seen);
      }
    }

    if (path.isArrayExpression() && selection.length > 0) {
      const index = selection[0];
      if (index !== null && /^\d+$/.test(index)) {
        const element = path.get("elements")[Number(index)];
        if (
          element?.isExpression() &&
          !path.node.elements
            .slice(0, Number(index))
            .some((element) => t.isSpreadElement(element))
        )
          localObjectRoots(
            element,
            roots,
            memberOwner,
            seen,
            selection.slice(1),
            copiedPropertyExclusions
          );
      }
    }

    if (path.isMemberExpression())
      localObjectRoots(
        path.get("object"),
        roots,
        memberOwner,
        seen,
        memberOwner ? selection : [staticMemberName(path.node), ...selection],
        copiedPropertyExclusions
      );
    if (
      path.isTSAsExpression() ||
      path.isTSTypeAssertion() ||
      path.isTSNonNullExpression() ||
      path.isTSSatisfiesExpression() ||
      path.isTypeCastExpression() ||
      path.isParenthesizedExpression()
    ) {
      const expression = path.get("expression");
      if (!Array.isArray(expression))
        localObjectRoots(
          expression,
          roots,
          memberOwner,
          seen,
          selection,
          copiedPropertyExclusions
        );
    }

    if (path.isConditionalExpression()) {
      localObjectRoots(
        path.get("consequent"),
        roots,
        memberOwner,
        seen,
        selection,
        copiedPropertyExclusions
      );
      localObjectRoots(
        path.get("alternate"),
        roots,
        memberOwner,
        seen,
        selection,
        copiedPropertyExclusions
      );
    }

    if (path.isLogicalExpression()) {
      // An && expression only returns its left operand when it is falsy,
      // so an object receiver can only come from the right operand.
      if (path.node.operator !== "&&")
        localObjectRoots(
          path.get("left"),
          roots,
          memberOwner,
          seen,
          selection,
          copiedPropertyExclusions
        );

      localObjectRoots(
        path.get("right"),
        roots,
        memberOwner,
        seen,
        selection,
        copiedPropertyExclusions
      );
    }

    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      const declaration = binding?.path;
      if (declaration?.isVariableDeclarator()) {
        const init = declaration.get("init");
        if (memberOwner && init.isExpression())
          localObjectRoots(
            init,
            roots,
            memberOwner,
            seen,
            selection,
            copiedPropertyExclusions
          );

        if (binding)
          for (const source of localBindingSources(binding))
            localObjectRoots(
              source.path,
              roots,
              memberOwner,
              seen,
              [...source.selection, ...selection],
              copiedPropertyExclusions
            );
      }

      // Reassigned aliases may refer to any explicitly assigned object. Keep
      // their possible roots instead of guessing which assignment ran last.
      for (const violation of binding?.constantViolations ?? []) {
        if (!violation.isAssignmentExpression()) continue;

        for (const source of localPatternSources(
          violation.get("left"),
          violation.get("right"),
          path.node.name
        ))
          localObjectRoots(
            source.path,
            roots,
            memberOwner,
            seen,
            [...source.selection, ...selection],
            copiedPropertyExclusions
          );
      }
    }
  } finally {
    visited.active = false;
  }

  return undefined;
}

/** One graph walk, driven by synchronous Node I/O or asynchronous bundler I/O. */
export function* analyzeExtractCalls(
  options: ExtractCallsAnalysisOptions
): ExtractCallsAnalysis {
  const root = canonicalExtractCallsFile(options.root);
  const {
    dependencies,
    modules,
    resolveImport,
    load,
    bindingTarget,
    valueTarget,
    resolveExport
  } = createModuleGraph({
    onResolveBinding(module, binding) {
      if (module.id === options.filename)
        registrationBindings?.add(binding.identifier.name);
    },
    parse: (id, source, jsx) =>
      parseProgram(id, source, jsx, options.parserCache, options.parserPlugins)
  });

  const protectedFunctions = new Map<
    string,
    Map<string, { start: number; end: number }>
  >();

  const visited = new Map<t.Node, Set<t.Node | undefined>>();
  const mutatedReceivers = new Map<Module, Set<t.ObjectExpression>>();
  const escapedReceivers = new Map<Module, Set<t.ObjectExpression>>();
  let registrationBindings: Set<string> | undefined;
  let registration = "extractCalls";

  function* resolveReceiverMember(
    target: Target,
    name: string
  ): Flow<RegisteredTarget | null> {
    if ("external" in target) return null;
    const { path, module } = target;
    if (
      !path.isObjectExpression() ||
      path.node.properties.some(
        (property) => t.isSpreadElement(property) || property.computed
      )
    )
      return null;

    let mutations = mutatedReceivers.get(module);
    if (!mutations) {
      const writes = new Set<t.ObjectExpression>();
      const escapes = new Set<t.ObjectExpression>();
      const collectArgumentEscapes = (
        call: NodePath<t.CallExpression | t.NewExpression>
      ) => {
        for (const argument of call.get("arguments")) {
          if (argument.isExpression())
            localObjectRoots(argument, escapes, false);
        }
      };

      module.program.traverse({
        MemberExpression(member) {
          if (!isWriteTarget(member)) return;
          localObjectRoots(member.get("object"), writes);
        },
        CallExpression: collectArgumentEscapes,
        NewExpression: collectArgumentEscapes
      });
      mutations = writes;
      mutatedReceivers.set(module, writes);
      escapedReceivers.set(module, escapes);
    }

    if (mutations.has(path.node))
      throw new Error(
        `Cannot use mutated extractCalls receiver in ${module.id}`
      );

    if (escapedReceivers.get(module)?.has(path.node))
      throw new Error(
        `Cannot use escaped extractCalls receiver in ${module.id}`
      );

    const member = path.get("properties").findLast((property) => {
      const node = property.node;
      return (
        (t.isObjectMethod(node) || t.isObjectProperty(node)) &&
        (t.isIdentifier(node.key) || t.isStringLiteral(node.key)) &&
        exportedName(node.key) === name
      );
    });
    if (!member || member.isSpreadElement()) return null;
    if (member.isObjectMethod() && member.node.kind !== "method") return null;

    const value = yield* valueTarget(
      module,
      member.isObjectProperty() ? member.get("value") : member,
      new Set()
    );

    return value ? { target: value, receiver: { module, path } } : null;
  }

  function* resolveRegisteredExports(
    module: Module,
    name: string
  ): Flow<RegisteredTarget[]> {
    const targets: RegisteredTarget[] = [];
    const literal = yield* resolveExport(module, name, new Set());

    if (literal) targets.push({ target: literal });
    if (!name.includes(".")) return targets;

    const [head, ...members] = name.split(".");
    const target = yield* resolveExport(module, head!, new Set());
    let selected: RegisteredTarget | null = target ? { target } : null;

    for (const name of members)
      selected = selected
        ? yield* resolveReceiverMember(selected.target, name)
        : null;

    if (selected) targets.push(selected);

    return targets;
  }

  function rememberFunction(module: Module, path: NodePath<t.Node>): void {
    if (!path.isFunction()) return;

    const { start, end } = path.node;
    if (start == null || end == null)
      throw new Error(`Missing function source location in ${module.id}`);

    const ranges = protectedFunctions.get(module.id) ?? new Map();
    ranges.set(`${start}:${end}`, { start, end });
    protectedFunctions.set(module.id, ranges);
  }

  function* protect(target: Target, receiver?: Receiver): Flow<void> {
    if ("external" in target) return;

    const { module, path } = target;
    const owners = visited.get(path.node) ?? new Set<t.Node | undefined>();
    if (owners.has(receiver?.path.node)) return;
    owners.add(receiver?.path.node);
    visited.set(path.node, owners);

    const references: Array<{
      binding: Binding;
      reference: NodePath<t.Identifier>;
    }> = [];

    const reference = (reference: NodePath<t.Identifier>) => {
      const binding = reference.scope.getBinding(reference.node.name);

      if (
        binding &&
        binding.path !== path &&
        !binding.path.findParent((parent) => parent === path)
      )
        references.push({ binding, reference });
    };

    rememberFunction(module, path);

    if (path.isReferencedIdentifier())
      reference(path as NodePath<t.Identifier>);

    const receiverReferences: string[][] = [];
    path.traverse({
      TSType(child) {
        child.skip();
      },

      Function(child) {
        rememberFunction(module, child);
      },

      ReferencedIdentifier(child) {
        if (child.isIdentifier()) reference(child);
      },

      ThisExpression(child) {
        if (
          !receiver ||
          child.findParent(
            (parent) =>
              parent.isFunction() && !parent.isArrowFunctionExpression()
          ) !== path
        )
          return;

        const names: string[] = [];
        let value: NodePath<t.Node> = child;
        while (value.parentPath) {
          const member = value.parentPath;
          if (
            (member.isTSAsExpression() ||
              member.isTSTypeAssertion() ||
              member.isTSNonNullExpression() ||
              member.isTSSatisfiesExpression() ||
              member.isTypeCastExpression() ||
              member.isParenthesizedExpression()) &&
            member.node.expression === value.node
          ) {
            value = member;
            continue;
          }

          if (!member.isMemberExpression() || member.node.object !== value.node)
            break;

          const property = member.node.property;
          if (!member.node.computed && t.isIdentifier(property))
            names.push(property.name);
          else if (t.isStringLiteral(property)) names.push(property.value);
          else
            throw new Error(
              `Cannot identify extractCalls receiver member in ${module.id}`
            );

          value = member;
        }

        if (names.length === 0)
          throw new Error(
            `Cannot identify extractCalls receiver member in ${module.id}`
          );

        if (isWriteTarget(value))
          throw new Error(
            `Cannot use mutated extractCalls receiver in ${module.id}`
          );

        receiverReferences.push(names);
      }
    });

    for (const names of receiverReferences) {
      let dependency: RegisteredTarget | null = { target: receiver! };
      for (const name of names)
        dependency = dependency
          ? yield* resolveReceiverMember(dependency.target, name)
          : null;

      if (!dependency)
        throw new Error(
          `Cannot identify extractCalls receiver member ${names.join(".")} in ${module.id}`
        );

      yield* protect(dependency.target, dependency.receiver);
    }

    const inlineRequires: { source: string; path: NodePath<t.Node> }[] = [];
    path.traverse({
      CallExpression(call) {
        const source = getStaticCssEvalLiteralRequireImportPath(
          call.node,
          call.scope
        );
        if (source)
          inlineRequires.push({
            source,
            path: call.parentPath.isMemberExpression() ? call.parentPath : call
          });
      }
    });

    for (const { source, path: call } of inlineRequires) {
      const id = yield* resolveImport(module.id, source, "require");
      if (id ? isExternal(id) : !isLocalExtractCallsSource(source)) continue;

      const dependency = yield* valueTarget(module, call, new Set());

      if (dependency) yield* protect(dependency);
    }

    for (const { binding, reference } of references) {
      const cjs = getModuleReference(reference);

      if (cjs?.kind === "require") {
        const id = yield* resolveImport(module.id, cjs.source, "require");
        if (id ? isExternal(id) : !isLocalExtractCallsSource(cjs.source))
          continue;

        const member =
          reference.parentPath.isMemberExpression() &&
          reference.parentPath.node.object === reference.node
            ? reference.parentPath
            : reference;

        const dependency = yield* valueTarget(module, member, new Set());

        if (dependency) yield* protect(dependency);
      } else if (binding.path.isImportNamespaceSpecifier()) {
        const declaration = binding.path.parentPath;
        if (!declaration.isImportDeclaration()) continue;

        const id = yield* resolveImport(
          module.id,
          declaration.node.source.value
        );

        if (!id) {
          if (!isLocalExtractCallsSource(declaration.node.source.value))
            continue;

          throw new Error(
            `Cannot resolve ${declaration.node.source.value} from ${module.id}`
          );
        }

        if (isExternal(id)) continue;

        const name = referencedMemberName(reference);
        if (name === null)
          throw new Error(
            `Cannot identify namespace helper ${reference.node.name} in ${module.id}`
          );

        const dependency = yield* resolveExport(
          yield* load(id),
          name,
          new Set()
        );

        if (dependency) yield* protect(dependency);
      } else if (
        binding.path.isImportSpecifier() ||
        binding.path.isImportDefaultSpecifier()
      ) {
        const dependency = yield* bindingTarget(module, binding, new Set());

        if (dependency) yield* protect(dependency);
      } else {
        const name = referencedMemberName(reference);
        const init = binding.path.isVariableDeclarator()
          ? binding.path.get("init")
          : undefined;

        if (
          name &&
          binding.constant &&
          init?.isObjectExpression() &&
          init.node.properties.every(
            (property) => !t.isSpreadElement(property) && !property.computed
          )
        ) {
          const dependency = yield* resolveReceiverMember(
            { module, path: init },
            name
          );

          if (dependency) {
            yield* protect(dependency.target, dependency.receiver);
            continue;
          }
        }

        yield* protect({ module, path: binding.path });
      }
    }
  }

  try {
    const config = normalizeExtractCalls(
      options.extractCalls,
      options.parserCache
    );

    const hasTargets = Object.keys(config).length > 0;
    const imports: Record<string, readonly string[]> = Object.create(null);
    const localBindings = new Set<string>();
    const localTargets = new Map<string, Set<string>>();
    const requires: Record<string, readonly string[]> = Object.create(null);
    const resolvedSources: {
      import: Record<string, string>;
      require: Record<string, string>;
    } = { import: Object.create(null), require: Object.create(null) };
    const owner = {
      id: options.filename,
      program:
        options.program ??
        parseProgram(
          options.filename,
          options.source,
          options.jsx,
          options.parserCache,
          options.parserPlugins
        )
    };

    modules.set(owner.id, owner);

    for (const [source, names] of Object.entries(config)) {
      if (!isLocalExtractCallsSource(source)) {
        imports[source] = names;
        requires[source] = names;
        continue;
      }

      registration = `extractCalls[${JSON.stringify(source)}]`;
      dependencies.add(resolve(root, source).replaceAll("\\", "/"));

      const id = yield* resolveImport(
        resolve(root, "__mincho_extract_calls__.ts"),
        source,
        "require"
      );
      if (!id) throw new Error(`Cannot resolve registered module from ${root}`);

      const module = yield* load(id);
      const exports = localTargets.get(id) ?? new Set<string>();
      localTargets.set(id, exports);

      for (const name of names) {
        registration = `extractCalls[${JSON.stringify(source)}]: export ${JSON.stringify(name)}`;

        registrationBindings = localBindings;
        const targets = yield* resolveRegisteredExports(module, name);

        if (name === "default") {
          const raw = yield* resolveExport(module, null, new Set());

          if (raw && ("external" in raw || raw.path.isFunction()))
            targets.push({ target: raw });
        }

        registrationBindings = undefined;

        if (
          !targets.length ||
          targets.some(
            ({ target }) => !("external" in target) && !target.path.isFunction()
          )
        )
          throw new Error(
            `Cannot statically identify a function implementation in ${id}`
          );

        exports.add(name);

        for (const { target, receiver } of targets) {
          // Named default functions resolve directly, without visiting a binding.
          if (
            !("external" in target) &&
            target.module.id === owner.id &&
            target.path.isFunctionDeclaration() &&
            target.path.node.id
          )
            localBindings.add(target.path.node.id.name);

          yield* protect(target, receiver);
        }
      }
    }

    const requireSources = new Set<string>();
    owner.program.traverse({
      CallExpression(path) {
        const source = getStaticCssEvalLiteralRequireImportPath(
          path.node,
          path.scope
        );

        if (source) requireSources.add(source);
      }
    });

    for (const statement of owner.program.get("body")) {
      if (
        !statement.isImportDeclaration() ||
        statement.node.importKind === "type"
      )
        continue;

      const source = statement.node.source.value;
      if (!hasTargets) continue;

      const id = yield* resolveImport(owner.id, source);
      if (id) resolvedSources.import[source] = id;

      const names = id ? localTargets.get(id) : undefined;

      if (names)
        imports[source] = [
          ...new Set([...(imports[source] ?? []), ...names])
        ].sort();
    }

    for (const source of requireSources) {
      if (!hasTargets) continue;

      const id = yield* resolveImport(owner.id, source, "require");
      if (id) resolvedSources.require[source] = id;

      const names = id ? localTargets.get(id) : undefined;

      if (names)
        requires[source] = [
          ...new Set([...(requires[source] ?? []), ...names])
        ].sort();
    }

    return {
      imports,
      localBindings: [...localBindings].sort(),
      requires,
      resolvedSources,
      fingerprint: hasTargets
        ? JSON.stringify([
            // Identical source can resolve imports differently for each owner.
            relative(root, owner.id).replaceAll("\\", "/"),
            config,
            [...localTargets]
              .map(([id, names]) => [
                relative(root, id).replaceAll("\\", "/"),
                [...names].sort()
              ])
              .sort(),
            (["import", "require"] as const).map((kind) =>
              Object.entries(resolvedSources[kind])
                .map(([source, id]) => [
                  source,
                  relative(root, id).replaceAll("\\", "/")
                ])
                .sort()
            )
          ])
        : "",
      protectedFunctions: [
        ...(protectedFunctions.get(owner.id)?.values() ?? [])
      ],
      dependencies: [...dependencies].filter((id) => id !== owner.id).sort()
    };
  } catch (error) {
    throw new ExtractCallsError(
      `${registration}: ${error instanceof Error ? error.message : String(error)}`,
      dependencies,
      { cause: error }
    );
  }
}
