import {
  formatPartialEvalDeoptReason,
  type PartialEvalDeoptReason,
  type PartialEvalDiagnostic
} from "./partialEvaluator/index.js";
import { PARTIAL_EVAL_DEOPT_TAXONOMY } from "./deopt.js";
import { STATIC_CSS_EVAL_SUPPORT_MATRIX } from "./types.js";
import type {
  StaticCssEvalDiagnostic,
  StaticCssEvalDiagnosticCategory,
  StaticCssEvalDiagnosticCode,
  StaticCssEvalDiagnosticId,
  StaticCssEvalDiagnosticSeverity,
  StaticCssEvalExportName,
  StaticCssEvalSourceKind,
  StaticCssEvalSourceLocation,
  StaticCssEvalSourceOrigin,
  StaticCssEvalSupportMatrixEntry,
  StaticCssEvalUnsupportedReason
} from "./types.js";

export const STATIC_CSS_EVAL_DIAGNOSTIC_MESSAGE_PREFIX =
  "Cannot statically evaluate css prop value";

export const STATIC_CSS_EVAL_RESOLUTION_DEPTH_LIMIT = 32;

export interface StaticCssEvalDiagnosticContext {
  owner: StaticCssEvalSourceLocation;
  dependency?: StaticCssEvalSourceLocation;
  importPath?: string;
  exportName?: StaticCssEvalExportName;
  memberPath?: readonly string[];
  importChain?: readonly string[];
}

export interface CreateStaticCssEvalDiagnosticOptions extends StaticCssEvalDiagnosticContext {
  id?: StaticCssEvalDiagnosticId;
  code: StaticCssEvalDiagnosticCode;
  reason: StaticCssEvalUnsupportedReason;
  expressionType?: string;
  detail: string;
}

export interface StaticCssEvalImportCycleKey {
  file: string;
  exportName: StaticCssEvalExportName;
  memberPath?: readonly string[];
}

export interface StaticCssEvalImportCycleGuardOptions extends StaticCssEvalDiagnosticContext {
  stack: readonly StaticCssEvalImportCycleKey[];
  next: StaticCssEvalImportCycleKey;
}

export interface StaticCssEvalResolutionDepthGuardOptions extends StaticCssEvalDiagnosticContext {
  resolutionDepth: number;
  maxResolutionDepth?: number;
}

export interface StaticCssEvalProviderSourceUnsupportedOptions extends StaticCssEvalDiagnosticContext {
  sourceId: string;
  sourceKind: StaticCssEvalSourceKind;
  sourceOrigin: StaticCssEvalSourceOrigin;
  reason: StaticCssEvalUnsupportedReason;
}

export interface StaticCssEvalPartialNamespaceFailureOptions extends StaticCssEvalDiagnosticContext {
  failedReason: StaticCssEvalUnsupportedReason;
}

export type StaticCssEvalGuardResult =
  | { ok: true }
  | {
      ok: false;
      diagnostic: StaticCssEvalDiagnostic;
      dependencies: string[];
    };

interface StaticCssEvalDiagnosticRegistryEntry {
  readonly category: StaticCssEvalDiagnosticCategory;
  readonly severity: StaticCssEvalDiagnosticSeverity;
  readonly help: string;
  readonly supportMatrix: StaticCssEvalSupportMatrixEntry;
}

const SUPPORT_MATRIX = {
  mutation: getStaticCssEvalSupportMatrixEntry(
    "`const style = {...}; style.color = ...`"
  ),
  dynamicKey: getStaticCssEvalSupportMatrixEntry(
    "Dynamic computed object keys or member paths"
  ),
  dynamicSpread: getStaticCssEvalSupportMatrixEntry(
    "Dynamic or wrong-shape object/array spread operands"
  ),
  dynamicMember: getStaticCssEvalSupportMatrixEntry(
    "Dynamic, destructured, or unsupported namespace access"
  ),
  providerSource: getStaticCssEvalSupportMatrixEntry(
    "Provider/external modules without loadable source"
  ),
  exportStar: getStaticCssEvalSupportMatrixEntry(
    'Provider-backed export-star barrel graph (`export * from "./x"`)'
  ),
  namespace: getStaticCssEvalSupportMatrixEntry(
    "Dynamic, destructured, or unsupported namespace access"
  ),
  namespaceReexport: getStaticCssEvalSupportMatrixEntry(
    'Namespace re-export (`export * as ns from "./x"`)'
  ),
  commonjs: getStaticCssEvalSupportMatrixEntry(
    "Dynamic, non-const, shadowed, or unsafe CommonJS `require(...)` paths"
  ),
  importDepth: getStaticCssEvalSupportMatrixEntry(
    "Provider-backed package, `node_modules`, and outside-root ESM source"
  ),
  calls: getStaticCssEvalSupportMatrixEntry(
    "Nested calls, functions, and optional calls in static css values"
  ),
  runtimeShape: getStaticCssEvalSupportMatrixEntry("Runtime dynamic values"),
  templateInterpolation: getStaticCssEvalSupportMatrixEntry(
    "Template interpolation with runtime or non-primitive values"
  )
} as const;

