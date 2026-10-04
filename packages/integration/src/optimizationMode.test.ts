import { describe, expect, it } from "vitest";
import { resolveOptimizationOptions } from "./optimizationMode.js";

describe("optimization mode", () => {
  it("keeps helper evaluation in development and all optimizations in production", () => {
    expect(resolveOptimizationOptions("development")).toEqual({
      pureFunctions: true,
      staticRecipes: false,
      styledComponents: false,
      runtimeCodegen: false
    });
    expect(resolveOptimizationOptions("production")).toEqual({
      pureFunctions: true,
      staticRecipes: true,
      styledComponents: true,
      runtimeCodegen: true
    });
  });

  it("preserves individual overrides and does not erase them with undefined", () => {
    expect(
      resolveOptimizationOptions(
        "development",
        {
          staticRecipes: true,
          styledComponents: true,
          defineRulesCxConditions: true
        },
        { staticRecipes: undefined, styledComponents: false }
      )
    ).toEqual({
      pureFunctions: true,
      staticRecipes: true,
      styledComponents: false,
      runtimeCodegen: false,
      defineRulesCxConditions: true
    });
  });
});
