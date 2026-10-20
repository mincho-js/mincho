import { describe, expect, it } from "vitest";
import { resolveOptimizationOptions } from "./optimizationMode.js";

describe("optimization mode", () => {
  it("keeps evaluation shortcuts opt-in while retaining the runtime optimization profiles", () => {
    expect(resolveOptimizationOptions("development")).toEqual({
      pureFunctions: true,
      staticRecipes: false,
      styledComponents: false,
      runtimeCodegen: false,
      jsxRuntimeGuards: false,
      dependencyGraph: false,
      staticStyles: false,
      staticScopedCx: false,
      symbolicTokens: false
    });
    expect(resolveOptimizationOptions("production")).toEqual({
      pureFunctions: true,
      staticRecipes: true,
      styledComponents: true,
      runtimeCodegen: true,
      jsxRuntimeGuards: true,
      dependencyGraph: false,
      staticStyles: false,
      staticScopedCx: false,
      symbolicTokens: false
    });
  });

  it.each(["development", "production"] as const)(
    "preserves explicit evaluation shortcut overrides in %s",
    (mode) => {
      expect(
        resolveOptimizationOptions(
          mode,
          { dependencyGraph: true, staticStyles: true },
          { dependencyGraph: undefined, staticStyles: undefined }
        )
      ).toMatchObject({ dependencyGraph: true, staticStyles: true });
      expect(
        resolveOptimizationOptions(
          mode,
          { dependencyGraph: true, staticStyles: true },
          { dependencyGraph: false, staticStyles: false }
        )
      ).toMatchObject({ dependencyGraph: false, staticStyles: false });
    }
  );

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
      jsxRuntimeGuards: false,
      dependencyGraph: false,
      staticStyles: false,
      staticScopedCx: false,
      symbolicTokens: false,
      defineRulesCxConditions: true
    });
  });
});
