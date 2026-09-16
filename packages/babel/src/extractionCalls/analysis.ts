import { types as t, type NodePath } from "@babel/core";
import {
  createModuleGraph,
  isExternalModule as isExternal,
  parseModuleProgram as parseProgram,
  exportedName,
  type SourceModule as Module,
  type ModuleTarget as Target
} from "../moduleGraph.js";
import { getModuleReference } from "../commonjs/bindings.js";
import { getStaticCssEvalLiteralRequireImportPath } from "../staticCssEval/cjsBindings.js";
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
    }
  });

  const protectedFunctions = new Map<
    string,
    Map<string, { start: number; end: number }>
  >();

  const visited = new Set<t.Node>();
  let registrationBindings: Set<string> | undefined;
  let registration = "extractCalls";

  function rememberFunction(module: Module, path: NodePath<t.Node>): void {
    if (!path.isFunction()) return;

    const { start, end } = path.node;
    if (start == null || end == null)
      throw new Error(`Missing function source location in ${module.id}`);

    const ranges = protectedFunctions.get(module.id) ?? new Map();
    ranges.set(`${start}:${end}`, { start, end });
    protectedFunctions.set(module.id, ranges);
  }

  function* protect(target: Target): Flow<void> {
    if ("external" in target || visited.has(target.path.node)) return;

    const { module, path } = target;
    visited.add(path.node);

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

    path.traverse({
      TSType(child) {
        child.skip();
      },

      Function(child) {
        rememberFunction(module, child);
      },

      ReferencedIdentifier(child) {
        if (child.isIdentifier()) reference(child);
      }
    });

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
          const member = init.get("properties").findLast((property) => {
            const node = property.node;

            return (
              (t.isObjectMethod(node) || t.isObjectProperty(node)) &&
              (t.isIdentifier(node.key) || t.isStringLiteral(node.key)) &&
              exportedName(node.key) === name
            );
          });

          if (member && !member.isSpreadElement()) {
            yield* protect({
              module,
              path: member.isObjectProperty() ? member.get("value") : member
            });
            continue;
          }
        }

        yield* protect({ module, path: binding.path });
      }
    }
  }

  try {
    const config = normalizeExtractCalls(options.extractCalls);
    const imports: Record<string, readonly string[]> = Object.create(null);
    const localBindings = new Set<string>();
    const localTargets = new Map<string, Set<string>>();
    const requires: Record<string, readonly string[]> = Object.create(null);
    const owner = {
      id: options.filename,
      program:
        options.program ??
        parseProgram(options.filename, options.source, options.jsx)
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
        const targets: Target[] = [];
        const named = yield* resolveExport(module, name, new Set());

        if (named) targets.push(named);

        if (name === "default") {
          const raw = yield* resolveExport(module, null, new Set());

          if (raw && ("external" in raw || raw.path.isFunction()))
            targets.push(raw);
        }

        registrationBindings = undefined;

        if (
          !targets.length ||
          targets.some(
            (target) => !("external" in target) && !target.path.isFunction()
          )
        )
          throw new Error(
            `Cannot statically identify a function implementation in ${id}`
          );

        exports.add(name);

        for (const target of targets) {
          // Named default functions resolve directly, without visiting a binding.
          if (
            !("external" in target) &&
            target.module.id === owner.id &&
            target.path.isFunctionDeclaration() &&
            target.path.node.id
          )
            localBindings.add(target.path.node.id.name);

          yield* protect(target);
        }
      }
    }

    if (localTargets.size) {
      for (const statement of owner.program.get("body")) {
        if (
          !statement.isImportDeclaration() ||
          statement.node.importKind === "type"
        )
          continue;

        const source = statement.node.source.value;
        const id = yield* resolveImport(owner.id, source);
        const names = id ? localTargets.get(id) : undefined;

        if (names)
          imports[source] = [
            ...new Set([...(imports[source] ?? []), ...names])
          ].sort();
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

    for (const source of requireSources) {
      if (!localTargets.size) break;

      const id = yield* resolveImport(owner.id, source, "require");
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
      fingerprint: Object.keys(config).length
        ? JSON.stringify([
            config,
            [...localTargets]
              .map(([id, names]) => [
                relative(root, id).replaceAll("\\", "/"),
                [...names].sort()
              ])
              .sort()
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
      dependencies
    );
  }
}
