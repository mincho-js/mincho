import { NodePath, Node, types as t, PluginPass } from '@babel/core';
import { Scope } from '@babel/traverse';

export type PluginOptions = {
  result: [string, string];
  /**
   * @deprecated no longer used
   */
  path?: string;
};

export type PluginState = PluginPass & { opts: PluginOptions };

export type ProgramScope = Scope & {
  macaronData: {
    imports: Map<string, t.Identifier>;
    bindings: Array<NodePath<t.Node>>;
    nodes: Array<t.Node>;
    cssFile: string;
  };
};

export type MacaronNode = ProgramScope['macaronData']['nodes'][number];
