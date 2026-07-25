export interface StaticCssEvalProvider {
  getResolvedCssValue(query: StaticCssEvalQuery): StaticCssEvalResult;
}

export interface StaticCssEvalQuery {
  importerId: string;
  expressionStart: number;
  expressionEnd: number;
  bindingName?: string;
  memberPath?: string[];
}

export const STATIC_CSS_EVAL_SOURCE_KINDS = [
  "project-source",
  "package-source",
  "provider-virtual",
  "static-data",
  "external-no-source",
  "unresolved",
  "unsupported-source-shape"
] as const;

export type StaticCssEvalSourceKind =
  (typeof STATIC_CSS_EVAL_SOURCE_KINDS)[number];

export const STATIC_CSS_EVAL_SOURCE_ORIGINS = [
  "project",
  "package",
  "provider",
  "data",
  "external",
  "unresolved",
  "unsupported"
] as const;

export type StaticCssEvalSourceOrigin =
  (typeof STATIC_CSS_EVAL_SOURCE_ORIGINS)[number];

// Maintainer boundary: these contracts model AST-derived css values only.
// Token/theme semantics are not interpreted unless they arrive as JS bindings.
export type StaticCssEvalResult =
  | StaticCssEvalLegacyNotCandidateResult
  | StaticCssEvalLegacyResolvedResult
  | StaticCssEvalLegacyErrorResult
  | StaticCssEvalResolvedResult
  | StaticCssEvalUnsupportedResult
  | StaticCssEvalErrorResult;

type StaticCssEvalLegacyNotCandidateResult = {
  kind: "not-candidate";
  value?: never;
  diagnostic?: never;
};

type StaticCssEvalLegacyResolvedResult = {
  kind: "resolved";
  value: StaticCssLiteral;
  dependencies: string[];
  diagnostic?: never;
};

type StaticCssEvalLegacyErrorResult = {
  kind: "error";
  diagnostic: StaticCssEvalDiagnostic;
  dependencies: string[];
  value?: never;
};

export interface StaticCssEvalResolvedResult {
  kind: "resolved";
  status: "resolved";
  expression: string;
  value: StaticCssLiteral;
  provenance?: BindingProvenance;
  dependencies: ResolutionDependency[];
  resolutionChain?: ResolutionChainEntry[];
  diagnostics?: [];
  cacheKey?: StaticCssEvalCacheKey;
  diagnostic?: never;
}

export interface StaticCssEvalUnsupportedResult {
  kind: "not-candidate";
  status: "unsupported";
  expression: string;
  provenance?: BindingProvenance;
  dependencies: ResolutionDependency[];
  resolutionChain?: ResolutionChainEntry[];
  diagnostics: StaticCssEvalDiagnostic[];
  cacheKey?: StaticCssEvalCacheKey;
  value?: never;
  diagnostic?: never;
}

export interface StaticCssEvalErrorResult {
  kind: "error";
  status: "error";
  expression: string;
  provenance?: BindingProvenance;
  dependencies: ResolutionDependency[];
  resolutionChain?: ResolutionChainEntry[];
  diagnostic: StaticCssEvalDiagnostic;
  diagnostics: StaticCssEvalDiagnostic[];
  cacheKey?: StaticCssEvalCacheKey;
  value?: never;
}

export type StaticCssEvalResultStatus = "resolved" | "unsupported" | "error";

export type BindingProvenance =
  | {
      kind: "local";
      file: string;
      bindingName: string;
      declarationKind?: "const" | "let" | "var" | "function" | "class";
    }
  | {
      kind: "imported";
      file: string;
      importer: string;
      specifier: string;
      exportName: StaticCssEvalExportName;
      memberPath: string[];
    }
  | {
      kind: "reexported";
      file: string;
      importer: string;
      specifier: string;
      exportName: StaticCssEvalExportName;
      memberPath: string[];
      reexportName: string;
    }
  | {
      kind: "namespace-member";
      file: string;
      importer: string;
      specifier: string;
      exportName: StaticCssEvalExportName;
      memberPath: string[];
      namespaceBinding: string;
    };

export type ResolutionDependencyKind =
  | "local"
  | "imported"
  | "reexported"
  | "namespace-member"
  | "unresolved";

export interface ResolutionDependency {
  file: string;
  kind: ResolutionDependencyKind;
  importer: string;
  specifier: string;
  exportName: StaticCssEvalExportName;
  memberPath: string[];
  inspected: boolean;
  contributed: boolean;
  readonly sourceKind?: StaticCssEvalSourceKind;
  readonly sourceOrigin?: StaticCssEvalSourceOrigin;
  readonly canonicalModuleId?: string;
  readonly normalizedPathKey?: string;
  readonly watchFiles?: readonly string[];
  readonly unsupportedReason?: StaticCssEvalUnsupportedReason;
}

