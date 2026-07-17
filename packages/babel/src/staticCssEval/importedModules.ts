import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
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
  createStaticCssEvalCjsUnsupportedDiagnostic,
  createStaticCssEvalComputedMemberUnsupportedDiagnostic,
  createStaticCssEvalDiagnostic,
  createStaticCssEvalDynamicExpressionUnsupportedDiagnostic,
  createStaticCssEvalExportStarUnsupportedDiagnostic,
  createStaticCssEvalMutableBindingDiagnostic,
  createStaticCssEvalMutatedBindingDiagnostic,
  createStaticCssEvalNamespaceImportUnsupportedDiagnostic,
  createStaticCssEvalPackageImportUnsupportedDiagnostic,
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
  createStaticCssModuleCache,
  formatExportMapCacheKey,
  STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION
} from "./moduleCache.js";
import type {
  ExportMapEntry,
  ExportMapLocalEntry,
  ParsedStaticCssModule,
  StaticCssModuleCache,
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

export interface ImportedStaticCssEvalLoadedModule {
  id: string;
  source: string;
  realpath?: string;
  sourceHash?: string;
  version?: string | number;
}

export interface ImportedStaticCssEvalImportResolution {
  importerId: string;
  importPath: string;
  resolvedId: string;
}

export interface ImportedStaticCssEvalModuleRecord extends StaticCssEvalModuleRecord {
  source: string;
  imports: ReadonlyMap<string, ImportedStaticCssEvalImportBinding>;
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
  // Imported css props are resolved from parsed ESM AST/export maps only.
  // Keep module execution, `export *`, packages, CJS, spread, computed paths,
  // and broad namespace handling unsupported instead of adding fallbacks here.
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

  for (const statement of parsedModule.program.body) {
    collectModuleImportBindings(statement, imports);
  }

  return {
    id: loadedModule.id,
    realpath: loadedModule.realpath ?? loadedModule.id,
    sourceHash:
      loadedModule.sourceHash ?? `inline:${loadedModule.source.length}`,
    ...(loadedModule.version !== undefined
      ? { version: loadedModule.version }
      : {}),
    dependencies: [],
    source: loadedModule.source,
    imports,
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
  readonly #importResolutions = new Map<string, string>();
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
        resolution.resolvedId
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

    const importBinding = ownerRecord.imports.get(query.bindingName);

    if (!importBinding) {
      const cjsDiagnostic = this.#createCjsUnsupportedDiagnostic(
        ownerRecord,
        query
      );

      return cjsDiagnostic
        ? createImportedStaticCssEvalErrorResult({
            query,
            diagnostic: cjsDiagnostic,
            state: createResolutionState(createQueryOwnerLocation(query))
          })
        : { kind: "not-candidate" };
    }

    const owner = createQueryOwnerLocation(query);
    const state = createResolutionState(owner);
    const requestResult = createResolutionRequest(query, importBinding, owner);

    if (requestResult.kind === "error") {
      return createImportedStaticCssEvalErrorResult({
        query,
        diagnostic: requestResult.diagnostic,
        state
      });
    }

    const importResult = this.#resolveProjectLocalImport(
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

  #resolveProjectLocalImport(
    request: ImportedStaticCssEvalResolutionRequest,
    owner: StaticCssEvalSourceLocation,
    state: ImportedStaticCssEvalResolutionState
  ):
    | { kind: "resolved"; record: ImportedStaticCssEvalModuleRecord }
    | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
    const resolvedId = this.#resolveImport(request.importer, request.specifier);

    if (!resolvedId) {
      addResolutionDependency(state, {
        file: request.specifier,
        kind: "unresolved",
        importer: request.importer,
        specifier: request.specifier,
        exportName: request.exportName,
        memberPath: request.memberPath,
        inspected: false,
        contributed: false
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

    addResolutionDependency(state, {
      file: resolvedId,
      kind: request.dependencyKind,
      importer: request.importer,
      specifier: request.specifier,
      exportName: request.exportName,
      memberPath: request.memberPath,
      inspected: false,
      contributed: false
    });

    const loadedModule = this.#modules.get(resolvedId);

    if (!loadedModule) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalUnresolvedImportDiagnostic(
          {
            owner,
            dependency: { file: resolvedId },
            importPath: request.specifier,
            exportName: request.exportName,
            memberPath: request.memberPath,
            importChain: createResolutionImportChain(state, resolvedId)
          },
          request.specifier
        )
      };
    }

    const sourceSizeResult = enforceStaticCssEvalSourceSize({
      owner,
      dependency: { file: resolvedId },
      importPath: request.specifier,
      exportName: request.exportName,
      memberPath: request.memberPath,
      source: loadedModule.source
    });

    if (!sourceSizeResult.ok) {
      markResolutionDependencyInspected(state, resolvedId);
      return { kind: "error", diagnostic: sourceSizeResult.diagnostic };
    }

    const record = this.#getModuleRecord(resolvedId);

    if (!record) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalUnresolvedImportDiagnostic(
          {
            owner,
            dependency: { file: resolvedId },
            importPath: request.specifier,
            exportName: request.exportName,
            memberPath: request.memberPath,
            importChain: createResolutionImportChain(state, resolvedId)
          },
          request.specifier
        )
      };
    }

    markResolutionDependencyInspected(state, resolvedId);
    return { kind: "resolved", record };
  }

  #resolveModuleExport(
    record: ImportedStaticCssEvalModuleRecord,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState
  ): ImportedStaticCssEvalResolutionResult {
    const guardResult = this.#guardResolution(record, request, state);

    if (!guardResult.ok) {
      for (const dependency of guardResult.dependencies) {
        addResolutionDependency(state, {
          file: dependency,
          kind: "reexported",
          importer: request.importer,
          specifier: request.specifier,
          exportName: request.exportName,
          memberPath: request.memberPath,
          inspected: true,
          contributed: false
        });
      }

      return { kind: "error", diagnostic: guardResult.diagnostic };
    }

    const stackEntry: StaticCssEvalImportCycleKey = {
      file: record.id,
      exportName: request.exportName,
      memberPath: request.memberPath
    };
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
    const exportEntry = record.exports.get(request.exportName);

    if (!exportEntry) {
      return this.#createMissingExportResult(record, request, state);
    }

    const effectiveRequest =
      exportEntry.kind === "reexport"
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
      provenance
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
          effectiveRequest.memberPath
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

    return resolveStaticExportMapEntry(
      record,
      exportEntry,
      effectiveRequest,
      state,
      provenance
    );
  }

  #resolveReexportEntry(
    record: ImportedStaticCssEvalModuleRecord,
    exportEntry: Extract<ExportMapEntry, { kind: "reexport" }>,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState,
    provenance: BindingProvenance
  ): ImportedStaticCssEvalResolutionResult {
    if (!isProjectLocalStaticCssImportSpecifier(exportEntry.source)) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalPackageImportUnsupportedDiagnostic(
          {
            owner: state.owner,
            dependency: { file: record.id },
            importPath: exportEntry.source,
            exportName: exportEntry.importedName,
            memberPath: request.memberPath,
            importChain: createResolutionImportChain(state, record.id)
          },
          exportEntry.source
        ),
        provenance,
        cacheKey: createImportedStaticCssEvalCacheKey(
          state.owner.file,
          record.parsedModule,
          request.exportName,
          request.memberPath
        )
      };
    }

    const reexportRequest: ImportedStaticCssEvalResolutionRequest = {
      importer: record.id,
      specifier: exportEntry.source,
      exportName: exportEntry.importedName,
      memberPath: [...request.memberPath],
      dependencyKind: "reexported",
      provenanceKind: "reexported",
      reexportName: formatExportName(exportEntry.exportName)
    };
    const importResult = this.#resolveProjectLocalImport(
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
            request.memberPath
          )
        }
      : this.#resolveModuleExport(importResult.record, reexportRequest, state);
  }

  #createMissingExportResult(
    record: ImportedStaticCssEvalModuleRecord,
    request: ImportedStaticCssEvalResolutionRequest,
    state: ImportedStaticCssEvalResolutionState
  ): ImportedStaticCssEvalResolutionResult {
    const exportStar = record.parsedModule.unsupportedExportStars[0];

    if (exportStar) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalExportStarUnsupportedDiagnostic(
          {
            owner: state.owner,
            dependency: { file: record.id },
            importPath: exportStar.source ?? request.specifier,
            exportName: request.exportName,
            memberPath: request.memberPath,
            importChain: createResolutionImportChain(state, record.id)
          },
          exportStar.source ?? request.specifier
        ),
        cacheKey: createImportedStaticCssEvalCacheKey(
          state.owner.file,
          record.parsedModule,
          request.exportName,
          request.memberPath
        )
      };
    }

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
        request.memberPath
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

    if (
      !init ||
      !isRequireCallExpression(unwrapTransparentCssRuleExpression(init))
    ) {
      return null;
    }

    return createStaticCssEvalCjsUnsupportedDiagnostic({
      owner: createQueryOwnerLocation(query),
      memberPath: query.memberPath
    });
  }

  #resolveImport(importerId: string, importPath: string): string | null {
    return (
      this.#importResolutions.get(
        createImportResolutionKey(importerId, importPath)
      ) ?? (this.#modules.has(importPath) ? importPath : null)
    );
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
      if (!(error instanceof Error)) {
        return null;
      }
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

