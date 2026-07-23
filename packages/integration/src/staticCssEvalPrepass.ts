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
  StaticCssEvalSourceKind,
  StaticCssEvalSourceOrigin,
  StaticCssEvalSourceProvider,
  StaticCssEvalSourceResolution,
  StaticCssEvalSourceUnsupportedReason
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
  sourceKind: StaticCssEvalSourceKind;
  sourceOrigin: StaticCssEvalSourceOrigin;
  unsupportedReason?: StaticCssEvalSourceUnsupportedReason;
  watchFiles?: readonly string[];
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
type StaticCssEvalPrepassCjsImportBinding =
  ImportedStaticCssEvalModuleRecord["cjsImports"] extends ReadonlyMap<
    string,
    infer CjsImportBinding
  >
    ? CjsImportBinding
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

interface StaticCssEvalPrepassDependencyRequest {
  importPath: string;
  exportRequest: StaticCssEvalPrepassExportRequest | null;
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

interface CreateLoadedModuleOptions {
  resolution?: NormalizedStaticCssEvalSourceResolution;
  sourceText?: string;
}

type PreparedStaticCssEvalLoadedSource =
  | {
      kind: "source";
      sourceText: string;
      loadedSource: StaticCssEvalLoadedSource;
    }
  | {
      kind: "unsupported";
      loadedSource: StaticCssEvalLoadedSource;
    };

const STATIC_CSS_EVAL_PREPASS_MAX_SOURCE_BYTES = 1024 * 1024;

const STATIC_CSS_EVAL_PREPASS_RESERVED_EXPORT_NAMES = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield"
]);

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
    const dependencyRequest = createStaticCssEvalPrepassDependencyRequest(
      ownerRecord,
      candidate.bindingName,
      candidate.memberPath ?? []
    );

    if (!dependencyRequest) {
      continue;
    }

    const moduleRecord = await loadStaticCssEvalPrepassDependency(
      ownerId,
      dependencyRequest.importPath,
      prepassContext
    );

    if (!moduleRecord) {
      continue;
    }

    if (dependencyRequest.exportRequest) {
      await loadStaticCssEvalPrepassGraphDependencies(
        moduleRecord,
        dependencyRequest.exportRequest,
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
      state.importResolutions.push(
        createStaticCssEvalPrepassImportResolution(
          importerId,
          importPath,
          resolution
        )
      );
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

  const preparedSource = prepareStaticCssEvalLoadedSource(
    resolution.resolvedFile,
    loadedSource,
    resolution
  );

  if (preparedSource.kind === "unsupported") {
    markPrepassImportResolutionLoaded(
      state.importResolutions,
      importerId,
      importPath,
      resolution,
      preparedSource.loadedSource
    );
    markResolvedDependencyLoaded(
      state.resolvedDependencies,
      importerId,
      importPath,
      resolution,
      preparedSource.loadedSource
    );
    return undefined;
  }

  const loadedModule = createLoadedModule(
    resolution.resolvedFile,
    preparedSource.loadedSource,
    { resolution, sourceText: preparedSource.sourceText }
  );

  let moduleRecord: ImportedStaticCssEvalModuleRecord;

  try {
    moduleRecord = createImportedStaticCssEvalModuleRecord(loadedModule);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    const unsupportedSource = createUnsupportedStaticCssEvalLoadedSource(
      loadedSource,
      "unsupported-source-shape"
    );
    markResolvedDependencyLoaded(
      state.resolvedDependencies,
      importerId,
      importPath,
      resolution,
      unsupportedSource
    );
    markPrepassImportResolutionLoaded(
      state.importResolutions,
      importerId,
      importPath,
      resolution,
      unsupportedSource
    );
    return undefined;
  }

  markPrepassImportResolutionLoaded(
    state.importResolutions,
    importerId,
    importPath,
    resolution,
    preparedSource.loadedSource
  );
  markResolvedDependencyLoaded(
    state.resolvedDependencies,
    importerId,
    importPath,
    resolution,
    preparedSource.loadedSource
  );
  state.resolvedModuleCache.set(moduleRecord.id, moduleRecord);
  state.loadedModules.push(loadedModule);

  return moduleRecord;
}

function createStaticCssEvalPrepassDependencyRequest(
  ownerRecord: ImportedStaticCssEvalModuleRecord,
  bindingName: string | null | undefined,
  memberPath: readonly string[]
): StaticCssEvalPrepassDependencyRequest | null {
  if (!bindingName) {
    return null;
  }

  const importBinding = ownerRecord.imports.get(bindingName);

  if (importBinding) {
    return {
      importPath: importBinding.importPath,
      exportRequest: createStaticCssEvalPrepassExportRequest(
        importBinding,
        memberPath
      )
    };
  }

  const cjsBinding = ownerRecord.cjsImports.get(bindingName);

  return cjsBinding
    ? {
        importPath: cjsBinding.importPath,
        exportRequest: createStaticCssEvalPrepassCjsExportRequest(
          cjsBinding,
          memberPath
        )
      }
    : null;
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

function createStaticCssEvalPrepassCjsExportRequest(
  cjsBinding: StaticCssEvalPrepassCjsImportBinding,
  memberPath: readonly string[]
): StaticCssEvalPrepassExportRequest {
  const [exportName, ...remainingMemberPath] = [
    ...cjsBinding.propertyPath,
    ...memberPath
  ];

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

function assertNever(value: never): never {
  throw new TypeError(`Unexpected static css eval prepass value: ${value}`);
}

function createLoadedModule(
  id: string,
  loadedSource: StaticCssEvalLoadedSource,
  options: CreateLoadedModuleOptions = {}
): ImportedStaticCssEvalLoadedModule {
  const sourceText =
    options.sourceText ?? getLoadedSourceText(id, loadedSource);
  const sourceIdentity = createLoadedSourceIdentity(
    sourceText,
    loadedSource,
    options.resolution
  );

  return {
    id,
    source: sourceText,
    realpath: loadedSource.realpath ?? options.resolution?.realpath,
    sourceHash: sourceIdentity.sourceHash,
    version: sourceIdentity.version,
    ...createLoadedModuleSourceMetadata(loadedSource, options.resolution)
  };
}

function createStaticCssEvalPrepassImportResolution(
  importerId: string,
  importPath: string,
  resolution: NormalizedStaticCssEvalSourceResolution,
  loadedSource?: StaticCssEvalLoadedSource
): ImportedStaticCssEvalImportResolution {
  const canonicalModuleId =
    loadedSource?.canonicalModuleId ?? resolution.canonicalModuleId;
  const normalizedPathKey =
    loadedSource?.normalizedPathKey ?? resolution.normalizedPathKey;
  const sourceKind = loadedSource?.sourceKind ?? resolution.sourceKind;
  const sourceOrigin =
    loadedSource?.sourceOrigin ??
    (loadedSource?.sourceKind
      ? getStaticCssEvalSourceOrigin(loadedSource.sourceKind)
      : resolution.sourceOrigin);
  const unsupportedReason =
    loadedSource?.unsupportedReason ?? resolution.unsupportedReason;
  const watchFiles = loadedSource?.watchFiles ?? resolution.watchFiles;

  return {
    importerId,
    importPath,
    resolvedId: resolution.resolvedFile,
    canonicalModuleId,
    normalizedPathKey,
    sourceKind,
    sourceOrigin,
    ...(unsupportedReason ? { unsupportedReason } : {}),
    ...(watchFiles ? { watchFiles: [...watchFiles] } : {})
  };
}

function markPrepassImportResolutionLoaded(
  importResolutions: ImportedStaticCssEvalImportResolution[],
  importerId: string,
  importPath: string,
  resolution: NormalizedStaticCssEvalSourceResolution,
  loadedSource: StaticCssEvalLoadedSource
): void {
  const importResolutionIndex = importResolutions.findIndex(
    (importResolution) =>
      importResolution.importerId === importerId &&
      importResolution.importPath === importPath &&
      importResolution.resolvedId === resolution.resolvedFile
  );
  const loadedImportResolution = createStaticCssEvalPrepassImportResolution(
    importerId,
    importPath,
    resolution,
    loadedSource
  );

  if (importResolutionIndex === -1) {
    importResolutions.push(loadedImportResolution);
    return;
  }

  importResolutions[importResolutionIndex] = loadedImportResolution;
}

function createLoadedModuleSourceMetadata(
  loadedSource: StaticCssEvalLoadedSource,
  resolution: NormalizedStaticCssEvalSourceResolution | undefined
): Pick<
  ImportedStaticCssEvalLoadedModule,
  | "canonicalModuleId"
  | "normalizedPathKey"
  | "sourceKind"
  | "sourceOrigin"
  | "unsupportedReason"
  | "watchFiles"
> {
  const sourceKind = loadedSource.sourceKind ?? resolution?.sourceKind;
  const sourceOrigin =
    loadedSource.sourceOrigin ??
    (loadedSource.sourceKind
      ? getStaticCssEvalSourceOrigin(loadedSource.sourceKind)
      : resolution?.sourceOrigin);
  const canonicalModuleId =
    loadedSource.canonicalModuleId ?? resolution?.canonicalModuleId;
  const normalizedPathKey =
    loadedSource.normalizedPathKey ?? resolution?.normalizedPathKey;
  const unsupportedReason =
    loadedSource.unsupportedReason ?? resolution?.unsupportedReason;
  const watchFiles = loadedSource.watchFiles ?? resolution?.watchFiles;

  return {
    ...(canonicalModuleId ? { canonicalModuleId } : {}),
    ...(normalizedPathKey ? { normalizedPathKey } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(sourceOrigin ? { sourceOrigin } : {}),
    ...(unsupportedReason ? { unsupportedReason } : {}),
    ...(watchFiles ? { watchFiles: [...watchFiles] } : {})
  };
}

function prepareStaticCssEvalLoadedSource(
  id: string,
  loadedSource: StaticCssEvalLoadedSource,
  resolution: NormalizedStaticCssEvalSourceResolution
): PreparedStaticCssEvalLoadedSource {
  const sourceKind = loadedSource.sourceKind ?? resolution.sourceKind;
  const sourceText = loadedSource.sourceText ?? loadedSource.source;

  if (sourceKind === "unsupported-source-shape") {
    return {
      kind: "unsupported",
      loadedSource: createUnsupportedStaticCssEvalLoadedSource(
        loadedSource,
        loadedSource.unsupportedReason ?? "unsupported-source-shape"
      )
    };
  }

  if (sourceText === undefined) {
    return {
      kind: "unsupported",
      loadedSource: createUnsupportedStaticCssEvalLoadedSource(
        loadedSource,
        "unsupported-source-shape"
      )
    };
  }

  if (sourceKind === "static-data") {
    return prepareStaticCssEvalStaticDataSource({
      id,
      sourceText,
      loadedSource,
      resolution
    });
  }

  return prepareStaticCssEvalSourceText(sourceText, loadedSource);
}

function prepareStaticCssEvalSourceText(
  sourceText: string,
  loadedSource: StaticCssEvalLoadedSource
): PreparedStaticCssEvalLoadedSource {
  if (isStaticCssEvalSourceOverByteLimit(sourceText)) {
    return {
      kind: "unsupported",
      loadedSource: createUnsupportedStaticCssEvalLoadedSource(
        loadedSource,
        "source-size-limit-exceeded"
      )
    };
  }

  return { kind: "source", sourceText, loadedSource };
}

function prepareStaticCssEvalStaticDataSource(options: {
  id: string;
  sourceText: string;
  loadedSource: StaticCssEvalLoadedSource;
  resolution: NormalizedStaticCssEvalSourceResolution;
}): PreparedStaticCssEvalLoadedSource {
  const sourceIds = createStaticCssEvalSourceIds(
    options.id,
    options.resolution
  );

  if (isStaticCssEvalWasmRuntimeSource(sourceIds)) {
    return {
      kind: "unsupported",
      loadedSource: createUnsupportedStaticCssEvalLoadedSource(
        options.loadedSource,
        hasStaticCssEvalQueryFlag(sourceIds, "init")
          ? "runtime-wasm-init"
          : "runtime-wasm-module"
      )
    };
  }

  if (isStaticCssEvalStringDataSource(sourceIds)) {
    const esmSource = createStaticCssEvalStringDataModuleSource(
      options.sourceText
    );

    return prepareStaticCssEvalSourceText(esmSource, {
      ...options.loadedSource,
      sourceText: esmSource
    });
  }

  if (isStaticCssEvalJsonSource(sourceIds)) {
    return prepareStaticCssEvalJsonDataSource(
      options.sourceText,
      options.loadedSource
    );
  }

  return prepareStaticCssEvalSourceText(
    options.sourceText,
    options.loadedSource
  );
}

function prepareStaticCssEvalJsonDataSource(
  sourceText: string,
  loadedSource: StaticCssEvalLoadedSource
): PreparedStaticCssEvalLoadedSource {
  let value: unknown;

  try {
    value = JSON.parse(sourceText);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        kind: "unsupported",
        loadedSource: createUnsupportedStaticCssEvalLoadedSource(
          loadedSource,
          "invalid-json-data"
        )
      };
    }

    throw error;
  }

  const esmSource = createStaticCssEvalJsonDataModuleSource(value);

  if (!esmSource) {
    return {
      kind: "unsupported",
      loadedSource: createUnsupportedStaticCssEvalLoadedSource(
        loadedSource,
        "non-literal-loader-output"
      )
    };
  }

  return prepareStaticCssEvalSourceText(esmSource, {
    ...loadedSource,
    sourceText: esmSource
  });
}

function createStaticCssEvalJsonDataModuleSource(
  value: unknown
): string | null {
  const defaultLiteral = JSON.stringify(value);

  if (typeof defaultLiteral !== "string") {
    return null;
  }

  const declarations = [`export default ${defaultLiteral};`];

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, itemValue] of Object.entries(value)) {
      if (!isStaticCssEvalValidNamedExport(key)) {
        continue;
      }

      const itemLiteral = JSON.stringify(itemValue);

      if (typeof itemLiteral === "string") {
        declarations.push(`export const ${key} = ${itemLiteral};`);
      }
    }
  }

  return `${declarations.join("\n")}\n`;
}

