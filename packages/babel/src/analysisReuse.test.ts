import { describe, expect, it, vi } from "vitest";
import { SourceAstCache } from "./staticCssEval/moduleParser.js";
import { analyzeSource } from "./sourceAnalysis.js";
import { semanticExports } from "./semanticExports.js";

describe("immutable source analysis", () => {
  it.each(["ts", "cts", "mts"])(
    "analyzes TypeScript assertions and generic arrows in .%s files",
    (extension) => {
      const cache = new SourceAstCache();
      const filename = `/plain.${extension}`;
      const source =
        "export const value = <number>1; export const identity = <T>(value: T) => value;";
      const facts = analyzeSource(filename, source, cache);

      expect(facts).toMatchObject({
        calls: false,
        componentJsx: false,
        cssJsx: false
      });
      expect(analyzeSource(filename, source, cache)).toBe(facts);
      expect(() => analyzeSource("/plain.tsx", source, cache)).toThrow();
    }
  );

  it.each(["tsx", "jsx", "js", "mjs", "cjs"])(
    "keeps JSX candidates in .%s files",
    (extension) => {
      expect(
        analyzeSource(
          `/view.${extension}`,
          "export const App = () => <Box css={{color: 'red'}} />;"
        )
      ).toMatchObject({ componentJsx: true, cssJsx: true });
    }
  );

  it("shares summaries while giving mutating transforms independent ASTs", () => {
    const observe = vi.fn();
    const cache = new SourceAstCache(observe);
    const source = "export const App = () => <div {...props} />;";
    const first = analyzeSource("/App.tsx", source, cache);

    expect(first.cssJsx).toBe(true);
    expect(analyzeSource("/App.tsx", source, cache)).toBe(first);

    const input = {
      resolvedFile: "/App.tsx",
      source,
      parserOptions: {
        plugins: ["jsx", "typescript"] as ("jsx" | "typescript")[],
        sourceType: "unambiguous" as const,
        jsx: true,
        typescript: true
      }
    };

    cache.parse(input).program.body.length = 0;

    expect(cache.parse(input).program.body).toHaveLength(1);
    expect(analyzeSource("/App.tsx", source, cache)).toBe(first);
    expect(observe).toHaveBeenCalledWith(true, "analysis");
  });

  it("recognizes escaped imports, CommonJS, JSX consumers and calls", () => {
    expect(
      analyzeSource(
        "/a.ts",
        String.raw`import {css} from "@mincho-js/\u0063ss"; css({});`
      ).sources
    ).toEqual(["@mincho-js/css"]);
    expect(
      analyzeSource("/a.cts", "import css = require('x'); export = css;")
        .commonJs
    ).toBe(true);
    expect(
      analyzeSource("/a.tsx", "export const x = <Box />;").componentJsx
    ).toBe(true);
    expect(analyzeSource("/a.ts", "const x = recipe({});").calls).toBe(true);
  });
});

describe("semantic export fingerprints", () => {
  it.each([
    {
      reason: "unknown captured binding",
      source: "export const styles = () => Math.max(1, 2);",
      members: []
    },
    {
      reason: "missing object member",
      source: "export const styles = { button: { color: 'red' } };",
      members: ["missing"]
    },
    {
      reason: "member of a non-object",
      source: "export const styles = 1;",
      members: ["button"]
    },
    {
      reason: "missing export",
      source: "export const unused = 1;",
      members: []
    },
    {
      reason: "cyclic helper captures",
      source:
        "function a() { return b(); } function b() { return a(); } export const styles = a;",
      members: []
    },
    {
      reason: "oversized export",
      source: `export const styles = [${Array(513).fill("0").join(",")}];`,
      members: []
    }
  ])("caches unsupported exports: $reason", ({ source, members }) => {
    const observe = vi.fn();
    const cache = new SourceAstCache(observe);
    const requests = [{ name: "styles", members }];

    expect(semanticExports("/tokens.ts", source, requests, cache)).toBeNull();
    observe.mockClear();

    expect(semanticExports("/tokens.ts", source, requests, cache)).toBeNull();
    expect(observe).toHaveBeenCalledExactlyOnceWith(true, "analysis");
  });

  it.each(["ts", "cts", "mts"])(
    "tracks TypeScript assertions and generic helpers in .%s files",
    (extension) => {
      const cache = new SourceAstCache();
      const filename = `/tokens.${extension}`;
      const source =
        "export const color = <string>'red'; export const identity = <T>(value: T) => value;";
      const requests = [{ name: "color", members: [] }];
      const first = semanticExports(filename, source, requests, cache);

      expect(first).not.toBeNull();
      expect(semanticExports(filename, source, requests, cache)).toBe(first);
      expect(
        semanticExports(
          filename,
          source.replace("'red'", "'blue'"),
          requests,
          cache
        )
      ).not.toBe(first);
      expect(
        semanticExports(
          filename,
          source.replace("=> value;", "=> value as T;"),
          requests,
          cache
        )
      ).toBe(first);
      expect(
        semanticExports("/tokens.tsx", source, requests, cache)
      ).toBeNull();
    }
  );

  it.each(["tsx", "jsx", "js", "mjs", "cjs"])(
    "keeps JSX helpers in semantic analysis of .%s files",
    (extension) => {
      expect(
        semanticExports(
          `/view.${extension}`,
          "export const view = () => <div />;",
          [{ name: "view", members: [] }]
        )
      ).not.toBeNull();
    }
  );

  const fingerprint = (
    source: string,
    name = "styles",
    members: string[] = []
  ) => semanticExports("/tokens.ts", source, [{ name, members }]);

  it("tracks selected members and their local captures rather than unrelated exports", () => {
    const source = `const color = 'red'; export const styles = {button: {color}, card: {color:'blue'}}; export const unused = 1;`;
    const first = fingerprint(source, "styles", ["button"]);

    expect(first).not.toBeNull();
    expect(
      fingerprint(
        source.replace("'blue'", "'green'").replace("unused = 1", "unused = 2"),
        "styles",
        ["button"]
      )
    ).toBe(first);
    expect(
      fingerprint(source.replace("'red'", "'orange'"), "styles", ["button"])
    ).not.toBe(first);
    expect(
      fingerprint(source + "\nexport const another = 3;", "styles", ["button"])
    ).toBe(first);
  });

  it("includes helper implementations and captured values", () => {
    const source =
      "const factor = 2; export function make(n) { return {padding:n*factor}; } export const unused = 1;";

    const first = fingerprint(source, "make");

    expect(first).not.toBeNull();
    expect(
      fingerprint(source.replace("unused = 1", "unused = 2"), "make")
    ).toBe(first);
    expect(
      fingerprint(source.replace("factor = 2", "factor = 3"), "make")
    ).not.toBe(first);
    expect(
      fingerprint(source.replace("n*factor", "n+factor"), "make")
    ).not.toBe(first);
  });

  it.each([
    "export const styles = {}; effect();",
    "export let styles = {};",
    "export const styles = {}; const unused = effect();",
    "exports.styles = {};",
    "export const styles = { get color() { return 'red'; } };",
    "import './effect'; export const styles = {};",
    "const a = b; const b = a; export const styles = a;",
    "const a = b; const b = 1; export const styles = {};",
    "export const styles = {"
  ])("retains full invalidation for unknown effects: %s", (source) =>
    expect(fingerprint(source)).toBeNull()
  );
});
