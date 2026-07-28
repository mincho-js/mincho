import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import type { StaticMemberReference } from "../candidates.js";
import type {
  StaticCssEvalProviderSourceMetadata,
  StaticCssEvalProviderSourcePolicyDescriptor
} from "../boundary.js";
import type { ImportedStaticCssEvalCjsBinding } from "../cjsBindings.js";
import type { StaticCssEvalImportCycleKey } from "../diagnostics.js";
import type {
  ExportMapEntry,
  ExportGraphStarReexportEntry,
  ParsedStaticCssModule,
  StaticCssModuleCache,
  StaticCssModuleExportNameTableEntry
} from "../moduleCache.js";
import type {
  BindingProvenance,
  ResolutionChainEntry,
  ResolutionDependency,
  ResolutionDependencyKind,
  StaticCssEvalCacheKey,
  StaticCssEvalDiagnostic,
  StaticCssEvalExportName,
  StaticCssEvalSourceLocation,
  StaticCssEvalModuleRecord,
  StaticCssLiteral
} from "../types.js";

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

export type ImportedStaticCssEvalResolutionResult =
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

export type ImportedStaticCssEvalExportPresenceResult =
  | { kind: "found" }
  | { kind: "missing" }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic };

export interface ImportedStaticCssEvalExportStarCandidate {
  readonly entry: ExportGraphStarReexportEntry;
  readonly record: ImportedStaticCssEvalModuleRecord;
  readonly request: ImportedStaticCssEvalResolutionRequest;
}

export interface ImportedStaticCssEvalNamespaceExportNameTable {
  readonly table: ReadonlyMap<
    StaticCssEvalExportName,
    StaticCssModuleExportNameTableEntry
  >;
  readonly candidates: ImportedStaticCssEvalExportStarCandidate[];
}

export interface ImportedStaticCssEvalContext {
  owner: StaticCssEvalSourceLocation;
  dependency: StaticCssEvalSourceLocation;
  importPath: string;
  exportName: StaticCssEvalExportName;
  memberPath: string[];
}

export type ImportedStaticCssEvalProvenanceKind = Exclude<
  BindingProvenance["kind"],
  "local"
>;

export interface ImportedStaticCssEvalResolutionRequest {
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

export interface ImportedStaticCssEvalResolvedImport {
  readonly resolvedId: string;
  readonly sourceMetadata: StaticCssEvalProviderSourceMetadata;
}

export interface ImportedStaticCssEvalResolutionState {
  owner: StaticCssEvalSourceLocation;
  dependencies: Map<string, ResolutionDependency>;
  resolutionChain: ResolutionChainEntry[];
  stack: StaticCssEvalImportCycleKey[];
}

export interface StaticCssLiteralValidationState {
  count: number;
}

export interface ImportedStaticCssEvalLocalReferenceFrame {
  readonly recordId: string;
  readonly bindingName: string;
  readonly memberPath: readonly string[];
}

export type ImportedStaticCssEvalLiteralResult =
  | { kind: "resolved"; value: StaticCssLiteral }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic };

export type ImportedStaticCssEvalLiteralReferenceResult =
  | ImportedStaticCssEvalLiteralResult
  | { kind: "not-candidate" };

export type ImportedStaticCssEvalDeclarationKind =
  | "const"
  | "let"
  | "var"
  | "function"
  | "class";

export interface ImportedStaticCssEvalLiteralEvaluationOptions {
  readonly expression: t.Expression;
  readonly context: ImportedStaticCssEvalContext;
  readonly record: ImportedStaticCssEvalModuleRecord;
  readonly request: ImportedStaticCssEvalResolutionRequest;
  readonly resolutionState: ImportedStaticCssEvalResolutionState;
  readonly literalState: StaticCssLiteralValidationState;
  readonly localStack: readonly ImportedStaticCssEvalLocalReferenceFrame[];
  readonly depth: number;
  readonly resolveReference: ImportedStaticCssEvalLiteralReferenceResolver;
}

export interface ImportedStaticCssEvalLiteralReferenceOptions extends ImportedStaticCssEvalLiteralEvaluationOptions {
  readonly reference: StaticMemberReference;
}

export type ImportedStaticCssEvalLiteralReferenceResolver = (
  options: ImportedStaticCssEvalLiteralReferenceOptions
) => ImportedStaticCssEvalLiteralResult;

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

export interface ImportedStaticCssEvalResolverOptions extends CreateImportedStaticCssEvalProviderOptions {
  moduleCache?: StaticCssModuleCache;
}

export type ResolveImportedStaticCssEvalExpressionResult =
  | { kind: "not-candidate" }
  | { kind: "resolved"; expression: t.ObjectExpression | t.ArrayExpression }
  | { kind: "error"; diagnostic: StaticCssEvalDiagnostic };