export interface ResolutionChainEntry {
  importer: string;
  source: string;
  exportName: StaticCssEvalExportName;
  memberPath: string[];
  provenance?: BindingProvenance;
  readonly sourceKind?: StaticCssEvalSourceKind;
  readonly sourceOrigin?: StaticCssEvalSourceOrigin;
  readonly canonicalModuleId?: string;
  readonly normalizedPathKey?: string;
  readonly watchFiles?: readonly string[];
  readonly unsupportedReason?: StaticCssEvalUnsupportedReason;
}

export interface StaticCssEvalCacheKey {
  importerFile: string;
  resolvedFile: string;
  exportName: StaticCssEvalExportName;
  memberPath: string[];
  sourceHash: string;
  sourceVersion?: string | number;
  pluginOptionsVersion: string | number;
  resolverOptionsVersion: string | number;
  parserVersion?: string | number;
  staticEvalSupportVersion: string | number;
  resolvedId?: string;
  readonly sourceKind?: StaticCssEvalSourceKind;
  readonly sourceOrigin?: StaticCssEvalSourceOrigin;
  readonly canonicalModuleId?: string;
  readonly normalizedPathKey?: string;
  readonly watchFiles?: readonly string[];
  readonly unsupportedReason?: StaticCssEvalUnsupportedReason;
  parserOptions?: StaticCssEvalParserOptionsKey;
  projectLocalBoundary?: StaticCssEvalProjectLocalBoundaryState;
}

export type StaticCssEvalDiagnosticId =
  | "STATIC_CSS_EVAL_LOCAL_ALIAS_CYCLE"
  | "STATIC_CSS_EVAL_MUTABLE_BINDING"
  | "STATIC_CSS_EVAL_MUTATED_BINDING"
  | "STATIC_CSS_EVAL_UNSUPPORTED_ARRAY_ELEMENT"
  | "STATIC_CSS_EVAL_OBJECT_SPREAD_UNSUPPORTED"
  | "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED"
  | "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
  | "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED"
  | "STATIC_CSS_EVAL_EXPORT_STAR_UNSUPPORTED"
  | "STATIC_CSS_EVAL_EXPORT_STAR_AMBIGUOUS"
  | "STATIC_CSS_EVAL_NAMESPACE_UNSUPPORTED"
  | "STATIC_CSS_EVAL_NAMESPACE_REEXPORT_UNSUPPORTED"
  | "STATIC_CSS_EVAL_NAMESPACE_PARTIAL_UNSUPPORTED"
  | "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
  | "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED"
  | "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED"
  | "STATIC_CSS_EVAL_CJS_BUNDLE_RUNTIME_UNSUPPORTED"
  | "STATIC_CSS_EVAL_CJS_UNSUPPORTED"
  | "STATIC_CSS_EVAL_IMPORT_CYCLE"
  | "STATIC_CSS_EVAL_UNRESOLVED_IMPORT"
  | "STATIC_CSS_EVAL_UNRESOLVED_EXPORT"
  | "STATIC_CSS_EVAL_RESOLUTION_DEPTH_EXCEEDED";

export const STATIC_CSS_EVAL_DIAGNOSTIC_IDS = [
  "STATIC_CSS_EVAL_LOCAL_ALIAS_CYCLE",
  "STATIC_CSS_EVAL_MUTABLE_BINDING",
  "STATIC_CSS_EVAL_MUTATED_BINDING",
  "STATIC_CSS_EVAL_UNSUPPORTED_ARRAY_ELEMENT",
  "STATIC_CSS_EVAL_OBJECT_SPREAD_UNSUPPORTED",
  "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED",
  "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED",
  "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
  "STATIC_CSS_EVAL_EXPORT_STAR_UNSUPPORTED",
  "STATIC_CSS_EVAL_EXPORT_STAR_AMBIGUOUS",
  "STATIC_CSS_EVAL_NAMESPACE_UNSUPPORTED",
  "STATIC_CSS_EVAL_NAMESPACE_REEXPORT_UNSUPPORTED",
  "STATIC_CSS_EVAL_NAMESPACE_PARTIAL_UNSUPPORTED",
  "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED",
  "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED",
  "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED",
  "STATIC_CSS_EVAL_CJS_BUNDLE_RUNTIME_UNSUPPORTED",
  "STATIC_CSS_EVAL_CJS_UNSUPPORTED",
  "STATIC_CSS_EVAL_IMPORT_CYCLE",
  "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
  "STATIC_CSS_EVAL_UNRESOLVED_EXPORT",
  "STATIC_CSS_EVAL_RESOLUTION_DEPTH_EXCEEDED"
] as const satisfies readonly StaticCssEvalDiagnosticId[];