function createStaticCssEvalStringDataModuleSource(value: string): string {
  return `export default ${JSON.stringify(value)};\n`;
}

function createUnsupportedStaticCssEvalLoadedSource(
  loadedSource: StaticCssEvalLoadedSource,
  unsupportedReason: StaticCssEvalSourceUnsupportedReason
): StaticCssEvalLoadedSource {
  return {
    ...loadedSource,
    sourceKind: "unsupported-source-shape",
    sourceOrigin: "unsupported",
    unsupportedReason: loadedSource.unsupportedReason ?? unsupportedReason
  };
}

function createStaticCssEvalSourceIds(
  id: string,
  resolution: NormalizedStaticCssEvalSourceResolution
): string[] {
  return [
    ...new Set([
      id,
      resolution.resolvedFile,
      resolution.canonicalModuleId,
      resolution.normalizedPathKey
    ])
  ];
}

function isStaticCssEvalJsonSource(sourceIds: readonly string[]): boolean {
  return sourceIds.some((sourceId) =>
    stripStaticCssEvalQuery(sourceId).endsWith(".json")
  );
}

function isStaticCssEvalStringDataSource(
  sourceIds: readonly string[]
): boolean {
  return (
    hasStaticCssEvalQueryFlag(sourceIds, "raw") ||
    hasStaticCssEvalQueryFlag(sourceIds, "url")
  );
}

