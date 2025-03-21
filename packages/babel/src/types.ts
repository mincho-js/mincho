import type { NodePath, PluginPass, types as t } from "@babel/core";
import type { Scope } from "@babel/traverse";

export type PluginOptions = {
  result: [string, string];
};

export type PluginState = PluginPass & {
  opts: PluginOptions;
};

export type ProgramScope = Scope & {
  minchoData: {
    imports: Map<string, t.Identifier>;
    bindings: Array<NodePath<t.Node>>;
    nodes: Array<t.Node>;
    cssFile: string;
  };
};

export type MinchoNode = ProgramScope["minchoData"]["nodes"][number];
