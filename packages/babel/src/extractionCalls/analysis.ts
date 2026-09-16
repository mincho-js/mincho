import { parseSync, traverse, types as t, type NodePath } from "@babel/core";
import { getModuleReference } from "../commonjs/bindings.js";
import {
  commonJsExports,
  findNodePath,
  normalizeTypeScriptCommonJs
} from "../commonjs/modules.js";
import { getStaticCssEvalLiteralRequireImportPath } from "../staticCssEval/cjsBindings.js";
import type { Binding } from "@babel/traverse";
import { isAbsolute, relative, resolve } from "node:path";
import { isLocalExtractCallsSource, normalizeExtractCalls } from "./config.js";
import { canonicalExtractCallsFile } from "./filesystem.js";
import {
  ExtractCallsError,
  type ExtractCallsAnalysis,
  type ExtractCallsAnalysisOptions,
  type ExtractCallsRequest
} from "./types.js";

type Flow<T> = Generator<ExtractCallsRequest, T, string | null>;

interface Module {
  id: string;
  program: NodePath<t.Program>;
}

type Target = { module: Module; path: NodePath<t.Node> } | { external: true };

function parseProgram(
  id: string,
  source: string,
  jsx = /\.(?:[jt]sx|[cm]?js)$/.test(id)
): NodePath<t.Program> {
  const ast = parseSync(source, {
    filename: id,
    configFile: false,
    babelrc: false,
    parserOpts: {
      sourceType: "unambiguous",
      plugins: ["typescript", ...(jsx ? ["jsx" as const] : [])]
    }
  });

  let program: NodePath<t.Program> | undefined;

  if (ast)
    traverse(ast, {
      Program(path) {
        program = path;
        path.stop();
      }
    });
  if (!program) throw new Error(`Cannot parse extractCalls module ${id}`);

  normalizeTypeScriptCommonJs(program);

  return program;
}

function exportedName(node: t.Identifier | t.StringLiteral): string {
  return t.isIdentifier(node) ? node.name : node.value;
}

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

function isExternal(id: string): boolean {
  return (
    !isAbsolute(id) ||
    /(?:^|\/)(?:node_modules|\.yarn)\//.test(id) ||
    !/\.[cm]?[jt]sx?$/.test(id)
  );
}