export type StaticCssLiteral =
  | string
  | number
  | boolean
  | null
  | StaticCssLiteral[]
  | { [key: string]: StaticCssLiteral };

export type StaticCssEvalExportName = "default" | string | null;

export interface StaticCssEvalSourceLocation {
  file: string;
  line?: number;
  column?: number;
  start?: number;
  end?: number;
}

export const STATIC_CSS_EVAL_DIAGNOSTIC_CODES = [
  "unsupported-syntax",
  "unsupported-source",
  "mutation-detected",
  "cycle-detected",
  "limit-exceeded",
  "failed-project-local-dependency"
] as const;

export type StaticCssEvalDiagnosticCode =
  (typeof STATIC_CSS_EVAL_DIAGNOSTIC_CODES)[number];

export const STATIC_CSS_EVAL_UNSUPPORTED_REASONS = [
  "let-or-var-binding",
  "mutated-binding",
  "namespace-import",
  "reexport-or-barrel",
  "commonjs-require",
  "node-modules-import",
  "virtual-module",
  "provider-virtual-no-source",
  "function-or-call",
  "runtime-dynamic-value",
  "dynamic-import",
  "runtime-wasm-init-or-function",
  "non-literal-loader-output",
  "computed-object-key",
  "object-or-array-spread",
  "conditional-or-logical-expression",
  "binary-expression",
  "template-expression",
  "identifier-object-value",
  "member-expression-object-value",
  "dynamic-member-path",
  "numeric-member-path",
  "optional-member-path",
  "unsupported-literal",
  "runtime-wasm-init",
  "runtime-wasm-module",
  "invalid-json-data",
  "source-size-limit-exceeded",
  "not-project-local",
  "failed-project-local-dependency",
  "external-no-source",
  "unresolved",
  "unsupported-source-shape",
  "ambiguous-star",
  "partial-namespace-failure",
  "unsupported-namespace-reexport"
] as const;

export type StaticCssEvalUnsupportedReason =
  (typeof STATIC_CSS_EVAL_UNSUPPORTED_REASONS)[number];

export interface StaticCssEvalDiagnostic {
  id?: StaticCssEvalDiagnosticId;
  code: StaticCssEvalDiagnosticCode;
  message: string;
  reason: StaticCssEvalUnsupportedReason;
  owner: StaticCssEvalSourceLocation;
  dependency?: StaticCssEvalSourceLocation;
  importPath?: string;
  exportName?: StaticCssEvalExportName;
  memberPath?: string[];
  importChain?: string[];
}

export type StaticCssEvalDependencyKind = "owner" | "project-local-import";

export interface StaticCssEvalDependencyMetadata {
  kind: StaticCssEvalDependencyKind;
  id: string;
  realpath: string;
  importerId?: string;
  importPath?: string;
  sourceHash?: string;
  version?: string | number;
  projectLocal: boolean;
  insideNodeModules: boolean;
  virtual: boolean;
  readonly sourceKind?: StaticCssEvalSourceKind;
  readonly sourceOrigin?: StaticCssEvalSourceOrigin;
  readonly canonicalModuleId?: string;
  readonly normalizedPathKey?: string;
  readonly watchFiles?: readonly string[];
  readonly unsupportedReason?: StaticCssEvalUnsupportedReason;
}

export interface StaticCssEvalModuleRecord {
  id: string;
  realpath: string;
  sourceHash: string;
  version?: string | number;
  dependencies: StaticCssEvalDependencyMetadata[];
  readonly sourceKind?: StaticCssEvalSourceKind;
  readonly sourceOrigin?: StaticCssEvalSourceOrigin;
  readonly canonicalModuleId?: string;
  readonly normalizedPathKey?: string;
  readonly watchFiles?: readonly string[];
  readonly unsupportedReason?: StaticCssEvalUnsupportedReason;
}

export interface StaticCssEvalDependencyMaps {
  ownerToDependencies: ReadonlyMap<string, string[]>;
  dependencyToOwners: ReadonlyMap<string, string[]>;
  resolvedModuleCache: ReadonlyMap<string, StaticCssEvalModuleRecord>;
}

export interface StaticCssEvalProjectLocalBoundaryState {
  rootRealpath: string;
  resolvedRealpath: string;
  insideRoot: boolean;
  insideNodeModules: boolean;
  virtual: boolean;
  packageExportOutsideRoot: boolean;
}

export interface StaticCssEvalParserOptionsKey {
  plugins: string[];
  sourceType: "module" | "script" | "unambiguous";
  jsx: boolean;
  typescript: boolean;
}