const STATIC_CSS_EVAL_DIAGNOSTIC_REGISTRY = {
  STATIC_CSS_EVAL_LOCAL_ALIAS_CYCLE: registryEntry(
    "project-cache",
    "Break the local alias cycle or inline one side of the static css binding.",
    SUPPORT_MATRIX.importDepth
  ),
  STATIC_CSS_EVAL_MUTABLE_BINDING: registryEntry(
    "binding-provenance",
    "Use an unmutated const binding for css-rule candidates.",
    SUPPORT_MATRIX.mutation
  ),
  STATIC_CSS_EVAL_MUTATED_BINDING: registryEntry(
    "binding-provenance",
    "Remove writes to the css binding or move the dynamic value to a supported runtime leaf.",
    SUPPORT_MATRIX.mutation
  ),
  STATIC_CSS_EVAL_UNSUPPORTED_CALL_EXPRESSION: registryEntry(
    "sidecar-hoistability",
    "Babel does not execute user functions; keep nested css values as static literals or hoist a whole rule through the sidecar path.",
    SUPPORT_MATRIX.calls
  ),
  STATIC_CSS_EVAL_NON_STATIC_OBJECT_KEY: registryEntry(
    "syntax-reducer",
    "Use a literal or statically resolved string/number object key.",
    SUPPORT_MATRIX.dynamicKey
  ),
  STATIC_CSS_EVAL_UNSUPPORTED_SPREAD: registryEntry(
    "syntax-reducer",
    "Spread only statically resolved object or array literals of the matching shape.",
    SUPPORT_MATRIX.dynamicSpread
  ),
  STATIC_CSS_EVAL_UNSUPPORTED_COMPUTED_MEMBER: registryEntry(
    "syntax-reducer",
    "Use a statically known member path before crossing the static css eval boundary.",
    SUPPORT_MATRIX.dynamicKey
  ),
  STATIC_CSS_EVAL_RUNTIME_CSS_SHAPE_UNSUPPORTED: registryEntry(
    "policy",
    "Keep css-rule object shape static; move only supported declaration leaf values to runtime.",
    SUPPORT_MATRIX.runtimeShape
  ),
  STATIC_CSS_EVAL_TEMPLATE_INTERPOLATION_UNSUPPORTED: registryEntry(
    "syntax-reducer",
    "Template interpolations must reduce to static string, number, boolean, or null primitives.",
    SUPPORT_MATRIX.templateInterpolation
  ),
  STATIC_CSS_EVAL_PARTIAL_EVAL_DEPTH_EXCEEDED: registryEntry(
    "project-cache",
    "Reduce the static css binding graph depth or split the rule into smaller static bindings.",
    SUPPORT_MATRIX.importDepth
  ),
  STATIC_CSS_EVAL_PARTIAL_EVAL_NODE_COUNT_EXCEEDED: registryEntry(
    "project-cache",
    "Reduce the static css literal size before it crosses the Babel static-eval boundary.",
    SUPPORT_MATRIX.importDepth
  ),
  STATIC_CSS_EVAL_UNSUPPORTED_ARRAY_ELEMENT: registryEntry(
    "syntax-reducer",
    "Use only static css-rule objects or supported static spreads in css arrays.",
    SUPPORT_MATRIX.dynamicSpread
  ),
  STATIC_CSS_EVAL_OBJECT_SPREAD_UNSUPPORTED: registryEntry(
    "syntax-reducer",
    "Spread only statically resolved object or array literals of the matching shape.",
    SUPPORT_MATRIX.dynamicSpread
  ),
  STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED: registryEntry(
    "syntax-reducer",
    "Use a statically known member path before crossing the static css eval boundary.",
    SUPPORT_MATRIX.dynamicKey
  ),
  STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED: registryEntry(
    "policy",
    "Keep css-rule shape static; unsupported runtime expressions cannot be evaluated by Babel.",
    SUPPORT_MATRIX.runtimeShape
  ),
  STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED: registryEntry(
    "dependency-source",
    "Configure the bundler/source provider to return deterministic ESM source or keep the css value project-local.",
    SUPPORT_MATRIX.providerSource
  ),
  STATIC_CSS_EVAL_EXPORT_STAR_UNSUPPORTED: registryEntry(
    "dependency-source",
    "Use explicit exports or provider-backed export-star metadata that can be resolved without executing modules.",
    SUPPORT_MATRIX.exportStar
  ),
  STATIC_CSS_EVAL_EXPORT_STAR_AMBIGUOUS: registryEntry(
    "dependency-source",
    "Resolve the ambiguous export-star name with an explicit re-export.",
    SUPPORT_MATRIX.exportStar
  ),
  STATIC_CSS_EVAL_NAMESPACE_UNSUPPORTED: registryEntry(
    "dependency-source",
    "Use a static namespace member path that resolves to a literal export.",
    SUPPORT_MATRIX.namespace
  ),
  STATIC_CSS_EVAL_NAMESPACE_REEXPORT_UNSUPPORTED: registryEntry(
    "dependency-source",
    "Use direct named/default re-exports instead of namespace re-export entries.",
    SUPPORT_MATRIX.namespaceReexport
  ),
  STATIC_CSS_EVAL_NAMESPACE_PARTIAL_UNSUPPORTED: registryEntry(
    "dependency-source",
    "Fix the failed namespace export or import the supported member directly.",
    SUPPORT_MATRIX.namespace
  ),
  STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED: registryEntry(
    "dependency-source",
    "Use a static literal require path or ESM source provider metadata.",
    SUPPORT_MATRIX.commonjs
  ),
  STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED: registryEntry(
    "dependency-source",
    "Expose static CJS exports or ESM source; runtime export mutation is not executed.",
    SUPPORT_MATRIX.commonjs
  ),
  STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED: registryEntry(
    "dependency-source",
    "Use supported static CJS helper output or ESM source provider metadata.",
    SUPPORT_MATRIX.commonjs
  ),
  STATIC_CSS_EVAL_CJS_BUNDLE_RUNTIME_UNSUPPORTED: registryEntry(
    "dependency-source",
    "Provide source before bundler runtime wrapping; Babel static eval will not run bundle bootstraps.",
    SUPPORT_MATRIX.commonjs
  ),
  STATIC_CSS_EVAL_CJS_UNSUPPORTED: registryEntry(
    "dependency-source",
    "Use supported AST-only CommonJS forms or ESM source.",
    SUPPORT_MATRIX.commonjs
  ),
  STATIC_CSS_EVAL_IMPORT_CYCLE: registryEntry(
    "project-cache",
    "Break the static css import cycle or import a non-cyclic leaf binding.",
    SUPPORT_MATRIX.importDepth
  ),
  STATIC_CSS_EVAL_UNRESOLVED_IMPORT: registryEntry(
    "dependency-source",
    "Ensure the source provider can resolve this import path for static css evaluation.",
    SUPPORT_MATRIX.providerSource
  ),
  STATIC_CSS_EVAL_UNRESOLVED_EXPORT: registryEntry(
    "dependency-source",
    "Export the requested binding explicitly or update the import member path.",
    SUPPORT_MATRIX.exportStar
  ),
  STATIC_CSS_EVAL_RESOLUTION_DEPTH_EXCEEDED: registryEntry(
    "project-cache",
    "Reduce the static css dependency chain depth.",
    SUPPORT_MATRIX.importDepth
  )
} as const satisfies Record<
  StaticCssEvalDiagnosticId,
  StaticCssEvalDiagnosticRegistryEntry
