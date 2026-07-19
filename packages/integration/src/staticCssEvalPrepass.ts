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

interface StaticCssEvalPrepassContext {
  sourceProvider: StaticCssEvalSourceProvider;
  state: StaticCssEvalPrepassState;
}

type StaticCssEvalPrepassImportBinding =
  ImportedStaticCssEvalModuleRecord["imports"] extends ReadonlyMap<
    string,
    infer ImportBinding
  >
    ? ImportBinding
    : never;
type StaticCssEvalPrepassExportName = string | null;
type StaticCssEvalPrepassExportEntry =
  ImportedStaticCssEvalModuleRecord["exports"] extends ReadonlyMap<
    StaticCssEvalPrepassExportName,
    infer ExportEntry
  >
    ? ExportEntry
    : never;

interface StaticCssEvalPrepassExportRequest {
  exportName: StaticCssEvalPrepassExportName;
  memberPath: readonly string[];
  wholeNamespace: boolean;
}

interface StaticCssEvalPrepassExportWalk {
  exportName: string;
  memberPath: readonly string[];
  seen: Set<string>;
}

interface StaticCssEvalPrepassWholeNamespaceWalk {
  includeDefaultExport: boolean;
  seen: Set<string>;
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
  const prepassContext: StaticCssEvalPrepassContext = {
    sourceProvider,
    state: prepassState
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
      prepassContext
    );

    if (!moduleRecord) {
      continue;
    }

    const request = createStaticCssEvalPrepassExportRequest(
      importBinding,
      candidate.memberPath ?? []
    );

