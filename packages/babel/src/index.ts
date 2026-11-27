import {
  assertExtractionPublications,
  finishCapturedAuthoringOwners
} from "./transforms/extractionPublication.js";
import { compactRecipes } from "./optimizations/compactRecipes.js";
import {
  analyzePureFunctions,
  applyPureFunctions
} from "./optimizations/pureFunctions.js";
import { type PluginObj, types as t } from "@babel/core";
import {
  analyzeDefineRulesCxConditionsCallExpression,
  defineRulesCxConditionsOptimizationMetadataKey,
  isDefineRulesCxConditionsEnabled
} from "./defineRulesCxConditions.js";
import {
  preprocessJsxCssProp,
  removeUnusedJsxCssPropCssModuleImports
} from "./jsxCssProp.js";
import { transformCallExpression } from "./transforms/callExpression.js";
import postprocess from "./transforms/postprocess.js";
import preprocess from "./transforms/preprocess.js";
import type { PluginState } from "./types.js";
import { prepareExtractCalls } from "./extractionCalls/index.js";

import { normalizeTypeScriptCommonJs } from "./commonjs/modules.js";
import {
  hasConfiguredGeneratorOverride,
  optimizeRuntimeCodegen,
  removeUnusedExtractedImports,
  removeUnusedGeneratedImports,
  type OriginalModuleRequests
} from "./optimizations/runtimeCodegen.js";
import { pruneRecipeMetadata } from "./optimizations/recipeMetadata.js";
import { lowerLayoutJsx } from "./optimizations/layoutJsx.js";
import { optimizeLocalScopedCx } from "./optimizations/localScopedCx.js";
import {
  prepareCompilerClassStrategies,
  finishCompilerClassStrategies
} from "./optimizations/compilerClassStrategies.js";

export function minchoBabelPlugin(): PluginObj<PluginState> {
  const started = new WeakMap<PluginState, number>();
  const originalModuleRequests = new WeakMap<
    PluginState,
    OriginalModuleRequests
  >();

  return {
    name: "mincho-babel-plugin",
    visitor: {
      Program: {
        enter(path, state) {
          if (state.opts.diagnostics) started.set(state, performance.now());
          normalizeTypeScriptCommonJs(path, state.file);

          // After configured pre hooks and input normalization, but before
          // Mincho introduces CSS-sidecar requests, record exact input nodes.
          const requires = new Map<t.CallExpression, number>();
          t.traverseFast(path.node, (node) => {
            if (
              t.isCallExpression(node) &&
              t.isIdentifier(node.callee, { name: "require" })
            )
              requires.set(node, requires.size);
          });
          const statements =
            state.opts.optimize?.runtimeCodegen !== true
              ? new Set(path.node.body)
              : undefined;
          if (statements || requires.size)
            originalModuleRequests.set(state, { statements, requires });

          if (isDefineRulesCxConditionsEnabled(state)) {
            state.file.metadata[
              defineRulesCxConditionsOptimizationMetadataKey
            ] = true;
          }

          if (state.opts.optimize?.pureFunctions !== false) {
            let prepared = state.opts.preparedPureFunctions;

            if (!prepared) {
              const realm = state.opts.preparedExtractCalls?.arrayMapIntrinsics;
              const flow = analyzePureFunctions({
                nativeArrayIteration: realm?.iterationIntact ?? realm?.intact,
                filename: state.file.opts.filename ?? "/__mincho__.tsx",
                source: state.file.code,
                program: path,
                jsxCssProp: Boolean(state.opts.jsxCssProp)
              });

              let step = flow.next();

              while (!step.done) step = flow.next(null);

              prepared = step.value;
            }

            applyPureFunctions(path, prepared);
            state.file.metadata.minchoPureFunctions = prepared.diagnostics;
          }

          preprocess(path, prepareExtractCalls(path, state));
          if (state.opts.optimize?.styledComponents === true)
            lowerLayoutJsx(path);
          prepareCompilerClassStrategies(path, state);
          state.opts.jsxCssPropTransformed = preprocessJsxCssProp(path, state);
        },

        exit(path, state) {
          assertExtractionPublications(path);
          postprocess(path, state);
          finishCapturedAuthoringOwners(path);
          finishCompilerClassStrategies(path, state);

          if (state.opts.optimize?.staticScopedCx)
            state.file.metadata.minchoClassStringBudget = optimizeLocalScopedCx(
              path,
              state.file.opts.filename ?? "/__mincho__.tsx"
            );

          if (state.opts.optimize?.runtimeCodegen === true) {
            optimizeRuntimeCodegen(path);
            pruneRecipeMetadata(path);
          }

          const optionalSites = state.opts.stageCommonJsRuntimeRequests
            ? (state.file.metadata.minchoOptionalCommonJsSites = [])
            : undefined;
          removeUnusedExtractedImports(
            path,
            originalModuleRequests.get(state),
            optionalSites,
            hasConfiguredGeneratorOverride(state.file.opts)
              ? {
                  cleanup: state.opts.stageEsmGeneratorImports
                    ? (state.file.metadata.minchoOptionalEsmImports = {
                        sites: [],
                        requests: []
                      })
                    : undefined
                }
              : undefined
          );
          removeUnusedJsxCssPropCssModuleImports(path);
          removeUnusedGeneratedImports(path);
          compactRecipes(path, {
            ...state.opts.optimize,
            bundleSize: state.opts.bundleSize
          });

          const stagedEsm = state.file.metadata.minchoOptionalEsmImports;
          if (stagedEsm?.sites.length)
            for (const node of path.node.body)
              if (
                node.type === "ImportDeclaration" ||
                node.type === "ExportNamedDeclaration" ||
                node.type === "ExportAllDeclaration"
              )
                stagedEsm.requests.push(t.cloneNode(node));

          const start = started.get(state);

          if (start !== undefined) {
            state.file.metadata.minchoCompilation = {
              durationMs: performance.now() - start,
              extractedCalls: (
                path.scope as import("./types.js").ProgramScope
              ).minchoData.nodes.filter(
                (node) => node.type === "ExportNamedDeclaration"
              ).length,
              jsxCssProp: state.opts.jsxCssPropTransformed === true,
              sidecar: state.opts.result[0]
            };
          }
        }
      },

      CallExpression(path, state) {
        analyzeDefineRulesCxConditionsCallExpression(path, state);

        if (path.isCallExpression()) {
          transformCallExpression(path);
        }
      }
    }
  };
}

