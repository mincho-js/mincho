import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compilerAuthoringEndpoint } from "./authoringContract.js";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore This test runs as ESM; ignore import.meta for CJS declaration emission.
const fixtureRequire = createRequire(import.meta.url);

describe("authoring endpoint host conditions", () => {
  it.each([
    ["@vanilla-extract/css", "style", "vanilla-extract-css.esm.js"],
    ["@vanilla-extract/css", "style", "vanilla-extract-css.browser.esm.js"],
    ["@vanilla-extract/css", "style", "vanilla-extract-css.browser.cjs.js"],
    ["@vanilla-extract/recipes", "recipe", "vanilla-extract-recipes.esm.js"]
  ])(
    "recognizes the compiler installation runtime build %s %s %s",
    (source, name, build) => {
      const filename = fixtureRequire.resolve(source);
      const endpoint = realpathSync(join(dirname(filename), build)).replaceAll(
        "\\",
        "/"
      );
      expect(readFileSync(endpoint, "utf8").length).toBeGreaterThan(0);
      expect(compilerAuthoringEndpoint(source, name, endpoint)).toMatchObject({
        id: endpoint
      });
      for (const spelling of [
        `/@fs${endpoint}`,
        endpoint,
        "host:rewritten-endpoint"
      ]) {
        expect(compilerAuthoringEndpoint(spelling, name, endpoint)).toEqual(
          compilerAuthoringEndpoint(source, name, endpoint)
        );
      }
      expect(
        compilerAuthoringEndpoint(
          source,
          name === "recipe" ? "style" : "recipe",
          endpoint
        )
      ).toBeUndefined();
      expect(
        compilerAuthoringEndpoint(source, name, `/host-alias/${build}`)
      ).toBeUndefined();
      expect(
        compilerAuthoringEndpoint(source, "unrelated", endpoint)
      ).toBeUndefined();
    }
  );
});

it.each([false, true])(
  "parameter substitution respects intervening with: %s",
  async (intercepted) => {
    const { parseSync, traverse } = await import("@babel/core");
    const { authoringArgumentPlan } = await import("./authoringContract.js");
    const ast = parseSync(
      `function wrap(color){${intercepted ? 'with({color:"blue"}){' : ""}return style({color});${intercepted ? "}" : ""}}`,
      { sourceType: "script", configFile: false, babelrc: false }
    )!;
    let result: unknown;
    traverse(ast, {
      FunctionDeclaration(fn) {
        const parameters = fn.get("params");
        if (!parameters.every((p) => p.isIdentifier()))
          throw new Error("Expected parameters");
        fn.traverse({
          CallExpression(call) {
            const arg = call.get("arguments")[0];
            result = authoringArgumentPlan(arg, parameters);
          }
        });
      }
    });
    expect(result === undefined).toBe(intercepted);
  }
);

it.each([false, true])(
  "uses runtime slots for authoring arguments: erased this=%s",
  async (erased) => {
    const { parseSync, traverse } = await import("@babel/core");
    const { authoringArgumentPlan, substituteAuthoringPlan } =
      await import("./authoringContract.js");
    const ast = parseSync(
      `function wrap(${erased ? "this:void," : ""}color:string,fallback:string){return style({color,fallback})}`,
      {
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["typescript"] }
      }
    )!;
    let plan:
      import("./authoringContract.js").AuthoringArgumentPlan | undefined;
    traverse(ast, {
      FunctionDeclaration(fn) {
        const parameters = fn.get("params");
        if (!parameters.every((p) => p.isIdentifier()))
          throw Error("parameters");
        fn.traverse({
          CallExpression(call) {
            plan = authoringArgumentPlan(
              call.get("arguments.0") as import("@babel/core").NodePath,
              parameters
            );
          }
        });
      }
    });
    expect(
      substituteAuthoringPlan(plan!, [
        { kind: "literal", value: "red" },
        { kind: "literal", value: "blue" }
      ])
    ).toEqual({
      kind: "object",
      entries: [
        {
          kind: "property",
          key: "color",
          value: { kind: "literal", value: "red" }
        },
        {
          kind: "property",
          key: "fallback",
          value: { kind: "literal", value: "blue" }
        }
      ]
    });
  }
);
