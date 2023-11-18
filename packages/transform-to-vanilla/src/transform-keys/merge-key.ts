const RegExp = /[$_]$/;

// == Interface ================================================================
export function removeSignSimbol(keyStr: string) {
  return hasSignSimbol(keyStr) ? keyStr.trim().replace(RegExp, "") : keyStr;
}

// == Utils ====================================================================
function hasSignSimbol(keyStr: string) {
  return RegExp.test(keyStr);
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("Remove Key Sign Symbol", () => {
    it("No Sign Symbol", () => {
      expect(removeSignSimbol("boxShadow")).toBe("boxShadow");
    });
    it("Has Sign Symbol", () => {
      expect(removeSignSimbol("boxShadow$")).toBe("boxShadow");
      expect(removeSignSimbol("transform_")).toBe("transform");
    });
  });
}
