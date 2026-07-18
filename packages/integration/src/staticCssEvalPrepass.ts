import {
  internalCollectJsxCssPropStaticCssEvalCandidates as collectJsxCssPropStaticCssEvalCandidates,
  internalCreateImportedStaticCssEvalModuleRecord as createImportedStaticCssEvalModuleRecord,
  internalCreateImportedStaticCssEvalProvider as createImportedStaticCssEvalProvider,
  type InternalImportedStaticCssEvalImportResolution as ImportedStaticCssEvalImportResolution,
  type InternalImportedStaticCssEvalLoadedModule as ImportedStaticCssEvalLoadedModule,
  type InternalImportedStaticCssEvalModuleRecord as ImportedStaticCssEvalModuleRecord,
  type PluginOptions
} from "@mincho-js/babel";
import type {
  StaticCssEvalLoadedSource,
  StaticCssEvalPrepassResult,
  StaticCssEvalResolvedDependency,
  StaticCssEvalResolverKind,
  StaticCssEvalSourceIdentity,
  StaticCssEvalSourceProvider,
  StaticCssEvalSourceResolution
} from "./babel.js";

type StaticCssEvalProvider = NonNullable<
  PluginOptions["staticCssEvalProvider"]
>;

interface NormalizedStaticCssEvalSourceResolution {
  resolvedFile: string;
  canonicalModuleId: string;
  normalizedPathKey: string;
  resolverKind: StaticCssEvalResolverKind;
  realpath?: string;
  sourceIdentity?: StaticCssEvalSourceIdentity;
}

interface PreparedStaticCssEvalPrepass {
  provider: StaticCssEvalProvider;
  result: StaticCssEvalPrepassResult;
}

interface StaticCssEvalPrepassState {
  loadedModules: ImportedStaticCssEvalLoadedModule[];
  importResolutions: ImportedStaticCssEvalImportResolution[];
  resolvedModuleCache: Map<string, ImportedStaticCssEvalModuleRecord>;
  ownerDependencies: string[];
  dependencyToOwners: Map<string, string[]>;
  resolvedDependencies: StaticCssEvalResolvedDependency[];
  resolvedImports: Map<string, NormalizedStaticCssEvalSourceResolution | null>;
  loadedDependencyIds: Set<string>;
}

export async function createStaticCssEvalPrepass(
  ownerId: string,
  sourceProvider: StaticCssEvalSourceProvider
): Promise<PreparedStaticCssEvalPrepass> {
  const ownerSource = await sourceProvider.load(ownerId);

  if (!ownerSource) {
    throw new Error(`Failed to load static css eval owner source ${ownerId}`);
  }

  const ownerModule = createLoadedModule(ownerId, ownerSource);
  const ownerRecord = createImportedStaticCssEvalModuleRecord(ownerModule);
  const candidates = collectJsxCssPropStaticCssEvalCandidates(
    ownerRecord.programPath,
    { importerId: ownerId }
  );
  const prepassState: StaticCssEvalPrepassState = {
    loadedModules: [ownerModule],
    importResolutions: [],
    resolvedModuleCache: new Map([[ownerRecord.id, ownerRecord]]),
    ownerDependencies: [],
    dependencyToOwners: new Map(),
    resolvedDependencies: [],
    resolvedImports: new Map(),
    loadedDependencyIds: new Set([ownerId])
  };

  for (const candidate of candidates) {
    const importBinding = candidate.bindingName
      ? ownerRecord.imports.get(candidate.bindingName)
      : undefined;

    if (!importBinding) {
      continue;
    }

    const moduleRecord = await loadStaticCssEvalPrepassDependency(
      ownerId,
      importBinding.importPath,
      sourceProvider,
      prepassState
    );

    if (!moduleRecord) {
      continue;
    }

    if (importBinding.kind !== "namespace") {
      await loadDirectReexportDependencies(
        moduleRecord,
        importBinding.importedName,
        sourceProvider,
        prepassState
      );
    }
  }

  const ownerToDependencies = new Map<string, string[]>([
    [ownerId, prepassState.ownerDependencies]
  ]);
  const provider = createImportedStaticCssEvalProvider({
    modules: prepassState.loadedModules,
    importResolutions: prepassState.importResolutions,
    moduleRecords: [...prepassState.resolvedModuleCache.values()]
  });

  return {
    provider,
    result: {
      dependencyFiles: [...prepassState.ownerDependencies],
      ownerToDependencies,
      dependencyToOwners: prepassState.dependencyToOwners,
      resolvedModuleCache: prepassState.resolvedModuleCache,
      resolvedDependencies: prepassState.resolvedDependencies
    }
  };
}

