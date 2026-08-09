import {
  type BabelOptions,
  babelTransform,
  compile,
  internalCollectStaticCssEvalDependencyIds as collectStaticCssEvalDependencyIds,
  internalCreateStaticCssEvalSourceHash as createStaticCssEvalSourceHash,
  internalCreateStaticCssEvalSourceIdentity as createStaticCssEvalSourceIdentity,
  internalGetExistingStaticCssEvalRealpath as getExistingRealpath,
  internalGetExistingStaticCssEvalStat as getExistingStat,
  internalGetStaticCssEvalRealpathOrResolvedPath as getRealpathOrResolvedPath,
  internalHasStaticCssEvalNodeModulesSegment as hasNodeModulesSegment,
  internalIsMissingStaticCssEvalFileSystemEntryError as isMissingFileSystemEntryError,
  internalIsProjectLocalStaticCssEvalImportPath as isProjectLocalImportPath,
  internalIsStaticCssEvalStaticDataFile as isStaticCssEvalStaticDataFile,
  internalIsStaticCssEvalPathInsideRoot as isPathInsideRoot,
  internalIsVirtualStaticCssEvalId as isVirtualStaticCssEvalId,
  internalMinchoProjectEngine,
  internalNormalizeStaticCssEvalFileId as normalizeStaticCssEvalFileId,
  internalPrepareStaticCssEvalStaticDataSource as prepareStaticCssEvalStaticDataSource,
  internalStaticCssEvalExternalResolutionPrefix as externalStaticCssEvalResolutionPrefix,
  processDefineRulesPresetRegistryFile,
  runDefineRulesPresetRegistryStep
} from "@mincho-js/integration";
import { normalizePath } from "@rollup/pluginutils";
import { dirname, join, posix, resolve } from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { findChunkDirectivePrologueEnd } from "./chunkPrologue.js";

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
  transformRequest?(
    url: string,
    options?: { ssr?: boolean }
  ): Promise<{ code?: string } | null>;
}