    if (request) {
      await loadStaticCssEvalPrepassGraphDependencies(
        moduleRecord,
        request,
        prepassContext
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
  context: StaticCssEvalPrepassContext
): Promise<ImportedStaticCssEvalModuleRecord | undefined> {
  if (!isProjectLocalStaticCssEvalImportSpecifier(importPath)) {
    return undefined;
  }

  const { sourceProvider, state } = context;
  const resolvedImportKey = `${importerId}\0${importPath}`;
  let resolution = state.resolvedImports.get(resolvedImportKey);

  if (!state.resolvedImports.has(resolvedImportKey)) {
    const sourceResolution = await sourceProvider.resolve(
      importerId,
      importPath
    );
    resolution = sourceResolution
      ? normalizeStaticCssEvalSourceResolution(sourceResolution)
      : null;
    state.resolvedImports.set(resolvedImportKey, resolution ?? null);

    if (resolution) {
      state.importResolutions.push({
        importerId,
        importPath,
        resolvedId: resolution.resolvedFile
      });
      state.resolvedDependencies.push(
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
    state.ownerDependencies,
    state.dependencyToOwners,
    state.loadedModules[0]?.id ?? importerId,
    resolution.resolvedFile
  );

  const cachedRecord = state.resolvedModuleCache.get(resolution.resolvedFile);

  if (cachedRecord) {
    return cachedRecord;
  }

  if (state.loadedDependencyIds.has(resolution.resolvedFile)) {
    return undefined;
  }

  state.loadedDependencyIds.add(resolution.resolvedFile);
  const loadedSource = await sourceProvider.load(resolution.normalizedPathKey);

  if (!loadedSource) {
    return undefined;
  }

  markResolvedDependencyLoaded(
    state.resolvedDependencies,
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
    state.resolvedModuleCache.set(moduleRecord.id, moduleRecord);
    state.loadedModules.push(loadedModule);

    return moduleRecord;
  } catch {
    return undefined;
  }
}

function createStaticCssEvalPrepassExportRequest(
  importBinding: StaticCssEvalPrepassImportBinding,
  memberPath: readonly string[]
): StaticCssEvalPrepassExportRequest | null {
  switch (importBinding.kind) {
    case "default":
    case "named":
      return {
        exportName: importBinding.importedName,
        memberPath: [...memberPath],
        wholeNamespace: false
      };
    case "namespace": {
      const [exportName, ...remainingMemberPath] = memberPath;

      if (exportName === undefined) {
        return {
          exportName: null,
          memberPath: [],
          wholeNamespace: true
        };
      }

      return {
        exportName,
        memberPath: remainingMemberPath,
        wholeNamespace: false
      };
    }
    default:
      return assertNever(importBinding);
  }
}

async function loadStaticCssEvalPrepassGraphDependencies(
  moduleRecord: ImportedStaticCssEvalModuleRecord,
  request: StaticCssEvalPrepassExportRequest,
  context: StaticCssEvalPrepassContext
): Promise<void> {
  if (request.wholeNamespace) {
    await loadWholeNamespacePrepassDependencies(
      moduleRecord,
      { includeDefaultExport: true, seen: new Set() },
      context
    );
    return;
  }

  if (request.exportName === null) {
    return;
  }

  await loadExportNamePrepassDependencies(
    moduleRecord,
    {
      exportName: request.exportName,
      memberPath: request.memberPath,
      seen: new Set()
    },
    context
  );
}

async function loadExportNamePrepassDependencies(
  moduleRecord: ImportedStaticCssEvalModuleRecord,
  walk: StaticCssEvalPrepassExportWalk,
  context: StaticCssEvalPrepassContext
): Promise<void> {
  const walkKey = createStaticCssEvalPrepassWalkKey(
    moduleRecord.id,
    walk.exportName,
    walk.memberPath
  );

  if (walk.seen.has(walkKey)) {
    return;
  }

  walk.seen.add(walkKey);

  const exportEntry = moduleRecord.exports.get(walk.exportName);

  if (exportEntry) {
    await loadExplicitExportEntryPrepassDependencies(
      moduleRecord,
      exportEntry,
      walk,
      context
    );
    return;
  }

  if (walk.exportName === "default") {
    return;
  }

  for (const starEntry of moduleRecord.parsedModule.exportStarReexports) {
    const dependencyRecord = await loadStaticCssEvalPrepassDependency(
      moduleRecord.id,
      starEntry.source,
      context
    );

    if (!dependencyRecord) {
      continue;
    }

    await loadExportNamePrepassDependencies(dependencyRecord, walk, context);
  }
}

async function loadWholeNamespacePrepassDependencies(
  moduleRecord: ImportedStaticCssEvalModuleRecord,
  walk: StaticCssEvalPrepassWholeNamespaceWalk,
  context: StaticCssEvalPrepassContext
): Promise<void> {
  const walkKey = createStaticCssEvalPrepassWalkKey(
    moduleRecord.id,
    walk.includeDefaultExport ? "<namespace-with-default>" : "<namespace>",
    []
  );

  if (walk.seen.has(walkKey)) {
    return;
  }

  walk.seen.add(walkKey);

  for (const [exportName, exportEntry] of moduleRecord.exports) {
    if (exportName === null) {
      continue;
    }

    if (!walk.includeDefaultExport && exportName === "default") {
      continue;
    }

    await loadExplicitExportEntryPrepassDependencies(
      moduleRecord,
      exportEntry,
      { exportName, memberPath: [], seen: walk.seen },
      context
    );
  }

  for (const starEntry of moduleRecord.parsedModule.exportStarReexports) {
    const dependencyRecord = await loadStaticCssEvalPrepassDependency(
      moduleRecord.id,
      starEntry.source,
      context
    );

    if (!dependencyRecord) {
      continue;
    }

    await loadWholeNamespacePrepassDependencies(
      dependencyRecord,
      { includeDefaultExport: false, seen: walk.seen },
      context
    );
  }
}

async function loadExplicitExportEntryPrepassDependencies(
  moduleRecord: ImportedStaticCssEvalModuleRecord,
  exportEntry: StaticCssEvalPrepassExportEntry,
  walk: StaticCssEvalPrepassExportWalk,
  context: StaticCssEvalPrepassContext
): Promise<void> {
  if (exportEntry.kind !== "reexport") {
    return;
  }

  const dependencyRecord = await loadStaticCssEvalPrepassDependency(
    moduleRecord.id,
    exportEntry.source,
    context
  );

  if (!dependencyRecord) {
    return;
  }

  await loadExportNamePrepassDependencies(
    dependencyRecord,
    {
      exportName: exportEntry.importedName,
      memberPath: walk.memberPath,
      seen: walk.seen
    },
    context
  );
}

function createStaticCssEvalPrepassWalkKey(
  file: string,
  exportName: string,
  memberPath: readonly string[]
): string {
  return `${file}\0${exportName}\0${memberPath.join(".")}`;
}

function isProjectLocalStaticCssEvalImportSpecifier(
  importPath: string
): boolean {
  return importPath.startsWith(".") || importPath.startsWith("/");
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected static css eval prepass value: ${value}`);
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
