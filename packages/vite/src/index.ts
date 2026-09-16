import {
  type BabelOptions,
  type BabelTransformResult,
  type DefineRulesPackageGraph,
  type InternalStaticCssEvalLoadedSource as StaticCssEvalLoadedSource,
  type InternalStaticCssEvalMetadataLike as StaticCssEvalMetadata,
  type InternalStaticCssEvalSourceResolution as StaticCssEvalSourceResolution,
  babelTransformSource,
  internalCollectStaticCssEvalDependencyIds as collectStaticCssEvalDependencyIds,
  compile,
  internalGetScriptLoader as getScriptLoader,
  internalInspectCommonJs as inspectCommonJs,
  internalCreateStaticCssEvalSourceIdentity as createStaticCssEvalSourceIdentity,
  internalGetStaticCssEvalRealpathOrResolvedPath as getRealpathOrResolvedPath,
  internalMinchoProjectEngine,
  internalIsProjectLocalStaticCssEvalImportPath as isProjectLocalImportPath,
  internalIsVirtualStaticCssEvalId as isVirtualStaticCssEvalId,
  internalNormalizeStaticCssEvalFileId as normalizeStaticCssEvalFileId,
  processDefineRulesPresetRegistryFile,
  runDefineRulesPresetRegistryStep
} from "@mincho-js/integration";
import { normalizePath } from "@rollup/pluginutils";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin, ResolvedConfig, Rollup, ViteDevServer } from "vite";
import {
  ViteCssState,
  customNormalize,
  extractedSidecarIdPrefix,
  extractedSidecarModuleId
} from "./cssState.js";
import { createLibraryCssLinker } from "./libraryCssLinker.js";
import { createPackageGraphAnalysis } from "./packageGraphAnalysis.js";
import { createViteStaticCssEvalSourceProvider } from "./staticCssEvalSourceProvider.js";
import { commonJsRuntimePrefix, commonJsRuntimeRequest } from "./commonJs.js";

type PluginContext = Rollup.PluginContext;

type OutputPluginContext = Rollup.PluginContext;

interface LibraryCssSidecarContract {
  readonly ancestorStyleSpecifiers: readonly string[];
  readonly hasOwnCss: boolean;
  readonly packageGraph?: DefineRulesPackageGraph;
}

// Match both the old format and the new virtual format
function extractedCssFileFilter(filePath: string) {
  const extractedIndex = filePath.indexOf("extracted_");
  if (extractedIndex === -1) {
    return false;
  }

  const afterExtracted = filePath.substring(extractedIndex);
  if (afterExtracted.includes("/")) {
    return false;
  }

  if (
    !(
      afterExtracted.endsWith(".css.ts") ||
      afterExtracted.endsWith(".css.ts?used")
    )
  ) {
    return false;
  }

  return true;
}

export interface MinchoVitePluginOptions {
  babel?: BabelOptions;
  jsxCssProp?: boolean;

  /** Additional build-time calls; local files are relative to root. Overrides babel.extractCalls. */
  extractCalls?: BabelOptions["extractCalls"];
  libraryCss?: {
    /** Exact output-relative CSS filename when build.cssCodeSplit is false. */
    fileName?: string;

    /** Analyze package graphs in a reusable worker, or in the main thread. */
    analysis?: "worker" | "inline";
  };
}

export type { ExtractCalls } from "@mincho-js/integration";

export function minchoVitePlugin(_options?: MinchoVitePluginOptions) {
  const plugin = createMinchoViteEnvironmentPlugin(_options);
  const pendingServerPlugins = new Set<
    ReturnType<typeof createMinchoViteEnvironmentPlugin>
  >();

  let config: ResolvedConfig;
  let server: ViteDevServer | undefined;

  return {
    ...plugin,

    async configResolved(this: void, resolvedConfig: ResolvedConfig) {
      config = resolvedConfig;
      server = undefined;
      pendingServerPlugins.clear();
      await plugin.configResolved(resolvedConfig);
    },

    configureServer(this: void, serverInstance: ViteDevServer) {
      server = serverInstance;
      plugin.configureServer(serverInstance);

      for (const environmentPlugin of pendingServerPlugins) {
        environmentPlugin.configureServer(serverInstance);
      }

      pendingServerPlugins.clear();
    },

    async applyToEnvironment() {
      // Providers may resolve different CSS in client and SSR environments.
      // Extraction, dependency, and virtual CSS state belong to one environment.
      const environmentPlugin = createMinchoViteEnvironmentPlugin(_options);
      await environmentPlugin.configResolved(config);

      if (server) environmentPlugin.configureServer(server);
      else pendingServerPlugins.add(environmentPlugin);

      return environmentPlugin;
    }
  } satisfies Plugin;
}

