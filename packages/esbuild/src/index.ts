import * as fs from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { vanillaExtractPlugin } from "@vanilla-extract/esbuild-plugin";
import {
  type Loader,
  type Plugin as EsbuildPlugin,
  type PluginBuild,
  type ResolveResult
} from "esbuild";
import { EsbuildAssets } from "./assets.js";
import {
  getBuildTransaction,
  recordPackageGraph
} from "./buildInputSnapshot.js";
import {
  type BabelOptions,
  type InternalStaticCssEvalSourceUnsupportedReason as StaticCssEvalSourceUnsupportedReason,
  type InternalStaticCssEvalLoadedSource as StaticCssEvalLoadedSource,
  type InternalStaticCssEvalSourceProvider as StaticCssEvalSourceProvider,
  type InternalStaticCssEvalSourceResolution as StaticCssEvalSourceResolution,
  type InternalStaticCssEvalSourceKind as StaticCssEvalSourceKind,
  type InternalStaticCssEvalSourceOrigin as StaticCssEvalSourceOrigin,
  babelTransformSource,
  compile,
  internalCollectStaticCssEvalDependencyIds as collectStaticCssEvalDependencyIds,
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

type ScriptLoader = "js" | "jsx" | "ts" | "tsx";

const integrationHelpers = {
  babelTransformSource,
  compile,
  processDefineRulesPresetRegistryFile,
  runDefineRulesPresetRegistryStep
};

type MinchoBabelOptionsWithStaticCssEval = BabelOptions;

type BabelTransformResult = Omit<
  Awaited<ReturnType<typeof babelTransformSource>>,
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

type StaticCssEvalResolutionCache = Map<
  string,
  StaticCssEvalSourceResolution | null
>;

type StaticCssEvalLoadedSourceCache = Map<
  string,
  StaticCssEvalLoadedSource | null
>;

const unsupportedStaticCssEvalResolutionPrefix =
  "virtual:mincho-static-css-eval-unsupported:";

const esbuildStaticCssEvalModuleIdPrefix = "esbuild:";

function getScriptLoader(
  filePath: string,
  loaders: Record<string, Loader> = {}
): ScriptLoader | undefined {
  const extension = Object.keys(loaders)
    .sort((a, b) => b.length - a.length)
    .find((extension) => filePath.endsWith(extension));

  const loader = extension
    ? loaders[extension]
    : /\.[cm]?ts$/.test(filePath)
      ? "ts"
      : /\.[cm]?js$/.test(filePath)
        ? "js"
        : filePath.endsWith(".tsx")
          ? "tsx"
          : filePath.endsWith(".jsx")
            ? "jsx"
            : undefined;

  return loader === "js" ||
    loader === "jsx" ||
    loader === "ts" ||
    loader === "tsx"
    ? loader
    : undefined;
}

function createEsbuildStaticCssEvalSourceProvider(options: {
  build: PluginBuild;
  ownerId: string;
  ownerSource: string;
  rootRealpath: Promise<string>;
  resolutionCache: StaticCssEvalResolutionCache;
  loadedSourceCache: StaticCssEvalLoadedSourceCache;
  assets: EsbuildAssets;
}): StaticCssEvalSourceProvider {
  const ownerId = normalizeStaticCssEvalFileId(options.ownerId);

  return {
    async resolve(importerId: string, importPath: string) {
      const cacheKey = `${getEsbuildStaticCssEvalCacheKey(importerId)}\0${importPath}`;

      if (options.resolutionCache.has(cacheKey)) {
        return options.resolutionCache.get(cacheKey) ?? null;
      }

      const resolution = await resolveEsbuildStaticCssEvalImport({
        build: options.build,
        importerId,
        importPath,
        rootRealpath: options.rootRealpath
      });

      options.resolutionCache.set(cacheKey, resolution);

      return resolution;
    },

    async load(id: string) {
      const cacheKey = getEsbuildStaticCssEvalCacheKey(id);

      if (options.loadedSourceCache.has(cacheKey)) {
        return options.loadedSourceCache.get(cacheKey) ?? null;
      }

      const loadedSource = await loadEsbuildStaticCssEvalSource({
        id,
        ownerId,
        ownerSource: options.ownerSource,
        assets: options.assets,
        readFile: getBuildTransaction(
          options.build.initialOptions
        )?.snapshot.readFile.bind(
          getBuildTransaction(options.build.initialOptions)!.snapshot
        ),
        rootRealpath: options.rootRealpath
      });

      options.loadedSourceCache.set(cacheKey, loadedSource);

      return loadedSource;
    }
  };
}

async function resolveEsbuildStaticCssEvalImport(options: {
  build: PluginBuild;
  importerId: string;
  importPath: string;
  rootRealpath: Promise<string>;
}): Promise<StaticCssEvalSourceResolution | null> {
  const resolved = await resolveEsbuildImport(
    options.build,
    options.importerId,
    options.importPath
  );

  if (resolved == null) {
    return null;
  }

  if (resolved.external) {
    return createExternalStaticCssEvalResolution(resolved, options.importPath);
  }

  if (
    !isEsbuildStaticCssEvalFileNamespace(resolved.namespace) ||
    isVirtualStaticCssEvalId(resolved.path)
  ) {
    return createUnsupportedStaticCssEvalResolution(
      options.importPath,
      createEsbuildStaticCssEvalCanonicalModuleId(resolved)
    );
  }

  return createEsbuildStaticCssEvalFileResolution(
    resolved,
    await options.rootRealpath
  );
}

async function resolveEsbuildImport(
  build: PluginBuild,
  importerId: string,
  importPath: string
): Promise<ResolveResult | null> {
  if (typeof build.resolve === "function") {
    const resolved = await build.resolve(importPath, {
      importer: parseEsbuildStaticCssEvalLoadId(importerId).path,
      namespace: parseEsbuildStaticCssEvalLoadId(importerId).namespace,
      kind: "import-statement",
      resolveDir: dirname(parseEsbuildStaticCssEvalLoadId(importerId).path)
    });

    if (resolved.errors.length > 0 || resolved.path === "") {
      return null;
    }

    return resolved;
  }

  const resolvedPath = resolveStaticCssEvalImportFromFileSystem(
    importerId,
    importPath
  );

  return resolvedPath ? createStaticCssEvalResolveResult(resolvedPath) : null;
}

async function loadEsbuildStaticCssEvalSource(options: {
  id: string;
  ownerId: string;
  ownerSource: string;
  assets: EsbuildAssets;
  rootRealpath: Promise<string>;
  readFile?: (path: string) => Promise<Buffer>;
}): Promise<StaticCssEvalLoadedSource | null> {
  const fileId = normalizeStaticCssEvalFileId(options.id);

  if (fileId === options.ownerId) {
    const ownerRealpath = await getExistingRealpath(fileId);
    const stat = ownerRealpath ? await getExistingStat(ownerRealpath) : null;
    const sourceIdentity = stat
      ? createStaticCssEvalSourceIdentity(stat)
      : undefined;

    return {
      sourceText: options.ownerSource,
      source: options.ownerSource,
      resolvedFile: ownerRealpath ?? options.ownerId,
      canonicalModuleId: options.ownerId,
      normalizedPathKey: options.ownerId,
      ...(ownerRealpath ? { realpath: ownerRealpath } : {}),
      ...(sourceIdentity ? { sourceIdentity } : {}),
      sourceKind: "project-source",
      sourceOrigin: "project",
      ...(ownerRealpath ? { watchFiles: [ownerRealpath] } : {}),
      resolverKind: "esbuild"
    };
  }

  if (isUnsupportedStaticCssEvalResolutionId(options.id)) {
    return {
      sourceText: "export {};",
      source: "export {};",
      sourceKind: "unsupported-source-shape",
      sourceOrigin: "unsupported",
      unsupportedReason: "unsupported-source-shape",
      resolverKind: "esbuild"
    };
  }

  if (isExternalStaticCssEvalResolutionId(options.id)) {
    return null;
  }

  const loadId = parseEsbuildStaticCssEvalLoadId(options.id);

  if (!isEsbuildStaticCssEvalFileNamespace(loadId.namespace)) {
    return null;
  }

  const loadFileId = normalizeStaticCssEvalFileId(loadId.path);
  const realpath = await getExistingRealpath(loadFileId);

  if (!realpath) {
    return null;
  }

  const rootRealpath = await options.rootRealpath;

  let source: string;
  let stat: fs.Stats;

  try {
    [source, stat] = await Promise.all([
      options.readFile
        ? options.readFile(realpath).then((bytes) => bytes.toString("utf8"))
        : fs.promises.readFile(realpath, "utf8"),
      fs.promises.stat(realpath)
    ]);
  } catch (error) {
    if (isMissingFileSystemEntryError(error)) {
      return null;
    }

    throw error;
  }

  const metadata = createEsbuildStaticCssEvalFileMetadata({
    realpath,
    rootRealpath,
    stat,
    suffix: loadId.suffix
  });

  const staticDataSource = new URLSearchParams(
    loadId.suffix.split("#", 1)[0]?.slice(1)
  ).has("url")
    ? await options.assets.load(realpath, loadId.suffix)
    : source;

  const sourceText = prepareStaticCssEvalStaticDataSource(
    metadata.normalizedPathKey,
    staticDataSource
  );

  return {
    sourceText,
    source: sourceText,
    ...metadata
  };
}

function getEsbuildStaticCssEvalCacheKey(id: string): string {
  const moduleId = parseEsbuildStaticCssEvalLoadId(id);

  return JSON.stringify([
    normalizeEsbuildStaticCssEvalNamespace(moduleId.namespace),
    normalizeStaticCssEvalFileId(moduleId.path),
    moduleId.suffix
  ]);
}

interface EsbuildStaticCssEvalFileMetadataOptions {
  realpath: string;
  rootRealpath: string;
  stat: fs.Stats;
  suffix: string;
}

interface EsbuildStaticCssEvalLoadId {
  namespace: string;
  path: string;
  suffix: string;
}

async function createEsbuildStaticCssEvalFileResolution(
  resolved: ResolveResult,
  rootRealpath: string
): Promise<StaticCssEvalSourceResolution | null> {
  const fileId = normalizeStaticCssEvalFileId(resolved.path);
  const realpath = await getExistingRealpath(fileId);

  if (!realpath) {
    return null;
  }

  const stat = await getExistingStat(realpath);

  if (!stat) {
    return null;
  }

  const metadata = createEsbuildStaticCssEvalFileMetadata({
    realpath,
    rootRealpath,
    stat,
    suffix: getEsbuildStaticCssEvalResolveSuffix(resolved)
  });

  return {
    id: metadata.resolvedFile,
    ...metadata
  };
}

function createEsbuildStaticCssEvalFileMetadata({
  realpath,
  rootRealpath,
  stat,
  suffix
}: EsbuildStaticCssEvalFileMetadataOptions): Required<
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
  const sourceIdentity = createStaticCssEvalSourceIdentity(stat);
  const sourceKind = getEsbuildStaticCssEvalFileSourceKind({
    moduleId: `${realpath}${suffix}`,
    realpath,
    rootRealpath
  });

  const querySuffix = suffix;
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
    sourceOrigin: getStaticCssEvalSourceOrigin(sourceKind),
    watchFiles: [realpath],
    resolverKind: "esbuild"
  };
}

function getEsbuildStaticCssEvalFileSourceKind({
  moduleId,
  realpath,
  rootRealpath
}: {
  moduleId: string;
  realpath: string;
  rootRealpath: string;
}): StaticCssEvalSourceKind {
  if (isStaticCssEvalStaticDataFile(moduleId, realpath)) {
    return "static-data";
  }

  return hasNodeModulesSegment(realpath) ||
    !isPathInsideRoot(rootRealpath, realpath)
    ? "package-source"
    : "project-source";
}