export {
  appendUniqueMetadataItems as internalAppendUniqueStaticCssEvalMetadataItems,
  appendUniqueResolvedModuleIds as internalAppendUniqueStaticCssEvalResolvedModuleIds,
  createStaticCssEvalCacheKeyMetadataKey as internalCreateStaticCssEvalCacheKeyMetadataKey,
  createResolutionDependencyMetadataKey as internalCreateStaticCssEvalDependencyMetadataKey,
  createStaticCssEvalDiagnosticMetadataKey as internalCreateStaticCssEvalDiagnosticMetadataKey
} from "./jsxCssProp.js";
export { resolveFromModule as internalResolveFromModule } from "./moduleResolution.js";
export {
  collectJsxCssPropStaticCssEvalCandidates as internalCollectJsxCssPropStaticCssEvalCandidates,
  getStaticCssEvalMemberReference as internalGetStaticCssEvalMemberReference,
  unwrapTransparentCssRuleExpression as internalUnwrapTransparentCssRuleExpression
} from "./staticCssEval/candidates.js";
export {
  createImportedStaticCssEvalModuleRecord as internalCreateImportedStaticCssEvalModuleRecord,
  createImportedStaticCssEvalProvider as internalCreateImportedStaticCssEvalProvider
} from "./staticCssEval/importedModules.js";
export type {
  ImportedStaticCssEvalImportResolution as InternalImportedStaticCssEvalImportResolution,
  ImportedStaticCssEvalLoadedModule as InternalImportedStaticCssEvalLoadedModule,
  ImportedStaticCssEvalModuleRecord as InternalImportedStaticCssEvalModuleRecord
} from "./staticCssEval/importedModules.js";
export { STATIC_CSS_EVAL_LIMITS as internalStaticCssEvalLimits } from "./staticCssEval/types.js";
export {
  hasConcreteLogicalSyntaxFilename as internalHasConcreteLogicalSyntaxFilename,
  hasStaticCssEvalSyntaxFilename as internalHasStaticCssEvalSyntaxFilename
} from "./staticCssEval/syntaxFilename.js";
export { styledComponentPlugin as minchoStyledComponentPlugin } from "./styled.js";
export {
  canBypassJsxRuntimeGuards as internalCanBypassJsxRuntimeGuards,
  hasExplicitJsxRuntimeImport as internalHasExplicitJsxRuntimeImport,
  transformJsxRuntimeGuards as internalTransformJsxRuntimeGuards
} from "./optimizations/jsxRuntimeGuards.js";
export type {
  ExtractCalls,
  MinchoBabelFileMetadata,
  MinchoCompilationMetadata,
  MinchoStaticCssEvalMetadata,
  PluginOptions
} from "./types.js";
export { analyzeExtractCalls as internalAnalyzeExtractCalls } from "./extractionCalls/analysis.js";
export { jsxCssPropExtractCalls as internalJsxCssPropExtractCalls } from "./jsxCssProp/options.js";
export {
  canonicalExtractCallsFile as internalCanonicalExtractCallsFile,
  resolveExtractCallsFile as internalResolveExtractCallsFile
} from "./extractionCalls/filesystem.js";
export { ExtractCallsError as InternalExtractCallsError } from "./extractionCalls/types.js";
export type { PreparedExtractCalls as InternalPreparedExtractCalls } from "./extractionCalls/types.js";
export {
  inspectCommonJs as internalInspectCommonJs,
  commonJsToEsmPlugin as internalCommonJsToEsmPlugin
} from "./commonjs/esm.js";
export { getModuleReference as internalGetModuleReference } from "./commonjs/bindings.js";
export { hasConfiguredGeneratorOverride as internalHasConfiguredGeneratorOverride } from "./optimizations/runtimeCodegen.js";
export { normalizeTypeScriptCommonJs as internalNormalizeTypeScriptCommonJs } from "./commonjs/modules.js";

