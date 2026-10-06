import { describe, expect, it } from "vitest";
import { annotateRecipeFactories } from "./runtimeExpressions.js";

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