/** One graph walk, driven by synchronous Node I/O or asynchronous bundler I/O. */
export function* analyzeExtractCalls(
  options: ExtractCallsAnalysisOptions
): ExtractCallsAnalysis {
  const root = canonicalExtractCallsFile(options.root);
  const dependencies = new Set<string>();
  const modules = new Map<string, Module>();
  const resolutions = new Map<string, string | null>();
  const protectedFunctions = new Map<
    string,
    Map<string, { start: number; end: number }>
  >();

  const visited = new Set<t.Node>();
  let registrationBindings: Set<string> | undefined;
  let registration = "extractCalls";

  function* resolveImport(
    importer: string,
    source: string,
    mode: "import" | "require" = "import"
  ): Flow<string | null> {
    const key = JSON.stringify([importer, source, mode]);

    if (!resolutions.has(key))
      resolutions.set(key, yield { kind: "resolve", importer, source, mode });

    return resolutions.get(key) ?? null;
  }

  function* load(id: string): Flow<Module> {
    const existing = modules.get(id);
    if (existing) return existing;

    dependencies.add(id);

    if (modules.size >= 512)
      throw new Error("extractCalls module graph exceeds 512 modules");

    const source = yield { kind: "load", id };
    if (source === null) throw new Error(`Cannot load ${id}`);

    const record = { id, program: parseProgram(id, source) };
    modules.set(id, record);

    return record;
  }

  function* importTarget(
    module: Module,
    source: string,
    name: string | null,
    seen: Set<string>,
    mode: "import" | "require" = "import",
    interop = false
  ): Flow<Target | null> {
    const id = yield* resolveImport(module.id, source, mode);

    if (!id) {
      if (!isLocalExtractCallsSource(source)) return { external: true };

      throw new Error(
        `Cannot resolve ${JSON.stringify(source)} from ${module.id}`
      );
    }

    if (isExternal(id)) return { external: true };

    const imported = yield* load(id);

    if (name === "default" && (mode === "import" || interop)) {
      const shape = commonJsExports(imported.program, imported.id);
      const marker = shape.exports.get("__esModule");
      if (
        shape.exports.has(null) &&
        !(
          interop &&
          marker?.kind === "expression" &&
          t.isBooleanLiteral(marker.expression, { value: true })
        )
      )
        return yield* resolveExport(imported, null, seen);
    }

    return yield* resolveExport(imported, name, seen);
  }

  function* bindingTarget(
    module: Module,
    binding: Binding,
    seen: Set<string>
  ): Flow<Target | null> {
    if (!binding.constant)
      throw new Error(
        `Mutable binding ${binding.identifier.name} in ${module.id}`
      );

    if (module.id === options.filename)
      registrationBindings?.add(binding.identifier.name);

    const path = binding.path;

    if (path.isImportSpecifier() || path.isImportDefaultSpecifier()) {
      const declaration = path.parentPath;
      if (!declaration.isImportDeclaration()) return null;

      return yield* importTarget(
        module,
        declaration.node.source.value,
        path.isImportDefaultSpecifier()
          ? "default"
          : exportedName(path.node.imported),
        seen
      );
    }

    return yield* valueTarget(module, path, seen);
  }

  function* valueTarget(
    module: Module,
    path: NodePath<t.Node>,
    seen: Set<string>
  ): Flow<Target | null> {
    const reference = getModuleReference(path);

    if (reference?.kind === "require") {
      if (reference.unsafe) throw new Error(reference.unsafe);
      if (reference.members.length > 1 || reference.members.includes(null))
        throw new Error(`Cannot identify CommonJS helper in ${module.id}`);

      return yield* importTarget(
        module,
        reference.source,
        reference.members[0] ?? null,
        seen,
        "require",
        reference.interop
      );
    }

    if (path.isVariableDeclarator()) {
      const init = path.get("init");

      return init.node
        ? yield* valueTarget(module, init as NodePath<t.Node>, seen)
        : null;
    }

    if (
      path.isTSAsExpression() ||
      path.isTSSatisfiesExpression() ||
      path.isTSNonNullExpression() ||
      path.isTSTypeAssertion() ||
      path.isParenthesizedExpression()
    )
      return yield* valueTarget(
        module,
        path.get("expression") as NodePath<t.Node>,
        seen
      );

    if (path.isIdentifier()) {
      const key = `${module.id}:binding:${path.node.name}`;
      if (seen.has(key)) return null;

      const binding = path.scope.getBinding(path.node.name);

      return binding
        ? yield* bindingTarget(module, binding, new Set([...seen, key]))
        : null;
    }

    return { module, path };
  }

  function* resolveExport(
    module: Module,
    name: string | null,
    seen: Set<string>
  ): Flow<Target | null> {
    const key = `${module.id}:export:${name}`;
    if (seen.has(key)) return null;

    const next = new Set([...seen, key]);
    const stars: string[] = [];

    for (const statement of module.program.get("body")) {
      if (statement.isExportDefaultDeclaration() && name === "default")
        return yield* valueTarget(module, statement.get("declaration"), next);
      if (
        statement.isExportAllDeclaration() &&
        statement.node.exportKind !== "type"
      )
        stars.push(statement.node.source.value);
      if (
        !statement.isExportNamedDeclaration() ||
        statement.node.exportKind === "type"
      )
        continue;

      const declaration = statement.get("declaration");

      if (
        name !== null &&
        declaration.node &&
        Object.hasOwn(t.getOuterBindingIdentifiers(declaration.node), name)
      ) {
        const binding = module.program.scope.getBinding(name);

        return binding ? yield* bindingTarget(module, binding, next) : null;
      }

      for (const specifier of statement.get("specifiers")) {
        if (
          !specifier.isExportSpecifier() ||
          specifier.node.exportKind === "type" ||
          exportedName(specifier.node.exported) !== name
        )
          continue;

        const local = exportedName(specifier.node.local);
        if (statement.node.source)
          return yield* importTarget(
            module,
            statement.node.source.value,
            local,
            next
          );

        const binding = module.program.scope.getBinding(local);

        return binding ? yield* bindingTarget(module, binding, next) : null;
      }
    }

    const commonjs = commonJsExports(module.program, module.id);
    const entry = commonjs.exports.get(name);

    if (entry) {
      if (entry.kind === "unsupported")
        throw new Error(
          `Unsupported CommonJS export ${name} in ${module.id}: ${entry.cjsExportMutation ?? entry.cjsHelperName ?? entry.unsupportedKind}`
        );
      if (entry.kind === "reexport")
        return yield* importTarget(
          module,
          entry.source,
          entry.importedName,
          next,
          "require"
        );

      if (entry.kind === "local") {
        const binding = module.program.scope.getBinding(entry.localName);

        return binding ? yield* bindingTarget(module, binding, next) : null;
      }

      const expression = findNodePath(module.program, entry.expression);

      return expression ? yield* valueTarget(module, expression, next) : null;
    }

    // module.exports = require("./impl") forwards its named exports as well.
    const replacement = commonjs.exports.get(null);

    if (name !== null && replacement?.kind === "expression") {
      const expression = findNodePath(module.program, replacement.expression);
      const reference = expression && getModuleReference(expression);
      if (reference?.kind === "require" && reference.members.length === 0)
        return yield* importTarget(
          module,
          reference.source,
          name,
          next,
          "require"
        );
    }

    if (name === "default" || name === null) return null;

    let found: Target | null = null;

    for (const [source, mode] of [
      ...stars.map((source) => [source, "import"] as const),
      ...commonjs.stars.map((star) => [star.source, "require"] as const)
    ]) {
      const candidate = yield* importTarget(module, source, name, next, mode);
      if (!candidate) continue;
      if (
        found &&
        ("external" in found ||
          "external" in candidate ||
          found.path.node !== candidate.path.node)
      )
        throw new Error(`Ambiguous export ${name} in ${module.id}`);

      found = candidate;
    }

    return found;
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

    const inlineRequires: NodePath<t.Node>[] = [];
    path.traverse({
      CallExpression(call) {
        if (getStaticCssEvalLiteralRequireImportPath(call.node, call.scope))
          inlineRequires.push(
            call.parentPath.isMemberExpression() ? call.parentPath : call
          );
      }
    });

    for (const call of inlineRequires) {
      const dependency = yield* valueTarget(module, call, new Set());

      if (dependency) yield* protect(dependency);
    }

    for (const { binding, reference } of references) {
      const cjs = getModuleReference(reference);

      if (cjs?.kind === "require") {
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
