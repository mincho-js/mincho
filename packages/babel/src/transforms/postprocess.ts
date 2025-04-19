import { NodePath, types as t, transformFromAstSync } from "@babel/core";
import type { PluginState, ProgramScope } from "@/types.js";

export default function postprocess(
  path: NodePath<t.Node>,
  state: PluginState
) {
  const programParent = path.scope as ProgramScope;

  // Use transformFromAstSync instead of generator
  const program = t.program(programParent.minchoData.nodes as t.Statement[]);
  const result = transformFromAstSync(program, "", {
    ast: false,
    code: true
  });

  const cssExtract = result?.code || "";

  state.opts.result = [programParent.minchoData.cssFile, cssExtract];
}
