export function isSelectorskey(key: string) {
  return key === "selectors";
}

export function isComplexKey(key: string) {
  return key.includes("&");
}

export function isSimpleSelectorKey(key: string) {
  return key.startsWith("[") || key.startsWith(":");
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

    it("Not complex selecot", () => {
      expect(isComplexKey(":hover")).toBeFalsy();
    });

    it("Simple Selector", () => {
      expect(
        isSimpleSelectorKey(`[href^="https://"][href$=".org"]`)
      ).toBeTruthy();
      expect(isSimpleSelectorKey(":hover:active")).toBeTruthy();
    });
  });
}
