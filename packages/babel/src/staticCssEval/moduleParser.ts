import { transformSync, types as t } from "@babel/core";
import type { NodePath, PluginObj } from "@babel/core";
import type { StaticCssEvalParserOptionsKey } from "./types.js";

export interface StaticCssModuleParserInput {
  readonly resolvedFile: string;
  readonly source: string;
  readonly parserOptions: StaticCssEvalParserOptionsKey;
}

export interface StaticCssModuleParserResult {
  readonly ast: t.File;
  readonly programPath: NodePath<t.Program>;
}

export function parseStaticCssModuleProgram(
  input: StaticCssModuleParserInput
): StaticCssModuleParserResult {
  const programPathRef: { current?: NodePath<t.Program> } = {};
  const captureProgramPathPlugin: PluginObj = {
    visitor: {
      Program(path: NodePath<t.Program>) {
        programPathRef.current = path;
        path.stop();
      }
    }
  };
  const result = transformSync(input.source, {
    filename: input.resolvedFile,
    ast: true,
    code: false,
    sourceType: input.parserOptions.sourceType,
    configFile: false,
    babelrc: false,
    parserOpts: {
      plugins: [
        ...(input.parserOptions.jsx ? (["jsx"] as const) : []),
        ...(input.parserOptions.typescript ? (["typescript"] as const) : [])
      ]
    },
    plugins: [captureProgramPathPlugin]
  });
  const programPath = programPathRef.current;

  if (!programPath || !result?.ast) {
    throw new TypeError(
      `Failed to parse static css module ${input.resolvedFile}`
    );
  }

  return { ast: result.ast, programPath };
}