function isStaticCssEvalWasmRuntimeSource(
  sourceIds: readonly string[]
): boolean {
  return sourceIds.some(
    (sourceId) =>
      stripStaticCssEvalQuery(sourceId).endsWith(".wasm") &&
      !hasStaticCssEvalQueryFlag([sourceId], "raw") &&
      !hasStaticCssEvalQueryFlag([sourceId], "url")
  );
}

function hasStaticCssEvalQueryFlag(
  sourceIds: readonly string[],
  flag: string
): boolean {
  return sourceIds.some((sourceId) =>
    getStaticCssEvalQueryFlags(sourceId).includes(flag)
  );
}

function getStaticCssEvalQueryFlags(sourceId: string): string[] {
  const queryIndex = sourceId.indexOf("?");

  if (queryIndex === -1) {
    return [];
  }

  const hashIndex = sourceId.indexOf("#", queryIndex);
  const query = sourceId.slice(
    queryIndex + 1,
    hashIndex === -1 ? undefined : hashIndex
  );

  const flags: string[] = [];

  for (const part of query.split("&")) {
    const flag = part.split("=")[0];

    if (flag) {
      flags.push(flag);
    }
  }

  return flags;
}

function stripStaticCssEvalQuery(sourceId: string): string {
  const queryIndex = sourceId.search(/[?#]/);
  return queryIndex === -1 ? sourceId : sourceId.slice(0, queryIndex);
}

function isStaticCssEvalValidNamedExport(name: string): boolean {
  return (
    /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(name) &&
    !STATIC_CSS_EVAL_PREPASS_RESERVED_EXPORT_NAMES.has(name)
  );
}

function isStaticCssEvalSourceOverByteLimit(sourceText: string): boolean {
  return (
    new TextEncoder().encode(sourceText).byteLength >
    STATIC_CSS_EVAL_PREPASS_MAX_SOURCE_BYTES
  );
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
  const sourceKind = resolution.sourceKind ?? "project-source";

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
    ),
    sourceKind,
    sourceOrigin:
      resolution.sourceOrigin ?? getStaticCssEvalSourceOrigin(sourceKind),
    unsupportedReason: resolution.unsupportedReason,
    ...(resolution.watchFiles ? { watchFiles: [...resolution.watchFiles] } : {})
  };
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
      return assertNever(sourceKind);
  }
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
    ? (loadedSource.sourceText ?? loadedSource.source)
    : undefined;
  const sourceIdentity = loadedSource
    ? createLoadedSourceIdentity(sourceText ?? "", loadedSource, resolution)
    : resolution.sourceIdentity;
  const sourceKind = loadedSource?.sourceKind ?? resolution.sourceKind;
  const sourceOrigin =
    loadedSource?.sourceOrigin ??
    (loadedSource?.sourceKind
      ? getStaticCssEvalSourceOrigin(loadedSource.sourceKind)
      : resolution.sourceOrigin);
  const unsupportedReason =
    loadedSource?.unsupportedReason ?? resolution.unsupportedReason;
  const watchFiles = loadedSource?.watchFiles ?? resolution.watchFiles;

  return {
    importerId,
    specifier,
    resolvedFile: resolution.resolvedFile,
    canonicalModuleId: resolution.canonicalModuleId,
    normalizedPathKey: resolution.normalizedPathKey,
    resolverKind: resolution.resolverKind,
    loaded,
    ...(sourceIdentity ? { sourceIdentity } : {}),
    sourceKind,
    sourceOrigin,
    ...(unsupportedReason ? { unsupportedReason } : {}),
    ...(watchFiles ? { watchFiles: [...watchFiles] } : {})
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

// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;

  const YARN_NODE_LINKERS = ["pnp", "pnpm", "node-modules"] as const;

  type YarnNodeLinker = (typeof YARN_NODE_LINKERS)[number];

  type YarnNodeLinkerFixtureSourceEntry = {
    readonly kind: "source";
    readonly resolvedFile: string;
    readonly canonicalModuleId: string;
    readonly normalizedPathKey: string;
    readonly sourcePath: string;
    readonly realpath: string;
    readonly sourceKind: StaticCssEvalSourceKind;
    readonly sourceOrigin: StaticCssEvalSourceOrigin;
    readonly sourceIdentity: StaticCssEvalSourceIdentity;
    readonly watchFiles: readonly string[];
  };

  type YarnNodeLinkerFixtureExternalEntry = {
    readonly kind: "external-no-source";
    readonly resolvedFile: string;
    readonly canonicalModuleId: string;
    readonly normalizedPathKey: string;
    readonly sourceKind: "external-no-source";
    readonly sourceOrigin: "external";
    readonly unsupportedReason: "external-no-source";
    readonly sourceIdentity: StaticCssEvalSourceIdentity;
    readonly watchFiles: readonly string[];
  };

  type YarnNodeLinkerFixtureLoadEntry =
    | YarnNodeLinkerFixtureSourceEntry
    | YarnNodeLinkerFixtureExternalEntry;

  type YarnNodeLinkerFixture = {
    readonly nodeLinker: YarnNodeLinker;
    readonly rootDir: string;
    readonly yarnrcPath: string;
    readonly yarnrcValue: string;
    readonly ownerId: string;
    readonly unsupportedOwnerId: string;
    readonly packageJsonPath: string;
    readonly provider: StaticCssEvalSourceProvider;
    readonly moduleIds: {
      readonly direct: string;
      readonly defaultExport: string;
      readonly barrel: string;
      readonly starSource: string;
      readonly json: string;
      readonly raw: string;
      readonly external: string;
      readonly supported: readonly string[];
    };
    readonly dispose: () => Promise<void>;
  };

  async function withYarnNodeLinkerFixtures(
    run: (fixtures: readonly YarnNodeLinkerFixture[]) => Promise<void>
  ): Promise<void> {
    const fixtures = await Promise.all(
      YARN_NODE_LINKERS.map((nodeLinker) =>
        createYarnNodeLinkerFixture(nodeLinker)
      )
    );

    try {
      await run(fixtures);
    } finally {
      await Promise.all(fixtures.map((fixture) => fixture.dispose()));
      await removeYarnNodeLinkerFixtureParent();
    }
  }

  async function removeYarnNodeLinkerFixtureParent(): Promise<void> {
    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");

    await rm(join(process.cwd(), ".tmp", "static-css-eval-node-linkers"), {
      recursive: true,
      force: true
    });
  }

  async function createYarnNodeLinkerFixture(
    nodeLinker: YarnNodeLinker
  ): Promise<YarnNodeLinkerFixture> {
    const { mkdir, mkdtemp, readFile, rm, writeFile } =
      await import("node:fs/promises");
    const { join } = await import("node:path");
    const tempParent = join(
      process.cwd(),
      ".tmp",
      "static-css-eval-node-linkers"
    );

    await mkdir(tempParent, { recursive: true });

    const rootDir = await mkdtemp(join(tempParent, `${nodeLinker}-`));
    const srcDir = join(rootDir, "src");
    const packageRoot = join(
      rootDir,
      ".yarn",
      "provider-store",
      nodeLinker,
      "@fixture",
      "styles"
    );
    const ownerId = join(srcDir, "App.tsx");
    const unsupportedOwnerId = join(srcDir, "Unsupported.tsx");
    const yarnrcPath = join(rootDir, ".yarnrc.yml");
    const yarnrcValue = `nodeLinker: ${nodeLinker}`;
    const packageJsonPath = join(packageRoot, "package.json");
    const packageId = `yarn:${nodeLinker}:@fixture/styles`;
    const directId = `${packageId}/index.ts`;
    const defaultId = `${packageId}/default.ts`;
    const barrelId = `${packageId}/barrel.ts`;
    const starSourceId = `${packageId}/star-source.ts`;
    const jsonId = `${packageId}/theme.json?import`;
    const rawId = `${packageId}/tokens.css?raw`;
    const externalId = `yarn:${nodeLinker}:external:@fixture/no-source`;
    const directPath = join(packageRoot, "index.ts");
    const defaultPath = join(packageRoot, "default.ts");
    const barrelPath = join(packageRoot, "barrel.ts");
    const starSourcePath = join(packageRoot, "star-source.ts");
    const jsonPath = join(packageRoot, "theme.json");
    const rawPath = join(packageRoot, "tokens.css");
    const watchFiles = [packageJsonPath, yarnrcPath];

    await mkdir(srcDir, { recursive: true });
    await mkdir(packageRoot, { recursive: true });
    await Promise.all([
      writeFile(yarnrcPath, `${yarnrcValue}\n`),
      writeFile(
        join(rootDir, "package.json"),
        `${JSON.stringify(
          {
            name: `linker-${nodeLinker}-consumer`,
            packageManager: "yarn@4.14.1",
            private: true,
            type: "module",
            dependencies: { "@fixture/styles": "workspace:." }
          },
          null,
          2
        )}\n`
      ),
      writeFile(
        packageJsonPath,
        `${JSON.stringify(
          {
            name: "@fixture/styles",
            version: "1.0.0",
            type: "module",
            exports: {
              ".": "./index.ts",
              "./default": "./default.ts",
              "./barrel": "./barrel.ts",
              "./theme.json": "./theme.json",
              "./tokens.css?raw": "./tokens.css?raw"
            }
          },
          null,
          2
        )}\n`
      ),
      writeFile(ownerId, createYarnNodeLinkerConsumerSource()),
      writeFile(unsupportedOwnerId, createYarnNodeLinkerUnsupportedSource()),
      writeFile(
        directPath,
        `export const directButton = { color: "crimson" } as const;\n`
      ),
      writeFile(
        defaultPath,
        `const defaultButton = { color: "navy" } as const;\nexport default defaultButton;\n`
      ),
      writeFile(barrelPath, `export * from "./star-source";\n`),
      writeFile(
        starSourcePath,
        `export const barrelButton = { color: "forestgreen" } as const;\n`
      ),
      writeFile(
        jsonPath,
        `${JSON.stringify({
          jsonButton: { color: "rebeccapurple" },
          jsonDefaultButton: { color: "goldenrod" }
        })}\n`
      ),
      writeFile(rawPath, `:root { --fixture-token: tomato; }\n`)
    ]);

    const entries = [
      {
        kind: "source",
        resolvedFile: ownerId,
        canonicalModuleId: ownerId,
        normalizedPathKey: ownerId,
        sourcePath: ownerId,
        realpath: ownerId,
        sourceKind: "project-source",
        sourceOrigin: "project",
        sourceIdentity: { version: `${nodeLinker}:consumer` },
        watchFiles: [ownerId]
      },
      {
        kind: "source",
        resolvedFile: unsupportedOwnerId,
        canonicalModuleId: unsupportedOwnerId,
        normalizedPathKey: unsupportedOwnerId,
        sourcePath: unsupportedOwnerId,
        realpath: unsupportedOwnerId,
        sourceKind: "project-source",
        sourceOrigin: "project",
        sourceIdentity: { version: `${nodeLinker}:unsupported-consumer` },
        watchFiles: [unsupportedOwnerId]
      },
      {
        kind: "source",
        resolvedFile: directId,
        canonicalModuleId: `${packageId}:root`,
        normalizedPathKey: `${directId}?conditions=import`,
        sourcePath: directPath,
        realpath: directPath,
        sourceKind: "package-source",
        sourceOrigin: "package",
        sourceIdentity: { version: `${nodeLinker}:direct` },
        watchFiles
      },
      {
        kind: "source",
        resolvedFile: defaultId,
        canonicalModuleId: `${packageId}:default`,
        normalizedPathKey: `${defaultId}?conditions=import`,
        sourcePath: defaultPath,
        realpath: defaultPath,
        sourceKind: "package-source",
        sourceOrigin: "package",
        sourceIdentity: { version: `${nodeLinker}:default` },
        watchFiles
      },
      {
        kind: "source",
        resolvedFile: barrelId,
        canonicalModuleId: `${packageId}:barrel`,
        normalizedPathKey: `${barrelId}?conditions=import`,
        sourcePath: barrelPath,
        realpath: barrelPath,
        sourceKind: "package-source",
        sourceOrigin: "package",
        sourceIdentity: { version: `${nodeLinker}:barrel` },
        watchFiles
      },
      {
        kind: "source",
        resolvedFile: starSourceId,
        canonicalModuleId: `${packageId}:star-source`,
        normalizedPathKey: `${starSourceId}?conditions=import`,
        sourcePath: starSourcePath,
        realpath: starSourcePath,
        sourceKind: "package-source",
        sourceOrigin: "package",
        sourceIdentity: { version: `${nodeLinker}:star-source` },
        watchFiles
      },
      {
        kind: "source",
        resolvedFile: jsonId,
        canonicalModuleId: `${packageId}:theme-json`,
        normalizedPathKey: jsonId,
        sourcePath: jsonPath,
        realpath: jsonPath,
        sourceKind: "static-data",
        sourceOrigin: "data",
        sourceIdentity: { version: `${nodeLinker}:json` },
        watchFiles
      },
      {
        kind: "source",
        resolvedFile: rawId,
        canonicalModuleId: `${packageId}:tokens-raw`,
        normalizedPathKey: rawId,
        sourcePath: rawPath,
        realpath: rawPath,
        sourceKind: "static-data",
        sourceOrigin: "data",
        sourceIdentity: { version: `${nodeLinker}:raw` },
        watchFiles
      },
      {
        kind: "external-no-source",
        resolvedFile: externalId,
        canonicalModuleId: `${packageId}:external-no-source`,
        normalizedPathKey: externalId,
        sourceKind: "external-no-source",
        sourceOrigin: "external",
        unsupportedReason: "external-no-source",
        sourceIdentity: { version: `${nodeLinker}:external-no-source` },
        watchFiles
      }
    ] satisfies readonly YarnNodeLinkerFixtureLoadEntry[];
    const loadEntries = new Map(
      entries.map((entry) => [entry.normalizedPathKey, entry])
    );
    const resolutions = new Map<string, YarnNodeLinkerFixtureLoadEntry>([
      [createFixtureResolutionKey(ownerId, "@fixture/styles"), entries[2]],
      [
        createFixtureResolutionKey(ownerId, "@fixture/styles/default"),
        entries[3]
      ],
      [
        createFixtureResolutionKey(ownerId, "@fixture/styles/barrel"),
        entries[4]
      ],
      [
        createFixtureResolutionKey(ownerId, "@fixture/styles/theme.json"),
        entries[6]
      ],
      [
        createFixtureResolutionKey(ownerId, "@fixture/styles/tokens.css?raw"),
        entries[7]
      ],
      [createFixtureResolutionKey(barrelId, "./star-source"), entries[5]],
      [
        createFixtureResolutionKey(unsupportedOwnerId, "@fixture/no-source"),
        entries[8]
      ]
    ]);
    const provider: StaticCssEvalSourceProvider = {
      resolve(importerId, importPath) {
        const entry = resolutions.get(
          createFixtureResolutionKey(importerId, importPath)
        );

        return entry ? createYarnNodeLinkerResolution(entry, nodeLinker) : null;
      },
      async load(id) {
        const entry = loadEntries.get(id);

        if (!entry) {
          return null;
        }

        switch (entry.kind) {
          case "source":
            return {
              sourceText: await readFile(entry.sourcePath, "utf8"),
              resolvedFile: entry.resolvedFile,
              canonicalModuleId: entry.canonicalModuleId,
              normalizedPathKey: entry.normalizedPathKey,
              realpath: entry.realpath,
              sourceKind: entry.sourceKind,
              sourceOrigin: entry.sourceOrigin,
              sourceIdentity: entry.sourceIdentity,
              watchFiles: entry.watchFiles
            };
          case "external-no-source":
            return null;
          default:
            return assertNever(entry);
        }
      }
    };

    return {
      nodeLinker,
      rootDir,
      yarnrcPath,
      yarnrcValue,
      ownerId,
      unsupportedOwnerId,
      packageJsonPath,
      provider,
      moduleIds: {
        direct: directId,
        defaultExport: defaultId,
        barrel: barrelId,
        starSource: starSourceId,
        json: jsonId,
        raw: rawId,
        external: externalId,
        supported: [directId, defaultId, barrelId, starSourceId, jsonId, rawId]
      },
      dispose: () => rm(rootDir, { recursive: true, force: true })
    };
  }

  function createYarnNodeLinkerConsumerSource(): string {
    return `
      import { directButton } from "@fixture/styles";
      import defaultButton from "@fixture/styles/default";
      import { barrelButton } from "@fixture/styles/barrel";
      import theme, { jsonButton } from "@fixture/styles/theme.json";
      import rawTokens from "@fixture/styles/tokens.css?raw";

      function App() {
        return <>
          <div css={directButton} />
          <div css={defaultButton} />
          <div css={barrelButton} />
          <div css={jsonButton} />
          <div css={theme.jsonDefaultButton} />
          <div css={rawTokens} />
        </>;
      }
    `;
  }

  function createYarnNodeLinkerUnsupportedSource(): string {
    return `
      import { externalButton } from "@fixture/no-source";

      function App() {
        return <div css={externalButton} />;
      }
    `;
  }

  function createFixtureResolutionKey(
    importerId: string,
    importPath: string
  ): string {
    return `${importerId}\0${importPath}`;
  }

  function createYarnNodeLinkerResolution(
    entry: YarnNodeLinkerFixtureLoadEntry,
    nodeLinker: YarnNodeLinker
  ): StaticCssEvalSourceResolution {
    return {
      resolvedFile: entry.resolvedFile,
      canonicalModuleId: entry.canonicalModuleId,
      normalizedPathKey: entry.normalizedPathKey,
      sourceKind: entry.sourceKind,
      sourceOrigin: entry.sourceOrigin,
      sourceIdentity: entry.sourceIdentity,
      watchFiles: entry.watchFiles,
      resolverKind: `yarn-${nodeLinker}-provider`,
      ...(entry.kind === "source" ? { realpath: entry.realpath } : {}),
      ...(entry.kind === "external-no-source"
        ? { unsupportedReason: entry.unsupportedReason }
        : {})
    };
  }

  describe("static css eval prepass source provider metadata", () => {
    it("preserves legacy id/source provider metadata", async () => {
      const ownerId = "/project/src/App.tsx";
      const stylesId = "/project/src/styles.ts";
      const ownerSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;
      const stylesSource = `export const button = { color: "red" } as const;`;
      const sources: Record<string, string> = {
        [ownerId]: ownerSource,
        [stylesId]: stylesSource
      };
      const provider: StaticCssEvalSourceProvider = {
        resolve(importerId, importPath) {
          expect({ importerId, importPath }).toEqual({
            importerId: ownerId,
            importPath: "./styles"
          });

          return { id: stylesId };
        },
        load(id) {
          const source = sources[id];

          return source === undefined ? null : { source };
        }
      };

      const { result } = await createStaticCssEvalPrepass(ownerId, provider);

      expect(result.dependencyFiles).toEqual([stylesId]);
      expect(result.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: ownerId,
          specifier: "./styles",
          resolvedFile: stylesId,
          canonicalModuleId: stylesId,
          normalizedPathKey: stylesId,
          resolverKind: "source-provider",
          loaded: true
        })
      ]);
      expect(result.resolvedModuleCache.has(stylesId)).toBe(true);
    });

    it("preloads direct CommonJS require dependencies from css prop candidates", async () => {
      const ownerId = "/project/src/App.tsx";
      const stylesId = "/project/src/styles.cjs";
      const stylesWatchFile = "/project/src/styles.cjs";
      const ownerSource = `
        const styles = require("./styles");

        function App() {
          return <div css={styles.button} />;
        }
      `;
      const stylesSource = `exports.button = { color: "red" };`;
      const calls: {
        resolved: Array<{ importerId: string; importPath: string }>;
        loaded: string[];
      } = { resolved: [], loaded: [] };
      const provider: StaticCssEvalSourceProvider = {
        resolve(importerId, importPath) {
          calls.resolved.push({ importerId, importPath });

          return importPath === "./styles"
            ? {
                resolvedFile: stylesId,
                canonicalModuleId: stylesId,
                normalizedPathKey: stylesId,
                watchFiles: [stylesWatchFile],
                resolverKind: "test"
              }
            : null;
        },
        load(id) {
          calls.loaded.push(id);

          if (id === ownerId) {
            return { source: ownerSource };
          }

          return id === stylesId
            ? {
                source: stylesSource,
                watchFiles: [stylesWatchFile],
                resolverKind: "test"
              }
            : null;
        }
      };

      const { result } = await createStaticCssEvalPrepass(ownerId, provider);

      expect(calls.resolved).toEqual([
        { importerId: ownerId, importPath: "./styles" }
      ]);
      expect(calls.loaded).toEqual([ownerId, stylesId]);
      expect(result.dependencyFiles).toEqual([stylesId]);
      expect(result.ownerToDependencies.get(ownerId)).toEqual([stylesId]);
      expect(result.dependencyToOwners.get(stylesId)).toEqual([ownerId]);
      expect(result.resolvedModuleCache.has(stylesId)).toBe(true);
      expect(result.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: ownerId,
          specifier: "./styles",
          resolvedFile: stylesId,
          resolverKind: "test",
          loaded: true,
          watchFiles: [stylesWatchFile]
        })
      ]);
    });

    it("preloads CommonJS helper export-star dependencies from bare require candidates", async () => {
      const ownerId = "/project/src/App.tsx";
      const barrelId = "/project/src/barrel.cjs";
      const stylesId = "/project/src/styles.cjs";
      const sources: Record<string, string> = {
        [ownerId]: `
          const styles = require("./barrel");

          function App() {
            return <div css={styles} />;
          }
        `,
        [barrelId]: `
          var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
            if (k2 === undefined) k2 = k;
            var desc = Object.getOwnPropertyDescriptor(m, k);
            if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
              desc = { enumerable: true, get: function() { return m[k]; } };
            }
            Object.defineProperty(o, k2, desc);
          }) : (function(o, m, k, k2) {
            if (k2 === undefined) k2 = k;
            o[k2] = m[k];
          }));
          var __exportStar = (this && this.__exportStar) || function(m, exports) {
            for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
          };
          __exportStar(require("./styles"), exports);
        `,
        [stylesId]: `exports.button = { color: "red" };`
      };
      const calls: {
        resolved: Array<{ importerId: string; importPath: string }>;
        loaded: string[];
      } = { resolved: [], loaded: [] };
      const provider: StaticCssEvalSourceProvider = {
        resolve(importerId, importPath) {
          calls.resolved.push({ importerId, importPath });

          if (importerId === ownerId && importPath === "./barrel") {
            return { id: barrelId };
          }

          return importerId === barrelId && importPath === "./styles"
            ? { id: stylesId }
            : null;
        },
        load(id) {
          calls.loaded.push(id);

          const source = sources[id];

          return source === undefined ? null : { source };
        }
      };

      const { result } = await createStaticCssEvalPrepass(ownerId, provider);

      expect(calls.resolved).toEqual([
        { importerId: ownerId, importPath: "./barrel" },
        { importerId: barrelId, importPath: "./styles" }
      ]);
      expect(calls.loaded).toEqual([ownerId, barrelId, stylesId]);
      expect(result.dependencyFiles).toEqual([barrelId, stylesId]);
      expect(result.resolvedModuleCache.has(barrelId)).toBe(true);
      expect(result.resolvedModuleCache.has(stylesId)).toBe(true);
    });

    it("preloads CommonJS helper export-star dependencies from require candidates", async () => {
      const ownerId = "/project/src/App.tsx";
      const barrelId = "/project/src/barrel.cjs";
      const stylesId = "/project/src/styles.cjs";
      const ownerSource = `
        const styles = require("./barrel");

        function App() {
          return <div css={styles.button} />;
        }
      `;
      const barrelSource = `
        var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
          if (k2 === undefined) k2 = k;
          var desc = Object.getOwnPropertyDescriptor(m, k);
          if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
            desc = { enumerable: true, get: function() { return m[k]; } };
          }
          Object.defineProperty(o, k2, desc);
        }) : (function(o, m, k, k2) {
          if (k2 === undefined) k2 = k;
          o[k2] = m[k];
        }));
        var __exportStar = (this && this.__exportStar) || function(m, exports) {
          for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
        };
        __exportStar(require("./styles"), exports);
      `;
      const stylesSource = `exports.button = { color: "red" };`;
      const calls: {
        resolved: Array<{ importerId: string; importPath: string }>;
        loaded: string[];
      } = { resolved: [], loaded: [] };
      const provider: StaticCssEvalSourceProvider = {
        resolve(importerId, importPath) {
          calls.resolved.push({ importerId, importPath });

          if (importerId === ownerId && importPath === "./barrel") {
            return {
              resolvedFile: barrelId,
              canonicalModuleId: barrelId,
              normalizedPathKey: barrelId,
              watchFiles: [barrelId],
              resolverKind: "test"
            };
          }

          return importerId === barrelId && importPath === "./styles"
            ? {
                resolvedFile: stylesId,
                canonicalModuleId: stylesId,
                normalizedPathKey: stylesId,
                watchFiles: [stylesId],
                resolverKind: "test"
              }
            : null;
        },
        load(id) {
          calls.loaded.push(id);

          if (id === ownerId) {
            return { source: ownerSource };
          }

          if (id === barrelId) {
            return { source: barrelSource, watchFiles: [barrelId] };
          }

          return id === stylesId
            ? { source: stylesSource, watchFiles: [stylesId] }
            : null;
        }
      };

      const { result } = await createStaticCssEvalPrepass(ownerId, provider);

      expect(calls.resolved).toEqual([
        { importerId: ownerId, importPath: "./barrel" },
        { importerId: barrelId, importPath: "./styles" }
      ]);
      expect(calls.loaded).toEqual([ownerId, barrelId, stylesId]);
      expect(result.dependencyFiles).toEqual([barrelId, stylesId]);
      expect(result.ownerToDependencies.get(ownerId)).toEqual([
        barrelId,
        stylesId
      ]);
      expect(result.dependencyToOwners.get(barrelId)).toEqual([ownerId]);
      expect(result.dependencyToOwners.get(stylesId)).toEqual([ownerId]);
      expect(result.resolvedModuleCache.has(barrelId)).toBe(true);
      expect(result.resolvedModuleCache.has(stylesId)).toBe(true);
      expect(result.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: ownerId,
          specifier: "./barrel",
          resolvedFile: barrelId,
          loaded: true,
          watchFiles: [barrelId]
        }),
        expect.objectContaining({
          importerId: barrelId,
          specifier: "./styles",
          resolvedFile: stylesId,
          loaded: true,
          watchFiles: [stylesId]
        })
      ]);
    });

    it("records external-no-source provider metadata without filesystem fallback", async () => {
      const ownerId = "/project/src/App.tsx";
      const externalId = "external:@scope/styles";
      const ownerSource = `
        import { button } from "./external";

        function App() {
          return <div css={button} />;
        }
      `;
      const loadedIds: string[] = [];
      const provider: StaticCssEvalSourceProvider = {
        resolve(importerId, importPath) {
          expect({ importerId, importPath }).toEqual({
            importerId: ownerId,
            importPath: "./external"
          });

          return {
            resolvedFile: externalId,
            canonicalModuleId: "pkg:@scope/styles",
            normalizedPathKey: externalId,
            sourceKind: "external-no-source",
            sourceOrigin: "external",
            unsupportedReason: "external-no-source",
            sourceIdentity: { version: "externalized-v1" },
            watchFiles: ["/project/package.json"]
          };
        },
        load(id) {
          loadedIds.push(id);

          return id === ownerId ? { source: ownerSource } : null;
        }
      };

      const { result } = await createStaticCssEvalPrepass(ownerId, provider);

      expect(loadedIds).toEqual([ownerId, externalId]);
      expect(result.resolvedModuleCache.has(externalId)).toBe(false);
      expect(result.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: ownerId,
          specifier: "./external",
          resolvedFile: externalId,
          canonicalModuleId: "pkg:@scope/styles",
          normalizedPathKey: externalId,
          sourceKind: "external-no-source",
          sourceOrigin: "external",
          unsupportedReason: "external-no-source",
          resolverKind: "source-provider",
          loaded: false,
          sourceIdentity: { version: "externalized-v1" },
          watchFiles: ["/project/package.json"]
        })
      ]);
    });

    it("uses loaded source metadata over resolution metadata", async () => {
      const ownerId = "/project/src/App.tsx";
      const stylesId = "/project/node_modules/@scope/styles/index.ts";
      const stylesSource = `export const button = { color: "red" } as const;`;
      const ownerSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;
      const provider: StaticCssEvalSourceProvider = {
        resolve() {
          return {
            id: stylesId,
            canonicalModuleId: "pkg:@scope/styles",
            normalizedPathKey: stylesId,
            sourceKind: "package-source",
            sourceOrigin: "package",
            sourceIdentity: { version: "resolution-v1" },
            watchFiles: ["/project/node_modules/@scope/styles/package.json"]
          };
        },
        load(id) {
          if (id === ownerId) {
            return { source: ownerSource };
          }

          return {
            source: stylesSource,
            sourceKind: "static-data",
            sourceIdentity: { sourceHash: "loaded-static-data" },
            watchFiles: ["/project/node_modules/@scope/styles/styles.json"]
          };
        }
      };

      const { result } = await createStaticCssEvalPrepass(ownerId, provider);

      expect(result.resolvedDependencies).toEqual([
        expect.objectContaining({
          resolvedFile: stylesId,
          canonicalModuleId: "pkg:@scope/styles",
          normalizedPathKey: stylesId,
          sourceKind: "static-data",
          sourceOrigin: "data",
          loaded: true,
          sourceIdentity: {
            sourceHash: "loaded-static-data",
            version: "resolution-v1"
          },
          watchFiles: ["/project/node_modules/@scope/styles/styles.json"]
        })
      ]);
    });

    it("resolves package and virtual source provider edges", async () => {
      const ownerId = "/project/src/App.tsx";
      const packageId = "pkg:@scope/styles/index.ts";
      const virtualId = "\0virtual:mincho/styles";
      const ownerSource = `
        import { button } from "@scope/styles";
        import { virtualButton } from "virtual:mincho/styles";

        function App() {
          return <>
            <div css={button} />
            <div css={virtualButton} />
          </>;
        }
      `;
      const calls: Array<{ importerId: string; importPath: string }> = [];
      const provider: StaticCssEvalSourceProvider = {
        resolve(importerId, importPath) {
          calls.push({ importerId, importPath });

          if (importPath === "@scope/styles") {
            return {
              resolvedFile: packageId,
              canonicalModuleId: "pkg:@scope/styles",
              normalizedPathKey: "pkg:@scope/styles/index.ts?condition=import",
              realpath: "/project/.yarn/cache/@scope-styles/index.ts",
              sourceKind: "package-source",
              watchFiles: ["/project/.pnp.cjs"]
            };
          }

          if (importPath === "virtual:mincho/styles") {
            return {
              id: virtualId,
              canonicalModuleId: virtualId,
              normalizedPathKey: virtualId,
              sourceKind: "provider-virtual",
              sourceIdentity: { version: "virtual-v1" }
            };
          }

          return null;
        },
        load(id) {
          if (id === ownerId) {
            return { source: ownerSource };
          }

          if (id === "pkg:@scope/styles/index.ts?condition=import") {
            return {
              sourceText: `export const button = { color: "red" } as const;`,
              sourceKind: "package-source",
              sourceIdentity: { sourceHash: "pkg-styles-v1" }
            };
          }

          if (id === virtualId) {
            return {
              sourceText: `export const virtualButton = { color: "blue" } as const;`,
              sourceKind: "provider-virtual",
              sourceIdentity: { sourceHash: "virtual-styles-v1" }
            };
          }

          return null;
        }
      };

      const { result } = await createStaticCssEvalPrepass(ownerId, provider);

      expect(calls).toEqual([
        { importerId: ownerId, importPath: "@scope/styles" },
        { importerId: ownerId, importPath: "virtual:mincho/styles" }
      ]);
      expect(result.dependencyFiles).toEqual([packageId, virtualId]);
      expect(result.resolvedModuleCache.has(packageId)).toBe(true);
      expect(result.resolvedModuleCache.has(virtualId)).toBe(true);
      expect(result.resolvedDependencies).toEqual([
        expect.objectContaining({
          specifier: "@scope/styles",
          resolvedFile: packageId,
          canonicalModuleId: "pkg:@scope/styles",
          normalizedPathKey: "pkg:@scope/styles/index.ts?condition=import",
          sourceKind: "package-source",
          sourceOrigin: "package",
          loaded: true,
          sourceIdentity: { sourceHash: "pkg-styles-v1" },
          watchFiles: ["/project/.pnp.cjs"]
        }),
        expect.objectContaining({
          specifier: "virtual:mincho/styles",
          resolvedFile: virtualId,
          canonicalModuleId: virtualId,
          normalizedPathKey: virtualId,
          sourceKind: "provider-virtual",
          sourceOrigin: "provider",
          loaded: true,
          sourceIdentity: {
            sourceHash: "virtual-styles-v1",
            version: "virtual-v1"
          }
        })
      ]);
    });

    it("synthesizes json raw and wasm static data modules as literal ESM", async () => {
      const ownerId = "/project/src/App.tsx";
      const jsonId = "pkg:@scope/styles/styles.json?import";
      const rawId = "pkg:@scope/styles/tokens.css?raw";
      const wasmUrlId = "pkg:@scope/styles/icon.wasm?url";
      const ownerSource = `
        import { button } from "@scope/styles/styles.json";
        import tokens from "@scope/styles/tokens.css?raw";
        import wasmUrl from "@scope/styles/icon.wasm?url";

        function App() {
          return <>
            <div css={button} />
            <div css={tokens} />
            <div css={wasmUrl} />
          </>;
        }
      `;
      const resolutions: Record<string, string> = {
        [`${ownerId}\0@scope/styles/styles.json`]: jsonId,
        [`${ownerId}\0@scope/styles/tokens.css?raw`]: rawId,
        [`${ownerId}\0@scope/styles/icon.wasm?url`]: wasmUrlId
      };
      const provider: StaticCssEvalSourceProvider = {
        resolve(importerId, importPath) {
          const resolvedId = resolutions[`${importerId}\0${importPath}`];

          return resolvedId
            ? {
                resolvedFile: resolvedId,
                canonicalModuleId: resolvedId,
                normalizedPathKey: resolvedId,
                sourceKind: "static-data"
              }
            : null;
        },
        load(id) {
          if (id === ownerId) {
            return { source: ownerSource };
          }

          if (id === jsonId) {
            return {
              sourceText: JSON.stringify({
                button: { color: "red" },
                card: { color: "blue" },
                "invalid-key": { color: "orange" }
              }),
              sourceKind: "static-data",
              sourceIdentity: { version: "json-v1" }
            };
          }

          if (id === rawId) {
            return {
              sourceText: ".button { color: red; }",
              sourceKind: "static-data",
              sourceIdentity: { version: "raw-v1" }
            };
          }

          if (id === wasmUrlId) {
            return {
              sourceText: "/assets/icon.abc123.wasm",
              sourceKind: "static-data",
              sourceIdentity: { version: "wasm-url-v1" }
            };
          }

          return null;
        }
      };

      const { result } = await createStaticCssEvalPrepass(ownerId, provider);
      const jsonRecord = result.resolvedModuleCache.get(jsonId);
      const rawRecord = result.resolvedModuleCache.get(rawId);
      const wasmUrlRecord = result.resolvedModuleCache.get(wasmUrlId);

      if (!jsonRecord || !rawRecord || !wasmUrlRecord) {
        throw new TypeError("expected synthesized data module records");
      }

      expect(jsonRecord.source).toContain(
        `export default {"button":{"color":"red"},"card":{"color":"blue"},"invalid-key":{"color":"orange"}};`
      );
      expect(jsonRecord.source).toContain(
        `export const button = {"color":"red"};`
      );
      expect(jsonRecord.source).toContain(
        `export const card = {"color":"blue"};`
      );
      expect(jsonRecord.exports.has("button")).toBe(true);
      expect(jsonRecord.exports.has("card")).toBe(true);
      expect(jsonRecord.exports.has("invalid-key")).toBe(false);
      expect(rawRecord.source).toBe(
        `export default ".button { color: red; }";\n`
      );
      expect(wasmUrlRecord.source).toBe(
        `export default "/assets/icon.abc123.wasm";\n`
      );
      expect(result.resolvedDependencies).toEqual([
        expect.objectContaining({
          specifier: "@scope/styles/styles.json",
          sourceKind: "static-data",
          sourceOrigin: "data",
          loaded: true,
          sourceIdentity: expect.objectContaining({ version: "json-v1" })
        }),
        expect.objectContaining({
          specifier: "@scope/styles/tokens.css?raw",
          sourceKind: "static-data",
          sourceOrigin: "data",
          loaded: true,
          sourceIdentity: expect.objectContaining({ version: "raw-v1" })
        }),
        expect.objectContaining({
          specifier: "@scope/styles/icon.wasm?url",
          sourceKind: "static-data",
          sourceOrigin: "data",
          loaded: true,
          sourceIdentity: expect.objectContaining({ version: "wasm-url-v1" })
        })
      ]);
    });

    it("records unsupported wasm init, oversized data, and missing source payloads without parsing", async () => {
      const ownerId = "/project/src/App.tsx";
      const wasmInitId = "pkg:@scope/styles/icon.wasm?init";
      const oversizedRawId = "pkg:@scope/styles/huge.css?raw";
      const missingSourceId = "pkg:@scope/styles/missing.css?raw";
      const ownerSource = `
        import initWasm from "@scope/styles/icon.wasm?init";
        import huge from "@scope/styles/huge.css?raw";
        import missing from "@scope/styles/missing.css?raw";

        function App() {
          return <>
            <div css={initWasm} />
            <div css={huge} />
            <div css={missing} />
          </>;
        }
      `;
      const resolutions: Record<string, string> = {
        [`${ownerId}\0@scope/styles/icon.wasm?init`]: wasmInitId,
        [`${ownerId}\0@scope/styles/huge.css?raw`]: oversizedRawId,
        [`${ownerId}\0@scope/styles/missing.css?raw`]: missingSourceId
      };
      const provider: StaticCssEvalSourceProvider = {
        resolve(importerId, importPath) {
          const resolvedId = resolutions[`${importerId}\0${importPath}`];

          return resolvedId
            ? {
                resolvedFile: resolvedId,
                canonicalModuleId: resolvedId,
                normalizedPathKey: resolvedId,
                sourceKind: "static-data"
              }
            : null;
        },
        load(id) {
          if (id === ownerId) {
            return { source: ownerSource };
          }

          if (id === wasmInitId) {
            return {
              sourceText: `export default function init() {}`,
              sourceKind: "static-data",
              sourceIdentity: { version: "wasm-init-v1" }
            };
          }

          if (id === oversizedRawId) {
            return {
              sourceText: "a".repeat(1024 * 1024 + 1),
              sourceKind: "static-data",
              sourceIdentity: { version: "oversized-raw-v1" }
            };
          }

          if (id === missingSourceId) {
            return {
              sourceKind: "static-data",
              sourceIdentity: { version: "missing-source-v1" }
            };
          }

          return null;
        }
      };

      const { result } = await createStaticCssEvalPrepass(ownerId, provider);

      expect(result.resolvedModuleCache.has(wasmInitId)).toBe(false);
      expect(result.resolvedModuleCache.has(oversizedRawId)).toBe(false);
      expect(result.resolvedModuleCache.has(missingSourceId)).toBe(false);
      expect(result.resolvedDependencies).toEqual([
        expect.objectContaining({
          specifier: "@scope/styles/icon.wasm?init",
          resolvedFile: wasmInitId,
          loaded: true,
          sourceKind: "unsupported-source-shape",
          sourceOrigin: "unsupported",
          unsupportedReason: "runtime-wasm-init",
          sourceIdentity: expect.objectContaining({ version: "wasm-init-v1" })
        }),
        expect.objectContaining({
          specifier: "@scope/styles/huge.css?raw",
          resolvedFile: oversizedRawId,
          loaded: true,
          sourceKind: "unsupported-source-shape",
          sourceOrigin: "unsupported",
          unsupportedReason: "source-size-limit-exceeded",
          sourceIdentity: expect.objectContaining({
            version: "oversized-raw-v1"
          })
        }),
        expect.objectContaining({
          specifier: "@scope/styles/missing.css?raw",
          resolvedFile: missingSourceId,
          loaded: true,
          sourceKind: "unsupported-source-shape",
          sourceOrigin: "unsupported",
          unsupportedReason: "unsupported-source-shape",
          sourceIdentity: expect.objectContaining({
            version: "missing-source-v1"
          })
        })
      ]);
    });

    it("resolves Yarn nodeLinker pnp pnpm node-modules package fixtures through provider metadata", async () => {
      const { readFile } = await import("node:fs/promises");

      await withYarnNodeLinkerFixtures(async (fixtures) => {
        for (const fixture of fixtures) {
          const yarnrcValue = (
            await readFile(fixture.yarnrcPath, "utf8")
          ).trim();

          expect(yarnrcValue).toBe(fixture.yarnrcValue);

          const { result } = await createStaticCssEvalPrepass(
            fixture.ownerId,
            fixture.provider
          );
          const jsonRecord = result.resolvedModuleCache.get(
            fixture.moduleIds.json
          );
          const rawRecord = result.resolvedModuleCache.get(
            fixture.moduleIds.raw
          );

          if (!jsonRecord || !rawRecord) {
            throw new TypeError("expected linker data module records");
          }

          for (const moduleId of fixture.moduleIds.supported) {
            expect(result.resolvedModuleCache.has(moduleId)).toBe(true);
          }

          expect(result.dependencyFiles).toEqual(
            expect.arrayContaining([...fixture.moduleIds.supported])
          );
          expect(jsonRecord.source).toContain(
            `export default {"jsonButton":{"color":"rebeccapurple"},"jsonDefaultButton":{"color":"goldenrod"}};`
          );
          expect(jsonRecord.source).toContain(
            `export const jsonButton = {"color":"rebeccapurple"};`
          );
          expect(jsonRecord.exports.has("default")).toBe(true);
          expect(jsonRecord.exports.has("jsonButton")).toBe(true);
          expect(rawRecord.source).toBe(
            `export default ":root { --fixture-token: tomato; }\\n";\n`
          );
          expect(result.resolvedDependencies).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                specifier: "@fixture/styles",
                resolvedFile: fixture.moduleIds.direct,
                sourceKind: "package-source",
                sourceOrigin: "package",
                resolverKind: `yarn-${fixture.nodeLinker}-provider`,
                loaded: true,
                watchFiles: [fixture.packageJsonPath, fixture.yarnrcPath]
              }),
              expect.objectContaining({
                specifier: "@fixture/styles/default",
                resolvedFile: fixture.moduleIds.defaultExport,
                sourceKind: "package-source",
                sourceOrigin: "package",
                resolverKind: `yarn-${fixture.nodeLinker}-provider`,
                loaded: true
              }),
              expect.objectContaining({
                specifier: "@fixture/styles/barrel",
                resolvedFile: fixture.moduleIds.barrel,
                sourceKind: "package-source",
                sourceOrigin: "package",
                resolverKind: `yarn-${fixture.nodeLinker}-provider`,
                loaded: true
              }),
              expect.objectContaining({
                importerId: fixture.moduleIds.barrel,
                specifier: "./star-source",
                resolvedFile: fixture.moduleIds.starSource,
                sourceKind: "package-source",
                sourceOrigin: "package",
                resolverKind: `yarn-${fixture.nodeLinker}-provider`,
                loaded: true
              }),
              expect.objectContaining({
                specifier: "@fixture/styles/theme.json",
                resolvedFile: fixture.moduleIds.json,
                sourceKind: "static-data",
                sourceOrigin: "data",
                resolverKind: `yarn-${fixture.nodeLinker}-provider`,
                loaded: true
              }),
              expect.objectContaining({
                specifier: "@fixture/styles/tokens.css?raw",
                resolvedFile: fixture.moduleIds.raw,
                sourceKind: "static-data",
                sourceOrigin: "data",
                resolverKind: `yarn-${fixture.nodeLinker}-provider`,
                loaded: true
              })
            ])
          );
        }
      });
    });

    it("records external-no-source diagnostics for Yarn nodeLinker pnp pnpm node-modules fixtures", async () => {
      await withYarnNodeLinkerFixtures(async (fixtures) => {
        for (const fixture of fixtures) {
          const { result } = await createStaticCssEvalPrepass(
            fixture.unsupportedOwnerId,
            fixture.provider
          );

          expect(
            result.resolvedModuleCache.has(fixture.moduleIds.external)
          ).toBe(false);
          expect(result.resolvedDependencies).toEqual([
            expect.objectContaining({
              specifier: "@fixture/no-source",
              resolvedFile: fixture.moduleIds.external,
              sourceKind: "external-no-source",
              sourceOrigin: "external",
              unsupportedReason: "external-no-source",
              resolverKind: `yarn-${fixture.nodeLinker}-provider`,
              loaded: false,
              sourceIdentity: {
                version: `${fixture.nodeLinker}:external-no-source`
              },
              watchFiles: [fixture.packageJsonPath, fixture.yarnrcPath]
            })
          ]);
        }
      });
    });
  });
}
