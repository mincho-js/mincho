export function atRuleKeyInfo(key: string) {
  const spaceIndex = key.indexOf(" ");

  const isRules = key.startsWith("@");
  const isToplevelRules = isRules && spaceIndex !== -1;

  return {
    isRules,
    isToplevelRules,
    atRuleKey: isRules
      ? isToplevelRules
        ? key.substring(0, spaceIndex)
        : key
      : "",
    atRuleNestedKey: isToplevelRules ? key.substring(spaceIndex + 1) : ""
  };
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("Toplevel atRule", () => {
    it("Is Toplevel", () => {
      const { isRules, isToplevelRules, atRuleKey, atRuleNestedKey } =
        atRuleKeyInfo("@media screen and (min-width: 768px)");
      expect(isRules).toBeTruthy();
      expect(isToplevelRules).toBeTruthy();
      expect(atRuleKey).toBe("@media");
      expect(atRuleNestedKey).toBe("screen and (min-width: 768px)");
    });

    it("Nested atRule", () => {
      const { isRules, isToplevelRules, atRuleKey, atRuleNestedKey } =
        atRuleKeyInfo("@media");
      expect(isRules).toBeTruthy();
      expect(isToplevelRules).toBeFalsy();
      expect(atRuleKey).toBe("@media");
      expect(atRuleNestedKey).toBe("");
    });
  });
}
