import { describe, expect, it, vi } from "vitest";
import {
  createSymbolicTokenArtifact,
  rebindSymbolicTokenArtifact
} from "./symbolicTokens.js";
import { RuntimeOptimizations } from "./runtimeOptimizations.js";
import { CompilationCache } from "./compilationCache.js";
import { getCompilerIdentity } from "./diskCache.js";
import type { StaticCssEvalSourceProvider } from "./babel.js";

describe("symbolic token references", () => {
  it.each([
    'try { result = color; } catch { result = "fallback"; } const color = brand;',
    'try { result = run(); } catch { result = "fallback"; } const color = brand; function run() { return color; }',
    "if (false) { var color = brand; } result = color;"
  ])("preserves local alias initialization order: %s", async (body) => {
    const source = 'var brand="var(--brand)"; export {brand};';
    const symbolicTokens = createSymbolicTokenArtifact(
      source,
      "/tokens.ts",
      await getCompilerIdentity(),
      new Set(["var(--brand)"])
    );

    const code = `import {brand} from "/tokens.ts"; let result; ${body}`;

    const execute = (text: string) =>
      new Function(
        "brand",
        text.replace(/import[^;]+;/g, "") + "\nreturn result;"
      )("var(--brand)");

    const output = await new RuntimeOptimizations().transform(
      {
        filename: "/app.ts",
        source: code,
        babel: {
          optimize: {
            symbolicTokens: true,
            pureFunctions: false,
            staticRecipes: false,
            styledComponents: false,
            runtimeCodegen: false
          }
        }
      },
      { code, result: ["", ""] },
      {
        resolve: (_owner, id) => ({ id }),

        load: () => ({ source, symbolicTokens })
      }
    );

    expect(execute(output.code)).toBe(execute(code));
  });

  it("captures only actual compiler variables exported as immutable strings", async () => {
    const source =
      'var brand="var(--brand)", fake="var(--fake)", object={brand}; export {brand, fake, object};';

    const artifact = createSymbolicTokenArtifact(
      source,
      "/tokens.ts",
      await getCompilerIdentity(),
      new Set(["var(--brand)"])
    );

    expect(artifact?.references).toEqual({ brand: "var(--brand)" });
  });

  it("replays CSS on hits while reusing reference analysis after a CSS-only edit", async () => {
    const compiler = await getCompilerIdentity();
    let source = 'import "red.css"; var brand="var(--brand)"; export {brand};';
    const load = vi.fn(() => ({
      source,
      symbolicTokens: createSymbolicTokenArtifact(
        source,
        "/tokens.ts",
        compiler,
        new Set(["var(--brand)", "var(--changed)"])
      )
    }));

    const provider: StaticCssEvalSourceProvider = {
      resolve: (_owner, id) => ({ id }),

      load
    };

    const code =
      'import {brand as color} from "/tokens.ts"; export const style={color};';

    const cache = new CompilationCache();
    const parser = vi.spyOn(cache.parser, "parse");
    const runtime = new RuntimeOptimizations();
    const options = {
      filename: "/app.ts",
      source: code,
      babel: {
        compilationCache: cache,
        optimize: {
          symbolicTokens: true,
          staticRecipes: false,
          styledComponents: false,
          runtimeCodegen: false
        }
      }
    };

    const run = () =>
      runtime.transform(options, { code, result: ["", ""] }, provider);

    const first = await run();

    expect(first.code).toContain('"var(--brand)"');
    expect(first.code).toContain('import "/tokens.ts"');

    const parses = parser.mock.calls.length;
    const loads = load.mock.calls.length;
    source = source.replace('"red.css"', '"blue.css"');
    cache.invalidate("/tokens.ts");

    expect((await run()).code).toBe(first.code);
    expect(parser).toHaveBeenCalledTimes(parses);
    expect(load.mock.calls.length).toBeGreaterThan(loads);
    expect(load.mock.results.at(-1)?.value.source).toContain('"blue.css"');

    source = source.replace("var(--brand)", "var(--changed)");
    cache.invalidate("/tokens.ts");

    expect((await run()).code).toContain('"var(--changed)"');
    expect(parser.mock.calls.length).toBeGreaterThan(parses);

    const changedParses = parser.mock.calls.length;
    source =
      'import "green.css"; var brand={value:"var(--changed)"}; export {brand};';
    cache.invalidate("/tokens.ts");

    expect((await run()).code).toBe(code);
    expect(parser.mock.calls.length).toBeGreaterThan(changedParses);
    expect(load.mock.results.at(-1)?.value.source).toContain('"green.css"');
  });

  it("invalidates a re-export when its target changes", async () => {
    const compiler = await getCompilerIdentity();
    let target = "/red.ts";
    const provider: StaticCssEvalSourceProvider = {
      resolve: (_owner, id) => ({ id }),

      load: (id) => {
        if (id === "/tokens.ts")
          return { source: `export {brand} from "${target}";` };

        const value = id === "/red.ts" ? "var(--red)" : "var(--blue)";
        const source = `export const brand="${value}";`;

        return {
          source,
          symbolicTokens: createSymbolicTokenArtifact(
            source,
            id,
            compiler,
            new Set([value])
          )
        };
      }
    };

    const code =
      'import {brand} from "/tokens.ts"; export const style={color:brand};';

    const cache = new CompilationCache();
    const runtime = new RuntimeOptimizations();
    const options = {
      filename: "/app.ts",
      source: code,
      babel: {
        compilationCache: cache,
        optimize: {
          symbolicTokens: true,
          pureFunctions: false,
          staticRecipes: false,
          styledComponents: false,
          runtimeCodegen: false
        }
      }
    };

    const run = () =>
      runtime.transform(options, { code, result: ["", ""] }, provider);

    expect((await run()).code).toContain('"var(--red)"');

    target = "/blue.ts";
    cache.invalidate("/tokens.ts");

    const output = await run();

    expect(output.code).toContain('"var(--blue)"');
    expect(output.code).toContain('import "/tokens.ts"');
  });

  it("rejects stale source, incompatible compiler and mutable containers", async () => {
    const source = 'var brand="var(--brand)"; export {brand};';
    const artifact = createSymbolicTokenArtifact(
      source,
      "/tokens.ts",
      await getCompilerIdentity(),
      new Set(["var(--brand)"])
    )!;

    for (const symbolicTokens of [
      { ...artifact, version: 2 },
      { ...artifact, compiler: "foreign" },
      rebindSymbolicTokenArtifact(artifact, "different")
    ]) {
      const code =
        'import {brand} from "/tokens.ts"; export const result=brand;';

      const output = await new RuntimeOptimizations().transform(
        {
          filename: "/app.ts",
          source: code,
          babel: {
            optimize: {
              symbolicTokens: true,
              staticRecipes: false,
              styledComponents: false,
              runtimeCodegen: false
            }
          }
        },
        { code, result: ["", ""] },
        {
          resolve: (_owner, id) => ({ id }),

          load: () => ({
            source,
            symbolicTokens: symbolicTokens as typeof artifact
          })
        }
      );

      expect(output.code).toBe(code);
    }
  });
});
