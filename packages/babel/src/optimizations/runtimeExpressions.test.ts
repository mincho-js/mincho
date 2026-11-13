import { describe, expect, it } from "vitest";
import type { TransformOptions } from "@babel/core";
import { SourceAstCache } from "../staticCssEval/moduleParser.js";
import {
  analyzeRuntimeExpressions,
  annotateRecipeFactories,
  applyRuntimeExpressions
} from "./runtimeExpressions.js";

describe("runtime optimizer parser configuration", () => {
  it.each([
    ["owner", false],
    ["owner", true],
    ["dependency", false],
    ["dependency", true]
  ] as const)(
    "preserves configured parser plugins in the %s with cached parsing=%s",
    (location, cached) => {
      const decorated =
        "export @sealed class View { render(): unknown { return <div />; } }";
      const recipe = `
        import { createRuntimeFn } from "@mincho-js/css/rules/createRuntimeFn";
        export const button = createRuntimeFn({
          defaultClassName: "base",
          variantClassNames: {},
          defaultVariants: {},
          compoundVariants: []
        });
      `;
      const source = `${location === "owner" ? decorated : ""}
        import { button } from "/recipe.tsx";
        export const cls = button();
      `;
      const options = {
        filename: "/app.tsx",
        source,
        parserCache: cached ? new SourceAstCache() : undefined,
        parserPlugins: [
          ["decorators", { decoratorsBeforeExport: false }]
        ] satisfies NonNullable<TransformOptions["parserOpts"]>["plugins"]
      };
      const flow = analyzeRuntimeExpressions(options);
      let step = flow.next();

      while (!step.done) {
        const request = step.value;
        step = flow.next(
          request.kind === "load" && request.id === "/recipe.tsx"
            ? `${location === "dependency" ? decorated : ""} ${recipe}`
            : request.kind === "resolve" && request.source === "/recipe.tsx"
              ? request.source
              : null
        );
      }

      expect(step.value.calls).toHaveLength(1);

      const output = applyRuntimeExpressions({
        ...options,
        ...(cached ? { ast: step.value.ast } : {}),
        replacements: [{ key: step.value.calls[0]!.key, value: "base" }]
      });

      expect(output?.code).toContain('export const cls = "base";');
      if (location === "owner") {
        expect(output?.code).toContain("@sealed");
        expect(output?.code).toContain("<div />");
      }
    }
  );
});

describe("serialized recipe purity", () => {
  it("preserves serialized bytes and respects lexical shadowing", () => {
    const source =
      'import {createRuntimeFn as recipe} from "@mincho-js/css/rules/createRuntimeFn";export const a=recipe({});export const b=(recipe)({});function shadow(recipe){return recipe({});}';

    const transformed = annotateRecipeFactories(source, "/sidecar.js");

    expect(transformed.replaceAll("/*#__PURE__*/", "")).toBe(source);
    expect(transformed.match(/#__PURE__/g)).toHaveLength(2);
    expect(transformed).toContain(
      "function shadow(recipe){return recipe({});}"
    );
  });

  it("marks only the known pure factory and retains argument effects", () => {
    const source = `
      import { createRuntimeFn as recipe } from "@mincho-js/css/rules/createRuntimeFn";
      import { createDefineRulesCssRuntime } from "@mincho-js/css/defineRules/createDefineRulesCssRuntime";
      export const unused = recipe(readConfig());
      export const registered = createDefineRulesCssRuntime({});
    `;

    const transformed = annotateRecipeFactories(source, "/sidecar.js");

    expect(transformed).toMatch(/\/\*#__PURE__\*\/\s*recipe\(readConfig\(\)\)/);
    expect(transformed).toContain(
      "registered = createDefineRulesCssRuntime({})"
    );
    expect(transformed.match(/#__PURE__/g)).toHaveLength(1);
  });

  it("retains unrelated serialized runtimes unchanged", () => {
    const source =
      'import { createRuntimeFn } from "@vanilla-extract/recipes/createRuntimeFn"; export const recipe = createRuntimeFn({});';

    expect(annotateRecipeFactories(source, "/sidecar.js")).toBe(source);
  });
});
