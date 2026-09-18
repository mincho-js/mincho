import {
  parseSync,
  transformSync,
  transformFromAstSync,
  types as t
} from "@babel/core";
import { createHash } from "node:crypto";
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

/** Cached files contain no NodePaths or Scopes; each user receives a fresh AST. */
export class SourceAstCache {
  private readonly entries = new Map<string, { ast: t.File; bytes: number }>();
  private bytes = 0;

  constructor(private readonly observe?: (hit: boolean) => void) {}

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  parse(input: StaticCssModuleParserInput): t.File {
    const key = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");

    let entry = this.entries.get(key);
    this.observe?.(Boolean(entry));

    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    } else {
      const ast = parseSync(input.source, {
        filename: input.resolvedFile,
        configFile: false,
        babelrc: false,
        parserOpts: {
          sourceType: input.parserOptions.sourceType,
          plugins: [
            ...(input.parserOptions.jsx ? ["jsx" as const] : []),
            ...(input.parserOptions.typescript ? ["typescript" as const] : [])
          ]
        }
      });
      if (!ast) throw new TypeError(`Cannot parse ${input.resolvedFile}`);

      entry = { ast, bytes: Buffer.byteLength(input.source) };

      if (entry.bytes <= 64 * 1024 * 1024) {
        this.entries.set(key, entry);
        this.bytes += entry.bytes;

        while (this.entries.size > 512 || this.bytes > 64 * 1024 * 1024) {
          const oldest = this.entries.keys().next().value!;
          this.bytes -= this.entries.get(oldest)!.bytes;
          this.entries.delete(oldest);
        }
      }
    }

    return structuredClone(entry.ast);
  }
}

export function parseStaticCssModuleProgram(
  input: StaticCssModuleParserInput,
  cache?: SourceAstCache
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

  const options = {
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
  } satisfies Parameters<typeof transformSync>[1];

  const result = cache
    ? transformFromAstSync(cache.parse(input), input.source, {
        ...options,
        cloneInputAst: false
      })
    : transformSync(input.source, options);

  const programPath = programPathRef.current;

  if (!programPath || !result?.ast) {
    throw new TypeError(
      `Failed to parse static css module ${input.resolvedFile}`
    );
  }

  return { ast: result.ast, programPath };
}
