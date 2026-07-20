import type {
  StaticCssEvalDiagnostic,
  StaticCssEvalDiagnosticCode,
  StaticCssEvalDiagnosticId,
  StaticCssEvalExportName,
  StaticCssEvalSourceKind,
  StaticCssEvalSourceLocation,
  StaticCssEvalSourceOrigin,
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

export function createStaticCssEvalDiagnostic(
  options: CreateStaticCssEvalDiagnosticOptions
): StaticCssEvalDiagnostic {
  const diagnostic: StaticCssEvalDiagnostic = {
    ...(options.id !== undefined ? { id: options.id } : {}),
    code: options.code,
    message: formatStaticCssEvalDiagnosticMessage(options.detail),
    reason: options.reason,
    owner: cloneSourceLocation(options.owner)
  };

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

export function createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
  context: StaticCssEvalDiagnosticContext,
  expressionType: string
): StaticCssEvalDiagnostic {
  return createStaticCssEvalDiagnostic({
    id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED",
    code: "unsupported-source",
    reason: "runtime-dynamic-value",
    detail: `dynamic expression is unsupported: ${expressionType}`,
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
    detail: `same-file binding "${bindingName}" contains an ${collection} spread`,
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

    it("builds stable diagnostics for unsupported source cases", () => {
      const owner = { file: "/project/src/App.tsx", start: 1, end: 2 };
      const dependency = { file: "/project/src/styles.ts" };

      expect(
        createStaticCssEvalDynamicExpressionUnsupportedDiagnostic(
          { owner },
          "CallExpression"
        )
      ).toEqual({
        id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: dynamic expression is unsupported: CallExpression",
        reason: "runtime-dynamic-value",
        owner
      });

      expect(
        createStaticCssEvalMutableBindingDiagnostic({ owner }, "style")
      ).toEqual({
        id: "STATIC_CSS_EVAL_MUTABLE_BINDING",
        code: "unsupported-source",
        message:
          'Cannot statically evaluate css prop value: binding "style" is mutable',
        reason: "let-or-var-binding",
        owner
      });

      expect(
        createStaticCssEvalMutatedBindingDiagnostic({ owner }, "style")
      ).toEqual({
        id: "STATIC_CSS_EVAL_MUTATED_BINDING",
        code: "unsupported-source",
        message:
          'Cannot statically evaluate css prop value: binding "style" is mutated',
        reason: "mutated-binding",
        owner
      });

      expect(
        createStaticCssEvalObjectSpreadUnsupportedDiagnostic({ owner }, "style")
      ).toEqual({
        id: "STATIC_CSS_EVAL_OBJECT_SPREAD_UNSUPPORTED",
        code: "unsupported-syntax",
        message:
          'Cannot statically evaluate css prop value: same-file binding "style" contains an object spread',
        reason: "object-or-array-spread",
        owner
      });

      expect(
        createStaticCssEvalComputedMemberUnsupportedDiagnostic({ owner })
      ).toEqual({
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
      ).toEqual({
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

      expect(createStaticCssEvalCjsUnsupportedDiagnostic({ owner })).toEqual({
        id: "STATIC_CSS_EVAL_CJS_UNSUPPORTED",
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: commonjs require is unsupported",
        reason: "commonjs-require",
        owner
      });

      expect(
        createStaticCssEvalCjsDynamicRequireUnsupportedDiagnostic({ owner })
      ).toEqual({
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
      ).toEqual({
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
      ).toEqual({
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
      ).toEqual({
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
      ).toEqual({
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
      ).toEqual({
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
      ).toEqual({
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
      ).toEqual({
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
      ).toEqual({
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
      ).toEqual({
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
      ).toEqual({
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
        expect(cycleResult.diagnostic).toEqual({
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

      expect(depthResult).toEqual({
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