>;

export function createStaticCssEvalDiagnostic(
  options: CreateStaticCssEvalDiagnosticOptions
): StaticCssEvalDiagnostic {
  const registry = options.id
    ? STATIC_CSS_EVAL_DIAGNOSTIC_REGISTRY[options.id]
    : undefined;
  const diagnostic: StaticCssEvalDiagnostic = {
    ...(options.id !== undefined ? { id: options.id } : {}),
    code: options.code,
    message: formatStaticCssEvalDiagnosticMessage(options.detail),
    reason: options.reason,
    ...(options.expressionType !== undefined
      ? { expressionType: options.expressionType }
      : {}),
    owner: cloneSourceLocation(options.owner)
  };

  if (registry !== undefined) {
    diagnostic.category = registry.category;
    diagnostic.severity = registry.severity;
    diagnostic.help = registry.help;
    diagnostic.supportMatrix = registry.supportMatrix;
  }

  if (options.dependency) {
    diagnostic.dependency = cloneSourceLocation(options.dependency);
  }

  if (options.importPath !== undefined) {
    diagnostic.importPath = options.importPath;
  }

  if (options.exportName !== undefined) {
    diagnostic.exportName = options.exportName;
  }

  if (options.memberPath) {
    diagnostic.memberPath = [...options.memberPath];
  }

  if (options.importChain) {
    diagnostic.importChain = [...options.importChain];
  }

  return diagnostic;
}

export function createStaticCssEvalPartialEvalDeoptDiagnostic(
  diagnostic: PartialEvalDiagnostic
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: getStaticCssEvalPartialEvalDeoptDiagnosticId(diagnostic.reason),
    code: getStaticCssEvalPartialEvalDeoptDiagnosticCode(diagnostic.reason),
    reason: getStaticCssEvalPartialEvalUnsupportedReason(diagnostic.reason),
    detail: getStaticCssEvalPartialEvalDeoptDetail(diagnostic),
    owner: diagnostic.owner,
    memberPath: diagnostic.memberPath
  });
}

function registryEntry(
  category: StaticCssEvalDiagnosticCategory,
  help: string,
  supportMatrix: StaticCssEvalSupportMatrixEntry
): StaticCssEvalDiagnosticRegistryEntry {
  return { category, severity: "error", help, supportMatrix };
}

function getStaticCssEvalSupportMatrixEntry(
  construct: string
): StaticCssEvalSupportMatrixEntry {
  const entry = STATIC_CSS_EVAL_SUPPORT_MATRIX.find((candidate) => {
    return candidate.construct === construct;
  });

  if (entry !== undefined) {
    return entry;
  }

  throw new Error(`Missing static css eval support matrix row: ${construct}`);
}

