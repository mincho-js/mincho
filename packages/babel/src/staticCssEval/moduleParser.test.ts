import { describe, expect, it } from "vitest";
import { parseSync } from "@babel/core";
import { analyzeSource } from "../sourceAnalysis.js";
import { parseStaticCssModuleProgram, SourceAstCache } from "./moduleParser.js";
import { STATIC_CSS_MODULE_CACHE_PARSER_OPTIONS } from "./moduleCache.js";

describe("source AST cache", () => {
  it("reparses large modules without retaining or cloning their ASTs", () => {
    const hits: boolean[] = [];
    const cache = new SourceAstCache((hit) => hits.push(hit));
    const input = {
      resolvedFile: "/large.ts",
      source: Array.from(
        { length: 512 },
        (_, index) => `export const value${index} = ${index};`
      ).join("\n"),
      parserOptions: STATIC_CSS_MODULE_CACHE_PARSER_OPTIONS
    };
    const first = cache.parse(input);
    const second = cache.parse(input);

    first.program.body.length = 0;

    expect(second.program.body).toHaveLength(512);
    expect(hits).toEqual([false, false]);
  });

  it("copies every parser field and shared comment reference without leaking mutations", () => {
    const cache = new SourceAstCache();
    const input = {
      resolvedFile: "/comments.tsx",
      source: "/* shared */ export const view = <div title='hello' />; // end",
      parserOptions: STATIC_CSS_MODULE_CACHE_PARSER_OPTIONS
    };
    const expected = parseSync(input.source, {
      filename: input.resolvedFile,
      configFile: false,
      babelrc: false,
      parserOpts: {
        sourceType: input.parserOptions.sourceType,
        plugins: ["jsx", "typescript"]
      }
    });
    const first = cache.parse(input);
    const second = cache.parse(input);

    expect(first).toEqual(structuredClone(expected));
    expect(second).toEqual(first);
    expect(first.comments![0]).toBe(first.program.body[0]!.leadingComments![0]);
    expect(first.comments![0]).not.toBe(second.comments![0]);
    expect(first.program.body[0]!.loc).not.toBe(second.program.body[0]!.loc);

    first.program.body[0]!.loc!.start.line = 99;
    first.comments![0]!.value = "mutated";

    expect(cache.parse(input)).toEqual(second);
  });

  it("retains only the summary for a syntax-only eligibility check", () => {
    const events: string[] = [];
    const cache = new SourceAstCache((hit, kind = "ast") =>
      events.push(`${kind}:${hit}`)
    );
    const input = {
      resolvedFile: "/ordinary.ts",
      source: "export const version = 1;",
      parserOptions: {
        plugins: ["typescript"] as ["typescript"],
        sourceType: "unambiguous" as const,
        jsx: false,
        typescript: true
      }
    };
    const summary = analyzeSource(input.resolvedFile, input.source, cache);

    expect(analyzeSource(input.resolvedFile, input.source, cache)).toBe(
      summary
    );
    cache.parse(input);
    cache.parse(input);

    expect(events).toEqual([
      "analysis:false",
      "ast:false",
      "analysis:true",
      "ast:false",
      "ast:true"
    ]);
  });

  it("does not retain an AST that exceeds the byte budget despite its short source", () => {
    const hits: boolean[] = [];
    const source = "export const values = [" + "1,".repeat(300) + "];";
    const cache = new SourceAstCache((hit) => hits.push(hit), 512, 4096);
    const input = {
      resolvedFile: "/large.ts",
      source,
      parserOptions: STATIC_CSS_MODULE_CACHE_PARSER_OPTIONS
    };

    expect(Buffer.byteLength(source)).toBeLessThan(4096);
    expect(cache.parse(input).program.body).toHaveLength(1);
    expect(cache.parse(input).program.body).toHaveLength(1);
    expect(hits).toEqual([false, false]);
  });

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
