import { describe, expect, it } from "vitest";
import { analyzeSource } from "./sourceAnalysis.js";
import { semanticExports } from "./semanticExports.js";
import { SourceAstCache } from "./staticCssEval/moduleParser.js";

describe("immutable syntax facts", () => {
  it("keeps distinct UTF-16 source literals distinct in content keys", () => {
    const cache = new SourceAstCache();
    const demand = [{ name: "token", members: [] }];
    const surrogate = semanticExports(
      "/a.ts",
      `export const token = "${String.fromCharCode(0xd800)}";`,
      demand,
      cache
    );

    const replacement = semanticExports(
      "/a.ts",
      `export const token = "${String.fromCharCode(0xfffd)}";`,
      demand,
      cache
    );

    expect(surrogate).not.toBeNull();
    expect(replacement).not.toBe(surrogate);
  });

  it("shares summaries across filenames while keeping mutable ASTs isolated", () => {
    const events: string[] = [];
    const cache = new SourceAstCache(
      (hit, kind) => events.push(`${kind}:${hit}`),
      32,
      65536
    );

    const source =
      'import { css } from "@mincho-js/css"; export const x = css({color:"red"});';

    const a = analyzeSource("/a.tsx", source, cache);
    const b = analyzeSource("/b.tsx", source, cache);

    expect(a).toBe(b);
    expect(events).toContain("analysis:true");

    const input = {
      resolvedFile: "/a.tsx",
      source,
      parserOptions: {
        plugins: ["jsx", "typescript"] as ["jsx", "typescript"],
        sourceType: "module" as const,
        jsx: true,
        typescript: true
      }
    };

    const ast = cache.parse(input);
    ast.program.body.length = 0;

    expect(cache.parse(input).program.body).toHaveLength(2);

    input.source = "export const changed = 1;";

    expect(cache.parse(input).program.body).toHaveLength(1);
  });

  it("separates changed syntax and requested export/member sets, including negative facts", () => {
    const cache = new SourceAstCache();

    expect(analyzeSource("/a.tsx", "const x = 1", cache).calls).toBe(false);
    expect(analyzeSource("/a.tsx", "const x = sideEffect()", cache).calls).toBe(
      true
    );

    const source = 'export const tokens = {red:"red",blue:"blue"};';
    const red = [{ name: "tokens", members: ["red"] }];
    const blue = [{ name: "tokens", members: ["blue"] }];

    expect(semanticExports("/a.ts", source, red, cache)).toBe(
      semanticExports("/b.ts", source, red, cache)
    );
    expect(semanticExports("/a.ts", source, red, cache)).not.toBe(
      semanticExports("/a.ts", source, blue, cache)
    );
    expect(
      semanticExports("/a.ts", source + " sideEffect();", red, cache)
    ).toBeNull();
    expect(
      semanticExports("/b.ts", source + " sideEffect();", red, cache)
    ).toBeNull();
  });
});