function getStaticCssEvalSourceOrigin(
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

function assertNeverStaticCssEvalSourceKind(value: never): never {
  throw new TypeError(`Unexpected static css eval source kind: ${value}`);
}

function createEsbuildStaticCssEvalCanonicalModuleId(
  resolved: ResolveResult
): string {
  return createEsbuildStaticCssEvalModuleId({
    namespace: normalizeEsbuildStaticCssEvalNamespace(resolved.namespace),
    path: resolved.path,
    suffix: getEsbuildStaticCssEvalResolveSuffix(resolved)
  });
}

function createEsbuildStaticCssEvalModuleId({
  namespace,
  path,
  suffix
}: EsbuildStaticCssEvalLoadId): string {
  return `${esbuildStaticCssEvalModuleIdPrefix}${namespace}:${path}${suffix}`;
}

function parseEsbuildStaticCssEvalLoadId(
  id: string
): EsbuildStaticCssEvalLoadId {
  if (!id.startsWith(esbuildStaticCssEvalModuleIdPrefix)) {
    return createEsbuildStaticCssEvalLoadId("file", id);
  }

  const payload = id.slice(esbuildStaticCssEvalModuleIdPrefix.length);
  const namespaceEnd = payload.indexOf(":");

  if (namespaceEnd === -1) {
    return createEsbuildStaticCssEvalLoadId("file", payload);
  }

  return createEsbuildStaticCssEvalLoadId(
    payload.slice(0, namespaceEnd),
    payload.slice(namespaceEnd + 1)
  );
}

function createEsbuildStaticCssEvalLoadId(
  namespace: string,
  pathWithSuffix: string
): EsbuildStaticCssEvalLoadId {
  return {
    namespace,
    path: stripStaticCssEvalQuery(pathWithSuffix),
    suffix: getStaticCssEvalQuerySuffix(pathWithSuffix)
  };
}

function getEsbuildStaticCssEvalResolveSuffix(resolved: ResolveResult): string {
  return resolved.suffix || getStaticCssEvalQuerySuffix(resolved.path);
}

function normalizeEsbuildStaticCssEvalNamespace(namespace: string): string {
  return namespace === "" ? "file" : namespace;
}

function isEsbuildStaticCssEvalFileNamespace(namespace: string): boolean {
  return namespace === "" || namespace === "file";
}

function getStaticCssEvalQuerySuffix(sourceId: string): string {
  const suffixIndex = sourceId.search(/[?#]/);

  return suffixIndex === -1 ? "" : sourceId.slice(suffixIndex);
}

function stripStaticCssEvalQuery(sourceId: string): string {
  const queryIndex = sourceId.search(/[?#]/);

  return queryIndex === -1 ? sourceId : sourceId.slice(0, queryIndex);
}

function createUnsupportedStaticCssEvalResolution(
  importPath: string,
  canonicalModuleId?: string
): StaticCssEvalSourceResolution {
  const id = `${unsupportedStaticCssEvalResolutionPrefix}${encodeURIComponent(
    importPath
  )}`;

  return {
    id,
    resolvedFile: id,
    canonicalModuleId: canonicalModuleId ?? id,
    normalizedPathKey: id,
    sourceKind: "unsupported-source-shape",
    sourceOrigin: "unsupported",
    unsupportedReason: "unsupported-source-shape",
    resolverKind: "esbuild"
  };
}

function createExternalStaticCssEvalResolution(
  resolved: ResolveResult,
  importPath: string
): StaticCssEvalSourceResolution {
  const externalId = `${externalStaticCssEvalResolutionPrefix}${encodeURIComponent(
    resolved.path || importPath
  )}`;

  return {
    id: externalId,
    resolvedFile: externalId,
    canonicalModuleId: createEsbuildStaticCssEvalCanonicalModuleId(resolved),
    normalizedPathKey: externalId,
    sourceKind: "external-no-source",
    sourceOrigin: "external",
    unsupportedReason: "external-no-source",
    resolverKind: "esbuild"
  };
}

function isUnsupportedStaticCssEvalResolutionId(id: string): boolean {
  return id.startsWith(unsupportedStaticCssEvalResolutionPrefix);
}

function isExternalStaticCssEvalResolutionId(id: string): boolean {
  return id.startsWith(externalStaticCssEvalResolutionPrefix);
}

function getWatchableStaticCssEvalDependencyFiles(
  rootRealpath: string,
  staticCssEval: { readonly dependencyFiles?: readonly string[] } | undefined,
  ownerId?: string
): string[] {
  const watchFiles = new Set<string>();
  const ownerFileId = ownerId
    ? normalizeStaticCssEvalFileId(ownerId, rootRealpath)
    : "";

  for (const dependencyFile of staticCssEval?.dependencyFiles ?? []) {
    const fileId = normalizeStaticCssEvalFileId(dependencyFile, rootRealpath);

    if (fileId === ownerFileId || !fs.existsSync(fileId)) {
      continue;
    }

    watchFiles.add(fileId);
  }

  return [...watchFiles];
}

function resolveStaticCssEvalImportFromFileSystem(
  importerId: string,
  importPath: string
): string | null {
  if (
    !isProjectLocalImportPath(importPath) ||
    isVirtualStaticCssEvalId(importPath)
  ) {
    return null;
  }

  const basePath = importPath.startsWith("/")
    ? importPath
    : resolvePath(dirname(importerId), importPath);

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
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function createStaticCssEvalResolveResult(path: string): ResolveResult {
  return {
    errors: [],
    warnings: [],
    path,
    external: false,
    sideEffects: true,
    namespace: "file",
    suffix: "",
    pluginData: undefined
  };
}

export interface MinchoEsbuildPluginOptions {
  includeNodeModulesPattern?: RegExp;
  jsxCssProp?: boolean;
}

/**
 * Plugin flow:
 * 1. Intercepts TypeScript/JavaScript files (*.tsx, *.jsx, *.ts, *.js)
 * 2. Extracts CSS using Babel and injects imports to generated CSS files (extracted_[hash].css.ts)
 * 3. Processes extracted CSS:
 *    - Resolves all imports in the CSS files
 *    - Bundles the code with proper file scoping
 *    - Generates vanilla-extract compatible .css.ts files
 *    - Hands off to @vanilla-extract/esbuild-plugin for final CSS processing
 * 4. Returns the transformed JavaScript with proper CSS imports
 *
 * This plugin integrates Mincho.js styling with ESBuild's build process,
 * enabling zero-runtime CSS-in-JS with type safety.
 */
export function minchoEsbuildPlugin({
  includeNodeModulesPattern,
  jsxCssProp
}: MinchoEsbuildPluginOptions = {}): EsbuildPlugin {
  return {
    name: "mincho-js-esbuild",

    setup(build) {
      const transaction = getBuildTransaction(build.initialOptions);
      const resolvers = new Map<string, string>();
      const resolverCache = new Map<string, string>();
      const staticCssEvalResolutionCache: StaticCssEvalResolutionCache =
        new Map();

      const staticCssEvalLoadedSourceCache: StaticCssEvalLoadedSourceCache =
        new Map();

      const staticCssEvalProjectEngine = new internalMinchoProjectEngine();
      const assets = new EsbuildAssets(build);
      build.onStart(() => assets.beginBuild());
      build.onResolve({ filter: /.*/ }, (args) =>
        args.kind === "url-token" ? assets.resolveCssUrl(args.path) : undefined
      );

      const rootRealpath = getRealpathOrResolvedPath(
        build.initialOptions.absWorkingDir ?? process.cwd()
      );

      build.onEnd((result) => {
        resolvers.clear();
        resolverCache.clear();
        staticCssEvalResolutionCache.clear();
        staticCssEvalLoadedSourceCache.clear();

        if (result) return assets.finishBuild(result);
      });

      build.onResolve({ filter: /^extracted_(.*)\.css\.ts$/ }, async (args) => {
        if (!resolvers.has(args.path)) {
          return;
        }

        const resolvedPath = join(args.importer, "..", args.path);

        return {
          namespace: "extracted-css",
          path: resolvedPath,
          pluginData: {
            path: args.path,
            mainFilePath: args.pluginData?.mainFilePath
          }
        };
      });

      build.onLoad(
        { filter: /.*/, namespace: "extracted-css" },
        async ({ path, pluginData }) => {
          const resolverContents = resolvers.get(pluginData.path)!;
          const assetWatchFiles = new Set<string>();
          const { source, watchFiles = [] } = await integrationHelpers.compile({
            esbuild: build.esbuild,
            filePath: path,
            originalPath: pluginData.mainFilePath!,
            contents: resolverContents,
            externals: [],
            cwd: build.initialOptions.absWorkingDir,
            loader: assets.getCompileLoaders(),
            plugins: [assets.createCompilePlugin(assetWatchFiles)],
            readFileBytes: transaction?.snapshot.readFile.bind(
              transaction.snapshot
            ),
            readFile: transaction
              ? (filePath: string) =>
                  transaction.snapshot
                    .readFile(filePath)
                    .then((bytes) => bytes.toString("utf8"))
              : undefined,
            resolverCache
          });

          try {
            const {
              ancestorStyleSpecifiers,
              source: registrySource,
              packageGraph
            } = await integrationHelpers.runDefineRulesPresetRegistryStep(() =>
              integrationHelpers.processDefineRulesPresetRegistryFile({
                source,
                filePath: path,
                outputCss: undefined,
                identOption: build.initialOptions.minify ? "short" : "debug"
              })
            );

            if (transaction) {
              if (!packageGraph)
                throw new Error(
                  "Mincho build requires package graph metadata from the registry."
                );

              // Babel currently emits one extracted module per source. Keep
              // multiple extraction identities complete and order-independent.
              recordPackageGraph(
                transaction,
                pluginData.mainFilePath,
                path,
                packageGraph
              );
            }

            const contents = `${ancestorStyleSpecifiers
              .map((specifier) => `import ${JSON.stringify(specifier)};`)
              .join(
                "\n"
              )}${ancestorStyleSpecifiers.length === 0 ? "" : "\n"}${registrySource}`;

            return {
              contents,
              loader: "js",
              resolveDir: dirname(path),
              watchFiles: [...new Set([...watchFiles, ...assetWatchFiles])]
            };
          } catch (error) {
            if (error instanceof ReferenceError) {
              return {
                errors: [
                  {
                    text: error.toString(),
                    detail:
                      "This usually happens if you use a browser api at the top level of a file being imported."
                  }
                ]
              };
            }

            throw error;
          }
        }
      );

      build.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
        const loader = getScriptLoader(args.path, build.initialOptions.loader);
        if (!loader) return;
        if (args.path.endsWith(".css.ts")) return;

        if (args.path.includes("node_modules")) {
          if (!includeNodeModulesPattern) return;
          if (!includeNodeModulesPattern.test(args.path)) return;
        }

        const source = transaction
          ? (await transaction.snapshot.readFile(args.path)).toString("utf8")
          : await fs.promises.readFile(args.path, "utf8");

        const babelOptions: MinchoBabelOptionsWithStaticCssEval | undefined =
          jsxCssProp === undefined ? undefined : { jsxCssProp };

        const transformBabelOptions:
          | MinchoBabelOptionsWithStaticCssEval
          | undefined =
          babelOptions?.jsxCssProp === true
            ? {
                ...babelOptions,
                staticCssEvalProjectEngine,
                staticCssEvalSourceProvider:
                  createEsbuildStaticCssEvalSourceProvider({
                    build,
                    ownerId: args.path,
                    ownerSource: source,
                    assets,
                    rootRealpath,
                    resolutionCache: staticCssEvalResolutionCache,
                    loadedSourceCache: staticCssEvalLoadedSourceCache
                  })
              }
            : babelOptions;

        const {
          code,
          map,
          result: [file, cssExtract],
          staticCssEval
        } = (await integrationHelpers.babelTransformSource({
          filename: args.path,
          source,
          loader,
          babel: transformBabelOptions,
          sourceMaps: Boolean(build.initialOptions.sourcemap)
        })) as BabelTransformResult;

        const staticCssEvalFileResult =
          staticCssEvalProjectEngine.getFileResult(args.path);

        // the extracted code and original are the same -> no css extracted
        if (file && cssExtract && cssExtract != code) {
          resolvers.set(file, cssExtract);
          resolverCache.delete(args.path);
        }

        return {
          contents: map
            ? `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`
            : code,
          loader,
          pluginData: {
            mainFilePath: args.path
          },
          watchFiles: getWatchableStaticCssEvalDependencyFiles(
            await rootRealpath,
            staticCssEvalFileResult ?? {
              dependencyFiles: collectStaticCssEvalDependencyIds(staticCssEval)
            },
            args.path
          )
        };
      });
    }
  };
}

export const minchoEsbuildPlugins = (
  options: MinchoEsbuildPluginOptions = {}
) => [
  minchoEsbuildPlugin(options),
  vanillaExtractPlugin({ externals: ["@mincho-js/transform-to-vanilla"] })
];

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { afterEach, beforeAll, describe, expect, it, vi } = import.meta.vitest;

  const DEFINE_RULES_PRESET_SCHEMA = "mincho.defineRulesPreset";

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
    consumer: string;
  };

  type DefineRulesPresetSerializationManifest = {
    DEFINE_RULES_PRESET_SERIALIZATION_PATHS: DefineRulesPresetSerializationPaths;
    DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES: readonly DefineRulesPresetSerializationCase[];
    createDefineRulesPresetSerializationFixturePath: (
      relativePath: string
    ) => string;
  };

  let consumerFixturePath: string;
  let registryFixtureMatrixCases: DefineRulesPresetSerializationFixtureCase[] =
    [];

  let serializedRegistryFixtureCases: DefineRulesPresetSerializationFixtureCase[] =
    [];

  function getDefineRulesPresetSerializationManifestUrl(): string {
    return new URL(
      "../../integration/src/__fixtures__/defineRules-preset-serialization/manifest.ts",
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
      import.meta.url
    ).href;
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

    consumerFixturePath = createDefineRulesPresetSerializationFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.consumer
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

  interface MockLoadArgs {
    path: string;
    pluginData?: {
      path?: string;
      mainFilePath?: string;
    };
  }

  interface MockResolveArgs {
    path: string;
    importer: string;
    pluginData?: {
      mainFilePath?: string;
    };
  }

  type ScriptLoadResult = {
    contents: string;
    loader: ScriptLoader;
    pluginData: {
      mainFilePath: string;
    };
    watchFiles: string[];
  };

  function getScriptLoadWatchFiles(value: unknown): string[] {
    if (
      typeof value !== "object" ||
      value === null ||
      !("watchFiles" in value) ||
      !Array.isArray(value.watchFiles) ||
      !value.watchFiles.every((file) => typeof file === "string")
    ) {
      throw new Error("Expected script load result to include watch files");
    }

    return value.watchFiles;
  }

  type ResolvedExtractedCssResult = {
    namespace: string;
    path: string;
    pluginData: {
      path: string;
      mainFilePath: string;
    };
  };

  type ExtractedCssLoadResult = {
    contents: string;
    loader: string;
    resolveDir: string;
  };

  type LoadCallback = (args: MockLoadArgs) => Promise<unknown>;

  type ResolveCallback = (args: MockResolveArgs) => Promise<unknown>;

  type TestEsbuildApi = Parameters<typeof compile>[0]["esbuild"];

  function createBuildHarness({
    absWorkingDir = "/workspace",
    esbuild,
    minify = false,
    loader,
    outdir,
    plugin = minchoEsbuildPlugin(),
    resolve: resolveImport
  }: {
    absWorkingDir?: string;
    esbuild?: TestEsbuildApi;
    minify?: boolean;
    loader?: Record<string, Loader>;
    outdir?: string;
    plugin?: EsbuildPlugin;
    resolve?: PluginBuild["resolve"];
  } = {}) {
    let extractedCssResolveCallback: ResolveCallback | undefined;
    let extractedCssLoadCallback: LoadCallback | undefined;
    let scriptLoadCallback: LoadCallback | undefined;
    let endCallback: (() => void) | undefined;

    const build = {
      esbuild: esbuild ?? {},
      initialOptions: {
        absWorkingDir,
        minify,
        loader,
        outdir
      },

      async resolve(path: string, options?: { importer?: string }) {
        if (resolveImport) {
          return resolveImport(path, options);
        }

        const importer = options?.importer ?? join(absWorkingDir, "entry.ts");
        const resolvedPath = resolveStaticCssEvalImportFromFileSystem(
          importer,
          path
        );

        return resolvedPath
          ? createStaticCssEvalResolveResult(resolvedPath)
          : {
              errors: [],
              warnings: [],
              path: "",
              external: false,
              sideEffects: true,
              namespace: "",
              suffix: "",
              pluginData: undefined
            };
      },

      onResolve(_options: { filter: RegExp }, callback: ResolveCallback): void {
        extractedCssResolveCallback = callback;
      },

      onLoad(
        options: { filter: RegExp; namespace?: string },
        callback: LoadCallback
      ): void {
        if (options.namespace === "extracted-css") {
          extractedCssLoadCallback = callback;

          return;
        }

        scriptLoadCallback = callback;
      },

      onStart(): void {},

      onEnd(callback: () => void): void {
        endCallback = callback;
      }
    } as unknown as Parameters<EsbuildPlugin["setup"]>[0];

    plugin.setup(build);

    return {
      endBuild() {
        endCallback?.();
      },

      async loadScript(args: MockLoadArgs) {
        if (scriptLoadCallback == null) {
          throw new Error("Missing script onLoad callback");
        }

        if (fs.existsSync(args.path)) return scriptLoadCallback(args);

        // Unit fixtures with mocked transforms need no disk-backed owner.
        const readFile = fs.promises.readFile.bind(fs.promises);
        const readSpy = vi
          .spyOn(fs.promises, "readFile")
          .mockImplementation(((file: fs.PathLike, options: unknown) =>
            file === args.path
              ? Promise.resolve("")
              : readFile(
                  file,
                  options as "utf8"
                )) as typeof fs.promises.readFile);

        try {
          return await scriptLoadCallback(args);
        } finally {
          readSpy.mockRestore();
        }
      },

      async resolveExtractedCss(args: MockResolveArgs) {
        if (extractedCssResolveCallback == null) {
          throw new Error("Missing extracted-css onResolve callback");
        }

        return extractedCssResolveCallback(args);
      },

      async loadExtractedCss(args: MockLoadArgs) {
        if (extractedCssLoadCallback == null) {
          throw new Error("Missing extracted-css onLoad callback");
        }

        return extractedCssLoadCallback(args);
      }
    };
  }

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
      ancestorStyleSpecifiers: [],
      source,
      registrySession: createEmptyRegistrySession()
    };
  }

  async function createV5PresetBuildSource(
    filePath = "src/extracted_rules.css.ts"
  ): Promise<{
    className: string;
    marker: string;
    source: string;
  }> {
    const [css, fileScope] = await Promise.all([
      import("@mincho-js/css"),
      import("@vanilla-extract/css/fileScope")
    ]);

    fileScope.setFileScope(filePath, "@mincho-js/esbuild");

    try {
      const rules = css.defineRules({ properties: { background: true } });
      const className = rules.css({ background: "blue" });
      const marker = splitClassNames(className).find(isSegmentMarker);
      if (marker === undefined) {
        throw new Error(
          "Expected defineRules output to include a segment marker"
        );
      }

      return {
        className,
        marker,
        source: `
          export const preset = ${JSON.stringify(rules.preset)};
          export const shared = ${JSON.stringify(className)};
        `
      };
    } finally {
      fileScope.endFileScope();
    }
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
    expect(source).toMatch(
      /["']?origin["']?\s*:\s*["'](?:mincho|@mincho-js\/esbuild):/
    );
    expect(source).toMatch(/["']?atoms["']?\s*:\s*\[/);
    expect(source).not.toMatch(/["']?classNameByCache["']?\s*:/);
    expect(source).not.toMatch(/["']?writeKeyByCacheKey["']?\s*:/);
    expect(source).not.toMatch(/["']?conditionById["']?\s*:/);
    expect(source).not.toMatch(/["']?propertyById["']?\s*:/);
    expect(source).not.toMatch(/["']?writeKeyById["']?\s*:/);

    expectSourceV5PresetArtifactToOmitRuntimeFields(source);
  }

  function expectSourceV5PresetArtifactToOmitRuntimeFields(
    source: string
  ): void {
    const artifactSource = extractV5PresetArtifactSource(source);

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

  it("counts V5 preset artifacts independently of property order", () => {
    expect(
      countV5PresetArtifacts(
        'const first={version:5,schema:"mincho.defineRulesPreset"};const second={schema:"mincho.defineRulesPreset",nodes:[],version:5};'
      )
    ).toBe(2);
  });

  function createLivePresetBuildSource(): string {
    return `
      import { defineRules } from "@mincho-js/css";

      export const { css, preset } = defineRules({ properties: { background: true } });
      export const fillBlue = css({ background: "blue" });
    `;
  }

  function createLivePresetSmokeEntrySource(): string {
    return `
      import { css as vanillaCss, defineRules } from "@mincho-js/css";

      export const { css: presetCss, preset } = defineRules({
        debugId: "esbuild-build-smoke",
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
    const cacheRoot = join(process.cwd(), "packages/esbuild/.cache");
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

  function createJsxCssPropFixtureSource(): string {
    return `
      function App() {
        return <div className="base" css={{ color: "red" }} />;
      }
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
    `;
  }

  async function createJsxCssPropFixture(
    prefix: string,
    source = createJsxCssPropFixtureSource()
  ) {
    const cacheRoot = join(process.cwd(), "packages/esbuild/.cache");
    await fs.promises.mkdir(cacheRoot, { recursive: true });

    const root = await fs.promises.mkdtemp(join(cacheRoot, prefix));
    const srcRoot = join(root, "src");
    const entryPath = join(srcRoot, "entry.tsx");
    await fs.promises.mkdir(srcRoot, { recursive: true });
    await fs.promises.writeFile(entryPath, source, "utf8");

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

  async function createImportedCssPropEsbuildFixture(
    prefix: string,
    options: {
      entrySource?: string;
      styleSource?: string;
    } = {}
  ) {
    const cacheRoot = join(process.cwd(), "packages/esbuild/.cache");
    await fs.promises.mkdir(cacheRoot, { recursive: true });

    const root = await fs.promises.mkdtemp(join(cacheRoot, prefix));
    const srcRoot = join(root, "src");
    const entryPath = join(srcRoot, "entry.tsx");
    const stylesPath = join(srcRoot, "styles.ts");
    const entrySource =
      options.entrySource ?? createImportedCssPropEntrySource();

    const styleSource = options.styleSource ?? createImportedStyleSource("red");

    await fs.promises.mkdir(srcRoot, { recursive: true });
    await fs.promises.writeFile(entryPath, entrySource, "utf8");
    await fs.promises.writeFile(stylesPath, styleSource, "utf8");

    return {
      entryPath,
      entrySource,
      root,
      srcRoot,
      stylesPath,
      styleSource
    };
  }

  function createMappedEsbuildResolve(
    resolutions: Record<string, ResolveResult>
  ): PluginBuild["resolve"] {
    return async (source, options) => {
      const importer = options?.importer ?? "";
      const mappedResolution =
        resolutions[`${importer}\0${source}`] ??
        resolutions[source] ??
        resolutions[stripStaticCssEvalQuery(source)];

      if (mappedResolution) {
        return mappedResolution;
      }

      const resolvedPath = resolveStaticCssEvalImportFromFileSystem(
        importer,
        source
      );

      return resolvedPath
        ? createStaticCssEvalResolveResult(resolvedPath)
        : createStaticCssEvalResolveResult("");
    };
  }

  function createSuffixedEsbuildResolveResult(
    path: string,
    suffix: string
  ): ResolveResult {
    return {
      ...createStaticCssEvalResolveResult(path),
      suffix
    };
  }

  async function loadCssPropSidecarSourceFromHarness(
    harness: ReturnType<typeof createBuildHarness>,
    entryPath: string
  ): Promise<{ scriptSource: string; sidecarSource: string }> {
    const compileSpy = vi
      .spyOn(integrationHelpers, "compile")
      .mockResolvedValue({ source: "compiled static css" } as Awaited<
        ReturnType<typeof compile>
      >);

    vi.spyOn(
      integrationHelpers,
      "processDefineRulesPresetRegistryFile"
    ).mockResolvedValue(createRegistryResult("registered static css"));

    const scriptLoadResult = (await harness.loadScript({
      path: entryPath
    })) as ScriptLoadResult;

    const { file: sidecarFile } = extractCssPropSidecarImport(
      scriptLoadResult.contents
    );

    const resolveResult = (await harness.resolveExtractedCss({
      path: sidecarFile,
      importer: entryPath,
      pluginData: scriptLoadResult.pluginData
    })) as ResolvedExtractedCssResult;

    await harness.loadExtractedCss({
      path: resolveResult.path,
      pluginData: resolveResult.pluginData
    });

    const compileOptions = compileSpy.mock.calls[0]?.[0];

    if (compileOptions == null) {
      throw new Error("Expected extracted css sidecar to be compiled");
    }

    return {
      scriptSource: scriptLoadResult.contents,
      sidecarSource: compileOptions.contents
    };
  }

  function collectEsbuildOutputTexts(result: {
    outputFiles?: Array<{ path: string; text: string }>;
  }): {
    all: string;
    css: string;
    js: string;
  } {
    const outputFiles = result.outputFiles ?? [];
    const js = outputFiles
      .filter((outputFile) => /\.(?:mjs|js)$/.test(outputFile.path))
      .map((outputFile) => outputFile.text)
      .join("\n");

    const css = outputFiles
      .filter((outputFile) => outputFile.path.endsWith(".css"))
      .map((outputFile) => outputFile.text)
      .join("\n");

    return {
      all: outputFiles.map((outputFile) => outputFile.text).join("\n"),
      css,
      js
    };
  }

  function expectCssPropBuildOutputToContainColor(
    output: { all: string; css: string; js: string },
    color: string
  ): void {
    expect(output.css).toContain(`color: ${color};`);
    expect(output.js).not.toContain(" css=");
    expect(output.js).not.toContain("css={");
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

  async function createRealEsbuildRegistryFixture(
    fixtureCase: DefineRulesPresetSerializationFixtureCase
  ) {
    const cacheRoot = join(process.cwd(), "packages/esbuild/.cache");
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

  async function buildRealEsbuildRegistryFixture(
    fixtureCase: DefineRulesPresetSerializationFixtureCase
  ) {
    const realEsbuild = await import("esbuild");
    const { entryPath, root } =
      await createRealEsbuildRegistryFixture(fixtureCase);

    const fixtureSource = await fs.promises.readFile(
      join(root, "src/index.css.ts"),
      "utf8"
    );

    const babelTransformSpy = vi
      .spyOn(integrationHelpers, "babelTransformSource")
      .mockResolvedValue({
        code: 'import "extracted_registry.css.ts";\nexport const __registryBuildMarker = "entry";',
        result: ["extracted_registry.css.ts", fixtureSource]
      });

    const registrySources: string[] = [];
    const processRegistryFile =
      integrationHelpers.processDefineRulesPresetRegistryFile;

    integrationHelpers.processDefineRulesPresetRegistryFile = async (
      options
    ) => {
      const result = await processRegistryFile(options);
      registrySources.push(result.source);

      return result;
    };

    try {
      const result = await realEsbuild.build({
        absWorkingDir: root,
        bundle: true,
        entryPoints: [entryPath],
        external: ["@mincho-js/css"],
        format: "esm",
        minify: false,
        outdir: join(root, "dist"),
        plugins: minchoEsbuildPlugins(),
        write: false
      });

      const jsOutput = result.outputFiles.find((outputFile) =>
        outputFile.path.endsWith(".js")
      );

      const cssOutput = result.outputFiles.find((outputFile) =>
        outputFile.path.endsWith(".css")
      );

      if (jsOutput == null) {
        throw new Error("Expected esbuild registry build to emit a JS file");
      }

      return {
        css: cssOutput?.text ?? "",
        js: jsOutput.text,
        registrySource: registrySources.join("\n")
      };
    } finally {
      integrationHelpers.processDefineRulesPresetRegistryFile =
        processRegistryFile;
      babelTransformSpy.mockRestore();
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  }

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extractFillBlueClassName(source: string): string {
    const match = source.match(/fillBlue\s*=\s*["']([^"']+)["']/);
    if (match?.[1] == null) {
      throw new Error(
        "Expected build output to include a fillBlue class literal"
      );
    }

    return match[1];
  }

  function extractExportedVariableInitFromBuildSource(
    source: string,
    exportName: string
  ): string {
    const inlineExportedVariableMatch = new RegExp(
      `\\bexport\\s+(?:const|let|var)\\s+${escapeRegExp(exportName)}\\s*=\\s*([^;]+);`
    ).exec(source);
    if (inlineExportedVariableMatch?.[1] != null) {
      return inlineExportedVariableMatch[1].trim();
    }

    const namedExportMatch = Array.from(
      source.matchAll(/\bexport\s*\{([\s\S]*?)\}\s*;/g)
    ).find(([, exportSpecifiers]) =>
      exportSpecifiers
        ?.split(",")
        .some(
          (specifier) => specifier.trim().split(/\s+as\s+/)[0] === exportName
        )
    );
    if (namedExportMatch == null) {
      throw new Error(`Failed to locate exported variable ${exportName}`);
    }

    const variableMatch = new RegExp(
      `\\b(?:const|let|var)\\s+${escapeRegExp(exportName)}\\s*=\\s*([^;]+);`
    ).exec(source);

    if (variableMatch?.[1] == null) {
      throw new Error(`Failed to locate exported variable ${exportName}`);
    }

    return variableMatch[1].trim();
  }

  function extractExportedStringValueFromBuildSource(
    source: string,
    exportName: string
  ): string {
    const exportedInit = extractExportedVariableInitFromBuildSource(
      source,
      exportName
    );

    const stringLiteralMatch = /^(?:"([^"]+)"|'([^']+)')$/.exec(exportedInit);

    if (stringLiteralMatch == null) {
      throw new Error(`Expected export ${exportName} to be a string literal`);
    }

    return stringLiteralMatch[1] ?? stringLiteralMatch[2]!;
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

  function extractCssPropSidecarImport(code: string): {
    file: string;
    localNames: string[];
  } {
    const sidecarImportMatch =
      /import \{ ([^}]+) \} from "(extracted_[^"]+\.css\.ts)";/.exec(code);

    if (sidecarImportMatch == null) {
      throw new Error(
        "Expected transformed code to import an extracted sidecar"
      );
    }

    return {
      file: sidecarImportMatch[2]!,
      localNames: [
        ...(sidecarImportMatch[1]?.matchAll(
          /(?:^|, )([A-Za-z_$][\w$]*)(?: as ([A-Za-z_$][\w$]*))?/g
        ) ?? [])
      ].map(([, importedName, localName]) => localName ?? importedName)
    };
  }

  function extractCxIdentifierFromSource(source: string): string {
    const cxImportMatch =
      /import \{ [^}]*\bcx(?: as ([A-Za-z_$][\w$]*))?[^}]*\} from "@mincho-js\/css";/.exec(
        source
      );

    if (cxImportMatch == null) {
      throw new Error("Expected transformed source to import cx");
    }

    return cxImportMatch[1] ?? "cx";
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
    expect(source).not.toContain(`${cxIdentifier}(styleB)`);
    expect(source).toContain("css: _minchoCssProp");
    expect(source).toContain("..._minchoRest");
    expect(source).toMatch(
      new RegExp(
        `className=\\{${escapeRegExp(cxIdentifier)}\\(_minchoClassName, styleA\\)\\}`
      )
    );
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

  async function spyOnSourceBabelTransform() {
    const sourceIntegrationUrl = new URL(
      "../../integration/src/babel" + ".ts",
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
      import.meta.url
    ).href;

    const sourceIntegrationModule = (await import(
      /* @vite-ignore */ sourceIntegrationUrl
    )) as {
      babelTransformSource: typeof babelTransformSource;
    };

    return vi
      .spyOn(integrationHelpers, "babelTransformSource")
      .mockImplementation(sourceIntegrationModule.babelTransformSource);
  }

  async function loadExtractedCssFromEntry(
    harness: ReturnType<typeof createBuildHarness>,
    entryPath = "/workspace/src/app.ts",
    extractedPath = "extracted_rules.css.ts"
  ) {
    const scriptLoadResult = (await harness.loadScript({
      path: entryPath
    })) as ScriptLoadResult;

    const resolveResult = (await harness.resolveExtractedCss({
      path: extractedPath,
      importer: entryPath,
      pluginData: scriptLoadResult.pluginData
    })) as ResolvedExtractedCssResult;

    const loadResult = (await harness.loadExtractedCss({
      path: resolveResult.path,
      pluginData: resolveResult.pluginData
    })) as ExtractedCssLoadResult;

    return {
      loadResult,
      resolveResult,
      scriptLoadResult
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves directory imports to index files", async () => {
    const { entryPath, root } = await createJsxCssPropFixture(
      "static-css-resolve-directory-"
    );

    const directoryPath = join(root, "src", "styles");
    const indexPath = join(directoryPath, "index.ts");
    await fs.promises.mkdir(directoryPath);
    await fs.promises.writeFile(indexPath, "export const button = {};", "utf8");

    try {
      expect(
        resolveStaticCssEvalImportFromFileSystem(entryPath, "./styles")
      ).toBe(indexPath);
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  describe("minchoEsbuildPlugin", () => {
    it("static css eval shared helpers normalize file ids and preserve source identity for esbuild", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "static-css-eval-shared-helper-identity-"
      );

      try {
        const rootRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(fixture.root)
        );

        const stylesRealpath = normalizeStaticCssEvalFileId(
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

    it("static css eval shared helpers watch real package and outside-root dependencies for esbuild", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "static-css-eval-shared-helper-boundary-"
      );

      try {
        const stylesRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(fixture.stylesPath)
        );

        const outsideRootFile = normalizeStaticCssEvalFileId(
          join(process.cwd(), "package.json")
        );

        const packagePath = join(fixture.root, "node_modules/pkg/styles.ts");
        await fs.promises.mkdir(dirname(packagePath), { recursive: true });
        await fs.promises.writeFile(
          packagePath,
          createImportedStyleSource("blue"),
          "utf8"
        );

        const packageRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(packagePath)
        );

        vi.spyOn(integrationHelpers, "babelTransformSource").mockResolvedValue({
          code: fixture.entrySource,
          result: ["", ""],
          staticCssEval: {
            dependencyFiles: [
              stylesRealpath,
              "virtual:mincho-static-css-eval-test",
              packageRealpath,
              outsideRootFile
            ]
          }
        } as BabelTransformResult);

        const harness = createBuildHarness({
          absWorkingDir: fixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true })
        });

        const scriptLoadResult = (await harness.loadScript({
          path: fixture.entryPath
        })) as ScriptLoadResult;

        expect(new Set(scriptLoadResult.watchFiles)).toEqual(
          new Set([stylesRealpath, packageRealpath, outsideRootFile])
        );
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("loads a TSX fixture with jsxCssProp enabled and registers extracted css sidecar content", async () => {
      const { entryPath, root } = await createJsxCssPropFixture(
        "jsx-css-prop-enabled-"
      );

      const babelTransformSpy = await spyOnSourceBabelTransform();
      const compileSpy = vi
        .spyOn(integrationHelpers, "compile")
        .mockResolvedValue({
          source: "compiled source"
        } as Awaited<ReturnType<typeof compile>>);

      vi.spyOn(
        integrationHelpers,
        "processDefineRulesPresetRegistryFile"
      ).mockResolvedValue(createRegistryResult("registered source"));

      try {
        const harness = createBuildHarness({
          plugin: minchoEsbuildPlugin({ jsxCssProp: true })
        });

        const scriptLoadResult = (await harness.loadScript({
          path: entryPath
        })) as ScriptLoadResult;

        const { file: sidecarFile, localNames: sidecarLocalNames } =
          extractCssPropSidecarImport(scriptLoadResult.contents);

        const cxImportMatch =
          /import \{ [^}]*\bcx(?: as ([A-Za-z_$][\w$]*))?[^}]*\} from "@mincho-js\/css";/.exec(
            scriptLoadResult.contents
          );

        const cxIdentifier = cxImportMatch?.[1] ?? "cx";
        const classNameMergeMatch =
          /className=\{([A-Za-z_$][\w$]*)\("base", ([A-Za-z_$][\w$]*)\)\}/.exec(
            scriptLoadResult.contents
          );

        expect(babelTransformSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filename: entryPath,
            source: expect.any(String),
            loader: "tsx",
            babel: expect.objectContaining({
              jsxCssProp: true,
              staticCssEvalSourceProvider: expect.any(Object)
            })
          })
        );
        expect(scriptLoadResult.loader).toBe("tsx");
        expect(scriptLoadResult.contents).not.toContain(" css=");
        expect(scriptLoadResult.contents).not.toContain("css={{");
        expect(scriptLoadResult.contents).not.toContain('color: "red"');
        expect(cxImportMatch).not.toBeNull();
        expect(classNameMergeMatch).not.toBeNull();
        expect(classNameMergeMatch?.[1]).toBe(cxIdentifier);
        expect(sidecarLocalNames).toContain(classNameMergeMatch?.[2]);

        const resolveResult = (await harness.resolveExtractedCss({
          path: sidecarFile,
          importer: entryPath,
          pluginData: scriptLoadResult.pluginData
        })) as ResolvedExtractedCssResult;

        const loadResult = (await harness.loadExtractedCss({
          path: resolveResult.path,
          pluginData: resolveResult.pluginData
        })) as ExtractedCssLoadResult;

        const compileOptions = compileSpy.mock.calls[0]?.[0];

        if (compileOptions == null) {
          throw new Error("Expected extracted css sidecar to be compiled");
        }

        expect(resolveResult).toEqual({
          namespace: "extracted-css",
          path: join(entryPath, "..", sidecarFile),
          pluginData: {
            path: sidecarFile,
            mainFilePath: entryPath
          }
        });
        expect(compileOptions).toEqual(
          expect.objectContaining({
            filePath: resolveResult.path,
            originalPath: entryPath,
            contents: expect.any(String)
          })
        );
        expect(compileOptions.contents).toContain("@mincho-js/css");
        expect(compileOptions.contents).toMatch(
          /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*css\(\{\s*color: "red"\s*\}\);/s
        );
        expect(loadResult.contents).toBe("registered source");
      } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
      }
    });

    it("lowers v2 class-value component and pre-css spread css props with jsxCssProp enabled", async () => {
      const { entryPath, root } = await createJsxCssPropFixture(
        "jsx-css-prop-v2-class-value-",
        createJsxCssPropV2ClassValueFixtureSource()
      );

      const babelTransformSpy = await spyOnSourceBabelTransform();

      try {
        const harness = createBuildHarness({
          plugin: minchoEsbuildPlugin({ jsxCssProp: true })
        });

        const scriptLoadResult = (await harness.loadScript({
          path: entryPath
        })) as ScriptLoadResult;

        const cxIdentifier = extractCxIdentifierFromSource(
          scriptLoadResult.contents
        );

        const missingResolveResult = await harness.resolveExtractedCss({
          path: "extracted_missing.css.ts",
          importer: entryPath,
          pluginData: scriptLoadResult.pluginData
        });

        expect(babelTransformSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filename: entryPath,
            source: expect.any(String),
            loader: "tsx",
            babel: expect.objectContaining({
              jsxCssProp: true,
              staticCssEvalSourceProvider: expect.any(Object)
            })
          })
        );
        expect(scriptLoadResult.loader).toBe("tsx");
        expect(scriptLoadResult.contents).not.toContain(" css=");
        expect(scriptLoadResult.contents).not.toContain("css={styleA}");
        expect(scriptLoadResult.contents).not.toContain("css={styleB}");
        expect(scriptLoadResult.contents).not.toContain("css(styleA)");
        expect(scriptLoadResult.contents).not.toContain("_css(styleA)");

        expectSourceToContainV2ClassValueCssPropLowering(
          scriptLoadResult.contents,
          cxIdentifier
        );

        expect(missingResolveResult).toBeUndefined();
      } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
      }
    });

    it("forwards jsxCssProp through the exported plugin array", async () => {
      const { entryPath, root } = await createJsxCssPropFixture(
        "jsx-css-prop-plugin-array-",
        createJsxCssPropV2ClassValueFixtureSource()
      );

      const minchoPlugin = minchoEsbuildPlugins({ jsxCssProp: true })[0];
      const babelTransformSpy = await spyOnSourceBabelTransform();

      if (minchoPlugin == null) {
        throw new Error(
          "Expected exported plugin array to include Mincho plugin"
        );
      }

      try {
        const harness = createBuildHarness({ plugin: minchoPlugin });
        const scriptLoadResult = (await harness.loadScript({
          path: entryPath
        })) as ScriptLoadResult;

        const cxIdentifier = extractCxIdentifierFromSource(
          scriptLoadResult.contents
        );

        expect(babelTransformSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filename: entryPath,
            source: expect.any(String),
            loader: "tsx",
            babel: expect.objectContaining({
              jsxCssProp: true,
              staticCssEvalSourceProvider: expect.any(Object)
            })
          })
        );
        expect(scriptLoadResult.contents).not.toContain(" css=");

        expectSourceToContainV2ClassValueCssPropLowering(
          scriptLoadResult.contents,
          cxIdentifier
        );
      } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
      }
    });

    it("refreshes imported static css prop dependencies across esbuild rebuilds without stale CSS", async () => {
      const realEsbuild = await import("esbuild");
      const fixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-imported-rebuild-"
      );

      await spyOnSourceBabelTransform();

      const harness = createBuildHarness({
        absWorkingDir: fixture.root,
        plugin: minchoEsbuildPlugin({ jsxCssProp: true })
      });

      const scriptLoadResult = (await harness.loadScript({
        path: fixture.entryPath
      })) as ScriptLoadResult;

      const stylesRealpath = normalizeStaticCssEvalFileId(
        await fs.promises.realpath(fixture.stylesPath)
      );

      const context = await realEsbuild.context({
        absWorkingDir: fixture.root,
        bundle: true,
        entryPoints: [fixture.entryPath],
        external: ["@mincho-js/css"],
        format: "esm",
        minify: false,
        outdir: join(fixture.root, "dist"),
        plugins: minchoEsbuildPlugins({ jsxCssProp: true }),
        write: false
      });

      try {
        expect(scriptLoadResult.watchFiles).toContain(stylesRealpath);

        const redOutput = collectEsbuildOutputTexts(await context.rebuild());

        expectCssPropBuildOutputToContainColor(redOutput, "red");

        expect(redOutput.all).not.toContain("color: blue");

        await fs.promises.writeFile(
          fixture.stylesPath,
          createImportedStyleSource("blue"),
          "utf8"
        );

        const blueOutput = collectEsbuildOutputTexts(await context.rebuild());

        expectCssPropBuildOutputToContainColor(blueOutput, "blue");

        expect(blueOutput.all).not.toContain("color: red");
      } finally {
        await context.dispose();
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    }, 20000);

    it("supplies esbuild canonical resolver fields to the static css eval source provider", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-provider-canonical-"
      );

      const captured: {
        loadedSource?: StaticCssEvalLoadedSource | null;
        resolution?: StaticCssEvalSourceResolution | null;
      } = {};

      try {
        vi.spyOn(integrationHelpers, "babelTransformSource").mockImplementation(
          async ({
            babel: options = {}
          }: Parameters<typeof babelTransformSource>[0]) => {
            const sourceProvider = options.staticCssEvalSourceProvider;

            if (!sourceProvider) {
              throw new Error(
                "Expected esbuild static css eval source provider"
              );
            }

            captured.resolution = await sourceProvider.resolve(
              fixture.entryPath,
              "./styles"
            );

            if (!captured.resolution?.normalizedPathKey) {
              throw new Error("Expected canonical esbuild source resolution");
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
            } as BabelTransformResult;
          }
        );

        const emptyResolveResult = createStaticCssEvalResolveResult("");
        const harness = createBuildHarness({
          absWorkingDir: fixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true }),

          async resolve(source) {
            return source === "./styles"
              ? createStaticCssEvalResolveResult(
                  `/@fs${fixture.stylesPath}?import#hmr`
                )
              : emptyResolveResult;
          }
        });

        const scriptLoadResult = (await harness.loadScript({
          path: fixture.entryPath
        })) as ScriptLoadResult;

        const stylesRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(fixture.stylesPath)
        );

        const canonicalModuleId = `${stylesRealpath}?import#hmr`;
        const resolution = captured.resolution;
        const loadedSource = captured.loadedSource;

        if (!resolution || !loadedSource) {
          throw new Error(
            "Expected captured esbuild static css provider metadata"
          );
        }

        expect(resolution).toMatchObject({
          id: canonicalModuleId,
          resolvedFile: canonicalModuleId,
          canonicalModuleId,
          normalizedPathKey: canonicalModuleId,
          realpath: stylesRealpath,
          sourceIdentity: {
            sourceHash: expect.stringMatching(/^mtime:/)
          },
          resolverKind: "esbuild"
        });
        expect(loadedSource).toMatchObject({
          sourceText: fixture.styleSource,
          resolvedFile: canonicalModuleId,
          canonicalModuleId,
          normalizedPathKey: canonicalModuleId,
          realpath: stylesRealpath,
          sourceIdentity: {
            sourceHash: expect.stringMatching(/^mtime:/)
          },
          resolverKind: "esbuild"
        });
        expect(scriptLoadResult.watchFiles).toContain(stylesRealpath);
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("dedupes query, hash, /@fs, and SSR metadata variants to one watch key", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-normalized-metadata-"
      );

      try {
        const stylesRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(fixture.stylesPath)
        );

        vi.spyOn(integrationHelpers, "babelTransformSource").mockResolvedValue({
          code: fixture.entrySource,
          result: ["", ""],
          staticCssEval:
            createDuplicatedStaticCssEvalMetadataVariants(stylesRealpath)
        } as BabelTransformResult);

        const harness = createBuildHarness({
          absWorkingDir: fixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true })
        });

        const scriptLoadResult = (await harness.loadScript({
          path: fixture.entryPath
        })) as ScriptLoadResult;

        expect(scriptLoadResult.watchFiles).toEqual([stylesRealpath]);
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("static css eval watch files include dependencies and caches clear on end", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "static-css-eval-watch-files-"
      );

      const stylesRealpath = normalizeStaticCssEvalFileId(
        await fs.promises.realpath(fixture.stylesPath)
      );

      const outsideRootFile = normalizeStaticCssEvalFileId(
        join(process.cwd(), "package.json")
      );

      const packagePath = join(fixture.root, "node_modules/pkg/styles.ts");
      await fs.promises.mkdir(dirname(packagePath), { recursive: true });
      await fs.promises.writeFile(
        packagePath,
        createImportedStyleSource("blue"),
        "utf8"
      );

      const packageRealpath = normalizeStaticCssEvalFileId(
        await fs.promises.realpath(packagePath)
      );

      let resolveCalls = 0;
      const loadedStyleSources: string[] = [];

      vi.spyOn(integrationHelpers, "babelTransformSource").mockImplementation(
        async ({
          babel: options = {}
        }: Parameters<typeof babelTransformSource>[0]) => {
          const sourceProvider = options.staticCssEvalSourceProvider;

          if (!sourceProvider) {
            throw new Error("Expected esbuild static css eval source provider");
          }

          const firstResolution = await sourceProvider.resolve(
            fixture.entryPath,
            "./styles"
          );

          const secondResolution = await sourceProvider.resolve(
            fixture.entryPath,
            "./styles"
          );

          expect(secondResolution).toBe(firstResolution);

          if (!firstResolution?.normalizedPathKey) {
            throw new Error("Expected esbuild static css eval resolution");
          }

          const firstLoadedSource = await sourceProvider.load(
            firstResolution.normalizedPathKey
          );

          const secondLoadedSource = await sourceProvider.load(
            firstResolution.normalizedPathKey
          );

          expect(secondLoadedSource).toBe(firstLoadedSource);

          loadedStyleSources.push(firstLoadedSource?.sourceText ?? "");

          return {
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
          } as BabelTransformResult;
        }
      );

      try {
        const harness = createBuildHarness({
          absWorkingDir: fixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true }),

          async resolve(
            source: string,
            options?: Parameters<PluginBuild["resolve"]>[1]
          ) {
            if (source !== "./styles") {
              return createStaticCssEvalResolveResult("");
            }

            resolveCalls += 1;

            return createStaticCssEvalResolveResult(
              resolveStaticCssEvalImportFromFileSystem(
                options?.importer ?? fixture.entryPath,
                source
              ) ?? ""
            );
          }
        });

        const firstLoadResult = (await harness.loadScript({
          path: fixture.entryPath
        })) as ScriptLoadResult;

        expect(new Set(firstLoadResult.watchFiles)).toEqual(
          new Set([stylesRealpath, packageRealpath, outsideRootFile])
        );
        expect(resolveCalls).toBe(1);
        expect(loadedStyleSources).toEqual([fixture.styleSource]);

        await fs.promises.writeFile(
          fixture.stylesPath,
          createImportedStyleSource("blue"),
          "utf8"
        );

        harness.endBuild();

        const secondLoadResult = (await harness.loadScript({
          path: fixture.entryPath
        })) as ScriptLoadResult;

        expect(new Set(secondLoadResult.watchFiles)).toEqual(
          new Set([stylesRealpath, packageRealpath, outsideRootFile])
        );
        expect(resolveCalls).toBe(2);
        expect(loadedStyleSources).toEqual([
          fixture.styleSource,
          createImportedStyleSource("blue")
        ]);
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("registers direct re-export dependency metadata without re-deriving provenance", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-imported-watch-reexport-",
        {
          entrySource: createImportedCssPropEntrySource("./barrel")
        }
      );

      const barrelPath = join(fixture.srcRoot, "barrel.ts");
      const buttonPath = join(fixture.srcRoot, "button.ts");

      try {
        await fs.promises.writeFile(
          barrelPath,
          'export { button } from "./button";',
          "utf8"
        );
        await fs.promises.writeFile(
          buttonPath,
          'export const button = { color: "red" } as const;',
          "utf8"
        );

        const barrelRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(barrelPath)
        );

        const buttonRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(buttonPath)
        );

        vi.spyOn(integrationHelpers, "babelTransformSource").mockResolvedValue({
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
        } as BabelTransformResult);

        const harness = createBuildHarness({
          absWorkingDir: fixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true })
        });

        const scriptLoadResult = (await harness.loadScript({
          path: fixture.entryPath
        })) as ScriptLoadResult;

        expect(new Set(scriptLoadResult.watchFiles)).toEqual(
          new Set([barrelRealpath, buttonRealpath])
        );
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("registers CommonJS require dependency metadata from Babel integration", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-cjs-require-watch-",
        {
          entrySource: `
            const styles = require("./styles");

            function App() {
              return <div css={styles.button} />;
            }
          `,
          styleSource: `exports.button = { color: "red" };`
        }
      );

      try {
        await spyOnSourceBabelTransform();

        const stylesRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(fixture.stylesPath)
        );

        const harness = createBuildHarness({
          absWorkingDir: fixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true })
        });

        const scriptLoadResult = (await harness.loadScript({
          path: fixture.entryPath
        })) as ScriptLoadResult;

        expect(new Set(scriptLoadResult.watchFiles)).toEqual(
          new Set([stylesRealpath])
        );
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("refreshes export-star namespace member watch files when leaf and barrel targets change", async () => {
      const realEsbuild = await import("esbuild");
      const fixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-export-star-namespace-watch-",
        {
          entrySource: createNamespaceCssPropEntrySource()
        }
      );

      const barrelPath = join(fixture.srcRoot, "barrel.ts");
      const buttonPath = join(fixture.srcRoot, "button.ts");
      const primaryButtonPath = join(fixture.srcRoot, "primaryButton.ts");

      await spyOnSourceBabelTransform();
      await fs.promises.writeFile(
        barrelPath,
        'export * from "./button";',
        "utf8"
      );
      await fs.promises.writeFile(
        buttonPath,
        'export const button = { primary: { color: "red" } } as const;',
        "utf8"
      );
      await fs.promises.writeFile(
        primaryButtonPath,
        'export const button = { primary: { color: "green" } } as const;',
        "utf8"
      );

      const harness = createBuildHarness({
        absWorkingDir: fixture.root,
        plugin: minchoEsbuildPlugin({ jsxCssProp: true })
      });

      const context = await realEsbuild.context({
        absWorkingDir: fixture.root,
        bundle: true,
        entryPoints: [fixture.entryPath],
        external: ["@mincho-js/css"],
        format: "esm",
        minify: false,
        outdir: join(fixture.root, "dist"),
        plugins: minchoEsbuildPlugins({ jsxCssProp: true }),
        write: false
      });

      try {
        const barrelRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(barrelPath)
        );

        const buttonRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(buttonPath)
        );

        const primaryButtonRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(primaryButtonPath)
        );

        const firstWatchFiles = getScriptLoadWatchFiles(
          await harness.loadScript({
            path: fixture.entryPath
          })
        );

        expect(new Set(firstWatchFiles)).toEqual(
          new Set([barrelRealpath, buttonRealpath])
        );

        const redOutput = collectEsbuildOutputTexts(await context.rebuild());
        expectCssPropBuildOutputToContainColor(redOutput, "red");

        await fs.promises.writeFile(
          buttonPath,
          'export const button = { primary: { color: "blue" } } as const;',
          "utf8"
        );

        const blueOutput = collectEsbuildOutputTexts(await context.rebuild());
        expectCssPropBuildOutputToContainColor(blueOutput, "blue");

        expect(blueOutput.all).not.toContain("color: red");

        await fs.promises.writeFile(
          barrelPath,
          'export * from "./primaryButton";',
          "utf8"
        );

        const greenOutput = collectEsbuildOutputTexts(await context.rebuild());
        expectCssPropBuildOutputToContainColor(greenOutput, "green");

        expect(greenOutput.all).not.toContain("color: blue");

        harness.endBuild();

        const secondWatchFiles = getScriptLoadWatchFiles(
          await harness.loadScript({
            path: fixture.entryPath
          })
        );

        expect(new Set(secondWatchFiles)).toEqual(
          new Set([barrelRealpath, primaryButtonRealpath])
        );
        expect(secondWatchFiles).not.toContain(buttonRealpath);
      } finally {
        await context.dispose();
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    }, 20000);

    it("registers whole namespace export-star watch metadata from Babel integration", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-whole-namespace-export-star-watch-",
        {
          entrySource: createNamespaceCssPropEntrySource("./barrel", "styles")
        }
      );

      const barrelPath = join(fixture.srcRoot, "barrel.ts");
      const resetPath = join(fixture.srcRoot, "reset.ts");
      const buttonPath = join(fixture.srcRoot, "button.ts");

      try {
        await fs.promises.writeFile(
          barrelPath,
          'export { default } from "./reset"; export * from "./button";',
          "utf8"
        );
        await fs.promises.writeFile(
          resetPath,
          "export default { margin: 0 } as const;",
          "utf8"
        );
        await fs.promises.writeFile(
          buttonPath,
          'export const button = { color: "red" } as const;',
          "utf8"
        );

        const barrelRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(barrelPath)
        );

        const resetRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(resetPath)
        );

        const buttonRealpath = normalizeStaticCssEvalFileId(
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

        vi.spyOn(integrationHelpers, "babelTransformSource").mockResolvedValue(
          transformResult
        );

        const harness = createBuildHarness({
          absWorkingDir: fixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true })
        });

        const watchFiles = getScriptLoadWatchFiles(
          await harness.loadScript({
            path: fixture.entryPath
          })
        );

        expect(new Set(watchFiles)).toEqual(
          new Set([barrelRealpath, resetRealpath, buttonRealpath])
        );
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("surfaces import-cycle static css eval diagnostics without hanging", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-imported-cycle-",
        {
          entrySource: createImportedCssPropEntrySource("./barrel")
        }
      );

      const barrelPath = join(fixture.srcRoot, "barrel.ts");
      const buttonPath = join(fixture.srcRoot, "button.ts");

      try {
        await fs.promises.writeFile(
          barrelPath,
          'export { button } from "./button";',
          "utf8"
        );
        await fs.promises.writeFile(
          buttonPath,
          'export { button } from "./barrel";',
          "utf8"
        );

        const barrelRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(barrelPath)
        );

        const buttonRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(buttonPath)
        );

        const cycleStaticCssEval: StaticCssEvalMetadata = {
          dependencyFiles: [barrelRealpath, buttonRealpath],
          dependencies: [
            { file: barrelRealpath, kind: "reexported" },
            { file: buttonRealpath, kind: "reexported" }
          ],
          resolvedDependencies: [
            { resolvedFile: barrelRealpath },
            { resolvedFile: buttonRealpath }
          ],
          diagnostics: [
            {
              id: "STATIC_CSS_EVAL_IMPORT_CYCLE",
              dependency: { file: buttonRealpath }
            }
          ],
          resolvedModuleIds: [barrelRealpath, buttonRealpath]
        };

        const cycleError = new Error(
          "STATIC_CSS_EVAL_IMPORT_CYCLE: cyclic static css reference detected"
        ) as Error & { staticCssEval: StaticCssEvalMetadata };

        cycleError.staticCssEval = cycleStaticCssEval;

        vi.spyOn(integrationHelpers, "babelTransformSource").mockRejectedValue(
          cycleError
        );

        const harness = createBuildHarness({
          absWorkingDir: fixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true })
        });

        let thrownError: unknown;

        try {
          await harness.loadScript({ path: fixture.entryPath });
        } catch (error) {
          thrownError = error;
        }

        expect(thrownError).toBe(cycleError);
        expect(
          (
            thrownError as { staticCssEval?: StaticCssEvalMetadata }
          ).staticCssEval?.diagnostics?.map((diagnostic) => diagnostic.id)
        ).toContain("STATIC_CSS_EVAL_IMPORT_CYCLE");
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("scopes imported static css eval source caches to independent esbuild build contexts", async () => {
      const realEsbuild = await import("esbuild");
      const redFixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-cache-scope-red-",
        { styleSource: createImportedStyleSource("red") }
      );

      const blueFixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-cache-scope-blue-",
        { styleSource: createImportedStyleSource("blue") }
      );

      await spyOnSourceBabelTransform();

      const sharedMinchoPlugin = minchoEsbuildPlugin({ jsxCssProp: true });
      const redContext = await realEsbuild.context({
        absWorkingDir: redFixture.root,
        bundle: true,
        entryPoints: [redFixture.entryPath],
        external: ["@mincho-js/css"],
        format: "esm",
        minify: false,
        outdir: join(redFixture.root, "dist"),
        plugins: [sharedMinchoPlugin, vanillaExtractPlugin()],
        write: false
      });

      const blueContext = await realEsbuild.context({
        absWorkingDir: blueFixture.root,
        bundle: true,
        entryPoints: [blueFixture.entryPath],
        external: ["@mincho-js/css"],
        format: "esm",
        minify: false,
        outdir: join(blueFixture.root, "dist"),
        plugins: [sharedMinchoPlugin, vanillaExtractPlugin()],
        write: false
      });

      try {
        const redOutput = collectEsbuildOutputTexts(await redContext.rebuild());
        const blueOutput = collectEsbuildOutputTexts(
          await blueContext.rebuild()
        );

        expectCssPropBuildOutputToContainColor(redOutput, "red");

        expect(redOutput.all).not.toContain("color: blue");

        expectCssPropBuildOutputToContainColor(blueOutput, "blue");

        expect(blueOutput.all).not.toContain("color: red");
      } finally {
        await Promise.all([redContext.dispose(), blueContext.dispose()]);
        await Promise.all([
          fs.promises.rm(redFixture.root, { force: true, recursive: true }),
          fs.promises.rm(blueFixture.root, { force: true, recursive: true })
        ]);
      }
    }, 20000);

    it("supports static css eval package named default and namespace imports from esbuild file namespace packages", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "static-css-eval-package-file-namespace-",
        {
          entrySource: `
            import defaultButton, { button } from "@pkg/styles";
            import * as styles from "@pkg/styles";

            function App() {
              return <>
                <div css={button} />
                <div css={defaultButton} />
                <div css={styles.card} />
              </>;
            }

            export { App };
          `
        }
      );

      const packageRoot = join(fixture.root, "node_modules/@pkg/styles");
      const packageIndexPath = join(packageRoot, "index.ts");
      await spyOnSourceBabelTransform();

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

        const harness = createBuildHarness({
          absWorkingDir: fixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true }),
          resolve: createMappedEsbuildResolve({
            "@pkg/styles": createStaticCssEvalResolveResult(packageIndexPath)
          })
        });

        const { scriptSource, sidecarSource } =
          await loadCssPropSidecarSourceFromHarness(harness, fixture.entryPath);

        expect(scriptSource).not.toContain("css={button}");
        expect(sidecarSource).toContain('color: "red"');
        expect(sidecarSource).toContain('color: "orange"');
        expect(sidecarSource).toContain('color: "green"');
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("supports static css eval package export-star barrels resolved by esbuild", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "static-css-eval-package-export-star-",
        {
          entrySource: createImportedCssPropEntrySource("@pkg/styles")
        }
      );

      const packageRoot = join(fixture.root, "node_modules/@pkg/styles");
      const packageIndexPath = join(packageRoot, "index.ts");
      const packageButtonPath = join(packageRoot, "button.ts");
      await spyOnSourceBabelTransform();

      try {
        await fs.promises.mkdir(packageRoot, { recursive: true });
        await fs.promises.writeFile(
          packageIndexPath,
          'export * from "./button";',
          "utf8"
        );
        await fs.promises.writeFile(
          packageButtonPath,
          createImportedStyleSource("blue"),
          "utf8"
        );

        const harness = createBuildHarness({
          absWorkingDir: fixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true }),
          resolve: createMappedEsbuildResolve({
            "@pkg/styles": createStaticCssEvalResolveResult(packageIndexPath)
          })
        });

        const { sidecarSource } = await loadCssPropSidecarSourceFromHarness(
          harness,
          fixture.entryPath
        );

        expect(sidecarSource).toContain('color: "blue"');
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("supports static css eval json default and named imports from esbuild packages", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "static-css-eval-json-package-",
        {
          entrySource: `
            import jsonStyles, { button } from "@pkg/styles/styles.json";

            function App() {
              return <>
                <div css={button} />
                <div css={jsonStyles.card} />
              </>;
            }
          `
        }
      );

      const packageRoot = join(fixture.root, "node_modules/@pkg/styles");
      const packageJsonPath = join(packageRoot, "styles.json");
      await spyOnSourceBabelTransform();

      try {
        await fs.promises.mkdir(packageRoot, { recursive: true });
        await fs.promises.writeFile(
          packageJsonPath,
          JSON.stringify({
            button: { color: "red" },
            card: { color: "green" }
          }),
          "utf8"
        );

        const harness = createBuildHarness({
          absWorkingDir: fixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true }),
          resolve: createMappedEsbuildResolve({
            "@pkg/styles/styles.json":
              createStaticCssEvalResolveResult(packageJsonPath)
          })
        });

        const { sidecarSource } = await loadCssPropSidecarSourceFromHarness(
          harness,
          fixture.entryPath
        );

        expect(sidecarSource).toContain('color: "red"');
        expect(sidecarSource).toContain('color: "green"');
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("supports static css eval raw string imports from esbuild package suffixes", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "static-css-eval-raw-package-",
        {
          entrySource: `
            import rawColor from "@pkg/styles/color.txt?raw";

            function App() {
              return <div css={{ color: rawColor }} />;
            }
          `
        }
      );

      const packageRoot = join(fixture.root, "node_modules/@pkg/styles");
      const rawColorPath = join(packageRoot, "color.txt");
      const captured: {
        loadedSource?: StaticCssEvalLoadedSource | null;
        resolution?: StaticCssEvalSourceResolution | null;
      } = {};

      try {
        await fs.promises.mkdir(packageRoot, { recursive: true });
        await fs.promises.writeFile(rawColorPath, "red", "utf8");
        vi.spyOn(integrationHelpers, "babelTransformSource").mockImplementation(
          async ({
            babel: options = {}
          }: Parameters<typeof babelTransformSource>[0]) => {
            const sourceProvider = options.staticCssEvalSourceProvider;

            if (!sourceProvider) {
              throw new Error(
                "Expected esbuild static css eval source provider"
              );
            }

            captured.resolution = await sourceProvider.resolve(
              fixture.entryPath,
              "@pkg/styles/color.txt?raw"
            );

            if (!captured.resolution?.normalizedPathKey) {
              throw new Error("Expected raw data source resolution");
            }

            captured.loadedSource = await sourceProvider.load(
              captured.resolution.normalizedPathKey
            );

            return {
              code: fixture.entrySource,
              result: ["", ""]
            } as BabelTransformResult;
          }
        );

        const harness = createBuildHarness({
          absWorkingDir: fixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true }),
          resolve: createMappedEsbuildResolve({
            "@pkg/styles/color.txt?raw": createSuffixedEsbuildResolveResult(
              rawColorPath,
              "?raw"
            )
          })
        });

        await harness.loadScript({ path: fixture.entryPath });

        const rawRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(rawColorPath)
        );

        expect(captured.resolution).toMatchObject({
          resolvedFile: `${rawRealpath}?raw`,
          canonicalModuleId: `${rawRealpath}?raw`,
          normalizedPathKey: `${rawRealpath}?raw`,
          realpath: rawRealpath,
          sourceKind: "static-data",
          sourceOrigin: "data",
          watchFiles: [rawRealpath],
          resolverKind: "esbuild"
        });
        expect(captured.loadedSource).toMatchObject({
          sourceText: "red",
          resolvedFile: `${rawRealpath}?raw`,
          sourceKind: "static-data",
          sourceOrigin: "data",
          watchFiles: [rawRealpath],
          resolverKind: "esbuild"
        });
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("supports static css eval wasm url string imports from esbuild package suffixes", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "static-css-eval-wasm-url-package-",
        {
          entrySource: `
            import wasmUrl from "@pkg/styles/icon.wasm?url";

            function App() {
              return <div css={{ backgroundImage: wasmUrl }} />;
            }
          `
        }
      );

      const packageRoot = join(fixture.root, "node_modules/@pkg/styles");
      const wasmPath = join(packageRoot, "icon.wasm");
      const captured: {
        loadedSource?: StaticCssEvalLoadedSource | null;
        resolution?: StaticCssEvalSourceResolution | null;
      } = {};

      try {
        await fs.promises.mkdir(packageRoot, { recursive: true });
        await fs.promises.writeFile(wasmPath, "wasm-init", "utf8");
        vi.spyOn(integrationHelpers, "babelTransformSource").mockImplementation(
          async ({
            babel: options = {}
          }: Parameters<typeof babelTransformSource>[0]) => {
            const sourceProvider = options.staticCssEvalSourceProvider;

            if (!sourceProvider) {
              throw new Error(
                "Expected esbuild static css eval source provider"
              );
            }

            captured.resolution = await sourceProvider.resolve(
              fixture.entryPath,
              "@pkg/styles/icon.wasm?url"
            );

            if (!captured.resolution?.normalizedPathKey) {
              throw new Error("Expected wasm url data source resolution");
            }

            captured.loadedSource = await sourceProvider.load(
              captured.resolution.normalizedPathKey
            );

            return {
              code: fixture.entrySource,
              result: ["", ""]
            } as BabelTransformResult;
          }
        );

        const harness = createBuildHarness({
          absWorkingDir: fixture.root,
          esbuild: await import("esbuild"),
          loader: { ".wasm": "file" },
          outdir: join(fixture.root, "out"),
          plugin: minchoEsbuildPlugin({ jsxCssProp: true }),
          resolve: createMappedEsbuildResolve({
            "@pkg/styles/icon.wasm?url": createSuffixedEsbuildResolveResult(
              wasmPath,
              "?url"
            )
          })
        });

        await harness.loadScript({ path: fixture.entryPath });

        const wasmRealpath = normalizeStaticCssEvalFileId(
          await fs.promises.realpath(wasmPath)
        );

        expect(captured.resolution).toMatchObject({
          resolvedFile: `${wasmRealpath}?url`,
          canonicalModuleId: `${wasmRealpath}?url`,
          normalizedPathKey: `${wasmRealpath}?url`,
          realpath: wasmRealpath,
          sourceKind: "static-data",
          sourceOrigin: "data",
          watchFiles: [wasmRealpath],
          resolverKind: "esbuild"
        });
        expect(captured.loadedSource).toMatchObject({
          sourceText: expect.stringMatching(/^\.\/icon-[A-Z0-9]+\.wasm\?url$/),
          resolvedFile: `${wasmRealpath}?url`,
          sourceKind: "static-data",
          sourceOrigin: "data",
          watchFiles: [wasmRealpath],
          resolverKind: "esbuild"
        });
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("rejects static css eval external no-source imports without filesystem fallback", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "static-css-eval-external-no-source-",
        {
          entrySource: createImportedCssPropEntrySource("@pkg/external")
        }
      );

      await spyOnSourceBabelTransform();

      try {
        const harness = createBuildHarness({
          absWorkingDir: fixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true }),
          resolve: createMappedEsbuildResolve({
            "@pkg/external": {
              ...createStaticCssEvalResolveResult("@pkg/external"),
              external: true
            }
          })
        });

        await expect(
          harness.loadScript({ path: fixture.entryPath })
        ).rejects.toThrow("Cannot statically evaluate css prop value");
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("rejects static css eval unsupported non-file namespace virtual imports", async () => {
      const fixture = await createImportedCssPropEsbuildFixture(
        "static-css-eval-unsupported-non-file-namespace-",
        {
          entrySource: createImportedCssPropEntrySource("virtual:styles")
        }
      );

      await spyOnSourceBabelTransform();

      try {
        const harness = createBuildHarness({
          absWorkingDir: fixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true }),
          resolve: createMappedEsbuildResolve({
            "virtual:styles": {
              ...createStaticCssEvalResolveResult("virtual:styles"),
              namespace: "virtual"
            }
          })
        });

        await expect(
          harness.loadScript({ path: fixture.entryPath })
        ).rejects.toThrow("Cannot statically evaluate css prop value");
      } finally {
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    });

    it("rejects static css eval wasm runtime and direct imports from esbuild packages", async () => {
      const wasmCases = [
        {
          importPath: "@pkg/styles/icon.wasm?init",
          localName: "initWasm",
          prefix: "static-css-eval-wasm-runtime-package-",
          suffix: "?init"
        },
        {
          importPath: "@pkg/styles/icon.wasm",
          localName: "directWasm",
          prefix: "static-css-eval-wasm-direct-package-",
          suffix: ""
        }
      ] as const;

      for (const wasmCase of wasmCases) {
        const fixture = await createImportedCssPropEsbuildFixture(
          wasmCase.prefix,
          {
            entrySource: `
              import ${wasmCase.localName} from "${wasmCase.importPath}";

              function App() {
                return <div css={{ color: ${wasmCase.localName} }} />;
              }
            `
          }
        );

        const packageRoot = join(fixture.root, "node_modules/@pkg/styles");
        const wasmPath = join(packageRoot, "icon.wasm");
        await spyOnSourceBabelTransform();

        try {
          await fs.promises.mkdir(packageRoot, { recursive: true });
          await fs.promises.writeFile(wasmPath, "wasm-runtime", "utf8");

          const harness = createBuildHarness({
            absWorkingDir: fixture.root,
            plugin: minchoEsbuildPlugin({ jsxCssProp: true }),
            resolve: createMappedEsbuildResolve({
              [wasmCase.importPath]: createSuffixedEsbuildResolveResult(
                wasmPath,
                wasmCase.suffix
              )
            })
          });

          await expect(
            harness.loadScript({ path: fixture.entryPath })
          ).rejects.toThrow("Cannot statically evaluate css prop value");
        } finally {
          await fs.promises.rm(fixture.root, { force: true, recursive: true });
        }
      }
    });

    it("rejects virtual static css evaluation at esbuild boundaries", async () => {
      const fallbackFixture = await createJsxCssPropFixture(
        "jsx-css-prop-esbuild-boundary-fallback-",
        `
          import { button as virtualButton } from "virtual:styles";

          function App() {
            return <div css={virtualButton} />;
          }
        `
      );

      await spyOnSourceBabelTransform();

      try {
        const fallbackHarness = createBuildHarness({
          absWorkingDir: fallbackFixture.root,
          plugin: minchoEsbuildPlugin({ jsxCssProp: true })
        });

        await expect(
          fallbackHarness.loadScript({ path: fallbackFixture.entryPath })
        ).rejects.toThrow('import "virtual:styles" could not be resolved');
      } finally {
        await fs.promises.rm(fallbackFixture.root, {
          force: true,
          recursive: true
        });
      }
    });

    it("retransforms owners and drops stale CSS when an imported static dependency is deleted", async () => {
      const realEsbuild = await import("esbuild");
      const fixture = await createImportedCssPropEsbuildFixture(
        "jsx-css-prop-imported-deleted-dependency-"
      );

      await spyOnSourceBabelTransform();

      const context = await realEsbuild.context({
        absWorkingDir: fixture.root,
        bundle: true,
        entryPoints: [fixture.entryPath],
        external: ["@mincho-js/css"],
        format: "esm",
        minify: false,
        outdir: join(fixture.root, "dist"),
        plugins: minchoEsbuildPlugins({ jsxCssProp: true }),
        write: false
      });

      try {
        const redOutput = collectEsbuildOutputTexts(await context.rebuild());

        expectCssPropBuildOutputToContainColor(redOutput, "red");

        await fs.promises.rm(fixture.stylesPath, { force: true });

        await expect(context.rebuild()).rejects.toThrow(
          'import "./styles" could not be resolved'
        );
      } finally {
        await context.dispose();
        await fs.promises.rm(fixture.root, { force: true, recursive: true });
      }
    }, 20000);

    it("leaves TSX css prop unchanged when jsxCssProp is omitted or false", async () => {
      const fixtureCases = [
        {
          prefix: "jsx-css-prop-default-",
          plugin: minchoEsbuildPlugin(),
          expectedBabelOptions: undefined
        },
        {
          prefix: "jsx-css-prop-false-",
          plugin: minchoEsbuildPlugin({ jsxCssProp: false }),
          expectedBabelOptions: { jsxCssProp: false }
        }
      ] as const;

      for (const fixtureCase of fixtureCases) {
        const { entryPath, root } = await createJsxCssPropFixture(
          fixtureCase.prefix
        );

        const babelTransformSpy = vi.spyOn(
          integrationHelpers,
          "babelTransformSource"
        );

        try {
          const harness = createBuildHarness({ plugin: fixtureCase.plugin });
          const scriptLoadResult = (await harness.loadScript({
            path: entryPath
          })) as ScriptLoadResult;

          const resolveResult = await harness.resolveExtractedCss({
            path: "extracted_missing.css.ts",
            importer: entryPath,
            pluginData: scriptLoadResult.pluginData
          });

          expect(babelTransformSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              filename: entryPath,
              source: expect.any(String),
              loader: "tsx",
              babel: fixtureCase.expectedBabelOptions
            })
          );
          expect(scriptLoadResult.loader).toBe("tsx");
          expect(scriptLoadResult.contents).toContain('className="base"');
          expect(scriptLoadResult.contents).toContain("css={{");
          expect(scriptLoadResult.contents).toContain('color: "red"');
          expect(scriptLoadResult.contents).not.toMatch(
            /className=\{[A-Za-z_$][\w$]*\("base", [A-Za-z_$][\w$]*\)\}/
          );
          expect(resolveResult).toBeUndefined();
        } finally {
          babelTransformSpy.mockRestore();
          await fs.promises.rm(root, { force: true, recursive: true });
        }
      }
    });

    it("builds a real esbuild fixture and emits defineRules preset registry artifact", async () => {
      const realEsbuild = await import("esbuild");
      const { entryPath, root } = await createLivePresetSmokeFixture(
        "define-rules-esbuild-smoke-"
      );

      try {
        const result = await realEsbuild.build({
          absWorkingDir: root,
          bundle: true,
          entryPoints: [entryPath],
          external: ["@mincho-js/css"],
          format: "esm",
          minify: false,
          outdir: join(root, "dist"),
          plugins: minchoEsbuildPlugins(),
          write: false
        });

        const jsOutput = result.outputFiles.find((outputFile) =>
          outputFile.path.endsWith(".js")
        );

        const cssOutput = result.outputFiles.find((outputFile) =>
          outputFile.path.endsWith(".css")
        );

        if (jsOutput == null) {
          throw new Error("Expected esbuild smoke build to emit a JS file");
        }
        if (cssOutput == null) {
          throw new Error("Expected esbuild smoke build to emit a CSS file");
        }

        const fillBlueClassName = extractFillBlueClassName(jsOutput.text);

        expect(jsOutput.text).not.toContain('background: "blue"');

        expectCssSourceToContainClassNames(cssOutput.text, fillBlueClassName);

        expect(cssOutput.text).toContain("background: blue;");

        vi.spyOn(integrationHelpers, "babelTransformSource").mockResolvedValue({
          code: 'import "extracted_rules.css.ts";\nexport { css, preset, fillBlue };',
          result: ["extracted_rules.css.ts", createLivePresetBuildSource()]
        });

        const harness = createBuildHarness({
          absWorkingDir: process.cwd(),
          esbuild: realEsbuild
        });

        const { loadResult } = await loadExtractedCssFromEntry(
          harness,
          join(process.cwd(), "packages/esbuild/src/registry-entry.ts")
        );

        const registryClassName = extractExportedStringValueFromBuildSource(
          loadResult.contents,
          "fillBlue"
        );

        expectSourceToContainPresetAtomClassName(
          loadResult.contents,
          registryClassName
        );
        expectSourceToContainPopulatedPresetAtom(loadResult.contents);
      } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
      }
    });

    it("real esbuild registry builds helper-wrapped, IIFE, nested, multiple instances, and imported helper fixtures", async () => {
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
          await buildRealEsbuildRegistryFixture(fixtureCase);

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
    });

    it("real esbuild function-valued config build skips registry artifacts", async () => {
      const fixtureCase = registryFixtureMatrixCases.find(
        (candidate) => candidate.caseId === "registry-function-config-invalid"
      );
      if (fixtureCase == null) {
        throw new Error("Missing registry function config fixture case");
      }

      const { js, registrySource } =
        await buildRealEsbuildRegistryFixture(fixtureCase);

      expect(registrySource).not.toBe("");
      expect(countV5PresetArtifacts(registrySource)).toBe(0);
      expect(countV5PresetArtifacts(js)).toBe(0);
      expect(registrySource).toContain("rebeccapurple");
    });

    it("serializes live preset output through the esbuild registry path", async () => {
      const livePresetFixtureSource = createLivePresetBuildSource();
      expectSourceToContainSnippet(
        livePresetFixtureSource,
        "export const { css, preset } = defineRules({ properties: { background: true } });"
      );
      expectSourceToContainSnippet(
        livePresetFixtureSource,
        'export const fillBlue = css({ background: "blue" });'
      );

      const realEsbuild = await import("esbuild");
      const entryPath = join(
        process.cwd(),
        "packages/esbuild/src/live-preset-entry.ts"
      );

      vi.spyOn(integrationHelpers, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { css, preset, fillBlue };',
        result: ["extracted_rules.css.ts", livePresetFixtureSource]
      });

      const registrySpy = vi.spyOn(
        integrationHelpers,
        "processDefineRulesPresetRegistryFile"
      );

      const harness = createBuildHarness({
        absWorkingDir: process.cwd(),
        esbuild: realEsbuild
      });

      const { loadResult, resolveResult } = await loadExtractedCssFromEntry(
        harness,
        entryPath
      );

      const fillBlueInit = extractExportedVariableInitFromBuildSource(
        loadResult.contents,
        "fillBlue"
      );

      const fillBlueClassName = extractExportedStringValueFromBuildSource(
        loadResult.contents,
        "fillBlue"
      );

      expect(registrySpy).toHaveBeenCalledWith({
        source: expect.any(String),
        filePath: resolveResult.path,
        outputCss: undefined,
        identOption: "debug"
      });
      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(loadResult.loader).toBe("js");
      expect(loadResult.resolveDir).toBe(dirname(resolveResult.path));
      expect(fillBlueInit).toMatch(/^(?:"[^"]+"|'[^']+')$/);

      const fillBlueClassNames = splitClassNames(fillBlueClassName);

      expect(fillBlueClassNames.filter(isSegmentMarker)).toHaveLength(1);
      expect(
        fillBlueClassNames.filter((token) => !isSegmentMarker(token))
      ).toHaveLength(1);
      expect(
        hasCssCallWithStringProperty(loadResult.contents, "background", "blue")
      ).toBe(false);

      expectSourceToContainPresetAtomClassName(
        loadResult.contents,
        fillBlueClassName
      );
    });

    it("defineRules exported css skips function-valued registry artifacts", async () => {
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

      const realEsbuild = await import("esbuild");
      const entryPath = join(
        process.cwd(),
        "packages/esbuild/src/function-valued-config-entry.ts"
      );

      vi.spyOn(integrationHelpers, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { raw };',
        result: ["extracted_rules.css.ts", functionValuedConfigBuildSource]
      });

      const registrySpy = vi.spyOn(
        integrationHelpers,
        "processDefineRulesPresetRegistryFile"
      );

      const harness = createBuildHarness({
        absWorkingDir: process.cwd(),
        esbuild: realEsbuild
      });

      const scriptLoadResult = (await harness.loadScript({
        path: entryPath
      })) as ScriptLoadResult;

      const resolveResult = (await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: entryPath,
        pluginData: scriptLoadResult.pluginData
      })) as ResolvedExtractedCssResult;

      const loadResult = (await harness.loadExtractedCss({
        path: resolveResult.path,
        pluginData: resolveResult.pluginData
      })) as ExtractedCssLoadResult;

      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(loadResult.loader).toBe("js");
      expect(countV5PresetArtifacts(loadResult.contents)).toBe(0);
      expect(loadResult.contents).toContain("blue");
    });

    it("routes extracted css through the shared preset registry wrapper without breaking the namespace flow", async () => {
      vi.spyOn(integrationHelpers, "babelTransformSource").mockResolvedValue({
        code: "export const app = {};",
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationHelpers, "compile").mockResolvedValue({
        source: "compiled source"
      } as Awaited<ReturnType<typeof compile>>);

      const registryStepSpy = vi.spyOn(
        integrationHelpers,
        "runDefineRulesPresetRegistryStep"
      );

      const presetBuildSource = await createV5PresetBuildSource();
      const registrySpy = vi
        .spyOn(integrationHelpers, "processDefineRulesPresetRegistryFile")
        .mockResolvedValue({
          ...createRegistryResult(presetBuildSource.source),
          ancestorStyleSpecifiers: ["@scope/ancestor/style.css"]
        });

      const harness = createBuildHarness();
      const { loadResult, resolveResult } =
        await loadExtractedCssFromEntry(harness);

      expect(resolveResult).toEqual({
        namespace: "extracted-css",
        path: "/workspace/src/extracted_rules.css.ts",
        pluginData: {
          path: "extracted_rules.css.ts",
          mainFilePath: "/workspace/src/app.ts"
        }
      });
      expect(registryStepSpy).toHaveBeenCalledWith(expect.any(Function));
      expect(registryStepSpy).toHaveBeenCalledTimes(1);
      expect(registrySpy).toHaveBeenCalledWith({
        source: "compiled source",
        filePath: "/workspace/src/extracted_rules.css.ts",
        outputCss: undefined,
        identOption: "debug"
      });
      expect(loadResult.loader).toBe("js");
      expect(loadResult.resolveDir).toBe("/workspace/src");
      expect(loadResult.contents).toContain(
        'import "@scope/ancestor/style.css";'
      );

      expectSourceToContainPresetAtomClassName(
        loadResult.contents,
        presetBuildSource.className
      );
    });

    it("passes short identifiers to the registry wrapper when esbuild minifies", async () => {
      vi.spyOn(integrationHelpers, "babelTransformSource").mockResolvedValue({
        code: "export const app = {};",
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationHelpers, "compile").mockResolvedValue({
        source: "compiled source"
      } as Awaited<ReturnType<typeof compile>>);

      const presetBuildSource = await createV5PresetBuildSource();
      const registrySpy = vi
        .spyOn(integrationHelpers, "processDefineRulesPresetRegistryFile")
        .mockResolvedValue(createRegistryResult(presetBuildSource.source));

      const harness = createBuildHarness({ minify: true });
      await loadExtractedCssFromEntry(harness);

      expect(registrySpy).toHaveBeenCalledWith({
        source: "compiled source",
        filePath: "/workspace/src/extracted_rules.css.ts",
        outputCss: undefined,
        identOption: "short"
      });
    });

    it("serializes supported fixture matrix cases through the esbuild extracted-css registry path", async () => {
      for (const fixtureCase of serializedRegistryFixtureCases) {
        if (fixtureCase.caseId === "registry-imported-helper-executed") {
          continue;
        }

        vi.restoreAllMocks();

        const fixtureSource = readFixtureSource(fixtureCase.fixturePath);

        for (const expectedSourceSnippet of fixtureCase.expectedSourceSnippets) {
          expectSourceToContainSnippet(fixtureSource, expectedSourceSnippet);
        }

        vi.spyOn(integrationHelpers, "babelTransformSource").mockResolvedValue({
          code: 'import "extracted_rules.css.ts";\nexport { css, preset, shared };',
          result: ["extracted_rules.css.ts", "resolver contents"]
        });

        const compileFixtureSource = integrationHelpers.compile;
        vi.spyOn(integrationHelpers, "compile").mockImplementation(
          (options: Parameters<typeof compile>[0]) =>
            compileFixtureSource({
              ...options,
              contents: fixtureSource
            })
        );

        const registrySpy = vi.spyOn(
          integrationHelpers,
          "processDefineRulesPresetRegistryFile"
        );

        const realEsbuild = await import("esbuild");
        const harness = createBuildHarness({
          absWorkingDir: process.cwd(),
          esbuild: realEsbuild
        });

        const { loadResult, resolveResult } = await loadExtractedCssFromEntry(
          harness,
          join(process.cwd(), "packages/esbuild/src/app.ts")
        );

        expect(registrySpy).toHaveBeenCalledWith({
          source: expect.any(String),
          filePath: resolveResult.path,
          outputCss: undefined,
          identOption: "debug"
        });
        expect(registrySpy).toHaveBeenCalledTimes(1);
        expect(loadResult.loader).toBe("js");
        expect(loadResult.resolveDir).toBe(dirname(resolveResult.path));

        expectSourceToContainV5PresetArtifact(loadResult.contents);
      }
    });

    it("skips function-valued config fixture registry artifacts through the esbuild registry path", async () => {
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

      vi.spyOn(integrationHelpers, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport { raw };',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });

      const compileFixtureSource = integrationHelpers.compile;
      vi.spyOn(integrationHelpers, "compile").mockImplementation(
        (options: Parameters<typeof compile>[0]) =>
          compileFixtureSource({
            ...options,
            filePath: fixtureCase.fixturePath,
            originalPath: fixtureCase.fixturePath,
            contents: fixtureSource
          })
      );

      const registrySpy = vi.spyOn(
        integrationHelpers,
        "processDefineRulesPresetRegistryFile"
      );

      const fixtureProjectRoot = resolvePath(
        dirname(fixtureCase.fixturePath),
        "../../../../../../.."
      );

      const fixtureAppPath = join(
        fixtureProjectRoot,
        "packages/esbuild/src/app.ts"
      );

      const realEsbuild = await import("esbuild");
      const harness = createBuildHarness({
        absWorkingDir: fixtureProjectRoot,
        esbuild: realEsbuild
      });

      const scriptLoadResult = (await harness.loadScript({
        path: fixtureAppPath
      })) as ScriptLoadResult;

      const resolveResult = (await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: fixtureAppPath,
        pluginData: scriptLoadResult.pluginData
      })) as ResolvedExtractedCssResult;

      const loadResult = (await harness.loadExtractedCss({
        path: resolveResult.path,
        pluginData: resolveResult.pluginData
      })) as ExtractedCssLoadResult;

      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(loadResult.loader).toBe("js");
      expect(countV5PresetArtifacts(loadResult.contents)).toBe(0);
      expect(loadResult.contents).toContain("rebeccapurple");
    }, 20000);

    it("keeps root css alias reuse paired with the explicit css asset import when no local extraction is needed", async () => {
      const consumerFixtureSource = readFixtureSource(
        consumerFixturePath
      ).replaceAll(
        "__DEFINE_RULES_PRESET_SPECIFIER__",
        "@mincho-js-proof/define-rules-preset"
      );

      vi.spyOn(integrationHelpers, "babelTransformSource").mockResolvedValue({
        code: consumerFixtureSource,
        result: ["extracted_rules.css.ts", ""]
      });

      const harness = createBuildHarness();
      const loadResult = (await harness.loadScript({
        path: "/workspace/src/app.ts"
      })) as {
        contents: string;
        loader: string;
        pluginData: {
          mainFilePath: string;
        };
      };

      const resolveResult = await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: "/workspace/src/app.ts",
        pluginData: loadResult.pluginData
      });

      expect(loadResult.contents).toBe(consumerFixtureSource);
      expect(loadResult.loader).toBe("ts");
      expect(resolveResult).toBeUndefined();
      expect(loadResult.contents).toContain(
        'import "@mincho-js-proof/define-rules-preset/shared-component.css";'
      );
      expect(loadResult.contents).toContain(
        '} from "@mincho-js-proof/define-rules-preset";'
      );
      expect(loadResult.contents).toContain("  css,");
      expect(loadResult.contents).toContain("export { importedShared };");
    });

    it("preserves the existing ReferenceError wrapping when extracted css evaluation fails", async () => {
      vi.spyOn(integrationHelpers, "babelTransformSource").mockResolvedValue({
        code: "export const app = {};",
        result: ["extracted_rules.css.ts", "resolver contents"]
      });
      vi.spyOn(integrationHelpers, "compile").mockResolvedValue({
        source: "compiled source"
      } as Awaited<ReturnType<typeof compile>>);

      const registrySpy = vi
        .spyOn(integrationHelpers, "processDefineRulesPresetRegistryFile")
        .mockRejectedValue(new ReferenceError("window is not defined"));

      const harness = createBuildHarness();
      const scriptLoadResult = (await harness.loadScript({
        path: "/workspace/src/app.ts"
      })) as ScriptLoadResult;

      const resolveResult = (await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: "/workspace/src/app.ts",
        pluginData: scriptLoadResult.pluginData
      })) as ResolvedExtractedCssResult;

      const loadResult = (await harness.loadExtractedCss({
        path: resolveResult.path,
        pluginData: resolveResult.pluginData
      })) as {
        errors: Array<{
          text: string;
          detail: string;
        }>;
      };

      expect(registrySpy).toHaveBeenCalledWith({
        source: "compiled source",
        filePath: "/workspace/src/extracted_rules.css.ts",
        outputCss: undefined,
        identOption: "debug"
      });
      expect(loadResult).toEqual({
        errors: [
          {
            text: "ReferenceError: window is not defined",
            detail:
              "This usually happens if you use a browser api at the top level of a file being imported."
          }
        ]
      });
    });

    it("cleans extracted-css resolvers on build end", async () => {
      vi.spyOn(integrationHelpers, "babelTransformSource").mockResolvedValue({
        code: 'import "extracted_rules.css.ts";\nexport const app = {};',
        result: ["extracted_rules.css.ts", "resolver contents"]
      });

      const harness = createBuildHarness();
      const scriptLoadResult = (await harness.loadScript({
        path: "/workspace/src/app.ts"
      })) as ScriptLoadResult;

      const resolveBeforeEnd = await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: "/workspace/src/app.ts",
        pluginData: scriptLoadResult.pluginData
      });

      harness.endBuild();

      const resolveAfterEnd = await harness.resolveExtractedCss({
        path: "extracted_rules.css.ts",
        importer: "/workspace/src/app.ts",
        pluginData: scriptLoadResult.pluginData
      });

      expect(resolveBeforeEnd).toEqual({
        namespace: "extracted-css",
        path: "/workspace/src/extracted_rules.css.ts",
        pluginData: {
          path: "extracted_rules.css.ts",
          mainFilePath: "/workspace/src/app.ts"
        }
      });
      expect(resolveAfterEnd).toBeUndefined();
    });

    it("defineRules preset registry steps are queued so concurrent esbuild loads cannot overlap shared registry sessions", async () => {
      const firstDeferred = createDeferred<string>();
      const secondDeferred = createDeferred<string>();
      const processOrder: string[] = [];

      vi.spyOn(integrationHelpers, "babelTransformSource")
        .mockResolvedValueOnce({
          code: "export const appA = {};",
          result: ["extracted_a.css.ts", "resolver contents a"]
        })
        .mockResolvedValueOnce({
          code: "export const appB = {};",
          result: ["extracted_b.css.ts", "resolver contents b"]
        });
      vi.spyOn(integrationHelpers, "compile").mockImplementation(
        async (options: Parameters<typeof compile>[0]) =>
          ({
            source: `compiled source:${options.filePath}`
          }) as Awaited<ReturnType<typeof compile>>
      );

      const registrySpy = vi
        .spyOn(integrationHelpers, "processDefineRulesPresetRegistryFile")
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

      const harness = createBuildHarness();
      const scriptLoadResultA = (await harness.loadScript({
        path: "/workspace/src/app-a.ts"
      })) as ScriptLoadResult;

      const scriptLoadResultB = (await harness.loadScript({
        path: "/workspace/src/app-b.ts"
      })) as ScriptLoadResult;

      const resolveResultA = (await harness.resolveExtractedCss({
        path: "extracted_a.css.ts",
        importer: "/workspace/src/app-a.ts",
        pluginData: scriptLoadResultA.pluginData
      })) as ResolvedExtractedCssResult;

      const resolveResultB = (await harness.resolveExtractedCss({
        path: "extracted_b.css.ts",
        importer: "/workspace/src/app-b.ts",
        pluginData: scriptLoadResultB.pluginData
      })) as ResolvedExtractedCssResult;

      const firstLoadPromise = harness.loadExtractedCss({
        path: resolveResultA.path,
        pluginData: resolveResultA.pluginData
      }) as Promise<ExtractedCssLoadResult>;

      const secondLoadPromise = harness.loadExtractedCss({
        path: resolveResultB.path,
        pluginData: resolveResultB.pluginData
      }) as Promise<ExtractedCssLoadResult>;

      await vi.waitFor(() => {
        expect(processOrder).toEqual([
          "start:/workspace/src/extracted_a.css.ts"
        ]);
      });

      const firstPresetBuildSource = await createV5PresetBuildSource(
        "src/extracted_a.css.ts"
      );

      firstDeferred.resolve(firstPresetBuildSource.source);

      const firstLoadResult = await firstLoadPromise;

      await vi.waitFor(() => {
        expect(processOrder).toEqual([
          "start:/workspace/src/extracted_a.css.ts",
          "end:/workspace/src/extracted_a.css.ts",
          "start:/workspace/src/extracted_b.css.ts"
        ]);
      });

      const secondPresetBuildSource = await createV5PresetBuildSource(
        "src/extracted_b.css.ts"
      );

      secondDeferred.resolve(secondPresetBuildSource.source);

      const secondLoadResult = await secondLoadPromise;

      expect(processOrder).toEqual([
        "start:/workspace/src/extracted_a.css.ts",
        "end:/workspace/src/extracted_a.css.ts",
        "start:/workspace/src/extracted_b.css.ts",
        "end:/workspace/src/extracted_b.css.ts"
      ]);
      expect(registrySpy).toHaveBeenNthCalledWith(1, {
        source: "compiled source:/workspace/src/extracted_a.css.ts",
        filePath: "/workspace/src/extracted_a.css.ts",
        outputCss: undefined,
        identOption: "debug"
      });
      expect(registrySpy).toHaveBeenNthCalledWith(2, {
        source: "compiled source:/workspace/src/extracted_b.css.ts",
        filePath: "/workspace/src/extracted_b.css.ts",
        outputCss: undefined,
        identOption: "debug"
      });

      expectSourceToContainPresetAtomClassName(
        firstLoadResult.contents,
        firstPresetBuildSource.className
      );
      expectSourceToContainPresetAtomClassName(
        secondLoadResult.contents,
        secondPresetBuildSource.className
      );

      expect(firstPresetBuildSource.marker).not.toBe(
        secondPresetBuildSource.marker
      );
      expect(firstLoadResult.contents).not.toContain(
        secondPresetBuildSource.marker
      );
      expect(secondLoadResult.contents).not.toContain(
        firstPresetBuildSource.marker
      );
    });

    it("counts V5 preset artifacts when schema and version property order differs", () => {
      expect(
        countV5PresetArtifacts(
          `{ version: 5, schema: "${DEFINE_RULES_PRESET_SCHEMA}" } { schema: "${DEFINE_RULES_PRESET_SCHEMA}", version: 5 }`
        )
      ).toBe(2);
    });
  });
}
