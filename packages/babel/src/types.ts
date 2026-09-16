import type { NodePath, PluginPass, types as t } from "@babel/core";
import type { Scope } from "@babel/traverse";
import type {
  ResolutionDependency,
  StaticCssEvalCacheKey,
  StaticCssEvalDiagnostic,
  StaticCssEvalProvider
} from "./staticCssEval/types.js";
import type { DefineRulesCxConditionsMetadata } from "./defineRulesCxConditionsTypes.js";
import type {
  ExtractCalls,
  PreparedExtractCalls
} from "./extractionCalls/types.js";

export type { ExtractCalls } from "./extractionCalls/types.js";

export interface PluginOptions {
  result: [string, string];

  /** Additional build-time calls; local files are relative to the Babel root. */
  extractCalls?: ExtractCalls;

  /** @internal Module identities and protected implementations from bundler analysis. */
  preparedExtractCalls?: PreparedExtractCalls;
  jsxCssProp?: boolean;
  jsxCssPropTransformed?: boolean;
  optimize?: {
    defineRulesCxConditions?: boolean;
  };

  /** @internal Prepared sync provider supplied by bundler prepasses only. */
  staticCssEvalProvider?: StaticCssEvalProvider;
}

export interface MinchoStaticCssEvalMetadata {
  dependencies: ResolutionDependency[];
  diagnostics: StaticCssEvalDiagnostic[];
  cacheKeys: StaticCssEvalCacheKey[];
  resolvedModuleIds: string[];
}

export interface MinchoBabelFileMetadata {
  minchoStaticCssEval?: MinchoStaticCssEvalMetadata;
  minchoDefineRulesCxConditions?: DefineRulesCxConditionsMetadata;
  [key: string]: unknown;
}

export interface PluginState extends PluginPass {
  opts: PluginOptions;
  file: Omit<PluginPass["file"], "metadata"> & {
    metadata: MinchoBabelFileMetadata;
  };
}

export interface ProgramScope extends Scope {
  minchoData: {
    imports: Map<string, t.Identifier>;
    bindings: Array<NodePath<t.Node>>;
    nodes: Array<t.Node>;
    cssFile: string;
    extractCalls?: PreparedExtractCalls;
  };
}

export type MinchoNode = ProgramScope["minchoData"]["nodes"][number];
