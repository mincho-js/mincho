import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import hash from "@emotion/hash";
import {
  getStaticObjectMemberValue,
  getStaticObjectPropertyName,
  getUnsupportedLiteralReason
} from "./ast.js";
import {
  createStaticCssEvalCandidate,
  getStaticCssEvalMemberReference,
  unwrapTransparentCssRuleExpression
} from "./candidates.js";
import {
  createStaticCssEvalProviderSourceMetadata,
  enforceStaticCssEvalProviderSourcePolicy
} from "./boundary.js";
import {
  collectStaticCssEvalCjsRequireBindings,
  getStaticCssEvalCjsRequireSource,
  isStaticCssEvalLiteralRequireCallExpression
} from "./cjsBindings.js";
import type {
  ImportedStaticCssEvalCjsBinding,
  StaticCssEvalCjsRequireSource
} from "./cjsBindings.js";
import { containsStaticCssEvalRequireCallExpression } from "./cjsRequireAnalysis.js";
import {
  createStaticCssEvalCjsImportRequestParts,
  createStaticCssEvalCjsReexportRequestParts
} from "./cjsResolver.js";
import type { StaticCssEvalCjsResolutionRequestParts } from "./cjsResolver.js";
import type {
  StaticCssEvalProviderSourceMetadata,
  StaticCssEvalProviderSourcePolicyDescriptor
} from "./boundary.js";
import {
  createStaticCssEvalAmbiguousExportStarDiagnostic,
  createStaticCssEvalCjsBundleRuntimeUnsupportedDiagnostic,
  createStaticCssEvalCjsDynamicRequireUnsupportedDiagnostic,
  createStaticCssEvalCjsExportUnsupportedDiagnostic,
  createStaticCssEvalCjsHelperUnsupportedDiagnostic,
  createStaticCssEvalCjsUnsupportedDiagnostic,
  createStaticCssEvalComputedMemberUnsupportedDiagnostic,
  createStaticCssEvalDiagnostic,
  createStaticCssEvalDynamicExpressionUnsupportedDiagnostic,
  createStaticCssEvalExportStarUnsupportedDiagnostic,
  createStaticCssEvalMutableBindingDiagnostic,
  createStaticCssEvalMutatedBindingDiagnostic,
  createStaticCssEvalNamespaceReexportUnsupportedDiagnostic,
  createStaticCssEvalPartialNamespaceFailureDiagnostic,
  createStaticCssEvalProviderSourceUnsupportedDiagnostic,
  createStaticCssEvalUnresolvedExportDiagnostic,
  createStaticCssEvalUnresolvedImportDiagnostic,
  guardStaticCssEvalImportCycle,
  guardStaticCssEvalResolutionDepth
} from "./diagnostics.js";
import type { StaticCssEvalImportCycleKey } from "./diagnostics.js";
import {
  enforceStaticCssEvalLiteralNodeCount,
  enforceStaticCssEvalObjectArrayRecursionDepth,
  enforceStaticCssEvalSourceSize
} from "./limits.js";
import {
  createExportMapCacheKey,
  createStaticCssModuleExportNameTable,
  createStaticCssModuleCache,
  formatExportMapCacheKey,
  STATIC_CSS_MODULE_CACHE_PARSER_VERSION,
  STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION
} from "./moduleCache.js";
import type {
  ExportMapEntry,
  ExportGraphStarReexportEntry,
  ExportMapLocalEntry,
  ParsedStaticCssModule,
  StaticCssModuleCache,
  StaticCssModuleExportNameTableEntry,
  StaticCssModuleExportStarSource,
  StaticCssModuleSource
} from "./moduleCache.js";
import {
  getStaticCssEvalConstBindingInitExpression,
  hasStaticCssEvalBindingMutation
} from "./sameFile.js";
import type {
  BindingProvenance,
  ResolutionChainEntry,
  ResolutionDependency,
  ResolutionDependencyKind,
  StaticCssEvalCacheKey,
  StaticCssEvalDiagnostic,
  StaticCssEvalDiagnosticId,
  StaticCssEvalExportName,
  StaticCssEvalProvider,
  StaticCssEvalQuery,
  StaticCssEvalResult,
  StaticCssEvalSourceLocation,
  StaticCssEvalUnsupportedReason,
  StaticCssEvalModuleRecord,
  StaticCssLiteral
} from "./types.js";

export type ImportedStaticCssEvalImportBinding =
  | {
      kind: "default";
      localName: string;
      importPath: string;
      importedName: "default";
    }
  | {
      kind: "named";
      localName: string;
      importPath: string;
      importedName: string;
    }
  | {
      kind: "namespace";
      localName: string;
      importPath: string;
    };

export type { ImportedStaticCssEvalCjsBinding };

export type ImportedStaticCssEvalExportBinding = ExportMapEntry;

type ImportedStaticCssEvalResolutionResult =
  | { kind: "not-candidate" }
  | {
      kind: "resolved";
      value: StaticCssLiteral;
      provenance: BindingProvenance;
      cacheKey: StaticCssEvalCacheKey;
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      provenance?: BindingProvenance;
      cacheKey?: StaticCssEvalCacheKey;
    };

type ImportedStaticCssEvalExportPresenceResult =
  | { kind: "found" }
  | { kind: "missing" }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic };

interface ImportedStaticCssEvalExportStarCandidate {
  readonly entry: ExportGraphStarReexportEntry;
  readonly record: ImportedStaticCssEvalModuleRecord;
  readonly request: ImportedStaticCssEvalResolutionRequest;
}

interface ImportedStaticCssEvalNamespaceExportNameTable {
  readonly table: ReadonlyMap<
    StaticCssEvalExportName,
    StaticCssModuleExportNameTableEntry
  >;
  readonly candidates: ImportedStaticCssEvalExportStarCandidate[];
}

interface ImportedStaticCssEvalContext {
  owner: StaticCssEvalSourceLocation;
  dependency: StaticCssEvalSourceLocation;
  importPath: string;
  exportName: StaticCssEvalExportName;
  memberPath: string[];
}

type ImportedStaticCssEvalProvenanceKind = Exclude<
  BindingProvenance["kind"],
  "local"
>;

interface ImportedStaticCssEvalResolutionRequest {
  importer: string;
  specifier: string;
  exportName: StaticCssEvalExportName;
  memberPath: string[];
  dependencyKind: ResolutionDependencyKind;
  provenanceKind: ImportedStaticCssEvalProvenanceKind;
  namespaceBinding?: string;
  reexportName?: string;
  wholeNamespace?: boolean;
}

interface ImportedStaticCssEvalResolvedImport {
  readonly resolvedId: string;
  readonly sourceMetadata: StaticCssEvalProviderSourceMetadata;
}

interface ImportedStaticCssEvalResolutionState {
  owner: StaticCssEvalSourceLocation;
  dependencies: Map<string, ResolutionDependency>;
  resolutionChain: ResolutionChainEntry[];
  stack: StaticCssEvalImportCycleKey[];
}

interface StaticCssLiteralValidationState {
  count: number;
}

export interface ImportedStaticCssEvalLoadedModule extends StaticCssEvalProviderSourcePolicyDescriptor {
  id: string;
  source: string;
  realpath?: string;
  sourceHash?: string;
  version?: string | number;
}

export interface ImportedStaticCssEvalImportResolution extends StaticCssEvalProviderSourcePolicyDescriptor {
  importerId: string;
  importPath: string;
  resolvedId: string;
}

export interface ImportedStaticCssEvalModuleRecord extends StaticCssEvalModuleRecord {
  source: string;
  imports: ReadonlyMap<string, ImportedStaticCssEvalImportBinding>;
  cjsImports: ReadonlyMap<string, ImportedStaticCssEvalCjsBinding>;
  exports: ReadonlyMap<
    StaticCssEvalExportName,
    ImportedStaticCssEvalExportBinding
  >;
  exportAllReexportSources: readonly string[];
  parsedModule: ParsedStaticCssModule;
  programPath: NodePath<t.Program>;
}

export interface CreateImportedStaticCssEvalProviderOptions {
  modules: readonly ImportedStaticCssEvalLoadedModule[];
  importResolutions: readonly ImportedStaticCssEvalImportResolution[];
  moduleRecords?: readonly ImportedStaticCssEvalModuleRecord[];
}

interface ImportedStaticCssEvalResolverOptions extends CreateImportedStaticCssEvalProviderOptions {
  moduleCache?: StaticCssModuleCache;
}

export type ResolveImportedStaticCssEvalExpressionResult =
  | { kind: "not-candidate" }
  | { kind: "resolved"; expression: t.ObjectExpression | t.ArrayExpression }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic };

const importResolutionKeySeparator = "\0";

export function createImportedStaticCssEvalProvider(
  options: CreateImportedStaticCssEvalProviderOptions
): StaticCssEvalProvider {
  const resolver = new ImportedStaticCssEvalResolver(options);

  return {
    getResolvedCssValue(query) {
      return resolver.resolve(query);
    }
  };
}

export function createImportedStaticCssEvalModuleRecord(
  loadedModule: ImportedStaticCssEvalLoadedModule
): ImportedStaticCssEvalModuleRecord {
  return createImportedStaticCssEvalModuleRecordWithCache(
    loadedModule,
    createStaticCssModuleCache()
  );
}

function createImportedStaticCssEvalModuleRecordWithCache(
  loadedModule: ImportedStaticCssEvalLoadedModule,
  moduleCache: StaticCssModuleCache
): ImportedStaticCssEvalModuleRecord {
  const parsedModule = moduleCache.getParsedModule(
    createStaticCssModuleSource(loadedModule)
  );

  const imports = new Map<string, ImportedStaticCssEvalImportBinding>();
  const cjsImports = collectStaticCssEvalCjsRequireBindings(
    parsedModule.programPath
  );

  for (const statement of parsedModule.program.body) {
    collectModuleImportBindings(statement, imports);
  }

  return {
    id: loadedModule.id,
    realpath: loadedModule.realpath ?? loadedModule.id,
    sourceHash:
      loadedModule.sourceHash ??
      createInlineStaticCssSourceHash(loadedModule.source),
    ...(loadedModule.version !== undefined
      ? { version: loadedModule.version }
      : {}),
    ...createStaticCssEvalProviderSourceMetadata(loadedModule),
    dependencies: [],
    source: loadedModule.source,
    imports,
    cjsImports,
    exports: parsedModule.exportMap,
    exportAllReexportSources: parsedModule.unsupportedExportStars.flatMap(
      (entry) => (entry.source ? [entry.source] : [])
    ),
    parsedModule,
    programPath: parsedModule.programPath
  };
}

export function resolveImportedStaticCssEvalExpression(options: {
  expression: t.Expression;
  ownerFile: string;
  provider?: StaticCssEvalProvider;
  allowUnsupportedSourceFallback?: boolean;
}): ResolveImportedStaticCssEvalExpressionResult {
  if (!options.provider) {
    return { kind: "not-candidate" };
  }

  const candidate = createStaticCssEvalCandidate(
    options.expression,
    options.ownerFile
  );

  if (!candidate?.bindingName) {
    return { kind: "not-candidate" };
  }

  const result = options.provider.getResolvedCssValue(candidate);

  if (result.kind === "not-candidate") {
    return { kind: "not-candidate" };
  }

  if (result.kind === "error") {
    if (
      options.allowUnsupportedSourceFallback === true &&
      result.diagnostic.reason === "reexport-or-barrel" &&
      result.diagnostic.id === undefined
    ) {
      return { kind: "not-candidate" };
    }

    return { kind: "error", diagnostic: result.diagnostic };
  }

  if (!isStaticCssRuleLiteralValue(result.value)) {
    return { kind: "not-candidate" };
  }

  const expression = createStaticCssLiteralExpression(result.value);

  return t.isObjectExpression(expression) || t.isArrayExpression(expression)
    ? { kind: "resolved", expression }
    : { kind: "not-candidate" };
}

export function findUnsupportedImportedStaticCssEvalReferenceDiagnostic(options: {
  expression: t.Expression;
  ownerFile: string;
  provider?: StaticCssEvalProvider;
}): StaticCssEvalDiagnostic | null {
  const { provider } = options;

  if (!provider) {
    return null;
  }

  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    options.expression
  );

  if (t.isObjectExpression(unwrappedExpression)) {
    return findUnsupportedImportedObjectReferenceDiagnostic(
      unwrappedExpression,
      { ownerFile: options.ownerFile, provider }
    );
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return findUnsupportedImportedArrayReferenceDiagnostic(
      unwrappedExpression,
      { ownerFile: options.ownerFile, provider }
    );
  }

  return findUnsupportedImportedExpressionReferenceDiagnostic(
    unwrappedExpression,
    {
      ownerFile: options.ownerFile,
      provider,
      includeSupportedReferenceErrors: false
    }
  );
}

export function createStaticCssLiteralExpression(
  value: StaticCssLiteral
): t.Expression {
  if (Array.isArray(value)) {
    return t.arrayExpression(value.map(createStaticCssLiteralExpression));
  }

  if (value && typeof value === "object") {
    return t.objectExpression(
      Object.entries(value).map(([key, propertyValue]) =>
        t.objectProperty(
          t.isValidIdentifier(key) ? t.identifier(key) : t.stringLiteral(key),
          createStaticCssLiteralExpression(propertyValue)
        )
      )
    );
  }

  if (typeof value === "string") {
    return t.stringLiteral(value);
  }

  if (typeof value === "number") {
    return t.numericLiteral(value);
  }

  if (typeof value === "boolean") {
    return t.booleanLiteral(value);
  }

  return t.nullLiteral();
}

class ImportedStaticCssEvalResolver {
  readonly #modules = new Map<string, ImportedStaticCssEvalLoadedModule>();
  readonly #records = new Map<string, ImportedStaticCssEvalModuleRecord>();
  readonly #parseFailures = new Map<string, string>();
  readonly #importResolutions = new Map<
    string,
    ImportedStaticCssEvalResolvedImport
  >();
  readonly #moduleCache: StaticCssModuleCache;

