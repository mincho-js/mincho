import type { NodePath, types as t } from "@babel/core";
import {
  getModuleReference,
  referencesModuleExport
} from "../commonjs/bindings.js";
import type { PluginState, ProgramScope } from "../types.js";
import { analyzeExtractCalls } from "./analysis.js";
import { isBuiltInExtractionCall } from "./builtins.js";
import {
  canonicalExtractCallsFile,
  runExtractCallsAnalysisSync
} from "./filesystem.js";
import type { PreparedExtractCalls } from "./types.js";

export function prepareExtractCalls(
  path: NodePath<t.Program>,
  state: PluginState
): PreparedExtractCalls | undefined {
  if (state.opts.preparedExtractCalls) return state.opts.preparedExtractCalls;
  if (state.opts.extractCalls === undefined) return undefined;

  const root = state.file.opts.root ?? process.cwd();
  const filename = canonicalExtractCallsFile(
    state.file.opts.filename ?? `${root}/__mincho_owner__.ts`
  );

  return runExtractCallsAnalysisSync(
    analyzeExtractCalls({
      extractCalls: state.opts.extractCalls,
      root,
      filename,
      source: state.file.code,
      program: path
    })
  );
}

export function isExtractionCall(
  callee: NodePath<t.Node>,
  strict = true
): boolean {
  if (isBuiltInExtractionCall(callee, strict)) return true;

  const program = callee.scope.getProgramParent() as ProgramScope;
  const config = program.minchoData?.extractCalls;

  if (
    callee.isIdentifier() &&
    config?.localBindings.includes(callee.node.name)
  ) {
    const binding = callee.scope.getBinding(callee.node.name);

    if (binding && binding === program.getBinding(callee.node.name))
      return true;
  }

  return (
    config !== undefined &&
    Object.entries(
      getModuleReference(callee)?.kind === "require"
        ? (config.requires ?? config.imports)
        : config.imports
    ).some(([source, names]) =>
      names.some((name) => referencesModuleExport(callee, source, name, strict))
    )
  );
}

export function isInsideExtractCallsImplementation(
  path: NodePath<t.Node>
): boolean {
  const config = (path.scope.getProgramParent() as ProgramScope).minchoData
    ?.extractCalls;

  return Boolean(
    config?.protectedFunctions.length &&
    path.findParent(
      (parent) =>
        parent.isFunction() &&
        config.protectedFunctions.some(
          ({ start, end }) =>
            parent.node.start === start && parent.node.end === end
        )
    )
  );
}
