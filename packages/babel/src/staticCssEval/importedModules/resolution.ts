import { types as t } from "@babel/core";
import {
  getStaticCssEvalMemberReference,
  unwrapTransparentCssRuleExpression
} from "../candidates.js";
import { createStaticCssEvalProviderSourceMetadata } from "../boundary.js";
import { getStaticCssEvalCjsRequireSource } from "../cjsBindings.js";
import { createStaticCssEvalCjsImportRequestParts } from "../cjsResolver.js";
import {
  createStaticCssEvalAmbiguousExportStarDiagnostic,
  createStaticCssEvalCjsBundleRuntimeUnsupportedDiagnostic,
  createStaticCssEvalCjsExportUnsupportedDiagnostic,
  createStaticCssEvalCjsHelperUnsupportedDiagnostic,
  createStaticCssEvalComputedMemberUnsupportedDiagnostic,
  createStaticCssEvalDynamicExpressionUnsupportedDiagnostic,
  createStaticCssEvalExportStarUnsupportedDiagnostic,
  createStaticCssEvalMutableBindingDiagnostic,
  createStaticCssEvalMutatedBindingDiagnostic,
  createStaticCssEvalNamespaceReexportUnsupportedDiagnostic
} from "../diagnostics.js";
import { STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION } from "../moduleCache.js";
import { getStaticCssEvalConstBindingInitExpression } from "../sameFile.js";
import type { StaticCssEvalProviderSourcePolicyDescriptor } from "../boundary.js";
import type {
  ImportedStaticCssEvalCjsBinding,
  StaticCssEvalCjsRequireSource
} from "../cjsBindings.js";
import type { StaticCssEvalCjsResolutionRequestParts } from "../cjsResolver.js";
import type { StaticCssEvalImportCycleKey } from "../diagnostics.js";
import type {
  ExportMapEntry,
  ExportGraphStarReexportEntry,
  ExportMapLocalEntry,
  ParsedStaticCssModule,
  StaticCssModuleExportStarSource
} from "../moduleCache.js";
import type {
  BindingProvenance,
  ResolutionDependency,
  ResolutionDependencyKind,
  StaticCssEvalCacheKey,
  StaticCssEvalDiagnostic,
  StaticCssEvalExportName,
  StaticCssEvalQuery,
  StaticCssEvalResult,
  StaticCssEvalSourceLocation,
  StaticCssLiteral
} from "../types.js";
import type {
  ImportedStaticCssEvalContext,
  ImportedStaticCssEvalExportStarCandidate,
  ImportedStaticCssEvalImportBinding,
  ImportedStaticCssEvalLiteralReferenceResolver,
  ImportedStaticCssEvalModuleRecord,
  ImportedStaticCssEvalResolutionRequest,
  ImportedStaticCssEvalResolutionResult,
  ImportedStaticCssEvalResolutionState
} from "./contracts.js";
import { formatExportName } from "./format.js";
import { createImportedLiteralDiagnosticContext } from "./literalDiagnostics.js";
import { evaluateStaticCssLiteralExpression } from "./literalEval.js";
import { hasImportedStaticCssBindingMutation } from "./localReference.js";
import {
  resolveStaticObjectMemberPath,
  selectStaticCssEvalExpressionForMemberPath,
  selectStaticCssLiteralMemberPath
} from "./memberPath.js";

export const importResolutionKeySeparator = "\0";

export function assertNever(value: never): never {
  throw new TypeError(`Unexpected imported static css eval value: ${value}`);
}

export function createResolutionState(
  owner: StaticCssEvalSourceLocation
): ImportedStaticCssEvalResolutionState {
  return {
    owner,
    dependencies: new Map<string, ResolutionDependency>(),
    resolutionChain: [],
    stack: []
  };
}