  constructor(options: ImportedStaticCssEvalResolverOptions) {
    this.#moduleCache = options.moduleCache ?? createStaticCssModuleCache();

    for (const loadedModule of options.modules) {
      this.#modules.set(loadedModule.id, loadedModule);
    }

    for (const moduleRecord of options.moduleRecords ?? []) {
      this.#records.set(moduleRecord.id, moduleRecord);
    }

    for (const resolution of options.importResolutions) {
      this.#importResolutions.set(
        createImportResolutionKey(resolution.importerId, resolution.importPath),
        {
          resolvedId: resolution.resolvedId,
          sourceMetadata: createStaticCssEvalProviderSourceMetadata(resolution)
        }
      );
    }
  }

  resolve(query: StaticCssEvalQuery): StaticCssEvalResult {
    if (!query.bindingName) {
      return { kind: "not-candidate" };
    }

    const ownerRecord = this.#getModuleRecord(query.importerId);

    if (!ownerRecord) {
      return { kind: "not-candidate" };
    }

    const owner = createQueryOwnerLocation(query);
    const state = createResolutionState(owner);
    const importBinding = ownerRecord.imports.get(query.bindingName);
    const cjsBinding = ownerRecord.cjsImports.get(query.bindingName);
    const requestResult = importBinding
      ? createResolutionRequest(query, importBinding)
      : cjsBinding
        ? createCjsResolutionRequest(query, cjsBinding)
        : null;

    if (!requestResult) {
      const cjsDiagnostic = this.#createCjsUnsupportedDiagnostic(
        ownerRecord,
        query
      );

      return cjsDiagnostic
        ? createImportedStaticCssEvalErrorResult({
            query,
            diagnostic: cjsDiagnostic,
            state
          })
        : { kind: "not-candidate" };
    }

    if (requestResult.kind === "error") {
      return createImportedStaticCssEvalErrorResult({
        query,
        diagnostic: requestResult.diagnostic,
        state
      });
    }

    const importResult = this.#resolveProviderImport(
      requestResult.request,
      owner,
      state
    );

    if (importResult.kind === "error") {
      return createImportedStaticCssEvalErrorResult({
        query,
        diagnostic: importResult.diagnostic,
        state
      });
    }

    const result = this.#resolveModuleExport(
      importResult.record,
      requestResult.request,
      state
    );

    if (result.kind === "not-candidate") {
      return { kind: "not-candidate" };
    }

    if (result.kind === "error") {
      return createImportedStaticCssEvalErrorResult({
        query,
        diagnostic: result.diagnostic,
        state,
        provenance: result.provenance,
        cacheKey: result.cacheKey
      });
    }

    markResolutionDependenciesContributed(state);

    return createImportedStaticCssEvalResolvedResult({
      query,
      value: result.value,
      provenance: result.provenance,
      cacheKey: result.cacheKey,
      state
    });
  }

  #resolveProviderImport(
    request: ImportedStaticCssEvalResolutionRequest,
    owner: StaticCssEvalSourceLocation,
    state: ImportedStaticCssEvalResolutionState
  ):
    | { kind: "resolved"; record: ImportedStaticCssEvalModuleRecord }
    | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
    const resolvedImport = this.#resolveImport(
      request.importer,
      request.specifier
    );

    if (!resolvedImport) {
      const sourceMetadata = createStaticCssEvalProviderSourceMetadata({
        sourceKind: "unresolved",
        sourceOrigin: "unresolved",
        unsupportedReason: "unresolved"
      });
      addResolutionDependency(state, {
        file: request.specifier,
        kind: "unresolved",
        importer: request.importer,
        specifier: request.specifier,
        exportName: request.exportName,
        memberPath: request.memberPath,
        inspected: false,
        contributed: false,
        ...sourceMetadata
      });

      return {
        kind: "error",
        diagnostic: createStaticCssEvalUnresolvedImportDiagnostic(
          {
            owner,
            dependency: { file: request.specifier },
            importPath: request.specifier,
            exportName: request.exportName,
            memberPath: request.memberPath,
            importChain: createResolutionImportChain(state, request.specifier)
          },
          request.specifier
        )
      };
    }

    const loadedModule = this.#modules.get(resolvedImport.resolvedId);
    const cachedRecord = this.#records.get(resolvedImport.resolvedId);
    const resolvedSource = loadedModule ?? cachedRecord;
    const sourceMetadata = mergeImportedStaticCssEvalSourceMetadata(
      resolvedImport.sourceMetadata,
      resolvedSource
    );

    addResolutionDependency(state, {
      file: resolvedImport.resolvedId,
      kind: request.dependencyKind,
      importer: request.importer,
      specifier: request.specifier,
      exportName: request.exportName,
      memberPath: request.memberPath,
      inspected: false,
      contributed: false,
      ...sourceMetadata
    });

    const sourcePolicyResult = enforceStaticCssEvalProviderSourcePolicy({
      owner,
      dependency: { file: resolvedImport.resolvedId },
      importPath: request.specifier,
      exportName: request.exportName,
      memberPath: request.memberPath,
      importChain: createResolutionImportChain(
        state,
        resolvedImport.resolvedId
      ),
      sourceId: resolvedImport.resolvedId,
      ...sourceMetadata
    });

    if (!sourcePolicyResult.ok) {
      markResolutionDependencyInspected(state, resolvedImport.resolvedId);
      return { kind: "error", diagnostic: sourcePolicyResult.diagnostic };
    }

    if (!resolvedSource) {
      markResolutionDependencyInspected(state, resolvedImport.resolvedId);

      if (sourceMetadata.sourceKind === "provider-virtual") {
        return {
          kind: "error",
          diagnostic: createStaticCssEvalProviderSourceUnsupportedDiagnostic({
            owner,
            dependency: { file: resolvedImport.resolvedId },
            importPath: request.specifier,
            exportName: request.exportName,
            memberPath: request.memberPath,
            importChain: createResolutionImportChain(
              state,
              resolvedImport.resolvedId
            ),
            sourceId: resolvedImport.resolvedId,
            sourceKind: sourceMetadata.sourceKind,
            sourceOrigin: sourceMetadata.sourceOrigin,
            reason:
              sourceMetadata.unsupportedReason ?? "provider-virtual-no-source"
          })
        };
      }

      return {
        kind: "error",
        diagnostic: createStaticCssEvalUnresolvedImportDiagnostic(
          {
            owner,
            dependency: { file: resolvedImport.resolvedId },
            importPath: request.specifier,
            exportName: request.exportName,
            memberPath: request.memberPath,
            importChain: createResolutionImportChain(
              state,
              resolvedImport.resolvedId
            )
          },
          request.specifier
        )
      };
    }

    const sourceSizeResult = enforceStaticCssEvalSourceSize({
      owner,
      dependency: { file: resolvedImport.resolvedId },
      importPath: request.specifier,
      exportName: request.exportName,
      memberPath: request.memberPath,
      source: resolvedSource.source
    });

    if (!sourceSizeResult.ok) {
      markResolutionDependencyInspected(state, resolvedImport.resolvedId);
      return { kind: "error", diagnostic: sourceSizeResult.diagnostic };
    }

    const record =
      cachedRecord ?? this.#getModuleRecord(resolvedImport.resolvedId);

    if (!record) {
      markResolutionDependencyInspected(state, resolvedImport.resolvedId);
      return {
        kind: "error",
        diagnostic: createStaticCssEvalUnresolvedImportDiagnostic(
          {
            owner,
            dependency: { file: resolvedImport.resolvedId },
            importPath: request.specifier,
            exportName: request.exportName,
            memberPath: request.memberPath,
            importChain: createResolutionImportChain(
              state,
              resolvedImport.resolvedId
            )
          },
          request.specifier,
          this.#parseFailures.get(resolvedImport.resolvedId)
        )
      };
    }

    markResolutionDependencyInspected(state, resolvedImport.resolvedId);
    return { kind: "resolved", record };
  }

  #resolveModuleExport(
    record: ImportedStaticCssEvalModuleRecord,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState
  ): ImportedStaticCssEvalResolutionResult {
    const guardResult = this.#guardResolution(record, request, state);

    if (!guardResult.ok) {
      addResolutionGuardDependencies(state, guardResult.dependencies, request);

      return { kind: "error", diagnostic: guardResult.diagnostic };
    }

    const stackEntry = createImportCycleStackEntry(record, request);
    state.stack.push(stackEntry);

    try {
      return this.#resolveGuardedModuleExport(record, request, state);
    } finally {
      state.stack.pop();
    }
  }

  #resolveGuardedModuleExport(
    record: ImportedStaticCssEvalModuleRecord,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState
  ): ImportedStaticCssEvalResolutionResult {
    if (request.wholeNamespace === true) {
      return this.#resolveWholeNamespaceExport(record, request, state);
    }

    const exportEntry = record.exports.get(request.exportName);

    if (!exportEntry) {
      const cjsModuleUnsupportedEntry = getCjsModuleUnsupportedEntry(record);

      if (cjsModuleUnsupportedEntry) {
        return this.#resolveExportMapEntry(
          record,
          cjsModuleUnsupportedEntry,
          request,
          state
        );
      }

      return this.#resolveExportStarEntries(record, request, state);
    }

    return this.#resolveExportMapEntry(record, exportEntry, request, state);
  }

  #resolveExportMapEntry(
    record: ImportedStaticCssEvalModuleRecord,
    exportEntry: ExportMapEntry,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState
  ): ImportedStaticCssEvalResolutionResult {
    const cjsReexportSource =
      exportEntry.kind === "reexport" || exportEntry.kind === "unsupported"
        ? null
        : getStaticExportEntryCjsRequireSource(record, exportEntry);
    const effectiveRequest =
      exportEntry.kind === "reexport" || cjsReexportSource
        ? {
            ...request,
            dependencyKind: "reexported" as const,
            provenanceKind: "reexported" as const,
            reexportName: formatExportName(exportEntry.exportName)
          }
        : request;
    const provenance = createBindingProvenance(record.id, effectiveRequest);
    state.resolutionChain.push({
      importer: effectiveRequest.importer,
      source: record.id,
      exportName: effectiveRequest.exportName,
      memberPath: [...effectiveRequest.memberPath],
      provenance,
      ...createStaticCssEvalProviderSourceMetadata(record)
    });
    updateResolutionDependencyKind(
      state,
      record.id,
      effectiveRequest.dependencyKind
    );

    if (exportEntry.kind === "unsupported") {
      return {
        kind: "error",
        diagnostic: createUnsupportedExportEntryDiagnostic(
          exportEntry,
          record,
          effectiveRequest,
          state
        ),
        provenance,
        cacheKey: createImportedStaticCssEvalCacheKey(
          state.owner.file,
          record.parsedModule,
          effectiveRequest.exportName,
          effectiveRequest.memberPath,
          record
        )
      };
    }

    if (exportEntry.kind === "reexport") {
      return this.#resolveReexportEntry(
        record,
        exportEntry,
        effectiveRequest,
        state,
        provenance
      );
    }

    if (cjsReexportSource) {
      return this.#resolveCjsReexportEntry(
        record,
        exportEntry,
        cjsReexportSource,
        effectiveRequest,
        state,
        provenance
      );
    }

    return resolveStaticExportMapEntry(
      record,
      exportEntry,
      effectiveRequest,
      state,
      provenance
    );
  }

  #resolveWholeNamespaceExport(
    record: ImportedStaticCssEvalModuleRecord,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState
  ): ImportedStaticCssEvalResolutionResult {
    const namespaceTableResult = this.#collectNamespaceExportNameTable(
      record,
      request,
      state,
      true
    );
    const provenance = createBindingProvenance(record.id, request);
    const cacheKey = createImportedStaticCssEvalCacheKey(
      state.owner.file,
      record.parsedModule,
      request.exportName,
      request.memberPath,
      record
    );

    if (namespaceTableResult.kind === "error") {
      return {
        kind: "error",
        diagnostic: namespaceTableResult.diagnostic,
        provenance,
        cacheKey
      };
    }

    const namespaceValue: Record<string, StaticCssLiteral> =
      Object.create(null);

    for (const [exportName, tableEntry] of namespaceTableResult.table.table) {
      if (exportName === null) {
        continue;
      }

      const exportRequest: ImportedStaticCssEvalResolutionRequest = {
        ...request,
        exportName,
        memberPath: [],
        wholeNamespace: false,
        reexportName: formatExportName(exportName)
      };
      const exportResult = this.#resolveNamespaceTableEntry(
        record,
        tableEntry,
        exportRequest,
        namespaceTableResult.table.candidates,
        state
      );

      if (exportResult.kind === "not-candidate") {
        return this.#createMissingExportResult(record, exportRequest, state);
      }

      if (exportResult.kind === "error") {
        return {
          kind: "error",
          diagnostic: createStaticCssEvalPartialNamespaceFailureDiagnostic({
            owner: state.owner,
            dependency: exportResult.diagnostic.dependency ?? {
              file: record.id
            },
            importPath: request.specifier,
            exportName: exportRequest.exportName,
            memberPath: exportRequest.memberPath,
            importChain: exportResult.diagnostic.importChain,
            failedReason: exportResult.diagnostic.reason
          }),
          provenance,
          cacheKey
        };
      }

      namespaceValue[exportName] = exportResult.value;
    }

    return {
      kind: "resolved",
      value: namespaceValue,
      provenance,
      cacheKey
    };
  }

  #resolveNamespaceTableEntry(
    record: ImportedStaticCssEvalModuleRecord,
    tableEntry: StaticCssModuleExportNameTableEntry,
    request: ImportedStaticCssEvalResolutionRequest,
    candidates: readonly ImportedStaticCssEvalExportStarCandidate[],
    state: ImportedStaticCssEvalResolutionState
  ): ImportedStaticCssEvalResolutionResult {
    switch (tableEntry.kind) {
      case "explicit":
        return this.#resolveExportMapEntry(
          record,
          tableEntry.entry,
          request,
          state
        );
      case "star": {
        const candidate = candidates.find(
          (exportStarCandidate) =>
            exportStarCandidate.entry === tableEntry.entry
        );

        return candidate
          ? this.#resolveModuleExport(
              candidate.record,
              {
                ...candidate.request,
                exportName: request.exportName,
                memberPath: [],
                wholeNamespace: false,
                reexportName: formatExportName(request.exportName)
              },
              state
            )
          : this.#createMissingExportResult(record, request, state);
      }
      case "ambiguous-star":
        return {
          kind: "error",
          diagnostic: createAmbiguousExportStarDiagnostic(
            record,
            request,
            state,
            candidates
          ),
          cacheKey: createImportedStaticCssEvalCacheKey(
            state.owner.file,
            record.parsedModule,
            request.exportName,
            request.memberPath,
            record
          )
        };
      default:
        return assertNever(tableEntry);
    }
  }

  #collectNamespaceExportNames(
    record: ImportedStaticCssEvalModuleRecord,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState,
    includeDefaultExport: boolean
  ):
    | { kind: "resolved"; exportNames: StaticCssEvalExportName[] }
    | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
    const guardResult = this.#guardResolution(record, request, state);

    if (!guardResult.ok) {
      addResolutionGuardDependencies(state, guardResult.dependencies, request);

      return { kind: "error", diagnostic: guardResult.diagnostic };
    }

    const stackEntry = createImportCycleStackEntry(record, request);
    state.stack.push(stackEntry);

    try {
      const namespaceTableResult = this.#collectNamespaceExportNameTable(
        record,
        request,
        state,
        includeDefaultExport
      );

      if (namespaceTableResult.kind === "error") {
        return namespaceTableResult;
      }

      const exportNames: StaticCssEvalExportName[] = [];

      for (const [exportName, tableEntry] of namespaceTableResult.table.table) {
        if (exportName === null) {
          continue;
        }

        if (tableEntry.kind === "ambiguous-star") {
          return {
            kind: "error",
            diagnostic: createAmbiguousExportStarDiagnostic(
              record,
              { ...request, exportName },
              state,
              namespaceTableResult.table.candidates
            )
          };
        }

        exportNames.push(exportName);
      }

      return { kind: "resolved", exportNames };
    } finally {
      state.stack.pop();
    }
  }

  #collectNamespaceExportNameTable(
    record: ImportedStaticCssEvalModuleRecord,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState,
    includeDefaultExport: boolean
  ):
    | { kind: "resolved"; table: ImportedStaticCssEvalNamespaceExportNameTable }
    | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
    const starSourcesResult = this.#collectNamespaceExportStarSources(
      record,
      request,
      state
    );

    if (starSourcesResult.kind === "error") {
      return { kind: "error", diagnostic: starSourcesResult.diagnostic };
    }

    return {
      kind: "resolved",
      table: {
        table: createStaticCssModuleExportNameTable(
          createNamespaceExplicitExportMap(
            record.exports,
            includeDefaultExport
          ),
          starSourcesResult.starSources
        ),
        candidates: starSourcesResult.candidates
      }
    };
  }

  #collectNamespaceExportStarSources(
    record: ImportedStaticCssEvalModuleRecord,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState
  ):
    | {
        kind: "resolved";
        starSources: StaticCssModuleExportStarSource[];
        candidates: ImportedStaticCssEvalExportStarCandidate[];
      }
    | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
    const starSources: StaticCssModuleExportStarSource[] = [];
    const candidates: ImportedStaticCssEvalExportStarCandidate[] = [];

    for (const starEntry of record.parsedModule.exportStarReexports) {
      const starRequest = createExportStarRequest(record, starEntry, request);
      const importResult = this.#resolveProviderImport(
        starRequest,
        state.owner,
        state
      );

      if (importResult.kind === "error") {
        return { kind: "error", diagnostic: importResult.diagnostic };
      }

      const exportNamesResult = this.#collectNamespaceExportNames(
        importResult.record,
        { ...starRequest, wholeNamespace: true },
        state,
        false
      );

      if (exportNamesResult.kind === "error") {
        return { kind: "error", diagnostic: exportNamesResult.diagnostic };
      }

      if (exportNamesResult.exportNames.length === 0) {
        continue;
      }

      candidates.push({
        entry: starEntry,
        record: importResult.record,
        request: starRequest
      });
      starSources.push({
        entry: starEntry,
        exportNames: exportNamesResult.exportNames
      });
    }

    return { kind: "resolved", starSources, candidates };
  }

  #resolveExportStarEntries(
    record: ImportedStaticCssEvalModuleRecord,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState
  ): ImportedStaticCssEvalResolutionResult {
    if (
      request.exportName === "default" ||
      record.parsedModule.exportStarReexports.length === 0
    ) {
      return this.#createMissingExportResult(record, request, state);
    }

    const effectiveRequest = {
      ...request,
      dependencyKind: "reexported" as const,
      provenanceKind: "reexported" as const,
      reexportName: formatExportName(request.exportName)
    };
    const provenance = createBindingProvenance(record.id, effectiveRequest);
    state.resolutionChain.push({
      importer: effectiveRequest.importer,
      source: record.id,
      exportName: effectiveRequest.exportName,
      memberPath: [...effectiveRequest.memberPath],
      provenance,
      ...createStaticCssEvalProviderSourceMetadata(record)
    });
    updateResolutionDependencyKind(
      state,
      record.id,
      effectiveRequest.dependencyKind
    );

    const candidatesResult = this.#collectExportStarCandidates(
      record,
      effectiveRequest,
      state
    );

    if (candidatesResult.kind === "error") {
      return {
        kind: "error",
        diagnostic: candidatesResult.diagnostic,
        provenance,
        cacheKey: createImportedStaticCssEvalCacheKey(
          state.owner.file,
          record.parsedModule,
          effectiveRequest.exportName,
          effectiveRequest.memberPath,
          record
        )
      };
    }

    const exportNameTable = createStaticCssModuleExportNameTable(
      record.exports,
      createExportStarSources(
        effectiveRequest.exportName,
        candidatesResult.candidates
      )
    );
    const tableEntry = exportNameTable.get(effectiveRequest.exportName);

    if (!tableEntry) {
      return this.#createMissingExportResult(record, effectiveRequest, state);
    }

    switch (tableEntry.kind) {
      case "explicit":
        return this.#resolveExportMapEntry(
          record,
          tableEntry.entry,
          effectiveRequest,
          state
        );
      case "star": {
        const candidate = candidatesResult.candidates.find(
          (exportStarCandidate) =>
            exportStarCandidate.entry === tableEntry.entry
        );

        return candidate
          ? this.#resolveModuleExport(
              candidate.record,
              candidate.request,
              state
            )
          : this.#createMissingExportResult(record, effectiveRequest, state);
      }
      case "ambiguous-star":
        return {
          kind: "error",
          diagnostic: createAmbiguousExportStarDiagnostic(
            record,
            effectiveRequest,
            state,
            candidatesResult.candidates
          ),
          provenance,
          cacheKey: createImportedStaticCssEvalCacheKey(
            state.owner.file,
            record.parsedModule,
            effectiveRequest.exportName,
            effectiveRequest.memberPath,
            record
          )
        };
      default:
        return assertNever(tableEntry);
    }
  }

  #collectExportStarCandidates(
    record: ImportedStaticCssEvalModuleRecord,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState
  ):
    | {
        kind: "resolved";
        candidates: ImportedStaticCssEvalExportStarCandidate[];
      }
    | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
    const candidates: ImportedStaticCssEvalExportStarCandidate[] = [];

    for (const starEntry of record.parsedModule.exportStarReexports) {
      const candidateResult = this.#resolveExportStarCandidate(
        record,
        starEntry,
        request,
        state
      );

      if (candidateResult.kind === "error") {
        return { kind: "error", diagnostic: candidateResult.diagnostic };
      }

      if (candidateResult.kind === "resolved") {
        candidates.push(candidateResult.candidate);
      }
    }

    return { kind: "resolved", candidates };
  }

  #resolveExportStarCandidate(
    record: ImportedStaticCssEvalModuleRecord,
    starEntry: ExportGraphStarReexportEntry,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState
  ):
    | {
        kind: "resolved";
        candidate: ImportedStaticCssEvalExportStarCandidate;
      }
    | { kind: "missing" }
    | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
    const starRequest = createExportStarRequest(record, starEntry, request);
    const importResult = this.#resolveProviderImport(
      starRequest,
      state.owner,
      state
    );

    if (importResult.kind === "error") {
      return { kind: "error", diagnostic: importResult.diagnostic };
    }

    const presenceResult = this.#recordExportsName(
      importResult.record,
      starRequest,
      state
    );

    if (presenceResult.kind === "error") {
      return { kind: "error", diagnostic: presenceResult.diagnostic };
    }

    return presenceResult.kind === "found"
      ? {
          kind: "resolved",
          candidate: {
            entry: starEntry,
            record: importResult.record,
            request: starRequest
          }
        }
      : { kind: "missing" };
  }

  #recordExportsName(
    record: ImportedStaticCssEvalModuleRecord,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState
  ): ImportedStaticCssEvalExportPresenceResult {
    const guardResult = this.#guardResolution(record, request, state);

    if (!guardResult.ok) {
      addResolutionGuardDependencies(state, guardResult.dependencies, request);

      return { kind: "error", diagnostic: guardResult.diagnostic };
    }

    const stackEntry = createImportCycleStackEntry(record, request);
    state.stack.push(stackEntry);

    try {
      if (record.exports.has(request.exportName)) {
        return { kind: "found" };
      }

      if (
        request.exportName === "default" ||
        record.parsedModule.exportStarReexports.length === 0
      ) {
        return { kind: "missing" };
      }

      const candidatesResult = this.#collectExportStarCandidates(
        record,
        request,
        state
      );

      if (candidatesResult.kind === "error") {
        return { kind: "error", diagnostic: candidatesResult.diagnostic };
      }

      const exportNameTable = createStaticCssModuleExportNameTable(
        record.exports,
        createExportStarSources(request.exportName, candidatesResult.candidates)
      );
      const tableEntry = exportNameTable.get(request.exportName);

      if (!tableEntry) {
        return { kind: "missing" };
      }

      switch (tableEntry.kind) {
        case "explicit":
        case "star":
          return { kind: "found" };
        case "ambiguous-star":
          return {
            kind: "error",
            diagnostic: createAmbiguousExportStarDiagnostic(
              record,
              request,
              state,
              candidatesResult.candidates
            )
          };
        default:
          return assertNever(tableEntry);
      }
    } finally {
      state.stack.pop();
    }
  }

  #resolveReexportEntry(
    record: ImportedStaticCssEvalModuleRecord,
    exportEntry: Extract<ExportMapEntry, { kind: "reexport" }>,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState,
    provenance: BindingProvenance
  ): ImportedStaticCssEvalResolutionResult {
    const reexportRequest: ImportedStaticCssEvalResolutionRequest = {
      importer: record.id,
      specifier: exportEntry.source,
      exportName: exportEntry.importedName,
      memberPath: [...request.memberPath],
      dependencyKind: "reexported",
      provenanceKind: "reexported",
      reexportName: formatExportName(exportEntry.exportName)
    };
    const importResult = this.#resolveProviderImport(
      reexportRequest,
      state.owner,
      state
    );

    return importResult.kind === "error"
      ? {
          kind: "error",
          diagnostic: importResult.diagnostic,
          provenance,
          cacheKey: createImportedStaticCssEvalCacheKey(
            state.owner.file,
            record.parsedModule,
            request.exportName,
            request.memberPath,
            record
          )
        }
      : this.#resolveModuleExport(importResult.record, reexportRequest, state);
  }

  #resolveCjsReexportEntry(
    record: ImportedStaticCssEvalModuleRecord,
    exportEntry: Exclude<ExportMapEntry, { kind: "reexport" | "unsupported" }>,
    source: StaticCssEvalCjsRequireSource,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState,
    provenance: BindingProvenance
  ): ImportedStaticCssEvalResolutionResult {
    const reexportParts = createStaticCssEvalCjsReexportRequestParts({
      source,
      queryMemberPath: request.memberPath,
      reexportName: formatExportName(exportEntry.exportName)
    });
    const reexportRequest = createResolutionRequestFromCjsParts(
      record.id,
      reexportParts
    );
    const importResult = this.#resolveProviderImport(
      reexportRequest,
      state.owner,
      state
    );

    return importResult.kind === "error"
      ? {
          kind: "error",
          diagnostic: importResult.diagnostic,
          provenance,
          cacheKey: createImportedStaticCssEvalCacheKey(
            state.owner.file,
            record.parsedModule,
            request.exportName,
            request.memberPath,
            record
          )
        }
      : this.#resolveModuleExport(importResult.record, reexportRequest, state);
  }

  #createMissingExportResult(
    record: ImportedStaticCssEvalModuleRecord,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState
  ): ImportedStaticCssEvalResolutionResult {
    return {
      kind: "error",
      diagnostic: createStaticCssEvalUnresolvedExportDiagnostic(
        {
          owner: state.owner,
          dependency: { file: record.id },
          importPath: request.specifier,
          exportName: request.exportName,
          memberPath: request.memberPath,
          importChain: createResolutionImportChain(state, record.id)
        },
        request.exportName
      ),
      cacheKey: createImportedStaticCssEvalCacheKey(
        state.owner.file,
        record.parsedModule,
        request.exportName,
        request.memberPath,
        record
      )
    };
  }

  #guardResolution(
    record: ImportedStaticCssEvalModuleRecord,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState
  ) {
    const next = {
      file: record.id,
      exportName: request.exportName,
      memberPath: request.memberPath
    };
    const cycleResult = guardStaticCssEvalImportCycle({
      owner: state.owner,
      dependency: { file: record.id },
      importPath: request.specifier,
      exportName: request.exportName,
      memberPath: request.memberPath,
      stack: state.stack,
      next
    });

    if (!cycleResult.ok) {
      return cycleResult;
    }

    return guardStaticCssEvalResolutionDepth({
      owner: state.owner,
      dependency: { file: record.id },
      importPath: request.specifier,
      exportName: request.exportName,
      memberPath: request.memberPath,
      resolutionDepth: state.stack.length + 1
    });
  }

  #createCjsUnsupportedDiagnostic(
    ownerRecord: ImportedStaticCssEvalModuleRecord,
    query: StaticCssEvalQuery
  ): StaticCssEvalDiagnostic | null {
    const bindingName = query.bindingName;

    if (!bindingName) {
      return null;
    }

    const binding = ownerRecord.programPath.scope.getBinding(bindingName);
    const init = binding
      ? getStaticCssEvalConstBindingInitExpression(binding)
      : null;

    const unwrappedInit = init
      ? unwrapTransparentCssRuleExpression(init)
      : null;

    if (
      !unwrappedInit ||
      !containsStaticCssEvalRequireCallExpression(
        unwrappedInit,
        ownerRecord.programPath.scope
      )
    ) {
      return null;
    }

    const context = {
      owner: createQueryOwnerLocation(query),
      ...(query.memberPath ? { memberPath: query.memberPath } : {})
    };

    if (
      !isStaticCssEvalLiteralRequireCallExpression(
        unwrappedInit,
        ownerRecord.programPath.scope
      )
    ) {
      return createStaticCssEvalCjsDynamicRequireUnsupportedDiagnostic(context);
    }

    return createStaticCssEvalCjsUnsupportedDiagnostic(context);
  }

  #resolveImport(
    importerId: string,
    importPath: string
  ): ImportedStaticCssEvalResolvedImport | null {
    const resolvedImport = this.#importResolutions.get(
      createImportResolutionKey(importerId, importPath)
    );

    if (resolvedImport) {
      return resolvedImport;
    }

    const loadedModule = this.#modules.get(importPath);

    return loadedModule
      ? {
          resolvedId: importPath,
          sourceMetadata:
            createStaticCssEvalProviderSourceMetadata(loadedModule)
        }
      : null;
  }

  #getModuleRecord(id: string): ImportedStaticCssEvalModuleRecord | null {
    const cachedRecord = this.#records.get(id);

    if (cachedRecord) {
      return cachedRecord;
    }

    const loadedModule = this.#modules.get(id);

    if (!loadedModule) {
      return null;
    }

    try {
      const record = createImportedStaticCssEvalModuleRecordWithCache(
        loadedModule,
        this.#moduleCache
      );
      this.#records.set(id, record);
      return record;
    } catch (error) {
      this.#parseFailures.set(
        id,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  }
}

