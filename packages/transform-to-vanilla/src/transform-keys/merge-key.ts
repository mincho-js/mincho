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
    it("Has Sign Symbol to the end", () => {
      expect(removeSignSimbol("boxShadow$")).toBe("boxShadow");
      expect(removeSignSimbol("transform_")).toBe("transform");
    });
    it("Has Sign Symbol in the middle or at the first", () => {
      expect(removeSignSimbol("box$Shadow")).toBe("box$Shadow");
      expect(removeSignSimbol("trans_form")).toBe("trans_form");
      expect(removeSignSimbol("$boxShadow")).toBe("$boxShadow");
      expect(removeSignSimbol("_transform")).toBe("_transform");
    });
  });
}