async function loadStaticCssEvalPrepassDependency(
  importerId: string,
  importPath: string,
  sourceProvider: StaticCssEvalSourceProvider,
  prepassState: StaticCssEvalPrepassState
): Promise<ImportedStaticCssEvalModuleRecord | undefined> {
  const resolvedImportKey = `${importerId}\0${importPath}`;
  let resolution = prepassState.resolvedImports.get(resolvedImportKey);

  if (!prepassState.resolvedImports.has(resolvedImportKey)) {
    const sourceResolution = await sourceProvider.resolve(
      importerId,
      importPath
    );
    resolution = sourceResolution
      ? normalizeStaticCssEvalSourceResolution(sourceResolution)
      : null;
    prepassState.resolvedImports.set(resolvedImportKey, resolution ?? null);

    if (resolution) {
      prepassState.importResolutions.push({
        importerId,
        importPath,
        resolvedId: resolution.resolvedFile
      });
      prepassState.resolvedDependencies.push(
        createStaticCssEvalResolvedDependency(
          importerId,
          importPath,
          resolution,
          false
        )
      );
    }
  }

  if (!resolution) {
    return undefined;
  }

  addOwnerDependency(
    prepassState.ownerDependencies,
    prepassState.dependencyToOwners,
    prepassState.loadedModules[0]?.id ?? importerId,
    resolution.resolvedFile
  );

  const cachedRecord = prepassState.resolvedModuleCache.get(
    resolution.resolvedFile
  );

  if (cachedRecord) {
    return cachedRecord;
  }

  if (prepassState.loadedDependencyIds.has(resolution.resolvedFile)) {
    return undefined;
  }

  prepassState.loadedDependencyIds.add(resolution.resolvedFile);
  const loadedSource = await sourceProvider.load(resolution.normalizedPathKey);

  if (!loadedSource) {
    return undefined;
  }

  markResolvedDependencyLoaded(
    prepassState.resolvedDependencies,
    importerId,
    importPath,
    resolution,
    loadedSource
  );

  const loadedModule = createLoadedModule(
    resolution.resolvedFile,
    loadedSource,
    resolution
  );

  try {
    const moduleRecord = createImportedStaticCssEvalModuleRecord(loadedModule);
    prepassState.resolvedModuleCache.set(moduleRecord.id, moduleRecord);
    prepassState.loadedModules.push(loadedModule);

    return moduleRecord;
  } catch {
    return undefined;
  }
}

async function loadDirectReexportDependencies(
  moduleRecord: ImportedStaticCssEvalModuleRecord,
  exportName: string,
  sourceProvider: StaticCssEvalSourceProvider,
  prepassState: StaticCssEvalPrepassState
): Promise<void> {
  let currentRecord: ImportedStaticCssEvalModuleRecord | undefined =
    moduleRecord;
  let currentExportName = exportName;
  const seenReexports = new Set<string>();

  while (currentRecord) {
    const exportEntry = currentRecord.exports.get(currentExportName);

    if (!exportEntry || exportEntry.kind !== "reexport") {
      return;
    }

    const reexportKey = `${currentRecord.id}\0${currentExportName}`;

    if (seenReexports.has(reexportKey)) {
      return;
    }

    seenReexports.add(reexportKey);

    currentRecord = await loadStaticCssEvalPrepassDependency(
      currentRecord.id,
      exportEntry.source,
      sourceProvider,
      prepassState
    );
    currentExportName = exportEntry.importedName;
  }
}

function createLoadedModule(
  id: string,
  loadedSource: StaticCssEvalLoadedSource,
  resolution?: NormalizedStaticCssEvalSourceResolution
): ImportedStaticCssEvalLoadedModule {
  const sourceText = getLoadedSourceText(id, loadedSource);
  const sourceIdentity = createLoadedSourceIdentity(
    sourceText,
    loadedSource,
    resolution
  );

  return {
    id,
    source: sourceText,
    realpath: loadedSource.realpath ?? resolution?.realpath,
    sourceHash: sourceIdentity.sourceHash,
    version: sourceIdentity.version
  };
}

function getLoadedSourceText(
  id: string,
  loadedSource: StaticCssEvalLoadedSource
): string {
  const sourceText = loadedSource.sourceText ?? loadedSource.source;

  if (sourceText === undefined) {
    throw new Error(
      `Static css eval source provider did not return source for ${id}`
    );
  }

  return sourceText;
}