export {
  createModuleGraph as internalCreateModuleGraph,
  parseModuleProgram as internalParseModuleProgram,
  type ModuleGraph as InternalModuleGraph,
  type ModuleGraphFlow as InternalModuleGraphFlow,
  type ModuleGraphRequest as InternalModuleGraphRequest,
  type ModuleTarget as InternalModuleTarget
} from "./moduleGraph.js";

export { SourceAstCache as InternalSourceAstCache } from "./staticCssEval/moduleParser.js";
export { getStaticCssEvalLiteralRequireImportPath as internalGetStaticCssEvalLiteralRequireImportPath } from "./staticCssEval/cjsBindings.js";
export { analyzeSource as internalAnalyzeSource } from "./sourceAnalysis.js";
export {
  semanticExports as internalSemanticExports,
  type SemanticExportRequest as InternalSemanticExportRequest
} from "./semanticExports.js";

export { analyzePureFunctions as internalAnalyzePureFunctions } from "./optimizations/pureFunctions.js";

export {
  annotateRecipeFactories as internalAnnotateRecipeFactories,
  collectRuntimeCandidates as internalCollectRuntimeCandidates,
  analyzeRuntimeExpressions as internalAnalyzeRuntimeExpressions,
  applyRuntimeExpressions as internalApplyRuntimeExpressions,
  type RuntimeCandidates as InternalRuntimeCandidates
} from "./optimizations/runtimeExpressions.js";

export {
  measureBundleBytes as internalMeasureBundleBytes,
  bundleSizeMetric as internalBundleSizeMetric
} from "./bundleSize.js";
export type { BundleBytes, BundleSizeOptions } from "./bundleSize.js";

export { hasObservablePrototypeMutation as internalHasObservablePrototypeMutation } from "./optimizations/recipeMetadata.js";

export {
  recipeFactoryKind as internalRecipeFactoryKind,
  decodeRecipePayload as internalDecodeRecipePayload
} from "./optimizations/recipeFactories.js";

/** @internal Ignore erased type syntax when observing emitted-source effects. */
export { isRuntimeSourceReference as internalIsRuntimeSourceReference } from "./optimizations/runtimeSourceReference.js";