function createMinchoViteEnvironmentPlugin(_options?: MinchoVitePluginOptions) {
  let config: ResolvedConfig;
  let server: ViteDevServer;
  const staticCssEvalOwnerStack = new AsyncLocalStorage<ReadonlySet<string>>();

  const cssState = new ViteCssState({
    invalidateModule: invalidateViteModule,
    deleteContract: deleteLibraryCssContract
  });

  const { resolverCache } = cssState;

  const staticCssEvalProjectEngine = new internalMinchoProjectEngine();
  const libraryCssSidecarContracts = new Map<
    string,
    LibraryCssSidecarContract
  >();

  let graphAnalysis = createPackageGraphAnalysis({
    mode: _options?.libraryCss?.analysis ?? "worker"
  });

  let graphGeneration = graphAnalysis.beginGeneration();
  let graphAnalysisClosed = false;
  let transformEpoch = Symbol("build");

  const outputLinkers = new Map<
    object,
    ReturnType<typeof createLibraryCssLinker>
  >();

  const validatedUnsplitCssByDirectory = new Map<string, Set<string>>();

  function ownedExtractedSidecarPath(id: string | undefined) {
    if (!id?.startsWith(extractedSidecarIdPrefix) || !id.endsWith(".js")) {
      return undefined;
    }

    const filePath = id.slice(extractedSidecarIdPrefix.length, -3);

    return cssState.hasSidecar(filePath) ? filePath : undefined;
  }

  function abortOutputLinkers(error: Error): void {
    for (const linker of outputLinkers.values()) linker.abort(error);

    outputLinkers.clear();
  }

  function setLibraryCssContract(
    id: string,
    contract: LibraryCssSidecarContract
  ): void {
    const previous = libraryCssSidecarContracts.get(id);
    libraryCssSidecarContracts.set(id, contract);

    if (contract.packageGraph) {
      graphAnalysis.register({
        generation: graphGeneration,
        moduleId: id,
        graph: contract.packageGraph
      });
    } else if (previous?.packageGraph) {
      graphAnalysis.remove({ generation: graphGeneration, moduleId: id });
    }
  }

  function deleteLibraryCssContract(id: string): void {
    const previous = libraryCssSidecarContracts.get(id);
    libraryCssSidecarContracts.delete(id);

    if (previous?.packageGraph) {
      graphAnalysis.remove({ generation: graphGeneration, moduleId: id });
    }
  }

  function libraryCssLinker(
    outputOptions: object
  ): ReturnType<typeof createLibraryCssLinker> {
    let linker = outputLinkers.get(outputOptions);

    if (!linker) {
      linker = createLibraryCssLinker({
        cssCodeSplit: config.build.cssCodeSplit === true,
        fileName: _options?.libraryCss?.fileName
      });
      outputLinkers.set(outputOptions, linker);
    }

    return linker;
  }

  const virtualExt = ".vanilla.css";
  const virtualCssImportPrefix = "mincho-virtual-css:";
  const virtualCssIdPrefix = "\0mincho-virtual-css:";
  let rootRealpath = "";

  function invalidateViteModule(id: string): void {
    if (!server) {
      return;
    }

    const module = server.moduleGraph.getModuleById(id);
    if (!module) {
      return;
    }

    server.moduleGraph.invalidateModule(module);
    module.lastHMRTimestamp = module.lastInvalidationTimestamp || Date.now();
  }

  function addStaticCssEvalWatchFilesForOwner(
    pluginContext: PluginContext,
    ownerId: string
  ): void {
    const fileResult = staticCssEvalProjectEngine.getFileResult(ownerId);
    const dependencies = new Set(
      fileResult
        ? fileResult.dependencyFiles
            .map((dependency) =>
              normalizeStaticCssEvalFileId(dependency, rootRealpath)
            )
            .filter(
              (dependency) =>
                dependency !== ownerId &&
                isWatchableStaticCssEvalDependency(dependency)
            )
        : []
    );

    for (const dependency of dependencies) {
      pluginContext.addWatchFile(dependency);
    }
  }

  function refreshStaticCssEvalProjectEngineFromAdapterResult(
    ownerId: string,
    staticCssEval: StaticCssEvalMetadata | undefined
  ): void {
    const fileResult = staticCssEvalProjectEngine.getFileResult(ownerId);

    if (staticCssEval && !fileResult) {
      staticCssEvalProjectEngine.refreshFile({
        fileId: ownerId,
        result: {
          dependencyFiles: collectStaticCssEvalDependencyIds(staticCssEval)
        }
      });
    } else if (!staticCssEval && fileResult) {
      staticCssEvalProjectEngine.refreshFile({ fileId: ownerId });
    }
  }

  const observedProviderSources = new Map<string, string>();
  const observedTransformInputs = new Map<string, string>();

  function observeStaticCssEvalSource(
    id: string,
    source: string,
    transformInput = false
  ): void {
    const fileId = normalizeStaticCssEvalFileId(id, rootRealpath);
    const sourceObservations = transformInput
      ? observedTransformInputs
      : observedProviderSources;
    const previousSource = sourceObservations.get(fileId);

    // Virtual loads return transformed code; their transform input owns tracking.
    if (
      !transformInput &&
      observedTransformInputs.has(fileId) &&
      isVirtualStaticCssEvalId(fileId)
    )
      return;

    if (previousSource === source) return;

    if (
      previousSource !== undefined &&
      (config.command === "serve" || config.build.watch)
    )
      invalidateStaticCssEvalDependency(fileId);

    sourceObservations.set(fileId, source);
  }

  function invalidateStaticCssEvalDependency(dependencyId: string): void {
    for (const ownerId of staticCssEvalProjectEngine.invalidateByDependency(
      dependencyId
    )) {
      cssState.clearGeneratedCssForOwner(ownerId);
      invalidateViteModule(ownerId);
    }
  }

  function isWatchableStaticCssEvalDependency(id: string): boolean {
    return rootRealpath !== "" && fs.existsSync(id);
  }

  function collectLibraryCssSidecarContract(
    entryChunk: Rollup.RenderedChunk,
    chunks: Record<string, Rollup.RenderedChunk>,
    getModuleInfo: OutputPluginContext["getModuleInfo"]
  ): {
    ancestorStyleSpecifiers: string[];
    graphModuleIds: string[];
    hasOwnCss: boolean;
  } {
    const ancestorStyleSpecifiers: string[] = [];
    const graphModuleIds: string[] = [];
    const seenModuleIds = new Set<string>();
    const seenChunkFileNames = new Set<string>();
    const seenStyleSpecifiers = new Set<string>();
    const virtualCssOwnerIds = new Set<string>();
    let hasOwnCss = false;

    for (const output of Object.values(chunks)) {
      for (const moduleId of output.moduleIds) {
        if (moduleId.endsWith(virtualExt)) {
          virtualCssOwnerIds.add(moduleId.slice(0, -virtualExt.length));
        }
      }
    }

    const visit = (moduleId: string): void => {
      const worklist = [
        {
          moduleId,
          importedIds: undefined as readonly string[] | undefined,
          index: 0
        }
      ];

      while (worklist.length > 0) {
        const current = worklist[worklist.length - 1]!;

        if (current.importedIds === undefined) {
          if (seenModuleIds.has(current.moduleId)) {
            worklist.pop();
            continue;
          }

          seenModuleIds.add(current.moduleId);

          const moduleInfo = getModuleInfo(current.moduleId);

          if (!moduleInfo?.isExternal) {
            hasOwnCss ||=
              (/\.(?:css|scss|sass|less|styl|stylus)(?:\?|$)/.test(
                current.moduleId
              ) &&
                !/[?&](?:inline|raw|url)(?:[=&]|$)/.test(current.moduleId)) ||
              virtualCssOwnerIds.has(current.moduleId);
          }

          current.importedIds = moduleInfo?.importedIds ?? [];
        }

        const importedId = current.importedIds[current.index++];

        if (importedId !== undefined) {
          worklist.push({
            moduleId: importedId,
            importedIds: undefined,
            index: 0
          });
          continue;
        }

        worklist.pop();

        const contract = libraryCssSidecarContracts.get(current.moduleId);
        if (contract === undefined) continue;

        hasOwnCss ||= contract.hasOwnCss;

        if (contract.packageGraph) {
          graphModuleIds.push(current.moduleId);
          continue;
        }

        for (const specifier of contract.ancestorStyleSpecifiers) {
          if (!seenStyleSpecifiers.has(specifier)) {
            seenStyleSpecifiers.add(specifier);
            ancestorStyleSpecifiers.push(specifier);
          }
        }
      }
    };

    const visitChunk = (chunk: Rollup.RenderedChunk): void => {
      const worklist = [{ chunk, index: -1 }];

      while (worklist.length > 0) {
        const current = worklist[worklist.length - 1]!;

        if (current.index === -1) {
          if (seenChunkFileNames.has(current.chunk.fileName)) {
            worklist.pop();
            continue;
          }

          seenChunkFileNames.add(current.chunk.fileName);

          // Walk the declared static import graph, not transform completion order.
          if (current.chunk.facadeModuleId) visit(current.chunk.facadeModuleId);

          for (const moduleId of current.chunk.moduleIds) visit(moduleId);

          current.index = 0;
        }

        const importedFileName = current.chunk.imports?.[current.index++];

        if (importedFileName !== undefined) {
          const importedChunk = chunks[importedFileName];

          if (importedChunk) {
            worklist.push({ chunk: importedChunk, index: -1 });
          }

          continue;
        }

        worklist.pop();
      }
    };

    visitChunk(entryChunk);

    return {
      ancestorStyleSpecifiers,
      graphModuleIds,
      hasOwnCss
    };
  }

  return {
    name: "mincho-css-vite",
    enforce: "pre",
    buildStart: {
      // Entry preloading must wait for async CSS compiler initialization.
      order: "post",
      sequential: true,

      async handler(this: PluginContext) {
        transformEpoch = Symbol("build");

        if (graphAnalysisClosed) {
          graphAnalysis = createPackageGraphAnalysis({
            mode: _options?.libraryCss?.analysis ?? "worker"
          });
          graphAnalysisClosed = false;
        }

        graphGeneration = graphAnalysis.beginGeneration();

        // Rollup may reuse unchanged transforms during a watch rebuild.
        // Only changed owners are invalidated; unreachable records are never queried.
        for (const [id, contract] of libraryCssSidecarContracts) {
          if (contract.packageGraph) {
            graphAnalysis.register({
              generation: graphGeneration,
              moduleId: id,
              graph: contract.packageGraph
            });
          }
        }

        abortOutputLinkers(new Error("Vite started a new build generation"));
        validatedUnsplitCssByDirectory.clear();

        if (config.build.lib && this.load) {
          const entry = config.build.lib.entry;
          if (entry === undefined) return;

          const entryIds =
            typeof entry === "string"
              ? [entry]
              : Array.isArray(entry)
                ? entry
                : Object.values(entry);

          // Resolving imports does not finish their transforms. Load the full
          // graph before another entry can serialize a shared preset.
          const loadedIds = new Set<string>();

          const preload = async (id: string): Promise<void> => {
            if (loadedIds.has(id)) return;

            loadedIds.add(id);

            const moduleInfo = await this.load?.({
              id,
              resolveDependencies: true
            });

            for (const dependency of moduleInfo?.importedIdResolutions ?? []) {
              if (!dependency.external) await preload(dependency.id);
            }
          };

          for (const id of entryIds) {
            await preload(normalizePath(resolve(config.root, id)));
          }
        }
      }
    },

    configureServer(this: void, serverInstance: ViteDevServer) {
      server = serverInstance;
    },

    async configResolved(this: void, resolvedConfig: ResolvedConfig) {
      config = resolvedConfig;
      rootRealpath = await getRealpathOrResolvedPath(config.root);
    },

    resolveId(id: string, importer?: string) {
      if (id.startsWith(commonJsRuntimePrefix)) {
        const [file, specifier, external] = commonJsRuntimeRequest(id);
        if (
          this.environment?.config.consumer === "server" &&
          (config.command !== "build" || external)
        )
          return id;

        const optimizer =
          this.environment?.mode === "dev"
            ? this.environment.depsOptimizer
            : undefined;

        if (optimizer) {
          if (
            optimizer.options.exclude?.some(
              (excluded) =>
                specifier === excluded || specifier.startsWith(`${excluded}/`)
            )
          )
            throw new Error(
              `Cannot load CommonJS runtime package ${specifier}: it is excluded from Vite optimizeDeps.`
            );

          const existing = Object.values(optimizer.metadata.optimized).find(
            (dependency) => dependency.src === file
          );
          if (!existing && optimizer.options.noDiscovery)
            throw new Error(
              `Cannot load CommonJS runtime package ${specifier}: enable optimizeDeps.noDiscovery: false or include ${file} in optimizeDeps.include.`
            );

          const dependency =
            existing ?? optimizer.registerMissingImport(file, file);

          return optimizer.getOptimizedDepId(dependency);
        }

        if (this.environment?.mode === "dev")
          throw new Error(
            `Cannot load CommonJS runtime package ${specifier}: enable Vite dependency optimization with optimizeDeps.noDiscovery: false or optimizeDeps.include.`
          );

        return this.resolve(file, importer, { skipSelf: true });
      }

      if (id.startsWith(extractedSidecarIdPrefix)) {
        return ownedExtractedSidecarPath(id) === undefined ? undefined : id;
      }

      if (id.startsWith(virtualCssImportPrefix)) {
        const physicalPath = id.slice(virtualCssImportPrefix.length);
        const virtualCssId = `${virtualCssIdPrefix}${physicalPath}`;
        const importerData =
          importer === undefined
            ? undefined
            : (cssState.getModuleData(importer) ??
              cssState.getModuleData(customNormalize(importer)));

        const trackedPhysicalPath =
          importerData?.kind !== "loaded-sidecar"
            ? undefined
            : normalizePath(
                resolve(config.root, `${importerData.filePath}${virtualExt}`)
              );
        if (
          !physicalPath.endsWith(virtualExt) ||
          (!cssState.isAuthorizedVirtualCss(virtualCssId) &&
            physicalPath !== trackedPhysicalPath)
        ) {
          return;
        }

        cssState.authorizeVirtualCss(virtualCssId);

        return virtualCssId;
      }

      if (id.startsWith("\0")) return;

      const physicalImporter = ownedExtractedSidecarPath(importer);

      if (extractedCssFileFilter(id)) {
        const normalizedId = id.startsWith("/") ? id.slice(1) : id;
        const exactPath = normalizePath(id);
        const resolvedPath = cssState.hasSidecar(exactPath)
          ? exactPath
          : importer === undefined
            ? undefined
            : normalizePath(
                join(physicalImporter ?? importer, "..", normalizedId)
              );

        if (resolvedPath === undefined || !cssState.hasSidecar(resolvedPath)) {
          return physicalImporter === undefined
            ? undefined
            : this.resolve(id, physicalImporter, { skipSelf: true });
        }

        // Other CSS plugins must not re-evaluate this in-memory sidecar as
        // a real .css.ts file. Its physical path remains compiler metadata.
        return extractedSidecarModuleId(resolvedPath);
      }

      if (id.endsWith(virtualExt)) {
        const exactId = normalizePath(id);
        if (cssState.hasCss(exactId)) {
          return exactId;
        }

        const normalizedId = id.startsWith("/") ? id.slice(1) : id;

        const key = normalizePath(resolve(config.root, normalizedId));
        if (cssState.hasCss(key)) {
          return key;
        }
      }

      if (physicalImporter !== undefined) {
        return this.resolve(id, physicalImporter, { skipSelf: true });
      }
    },

    async load(id: string) {
      if (id.startsWith(commonJsRuntimePrefix)) {
        const [file, specifier] = commonJsRuntimeRequest(id);
        const source = await fs.promises.readFile(file, "utf8");
        const exportedNames = file.endsWith(".json")
          ? Object.keys(JSON.parse(source.replace(/^\uFEFF/, "")) ?? {})
          : inspectCommonJs(source, file).exports;
        const named = exportedNames.filter(
          (name) => name !== "default" && name !== "__esModule"
        );

        // Deployed packages resolve beside the output. Local paths and package
        // imports keep their original importer context, as do all dev requests.
        const runtimeRequire =
          config.command === "build" &&
          !isProjectLocalImportPath(specifier) &&
          !/^(?:[\\#]|[a-z][a-z\d+.-]*:)/i.test(specifier)
            ? `createRequire(import.meta.url)(${JSON.stringify(specifier)})`
            : `createRequire(${JSON.stringify(pathToFileURL(file).href)})(${JSON.stringify(file)})`;

        return [
          'import { createRequire } from "node:module";',
          `const value = ${runtimeRequire};`,
          "export default value;",
          ...named.map(
            (name, index) =>
              `const exported${index} = value[${JSON.stringify(name)}]; export { exported${index} as ${JSON.stringify(name)} };`
          )
        ].join("\n");
      }

      if (id.startsWith(virtualCssIdPrefix)) {
        if (!cssState.isAuthorizedVirtualCss(id)) {
          return null;
        }

        const cached = cssState.getCss(id);
        if (cached !== undefined) {
          return cached;
        }

        // Fallback for sibling-imported virtual CSS: read the physical
        // .vanilla.css sidecar directly so vite:load-fallback never tries
        // to resolve the `\0`-prefixed id.
        const physicalPath = id.slice(virtualCssIdPrefix.length);
        if (!physicalPath.endsWith(virtualExt)) {
          return null;
        }

        try {
          return await fs.promises.readFile(physicalPath, "utf-8");
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return "";
          }

          throw error;
        }
      }

      const sidecarPath = ownedExtractedSidecarPath(id);
      if (id.startsWith("\0") && sidecarPath === undefined) {
        return null;
      }

      // Handle both old and new CSS file formats
      if (sidecarPath !== undefined || extractedCssFileFilter(id)) {
        return cssState.loadSidecar(id, sidecarPath ?? id);
      }

      if (id.endsWith(virtualExt)) {
        const cssFileId = normalizePath(resolve(config.root, id));
        const css = cssState.getCss(cssFileId);

        if (typeof css !== "string") {
          return null;
        }

        return css;
      }

      return null;
    },

    async transform(
      this: Rollup.TransformPluginContext,
      code: string,
      id: string
    ) {
      const sidecarPath = ownedExtractedSidecarPath(id);
      if (id.startsWith("\0") && sidecarPath === undefined) return;

      const epoch = transformEpoch;
      const fileId = normalizeStaticCssEvalFileId(
        sidecarPath ?? id,
        rootRealpath
      );

      // A virtual provider may transform its owner while loading its source.
      // Keep that nested request from starting the same static prepass again.
      if (staticCssEvalOwnerStack.getStore()?.has(fileId)) return null;

      const refreshProviderSource =
        observedProviderSources.has(fileId) &&
        !isVirtualStaticCssEvalId(fileId);
      observeStaticCssEvalSource(fileId, code, true);

      const moduleInfo = cssState.getModuleData(id);

      // A dependency can change before its first transform. Compare fresh disk
      // contents with the provider baseline, not with a preceding plugin's code.
      if (refreshProviderSource) {
        const provider = createViteStaticCssEvalSourceProvider(
          this,
          fileId,
          undefined,
          rootRealpath
        );
        const loaded = await provider.load(id);
        if (epoch !== transformEpoch) return null;

        observeStaticCssEvalSource(
          fileId,
          loaded?.sourceText ?? loaded?.source ?? ""
        );
      }

      // Handle both old and new CSS file formats for transformation
      if (
        moduleInfo?.kind === "loaded-sidecar" &&
        (sidecarPath !== undefined || extractedCssFileFilter(id))
      ) {
        try {
          resolverCache.delete(moduleInfo.originalPath);
          cssState.clearVirtualCssForSidecar(moduleInfo.filePath, false);

          const { source, watchFiles } = await compile({
            filePath: moduleInfo.filePath,
            cwd: config.root,
            originalPath: moduleInfo.originalPath,
            contents: code,
            resolverCache,
            externals: []
          });

          if (epoch !== transformEpoch) return null;

          for (const file of watchFiles) {
            if (extractedCssFileFilter(file)) {
              continue;
            }

            // In start mode, we need to prevent the file from rewatching itself.
            // If it's a `build --watch`, it needs to watch everything.
            if (config.command === "build" || file !== id) {
              this.addWatchFile(file);
            }
          }

          let hasGeneratedVirtualCss = false;
          const registryResult = await processDefineRulesPresetViteFile({
            source,
            filePath: moduleInfo.filePath,
            identOption: config.mode === "production" ? "short" : "debug",

            serializeVirtualCssPath: async ({
              fileScope,
              source
            }: {
              fileScope: { filePath: string };
              source: string;
            }) => {
              if (epoch !== transformEpoch) return "";

              hasGeneratedVirtualCss = true;

              const id: string = `${fileScope.filePath}${virtualExt}`;
              const cssFileId = normalizePath(resolve(config.root, id));
              const virtualCssId = `${virtualCssIdPrefix}${cssFileId}`;

              invalidateViteModule(virtualCssId);

              cssState.setVirtualCssForSidecar(
                moduleInfo.filePath,
                virtualCssId,
                source
              );

              return `import "${virtualCssImportPrefix}${cssFileId}";`;
            }
          });

          if (epoch !== transformEpoch) return null;

          if (
            config.command === "build" &&
            config.build.lib &&
            (hasGeneratedVirtualCss ||
              registryResult.ancestorStyleSpecifiers.length > 0)
          ) {
            const contract: LibraryCssSidecarContract = {
              ancestorStyleSpecifiers: registryResult.ancestorStyleSpecifiers,
              hasOwnCss: hasGeneratedVirtualCss,
              packageGraph: registryResult.packageGraph
            };

            setLibraryCssContract(id, contract);

            if (cssState.sidecarCount(moduleInfo.originalPath) === 1) {
              setLibraryCssContract(moduleInfo.originalPath, contract);
            } else {
              deleteLibraryCssContract(moduleInfo.originalPath);
            }
          } else {
            deleteLibraryCssContract(id);
            deleteLibraryCssContract(moduleInfo.originalPath);
          }

          return registryResult.source;
        } catch (error) {
          if (config.command === "build") {
            throw error;
          }

          console.error(error);
        }
      }

      if (
        sidecarPath === undefined &&
        /\.[cm]?[jt]sx?(\?used)?$/.test(id) &&
        !id.endsWith(".vanilla.js")
      ) {
        if (id.includes("node_modules") || /(^|[\\/])\.yarn[\\/]/.test(id))
          return;

        if (id.endsWith(".css.ts")) {
          return;
        }

        let babelOptions: BabelOptions | undefined =
          _options?.jsxCssProp === undefined
            ? _options?.babel
            : { ..._options.babel, jsxCssProp: _options.jsxCssProp };

        if (_options?.extractCalls !== undefined)
          babelOptions = {
            ...babelOptions,
            extractCalls: _options.extractCalls
          };

        const sourceProvider = createViteStaticCssEvalSourceProvider(
          this,
          fileId,
          code,
          rootRealpath,
          this.environment?.mode === "dev" ? this.environment : undefined
        );

        const transformBabelOptions: BabelOptions = {
          ...babelOptions,
          staticCssEvalProjectEngine,
          staticCssEvalSourceProvider: {
            ...sourceProvider,

            async load(id) {
              const loaded = await sourceProvider.load(id);
              const source = loaded?.sourceText ?? loaded?.source;

              if (source !== undefined)
                observeStaticCssEvalSource(
                  loaded?.realpath ?? loaded?.resolvedFile ?? id,
                  source
                );

              return loaded;
            }
          }
        };

        let transformResult: BabelTransformResult;

        try {
          const activeOwners = new Set(staticCssEvalOwnerStack.getStore());
          activeOwners.add(fileId);
          transformResult = await staticCssEvalOwnerStack.run(
            activeOwners,
            () =>
              babelTransformSource({
                filename: fileId,
                root: rootRealpath,
                commonJsToEsm: true,
                source: code,
                loader: getScriptLoader(fileId) ?? "js",
                babel: transformBabelOptions,

                // Vite composes this map with preceding plugin maps itself.
                sourceMaps: true
              })
          );
        } catch (error) {
          addStaticCssEvalWatchFilesForOwner(this, fileId);

          throw error;
        }

        if (epoch !== transformEpoch) return null;

        const {
          code: transformedCode,
          map,
          jsxCssPropTransformed,
          commonJsTransformed,
          result: [file, cssExtract],
          staticCssEval
        } = transformResult;

        refreshStaticCssEvalProjectEngineFromAdapterResult(
          fileId,
          staticCssEval
        );
        addStaticCssEvalWatchFilesForOwner(this, fileId);

        if (!cssExtract || !file) {
          if (config.command === "build" && config.build.lib) {
            cssState.clearGeneratedCssForOwner(fileId);
          }

          if (
            commonJsTransformed ||
            (babelOptions?.jsxCssProp === true &&
              jsxCssPropTransformed === true)
          ) {
            return {
              code: transformedCode,
              map: map ?? null
            };
          }

          return null;
        }

        if (config.command === "build" && config.build.watch) {
          this.addWatchFile(file);
        }

        const resolvedCssPath = normalizePath(join(fileId, "..", file));

        if (server && cssState.hasSidecar(resolvedCssPath)) {
          const { moduleGraph } = server;

          for (const moduleId of [
            resolvedCssPath,
            extractedSidecarModuleId(resolvedCssPath)
          ]) {
            const module = moduleGraph.getModuleById(moduleId);

            if (module) {
              moduleGraph.invalidateModule(module);
            }
          }
        }

        cssState.registerSidecar(fileId, resolvedCssPath, cssExtract);

        return {
          code: transformedCode,
          map: map ?? null
        };
      }

      return null;
    },

    renderStart(outputOptions) {
      if (
        config.command === "build" &&
        config.build.lib &&
        (outputOptions.format === "es" || outputOptions.format === "cjs")
      ) {
        libraryCssLinker(outputOptions);
      }
    },

    renderChunk: {
      order: "post",

      async handler(code, chunk, outputOptions, meta) {
        if (
          config.command !== "build" ||
          !config.build.lib ||
          (outputOptions.format !== "es" && outputOptions.format !== "cjs")
        )
          return null;

        const linker = libraryCssLinker(outputOptions);

        try {
          let ancestorStyleSpecifiers: string[] = [];
          let hasOwnCss = false;

          if (chunk.isEntry || chunk.isDynamicEntry) {
            const contract = collectLibraryCssSidecarContract(
              chunk,
              meta.chunks,
              this.getModuleInfo
            );

            hasOwnCss = contract.hasOwnCss;

            const analyzed =
              contract.graphModuleIds.length > 0
                ? await graphAnalysis.analyze({
                    generation: graphGeneration,
                    moduleIds: contract.graphModuleIds
                  })
                : undefined;

            ancestorStyleSpecifiers = [
              ...new Set([
                ...(analyzed?.styleSpecifiers ?? []),
                ...contract.ancestorStyleSpecifiers
              ])
            ];

            const resolvedAncestors = await Promise.all(
              ancestorStyleSpecifiers.map((specifier) =>
                this.resolve(specifier, chunk.facadeModuleId ?? undefined, {
                  skipSelf: true
                })
              )
            );

            for (const [index, resolved] of resolvedAncestors.entries()) {
              if (resolved === null)
                throw new Error(
                  `[mincho-css-vite] Library CSS sidecar ${ancestorStyleSpecifiers[index]} required by entry chunk ${chunk.fileName} is not exported by its package`
                );
            }
          }

          return await linker.renderChunk({
            code,
            chunk,
            chunks: meta.chunks,
            format: outputOptions.format,
            ancestorStyleSpecifiers,
            hasOwnCss
          });
        } catch (error) {
          linker.abort(
            error instanceof Error ? error : new Error(String(error))
          );

          throw error;
        }
      }
    },
    generateBundle: {
      order: "post",

      handler(outputOptions, bundle) {
        // Vite owns final asset naming, hashing and source-map composition.
        const directory = resolve(
          config.root,
          outputOptions.dir ??
            (outputOptions.file
              ? dirname(outputOptions.file)
              : (config.build.outDir ?? "dist"))
        );

        let validatedUnsplitCss = validatedUnsplitCssByDirectory.get(directory);

        if (!validatedUnsplitCss) {
          validatedUnsplitCss = new Set();
          validatedUnsplitCssByDirectory.set(directory, validatedUnsplitCss);
        }

        outputLinkers
          .get(outputOptions)
          ?.validateBundle(bundle, { validatedUnsplitCss });
        outputLinkers.delete(outputOptions);
      }
    },

    renderError(error) {
      abortOutputLinkers(error ?? new Error("Vite rendering failed"));
    },

    async closeBundle() {
      transformEpoch = Symbol("closed");
      abortOutputLinkers(new Error("Vite bundle closed"));

      if (!config.build.watch) {
        graphAnalysisClosed = true;
        await graphAnalysis.close();
      }
    },

    async closeWatcher() {
      transformEpoch = Symbol("closed");
      abortOutputLinkers(new Error("Vite watcher closed"));
      graphAnalysisClosed = true;
      await graphAnalysis.close();
    }
  } satisfies Plugin;
}

let collectDefineRulesPresetViteRegistrySource:
  | ((source: string) => void)
  | undefined;

async function processDefineRulesPresetViteFile(
  options: Parameters<typeof processDefineRulesPresetRegistryFile>[0]
): Promise<Awaited<ReturnType<typeof processDefineRulesPresetRegistryFile>>> {
  const result = await runDefineRulesPresetRegistryStep(() =>
    processDefineRulesPresetRegistryFile(options)
  );

  collectDefineRulesPresetViteRegistrySource?.(result.source);

  return result;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // Watch fixtures deliberately include partial metadata from legacy providers.
  // Keep that compatibility cast at the fixture boundary, outside production code.
  function createBabelTransformFixture(
    result: Omit<BabelTransformResult, "staticCssEval"> & {
      staticCssEval?: StaticCssEvalMetadata;
    }
  ): BabelTransformResult {
    return result as BabelTransformResult;
  }

  // Lightweight test fixtures; production hooks use Vite and Rollup types.
  interface Module {
    lastHMRTimestamp?: number;
    lastInvalidationTimestamp?: number;
  }

  // Define local interfaces instead of importing directly from Vite
  interface ViteDevServer {
    moduleGraph: {
      getModuleById(id: string): Module | undefined;

      getModulesByFile?(file: string): Set<Module> | undefined;

      invalidateModule(module: Module): void;
    };
    pluginContainer?: {
      load(id: string): Promise<string | { code: string } | null>;

      transform(code: string, id: string): Promise<{ code: string } | null>;
    };
  }

  interface ResolvedConfig {
    root: string;
    command: string;
    mode: string;
    build: {
      cssCodeSplit?: boolean;
      lib?:
        | {
            cssFileName?: string;
            entry?:
              | string
              | readonly string[]
              | Readonly<Record<string, string>>;
          }
        | false;
      watch: unknown;
    };
  }

  type OutputBundleItem =
    | {
        code: string;
        facadeModuleId: string | null;
        fileName: string;
        dynamicImports?: readonly string[];
        imports?: readonly string[];
        isEntry: boolean;
        moduleIds?: readonly string[];
        type: "chunk";
        viteMetadata?: {
          importedCss: ReadonlySet<string>;
        };
      }
    | {
        fileName: string;
        names?: readonly string[];
        originalFileNames?: readonly string[];
        type: "asset";
      };

  interface OutputPluginContext {
    getModuleInfo: (id: string) => { importedIds: readonly string[] } | null;
    resolve: (
      source: string,
      importer?: string,
      options?: { skipSelf?: boolean }
    ) => Promise<{ id: string } | null>;
  }

  interface LoadedModule {
    code: string | null;
    importedIdResolutions?: readonly {
      id: string;
      external?: boolean | "absolute" | "relative";
    }[];
  }

  interface PluginContext {
    addWatchFile: (id: string) => void;
    load?: (options: {
      id: string;
      resolveDependencies?: boolean;
    }) => Promise<LoadedModule | null> | LoadedModule | null;
    resolve?: (
      source: string,
      importer?: string,
      options?: { skipSelf?: boolean }
    ) =>
      | Promise<{
          id: string;
          external?: boolean | "absolute" | "relative";
        } | null>
      | { id: string; external?: boolean | "absolute" | "relative" }
      | null;
  }

  // Simplified Plugin interface with only what we need
  interface Plugin {
    name: string;
    enforce?: "pre" | "post";
    buildStart?: {
      order: "post";
      sequential: true;
      handler: (this: PluginContext) => void | Promise<void>;
    };
    configureServer?: (server: ViteDevServer) => void;
    configResolved?: (config: ResolvedConfig) => void | Promise<void>;
    resolveId?: (id: string, importer?: string) => string | undefined;
    load?: (id: string) => string | null | Promise<string | null>;
    transform?: (
      code: string,
      id: string
    ) =>
      | string
      | null
      | { code: string; map?: string }
      | Promise<string | null | { code: string; map?: string }>;
    closeWatcher?: () => Promise<void>;
    renderChunk?: {
      order: "post";
      handler: (
        this: OutputPluginContext,
        code: string,
        chunk: Extract<OutputBundleItem, { type: "chunk" }>,
        options: { format: string },
        meta: {
          chunks: Record<string, Extract<OutputBundleItem, { type: "chunk" }>>;
        }
      ) => Promise<{ code: string; map?: unknown } | null>;
    };
    generateBundle?: {
      order: "post";
      handler: (
        this: OutputPluginContext,
        options: { format: string },
        bundle: Record<string, OutputBundleItem>
      ) => void | Promise<void>;
    };
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { afterEach, beforeAll, describe, expect, it, vi } = import.meta.vitest;

  const DEFINE_RULES_PRESET_SCHEMA = "mincho.defineRulesPreset";
  const explicitProviderSidecarImport =
    'import "@mincho-js-proof/define-rules-preset/shared-component.css";';

  type DefineRulesPresetSerializationCase = {
    caseId: string;
    expectedEvaluation: "serialized" | "not-serialized";
    expectedRegistryInstances: number;
    expectedSourceSnippets: readonly string[];
    relativePath: string;
  };

  type DefineRulesPresetSerializationFixtureCase =
    DefineRulesPresetSerializationCase & {
      fixturePath: string;
    };

  type DefineRulesPresetRegistryResult = Awaited<
    ReturnType<typeof processDefineRulesPresetRegistryFile>
  >;

  type DefineRulesPresetSerializationPaths = {
    packageDiamond: string;
    providerDistModule: string;
    providerRoot: string;
    providerSidecarCss: string;
    viteConsumerEntry: string;
    viteConsumerRoot: string;
  };

  type DefineRulesPresetSerializationManifest = {
    DEFINE_RULES_PRESET_SERIALIZATION_PATHS: DefineRulesPresetSerializationPaths;
    DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES: readonly DefineRulesPresetSerializationCase[];
    createDefineRulesPresetSerializationFixturePath: (
      relativePath: string
    ) => string;
  };

  let providerDistModulePath: string;
  let providerRootFixturePath: string;
  let providerSidecarCssPath: string;
  let registryFixtureMatrixCases: DefineRulesPresetSerializationFixtureCase[] =
    [];

  let serializedRegistryFixtureCases: DefineRulesPresetSerializationFixtureCase[] =
    [];

  let viteConsumerEntryPath: string;
  let viteConsumerRootPath: string;
  const sharedComponentRuntimeForbiddenPatterns = [
    /mincho\.defineRulesPreset/,
    /rootNodeId\s*:/,
    /["']?nodes["']?\s*:/,
    /["']?origin["']?\s*:/,
    /["']?parents["']?\s*:/,
    /["']?condition["']?\s*:/,
    /["']?property["']?\s*:/,
    /["']?cacheKey["']?\s*:/,
    /createDefineRulesCssRuntime/,
    /createDefineRulesCxRuntime/,
    /["']?classWrites["']?\s*:/
  ];

  function getDefineRulesPresetSerializationManifestUrl(): string {
    return new URL(
      "../../integration/src/__fixtures__/defineRules-preset-serialization/manifest.ts",
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
      import.meta.url
    ).href;
  }

  function createViteFixtureCacheRoot(): string {
    return join(
      fileURLToPath(
        new URL(
          "..",
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
          import.meta.url
        )
      ),
      ".cache"
    );
  }

  async function loadDefineRulesPresetSerializationManifest(): Promise<DefineRulesPresetSerializationManifest> {
    return (await import(
      getDefineRulesPresetSerializationManifestUrl()
    )) as DefineRulesPresetSerializationManifest;
  }

  function createFixtureMatrixCases(
    fixtureCases: readonly DefineRulesPresetSerializationCase[],
    createFixturePath: (relativePath: string) => string
  ): DefineRulesPresetSerializationFixtureCase[] {
    return fixtureCases.map((fixtureCase) => ({
      ...fixtureCase,
      fixturePath: createFixturePath(fixtureCase.relativePath)
    }));
  }

  function initializeDefineRulesPresetSerializationFixtures(
    manifest: DefineRulesPresetSerializationManifest
  ): void {
    const {
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS,
      DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES,
      createDefineRulesPresetSerializationFixturePath
    } = manifest;

    viteConsumerRootPath = createDefineRulesPresetSerializationFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.viteConsumerRoot
    );
    viteConsumerEntryPath = createDefineRulesPresetSerializationFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.viteConsumerEntry
    );
    providerRootFixturePath = createDefineRulesPresetSerializationFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.providerRoot
    );
    providerDistModulePath = createDefineRulesPresetSerializationFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.providerDistModule
    );
    providerSidecarCssPath = createDefineRulesPresetSerializationFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.providerSidecarCss
    );
    registryFixtureMatrixCases = createFixtureMatrixCases(
      DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES,
      createDefineRulesPresetSerializationFixturePath
    );
    serializedRegistryFixtureCases = registryFixtureMatrixCases.filter(
      (fixtureCase) => fixtureCase.expectedEvaluation === "serialized"
    );
  }

  beforeAll(async () => {
    initializeDefineRulesPresetSerializationFixtures(
      await loadDefineRulesPresetSerializationManifest()
    );
  });

  function readFixtureSource(filePath: string): string {
    return fs.readFileSync(filePath, "utf8");
  }

  function getSharedComponentPackageRoot(): string {
    return resolve(
      dirname(fileURLToPath(getDefineRulesPresetSerializationManifestUrl())),
      "../../../../..",
      "examples/shared-component"
    );
  }

  function expectSharedComponentRuntimeChunkToOmitAuthoringGraph(
    source: string
  ): void {
    for (const pattern of sharedComponentRuntimeForbiddenPatterns) {
      expect(source).not.toMatch(pattern);
    }
  }

  function expectSharedComponentPresetChunkToContainAuthoringGraph(
    source: string
  ): void {
    expect(source).toMatch(/mincho\.defineRulesPreset/);
    expect(source).toMatch(/["']?version["']?\s*:\s*5/);
    expect(source).toMatch(/rootNodeId\s*:/);
    expect(source).toMatch(/["']?origin["']?\s*:/);
    expect(source).toMatch(/["']?parents["']?\s*:/);
    expect(source).toMatch(/["']?property["']?\s*:/);
    expect(source).toMatch(/["']?classWrites["']?\s*:/);
  }

  async function getTypeScriptDiagnostics(
    entryPath: string
  ): Promise<string[]> {
    const ts = await import("typescript");
    const options: import("typescript").CompilerOptions = {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleDetection: ts.ModuleDetectionKind.Force,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2020
    };

    const program = ts.createProgram(
      [entryPath],
      options,
      ts.createCompilerHost(options)
    );

    return ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
      );
  }

  async function buildSharedComponentPackage(outDir: string): Promise<void> {
    const { execFile } = await import("node:child_process");
    const yarnBinary = process.platform === "win32" ? "yarn.cmd" : "yarn";

    await new Promise<void>((resolveCommand, rejectCommand) => {
      execFile(
        yarnBinary,
        ["run", "-T", "vite", "build", "--outDir", outDir, "--emptyOutDir"],
        { cwd: getSharedComponentPackageRoot() },
        (error, stdout, stderr) => {
          if (error != null) {
            rejectCommand(
              new Error(`shared-component build failed\n${stdout}\n${stderr}`)
            );

            return;
          }

          resolveCommand();
        }
      );
    });
  }

  function normalizeFixtureSourceWhitespace(source: string): string {
    return source.replace(/\s+/g, " ").trim();
  }

  function expectSourceToContainSnippet(source: string, snippet: string): void {
    expect(normalizeFixtureSourceWhitespace(source)).toContain(
      normalizeFixtureSourceWhitespace(snippet)
    );
  }

  function createEmptyRegistrySession(): DefineRulesPresetRegistryResult["registrySession"] {
    return {
      instances: [],
      nextRegistrationIndex: 0,
      nextRegistrationIndexByFileScope: {}
    };
  }

  function createRegistryResult(
    source: string
  ): DefineRulesPresetRegistryResult {
    return {
      ancestorStyleSpecifiers: [],
      source,
      registrySession: createEmptyRegistrySession()
    };
  }

  function createV5PresetBuildSource(className: string): string {
    return `
      export const preset = {
        schema: "${DEFINE_RULES_PRESET_SCHEMA}",
        version: 5,
        rootNodeId: "7bdcbcb5d53d00a313df32a0aa01b07a9f1c299742bfe4e0dfb9a3544db4f3e1",
        nodes: [{
          nodeId: "7bdcbcb5d53d00a313df32a0aa01b07a9f1c299742bfe4e0dfb9a3544db4f3e1",
          origin: "@mincho-js/vite:src/extracted_rules.css.ts#defineRules:0",
          contentHash: "b7ba039d454a3d92b5c99cb091a5aee8f2d6d4fa7b8ed77baa0e34010b42e9d5",
          parents: [],
          atoms: [{
            atomId: "2e3cc161ee1f1f087d413e5bb2e94d565e4ef4da65e41666af84ee05a57948db",
            cacheKey: "shared",
            className: "${className}",
            condition: {
              layer: null,
              supports: null,
              media: null,
              container: null,
              selector: "&"
            },
            property: "background"
          }]
        }]
      };
      export const shared = "${className}";
    `;
  }

  function expectSourceToContainV5PresetArtifact(source: string): void {
    expect(source).toMatch(
      new RegExp(
        `["']?schema["']?\\s*:\\s*["']${escapeRegExp(DEFINE_RULES_PRESET_SCHEMA)}["']`
      )
    );
    expect(source).toMatch(/["']?version["']?\s*:\s*5/);
    expect(source).toMatch(/["']?rootNodeId["']?\s*:\s*["'][a-f0-9]{64}["']/);
    expect(source).toMatch(/["']?nodes["']?\s*:\s*\[/);
    expect(source).toMatch(/["']?origin["']?\s*:\s*["'][^"']+#defineRules:\d+/);
    expect(source).toMatch(/["']?atoms["']?\s*:\s*\[/);

    expectSourceV5PresetArtifactToOmitRuntimeFields(source);
  }

  function expectSourceToContainV5RuntimePresetSeed(source: string): void {
    expect(source).toMatch(
      new RegExp(
        `["']?schema["']?\\s*:\\s*["']${escapeRegExp(DEFINE_RULES_PRESET_SCHEMA)}["']`
      )
    );
    expect(source).toMatch(/["']?version["']?\s*:\s*5/);
  }

  function expectSourceV5PresetArtifactToOmitRuntimeFields(
    source: string
  ): void {
    const artifactSource = extractV5PresetArtifactSource(source);

    expect(artifactSource).not.toMatch(/["']?classNameByCache["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?writeKeyByCacheKey["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?conditionById["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?propertyById["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?writeKeyById["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?registeredSegments["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?segmentCache["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?fullResultCache["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?atomicClassByClassName["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?cx["']?\s*:/);
  }

  function extractV5PresetArtifactSource(source: string): string {
    const schemaMatch = source.match(
      new RegExp(
        `["']?schema["']?\\s*:\\s*["']${escapeRegExp(DEFINE_RULES_PRESET_SCHEMA)}["']`
      )
    );
    if (schemaMatch?.index == null) {
      throw new Error("Expected defineRules preset schema in source");
    }

    const artifactStart = source.lastIndexOf("{", schemaMatch.index);
    if (artifactStart === -1) {
      throw new Error("Expected defineRules preset artifact object in source");
    }

    let depth = 0;

    for (let index = artifactStart; index < source.length; index += 1) {
      const char = source[index];

      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;

      if (depth === 0) {
        return source.slice(artifactStart, index + 1);
      }
    }

    throw new Error("Expected defineRules preset artifact object to close");
  }

  function countV5PresetArtifacts(source: string): number {
    return Array.from(
      source.matchAll(
        new RegExp(
          `["']?schema["']?\\s*:\\s*["']${escapeRegExp(DEFINE_RULES_PRESET_SCHEMA)}["']`,
          "g"
        )
      )
    ).length;
  }

  function expectSourceToContainPopulatedPresetAtom(source: string): void {
    expect(source).toMatch(/["']?className["']?\s*:\s*["'][^"']+["']/);
  }

  function expectSourceToContainPresetAtomClassName(
    source: string,
    className: string
  ): void {
    expectSourceToContainV5PresetArtifact(source);

    for (const atomClassName of splitClassNames(className).filter(
      (token) => !isSegmentMarker(token)
    )) {
      expect(source).toMatch(
        new RegExp(
          `["']?className["']?\\s*:\\s*["']${escapeRegExp(atomClassName)}["']`
        )
      );
    }
  }

  function createLivePresetSmokeEntrySource(): string {
    return `
      import { css as vanillaCss, defineRules } from "@mincho-js/css";

      export const { css: presetCss, preset } = defineRules({
        debugId: "vite-build-smoke",
        properties: {
          background: true
        }
      });
      export const fillBlue = vanillaCss([
        presetCss({ background: "blue" })
      ]);
    `;
  }

  async function createLivePresetSmokeFixture(prefix: string) {
    const cacheRoot = createViteFixtureCacheRoot();
    await fs.promises.mkdir(cacheRoot, { recursive: true });

    const root = await fs.promises.mkdtemp(join(cacheRoot, prefix));
    const srcRoot = join(root, "src");
    const entryPath = join(srcRoot, "entry.ts");
    await fs.promises.mkdir(srcRoot, { recursive: true });
    await fs.promises.writeFile(entryPath, createLivePresetSmokeEntrySource());

    return {
      entryPath,
      root
    };
  }

  function createRealRegistryBuildEntrySource(
    fixtureCase: DefineRulesPresetSerializationFixtureCase,
    _fixtureSource: string
  ): string {
    if (fixtureCase.caseId === "registry-helper-wrapped-executed") {
      return `
        import { css, defineRules } from "@mincho-js/css";
        function createPresetOwner() {
          return defineRules({ properties: { color: true, display: true } });
        }
        const presetOwner = createPresetOwner();
        export const { css: presetCss, preset } = presetOwner;
        export const shared = presetCss({ color: "rebeccapurple", display: "flex" });
        export const __registryBuildMarker = css([shared]);
        export const __registryBuildPresetArtifact = JSON.stringify(preset);
      `;
    }

    if (fixtureCase.caseId === "registry-iife-executed") {
      return `
        import { css, defineRules } from "@mincho-js/css";
        const presetOwner = (() => defineRules({ properties: { color: true, display: true } }))();
        export const { css: presetCss, preset } = presetOwner;
        export const shared = presetCss({ color: "rebeccapurple", display: "flex" });
        export const __registryBuildMarker = css([shared]);
        export const __registryBuildPresetArtifact = JSON.stringify(preset);
      `;
    }

    if (fixtureCase.caseId === "registry-nested-function-executed") {
      return `
        import { css, defineRules } from "@mincho-js/css";
        function createPresetOwner() {
          return defineRules({ properties: { color: true, display: true } });
        }
        const presetOwner = createPresetOwner();
        export const { css: presetCss, preset } = presetOwner;
        export const shared = presetCss({ color: "rebeccapurple", display: "flex" });
        export const __registryBuildMarker = css([shared]);
        export const __registryBuildPresetArtifact = JSON.stringify(preset);
      `;
    }

    if (fixtureCase.caseId === "registry-multiple-instances") {
      return `
        import { css, defineRules } from "@mincho-js/css";
        const primaryPresetOwner = defineRules({ properties: { color: true, display: true } });
        const secondaryPresetOwner = defineRules({ properties: { padding: true, margin: true } });
        export const { css: primaryCss, preset: primaryPreset } = primaryPresetOwner;
        export const secondaryPreset = secondaryPresetOwner.preset;
        export const shared = primaryCss({ color: "rebeccapurple", display: "flex" });
        export const secondaryShared = secondaryPresetOwner.css({ padding: 17, margin: 7 });
        export const __registryBuildMarker = css([shared, secondaryShared]);
        export const __registryBuildPresetArtifacts = [
          JSON.stringify(primaryPreset),
          JSON.stringify(secondaryPreset)
        ];
      `;
    }

    if (fixtureCase.caseId === "registry-imported-helper-executed") {
      return `
        import { css } from "@mincho-js/css";
        import { createPresetOwner } from "./helper";
        const presetOwner = createPresetOwner();
        export const { css: presetCss, preset } = presetOwner;
        export const shared = presetCss({ color: "rebeccapurple", display: "flex" });
        export const __registryBuildMarker = css([shared]);
        export const __registryBuildPresetArtifact = JSON.stringify(preset);
      `;
    }

    return _fixtureSource;
  }

  async function createRealViteRegistryFixture(
    fixtureCase: DefineRulesPresetSerializationFixtureCase
  ) {
    const cacheRoot = createViteFixtureCacheRoot();
    await fs.promises.mkdir(cacheRoot, { recursive: true });

    const root = await fs.promises.mkdtemp(
      join(cacheRoot, `${fixtureCase.caseId}-`)
    );

    const srcRoot = join(root, "src");
    await fs.promises.cp(dirname(fixtureCase.fixturePath), srcRoot, {
      recursive: true
    });

    const fixtureSource = await fs.promises.readFile(
      join(srcRoot, "index.css.ts"),
      "utf8"
    );

    const entrySource = createRealRegistryBuildEntrySource(
      fixtureCase,
      fixtureSource
    );

    const entryPath = join(srcRoot, "entry.ts");
    await fs.promises.writeFile(entryPath, entrySource);

    return {
      entryPath,
      root
    };
  }

  async function buildRealViteRegistryFixture(
    fixtureCase: DefineRulesPresetSerializationFixtureCase
  ) {
    const { build } = await import("vite");
    const { entryPath, root } =
      await createRealViteRegistryFixture(fixtureCase);

    const fixtureSource = await fs.promises.readFile(
      join(root, "src/index.css.ts"),
      "utf8"
    );

    const integrationModule = await import("@mincho-js/integration");
    const babelTransformSpy = vi
      .spyOn(integrationModule, "babelTransformSource")
      .mockResolvedValue({
        code: 'import "extracted_registry.css.ts";\nexport const __registryBuildMarker = "entry";',
        result: ["extracted_registry.css.ts", fixtureSource]
      });

    const registrySources: string[] = [];
    collectDefineRulesPresetViteRegistrySource = (source) => {
      registrySources.push(source);
    };

    try {
      const buildResult = await build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [minchoVitePlugin({ libraryCss: { fileName: "style.css" } })],
        build: {
          cssMinify: false,
          emptyOutDir: false,
          lib: {
            entry: entryPath,
            fileName: "index",
            cssFileName: "style",
            formats: ["es"]
          },
          minify: false,
          write: false
        },
        resolve: {
          preserveSymlinks: true
        }
      });

      type ViteRegistryOutput =
        | { code: string; fileName: string; type: "chunk" }
        | { fileName: string; source: string | Uint8Array; type: "asset" };

      const rollupOutputs = Array.isArray(buildResult)
        ? buildResult
        : [buildResult];

      const outputFiles = rollupOutputs.flatMap((rollupOutput) => {
        const possibleRollupOutput = rollupOutput as { output?: unknown };
        if (!Array.isArray(possibleRollupOutput.output)) {
          throw new Error(
            "Expected Vite registry build to return Rollup output"
          );
        }

        return possibleRollupOutput.output as ViteRegistryOutput[];
      });

      const jsOutput = outputFiles.find(
        (output) =>
          output.type === "chunk" && /\.(?:mjs|js)$/.test(output.fileName)
      );

      const cssOutput = outputFiles.find(
        (output) => output.type === "asset" && output.fileName.endsWith(".css")
      );

      if (jsOutput?.type !== "chunk") {
        throw new Error("Expected Vite registry build to emit an ES chunk");
      }

      return {
        css: cssOutput?.type === "asset" ? String(cssOutput.source) : "",
        js: jsOutput.code,
        registrySource: registrySources.join("\n")
      };
    } finally {
      collectDefineRulesPresetViteRegistrySource = undefined;
      babelTransformSpy.mockRestore();
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  }

  function extractAssignedStringValueFromBuildSource(
    source: string,
    assignmentName: string
  ): string {
    const match = source.match(
      new RegExp(`${escapeRegExp(assignmentName)}\\s*=\\s*["']([^"']+)["']`)
    );
    if (match?.[1] == null) {
      throw new Error(
        `Expected build output to include a ${assignmentName} string literal`
      );
    }

    return match[1];
  }

  function extractFillBlueClassName(source: string): string {
    return extractAssignedStringValueFromBuildSource(source, "fillBlue");
  }

  function createDeferred<Value>() {
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<Value>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });

    return {
      promise,
      resolve,
      reject
    };
  }

  function createResolvedConfig(
    overrides: Partial<ResolvedConfig> = {}
  ): ResolvedConfig {
    const { build: buildOverrides, ...restOverrides } = overrides;

    return {
      root: viteConsumerRootPath,
      command: "build",
      mode: "production",
      ...restOverrides,
      build: {
        cssCodeSplit: buildOverrides?.cssCodeSplit,
        lib: buildOverrides?.lib,
        watch: buildOverrides?.watch ?? false
      }
    };
  }

  async function createViteHarness({
    configOverrides,
    getModuleInfo,
    pluginOptions,
    resolve: resolveImport,
    server
  }: {
    configOverrides?: Partial<ResolvedConfig>;
    getModuleInfo?: OutputPluginContext["getModuleInfo"];
    pluginOptions?: MinchoVitePluginOptions;
    resolve?: PluginContext["resolve"];
    server?: ViteDevServer;
  } = {}) {
    const plugin = minchoVitePlugin({
      ...pluginOptions,
      libraryCss: {
        fileName: "style.css",
        analysis: "inline",
        ...pluginOptions?.libraryCss
      }
    }) as unknown as Plugin;

    const resolvedConfig = createResolvedConfig(configOverrides);
    const watchFiles: string[] = [];

    await plugin.configResolved?.(resolvedConfig);

    if (server) {
      plugin.configureServer?.(server);
    }

    return {
      async buildStart() {
        await plugin.buildStart?.handler.call({
          addWatchFile(file: string) {
            watchFiles.push(file);
          }
        });
      },

      async closeWatcher() {
        await plugin.closeWatcher?.();
      },

      async load(id: string) {
        return plugin.load?.(id);
      },

      async generateBundle(
        format: string,
        bundle: Record<string, OutputBundleItem>,
        resolveOutputImport: OutputPluginContext["resolve"] = async () => ({
          id: "/style.css"
        })
      ) {
        const context = {
          getModuleInfo: getModuleInfo ?? (() => null),
          resolve: resolveOutputImport
        };

        const outputOptions = { format };
        const chunks: Record<
          string,
          Extract<OutputBundleItem, { type: "chunk" }>
        > = {};

        for (const [fileName, output] of Object.entries(bundle)) {
          if (output.type !== "chunk") continue;

          output.imports ??= [];
          output.moduleIds ??= output.facadeModuleId
            ? [output.facadeModuleId]
            : [];
          chunks[fileName] = output;
        }

        await Promise.all(
          Object.values(chunks).map(async (chunk) => {
            const result = await plugin.renderChunk?.handler.call(
              context,
              chunk.code,
              chunk,
              outputOptions,
              { chunks }
            );

            if (result) chunk.code = result.code;
          })
        );

        return plugin.generateBundle?.handler.call(
          context,
          outputOptions,
          bundle
        );
      },

      resolveId(id: string, importer?: string) {
        return plugin.resolveId?.call(
          {
            resolve:
              resolveImport ??
              ((source: string, importer?: string) =>
                resolveViteHarnessImport(source, importer, resolvedConfig.root))
          },
          id,
          importer
        );
      },

      async transform(id: string, code: string) {
        return plugin.transform?.call(
          {
            addWatchFile(file: string) {
              watchFiles.push(file);
            },

            resolve:
              resolveImport ??
              ((source, importer) =>
                resolveViteHarnessImport(
                  source,
                  importer,
                  resolvedConfig.root
                )),
            ...(server?.pluginContainer
              ? {
                  environment: {
                    mode: "dev",
                    pluginContainer: server.pluginContainer,
                    moduleGraph: {
                      ensureEntryFromUrl: async () => {},

                      getModuleById: () => undefined
                    }
                  }
                }
              : {})
          },
          code,
          id
        );
      },

      watchFiles
    };
  }

  function resolveViteHarnessImport(
    source: string,
    importer: string | undefined,
    root: string
  ): { id: string } | null {
    if (isVirtualStaticCssEvalId(source)) {
      return { id: source };
    }

    if (!isProjectLocalImportPath(source)) {
      return null;
    }

    const basePath = source.startsWith("/")
      ? source
      : resolve(dirname(importer ?? root), source);

    const candidates = [
      basePath,
      `${basePath}.ts`,
      `${basePath}.tsx`,
      `${basePath}.js`,
      `${basePath}.jsx`,
      join(basePath, "index.ts"),
      join(basePath, "index.tsx"),
      join(basePath, "index.js"),
      join(basePath, "index.jsx")
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return { id: candidate };
      }
    }

    return null;
  }

  async function createExtractedCssFixture(
    harness: Awaited<ReturnType<typeof createViteHarness>>
  ) {
    return createExtractedCssFixtureFromEntry(harness, viteConsumerEntryPath);
  }

  async function createExtractedCssFixtureFromEntry(
    harness: Awaited<ReturnType<typeof createViteHarness>>,
    entryPath: string
  ) {
    const entrySource = await fs.promises.readFile(entryPath, "utf8");
    const transformedEntry = await harness.transform(entryPath, entrySource);

    if (
      transformedEntry == null ||
      typeof transformedEntry !== "object" ||
      !("code" in transformedEntry) ||
      typeof transformedEntry.code !== "string"
    ) {
      throw new Error("Expected the entry transform to return code");
    }

    const extractedImportMatch = transformedEntry.code.match(
      /import\s+["']([^"']*extracted_[^"']+\.css\.ts)["'];?/
    );
    if (extractedImportMatch == null) {
      throw new Error("Failed to locate the extracted css import");
    }

    const extractedId = harness.resolveId(extractedImportMatch[1], entryPath);
    if (typeof extractedId !== "string") {
      throw new Error("Expected the extracted css id to resolve");
    }

    const extractedSource = await harness.load(extractedId);
    if (typeof extractedSource !== "string") {
      throw new Error(
        "Expected the extracted css module to load as source text"
      );
    }

    return {
      extractedId,
      extractedSource,
      physicalPath: normalizePath(
        resolve(dirname(entryPath), extractedImportMatch[1])
      )
    };
  }

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  type ExtractedCssImport = {
    importedNames: string[];
    localNames: string[];
    source: string;
  };

  function createJsxCssPropFixtureSource(): string {
    return `
      function App() {
        return <div className="base" css={{ color: "red" }} />;
      }

      export { App };
    `;
  }

  function createJsxCssPropV2ClassValueFixtureSource(): string {
    return `
      const styleA = "style-a";
      const styleB = ["style-b"];
      const spreadProps = {
        className: "from-spread",
        css: "leaked-css",
        id: "root"
      };
      const motion = { div: "div" };

      function Button(props) {
        return <button {...props} />;
      }

      function App() {
        return <>
          <Button css={styleA} />
          <motion.div css={styleB} />
        </>;
      }

      function SpreadApp() {
        return <div {...spreadProps} css={styleA} />;
      }

      export { App, SpreadApp };
    `;
  }

  async function createJsxCssPropViteFixture(
    prefix: string,
    source = createJsxCssPropFixtureSource()
  ) {
    const cacheRoot = createViteFixtureCacheRoot();
    await fs.promises.mkdir(cacheRoot, { recursive: true });

    const root = await fs.promises.mkdtemp(join(cacheRoot, prefix));
    const srcRoot = join(root, "src");
    const entryPath = join(srcRoot, "entry.tsx");

    await fs.promises.mkdir(srcRoot, { recursive: true });
    await fs.promises.writeFile(entryPath, source);

    return {
      entryPath,
      root,
      source
    };
  }

  function createImportedCssPropEntrySource(
    importPath = "./styles",
    cssExpression = "button"
  ): string {
    return `
      import { button } from "${importPath}";

      function App() {
        return <div css={${cssExpression}} />;
      }

      export { App };
    `;
  }

  function createNamespaceCssPropEntrySource(
    importPath = "./barrel",
    cssExpression = "styles.button.primary"
  ): string {
    return `
      import * as styles from "${importPath}";

      function App() {
        return <div css={${cssExpression}} />;
      }

      export { App };
    `;
  }

  function createImportedCssPropStaticRuleEntrySource(
    importPath = "./styles"
  ): string {
    return `
      import { button } from "${importPath}";

      function App() {
        return <div css={{ color: button }} />;
      }

      export { App };
    `;
  }

  function createImportedStyleSource(color: string): string {
    return `export const button = { color: "${color}" } as const;`;
  }

  function createDuplicatedStaticCssEvalMetadataVariants(
    filePath: string,
    kind = "imported"
  ): StaticCssEvalMetadata {
    return {
      dependencyFiles: [`/@fs${filePath}?import#dep`],
      dependencies: [{ file: `ssr:/@fs${filePath}?dep#hash`, kind }],
      resolvedDependencies: [
        {
          resolvedFile: `/@fs${filePath}?resolved#hash`,
          canonicalModuleId: `ssr:/@fs${filePath}?canonical#hash`,
          normalizedPathKey: `/@fs${filePath}?normalized#hash`
        }
      ],
      cacheKeys: [
        {
          resolvedFile: `/@fs${filePath}?cache#hash`,
          resolvedId: `ssr:/@fs${filePath}?cache-id#hash`
        }
      ],
      resolvedModuleIds: [`ssr:/@fs${filePath}?module#hash`]
    };
  }

  function createExportStarStaticCssEvalMetadata({
    barrelPath,
    explicitDefaultPath,
    terminalLeafPath
  }: {
    readonly barrelPath: string;
    readonly explicitDefaultPath?: string;
    readonly terminalLeafPath: string;
  }): StaticCssEvalMetadata {
    const dependencyPaths = [
      barrelPath,
      ...(explicitDefaultPath ? [explicitDefaultPath] : []),
      terminalLeafPath
    ];

    return {
      dependencyFiles: dependencyPaths.map(
        (filePath) => `/@fs${filePath}?import#dep`
      ),
      dependencies: dependencyPaths.map((filePath) => ({
        file: `ssr:/@fs${filePath}?dep#hash`,
        kind: "reexported"
      })),
      resolvedDependencies: dependencyPaths.map((filePath) => ({
        resolvedFile: `/@fs${filePath}?resolved#hash`,
        canonicalModuleId: `ssr:/@fs${filePath}?canonical#hash`,
        normalizedPathKey: `/@fs${filePath}?normalized#hash`
      })),
      cacheKeys: dependencyPaths.map((filePath) => ({
        resolvedFile: `/@fs${filePath}?cache#hash`,
        resolvedId: `ssr:/@fs${filePath}?cache-id#hash`
      })),
      resolvedModuleIds: dependencyPaths.map(
        (filePath) => `ssr:/@fs${filePath}?module#hash`
      )
    };
  }

  async function createImportedCssPropViteFixture(
    prefix: string,
    options: {
      entrySource?: string;
      styleSource?: string;
    } = {}
  ) {
    const cacheRoot = createViteFixtureCacheRoot();
    await fs.promises.mkdir(cacheRoot, { recursive: true });

    const root = await fs.promises.mkdtemp(join(cacheRoot, prefix));
    const srcRoot = join(root, "src");
    const entryPath = join(srcRoot, "entry.tsx");
    const stylesPath = join(srcRoot, "styles.ts");
    const entrySource =
      options.entrySource ?? createImportedCssPropEntrySource();

    const styleSource = options.styleSource ?? createImportedStyleSource("red");

    await fs.promises.mkdir(srcRoot, { recursive: true });
    await fs.promises.writeFile(entryPath, entrySource);
    await fs.promises.writeFile(stylesPath, styleSource);

    return {
      entryPath,
      entrySource,
      root,
      srcRoot,
      stylesPath,
      styleSource
    };
  }

  async function transformImportedCssPropToVirtualCss(
    harness: Awaited<ReturnType<typeof createViteHarness>>,
    entryPath: string,
    entrySource: string
  ) {
    const transformedEntry = extractViteTransformCode(
      await harness.transform(entryPath, entrySource),
      "Expected imported css-prop entry transform to return code"
    );

    const extractedCssImport =
      extractNamedCssImportFromSource(transformedEntry);

    const extractedId = harness.resolveId(extractedCssImport.source, entryPath);
    assertString(
      extractedId,
      "Expected imported css-prop sidecar import to resolve"
    );

    const extractedSource = await harness.load(extractedId);
    assertString(
      extractedSource,
      "Expected imported css-prop sidecar source to load"
    );

    const transformedExtractedCss = await harness.transform(
      extractedId,
      extractedSource
    );

    assertString(
      transformedExtractedCss,
      "Expected imported css-prop sidecar transform to return source text"
    );

    const virtualImportMatch = transformedExtractedCss.match(
      /import\s+"([^"]+\.vanilla\.css)";/
    );

    if (virtualImportMatch?.[1] == null) {
      throw new Error(
        "Expected imported css-prop output to import virtual CSS"
      );
    }

    const resolvedVirtualId = harness.resolveId(virtualImportMatch[1]);
    assertString(
      resolvedVirtualId,
      "Expected imported css-prop virtual CSS id to resolve"
    );

    const virtualCss = await harness.load(resolvedVirtualId);
    assertString(virtualCss, "Expected imported css-prop virtual CSS to load");

    return {
      extractedCssImport,
      extractedId,
      extractedSource,
      resolvedVirtualId,
      transformedEntry,
      transformedExtractedCss,
      virtualCss
    };
  }

  async function spyOnSourceBabelTransform() {
    const sourceIntegrationUrl = new URL(
      "../../integration/src/babel" + ".ts",
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
      import.meta.url
    ).href;

    const [integrationModule, sourceIntegrationModule] = await Promise.all([
      import("@mincho-js/integration"),
      import(/* @vite-ignore */ sourceIntegrationUrl) as Promise<{
        babelTransformSource: typeof babelTransformSource;
      }>
    ]);

    return vi
      .spyOn(integrationModule, "babelTransformSource")
      .mockImplementation(sourceIntegrationModule.babelTransformSource);
  }

  function extractViteTransformCode(
    transformResult: unknown,
    message: string
  ): string {
    if (
      transformResult == null ||
      typeof transformResult !== "object" ||
      !("code" in transformResult) ||
      typeof transformResult.code !== "string"
    ) {
      throw new Error(message);
    }

    return transformResult.code;
  }

  function extractNamedCssImportFromSource(source: string): ExtractedCssImport {
    const importMatch =
      /import\s+\{\s*([^}]+?)\s*\}\s+from\s+["']([^"']*extracted_[^"']+\.css\.ts)["'];?/.exec(
        source
      );

    if (importMatch?.[1] == null || importMatch[2] == null) {
      throw new Error("Expected transformed source to import extracted css");
    }

    const importedNames: string[] = [];
    const localNames: string[] = [];

    for (const rawSpecifier of importMatch[1].split(",")) {
      const specifier = rawSpecifier.trim();
      if (specifier === "") continue;

      const specifierMatch =
        /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(specifier);

      if (specifierMatch?.[1] == null) {
        throw new Error(
          `Expected named extracted css import, got ${specifier}`
        );
      }

      importedNames.push(specifierMatch[1]);
      localNames.push(specifierMatch[2] ?? specifierMatch[1]);
    }

    return {
      importedNames,
      localNames,
      source: importMatch[2]
    };
  }

  function extractCxIdentifierFromSource(source: string): string {
    const cxImportMatch =
      /import\s+\{\s*[^}]*\bcx(?:\s+as\s+([A-Za-z_$][\w$]*))?[^}]*\}\s+from\s+["']@mincho-js\/css["'];?/.exec(
        source
      );

    if (cxImportMatch == null) {
      throw new Error("Expected transformed source to import cx");
    }

    return cxImportMatch[1] ?? "cx";
  }

  function expectSourceToContainCssPropClassNameMerge(
    source: string,
    cxIdentifier: string,
    generatedLocalNames: string[]
  ): void {
    const classNameMergeMatch = new RegExp(
      `className=\\{${escapeRegExp(cxIdentifier)}\\(\\s*"base"\\s*,\\s*([A-Za-z_$][\\w$]*)\\s*\\)\\}`
    ).exec(source);

    expect(classNameMergeMatch).not.toBeNull();
    expect(generatedLocalNames).toContain(classNameMergeMatch?.[1]);
  }

  function expectSourceToContainV2ClassValueCssPropLowering(
    source: string,
    cxIdentifier: string
  ): void {
    expect(source).toMatch(
      new RegExp(
        `<Button className=\\{${escapeRegExp(cxIdentifier)}\\(styleA\\)\\} />`
      )
    );
    expect(source).toMatch(/<motion\.div className=\{[A-Za-z_$][\w$]*\} \/>/);
    expect(source).toContain("css: _minchoCssProp");
    expect(source).toContain("..._minchoRest");
    expect(source).toMatch(
      new RegExp(
        `className=\\{${escapeRegExp(cxIdentifier)}\\(_minchoClassName, styleA\\)\\}`
      )
    );
  }

  function extractExportedVariableInitializerFromBuildSource(
    source: string,
    exportName: string
  ): string {
    const exportMatch = source.match(
      new RegExp(
        `export\\s+(?:const|let|var)\\s+${escapeRegExp(exportName)}\\s*=\\s*([^;]+);`
      )
    );

    if (exportMatch?.[1] == null) {
      throw new Error(`Failed to locate exported variable ${exportName}`);
    }

    return exportMatch[1].trim();
  }

  function extractExportedStringValueFromBuildSource(
    source: string,
    exportName: string
  ): string {
    const initializer = extractExportedVariableInitializerFromBuildSource(
      source,
      exportName
    );

    const stringLiteralMatch = initializer.match(/^(["'])(.*)\1$/);

    if (stringLiteralMatch?.[2] == null) {
      throw new Error(`Expected export ${exportName} to be a string literal`);
    }

    return stringLiteralMatch[2];
  }

  function extractVariableStringValueFromBuildSource(
    source: string,
    variableName: string
  ): string {
    const variableMatch = source.match(
      new RegExp(
        `\\b(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExp(variableName)}\\s*=\\s*(["'])(.*?)\\1\\s*;`
      )
    );

    if (variableMatch?.[2] == null) {
      throw new Error(
        `Expected variable ${variableName} to be a string literal`
      );
    }

    return variableMatch[2];
  }

  function splitClassNames(className: string): string[] {
    return className.split(/\s+/).filter(Boolean);
  }

  function isSegmentMarker(className: string): boolean {
    return className.startsWith("__mincho_seg_");
  }

  function expectCssSourceToContainClassNames(
    source: string,
    className: string
  ): void {
    for (const fragmentClassName of splitClassNames(className).filter(
      (token) => !isSegmentMarker(token)
    )) {
      expect(source).toContain(`.${fragmentClassName}`);
    }
  }

  function hasCssCallWithStringProperty(
    source: string,
    propertyName: string,
    propertyValue: string
  ): boolean {
    return new RegExp(
      `\\bcss\\s*\\(\\s*\\{[\\s\\S]*?${escapeRegExp(propertyName)}\\s*:\\s*["']${escapeRegExp(propertyValue)}["'][\\s\\S]*?\\}\\s*\\)`
    ).test(source);
  }

  function assertString(
    value: unknown,
    message: string
  ): asserts value is string {
    if (typeof value !== "string") {
      throw new Error(message);
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("minchoVitePlugin", () => {
    it.each([
      "/project/.yarn/cache/dependency.cjs",
      "C:\\project\\.yarn\\cache\\dependency.cts",
      "C:/project/.yarn\\cache/dependency.mjs",
      ".yarn\\cache\\dependency.mts",
      "/project/node_modules/dependency/index.cjs"
    ])("skips dependency transforms for %s", async (id: string) => {
      const integrationModule = await import("@mincho-js/integration");
      const babelSpy = vi
        .spyOn(integrationModule, "babelTransformSource")
        .mockResolvedValue({ code: "export {};", result: ["", ""] });
      const harness = await createViteHarness();

      await expect(
        harness.transform(id, "module.exports = 1;")
      ).resolves.toBeUndefined();
      expect(babelSpy).not.toHaveBeenCalled();

      await harness.transform(
        "/project/src/my.yarn/index.cjs",
        "module.exports = 1;"
      );
      expect(babelSpy).toHaveBeenCalledTimes(1);
    });

    it("keeps extracted module IDs opaque while compiling and resolving from the physical path", async () => {
      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_owned.css.ts";',
        result: ["extracted_owned.css.ts", "resolver contents"]
      });

      const compileSpy = vi
        .spyOn(integrationModule, "compile")
        .mockResolvedValue({
          source: "compiled source",
          watchFiles: []
        } as unknown as Awaited<ReturnType<typeof compile>>);

      const registrySpy = vi
        .spyOn(integrationModule, "processDefineRulesPresetRegistryFile")
        .mockResolvedValue(
          createRegistryResult("export const local = 'local';")
        );

      const resolveImport = vi.fn(async () => ({ id: "/resolved/helper.js" }));
      const harness = await createViteHarness({ resolve: resolveImport });
      const fixture = await createExtractedCssFixture(harness);

      expect(fixture.extractedId).toBe(
        `${extractedSidecarIdPrefix}${fixture.physicalPath}.js`
      );
      expect(fixture.extractedId).not.toMatch(/\.css\.[cm]?[jt]sx?$/);
      expect(harness.resolveId(fixture.physicalPath)).toBe(fixture.extractedId);
      expect(harness.resolveId(fixture.extractedId)).toBe(fixture.extractedId);
      expect(await harness.load(fixture.physicalPath)).toBe(
        fixture.extractedSource
      );

      await harness.transform(fixture.extractedId, fixture.extractedSource);

      expect(compileSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: fixture.physicalPath,
          originalPath: viteConsumerEntryPath
        })
      );
      expect(registrySpy).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: fixture.physicalPath })
      );
      expect(harness.watchFiles).not.toContain(fixture.extractedId);
      await expect(
        harness.resolveId("./helper.js", fixture.extractedId)
      ).resolves.toEqual({ id: "/resolved/helper.js" });

      expect(resolveImport).toHaveBeenLastCalledWith(
        "./helper.js",
        fixture.physicalPath,
        { skipSelf: true }
      );

      await harness.resolveId("./extracted_user.css.ts", fixture.extractedId);

      expect(resolveImport).toHaveBeenLastCalledWith(
        "./extracted_user.css.ts",
        fixture.physicalPath,
        { skipSelf: true }
      );

      const unownedId = `${extractedSidecarIdPrefix}/unowned/extracted_fake.css.ts.js`;

      expect(harness.resolveId(unownedId)).toBeUndefined();
      await expect(harness.load(unownedId)).resolves.toBeNull();
      await expect(harness.transform(unownedId, "")).resolves.toBeUndefined();
    });

    it.each(["compile", "registry"] as const)(
      "skips Babel for owned extracted modules after a %s failure in dev",
      async (failureStage: "compile" | "registry") => {
        const integrationModule = await import("@mincho-js/integration");
        const babelSpy = vi
          .spyOn(integrationModule, "babelTransformSource")
          .mockResolvedValue({
            code: 'import "extracted_owned.css.ts";',
            result: ["extracted_owned.css.ts", "resolver contents"]
          });

        const compileSpy = vi
          .spyOn(integrationModule, "compile")
          .mockResolvedValue({ source: "compiled source", watchFiles: [] });

        const registrySpy = vi
          .spyOn(integrationModule, "processDefineRulesPresetRegistryFile")
          .mockResolvedValue(createRegistryResult("export {};"));

        const failure = new Error(`${failureStage} failure`);
        const consoleErrorSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});

        if (failureStage === "compile") {
          compileSpy.mockRejectedValueOnce(failure);
        } else {
          registrySpy.mockRejectedValueOnce(failure);
        }

        const harness = await createViteHarness({
          configOverrides: { command: "serve", mode: "development" }
        });

        const fixture = await createExtractedCssFixture(harness);
        babelSpy.mockClear();

        const result = await harness.transform(
          fixture.extractedId,
          fixture.extractedSource
        );

        expect(compileSpy).toHaveBeenCalledTimes(1);
        expect(registrySpy).toHaveBeenCalledTimes(
          failureStage === "registry" ? 1 : 0
        );
        expect(consoleErrorSpy).toHaveBeenCalledWith(failure);
        expect(babelSpy).not.toHaveBeenCalled();
        expect(result).toBeNull();
      }
    );

    it("invalidates and removes both extracted aliases and their output graph when the owner loses CSS", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const babelSpy = vi
        .spyOn(integrationModule, "babelTransformSource")
        .mockResolvedValue({
          code: 'import "extracted_owned.css.ts";',
          result: ["extracted_owned.css.ts", "resolver contents"]
        });

      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      } as unknown as Awaited<ReturnType<typeof compile>>);
      vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      ).mockResolvedValue({
        ...createRegistryResult("export const local = 'local';"),
        ancestorStyleSpecifiers: ["ancestor/style.css"],
        packageGraph: {
          packages: [{ packageName: "ancestor", firstSeen: 0 }],
          dependencies: [],
          localPackages: []
        }
      });

      const module = {};
      const getModuleById = vi.fn(() => module);
      const invalidateModule = vi.fn();
      const harness = await createViteHarness({
        configOverrides: { build: { lib: {}, watch: true } },
        server: { moduleGraph: { getModuleById, invalidateModule } }
      });

      const fixture = await createExtractedCssFixture(harness);
      await harness.load(fixture.physicalPath);
      await harness.transform(fixture.extractedId, fixture.extractedSource);
      await harness.transform(fixture.physicalPath, fixture.extractedSource);
      await harness.transform(viteConsumerEntryPath, "owner source");

      expect(getModuleById).toHaveBeenCalledWith(fixture.physicalPath);
      expect(getModuleById).toHaveBeenCalledWith(fixture.extractedId);
      expect(invalidateModule).toHaveBeenCalledWith(module);

      await harness.buildStart();

      expect(harness.resolveId(fixture.extractedId)).toBe(fixture.extractedId);

      babelSpy.mockResolvedValue({ code: "export {};", result: ["", ""] });
      await harness.transform(viteConsumerEntryPath, "export {};");

      expect(harness.resolveId(fixture.extractedId)).toBeUndefined();
      expect(harness.resolveId(fixture.physicalPath)).toBeUndefined();
      await expect(harness.load(fixture.extractedId)).resolves.toBeNull();
      await expect(harness.load(fixture.physicalPath)).resolves.toBeNull();
      await expect(
        harness.transform(fixture.extractedId, fixture.extractedSource)
      ).resolves.toBeUndefined();

      const entry: OutputBundleItem = {
        type: "chunk",
        code: "export const entry = true;",
        fileName: "entry.js",
        facadeModuleId: viteConsumerEntryPath,
        isEntry: true,
        moduleIds: [
          viteConsumerEntryPath,
          fixture.physicalPath,
          fixture.extractedId
        ]
      };

      await harness.generateBundle("es", { "entry.js": entry });

      expect(entry.code).toBe("export const entry = true;");
    });

    it("static css eval shared helpers normalize file ids and preserve source identity for Vite", async () => {
      const fixture = await createImportedCssPropViteFixture(
        "static-css-eval-shared-helper-identity-"
      );

      try {
        const rootRealpath = normalizePath(
          await fs.promises.realpath(fixture.root)
        );

        const stylesRealpath = normalizePath(
          await fs.promises.realpath(fixture.stylesPath)
        );

        const stat = await fs.promises.stat(stylesRealpath);
        const sourceIdentity = createStaticCssEvalSourceIdentity(stat);

        expect(
          normalizeStaticCssEvalFileId(
            `/@fs${stylesRealpath}?import#hash`,
            rootRealpath
          )
        ).toBe(stylesRealpath);
        expect(
          normalizeStaticCssEvalFileId(
            `ssr:/@fs${stylesRealpath}?used#hash`,
            rootRealpath
          )
        ).toBe(stylesRealpath);
        expect(sourceIdentity).toEqual({
          sourceHash: `mtime:${stat.mtimeMs}:size:${stat.size}`,
          version: stat.mtimeMs
        });
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("static css eval watch files include real package and outside-root dependencies for Vite", async () => {
      const fixture = await createImportedCssPropViteFixture(
        "static-css-eval-shared-helper-boundary-"
      );

      try {
        const integrationModule = await import("@mincho-js/integration");
        const stylesRealpath = normalizePath(
          await fs.promises.realpath(fixture.stylesPath)
        );

        const outsideRootFile = normalizePath(
          join(process.cwd(), "package.json")
        );

        const packagePath = join(fixture.root, "node_modules/pkg/styles.ts");
        await fs.promises.mkdir(dirname(packagePath), { recursive: true });
        await fs.promises.writeFile(
          packagePath,
          createImportedStyleSource("blue")
        );

        const packageRealpath = normalizePath(
          await fs.promises.realpath(packagePath)
        );

        vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue(
          createBabelTransformFixture({
            code: fixture.entrySource,
            result: ["", ""],
            staticCssEval: {
              dependencyFiles: [
                stylesRealpath,
                "virtual:mincho-static-css-eval-test",
                outsideRootFile
              ],
              resolvedDependencies: [
                {
                  resolvedFile: "virtual:mincho-static-css-eval-provider",
                  canonicalModuleId: "virtual:mincho-static-css-eval-provider",
                  normalizedPathKey: "virtual:mincho-static-css-eval-provider",
                  watchFiles: [packageRealpath]
                }
              ]
            }
          })
        );

        const harness = await createViteHarness({
          configOverrides: {
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          }
        });

        await harness.transform(fixture.entryPath, fixture.entrySource);

        expect(new Set(harness.watchFiles)).toEqual(
          new Set([stylesRealpath, packageRealpath, outsideRootFile])
        );
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("normalizes Vite static css dependency ids before cache and watch keys", () => {
      const root = "/project";

      expect(
        normalizeStaticCssEvalFileId(
          "/@fs/project/src/styles.ts?import#hash",
          root
        )
      ).toBe("/project/src/styles.ts");
      expect(normalizeStaticCssEvalFileId("/src/styles.ts?used", root)).toBe(
        "/project/src/styles.ts"
      );
      expect(
        normalizeStaticCssEvalFileId("ssr:/src/styles.ts?import", root)
      ).toBe("/project/src/styles.ts");
      expect(
        normalizeStaticCssEvalFileId("C:\\project\\src\\styles.ts?raw#hash")
      ).toBe("C:/project/src/styles.ts");
    });

    it("dedupes query, hash, /@fs, and SSR metadata variants to one watch key", async () => {
      const fixture = await createImportedCssPropViteFixture(
        "jsx-css-prop-normalized-metadata-"
      );

      try {
        const integrationModule = await import("@mincho-js/integration");
        const stylesRealpath = normalizePath(
          await fs.promises.realpath(fixture.stylesPath)
        );

        vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue(
          createBabelTransformFixture({
            code: fixture.entrySource,
            result: ["", ""],
            staticCssEval:
              createDuplicatedStaticCssEvalMetadataVariants(stylesRealpath)
          })
        );

        const harness = await createViteHarness({
          configOverrides: {
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          }
        });

        await harness.transform(fixture.entryPath, fixture.entrySource);

        expect(harness.watchFiles).toEqual([stylesRealpath]);
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("lowers enabled jsx css prop before React JSX lowering and serves generated CSS", async () => {
      const fixture = await createJsxCssPropViteFixture(
        "jsx-css-prop-enabled-"
      );

      try {
        const babelTransformSpy = await spyOnSourceBabelTransform();
        const harness = await createViteHarness({
          configOverrides: {
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          }
        });

        const transformedEntry = extractViteTransformCode(
          await harness.transform(fixture.entryPath, fixture.source),
          "Expected enabled css-prop entry transform to return code"
        );

        expect(babelTransformSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filename: fixture.entryPath,
            source: fixture.source,
            babel: expect.objectContaining({
              jsxCssProp: true,
              staticCssEvalSourceProvider: expect.any(Object)
            })
          })
        );

        const extractedCssImport =
          extractNamedCssImportFromSource(transformedEntry);

        const cxIdentifier = extractCxIdentifierFromSource(transformedEntry);

        expect(transformedEntry).not.toContain(" css=");
        expect(transformedEntry).not.toContain("css={{");
        expect(transformedEntry).not.toContain('color: "red"');

        expectSourceToContainCssPropClassNameMerge(
          transformedEntry,
          cxIdentifier,
          extractedCssImport.localNames
        );

        const extractedId = harness.resolveId(
          extractedCssImport.source,
          fixture.entryPath
        );

        assertString(
          extractedId,
          "Expected enabled css-prop sidecar import to resolve"
        );

        const extractedSource = await harness.load(extractedId);
        assertString(
          extractedSource,
          "Expected enabled css-prop sidecar source to load"
        );

        expect(extractedSource).toMatch(
          /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*css\(\{\s*color: "red"\s*\}\);/s
        );

        const transformedExtractedCss = await harness.transform(
          extractedId,
          extractedSource
        );

        assertString(
          transformedExtractedCss,
          "Expected enabled css-prop sidecar transform to return source text"
        );

        const generatedClassName = extractExportedStringValueFromBuildSource(
          transformedExtractedCss,
          extractedCssImport.importedNames[0]!
        );

        const virtualImportMatch = transformedExtractedCss.match(
          /import\s+"([^"]+\.vanilla\.css)";/
        );

        if (virtualImportMatch?.[1] == null) {
          throw new Error(
            "Expected enabled css-prop output to import virtual CSS"
          );
        }

        const resolvedVirtualId = harness.resolveId(virtualImportMatch[1]);
        assertString(
          resolvedVirtualId,
          "Expected enabled css-prop virtual CSS id to resolve"
        );

        const virtualCss = await harness.load(resolvedVirtualId);
        assertString(
          virtualCss,
          "Expected enabled css-prop virtual CSS to load"
        );
        expectCssSourceToContainClassNames(virtualCss, generatedClassName);

        expect(virtualCss).toContain("color: red;");
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("retains imported static css prop virtual CSS during builds", async () => {
      const fixture = await createImportedCssPropViteFixture(
        "jsx-css-prop-imported-build-retention-"
      );

      try {
        // Given
        await spyOnSourceBabelTransform();

        const harness = await createViteHarness({
          configOverrides: {
            command: "build",
            mode: "production",
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          }
        });

        const redArtifact = await transformImportedCssPropToVirtualCss(
          harness,
          fixture.entryPath,
          fixture.entrySource
        );

        const virtualImportMatch = redArtifact.transformedExtractedCss.match(
          /import\s+"([^"]+\.vanilla\.css)";/
        );

        if (virtualImportMatch?.[1] == null) {
          throw new Error(
            "Expected imported css-prop output to import virtual CSS"
          );
        }

        // When
        await harness.transform(
          fixture.stylesPath,
          await fs.promises.readFile(fixture.stylesPath, "utf8")
        );

        // Then
        const resolvedVirtualId = harness.resolveId(virtualImportMatch[1]);
        assertString(
          resolvedVirtualId,
          "Expected build-mode virtual CSS id to remain resolvable after dependency transform"
        );

        const virtualCss = await harness.load(resolvedVirtualId);
        assertString(
          virtualCss,
          "Expected build-mode virtual CSS to remain loadable after dependency transform"
        );

        expect(virtualCss).toBe(redArtifact.virtualCss);
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("refreshes imported static css prop dependencies without stale CSS", async () => {
      const fixture = await createImportedCssPropViteFixture(
        "jsx-css-prop-imported-refresh-"
      );

      const ownerModule: Module = { lastInvalidationTimestamp: 1001 };
      const sidecarModule: Module = { lastInvalidationTimestamp: 1002 };
      const virtualModule: Module = { lastInvalidationTimestamp: 1003 };
      const modules = new Map<string, Module>([
        [fixture.entryPath, ownerModule]
      ]);

      const getModuleById = vi.fn((moduleId: string) => modules.get(moduleId));
      const invalidateModule = vi.fn();

      try {
        await spyOnSourceBabelTransform();

        const harness = await createViteHarness({
          configOverrides: {
            command: "serve",
            mode: "development",
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          },
          server: {
            moduleGraph: {
              getModuleById,
              invalidateModule
            }
          }
        });

        const redArtifact = await transformImportedCssPropToVirtualCss(
          harness,
          fixture.entryPath,
          fixture.entrySource
        );

        modules.set(redArtifact.extractedId, sidecarModule);
        modules.set(redArtifact.resolvedVirtualId, virtualModule);

        expect(redArtifact.extractedSource).toContain('color: "red"');
        expect(redArtifact.virtualCss).toContain("color: red;");
        expect(redArtifact.virtualCss).not.toContain("color: blue;");

        await fs.promises.writeFile(
          fixture.stylesPath,
          createImportedStyleSource("blue")
        );
        await harness.transform(
          fixture.stylesPath,
          await fs.promises.readFile(fixture.stylesPath, "utf8")
        );

        expect(invalidateModule).toHaveBeenCalledWith(ownerModule);
        expect(invalidateModule).toHaveBeenCalledWith(sidecarModule);
        expect(invalidateModule).toHaveBeenCalledWith(virtualModule);
        expect(ownerModule.lastHMRTimestamp).toBe(1001);
        expect(await harness.load(redArtifact.extractedId)).toBeNull();
        expect(await harness.load(redArtifact.resolvedVirtualId)).toBeNull();

        const blueArtifact = await transformImportedCssPropToVirtualCss(
          harness,
          fixture.entryPath,
          fixture.entrySource
        );

        expect(blueArtifact.extractedSource).toContain('color: "blue"');
        expect(blueArtifact.extractedSource).not.toContain('color: "red"');
        expect(blueArtifact.virtualCss).toContain("color: blue;");
        expect(blueArtifact.virtualCss).not.toContain("color: red;");
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("static css eval dependency invalidation removes stale owners and virtual css", async () => {
      const fixture = await createImportedCssPropViteFixture(
        "static-css-eval-dependency-invalidation-"
      );

      const ownerModule: Module = { lastInvalidationTimestamp: 2001 };
      const sidecarModule: Module = { lastInvalidationTimestamp: 2002 };
      const virtualModule: Module = { lastInvalidationTimestamp: 2003 };
      const modules = new Map<string, Module>([
        [fixture.entryPath, ownerModule]
      ]);

      const getModuleById = vi.fn((moduleId: string) => modules.get(moduleId));
      const invalidateModule = vi.fn();

      try {
        const babelTransformSpy = await spyOnSourceBabelTransform();
        const harness = await createViteHarness({
          configOverrides: {
            command: "serve",
            mode: "development",
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          },
          server: {
            moduleGraph: {
              getModuleById,
              invalidateModule
            }
          }
        });

        const redArtifact = await transformImportedCssPropToVirtualCss(
          harness,
          fixture.entryPath,
          fixture.entrySource
        );

        modules.set(redArtifact.extractedId, sidecarModule);
        modules.set(redArtifact.resolvedVirtualId, virtualModule);

        await fs.promises.writeFile(
          fixture.stylesPath,
          createImportedStyleSource("blue")
        );
        await harness.transform(
          fixture.stylesPath,
          await fs.promises.readFile(fixture.stylesPath, "utf8")
        );

        expect(invalidateModule).toHaveBeenCalledWith(ownerModule);
        expect(invalidateModule).toHaveBeenCalledWith(sidecarModule);
        expect(invalidateModule).toHaveBeenCalledWith(virtualModule);
        expect(ownerModule.lastHMRTimestamp).toBe(2001);
        expect(await harness.load(redArtifact.extractedId)).toBeNull();
        expect(await harness.load(redArtifact.resolvedVirtualId)).toBeNull();

        const blueArtifact = await transformImportedCssPropToVirtualCss(
          harness,
          fixture.entryPath,
          fixture.entrySource
        );

        modules.set(blueArtifact.extractedId, sidecarModule);
        modules.set(blueArtifact.resolvedVirtualId, virtualModule);

        expect(blueArtifact.virtualCss).toContain("color: blue;");

        babelTransformSpy.mockResolvedValue(
          createBabelTransformFixture({
            code: "export const App = () => null;",
            result: ["", ""],
            staticCssEval: undefined
          })
        );
        await harness.transform(
          fixture.entryPath,
          "export const App = () => null;"
        );

        invalidateModule.mockClear();
        await harness.transform(
          fixture.stylesPath,
          await fs.promises.readFile(fixture.stylesPath, "utf8")
        );

        expect(invalidateModule).not.toHaveBeenCalled();
        expect(await harness.load(blueArtifact.resolvedVirtualId)).toContain(
          "color: blue;"
        );
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("supplies Vite canonical resolver fields to the static css eval source provider", async () => {
      const fixture = await createImportedCssPropViteFixture(
        "jsx-css-prop-provider-canonical-"
      );

      const captured: {
        loadedSource?: StaticCssEvalLoadedSource | null;
        resolution?: StaticCssEvalSourceResolution | null;
      } = {};

      try {
        const integrationModule = await import("@mincho-js/integration");
        vi.spyOn(integrationModule, "babelTransformSource").mockImplementation(
          async ({
            babel: options = {}
          }: Parameters<typeof babelTransformSource>[0]) => {
            const sourceProvider = (options as BabelOptions | undefined)
              ?.staticCssEvalSourceProvider;

            if (!sourceProvider) {
              throw new Error("Expected Vite static css eval source provider");
            }

            captured.resolution = await sourceProvider.resolve(
              fixture.entryPath,
              "./styles"
            );

            if (!captured.resolution?.normalizedPathKey) {
              throw new Error("Expected canonical Vite source resolution");
            }

            captured.loadedSource = await sourceProvider.load(
              captured.resolution.normalizedPathKey
            );

            return createBabelTransformFixture({
              code: fixture.entrySource,
              result: ["", ""],
              staticCssEval: {
                dependencyFiles: [
                  captured.resolution.resolvedFile ??
                    captured.resolution.id ??
                    captured.resolution.normalizedPathKey
                ]
              }
            });
          }
        );

        const harness = await createViteHarness({
          configOverrides: {
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          },

          resolve(source) {
            return source === "./styles"
              ? { id: `/@fs${fixture.stylesPath}?import#hmr` }
              : null;
          }
        });

        await harness.transform(fixture.entryPath, fixture.entrySource);

        const stylesRealpath = normalizePath(
          await fs.promises.realpath(fixture.stylesPath)
        );

        const resolution = captured.resolution;
        const loadedSource = captured.loadedSource;

        if (!resolution || !loadedSource) {
          throw new Error(
            "Expected captured Vite static css provider metadata"
          );
        }

        expect(resolution).toMatchObject({
          id: stylesRealpath,
          resolvedFile: stylesRealpath,
          canonicalModuleId: stylesRealpath,
          normalizedPathKey: stylesRealpath,
          realpath: stylesRealpath,
          sourceIdentity: {
            sourceHash: expect.stringMatching(/^mtime:/)
          },
          resolverKind: "vite"
        });
        expect(loadedSource).toMatchObject({
          sourceText: fixture.styleSource,
          resolvedFile: stylesRealpath,
          canonicalModuleId: stylesRealpath,
          normalizedPathKey: stylesRealpath,
          realpath: stylesRealpath,
          sourceIdentity: {
            sourceHash: expect.stringMatching(/^mtime:/)
          },
          resolverKind: "vite"
        });
        expect(harness.watchFiles).toContain(stylesRealpath);
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("supplies Vite package data virtual and unsupported source records to static css eval", async () => {
      const fixture = await createJsxCssPropViteFixture(
        "static-css-eval-provider-package-data-virtual-",
        `
          import { button } from "@pkg/styles";
          import { token } from "@pkg/styles/styles.json";
          import rawTokens from "@pkg/styles/tokens.css?raw";
          import textToken from "@pkg/styles/token.txt?text";
          import assetUrl from "@pkg/styles/asset.svg?url";
          import wasmUrl from "@pkg/styles/icon.wasm?url";
          import initWasm from "@pkg/styles/icon.wasm?init";
          import { virtualButton } from "virtual:mincho-test-styles";
          import { externalButton } from "@pkg/external";

          function App() {
            return <>
              <div css={button} />
              <div css={token} />
              <div css={rawTokens} />
              <div css={textToken} />
              <div css={assetUrl} />
              <div css={wasmUrl} />
              <div css={initWasm} />
              <div css={virtualButton} />
              <div css={externalButton} />
            </>;
          }

          export { App };
        `
      );

      const packageRoot = join(fixture.root, "node_modules/@pkg/styles");
      const packageIndexPath = join(packageRoot, "index.ts");
      const packageJsonPath = join(packageRoot, "styles.json");
      const rawTokensPath = join(packageRoot, "tokens.css");
      const textTokenPath = join(packageRoot, "token.txt");
      const assetPath = join(packageRoot, "asset.svg");
      const wasmPath = join(packageRoot, "icon.wasm");
      const virtualId = "\0virtual:mincho-test-styles";
      const captured: {
        loaded: Record<string, StaticCssEvalLoadedSource | null | undefined>;
        resolved: Record<
          string,
          StaticCssEvalSourceResolution | null | undefined
        >;
      } = { loaded: {}, resolved: {} };

      try {
        const integrationModule = await import("@mincho-js/integration");
        await fs.promises.mkdir(packageRoot, { recursive: true });
        await fs.promises.writeFile(
          packageIndexPath,
          'export const button = { color: "red" } as const;',
          "utf8"
        );
        await fs.promises.writeFile(
          packageJsonPath,
          JSON.stringify({ token: { color: "green" } }),
          "utf8"
        );
        await fs.promises.writeFile(
          rawTokensPath,
          ".token { color: blue; }",
          "utf8"
        );
        await fs.promises.writeFile(textTokenPath, "purple", "utf8");
        await fs.promises.writeFile(assetPath, "<svg></svg>", "utf8");
        await fs.promises.writeFile(wasmPath, "wasm-init", "utf8");

        vi.spyOn(integrationModule, "babelTransformSource").mockImplementation(
          async ({
            babel: options = {}
          }: Parameters<typeof babelTransformSource>[0]) => {
            const sourceProvider = options.staticCssEvalSourceProvider;

            if (!sourceProvider) {
              throw new Error("Expected Vite static css eval source provider");
            }

            const importPaths = [
              "@pkg/styles",
              "@pkg/styles/styles.json",
              "@pkg/styles/tokens.css?raw",
              "@pkg/styles/token.txt?text",
              "@pkg/styles/asset.svg?url",
              "@pkg/styles/icon.wasm?url",
              "@pkg/styles/icon.wasm?init",
              "virtual:mincho-test-styles",
              "@pkg/external"
            ] as const;

            for (const importPath of importPaths) {
              const resolution = await sourceProvider.resolve(
                fixture.entryPath,
                importPath
              );

              captured.resolved[importPath] = resolution;
              captured.loaded[importPath] = resolution?.normalizedPathKey
                ? await sourceProvider.load(resolution.normalizedPathKey)
                : undefined;
            }

            return createBabelTransformFixture({
              code: fixture.source,
              result: ["", ""]
            });
          }
        );

        const virtualTransform = vi.fn(async (id: string) =>
          id === virtualId
            ? {
                code: 'export const virtualButton = { color: "blue" } as const;'
              }
            : null
        );

        const harness = await createViteHarness({
          configOverrides: {
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          },

          resolve(source) {
            if (source === "@pkg/styles") {
              return { id: `/@fs${packageIndexPath}?import` };
            }
            if (source === "@pkg/styles/styles.json") {
              return { id: `/@fs${packageJsonPath}?import` };
            }
            if (source === "@pkg/styles/tokens.css?raw") {
              return { id: `/@fs${rawTokensPath}?raw` };
            }
            if (source === "@pkg/styles/token.txt?text") {
              return { id: `/@fs${textTokenPath}?text` };
            }
            if (source === "@pkg/styles/asset.svg?url") {
              return { id: `/@fs${assetPath}?url` };
            }
            if (source === "@pkg/styles/icon.wasm?url") {
              return { id: `/@fs${wasmPath}?url` };
            }
            if (source === "@pkg/styles/icon.wasm?init") {
              return { id: `/@fs${wasmPath}?init` };
            }
            if (source === "virtual:mincho-test-styles") {
              return { id: virtualId };
            }
            if (source === "@pkg/external") {
              return { id: source, external: true };
            }

            return null;
          },

          server: {
            moduleGraph: {
              getModuleById: () => undefined,

              invalidateModule: vi.fn()
            },
            pluginContainer: {
              load: virtualTransform,

              transform: async (code) => ({ code })
            }
          }
        });

        await harness.transform(fixture.entryPath, fixture.source);

        const packageRealpath = normalizePath(
          await fs.promises.realpath(packageIndexPath)
        );

        const jsonRealpath = normalizePath(
          await fs.promises.realpath(packageJsonPath)
        );

        const rawRealpath = normalizePath(
          await fs.promises.realpath(rawTokensPath)
        );

        const textRealpath = normalizePath(
          await fs.promises.realpath(textTokenPath)
        );

        const assetRealpath = normalizePath(
          await fs.promises.realpath(assetPath)
        );

        const wasmRealpath = normalizePath(
          await fs.promises.realpath(wasmPath)
        );

        const assetUrl = "/node_modules/@pkg/styles/asset.svg";
        const wasmUrl = "/node_modules/@pkg/styles/icon.wasm";

        expect(captured.resolved["@pkg/styles"]).toMatchObject({
          resolvedFile: packageRealpath,
          normalizedPathKey: packageRealpath,
          realpath: packageRealpath,
          sourceKind: "package-source",
          sourceOrigin: "package",
          watchFiles: [packageRealpath],
          resolverKind: "vite"
        });
        expect(captured.loaded["@pkg/styles"]).toMatchObject({
          sourceText: 'export const button = { color: "red" } as const;',
          resolvedFile: packageRealpath,
          sourceKind: "package-source",
          sourceOrigin: "package",
          watchFiles: [packageRealpath],
          resolverKind: "vite"
        });
        expect(captured.resolved["@pkg/styles/styles.json"]).toMatchObject({
          resolvedFile: `${jsonRealpath}?import`,
          normalizedPathKey: `${jsonRealpath}?import`,
          realpath: jsonRealpath,
          sourceKind: "static-data",
          sourceOrigin: "data",
          watchFiles: [jsonRealpath]
        });
        expect(captured.loaded["@pkg/styles/styles.json"]).toMatchObject({
          sourceText: JSON.stringify({ token: { color: "green" } }),
          sourceKind: "static-data",
          sourceOrigin: "data",
          watchFiles: [jsonRealpath]
        });
        expect(captured.resolved["@pkg/styles/tokens.css?raw"]).toMatchObject({
          resolvedFile: `${rawRealpath}?raw`,
          normalizedPathKey: `${rawRealpath}?raw`,
          realpath: rawRealpath,
          sourceKind: "static-data",
          sourceOrigin: "data",
          watchFiles: [rawRealpath]
        });
        expect(captured.resolved["@pkg/styles/token.txt?text"]).toMatchObject({
          resolvedFile: `${textRealpath}?text`,
          normalizedPathKey: `${textRealpath}?text`,
          realpath: textRealpath,
          sourceKind: "static-data",
          sourceOrigin: "data",
          watchFiles: [textRealpath]
        });
        expect(captured.loaded["@pkg/styles/token.txt?text"]).toMatchObject({
          sourceText: `export default "purple";\n`,
          sourceKind: "static-data",
          sourceOrigin: "data",
          watchFiles: [textRealpath]
        });
        expect(captured.resolved["@pkg/styles/asset.svg?url"]).toMatchObject({
          resolvedFile: `${assetRealpath}?url`,
          normalizedPathKey: `${assetRealpath}?url`,
          realpath: assetRealpath,
          sourceKind: "static-data",
          sourceOrigin: "data",
          watchFiles: [assetRealpath]
        });
        expect(captured.loaded["@pkg/styles/asset.svg?url"]).toMatchObject({
          sourceText: `export default ${JSON.stringify(assetUrl)};\n`,
          sourceKind: "static-data",
          sourceOrigin: "data",
          watchFiles: [assetRealpath]
        });
        expect(captured.resolved["@pkg/styles/icon.wasm?url"]).toMatchObject({
          resolvedFile: `${wasmRealpath}?url`,
          normalizedPathKey: `${wasmRealpath}?url`,
          realpath: wasmRealpath,
          sourceKind: "static-data",
          sourceOrigin: "data",
          watchFiles: [wasmRealpath]
        });
        expect(captured.loaded["@pkg/styles/icon.wasm?url"]).toMatchObject({
          sourceText: `export default ${JSON.stringify(wasmUrl)};\n`,
          sourceKind: "static-data",
          sourceOrigin: "data",
          watchFiles: [wasmRealpath]
        });
        expect(captured.resolved["@pkg/styles/icon.wasm?init"]).toMatchObject({
          resolvedFile: `${wasmRealpath}?init`,
          normalizedPathKey: `${wasmRealpath}?init`,
          realpath: wasmRealpath,
          sourceKind: "static-data",
          sourceOrigin: "data",
          watchFiles: [wasmRealpath]
        });
        expect(captured.resolved["virtual:mincho-test-styles"]).toMatchObject({
          resolvedFile: virtualId,
          canonicalModuleId: virtualId,
          normalizedPathKey: virtualId,
          sourceKind: "provider-virtual",
          sourceOrigin: "provider"
        });
        expect(captured.loaded["virtual:mincho-test-styles"]).toMatchObject({
          sourceText:
            'export const virtualButton = { color: "blue" } as const;',
          sourceKind: "provider-virtual",
          sourceOrigin: "provider"
        });
        expect(virtualTransform).toHaveBeenCalledWith(virtualId);
        expect(captured.resolved["@pkg/external"]).toMatchObject({
          resolvedFile: "external:mincho-static-css-eval:%40pkg%2Fexternal",
          sourceKind: "external-no-source",
          sourceOrigin: "external",
          unsupportedReason: "external-no-source"
        });
        expect(captured.loaded["@pkg/external"]).toBeNull();
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("statically evaluates Vite static css eval package url wasm and provider virtual css prop imports", async () => {
      const fixture = await createJsxCssPropViteFixture(
        "static-css-eval-package-virtual-transform-",
        `
          import defaultButton, { button } from "@pkg/styles";
          import * as styles from "@pkg/styles";
          import assetUrl from "@pkg/styles/asset.svg?url";
          import wasmUrl from "@pkg/styles/icon.wasm?url";
          import { virtualButton } from "virtual:mincho-test-styles";

          function App() {
            return <>
              <div css={button} />
              <div css={defaultButton} />
              <div css={styles.card} />
              <div css={assetUrl} />
              <div css={wasmUrl} />
              <div css={virtualButton} />
            </>;
          }

          export { App };
        `
      );

      const packageRoot = join(fixture.root, "node_modules/@pkg/styles");
      const packageIndexPath = join(packageRoot, "index.ts");
      const assetPath = join(packageRoot, "asset.svg");
      const wasmPath = join(packageRoot, "icon.wasm");
      const virtualId = "\0virtual:mincho-test-styles";

      try {
        await fs.promises.mkdir(packageRoot, { recursive: true });
        await fs.promises.writeFile(
          packageIndexPath,
          `
            export const button = { color: "red" } as const;
            export const card = { color: "green" } as const;
            export default { color: "orange" } as const;
          `,
          "utf8"
        );
        await fs.promises.writeFile(assetPath, "<svg></svg>", "utf8");
        await fs.promises.writeFile(wasmPath, "wasm-binary", "utf8");
        await spyOnSourceBabelTransform();

        const harness = await createViteHarness({
          configOverrides: {
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          },

          resolve(source) {
            if (source === "@pkg/styles") {
              return { id: `/@fs${packageIndexPath}?import` };
            }
            if (source === "@pkg/styles/asset.svg?url") {
              return { id: `/@fs${assetPath}?url` };
            }
            if (source === "@pkg/styles/icon.wasm?url") {
              return { id: `/@fs${wasmPath}?url` };
            }
            if (source === "virtual:mincho-test-styles") {
              return { id: virtualId };
            }

            return null;
          },

          server: {
            moduleGraph: {
              getModuleById: () => undefined,

              invalidateModule: vi.fn()
            },
            pluginContainer: {
              async load(id) {
                return id === virtualId
                  ? {
                      code: 'export const virtualButton = { color: "blue" } as const;'
                    }
                  : null;
              },

              transform: async (code) => ({ code })
            }
          }
        });

        const artifact = await transformImportedCssPropToVirtualCss(
          harness,
          fixture.entryPath,
          fixture.source
        );

        expect(artifact.virtualCss).toContain("color: red;");
        expect(artifact.virtualCss).toContain("color: orange;");
        expect(artifact.virtualCss).toContain("color: green;");
        expect(artifact.virtualCss).not.toContain("<svg></svg>");
        expect(artifact.virtualCss).not.toContain("wasm-binary");
        expect(artifact.virtualCss).toContain("color: blue;");
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("registers dependency files for successful imported evaluations", async () => {
      const supportedFixture = await createImportedCssPropViteFixture(
        "jsx-css-prop-imported-watch-supported-"
      );

      try {
        await spyOnSourceBabelTransform();

        const supportedHarness = await createViteHarness({
          configOverrides: {
            root: supportedFixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          }
        });

        await transformImportedCssPropToVirtualCss(
          supportedHarness,
          supportedFixture.entryPath,
          supportedFixture.entrySource
        );

        expect(supportedHarness.watchFiles).toContain(
          normalizePath(await fs.promises.realpath(supportedFixture.stylesPath))
        );
      } finally {
        await fs.promises.rm(supportedFixture.root, {
          force: true,
          recursive: true
        });
      }
    });

    it("registers direct re-export dependency metadata without re-deriving provenance", async () => {
      const fixture = await createImportedCssPropViteFixture(
        "jsx-css-prop-imported-watch-reexport-",
        {
          entrySource: createImportedCssPropEntrySource("./barrel")
        }
      );

      const barrelPath = join(fixture.srcRoot, "barrel.ts");
      const buttonPath = join(fixture.srcRoot, "button.ts");

      try {
        const integrationModule = await import("@mincho-js/integration");
        await fs.promises.writeFile(
          barrelPath,
          'export { button } from "./button";'
        );
        await fs.promises.writeFile(
          buttonPath,
          'export const button = { color: "red" } as const;'
        );

        const barrelRealpath = normalizePath(
          await fs.promises.realpath(barrelPath)
        );

        const buttonRealpath = normalizePath(
          await fs.promises.realpath(buttonPath)
        );

        vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue(
          createBabelTransformFixture({
            code: fixture.entrySource,
            result: ["", ""],
            staticCssEval: {
              dependencyFiles: [barrelRealpath],
              dependencies: [
                { file: barrelRealpath, kind: "reexported" },
                { file: buttonRealpath, kind: "reexported" }
              ],
              resolvedDependencies: [
                {
                  resolvedFile: barrelRealpath,
                  canonicalModuleId: `/@fs${barrelRealpath}?import`,
                  normalizedPathKey: barrelRealpath
                },
                {
                  resolvedFile: buttonRealpath,
                  canonicalModuleId: `ssr:/@fs${buttonRealpath}?import`,
                  normalizedPathKey: buttonRealpath
                }
              ],
              cacheKeys: [
                {
                  resolvedFile: buttonRealpath,
                  resolvedId: `/@fs${buttonRealpath}?import`
                }
              ],
              resolvedModuleIds: [
                `/@fs${barrelRealpath}?import`,
                `ssr:/@fs${buttonRealpath}?import`
              ]
            }
          })
        );

        const harness = await createViteHarness({
          configOverrides: {
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          }
        });

        await harness.transform(fixture.entryPath, fixture.entrySource);

        expect(new Set(harness.watchFiles)).toEqual(
          new Set([barrelRealpath, buttonRealpath])
        );
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("refreshes export-star namespace member watch dependencies when leaf and barrel targets change", async () => {
      const fixture = await createImportedCssPropViteFixture(
        "jsx-css-prop-imported-export-star-namespace-watch-",
        {
          entrySource: createNamespaceCssPropEntrySource()
        }
      );

      const barrelPath = join(fixture.srcRoot, "barrel.ts");
      const buttonPath = join(fixture.srcRoot, "button.ts");
      const primaryButtonPath = join(fixture.srcRoot, "primaryButton.ts");

      try {
        await spyOnSourceBabelTransform();
        await fs.promises.writeFile(barrelPath, 'export * from "./button";');
        await fs.promises.writeFile(
          buttonPath,
          'export const button = { primary: { color: "red" } } as const;'
        );
        await fs.promises.writeFile(
          primaryButtonPath,
          'export const button = { primary: { color: "green" } } as const;'
        );

        const harness = await createViteHarness({
          configOverrides: {
            command: "serve",
            mode: "development",
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          }
        });

        const barrelRealpath = normalizePath(
          await fs.promises.realpath(barrelPath)
        );

        const buttonRealpath = normalizePath(
          await fs.promises.realpath(buttonPath)
        );

        const primaryButtonRealpath = normalizePath(
          await fs.promises.realpath(primaryButtonPath)
        );

        const redArtifact = await transformImportedCssPropToVirtualCss(
          harness,
          fixture.entryPath,
          fixture.entrySource
        );

        expect(redArtifact.virtualCss).toContain("color: red;");
        expect(new Set(harness.watchFiles)).toEqual(
          new Set([barrelRealpath, buttonRealpath])
        );

        await fs.promises.writeFile(
          buttonPath,
          'export const button = { primary: { color: "blue" } } as const;'
        );
        await harness.transform(
          buttonPath,
          await fs.promises.readFile(buttonPath, "utf8")
        );

        expect(await harness.load(redArtifact.resolvedVirtualId)).toBeNull();

        harness.watchFiles.length = 0;

        const blueArtifact = await transformImportedCssPropToVirtualCss(
          harness,
          fixture.entryPath,
          fixture.entrySource
        );

        expect(blueArtifact.virtualCss).toContain("color: blue;");
        expect(new Set(harness.watchFiles)).toEqual(
          new Set([barrelRealpath, buttonRealpath])
        );

        await fs.promises.writeFile(
          barrelPath,
          'export * from "./primaryButton";'
        );
        await harness.transform(
          barrelPath,
          await fs.promises.readFile(barrelPath, "utf8")
        );

        expect(await harness.load(blueArtifact.resolvedVirtualId)).toBeNull();

        const greenArtifact = await transformImportedCssPropToVirtualCss(
          harness,
          fixture.entryPath,
          fixture.entrySource
        );

        expect(greenArtifact.virtualCss).toContain("color: green;");
        expect(new Set(harness.watchFiles)).toEqual(
          new Set([barrelRealpath, buttonRealpath, primaryButtonRealpath])
        );

        await harness.transform(
          buttonPath,
          await fs.promises.readFile(buttonPath, "utf8")
        );

        expect(await harness.load(greenArtifact.resolvedVirtualId)).toContain(
          "color: green;"
        );
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it.each(["provider", "transform", "disk"])(
      "keeps file source observations stable and detects changes from the %s",
      async (origin: string) => {
        const fixture = await createImportedCssPropViteFixture(
          "cjs-source-origins-",
          {
            entrySource:
              'const styles = require("./styles"); export const value = styles.value;',
            styleSource: 'exports.value = "red";'
          }
        );

        try {
          await spyOnSourceBabelTransform();

          const otherOwner = join(fixture.srcRoot, "other.ts");
          const ownerModule = {};
          const otherModule = {};
          const invalidateModule = vi.fn();
          const harness = await createViteHarness({
            configOverrides: {
              command: "serve",
              mode: "development",
              root: fixture.root
            },

            resolve(id) {
              return id === "./styles" ? { id: fixture.stylesPath } : null;
            },

            server: {
              moduleGraph: {
                getModuleById(id) {
                  if (id === fixture.entryPath) return ownerModule;
                  if (id === otherOwner) return otherModule;
                },

                invalidateModule
              }
            }
          });

          // An earlier plugin changes the transform input; the provider reads disk.
          const transformInput = `// earlier plugin\n${fixture.styleSource}`;
          await harness.transform(fixture.entryPath, fixture.entrySource);

          for (const owner of [
            fixture.entryPath,
            otherOwner,
            fixture.entryPath,
            otherOwner
          ]) {
            await harness.transform(fixture.stylesPath, transformInput);
            const code = extractViteTransformCode(
              await harness.transform(owner, fixture.entrySource),
              "Expected CommonJS owner normalization"
            );

            expect(code).toContain("_cjsImport.default");
          }

          expect(invalidateModule).not.toHaveBeenCalled();

          if (origin !== "transform") {
            await fs.promises.writeFile(
              fixture.stylesPath,
              'exports.value = "blue";'
            );
            if (origin === "disk")
              await harness.transform(fixture.stylesPath, transformInput);
            else
              await harness.transform(fixture.entryPath, fixture.entrySource);
          } else {
            await harness.transform(
              fixture.stylesPath,
              transformInput.replace("red", "blue")
            );
          }

          expect(invalidateModule.mock.calls.flat()).toContain(otherModule);

          invalidateModule.mockClear();
          await harness.transform(otherOwner, fixture.entrySource);
          expect(invalidateModule).not.toHaveBeenCalled();
        } finally {
          await fs.promises.rm(fixture.root, { force: true, recursive: true });
        }
      }
    );

    it.each(["virtual:styles.js", "\0virtual:styles.js"])(
      "keeps source observations stable when loading %s repeatedly",
      async (virtualId: string) => {
        await spyOnSourceBabelTransform();

        const source = `const styles = require(${JSON.stringify(virtualId)}); export const value = styles.value;`;
        let virtualSource = 'exports.value = "red";';
        const otherOwner = join(viteConsumerRootPath, "src/other.ts");
        const ownerModule = {};
        const otherModule = {};
        const invalidateModule = vi.fn();
        const transformedSources: string[] = [];
        const harness = await createViteHarness({
          configOverrides: { command: "serve", mode: "development" },

          resolve(id) {
            return id === virtualId ? { id } : null;
          },

          server: {
            moduleGraph: {
              getModuleById(id) {
                if (id === viteConsumerEntryPath) return ownerModule;
                if (id === otherOwner) return otherModule;
              },

              invalidateModule
            },
            pluginContainer: {
              async load(id) {
                return id === virtualId ? { code: virtualSource } : null;
              },

              async transform(code, id) {
                const result = await harness.transform(id, code);
                const transformed = result
                  ? extractViteTransformCode(result, "Expected virtual source")
                  : code;
                transformedSources.push(transformed);

                return { code: transformed };
              }
            }
          }
        });

        for (const owner of [
          viteConsumerEntryPath,
          otherOwner,
          viteConsumerEntryPath,
          otherOwner
        ]) {
          const code = extractViteTransformCode(
            await harness.transform(owner, source),
            "Expected CommonJS owner normalization"
          );

          // The evaluator still receives the provider's transformed source.
          expect(code.includes("_cjsImport.default")).toBe(
            virtualId.startsWith("\0")
          );
        }

        expect(transformedSources.length).toBeGreaterThan(0);
        if (!virtualId.startsWith("\0"))
          expect(transformedSources[0]).toContain("export default");
        expect(invalidateModule).not.toHaveBeenCalled();

        virtualSource = 'exports.value = "blue";';
        await harness.transform(virtualId, virtualSource);
        await harness.transform(viteConsumerEntryPath, source);

        expect(invalidateModule.mock.calls.flat()).toContain(otherModule);
        expect(transformedSources[transformedSources.length - 1]).toContain(
          '"blue"'
        );

        invalidateModule.mockClear();
        await harness.transform(otherOwner, source);
        expect(invalidateModule).not.toHaveBeenCalled();
      }
    );

    it("invalidates CommonJS require css prop dependencies from integration metadata", async () => {
      const fixture = await createImportedCssPropViteFixture(
        "jsx-css-prop-cjs-require-watch-",
        {
          entrySource: `
            const styles = require("./styles");

            function App() {
              return <div css={styles.button} />;
            }

            export { App };
          `,
          styleSource: `exports.button = { color: "red" };`
        }
      );

      try {
        await spyOnSourceBabelTransform();

        const harness = await createViteHarness({
          configOverrides: {
            command: "serve",
            mode: "development",
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          }
        });

        const stylesRealpath = normalizePath(
          await fs.promises.realpath(fixture.stylesPath)
        );

        const redArtifact = await transformImportedCssPropToVirtualCss(
          harness,
          fixture.entryPath,
          fixture.entrySource
        );

        expect(redArtifact.virtualCss).toContain("color: red;");
        expect(new Set(harness.watchFiles)).toEqual(new Set([stylesRealpath]));

        await fs.promises.writeFile(
          fixture.stylesPath,
          `exports.button = { color: "blue" };`
        );
        await harness.transform(
          fixture.stylesPath,
          await fs.promises.readFile(fixture.stylesPath, "utf8")
        );

        expect(await harness.load(redArtifact.resolvedVirtualId)).toBeNull();

        const blueArtifact = await transformImportedCssPropToVirtualCss(
          harness,
          fixture.entryPath,
          fixture.entrySource
        );

        expect(blueArtifact.virtualCss).toContain("color: blue;");
        expect(new Set(harness.watchFiles)).toEqual(new Set([stylesRealpath]));
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("registers whole namespace export-star watch metadata from Babel integration", async () => {
      const fixture = await createImportedCssPropViteFixture(
        "jsx-css-prop-whole-namespace-export-star-watch-",
        {
          entrySource: createNamespaceCssPropEntrySource("./barrel", "styles")
        }
      );

      const barrelPath = join(fixture.srcRoot, "barrel.ts");
      const resetPath = join(fixture.srcRoot, "reset.ts");
      const buttonPath = join(fixture.srcRoot, "button.ts");

      try {
        const integrationModule = await import("@mincho-js/integration");
        await fs.promises.writeFile(
          barrelPath,
          'export { default } from "./reset"; export * from "./button";'
        );
        await fs.promises.writeFile(
          resetPath,
          "export default { margin: 0 } as const;"
        );
        await fs.promises.writeFile(
          buttonPath,
          'export const button = { color: "red" } as const;'
        );

        const barrelRealpath = normalizePath(
          await fs.promises.realpath(barrelPath)
        );

        const resetRealpath = normalizePath(
          await fs.promises.realpath(resetPath)
        );

        const buttonRealpath = normalizePath(
          await fs.promises.realpath(buttonPath)
        );

        const transformResult: BabelTransformResult =
          createBabelTransformFixture({
            code: fixture.entrySource,
            result: ["", ""],
            staticCssEval: createExportStarStaticCssEvalMetadata({
              barrelPath: barrelRealpath,
              explicitDefaultPath: resetRealpath,
              terminalLeafPath: buttonRealpath
            })
          });

        vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue(
          transformResult
        );

        const harness = await createViteHarness({
          configOverrides: {
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          }
        });

        await harness.transform(fixture.entryPath, fixture.entrySource);

        expect(new Set(harness.watchFiles)).toEqual(
          new Set([barrelRealpath, resetRealpath, buttonRealpath])
        );
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("refuses virtual and third-party static css evaluation at boundaries", async () => {
      const fallbackFixture = await createJsxCssPropViteFixture(
        "jsx-css-prop-imported-boundary-fallback-",
        `
          import { button } from "virtual:styles";
          import { packageButton } from "pkg/styles";

          function App() {
            return <>
              <div css={button} />
              <div css={packageButton} />
            </>;
          }

          export { App };
        `
      );

      const staticRuleFixture = await createJsxCssPropViteFixture(
        "jsx-css-prop-imported-boundary-static-rule-",
        createImportedCssPropStaticRuleEntrySource("pkg/styles")
      );

      try {
        await spyOnSourceBabelTransform();

        const missingVirtualId = "\0virtual:styles";
        const fallbackHarness = await createViteHarness({
          configOverrides: {
            root: fallbackFixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          },

          resolve(source) {
            return source === "virtual:styles"
              ? { id: missingVirtualId }
              : null;
          },

          server: {
            moduleGraph: {
              getModuleById: () => undefined,

              invalidateModule: vi.fn()
            },
            pluginContainer: {
              load: vi.fn(async () => null),

              transform: async (code) => ({ code })
            }
          }
        });

        await expect(
          fallbackHarness.transform(
            fallbackFixture.entryPath,
            fallbackFixture.source
          )
        ).rejects.toThrow(
          "Cannot statically evaluate css prop value: provider virtual module"
        );

        expect(fallbackHarness.watchFiles).toEqual([]);

        const staticRuleHarness = await createViteHarness({
          configOverrides: {
            root: staticRuleFixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          }
        });

        await expect(
          staticRuleHarness.transform(
            staticRuleFixture.entryPath,
            staticRuleFixture.source
          )
        ).rejects.toThrow("Cannot statically evaluate css prop value");

        expect(staticRuleHarness.watchFiles).toEqual([]);
      } finally {
        await Promise.all([
          fs.promises.rm(fallbackFixture.root, {
            force: true,
            recursive: true
          }),
          fs.promises.rm(staticRuleFixture.root, {
            force: true,
            recursive: true
          })
        ]);
      }
    });

    it("clears stale generated CSS when a project-local dependency disappears", async () => {
      const fixture = await createImportedCssPropViteFixture(
        "jsx-css-prop-imported-deleted-dependency-"
      );

      try {
        await spyOnSourceBabelTransform();

        const harness = await createViteHarness({
          configOverrides: {
            command: "serve",
            mode: "development",
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          }
        });

        const redArtifact = await transformImportedCssPropToVirtualCss(
          harness,
          fixture.entryPath,
          fixture.entrySource
        );

        expect(redArtifact.virtualCss).toContain("color: red;");

        await fs.promises.rm(fixture.stylesPath, { force: true });
        await harness.transform(fixture.stylesPath, "");

        expect(await harness.load(redArtifact.extractedId)).toBeNull();
        expect(await harness.load(redArtifact.resolvedVirtualId)).toBeNull();
        await expect(
          harness.transform(fixture.entryPath, fixture.entrySource)
        ).rejects.toThrow('import "./styles" could not be resolved');

        expect(await harness.load(redArtifact.extractedId)).toBeNull();
        expect(await harness.load(redArtifact.resolvedVirtualId)).toBeNull();
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("lowers v2 class-value component and pre-css spread css props before React JSX handling", async () => {
      const fixture = await createJsxCssPropViteFixture(
        "jsx-css-prop-v2-class-value-",
        createJsxCssPropV2ClassValueFixtureSource()
      );

      try {
        const babelTransformSpy = await spyOnSourceBabelTransform();
        const harness = await createViteHarness({
          configOverrides: {
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          }
        });

        const transformedEntry = extractViteTransformCode(
          await harness.transform(fixture.entryPath, fixture.source),
          "Expected v2 class-value css-prop entry transform to return code"
        );

        const cxIdentifier = extractCxIdentifierFromSource(transformedEntry);

        expect(babelTransformSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filename: fixture.entryPath,
            source: fixture.source,
            babel: expect.objectContaining({
              jsxCssProp: true,
              staticCssEvalSourceProvider: expect.any(Object)
            })
          })
        );
        expect(transformedEntry).not.toContain(" css=");
        expect(transformedEntry).not.toContain("css={styleA}");
        expect(transformedEntry).not.toContain("css={styleB}");
        expect(transformedEntry).not.toContain("css(styleA)");
        expect(transformedEntry).not.toContain("_css(styleA)");

        expectSourceToContainV2ClassValueCssPropLowering(
          transformedEntry,
          cxIdentifier
        );
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("preserves downstream transforms when enabled jsx css prop processing is unused", async () => {
      const fixture = await createJsxCssPropViteFixture(
        "jsx-css-prop-unused-",
        `
          function App() {
            return <div className="base" />;
          }

          export { App };
        `
      );

      try {
        const babelTransformSpy = await spyOnSourceBabelTransform();
        const harness = await createViteHarness({
          configOverrides: {
            root: fixture.root
          },
          pluginOptions: {
            jsxCssProp: true
          }
        });

        await expect(
          harness.transform(fixture.entryPath, fixture.source)
        ).resolves.toBeNull();

        expect(babelTransformSpy).toHaveBeenCalledTimes(1);
        expect(babelTransformSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filename: fixture.entryPath,
            source: fixture.source,
            babel: expect.objectContaining({
              jsxCssProp: true,
              staticCssEvalSourceProvider: expect.any(Object)
            })
          })
        );
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("leaves jsx css prop lowering disabled by default and by explicit false", async () => {
      const fixture = await createJsxCssPropViteFixture(
        "jsx-css-prop-disabled-"
      );

      const disabledCases: {
        label: string;
        pluginOptions?: MinchoVitePluginOptions;
        expectedOptions?: BabelOptions;
      }[] = [
        { label: "default" },
        {
          label: "empty optimize",
          pluginOptions: { babel: { optimize: {} } },
          expectedOptions: { optimize: {} }
        },
        {
          label: "inactive optimize",
          pluginOptions: {
            babel: { optimize: { defineRulesCxConditions: false } }
          },
          expectedOptions: { optimize: { defineRulesCxConditions: false } }
        },
        {
          label: "explicit false",
          pluginOptions: { jsxCssProp: false },
          expectedOptions: { jsxCssProp: false }
        },
        {
          label: "explicit false with optimize",
          pluginOptions: {
            babel: { optimize: { defineRulesCxConditions: true } },
            jsxCssProp: false
          },
          expectedOptions: {
            jsxCssProp: false,
            optimize: { defineRulesCxConditions: true }
          }
        }
      ];

      try {
        const babelTransformSpy = await spyOnSourceBabelTransform();

        for (const disabledCase of disabledCases) {
          const harness = await createViteHarness({
            configOverrides: {
              root: fixture.root
            },
            pluginOptions: disabledCase.pluginOptions
          });

          await expect(
            harness.transform(fixture.entryPath, fixture.source),
            disabledCase.label
          ).resolves.toBeNull();
        }

        for (const [index, disabledCase] of disabledCases.entries()) {
          expect(babelTransformSpy).toHaveBeenNthCalledWith(
            index + 1,
            expect.objectContaining({
              filename: fixture.entryPath,
              source: fixture.source,
              babel: expect.objectContaining({
                ...disabledCase.expectedOptions,
                staticCssEvalSourceProvider: expect.any(Object)
              })
            })
          );
        }

        expect(fixture.source).toContain(
          '<div className="base" css={{ color: "red" }} />'
        );
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("defineRules preset registry steps are queued in Vite extracted transforms", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const firstDeferred = createDeferred<string>();
      const secondDeferred = createDeferred<string>();
      const processOrder: string[] = [];

      vi.spyOn(integrationModule, "babelTransformSource")
        .mockResolvedValueOnce({
          code: 'import "extracted_a.css.ts";\nexport { cssA };',
          result: ["extracted_a.css.ts", "resolver contents a"]
        })
        .mockResolvedValueOnce({
          code: 'import "extracted_b.css.ts";\nexport { cssB };',
          result: ["extracted_b.css.ts", "resolver contents b"]
        });
      vi.spyOn(integrationModule, "compile").mockImplementation(
        async (options: Parameters<typeof compile>[0]) =>
          ({
            source: `compiled source:${options.filePath}`,
            watchFiles: []
          }) as Awaited<ReturnType<typeof compile>>
      );

      const registrySpy = vi
        .spyOn(integrationModule, "processDefineRulesPresetRegistryFile")
        .mockImplementation(
          async (
            options: Parameters<typeof processDefineRulesPresetRegistryFile>[0]
          ) => {
            processOrder.push(`start:${options.filePath}`);

            if (options.filePath.endsWith("extracted_a.css.ts")) {
              const result = await firstDeferred.promise;
              processOrder.push(`end:${options.filePath}`);

              return createRegistryResult(result);
            }

            const result = await secondDeferred.promise;
            processOrder.push(`end:${options.filePath}`);

            return createRegistryResult(result);
          }
        );

      const harness = await createViteHarness();
      const firstFixture = await createExtractedCssFixture(harness);
      const secondFixture = await createExtractedCssFixture(harness);
      const firstTransformPromise = harness.transform(
        firstFixture.extractedId,
        firstFixture.extractedSource
      ) as Promise<string>;

      const secondTransformPromise = harness.transform(
        secondFixture.extractedId,
        secondFixture.extractedSource
      ) as Promise<string>;

      await vi.waitFor(() => {
        expect(processOrder).toEqual([`start:${firstFixture.physicalPath}`]);
      });

      firstDeferred.resolve(createV5PresetBuildSource("provider-a_class"));

      const firstTransformResult = await firstTransformPromise;
      assertString(
        firstTransformResult,
        "Expected the first queued transform to return source text"
      );

      await vi.waitFor(() => {
        expect(processOrder).toEqual([
          `start:${firstFixture.physicalPath}`,
          `end:${firstFixture.physicalPath}`,
          `start:${secondFixture.physicalPath}`
        ]);
      });

      secondDeferred.resolve(createV5PresetBuildSource("provider-b_class"));

      const secondTransformResult = await secondTransformPromise;
      assertString(
        secondTransformResult,
        "Expected the second queued transform to return source text"
      );

      expect(processOrder).toEqual([
        `start:${firstFixture.physicalPath}`,
        `end:${firstFixture.physicalPath}`,
        `start:${secondFixture.physicalPath}`,
        `end:${secondFixture.physicalPath}`
      ]);
      expect(registrySpy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          filePath: firstFixture.physicalPath,
          identOption: "short",
          source: `compiled source:${firstFixture.physicalPath}`,
          serializeVirtualCssPath: expect.any(Function)
        })
      );
      expect(registrySpy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          filePath: secondFixture.physicalPath,
          identOption: "short",
          source: `compiled source:${secondFixture.physicalPath}`,
          serializeVirtualCssPath: expect.any(Function)
        })
      );

      expectSourceToContainPresetAtomClassName(
        firstTransformResult,
        "provider-a_class"
      );
      expectSourceToContainPresetAtomClassName(
        secondTransformResult,
        "provider-b_class"
      );

      expect(firstTransformResult).not.toContain("provider-b_class");
      expect(secondTransformResult).not.toContain("provider-a_class");
    });

    it("uses registry wrapper source for build output preset artifacts", async () => {
      const integrationModule = await import("@mincho-js/integration");

      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { css, shared };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });

      const compileResult: Awaited<ReturnType<typeof compile>> = {
        source: "compiled source",
        watchFiles: []
      };

      vi.spyOn(integrationModule, "compile").mockResolvedValue(compileResult);

      const registrySpy = vi
        .spyOn(integrationModule, "processDefineRulesPresetRegistryFile")
        .mockResolvedValue(
          createRegistryResult(createV5PresetBuildSource("shared_class"))
        );

      const harness = await createViteHarness();
      const { extractedId, extractedSource, physicalPath } =
        await createExtractedCssFixture(harness);

      const transformedExtractedCss = await harness.transform(
        extractedId,
        extractedSource
      );

      assertString(
        transformedExtractedCss,
        "Expected extracted css transform to return source text"
      );

      expect(registrySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: physicalPath,
          identOption: "short",
          source: "compiled source",
          serializeVirtualCssPath: expect.any(Function)
        })
      );
      expect(registrySpy).toHaveBeenCalledTimes(1);

      expectSourceToContainPresetAtomClassName(
        transformedExtractedCss,
        "shared_class"
      );
    });

    it("builds a real Vite fixture with defineRules preset registry artifact", async () => {
      const { build } = await import("vite");
      const { entryPath, root } = await createLivePresetSmokeFixture(
        "define-rules-vite-smoke-"
      );

      try {
        const buildResult = await build({
          root,
          configFile: false,
          logLevel: "silent",
          plugins: [
            minchoVitePlugin({ libraryCss: { fileName: "style.css" } })
          ],
          build: {
            cssMinify: false,
            emptyOutDir: false,
            lib: {
              entry: entryPath,
              fileName: "index",
              cssFileName: "style",
              formats: ["es"]
            },
            minify: false,
            write: false
          },
          resolve: {
            preserveSymlinks: true
          }
        });

        type ViteSmokeOutput =
          | { code: string; fileName: string; type: "chunk" }
          | { fileName: string; source: string | Uint8Array; type: "asset" };

        const rollupOutputs = Array.isArray(buildResult)
          ? buildResult
          : [buildResult];

        const outputFiles = rollupOutputs.flatMap((rollupOutput) => {
          const possibleRollupOutput = rollupOutput as { output?: unknown };
          if (!Array.isArray(possibleRollupOutput.output)) {
            throw new Error(
              "Expected Vite smoke build to return Rollup output"
            );
          }

          return possibleRollupOutput.output as ViteSmokeOutput[];
        });

        const jsOutput = outputFiles.find(
          (output) =>
            output.type === "chunk" && /\.(?:mjs|js)$/.test(output.fileName)
        );

        const cssOutput = outputFiles.find(
          (output) =>
            output.type === "asset" && output.fileName.endsWith(".css")
        );

        if (jsOutput?.type !== "chunk") {
          throw new Error("Expected Vite smoke build to emit an ES chunk");
        }
        if (
          cssOutput?.type !== "asset" ||
          typeof cssOutput.source !== "string"
        ) {
          throw new Error("Expected Vite smoke build to emit a CSS asset");
        }

        const fillBlueClassName = extractFillBlueClassName(jsOutput.code);
        expectSourceToContainV5RuntimePresetSeed(jsOutput.code);

        expect(jsOutput.code).not.toContain('background: "blue"');

        expectCssSourceToContainClassNames(cssOutput.source, fillBlueClassName);

        expect(cssOutput.source).toContain("background: blue;");
      } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
      }
    }, 20000);

    it("propagates non-ENOENT errors while loading virtual CSS sidecars", async () => {
      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });

      const harness = await createViteHarness();
      const fixture = await createExtractedCssFixture(harness);
      const physicalPath = `${fixture.physicalPath}.vanilla.css`;
      const resolvedVirtualId = harness.resolveId(
        `mincho-virtual-css:${physicalPath}`,
        fixture.extractedId
      );

      expect(resolvedVirtualId).toBe(`\0mincho-virtual-css:${physicalPath}`);

      if (typeof resolvedVirtualId !== "string") {
        throw new Error("Expected the trusted virtual CSS ID to resolve");
      }

      const readError = Object.assign(new Error("sidecar access denied"), {
        code: "EACCES"
      });

      vi.spyOn(fs.promises, "readFile").mockRejectedValueOnce(readError);

      await expect(harness.load(resolvedVirtualId)).rejects.toBe(readError);
    });

    it("rejects unregistered virtual CSS IDs before filesystem access", async () => {
      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });

      const harness = await createViteHarness();
      const fixture = await createExtractedCssFixture(harness);
      const readFileSpy = vi.spyOn(fs.promises, "readFile");
      const importId = "mincho-virtual-css:/etc/passwd.vanilla.css";
      const virtualId = "\0mincho-virtual-css:/etc/passwd.vanilla.css";

      expect(
        harness.resolveId(importId, "/workspace/src/entry.ts")
      ).toBeUndefined();
      expect(harness.resolveId(importId, fixture.extractedId)).toBeUndefined();
      await expect(harness.load(virtualId)).resolves.toBeNull();

      expect(readFileSpy).not.toHaveBeenCalled();
    });

    it("waits for asynchronous plugin initialization before preloading library CSS", async () => {
      const { build } = await import("vite");
      const cacheRoot = createViteFixtureCacheRoot();
      await fs.promises.mkdir(cacheRoot, { recursive: true });

      const root = await fs.promises.mkdtemp(
        join(cacheRoot, "async-css-init-")
      );

      const entryPath = join(root, "entry.css");
      await fs.promises.writeFile(entryPath, "");

      let initialized = false;
      let loadedBeforeInitialization = false;

      try {
        const result = await build({
          root,
          configFile: false,
          logLevel: "silent",
          plugins: [
            minchoVitePlugin(),
            {
              name: "async-css-compiler",
              enforce: "post",

              async buildStart() {
                await new Promise((resolve) => setTimeout(resolve, 100));
                initialized = true;
              },

              load(id) {
                if (id !== entryPath) return null;

                loadedBeforeInitialization ||= !initialized;

                return initialized ? ".ready { color: purple; }" : "";
              }
            }
          ],
          build: {
            cssCodeSplit: true,
            cssMinify: false,
            lib: { entry: entryPath, fileName: "index", formats: ["es"] },
            write: false
          }
        });

        const css = (Array.isArray(result) ? result : [result])
          .flatMap((output) => {
            if (!("output" in output)) throw new Error("Expected build output");

            return output.output;
          })
          .filter(
            (output) =>
              output.type === "asset" && output.fileName.endsWith(".css")
          )
          .map((output) =>
            output.type === "asset" ? String(output.source) : ""
          )
          .join("\n");

        expect(loadedBeforeInitialization).toBe(false);
        expect(css).toContain("color: purple;");
      } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
      }
    });

    it("preserves virtual CSS IDs across build starts", async () => {
      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });

      const harness = await createViteHarness();
      const fixture = await createExtractedCssFixture(harness);
      const physicalPath = `${fixture.physicalPath}.vanilla.css`;
      const importId = `mincho-virtual-css:${physicalPath}`;
      const resolvedVirtualId = harness.resolveId(
        importId,
        fixture.extractedId
      );

      if (typeof resolvedVirtualId !== "string") {
        throw new Error("Expected generated virtual CSS ID to resolve");
      }

      expect(await harness.load(resolvedVirtualId)).not.toBeNull();

      await harness.buildStart();

      await expect(harness.load(resolvedVirtualId)).resolves.not.toBeNull();

      expect(harness.resolveId(importId, fixture.extractedId)).toBe(
        resolvedVirtualId
      );
    });

    it("derives library sidecars from each entry graph and Vite CSS metadata", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const entryOnePath = join(viteConsumerRootPath, "sidecar-entry-one.ts");
      const entryTwoPath = join(viteConsumerRootPath, "sidecar-entry-two.ts");
      const firstOwnerPath = join(viteConsumerRootPath, "sidecar-first.ts");
      const secondOwnerPath = join(viteConsumerRootPath, "sidecar-second.ts");
      const thirdOwnerPath = join(viteConsumerRootPath, "sidecar-third.ts");
      const fixturePaths = [
        entryOnePath,
        entryTwoPath,
        firstOwnerPath,
        secondOwnerPath,
        thirdOwnerPath
      ];

      const extractedFileNameByOwner = new Map([
        [firstOwnerPath, "extracted_sidecar-first.css.ts"],
        [secondOwnerPath, "extracted_sidecar-second.css.ts"],
        [thirdOwnerPath, "extracted_sidecar-third.css.ts"]
      ]);

      const ancestorSpecifierByExtractedFileName = new Map([
        ["extracted_sidecar-first.css.ts", "@scope/first/style.css"],
        ["extracted_sidecar-second.css.ts", "@scope/second/style.css"],
        ["extracted_sidecar-third.css.ts", "@scope/third/style.css"]
      ]);

      const graph = new Map<string, { importedIds: readonly string[] }>([
        [entryOnePath, { importedIds: [firstOwnerPath, secondOwnerPath] }],
        [entryTwoPath, { importedIds: [thirdOwnerPath] }],
        [firstOwnerPath, { importedIds: [] }],
        [secondOwnerPath, { importedIds: [] }],
        [thirdOwnerPath, { importedIds: [] }]
      ]);

      vi.spyOn(integrationModule, "babelTransformSource").mockImplementation(
        async ({
          filename: filePath
        }: Parameters<typeof babelTransformSource>[0]) => {
          const extractedFileName = extractedFileNameByOwner.get(filePath);
          if (extractedFileName === undefined) {
            throw new Error(`Unexpected sidecar fixture owner: ${filePath}`);
          }

          return {
            code: `import "${extractedFileName}";`,
            result: [extractedFileName, "resolver contents"]
          };
        }
      );

      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      });
      vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      ).mockImplementation(
        async (
          options: Parameters<typeof processDefineRulesPresetRegistryFile>[0]
        ) => {
          const ancestorStyleSpecifier = [
            ...ancestorSpecifierByExtractedFileName
          ].find(([fileName]) => options.filePath.endsWith(fileName))?.[1];
          if (ancestorStyleSpecifier === undefined) {
            throw new Error(
              `Unexpected sidecar fixture extracted CSS: ${options.filePath}`
            );
          }

          if (!options.filePath.endsWith("extracted_sidecar-third.css.ts")) {
            await options.serializeVirtualCssPath?.({
              fileName: "style.css",
              fileScope: { filePath: options.filePath, packageName: "local" },
              source: ".local { color: red; }"
            });
          }

          return {
            ancestorStyleSpecifiers: [ancestorStyleSpecifier],
            registrySession: createEmptyRegistrySession(),
            source: "export const local = 'local';"
          };
        }
      );

      try {
        await Promise.all(
          fixturePaths.map((fixturePath) =>
            fs.promises.writeFile(fixturePath, "export const fixture = true;\n")
          )
        );

        const harness = await createViteHarness({
          configOverrides: {
            build: { cssCodeSplit: true, lib: {}, watch: false }
          },

          getModuleInfo: (id) => graph.get(id) ?? null
        });

        const firstFixture = await createExtractedCssFixtureFromEntry(
          harness,
          firstOwnerPath
        );

        const secondFixture = await createExtractedCssFixtureFromEntry(
          harness,
          secondOwnerPath
        );

        const thirdFixture = await createExtractedCssFixtureFromEntry(
          harness,
          thirdOwnerPath
        );

        await harness.transform(
          thirdFixture.extractedId,
          thirdFixture.extractedSource
        );
        await harness.transform(
          secondFixture.extractedId,
          secondFixture.extractedSource
        );
        await harness.transform(
          firstFixture.extractedId,
          firstFixture.extractedSource
        );

        const firstEntryChunk: OutputBundleItem = {
          code: "export const first = true;",
          facadeModuleId: entryOnePath,
          fileName: "entries/first.mjs",
          imports: ["chunks/shared.mjs"],
          isEntry: true,
          type: "chunk",
          viteMetadata: {
            importedCss: new Set(["entries/first.css"])
          }
        };

        const secondEntryChunk: OutputBundleItem = {
          code: "export const second = true;",
          facadeModuleId: entryTwoPath,
          fileName: "entries/second.mjs",
          isEntry: true,
          type: "chunk",
          viteMetadata: { importedCss: new Set() }
        };

        const sharedChunk: OutputBundleItem = {
          code: "export const shared = true;",
          facadeModuleId: null,
          fileName: "chunks/shared.mjs",
          isEntry: false,
          moduleIds: [],
          type: "chunk",
          viteMetadata: {
            importedCss: new Set(["entries/first-extra.css"])
          }
        };

        await harness.generateBundle("es", {
          "entries/first.mjs": firstEntryChunk,
          "entries/second.mjs": secondEntryChunk,
          "chunks/shared.mjs": sharedChunk,
          "entries/first.css": { fileName: "entries/first.css", type: "asset" },
          "entries/first-extra.css": {
            fileName: "entries/first-extra.css",
            type: "asset"
          }
        });

        const firstAncestor = 'import "@scope/first/style.css";';
        const secondAncestor = 'import "@scope/second/style.css";';
        const firstCss = 'import "./first.css";';
        const firstExtraCss = 'import "./first-extra.css";';

        expect(firstEntryChunk.code).toContain(firstAncestor);
        expect(firstEntryChunk.code).toContain(secondAncestor);
        expect(firstEntryChunk.code).toContain(firstCss);
        expect(firstEntryChunk.code).toContain(firstExtraCss);
        expect(firstEntryChunk.code).not.toContain("@scope/third/style.css");

        const firstAncestorIndex = firstEntryChunk.code.indexOf(firstAncestor);
        const secondAncestorIndex =
          firstEntryChunk.code.indexOf(secondAncestor);

        const firstCssIndex = firstEntryChunk.code.indexOf(firstCss);
        const firstExtraCssIndex = firstEntryChunk.code.indexOf(firstExtraCss);

        expect(firstAncestorIndex).toBeLessThan(secondAncestorIndex);
        expect(secondAncestorIndex).toBeLessThan(firstCssIndex);
        expect(firstExtraCssIndex).toBeLessThan(firstCssIndex);

        expect(secondEntryChunk.code).toContain(
          'import "@scope/third/style.css";'
        );
        expect(secondEntryChunk.code).not.toContain('import "./second.css";');
        expect(secondEntryChunk.code).not.toContain("@scope/first/style.css");
        expect(secondEntryChunk.code).not.toContain("@scope/second/style.css");

        const unsplitHarness = await createViteHarness({
          configOverrides: {
            build: { cssCodeSplit: false, lib: {}, watch: false }
          },

          getModuleInfo: (id) => graph.get(id) ?? null
        });

        const unsplitFirstFixture = await createExtractedCssFixtureFromEntry(
          unsplitHarness,
          firstOwnerPath
        );

        const unsplitThirdFixture = await createExtractedCssFixtureFromEntry(
          unsplitHarness,
          thirdOwnerPath
        );

        await unsplitHarness.transform(
          unsplitFirstFixture.extractedId,
          unsplitFirstFixture.extractedSource
        );
        await unsplitHarness.transform(
          unsplitThirdFixture.extractedId,
          unsplitThirdFixture.extractedSource
        );

        const unsplitOwnEntry: OutputBundleItem = {
          code: '#!/usr/bin/env node\r\n/* banner */\r\n\r\n"use client"; // client\r\n"use server";\r\nexport const own = true;',
          facadeModuleId: entryOnePath,
          fileName: "entries/own.mjs",
          isEntry: true,
          type: "chunk"
        };

        const unsplitInheritedEntry: OutputBundleItem = {
          code: "export const inherited = true;",
          facadeModuleId: entryTwoPath,
          fileName: "entries/inherited.mjs",
          isEntry: true,
          type: "chunk"
        };

        await unsplitHarness.generateBundle("es", {
          "entries/own.mjs": unsplitOwnEntry,
          "entries/inherited.mjs": unsplitInheritedEntry,
          "style.css": {
            fileName: "style.css",
            type: "asset",
            originalFileNames: ["style.css"]
          }
        });

        expect(unsplitOwnEntry.code).toContain('import "../style.css";');
        expect(unsplitOwnEntry.code).toMatch(
          /^#!\/usr\/bin\/env node\r\n\/\* banner \*\/\r\n\r\n["']use client["']; \/\/ client\r\n["']use server["'];\r\nimport /
        );
        expect(unsplitInheritedEntry.code).toContain(
          'import "@scope/third/style.css";'
        );
        expect(unsplitInheritedEntry.code).not.toContain(
          'import "../style.css";'
        );

        const cjsEntry: OutputBundleItem = {
          code: '#!/usr/bin/env node\r\n/* banner */\r\n"use strict"; // strict\r\nmodule.exports = {};',
          facadeModuleId: entryOnePath,
          fileName: "entries/own.cjs",
          isEntry: true,
          type: "chunk"
        };

        await unsplitHarness.generateBundle("cjs", {
          "entries/own.cjs": cjsEntry,
          "style.css": {
            fileName: "style.css",
            type: "asset",
            originalFileNames: ["style.css"]
          }
        });

        expect(cjsEntry.code).toMatch(
          /^#!\/usr\/bin\/env node\r\n\/\* banner \*\/\r\n["']use strict["']; \/\/ strict\r\nrequire\(/
        );

        const iifeCode = "(() => { globalThis.mincho = true; })();";
        const iifeEntry: OutputBundleItem = {
          code: iifeCode,
          facadeModuleId: entryOnePath,
          fileName: "entries/own.iife.js",
          isEntry: true,
          type: "chunk"
        };

        await unsplitHarness.generateBundle("iife", {
          "entries/own.iife.js": iifeEntry,
          "style.css": {
            fileName: "style.css",
            type: "asset",
            originalFileNames: ["style.css"]
          }
        });

        expect(iifeEntry.code).toBe(iifeCode);
      } finally {
        await Promise.all(
          fixturePaths.map((fixturePath) =>
            fs.promises.rm(fixturePath, { force: true })
          )
        );
      }
    });

    it("traverses deep cyclic module and chunk graphs in dependency order", async () => {
      const depth = 20000;
      const graph = new Map<string, { importedIds: string[] }>();
      const bundle: Record<string, OutputBundleItem> = {};

      for (let index = 0; index < depth; index += 1) {
        graph.set(`module-${index}`, {
          importedIds: [index + 1 < depth ? `module-${index + 1}` : "module-0"]
        });
        bundle[`chunk-${index}.mjs`] = {
          type: "chunk",
          code: "export const value = true;",
          facadeModuleId: index === 0 ? "module-0" : null,
          fileName: `chunk-${index}.mjs`,
          isEntry: index === 0,
          moduleIds: index === 0 ? ["module-0"] : [],
          imports: [
            index + 1 < depth ? `chunk-${index + 1}.mjs` : "chunk-0.mjs"
          ],
          viteMetadata: {
            importedCss: new Set(
              index === 0
                ? ["entry.css"]
                : index === depth - 1
                  ? ["leaf.css"]
                  : []
            )
          }
        };
      }

      for (const fileName of ["entry.css", "leaf.css"]) {
        bundle[fileName] = { type: "asset", fileName };
      }

      const harness = await createViteHarness({
        configOverrides: {
          build: { cssCodeSplit: true, lib: {}, watch: false }
        },

        getModuleInfo: (id) => graph.get(id) ?? null
      });

      await harness.generateBundle("es", bundle);

      expect(bundle["chunk-0.mjs"]).toMatchObject({
        code: 'import "./leaf.css";\nimport "./entry.css";\nexport const value = true;'
      });
    });

    it("clears library CSS sidecars when a watched owner stops emitting CSS", async () => {
      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransformSource")
        .mockResolvedValueOnce({
          code: 'import "extracted_watch.css.ts";\nexport const entry = true;',
          result: ["extracted_watch.css.ts", "resolver contents"]
        })
        .mockResolvedValueOnce({
          code: "export const entry = true;",
          result: ["", ""]
        });
      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      });
      vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      ).mockResolvedValue({
        ancestorStyleSpecifiers: ["@scope/ancestor/style.css"],
        registrySession: createEmptyRegistrySession(),
        source: "export const local = true;"
      });

      const harness = await createViteHarness({
        configOverrides: { build: { lib: {}, watch: {} } }
      });

      const entryPath = viteConsumerEntryPath;
      const extractedFixture = await createExtractedCssFixtureFromEntry(
        harness,
        entryPath
      );

      await harness.transform(
        extractedFixture.extractedId,
        extractedFixture.extractedSource
      );
      await harness.transform(entryPath, "export const entry = true;");

      const entryCode = "export const entry = true;";
      const entryChunk: OutputBundleItem = {
        code: entryCode,
        facadeModuleId: entryPath,
        fileName: "entry.mjs",
        isEntry: true,
        type: "chunk"
      };

      await harness.generateBundle("es", { "entry.mjs": entryChunk });

      expect(entryChunk.code).toBe(entryCode);
    });

    it("injects ordered library CSS sidecars into ESM and CJS entry chunks", async () => {
      const { build } = await import("vite");
      const manifest = await loadDefineRulesPresetSerializationManifest();
      const fixturePath =
        manifest.createDefineRulesPresetSerializationFixturePath(
          manifest.DEFINE_RULES_PRESET_SERIALIZATION_PATHS.packageDiamond
        );

      const fixtureRoot = dirname(dirname(fixturePath));
      const entryPath = join(fixtureRoot, "library-css-sidecar-entry.ts");
      const fixtureSource = (
        await fs.promises.readFile(fixturePath, "utf8")
      ).replace(
        /"@mincho-js-proof\/([^"]+)"/g,
        (_specifier, packageName: string) =>
          JSON.stringify(
            normalizePath(
              join(
                fixtureRoot,
                "node_modules",
                "@mincho-js-proof",
                packageName,
                "dist/index.js"
              )
            )
          )
      );

      const integrationModule = await import("@mincho-js/integration");

      try {
        await fs.promises.writeFile(entryPath, "export const entry = true;\n");
        vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
          code: 'import "extracted_diamond.css.ts";\nexport const entry = true;',
          result: ["extracted_diamond.css.ts", fixtureSource]
        });

        for (const format of ["es", "cjs"] as const) {
          const buildResult = await build({
            root: fixtureRoot,
            configFile: false,
            logLevel: "silent",
            plugins: [
              minchoVitePlugin({ libraryCss: { fileName: "style.css" } })
            ],
            build: {
              cssMinify: false,
              emptyOutDir: false,
              lib: {
                entry: entryPath,
                fileName: "entry",
                cssFileName: "style",
                formats: [format]
              },
              minify: false,
              write: false
            },
            resolve: {
              alias: Object.fromEntries(
                ["diamond-a", "diamond-b", "diamond-c"].map((packageName) => [
                  `@mincho-js-proof/${packageName}/style.css`,
                  normalizePath(
                    join(
                      fixtureRoot,
                      "node_modules",
                      "@mincho-js-proof",
                      packageName,
                      "dist/index.css"
                    )
                  )
                ])
              ),
              preserveSymlinks: true
            }
          });

          type LibraryCssOutput =
            | {
                code: string;
                fileName: string;
                isEntry: boolean;
                type: "chunk";
              }
            | {
                fileName: string;
                source: string | Uint8Array;
                type: "asset";
              };

          const rollupOutput = Array.isArray(buildResult)
            ? buildResult[0]
            : buildResult;

          if (rollupOutput === undefined) {
            throw new Error("Expected Vite library build output");
          }
          if (!("output" in rollupOutput)) {
            throw new Error("Expected Vite Rollup library output");
          }

          const outputFiles = rollupOutput.output as LibraryCssOutput[];
          const entryChunk = outputFiles.find(
            (output) => output.type === "chunk" && output.isEntry
          );

          const cssAsset = outputFiles.find(
            (output) =>
              output.type === "asset" && output.fileName.endsWith(".css")
          );

          if (entryChunk?.type !== "chunk" || cssAsset?.type !== "asset") {
            throw new Error("Expected Vite library entry chunk and CSS asset");
          }

          const ownStyleSpecifier = posix.relative(
            posix.dirname(entryChunk.fileName),
            cssAsset.fileName
          );

          const normalizedOwnStyleSpecifier = ownStyleSpecifier.startsWith(".")
            ? ownStyleSpecifier
            : `./${ownStyleSpecifier}`;

          const expectedStyleSpecifiers = [
            "@mincho-js-proof/diamond-a/style.css",
            "@mincho-js-proof/diamond-b/style.css",
            "@mincho-js-proof/diamond-c/style.css",
            normalizedOwnStyleSpecifier
          ];

          const statements = expectedStyleSpecifiers.map((specifier) =>
            format === "es"
              ? `import "${specifier}";`
              : `require("${specifier}");`
          );

          const [
            firstStatement,
            secondStatement,
            thirdStatement,
            fourthStatement
          ] = statements;

          if (
            firstStatement === undefined ||
            secondStatement === undefined ||
            thirdStatement === undefined ||
            fourthStatement === undefined
          ) {
            throw new Error("Expected four library CSS sidecar statements");
          }

          for (const statement of statements) {
            expect(entryChunk.code).toContain(statement);
          }

          if (format === "cjs") {
            expect(entryChunk.code).toMatch(/^["']use strict["'];/);
            expect(entryChunk.code.indexOf("use strict")).toBeLessThan(
              entryChunk.code.indexOf(firstStatement)
            );
          }

          expect(entryChunk.code.indexOf(firstStatement)).toBeLessThan(
            entryChunk.code.indexOf(secondStatement)
          );
          expect(entryChunk.code.indexOf(secondStatement)).toBeLessThan(
            entryChunk.code.indexOf(thirdStatement)
          );
          expect(entryChunk.code.indexOf(thirdStatement)).toBeLessThan(
            entryChunk.code.indexOf(fourthStatement)
          );
          expect(String(cssAsset.source)).toContain("padding: 13px;");
          expect(String(cssAsset.source)).not.toContain("display: flex;");
          expect(String(cssAsset.source)).not.toContain(
            "color: rebeccapurple;"
          );
        }
      } finally {
        vi.restoreAllMocks();
        await fs.promises.rm(entryPath, { force: true });
      }
    }, 20_000);

    it("injects each split library entry's own CSS and skips entries without CSS", async () => {
      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_multi-entry.css.ts";\nexport const entry = true;',
        result: ["extracted_multi-entry.css.ts", "resolver contents"]
      });

      const compileResult: Awaited<ReturnType<typeof compile>> = {
        source: "compiled source",
        watchFiles: []
      };

      vi.spyOn(integrationModule, "compile").mockResolvedValue(compileResult);
      vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      ).mockImplementation(
        async (
          options: Parameters<
            typeof integrationModule.processDefineRulesPresetRegistryFile
          >[0]
        ) => {
          await options.serializeVirtualCssPath?.({
            fileName: options.filePath,
            fileScope: { filePath: options.filePath },
            source: ".local { color: red; }"
          });

          return createRegistryResult("export const local = true;");
        }
      );

      const harness = await createViteHarness({
        configOverrides: {
          build: { cssCodeSplit: true, lib: {}, watch: false }
        }
      });

      const { extractedId, extractedSource } =
        await createExtractedCssFixture(harness);

      await harness.transform(extractedId, extractedSource);

      const formats: readonly ("es" | "cjs")[] = ["es", "cjs"];

      for (const format of formats) {
        const extension = format === "es" ? "mjs" : "cjs";
        const firstCode = "export const first = true;";
        const secondCode = "export const second = true;";
        const noCssCode = "export const noCss = true;";
        const firstChunk: OutputBundleItem = {
          code: firstCode,
          facadeModuleId: viteConsumerEntryPath,
          fileName: `entries/first.${extension}`,
          isEntry: true,
          type: "chunk",
          viteMetadata: { importedCss: new Set(["assets/first.css"]) }
        };

        const secondChunk: OutputBundleItem = {
          code: secondCode,
          facadeModuleId: viteConsumerEntryPath,
          fileName: `entries/second.${extension}`,
          isEntry: true,
          type: "chunk",
          viteMetadata: { importedCss: new Set(["assets/second.css"]) }
        };

        const noCssChunk: OutputBundleItem = {
          code: noCssCode,
          facadeModuleId: join(viteConsumerRootPath, "no-css.ts"),
          fileName: `entries/no-css.${extension}`,
          isEntry: true,
          moduleIds: [],
          type: "chunk",
          viteMetadata: { importedCss: new Set() }
        };

        const firstStatement =
          format === "es"
            ? 'import "../assets/first.css";'
            : 'require("../assets/first.css");';

        const secondStatement =
          format === "es"
            ? 'import "../assets/second.css";'
            : 'require("../assets/second.css");';

        await harness.generateBundle(format, {
          [firstChunk.fileName]: firstChunk,
          [secondChunk.fileName]: secondChunk,
          [noCssChunk.fileName]: noCssChunk,
          "assets/first.css": { fileName: "assets/first.css", type: "asset" },
          "assets/second.css": {
            fileName: "assets/second.css",
            type: "asset"
          }
        });

        expect(firstChunk.code).toBe(`${firstStatement}\n${firstCode}`);
        expect(firstChunk.code).not.toContain(secondStatement);
        expect(secondChunk.code).toBe(`${secondStatement}\n${secondCode}`);
        expect(secondChunk.code).not.toContain(firstStatement);
        expect(noCssChunk.code).toBe(noCssCode);
      }
    });

    it("orders library CSS sidecars by entry module order when transforms finish in reverse", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const firstCompile =
        createDeferred<Awaited<ReturnType<typeof compile>>>();

      const compileSpy = vi
        .spyOn(integrationModule, "compile")
        .mockImplementation(
          async (options: Parameters<typeof integrationModule.compile>[0]) => {
            if (options.filePath.endsWith("extracted_a.css.ts")) {
              return firstCompile.promise;
            }

            return {
              source: `compiled source:${options.filePath}`,
              watchFiles: []
            } as Awaited<ReturnType<typeof compile>>;
          }
        );

      vi.spyOn(integrationModule, "babelTransformSource")
        .mockResolvedValueOnce({
          code: 'import "extracted_a.css.ts";\nexport const entryA = true;',
          result: ["extracted_a.css.ts", "resolver contents a"]
        })
        .mockResolvedValueOnce({
          code: 'import "extracted_b.css.ts";\nexport const entryB = true;',
          result: ["extracted_b.css.ts", "resolver contents b"]
        });
      vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      ).mockImplementation(
        async (
          options: Parameters<
            typeof integrationModule.processDefineRulesPresetRegistryFile
          >[0]
        ) => {
          await options.serializeVirtualCssPath?.({
            fileName: options.filePath,
            fileScope: { filePath: options.filePath },
            source: ".local { color: red; }"
          });

          return {
            ...createRegistryResult("export const local = true;"),
            ancestorStyleSpecifiers: options.filePath.endsWith(
              "extracted_a.css.ts"
            )
              ? ["@scope/a/style.css", "@scope/shared/style.css"]
              : ["@scope/b/style.css", "@scope/shared/style.css"]
          };
        }
      );

      const harness = await createViteHarness({
        configOverrides: { build: { lib: {}, watch: false } }
      });

      const firstFixture = await createExtractedCssFixture(harness);
      const secondFixture = await createExtractedCssFixture(harness);
      const firstTransform = harness.transform(
        firstFixture.extractedId,
        firstFixture.extractedSource
      );

      await vi.waitFor(() => {
        expect(compileSpy).toHaveBeenCalledWith(
          expect.objectContaining({ filePath: firstFixture.physicalPath })
        );
      });
      await harness.transform(
        secondFixture.extractedId,
        secondFixture.extractedSource
      );
      firstCompile.resolve({
        source: `compiled source:${firstFixture.physicalPath}`,
        watchFiles: []
      } as Awaited<ReturnType<typeof compile>>);
      await firstTransform;

      const formats: readonly ("es" | "cjs")[] = ["es", "cjs"];

      for (const format of formats) {
        const entryChunk: OutputBundleItem = {
          code: "export const entry = true;",
          facadeModuleId: viteConsumerEntryPath,
          fileName: `entry.${format === "es" ? "mjs" : "cjs"}`,
          isEntry: true,
          moduleIds: [firstFixture.extractedId, secondFixture.extractedId],
          type: "chunk"
        };

        await harness.generateBundle(format, {
          [entryChunk.fileName]: entryChunk,
          "style.css": {
            fileName: "style.css",
            type: "asset",
            originalFileNames: ["style.css"]
          }
        });

        const expectedStyleSpecifiers = [
          "@scope/a/style.css",
          "@scope/shared/style.css",
          "@scope/b/style.css",
          "./style.css"
        ];

        const expectedStatements = expectedStyleSpecifiers.map((specifier) =>
          format === "es"
            ? `import ${JSON.stringify(specifier)};`
            : `require(${JSON.stringify(specifier)});`
        );

        expect(entryChunk.code).toBe(
          `${expectedStatements.join("\n")}\nexport const entry = true;`
        );
      }
    });

    it("injects static shared-chunk library CSS ancestors once and excludes dynamic chunks", async () => {
      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransformSource")
        .mockResolvedValueOnce({
          code: 'import "extracted_shared-first.css.ts";\nexport const first = true;',
          result: ["extracted_shared-first.css.ts", "shared first resolver"]
        })
        .mockResolvedValueOnce({
          code: 'import "extracted_shared-second.css.ts";\nexport const second = true;',
          result: ["extracted_shared-second.css.ts", "shared second resolver"]
        })
        .mockResolvedValueOnce({
          code: 'import "extracted_dynamic.css.ts";\nexport const dynamic = true;',
          result: ["extracted_dynamic.css.ts", "dynamic resolver"]
        });

      const compileResult: Awaited<ReturnType<typeof compile>> = {
        source: "compiled source",
        watchFiles: []
      };

      vi.spyOn(integrationModule, "compile").mockResolvedValue(compileResult);

      const ancestorStyleSpecifiersByFilePath = new Map<string, string[]>();
      vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      ).mockImplementation(
        async (
          options: Parameters<
            typeof integrationModule.processDefineRulesPresetRegistryFile
          >[0]
        ) => {
          await options.serializeVirtualCssPath?.({
            fileName: options.filePath,
            fileScope: { filePath: options.filePath },
            source: ".local { color: red; }"
          });

          return {
            ...createRegistryResult("export const local = true;"),
            ancestorStyleSpecifiers:
              ancestorStyleSpecifiersByFilePath.get(options.filePath) ?? []
          };
        }
      );

      const harness = await createViteHarness({
        configOverrides: { build: { lib: {}, watch: false } }
      });

      const firstSharedFixture = await createExtractedCssFixture(harness);
      const secondSharedFixture = await createExtractedCssFixture(harness);
      const dynamicFixture = await createExtractedCssFixture(harness);
      ancestorStyleSpecifiersByFilePath.set(firstSharedFixture.physicalPath, [
        "@scope/shared-first/style.css"
      ]);
      ancestorStyleSpecifiersByFilePath.set(secondSharedFixture.physicalPath, [
        "@scope/shared-second/style.css"
      ]);
      ancestorStyleSpecifiersByFilePath.set(dynamicFixture.physicalPath, [
        "@scope/dynamic/style.css"
      ]);
      await harness.transform(
        firstSharedFixture.extractedId,
        firstSharedFixture.extractedSource
      );
      await harness.transform(
        secondSharedFixture.extractedId,
        secondSharedFixture.extractedSource
      );
      await harness.transform(
        dynamicFixture.extractedId,
        dynamicFixture.extractedSource
      );

      const entryChunk: OutputBundleItem = {
        code: "export const entry = true;",
        dynamicImports: ["dynamic.mjs"],
        facadeModuleId: viteConsumerEntryPath,
        fileName: "entry.mjs",
        imports: ["shared-first.mjs", "shared-second.mjs"],
        isEntry: true,
        moduleIds: [viteConsumerEntryPath],
        type: "chunk"
      };

      const firstSharedChunk: OutputBundleItem = {
        code: "export const first = true;",
        facadeModuleId: null,
        fileName: "shared-first.mjs",
        imports: ["shared-second.mjs"],
        isEntry: false,
        moduleIds: [firstSharedFixture.extractedId],
        type: "chunk"
      };

      const secondSharedChunk: OutputBundleItem = {
        code: "export const second = true;",
        facadeModuleId: null,
        fileName: "shared-second.mjs",
        imports: ["shared-first.mjs"],
        isEntry: false,
        moduleIds: [secondSharedFixture.extractedId],
        type: "chunk"
      };

      const dynamicChunkCode = "export const dynamic = true;";
      const dynamicChunk: OutputBundleItem = {
        code: dynamicChunkCode,
        facadeModuleId: null,
        fileName: "dynamic.mjs",
        isEntry: false,
        moduleIds: [dynamicFixture.extractedId],
        type: "chunk"
      };

      await harness.generateBundle("es", {
        [entryChunk.fileName]: entryChunk,
        [firstSharedChunk.fileName]: firstSharedChunk,
        [secondSharedChunk.fileName]: secondSharedChunk,
        [dynamicChunk.fileName]: dynamicChunk,
        "style.css": {
          fileName: "style.css",
          type: "asset",
          originalFileNames: ["style.css"]
        }
      });

      expect(entryChunk.code).toBe(
        [
          'import "@scope/shared-first/style.css";',
          'import "@scope/shared-second/style.css";',
          'import "./style.css";',
          "export const entry = true;"
        ].join("\n")
      );
      expect(entryChunk.code).not.toContain("@scope/dynamic/style.css");
      expect(dynamicChunk.code).toBe(dynamicChunkCode);
    });

    it("does not retain library CSS sidecar behavior between watch builds", async () => {
      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransformSource")
        .mockResolvedValueOnce({
          code: 'import "extracted_watch-first.css.ts";\nexport const entry = true;',
          result: ["extracted_watch-first.css.ts", "first resolver contents"]
        })
        .mockResolvedValueOnce({
          code: 'import "extracted_watch-second.css.ts";\nexport const entry = true;',
          result: ["extracted_watch-second.css.ts", "second resolver contents"]
        });
      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      } as Awaited<ReturnType<typeof compile>>);
      vi.spyOn(integrationModule, "processDefineRulesPresetRegistryFile")
        .mockImplementationOnce(
          async (
            options: Parameters<
              typeof integrationModule.processDefineRulesPresetRegistryFile
            >[0]
          ) => {
            await options.serializeVirtualCssPath?.({
              fileName: options.filePath,
              fileScope: { filePath: options.filePath },
              source: ".first { color: red; }"
            });

            return createRegistryResult("export const first = true;");
          }
        )
        .mockResolvedValueOnce(
          createRegistryResult("export const second = true;")
        );

      const harness = await createViteHarness({
        configOverrides: {
          build: { lib: { cssFileName: "style" }, watch: true }
        }
      });

      await harness.buildStart();

      const firstFixture = await createExtractedCssFixture(harness);
      await harness.transform(
        firstFixture.extractedId,
        firstFixture.extractedSource
      );

      const firstChunk: OutputBundleItem = {
        code: "export const first = true;",
        facadeModuleId: viteConsumerEntryPath,
        fileName: "first.mjs",
        isEntry: true,
        moduleIds: [firstFixture.extractedId],
        type: "chunk"
      };

      await harness.generateBundle("es", {
        [firstChunk.fileName]: firstChunk,
        "style.css": {
          fileName: "style.css",
          type: "asset",
          originalFileNames: ["style.css"]
        }
      });

      expect(firstChunk.code).toBe(
        'import "./style.css";\nexport const first = true;'
      );

      await harness.buildStart();

      const secondFixture = await createExtractedCssFixture(harness);
      await harness.transform(
        secondFixture.extractedId,
        secondFixture.extractedSource
      );

      const secondChunk: OutputBundleItem = {
        code: "export const second = true;",
        facadeModuleId: viteConsumerEntryPath,
        fileName: "second.mjs",
        isEntry: true,
        moduleIds: [secondFixture.extractedId],
        type: "chunk"
      };

      await harness.generateBundle("es", {
        [secondChunk.fileName]: secondChunk
      });

      expect(secondChunk.code).toBe("export const second = true;");
    });

    it("counts V5 preset artifacts when schema and version property order differs", () => {
      expect(
        countV5PresetArtifacts(
          `{ version: 5, schema: "${DEFINE_RULES_PRESET_SCHEMA}" } { schema: "${DEFINE_RULES_PRESET_SCHEMA}", version: 5 }`
        )
      ).toBe(2);
    });

    it.each([false, true])(
      "discards deferred registry results after a new build (reopen: %s)",
      async (reopen: boolean) => {
        const integrationModule = await import("@mincho-js/integration");
        vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
          code: 'import "extracted_stale.css.ts"; export const entry = true;',
          result: ["extracted_stale.css.ts", "resolver contents"]
        });
        vi.spyOn(integrationModule, "compile").mockResolvedValue({
          source: "compiled source",
          watchFiles: []
        } as Awaited<ReturnType<typeof compile>>);

        let release = () => {};

        const pendingRegistry = new Promise<void>((resolve) => {
          release = resolve;
        });

        const registrySpy = vi
          .spyOn(integrationModule, "processDefineRulesPresetRegistryFile")
          .mockImplementation(
            async (
              options: Parameters<
                typeof integrationModule.processDefineRulesPresetRegistryFile
              >[0]
            ) => {
              await pendingRegistry;
              await options.serializeVirtualCssPath?.({
                fileName: options.filePath,
                fileScope: { filePath: options.filePath },
                source: ".stale { color: red; }"
              });

              return {
                ...createRegistryResult("export const stale = true;"),
                ancestorStyleSpecifiers: ["@scope/stale/style.css"]
              };
            }
          );

        const harness = await createViteHarness({
          configOverrides: {
            build: { lib: {}, watch: true, cssCodeSplit: true }
          }
        });

        await harness.buildStart();

        const { extractedId, extractedSource, physicalPath } =
          await createExtractedCssFixture(harness);

        const transforming = harness.transform(extractedId, extractedSource);
        await vi.waitFor(() => expect(registrySpy).toHaveBeenCalledOnce());

        if (reopen) {
          await harness.closeWatcher();
          await harness.buildStart();
        }

        await harness.buildStart();
        release();

        expect(await transforming).toBeNull();

        const virtualId = harness.resolveId(
          `mincho-virtual-css:${physicalPath}.vanilla.css`,
          extractedId
        );

        assertString(virtualId, "Expected an authorized sidecar path");

        expect(await harness.load(virtualId)).toBe("");

        const chunk: OutputBundleItem = {
          type: "chunk",
          fileName: "entry.mjs",
          isEntry: true,
          facadeModuleId: viteConsumerEntryPath,
          moduleIds: [extractedId],
          code: "export const entry = true;"
        };

        await harness.generateBundle("es", { "entry.mjs": chunk });

        expect(chunk.code).toBe("export const entry = true;");
      }
    );

    it("injects the emitted unsplit library CSS asset into each output format", async () => {
      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_unsplit.css.ts";\nexport const entry = true;',
        result: ["extracted_unsplit.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      } as Awaited<ReturnType<typeof compile>>);
      vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      ).mockImplementation(
        async (
          options: Parameters<
            typeof integrationModule.processDefineRulesPresetRegistryFile
          >[0]
        ) => {
          await options.serializeVirtualCssPath?.({
            fileName: options.filePath,
            fileScope: { filePath: options.filePath },
            source: ".entry { color: red; }"
          });

          return createRegistryResult("export const entry = true;");
        }
      );

      const harness = await createViteHarness({
        pluginOptions: { libraryCss: { fileName: "relocated/style.css" } },
        configOverrides: {
          build: {
            cssCodeSplit: false,
            lib: { cssFileName: "configured-style" },
            watch: false
          }
        }
      });

      await harness.buildStart();

      const { extractedId, extractedSource } =
        await createExtractedCssFixture(harness);

      await harness.transform(extractedId, extractedSource);

      const esChunk: OutputBundleItem = {
        code: "export const entry = true;",
        facadeModuleId: viteConsumerEntryPath,
        fileName: "entries/entry.mjs",
        isEntry: true,
        moduleIds: [extractedId],
        type: "chunk"
      };

      const cjsChunk: OutputBundleItem = {
        code: "exports.entry = true;",
        facadeModuleId: viteConsumerEntryPath,
        fileName: "entries/entry.cjs",
        isEntry: true,
        moduleIds: [extractedId],
        type: "chunk"
      };

      await harness.generateBundle("es", {
        [esChunk.fileName]: esChunk,
        "relocated/style.css": {
          fileName: "relocated/style.css",
          names: ["configured-style.css"],
          originalFileNames: ["style.css"],
          type: "asset"
        },
        "plugin.css": { fileName: "plugin.css", type: "asset" }
      });
      await harness.generateBundle("cjs", {
        [cjsChunk.fileName]: cjsChunk,
        "plugin.css": { fileName: "plugin.css", type: "asset" }
      });

      expect(esChunk.code).toBe(
        'import "../relocated/style.css";\nexport const entry = true;'
      );
      expect(cjsChunk.code).toBe(
        'require("../relocated/style.css");\nexports.entry = true;'
      );
    });

    it("reports missing library CSS assets and ancestor style exports", async () => {
      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_failure.css.ts";\nexport const entry = true;',
        result: ["extracted_failure.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      });
      vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      ).mockImplementation(
        async (
          options: Parameters<typeof processDefineRulesPresetRegistryFile>[0]
        ) => {
          await options.serializeVirtualCssPath?.({
            fileName: "style.css",
            fileScope: { filePath: "local.css.ts", packageName: "local" },
            source: ".local { color: red; }"
          });

          return {
            ancestorStyleSpecifiers: ["@scope/ancestor/style.css"],
            registrySession: {
              instances: [],
              nextRegistrationIndex: 0,
              nextRegistrationIndexByFileScope: {}
            },
            source: "export const local = 'local';"
          };
        }
      );

      const harness = await createViteHarness({
        configOverrides: { build: { lib: {}, watch: false } }
      });

      const entryPath = viteConsumerEntryPath;
      const transformedEntry = await harness.transform(
        entryPath,
        "entry source"
      );

      const transformedCode = extractViteTransformCode(
        transformedEntry,
        "Expected failure fixture entry transform"
      );

      const extractedImport = transformedCode.match(
        /import\s+["']([^"']*extracted_[^"']+\.css\.ts)["']/
      );
      if (extractedImport?.[1] === undefined) {
        throw new Error("Expected failure fixture extracted CSS import");
      }

      const extractedId = harness.resolveId(extractedImport[1], entryPath);
      if (extractedId === undefined) {
        throw new Error("Expected failure fixture extracted CSS id");
      }

      const extractedSource = await harness.load(extractedId);
      assertString(
        extractedSource,
        "Expected failure fixture extracted CSS source"
      );
      await harness.transform(extractedId, extractedSource);

      const entryChunk: OutputBundleItem = {
        code: "export const entry = true;",
        facadeModuleId: entryPath,
        fileName: "entry.mjs",
        isEntry: true,
        type: "chunk"
      };

      await expect(
        harness.generateBundle("es", { "entry.mjs": entryChunk })
      ).rejects.toThrow("was linked before hashing but was not emitted");
      await expect(
        harness.generateBundle("es", {
          "entry.mjs": entryChunk,
          "plugin.css": { fileName: "plugin.css", type: "asset" }
        })
      ).rejects.toThrow("was linked before hashing but was not emitted");
      await expect(
        harness.generateBundle(
          "es",
          {
            "entry.mjs": entryChunk,
            "style.css": {
              fileName: "style.css",
              type: "asset",
              originalFileNames: ["style.css"]
            }
          },
          async () => null
        )
      ).rejects.toThrow(
        "@scope/ancestor/style.css required by entry chunk entry.mjs is not exported"
      );

      const splitHarness = await createViteHarness({
        configOverrides: {
          build: { cssCodeSplit: true, lib: {}, watch: false }
        }
      });

      await expect(
        splitHarness.generateBundle("es", {
          "entry.mjs": { ...entryChunk, moduleIds: ["local.css"] }
        })
      ).rejects.toThrow("entry chunk entry.mjs expected one emitted CSS asset");
    });

    it.each([
      "registry-helper-wrapped-executed",
      "registry-iife-executed",
      "registry-nested-function-executed",
      "registry-multiple-instances",
      "registry-imported-helper-executed"
    ])("real Vite registry builds %s", async (caseId: string) => {
      const fixtureCase = serializedRegistryFixtureCases.find(
        (candidate) => candidate.caseId === caseId
      );
      if (fixtureCase == null) {
        throw new Error(`Missing registry fixture case ${caseId}`);
      }

      const { registrySource } =
        await buildRealViteRegistryFixture(fixtureCase);

      expect(registrySource).not.toBe("");

      expectSourceToContainV5PresetArtifact(registrySource);
      expectSourceToContainPopulatedPresetAtom(registrySource);

      if (fixtureCase.expectedRegistryInstances > 1) {
        const artifactCount = Array.from(
          registrySource.matchAll(
            /["']?schema["']?\s*:\s*["']mincho\.defineRulesPreset["']/g
          )
        ).length;

        expect(artifactCount).toBeGreaterThanOrEqual(
          fixtureCase.expectedRegistryInstances
        );
      }
    });

    it("real Vite function-valued config build skips registry artifacts", async () => {
      const fixtureCase = registryFixtureMatrixCases.find(
        (candidate) => candidate.caseId === "registry-function-config-invalid"
      );
      if (fixtureCase == null) {
        throw new Error("Missing registry function config fixture case");
      }

      const { js, registrySource } =
        await buildRealViteRegistryFixture(fixtureCase);

      expect(registrySource).not.toBe("");
      expect(countV5PresetArtifacts(registrySource)).toBe(0);
      expect(countV5PresetArtifacts(js)).toBe(0);
      expect(registrySource).toContain("rebeccapurple");
    }, 20000);

    it("serializes live preset output through the Vite build artifact path", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const livePresetBuildSource = `
        import { defineRules } from "@mincho-js/css";

        export const { css } = defineRules({ properties: { background: true } });
        export const fillBlue = css({ background: "blue" });
      `;

      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { css, fillBlue };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });

      const compileFixtureSource: typeof compile = integrationModule.compile;

      const compileLivePresetFixture: typeof compile = (
        options: Parameters<typeof compile>[0]
      ) =>
        compileFixtureSource({
          ...options,
          contents: livePresetBuildSource
        });

      vi.spyOn(integrationModule, "compile").mockImplementation(
        compileLivePresetFixture
      );

      const registrySpy = vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      );

      const harness = await createViteHarness();
      const { extractedId, extractedSource } =
        await createExtractedCssFixture(harness);

      const transformedExtractedCss = await harness.transform(
        extractedId,
        extractedSource
      );

      assertString(
        transformedExtractedCss,
        "Expected extracted css transform to return source text"
      );

      const fillBlueClassName = extractExportedStringValueFromBuildSource(
        transformedExtractedCss,
        "fillBlue"
      );

      const fillBlueInitializer =
        extractExportedVariableInitializerFromBuildSource(
          transformedExtractedCss,
          "fillBlue"
        );

      expect(registrySpy).toHaveBeenCalledTimes(1);

      expectSourceToContainPresetAtomClassName(
        transformedExtractedCss,
        fillBlueClassName
      );

      const fillBlueClassNames = splitClassNames(fillBlueClassName);

      expect(fillBlueClassNames.filter(isSegmentMarker)).toHaveLength(1);
      expect(
        fillBlueClassNames.filter((token) => !isSegmentMarker(token))
      ).toHaveLength(1);
      expect(fillBlueInitializer).not.toMatch(/\bcss\s*\(/);
      expect(
        hasCssCallWithStringProperty(
          transformedExtractedCss,
          "background",
          "blue"
        )
      ).toBe(false);
    });

    it("defineRules exported css skips function-valued registry artifacts", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const functionValuedConfigBuildSource = `
        import { defineRules } from "@mincho-js/css";

        const invalid = defineRules({
          properties: {
            color(value: "brand" | "neutral") {
              return value === "brand" ? "blue" : "gray";
            }
          }
        });
        export const raw = invalid.css.raw({ color: "brand" });
      `;

      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { raw };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });

      const compileFixtureSource: typeof compile = integrationModule.compile;
      vi.spyOn(integrationModule, "compile").mockImplementation(
        (options: Parameters<typeof compileFixtureSource>[0]) =>
          compileFixtureSource({
            ...options,
            contents: functionValuedConfigBuildSource
          })
      );

      const registrySpy = vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      );

      const harness = await createViteHarness();
      const { extractedId, extractedSource } =
        await createExtractedCssFixture(harness);

      const transformedExtractedCss = await harness.transform(
        extractedId,
        extractedSource
      );

      assertString(
        transformedExtractedCss,
        "Expected function-valued config transform to return source text"
      );

      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(countV5PresetArtifacts(transformedExtractedCss)).toBe(0);
      expect(transformedExtractedCss).toContain("blue");
    });

    it("bubbles registry processing errors from build-time preset serialization", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { raw };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      } as Awaited<ReturnType<typeof compile>>);

      const registrySpy = vi
        .spyOn(integrationModule, "processDefineRulesPresetRegistryFile")
        .mockRejectedValue(new Error("registry processing failure"));

      const harness = await createViteHarness();
      const { extractedId, extractedSource } =
        await createExtractedCssFixture(harness);

      await expect(
        harness.transform(extractedId, extractedSource)
      ).rejects.toThrow("registry processing failure");

      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("serializes supported fixture matrix cases through the Vite extracted-css registry path", async () => {
      for (const fixtureCase of serializedRegistryFixtureCases) {
        vi.restoreAllMocks();

        const fixtureSource = readFixtureSource(fixtureCase.fixturePath);

        for (const expectedSourceSnippet of fixtureCase.expectedSourceSnippets) {
          expectSourceToContainSnippet(fixtureSource, expectedSourceSnippet);
        }

        const integrationModule = await import("@mincho-js/integration");
        vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
          code: 'import "extracted_rules.css.ts";\nexport { css, preset, shared };',
          result: ["extracted_rules.css.ts", "resolver contents"]
        });

        const compileFixtureSource: typeof compile = integrationModule.compile;
        vi.spyOn(integrationModule, "compile").mockImplementation(
          (options: Parameters<typeof compileFixtureSource>[0]) =>
            compileFixtureSource({
              ...options,
              filePath: fixtureCase.fixturePath,
              originalPath: fixtureCase.fixturePath,
              contents: fixtureSource
            })
        );

        const registrySpy = vi.spyOn(
          integrationModule,
          "processDefineRulesPresetRegistryFile"
        );

        const harness = await createViteHarness({
          configOverrides: {
            root: resolve(getSharedComponentPackageRoot(), "../..")
          }
        });

        const { extractedId, extractedSource, physicalPath } =
          await createExtractedCssFixture(harness);

        const transformedExtractedCss = await harness.transform(
          extractedId,
          extractedSource
        );

        assertString(
          transformedExtractedCss,
          "Expected extracted css transform to return source text"
        );

        expect(registrySpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: physicalPath,
            identOption: "short",
            serializeVirtualCssPath: expect.any(Function)
          })
        );
        expect(registrySpy).toHaveBeenCalledTimes(1);

        expectSourceToContainV5PresetArtifact(transformedExtractedCss);
      }
    });

    it("keeps function-valued config fixture artifact-free through the Vite registry path", async () => {
      const fixtureCase = registryFixtureMatrixCases.find(
        (candidate) => candidate.caseId === "registry-function-config-invalid"
      );
      if (fixtureCase == null) {
        throw new Error("Missing registry function config fixture case");
      }

      const fixtureSource = readFixtureSource(fixtureCase.fixturePath);

      for (const expectedSourceSnippet of fixtureCase.expectedSourceSnippets) {
        expectSourceToContainSnippet(fixtureSource, expectedSourceSnippet);
      }

      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { raw };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });

      const compileFixtureSource: typeof compile = integrationModule.compile;
      vi.spyOn(integrationModule, "compile").mockImplementation(
        (options: Parameters<typeof compileFixtureSource>[0]) =>
          compileFixtureSource({
            ...options,
            filePath: fixtureCase.fixturePath,
            originalPath: fixtureCase.fixturePath,
            contents: fixtureSource
          })
      );

      const registrySpy = vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      );

      const harness = await createViteHarness({
        configOverrides: {
          root: resolve(getSharedComponentPackageRoot(), "../..")
        }
      });

      const { extractedId, extractedSource } =
        await createExtractedCssFixture(harness);

      const transformedExtractedCss = await harness.transform(
        extractedId,
        extractedSource
      );

      assertString(
        transformedExtractedCss,
        "Expected function-valued fixture transform to return source text"
      );

      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(countV5PresetArtifacts(transformedExtractedCss)).toBe(0);
      expect(transformedExtractedCss).toContain("rebeccapurple");
    }, 20000);

    it("keeps root css alias reuse paired with the explicit css asset import when no local extraction is needed", async () => {
      const harness = await createViteHarness();
      const entrySource = await fs.promises.readFile(
        viteConsumerEntryPath,
        "utf8"
      );

      const transformedEntry = await harness.transform(
        viteConsumerEntryPath,
        entrySource
      );

      const {
        code,
        result: [extractedFile, extractedCss]
      } = await babelTransformSource({
        filename: viteConsumerEntryPath,
        source: entrySource
      });

      expect(transformedEntry).toBeNull();
      expect(extractedFile).toMatch(/^extracted_[^/]+\.css\.ts$/);
      expect(extractedCss).toBe("");
      expect(code).toContain(
        'import "@mincho-js-proof/define-rules-preset/shared-component.css";'
      );
      expect(code).toContain(
        'import { css, shared } from "@mincho-js-proof/define-rules-preset";'
      );
      expect(code).toContain("export { css, shared };");
    });

    it("defineRules provider sidecar import contract", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const entrySource = readFixtureSource(viteConsumerEntryPath);
      const providerDistModuleSource = readFixtureSource(
        providerDistModulePath
      );

      const providerSidecarCssSource = readFixtureSource(
        providerSidecarCssPath
      );

      const providerSharedClassName = extractVariableStringValueFromBuildSource(
        providerDistModuleSource,
        "shared"
      );

      expect(entrySource).toContain(explicitProviderSidecarImport);

      expectCssSourceToContainClassNames(
        providerSidecarCssSource,
        providerSharedClassName
      );

      expect(providerSidecarCssSource).toContain("color: rebeccapurple;");
      expect(providerSidecarCssSource).toContain("display: flex;");

      const {
        code,
        result: [extractedFile, extractedCss]
      } = await babelTransformSource({
        filename: viteConsumerEntryPath,
        source: entrySource
      });

      expect(extractedFile).toMatch(/^extracted_[^/]+\.css\.ts$/);
      expect(extractedCss).toBe("");
      expect(code).toContain(explicitProviderSidecarImport);
      expect(code).toContain(
        'import { css, shared } from "@mincho-js-proof/define-rules-preset";'
      );
      expect(code).toContain("export { css, shared };");
      expect(code).not.toContain(providerSharedClassName);

      const missingSidecarSource = entrySource.replace(
        explicitProviderSidecarImport,
        ""
      );

      expect(missingSidecarSource).not.toContain(explicitProviderSidecarImport);
      expect(missingSidecarSource).toContain(
        'import { css, shared } from "@mincho-js-proof/define-rules-preset";'
      );

      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: missingSidecarSource,
        result: ["", ""]
      });

      const harness = await createViteHarness();
      const missingSidecarTransform = await harness.transform(
        viteConsumerEntryPath,
        missingSidecarSource
      );

      expect(missingSidecarTransform).toBeNull();
      expect(missingSidecarSource).not.toContain(providerSharedClassName);
    });

    describe("shared-component package entry contracts", () => {
      let installedPackageRoot = "";
      let suiteRoot = "";

      beforeAll(async () => {
        const { tmpdir } = await import("node:os");

        // Keep this node_modules consumer outside the workspace's PnP graph.
        suiteRoot = await fs.promises.mkdtemp(
          join(tmpdir(), "shared-component-package-")
        );
        installedPackageRoot = join(
          suiteRoot,
          "node_modules/@examples/shared-component"
        );
        await fs.promises.mkdir(installedPackageRoot, { recursive: true });
        await fs.promises.copyFile(
          join(getSharedComponentPackageRoot(), "package.json"),
          join(installedPackageRoot, "package.json")
        );
        await buildSharedComponentPackage(join(installedPackageRoot, "dist"));
        await fs.promises.cp(
          join(getSharedComponentPackageRoot(), "dist/esm"),
          join(installedPackageRoot, "dist/esm"),
          {
            recursive: true,

            filter: (source) =>
              fs.statSync(source).isDirectory() || source.endsWith(".d.ts")
          }
        );

        return async () => {
          await fs.promises.rm(suiteRoot, { force: true, recursive: true });
        };
      }, 30000);

      it("splits runtime, preset, and stylesheet package outputs", () => {
        const packageJson = JSON.parse(
          readFixtureSource(join(installedPackageRoot, "package.json"))
        ) as unknown;

        expect(packageJson).toMatchObject({
          exports: {
            ".": {
              import: {
                types: "./dist/esm/index.d.ts",
                default: "./dist/esm/index.mjs"
              },
              require: {
                types: "./dist/esm/index.d.ts",
                default: "./dist/cjs/index.cjs"
              }
            },
            "./preset": {
              import: {
                types: "./dist/esm/preset.d.ts",
                default: "./dist/esm/preset.mjs"
              },
              require: {
                types: "./dist/esm/preset.d.ts",
                default: "./dist/cjs/preset.cjs"
              }
            },
            "./style.css": {
              default: "./dist/style.css"
            }
          },
          files: ["dist/"],
          sideEffects: ["./dist/style.css"]
        });

        const distRoot = join(installedPackageRoot, "dist");
        const runtimeEsm = readFixtureSource(join(distRoot, "esm/index.mjs"));
        const runtimeCjs = readFixtureSource(join(distRoot, "cjs/index.cjs"));
        const runtimeTypes = readFixtureSource(
          join(distRoot, "esm/index.d.ts")
        );

        const presetEsm = readFixtureSource(join(distRoot, "esm/preset.mjs"));
        const presetCjs = readFixtureSource(join(distRoot, "cjs/preset.cjs"));

        expect(runtimeEsm).toContain("SharedExampleCard");
        expect(runtimeEsm).toContain("sharedCardClassName");
        expect(runtimeEsm).toContain('import "../style.css";');
        expect(runtimeCjs).toContain('require("../style.css");');
        expect(presetEsm).toContain('import "../style.css";');
        expect(presetCjs).toContain('require("../style.css");');
        expect(runtimeTypes).not.toMatch(/\b(?:css|cx|preset)\b(?=\s*(?:,|}))/);

        expectSharedComponentRuntimeChunkToOmitAuthoringGraph(runtimeEsm);
        expectSharedComponentRuntimeChunkToOmitAuthoringGraph(runtimeCjs);
        expectSharedComponentPresetChunkToContainAuthoringGraph(presetEsm);
        expectSharedComponentPresetChunkToContainAuthoringGraph(presetCjs);

        expect(fs.existsSync(join(distRoot, "style.css"))).toBe(true);
      });

      it("keeps unused preset data out of a runtime-only Vite consumer bundle", async () => {
        const { build } = await import("vite");
        const root = await fs.promises.mkdtemp(
          join(suiteRoot, "shared-component-runtime-")
        );

        const entryPath = join(root, "entry.tsx");

        try {
          await fs.promises.writeFile(
            entryPath,
            `
              import { SharedExampleCard, sharedCardClassName } from "@examples/shared-component";

              export { SharedExampleCard, sharedCardClassName };
            `
          );

          const buildResult = await build({
            root,
            configFile: false,
            logLevel: "silent",
            build: {
              emptyOutDir: false,
              lib: {
                entry: entryPath,
                fileName: "runtime-consumer",
                formats: ["es"]
              },
              minify: false,
              rollupOptions: {
                external: [/^react(?:\/.*)?$/]
              },
              write: false
            },
            resolve: {
              // Vite's workspace PnP resolver cannot locate this isolated install.
              alias: [
                {
                  find: /^@examples\/shared-component$/,
                  replacement: installedPackageRoot
                }
              ],
              preserveSymlinks: true
            }
          });

          const rollupOutputs = Array.isArray(buildResult)
            ? buildResult
            : [buildResult];

          const bundledJs = rollupOutputs
            .flatMap((rollupOutput) => {
              const possibleOutput = rollupOutput as { output?: unknown };
              if (!Array.isArray(possibleOutput.output)) {
                throw new Error("Expected runtime consumer build output");
              }

              return possibleOutput.output;
            })
            .filter(
              (output): output is { code: string; type: "chunk" } =>
                typeof output === "object" &&
                output !== null &&
                "type" in output &&
                output.type === "chunk" &&
                "code" in output &&
                typeof output.code === "string"
            )
            .map((output) => output.code)
            .join("\n");

          expect(bundledJs).toContain("SharedExampleCard");

          expectSharedComponentRuntimeChunkToOmitAuthoringGraph(bundledJs);
        } finally {
          await fs.promises.rm(root, { force: true, recursive: true });
        }
      }, 20000);

      it("rejects root preset imports while the preset subpath resolves", async () => {
        const root = await fs.promises.mkdtemp(
          join(suiteRoot, "shared-component-types-")
        );

        const invalidEntryPath = join(root, "invalid-root-preset.ts");
        const validEntryPath = join(root, "valid-preset-subpath.ts");

        try {
          await fs.promises.writeFile(
            invalidEntryPath,
            'import { preset } from "@examples/shared-component";\nvoid preset;\n'
          );
          await fs.promises.writeFile(
            validEntryPath,
            'import { preset } from "@examples/shared-component/preset";\nvoid preset;\n'
          );

          const invalidDiagnostics =
            await getTypeScriptDiagnostics(invalidEntryPath);

          const validDiagnostics =
            await getTypeScriptDiagnostics(validEntryPath);

          expect(invalidDiagnostics.join("\n")).toContain(
            "has no exported member 'preset'"
          );
          expect(validDiagnostics).toEqual([]);
        } finally {
          await fs.promises.rm(root, { force: true, recursive: true });
        }
      });
    });

    it("drops stale registry artifacts during repeated HMR-style transforms", async () => {
      const integrationModule = await import("@mincho-js/integration");

      const createStaleRegistrySource = (includeRemovedOwner: boolean) => {
        const removedOwnerSource = includeRemovedOwner
          ? `
              const removedOwner = defineRules({
                debugId: "vite-removed-stale",
                properties: {
                  padding: true
                }
              });
              export const removedClass = removedOwner.css({ padding: 12 });
              export const removedPreset = removedOwner.preset;
            `
          : "";

        return `
          import { defineRules } from "@mincho-js/css";

          const currentOwner = defineRules({
            debugId: "vite-current-stale",
            properties: {
              color: true
            }
          });
          ${removedOwnerSource}
          export const currentClass = currentOwner.css({ color: "navy" });
          export const currentPreset = currentOwner.preset;
        `;
      };

      const firstRegistrySource = createStaleRegistrySource(true);
      const secondRegistrySource = createStaleRegistrySource(false);

      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_stale.css.ts";\nexport { currentClass };',
        result: ["extracted_stale.css.ts", "resolver contents"]
      });

      const registrySpy = vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      );

      const harness = await createViteHarness({
        configOverrides: {
          command: "serve",
          mode: "development"
        }
      });

      const { extractedId, extractedSource, physicalPath } =
        await createExtractedCssFixture(harness);

      expect(extractedSource).toBe("resolver contents");

      const firstTransform = await harness.transform(
        extractedId,
        firstRegistrySource
      );

      assertString(
        firstTransform,
        "Expected first repeated transform to return source text"
      );

      const firstVirtualImportMatch = firstTransform.match(
        /import\s+"([^"]+\.vanilla\.css)";/
      );
      if (firstVirtualImportMatch?.[1] == null) {
        throw new Error(
          "Expected first repeated transform to import virtual CSS"
        );
      }

      const resolvedVirtualId = harness.resolveId(firstVirtualImportMatch[1]);
      assertString(
        resolvedVirtualId,
        "Expected repeated transform virtual CSS id to resolve"
      );

      const currentClassName = extractVariableStringValueFromBuildSource(
        firstTransform,
        "currentClass"
      );

      const removedClassName = extractVariableStringValueFromBuildSource(
        firstTransform,
        "removedClass"
      );

      expect(removedClassName).not.toBe(currentClassName);

      const firstVirtualCss = await harness.load(resolvedVirtualId);
      assertString(
        firstVirtualCss,
        "Expected first repeated transform virtual CSS to load"
      );

      expect(registrySpy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          filePath: physicalPath,
          identOption: "debug",
          serializeVirtualCssPath: expect.any(Function)
        })
      );
      expect(countV5PresetArtifacts(firstTransform)).toBe(2);

      expectSourceToContainPresetAtomClassName(
        firstTransform,
        currentClassName
      );
      expectSourceToContainPresetAtomClassName(
        firstTransform,
        removedClassName
      );
      expectCssSourceToContainClassNames(firstVirtualCss, currentClassName);
      expectCssSourceToContainClassNames(firstVirtualCss, removedClassName);

      const secondTransform = await harness.transform(
        extractedId,
        secondRegistrySource
      );

      assertString(
        secondTransform,
        "Expected second repeated transform to return source text"
      );

      const secondCurrentClassName = extractVariableStringValueFromBuildSource(
        secondTransform,
        "currentClass"
      );

      const secondVirtualCss = await harness.load(resolvedVirtualId);
      assertString(
        secondVirtualCss,
        "Expected second repeated transform virtual CSS to load"
      );

      expect(registrySpy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          filePath: physicalPath,
          identOption: "debug",
          serializeVirtualCssPath: expect.any(Function)
        })
      );
      expect(countV5PresetArtifacts(secondTransform)).toBe(1);

      expectSourceToContainPresetAtomClassName(
        secondTransform,
        secondCurrentClassName
      );

      expect(secondTransform).not.toContain(removedClassName);
      expect(secondTransform).not.toContain("removedClass");
      expect(secondTransform).not.toContain("removedPreset");

      expectCssSourceToContainClassNames(
        secondVirtualCss,
        secondCurrentClassName
      );

      for (const removedFragmentClassName of splitClassNames(
        removedClassName
      )) {
        expect(secondVirtualCss).not.toContain(`.${removedFragmentClassName}`);
      }

      expect(registrySpy).toHaveBeenCalledTimes(2);
    });

    it("defineRules presets survive cross-module HMR without stale preset duplication", async () => {
      const { defineRules } = await import("@mincho-js/css");
      const integrationModule = await import("@mincho-js/integration");
      const fileScopeModule = await import("@vanilla-extract/css/fileScope");

      fileScopeModule.setFileScope("hmr-provider.css.ts");

      const providerV1 = defineRules({
        debugId: "hmr-provider",
        properties: {
          color: true,
          display: true
        }
      });

      const staleProviderClassName = providerV1.css({
        color: "rebeccapurple",
        display: "block"
      });

      const providerV2 = defineRules({
        debugId: "hmr-provider",
        properties: {
          color: true,
          display: true
        }
      });

      const updatedProviderClassName = providerV2.css({
        color: "mediumseagreen",
        display: "flex"
      });

      const providerVirtualCssId =
        "node_modules/@mincho-js-proof/define-rules-preset/extracted_provider.css.ts.vanilla.css";

      const providerVirtualFilePath = providerVirtualCssId.replace(
        /\.vanilla\.css$/,
        ""
      );

      const expectedProviderVirtualModuleId = normalizePath(
        join(viteConsumerRootPath, providerVirtualCssId)
      );

      const providerVersions = [
        {
          className: staleProviderClassName,
          color: "rebeccapurple"
        },
        {
          className: updatedProviderClassName,
          color: "mediumseagreen"
        }
      ];

      let providerVersionIndex = 0;

      const createProviderCssSource = (className: string, color: string) =>
        splitClassNames(className)
          .map(
            (fragmentClassName) => `.${fragmentClassName} { color: ${color}; }`
          )
          .join("\n");

      const hmrModule: Module = {
        lastInvalidationTimestamp: 987
      };

      const getModuleById = vi.fn(() => hmrModule);
      const invalidateModule = vi.fn();

      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_provider.css.ts";\nexport { css, shared };',
        result: ["extracted_provider.css.ts", "provider resolver contents"]
      });
      vi.spyOn(integrationModule, "compile").mockImplementation(
        async () =>
          ({
            source: `export const shared = ${JSON.stringify(providerVersions[providerVersionIndex]?.className)};`,
            watchFiles: []
          }) as Awaited<ReturnType<typeof compile>>
      );

      vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      ).mockImplementation(
        async ({
          source,
          serializeVirtualCssPath
        }: Parameters<typeof processDefineRulesPresetRegistryFile>[0]) => {
          const providerVersion = providerVersions[providerVersionIndex];
          if (providerVersion == null) {
            throw new Error(
              "Expected a provider version for HMR serialization"
            );
          }

          const virtualImport =
            (await serializeVirtualCssPath?.({
              fileName: providerVirtualFilePath,
              fileScope: {
                filePath: providerVirtualFilePath
              },
              source: createProviderCssSource(
                providerVersion.className,
                providerVersion.color
              )
            })) ?? "";

          return createRegistryResult(`${virtualImport}\n${source}`);
        }
      );

      const harness = await createViteHarness({
        configOverrides: {
          command: "serve",
          mode: "development"
        },
        server: {
          moduleGraph: {
            getModuleById,
            invalidateModule
          }
        }
      });

      const { extractedId, extractedSource } =
        await createExtractedCssFixtureFromEntry(
          harness,
          providerRootFixturePath
        );

      const transformedProviderV1 = await harness.transform(
        extractedId,
        extractedSource
      );

      assertString(
        transformedProviderV1,
        "Expected first provider HMR transform to return source text"
      );

      const virtualImportMatch = transformedProviderV1.match(
        /import\s+"([^"]+\.vanilla\.css)";/
      );
      if (virtualImportMatch?.[1] == null) {
        throw new Error("Expected provider HMR output to import virtual CSS");
      }

      const resolvedVirtualId = harness.resolveId(virtualImportMatch[1]);

      expect(resolvedVirtualId).toBe(
        `\0mincho-virtual-css:${expectedProviderVirtualModuleId}`
      );
      expect(transformedProviderV1).toContain(staleProviderClassName);
      expect(transformedProviderV1).not.toContain(updatedProviderClassName);
      expect(await harness.load(resolvedVirtualId!)).toBe(
        createProviderCssSource(staleProviderClassName, "rebeccapurple")
      );
      expect(getModuleById).toHaveBeenCalledWith(
        `\0mincho-virtual-css:${expectedProviderVirtualModuleId}`
      );
      expect(invalidateModule).toHaveBeenCalledWith(hmrModule);
      expect(invalidateModule).toHaveBeenCalledTimes(1);
      expect(hmrModule.lastHMRTimestamp).toBe(987);

      providerVersionIndex = 1;

      const transformedProviderV2 = await harness.transform(
        extractedId,
        extractedSource
      );

      assertString(
        transformedProviderV2,
        "Expected updated provider HMR transform to return source text"
      );

      expect(transformedProviderV2).toContain(updatedProviderClassName);
      expect(transformedProviderV2).not.toContain(staleProviderClassName);
      expect(await harness.load(resolvedVirtualId!)).toBe(
        createProviderCssSource(updatedProviderClassName, "mediumseagreen")
      );
      expect(invalidateModule).toHaveBeenCalledTimes(2);
      expect(hmrModule.lastHMRTimestamp).toBe(987);

      const consumer = defineRules({
        debugId: "hmr-consumer",
        presets: providerV2.preset,
        properties: {
          color: true,
          display: true,
          padding: true
        }
      });

      const reusedUpdatedClassName = consumer.css({
        color: "mediumseagreen",
        display: "flex"
      });

      const getClassNameByCacheKey = (preset: typeof providerV2.preset) => {
        const classNameByCacheKey: Record<string, string> = {};

        for (const node of preset.nodes) {
          for (const atom of node.atoms) {
            classNameByCacheKey[atom.cacheKey] = atom.className;
          }
        }

        return classNameByCacheKey;
      };

      const providerClassNameByCache = getClassNameByCacheKey(
        providerV2.preset
      );

      const consumerClassNameByCache = getClassNameByCacheKey(consumer.preset);
      const seededEntryCount = Object.keys(providerClassNameByCache).length;
      const staleOnlyClassNames = splitClassNames(
        staleProviderClassName
      ).filter(
        (fragmentClassName) =>
          !splitClassNames(updatedProviderClassName).includes(fragmentClassName)
      );

      expect(reusedUpdatedClassName).toBe(updatedProviderClassName);
      expect(Object.keys(consumerClassNameByCache)).toHaveLength(
        seededEntryCount
      );
      expect(consumerClassNameByCache).toEqual(
        expect.objectContaining(providerClassNameByCache)
      );

      for (const staleClassName of staleOnlyClassNames) {
        expect(Object.values(consumerClassNameByCache)).not.toContain(
          staleClassName
        );
      }

      fileScopeModule.endFileScope();
    });

    it("emits resolved virtual css imports while keeping dev HMR bookkeeping", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const cssSource = ".shared { color: rebeccapurple; }";
      const virtualCssId = "src/extracted_rules.css.ts.vanilla.css";
      const expectedModuleId = normalizePath(
        join(viteConsumerRootPath, virtualCssId)
      );

      const fileScopePath = expectedModuleId.slice(0, -".vanilla.css".length);
      const hmrModule: Module = {
        lastInvalidationTimestamp: 123
      };

      const getModuleById = vi.fn(() => hmrModule);
      const invalidateModule = vi.fn();

      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { css, shared };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      } as Awaited<ReturnType<typeof compile>>);

      const registrySpy = vi
        .spyOn(integrationModule, "processDefineRulesPresetRegistryFile")
        .mockImplementation(
          async ({
            serializeVirtualCssPath
          }: Parameters<typeof processDefineRulesPresetRegistryFile>[0]) => {
            return createRegistryResult(
              (await serializeVirtualCssPath?.({
                fileName: "src/extracted_rules.css.ts",
                fileScope: {
                  filePath: fileScopePath
                },
                source: cssSource
              })) ?? ""
            );
          }
        );

      const harness = await createViteHarness({
        configOverrides: {
          command: "serve",
          mode: "development"
        },
        server: {
          moduleGraph: {
            getModuleById,
            invalidateModule
          }
        }
      });

      const { extractedId, extractedSource, physicalPath } =
        await createExtractedCssFixture(harness);

      const transformedExtractedCss = await harness.transform(
        extractedId,
        extractedSource
      );

      assertString(
        transformedExtractedCss,
        "Expected extracted css transform to return source text"
      );

      const virtualImportMatch = transformedExtractedCss.match(
        /import\s+"([^"]+\.vanilla\.css)";/
      );
      if (virtualImportMatch == null) {
        throw new Error("Expected a virtual css import in dev mode");
      }

      expect(transformedExtractedCss).toContain(
        `import "mincho-virtual-css:${expectedModuleId}";`
      );
      expect(transformedExtractedCss).not.toContain("presets");

      const resolvedVirtualId = harness.resolveId(virtualImportMatch[1]);

      expect(resolvedVirtualId).toBe(
        `\0mincho-virtual-css:${expectedModuleId}`
      );
      expect(await harness.load(resolvedVirtualId!)).toBe(cssSource);
      expect(getModuleById).toHaveBeenCalledWith(
        `\0mincho-virtual-css:${expectedModuleId}`
      );
      expect(invalidateModule).toHaveBeenCalledWith(hmrModule);
      expect(hmrModule.lastHMRTimestamp).toBe(123);
      expect(registrySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: physicalPath,
          identOption: "debug",
          source: "compiled source",
          serializeVirtualCssPath: expect.any(Function)
        })
      );
      expect(registrySpy).toHaveBeenCalledTimes(1);
    });

    it("emits virtual css imports for Windows file scopes", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const cssSource = ".shared { color: rebeccapurple; }";
      const windowsRootPath = "C:\\workspace\\mincho";
      const windowsFileScopePath =
        "C:\\workspace\\mincho\\src\\extracted_rules.css.ts";

      vi.spyOn(integrationModule, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { css, shared };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      } as Awaited<ReturnType<typeof compile>>);
      vi.spyOn(
        integrationModule,
        "processDefineRulesPresetRegistryFile"
      ).mockImplementation(
        async ({
          serializeVirtualCssPath
        }: Parameters<typeof processDefineRulesPresetRegistryFile>[0]) => {
          return createRegistryResult(
            (await serializeVirtualCssPath?.({
              fileName: "src/extracted_rules.css.ts",
              fileScope: {
                filePath: windowsFileScopePath
              },
              source: cssSource
            })) ?? ""
          );
        }
      );

      const harness = await createViteHarness({
        configOverrides: {
          command: "serve",
          mode: "development",
          root: windowsRootPath
        }
      });

      const { extractedId, extractedSource } =
        await createExtractedCssFixture(harness);

      const transformedExtractedCss = await harness.transform(
        extractedId,
        extractedSource
      );

      assertString(
        transformedExtractedCss,
        "Expected Windows virtual css transform to return source text"
      );

      expect(transformedExtractedCss).toContain('import "mincho-virtual-css:');
      expect(transformedExtractedCss).not.toMatch(
        /import\s+"(?:\/\/|\/[A-Z]:)/
      );
    });
  });
}
