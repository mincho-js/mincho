import type { SourceAstCache } from "./staticCssEval/moduleParser.js";
import { createHash } from "node:crypto";
import {
  parseSync,
  traverse,
  types as t,
  type NodePath,
  type TransformOptions
} from "@babel/core";
import type { Binding } from "@babel/traverse";
import {
  getStaticCssEvalMemberReference,
  isTransparentCssRuleWrapperExpression,
  unwrapTransparentCssRuleExpression
} from "./staticCssEval/candidates.js";
import {
  getDestructuredBindingSource,
  resolveStaticMemberPath
} from "./staticCssEval/partialEvaluator/destructuring.js";
import { hasStaticCssEvalBindingMutation } from "./staticCssEval/sameFile/mutation.js";
import { isSupportedStaticCssPrimitiveLiteral } from "./staticCssEval/sameFile/primitives.js";
import { everyPatternExpression } from "./jsxCssProp/patternExpressions.js";
import {
  planEvaluation,
  proveEvaluationOrder
} from "./extractionCalls/evaluation.js";
import { isAbsolute } from "node:path";
import { isClosedCompiledRecipeAllocation } from "./optimizations/recipeFactories.js";
import {
  getModuleReference,
  hasLocalValueMutation,
  staticMemberName,
  type ModuleReference
} from "./commonjs/bindings.js";
import {
  commonJsExports,
  commonJsDataPublications,
  findNodePath,
  normalizeTypeScriptCommonJs
} from "./commonjs/modules.js";
import { inspectEmittedCommonJs } from "./commonjs/emitted.js";
import { hasDynamicScope } from "./optimizations/dynamicScope.js";
import { hasObservablePrototypeMutation } from "./optimizations/recipeMetadata.js";

export type ModuleGraphRequest =
  | {
      kind: "resolve";
      importer: string;
      source: string;
      mode?: "import" | "require";
      purpose?: "consumer-runtime";
    }
  | {
      kind: "load";
      id: string;
      purpose?: "consumer-runtime";
      /** An opaque host identity is meaningful only with a runtime receipt. */
      runtimeOnly?: true;
    }
  | { kind: "token-reference"; id: string; name?: string; value?: string };

/** Actual host-transformed bytes, never an inference from a filename. */
export interface RuntimeModuleSource {
  readonly source: string;
  readonly sourceHash: string;
  readonly watchFiles: readonly string[];
  readonly version: string;
}

export type ModuleGraphResponse =
  | string
  | null
  | RuntimeModuleSource
  | { readonly kind: "unavailable-runtime" }
  | { readonly kind: "conflicting-resolution"; readonly id: string };

export type ModuleGraphFlow<T> = Generator<
  ModuleGraphRequest,
  T,
  ModuleGraphResponse
>;

export interface SourceModule {
  readonly id: string;
  readonly program: NodePath<t.Program>;
  readonly runtimeSource?: RuntimeModuleSource;
}

