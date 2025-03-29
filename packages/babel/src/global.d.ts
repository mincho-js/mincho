declare module "@babel/helper-module-imports" {
  import { NodePath, Node, types as t } from "@babel/core";
  export function addNamed(
    path: NodePath<Node>,
    name: string,
    source: string,
    opts?: { nameHint?: string }
  ): t.Identifier;
}
