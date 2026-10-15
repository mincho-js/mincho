export {
  internalCanBypassJsxRuntimeGuards,
  internalHasExplicitJsxRuntimeImport,
  internalTransformJsxRuntimeGuards
} from "@mincho-js/babel";

export {
  CompilationDiagnostics,
  measureCompilationPhase as internalMeasureCompilationPhase,
  recordCompilationDiagnostic as internalRecordCompilationDiagnostic,
  type MinchoDiagnosticsOptions
} from "./diagnostics.js";
export type { ExtractCalls } from "@mincho-js/babel";
export {
  InternalSourceAstCache,
  internalInspectCommonJs,
  internalResolveFromModule
} from "@mincho-js/babel";
export {
  babelTransform,
  babelTransformSource,
  type BabelOptions,
  type BabelTransformResult,
  type BabelTransformSourceOptions,
  type StaticCssEvalLoadedSource as InternalStaticCssEvalLoadedSource,
  type StaticCssEvalResolverKind as InternalStaticCssEvalResolverKind,
  type StaticCssEvalSourceKind as InternalStaticCssEvalSourceKind,
  type StaticCssEvalSourceOrigin as InternalStaticCssEvalSourceOrigin,
  type StaticCssEvalSourceProvider as InternalStaticCssEvalSourceProvider,
  type StaticCssEvalSourceResolution as InternalStaticCssEvalSourceResolution,
  type StaticCssEvalSourceUnsupportedReason as InternalStaticCssEvalSourceUnsupportedReason
} from "./babel.js";
export { compile } from "./compile.js";
export { canSkipMinchoTransform as internalCanSkipMinchoTransform } from "./transformEligibility.js";
export {
  collectDefineRulesPackageGraph,
  getDefineRulesPackageStyleSpecifiers,
  mergeDefineRulesPackageGraphs,
  type DefineRulesPackageDependencyWitness,
  type DefineRulesPackageGraph,
  type DefineRulesPackageGraphArtifact
} from "./defineRulesPackageGraph.js";
export {
  getDefineRulesAncestorStyleSpecifiers,
  processDefineRulesPresetRegistryFile,
  runDefineRulesPresetRegistryStep,
  validateDefineRulesRegistrySession,
  type DefineRulesPresetRegistryFileOptions,
  type DefineRulesPresetRegistryResult
} from "./defineRulesPreset.js";
export {
  effectiveLoader as internalEffectiveLoader,
  getScriptLoader as internalGetScriptLoader,
  isScriptLoader as internalIsScriptLoader
} from "./scriptLoaders.js";
export {
  createStaticCssEvalSourceHash,
  createUnsupportedStaticCssEvalResolution,
  getExistingRealpath,
  getRealpathOrResolvedPath,
  hasNodeModulesSegment,
  isPathInsideRoot,
  isProjectLocalImportPath,
  isUnsupportedStaticCssEvalResolutionId,
  isVirtualStaticCssEvalId,
  trimTrailingSlash,
  unsupportedStaticCssEvalResolutionPrefix
} from "./staticCssEval.js";
export {
  MinchoProjectEngine as internalMinchoProjectEngine,
  type StaticEvalProjectEngine as InternalStaticEvalProjectEngine
} from "./staticCssEvalProjectEngine.js";
export { getStaticCssEvalSourceOrigin as internalGetStaticCssEvalSourceOrigin } from "./staticCssEvalSource.js";
export {
  internalCollectStaticCssEvalDependencyIds,
  internalCreateStaticCssEvalSourceHash,
  internalCreateStaticCssEvalSourceIdentity,
  internalGetExistingStaticCssEvalRealpath,
  internalGetExistingStaticCssEvalStat,
  internalGetStaticCssEvalQueryFlags,
  internalGetStaticCssEvalRealpathOrResolvedPath,
  internalHasStaticCssEvalNodeModulesSegment,
  internalIsMissingStaticCssEvalFileSystemEntryError,
  internalIsProjectLocalStaticCssEvalImportPath,
  internalIsStaticCssEvalPathInsideRoot,
  internalIsStaticCssEvalStaticDataFile,
  internalIsVirtualStaticCssEvalId,
  normalizeStaticCssEvalFileId as internalNormalizeStaticCssEvalFileId,
  internalNormalizeStaticCssEvalPathSyntax,
  internalPrepareStaticCssEvalStaticDataSource,
  internalStaticCssEvalExternalResolutionPrefix,
  type InternalStaticCssEvalMetadataLike,
  type InternalStaticCssEvalSourceIdentity
} from "./staticCssEvalUtils.js";

export { CompilationCache as InternalCompilationCache } from "./compilationCache.js";
export { CompilationExecution as InternalCompilationExecution } from "./compilationExecution.js";
export type {
  MinchoExecutionOptions,
  MinchoCacheOptions
} from "./executionOptions.js";

export type { CompileCacheBridge as InternalCompileCacheBridge } from "./compileCache.js";

export { RuntimeOptimizations as InternalRuntimeOptimizations } from "./runtimeOptimizations.js";
export {
  resolveOptimizationOptions as internalResolveOptimizationOptions,
  type OptimizationMode
} from "./optimizationMode.js";

export {
  planCssChunkSharing as internalPlanCssChunkSharing,
  resolveCssChunkSharingOptions as internalResolveCssChunkSharingOptions,
  isShareableCss as internalIsShareableCss,
  type MinchoCssChunkSharingOptions,
  type CssSharingBoundary as InternalCssSharingBoundary,
  type CssSharingModule as InternalCssSharingModule,
  type CssSharingGroup as InternalCssSharingGroup
} from "./cssChunkSharing.js";
export {
  generateVanillaCss as internalGenerateVanillaCss,
  hashVanillaCssArtifact as internalHashVanillaCssArtifact,
  type VanillaCssArtifact as InternalVanillaCssArtifact
} from "./vanillaCssIr.js";
export {
  optimizeVanillaCssArtifacts as internalOptimizeVanillaCssArtifacts,
  type CssIrOptimizationOptions as InternalCssIrOptimizationOptions
} from "./cssIrOptimization.js";
