import { type PluginObj } from "@babel/core";
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

export function minchoBabelPlugin(): PluginObj<PluginState> {
  return {
    name: "mincho-babel-plugin",
    visitor: {
      Program: {
        enter(path, state) {
          normalizeTypeScriptCommonJs(path, state.file);

          if (isDefineRulesCxConditionsEnabled(state)) {
            state.file.metadata[
              defineRulesCxConditionsOptimizationMetadataKey
            ] = true;
          }

          preprocess(path, prepareExtractCalls(path, state));
          state.opts.jsxCssPropTransformed = preprocessJsxCssProp(path, state);
        },

        exit(path, state) {
          removeUnusedJsxCssPropCssModuleImports(path);
          postprocess(path, state);
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
export { styledComponentPlugin as minchoStyledComponentPlugin } from "./styled.js";
export type {
  ExtractCalls,
  MinchoBabelFileMetadata,
  MinchoStaticCssEvalMetadata,
  PluginOptions
} from "./types.js";
export { analyzeExtractCalls as internalAnalyzeExtractCalls } from "./extractionCalls/analysis.js";
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

export {
  createModuleGraph as internalCreateModuleGraph,
  parseModuleProgram as internalParseModuleProgram,
  type ModuleGraph as InternalModuleGraph,
  type ModuleGraphFlow as InternalModuleGraphFlow,
  type ModuleGraphRequest as InternalModuleGraphRequest,
  type ModuleTarget as InternalModuleTarget
} from "./moduleGraph.js";
