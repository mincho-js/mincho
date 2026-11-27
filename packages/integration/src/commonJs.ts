import {
  parseAsync,
  transformAsync,
  transformFromAstAsync,
  traverse,
  types as t,
  type NodePath,
  type PluginObj,
  type TransformOptions
} from "@babel/core";
import {
  internalInspectCommonJs,
  internalGetStaticCssEvalLiteralRequireImportPath,
  internalGetModuleReference,
  internalCommonJsToEsmPlugin,
  internalResolveExtractCallsFile,
  type MinchoBabelFileMetadata
} from "@mincho-js/babel";
import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import type { BabelOptions, StaticCssEvalSourceProvider } from "./babel.js";
import { cacheDigest, type CompilationCache } from "./compilationCache.js";

type Description = ReturnType<typeof internalInspectCommonJs>;

interface Module {
  id: string;
  commonJsRuntimeId?: string;
  opaqueExternal?: boolean;
  description: Description;
  source: string;
}

/** Infer the sidecar format on the live Program or its fresh analysis scope. */
export function applyInferredCommonJsSourceType(program: NodePath<t.Program>) {
  let commonjs = program.node.body.some(
    (statement) =>
      t.isTSImportEqualsDeclaration(statement) ||
      t.isTSExportAssignment(statement)
  );

  let esm = program.node.body.some(
    (statement) =>
      t.isImportDeclaration(statement) || t.isExportDeclaration(statement)
  );

  program.traverse({
    ReferencedIdentifier(path) {
      if (
        ["require", "module", "exports"].includes(path.node.name) &&
        !path.scope.getBinding(path.node.name)
      )
        commonjs = true;
    },

    MetaProperty(path) {
      if (path.node.meta.name === "import") esm = true;
    }
  });
  program.node.sourceType = commonjs && !esm ? "script" : "module";
}

export function inferCommonJsSourceType(): PluginObj {
  return {
    name: "mincho-infer-source-type",
    visitor: { Program: applyInferredCommonJsSourceType }
  };
}

type OptionalSite = NonNullable<
  MinchoBabelFileMetadata["minchoOptionalCommonJsSites"]
>[number];

function unchangedOptionalCommonJsSites(
  ast: t.File,
  sites: readonly OptionalSite[]
): OptionalSite[] {
  const candidates = new Map<t.VariableDeclarator, OptionalSite[]>();
  for (const site of sites) {
    const list = candidates.get(site.declaration) ?? [];
    list.push(site);
    candidates.set(site.declaration, list);
  }
  const eligible = new Map<
    t.VariableDeclarator | t.ObjectProperty,
    { site: OptionalSite; references: NodePath[] }
  >();
  traverse(ast, {
    Program(program) {
      // Author post hooks may edit a declaration in place or add a reader.
      // A stale object identity alone cannot authorize removing it.
      program.scope.crawl();
      for (const statement of program.get("body")) {
        if (!statement.isVariableDeclaration()) continue;
        for (const declaration of statement.get("declarations")) {
          for (const site of candidates.get(declaration.node) ?? []) {
            if (!t.isNodesEquivalent(declaration.node, site.stagedShape))
              continue;
            const id = declaration.node.id;
            if (
              site.property &&
              (!t.isObjectPattern(id) || !id.properties.includes(site.property))
            )
              continue;
            const bindings = Object.keys(
              t.getBindingIdentifiers(site.property?.value ?? id)
            ).map((name) => declaration.scope.getBinding(name));
            if (
              bindings.some(
                (binding) =>
                  binding?.path.node !== declaration.node || !binding.constant
              )
            )
              continue;

            if (site.requests.length === 0) {
              const initializer = declaration.get("init");
              const producer = initializer.isExpression()
                ? internalGetModuleReference(initializer)
                : null;
              if (
                producer?.kind !== "require" ||
                producer.unsafe ||
                producer.source !== site.source ||
                producer.members.length !== site.members.length ||
                producer.members.some(
                  (member, index) => member !== site.members[index]
                )
              )
                continue;
            }
            const requests = new Set(site.requests);
            if (requests.size > 0) {
              const observe = (call: NodePath<t.CallExpression>) => {
                if (
                  requests.has(call.node) &&
                  internalGetStaticCssEvalLiteralRequireImportPath(
                    call.node,
                    call.scope
                  ) === site.source
                )
                  requests.delete(call.node);
              };
              const init = declaration.get("init");
              if (init.isCallExpression()) observe(init);
              init.traverse({ CallExpression: observe });
            }
            if (requests.size === 0)
              eligible.set(site.property ?? declaration.node, {
                site,
                references: bindings.flatMap(
                  (binding) => binding?.referencePaths ?? []
                )
              });
          }
        }
      }
      program.stop();
    }
  });
  // A reader inside another removed alias does not keep its upstream binding.
  // Resolve from the leaves so a live reader protects the entire input chain.
  const dead = new Set<t.Node>();
  let changed: boolean;
  do {
    const before = dead.size;
    for (const [node, { references }] of eligible)
      if (
        !dead.has(node) &&
        references.every((ref) =>
          ref.findParent((parent) => dead.has(parent.node))
        )
      )
        dead.add(node);
    changed = dead.size !== before;
  } while (changed);
  const result = [...eligible].flatMap(([node, { site }]) =>
    dead.has(node) ? [site] : []
  );
  return result;
}

