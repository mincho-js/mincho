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
  internalNormalizeStaticCssEvalFileId as normalizeStaticCssEvalFileId,
  internalPrepareStaticCssEvalStaticDataSource as prepareStaticCssEvalStaticDataSource,
  internalStaticCssEvalExternalResolutionPrefix as externalStaticCssEvalResolutionPrefix,
  processDefineRulesPresetRegistryFile,
  runDefineRulesPresetRegistryStep
} from "@mincho-js/integration";
import { normalizePath } from "@rollup/pluginutils";
import { dirname, join, resolve } from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

interface Module {
  lastHMRTimestamp?: number;
  lastInvalidationTimestamp?: number;
}

// Define local interfaces instead of importing directly from Vite
interface ViteDevServer {
  moduleGraph: {
    getModuleById: (id: string) => Module | undefined;
    getModulesByFile?: (file: string) => Set<Module> | undefined;
    invalidateModule: (module: Module) => void;
  };
  transformRequest?: (
    url: string,
    options?: { ssr?: boolean }
  ) => Promise<{ code?: string } | null>;
}

interface ResolvedConfig {
  root: string;
  command: string;
  mode: string;
  build: {
    watch: boolean;
  };
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
  enforce?: string;
  buildStart?: () => void;
  configureServer?: (server: ViteDevServer) => void;
  configResolved?: (config: ResolvedConfig) => void | Promise<void>;
  resolveId?: (id: string, importer?: string) => string | undefined;
  load?: (id: string) => unknown | Promise<unknown>;
  transform?: (code: string, id: string) => unknown | Promise<unknown>;
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

type MinchoBabelOptions = BabelOptions & { jsxCssProp?: boolean };

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
  const ownerToStaticCssEvalDependencies = new Map<string, Set<string>>();
  const dependencyToStaticCssEvalOwners = new Map<string, Set<string>>();
  const ownerToCssPaths = new Map<string, Set<string>>();
  const cssPathToVirtualCssIds = new Map<string, Set<string>>();
  const virtualExt = ".vanilla.css";
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

