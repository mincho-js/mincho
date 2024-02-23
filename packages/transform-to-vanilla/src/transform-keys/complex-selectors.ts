export function isSelectorskey(key: string) {
  return key === "selectors";
}

export function isComplexKey(key: string) {
  return key.includes("&");
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("Is complex selector", () => {
    it("complex selector", () => {
      expect(isComplexKey("&:hover:not(:active)")).toBeTruthy();
      expect(isComplexKey("nav li > &")).toBeTruthy();
    });

    it("Not complex selecot", () => {
      expect(isComplexKey(":hover")).toBeFalsy();
    });
  });
}