function collectModuleImportBindings(
  statement: t.Statement,
  imports: Map<string, ImportedStaticCssEvalImportBinding>
): void {
  if (!t.isImportDeclaration(statement) || statement.importKind === "type") {
    return;
  }

  const importPath = statement.source.value;

  for (const specifier of statement.specifiers) {
    if (t.isImportDefaultSpecifier(specifier)) {
      imports.set(specifier.local.name, {
        kind: "default",
        localName: specifier.local.name,
        importPath,
        importedName: "default"
      });
      continue;
    }

    if (t.isImportSpecifier(specifier) && specifier.importKind !== "type") {
      const importedName = getModuleStringName(specifier.imported);

      if (importedName) {
        imports.set(specifier.local.name, {
          kind: "named",
          localName: specifier.local.name,
          importPath,
          importedName
        });
      }
      continue;
    }

    if (t.isImportNamespaceSpecifier(specifier)) {
      imports.set(specifier.local.name, {
        kind: "namespace",
        localName: specifier.local.name,
        importPath
      });
    }
  }
}

function createInlineStaticCssSourceHash(source: string): string {
  return `inline:${hash(source)}`;
}

function createStaticCssModuleSource(
  loadedModule: ImportedStaticCssEvalLoadedModule
): StaticCssModuleSource {
  return {
    resolvedFile: loadedModule.id,
    source: loadedModule.source,
    sourceHash:
      loadedModule.sourceHash ??
      createInlineStaticCssSourceHash(loadedModule.source),
    ...(loadedModule.version !== undefined
      ? { sourceVersion: loadedModule.version }
      : {})
  };
}

