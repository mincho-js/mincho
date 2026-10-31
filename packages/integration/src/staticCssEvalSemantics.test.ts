import { describe, expect, it } from "vitest";
import { babelTransformSource } from "./babel.js";
import { internalStaticCssEvalLimits } from "@mincho-js/babel";

function transform(modules: Record<string, string>) {
  return babelTransformSource({
    filename: "/owner.tsx",
    source: modules["/owner.tsx"]!,
    babel: {
      jsxCssProp: true,
      staticCssEvalSourceProvider: {
        resolve: (_importer, specifier) => ({ id: specifier }),
        load: (id) =>
          modules[id] === undefined ? null : { sourceText: modules[id] }
      }
    }
  });
}

describe("imported CSS runtime semantics", () => {
  it.each(["exporter", "sibling"])(
    "keeps imported scalar values dynamic when %s mutation analysis exhausts its budget",
    async (location) => {
      const mutation = `function helper() { ${"void 0;".repeat(internalStaticCssEvalLimits.maxStaticLiteralNodeCount)} return t; } helper().c = "blue";`;
      const result = await transform({
        "/owner.tsx":
          'import { t } from "/t.ts"; import "/m.ts"; export const View = () => <div css={{ color: t.c }} />;',
        "/t.ts":
          'export const t = { c: "red" };' +
          (location === "exporter" ? mutation : ""),
        "/m.ts":
          location === "sibling"
            ? 'import { t } from "/t.ts";' + mutation
            : "export {};"
      });
      expect(result.result[1]).not.toContain('color: "red"');
      expect(result.code).toContain("t.c");
    }
  );

  it("checks deep execution imports without applying literal evaluation depth limits", async () => {
    const modules: Record<string, string> = {
      "/owner.tsx":
        'import { t } from "/t.ts"; import "/init0.ts"; export const View = () => <div css={{ color: t.c }} />;',
      "/t.ts": 'export const t = { c: "red" };'
    };
    const depth = internalStaticCssEvalLimits.maxImportDepth + 2;
    for (let index = 0; index < depth; index++) {
      modules[`/init${index}.ts`] = `import "/init${index + 1}.ts";`;
    }
    const last = `/init${depth}.ts`;
    modules[last] = "export {};";
    expect((await transform(modules)).result[1]).toContain('color: "red"');
    modules[last] = 'import { t } from "/t.ts"; t.c = "blue";';
    const mutated = await transform(modules);
    expect(mutated.result[1]).not.toContain('color: "red"');
    expect(mutated.code).toContain("t.c");
    expect(mutated.staticCssEval?.dependencyFiles).toContain(last);
  });

  it("does not spend mutation analysis on a large unrelated dependency", async () => {
    const result = await transform({
      "/owner.tsx":
        'import { t } from "/t.ts"; import "/large.ts"; export const View = () => <div css={{ color: t.c }} />;',
      "/t.ts": 'export const t = { c: "red" };',
      "/large.ts": `import { unrelated } from "/unrelated.ts"; export function render() { ${"void 0;".repeat(4000)} return unrelated; }`,
      "/unrelated.ts": 'export const unrelated = { text: "hello" };'
    });
    expect(result.result[1]).toContain('color: "red"');
    expect(result.staticCssEval?.dependencyFiles).toContain("/large.ts");
  });

  it("does not freeze values changed by a sibling side-effect module and watches the mutator", async () => {
    const result = await transform({
      "/owner.tsx":
        'import { t } from "/t.ts"; import "/m.ts"; export const View = () => <div css={{ color: t.c }} />;',
      "/t.ts": 'export const t = { c: "red" };',
      "/m.ts": 'import { t } from "/t.ts"; t.c = "blue";'
    });
    expect(result.result[1]).not.toContain('color: "red"');
    expect(result.code).toContain("t.c");
    expect(result.staticCssEval?.dependencyFiles).toContain("/m.ts");
  });

  it("does not fold a local alias across its temporal dead zone", async () => {
    await expect(
      transform({
        "/owner.tsx":
          'import { t } from "/t.ts"; export const View = () => <div css={{ color: t }} />;',
        "/t.ts": 'export const t = u; const u = "red";'
      })
    ).rejects.toThrow(/before.*initializ|temporal|TDZ/i);
  });

  it.each([
    'import { t } from "/barrel.ts"; const alias = t; alias.c = "blue";',
    'import * as tokens from "/barrel.ts"; tokens.t.c = "blue";',
    'const { t } = require("/barrel.ts"); t.c = "blue";'
  ])("tracks transitive mutators through reexports: %s", async (mutator) => {
    const modules = {
      "/owner.tsx":
        'import { t } from "/t.ts"; import "/init.ts"; export const View = () => <div css={{ color: t.c }} />;',
      "/t.ts": 'export const t = { c: "red" };',
      "/barrel.ts": 'export { t } from "/t.ts";',
      "/init.ts": 'import "/m.ts";',
      "/m.ts": mutator
    };
    const result = await transform(modules);
    expect(result.code).toContain("t.c");
    expect(result.result[1]).not.toContain('color: "red"');
    expect(result.staticCssEval?.dependencyFiles).toEqual(
      expect.arrayContaining(["/init.ts", "/m.ts", "/barrel.ts"])
    );
    // Removing the effect restores static evaluation on the next transform.
    modules["/m.ts"] = 'import "/barrel.ts";';
    expect((await transform(modules)).result[1]).toContain('color: "red"');
  });

  it.each([
    ['export let token = "red";', "token"],
    ['export const token = Object.freeze({ c: "red" });', "token.c"],
    ['export const token = { get c() { return "red"; } };', "token.c"],
    ['export enum Token { c = "red" }', "Token.c"]
  ])(
    "retains unproven ESM scalar leaves at runtime: %s",
    async (source, expression) => {
      const binding = expression.split(".")[0];
      const result = await transform({
        "/owner.tsx": `import { ${binding} } from "/t.ts"; export const View = () => <div css={{ color: ${expression} }} />;`,
        "/t.ts": source
      });
      expect(result.code).toContain(expression);
      expect(result.result[1]).not.toContain('color: "red"');
    }
  );
});