export const STATIC_CSS_EVAL_LIMITS = {
  maxImportDepth: 10,
  maxEvaluatedModulesPerOwner: 100,
  maxLoadedDependencySourceBytes: 1024 * 1024,
  maxObjectArrayRecursionDepth: 50,
  maxStaticLiteralNodeCount: 10_000
} as const;

export const STATIC_CSS_EVAL_CYCLE_KEY_FIELDS = [
  "resolvedId",
  "exportName",
  "memberPath"
] as const satisfies readonly (keyof StaticCssEvalCacheKey)[];

export const STATIC_CSS_EVAL_GUARDRAILS = [
  "no-module-execution",
  "no-node-vm-eval-dynamic-import",
  "no-bundler-runtime-evaluation",
  "esm-source-provider-export-graph-v3",
  "all-esm-package-source-provider-policy-v1",
  "provider-backed-static-data-json-raw-url-wasm-string-v1",
  "provider-backed-virtual-source-v1",
  "fail-closed-namespace-star-and-source-shape-v1",
  "async-prepass-sync-babel-boundary"
] as const;

export type StaticCssEvalSupportStatus =
  | "preserved"
  | "supported"
  | "unsupported";

export interface StaticCssEvalSupportMatrixEntry {
  construct: string;
  behavior: string;
  status: StaticCssEvalSupportStatus;
}