function mergeImportedStaticCssEvalSourceMetadata(
  resolutionMetadata: StaticCssEvalProviderSourceMetadata,
  loadedModule: StaticCssEvalProviderSourcePolicyDescriptor | undefined
): StaticCssEvalProviderSourceMetadata {
  if (!loadedModule) {
    return resolutionMetadata;
  }

  return createStaticCssEvalProviderSourceMetadata({
    sourceKind: loadedModule.sourceKind ?? resolutionMetadata.sourceKind,
    sourceOrigin:
      loadedModule.sourceOrigin ??
      (loadedModule.sourceKind ? undefined : resolutionMetadata.sourceOrigin),
    canonicalModuleId:
      loadedModule.canonicalModuleId ?? resolutionMetadata.canonicalModuleId,
    normalizedPathKey:
      loadedModule.normalizedPathKey ?? resolutionMetadata.normalizedPathKey,
    watchFiles: loadedModule.watchFiles ?? resolutionMetadata.watchFiles,
    unsupportedReason:
      loadedModule.unsupportedReason ?? resolutionMetadata.unsupportedReason
  });
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected imported static css eval value: ${value}`);
}

function createResolutionState(
  owner: StaticCssEvalSourceLocation
): ImportedStaticCssEvalResolutionState {
  return {
    owner,
    dependencies: new Map<string, ResolutionDependency>(),
    resolutionChain: [],
    stack: []
  };
}

function createResolutionRequest(
  query: StaticCssEvalQuery,
  importBinding: ImportedStaticCssEvalImportBinding
):
  | { kind: "resolved"; request: ImportedStaticCssEvalResolutionRequest }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  const queryMemberPath = [...(query.memberPath ?? [])];

  if (importBinding.kind === "namespace") {
    const [exportName, ...memberPath] = queryMemberPath;

    if (exportName === undefined) {
      return {
        kind: "resolved",
        request: {
          importer: query.importerId,
          specifier: importBinding.importPath,
          exportName: null,
          memberPath: [],
          dependencyKind: "namespace-member",
          provenanceKind: "namespace-member",
          namespaceBinding: importBinding.localName,
          wholeNamespace: true
        }
      };
    }

    return {
      kind: "resolved",
      request: {
        importer: query.importerId,
        specifier: importBinding.importPath,
        exportName,
        memberPath,
        dependencyKind: "namespace-member",
        provenanceKind: "namespace-member",
        namespaceBinding: importBinding.localName
      }
    };
  }

  return {
    kind: "resolved",
    request: {
      importer: query.importerId,
      specifier: importBinding.importPath,
      exportName: importBinding.importedName,
      memberPath: queryMemberPath,
      dependencyKind: "imported",
      provenanceKind: "imported"
    }
  };
}

function createCjsResolutionRequest(
  query: StaticCssEvalQuery,
  binding: ImportedStaticCssEvalCjsBinding
): { kind: "resolved"; request: ImportedStaticCssEvalResolutionRequest } {
  const requestParts = createStaticCssEvalCjsImportRequestParts({
    binding,
    queryMemberPath: [...(query.memberPath ?? [])]
  });

  return {
    kind: "resolved",
    request: createResolutionRequestFromCjsParts(query.importerId, requestParts)
  };
}

function createResolutionRequestFromCjsParts(
  importer: string,
  parts: StaticCssEvalCjsResolutionRequestParts
): ImportedStaticCssEvalResolutionRequest {
  return {
    importer,
    specifier: parts.specifier,
    exportName: parts.exportName,
    memberPath: parts.memberPath,
    dependencyKind: parts.dependencyKind,
    provenanceKind: parts.provenanceKind,
    ...(parts.reexportName !== undefined
      ? { reexportName: parts.reexportName }
      : {})
  };
}

function getStaticExportEntryCjsRequireSource(
  record: ImportedStaticCssEvalModuleRecord,
  exportEntry: Exclude<ExportMapEntry, { kind: "reexport" | "unsupported" }>
): StaticCssEvalCjsRequireSource | null {
  return exportEntry.kind === "expression"
    ? getStaticExpressionCjsRequireSource(record, exportEntry.expression)
    : getLocalBindingCjsRequireSource(record, exportEntry.localName, []);
}

function getStaticExpressionCjsRequireSource(
  record: ImportedStaticCssEvalModuleRecord,
  expression: t.Expression
): StaticCssEvalCjsRequireSource | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);
  const directSource = getStaticCssEvalCjsRequireSource(
    unwrappedExpression,
    record.programPath.scope
  );

  if (directSource) {
    return directSource;
  }

  const reference = getStaticCssEvalMemberReference(unwrappedExpression);

  return reference?.kind === "supported"
    ? getLocalBindingCjsRequireSource(
        record,
        reference.bindingName,
        reference.memberPath
      )
    : null;
}

function getLocalBindingCjsRequireSource(
  record: ImportedStaticCssEvalModuleRecord,
  localName: string,
  memberPath: readonly string[]
): StaticCssEvalCjsRequireSource | null {
  const binding = record.programPath.scope.getBinding(localName);
  const expression = binding
    ? getStaticCssEvalConstBindingInitExpression(binding)
    : null;
  const source = getStaticCssEvalCjsRequireSource(
    expression ? unwrapTransparentCssRuleExpression(expression) : null,
    record.programPath.scope
  );

  return source
    ? appendStaticCssEvalCjsRequireSource(source, memberPath)
    : null;
}

function appendStaticCssEvalCjsRequireSource(
  source: StaticCssEvalCjsRequireSource,
  memberPath: readonly string[]
): StaticCssEvalCjsRequireSource {
  return memberPath.length === 0
    ? source
    : {
        importPath: source.importPath,
        propertyPath: [...source.propertyPath, ...memberPath]
      };
}

function resolveStaticExportMapEntry(
  record: ImportedStaticCssEvalModuleRecord,
  exportEntry: Exclude<ExportMapEntry, { kind: "reexport" | "unsupported" }>,
  request: ImportedStaticCssEvalResolutionRequest,
  state: ImportedStaticCssEvalResolutionState,
  provenance: BindingProvenance
): ImportedStaticCssEvalResolutionResult {
  const expressionResult = getStaticExportEntryExpression(record, exportEntry);
  const cacheKey = createImportedStaticCssEvalCacheKey(
    state.owner.file,
    record.parsedModule,
    request.exportName,
    request.memberPath,
    record
  );

  if (expressionResult.kind === "error") {
    return {
      kind: "error",
      diagnostic: expressionResult.diagnostic,
      provenance,
      cacheKey
    };
  }

  const localName = expressionResult.localName;

  if (localName && hasImportedStaticCssBindingMutation(record, localName)) {
    return {
      kind: "error",
      diagnostic: createStaticCssEvalMutatedBindingDiagnostic(
        createImportedDiagnosticContext(record, request, state),
        localName
      ),
      provenance,
      cacheKey
    };
  }

  const memberExpression = resolveStaticObjectMemberPath(
    expressionResult.expression,
    request.memberPath
  );

  if (!memberExpression) {
    return { kind: "not-candidate" };
  }

  const context = createImportedLiteralContext(record, request, state);
  const literalResult = evaluateStaticCssLiteralExpression(
    memberExpression,
    context,
    { count: 0 },
    1
  );

  if (literalResult.kind === "error") {
    return {
      kind: "error",
      diagnostic: literalResult.diagnostic,
      provenance,
      cacheKey
    };
  }

  return {
    kind: "resolved",
    value: literalResult.value,
    provenance,
    cacheKey
  };
}

function getStaticExportEntryExpression(
  record: ImportedStaticCssEvalModuleRecord,
  exportEntry:
    | ExportMapLocalEntry
    | Extract<ExportMapEntry, { kind: "expression" }>
):
  | { kind: "resolved"; expression: t.Expression; localName: string | null }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  if (exportEntry.kind === "expression") {
    const expression = unwrapTransparentCssRuleExpression(
      exportEntry.expression
    );
    const reference = getStaticCssEvalMemberReference(expression);

    if (reference?.kind === "supported") {
      return getLocalBindingExpressionResult(
        record,
        reference.bindingName,
        exportEntry.exportName,
        reference.memberPath
      );
    }

    if (reference?.kind === "unsupported") {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalComputedMemberUnsupportedDiagnostic({
          owner: { file: record.id },
          dependency: { file: record.id },
          exportName: exportEntry.exportName,
          memberPath: reference.memberPath
        })
      };
    }

    return { kind: "resolved", expression, localName: null };
  }

  return getLocalBindingExpressionResult(
    record,
    exportEntry.localName,
    exportEntry.exportName
  );
}

function getLocalBindingExpressionResult(
  record: ImportedStaticCssEvalModuleRecord,
  localName: string,
  exportName: StaticCssEvalExportName,
  memberPath: readonly string[] = []
):
  | { kind: "resolved"; expression: t.Expression; localName: string }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  const binding = record.programPath.scope.getBinding(localName);
  const expression = binding
    ? getStaticCssEvalConstBindingInitExpression(binding)
    : null;

  if (expression) {
    const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);
    const memberExpression = resolveStaticObjectMemberPath(
      unwrappedExpression,
      memberPath
    );

    if (!memberExpression) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          {
            owner: { file: record.id },
            dependency: { file: record.id },
            exportName,
            memberPath
          },
          unwrappedExpression.type
        )
      };
    }

    return {
      kind: "resolved",
      expression: memberExpression,
      localName
    };
  }

  return {
    kind: "error",
    diagnostic: createStaticCssEvalMutableBindingDiagnostic(
      {
        owner: { file: record.id },
        dependency: { file: record.id },
        exportName
      },
      localName
    )
  };
}

function createImportedLiteralContext(
  record: ImportedStaticCssEvalModuleRecord,
  request: ImportedStaticCssEvalResolutionRequest,
  state: ImportedStaticCssEvalResolutionState
): ImportedStaticCssEvalContext {
  return {
    owner: state.owner,
    dependency: { file: record.id },
    importPath: request.specifier,
    exportName: request.exportName,
    memberPath: [...request.memberPath]
  };
}

function createImportedDiagnosticContext(
  record: ImportedStaticCssEvalModuleRecord,
  request: ImportedStaticCssEvalResolutionRequest,
  state: ImportedStaticCssEvalResolutionState
) {
  return {
    owner: state.owner,
    dependency: { file: record.id },
    importPath: request.specifier,
    exportName: request.exportName,
    memberPath: request.memberPath,
    importChain: createResolutionImportChain(state, record.id)
  };
}

function createUnsupportedExportEntryDiagnostic(
  exportEntry: Extract<ExportMapEntry, { kind: "unsupported" }>,
  record: ImportedStaticCssEvalModuleRecord,
  request: ImportedStaticCssEvalResolutionRequest,
  state: ImportedStaticCssEvalResolutionState
): StaticCssEvalDiagnostic {
  const context = createImportedDiagnosticContext(record, request, state);

  if (exportEntry.unsupportedKind === "export-star") {
    return createStaticCssEvalExportStarUnsupportedDiagnostic(
      context,
      exportEntry.source ?? request.specifier
    );
  }

  if (exportEntry.unsupportedKind === "export-namespace") {
    return createStaticCssEvalNamespaceReexportUnsupportedDiagnostic(
      context,
      exportEntry.source ?? request.specifier
    );
  }

  if (exportEntry.unsupportedKind === "cjs-export") {
    return createStaticCssEvalCjsExportUnsupportedDiagnostic(
      context,
      exportEntry.cjsExportMutation ?? exportEntry.declaration.type
    );
  }

  if (exportEntry.unsupportedKind === "cjs-helper") {
    return createStaticCssEvalCjsHelperUnsupportedDiagnostic(
      context,
      exportEntry.cjsHelperName ?? exportEntry.declaration.type
    );
  }

  if (exportEntry.unsupportedKind === "cjs-bundle-runtime") {
    return createStaticCssEvalCjsBundleRuntimeUnsupportedDiagnostic(
      context,
      exportEntry.cjsBundleRuntimeName ?? exportEntry.declaration.type
    );
  }

  return createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
    context,
    exportEntry.declaration.type
  );
}

function getCjsModuleUnsupportedEntry(
  record: ImportedStaticCssEvalModuleRecord
): Extract<ExportMapEntry, { kind: "unsupported" }> | null {
  const entry = record.exports.get(null);

  return entry?.kind === "unsupported" &&
    (entry.unsupportedKind === "cjs-bundle-runtime" ||
      entry.unsupportedKind === "cjs-helper" ||
      entry.unsupportedKind === "cjs-export")
    ? entry
    : null;
}

function createBindingProvenance(
  file: string,
  request: ImportedStaticCssEvalResolutionRequest
): BindingProvenance {
  if (request.provenanceKind === "namespace-member") {
    return {
      kind: "namespace-member",
      file,
      importer: request.importer,
      specifier: request.specifier,
      exportName: request.exportName,
      memberPath: [...request.memberPath],
      namespaceBinding: request.namespaceBinding ?? "<namespace>"
    };
  }

  if (request.provenanceKind === "reexported") {
    return {
      kind: "reexported",
      file,
      importer: request.importer,
      specifier: request.specifier,
      exportName: request.exportName,
      memberPath: [...request.memberPath],
      reexportName: request.reexportName ?? formatExportName(request.exportName)
    };
  }

  return {
    kind: "imported",
    file,
    importer: request.importer,
    specifier: request.specifier,
    exportName: request.exportName,
    memberPath: [...request.memberPath]
  };
}

function createImportedStaticCssEvalCacheKey(
  importerFile: string,
  parsedModule: ParsedStaticCssModule,
  exportName: StaticCssEvalExportName,
  memberPath: readonly string[],
  sourceMetadata?: StaticCssEvalProviderSourcePolicyDescriptor
): StaticCssEvalCacheKey {
  return {
    importerFile,
    resolvedFile: parsedModule.resolvedFile,
    exportName,
    memberPath: [...memberPath],
    sourceHash: parsedModule.sourceHash,
    ...(parsedModule.sourceVersion !== undefined
      ? { sourceVersion: parsedModule.sourceVersion }
      : {}),
    pluginOptionsVersion: "static-css-eval-provider:v1",
    resolverOptionsVersion: "static-css-eval-provider:v1",
    parserVersion: parsedModule.cacheKey.parserVersion,
    staticEvalSupportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION,
    resolvedId: parsedModule.resolvedFile,
    ...(sourceMetadata
      ? createStaticCssEvalProviderSourceMetadata(sourceMetadata)
      : {}),
    parserOptions: parsedModule.cacheKey.parserOptions
  };
}

function createImportedStaticCssEvalResolvedResult(options: {
  query: StaticCssEvalQuery;
  value: StaticCssLiteral;
  provenance: BindingProvenance;
  cacheKey: StaticCssEvalCacheKey;
  state: ImportedStaticCssEvalResolutionState;
}): StaticCssEvalResult {
  return {
    kind: "resolved",
    status: "resolved",
    expression: formatStaticCssEvalQueryExpression(options.query),
    value: options.value,
    provenance: options.provenance,
    dependencies: getResolutionDependencies(options.state),
    resolutionChain: [...options.state.resolutionChain],
    diagnostics: [],
    cacheKey: options.cacheKey
  };
}

function createImportedStaticCssEvalErrorResult(options: {
  query: StaticCssEvalQuery;
  diagnostic: StaticCssEvalDiagnostic;
  state: ImportedStaticCssEvalResolutionState;
  provenance?: BindingProvenance;
  cacheKey?: StaticCssEvalCacheKey;
}): StaticCssEvalResult {
  return {
    kind: "error",
    status: "error",
    expression: formatStaticCssEvalQueryExpression(options.query),
    ...(options.provenance ? { provenance: options.provenance } : {}),
    dependencies: getResolutionDependencies(options.state),
    resolutionChain: [...options.state.resolutionChain],
    diagnostic: options.diagnostic,
    diagnostics: [options.diagnostic],
    ...(options.cacheKey ? { cacheKey: options.cacheKey } : {})
  };
}

function addResolutionDependency(
  state: ImportedStaticCssEvalResolutionState,
  dependency: ResolutionDependency
): void {
  const key = createResolutionDependencyKey(dependency);
  const existing = state.dependencies.get(key);

  state.dependencies.set(key, {
    ...dependency,
    ...(existing
      ? {
          kind: mergeResolutionDependencyKind(existing.kind, dependency.kind),
          inspected: existing.inspected || dependency.inspected,
          contributed: existing.contributed || dependency.contributed
        }
      : {})
  });
}

function updateResolutionDependencyKind(
  state: ImportedStaticCssEvalResolutionState,
  file: string,
  kind: ResolutionDependencyKind
): void {
  for (const [key, dependency] of state.dependencies) {
    if (dependency.file === file) {
      state.dependencies.set(key, {
        ...dependency,
        kind: mergeResolutionDependencyKind(dependency.kind, kind)
      });
    }
  }
}

function markResolutionDependencyInspected(
  state: ImportedStaticCssEvalResolutionState,
  file: string
): void {
  for (const [key, dependency] of state.dependencies) {
    if (dependency.file === file) {
      state.dependencies.set(key, { ...dependency, inspected: true });
    }
  }
}

function markResolutionDependenciesContributed(
  state: ImportedStaticCssEvalResolutionState
): void {
  for (const [key, dependency] of state.dependencies) {
    state.dependencies.set(key, {
      ...dependency,
      contributed: dependency.inspected && dependency.kind !== "unresolved"
    });
  }
}

function getResolutionDependencies(
  state: ImportedStaticCssEvalResolutionState
): ResolutionDependency[] {
  return [...state.dependencies.values()].map((dependency) => ({
    ...dependency,
    memberPath: [...dependency.memberPath],
    ...(dependency.watchFiles ? { watchFiles: [...dependency.watchFiles] } : {})
  }));
}

function createResolutionDependencyKey(
  dependency: ResolutionDependency
): string {
  return JSON.stringify([
    dependency.file,
    dependency.importer,
    dependency.specifier,
    dependency.exportName,
    dependency.memberPath
  ]);
}

function mergeResolutionDependencyKind(
  previous: ResolutionDependencyKind,
  next: ResolutionDependencyKind
): ResolutionDependencyKind {
  if (previous === "unresolved" || next === "unresolved") {
    return next === "unresolved" ? previous : next;
  }

  if (previous === "reexported" || next === "reexported") {
    return "reexported";
  }

  if (previous === "namespace-member" || next === "namespace-member") {
    return "namespace-member";
  }

  return next;
}

function createImportCycleStackEntry(
  record: ImportedStaticCssEvalModuleRecord,
  request: ImportedStaticCssEvalResolutionRequest
): StaticCssEvalImportCycleKey {
  return {
    file: record.id,
    exportName: request.exportName,
    memberPath: [...request.memberPath]
  };
}

function createExportStarRequest(
  record: ImportedStaticCssEvalModuleRecord,
  starEntry: ExportGraphStarReexportEntry,
  request: ImportedStaticCssEvalResolutionRequest
): ImportedStaticCssEvalResolutionRequest {
  return {
    importer: record.id,
    specifier: starEntry.source,
    exportName: request.exportName,
    memberPath: [...request.memberPath],
    dependencyKind: "reexported",
    provenanceKind: "reexported",
    reexportName: formatExportName(request.exportName)
  };
}

function createExportStarSources(
  exportName: StaticCssEvalExportName,
  candidates: readonly ImportedStaticCssEvalExportStarCandidate[]
): StaticCssModuleExportStarSource[] {
  return candidates.map((candidate) => ({
    entry: candidate.entry,
    exportNames: [exportName]
  }));
}

function createNamespaceExplicitExportMap(
  exports: ReadonlyMap<StaticCssEvalExportName, ExportMapEntry>,
  includeDefaultExport: boolean
): ReadonlyMap<StaticCssEvalExportName, ExportMapEntry> {
  const namespaceExports = new Map<StaticCssEvalExportName, ExportMapEntry>();

  for (const [exportName, exportEntry] of exports) {
    if (exportName === null) {
      continue;
    }

    if (!includeDefaultExport && exportName === "default") {
      continue;
    }

    namespaceExports.set(exportName, exportEntry);
  }

  return namespaceExports;
}

function addResolutionGuardDependencies(
  state: ImportedStaticCssEvalResolutionState,
  dependencies: readonly string[],
  request: ImportedStaticCssEvalResolutionRequest
): void {
  for (const file of dependencies) {
    addResolutionDependency(state, {
      file,
      kind: request.dependencyKind,
      importer: request.importer,
      specifier: request.specifier,
      exportName: request.exportName,
      memberPath: [...request.memberPath],
      inspected: true,
      contributed: false
    });
  }
}

function createAmbiguousExportStarDiagnostic(
  record: ImportedStaticCssEvalModuleRecord,
  request: ImportedStaticCssEvalResolutionRequest,
  state: ImportedStaticCssEvalResolutionState,
  candidates: readonly ImportedStaticCssEvalExportStarCandidate[]
): StaticCssEvalDiagnostic {
  return createStaticCssEvalAmbiguousExportStarDiagnostic(
    {
      owner: state.owner,
      dependency: { file: record.id },
      importPath: request.specifier,
      exportName: request.exportName,
      memberPath: request.memberPath,
      importChain: createAmbiguousExportStarImportChain(
        state,
        request,
        candidates
      )
    },
    request.exportName
  );
}

function createAmbiguousExportStarImportChain(
  state: ImportedStaticCssEvalResolutionState,
  request: ImportedStaticCssEvalResolutionRequest,
  candidates: readonly ImportedStaticCssEvalExportStarCandidate[]
): string[] {
  return [
    state.owner.file,
    ...state.stack.map(formatStaticCssEvalResolutionFrame),
    ...candidates.map(
      (candidate) =>
        `${candidate.record.id}#${formatExportName(request.exportName)}`
    )
  ];
}

