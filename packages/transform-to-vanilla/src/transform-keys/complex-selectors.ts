import {
  type TransformContext,
  initTransformContext
} from "../transform-object/index";

export function isSelectorskey(key: string) {
  return key === "selectors";
}

export function isComplexKey(key: string) {
  return key.includes("&");
}

export function isSimpleSelectorKey(key: string) {
  return key.startsWith("[") || key.startsWith(":");
}

export function nestedSelectorKey(key: string, context: TransformContext) {
  return key.replaceAll("&", context.parentSelector);
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("Is complex selector", () => {
    it("selectors", () => {
      expect(isSelectorskey("selectors")).toBeTruthy();
    });

    it("complex selector", () => {
      expect(isComplexKey("&:hover:not(:active)")).toBeTruthy();
      expect(isComplexKey("nav li > &")).toBeTruthy();
    });

    it("Not complex selector", () => {
      expect(isComplexKey(":hover")).toBeFalsy();
    });

    it("Simple Selector", () => {
      expect(
        isSimpleSelectorKey(`[href^="https://"][href$=".org"]`)
      ).toBeTruthy();
      expect(isSimpleSelectorKey(":hover:active")).toBeTruthy();
    });

    it("Nested Selector", () => {
      const context: TransformContext = {
        ...structuredClone(initTransformContext),
        parentSelector: "nav li > &"
      };
      expect(nestedSelectorKey("&:hover", context)).toBe("nav li > &:hover");
      expect(nestedSelectorKey("&:hover:not(:active)", context)).toBe(
        "nav li > &:hover:not(:active)"
      );
      expect(nestedSelectorKey(":root[dir=rtl] &", context)).toBe(
        ":root[dir=rtl] nav li > &"
      );
    });
  });
}