export type ModuleTarget =
  | {
      module: SourceModule;
      path: NodePath<t.Node>;
      /** Forwarding modules execute before consumers observe this value. */
      initializationPath?: readonly SourceModule[];
    }
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
  cache?: SourceAstCache,
  parserPlugins: NonNullable<TransformOptions["parserOpts"]>["plugins"] = []
): NodePath<t.Program> {
  const typescript = /\.[cm]?tsx?$/.test(id);
  const plugins = parserPlugins.filter((entry) => {
    const name = typeof entry === "string" ? entry : entry[0];

    if (typescript && (name === "flow" || name === "flowComments"))
      return false;

    return jsx || !/\.[cm]?ts$/.test(id) || name !== "jsx";
  });
  const pluginNames = new Set(
    plugins.map((entry) => (typeof entry === "string" ? entry : entry[0]))
  );

  for (const plugin of ["jsx", "typescript"] as const) {
    if (plugin === "jsx" && !jsx) continue;
    if (plugin === "typescript" && pluginNames.has("flow")) continue;
    if (!pluginNames.has(plugin)) {
      plugins.push(plugin);
      pluginNames.add(plugin);
    }
  }

  const ast = cache
    ? cache.parse({
        resolvedFile: id,
        source,
        parserOptions: {
          plugins,
          sourceType: "unambiguous",
          jsx,
          typescript: pluginNames.has("typescript")
        }
      })
    : parseSync(source, {
        filename: id,
        configFile: false,
        babelrc: false,
        parserOpts: {
          sourceType: "unambiguous",
          plugins
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
    readonly loadPurpose?: "consumer-runtime";
    readonly onResolveBinding?: (
      module: SourceModule,
      binding: Binding
    ) => void;
  } = {}
) {
  const dependencies = new Set<string>();
  const modules = new Map<string, SourceModule>();
  const resolutions = new Map<string, string | null>();
  const conflictingIds = new Set<string>();
  const unownedRuntimeIds = new Set<string>();
  const ownedRuntimeIds = new Set<string>();
  const exportDemands = new Map<string, Set<string | null>>();
  const isExternal = options.isExternal ?? isExternalModule;
  const parseProgram = options.parse ?? parseModuleProgram;

  const commonJsShapes = new WeakMap<
    t.Program,
    ReturnType<typeof commonJsExports>
  >();
  const emittedShapes = new WeakMap<
    t.Program,
    ReturnType<typeof inspectEmittedCommonJs>
  >();
  const dataPublications = new WeakMap<t.Program, ReadonlySet<t.Node>>();
  let observablePrototypeMutation = false;

  function publishedData(module: SourceModule): ReadonlySet<t.Node> {
    if (!module.runtimeSource) return new Set();
    let values = dataPublications.get(module.program.node);
    if (!values) {
      values = commonJsDataPublications(module.program);
      dataPublications.set(module.program.node, values);
    }
    return values;
  }

  function emittedShape(module: Module) {
    if (!module.runtimeSource) return;
    // Like other intrinsic-sensitive reductions, recovery is withdrawn when
    // prototype mutation is observable in the loaded graph. Do not load new
    // runtime modules merely to certify a publication: that would change the
    // host preparation order and turn normal dependency effects into blockers.
    if (observablePrototypeMutation) return;
    if (!emittedShapes.has(module.program.node))
      emittedShapes.set(
        module.program.node,
        inspectEmittedCommonJs(module.program, module.id)
      );
    return emittedShapes.get(module.program.node);
  }

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

    if (!resolutions.has(key)) {
      const resolved = yield {
        kind: "resolve",
        importer,
        source,
        mode,
        ...(options.loadPurpose ? { purpose: options.loadPurpose } : {})
      };
      if (
        resolved &&
        typeof resolved !== "string" &&
        "kind" in resolved &&
        resolved.kind === "conflicting-resolution"
      ) {
        conflictingIds.add(resolved.id);
        modules.delete(resolved.id);
        throw new Error(`Conflicting host module variants for ${resolved.id}`);
      }
      resolutions.set(key, typeof resolved === "string" ? resolved : null);
    }

    return resolutions.get(key) ?? null;
  }

  function* load(id: string, runtimeOnly = false): Flow<Module> {
    if (conflictingIds.has(id))
      throw new Error(`Conflicting host module variants for ${id}`);
    const existing = modules.get(id);
    if (existing) return existing;

    // Authoring graphs expose resolved module ids, including host-defined ids.
    // Runtime observations instead watch physical sources supplied by the host.
    if (!options.loadPurpose || (isAbsolute(id) && !id.includes("\0")))
      dependencies.add(id);

    if (modules.size >= 512)
      throw new Error("extractCalls module graph exceeds 512 modules");

    const loaded = yield {
      kind: "load",
      id,
      ...(options.loadPurpose ? { purpose: options.loadPurpose } : {}),
      ...(runtimeOnly ? { runtimeOnly: true as const } : {})
    };
    if (
      options.loadPurpose &&
      loaded !== null &&
      typeof loaded !== "string" &&
      (!("kind" in loaded) || loaded.kind === "unavailable-runtime")
    )
      ownedRuntimeIds.add(id);
    if (
      loaded === null ||
      (typeof loaded !== "string" && "kind" in loaded) ||
      (runtimeOnly && typeof loaded === "string")
    )
      throw new Error(`Cannot load ${id}`);
    const runtimeSource = typeof loaded === "string" ? undefined : loaded;
    const source = typeof loaded === "string" ? loaded : loaded.source;
    if (runtimeSource) {
      if (
        options.loadPurpose !== "consumer-runtime" ||
        !runtimeSource.version ||
        createHash("sha256").update(source).digest("hex") !==
          runtimeSource.sourceHash
      )
        throw new Error(`Invalid runtime source receipt for ${id}`);
      for (const dependency of runtimeSource.watchFiles)
        dependencies.add(dependency);
    }

    const record = {
      id,
      program: parseProgram(id, source),
      ...(runtimeSource ? { runtimeSource } : {})
    };
    modules.set(id, record);
    observablePrototypeMutation ||= hasObservablePrototypeMutation(
      record.program
    );

    return record;
  }

  function* loadDependency(id: string): Flow<Module | null> {
    const external = isExternal(id);
    if (external && !options.loadPurpose) return null;
    if (options.loadPurpose && unownedRuntimeIds.has(id)) return null;

    // Host ids are opaque: a virtual module is not a filesystem path. Only
    // the host's positive receipt admits it to the consumer graph.
    try {
      return yield* load(id, external);
    } catch (error) {
      if (!options.loadPurpose) throw error;
      unownedRuntimeIds.add(id);
      return null;
    }
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

    const imported = yield* loadDependency(id);
    if (!imported) return { external: true, source, name, mode };

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

    if (path.isVariableDeclarator() && !t.isIdentifier(path.node.id)) {
      // A destructured binding denotes its selected value. A rest binding is
      // a fresh allocation; its root identity and its contents are distinct.
      const source = getDestructuredBindingSource(
        binding,
        binding.identifier.name
      );
      const init = path.get("init");
      if (!source) {
        const identifier = findNodePath(module.program, binding.identifier);
        const rest = identifier?.parentPath;
        if (rest?.isRestElement()) return { module, path: rest };
      }
      if (!source || !init.isExpression()) return null;

      const reference = getStaticCssEvalMemberReference(source.init);
      const owner = reference && path.scope.getBinding(reference.bindingName);
      if (owner && hasStaticCssEvalBindingMutation(module.program, owner))
        return null;

      const target = yield* valueTarget(module, init, seen);
      if (!target || "external" in target || !target.path.isExpression())
        return null;
      if (
        !(yield* initializationPathIsInert(
          target.initializationPath,
          target.module
        ))
      )
        return null;

      const declaration = target.path.findParent((path) =>
        path.isVariableDeclarator()
      );
      if (
        declaration?.isVariableDeclarator() &&
        t.isIdentifier(declaration.node.id)
      ) {
        const resolvedOwner = declaration.scope.getBinding(
          declaration.node.id.name
        );
        if (
          resolvedOwner &&
          hasStaticCssEvalBindingMutation(target.module.program, resolvedOwner)
        )
          return null;
      }

      let selected: t.Expression | null = target.path.node;

      for (const member of source.memberPath) {
        if (!selected) return null;
        // Unlike reduced arrays, source arrays still contain spreads whose
        // expanded length can shift this and all subsequent element indices.
        if (
          t.isArrayExpression(selected) &&
          selected.elements
            .slice(0, Number(member) + 1)
            .some((element) => t.isSpreadElement(element))
        )
          return null;

        selected = resolveStaticMemberPath(selected, [member]);
      }

      const selectedPath =
        selected && findNodePath(target.module.program, selected);
      return selectedPath
        ? withInitializationPath(
            yield* valueTarget(target.module, selectedPath, seen),
            target.initializationPath ?? []
          )
        : null;
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

    if (path.isIdentifier() || path.isJSXIdentifier()) {
      const key = `${module.id}:binding:${path.node.name}`;
      if (seen.has(key)) return null;

      const binding = path.scope.getBinding(path.node.name);

      return binding
        ? yield* bindingTarget(module, binding, new Set([...seen, key]))
        : null;
    }

    return { module, path };
  }

  function withInitializationPath(
    target: Target | null,
    modules: readonly SourceModule[]
  ): Target | null {
    if (!target || "external" in target) return target;
    const path = new Set(target.initializationPath);
    for (const module of modules)
      if (module.id !== target.module.id) path.add(module);
    return path.size ? { ...target, initializationPath: [...path] } : target;
  }

  function* resolveExport(
    module: Module,
    name: string | null,
    seen: Set<string>
  ): Flow<Target | null> {
    return withInitializationPath(
      yield* resolveExportValue(module, name, seen),
      [module]
    );
  }

  function* resolveExportValue(
    module: Module,
    name: string | null,
    seen: Set<string>
  ): Flow<Target | null> {
    const key = `${module.id}:export:${name}`;
    const demanded = exportDemands.get(module.id) ?? new Set<string | null>();
    demanded.add(name);
    exportDemands.set(module.id, demanded);

    if (seen.has(key)) return null;

    // Share the resolve set across star branches, as in ResolveExport. A
    // diamond must not revisit the same module/export pair for every path.
    const next = seen.add(key);
    const stars: string[] = [];
    const emitted =
      name === null ? undefined : emittedShape(module)?.exports.get(name);
    if (emitted?.kind === "expression") {
      const value = findNodePath(module.program, emitted.expression);
      return value ? yield* valueTarget(module, value, next) : null;
    }

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
          specifier.isExportNamespaceSpecifier() &&
          exportedName(specifier.node.exported) === name &&
          statement.node.source
        ) {
          const id = yield* resolveImport(
            module.id,
            statement.node.source.value
          );
          if (!id) return null;
          const namespace = yield* loadDependency(id);
          if (!namespace) return null;
          return { module: namespace, path: namespace.program };
        }

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

      found = withInitializationPath(
        candidate,
        found && !("external" in found) ? (found.initializationPath ?? []) : []
      );
    }

    return found;
  }

  function* exportedNames(
    module: Module,
    seen: Set<string>
  ): Flow<Set<string | null>> {
    if (seen.has(module.id)) return new Set();

    // Names are a union across the whole traversal, including shared barrels.
    const next = seen.add(module.id);
    const names = new Set<string | null>();
    const stars: { source: string; mode: "import" | "require" }[] = [];

    for (const statement of module.program.get("body")) {
      if (statement.isExportDefaultDeclaration()) names.add("default");
      else if (statement.isExportAllDeclaration()) {
        if (statement.node.exportKind !== "type")
          stars.push({ source: statement.node.source.value, mode: "import" });
      } else if (
        statement.isExportNamedDeclaration() &&
        statement.node.exportKind !== "type"
      ) {
        if (statement.node.declaration)
          for (const name of Object.keys(
            t.getOuterBindingIdentifiers(statement.node.declaration)
          ))
            names.add(name);

        for (const specifier of statement.node.specifiers)
          if (
            t.isExportNamespaceSpecifier(specifier) ||
            (t.isExportSpecifier(specifier) && specifier.exportKind !== "type")
          )
            names.add(exportedName(specifier.exported));
      }
    }

    const commonjs = commonJsShape(module);
    for (const name of commonjs.exports.keys()) names.add(name);
    for (const star of commonjs.stars)
      stars.push({ source: star.source, mode: "require" });

    for (const { source, mode } of stars) {
      const id = yield* resolveImport(module.id, source, mode);
      if (!id) continue;
      const imported = yield* loadDependency(id);
      if (!imported) continue;

      for (const name of yield* exportedNames(imported, next))
        if (name !== "default" && name !== null) names.add(name);
    }

    return names;
  }

  type ResolvedObject = {
    module: Module;
    initializationPath?: readonly SourceModule[];
    path: NodePath<
      | t.ObjectExpression
      | t.ArrayExpression
      | t.Function
      | t.Class
      | t.CallExpression
      | t.RegExpLiteral
      | t.RestElement
    >;
  };

  type ObjectResolution =
    | { kind: "object"; object: ResolvedObject }
    | { kind: "independent" }
    | { kind: "unknown" };

  const independentObject = { kind: "independent" } as const;
  const unknownObject = { kind: "unknown" } as const;
  const runtimeAllocations = new WeakMap<t.CallExpression, boolean>();

  function* closedRuntimeAllocation(
    module: SourceModule,
    path: NodePath<t.Node>
  ): Flow<boolean> {
    if (!module.runtimeSource || !path.isCallExpression()) return false;
    const cached = runtimeAllocations.get(path.node);
    if (cached !== undefined) return cached;
    runtimeAllocations.set(path.node, false);
    const reference = getModuleReference(path.get("callee"));
    if (!reference || reference.unsafe) return false;
    const id = yield* resolveImport(
      module.id,
      reference.source,
      reference.kind
    );
    const result = isClosedCompiledRecipeAllocation(path.node, reference, id);
    runtimeAllocations.set(path.node, result);
    return result;
  }

  function* closedRuntimeResult(
    module: SourceModule,
    path: NodePath<t.Node>
  ): Flow<boolean> {
    if (
      !path.isCallExpression() ||
      path.node.optional ||
      path.node.arguments.length !== 0
    )
      return false;
    const callee = yield* valueTarget(module, path.get("callee"), new Set());
    return Boolean(
      callee &&
      !("external" in callee) &&
      (yield* closedRuntimeAllocation(callee.module, callee.path))
    );
  }

  function* objectTarget(
    target: Target | null,
    seen = new Set<t.Node>(),
    properties: typeof objectProperties = objectProperties
  ): Flow<ObjectResolution> {
    if (!target || "external" in target || seen.has(target.path.node))
      return unknownObject;
    if (
      target.path.isObjectExpression() ||
      target.path.isArrayExpression() ||
      target.path.isFunction() ||
      target.path.isClass() ||
      target.path.isRegExpLiteral() ||
      target.path.isRestElement()
    )
      return {
        kind: "object",
        object: {
          module: target.module,
          path: target.path,
          initializationPath: target.initializationPath
        }
      };

    if (yield* closedRuntimeAllocation(target.module, target.path))
      return {
        kind: "object",
        object: {
          module: target.module,
          initializationPath: target.initializationPath,
          path: target.path as NodePath<t.CallExpression>
        }
      };

    if (yield* closedRuntimeResult(target.module, target.path))
      return independentObject;

    // These values cannot be an existing receiver object. This proves only
    // identity independence; execution effects are checked by call analysis.
    if (
      target.path.isLiteral() ||
      target.path.isUnaryExpression() ||
      target.path.isBinaryExpression()
    )
      return independentObject;

    // Unsupported expressions can produce or contain an imported receiver.
    // Unknown is an explicit result, never evidence of independence.
    if (!target.path.isMemberExpression()) return unknownObject;
    if (
      !(yield* initializationPathIsInert(
        target.initializationPath,
        target.module
      ))
    )
      return unknownObject;
    if (
      properties === objectProperties &&
      !(yield* moduleInitializationIsInert(target.module))
    )
      return unknownObject;

    const name = staticMemberName(target.path.node);
    if (name === null) return unknownObject;

    const next = new Set(seen).add(target.path.node);
    const object = yield* valueTarget(
      target.module,
      target.path.get("object"),
      new Set()
    );
    return yield* objectMemberTarget(object, name, next, properties);
  }

  type ObjectProperties = Map<string, Target | null>;
  const objectPropertyCache = new WeakMap<
    t.ObjectExpression | t.RestElement,
    ObjectProperties | null
  >();
  const producerMutationCache = new WeakMap<Binding, boolean>();

  function publishedExpression(
    module: SourceModule,
    statement: NodePath<t.Node>
  ): NodePath<t.Expression> | undefined {
    if (!statement.isExpressionStatement()) return;
    const assignment = statement.get("expression");
    if (!assignment.isAssignmentExpression({ operator: "=" })) return;
    const value = assignment.get("right");
    if (
      emittedShape(module)?.publications.has(statement.node) ||
      [...commonJsShape(module).exports.values()].some(
        (entry) =>
          entry.kind === "expression" &&
          entry.declaration === statement.node &&
          entry.expression === value.node
      )
    )
      return value;
  }

  function allocationReference(
    object: ResolvedObject
  ): { binding?: Binding; root: ResolvedObject } | undefined {
    if (object.path.isRestElement()) {
      const argument = object.path.get("argument");
      const binding =
        argument.isIdentifier() &&
        argument.scope.getBinding(argument.node.name);
      return binding ? { binding, root: object } : undefined;
    }
    let value: NodePath<t.Node> = object.path;
    const members: string[] = [];
    while (value.parentPath) {
      const parent = value.parentPath;
      if (
        parent.isExpression() &&
        isTransparentCssRuleWrapperExpression(parent.node)
      ) {
        value = parent;
        continue;
      }
      if (
        parent.isObjectProperty() &&
        parent.node.value === value.node &&
        parent.parentPath.isObjectExpression()
      ) {
        const name = staticMemberName(parent.node);
        if (name === null) return;
        members.unshift(name);
        value = parent.parentPath;
        continue;
      }
      if (parent.isArrayExpression() && typeof value.key === "number") {
        if (parent.node.elements.some((element) => t.isSpreadElement(element)))
          return;
        members.unshift(String(value.key));
        value = parent;
        continue;
      }
      if (
        parent.isExportDefaultDeclaration() ||
        (parent.isSpreadElement() && parent.parentPath.isObjectExpression()) ||
        (parent.isAssignmentExpression() &&
          parent.parentPath?.isExpressionStatement() &&
          publishedExpression(object.module, parent.parentPath)?.node ===
            value.node)
      ) {
        let root = value;
        while (
          root.isExpression() &&
          isTransparentCssRuleWrapperExpression(root.node)
        )
          root = root.get("expression") as NodePath<t.Node>;
        if (root.isObjectExpression() || root.isArrayExpression())
          return { root: { module: object.module, path: root } };
        return;
      }
      if (!parent.isVariableDeclarator() || parent.node.init !== value.node)
        return;

      for (const name of Object.keys(
        t.getOuterBindingIdentifiers(parent.node.id)
      )) {
        const binding = parent.scope.getBinding(name);
        if (!binding) continue;
        if (t.isIdentifier(parent.node.id)) {
          let root = value;
          while (
            root.isExpression() &&
            isTransparentCssRuleWrapperExpression(root.node)
          )
            root = root.get("expression") as NodePath<t.Node>;
          if (root.isObjectExpression() || root.isArrayExpression())
            return { binding, root: { module: object.module, path: root } };
          return;
        }
        const source = getDestructuredBindingSource(binding, name);
        if (
          !source ||
          !source.memberPath.every((member, index) => members[index] === member)
        )
          continue;
        const node = resolveStaticMemberPath(
          unwrapTransparentCssRuleExpression(source.init),
          source.memberPath
        );
        const path =
          node &&
          findNodePath(
            object.module.program,
            unwrapTransparentCssRuleExpression(node)
          );
        if (path?.isObjectExpression() || path?.isArrayExpression())
          return { binding, root: { module: object.module, path } };
      }
      return;
    }
  }

  /** Candidate own data slots; this alone does not prove producer immutability. */
  function* staticObjectProperties(
    object: ResolvedObject,
    seen = new Set<t.Node>()
  ): Flow<ObjectProperties | null> {
    if (
      (!object.path.isObjectExpression() && !object.path.isRestElement()) ||
      seen.has(object.path.node)
    )
      return null;
    if (objectPropertyCache.has(object.path.node))
      return objectPropertyCache.get(object.path.node)!;

    const next = new Set(seen).add(object.path.node);
    const properties: ObjectProperties = new Map();
    objectPropertyCache.set(object.path.node, null);
    if (object.path.isRestElement()) {
      const pattern = object.path.parentPath;
      const declaration = pattern?.parentPath;
      if (
        !pattern?.isObjectPattern() ||
        !declaration?.isVariableDeclarator() ||
        declaration.node.id !== pattern.node
      )
        return null;
      const excluded = new Set<string>();
      for (const property of pattern.node.properties) {
        if (t.isRestElement(property)) continue;
        const name = staticMemberName(property);
        if (property.computed || name === null) return null;
        excluded.add(name);
      }
      const init = declaration.get("init");
      if (!init.isExpression()) return null;
      const source = yield* objectTarget(
        yield* valueTarget(object.module, init, new Set()),
        next,
        producerObjectProperties
      );
      if (source.kind !== "object") return null;
      const sourceProperties = yield* producerObjectProperties(
        source.object,
        next
      );
      if (!sourceProperties) return null;
      for (const [name, value] of sourceProperties)
        if (!excluded.has(name)) properties.set(name, value);
      objectPropertyCache.set(object.path.node, properties);
      return properties;
    }
    if (!object.path.isObjectExpression()) return null;
    for (const property of object.path.get("properties")) {
      if (property.isSpreadElement()) {
        const spread = yield* objectTarget(
          yield* valueTarget(
            object.module,
            property.get("argument"),
            new Set()
          ),
          next,
          producerObjectProperties
        );
        const values =
          spread.kind === "object"
            ? yield* producerObjectProperties(spread.object, next)
            : null;
        if (!values) return null;
        for (const [name, value] of values) properties.set(name, value);
        continue;
      }

      const node = property.node;
      if (!t.isObjectProperty(node) && !t.isObjectMethod(node)) return null;
      const name = t.isObjectProperty(node)
        ? staticMemberName(node)
        : !node.computed && t.isIdentifier(node.key)
          ? node.key.name
          : t.isStringLiteral(node.key)
            ? node.key.value
            : null;
      if (name === null) return null;
      if (
        name === "__proto__" &&
        t.isObjectProperty(node) &&
        !node.computed &&
        !node.shorthand
      )
        return null;
      properties.set(name, {
        module: object.module,
        path: property.isObjectProperty() ? property.get("value") : property
      });
    }
    // An accessor anywhere in this shape prevents using ordinary property-read
    // rules. An explicitly later data property may shadow an earlier accessor.
    if (
      [...properties.values()].some(
        (value) =>
          value &&
          !("external" in value) &&
          value.path.isObjectMethod() &&
          value.path.node.kind !== "method"
      )
    )
      return null;
    objectPropertyCache.set(object.path.node, properties);
    return properties;
  }

  /** Finite own-data chains relative to one complete enclosing allocation. */
  function* candidateOwnDataPaths(root: ResolvedObject): Flow<{
    ownDataPaths: Set<string>;
    closedDataPaths: Set<string>;
  } | null> {
    const paths = new Set<string>();
    const closed = new Set<string>();
    const expanded = new Set<t.Node>();
    function* collect(object: ResolvedObject, prefix: string[]): Flow<boolean> {
      if (expanded.has(object.path.node)) return false;
      expanded.add(object.path.node);
      let properties: ObjectProperties | null;
      if (object.path.isArrayExpression()) {
        if (
          object.path.node.elements.some((element) =>
            t.isSpreadElement(element)
          )
        )
          return false;
        const elements: ObjectProperties = new Map();
        for (const [index, element] of object.path.get("elements").entries())
          if (element.isExpression())
            elements.set(String(index), {
              module: object.module,
              path: element
            });
        elements.set("length", null);
        properties = elements;
      } else {
        const enclosed =
          object.path === root.path ||
          object.path.findParent((path) => path === root.path);
        properties = enclosed
          ? yield* staticObjectProperties(object)
          : yield* producerObjectProperties(object);
      }
      if (!properties) return false;
      closed.add(JSON.stringify(prefix));
      for (const [name, value] of properties) {
        const members = [...prefix, name];
        paths.add(JSON.stringify(members));
        if (!value || "external" in value) continue;
        const child = yield* objectTarget(
          yield* valueTarget(value.module, value.path, new Set()),
          new Set(),
          producerObjectProperties
        );
        if (child.kind === "object") yield* collect(child.object, members);
      }
      return true;
    }
    return (yield* collect(root, []))
      ? { ownDataPaths: paths, closedDataPaths: closed }
      : null;
  }

  function* producerObjectProperties(
    object: ResolvedObject,
    seen = new Set<t.Node>()
  ): Flow<ObjectProperties | null> {
    if (
      !(yield* initializationPathIsInert(
        object.initializationPath,
        object.module
      ))
    )
      return null;
    const properties = yield* staticObjectProperties(object, seen);
    if (
      !properties ||
      (!object.path.isObjectExpression() && !object.path.isRestElement())
    )
      return null;
    const reference = allocationReference(object);
    if (reference?.binding) {
      let mutated = producerMutationCache.get(reference.binding);
      if (mutated === undefined) {
        // Pending cycles are unknown; every nested allocation shares this one
        // immutable-producer proof instead of replaying temporal mutations.
        producerMutationCache.set(reference.binding, true);
        const certificate = yield* candidateOwnDataPaths(reference.root);
        mutated =
          !certificate ||
          hasLocalValueMutation(
            reference.binding,
            certificate.ownDataPaths,
            certificate.closedDataPaths
          );
        producerMutationCache.set(reference.binding, mutated);
      }
      if (mutated) return null;
    } else if (!reference || !(yield* candidateOwnDataPaths(reference.root)))
      return null;
    return properties;
  }

  const initializationProofs = new Map<string, boolean>();
  const initializationImports = new WeakMap<
    t.Program,
    readonly { source: string; mode: "import" | "require" }[]
  >();

  function* initializationPathIsInert(
    path: readonly SourceModule[] = [],
    producer?: SourceModule,
    seen = new Set<string>()
  ): Flow<boolean> {
    for (const module of path) {
      // Dependencies of the producer initialize before this allocation exists.
      // Forwarders and their sibling dependencies can observe it afterwards.
      if (module.id === producer?.id || seen.has(module.id)) continue;
      seen.add(module.id);
      if (!(yield* moduleInitializationIsInert(module))) return false;
      let imports = initializationImports.get(module.program.node);
      if (!imports) {
        const discovered = new Map<
          string,
          { source: string; mode: "import" | "require" }
        >();
        const add = (source: string, mode: "import" | "require") =>
          discovered.set(JSON.stringify([source, mode]), { source, mode });
        for (const statement of module.program.node.body) {
          if (
            t.isImportDeclaration(statement) &&
            statement.importKind !== "type" &&
            statement.importKind !== "typeof" &&
            (!statement.specifiers.length ||
              statement.specifiers.some(
                (specifier) =>
                  !t.isImportSpecifier(specifier) ||
                  (specifier.importKind !== "type" &&
                    specifier.importKind !== "typeof")
              ))
          )
            add(statement.source.value, "import");
          else if (
            (t.isExportNamedDeclaration(statement) ||
              t.isExportAllDeclaration(statement)) &&
            statement.source &&
            statement.exportKind !== "type"
          )
            add(statement.source.value, "import");
        }
        module.program.traverse({
          Function(path) {
            path.skip();
          },
          CallExpression(path) {
            const reference = getModuleReference(path);
            if (reference?.kind === "require") add(reference.source, "require");
          }
        });
        imports = [...discovered.values()];
        initializationImports.set(module.program.node, imports);
      }
      for (const { source, mode } of imports) {
        const id = yield* resolveImport(module.id, source, mode);
        if (!id) return false;
        if (id === producer?.id || seen.has(id)) continue;
        const dependency = yield* loadDependency(id);
        if (
          !dependency ||
          !(yield* initializationPathIsInert([dependency], producer, seen))
        )
          return false;
      }
    }
    return true;
  }

  function immutableInitializer(
    module: SourceModule,
    path: NodePath<t.Node>
  ): boolean {
    if (
      [...(emittedShape(module)?.exports.values() ?? [])].some(
        (entry) => entry.kind === "expression" && entry.expression === path.node
      )
    )
      return true;
    if (path.isFunctionDeclaration() && path.node.id)
      return (
        path.scope.getBinding(path.node.id.name)?.constant === true &&
        !hasDynamicScope(module.program)
      );
    let value = path;
    while (
      value.parentPath?.isExpression() &&
      isTransparentCssRuleWrapperExpression(value.parentPath.node)
    )
      value = value.parentPath;
    const declaration = value.parentPath;
    if (
      !declaration?.isVariableDeclarator() ||
      declaration.node.init !== value.node ||
      !t.isIdentifier(declaration.node.id) ||
      !declaration.parentPath.isVariableDeclaration({ kind: "const" })
    )
      return false;
    return (
      declaration.scope.getBinding(declaration.node.id.name)?.constant === true
    );
  }

  function closedInvocation(path: NodePath<t.Node>): boolean {
    if (path.isClass())
      return (
        !path.node.superClass &&
        !path.node.decorators?.length &&
        path.node.body.body.length === 0
      );
    if (
      !path.isFunction() ||
      path.node.async ||
      path.node.generator ||
      !path.node.params.every((parameter) => t.isIdentifier(parameter))
    )
      return false;
    const internal = (reference: NodePath<t.Identifier>) => {
      const binding = reference.scope.getBinding(reference.node.name);
      return Boolean(
        binding &&
        binding.path !== path &&
        binding.path.findParent((parent) => parent === path)
      );
    };
    // Deferred captures and invocation effects are distinct from allocation.
    // Parameters are plain identifiers: defaults/destructuring can execute
    // before the body and need stronger invocation evidence.
    if (
      planEvaluation(path).captures.some(
        (capture) => !capture.isIdentifier() || !internal(capture)
      )
    )
      return false;
    return (
      proveEvaluationOrder(path.get("body"), {
        replay: () => "unknown",
        binding: (reference) => (internal(reference) ? "proven" : "unknown")
      }) === "proven"
    );
  }

  function* moduleInitializationIsInert(module: SourceModule): Flow<boolean> {
    const cached = initializationProofs.get(module.id);
    if (cached !== undefined) return cached;
    initializationProofs.set(module.id, false);
    const initialized = new Set<Binding>();
    const readProperties: typeof objectProperties = (object, seen) =>
      object.module.id === module.id
        ? producerObjectProperties(object, seen)
        : objectProperties(object, seen);

    function* readMembers(
      base: NodePath<t.Node>,
      members: readonly string[]
    ): Flow<boolean> {
      let target = yield* valueTarget(module, base, new Set());
      for (const name of members) {
        const selected = yield* objectTarget(target, new Set(), readProperties);
        if (selected.kind !== "object") return false;
        const properties = yield* readProperties(selected.object);
        if (!properties?.has(name)) return false;
        target = properties.get(name) ?? null;
      }
      return true;
    }

    function* expression(path: NodePath<t.Node>): Flow<boolean> {
      if (emittedShape(module)?.inertExpressions.has(path.node)) return true;
      const observations = new Set<t.Node>();
      const coercions = new Set<t.Node>();
      const runtimeCalls = new Set<t.Node>();
      const prepared = new Set<t.Node>();
      function* prepare(value: NodePath<t.Node>): Flow<void> {
        if (prepared.has(value.node)) return;
        prepared.add(value.node);
        const plan = planEvaluation(value);
        if (plan.kind === "unknown") return;
        if (plan.operation === "call") {
          if (
            (yield* closedRuntimeAllocation(module, value)) ||
            (yield* closedRuntimeResult(module, value))
          )
            runtimeCalls.add(value.node);
          return;
        }
        for (const step of plan.steps) {
          if (step.kind === "evaluate") {
            yield* prepare(step.operand.path);
          } else if (step.kind === "coerce") {
            const target = yield* valueTarget(module, step.path, new Set());
            if (
              target &&
              !("external" in target) &&
              target.path.isExpression() &&
              isSupportedStaticCssPrimitiveLiteral(
                unwrapTransparentCssRuleExpression(target.path.node)
              )
            )
              coercions.add(step.path.node);
          } else if (step.path.isMemberExpression()) {
            const name = staticMemberName(step.path.node);
            if (
              name !== null &&
              (yield* readMembers(step.path.get("object"), [name]))
            )
              observations.add(step.path.node);
          } else if (
            step.path.isSpreadElement() &&
            step.path.parentPath.isObjectExpression()
          ) {
            const target = yield* objectTarget(
              yield* valueTarget(module, step.path.get("argument"), new Set()),
              new Set(),
              readProperties
            );
            if (
              target.kind === "object" &&
              (yield* readProperties(target.object))
            )
              observations.add(step.path.node);
          }
        }
      }
      yield* prepare(path);
      return (
        proveEvaluationOrder(path, {
          replay: (value) =>
            runtimeCalls.has(value.node) ? "proven" : "unknown",
          binding: (reference) => {
            const binding = reference.scope.getBinding(reference.node.name);
            return binding
              ? initialized.has(binding) ||
                binding.kind === "module" ||
                binding.path.isFunctionDeclaration()
                ? "proven"
                : "unknown"
              : reference.node.name === "undefined"
                ? "proven"
                : "unknown";
          },
          observe: (observation) =>
            observations.has(observation.node) ? "proven" : "unknown",
          coerce: (value) => (coercions.has(value.node) ? "proven" : "unknown")
        }) === "proven"
      );
    }

    function* statement(path: NodePath<t.Node>): Flow<boolean> {
      if (
        path.isImportDeclaration() ||
        path.isExportAllDeclaration() ||
        path.isEmptyStatement() ||
        path.isTSTypeAliasDeclaration() ||
        path.isTSInterfaceDeclaration() ||
        path.isTSDeclareFunction()
      )
        return true;
      if (path.isExportNamedDeclaration()) {
        const declaration = path.get("declaration");
        return declaration.isDeclaration()
          ? yield* statement(declaration)
          : !declaration.node;
      }
      if (path.isExportDefaultDeclaration()) {
        const declaration = path.get("declaration");
        return declaration.isExpression()
          ? yield* expression(declaration)
          : yield* statement(declaration);
      }
      if (path.isFunctionDeclaration() || path.isClassDeclaration())
        return yield* expression(path);
      if (path.isExpressionStatement())
        return yield* expression(
          publishedExpression(module, path) ?? path.get("expression")
        );
      if (!path.isVariableDeclaration()) return false;
      if (path.node.declare) return true;
      for (const declaration of path.get("declarations")) {
        const init = declaration.get("init");
        const initializer = init.isExpression() ? init : undefined;
        if (initializer && !(yield* expression(initializer))) return false;
        const pattern = declaration.get("id");
        const expressions: NodePath<t.Expression>[] = [];
        if (
          !everyPatternExpression(pattern, (value) => {
            if (!value.node) return true;
            if (!value.isExpression()) return false;
            expressions.push(value);
            return true;
          })
        )
          return false;
        for (const value of expressions)
          if (!(yield* expression(value))) return false;
        const bindings = Object.keys(
          t.getOuterBindingIdentifiers(pattern.node)
        ).flatMap((name) => {
          const binding = declaration.scope.getBinding(name);
          return binding ? [binding] : [];
        });
        if (!pattern.isIdentifier()) {
          if (!initializer || !pattern.isObjectPattern()) return false;
          for (const binding of bindings) {
            const source = getDestructuredBindingSource(
              binding,
              binding.identifier.name
            );
            if (source) {
              if (!(yield* readMembers(initializer, source.memberPath)))
                return false;
            } else {
              const flatRest = pattern.node.properties.some(
                (property) =>
                  t.isRestElement(property) &&
                  t.isIdentifier(property.argument, {
                    name: binding.identifier.name
                  })
              );
              if (!flatRest) return false;
              const target = yield* objectTarget(
                yield* valueTarget(module, initializer, new Set()),
                new Set(),
                readProperties
              );
              if (
                target.kind !== "object" ||
                !(yield* readProperties(target.object))
              )
                return false;
            }
          }
        }
        for (const binding of bindings) initialized.add(binding);
      }
      return true;
    }

    function* importDeclaration(path: NodePath<t.Node>): Flow<boolean> {
      if (!path.isVariableDeclaration()) return false;
      for (const declaration of path.get("declarations")) {
        const init = declaration.get("init");
        if (!init.isCallExpression() && !init.isMemberExpression())
          return false;
        const reference = getModuleReference(init);
        if (
          !reference ||
          reference.unsafe ||
          reference.interop ||
          reference.kind !== "require" ||
          reference.members.length > 1 ||
          reference.members.includes(null)
        )
          return false;
        if (reference.members.length) {
          const id = yield* resolveImport(
            module.id,
            reference.source,
            "require"
          );
          if (!id) return false;
          const origins = yield* objectExportOrigins(id);
          const path = JSON.stringify(reference.members);
          if (
            !origins.readablePaths?.includes(path) &&
            !origins.ownDataPaths?.includes(path)
          )
            return false;
        }
        const pattern = declaration.get("id");
        if (!pattern.isIdentifier()) {
          if (!pattern.isObjectPattern()) return false;
          const names: string[] = [];
          for (const property of pattern.get("properties")) {
            if (
              !property.isObjectProperty() ||
              property.node.computed ||
              !t.isIdentifier(property.node.value)
            )
              return false;
            const name = staticMemberName(property.node);
            if (name === null) return false;
            names.push(name);
          }
          const id = yield* resolveImport(
            module.id,
            reference.source,
            "require"
          );
          if (!id) return false;
          const imported = yield* loadDependency(id);
          if (imported) {
            for (const name of names)
              if (!(yield* resolveExport(imported, name, new Set())))
                return false;
          }
        }
        for (const name of Object.keys(t.getBindingIdentifiers(pattern.node))) {
          const binding = pattern.scope.getBinding(name);
          if (binding) initialized.add(binding);
        }
      }
      return true;
    }

    let importsOnly = true;
    for (const path of module.program.get("body")) {
      if (path.isImportDeclaration() || path.isEmptyStatement()) continue;
      // Only leading static loads share ESM's pre-initialization boundary.
      // Later loads remain observable operations on already-created values.
      if (importsOnly && (yield* importDeclaration(path))) continue;
      importsOnly = false;
      if (!(yield* statement(path))) return false;
    }
    initializationProofs.set(module.id, true);
    return true;
  }

  function* objectProperties(
    object: ResolvedObject,
    seen = new Set<t.Node>()
  ): Flow<ObjectProperties | null> {
    const properties = yield* producerObjectProperties(object, seen);
    return properties && (yield* moduleInitializationIsInert(object.module))
      ? properties
      : null;
  }

  function* objectMemberTarget(
    target: Target | null,
    name: string,
    seen = new Set<t.Node>(),
    readProperties: typeof objectProperties = objectProperties
  ): Flow<ObjectResolution> {
    const result = yield* objectTarget(target, seen, readProperties);
    if (result.kind !== "object") return unknownObject;

    const properties = yield* readProperties(result.object, seen);
    if (!properties) return unknownObject;
    // A missing own slot can still resolve through the ambient prototype.
    if (!properties.has(name)) return unknownObject;

    const member = properties.get(name);
    if (!member || "external" in member) return unknownObject;
    if (member.path.isObjectMethod() && member.path.node.kind !== "method")
      return unknownObject;

    return yield* objectTarget(
      yield* valueTarget(member.module, member.path, new Set()),
      seen,
      readProperties
    );
  }

  /** Proven identities and explicit uncertainty; copies have their own origin. */
  function* objectExportOrigins(
    id: string,
    receiverPaths: readonly (readonly string[])[] = []
  ): Flow<{
    exports: Record<string, string>;
    esModule: boolean;
    unknownExports?: string[];
    unknownContents?: string[];
    inertInvocations?: Record<string, "call" | "construct">;
    ownDataPaths?: string[];
    readablePaths?: string[];
    closedDataPaths?: string[];
  }> {
    const origins: Record<string, string> = Object.create(null);
    const unknownExports = new Set<string>();
    const unknownContents = new Set<string>();
    const inertInvocations: Record<string, "call" | "construct"> =
      Object.create(null);
    const ownDataPaths = new Set<string>();
    const readablePaths = new Set<string>();
    const closedDataPaths = new Set<string>();
    if (isExternal(id) && !options.loadPurpose)
      return { exports: origins, esModule: false };

    let module: Module;
    let names: Set<string | null>;
    try {
      const loaded = yield* loadDependency(id);
      if (!loaded)
        return {
          exports: origins,
          esModule: false,
          ...(options.loadPurpose &&
          (!isExternal(id) || ownedRuntimeIds.has(id))
            ? { unknownExports: ["[]"] }
            : {})
        };
      module = loaded;
      names = yield* exportedNames(module, new Set());
      // The emitter's closed private exports allocation publishes data slots.
      // Their values can remain opaque without making the slot reads getters.
      for (const name of emittedShape(module)?.exports.keys() ?? [])
        ownDataPaths.add(JSON.stringify([name]));
      for (const [name, entry] of commonJsShape(module).exports)
        if (
          name !== null &&
          entry.kind === "expression" &&
          publishedData(module).has(entry.expression) &&
          (yield* moduleInitializationIsInert(module))
        )
          ownDataPaths.add(JSON.stringify([name]));
      if (
        module.runtimeSource &&
        module.program.node.body.some((statement) =>
          t.isExportDeclaration(statement)
        )
      )
        for (const name of names)
          if (name !== null) readablePaths.add(JSON.stringify([name]));
    } catch {
      // Optional provenance does not reject unrelated imports, but a failed
      // analysis cannot establish that their exported values are independent.
      return { exports: origins, esModule: false, unknownExports: ["[]"] };
    }

    const paths = new Set(
      [...names].map((name) => JSON.stringify(name === null ? [] : [name]))
    );
    for (const receiver of receiverPaths)
      for (let length = 1; length <= receiver.length; length++)
        paths.add(JSON.stringify(receiver.slice(0, length)));

    function* recordObject(
      object: ResolvedObject,
      members: readonly string[],
      expanded: Set<t.Node>
    ): Flow<void> {
      const initializationKnown =
        (yield* initializationPathIsInert(
          object.initializationPath,
          object.module
        )) && (yield* moduleInitializationIsInert(object.module));
      if (
        !initializationKnown &&
        !immutableInitializer(object.module, object.path)
      ) {
        // Opaque initialization can rebind a mutable export through direct
        // eval; even the root identity is unproved in that case.
        unknownExports.add(JSON.stringify(members));
        return;
      }
      const node = object.path.node;
      if (typeof node.start !== "number" || typeof node.end !== "number") {
        unknownExports.add(JSON.stringify(members));
        return;
      }

      origins[JSON.stringify(members)] = JSON.stringify([
        object.module.id,
        node.start,
        node.end
      ]);
      if (!initializationKnown) {
        // A const slot fixes this allocation's identity, not its properties.
        unknownContents.add(JSON.stringify(members));
        return;
      }
      // Keep a representative path for each contained object when a wrapper
      // escapes. Explicitly consumed paths are resolved separately below.
      if (expanded.has(node)) return;
      expanded.add(node);

      const properties = yield* objectProperties(object);
      if (!properties) {
        // An unknown descriptor shape is not an unknown root identity. A
        // closed callable cannot reach a foreign receiver through its body;
        // its exact allocation origin still tracks aliases and mutations.
        // No own-data/closed-shape certificate follows from this proof.
        // A verified serializer allocation closes over private literal data.
        // This proves disjoint reachable identities, not ordinary descriptors
        // or purity of later calls with arbitrary user-supplied arguments.
        if (yield* closedRuntimeAllocation(object.module, object.path)) return;
        const encoded = JSON.stringify(members);
        unknownContents.add(encoded);
        if (closedInvocation(object.path))
          inertInvocations[encoded] = object.path.isClass()
            ? "construct"
            : "call";
        return;
      }
      closedDataPaths.add(JSON.stringify(members));

      for (const name of properties.keys()) {
        const childMembers = [...members, name];
        ownDataPaths.add(JSON.stringify(childMembers));
        try {
          const child = yield* objectMemberTarget(object, name);
          yield* recordResolution(child, childMembers, expanded);
        } catch {
          unknownExports.add(JSON.stringify(childMembers));
        }
      }
    }

    function* recordResolution(
      result: ObjectResolution,
      members: readonly string[],
      expanded = new Set<t.Node>()
    ): Flow<void> {
      if (result.kind === "unknown")
        unknownExports.add(JSON.stringify(members));
      else if (result.kind === "object")
        yield* recordObject(result.object, members, expanded);
    }

    function* recordTarget(
      target: Target | null,
      members: readonly string[],
      namespaces = new Set<string>()
    ): Flow<void> {
      if (!target || "external" in target) {
        unknownExports.add(JSON.stringify(members));
        return;
      }
      if (target.path.isProgram()) {
        // A namespace is not the receiver, but its exported values may be.
        // Expand descendant namespaces once per demanded prefix. Keep direct
        // object exports for sibling aliases; consumed paths resolve below.
        const expanded = namespaces.has(target.module.id);
        namespaces.add(target.module.id);
        for (const name of yield* exportedNames(target.module, new Set())) {
          if (name === null) continue;
          try {
            const exported = yield* resolveExport(
              target.module,
              name,
              new Set()
            );
            if (
              expanded &&
              exported &&
              !("external" in exported) &&
              exported.path.isProgram()
            )
              continue;
            yield* recordTarget(
              withInitializationPath(exported, target.initializationPath ?? []),
              [...members, name],
              namespaces
            );
          } catch {
            unknownExports.add(JSON.stringify([...members, name]));
          }
        }
        return;
      }

      // A namespace is resolved through its validated exports above. Check
      // initialization on the actual value producer, not its forwarding shell.
      if (
        !(yield* moduleInitializationIsInert(target.module)) &&
        !immutableInitializer(target.module, target.path)
      ) {
        unknownExports.add(JSON.stringify(members));
        return;
      }

      yield* recordResolution(yield* objectTarget(target), members);
    }

    for (const encoded of paths) {
      const members = JSON.parse(encoded) as string[];
      // A failed resolution supplies uncertainty, not proof of independence.
      let target: Target | null;
      try {
        target = yield* resolveExport(module, members[0] ?? null, new Set());
        let terminal: ObjectResolution | undefined;
        for (let index = 1; index < members.length; index++) {
          if (target && !("external" in target) && target.path.isProgram()) {
            target = withInitializationPath(
              yield* resolveExport(target.module, members[index], new Set()),
              target.initializationPath ?? []
            );
            continue;
          }

          const selected = yield* objectMemberTarget(target, members[index]);
          if (selected.kind === "object") target = selected.object;
          else {
            terminal = index === members.length - 1 ? selected : unknownObject;
            break;
          }
        }
        if (terminal) yield* recordResolution(terminal, members);
        else yield* recordTarget(target, members);
      } catch {
        unknownExports.add(encoded);
      }
    }

    const shape = commonJsShape(module);
    const marker = shape.exports.get("__esModule");
    return {
      exports: origins,
      esModule:
        (marker?.kind === "expression" &&
          t.isBooleanLiteral(marker.expression, { value: true })) ||
        (!shape.exports.has(null) &&
          module.program.node.body.some((statement) =>
            t.isExportDeclaration(statement)
          )),
      ...(unknownExports.size
        ? { unknownExports: [...unknownExports].sort() }
        : {}),
      ...(unknownContents.size
        ? { unknownContents: [...unknownContents].sort() }
        : {}),
      ...(Object.keys(inertInvocations).length ? { inertInvocations } : {}),
      ...(ownDataPaths.size ? { ownDataPaths: [...ownDataPaths].sort() } : {}),
      ...(readablePaths.size
        ? { readablePaths: [...readablePaths].sort() }
        : {}),
      ...(closedDataPaths.size
        ? { closedDataPaths: [...closedDataPaths].sort() }
        : {})
    };
  }

  return {
    modules,
    dependencies,
    resolutions,
    exportDemands,
    objectExportOrigins,
    load,
    resolveImport,
    importTarget,
    bindingTarget,
    valueTarget,
    resolveExport
  };
}

export type ModuleGraph = ReturnType<typeof createModuleGraph>;