  function clearVirtualCssForSidecar(
    cssPath: string,
    invalidateModules = true
  ): void {
    const virtualCssIds = cssPathToVirtualCssIds.get(cssPath);
    if (!virtualCssIds) {
      return;
    }

    for (const virtualCssId of virtualCssIds) {
      cssMap.delete(virtualCssId);
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
    const cssPaths = ownerToCssPaths.get(ownerId);
    if (!cssPaths) {
      return;
    }

    for (const cssPath of cssPaths) {
      resolvers.delete(cssPath);
      resolverCache.delete(cssPath);
      idToPluginData.delete(cssPath);
      idToPluginData.delete(customNormalize(cssPath));
      clearVirtualCssForSidecar(cssPath);
      invalidateViteModule(cssPath);
    }

    ownerToCssPaths.delete(ownerId);
  }

  function removeStaticCssEvalDependenciesForOwner(ownerId: string): void {
    const dependencies = ownerToStaticCssEvalDependencies.get(ownerId);
    if (!dependencies) {
      return;
    }

    for (const dependency of dependencies) {
      const owners = dependencyToStaticCssEvalOwners.get(dependency);
      if (!owners) {
        continue;
      }

      owners.delete(ownerId);
      if (owners.size === 0) {
        dependencyToStaticCssEvalOwners.delete(dependency);
      }
    }

    ownerToStaticCssEvalDependencies.delete(ownerId);
  }

  function replaceStaticCssEvalDependenciesForOwner(
    pluginContext: PluginContext,
    ownerId: string,
    staticCssEval: StaticCssEvalMetadata | undefined
  ): void {
    // Vite invalidation consumes shared Babel/integration metadata as truth.
    // This layer normalizes watch ids; it does not infer css symbol provenance.
    removeStaticCssEvalDependenciesForOwner(ownerId);

    const dependencyIds = collectStaticCssEvalDependencyIds(
      staticCssEval
    ) as Array<string>;
    const dependencies = new Set<string>(
      dependencyIds
        .map((dependency) =>
          normalizeStaticCssEvalFileId(dependency, rootRealpath)
        )
        .filter(
          (dependency) =>
            dependency !== ownerId &&
            isWatchableStaticCssEvalDependency(dependency)
        )
    );

    if (dependencies.size === 0) {
      return;
    }

    ownerToStaticCssEvalDependencies.set(ownerId, dependencies);

    for (const dependency of dependencies) {
      const owners =
        dependencyToStaticCssEvalOwners.get(dependency) ?? new Set<string>();
      owners.add(ownerId);
      dependencyToStaticCssEvalOwners.set(dependency, owners);
      pluginContext.addWatchFile(dependency);
    }
  }

  function invalidateStaticCssEvalDependency(dependencyId: string): void {
    const owners = dependencyToStaticCssEvalOwners.get(dependencyId);
    if (!owners) {
      return;
    }

    for (const ownerId of owners) {
      clearGeneratedCssForOwner(ownerId);
      invalidateViteModule(ownerId);
    }
  }

  function isWatchableStaticCssEvalDependency(id: string): boolean {
    return rootRealpath !== "" && fs.existsSync(id);
  }

  return {
    name: "mincho-css-vite",
    enforce: "pre",
    buildStart() {
      // resolvers.clear();
      // resolverCache.clear();
      // cssMap.clear();
      // idToPluginData.clear();
    },
    configureServer(serverInstance: ViteDevServer) {
      server = serverInstance;
    },
    async configResolved(resolvedConfig: ResolvedConfig) {
      config = resolvedConfig;
      rootRealpath = await getRealpathOrResolvedPath(config.root);
    },
    resolveId(id: string, importer?: string) {
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
      invalidateStaticCssEvalDependency(fileId);

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

          const contents = await processDefineRulesPresetViteFile({
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
              const id: string = `${fileScope.filePath}${virtualExt}`;
              const cssFileId = normalizePath(resolve(config.root, id));

              if (server) {
                const { moduleGraph } = server;
                const moduleId = normalizePath(join(config.root, id));
                const module = moduleGraph.getModuleById(moduleId);

                if (module) {
                  moduleGraph.invalidateModule(module);
                  module.lastHMRTimestamp =
                    module.lastInvalidationTimestamp || Date.now();
                }
              }

              setVirtualCssForSidecar(moduleInfo.filePath, cssFileId, source);

              return `import "${id}";`;
            }
          });

          return contents;
        } catch (error) {
          if (config.command === "build") {
            throw error;
          }

          console.error(error);
        }
      }

      if (/(j|t)sx?(\?used)?$/.test(id) && !id.endsWith(".vanilla.js")) {
        if (id.includes("node_modules")) return;

        if (id.endsWith(".css.ts")) return;

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
          replaceStaticCssEvalDependenciesForOwner(
            this,
            fileId,
            getStaticCssEvalFromTransformError(error)
          );
          throw error;
        }
        const {
          code: transformedCode,
          jsxCssPropTransformed,
          result: [file, cssExtract],
          staticCssEval
        } = transformResult;

        replaceStaticCssEvalDependenciesForOwner(this, fileId, staticCssEval);

        if (!cssExtract || !file) {
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
    }
  } as PluginOption;
}

let collectDefineRulesPresetViteRegistrySource:
  | ((source: string) => void)
  | undefined;

