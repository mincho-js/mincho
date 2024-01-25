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

export function anonymousKeyInfo(keyStr: string) {
  const isAnimationName = isAnonymousSymbol("animationName", keyStr);
  const isFontFamily = isAnonymousSymbol("fontFamily", keyStr);

  return {
    isAnimationName,
    isFontFamily,
    isAnonymousSymbol: isAnimationName || isFontFamily
  };
}

function isAnonymousSymbol(anonymousKey: string, keyStr: string) {
  return (
    keyStr === anonymousKey ||
    keyStr === `${anonymousKey}$` ||
    keyStr === `${anonymousKey}_`
  );
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("Toplevel atRule", () => {
    it("Is Toplevel", () => {
      expect(
        atRuleKeyInfo("@media screen and (min-width: 768px)")
      ).toStrictEqual({
        isRules: true,
        isToplevelRules: true,
        atRuleKey: "@media",
        atRuleNestedKey: "screen and (min-width: 768px)"
      });
    });

    it("Nested atRule", () => {
      expect(atRuleKeyInfo("@media")).toStrictEqual({
        isRules: true,
        isToplevelRules: false,
        atRuleKey: "@media",
        atRuleNestedKey: ""
      });
    });

    it("Anonymous atRule", () => {
      expect(anonymousKeyInfo("animationName")).toStrictEqual({
        isAnimationName: true,
        isFontFamily: false,
        isAnonymousSymbol: true
      });

      expect(anonymousKeyInfo("animationName_")).toStrictEqual({
        isAnimationName: true,
        isFontFamily: false,
        isAnonymousSymbol: true
      });

      expect(anonymousKeyInfo("animationName$")).toStrictEqual({
        isAnimationName: true,
        isFontFamily: false,
        isAnonymousSymbol: true
      });

      expect(anonymousKeyInfo("fontFamily")).toStrictEqual({
        isAnimationName: false,
        isFontFamily: true,
        isAnonymousSymbol: true
      });

      expect(anonymousKeyInfo("fontFamily_")).toStrictEqual({
        isAnimationName: false,
        isFontFamily: true,
        isAnonymousSymbol: true
      });

      expect(anonymousKeyInfo("fontFamily$")).toStrictEqual({
        isAnimationName: false,
        isFontFamily: true,
        isAnonymousSymbol: true
      });
    });
  });
}