/** Match only unchanged authored sites in the one configured generator output. */
function reconcileEmittedCommonJsSites(
  authored: t.File,
  emitted: t.File,
  sites: readonly OptionalSite[]
): OptionalSite[] {
  const calls = (ast: t.File) => {
    const result: { node: t.CallExpression; location: string }[] = [];
    let unknown = false;
    traverse(ast, {
      ReferencedIdentifier(path) {
        if (
          path.isIdentifier({ name: "eval" }) &&
          !path.scope.getBinding("eval")
        )
          unknown = true;
        if (
          !path.isIdentifier({ name: "require" }) ||
          path.scope.getBinding("require")
        )
          return;
        const call = path.parentPath;
        if (
          !call.isCallExpression() ||
          call.node.callee !== path.node ||
          !internalGetStaticCssEvalLiteralRequireImportPath(
            call.node,
            call.scope
          )
        )
          unknown = true;
        else result.push({ node: call.node, location: call.getPathLocation() });
      },
      WithStatement() {
        unknown = true;
      }
    });
    return unknown ? undefined : result;
  };
  const before = calls(authored);
  const after = calls(emitted);
  if (
    !before ||
    !after ||
    before.length !== after.length ||
    before.some(
      ({ node, location }, index) =>
        location !== after[index]!.location ||
        !t.isNodesEquivalent(node, after[index]!.node)
    )
  )
    return [];
  const emittedRequests = new Map(
    before.map(({ node }, index) => [node, after[index]!.node])
  );
  const candidates: OptionalSite[] = [];
  for (const site of unchangedOptionalCommonJsSites(authored, sites)) {
    const position = authored.program.body.findIndex(
      (statement) =>
        t.isVariableDeclaration(statement) &&
        statement.declarations.includes(site.declaration)
    );
    const original = authored.program.body[position];
    const generated = emitted.program.body[position];
    if (
      !t.isVariableDeclaration(original) ||
      !t.isVariableDeclaration(generated) ||
      original.kind !== generated.kind
    )
      continue;
    const index = original.declarations.indexOf(site.declaration);
    const declaration = generated.declarations[index];
    const requests = site.requests.map((call) => emittedRequests.get(call));
    if (
      !declaration ||
      !t.isNodesEquivalent(declaration, site.stagedShape) ||
      requests.some((call) => !call)
    )
      continue;
    const propertyIndex =
      site.property && t.isObjectPattern(site.declaration.id)
        ? site.declaration.id.properties.indexOf(site.property)
        : -1;
    const property =
      propertyIndex >= 0 && t.isObjectPattern(declaration.id)
        ? declaration.id.properties[propertyIndex]
        : undefined;
    if (site.property && !t.isObjectProperty(property)) continue;
    candidates.push({
      ...site,
      declaration,
      ...(t.isObjectProperty(property) ? { property } : {}),
      requests: requests.filter((call): call is t.CallExpression => !!call),
      later: site.later.flatMap((entry) => {
        const node = emittedRequests.get(entry.node);
        return node ? [{ ...entry, node }] : [];
      })
    });
  }
  return candidates;
}