function normalizeStaticCssEvalSourceResolution(
  resolution: StaticCssEvalSourceResolution
): NormalizedStaticCssEvalSourceResolution {
  const resolvedFile = resolution.resolvedFile ?? resolution.id;

  if (!resolvedFile) {
    throw new Error(
      "Static css eval source resolution requires resolvedFile or id"
    );
  }

  const canonicalModuleId =
    resolution.canonicalModuleId ?? resolution.id ?? resolvedFile;
  const normalizedPathKey =
    resolution.normalizedPathKey ?? canonicalModuleId ?? resolvedFile;

  return {
    resolvedFile,
    canonicalModuleId,
    normalizedPathKey,
    resolverKind: resolution.resolverKind ?? "source-provider",
    realpath: resolution.realpath,
    sourceIdentity: normalizeStaticCssEvalSourceIdentity(
      resolution.sourceIdentity,
      resolution.sourceHash,
      resolution.version
    )
  };
}

function normalizeStaticCssEvalSourceIdentity(
  sourceIdentity: StaticCssEvalSourceIdentity | undefined,
  sourceHash: string | undefined,
  version: string | number | undefined
): StaticCssEvalSourceIdentity | undefined {
  const normalizedSourceHash = sourceIdentity?.sourceHash ?? sourceHash;
  const normalizedVersion = sourceIdentity?.version ?? version;

  if (normalizedSourceHash === undefined && normalizedVersion === undefined) {
    return undefined;
  }

  return {
    ...(normalizedSourceHash !== undefined
      ? { sourceHash: normalizedSourceHash }
      : {}),
    ...(normalizedVersion !== undefined ? { version: normalizedVersion } : {})
  };
}

function createLoadedSourceIdentity(
  sourceText: string,
  loadedSource: StaticCssEvalLoadedSource,
  resolution?: NormalizedStaticCssEvalSourceResolution
): Required<Pick<StaticCssEvalSourceIdentity, "sourceHash">> &
  Pick<StaticCssEvalSourceIdentity, "version"> {
  const sourceIdentity = normalizeStaticCssEvalSourceIdentity(
    loadedSource.sourceIdentity,
    loadedSource.sourceHash,
    loadedSource.version
  );
  const sourceHash =
    sourceIdentity?.sourceHash ??
    resolution?.sourceIdentity?.sourceHash ??
    createStaticCssEvalSourceTextHash(sourceText);
  const version =
    sourceIdentity?.version ?? resolution?.sourceIdentity?.version;

  return {
    sourceHash,
    ...(version !== undefined ? { version } : {})
  };
}

function createStaticCssEvalResolvedDependency(
  importerId: string,
  specifier: string,
  resolution: NormalizedStaticCssEvalSourceResolution,
  loaded: boolean,
  loadedSource?: StaticCssEvalLoadedSource
): StaticCssEvalResolvedDependency {
  const sourceText = loadedSource
    ? getLoadedSourceText(resolution.normalizedPathKey, loadedSource)
    : undefined;
  const sourceIdentity = loadedSource
    ? createLoadedSourceIdentity(sourceText ?? "", loadedSource, resolution)
    : resolution.sourceIdentity;

  return {
    importerId,
    specifier,
    resolvedFile: resolution.resolvedFile,
    canonicalModuleId: resolution.canonicalModuleId,
    normalizedPathKey: resolution.normalizedPathKey,
    resolverKind: resolution.resolverKind,
    loaded,
    ...(sourceIdentity ? { sourceIdentity } : {})
  };
}

function markResolvedDependencyLoaded(
  resolvedDependencies: StaticCssEvalResolvedDependency[],
  importerId: string,
  specifier: string,
  resolution: NormalizedStaticCssEvalSourceResolution,
  loadedSource: StaticCssEvalLoadedSource
): void {
  const resolvedDependencyIndex = resolvedDependencies.findIndex(
    (dependency) =>
      dependency.importerId === importerId &&
      dependency.specifier === specifier &&
      dependency.resolvedFile === resolution.resolvedFile
  );
  const loadedDependency = createStaticCssEvalResolvedDependency(
    importerId,
    specifier,
    resolution,
    true,
    loadedSource
  );

  if (resolvedDependencyIndex === -1) {
    resolvedDependencies.push(loadedDependency);
    return;
  }

  resolvedDependencies[resolvedDependencyIndex] = loadedDependency;
}

function createStaticCssEvalSourceTextHash(sourceText: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < sourceText.length; index += 1) {
    hash ^= sourceText.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}:${sourceText.length}`;
}

function addOwnerDependency(
  ownerDependencies: string[],
  dependencyToOwners: Map<string, string[]>,
  ownerId: string,
  dependencyId: string
): void {
  if (!ownerDependencies.includes(dependencyId)) {
    ownerDependencies.push(dependencyId);
  }

  const owners = dependencyToOwners.get(dependencyId);

  if (!owners) {
    dependencyToOwners.set(dependencyId, [ownerId]);
    return;
  }

  if (!owners.includes(ownerId)) {
    owners.push(ownerId);
  }
}
