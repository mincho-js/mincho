import { describe, expect, it } from "vitest";
import { babelTransformSource } from "./babel.js";
import { resolveOptimizationOptions } from "./optimizationMode.js";

describe("optimization mode", () => {
  it("keeps evaluation shortcuts opt-in while retaining the runtime optimization profiles", () => {
    expect(resolveOptimizationOptions("development")).toEqual({
      pureFunctions: true,
      staticRecipes: false,
      styledComponents: false,
      runtimeCodegen: false,
      jsxRuntimeGuards: false,
      compactRuntime: false,
      compactMetadata: false,
      sizeAware: false,
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
      compactRuntime: false,
      compactMetadata: false,
      sizeAware: false,
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
      compactRuntime: false,
      compactMetadata: false,
      sizeAware: false,
      dependencyGraph: false,
      staticStyles: false,
      staticScopedCx: false,
      symbolicTokens: false,
      defineRulesCxConditions: true
    });
  });
});

// Layout preparation must follow the same profile/override as styled flattening,
// even when the other production optimizations remain enabled.
describe("styledComponents Layout integration", () => {
  it.each([
    ["development", undefined, false],
    ["production", undefined, true],
    ["production", false, false],
    ["development", true, true]
  ] as const)(
    "%s with override %s lowers: %s",
    async (mode, override, enabled) => {
      const result = await babelTransformSource({
        filename: "/virtual/layout-optimization.tsx",
        source:
          'import { Item } from "@mincho-js/react/layout"; export const C = () => <Item as="button" width={80}>Save</Item>;',
        babel: {
          optimize: resolveOptimizationOptions(mode, {
            styledComponents: override
          })
        }
      });
      expect(result.result[1].includes("compileLayoutClass")).toBe(enabled);
      expect(result.code.includes('import "@mincho-js/css/layout.css"')).toBe(
        enabled
      );
      expect(result.code.includes("<Item ")).toBe(!enabled);
      expect(result.code.includes("<button ")).toBe(enabled);
    }
  );
});
