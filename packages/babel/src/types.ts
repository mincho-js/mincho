import type { NodePath, PluginPass, types as t } from "@babel/core";
import type { Scope } from "@babel/traverse";
import type {
  ResolutionDependency,
  StaticCssEvalCacheKey,
  StaticCssEvalDiagnostic,
  StaticCssEvalProvider
} from "./staticCssEval/types.js";

export interface PluginOptions {
  result: [string, string];
  jsxCssProp?: boolean;
  jsxCssPropTransformed?: boolean;
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
  };
}

export type MinchoNode = ProgramScope["minchoData"]["nodes"][number];
