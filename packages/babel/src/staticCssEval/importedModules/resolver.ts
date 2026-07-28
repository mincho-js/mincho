import { unwrapTransparentCssRuleExpression } from "../candidates.js";
import {
  createStaticCssEvalProviderSourceMetadata,
  enforceStaticCssEvalProviderSourcePolicy
} from "../boundary.js";
import { isStaticCssEvalLiteralRequireCallExpression } from "../cjsBindings.js";
import { containsStaticCssEvalRequireCallExpression } from "../cjsRequireAnalysis.js";
import { createStaticCssEvalCjsReexportRequestParts } from "../cjsResolver.js";
import {
  createStaticCssEvalCjsDynamicRequireUnsupportedDiagnostic,
  createStaticCssEvalCjsUnsupportedDiagnostic,
  createStaticCssEvalPartialNamespaceFailureDiagnostic,
  createStaticCssEvalProviderSourceUnsupportedDiagnostic,
  createStaticCssEvalUnresolvedExportDiagnostic,
  createStaticCssEvalUnresolvedImportDiagnostic,
  guardStaticCssEvalImportCycle,
  guardStaticCssEvalResolutionDepth
} from "../diagnostics.js";
import { enforceStaticCssEvalSourceSize } from "../limits.js";
import {
  createStaticCssModuleExportNameTable,
  createStaticCssModuleCache
} from "../moduleCache.js";
import { getStaticCssEvalConstBindingInitExpression } from "../sameFile.js";
import type { StaticCssEvalCjsRequireSource } from "../cjsBindings.js";
import type {
  ExportMapEntry,
  ExportGraphStarReexportEntry,
  StaticCssModuleCache,
  StaticCssModuleExportNameTableEntry,
  StaticCssModuleExportStarSource
} from "../moduleCache.js";
import type {
  BindingProvenance,
  StaticCssEvalDiagnostic,
  StaticCssEvalExportName,
  StaticCssEvalQuery,
  StaticCssEvalResult,
  StaticCssEvalSourceLocation,
  StaticCssLiteral
} from "../types.js";
import type {
  ImportedStaticCssEvalExportPresenceResult,
  ImportedStaticCssEvalExportStarCandidate,
  ImportedStaticCssEvalLiteralReferenceOptions,
  ImportedStaticCssEvalLiteralResult,
  ImportedStaticCssEvalLoadedModule,
  ImportedStaticCssEvalModuleRecord,
  ImportedStaticCssEvalNamespaceExportNameTable,
  ImportedStaticCssEvalResolutionRequest,
  ImportedStaticCssEvalResolutionResult,
  ImportedStaticCssEvalResolutionState,
  ImportedStaticCssEvalResolvedImport,
  ImportedStaticCssEvalResolverOptions
} from "./contracts.js";
import { formatExportName } from "./format.js";
import {
  createQueryOwnerLocation,
  createUnsupportedImportedLiteralResult,
  createUnsupportedImportedReferenceResult
} from "./literalDiagnostics.js";
import {
  createDynamicRequireOperandDiagnostic,
  createReferenceQuery,
  resolveSameModuleStaticLiteralReference
} from "./localReference.js";
import {
  createImportedStaticCssEvalModuleRecordWithCache,
  mergeImportedStaticCssEvalSourceMetadata
} from "./moduleSource.js";
import {
  addResolutionDependency,
  addResolutionGuardDependencies,
  assertNever,
  createAmbiguousExportStarDiagnostic,
  createBindingProvenance,
  createCjsResolutionRequest,
  createExportStarRequest,
  createExportStarSources,
  createImportCycleStackEntry,
  createImportResolutionKey,
  createImportedStaticCssEvalCacheKey,
  createImportedStaticCssEvalErrorResult,
  createImportedStaticCssEvalResolvedResult,
  createNamespaceExplicitExportMap,
  createResolutionImportChain,
  createResolutionRequest,
  createResolutionRequestFromCjsParts,
  createResolutionState,
  createUnsupportedExportEntryDiagnostic,
  getCjsModuleUnsupportedEntry,
  getStaticExportEntryCjsRequireSource,
  markResolutionDependenciesContributed,
  markResolutionDependencyInspected,
  resolveStaticExportMapEntry,
  updateResolutionDependencyKind
} from "./resolution.js";

export class ImportedStaticCssEvalResolver {
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
      if (sourceMetadata.sourceKind === "unresolved") {
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
          request.specifier,
          this.#parseFailures.get(resolvedImport.resolvedId)
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
      provenance,
      (options) => this.#resolveStaticCssLiteralReference(options)
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

  #resolveStaticCssLiteralReference(
    options: ImportedStaticCssEvalLiteralReferenceOptions
  ): ImportedStaticCssEvalLiteralResult {
    const { reference } = options;

    if (reference.kind === "unsupported") {
      return createUnsupportedImportedReferenceResult(options);
    }

    const cjsBinding = options.record.cjsImports.get(reference.bindingName);

    if (cjsBinding) {
      return this.#resolveProviderBackedLiteralReference(
        options,
        createCjsResolutionRequest(
          createReferenceQuery(options.record.id, reference),
          cjsBinding
        ).request
      );
    }

    const dynamicRequireDiagnostic =
      createDynamicRequireOperandDiagnostic(options);

    if (dynamicRequireDiagnostic) {
      return { kind: "error", diagnostic: dynamicRequireDiagnostic };
    }

    const localResult = resolveSameModuleStaticLiteralReference(options);

    if (localResult.kind !== "not-candidate") {
      return localResult;
    }

    const importBinding = options.record.imports.get(reference.bindingName);

    if (!importBinding) {
      return createUnsupportedImportedLiteralResult(
        options,
        options.expression
      );
    }

    const requestResult = createResolutionRequest(
      createReferenceQuery(options.record.id, reference),
      importBinding
    );

    if (requestResult.kind === "error") {
      return { kind: "error", diagnostic: requestResult.diagnostic };
    }

    return this.#resolveProviderBackedLiteralReference(
      options,
      requestResult.request
    );
  }

  #resolveProviderBackedLiteralReference(
    options: ImportedStaticCssEvalLiteralReferenceOptions,
    request: ImportedStaticCssEvalResolutionRequest
  ): ImportedStaticCssEvalLiteralResult {
    const importResult = this.#resolveProviderImport(
      request,
      options.resolutionState.owner,
      options.resolutionState
    );

    if (importResult.kind === "error") {
      return { kind: "error", diagnostic: importResult.diagnostic };
    }

    const exportResult = this.#resolveModuleExport(
      importResult.record,
      request,
      options.resolutionState
    );

    if (exportResult.kind === "error") {
      return { kind: "error", diagnostic: exportResult.diagnostic };
    }

    if (exportResult.kind === "not-candidate") {
      return createUnsupportedImportedLiteralResult(
        options,
        options.expression
      );
    }

    return { kind: "resolved", value: exportResult.value };
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
