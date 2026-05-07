import type { NodePath, PluginPass, types as t } from "@babel/core";
import type { Scope } from "@babel/traverse";

export interface PluginOptions {
  result: [string, string];
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