export const STATIC_CSS_EVAL_SUPPORT_MATRIX = [
  {
    construct: "Direct object/array in `css={...}`",
    behavior: "Existing behavior preserved",
    status: "preserved"
  },
  {
    construct: "Same-file top-level `const` object/array",
    behavior: "Supported",
    status: "supported"
  },
  {
    construct: "Same-file lexical `const` inside component/function",
    behavior: "Supported if Babel scope resolves it and no reassignment exists",
    status: "supported"
  },
  {
    construct: "`let` / `var`",
    behavior: "Unsupported as static css-rule candidates",
    status: "unsupported"
  },
  {
    construct: "`const style = {...}; style.color = ...`",
    behavior:
      "Unsupported; deterministic mutation diagnostic in css-rule candidate mode",
    status: "unsupported"
  },
  {
    construct: "`const styles = []; styles.push(...)`",
    behavior:
      "Unsupported; deterministic mutation diagnostic in css-rule candidate mode",
    status: "unsupported"
  },
  {
    construct: "Shadowed bindings",
    behavior: "Must respect Babel scope; local binding wins",
    status: "supported"
  },
  {
    construct: '`import { x } from "./style"`',
    behavior: "Supported for project-local ESM source",
    status: "supported"
  },
  {
    construct: '`import { x as y } from "./style"`',
    behavior: "Supported",
    status: "supported"
  },
  {
    construct: '`import x from "./style"`',
    behavior: "Supported when default export resolves to supported literal",
    status: "supported"
  },
  {
    construct: "`export const x = {...}`",
    behavior: "Supported",
    status: "supported"
  },
  {
    construct: "`const x = {...}; export { x }`",
    behavior: "Supported within same module only",
    status: "supported"
  },
  {
    construct: "`export { x as y }` in same module",
    behavior: "Supported",
    status: "supported"
  },
  {
    construct: "`export default {...}`",
    behavior: "Supported",
    status: "supported"
  },
  {
    construct: "`const x = {...}; export default x`",
    behavior: "Supported",
    status: "supported"
  },
  {
    construct:
      'Provider-backed ESM re-export graph (`export { x } from "./x"`, barrels, package barrels, and transitive aliases)',
    behavior:
      "Supported for project, package, data, and provider-backed virtual ESM source with dependency chain metadata",
    status: "supported"
  },
  {
    construct:
      'Provider-backed export-star barrel graph (`export * from "./x"`)',
    behavior:
      "Supported for project and package barrels; explicit exports win, `default` is not forwarded, and ambiguity fails closed",
    status: "supported"
  },
  {
    construct: 'Namespace re-export (`export * as ns from "./x"`)',
    behavior: "Unsupported; namespace re-export entries fail closed",
    status: "unsupported"
  },
  {
    construct:
      'Limited namespace member import (`import * as styles from "./style"; styles.x.y`)',
    behavior:
      "Supported for project-local ESM source-provider literal member chains, including export-star barrels",
    status: "supported"
  },
  {
    construct:
      'Whole namespace import object (`import * as styles from "./style"; css={styles}`)',
    behavior:
      "Supported under source-provider constraints when every exported namespace value is statically evaluable",
    status: "supported"
  },
  {
    construct: "Computed, optional, destructured, or broad namespace access",
    behavior:
      "Unsupported; namespace access must resolve to literal member chains or a whole namespace object",
    status: "unsupported"
  },
  {
    construct: "CommonJS / `require()`",
    behavior:
      "Supported for AST-only static forms: literal `require()` bindings, direct static CJS exports, and recognized compiler helper output; dynamic `require()` and runtime/bundler CommonJS execution remain unsupported",
    status: "supported"
  },
  {
    construct:
      "Provider-backed package, `node_modules`, and outside-root ESM source",
    behavior:
      "Supported when the bundler/provider supplies parseable ESM source and identity metadata; no Babel filesystem package resolver is used",
    status: "supported"
  },
  {
    construct: "Package barrel reexports",
    behavior:
      "Supported with the same direct reexport, `export *`, namespace, and default semantics as project source",
    status: "supported"
  },
  {
    construct:
      "Static data imports (JSON, `?raw`, `?url`, and safe wasm string forms)",
    behavior:
      "Supported when the provider synthesizes literal ESM source for JSON default/named exports or string payloads",
    status: "supported"
  },
  {
    construct: "Provider-backed virtual modules with supplied source",
    behavior:
      "Supported when the bundler/provider returns deterministic source or literal ESM payload plus source identity",
    status: "supported"
  },
  {
    construct: "Provider/external modules without loadable source",
    behavior:
      "Unsupported with source-kind diagnostics such as `external-no-source` or `provider-virtual-no-source`",
    status: "unsupported"
  },
  {
    construct:
      "Runtime wasm init/functions, non-literal loader output, and dynamic import graphs",
    behavior:
      "Unsupported; static evaluation never runs loader/runtime functions or dynamic import graphs",
    status: "unsupported"
  },
  {
    construct: "Remote/http modules",
    behavior:
      "Unsupported in the first iteration; providers must supply deterministic local/package/data/virtual source or literal payloads",
    status: "unsupported"
  },
  {
    construct: "Calls / mixins / functions",
    behavior: "Unsupported",
    status: "unsupported"
  },
  {
    construct: "Runtime dynamic values",
    behavior: "Unsupported in css-rule contexts",
    status: "unsupported"
  },
  {
    construct: "Template literal without expressions",
    behavior: "Supported as string literal",
    status: "supported"
  },
  {
    construct: "Template literal with expressions",
    behavior: "Unsupported",
    status: "unsupported"
  },
  {
    construct: "TS `as const` / `satisfies` wrappers",
    behavior:
      "Supported as transparent wrappers when already accepted by current unwrapping rules",
    status: "supported"
  },
  {
    construct: "Computed object keys",
    behavior: "Unsupported",
    status: "unsupported"
  },
  {
    construct: "Static object/array spreads in css-rule literals",
    behavior:
      "Supported when every spread operand statically resolves to a same-shape object or array literal",
    status: "supported"
  },
  {
    construct: "Static identifier/member values in css-rule literals",
    behavior:
      "Supported when identifiers and non-computed member paths resolve to static literals through same-file or provider-backed bindings",
    status: "supported"
  },
  {
    construct: "Dynamic or wrong-shape object/array spread operands",
    behavior:
      "Unsupported; unresolved, mutable, computed, function/call, dynamic, or wrong collection shape operands fail closed with diagnostics",
    status: "unsupported"
  },
  {
    construct: "Conditional/logical expressions as static values",
    behavior:
      "Unsupported for imported/static evaluation; existing direct css prop branch semantics remain separate",
    status: "unsupported"
  },
  {
    construct: "Binary expressions / string concatenation",
    behavior: "Unsupported",
    status: "unsupported"
  },
  {
    construct: "BigInt / RegExp / Date / Symbol / `NaN` / `Infinity`",
    behavior: "Unsupported",
    status: "unsupported"
  }
] as const satisfies readonly StaticCssEvalSupportMatrixEntry[];

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;

  const staticCssEvalDiagnosticExhaustiveMap = {
    STATIC_CSS_EVAL_LOCAL_ALIAS_CYCLE: true,
    STATIC_CSS_EVAL_MUTABLE_BINDING: true,
    STATIC_CSS_EVAL_MUTATED_BINDING: true,
    STATIC_CSS_EVAL_UNSUPPORTED_ARRAY_ELEMENT: true,
    STATIC_CSS_EVAL_OBJECT_SPREAD_UNSUPPORTED: true,
    STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED: true,
    STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED: true,
    STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED: true,
    STATIC_CSS_EVAL_EXPORT_STAR_UNSUPPORTED: true,
    STATIC_CSS_EVAL_EXPORT_STAR_AMBIGUOUS: true,
    STATIC_CSS_EVAL_NAMESPACE_UNSUPPORTED: true,
    STATIC_CSS_EVAL_NAMESPACE_REEXPORT_UNSUPPORTED: true,
    STATIC_CSS_EVAL_NAMESPACE_PARTIAL_UNSUPPORTED: true,
    STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED: true,
    STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED: true,
    STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED: true,
    STATIC_CSS_EVAL_CJS_BUNDLE_RUNTIME_UNSUPPORTED: true,
    STATIC_CSS_EVAL_CJS_UNSUPPORTED: true,
    STATIC_CSS_EVAL_IMPORT_CYCLE: true,
    STATIC_CSS_EVAL_UNRESOLVED_IMPORT: true,
    STATIC_CSS_EVAL_UNRESOLVED_EXPORT: true,
    STATIC_CSS_EVAL_RESOLUTION_DEPTH_EXCEEDED: true
  } satisfies Record<StaticCssEvalDiagnosticId, true>;

  const staticCssEvalDiagnosticIds = Object.keys(
    staticCssEvalDiagnosticExhaustiveMap
  ) as StaticCssEvalDiagnosticId[];

  const staticCssEvalResolvedResult = {
    kind: "resolved",
    status: "resolved",
    expression: "styles.button",
    value: { color: "red" },
    provenance: {
      kind: "imported",
      file: "/project/src/styles.ts",
      importer: "/project/src/App.tsx",
      specifier: "./styles",
      exportName: "default",
      memberPath: ["button"]
    },
    dependencies: [
      {
        file: "/project/src/styles.ts",
        kind: "imported",
        importer: "/project/src/App.tsx",
        specifier: "./styles",
        exportName: "default",
        memberPath: ["button"],
        inspected: true,
        contributed: true
      }
    ],
    resolutionChain: [
      {
        importer: "/project/src/App.tsx",
        source: "/project/src/styles.ts",
        exportName: "default",
        memberPath: ["button"],
        provenance: {
          kind: "imported",
          file: "/project/src/styles.ts",
          importer: "/project/src/App.tsx",
          specifier: "./styles",
          exportName: "default",
          memberPath: ["button"]
        }
      }
    ],
    cacheKey: {
      importerFile: "/project/src/App.tsx",
      resolvedFile: "/project/src/styles.ts",
      exportName: "default",
      memberPath: ["button"],
      sourceHash: "sha256:source",
      sourceVersion: 1,
      pluginOptionsVersion: 1,
      resolverOptionsVersion: 1,
      staticEvalSupportVersion: 1,
      resolvedId: "/project/src/styles.ts",
      parserOptions: {
        plugins: ["jsx", "typescript"],
        sourceType: "module",
        jsx: true,
        typescript: true
      },
      projectLocalBoundary: {
        rootRealpath: "/project",
        resolvedRealpath: "/project/src/styles.ts",
        insideRoot: true,
        insideNodeModules: false,
        virtual: false,
        packageExportOutsideRoot: false
      }
    }
  } satisfies StaticCssEvalResult;

  const staticCssEvalUnsupportedResult = {
    kind: "not-candidate",
    status: "unsupported",
    expression: "styles[key]",
    dependencies: [],
    diagnostics: [
      {
        id: "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED",
        code: "unsupported-source",
        message: "computed member access is unsupported",
        reason: "dynamic-member-path",
        owner: {
          file: "/project/src/App.tsx",
          start: 42,
          end: 55
        }
      }
    ],
    cacheKey: {
      importerFile: "/project/src/App.tsx",
      resolvedFile: "/project/src/styles.ts",
      exportName: "default",
      memberPath: ["button"],
      sourceHash: "sha256:source",
      pluginOptionsVersion: 1,
      resolverOptionsVersion: 1,
      staticEvalSupportVersion: 1
    }
  } satisfies StaticCssEvalResult;

  const staticCssEvalErrorResult = {
    kind: "error",
    status: "error",
    expression: "missing.button",
    dependencies: [],
    diagnostic: {
      id: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT",
      code: "unsupported-source",
      message: "export could not be resolved",
      reason: "reexport-or-barrel",
      owner: {
        file: "/project/src/App.tsx",
        start: 42,
        end: 55
      }
    },
    diagnostics: [
      {
        id: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT",
        code: "unsupported-source",
        message: "export could not be resolved",
        reason: "reexport-or-barrel",
        owner: {
          file: "/project/src/App.tsx",
          start: 42,
          end: 55
        }
      }
    ]
  } satisfies StaticCssEvalResult;

  describe("static css evaluator contracts", () => {
    it("encodes static evaluator limits and source-provider guardrails", () => {
      expect(STATIC_CSS_EVAL_LIMITS).toEqual({
        maxImportDepth: 10,
        maxEvaluatedModulesPerOwner: 100,
        maxLoadedDependencySourceBytes: 1024 * 1024,
        maxObjectArrayRecursionDepth: 50,
        maxStaticLiteralNodeCount: 10_000
      });
      expect(STATIC_CSS_EVAL_GUARDRAILS).toContain("no-module-execution");
      expect(STATIC_CSS_EVAL_GUARDRAILS).toContain(
        "async-prepass-sync-babel-boundary"
      );
      expect(STATIC_CSS_EVAL_GUARDRAILS).toContain(
        "esm-source-provider-export-graph-v3"
      );
      expect(STATIC_CSS_EVAL_GUARDRAILS).toContain(
        "all-esm-package-source-provider-policy-v1"
      );
      expect(STATIC_CSS_EVAL_GUARDRAILS).toContain(
        "provider-backed-static-data-json-raw-url-wasm-string-v1"
      );
      expect(STATIC_CSS_EVAL_GUARDRAILS).toContain(
        "provider-backed-virtual-source-v1"
      );
      expect(STATIC_CSS_EVAL_GUARDRAILS).toContain(
        "fail-closed-namespace-star-and-source-shape-v1"
      );
      expect(STATIC_CSS_EVAL_GUARDRAILS).not.toContain(
        "project-local-files-only"
      );
      expect(STATIC_CSS_EVAL_GUARDRAILS).not.toContain(
        "no-node-modules-virtual-cjs-or-outside-root-v1"
      );
      expect(STATIC_CSS_EVAL_GUARDRAILS).not.toContain(
        "direct-named-reexports-only-v1"
      );
    });

    it("keeps the source-provider export graph support matrix testable", () => {
      const supportMatrixByConstruct = new Map(
        STATIC_CSS_EVAL_SUPPORT_MATRIX.map((entry) => [entry.construct, entry])
      );
      const supportMatrixConstructs: readonly string[] =
        STATIC_CSS_EVAL_SUPPORT_MATRIX.map((entry) => entry.construct);

      expect(
        supportMatrixByConstruct.get(
          'Provider-backed ESM re-export graph (`export { x } from "./x"`, barrels, package barrels, and transitive aliases)'
        )
      ).toMatchObject({ status: "supported" });
      expect(
        supportMatrixByConstruct.get(
          'Provider-backed export-star barrel graph (`export * from "./x"`)'
        )
      ).toMatchObject({ status: "supported" });
      expect(
        supportMatrixByConstruct.get(
          'Limited namespace member import (`import * as styles from "./style"; styles.x.y`)'
        )
      ).toMatchObject({ status: "supported" });
      expect(
        supportMatrixByConstruct.get(
          'Whole namespace import object (`import * as styles from "./style"; css={styles}`)'
        )
      ).toMatchObject({ status: "supported" });
      expect(
        supportMatrixByConstruct.get(
          'Namespace re-export (`export * as ns from "./x"`)'
        )
      ).toMatchObject({ status: "unsupported" });
      expect(
        supportMatrixByConstruct.get(
          "Computed, optional, destructured, or broad namespace access"
        )
      ).toMatchObject({ status: "unsupported" });
      expect(
        supportMatrixByConstruct.get(
          "Provider-backed package, `node_modules`, and outside-root ESM source"
        )
      ).toMatchObject({ status: "supported" });
      expect(
        supportMatrixByConstruct.get("Package barrel reexports")
      ).toMatchObject({ status: "supported" });
      expect(
        supportMatrixByConstruct.get(
          "Static data imports (JSON, `?raw`, `?url`, and safe wasm string forms)"
        )
      ).toMatchObject({ status: "supported" });
      expect(
        supportMatrixByConstruct.get(
          "Provider-backed virtual modules with supplied source"
        )
      ).toMatchObject({ status: "supported" });
      expect(
        supportMatrixByConstruct.get(
          "Provider/external modules without loadable source"
        )
      ).toMatchObject({ status: "unsupported" });
      expect(
        supportMatrixByConstruct.get(
          "Runtime wasm init/functions, non-literal loader output, and dynamic import graphs"
        )
      ).toMatchObject({ status: "unsupported" });
      expect(supportMatrixByConstruct.get("Remote/http modules")).toMatchObject(
        { status: "unsupported" }
      );
      expect(
        supportMatrixByConstruct.get("CommonJS / `require()`")
      ).toMatchObject({
        status: "supported",
        behavior: expect.stringContaining("dynamic `require()`")
      });
      expect(
        supportMatrixConstructs.some(
          (construct) => construct === "Object spread / array spread"
        )
      ).toBe(false);
      expect(
        supportMatrixByConstruct.get(
          "Static object/array spreads in css-rule literals"
        )
      ).toMatchObject({
        status: "supported",
        behavior: expect.stringContaining("same-shape")
      });
      expect(
        supportMatrixByConstruct.get(
          "Static identifier/member values in css-rule literals"
        )
      ).toMatchObject({ status: "supported" });
      expect(
        supportMatrixByConstruct.get(
          "Dynamic or wrong-shape object/array spread operands"
        )
      ).toMatchObject({
        status: "unsupported",
        behavior: expect.stringContaining("fail closed")
      });
      expect(
        supportMatrixByConstruct.get("Calls / mixins / functions")
      ).toMatchObject({ status: "unsupported" });
      expect(
        supportMatrixByConstruct.get("Runtime dynamic values")
      ).toMatchObject({ status: "unsupported" });
      expect(
        supportMatrixConstructs.some(
          (construct) => construct === "Export star (`export *`)"
        )
      ).toBe(false);
      expect(STATIC_CSS_EVAL_SUPPORT_MATRIX).toHaveLength(41);
    });

    it("accepts synchronous provider and cache key contracts", () => {
      const provider: StaticCssEvalProvider = {
        getResolvedCssValue(query) {
          expect(query).toMatchObject({
            importerId: "/project/src/App.tsx",
            bindingName: "styles",
            memberPath: ["button"]
          });

          return {
            kind: "resolved",
            value: { color: "red" },
            dependencies: ["/project/src/styles.ts"]
          };
        }
      };
      const cacheKey: StaticCssEvalCacheKey = {
        importerFile: "/project/src/App.tsx",
        resolvedFile: "/project/src/styles.ts",
        exportName: "default",
        memberPath: ["button"],
        sourceHash: "sha256:source",
        sourceVersion: 1,
        pluginOptionsVersion: 1,
        resolverOptionsVersion: 1,
        staticEvalSupportVersion: 1,
        resolvedId: "/project/src/styles.ts",
        parserOptions: {
          plugins: ["jsx", "typescript"],
          sourceType: "module",
          jsx: true,
          typescript: true
        },
        projectLocalBoundary: {
          rootRealpath: "/project",
          resolvedRealpath: "/project/src/styles.ts",
          insideRoot: true,
          insideNodeModules: false,
          virtual: false,
          packageExportOutsideRoot: false
        }
      };

      expect(cacheKey.importerFile).toBe("/project/src/App.tsx");
      expect(cacheKey.projectLocalBoundary?.insideRoot).toBe(true);
      expect(
        provider.getResolvedCssValue({
          importerId: "/project/src/App.tsx",
          expressionStart: 42,
          expressionEnd: 55,
          bindingName: "styles",
          memberPath: ["button"]
        })
      ).toEqual({
        kind: "resolved",
        value: { color: "red" },
        dependencies: ["/project/src/styles.ts"]
      });
    });

    it("models resolved, unsupported, and error result shapes", () => {
      expect(staticCssEvalResolvedResult.status).toBe("resolved");
      expect(staticCssEvalResolvedResult.kind).toBe("resolved");
      expect(staticCssEvalResolvedResult.dependencies[0]?.file).toBe(
        "/project/src/styles.ts"
      );
      expect(staticCssEvalUnsupportedResult.status).toBe("unsupported");
      expect(staticCssEvalUnsupportedResult.kind).toBe("not-candidate");
      expect(staticCssEvalUnsupportedResult.diagnostics[0]?.id).toBe(
        "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED"
      );
      expect(staticCssEvalErrorResult.status).toBe("error");
      expect(staticCssEvalErrorResult.kind).toBe("error");
      expect(staticCssEvalErrorResult.diagnostics[0]?.id).toBe(
        "STATIC_CSS_EVAL_UNRESOLVED_EXPORT"
      );
    });

    it("keeps legacy kind narrowing ergonomic", () => {
      const legacyResult: StaticCssEvalResult = {
        kind: "error",
        diagnostic: {
          code: "unsupported-source",
          message: "legacy error",
          reason: "reexport-or-barrel",
          owner: { file: "/project/src/App.tsx" }
        },
        dependencies: []
      };

      if (legacyResult.kind === "error") {
        expect(legacyResult.diagnostic.message).toBe("legacy error");
      }
    });

    it("keeps diagnostic ids exhaustive", () => {
      expect(staticCssEvalDiagnosticIds).toEqual(
        STATIC_CSS_EVAL_DIAGNOSTIC_IDS
      );
      expect(staticCssEvalDiagnosticIds).toHaveLength(22);
    });
  });
}
