import {
  parseSync,
  transformSync,
  transformFromAstSync,
  types as t
} from "@babel/core";
import { createHash } from "node:crypto";
import { serialize } from "node:v8";
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

// Larger compiler modules were cheaper to reparse than to copy. Keep AST reuse
// for small inputs; immutable summaries remain cached regardless of this limit.
const MAX_CLONED_SOURCE_LENGTH = 8 * 1024;

/** Copy parser-owned data, including offsets, comments and shared locations. */
function cloneAst<T>(value: T, copies = new Map<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;

  const previous = copies.get(value);
  if (previous) return previous as T;

  const result = (
    Array.isArray(value) ? new Array(value.length) : {}
  ) as Record<string, unknown>;
  copies.set(value, result);

  for (const key of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[key];
    result[key] =
      child !== null && typeof child === "object"
        ? cloneAst(child, copies)
        : child;
  }

  return result as T;
}

/** Cached files contain no NodePaths or Scopes; each user receives a fresh AST. */
export class SourceAstCache {
  private readonly entries = new Map<
    string,
    { value: unknown; bytes: number }
  >();
  private bytes = 0;
  private readonly inputKeys = new WeakMap<
    StaticCssModuleParserInput,
    {
      source: string;
      filename: string;
      options: string;
      syntax: string;
      file: string;
    }
  >();

  constructor(
    private readonly observe?: (hit: boolean, kind?: string) => void,
    private maxEntries = 512,
    private maxBytes = 64 * 1024 * 1024
  ) {}

  observeResult(kind: string, hit: boolean): void {
    this.observe?.(hit, kind);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  resize(maxEntries: number, maxBytes: number): void {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;

    while (this.entries.size > maxEntries || this.bytes > maxBytes) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }

  /** Immutable analysis values share the parser's LRU and memory budget. */
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry.value as T;
  }

  set<T>(key: string, value: T, bytes: number): void {
    bytes += Buffer.byteLength(key);

    const previous = this.entries.get(key);

    if (previous) this.bytes -= previous.bytes;

    this.entries.delete(key);

    if (bytes > this.maxBytes || this.maxEntries <= 0) return;

    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    this.resize(this.maxEntries, this.maxBytes);
  }

  parse(input: StaticCssModuleParserInput): t.File {
    const reusable = input.source.length <= MAX_CLONED_SOURCE_LENGTH;
    const ast = this.read(input, reusable);

    return reusable ? cloneAst(ast) : ast;
  }

  private keys(input: StaticCssModuleParserInput) {
    const source = input.source;
    const filename = input.resolvedFile;
    const options = JSON.stringify(input.parserOptions);
    const previous = this.inputKeys.get(input);
    if (
      previous?.source === source &&
      previous.filename === filename &&
      previous.options === options
    )
      return previous;

    // Hash code units directly, rather than allocating an escaped JSON copy.
    // UTF-8 would collapse different lone surrogates to the replacement char.
    const syntax = createHash("sha256")
      .update(options)
      .update("\0")
      .update(source, "utf16le")
      .digest("hex");

    const file = createHash("sha256")
      .update(JSON.stringify(filename))
      .update(syntax)
      .digest("hex");

    const value = { source, filename, options, syntax, file };
    this.inputKeys.set(input, value);

    return value;
  }

  /** Only filename-independent immutable summaries may use this cache. ASTs,
   * NodePaths, resolution and code frames remain file-specific.
   */
  analyzeSyntax<T>(
    input: StaticCssModuleParserInput,
    name: string,
    inspect: (ast: t.File) => T
  ): T {
    return this.inspect(
      input,
      `syntax:${name}:${this.keys(input).syntax}`,
      inspect,
      false
    );
  }

  /** Inspect the immutable parse without allocating a second AST or Babel scopes. */
  analyze<T>(
    input: StaticCssModuleParserInput,
    name: string,
    inspect: (ast: t.File) => T
  ): T {
    return this.inspect(
      input,
      `analysis:${name}:${this.keys(input).file}`,
      inspect
    );
  }

  private inspect<T>(
    input: StaticCssModuleParserInput,
    key: string,
    inspect: (ast: t.File) => T,
    retainAst = true
  ): T {
    const previous = this.get<T>(key);
    this.observeResult("analysis", previous !== undefined);

    if (previous !== undefined) return previous;

    const result = inspect(this.read(input, retainAst));
    this.set(key, result, Buffer.byteLength(JSON.stringify(result)));

    return result;
  }

  private read(input: StaticCssModuleParserInput, retainAst = true): t.File {
    const key = `ast:${this.keys(input).file}`;
    let cached = this.get<t.File>(key);
    this.observe?.(Boolean(cached));

    if (!cached) {
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

      cached = ast;
      // Calibrated against retained heap for token, TSX and compiler fixtures:
      // use twice the serialized AST size rather than source bytes.
      // This is cache accounting, not a bound on total heap or process RSS.
      if (retainAst && input.source.length <= MAX_CLONED_SOURCE_LENGTH)
        this.set(key, ast, serialize(ast).byteLength * 2);
    }

    return cached;
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
