import type { NodePath, PluginPass, types as t } from "@babel/core";
import type { Scope } from "@babel/traverse";
import type { StaticCssEvalProvider } from "./staticCssEval/types.js";

export interface PluginOptions {
  result: [string, string];
  jsxCssProp?: boolean;
  jsxCssPropTransformed?: boolean;
  /** @internal Prepared sync provider supplied by bundler prepasses only. */
  staticCssEvalProvider?: StaticCssEvalProvider;
}

export interface PluginState extends PluginPass {
  opts: PluginOptions;
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