/** Prepare require-condition imports before the synchronous Babel ESM pass. */
export async function transformCommonJsToEsm(options: {
  filename: string;
  source: string;
  provider?: StaticCssEvalSourceProvider;
  dependencies: Set<string>;
  sidecar: string;
  sourceMaps: boolean;
  inputSourceMap?: TransformOptions["inputSourceMap"];
  parserPlugins?: NonNullable<TransformOptions["parserOpts"]>["plugins"];
  cache?: CompilationCache;
  collectRuntimeCandidates?: boolean;
  stagedSites?: {
    ast: t.File;
    originalSource: string;
    originalMap?: TransformOptions["inputSourceMap"];
    sites: NonNullable<MinchoBabelFileMetadata["minchoOptionalCommonJsSites"]>;
    runtimeSource?: BabelOptions["consumerRuntimeSource"];
    // The configured generator's one authoritative output can add readers.
    reconcileGeneratedCode?: boolean;
  };
}) {
  // Escaped identifiers still take the parser path. Ordinary ESM has no CJS
  // bindings to inspect, and already passed through the configured Babel parser.
  if (!/\b(?:require|module|exports)\b|\\/.test(options.source)) return null;
  const original = options.stagedSites;
  let staged = original;
  if (original?.reconcileGeneratedCode) {
    staged = undefined;
    let emitted: t.File | null;
    try {
      emitted = await parseAsync(options.source, {
        filename: options.filename,
        configFile: false,
        babelrc: false,
        sourceType: "unambiguous",
        parserOpts: { plugins: [...(options.parserPlugins ?? []), "jsx"] }
      });
    } catch {
      emitted = null;
    }
    if (emitted) {
      const sites = reconcileEmittedCommonJsSites(
        original.ast,
        emitted,
        original.sites
      );
      if (sites.length)
        staged = {
          ast: emitted,
          sites,
          originalSource: options.source,
          originalMap: options.inputSourceMap,
          runtimeSource: original.runtimeSource,
          reconcileGeneratedCode: true
        };
    }
  }

  async function inspect(
    source: string,
    filename: string,
    parserPlugins = options.parserPlugins
  ): Promise<Description> {
    if (!options.cache)
      return internalInspectCommonJs(source, filename, parserPlugins);

    const description = await options.cache.run(
      "commonjs:" +
        cacheDigest(JSON.stringify([filename, source, parserPlugins ?? []])),
      async () => {
        const value = internalInspectCommonJs(source, filename, parserPlugins);

        return {
          value,
          owner: filename,
          dependencies: [filename],
          bytes: Buffer.byteLength(JSON.stringify(value)),

          valid: async () => true
        };
      }
    );

    // Re-export discovery extends the descriptor for the current graph only.
    return structuredClone(description);
  }

  // The owner is stripped TypeScript and may retain configured JSX.
  const ownerParserPlugins = [...(options.parserPlugins ?? []), "jsx"] as const;
  const owner = {
    id: options.filename,
    source: options.source,
    description: staged?.reconcileGeneratedCode
      ? internalInspectCommonJs(
          options.source,
          options.filename,
          [...ownerParserPlugins],
          staged.ast
        )
      : await inspect(options.source, options.filename, [...ownerParserPlugins])
  };
  if (!owner.description.commonjs) return null;

  const modules = new Map<string, Module>([[owner.id, owner]]);
  const resolutions = new Map<string, Module | null>();

  async function resolveModule(
    importer: string,
    source: string,
    kind: "import" | "require" = "require"
  ): Promise<Module | null> {
    const key = `${importer}\0${source}\0${kind}`;
    if (resolutions.has(key)) return resolutions.get(key)!;

    // Generated sidecars are registered by the adapter after this transform.
    if (source === options.sidecar || source === `./${options.sidecar}`) {
      resolutions.set(key, null);

      return null;
    }

    const resolved = await options.provider?.resolve(importer, source, {
      kind
    });

    for (const file of resolved?.watchFiles ?? [])
      options.dependencies.add(file);

    const id =
      resolved?.id ??
      resolved?.resolvedFile ??
      resolved?.canonicalModuleId ??
      internalResolveExtractCallsFile(importer, source);

    const externalId =
      resolved?.canonicalModuleId ??
      resolved?.id ??
      resolved?.resolvedFile ??
      source;

    if (
      !id ||
      resolved?.sourceKind === "external-no-source" ||
      isBuiltin(externalId)
    ) {
      const commonJsRuntimeId =
        resolved?.commonJsRuntimeId ??
        (isBuiltin(externalId) ? externalId : undefined);

      if (commonJsRuntimeId) {
        const external = {
          id: id ?? externalId,
          commonJsRuntimeId,
          opaqueExternal: true,
          source: "",
          description: internalInspectCommonJs(
            "module.exports = {};",
            options.filename
          )
        };

        resolutions.set(key, external);

        return external;
      }

      if (resolved?.sourceKind === "external-no-source") {
        const external = {
          id: externalId,
          opaqueExternal: true,
          source: "",
          description: internalInspectCommonJs("export {};", options.filename)
        };

        resolutions.set(key, external);

        return external;
      }

      resolutions.set(key, null);

      return null;
    }

    options.dependencies.add(
      resolved?.realpath ?? resolved?.resolvedFile ?? id
    );

    const cached = modules.get(id);

    if (cached) {
      resolutions.set(key, cached);

      return cached;
    }

    // CSS sidecars are handled by the consuming bundler, including CSS Modules
    // and query variants. Preserve require-condition resolution without trying
    // to parse the stylesheet as JavaScript or probing it for CJS exports.
    if (
      /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)(?:[?#]|$)/.test(id)
    ) {
      const stylesheet = {
        id,
        source: "",
        description: internalInspectCommonJs("export {};", `${id}.js`)
      };

      modules.set(id, stylesheet);
      resolutions.set(key, stylesheet);

      return stylesheet;
    }

    if (modules.size >= 512)
      throw new Error("CommonJS module graph exceeds 512 modules");

    const loaded = options.provider
      ? await options.provider.load(resolved?.normalizedPathKey ?? id)
      : null;

    for (const file of loaded?.watchFiles ?? []) options.dependencies.add(file);

    let sourceText = loaded?.sourceText ?? loaded?.source;

    if (sourceText === undefined && !options.provider)
      sourceText = await readFile(id, "utf8");

    if (sourceText === undefined) {
      resolutions.set(key, null);

      return null;
    }

    // Configured parser plugins describe the owner. An explicitly typed
    // on-disk dependency chooses TypeScript independently of owner Flow.
    const syntaxPath = resolved?.realpath ?? resolved?.resolvedFile ?? id;
    const dependencyParserPlugins = /\.(?:[cm]?ts|tsx)$/i.test(syntaxPath)
      ? options.parserPlugins?.filter((plugin) => {
          const name = typeof plugin === "string" ? plugin : plugin[0];
          return name !== "flow" && name !== "flowComments";
        })
      : options.parserPlugins;
    const module = {
      id,
      commonJsRuntimeId: resolved?.commonJsRuntimeId,
      source: sourceText,
      description: await inspect(sourceText, id, dependencyParserPlugins)
    };

    modules.set(id, module);
    resolutions.set(key, module);

    return module;
  }

  if (staged) {
    const unchanged = unchangedOptionalCommonJsSites(staged.ast, staged.sites);
    const live = new WeakSet<t.Node>();
    t.traverseFast(staged.ast, (node) => {
      live.add(node);
    });
    const kept = new Set<t.VariableDeclarator>();
    // Only positively proved, eager host requests can retain the authored
    // site. Check live direct children in source order; a nonmatching first
    // child does not rule out a later request for the same runtime module.
    const runtimeSource = staged.runtimeSource;
    if (runtimeSource) {
      const eager = new Set(owner.description.topLevelRequires);
      const runtimeViews = new Map<
        string,
        Awaited<ReturnType<typeof runtimeSource>>
      >();
      for (const site of unchanged) {
        if (site.property || !live.has(site.declaration)) continue;
        const seen = new Set<string>();
        for (const later of site.later) {
          if (!live.has(later.node) || !eager.has(later.source)) continue;
          const child = await resolveModule(owner.id, later.source);
          if (
            !child ||
            child.opaqueExternal ||
            !child.description.commonjs ||
            child.commonJsRuntimeId ||
            seen.has(child.id)
          )
            continue;
          seen.add(child.id);
          const target = await resolveModule(owner.id, site.source);
          if (!target || target.opaqueExternal) break;
          const targetId = target.commonJsRuntimeId ?? target.id;
          const viewKey = JSON.stringify([child.id, targetId]);
          if (!runtimeViews.has(viewKey)) {
            const view = await runtimeSource(child.id, {
              purpose: "commonjs-runtime-order",
              targetId
            });
            runtimeViews.set(viewKey, view);
            for (const file of view?.watchFiles ?? [])
              options.dependencies.add(file);
          }
          const view = runtimeViews.get(viewKey);
          if (
            view?.source !== undefined &&
            view.eagerRuntimeModuleIds?.includes(targetId)
          ) {
            kept.add(site.declaration);
            break;
          }
        }
      }
    }
    // These matched sites are known to have no readers; needed module
    // initialization can keep only the load, as it did before staging names.
    for (const declaration of kept)
      if (t.isObjectPattern(declaration.id)) declaration.id.properties = [];
    const removed = new Set(
      unchanged
        .filter((site) => !site.property && !kept.has(site.declaration))
        .map((site) => site.declaration)
    );
    for (const site of unchanged)
      if (site.property && t.isObjectPattern(site.declaration.id))
        site.declaration.id.properties = site.declaration.id.properties.filter(
          (property) => property !== site.property
        );
    staged.ast.program.body = staged.ast.program.body.filter((statement) => {
      if (!t.isVariableDeclaration(statement)) return true;
      statement.declarations = statement.declarations.filter(
        (node) => !removed.has(node)
      );
      return statement.declarations.length > 0;
    });
    owner.description = internalInspectCommonJs(
      options.source,
      options.filename,
      [...(options.parserPlugins ?? []), "jsx"],
      staged.ast
    );
  }

  const exportNames = new Map<string, string[]>();

  async function names(
    module: Module,
    seen = new Set<string>()
  ): Promise<string[]> {
    if (module.opaqueExternal)
      throw new Error(`Cannot identify CommonJS re-exports from ${module.id}`);

    if (seen.has(module.id))
      throw new Error(`Unsupported cyclic CommonJS re-export: ${module.id}`);

    const cached = exportNames.get(module.id);
    if (cached) return cached;

    const found = new Set(module.description.exports);
    const next = new Set(seen).add(module.id);

    for (const [source, kind] of [
      ...module.description.stars.map((source) => [source, "require"] as const),
      ...module.description.esmStars.map(
        (source) => [source, "import"] as const
      )
    ]) {
      const dependency = await resolveModule(module.id, source, kind);
      if (!dependency)
        throw new Error(
          `Cannot identify CommonJS re-exports from ${source} in ${module.id}`
        );

      for (const name of await names(dependency, next)) {
        if (name === "default" || name === "__esModule" || found.has(name))
          continue;

        found.add(name);

        if (kind === "require")
          module.description.reexports.push({ name, source, imported: name });
      }
    }

    const result = [...found].sort();
    exportNames.set(module.id, result);

    return result;
  }

  const imports: Record<string, { id: string; commonjs: boolean }> =
    Object.create(null);

  for (const source of owner.description.requires) {
    const dependency = await resolveModule(owner.id, source);
    imports[source] = {
      id:
        (dependency?.description.exportsObject &&
          dependency.commonJsRuntimeId) ||
        dependency?.id ||
        source,
      commonjs: dependency
        ? dependency.description.exportsObject || /\.json$/.test(dependency.id)
        : false
    };
  }

  const transformOptions: TransformOptions = {
    filename: options.filename,
    babelrc: false,
    configFile: false,
    sourceType: "unambiguous",
    parserOpts: { plugins: [...(options.parserPlugins ?? []), "jsx"] },
    plugins: [
      internalCommonJsToEsmPlugin({
        description: owner.description,
        imports,
        exportNames: await names(owner)
      })
    ],
    sourceMaps: options.sourceMaps,
    ast: options.collectRuntimeCandidates,
    ...(options.inputSourceMap
      ? { inputSourceMap: options.inputSourceMap }
      : {})
  };
  const transformed = staged
    ? await transformFromAstAsync(staged.ast, staged.originalSource, {
        ...transformOptions,
        cloneInputAst: false,
        inputSourceMap: staged.originalMap
      })
    : await transformAsync(options.source, transformOptions);
  if (!transformed?.code)
    throw new Error(`Cannot normalize CommonJS module ${options.filename}`);

  return transformed;
}