function createResolutionImportChain(
  state: ImportedStaticCssEvalResolutionState,
  nextFile: string
): string[] {
  return [
    state.owner.file,
    ...state.stack.map(formatStaticCssEvalResolutionFrame),
    nextFile
  ];
}

function formatStaticCssEvalResolutionFrame(
  frame: StaticCssEvalImportCycleKey
): string {
  const memberPath = frame.memberPath?.length
    ? `.${frame.memberPath.join(".")}`
    : "";

  return `${frame.file}#${formatExportName(frame.exportName)}${memberPath}`;
}

function formatStaticCssEvalQueryExpression(query: StaticCssEvalQuery): string {
  const bindingName = query.bindingName ?? "<unknown>";
  const memberPath = query.memberPath?.length
    ? `.${query.memberPath.join(".")}`
    : "";

  return `${bindingName}${memberPath}`;
}

function hasImportedStaticCssBindingMutation(
  record: ImportedStaticCssEvalModuleRecord,
  localName: string
): boolean {
  const binding = record.programPath.scope.getBinding(localName);

  return binding
    ? hasStaticCssEvalBindingMutation(record.programPath, binding)
    : false;
}

function resolveStaticObjectMemberPath(
  expression: t.Expression,
  memberPath: readonly string[]
): t.Expression | null {
  let currentExpression: t.Expression | null =
    unwrapTransparentCssRuleExpression(expression);

  for (const memberName of memberPath) {
    if (!currentExpression) {
      return null;
    }

    const unwrappedExpression =
      unwrapTransparentCssRuleExpression(currentExpression);

    if (!t.isObjectExpression(unwrappedExpression)) {
      return null;
    }

    currentExpression = getStaticObjectMemberValue(
      unwrappedExpression,
      memberName
    );
  }

  return currentExpression
    ? unwrapTransparentCssRuleExpression(currentExpression)
    : null;
}

function evaluateStaticCssLiteralExpression(
  expression: t.Expression,
  context: ImportedStaticCssEvalContext,
  state: StaticCssLiteralValidationState,
  depth: number
):
  | { kind: "resolved"; value: StaticCssLiteral }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);
  state.count += 1;

  const countResult = enforceImportedStaticCssEvalLiteralCount(context, state);

  if (countResult) {
    return { kind: "error", diagnostic: countResult };
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    const depthResult = enforceImportedStaticCssEvalDepth(context, depth);

    if (depthResult) {
      return { kind: "error", diagnostic: depthResult };
    }

    return evaluateStaticCssObjectExpression(
      unwrappedExpression,
      context,
      state,
      depth
    );
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    const depthResult = enforceImportedStaticCssEvalDepth(context, depth);

    if (depthResult) {
      return { kind: "error", diagnostic: depthResult };
    }

    return evaluateStaticCssArrayExpression(
      unwrappedExpression,
      context,
      state,
      depth
    );
  }

  if (t.isStringLiteral(unwrappedExpression)) {
    return { kind: "resolved", value: unwrappedExpression.value };
  }

  if (t.isNumericLiteral(unwrappedExpression)) {
    return { kind: "resolved", value: unwrappedExpression.value };
  }

  if (t.isBooleanLiteral(unwrappedExpression)) {
    return { kind: "resolved", value: unwrappedExpression.value };
  }

  if (t.isNullLiteral(unwrappedExpression)) {
    return { kind: "resolved", value: null };
  }

  if (
    t.isUnaryExpression(unwrappedExpression) &&
    (unwrappedExpression.operator === "+" ||
      unwrappedExpression.operator === "-") &&
    t.isNumericLiteral(unwrappedExpression.argument)
  ) {
    return {
      kind: "resolved",
      value:
        unwrappedExpression.operator === "-"
          ? -unwrappedExpression.argument.value
          : unwrappedExpression.argument.value
    };
  }

  if (
    t.isTemplateLiteral(unwrappedExpression) &&
    unwrappedExpression.expressions.length === 0
  ) {
    const [quasi] = unwrappedExpression.quasis;
    return {
      kind: "resolved",
      value: quasi?.value.cooked ?? quasi?.value.raw ?? ""
    };
  }

  return {
    kind: "error",
    diagnostic: createImportedStaticCssEvalDiagnostic({
      ...context,
      code: "unsupported-syntax",
      reason: getUnsupportedLiteralReason(unwrappedExpression),
      detail: createUnsupportedLiteralDetail(
        context.exportName,
        unwrappedExpression
      )
    })
  };
}

function evaluateStaticCssObjectExpression(
  expression: t.ObjectExpression,
  context: ImportedStaticCssEvalContext,
  state: StaticCssLiteralValidationState,
  depth: number
):
  | { kind: "resolved"; value: StaticCssLiteral }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  const value: Record<string, StaticCssLiteral> = {};

  for (const property of expression.properties) {
    if (t.isSpreadElement(property)) {
      return createStaticCssLiteralError(
        context,
        "object-or-array-spread",
        `imported export "${formatExportName(
          context.exportName
        )}" contains an object spread`
      );
    }

    if (!t.isObjectProperty(property)) {
      return createStaticCssLiteralError(
        context,
        "function-or-call",
        `imported export "${formatExportName(
          context.exportName
        )}" contains an object method`
      );
    }

    if (property.computed) {
      return createStaticCssLiteralError(
        context,
        "computed-object-key",
        `imported export "${formatExportName(
          context.exportName
        )}" contains a computed object key`
      );
    }

    if (!t.isExpression(property.value)) {
      return createStaticCssLiteralError(
        context,
        "unsupported-literal",
        `imported export "${formatExportName(
          context.exportName
        )}" contains a non-expression object value`
      );
    }

    const propertyName = getStaticObjectPropertyName(property.key);

    if (!propertyName) {
      return createStaticCssLiteralError(
        context,
        "unsupported-literal",
        `imported export "${formatExportName(
          context.exportName
        )}" contains an unsupported object key`
      );
    }

    const propertyResult = evaluateStaticCssLiteralExpression(
      property.value,
      context,
      state,
      depth + 1
    );

    if (propertyResult.kind === "error") {
      return propertyResult;
    }

    value[propertyName] = propertyResult.value;
  }

  return { kind: "resolved", value };
}

function evaluateStaticCssArrayExpression(
  expression: t.ArrayExpression,
  context: ImportedStaticCssEvalContext,
  state: StaticCssLiteralValidationState,
  depth: number
):
  | { kind: "resolved"; value: StaticCssLiteral }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  const value: StaticCssLiteral[] = [];

  for (const element of expression.elements) {
    if (!element) {
      return createStaticCssLiteralError(
        context,
        "unsupported-literal",
        `imported export "${formatExportName(
          context.exportName
        )}" contains an array hole`
      );
    }

    if (t.isSpreadElement(element)) {
      return createStaticCssLiteralError(
        context,
        "object-or-array-spread",
        `imported export "${formatExportName(
          context.exportName
        )}" contains an array spread`
      );
    }

    const elementResult = evaluateStaticCssLiteralExpression(
      element,
      context,
      state,
      depth + 1
    );

    if (elementResult.kind === "error") {
      return elementResult;
    }

    value.push(elementResult.value);
  }

  return { kind: "resolved", value };
}

function findUnsupportedImportedObjectReferenceDiagnostic(
  expression: t.ObjectExpression,
  options: {
    ownerFile: string;
    provider: StaticCssEvalProvider;
    includeSupportedReferenceErrors?: boolean;
  }
): StaticCssEvalDiagnostic | null {
  for (const property of expression.properties) {
    if (!t.isObjectProperty(property) || !t.isExpression(property.value)) {
      continue;
    }

    const diagnostic = findUnsupportedImportedExpressionReferenceDiagnostic(
      property.value,
      options
    );

    if (diagnostic) {
      return diagnostic;
    }
  }

  return null;
}

function findUnsupportedImportedArrayReferenceDiagnostic(
  expression: t.ArrayExpression,
  options: {
    ownerFile: string;
    provider: StaticCssEvalProvider;
    includeSupportedReferenceErrors?: boolean;
  }
): StaticCssEvalDiagnostic | null {
  for (const element of expression.elements) {
    if (!element || t.isSpreadElement(element)) {
      continue;
    }

    const diagnostic = findUnsupportedImportedExpressionReferenceDiagnostic(
      element,
      options
    );

    if (diagnostic) {
      return diagnostic;
    }
  }

  return null;
}

function findUnsupportedImportedExpressionReferenceDiagnostic(
  expression: t.Expression,
  options: {
    ownerFile: string;
    provider: StaticCssEvalProvider;
    includeSupportedReferenceErrors?: boolean;
  }
): StaticCssEvalDiagnostic | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);
  const reference = getStaticCssEvalMemberReference(unwrappedExpression);

  if (reference?.kind === "unsupported") {
    const result = options.provider.getResolvedCssValue({
      importerId: options.ownerFile,
      expressionStart: unwrappedExpression.start ?? 0,
      expressionEnd: unwrappedExpression.end ?? 0,
      bindingName: reference.bindingName,
      ...(reference.memberPath.length > 0
        ? { memberPath: reference.memberPath }
        : {})
    });

    if (result.kind === "not-candidate") {
      return null;
    }

    if (reference.reason === "dynamic-member-path") {
      return createStaticCssEvalComputedMemberUnsupportedDiagnostic({
        owner: createExpressionOwnerLocation(
          unwrappedExpression,
          options.ownerFile
        ),
        memberPath: reference.memberPath
      });
    }

    return result.kind === "error"
      ? result.diagnostic
      : createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          {
            owner: createExpressionOwnerLocation(
              unwrappedExpression,
              options.ownerFile
            )
          },
          reference.detail
        );
  }

  const candidate = createStaticCssEvalCandidate(
    unwrappedExpression,
    options.ownerFile
  );

  if (
    options.includeSupportedReferenceErrors !== false &&
    candidate?.bindingName
  ) {
    const result = options.provider.getResolvedCssValue(candidate);

    if (result.kind === "error") {
      return result.diagnostic;
    }
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    return findUnsupportedImportedObjectReferenceDiagnostic(
      unwrappedExpression,
      options
    );
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return findUnsupportedImportedArrayReferenceDiagnostic(
      unwrappedExpression,
      options
    );
  }

  return null;
}

function enforceImportedStaticCssEvalDepth(
  context: ImportedStaticCssEvalContext,
  depth: number
): StaticCssEvalDiagnostic | null {
  const result = enforceStaticCssEvalObjectArrayRecursionDepth({
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    recursionDepth: depth
  });

  return result.ok ? null : result.diagnostic;
}

function enforceImportedStaticCssEvalLiteralCount(
  context: ImportedStaticCssEvalContext,
  state: StaticCssLiteralValidationState
): StaticCssEvalDiagnostic | null {
  const result = enforceStaticCssEvalLiteralNodeCount({
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    literalNodeCount: state.count
  });

  return result.ok ? null : result.diagnostic;
}

function createStaticCssLiteralError(
  context: ImportedStaticCssEvalContext,
  reason: StaticCssEvalUnsupportedReason,
  detail: string
): { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  return {
    kind: "error",
    diagnostic: createImportedStaticCssEvalDiagnostic({
      ...context,
      code: "unsupported-syntax",
      reason,
      detail
    })
  };
}

function createImportedStaticCssEvalDiagnostic(
  options: ImportedStaticCssEvalContext & {
    code: StaticCssEvalDiagnostic["code"];
    reason: StaticCssEvalUnsupportedReason;
    detail: string;
  }
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    code: options.code,
    reason: options.reason,
    detail: options.detail,
    owner: options.owner,
    dependency: options.dependency,
    importPath: options.importPath,
    exportName: options.exportName,
    memberPath: options.memberPath,
    importChain: [
      options.owner.file,
      `${options.dependency.file}#${formatExportName(options.exportName)}${
        options.memberPath.length > 0 ? `.${options.memberPath.join(".")}` : ""
      }`
    ]
  });
}

function createQueryOwnerLocation(
  query: StaticCssEvalQuery
): StaticCssEvalSourceLocation {
  return {
    file: query.importerId,
    start: query.expressionStart,
    end: query.expressionEnd
  };
}

function createExpressionOwnerLocation(
  expression: t.Expression,
  ownerFile: string
): StaticCssEvalSourceLocation {
  return {
    file: ownerFile,
    ...(typeof expression.start === "number"
      ? { start: expression.start }
      : {}),
    ...(typeof expression.end === "number" ? { end: expression.end } : {})
  };
}

function getModuleStringName(
  node: t.Identifier | t.StringLiteral
): string | null {
  if (t.isIdentifier(node)) {
    return node.name;
  }

  if (t.isStringLiteral(node)) {
    return node.value;
  }

  return null;
}

function createUnsupportedLiteralDetail(
  exportName: StaticCssEvalExportName,
  expression: t.Expression
): string {
  if (getUnsupportedLiteralReason(expression) === "dynamic-import") {
    return `imported export "${formatExportName(exportName)}" contains a dynamic import`;
  }

  return `imported export "${formatExportName(
    exportName
  )}" contains unsupported ${expression.type}`;
}
function isStaticCssRuleLiteralValue(
  value: StaticCssLiteral
): value is StaticCssLiteral[] | { [key: string]: StaticCssLiteral } {
  return value !== null && typeof value === "object";
}

function formatExportName(exportName: StaticCssEvalExportName): string {
  return exportName === null ? "<local>" : exportName;
}

