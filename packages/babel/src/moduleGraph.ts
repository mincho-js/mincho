import type { SourceAstCache } from "./staticCssEval/moduleParser.js";
import { parseSync, traverse, types as t, type NodePath } from "@babel/core";
import type { Binding } from "@babel/traverse";
import { isAbsolute } from "node:path";
import {
  getModuleReference,
  type ModuleReference
} from "./commonjs/bindings.js";
import {
  commonJsExports,
  findNodePath,
  normalizeTypeScriptCommonJs
} from "./commonjs/modules.js";

export type ModuleGraphRequest =
  | {
      kind: "resolve";
      importer: string;
      source: string;
      mode?: "import" | "require";
    }
  | { kind: "load"; id: string };

export type ModuleGraphFlow<T> = Generator<
  ModuleGraphRequest,
  T,
  string | null
>;

export interface SourceModule {
  readonly id: string;
  readonly program: NodePath<t.Program>;
}

export type ModuleTarget =
  | { module: SourceModule; path: NodePath<t.Node> }
  | {
      external: true;
      source: string;
      name: string | null;
      mode: "import" | "require";
    };

type Module = SourceModule;

type Target = ModuleTarget;

type Flow<T> = ModuleGraphFlow<T>;

export function parseModuleProgram(
  id: string,
  source: string,
  jsx = /\.(?:[jt]sx|[cm]?js)$/.test(id),
  cache?: SourceAstCache
): NodePath<t.Program> {
  const ast = cache
    ? cache.parse({
        resolvedFile: id,
        source,
        parserOptions: {
          plugins: jsx ? ["jsx", "typescript"] : ["typescript"],
          sourceType: "unambiguous",
          jsx,
          typescript: true
        }
      })
    : parseSync(source, {
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

export function exportedName(node: t.Identifier | t.StringLiteral): string {
  return t.isIdentifier(node) ? node.name : node.value;
}

export function isExternalModule(id: string): boolean {
  return (
    !isAbsolute(id) ||
    /(?:^|\/)(?:node_modules|\.yarn)\//.test(id) ||
    !/\.[cm]?[jt]sx?$/.test(id)
  );
}

/** Transient lexical graph. Only source/AST summaries may be cached across transforms. */
export function createModuleGraph(
  options: {
    readonly isExternal?: (id: string) => boolean;
    readonly parse?: typeof parseModuleProgram;
    readonly onResolveBinding?: (
      module: SourceModule,
      binding: Binding
    ) => void;
  } = {}
) {
  const dependencies = new Set<string>();
  const modules = new Map<string, SourceModule>();
  const resolutions = new Map<string, string | null>();
  const exportDemands = new Map<string, Set<string | null>>();
  const isExternal = options.isExternal ?? isExternalModule;
  const parseProgram = options.parse ?? parseModuleProgram;

  const commonJsShapes = new WeakMap<
    t.Program,
    ReturnType<typeof commonJsExports>
  >();

  function commonJsShape(module: Module) {
    let shape = commonJsShapes.get(module.program.node);
    if (!shape) {
      shape = commonJsExports(module.program, module.id);
      commonJsShapes.set(module.program.node, shape);
    }
    return shape;
  }

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
    interop: ModuleReference["interop"] = false
  ): Flow<Target | null> {
    const id = yield* resolveImport(module.id, source, mode);

    if (!id) {
      if (!(source.startsWith(".") || isAbsolute(source)))
        return { external: true, source, name, mode };

      throw new Error(
        `Cannot resolve ${JSON.stringify(source)} from ${module.id}`
      );
    }

    if (isExternal(id)) return { external: true, source, name, mode };

    const imported = yield* load(id);

    if (name === "default" && (mode === "import" || interop)) {
      const shape = commonJsShape(imported);
      const marker = shape.exports.get("__esModule");
      if (
        shape.exports.has(null) &&
        !(
          interop === true &&
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

    options.onResolveBinding?.(module, binding);

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

    if (reference?.kind === "import" && reference.members.length === 1) {
      if (reference.unsafe) throw new Error(reference.unsafe);

      const name = reference.members[0];
      if (name == null) return null;

      return yield* importTarget(module, reference.source, name, seen);
    }

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
    const demanded = exportDemands.get(module.id) ?? new Set<string | null>();
    demanded.add(name);
    exportDemands.set(module.id, demanded);

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

    const commonjs = commonJsShape(module);
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

  return {
    modules,
    dependencies,
    resolutions,
    exportDemands,
    load,
    resolveImport,
    importTarget,
    bindingTarget,
    valueTarget,
    resolveExport
  };
}

export type ModuleGraph = ReturnType<typeof createModuleGraph>;
