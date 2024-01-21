export function complexKeyInfo(key: string) {
  return key.includes("&");
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("Is complex selector", () => {
    it("complex selector", () => {
      expect(complexKeyInfo("&:hover:not(:active)")).toBeTruthy();
      expect(complexKeyInfo("nav li > &")).toBeTruthy();
    });

    it("Not complex selecot", () => {
      expect(complexKeyInfo(":hover")).toBeFalsy();
    });
  });
}