interface ResolvedConfig {
  root: string;
  command: string;
  mode: string;
  build: {
    cssCodeSplit?: boolean;
    lib?: { cssFileName?: string } | false;
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

interface LibraryCssSidecarContract {
  readonly ancestorStyleSpecifiers: readonly string[];
  readonly hasOwnCss: boolean;
}

interface PluginContext {
  addWatchFile: (id: string) => void;
  load?: (options: {
    id: string;
  }) => Promise<{ code?: string } | null> | { code?: string } | null;
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
  buildStart?: () => void;
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
  generateBundle?: {
    order: "post";
    handler: (
      this: OutputPluginContext,
      options: { format: string },
      bundle: Record<string, OutputBundleItem>
    ) => void | Promise<void>;
  };
}

// Alias for Plugin to match PluginOption
type PluginOption = Plugin;

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

type MinchoBabelOptions = BabelOptions;

interface StaticCssEvalSourceResolution {
  id: string;
  resolvedFile?: string;
  canonicalModuleId?: string;
  normalizedPathKey?: string;
  realpath?: string;
  sourceText?: string;
  sourceHash?: string;
  version?: string | number;
  sourceIdentity?: StaticCssEvalSourceIdentity;
  sourceKind?: StaticCssEvalSourceKind;
  sourceOrigin?: StaticCssEvalSourceOrigin;
  unsupportedReason?: StaticCssEvalSourceUnsupportedReason;
  watchFiles?: readonly string[];
  resolverKind?: StaticCssEvalResolverKind;
}

interface StaticCssEvalLoadedSource {
  source?: string;
  sourceText?: string;
  resolvedFile?: string;
  canonicalModuleId?: string;
  normalizedPathKey?: string;
  realpath?: string;
  sourceHash?: string;
  version?: string | number;
  sourceIdentity?: StaticCssEvalSourceIdentity;
  sourceKind?: StaticCssEvalSourceKind;
  sourceOrigin?: StaticCssEvalSourceOrigin;
  unsupportedReason?: StaticCssEvalSourceUnsupportedReason;
  watchFiles?: readonly string[];
  resolverKind?: StaticCssEvalResolverKind;
}

interface StaticCssEvalSourceIdentity {
  sourceHash?: string;
  version?: string | number;
}

type StaticCssEvalResolverKind =
  | "source-provider"
  | "filesystem"
  | "vite"
  | "esbuild"
  | "test"
  | (string & {});

type StaticCssEvalSourceKind =
  | "project-source"
  | "package-source"
  | "provider-virtual"
  | "static-data"
  | "external-no-source"
  | "unresolved"
  | "unsupported-source-shape";

type StaticCssEvalSourceOrigin =
  | "project"
  | "package"
  | "provider"
  | "data"
  | "external"
  | "unresolved"
  | "unsupported";

type StaticCssEvalSourceUnsupportedReason =
  | "external-no-source"
  | "unresolved"
  | "unsupported-source-shape";

interface StaticCssEvalSourceProvider {
  resolve(
    importerId: string,
    importPath: string
  ):
    | StaticCssEvalSourceResolution
    | Promise<StaticCssEvalSourceResolution | null>
    | null;
  load(
    id: string
  ):
    | StaticCssEvalLoadedSource
    | Promise<StaticCssEvalLoadedSource | null>
    | null;
}

type MinchoBabelOptionsWithStaticCssEval = Omit<
  MinchoBabelOptions,
  "staticCssEvalSourceProvider"
> & {
  staticCssEvalSourceProvider?: StaticCssEvalSourceProvider;
};

type BabelTransformResult = Omit<
  Awaited<ReturnType<typeof babelTransform>>,
  "staticCssEval"
> & {
  staticCssEval?: StaticCssEvalMetadata;
};

interface StaticCssEvalMetadata {
  dependencyFiles?: readonly string[];
  dependencies?: readonly StaticCssEvalResolutionDependency[];
  resolvedDependencies?: readonly StaticCssEvalResolvedDependency[];
  diagnostics?: readonly StaticCssEvalDiagnostic[];
  cacheKeys?: readonly StaticCssEvalCacheKey[];
  resolvedModuleIds?: readonly string[];
}

interface StaticCssEvalResolutionDependency {
  file: string;
  kind?: string;
  sourceKind?: StaticCssEvalSourceKind;
  sourceOrigin?: StaticCssEvalSourceOrigin;
  unsupportedReason?: StaticCssEvalSourceUnsupportedReason;
  watchFiles?: readonly string[];
}

interface StaticCssEvalResolvedDependency {
  resolvedFile: string;
  canonicalModuleId?: string;
  normalizedPathKey?: string;
  sourceKind?: StaticCssEvalSourceKind;
  sourceOrigin?: StaticCssEvalSourceOrigin;
  unsupportedReason?: StaticCssEvalSourceUnsupportedReason;
  watchFiles?: readonly string[];
}

interface StaticCssEvalDiagnostic {
  id?: string;
  dependency?: {
    file: string;
  };
}

interface StaticCssEvalCacheKey {
  importerFile?: string;
  resolvedFile?: string;
  resolvedId?: string;
  canonicalModuleId?: string;
  normalizedPathKey?: string;
  sourceKind?: StaticCssEvalSourceKind;
  sourceOrigin?: StaticCssEvalSourceOrigin;
  unsupportedReason?: StaticCssEvalSourceUnsupportedReason;
  watchFiles?: readonly string[];
  parserVersion?: string | number;
}

interface MinchoVitePluginOptions {
  babel?: MinchoBabelOptions;
  jsxCssProp?: boolean;
}

export function minchoVitePlugin(
  _options?: MinchoVitePluginOptions
): PluginOption {
  let config: ResolvedConfig;
  let server: ViteDevServer;
  const cssMap = new Map<string, string>();
  const resolverCache = new Map<string, string>();
  const resolvers = new Map<string, string>();
  const idToPluginData = new Map<string, Record<string, string>>();
  const staticCssEvalProjectEngine = new internalMinchoProjectEngine();
  const ownerToCssPaths = new Map<string, Set<string>>();
  const cssPathToVirtualCssIds = new Map<string, Set<string>>();
  const authorizedVirtualCssIds = new Set<string>();
  const libraryCssSidecarContracts = new Map<
    string,
    LibraryCssSidecarContract
  >();
  const virtualExt = ".vanilla.css";
  const virtualCssImportPrefix = "mincho-virtual-css:";
  const virtualCssIdPrefix = "\0mincho-virtual-css:";
  let rootRealpath = "";
  let libraryCssAssetFileName: string | undefined;

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

  function clearVirtualCssForSidecar(
    cssPath: string,
    invalidateModules = true
  ): void {
    const virtualCssIds = cssPathToVirtualCssIds.get(cssPath);
    if (!virtualCssIds) {
      return;
    }

    for (const virtualCssId of virtualCssIds) {
      cssMap.set(virtualCssId, "");
      authorizedVirtualCssIds.delete(virtualCssId);
      if (invalidateModules) {
        invalidateViteModule(virtualCssId);
      }
    }

    cssPathToVirtualCssIds.delete(cssPath);
  }

  function setVirtualCssForSidecar(
    cssPath: string,
    virtualCssId: string,
    source: string
  ): void {
    const virtualCssIds =
      cssPathToVirtualCssIds.get(cssPath) ?? new Set<string>();
    virtualCssIds.add(virtualCssId);
    cssPathToVirtualCssIds.set(cssPath, virtualCssIds);
    authorizedVirtualCssIds.add(virtualCssId);
    cssMap.set(virtualCssId, source);
  }

  function rememberGeneratedCssForOwner(
    ownerId: string,
    cssPath: string
  ): void {
    const cssPaths = ownerToCssPaths.get(ownerId) ?? new Set<string>();
    cssPaths.add(cssPath);
    ownerToCssPaths.set(ownerId, cssPaths);
  }

  function clearGeneratedCssForOwner(ownerId: string): void {
    libraryCssSidecarContracts.delete(ownerId);
    const cssPaths = ownerToCssPaths.get(ownerId);
    if (!cssPaths) {
      return;
    }

    for (const cssPath of cssPaths) {
      libraryCssSidecarContracts.delete(cssPath);
      resolvers.delete(cssPath);
      resolverCache.delete(cssPath);
      idToPluginData.delete(cssPath);
      idToPluginData.delete(customNormalize(cssPath));
      clearVirtualCssForSidecar(cssPath);
      invalidateViteModule(cssPath);
    }

    ownerToCssPaths.delete(ownerId);
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

  function invalidateStaticCssEvalDependency(dependencyId: string): void {
    for (const ownerId of staticCssEvalProjectEngine.invalidateByDependency(
      dependencyId
    )) {
      clearGeneratedCssForOwner(ownerId);
      invalidateViteModule(ownerId);
    }
  }

  function isWatchableStaticCssEvalDependency(id: string): boolean {
    return rootRealpath !== "" && fs.existsSync(id);
  }

  function collectLibraryCssSidecarContract(
    entryChunk: Extract<OutputBundleItem, { type: "chunk" }>,
    bundle: Record<string, OutputBundleItem>,
    getModuleInfo: OutputPluginContext["getModuleInfo"]
  ): {
    ancestorStyleSpecifiers: string[];
    cssAssetFileNames: string[];
    hasOwnCss: boolean;
  } {
    const ancestorStyleSpecifiers: string[] = [];
    const cssAssetFileNames: string[] = [];
    const seenModuleIds = new Set<string>();
    const seenChunkFileNames = new Set<string>();
    const seenCssAssetFileNames = new Set<string>();
    const seenStyleSpecifiers = new Set<string>();
    const virtualCssOwnerIds = new Set<string>();
    let hasOwnCss = false;

    for (const output of Object.values(bundle)) {
      if (output.type !== "chunk") continue;
      for (const moduleId of output.moduleIds ?? []) {
        if (moduleId.endsWith(virtualExt)) {
          virtualCssOwnerIds.add(moduleId.slice(0, -virtualExt.length));
        }
      }
    }

    const visit = (moduleId: string): void => {
      if (seenModuleIds.has(moduleId)) {
        return;
      }
      seenModuleIds.add(moduleId);
      hasOwnCss ||=
        moduleId.endsWith(".css") || virtualCssOwnerIds.has(moduleId);

      const moduleInfo = getModuleInfo(moduleId);
      for (const importedId of moduleInfo?.importedIds ?? []) {
        visit(importedId);
      }

      const contract = libraryCssSidecarContracts.get(moduleId);
      if (contract === undefined) {
        return;
      }
      hasOwnCss ||= contract.hasOwnCss;

      for (const specifier of contract.ancestorStyleSpecifiers) {
        if (!seenStyleSpecifiers.has(specifier)) {
          seenStyleSpecifiers.add(specifier);
          ancestorStyleSpecifiers.push(specifier);
        }
      }
    };

    const visitChunk = (
      chunk: Extract<OutputBundleItem, { type: "chunk" }>
    ) => {
      if (seenChunkFileNames.has(chunk.fileName)) {
        return;
      }
      seenChunkFileNames.add(chunk.fileName);

      const moduleIds =
        chunk.moduleIds ??
        (chunk.facadeModuleId === null ? [] : [chunk.facadeModuleId]);
      for (const moduleId of moduleIds) {
        visit(moduleId);
      }

      for (const importedFileName of chunk.imports ?? []) {
        const importedChunk = bundle[importedFileName];
        if (importedChunk?.type === "chunk") {
          visitChunk(importedChunk);
        }
      }

      for (const cssAssetFileName of chunk.viteMetadata?.importedCss ?? []) {
        if (!seenCssAssetFileNames.has(cssAssetFileName)) {
          seenCssAssetFileNames.add(cssAssetFileName);
          cssAssetFileNames.push(cssAssetFileName);
        }
      }
      hasOwnCss ||= (chunk.viteMetadata?.importedCss.size ?? 0) > 0;
    };

    visitChunk(entryChunk);
    return {
      ancestorStyleSpecifiers,
      cssAssetFileNames,
      hasOwnCss
    };
  }

  return {
    name: "mincho-css-vite",
    enforce: "pre",
    buildStart() {
      libraryCssSidecarContracts.clear();
      libraryCssAssetFileName = undefined;
    },
    configureServer(serverInstance: ViteDevServer) {
      server = serverInstance;
    },
    async configResolved(resolvedConfig: ResolvedConfig) {
      config = resolvedConfig;
      rootRealpath = await getRealpathOrResolvedPath(config.root);
    },
    resolveId(id: string, importer?: string) {
      if (id.startsWith(virtualCssImportPrefix)) {
        const physicalPath = id.slice(virtualCssImportPrefix.length);
        const virtualCssId = `${virtualCssIdPrefix}${physicalPath}`;
        const importerData =
          importer === undefined
            ? undefined
            : (idToPluginData.get(importer) ??
              idToPluginData.get(customNormalize(importer)));
        const trackedPhysicalPath =
          importerData?.filePath === undefined
            ? undefined
            : normalizePath(
                resolve(config.root, `${importerData.filePath}${virtualExt}`)
              );
        if (
          !physicalPath.endsWith(virtualExt) ||
          (!authorizedVirtualCssIds.has(virtualCssId) &&
            physicalPath !== trackedPhysicalPath)
        ) {
          return;
        }
        authorizedVirtualCssIds.add(virtualCssId);
        return virtualCssId;
      }
      if (id.startsWith("\0")) return;

      if (extractedCssFileFilter(id)) {
        const normalizedId = id.startsWith("/") ? id.slice(1) : id;
        const resolvedPath = normalizePath(join(importer!, "..", normalizedId));

        if (!resolvers.has(resolvedPath)) {
          return;
        }
        return resolvedPath;
      }

      if (id.endsWith(virtualExt)) {
        const exactId = normalizePath(id);
        if (cssMap.has(exactId)) {
          return exactId;
        }

        const normalizedId = id.startsWith("/") ? id.slice(1) : id;

        const key = normalizePath(resolve(config.root, normalizedId));
        if (cssMap.has(key)) {
          return key;
        }
      }
    },
    async load(
      id: string
    ): Promise<string | null | { code: string; map?: object | null }> {
      if (id.startsWith(virtualCssIdPrefix)) {
        if (!authorizedVirtualCssIds.has(id)) {
          return null;
        }
        const cached = cssMap.get(id);
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
      if (id.startsWith("\0")) {
        return null;
      }

      // Handle both old and new CSS file formats
      if (extractedCssFileFilter(id)) {
        const normalizedId = customNormalize(id);
        const pluginData = idToPluginData.get(normalizedId);

        if (!pluginData) {
          return null;
        }

        const resolverContents = resolvers.get(pluginData.path);

        if (!resolverContents) {
          return null;
        }

        idToPluginData.set(id, {
          ...idToPluginData.get(id),
          filePath: id,
          originalPath: pluginData.mainFilePath
        });

        return resolverContents;
      }

      if (id.endsWith(virtualExt)) {
        const cssFileId = normalizePath(resolve(config.root, id));
        const css = cssMap.get(cssFileId);

        if (typeof css !== "string") {
          return null;
        }

        return css;
      }
      return null;
    },
    async transform(this: PluginContext, code: string, id: string) {
      if (id.startsWith("\0")) return;
      const fileId = normalizeStaticCssEvalFileId(id, rootRealpath);
      if (config.command === "serve" || config.build.watch) {
        invalidateStaticCssEvalDependency(fileId);
      }

      const moduleInfo = idToPluginData.get(id);

      // Handle both old and new CSS file formats for transformation
      if (
        moduleInfo &&
        moduleInfo.originalPath &&
        moduleInfo.filePath &&
        extractedCssFileFilter(id)
      ) {
        try {
          resolverCache.delete(moduleInfo.originalPath);
          clearVirtualCssForSidecar(moduleInfo.filePath, false);
          const { source, watchFiles } = await compile({
            filePath: moduleInfo.filePath,
            cwd: config.root,
            originalPath: moduleInfo.originalPath,
            contents: code,
            resolverCache,
            externals: []
          });

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
              hasGeneratedVirtualCss = true;
              const id: string = `${fileScope.filePath}${virtualExt}`;
              const cssFileId = normalizePath(resolve(config.root, id));
              const virtualCssId = `${virtualCssIdPrefix}${cssFileId}`;

              if (server) {
                const { moduleGraph } = server;
                const module = moduleGraph.getModuleById(virtualCssId);

                if (module) {
                  moduleGraph.invalidateModule(module);
                  module.lastHMRTimestamp =
                    module.lastInvalidationTimestamp || Date.now();
                }
              }

              setVirtualCssForSidecar(
                moduleInfo.filePath,
                virtualCssId,
                source
              );

              return `import "${virtualCssImportPrefix}${cssFileId}";`;
            }
          });

          if (
            config.command === "build" &&
            config.build.lib &&
            (hasGeneratedVirtualCss ||
              registryResult.ancestorStyleSpecifiers.length > 0)
          ) {
            const contract: LibraryCssSidecarContract = {
              ancestorStyleSpecifiers: registryResult.ancestorStyleSpecifiers,
              hasOwnCss: hasGeneratedVirtualCss
            };
            libraryCssSidecarContracts.set(id, contract);
            if (ownerToCssPaths.get(moduleInfo.originalPath)?.size === 1) {
              libraryCssSidecarContracts.set(moduleInfo.originalPath, contract);
            } else {
              libraryCssSidecarContracts.delete(moduleInfo.originalPath);
            }
          } else {
            libraryCssSidecarContracts.delete(id);
            libraryCssSidecarContracts.delete(moduleInfo.originalPath);
          }

          return registryResult.source;
        } catch (error) {
          if (config.command === "build") {
            throw error;
          }

          console.error(error);
        }
      }

      if (/\.(j|t)sx?(\?used)?$/.test(id) && !id.endsWith(".vanilla.js")) {
        if (id.includes("node_modules") || /(^|\/)\.yarn\//.test(id)) return;

        if (id.endsWith(".css.ts")) {
          return;
        }

        try {
          await fs.promises.access(fileId, fs.constants.F_OK);
        } catch {
          return;
        }

        const babelOptions: MinchoBabelOptions | undefined =
          _options?.jsxCssProp === undefined
            ? _options?.babel
            : { ..._options.babel, jsxCssProp: _options.jsxCssProp };
        const transformBabelOptions: MinchoBabelOptions | undefined =
          babelOptions?.jsxCssProp === true
            ? {
                ...babelOptions,
                staticCssEvalProjectEngine,
                staticCssEvalSourceProvider:
                  createViteStaticCssEvalSourceProvider(
                    this,
                    fileId,
                    code,
                    rootRealpath,
                    server
                  )
              }
            : babelOptions;
        let transformResult: BabelTransformResult;

        try {
          transformResult = (await babelTransform(
            fileId,
            transformBabelOptions
          )) as BabelTransformResult;
        } catch (error) {
          addStaticCssEvalWatchFilesForOwner(this, fileId);
          throw error;
        }
        const {
          code: transformedCode,
          jsxCssPropTransformed,
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
            clearGeneratedCssForOwner(fileId);
          }
          if (
            babelOptions?.jsxCssProp === true &&
            jsxCssPropTransformed === true
          ) {
            return {
              code: transformedCode,
              map: { mappings: "" }
            };
          }

          return null;
        }

        if (config.command === "build" && config.build.watch) {
          this.addWatchFile(file);
        }

        const resolvedCssPath = normalizePath(join(fileId, "..", file));

        if (server && resolvers.has(resolvedCssPath)) {
          const { moduleGraph } = server;

          const module = moduleGraph.getModuleById(resolvedCssPath);
          if (module) {
            moduleGraph.invalidateModule(module);
          }
        }

        const normalizedCssPath = customNormalize(resolvedCssPath);

        resolvers.set(resolvedCssPath, cssExtract);
        rememberGeneratedCssForOwner(fileId, resolvedCssPath);
        resolverCache.delete(fileId);
        idToPluginData.delete(fileId);
        idToPluginData.delete(normalizedCssPath);

        idToPluginData.set(fileId, {
          ...idToPluginData.get(fileId),
          mainFilePath: fileId
        });
        idToPluginData.set(normalizedCssPath, {
          ...idToPluginData.get(normalizedCssPath),
          mainFilePath: fileId,
          path: resolvedCssPath
        });

        return {
          code: transformedCode,
          map: { mappings: "" }
        };
      }
      return null;
    },
    generateBundle: {
      order: "post",
      async handler(outputOptions, bundle) {
        if (
          config.command !== "build" ||
          !config.build.lib ||
          (outputOptions.format !== "es" && outputOptions.format !== "cjs")
        ) {
          return;
        }

        const cssAssets = Object.values(bundle).filter(
          (output) =>
            output.type === "asset" && output.fileName.endsWith(".css")
        );
        const entryChunks = Object.values(bundle).filter(
          (output) => output.type === "chunk" && output.isEntry
        );

        for (const chunk of entryChunks) {
          if (chunk.type !== "chunk") continue;
          const entryId = chunk.facadeModuleId;
          if (entryId === null) continue;

          const {
            ancestorStyleSpecifiers,
            cssAssetFileNames: collectedCssAssetFileNames,
            hasOwnCss
          } = collectLibraryCssSidecarContract(
            chunk,
            bundle,
            this.getModuleInfo
          );

          const cssAssetFileNames =
            config.build.cssCodeSplit === true
              ? collectedCssAssetFileNames
              : hasOwnCss
                ? (() => {
                    const emittedCssAssetFileNames = cssAssets.map(
                      (asset) => asset.fileName
                    );
                    const [emittedCssAssetFileName] = emittedCssAssetFileNames;
                    if (
                      emittedCssAssetFileNames.length === 1 &&
                      emittedCssAssetFileName !== undefined
                    ) {
                      libraryCssAssetFileName = emittedCssAssetFileName;
                    }
                    return emittedCssAssetFileNames.length === 0 &&
                      libraryCssAssetFileName !== undefined
                      ? [libraryCssAssetFileName]
                      : emittedCssAssetFileNames;
                  })()
                : [];
          if (
            ancestorStyleSpecifiers.length === 0 &&
            cssAssetFileNames.length === 0
          ) {
            continue;
          }
          if (
            (config.build.cssCodeSplit !== true &&
              hasOwnCss &&
              cssAssetFileNames.length === 0) ||
            (config.build.cssCodeSplit !== true && cssAssetFileNames.length > 1)
          ) {
            throw new Error(
              `[mincho-css-vite] Library CSS sidecar for entry chunk ${chunk.fileName} expected one emitted CSS asset for unsplit output or at least one for split output, found ${cssAssetFileNames.length}`
            );
          }

          for (const specifier of ancestorStyleSpecifiers) {
            const resolved = await this.resolve(
              specifier,
              chunk.facadeModuleId ?? undefined,
              { skipSelf: true }
            );
            if (resolved === null) {
              throw new Error(
                `[mincho-css-vite] Library CSS sidecar ${specifier} required by entry chunk ${chunk.fileName} is not exported by its package`
              );
            }
          }

          for (const cssAssetFileName of cssAssetFileNames) {
            if (
              config.build.cssCodeSplit === true &&
              !cssAssets.some((asset) => asset.fileName === cssAssetFileName)
            ) {
              throw new Error(
                `[mincho-css-vite] Library CSS sidecar for entry chunk ${chunk.fileName} references missing CSS asset ${cssAssetFileName}`
              );
            }
          }

          const ownStyleSpecifiers = cssAssetFileNames.map(
            (cssAssetFileName) => {
              const relativeCssPath = posix.relative(
                posix.dirname(chunk.fileName),
                cssAssetFileName
              );
              return relativeCssPath.startsWith(".")
                ? relativeCssPath
                : `./${relativeCssPath}`;
            }
          );
          const styleSpecifiers = [
            ...ancestorStyleSpecifiers,
            ...ownStyleSpecifiers
          ];
          const statements = styleSpecifiers.map((specifier) =>
            outputOptions.format === "cjs"
              ? `require(${JSON.stringify(specifier)});`
              : `import ${JSON.stringify(specifier)};`
          );
          const prologueEnd = findChunkDirectivePrologueEnd(chunk.code);
          chunk.code = `${chunk.code.slice(0, prologueEnd)}${statements.join("\n")}\n${chunk.code.slice(prologueEnd)}`;
        }
      }
    }
  } as PluginOption;
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

function customNormalize(path: string) {
  return path.startsWith("/") ? path.slice(1) : path;
}

function createViteStaticCssEvalSourceProvider(
  pluginContext: PluginContext,
  ownerId: string,
  ownerSource: string,
  rootRealpath: string,
  serverInstance?: ViteDevServer
): StaticCssEvalSourceProvider {
  return {
    async resolve(importerId: string, importPath: string) {
      const resolved = await pluginContext.resolve?.(importPath, importerId, {
        skipSelf: true
      });

      if (!resolved) {
        return null;
      }

      if (resolved.external) {
        return createExternalStaticCssEvalResolution(resolved.id);
      }

      if (isVirtualStaticCssEvalId(resolved.id)) {
        return canLoadViteStaticCssEvalVirtualSource(
          pluginContext,
          serverInstance
        )
          ? createViteStaticCssEvalVirtualResolution(resolved.id)
          : createUnsupportedStaticCssEvalResolution(importPath);
      }

      const fileId = normalizeStaticCssEvalFileId(resolved.id, rootRealpath);
      const resolvedRealpath = await getExistingRealpath(fileId);

      if (!resolvedRealpath) {
        return null;
      }

      let stat: fs.Stats;

      try {
        stat = await fs.promises.stat(resolvedRealpath);
      } catch (error) {
        if (isMissingFileSystemEntryError(error)) {
          return null;
        }

        throw error;
      }

      const metadata = createViteStaticCssEvalFileMetadata({
        id: resolved.id,
        realpath: resolvedRealpath,
        rootRealpath,
        stat
      });

      return { id: metadata.resolvedFile, ...metadata };
    },
    async load(id: string) {
      const fileId = normalizeStaticCssEvalFileId(id, rootRealpath);

      if (fileId === ownerId) {
        const ownerRealpath = await getExistingRealpath(fileId);
        const stat = ownerRealpath
          ? await getExistingStat(ownerRealpath)
          : null;
        const sourceIdentity = stat
          ? createStaticCssEvalSourceIdentity(stat)
          : undefined;
        return {
          sourceText: ownerSource,
          source: ownerSource,
          resolvedFile: ownerRealpath ?? ownerId,
          canonicalModuleId: ownerId,
          normalizedPathKey: ownerId,
          ...(ownerRealpath ? { realpath: ownerRealpath } : {}),
          ...(sourceIdentity ? { sourceIdentity } : {}),
          sourceKind: "project-source",
          sourceOrigin: "project",
          ...(ownerRealpath ? { watchFiles: [ownerRealpath] } : {}),
          resolverKind: "vite"
        };
      }

      if (isUnsupportedStaticCssEvalResolutionId(id)) {
        return {
          sourceText: "export {};",
          source: "export {};",
          sourceKind: "unsupported-source-shape",
          sourceOrigin: "unsupported",
          unsupportedReason: "unsupported-source-shape",
          resolverKind: "vite"
        };
      }

      if (isExternalStaticCssEvalResolutionId(id)) {
        return null;
      }

      if (isVirtualStaticCssEvalId(id)) {
        const virtualSource = await loadViteStaticCssEvalVirtualSource(
          id,
          pluginContext,
          serverInstance
        );

        return virtualSource
          ? {
              sourceText: virtualSource,
              source: virtualSource,
              resolvedFile: id,
              canonicalModuleId: id,
              normalizedPathKey: id,
              sourceKind: "provider-virtual",
              sourceOrigin: "provider",
              resolverKind: "vite"
            }
          : null;
      }

      const realpath = await getExistingRealpath(fileId);
      if (!realpath) {
        return null;
      }

      let fileSource: string;
      let stat: fs.Stats;

      try {
        [fileSource, stat] = await Promise.all([
          fs.promises.readFile(realpath, "utf8"),
          fs.promises.stat(realpath)
        ]);
      } catch (error) {
        if (isMissingFileSystemEntryError(error)) {
          return null;
        }

        throw error;
      }
      const metadata = createViteStaticCssEvalFileMetadata({
        id,
        realpath,
        rootRealpath,
        stat
      });
      const source = getViteStaticCssEvalStaticDataSource({
        id,
        realpath,
        rootRealpath,
        source: fileSource
      });
      return {
        sourceText: source,
        source,
        ...metadata
      };
    }
  };
}

interface ViteStaticCssEvalFileMetadataOptions {
  id: string;
  realpath: string;
  rootRealpath: string;
  stat: fs.Stats;
}

function createViteStaticCssEvalFileMetadata({
  id,
  realpath,
  rootRealpath,
  stat
}: ViteStaticCssEvalFileMetadataOptions): Required<
  Pick<
    StaticCssEvalSourceResolution,
    | "canonicalModuleId"
    | "normalizedPathKey"
    | "realpath"
    | "resolvedFile"
    | "resolverKind"
    | "sourceHash"
    | "sourceIdentity"
    | "sourceKind"
    | "sourceOrigin"
    | "version"
    | "watchFiles"
  >
> {
  const sourceHash = createStaticCssEvalSourceHash(stat);
  const version = stat.mtimeMs;
  const sourceIdentity: Required<
    Pick<StaticCssEvalSourceIdentity, "sourceHash" | "version">
  > = {
    sourceHash,
    version
  };
  const sourceKind = getViteStaticCssEvalFileSourceKind({
    id,
    realpath,
    rootRealpath
  });
  const querySuffix =
    sourceKind === "static-data" ? getViteStaticCssEvalQuerySuffix(id) : "";
  const resolvedFile = `${realpath}${querySuffix}`;

  return {
    resolvedFile,
    canonicalModuleId: resolvedFile,
    normalizedPathKey: resolvedFile,
    realpath,
    sourceHash: sourceIdentity.sourceHash,
    version: sourceIdentity.version,
    sourceIdentity,
    sourceKind,
    sourceOrigin: getViteStaticCssEvalSourceOrigin(sourceKind),
    watchFiles: [realpath],
    resolverKind: "vite"
  };
}

function getViteStaticCssEvalFileSourceKind({
  id,
  realpath,
  rootRealpath
}: Pick<
  ViteStaticCssEvalFileMetadataOptions,
  "id" | "realpath" | "rootRealpath"
>): StaticCssEvalSourceKind {
  if (isStaticCssEvalStaticDataFile(id, realpath)) {
    return "static-data";
  }

  return hasNodeModulesSegment(realpath) ||
    !isPathInsideRoot(rootRealpath, realpath)
    ? "package-source"
    : "project-source";
}

function getViteStaticCssEvalSourceOrigin(
  sourceKind: StaticCssEvalSourceKind
): StaticCssEvalSourceOrigin {
  switch (sourceKind) {
    case "project-source":
      return "project";
    case "package-source":
      return "package";
    case "provider-virtual":
      return "provider";
    case "static-data":
      return "data";
    case "external-no-source":
      return "external";
    case "unresolved":
      return "unresolved";
    case "unsupported-source-shape":
      return "unsupported";
    default:
      return assertNeverStaticCssEvalSourceKind(sourceKind);
  }
}

function getViteStaticCssEvalQueryFlags(id: string): string[] {
  const querySuffix = getViteStaticCssEvalQuerySuffix(id);

  if (querySuffix === "") {
    return [];
  }

  return querySuffix
    .slice(1)
    .split("&")
    .map((part) => part.split("=")[0])
    .filter((flag) => flag !== "");
}

function getViteStaticCssEvalQuerySuffix(id: string): string {
  const queryStart = id.indexOf("?");

  if (queryStart === -1) {
    return "";
  }

  const hashStart = id.indexOf("#", queryStart);

  return id.slice(queryStart, hashStart === -1 ? undefined : hashStart);
}

function getViteStaticCssEvalStaticDataSource(options: {
  id: string;
  realpath: string;
  rootRealpath: string;
  source: string;
}): string {
  const flags = getViteStaticCssEvalQueryFlags(options.id);

  if (flags.includes("url")) {
    const assetUrl = getViteStaticCssEvalUrlSource(
      options.realpath,
      options.rootRealpath
    );

    return `export default ${JSON.stringify(assetUrl)};\n`;
  }

  return prepareStaticCssEvalStaticDataSource(options.id, options.source);
}

function getViteStaticCssEvalUrlSource(
  realpath: string,
  rootRealpath: string
): string {
  const normalizedRealpath = normalizePath(realpath);
  const normalizedRootRealpath = normalizePath(rootRealpath);

  if (isPathInsideRoot(normalizedRootRealpath, normalizedRealpath)) {
    return `/${customNormalize(normalizedRealpath.slice(normalizedRootRealpath.length))}`;
  }

  return `/@fs/${customNormalize(normalizedRealpath)}`;
}

function createViteStaticCssEvalVirtualResolution(
  id: string
): StaticCssEvalSourceResolution {
  return {
    id,
    resolvedFile: id,
    canonicalModuleId: id,
    normalizedPathKey: id,
    sourceKind: "provider-virtual",
    sourceOrigin: "provider",
    resolverKind: "vite"
  };
}

function canLoadViteStaticCssEvalVirtualSource(
  pluginContext: PluginContext,
  serverInstance: ViteDevServer | undefined
): boolean {
  return Boolean(serverInstance?.transformRequest || pluginContext.load);
}

async function loadViteStaticCssEvalVirtualSource(
  id: string,
  pluginContext: PluginContext,
  serverInstance: ViteDevServer | undefined
): Promise<string | null> {
  const transformed = await serverInstance?.transformRequest?.(id, {
    ssr: true
  });

  if (typeof transformed?.code === "string") {
    return transformed.code;
  }

  const loaded = await pluginContext.load?.({ id });

  return typeof loaded?.code === "string" ? loaded.code : null;
}

function createExternalStaticCssEvalResolution(
  id: string
): StaticCssEvalSourceResolution {
  const resolvedId = `${externalStaticCssEvalResolutionPrefix}${encodeURIComponent(
    id
  )}`;

  return {
    id: resolvedId,
    resolvedFile: resolvedId,
    canonicalModuleId: id,
    normalizedPathKey: resolvedId,
    sourceKind: "external-no-source",
    sourceOrigin: "external",
    unsupportedReason: "external-no-source",
    resolverKind: "vite"
  };
}

function createUnsupportedStaticCssEvalResolution(
  importPath: string
): StaticCssEvalSourceResolution {
  const id = `virtual:mincho-static-css-eval-unsupported:${encodeURIComponent(
    importPath
  )}`;

  return {
    id,
    resolvedFile: id,
    canonicalModuleId: id,
    normalizedPathKey: id,
    sourceKind: "unsupported-source-shape",
    sourceOrigin: "unsupported",
    unsupportedReason: "unsupported-source-shape",
    resolverKind: "vite"
  };
}

function isUnsupportedStaticCssEvalResolutionId(id: string): boolean {
  return id.startsWith("virtual:mincho-static-css-eval-unsupported:");
}

function isExternalStaticCssEvalResolutionId(id: string): boolean {
  return id.startsWith(externalStaticCssEvalResolutionPrefix);
}

function assertNeverStaticCssEvalSourceKind(value: never): never {
  throw new TypeError(`Unexpected static css eval source kind: ${value}`);
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
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
      .spyOn(integrationModule, "babelTransform")
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
        plugins: [minchoVitePlugin() as never],
        build: {
          cssMinify: false,
          emptyOutDir: false,
          lib: {
            entry: entryPath,
            fileName: "index",
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
    const plugin = minchoVitePlugin(pluginOptions);
    const resolvedConfig = createResolvedConfig(configOverrides);
    const watchFiles: string[] = [];

    await plugin.configResolved?.(resolvedConfig);
    if (server) {
      plugin.configureServer?.(server);
    }

    return {
      buildStart() {
        plugin.buildStart?.();
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
        return plugin.generateBundle?.handler.call(
          {
            getModuleInfo: getModuleInfo ?? (() => null),
            resolve: resolveOutputImport
          },
          { format },
          bundle
        );
      },
      resolveId(id: string, importer?: string) {
        return plugin.resolveId?.(id, importer);
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
                resolveViteHarnessImport(source, importer, resolvedConfig.root))
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
      extractedSource
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
        babelTransform: typeof babelTransform;
      }>
    ]);

    return vi
      .spyOn(integrationModule, "babelTransform")
      .mockImplementation(sourceIntegrationModule.babelTransform);
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

        vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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
        } as unknown as BabelTransformResult);

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

        vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
          code: fixture.entrySource,
          result: ["", ""],
          staticCssEval:
            createDuplicatedStaticCssEvalMetadataVariants(stylesRealpath)
        } as unknown as BabelTransformResult);

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
          fixture.entryPath,
          expect.objectContaining({
            jsxCssProp: true,
            staticCssEvalSourceProvider: expect.any(Object)
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

        babelTransformSpy.mockResolvedValue({
          code: "export const App = () => null;",
          result: ["", ""],
          staticCssEval: undefined
        } as unknown as BabelTransformResult);
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
        vi.spyOn(integrationModule, "babelTransform").mockImplementation(
          async (
            _path: string,
            options: MinchoBabelOptionsWithStaticCssEval = {}
          ) => {
            const sourceProvider = (
              options as MinchoBabelOptionsWithStaticCssEval | undefined
            )?.staticCssEvalSourceProvider;

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

            return {
              code: fixture.entrySource,
              result: ["", ""],
              staticCssEval: {
                dependencyFiles: [
                  captured.resolution.resolvedFile ?? captured.resolution.id
                ]
              }
            } as unknown as BabelTransformResult;
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

        vi.spyOn(integrationModule, "babelTransform").mockImplementation(
          async (
            _path: string,
            options: MinchoBabelOptionsWithStaticCssEval = {}
          ) => {
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

            return {
              code: fixture.source,
              result: ["", ""]
            } as unknown as BabelTransformResult;
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
            transformRequest: virtualTransform
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
        expect(virtualTransform).toHaveBeenCalledWith(virtualId, { ssr: true });
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
            async transformRequest(id) {
              return id === virtualId
                ? {
                    code: 'export const virtualButton = { color: "blue" } as const;'
                  }
                : null;
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

        vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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
        } as unknown as BabelTransformResult);

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
        const transformResult: BabelTransformResult = {
          code: fixture.entrySource,
          result: ["", ""],
          staticCssEval: createExportStarStaticCssEvalMetadata({
            barrelPath: barrelRealpath,
            explicitDefaultPath: resetRealpath,
            terminalLeafPath: buttonRealpath
          })
        };
        vi.spyOn(integrationModule, "babelTransform").mockResolvedValue(
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
            transformRequest: vi.fn(async () => null)
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
          fixture.entryPath,
          expect.objectContaining({
            jsxCssProp: true,
            staticCssEvalSourceProvider: expect.any(Object)
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
          fixture.entryPath,
          expect.objectContaining({
            jsxCssProp: true,
            staticCssEvalSourceProvider: expect.any(Object)
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
        expectedOptions?: MinchoBabelOptions;
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
            fixture.entryPath,
            disabledCase.expectedOptions
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

      vi.spyOn(integrationModule, "babelTransform")
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
        expect(processOrder).toEqual([`start:${firstFixture.extractedId}`]);
      });

      firstDeferred.resolve(createV5PresetBuildSource("provider-a_class"));
      const firstTransformResult = await firstTransformPromise;
      assertString(
        firstTransformResult,
        "Expected the first queued transform to return source text"
      );

      await vi.waitFor(() => {
        expect(processOrder).toEqual([
          `start:${firstFixture.extractedId}`,
          `end:${firstFixture.extractedId}`,
          `start:${secondFixture.extractedId}`
        ]);
      });

      secondDeferred.resolve(createV5PresetBuildSource("provider-b_class"));
      const secondTransformResult = await secondTransformPromise;
      assertString(
        secondTransformResult,
        "Expected the second queued transform to return source text"
      );

      expect(processOrder).toEqual([
        `start:${firstFixture.extractedId}`,
        `end:${firstFixture.extractedId}`,
        `start:${secondFixture.extractedId}`,
        `end:${secondFixture.extractedId}`
      ]);
      expect(registrySpy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          filePath: firstFixture.extractedId,
          identOption: "short",
          source: `compiled source:${firstFixture.extractedId}`,
          serializeVirtualCssPath: expect.any(Function)
        })
      );
      expect(registrySpy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          filePath: secondFixture.extractedId,
          identOption: "short",
          source: `compiled source:${secondFixture.extractedId}`,
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

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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

      expect(registrySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: extractedId,
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
          plugins: [minchoVitePlugin() as never],
          build: {
            cssMinify: false,
            emptyOutDir: false,
            lib: {
              entry: entryPath,
              fileName: "index",
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
      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      const harness = await createViteHarness();
      const fixture = await createExtractedCssFixture(harness);
      const physicalPath = `${fixture.extractedId}.vanilla.css`;
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
      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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

    it("preserves virtual CSS IDs across build starts", async () => {
      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      const harness = await createViteHarness();
      const fixture = await createExtractedCssFixture(harness);
      const physicalPath = `${fixture.extractedId}.vanilla.css`;
      const importId = `mincho-virtual-css:${physicalPath}`;
      const resolvedVirtualId = harness.resolveId(
        importId,
        fixture.extractedId
      );

      if (typeof resolvedVirtualId !== "string") {
        throw new Error("Expected generated virtual CSS ID to resolve");
      }
      expect(await harness.load(resolvedVirtualId)).not.toBeNull();

      harness.buildStart();

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

      vi.spyOn(integrationModule, "babelTransform").mockImplementation(
        async (filePath: string) => {
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
          "style.css": { fileName: "style.css", type: "asset" }
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
          "style.css": { fileName: "style.css", type: "asset" }
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
          "style.css": { fileName: "style.css", type: "asset" }
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

    it("clears library CSS sidecars when a watched owner stops emitting CSS", async () => {
      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransform")
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
        vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
          code: 'import "extracted_diamond.css.ts";\nexport const entry = true;',
          result: ["extracted_diamond.css.ts", fixtureSource]
        });

        for (const format of ["es", "cjs"] as const) {
          const buildResult = await build({
            root: fixtureRoot,
            configFile: false,
            logLevel: "silent",
            plugins: [minchoVitePlugin() as never],
            build: {
              cssMinify: false,
              emptyOutDir: false,
              lib: {
                entry: entryPath,
                fileName: "entry",
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
      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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
          facadeModuleId: viteConsumerEntryPath,
          fileName: `entries/no-css.${extension}`,
          isEntry: true,
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

      vi.spyOn(integrationModule, "babelTransform")
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
          expect.objectContaining({ filePath: firstFixture.extractedId })
        );
      });
      await harness.transform(
        secondFixture.extractedId,
        secondFixture.extractedSource
      );
      firstCompile.resolve({
        source: `compiled source:${firstFixture.extractedId}`,
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
          "style.css": { fileName: "style.css", type: "asset" }
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
      vi.spyOn(integrationModule, "babelTransform")
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
      const ancestorStyleSpecifiersByModuleId = new Map<string, string[]>();
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
              ancestorStyleSpecifiersByModuleId.get(options.filePath) ?? []
          };
        }
      );

      const harness = await createViteHarness({
        configOverrides: { build: { lib: {}, watch: false } }
      });
      const firstSharedFixture = await createExtractedCssFixture(harness);
      const secondSharedFixture = await createExtractedCssFixture(harness);
      const dynamicFixture = await createExtractedCssFixture(harness);
      ancestorStyleSpecifiersByModuleId.set(firstSharedFixture.extractedId, [
        "@scope/shared-first/style.css"
      ]);
      ancestorStyleSpecifiersByModuleId.set(secondSharedFixture.extractedId, [
        "@scope/shared-second/style.css"
      ]);
      ancestorStyleSpecifiersByModuleId.set(dynamicFixture.extractedId, [
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
        "style.css": { fileName: "style.css", type: "asset" }
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
      vi.spyOn(integrationModule, "babelTransform")
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
      harness.buildStart();
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
        "style.css": { fileName: "style.css", type: "asset" }
      });
      expect(firstChunk.code).toBe(
        'import "./style.css";\nexport const first = true;'
      );

      harness.buildStart();
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

    it("injects the emitted unsplit library CSS asset into each output format", async () => {
      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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
        configOverrides: {
          build: {
            cssCodeSplit: false,
            lib: { cssFileName: "configured-style" },
            watch: false
          }
        }
      });
      harness.buildStart();
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
        "relocated/style-C4D2.css": {
          fileName: "relocated/style-C4D2.css",
          type: "asset"
        }
      });
      await harness.generateBundle("cjs", {
        [cjsChunk.fileName]: cjsChunk
      });

      expect(esChunk.code).toBe(
        'import "../relocated/style-C4D2.css";\nexport const entry = true;'
      );
      expect(cjsChunk.code).toBe(
        'require("../relocated/style-C4D2.css");\nexports.entry = true;'
      );
    });
    it("reports missing library CSS assets and ancestor style exports", async () => {
      const integrationModule = await import("@mincho-js/integration");
      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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
      ).rejects.toThrow("entry chunk entry.mjs expected one emitted CSS asset");
      await expect(
        harness.generateBundle(
          "es",
          {
            "entry.mjs": entryChunk,
            "style.css": { fileName: "style.css", type: "asset" }
          },
          async () => null
        )
      ).rejects.toThrow(
        "@scope/ancestor/style.css required by entry chunk entry.mjs is not exported"
      );
    });

    it("real Vite registry builds helper-wrapped, IIFE, nested, multiple instances, and imported helper fixtures", async () => {
      const realBuildCaseIds = [
        "registry-helper-wrapped-executed",
        "registry-iife-executed",
        "registry-nested-function-executed",
        "registry-multiple-instances",
        "registry-imported-helper-executed"
      ];

      for (const caseId of realBuildCaseIds) {
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
      }
    }, 20000);

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

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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
        vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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

        expect(registrySpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: extractedId,
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
      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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
      } = await babelTransform(viteConsumerEntryPath);

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
      } = await babelTransform(viteConsumerEntryPath);

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

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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
        const cacheRoot = createViteFixtureCacheRoot();
        await fs.promises.mkdir(cacheRoot, { recursive: true });
        suiteRoot = await fs.promises.mkdtemp(
          join(cacheRoot, "shared-component-package-")
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
          join(getSharedComponentPackageRoot(), ".cache/typescript-esm"),
          join(installedPackageRoot, "dist/esm"),
          { recursive: true }
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

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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
      const { extractedId, extractedSource } =
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
          filePath: extractedId,
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
          filePath: extractedId,
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

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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
          filePath: extractedId,
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

      vi.spyOn(integrationModule, "babelTransform").mockResolvedValue({
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