function createStaticCssModuleSource(
  loadedModule: ImportedStaticCssEvalLoadedModule
): StaticCssModuleSource {
  return {
    resolvedFile: loadedModule.id,
    source: loadedModule.source,
    sourceHash:
      loadedModule.sourceHash ?? `inline:${loadedModule.source.length}`,
    ...(loadedModule.version !== undefined
      ? { sourceVersion: loadedModule.version }
      : {})
  };
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
  importBinding: ImportedStaticCssEvalImportBinding,
  owner: StaticCssEvalSourceLocation
):
  | { kind: "resolved"; request: ImportedStaticCssEvalResolutionRequest }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  const queryMemberPath = [...(query.memberPath ?? [])];

  if (importBinding.kind === "namespace") {
    if (!isProjectLocalStaticCssImportSpecifier(importBinding.importPath)) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalNamespaceImportUnsupportedDiagnostic(
          {
            owner,
            importPath: importBinding.importPath,
            memberPath: queryMemberPath
          },
          importBinding.importPath
        )
      };
    }

    const [exportName, ...memberPath] = queryMemberPath;

    if (!exportName) {
      return {
        kind: "error",
        diagnostic: createStaticCssEvalNamespaceImportUnsupportedDiagnostic(
          {
            owner,
            importPath: importBinding.importPath,
            memberPath: queryMemberPath
          },
          importBinding.importPath
        )
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

  if (!isProjectLocalStaticCssImportSpecifier(importBinding.importPath)) {
    return {
      kind: "error",
      diagnostic: createStaticCssEvalPackageImportUnsupportedDiagnostic(
        {
          owner,
          importPath: importBinding.importPath,
          exportName: importBinding.importedName,
          memberPath: queryMemberPath
        },
        importBinding.importPath
      )
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
    request.memberPath
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

    if (t.isIdentifier(expression)) {
      return getLocalBindingExpressionResult(
        record,
        expression.name,
        exportEntry.exportName
      );
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
  exportName: StaticCssEvalExportName
):
  | { kind: "resolved"; expression: t.Expression; localName: string }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic } {
  const binding = record.programPath.scope.getBinding(localName);
  const expression = binding
    ? getStaticCssEvalConstBindingInitExpression(binding)
    : null;

  if (expression) {
    return {
      kind: "resolved",
      expression: unwrapTransparentCssRuleExpression(expression),
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
    return createStaticCssEvalNamespaceImportUnsupportedDiagnostic(
      context,
      exportEntry.source ?? request.specifier
    );
  }

  return createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
    context,
    exportEntry.declaration.type
  );
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
  memberPath: readonly string[]
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
    staticEvalSupportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION,
    resolvedId: parsedModule.resolvedFile,
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
    memberPath: [...dependency.memberPath]
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

function isProjectLocalStaticCssImportSpecifier(importPath: string): boolean {
  return importPath.startsWith(".") || importPath.startsWith("/");
}

function isRequireCallExpression(expression: t.Expression): boolean {
  return (
    t.isCallExpression(expression) &&
    t.isIdentifier(expression.callee) &&
    expression.callee.name === "require"
  );
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

function getStaticObjectMemberValue(
  expression: t.ObjectExpression,
  memberName: string
): t.Expression | null {
  for (let index = expression.properties.length - 1; index >= 0; index -= 1) {
    const property = expression.properties[index];

    if (!property || !t.isObjectProperty(property) || property.computed) {
      return null;
    }

    if (getStaticObjectPropertyName(property.key) !== memberName) {
      continue;
    }

    return t.isExpression(property.value) ? property.value : null;
  }

  return null;
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
      detail: `imported export "${formatExportName(
        context.exportName
      )}" contains unsupported ${unwrappedExpression.type}`
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

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const ownerId = "/project/src/App.tsx";
  const stylesId = "/project/src/styles.ts";
  const barrelId = "/project/src/barrel.ts";
  const buttonId = "/project/src/button.ts";

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
          staticEvalSupportVersion: result.cacheKey.staticEvalSupportVersion
        }))
      ).toEqual([
        {
          resolvedFile: stylesId,
          sourceHash: "hash:styles-v1",
          sourceVersion: "styles-v1",
          pluginOptionsVersion: "static-css-eval-provider:v1",
          resolverOptionsVersion: "static-css-eval-provider:v1",
          staticEvalSupportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION
        },
        {
          resolvedFile: stylesId,
          sourceHash: "hash:styles-v1",
          sourceVersion: "styles-v1",
          pluginOptionsVersion: "static-css-eval-provider:v1",
          resolverOptionsVersion: "static-css-eval-provider:v1",
          staticEvalSupportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION
        },
        {
          resolvedFile: stylesId,
          sourceHash: "hash:styles-v1",
          sourceVersion: "styles-v1",
          pluginOptionsVersion: "static-css-eval-provider:v1",
          resolverOptionsVersion: "static-css-eval-provider:v1",
          staticEvalSupportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION
        },
        {
          resolvedFile: stylesId,
          sourceHash: "hash:styles-v1",
          sourceVersion: "styles-v1",
          pluginOptionsVersion: "static-css-eval-provider:v1",
          resolverOptionsVersion: "static-css-eval-provider:v1",
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

    it("rejects export stars, missing exports, packages, cjs, and cycles with exact diagnostics", () => {
      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import { button } from "./barrel"; <div css={button} />;`,
            `export * from "./styles";`
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_EXPORT_STAR_UNSUPPORTED"
        },
        dependencies: [{ file: barrelId, inspected: true, contributed: false }]
      });

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
          id: "STATIC_CSS_EVAL_PACKAGE_IMPORT_UNSUPPORTED"
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
          id: "STATIC_CSS_EVAL_NAMESPACE_UNSUPPORTED"
        }
      });

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `const button = require("./styles"); <div css={button} />;`
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_CJS_UNSUPPORTED"
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