function createImportResolutionKey(
  importerId: string,
  importPath: string
): string {
  return `${importerId}${importResolutionKeySeparator}${importPath}`;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;

  const ownerId = "/project/src/App.tsx";
  const stylesId = "/project/src/styles.ts";
  const barrelId = "/project/src/barrel.ts";
  const buttonId = "/project/src/button.ts";
  const packageBarrelId = "pkg:@scope/styles";
  const packageLeafId = "pkg:@scope/styles/leaf";
  const packageDataId = "data:@scope/styles/tokens";
  const packageJsonId = "data:@scope/styles/theme.json";
  const packageRawId = "data:@scope/styles/tokens.css?raw";
  const packageWasmUrlId = "data:@scope/styles/icon.wasm?url";
  const providerVirtualId = "virtual:mincho-styles";

  function createProviderFromModules(options: {
    modules: readonly ImportedStaticCssEvalLoadedModule[];
    importResolutions: readonly ImportedStaticCssEvalImportResolution[];
    moduleCache?: StaticCssModuleCache;
  }): StaticCssEvalProvider {
    const resolver = new ImportedStaticCssEvalResolver(options);

    return {
      getResolvedCssValue(query) {
        return resolver.resolve(query);
      }
    };
  }

  function createCountingStaticCssModuleCache(): {
    cache: StaticCssModuleCache;
    missesByFile: ReadonlyMap<string, number>;
  } {
    const delegate = createStaticCssModuleCache();
    const seenKeys = new Set<string>();
    const missesByFile = new Map<string, number>();
    const cache: StaticCssModuleCache = {
      getParsedModule(source) {
        const key = formatExportMapCacheKey(createExportMapCacheKey(source));

        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          missesByFile.set(
            source.resolvedFile,
            (missesByFile.get(source.resolvedFile) ?? 0) + 1
          );
        }

        return delegate.getParsedModule(source);
      },
      getExportMap(source) {
        return cache.getParsedModule(source).exportMap;
      },
      getExportMapEntry(source, exportName) {
        return cache.getParsedModule(source).exportMap.get(exportName) ?? null;
      }
    };

    return { cache, missesByFile };
  }

  type ResolvedStaticCssEvalResultWithMetadata = {
    kind: "resolved";
    value: StaticCssLiteral;
    cacheKey: StaticCssEvalCacheKey;
    dependencies: ResolutionDependency[];
  };

  function expectResolvedResult(
    result: StaticCssEvalResult
  ): ResolvedStaticCssEvalResultWithMetadata {
    expect(result.kind).toBe("resolved");

    if (result.kind !== "resolved") {
      throw new Error("Expected static css eval result to resolve");
    }

    if (!("cacheKey" in result)) {
      throw new Error(
        "Expected resolved static css eval result to include cache key"
      );
    }

    if (
      !Array.isArray(result.dependencies) ||
      result.dependencies.some((dependency) => typeof dependency === "string")
    ) {
      throw new Error(
        "Expected resolved static css eval result dependencies metadata"
      );
    }

    return result as ResolvedStaticCssEvalResultWithMetadata;
  }

  function createProvider(
    stylesSource: string,
    ownerSource = `import { button } from "./styles"; <div css={button} />;`,
    barrelSource = `export { button } from "./styles";`,
    extraModules: readonly ImportedStaticCssEvalLoadedModule[] = [],
    extraImportResolutions: readonly ImportedStaticCssEvalImportResolution[] = []
  ): StaticCssEvalProvider {
    return createProviderFromModules({
      modules: [
        { id: ownerId, source: ownerSource },
        { id: stylesId, source: stylesSource },
        {
          id: barrelId,
          source: barrelSource
        },
        ...extraModules
      ],
      importResolutions: [
        { importerId: ownerId, importPath: "./styles", resolvedId: stylesId },
        { importerId: ownerId, importPath: "./barrel", resolvedId: barrelId },
        { importerId: barrelId, importPath: "./styles", resolvedId: stylesId },
        ...extraImportResolutions
      ]
    });
  }

  function resolveFixture(
    provider: StaticCssEvalProvider,
    bindingName: string,
    memberPath: string[] = []
  ): StaticCssEvalResult {
    return provider.getResolvedCssValue({
      importerId: ownerId,
      expressionStart: 0,
      expressionEnd: bindingName.length,
      bindingName,
      ...(memberPath.length > 0 ? { memberPath } : {})
    });
  }

  type CjsUnsupportedFixture = {
    readonly stylesSource: string;
    readonly ownerSource: string;
    readonly bindingName: string;
    readonly expectedDiagnosticId: StaticCssEvalDiagnosticId;
    readonly memberPath?: readonly string[];
  };

  function expectCjsUnsupportedFixture(fixture: CjsUnsupportedFixture): void {
    expect(
      resolveFixture(
        createProvider(fixture.stylesSource, fixture.ownerSource),
        fixture.bindingName,
        [...(fixture.memberPath ?? [])]
      )
    ).toMatchObject({
      kind: "error",
      diagnostic: { id: fixture.expectedDiagnosticId }
    });
  }

  function createEsbuildHelperSource(copyPropsSource: string): string {
    return `
      var __defProp = Object.defineProperty;
      var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
      var __getOwnPropNames = Object.getOwnPropertyNames;
      var __hasOwnProp = Object.prototype.hasOwnProperty;
      var __export = (target, all) => {
        for (var name in all)
          __defProp(target, name, { get: all[name], enumerable: true });
      };
      ${copyPropsSource}
      var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
    `;
  }

  function createEsbuildCopyPropsHelperSource(): string {
    return `
      var __copyProps = (to, from, except, desc) => {
        if (from && typeof from === "object" || typeof from === "function") {
          for (let key of __getOwnPropNames(from))
            if (!__hasOwnProp.call(to, key) && key !== except)
              __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
        }
        return to;
      };
    `;
  }

  describe("imported static css eval module records", () => {
    it("matches parser plugins to the loaded module extension", () => {
      expect(() =>
        createImportedStaticCssEvalModuleRecord({
          id: "/project/src/styles.ts",
          source: `export const value = <number>1;`
        })
      ).not.toThrow();

      expect(() =>
        createImportedStaticCssEvalModuleRecord({
          id: "/project/src/styles.js",
          source: `export const value: number = 1;`
        })
      ).toThrow();

      expect(() =>
        createImportedStaticCssEvalModuleRecord({
          id: "/project/src/styles.jsx",
          source: `export const value = <div />;`
        })
      ).not.toThrow();
    });

    it("derives matching module and cache hashes from inline source content", () => {
      const red = createImportedStaticCssEvalModuleRecord({
        id: stylesId,
        source: `export const value = "red";`
      });
      const sky = createImportedStaticCssEvalModuleRecord({
        id: stylesId,
        source: `export const value = "sky";`
      });

      expect(red.sourceHash).toMatch(/^inline:[a-z0-9]+$/);
      expect(red.sourceHash).toBe(red.parsedModule.sourceHash);
      expect(red.sourceHash).not.toBe(sky.sourceHash);
    });

    it("collects literal CommonJS require bindings into module records", () => {
      const record = createImportedStaticCssEvalModuleRecord({
        id: ownerId,
        source: `
          import type { ThemeTokens } from "./styles";

          const styles = require("./styles");
          const memberButton = require("./styles").button;
          const memberDefault = require("./styles").default;
          const { button, card: cardStyle } = require("./styles");
        `
      });

      expect(record.imports.has("ThemeTokens")).toBe(false);
      expect([...record.cjsImports.entries()]).toEqual([
        [
          "styles",
          {
            kind: "cjs-module",
            localName: "styles",
            importPath: "./styles",
            propertyPath: []
          }
        ],
        [
          "memberButton",
          {
            kind: "cjs-member",
            localName: "memberButton",
            importPath: "./styles",
            propertyPath: ["button"]
          }
        ],
        [
          "memberDefault",
          {
            kind: "cjs-member",
            localName: "memberDefault",
            importPath: "./styles",
            propertyPath: ["default"]
          }
        ],
        [
          "button",
          {
            kind: "cjs-destructured",
            localName: "button",
            importPath: "./styles",
            propertyPath: ["button"]
          }
        ],
        [
          "cardStyle",
          {
            kind: "cjs-destructured",
            localName: "cardStyle",
            importPath: "./styles",
            propertyPath: ["card"]
          }
        ]
      ]);
    });

    it("ignores literal CommonJS require when require is locally bound", () => {
      const record = createImportedStaticCssEvalModuleRecord({
        id: ownerId,
        source: `const require = makeRequire(); const styles = require("./styles");`
      });
      const provider = createProvider(
        `export const button = { color: "red" } as const;`,
        `const require = makeRequire(); const styles = require("./styles"); <div css={styles.button} />;`
      );

      expect(record.cjsImports.has("styles")).toBe(false);
      expect(resolveFixture(provider, "styles", ["button"])).toEqual({
        kind: "not-candidate"
      });
    });

    it("resolves named, aliased, default object, default const, and same-module export aliases", () => {
      expect(
        resolveFixture(
          createProvider(`export const button = { color: "red" } as const;`),
          "button"
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        provenance: { kind: "imported", file: stylesId, exportName: "button" },
        dependencies: [
          {
            file: stylesId,
            kind: "imported",
            importer: ownerId,
            specifier: "./styles",
            exportName: "button",
            memberPath: [],
            inspected: true,
            contributed: true
          }
        ]
      });

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import { button as buttonStyle } from "./styles"; <div css={buttonStyle} />;`
          ),
          "buttonStyle"
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "red" }
      });

      expect(
        resolveFixture(
          createProvider(
            `export default { color: "blue" } as const;`,
            `import styles from "./styles"; <div css={styles} />;`
          ),
          "styles"
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "blue" }
      });

      expect(
        resolveFixture(
          createProvider(
            `const button = { color: "green" } as const; export default button;`,
            `import styles from "./styles"; <div css={styles} />;`
          ),
          "styles"
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "green" }
      });

      expect(
        resolveFixture(
          createProvider(
            `const x = { color: "orange" } as const; export { x as y };`,
            `import { y } from "./styles"; <div css={y} />;`
          ),
          "y"
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "orange" }
      });
    });

    it("resolves nested member paths over imported static objects", () => {
      expect(
        resolveFixture(
          createProvider(
            `export const styles = { button: { primary: { color: "red" } } } as const;`,
            `import { styles } from "./styles"; <div css={styles.button.primary} />;`
          ),
          "styles",
          ["button", "primary"]
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "red" }
      });
    });

    it("resolves direct named reexport chains with inspected dependency metadata", () => {
      const result = resolveFixture(
        createProvider(
          `export const button = { color: "red" } as const;`,
          `import { button } from "./barrel"; <div css={button} />;`
        ),
        "button"
      );

      expect(result).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        provenance: {
          kind: "reexported",
          file: stylesId,
          exportName: "button"
        },
        dependencies: [
          {
            file: barrelId,
            kind: "reexported",
            inspected: true,
            contributed: true
          },
          {
            file: stylesId,
            kind: "reexported",
            inspected: true,
            contributed: true
          }
        ],
        resolutionChain: [
          { importer: ownerId, source: barrelId, exportName: "button" },
          { importer: barrelId, source: stylesId, exportName: "button" }
        ]
      });
    });

    it("resolves named reexport through export star barrel with dependency metadata", () => {
      const result = resolveFixture(
        createProvider(
          `export const button = { color: "red" } as const;`,
          `import { button } from "./barrel"; <div css={button} />;`,
          `export * from "./styles";`
        ),
        "button"
      );

      expect(result).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        provenance: {
          kind: "reexported",
          file: stylesId,
          exportName: "button"
        },
        dependencies: [
          {
            file: barrelId,
            kind: "reexported",
            inspected: true,
            contributed: true
          },
          {
            file: stylesId,
            kind: "reexported",
            inspected: true,
            contributed: true
          }
        ],
        resolutionChain: [
          { importer: ownerId, source: barrelId, exportName: "button" },
          { importer: barrelId, source: stylesId, exportName: "button" }
        ]
      });
    });

    it("resolves namespace members through export star barrels", () => {
      const result = resolveFixture(
        createProvider(
          `export const button = { color: "red" } as const;`,
          `import * as styles from "./barrel"; <div css={styles.button} />;`,
          `export * from "./styles";`
        ),
        "styles",
        ["button"]
      );

      expect(result).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        dependencies: [
          {
            file: barrelId,
            inspected: true,
            contributed: true
          },
          {
            file: stylesId,
            inspected: true,
            contributed: true
          }
        ],
        resolutionChain: [
          { importer: ownerId, source: barrelId, exportName: "button" },
          { importer: barrelId, source: stylesId, exportName: "button" }
        ]
      });
    });

    it("keeps export star default semantics ESM-accurate for namespace members", () => {
      expect(
        resolveFixture(
          createProvider(
            `export default { color: "red" } as const;`,
            `import * as styles from "./barrel"; <div css={styles.default} />;`,
            `export * from "./styles";`
          ),
          "styles",
          ["default"]
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT",
          exportName: "default"
        },
        dependencies: [{ file: barrelId, inspected: true, contributed: false }]
      });

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import * as styles from "./barrel"; <div css={styles.default} />;`,
            `export default { color: "blue" } as const; export * from "./styles";`
          ),
          "styles",
          ["default"]
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "blue" }
      });

      expect(
        resolveFixture(
          createProvider(
            `export default { color: "green" } as const;`,
            `import * as styles from "./barrel"; <div css={styles.root} />;`,
            `export { default as root } from "./styles"; export * from "./styles";`
          ),
          "styles",
          ["root"]
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "green" },
        provenance: {
          kind: "reexported",
          file: stylesId,
          exportName: "default",
          reexportName: "root"
        }
      });
    });

    it("resolves package provider named default namespace reexport export-star json raw and wasm imports", () => {
      const provider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `
              import rootDefault, { button, dataToken } from "@scope/styles";
              import * as styles from "@scope/styles";
              import theme, { jsonButton } from "@scope/styles/theme.json";
              import rawToken from "@scope/styles/tokens.css?raw";
              import wasmUrl from "@scope/styles/icon.wasm?url";
              import virtualDefault from "virtual:mincho-styles";
              <>
                <div css={button} />
                <div css={rootDefault} />
                <div css={dataToken} />
                <div css={styles.reexported} />
                <div css={styles.default} />
                <div css={jsonButton} />
                <div css={theme.card} />
                <div css={rawToken} />
                <div css={wasmUrl} />
                <div css={virtualDefault} />
              </>;
            `
          },
          {
            id: packageBarrelId,
            source: `
              export { default, button as reexported } from "@scope/styles/leaf";
              export * from "@scope/styles/leaf";
              export * from "@scope/styles/tokens";
            `,
            sourceKind: "package-source",
            sourceOrigin: "package",
            canonicalModuleId: "npm:@scope/styles",
            normalizedPathKey: packageBarrelId,
            watchFiles: ["/project/node_modules/@scope/styles/package.json"]
          },
          {
            id: packageLeafId,
            source: `
              export const button = { color: "red" } as const;
              export default { color: "blue" } as const;
            `,
            sourceKind: "package-source",
            sourceOrigin: "package",
            canonicalModuleId: "npm:@scope/styles/leaf",
            normalizedPathKey: packageLeafId
          },
          {
            id: packageDataId,
            source: `export const dataToken = { color: "green" } as const;`,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "json:@scope/styles/tokens",
            normalizedPathKey: packageDataId
          },
          {
            id: packageJsonId,
            source: `
              export default { card: { color: "orange" } } as const;
              export const jsonButton = { color: "cyan" } as const;
            `,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "json:@scope/styles/theme",
            normalizedPathKey: packageJsonId
          },
          {
            id: packageRawId,
            source: `export default "tomato";`,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "raw:@scope/styles/tokens",
            normalizedPathKey: packageRawId
          },
          {
            id: packageWasmUrlId,
            source: `export default "/assets/icon.wasm";`,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "wasm-url:@scope/styles/icon",
            normalizedPathKey: packageWasmUrlId
          },
          {
            id: providerVirtualId,
            source: `export default { color: "purple" } as const;`,
            sourceKind: "provider-virtual",
            sourceOrigin: "provider",
            canonicalModuleId: providerVirtualId,
            normalizedPathKey: providerVirtualId
          }
        ],
        importResolutions: [
          {
            importerId: ownerId,
            importPath: "@scope/styles",
            resolvedId: packageBarrelId,
            sourceKind: "package-source",
            sourceOrigin: "package",
            canonicalModuleId: "npm:@scope/styles",
            normalizedPathKey: packageBarrelId
          },
          {
            importerId: ownerId,
            importPath: "virtual:mincho-styles",
            resolvedId: providerVirtualId,
            sourceKind: "provider-virtual",
            sourceOrigin: "provider",
            canonicalModuleId: providerVirtualId,
            normalizedPathKey: providerVirtualId
          },
          {
            importerId: packageBarrelId,
            importPath: "@scope/styles/leaf",
            resolvedId: packageLeafId,
            sourceKind: "package-source",
            sourceOrigin: "package",
            canonicalModuleId: "npm:@scope/styles/leaf",
            normalizedPathKey: packageLeafId
          },
          {
            importerId: packageBarrelId,
            importPath: "@scope/styles/tokens",
            resolvedId: packageDataId,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "json:@scope/styles/tokens",
            normalizedPathKey: packageDataId
          },
          {
            importerId: ownerId,
            importPath: "@scope/styles/theme.json",
            resolvedId: packageJsonId,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "json:@scope/styles/theme",
            normalizedPathKey: packageJsonId
          },
          {
            importerId: ownerId,
            importPath: "@scope/styles/tokens.css?raw",
            resolvedId: packageRawId,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "raw:@scope/styles/tokens",
            normalizedPathKey: packageRawId
          },
          {
            importerId: ownerId,
            importPath: "@scope/styles/icon.wasm?url",
            resolvedId: packageWasmUrlId,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "wasm-url:@scope/styles/icon",
            normalizedPathKey: packageWasmUrlId
          }
        ]
      });
      const buttonResult = expectResolvedResult(
        resolveFixture(provider, "button")
      );

      expect(buttonResult.value).toEqual({ color: "red" });
      expect(resolveFixture(provider, "rootDefault")).toMatchObject({
        kind: "resolved",
        value: { color: "blue" }
      });
      expect(resolveFixture(provider, "dataToken")).toMatchObject({
        kind: "resolved",
        value: { color: "green" }
      });
      expect(resolveFixture(provider, "styles", ["reexported"])).toMatchObject({
        kind: "resolved",
        value: { color: "red" }
      });
      expect(resolveFixture(provider, "styles", ["default"])).toMatchObject({
        kind: "resolved",
        value: { color: "blue" }
      });
      expect(resolveFixture(provider, "jsonButton")).toMatchObject({
        kind: "resolved",
        value: { color: "cyan" }
      });
      expect(resolveFixture(provider, "theme", ["card"])).toMatchObject({
        kind: "resolved",
        value: { color: "orange" }
      });
      expect(resolveFixture(provider, "rawToken")).toMatchObject({
        kind: "resolved",
        value: "tomato"
      });
      expect(resolveFixture(provider, "wasmUrl")).toMatchObject({
        kind: "resolved",
        value: "/assets/icon.wasm"
      });
      expect(resolveFixture(provider, "virtualDefault")).toMatchObject({
        kind: "resolved",
        value: { color: "purple" }
      });
      expect(buttonResult.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: packageBarrelId,
            sourceKind: "package-source",
            sourceOrigin: "package",
            canonicalModuleId: "npm:@scope/styles"
          }),
          expect.objectContaining({
            file: packageLeafId,
            sourceKind: "package-source",
            sourceOrigin: "package",
            canonicalModuleId: "npm:@scope/styles/leaf"
          })
        ])
      );
      expect(buttonResult.cacheKey).toMatchObject({
        resolvedFile: packageLeafId,
        sourceKind: "package-source",
        sourceOrigin: "package",
        canonicalModuleId: "npm:@scope/styles/leaf",
        normalizedPathKey: packageLeafId
      });
    });

    it("resolves package whole namespace imports only when every export is static", () => {
      const staticNamespaceProvider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `import * as styles from "@scope/namespace"; <div css={styles} />;`
          },
          {
            id: packageBarrelId,
            source: `
              export { default } from "@scope/styles/leaf";
              export * from "@scope/styles/leaf";
              export const card = { color: "green" } as const;
            `,
            sourceKind: "package-source",
            sourceOrigin: "package"
          },
          {
            id: packageLeafId,
            source: `
              export const button = { color: "red" } as const;
              export default { color: "blue" } as const;
            `,
            sourceKind: "package-source",
            sourceOrigin: "package"
          }
        ],
        importResolutions: [
          {
            importerId: ownerId,
            importPath: "@scope/namespace",
            resolvedId: packageBarrelId,
            sourceKind: "package-source",
            sourceOrigin: "package"
          },
          {
            importerId: packageBarrelId,
            importPath: "@scope/styles/leaf",
            resolvedId: packageLeafId,
            sourceKind: "package-source",
            sourceOrigin: "package"
          }
        ]
      });
      const nonStaticNamespaceProvider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `import * as styles from "@scope/namespace"; <div css={styles} />;`
          },
          {
            id: packageBarrelId,
            source: `
              export const button = { color: "red" } as const;
              export const dynamic = createStyle();
            `,
            sourceKind: "package-source",
            sourceOrigin: "package"
          }
        ],
        importResolutions: [
          {
            importerId: ownerId,
            importPath: "@scope/namespace",
            resolvedId: packageBarrelId,
            sourceKind: "package-source",
            sourceOrigin: "package"
          }
        ]
      });

      expect(resolveFixture(staticNamespaceProvider, "styles")).toMatchObject({
        kind: "resolved",
        value: {
          default: { color: "blue" },
          button: { color: "red" },
          card: { color: "green" }
        }
      });
      expect(
        resolveFixture(nonStaticNamespaceProvider, "styles")
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_NAMESPACE_PARTIAL_UNSUPPORTED",
          code: "unsupported-source",
          reason: "partial-namespace-failure",
          dependency: { file: packageBarrelId },
          importPath: "@scope/namespace",
          exportName: "dynamic"
        }
      });
    });

    it("preserves special property names on whole namespace values", () => {
      const result = expectResolvedResult(
        resolveFixture(
          createProvider(
            `
              const proto = { color: "red" } as const;
              const constructorValue = { color: "blue" } as const;
              export { proto as "__proto__", constructorValue as "constructor" };
            `,
            `import * as styles from "./styles"; <div css={styles} />;`
          ),
          "styles"
        )
      );

      if (
        result.value === null ||
        typeof result.value !== "object" ||
        Array.isArray(result.value)
      ) {
        throw new TypeError("expected a static namespace object");
      }

      expect(Object.hasOwn(result.value, "__proto__")).toBe(true);
      expect(Object.hasOwn(result.value, "constructor")).toBe(true);
    });

    it("rejects unsupported provider source kinds with source metadata", () => {
      const unresolvedId = "unresolved:@scope/missing";
      const externalId = "external:@scope/external";
      const virtualNoSourceId = "virtual:missing-styles";
      const unsupportedShapeId = "unsupported:@scope/runtime";
      const wasmRuntimeId = "unsupported:@scope/wasm-init";
      const nonLiteralLoaderId = "unsupported:@scope/nonliteral";
      const provider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `
              import { button as externalButton } from "@scope/external";
              import { button as unresolvedButton } from "@scope/missing";
              import virtualStyles from "virtual:missing-styles";
              import { button as runtimeButton } from "@scope/runtime";
              import wasmInit from "@scope/wasm-init";
              import nonLiteral from "@scope/nonliteral";
              <>
                <div css={externalButton} />
                <div css={unresolvedButton} />
                <div css={virtualStyles} />
                <div css={runtimeButton} />
                <div css={wasmInit} />
                <div css={nonLiteral} />
              </>;
            `
          }
        ],
        importResolutions: [
          {
            importerId: ownerId,
            importPath: "@scope/external",
            resolvedId: externalId,
            sourceKind: "external-no-source",
            sourceOrigin: "external",
            unsupportedReason: "external-no-source",
            canonicalModuleId: "npm:@scope/external",
            normalizedPathKey: externalId,
            watchFiles: ["/project/package.json"]
          },
          {
            importerId: ownerId,
            importPath: "@scope/missing",
            resolvedId: unresolvedId,
            sourceKind: "unresolved",
            sourceOrigin: "unresolved",
            unsupportedReason: "unresolved",
            canonicalModuleId: "npm:@scope/missing",
            normalizedPathKey: unresolvedId
          },
          {
            importerId: ownerId,
            importPath: "virtual:missing-styles",
            resolvedId: virtualNoSourceId,
            sourceKind: "provider-virtual",
            sourceOrigin: "provider",
            canonicalModuleId: virtualNoSourceId,
            normalizedPathKey: virtualNoSourceId
          },
          {
            importerId: ownerId,
            importPath: "@scope/runtime",
            resolvedId: unsupportedShapeId,
            sourceKind: "unsupported-source-shape",
            sourceOrigin: "unsupported",
            unsupportedReason: "unsupported-source-shape",
            canonicalModuleId: "npm:@scope/runtime",
            normalizedPathKey: unsupportedShapeId
          },
          {
            importerId: ownerId,
            importPath: "@scope/wasm-init",
            resolvedId: wasmRuntimeId,
            sourceKind: "unsupported-source-shape",
            sourceOrigin: "unsupported",
            unsupportedReason: "runtime-wasm-init-or-function",
            canonicalModuleId: "npm:@scope/wasm-init",
            normalizedPathKey: wasmRuntimeId
          },
          {
            importerId: ownerId,
            importPath: "@scope/nonliteral",
            resolvedId: nonLiteralLoaderId,
            sourceKind: "unsupported-source-shape",
            sourceOrigin: "unsupported",
            unsupportedReason: "non-literal-loader-output",
            canonicalModuleId: "npm:@scope/nonliteral",
            normalizedPathKey: nonLiteralLoaderId
          }
        ]
      });

      const externalResult = resolveFixture(provider, "externalButton");

      expect(externalResult).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
          code: "unsupported-source",
          reason: "external-no-source",
          dependency: { file: externalId },
          importPath: "@scope/external",
          exportName: "button"
        },
        dependencies: [
          expect.objectContaining({
            file: externalId,
            sourceKind: "external-no-source",
            sourceOrigin: "external",
            unsupportedReason: "external-no-source",
            canonicalModuleId: "npm:@scope/external",
            normalizedPathKey: externalId,
            watchFiles: ["/project/package.json"],
            inspected: true,
            contributed: false
          })
        ]
      });
      expect(resolveFixture(provider, "unresolvedButton")).toMatchObject({
        kind: "error",
        diagnostic: {
          code: "unsupported-source",
          reason: "unresolved",
          dependency: { file: unresolvedId },
          importPath: "@scope/missing"
        }
      });
      const virtualResult = resolveFixture(provider, "virtualStyles");
      expect(virtualResult).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
          code: "unsupported-source",
          reason: "provider-virtual-no-source",
          dependency: { file: virtualNoSourceId },
          importPath: "virtual:missing-styles"
        }
      });
      expect(resolveFixture(provider, "runtimeButton")).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
          code: "unsupported-source",
          reason: "unsupported-source-shape",
          dependency: { file: unsupportedShapeId },
          importPath: "@scope/runtime"
        }
      });
      expect(resolveFixture(provider, "wasmInit")).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
          reason: "runtime-wasm-init-or-function",
          dependency: { file: wasmRuntimeId },
          importPath: "@scope/wasm-init"
        }
      });
      expect(resolveFixture(provider, "nonLiteral")).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
          reason: "non-literal-loader-output",
          dependency: { file: nonLiteralLoaderId },
          importPath: "@scope/nonliteral"
        }
      });
      expect(
        externalResult.kind === "error" ? externalResult.diagnostic.message : ""
      ).toContain(
        'Cannot statically evaluate css prop value: external module "external:@scope/external" has no provider source'
      );
      expect(
        virtualResult.kind === "error" ? virtualResult.diagnostic.message : ""
      ).toContain(
        'Cannot statically evaluate css prop value: provider virtual module "virtual:missing-styles" has no source from the bundler provider'
      );
    });

    it("lets explicit direct exports override same-named export star candidates", () => {
      const result = resolveFixture(
        createProvider(
          `export const button = { color: "red" } as const;`,
          `import { button } from "./barrel"; <div css={button} />;`,
          `export * from "./button"; export { button } from "./styles";`,
          [
            {
              id: buttonId,
              source: `export const button = { color: "blue" } as const;`
            }
          ],
          [
            {
              importerId: barrelId,
              importPath: "./button",
              resolvedId: buttonId
            }
          ]
        ),
        "button"
      );

      expect(result).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        dependencies: [
          { file: barrelId, inspected: true, contributed: true },
          { file: stylesId, inspected: true, contributed: true }
        ]
      });
      expect(result.kind === "resolved" ? result.dependencies : []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ file: buttonId })])
      );
    });

    it("reports ambiguous export star conflict without choosing a candidate", () => {
      const result = resolveFixture(
        createProvider(
          `export const button = { color: "red" } as const;`,
          `import { button } from "./barrel"; <div css={button} />;`,
          `export * from "./styles"; export * from "./button";`,
          [
            {
              id: buttonId,
              source: `export const button = { color: "blue" } as const;`
            }
          ],
          [
            {
              importerId: barrelId,
              importPath: "./button",
              resolvedId: buttonId
            }
          ]
        ),
        "button"
      );

      expect(result).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_EXPORT_STAR_AMBIGUOUS",
          reason: "ambiguous-star",
          exportName: "button",
          dependency: { file: barrelId },
          importChain: expect.arrayContaining([
            expect.stringContaining(`${stylesId}#button`),
            expect.stringContaining(`${buttonId}#button`)
          ])
        },
        dependencies: [
          { file: barrelId, inspected: true, contributed: false },
          { file: stylesId, inspected: true, contributed: false },
          { file: buttonId, inspected: true, contributed: false }
        ]
      });
      expect(
        result.kind === "error" ? result.diagnostic.message : ""
      ).toContain("ambiguous");
    });

    it("rejects dynamic import values with precise diagnostics", () => {
      const result = resolveFixture(
        createProvider(
          `export const button = import("./styles");`,
          `import { button } from "./styles"; <div css={button} />;`
        ),
        "button"
      );

      expect(result).toMatchObject({
        kind: "error",
        diagnostic: {
          code: "unsupported-syntax",
          reason: "dynamic-import",
          dependency: { file: stylesId },
          importPath: "./styles",
          exportName: "button"
        }
      });
      expect(result.kind === "error" ? result.diagnostic.message : "").toBe(
        'Cannot statically evaluate css prop value: imported export "button" contains a dynamic import'
      );
    });

    it("classifies native import expressions as dynamic imports", () => {
      expect(
        getUnsupportedLiteralReason(
          t.importExpression(t.stringLiteral("./styles"))
        )
      ).toBe("dynamic-import");
    });

    it("terminates export star reexport cycles with deterministic diagnostics", () => {
      const result = resolveFixture(
        createProviderFromModules({
          modules: [
            {
              id: ownerId,
              source: `import { button } from "./barrel"; <div css={button} />;`
            },
            { id: barrelId, source: `export * from "./button";` },
            { id: buttonId, source: `export * from "./barrel";` }
          ],
          importResolutions: [
            {
              importerId: ownerId,
              importPath: "./barrel",
              resolvedId: barrelId
            },
            {
              importerId: barrelId,
              importPath: "./button",
              resolvedId: buttonId
            },
            {
              importerId: buttonId,
              importPath: "./barrel",
              resolvedId: barrelId
            }
          ]
        }),
        "button"
      );

      expect(result).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_IMPORT_CYCLE",
          exportName: "button"
        },
        dependencies: expect.arrayContaining([
          expect.objectContaining({ file: barrelId, inspected: true }),
          expect.objectContaining({ file: buttonId, inspected: true })
        ])
      });
    });

    it("parses one imported source identity once for repeated binding resolutions", () => {
      const { cache, missesByFile } = createCountingStaticCssModuleCache();
      const provider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `
              import { button, card, banner } from "./styles";
              <>
                <div css={button} />
                <div css={card} />
                <div css={banner} />
                <div css={button} />
              </>;
            `,
            sourceHash: "hash:owner-v1",
            version: "owner-v1"
          },
          {
            id: stylesId,
            source: `
              export const button = { color: "red" } as const;
              export const card = { color: "blue" } as const;
              export const banner = { color: "green" } as const;
            `,
            sourceHash: "hash:styles-v1",
            version: "styles-v1"
          }
        ],
        importResolutions: [
          { importerId: ownerId, importPath: "./styles", resolvedId: stylesId }
        ],
        moduleCache: cache
      });

      const button = expectResolvedResult(resolveFixture(provider, "button"));
      const card = expectResolvedResult(resolveFixture(provider, "card"));
      const banner = expectResolvedResult(resolveFixture(provider, "banner"));
      const repeatedButton = expectResolvedResult(
        resolveFixture(provider, "button")
      );

      expect(button.value).toEqual({ color: "red" });
      expect(card.value).toEqual({ color: "blue" });
      expect(banner.value).toEqual({ color: "green" });
      expect(repeatedButton.value).toEqual({ color: "red" });
      expect(missesByFile.get(stylesId)).toBe(1);
      expect(missesByFile.get(ownerId)).toBe(1);
      expect(
        [button, card, banner, repeatedButton].map((result) => ({
          resolvedFile: result.cacheKey.resolvedFile,
          sourceHash: result.cacheKey.sourceHash,
          sourceVersion: result.cacheKey.sourceVersion,
          pluginOptionsVersion: result.cacheKey.pluginOptionsVersion,
          resolverOptionsVersion: result.cacheKey.resolverOptionsVersion,
          parserVersion: result.cacheKey.parserVersion,
          staticEvalSupportVersion: result.cacheKey.staticEvalSupportVersion
        }))
      ).toEqual([
        {
          resolvedFile: stylesId,
          sourceHash: "hash:styles-v1",
          sourceVersion: "styles-v1",
          pluginOptionsVersion: "static-css-eval-provider:v1",
          resolverOptionsVersion: "static-css-eval-provider:v1",
          parserVersion: STATIC_CSS_MODULE_CACHE_PARSER_VERSION,
          staticEvalSupportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION
        },
        {
          resolvedFile: stylesId,
          sourceHash: "hash:styles-v1",
          sourceVersion: "styles-v1",
          pluginOptionsVersion: "static-css-eval-provider:v1",
          resolverOptionsVersion: "static-css-eval-provider:v1",
          parserVersion: STATIC_CSS_MODULE_CACHE_PARSER_VERSION,
          staticEvalSupportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION
        },
        {
          resolvedFile: stylesId,
          sourceHash: "hash:styles-v1",
          sourceVersion: "styles-v1",
          pluginOptionsVersion: "static-css-eval-provider:v1",
          resolverOptionsVersion: "static-css-eval-provider:v1",
          parserVersion: STATIC_CSS_MODULE_CACHE_PARSER_VERSION,
          staticEvalSupportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION
        },
        {
          resolvedFile: stylesId,
          sourceHash: "hash:styles-v1",
          sourceVersion: "styles-v1",
          pluginOptionsVersion: "static-css-eval-provider:v1",
          resolverOptionsVersion: "static-css-eval-provider:v1",
          parserVersion: STATIC_CSS_MODULE_CACHE_PARSER_VERSION,
          staticEvalSupportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION
        }
      ]);
    });

    it("normalizes direct imports and direct reexports to the same terminal dependency file", () => {
      const directResult = expectResolvedResult(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import { button } from "./styles"; <div css={button} />;`
          ),
          "button"
        )
      );
      const reexportResult = expectResolvedResult(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import { button } from "./barrel"; <div css={button} />;`
          ),
          "button"
        )
      );
      const directDependency = directResult.dependencies.find(
        (dependency) => dependency.file === stylesId
      );
      const reexportDependency = reexportResult.dependencies.find(
        (dependency) => dependency.file === stylesId
      );

      expect(directDependency).toMatchObject({
        file: stylesId,
        kind: "imported"
      });
      expect(reexportDependency).toMatchObject({
        file: stylesId,
        kind: "reexported"
      });
      expect(directResult.cacheKey.resolvedFile).toBe(stylesId);
      expect(reexportResult.cacheKey.resolvedFile).toBe(stylesId);
      expect(directResult.cacheKey.resolvedId).toBe(
        reexportResult.cacheKey.resolvedId
      );
    });

    it("changes cache identity when imported source content identity changes", () => {
      const createVersionedProvider = (
        source: string,
        sourceHash: string,
        version: string
      ) =>
        createProviderFromModules({
          modules: [
            {
              id: ownerId,
              source: `import { button } from "./styles"; <div css={button} />;`
            },
            { id: stylesId, source, sourceHash, version }
          ],
          importResolutions: [
            {
              importerId: ownerId,
              importPath: "./styles",
              resolvedId: stylesId
            }
          ]
        });
      const red = expectResolvedResult(
        resolveFixture(
          createVersionedProvider(
            `export const button = { color: "red" } as const;`,
            "hash:styles-red",
            "styles-red"
          ),
          "button"
        )
      );
      const blue = expectResolvedResult(
        resolveFixture(
          createVersionedProvider(
            `export const button = { color: "blue" } as const;`,
            "hash:styles-blue",
            "styles-blue"
          ),
          "button"
        )
      );

      expect(red.value).toEqual({ color: "red" });
      expect(blue.value).toEqual({ color: "blue" });
      expect(red.cacheKey.resolvedFile).toBe(blue.cacheKey.resolvedFile);
      expect(red.cacheKey.sourceHash).toBe("hash:styles-red");
      expect(blue.cacheKey.sourceHash).toBe("hash:styles-blue");
      expect(red.cacheKey.sourceVersion).toBe("styles-red");
      expect(blue.cacheKey.sourceVersion).toBe("styles-blue");
      expect(red.cacheKey).not.toEqual(blue.cacheKey);
    });

    it("resolves limited namespace members from project-local literal chains", () => {
      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import * as styles from "./styles"; <div css={styles.button} />;`
          ),
          "styles",
          ["button"]
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        provenance: {
          kind: "namespace-member",
          file: stylesId,
          exportName: "button",
          namespaceBinding: "styles"
        },
        dependencies: [
          {
            file: stylesId,
            kind: "namespace-member",
            inspected: true,
            contributed: true
          }
        ]
      });
    });

    it("reports imported module parse failures in unresolved diagnostics", () => {
      expect(
        resolveFixture(createProvider(`export const button = {`), "button")
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
          message: expect.stringMatching(
            /Unexpected token|Unexpected end of input/
          )
        }
      });
    });

    it("preserves non-Error imported module parse failures", () => {
      const parseFailure = "synthetic parse failure";
      const delegate = createStaticCssModuleCache();
      const moduleCache: StaticCssModuleCache = {
        ...delegate,
        getParsedModule(source) {
          if (source.resolvedFile === stylesId) {
            throw parseFailure;
          }

          return delegate.getParsedModule(source);
        }
      };
      const provider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `import { button } from "./styles"; <div css={button} />;`
          },
          {
            id: stylesId,
            source: `export const button = { color: "red" } as const;`
          }
        ],
        importResolutions: [
          { importerId: ownerId, importPath: "./styles", resolvedId: stylesId }
        ],
        moduleCache
      });

      expect(resolveFixture(provider, "button")).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
          message: expect.stringContaining(parseFailure)
        }
      });
    });

    it("resolves static CommonJS require bindings and require-backed CJS exports", () => {
      const cjsImportProvider = createProvider(
        `
          export const button = { color: "red" } as const;
          export const card = { color: "blue" } as const;
          export default { color: "green" } as const;
        `,
        `
          const styles = require("./styles");
          const directButton = require("./styles").button;
          const { card: cardStyle } = require("./styles");
        `
      );

      expect(
        resolveFixture(cjsImportProvider, "styles", ["button"])
      ).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        provenance: {
          kind: "imported",
          file: stylesId,
          exportName: "button"
        },
        dependencies: [
          {
            file: stylesId,
            kind: "imported",
            importer: ownerId,
            specifier: "./styles",
            exportName: "button",
            memberPath: [],
            inspected: true,
            contributed: true
          }
        ]
      });
      expect(resolveFixture(cjsImportProvider, "directButton")).toMatchObject({
        kind: "resolved",
        value: { color: "red" }
      });
      expect(resolveFixture(cjsImportProvider, "cardStyle")).toMatchObject({
        kind: "resolved",
        value: { color: "blue" }
      });

      expect(
        resolveFixture(
          createProvider(
            `module.exports = { button: { color: "red" }, card: { color: "blue" } };`,
            `const styles = require("./styles"); <div css={styles} />;`
          ),
          "styles"
        )
      ).toMatchObject({
        kind: "resolved",
        value: {
          button: { color: "red" },
          card: { color: "blue" }
        },
        provenance: {
          kind: "imported",
          file: stylesId,
          exportName: null
        }
      });

      const cjsReexportProvider = createProvider(
        `
          export const button = { color: "red" } as const;
          export const card = { color: "blue" } as const;
        `,
        `import { button, card } from "./barrel"; <><div css={button} /><div css={card} /></>;`,
        `
          const styles = require("./styles");
          exports.button = styles.button;
          exports.card = require("./styles").card;
        `
      );

      expect(resolveFixture(cjsReexportProvider, "button")).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        provenance: {
          kind: "reexported",
          file: stylesId,
          exportName: "button",
          reexportName: "button"
        },
        dependencies: [
          {
            file: barrelId,
            kind: "reexported",
            inspected: true,
            contributed: true
          },
          {
            file: stylesId,
            kind: "reexported",
            inspected: true,
            contributed: true
          }
        ],
        resolutionChain: [
          { importer: ownerId, source: barrelId, exportName: "button" },
          { importer: barrelId, source: stylesId, exportName: "button" }
        ]
      });
      expect(resolveFixture(cjsReexportProvider, "card")).toMatchObject({
        kind: "resolved",
        value: { color: "blue" },
        provenance: {
          kind: "reexported",
          file: stylesId,
          exportName: "card",
          reexportName: "card"
        }
      });
    });

    it("resolves esbuild static CommonJS helper named default and require-backed exports", () => {
      const esbuildStylesSource = `
        ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
        const button = { color: "red" };
        const root = { color: "green" };
        __export(exports, {
          button: () => button,
          default: () => root
        });
        module.exports = __toCommonJS(exports);
      `;
      const esbuildProvider = createProvider(
        esbuildStylesSource,
        `const styles = require("./styles"); <><div css={styles.button} /><div css={styles.default} /></>;`
      );
      const buttonResult = expectResolvedResult(
        resolveFixture(esbuildProvider, "styles", ["button"])
      );
      const defaultResult = expectResolvedResult(
        resolveFixture(esbuildProvider, "styles", ["default"])
      );

      expect(buttonResult.value).toEqual({ color: "red" });
      expect(defaultResult.value).toEqual({ color: "green" });

      const reexportProvider = createProvider(
        `export const button = { color: "blue" } as const;`,
        `import { button } from "./barrel"; <div css={button} />;`,
        `
          ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
          const styles = require("./styles");
          __export(exports, { button: () => styles.button });
          module.exports = __toCommonJS(exports);
        `
      );

      expect(resolveFixture(reexportProvider, "button")).toMatchObject({
        kind: "resolved",
        value: { color: "blue" },
        provenance: {
          kind: "reexported",
          file: stylesId,
          exportName: "button",
          reexportName: "button"
        },
        resolutionChain: [
          { importer: ownerId, source: barrelId, exportName: "button" },
          { importer: barrelId, source: stylesId, exportName: "button" }
        ]
      });
    });

    it("rejects esbuild copyProps helper definitions missing required guard pieces", () => {
      const cases: readonly string[] = [
        `
          var __copyProps = (to, from, except, desc) => {
            if (from) {
              for (let key of __getOwnPropNames(from))
                if (!__hasOwnProp.call(to, key) && key !== except)
                  __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
            }
            return to;
          };
        `,
        `
          var __copyProps = (to, from, except, desc) => {
            if (from && typeof from === "object" || typeof from === "function") {
              for (let key of Object.keys(from))
                if (!__hasOwnProp.call(to, key) && key !== except)
                  __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
            }
            return to;
          };
        `,
        `
          var __copyProps = (to, from, except, desc) => {
            if (from && typeof from === "object" || typeof from === "function") {
              for (let key of __getOwnPropNames(from))
                if (key !== except)
                  __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
            }
            return to;
          };
        `,
        `
          var __copyProps = (to, from, except, desc) => {
            if (from && typeof from === "object" || typeof from === "function") {
              for (let key of __getOwnPropNames(from))
                if (!__hasOwnProp.call(to, key))
                  __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
            }
            return to;
          };
        `,
        `
          var __copyProps = (to, from, except, desc) => {
            if (from && typeof from === "object" || typeof from === "function") {
              for (let key of __getOwnPropNames(from))
                if (!__hasOwnProp.call(to, key) && key !== except)
                  __defProp(to, key, { get: () => from[key], enumerable: true });
            }
            return to;
          };
        `,
        `
          var __copyProps = (to, from, except, desc) => {
            if (from && typeof from === "object" || typeof from === "function") {
              for (let key of __getOwnPropNames(from))
                if (!__hasOwnProp.call(to, key) && key !== except)
                  __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) });
            }
            return to;
          };
        `
      ];

      for (const copyPropsSource of cases) {
        expectCjsUnsupportedFixture({
          stylesSource: `
            ${createEsbuildHelperSource(copyPropsSource)}
            var entry_exports = {};
            const button = { color: "red" };
            __export(entry_exports, { button: () => button });
            module.exports = __toCommonJS(entry_exports);
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED"
        });
      }
    });

    it("rejects missing exports, unresolved imports, dynamic cjs, and cycles with exact diagnostics", () => {
      expect(
        resolveFixture(
          createProvider(
            `export const card = { color: "red" } as const;`,
            `import { button } from "./styles"; <div css={button} />;`
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT"
        }
      });

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import { button } from "pkg"; <div css={button} />;`
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
          importPath: "pkg"
        }
      });

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import * as styles from "pkg"; <div css={styles.button} />;`
          ),
          "styles",
          ["button"]
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
          importPath: "pkg"
        }
      });

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `const styles = require(name); <div css={styles.button} />;`
          ),
          "styles",
          ["button"]
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED",
          reason: "commonjs-require",
          message:
            "Cannot statically evaluate css prop value: commonjs dynamic require is unsupported"
        }
      });

      expect(
        resolveFixture(
          createProviderFromModules({
            modules: [
              {
                id: ownerId,
                source: `import { button } from "./a"; <div css={button} />;`
              },
              { id: barrelId, source: `export { button } from "./button";` },
              { id: buttonId, source: `export { button } from "./barrel";` }
            ],
            importResolutions: [
              { importerId: ownerId, importPath: "./a", resolvedId: barrelId },
              {
                importerId: barrelId,
                importPath: "./button",
                resolvedId: buttonId
              },
              {
                importerId: buttonId,
                importPath: "./barrel",
                resolvedId: barrelId
              }
            ]
          }),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_IMPORT_CYCLE"
        }
      });
    });

    it("rejects unsupported CommonJS require forms with narrow dynamic diagnostics", () => {
      const cases: readonly CjsUnsupportedFixture[] = [
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource: `const styles = require(name); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = require(`./${name}`); <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource: `const styles = enabled ? require("./styles") : require("./fallback"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = `prefix-${require(name)}`; <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = require(name)`styles`; <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = tag`styles-${require(name)}`; <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = new (require(name))(); <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = new Styles(require(name)); <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = await require(name); <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = (target = require(name)); <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = (target[require(name)] = fallback); <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = (require(name))<unknown>; <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        }
      ];

      for (const fixture of cases) {
        expectCjsUnsupportedFixture(fixture);
      }
    });

    it("fails closed when CommonJS globals are lexically shadowed", () => {
      const shadowedRequireProvider = createProvider(
        `export const button = { color: "red" } as const;`,
        `const require = makeRequire(); const styles = require("./styles"); <div css={styles.button} />;`
      );

      expect(
        resolveFixture(shadowedRequireProvider, "styles", ["button"])
      ).toEqual({
        kind: "not-candidate"
      });
      expectCjsUnsupportedFixture({
        stylesSource: `const exports = {}; exports.button = { color: "red" };`,
        ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
        bindingName: "styles",
        memberPath: ["button"],
        expectedDiagnosticId: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT"
      });
      expectCjsUnsupportedFixture({
        stylesSource: `const module = {}; module.exports = { button: { color: "red" } };`,
        ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
        bindingName: "styles",
        memberPath: ["button"],
        expectedDiagnosticId: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT"
      });

      const parameterShadowedExportsSource = `
        function write(exports) {
          exports.button = { color: "red" };
        }
        write({});
      `;
      const parameterShadowedExportsRecord =
        createImportedStaticCssEvalModuleRecord({
          id: stylesId,
          source: parameterShadowedExportsSource
        });

      expect(parameterShadowedExportsRecord.exports.has("button")).toBe(false);
      expectCjsUnsupportedFixture({
        stylesSource: parameterShadowedExportsSource,
        ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
        bindingName: "styles",
        memberPath: ["button"],
        expectedDiagnosticId: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT"
      });
    });

    it("rejects unsupported CommonJS export mutations before className compilation", () => {
      const cases: readonly CjsUnsupportedFixture[] = [
        {
          stylesSource: `
            const button = { color: "red" };
            if (enabled) exports.button = button;
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED"
        },
        {
          stylesSource: `
            const button = { color: "red" };
            for (const name of ["button"]) exports.button = button;
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED"
        },
        {
          stylesSource: `
            const root = {};
            module.exports = root;
            exports.button = { color: "red" };
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED"
        }
      ];

      for (const fixture of cases) {
        expectCjsUnsupportedFixture(fixture);
      }
    });

    it("rejects unsupported CommonJS helper definitions before className compilation", () => {
      const cases: readonly CjsUnsupportedFixture[] = [
        {
          stylesSource: `
            function __createBinding() { sideEffect(); }
            const theme = require("./theme");
            __createBinding(exports, theme, "button");
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED"
        },
        {
          stylesSource: `
            const button = { color: "red" };
            var __export = function () { sideEffect(); };
            __export(exports, { button: function () { return button; } });
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED"
        }
      ];

      for (const fixture of cases) {
        expectCjsUnsupportedFixture(fixture);
      }
    });

    it("rejects Webpack Turbopack and Parcel CommonJS bundle runtime snippets", () => {
      const cases: readonly CjsUnsupportedFixture[] = [
        {
          stylesSource: `
            var __webpack_modules__ = {
              "./style": function (module) {
                module.exports = { button: { color: "red" } };
              }
            };
            function __webpack_require__(id) { return __webpack_modules__[id]({ exports: {} }); }
            module.exports = __webpack_require__("./style");
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_BUNDLE_RUNTIME_UNSUPPORTED"
        },
        {
          stylesSource: `
            function __turbopack_require__(id) { return id; }
            module.exports = __turbopack_require__("[project]/style");
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_BUNDLE_RUNTIME_UNSUPPORTED"
        },
        {
          stylesSource: `
            var parcelRequire = function (id) { return id; };
            module.exports = parcelRequire("style");
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_BUNDLE_RUNTIME_UNSUPPORTED"
        }
      ];

      for (const fixture of cases) {
        expectCjsUnsupportedFixture(fixture);
      }
    });

    it("rejects computed namespace members and ignores type-only imports", () => {
      const provider = createProvider(
        `export const button = { color: "red" } as const;`,
        `import * as styles from "./styles"; <div css={styles[variant]} />;`
      );
      const diagnostic =
        findUnsupportedImportedStaticCssEvalReferenceDiagnostic({
          expression: t.memberExpression(
            t.identifier("styles"),
            t.identifier("variant"),
            true
          ),
          ownerFile: ownerId,
          provider
        });

      expect(diagnostic).toMatchObject({
        id: "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED"
      });

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import type { button } from "./styles"; <div css={button} />;`
          ),
          "button"
        )
      ).toEqual({ kind: "not-candidate" });
    });

    it("rejects unsupported namespace reexports with exact diagnostics", () => {
      const result = resolveFixture(
        createProvider(
          `export const button = { color: "red" } as const;`,
          `import { styles } from "./barrel"; <div css={styles} />;`,
          `export * as styles from "./styles";`
        ),
        "styles"
      );

      expect(result).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_NAMESPACE_REEXPORT_UNSUPPORTED",
          reason: "unsupported-namespace-reexport",
          dependency: { file: barrelId },
          importPath: "./styles",
          exportName: "styles"
        }
      });
    });

    it("rejects exported const mutations deterministically", () => {
      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const; button.color = "blue";`
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_MUTATED_BINDING"
        },
        dependencies: [{ file: stylesId, inspected: true, contributed: false }]
      });

      expect(
        resolveFixture(
          createProvider(
            `export const buttons = [{ color: "red" }] as const; buttons.push({ color: "blue" });`,
            `import { buttons } from "./styles"; <div css={buttons} />;`
          ),
          "buttons"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_MUTATED_BINDING"
        },
        dependencies: [{ file: stylesId, inspected: true, contributed: false }]
      });
    });
  });
}