async function processDefineRulesPresetViteFile(
  options: Parameters<typeof processDefineRulesPresetRegistryFile>[0]
): Promise<string> {
  const { source } = await runDefineRulesPresetRegistryStep(() =>
    processDefineRulesPresetRegistryFile(options)
  );
  collectDefineRulesPresetViteRegistrySource?.(source);

  return source;
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

function getStaticCssEvalFromTransformError(
  error: unknown
): StaticCssEvalMetadata | undefined {
  return (error as { staticCssEval?: StaticCssEvalMetadata } | null)
    ?.staticCssEval;
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
      source,
      registrySession: createEmptyRegistrySession()
    };
  }

  function createV4PresetBuildSource(className: string): string {
    return `
      export const preset = {
        schema: "${DEFINE_RULES_PRESET_SCHEMA}",
        version: 4,
        classNameByCache: {
          shared: "${className}"
        },
        writeKeyByCacheKey: {
          shared: 0
        },
        conditionById: {
          0: {
            layer: null,
            supports: null,
            media: null,
            container: null,
            selector: "&"
          }
        },
        propertyById: {
          0: "background"
        },
        writeKeyById: {
          0: {
            conditionId: 0,
            propertyId: 0
          }
        }
      };
      export const shared = "${className}";
    `;
  }

  function expectSourceToContainV4PresetArtifact(source: string): void {
    expect(source).toMatch(
      new RegExp(
        `["']?schema["']?\\s*:\\s*["']${escapeRegExp(DEFINE_RULES_PRESET_SCHEMA)}["']`
      )
    );
    expect(source).toMatch(/["']?version["']?\s*:\s*4/);
    expect(source).toMatch(/["']?classNameByCache["']?\s*:\s*\{/);
    expect(source).toMatch(/["']?writeKeyByCacheKey["']?\s*:\s*\{/);
    expect(source).toMatch(/["']?conditionById["']?\s*:\s*\{/);
    expect(source).toMatch(/["']?propertyById["']?\s*:\s*\{/);
    expect(source).toMatch(/["']?writeKeyById["']?\s*:\s*\{/);
    expectSourceV4PresetArtifactToOmitRuntimeFields(source);
  }

  function expectSourceToContainV4RuntimePresetSeed(source: string): void {
    expect(source).toMatch(
      new RegExp(
        `["']?schema["']?\\s*:\\s*["']${escapeRegExp(DEFINE_RULES_PRESET_SCHEMA)}["']`
      )
    );
    expect(source).toMatch(/["']?version["']?\s*:\s*4/);
    expect(source).toMatch(/["']?classNameByCache["']?\s*:\s*\{/);
    expect(source).toMatch(/["']?writeKeyByCacheKey["']?\s*:\s*\{/);
  }

  function expectSourceV4PresetArtifactToOmitRuntimeFields(
    source: string
  ): void {
    const artifactSource = extractV4PresetArtifactSource(source);
    expect(artifactSource).not.toMatch(/["']?registeredSegments["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?segmentCache["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?fullResultCache["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?atomicClassByClassName["']?\s*:/);
    expect(artifactSource).not.toMatch(/["']?cx["']?\s*:/);
  }

  function extractV4PresetArtifactSource(source: string): string {
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

  function countV4PresetArtifacts(source: string): number {
    return Array.from(
      source.matchAll(
        /["']?schema["']?\s*:\s*["']mincho\.defineRulesPreset["']/g
      )
    ).length;
  }

  function expectSourceToContainPopulatedClassNameByCache(
    source: string
  ): void {
    expect(source).toMatch(
      /["']?classNameByCache["']?\s*:\s*\{[\s\S]*["'][^"']+["']\s*:/
    );
  }

  function expectSourceToContainClassNameByCacheValue(
    source: string,
    className: string
  ): void {
    expectSourceToContainV4PresetArtifact(source);
    expect(source).toMatch(
      new RegExp(
        `["']?classNameByCache["']?\\s*:\\s*\\{[\\s\\S]*["']${escapeRegExp(className)}["']`
      )
    );
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
        watch: buildOverrides?.watch ?? false
      }
    };
  }

  async function createViteHarness({
    configOverrides,
    pluginOptions,
    resolve: resolveImport,
    server
  }: {
    configOverrides?: Partial<ResolvedConfig>;
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
      async load(id: string) {
        return plugin.load?.(id);
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

  function expectCssSourceToContainClassNames(
    source: string,
    className: string
  ): void {
    for (const fragmentClassName of splitClassNames(className)) {
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
      }[] = [
        { label: "default" },
        { label: "explicit false", pluginOptions: { jsxCssProp: false } }
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

        expect(babelTransformSpy).toHaveBeenNthCalledWith(
          1,
          fixture.entryPath,
          undefined
        );
        expect(babelTransformSpy).toHaveBeenNthCalledWith(
          2,
          fixture.entryPath,
          {
            jsxCssProp: false
          }
        );
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

      firstDeferred.resolve(createV4PresetBuildSource("provider-a_class"));
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

      secondDeferred.resolve(createV4PresetBuildSource("provider-b_class"));
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
      expectSourceToContainClassNameByCacheValue(
        firstTransformResult,
        "provider-a_class"
      );
      expectSourceToContainClassNameByCacheValue(
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
      vi.spyOn(integrationModule, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: []
      } as Awaited<ReturnType<typeof compile>>);
      const registrySpy = vi
        .spyOn(integrationModule, "processDefineRulesPresetRegistryFile")
        .mockResolvedValue(
          createRegistryResult(createV4PresetBuildSource("shared_class"))
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
      expectSourceToContainClassNameByCacheValue(
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
        expectSourceToContainV4RuntimePresetSeed(jsOutput.code);
        expect(jsOutput.code).not.toContain('background: "blue"');
        expect(cssOutput.source).toContain(`.${fillBlueClassName}`);
        expect(cssOutput.source).toContain("background: blue;");
      } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
      }
    }, 20000);

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
        expectSourceToContainV4PresetArtifact(registrySource);
        expectSourceToContainPopulatedClassNameByCache(registrySource);
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
      expect(countV4PresetArtifacts(registrySource)).toBe(0);
      expect(countV4PresetArtifacts(js)).toBe(0);
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
      expectSourceToContainClassNameByCacheValue(
        transformedExtractedCss,
        fillBlueClassName
      );
      expect(fillBlueClassName.split(/\s+/)).toHaveLength(1);
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
      expect(countV4PresetArtifacts(transformedExtractedCss)).toBe(0);
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
            serializeVirtualCssPath: expect.any(Function)
          })
        );
        expect(registrySpy).toHaveBeenCalledTimes(1);
        expectSourceToContainV4PresetArtifact(transformedExtractedCss);
        expectSourceToContainPopulatedClassNameByCache(transformedExtractedCss);
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

      const harness = await createViteHarness();
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
      expect(countV4PresetArtifacts(transformedExtractedCss)).toBe(0);
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
      expect(countV4PresetArtifacts(firstTransform)).toBe(2);
      expectSourceToContainClassNameByCacheValue(
        firstTransform,
        currentClassName
      );
      expectSourceToContainClassNameByCacheValue(
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
      expect(countV4PresetArtifacts(secondTransform)).toBe(1);
      expectSourceToContainClassNameByCacheValue(
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
      expect(resolvedVirtualId).toBe(expectedProviderVirtualModuleId);
      expect(transformedProviderV1).toContain(staleProviderClassName);
      expect(transformedProviderV1).not.toContain(updatedProviderClassName);
      expect(await harness.load(resolvedVirtualId!)).toBe(
        createProviderCssSource(staleProviderClassName, "rebeccapurple")
      );
      expect(getModuleById).toHaveBeenCalledWith(
        expectedProviderVirtualModuleId
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
      const providerClassNameByCache = providerV2.preset.classNameByCache;
      const consumerClassNameByCache = consumer.preset.classNameByCache;
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

    it("keeps dev virtual css caching and HMR bookkeeping on the local path", async () => {
      const integrationModule = await import("@mincho-js/integration");
      const cssSource = ".shared { color: rebeccapurple; }";
      const virtualCssId = "src/extracted_rules.css.ts.vanilla.css";
      const expectedModuleId = normalizePath(
        join(viteConsumerRootPath, virtualCssId)
      );
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
                  filePath: "src/extracted_rules.css.ts"
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

      expect(transformedExtractedCss).toContain(`import "${virtualCssId}";`);
      expect(transformedExtractedCss).not.toContain("presets");
      const resolvedVirtualId = harness.resolveId(virtualImportMatch[1]);
      expect(resolvedVirtualId).toBe(expectedModuleId);
      expect(await harness.load(resolvedVirtualId!)).toBe(cssSource);
      expect(getModuleById).toHaveBeenCalledWith(expectedModuleId);
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
  });
}