export function createResolutionRequest(
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

export function createCjsResolutionRequest(
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

export function createResolutionRequestFromCjsParts(
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

export function getStaticExportEntryCjsRequireSource(
  record: ImportedStaticCssEvalModuleRecord,
  exportEntry: Exclude<ExportMapEntry, { kind: "reexport" | "unsupported" }>
): StaticCssEvalCjsRequireSource | null {
  return exportEntry.kind === "expression"
    ? getStaticExpressionCjsRequireSource(record, exportEntry.expression)
    : getLocalBindingCjsRequireSource(record, exportEntry.localName, []);
}

export function getStaticExpressionCjsRequireSource(
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

export function getLocalBindingCjsRequireSource(
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

export function appendStaticCssEvalCjsRequireSource(
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

export function resolveStaticExportMapEntry(
  record: ImportedStaticCssEvalModuleRecord,
  exportEntry: Exclude<ExportMapEntry, { kind: "reexport" | "unsupported" }>,
  request: ImportedStaticCssEvalResolutionRequest,
  state: ImportedStaticCssEvalResolutionState,
  provenance: BindingProvenance,
  resolveReference: ImportedStaticCssEvalLiteralReferenceResolver
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

  const selectedExpression = selectStaticCssEvalExpressionForMemberPath(
    expressionResult.expression,
    request.memberPath
  );

  const context = createImportedLiteralContext(record, request, state);
  const literalResult = evaluateStaticCssLiteralExpression({
    expression: selectedExpression.expression,
    context,
    record,
    request,
    resolutionState: state,
    literalState: { count: 0 },
    localStack: [],
    depth: 1,
    resolveReference
  });

  if (literalResult.kind === "error") {
    return {
      kind: "error",
      diagnostic: literalResult.diagnostic,
      provenance,
      cacheKey
    };
  }

  const value = selectStaticCssLiteralMemberPath(
    literalResult.value,
    selectedExpression.deferredMemberPath
  );

  if (value.kind === "not-candidate") {
    return {
      kind: "error",
      diagnostic: createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
        createImportedLiteralDiagnosticContext(context),
        selectedExpression.expression.type
      ),
      provenance,
      cacheKey
    };
  }

  return {
    kind: "resolved",
    value: value.value,
    provenance,
    cacheKey
  };
}

export function getStaticExportEntryExpression(
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

export function getLocalBindingExpressionResult(
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

export function createImportedLiteralContext(
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

export function createImportedDiagnosticContext(
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

export function createUnsupportedExportEntryDiagnostic(
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

export function getCjsModuleUnsupportedEntry(
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

export function createBindingProvenance(
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

export function createImportedStaticCssEvalCacheKey(
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

export function createImportedStaticCssEvalResolvedResult(options: {
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

export function createImportedStaticCssEvalErrorResult(options: {
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

export function addResolutionDependency(
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
          contributed: existing.contributed || dependency.contributed,
          sourceKind: dependency.sourceKind ?? existing.sourceKind,
          sourceOrigin: dependency.sourceOrigin ?? existing.sourceOrigin,
          canonicalModuleId:
            dependency.canonicalModuleId ?? existing.canonicalModuleId,
          normalizedPathKey:
            dependency.normalizedPathKey ?? existing.normalizedPathKey,
          unsupportedReason:
            dependency.unsupportedReason ?? existing.unsupportedReason,
          ...(existing.watchFiles || dependency.watchFiles
            ? {
                watchFiles: [
                  ...new Set([
                    ...(existing.watchFiles ?? []),
                    ...(dependency.watchFiles ?? [])
                  ])
                ]
              }
            : {})
        }
      : {})
  });
}

export function updateResolutionDependencyKind(
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

export function markResolutionDependencyInspected(
  state: ImportedStaticCssEvalResolutionState,
  file: string
): void {
  for (const [key, dependency] of state.dependencies) {
    if (dependency.file === file) {
      state.dependencies.set(key, { ...dependency, inspected: true });
    }
  }
}

export function markResolutionDependenciesContributed(
  state: ImportedStaticCssEvalResolutionState
): void {
  for (const [key, dependency] of state.dependencies) {
    state.dependencies.set(key, {
      ...dependency,
      contributed: dependency.inspected && dependency.kind !== "unresolved"
    });
  }
}

export function getResolutionDependencies(
  state: ImportedStaticCssEvalResolutionState
): ResolutionDependency[] {
  return [...state.dependencies.values()].map((dependency) => ({
    ...dependency,
    memberPath: [...dependency.memberPath],
    ...(dependency.watchFiles ? { watchFiles: [...dependency.watchFiles] } : {})
  }));
}

export function createResolutionDependencyKey(
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

export function mergeResolutionDependencyKind(
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

export function createImportCycleStackEntry(
  record: ImportedStaticCssEvalModuleRecord,
  request: ImportedStaticCssEvalResolutionRequest
): StaticCssEvalImportCycleKey {
  return {
    file: record.id,
    exportName: request.exportName,
    memberPath: [...request.memberPath]
  };
}

export function createExportStarRequest(
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

export function createExportStarSources(
  exportName: StaticCssEvalExportName,
  candidates: readonly ImportedStaticCssEvalExportStarCandidate[]
): StaticCssModuleExportStarSource[] {
  return candidates.map((candidate) => ({
    entry: candidate.entry,
    exportNames: [exportName]
  }));
}

export function createNamespaceExplicitExportMap(
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

export function addResolutionGuardDependencies(
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

export function createAmbiguousExportStarDiagnostic(
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

export function createAmbiguousExportStarImportChain(
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

export function createResolutionImportChain(
  state: ImportedStaticCssEvalResolutionState,
  nextFile: string
): string[] {
  return [
    state.owner.file,
    ...state.stack.map(formatStaticCssEvalResolutionFrame),
    nextFile
  ];
}

export function formatStaticCssEvalResolutionFrame(
  frame: StaticCssEvalImportCycleKey
): string {
  const memberPath = frame.memberPath?.length
    ? `.${frame.memberPath.join(".")}`
    : "";

  return `${frame.file}#${formatExportName(frame.exportName)}${memberPath}`;
}

export function formatStaticCssEvalQueryExpression(
  query: StaticCssEvalQuery
): string {
  const bindingName = query.bindingName ?? "<unknown>";
  const memberPath = query.memberPath?.length
    ? `.${query.memberPath.join(".")}`
    : "";

  return `${bindingName}${memberPath}`;
}

export function createImportResolutionKey(
  importerId: string,
  importPath: string
): string {
  return `${importerId}${importResolutionKeySeparator}${importPath}`;
}
