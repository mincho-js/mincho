import {
  type InternalStaticCssEvalLoadedSource as StaticCssEvalLoadedSource,
  type InternalStaticCssEvalSourceKind as StaticCssEvalSourceKind,
  type InternalStaticCssEvalSourceProvider as StaticCssEvalSourceProvider,
  type InternalStaticCssEvalSourceResolution as StaticCssEvalSourceResolution,
  internalCreateStaticCssEvalSourceIdentity as createStaticCssEvalSourceIdentity,
  internalStaticCssEvalExternalResolutionPrefix as externalStaticCssEvalResolutionPrefix,
  internalGetExistingStaticCssEvalRealpath as getExistingRealpath,
  internalGetExistingStaticCssEvalStat as getExistingStat,
  internalGetStaticCssEvalSourceOrigin as getStaticCssEvalSourceOrigin,
  internalHasStaticCssEvalNodeModulesSegment as hasNodeModulesSegment,
  internalIsMissingStaticCssEvalFileSystemEntryError as isMissingFileSystemEntryError,
  internalIsStaticCssEvalPathInsideRoot as isPathInsideRoot,
  internalIsProjectLocalStaticCssEvalImportPath as isProjectLocalImportPath,
  internalIsStaticCssEvalStaticDataFile as isStaticCssEvalStaticDataFile,
  internalIsVirtualStaticCssEvalId as isVirtualStaticCssEvalId,
  internalNormalizeStaticCssEvalFileId as normalizeStaticCssEvalFileId,
  internalPrepareStaticCssEvalStaticDataSource as prepareStaticCssEvalStaticDataSource
} from "@mincho-js/integration";
import { type PluginBuild, type ResolveResult } from "esbuild";
import * as fs from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { EsbuildAssets } from "./assets.js";
import { getBuildTransaction } from "./buildInputSnapshot.js";

export type ScriptLoader = "js" | "jsx" | "ts" | "tsx";

export type StaticCssEvalResolutionCache = Map<
  string,
  StaticCssEvalSourceResolution | null
>;

export type StaticCssEvalLoadedSourceCache = Map<
  string,
  StaticCssEvalLoadedSource | null
>;

const unsupportedStaticCssEvalResolutionPrefix =
  "virtual:mincho-static-css-eval-unsupported:";

const esbuildStaticCssEvalModuleIdPrefix = "esbuild:";

export function createEsbuildStaticCssEvalSourceProvider(options: {
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

      const transaction = getBuildTransaction(options.build.initialOptions);
      const loadedSource = await loadEsbuildStaticCssEvalSource({
        id,
        ownerId,
        ownerSource: options.ownerSource,
        assets: options.assets,
        readFile: transaction?.snapshot.readFile.bind(transaction.snapshot),
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

export function stripStaticCssEvalQuery(sourceId: string): string {
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

export function getWatchableStaticCssEvalDependencyFiles(
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

export function resolveStaticCssEvalImportFromFileSystem(
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

export function createStaticCssEvalResolveResult(path: string): ResolveResult {
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