export function createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
  context: StaticCssEvalDiagnosticContext,
  expressionType: string,
  detail = expressionType
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED",
    code: "unsupported-source",
    reason: "runtime-dynamic-value",
    expressionType,
    detail: `dynamic expression is unsupported: ${detail}`,
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalMutableBindingDiagnostic(
  context: StaticCssEvalDiagnosticContext,
  bindingName: string
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_MUTABLE_BINDING",
    code: "unsupported-source",
    reason: "let-or-var-binding",
    detail: `binding "${bindingName}" is mutable`,
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalMutatedBindingDiagnostic(
  context: StaticCssEvalDiagnosticContext,
  bindingName: string
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_MUTATED_BINDING",
    code: "unsupported-source",
    reason: "mutated-binding",
    detail: `binding "${bindingName}" is mutated`,
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalObjectSpreadUnsupportedDiagnostic(
  context: StaticCssEvalDiagnosticContext,
  bindingName: string,
  collection: "object" | "array" = "object"
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_OBJECT_SPREAD_UNSUPPORTED",
    code: "unsupported-syntax",
    reason: "object-or-array-spread",
    detail: `static css-rule binding "${bindingName}" contains an unsupported ${collection} spread operand`,
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalComputedMemberUnsupportedDiagnostic(
  context: StaticCssEvalDiagnosticContext
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED",
    code: "unsupported-source",
    reason: "dynamic-member-path",
    detail: "computed member access is unsupported",
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalProviderSourceUnsupportedDiagnostic(
  options: StaticCssEvalProviderSourceUnsupportedOptions
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
    code: "unsupported-source",
    reason: options.reason,
    detail: formatStaticCssEvalProviderSourceUnsupportedDetail(options),
    owner: options.owner,
    dependency: options.dependency,
    importPath: options.importPath,
    exportName: options.exportName,
    memberPath: options.memberPath,
    importChain: options.importChain
  });
}

export function createStaticCssEvalAmbiguousExportStarDiagnostic(
  context: StaticCssEvalDiagnosticContext,
  exportName: StaticCssEvalExportName
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_EXPORT_STAR_AMBIGUOUS",
    code: "unsupported-source",
    reason: "ambiguous-star",
    detail: `export "${exportName ?? "<local>"}" is ambiguous across export-star sources`,
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalCjsUnsupportedDiagnostic(
  context: StaticCssEvalDiagnosticContext
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_CJS_UNSUPPORTED",
    code: "unsupported-source",
    reason: "commonjs-require",
    detail: "commonjs require is unsupported",
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalCjsDynamicRequireUnsupportedDiagnostic(
  context: StaticCssEvalDiagnosticContext
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED",
    code: "unsupported-source",
    reason: "commonjs-require",
    detail: "commonjs dynamic require is unsupported",
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalCjsExportUnsupportedDiagnostic(
  context: StaticCssEvalDiagnosticContext,
  exportMutation: string
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED",
    code: "unsupported-source",
    reason: "unsupported-source-shape",
    detail: `commonjs export mutation is unsupported: ${exportMutation}`,
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalCjsHelperUnsupportedDiagnostic(
  context: StaticCssEvalDiagnosticContext,
  helperName: string
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED",
    code: "unsupported-source",
    reason: "unsupported-source-shape",
    detail: `commonjs helper is unsupported: ${helperName}`,
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalCjsBundleRuntimeUnsupportedDiagnostic(
  context: StaticCssEvalDiagnosticContext,
  runtimeName: string
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_CJS_BUNDLE_RUNTIME_UNSUPPORTED",
    code: "unsupported-source",
    reason: "runtime-dynamic-value",
    detail: `commonjs bundle runtime is unsupported: ${runtimeName}`,
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalExportStarUnsupportedDiagnostic(
  context: StaticCssEvalDiagnosticContext,
  importPath: string
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_EXPORT_STAR_UNSUPPORTED",
    code: "unsupported-source",
    reason: "reexport-or-barrel",
    detail: `export * from "${importPath}" is unsupported`,
    owner: context.owner,
    dependency: context.dependency,
    importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalNamespaceReexportUnsupportedDiagnostic(
  context: StaticCssEvalDiagnosticContext,
  importPath: string
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_NAMESPACE_REEXPORT_UNSUPPORTED",
    code: "unsupported-source",
    reason: "unsupported-namespace-reexport",
    detail: `namespace re-export from "${importPath}" is unsupported`,
    owner: context.owner,
    dependency: context.dependency,
    importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalPartialNamespaceFailureDiagnostic(
  options: StaticCssEvalPartialNamespaceFailureOptions
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_NAMESPACE_PARTIAL_UNSUPPORTED",
    code: "unsupported-source",
    reason: "partial-namespace-failure",
    detail: `namespace import cannot be partially evaluated because export "${options.exportName ?? "<local>"}" failed with reason "${options.failedReason}"`,
    owner: options.owner,
    dependency: options.dependency,
    importPath: options.importPath,
    exportName: options.exportName,
    memberPath: options.memberPath,
    importChain: options.importChain
  });
}

export function createStaticCssEvalNamespaceMemberUnsupportedDiagnostic(
  context: StaticCssEvalDiagnosticContext,
  memberPath: readonly string[]
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_NAMESPACE_UNSUPPORTED",
    code: "unsupported-source",
    reason: "dynamic-member-path",
    detail: `namespace member access ${memberPath.join(".")} is unsupported`,
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalUnresolvedImportDiagnostic(
  context: StaticCssEvalDiagnosticContext,
  importPath: string,
  failureDetail?: string
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
    code: "unsupported-source",
    reason: "failed-project-local-dependency",
    detail: `import "${importPath}" could not be resolved${
      failureDetail ? `: ${failureDetail}` : ""
    }`,
    owner: context.owner,
    dependency: context.dependency,
    importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalUnresolvedExportDiagnostic(
  context: StaticCssEvalDiagnosticContext,
  exportName: StaticCssEvalExportName
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT",
    code: "unsupported-source",
    reason: "reexport-or-barrel",
    detail: `export "${exportName ?? "<local>"}" could not be resolved`,
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function createStaticCssEvalImportCycleKey(
  input: StaticCssEvalImportCycleKey
): string {
  return JSON.stringify([
    input.file,
    input.exportName,
    [...(input.memberPath ?? [])]
  ]);
}

export function guardStaticCssEvalImportCycle(
  options: StaticCssEvalImportCycleGuardOptions
): StaticCssEvalGuardResult {
  const nextKey = createStaticCssEvalImportCycleKey(options.next);
  const cycleStartIndex = options.stack.findIndex((entry) => {
    return createStaticCssEvalImportCycleKey(entry) === nextKey;
  });

  if (cycleStartIndex === -1) {
    return { ok: true };
  }

  const cycle = [...options.stack.slice(cycleStartIndex), options.next];
  const importChain = cycle.map(formatStaticCssEvalImportCycleFrame);
  const diagnostic = createStaticCssEvalImportCycleDiagnostic({
    owner: options.owner,
    dependency: { file: options.next.file },
    importPath: options.importPath,
    exportName: options.next.exportName,
    memberPath: options.next.memberPath,
    importChain
  });

  return {
    ok: false,
    diagnostic,
    dependencies: getStaticCssEvalImportCycleDependencies(
      cycle,
      options.owner.file
    )
  };
}

export function createStaticCssEvalImportCycleDiagnostic(
  context: StaticCssEvalDiagnosticContext & {
    importChain: readonly string[];
  }
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_IMPORT_CYCLE",
    code: "cycle-detected",
    reason: "runtime-dynamic-value",
    detail: `cyclic static css reference detected: ${context.importChain.join(
      " -> "
    )}`,
    owner: context.owner,
    dependency: context.dependency,
    importPath: context.importPath,
    exportName: context.exportName,
    memberPath: context.memberPath,
    importChain: context.importChain
  });
}

export function guardStaticCssEvalResolutionDepth(
  options: StaticCssEvalResolutionDepthGuardOptions
): StaticCssEvalGuardResult {
  const limit =
    options.maxResolutionDepth ?? STATIC_CSS_EVAL_RESOLUTION_DEPTH_LIMIT;

  if (options.resolutionDepth <= limit) {
    return { ok: true };
  }

  const diagnostic = createStaticCssEvalResolutionDepthExceededDiagnostic({
    owner: options.owner,
    dependency: options.dependency,
    importPath: options.importPath,
    exportName: options.exportName,
    memberPath: options.memberPath,
    resolutionDepth: options.resolutionDepth,
    maxResolutionDepth: limit
  });

  return {
    ok: false,
    diagnostic,
    dependencies: getStaticCssEvalDiagnosticDependencies(diagnostic).filter(
      (file) => file !== options.owner.file
    )
  };
}

export function createStaticCssEvalResolutionDepthExceededDiagnostic(
  options: StaticCssEvalResolutionDepthGuardOptions
): StaticCssEvalDiagnostic {
  const limit =
    options.maxResolutionDepth ?? STATIC_CSS_EVAL_RESOLUTION_DEPTH_LIMIT;

  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_RESOLUTION_DEPTH_EXCEEDED",
    code: "limit-exceeded",
    reason: "failed-project-local-dependency",
    detail: `resolution depth exceeded (${options.resolutionDepth} steps > ${limit} steps)`,
    owner: options.owner,
    dependency: options.dependency,
    importPath: options.importPath,
    exportName: options.exportName,
    memberPath: options.memberPath
  });
}

export function formatStaticCssEvalDiagnosticMessage(detail: string): string {
  return `${STATIC_CSS_EVAL_DIAGNOSTIC_MESSAGE_PREFIX}: ${detail}`;
}

function formatStaticCssEvalProviderSourceUnsupportedDetail(
  options: StaticCssEvalProviderSourceUnsupportedOptions
): string {
  switch (options.reason) {
    case "external-no-source":
      return `external module "${options.sourceId}" has no provider source`;
    case "provider-virtual-no-source":
      return `provider virtual module "${options.sourceId}" has no source from the bundler provider`;
    case "dynamic-import":
      return `dynamic import graph "${options.sourceId}" is unsupported`;
    case "runtime-wasm-init":
      return `runtime wasm init output "${options.sourceId}" is unsupported`;
    case "runtime-wasm-module":
      return `runtime wasm module output "${options.sourceId}" is unsupported`;
    case "runtime-wasm-init-or-function":
      return `runtime wasm init/function output "${options.sourceId}" is unsupported`;
    case "invalid-json-data":
      return `JSON data source "${options.sourceId}" is not valid JSON`;
    case "source-size-limit-exceeded":
      return `source "${options.sourceId}" exceeds the static css eval source size limit`;
    case "non-literal-loader-output":
      return `loader output "${options.sourceId}" is not a static literal`;
    case "unresolved":
      return `module "${options.sourceId}" could not be resolved by the provider`;
    default:
      return `provider source kind "${options.sourceKind}" from origin "${options.sourceOrigin}" is unsupported`;
  }
}

function getStaticCssEvalPartialEvalDeoptDiagnosticCode(
  reason: PartialEvalDeoptReason
): StaticCssEvalDiagnosticCode {
  switch (reason) {
    case "mutated-binding":
      return "mutation-detected";
    case "unsupported-import":
      return "unsupported-source";
    case "unsupported-call-expression":
    case "non-static-object-key":
    case "unsupported-spread":
    case "unsupported-computed-member":
    case "runtime-css-shape":
    case "unsupported-template-interpolation":
      return "unsupported-syntax";
    case "cycle-detected":
      return "cycle-detected";
    case "depth-limit":
    case "node-count-limit":
      return "limit-exceeded";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function getStaticCssEvalPartialEvalDeoptDiagnosticId(
  reason: PartialEvalDeoptReason
): StaticCssEvalDiagnosticId {
  const mappedReason: PartialEvalDeoptReason =
    PARTIAL_EVAL_DEOPT_TAXONOMY[reason].reason;

  switch (mappedReason) {
    case "mutated-binding":
      return "STATIC_CSS_EVAL_MUTATED_BINDING";
    case "unsupported-import":
      return "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED";
    case "unsupported-call-expression":
      return "STATIC_CSS_EVAL_UNSUPPORTED_CALL_EXPRESSION";
    case "non-static-object-key":
      return "STATIC_CSS_EVAL_NON_STATIC_OBJECT_KEY";
    case "unsupported-spread":
      return "STATIC_CSS_EVAL_UNSUPPORTED_SPREAD";
    case "unsupported-computed-member":
      return "STATIC_CSS_EVAL_UNSUPPORTED_COMPUTED_MEMBER";
    case "runtime-css-shape":
      return "STATIC_CSS_EVAL_RUNTIME_CSS_SHAPE_UNSUPPORTED";
    case "unsupported-template-interpolation":
      return "STATIC_CSS_EVAL_TEMPLATE_INTERPOLATION_UNSUPPORTED";
    case "cycle-detected":
      return "STATIC_CSS_EVAL_IMPORT_CYCLE";
    case "depth-limit":
      return "STATIC_CSS_EVAL_PARTIAL_EVAL_DEPTH_EXCEEDED";
    case "node-count-limit":
      return "STATIC_CSS_EVAL_PARTIAL_EVAL_NODE_COUNT_EXCEEDED";
    default: {
      const exhaustive: never = mappedReason;
      return exhaustive;
    }
  }
}

function getStaticCssEvalPartialEvalUnsupportedReason(
  reason: PartialEvalDeoptReason
): StaticCssEvalUnsupportedReason {
  switch (reason) {
    case "mutated-binding":
      return "mutated-binding";
    case "unsupported-import":
      return "failed-project-local-dependency";
    case "unsupported-call-expression":
      return "function-or-call";
    case "non-static-object-key":
      return "computed-object-key";
    case "unsupported-spread":
      return "object-or-array-spread";
    case "unsupported-computed-member":
      return "dynamic-member-path";
    case "runtime-css-shape":
    case "cycle-detected":
      return "runtime-dynamic-value";
    case "unsupported-template-interpolation":
      return "template-expression";
    case "depth-limit":
    case "node-count-limit":
      return "failed-project-local-dependency";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function getStaticCssEvalPartialEvalDeoptDetail(
  diagnostic: PartialEvalDiagnostic
): string {
  switch (diagnostic.reason) {
    case "mutated-binding":
      return diagnostic.bindingName
        ? `same-file binding "${diagnostic.bindingName}" is mutated`
        : "same-file binding is mutated";
    case "unsupported-import":
      return diagnostic.bindingName
        ? `imported binding "${diagnostic.bindingName}" must be resolved by the static css provider`
        : "imported binding must be resolved by the static css provider";
    case "cycle-detected":
      return diagnostic.bindingName
        ? `binding cycle detected while resolving "${diagnostic.bindingName}"`
        : "binding cycle detected";
    default:
      return (
        diagnostic.detail ?? formatPartialEvalDeoptReason(diagnostic.reason)
      );
  }
}

export function getStaticCssEvalDiagnosticDependencies(
  diagnostic: StaticCssEvalDiagnostic
): string[] {
  const dependencies = new Set<string>();

  if (diagnostic.dependency) {
    dependencies.add(diagnostic.dependency.file);
  }

  return [...dependencies];
}

function cloneSourceLocation(
  location: StaticCssEvalSourceLocation
): StaticCssEvalSourceLocation {
  return { ...location };
}

function formatStaticCssEvalImportCycleFrame(
  frame: StaticCssEvalImportCycleKey
): string {
  const exportName = frame.exportName === null ? "<local>" : frame.exportName;
  const memberPath = frame.memberPath?.length
    ? `.${frame.memberPath.join(".")}`
    : "";

  return `${frame.file}#${exportName}${memberPath}`;
}

function getStaticCssEvalImportCycleDependencies(
  cycle: readonly StaticCssEvalImportCycleKey[],
  ownerFile: string
): string[] {
  const dependencies = new Set<string>();

  for (const frame of cycle) {
    if (frame.file !== ownerFile) {
      dependencies.add(frame.file);
    }
  }

  return [...dependencies];
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;

  describe("static css eval diagnostics", () => {
    it("creates deterministic css prop diagnostics with cloned metadata", () => {
      const owner = { file: "/project/src/App.tsx", start: 10, end: 20 };
      const diagnostic = createStaticCssEvalDiagnostic({
        code: "unsupported-source",
        reason: "not-project-local",
        detail: "dependency is outside the project root",
        owner,
        dependency: { file: "/outside/style.ts" },
        importPath: "pkg/style",
        exportName: "button",
        memberPath: ["root"],
        importChain: ["/project/src/App.tsx", "/outside/style.ts#button.root"]
      });

      owner.file = "/mutated.tsx";

      expect(diagnostic).toEqual({
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: dependency is outside the project root",
        reason: "not-project-local",
        owner: { file: "/project/src/App.tsx", start: 10, end: 20 },
        dependency: { file: "/outside/style.ts" },
        importPath: "pkg/style",
        exportName: "button",
        memberPath: ["root"],
        importChain: ["/project/src/App.tsx", "/outside/style.ts#button.root"]
      });
      expect(getStaticCssEvalDiagnosticDependencies(diagnostic)).toEqual([
        "/outside/style.ts"
      ]);
    });

    it("documents advanced static rule boundary diagnostics", () => {
      const owner = { file: "/project/src/App.tsx", start: 30, end: 60 };

      expect(
        createStaticCssEvalComputedMemberUnsupportedDiagnostic({ owner })
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: computed member access is unsupported",
        reason: "dynamic-member-path",
        owner
      });
      expect(
        createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          { owner },
          "OptionalCallExpression"
        )
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: dynamic expression is unsupported: OptionalCallExpression",
        reason: "runtime-dynamic-value",
        expressionType: "OptionalCallExpression",
        owner
      });
      expect(
        createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          { owner },
          "OptionalMemberExpression"
        )
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: dynamic expression is unsupported: OptionalMemberExpression",
        reason: "runtime-dynamic-value",
        expressionType: "OptionalMemberExpression",
        owner
      });
      expect(
        createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          { owner },
          "Identifier"
        )
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: dynamic expression is unsupported: Identifier",
        reason: "runtime-dynamic-value",
        expressionType: "Identifier",
        owner
      });
      expect(
        createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          { owner },
          "CallExpression"
        )
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: dynamic expression is unsupported: CallExpression",
        reason: "runtime-dynamic-value",
        expressionType: "CallExpression",
        owner
      });
      expect(
        createStaticCssEvalCjsDynamicRequireUnsupportedDiagnostic({ owner })
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: commonjs dynamic require is unsupported",
        reason: "commonjs-require",
        owner
      });
    });

    it("builds stable diagnostics for unsupported source cases", () => {
      const owner = { file: "/project/src/App.tsx", start: 1, end: 2 };
      const dependency = { file: "/project/src/styles.ts" };

      expect(
        createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          { owner },
          "CallExpression"
        )
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: dynamic expression is unsupported: CallExpression",
        reason: "runtime-dynamic-value",
        expressionType: "CallExpression",
        owner
      });

      expect(
        createStaticCssEvalMutableBindingDiagnostic({ owner }, "style")
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_MUTABLE_BINDING",
        code: "unsupported-source",
        message:
          'Cannot statically evaluate css prop value: binding "style" is mutable',
        reason: "let-or-var-binding",
        owner
      });

      expect(
        createStaticCssEvalMutatedBindingDiagnostic({ owner }, "style")
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_MUTATED_BINDING",
        code: "unsupported-source",
        message:
          'Cannot statically evaluate css prop value: binding "style" is mutated',
        reason: "mutated-binding",
        owner
      });

      expect(
        createStaticCssEvalObjectSpreadUnsupportedDiagnostic({ owner }, "style")
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_OBJECT_SPREAD_UNSUPPORTED",
        code: "unsupported-syntax",
        message:
          'Cannot statically evaluate css prop value: static css-rule binding "style" contains an unsupported object spread operand',
        reason: "object-or-array-spread",
        owner
      });

      expect(
        createStaticCssEvalObjectSpreadUnsupportedDiagnostic(
          { owner },
          "style",
          "array"
        )
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_OBJECT_SPREAD_UNSUPPORTED",
        code: "unsupported-syntax",
        message:
          'Cannot statically evaluate css prop value: static css-rule binding "style" contains an unsupported array spread operand',
        reason: "object-or-array-spread",
        owner
      });

      expect(
        createStaticCssEvalComputedMemberUnsupportedDiagnostic({ owner })
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: computed member access is unsupported",
        reason: "dynamic-member-path",
        owner
      });

      expect(
        createStaticCssEvalProviderSourceUnsupportedDiagnostic({
          owner,
          dependency: { file: "external:pkg/styles" },
          importPath: "pkg/styles",
          exportName: "button",
          sourceId: "external:pkg/styles",
          sourceKind: "external-no-source",
          sourceOrigin: "external",
          reason: "external-no-source"
        })
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
        code: "unsupported-source",
        message:
          'Cannot statically evaluate css prop value: external module "external:pkg/styles" has no provider source',
        reason: "external-no-source",
        owner,
        dependency: { file: "external:pkg/styles" },
        importPath: "pkg/styles",
        exportName: "button"
      });

      expect(
        createStaticCssEvalCjsUnsupportedDiagnostic({ owner })
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_CJS_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: commonjs require is unsupported",
        reason: "commonjs-require",
        owner
      });

      expect(
        createStaticCssEvalCjsDynamicRequireUnsupportedDiagnostic({ owner })
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: commonjs dynamic require is unsupported",
        reason: "commonjs-require",
        owner
      });

      expect(
        createStaticCssEvalCjsExportUnsupportedDiagnostic(
          { owner },
          "conditional module.exports assignment"
        )
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: commonjs export mutation is unsupported: conditional module.exports assignment",
        reason: "unsupported-source-shape",
        owner
      });

      expect(
        createStaticCssEvalCjsHelperUnsupportedDiagnostic(
          { owner },
          "__exportStar"
        )
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: commonjs helper is unsupported: __exportStar",
        reason: "unsupported-source-shape",
        owner
      });

      expect(
        createStaticCssEvalCjsBundleRuntimeUnsupportedDiagnostic(
          { owner },
          "webpack bootstrap"
        )
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_CJS_BUNDLE_RUNTIME_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: commonjs bundle runtime is unsupported: webpack bootstrap",
        reason: "runtime-dynamic-value",
        owner
      });

      expect(
        createStaticCssEvalExportStarUnsupportedDiagnostic(
          { owner, dependency },
          "./barrel"
        )
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_EXPORT_STAR_UNSUPPORTED",
        code: "unsupported-source",
        message:
          'Cannot statically evaluate css prop value: export * from "./barrel" is unsupported',
        reason: "reexport-or-barrel",
        owner,
        dependency,
        importPath: "./barrel"
      });

      expect(
        createStaticCssEvalNamespaceReexportUnsupportedDiagnostic(
          { owner },
          "./styles"
        )
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_NAMESPACE_REEXPORT_UNSUPPORTED",
        code: "unsupported-source",
        message:
          'Cannot statically evaluate css prop value: namespace re-export from "./styles" is unsupported',
        reason: "unsupported-namespace-reexport",
        owner,
        importPath: "./styles"
      });

      expect(
        createStaticCssEvalPartialNamespaceFailureDiagnostic({
          owner,
          dependency,
          importPath: "./styles",
          exportName: "dynamic",
          failedReason: "function-or-call"
        })
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_NAMESPACE_PARTIAL_UNSUPPORTED",
        code: "unsupported-source",
        message:
          'Cannot statically evaluate css prop value: namespace import cannot be partially evaluated because export "dynamic" failed with reason "function-or-call"',
        reason: "partial-namespace-failure",
        owner,
        dependency,
        importPath: "./styles",
        exportName: "dynamic"
      });

      expect(
        createStaticCssEvalAmbiguousExportStarDiagnostic(
          { owner, dependency, importPath: "./barrel" },
          "button"
        )
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_EXPORT_STAR_AMBIGUOUS",
        code: "unsupported-source",
        message:
          'Cannot statically evaluate css prop value: export "button" is ambiguous across export-star sources',
        reason: "ambiguous-star",
        owner,
        dependency,
        importPath: "./barrel",
        exportName: "button"
      });

      expect(
        createStaticCssEvalNamespaceMemberUnsupportedDiagnostic({ owner }, [
          "styles",
          "button"
        ])
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_NAMESPACE_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: namespace member access styles.button is unsupported",
        reason: "dynamic-member-path",
        owner,
        memberPath: ["styles", "button"]
      });

      expect(
        createStaticCssEvalUnresolvedImportDiagnostic(
          { owner, dependency },
          "./missing"
        )
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
        code: "unsupported-source",
        message:
          'Cannot statically evaluate css prop value: import "./missing" could not be resolved',
        reason: "failed-project-local-dependency",
        owner,
        dependency,
        importPath: "./missing"
      });

      expect(
        createStaticCssEvalUnresolvedExportDiagnostic(
          { owner, dependency },
          "button"
        )
      ).toMatchObject({
        id: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT",
        code: "unsupported-source",
        message:
          'Cannot statically evaluate css prop value: export "button" could not be resolved',
        reason: "reexport-or-barrel",
        owner,
        dependency,
        exportName: "button"
      });
    });

    it("normalizes deopt diagnostics with registry help and support matrix rows", () => {
      const owner = { file: "/project/src/App.tsx", start: 1, end: 2 };

      const computedKey = createStaticCssEvalPartialEvalDeoptDiagnostic({
        code: "unsupported-syntax",
        reason: "non-static-object-key",
        message:
          "Cannot partially evaluate css prop value: object key is not statically known",
        owner
      });
      const dynamicSpread = createStaticCssEvalPartialEvalDeoptDiagnostic({
        code: "unsupported-syntax",
        reason: "unsupported-spread",
        message:
          "Cannot partially evaluate css prop value: spread operand is not statically reducible",
        owner
      });
      const unsupportedCall = createStaticCssEvalPartialEvalDeoptDiagnostic({
        code: "unsupported-syntax",
        reason: "unsupported-call-expression",
        message:
          "Cannot partially evaluate css prop value: call expressions are not evaluated by Babel",
        owner,
        memberPath: ["props", "variant"]
      });
      const unsupportedDependency =
        createStaticCssEvalProviderSourceUnsupportedDiagnostic({
          owner,
          dependency: { file: "external:pkg/styles" },
          importPath: "pkg/styles",
          exportName: "button",
          sourceId: "external:pkg/styles",
          sourceKind: "external-no-source",
          sourceOrigin: "external",
          reason: "external-no-source"
        });
      const ambiguousExportStar =
        createStaticCssEvalAmbiguousExportStarDiagnostic(
          {
            owner,
            dependency: { file: "/project/src/barrel.ts" },
            importPath: "./barrel"
          },
          "button"
        );
      const missingProviderDependency =
        createStaticCssEvalUnresolvedImportDiagnostic(
          { owner, dependency: { file: "/project/src/styles.ts" } },
          "./missing"
        );

      expect(computedKey.id).toBe("STATIC_CSS_EVAL_NON_STATIC_OBJECT_KEY");
      expect(computedKey.category).toBe("syntax-reducer");
      expect(computedKey.severity).toBe("error");
      expect(computedKey.help).toContain("statically resolved string/number");
      expect(computedKey.supportMatrix?.construct).toBe(
        "Dynamic computed object keys or member paths"
      );
      expect(dynamicSpread.id).toBe("STATIC_CSS_EVAL_UNSUPPORTED_SPREAD");
      expect(dynamicSpread.reason).toBe("object-or-array-spread");
      expect(dynamicSpread.supportMatrix?.construct).toBe(
        "Dynamic or wrong-shape object/array spread operands"
      );
      expect(unsupportedCall.id).toBe(
        "STATIC_CSS_EVAL_UNSUPPORTED_CALL_EXPRESSION"
      );
      expect(unsupportedCall.category).toBe("sidecar-hoistability");
      expect(unsupportedCall.memberPath).toEqual(["props", "variant"]);
      expect(unsupportedCall.help).toContain(
        "Babel does not execute user functions"
      );
      expect(unsupportedCall.supportMatrix?.construct).toBe(
        "Nested calls, functions, and optional calls in static css values"
      );
      expect(unsupportedDependency.id).toBe(
        "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED"
      );
      expect(unsupportedDependency.category).toBe("dependency-source");
      expect(unsupportedDependency.help).toContain("source provider");
      expect(unsupportedDependency.supportMatrix?.construct).toBe(
        "Provider/external modules without loadable source"
      );
      expect(ambiguousExportStar.id).toBe(
        "STATIC_CSS_EVAL_EXPORT_STAR_AMBIGUOUS"
      );
      expect(ambiguousExportStar.reason).toBe("ambiguous-star");
      expect(ambiguousExportStar.help).toContain("explicit re-export");
      expect(missingProviderDependency.id).toBe(
        "STATIC_CSS_EVAL_UNRESOLVED_IMPORT"
      );
      expect(missingProviderDependency.help).toContain(
        "resolve this import path"
      );
      expect(missingProviderDependency.supportMatrix?.construct).toBe(
        "Provider/external modules without loadable source"
      );
      expect({ ...computedKey }.category).toBe("syntax-reducer");
      expect(
        Object.getOwnPropertyDescriptor(computedKey, "category")?.writable
      ).toBe(true);
    });

    it("guards repeated import chain keys and depth overflow deterministically", () => {
      const owner = { file: "/project/src/App.tsx", start: 10, end: 20 };
      const stack = [
        {
          file: "/project/src/a.ts",
          exportName: "styles",
          memberPath: ["button"]
        },
        {
          file: "/project/src/b.ts",
          exportName: "styles",
          memberPath: ["button"]
        }
      ] as const;

      expect(
        createStaticCssEvalImportCycleKey({
          file: "/project/src/a.ts",
          exportName: "styles",
          memberPath: ["button"]
        })
      ).toBe(
        createStaticCssEvalImportCycleKey({
          file: "/project/src/a.ts",
          exportName: "styles",
          memberPath: ["button"]
        })
      );

      const cycleResult = guardStaticCssEvalImportCycle({
        owner,
        stack,
        next: {
          file: "/project/src/a.ts",
          exportName: "styles",
          memberPath: ["button"]
        }
      });

      expect(cycleResult.ok).toBe(false);
      if (!cycleResult.ok) {
        expect(cycleResult.diagnostic).toMatchObject({
          id: "STATIC_CSS_EVAL_IMPORT_CYCLE",
          code: "cycle-detected",
          message:
            "Cannot statically evaluate css prop value: cyclic static css reference detected: /project/src/a.ts#styles.button -> /project/src/b.ts#styles.button -> /project/src/a.ts#styles.button",
          reason: "runtime-dynamic-value",
          owner,
          dependency: { file: "/project/src/a.ts" },
          exportName: "styles",
          memberPath: ["button"],
          importChain: [
            "/project/src/a.ts#styles.button",
            "/project/src/b.ts#styles.button",
            "/project/src/a.ts#styles.button"
          ]
        });
        expect(cycleResult.dependencies).toEqual([
          "/project/src/a.ts",
          "/project/src/b.ts"
        ]);
      }

      expect(
        guardStaticCssEvalResolutionDepth({
          owner,
          dependency: { file: "/project/src/styles.ts" },
          importPath: "./styles",
          exportName: "styles",
          memberPath: ["button"],
          resolutionDepth: STATIC_CSS_EVAL_RESOLUTION_DEPTH_LIMIT
        })
      ).toEqual({ ok: true });

      const depthResult = guardStaticCssEvalResolutionDepth({
        owner,
        dependency: { file: "/project/src/styles.ts" },
        importPath: "./styles",
        exportName: "styles",
        memberPath: ["button"],
        resolutionDepth: STATIC_CSS_EVAL_RESOLUTION_DEPTH_LIMIT + 1
      });

      expect(depthResult).toMatchObject({
        ok: false,
        diagnostic: {
          id: "STATIC_CSS_EVAL_RESOLUTION_DEPTH_EXCEEDED",
          code: "limit-exceeded",
          message:
            "Cannot statically evaluate css prop value: resolution depth exceeded (33 steps > 32 steps)",
          reason: "failed-project-local-dependency",
          owner,
          dependency: { file: "/project/src/styles.ts" },
          importPath: "./styles",
          exportName: "styles",
          memberPath: ["button"]
        },
        dependencies: ["/project/src/styles.ts"]
      });

      expect(
        guardStaticCssEvalResolutionDepth({
          owner,
          dependency: { file: owner.file },
          importPath: "./owner",
          exportName: "styles",
          memberPath: ["button"],
          resolutionDepth: STATIC_CSS_EVAL_RESOLUTION_DEPTH_LIMIT + 1
        })
      ).toMatchObject({ ok: false, dependencies: [] });
    });
  });
}
