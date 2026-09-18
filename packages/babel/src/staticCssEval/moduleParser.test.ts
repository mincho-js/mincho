import { describe, expect, it } from "vitest";
import { parseStaticCssModuleProgram, SourceAstCache } from "./moduleParser.js";
import { STATIC_CSS_MODULE_CACHE_PARSER_OPTIONS } from "./moduleCache.js";

describe("source AST cache", () => {
  it("shares parsing while keeping scopes, node mutations and source offsets isolated", () => {
    const hits: boolean[] = [];
    const cache = new SourceAstCache((hit) => hits.push(hit));
    const input = {
      resolvedFile: "/app.ts",
      source: "export const x = 42;",
      parserOptions: STATIC_CSS_MODULE_CACHE_PARSER_OPTIONS
    };

    const first = parseStaticCssModuleProgram(input, cache);
    const second = parseStaticCssModuleProgram(input, cache);
    first.programPath.scope.rename("x", "renamed");

    expect(second.programPath.scope.hasBinding("x")).toBe(true);
    expect(second.ast.program.body[0]?.start).toBe(0);
    expect(second.ast.program.body[0]?.end).toBe(input.source.length);
    expect(second.programPath).not.toBe(first.programPath);

    parseStaticCssModuleProgram(
      { ...input, source: "export const x = 43;" },
      cache
    );

    expect(hits).toEqual([false, true, false]);
  });
});
