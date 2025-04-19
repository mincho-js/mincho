import type { AtRulesPrefix } from "../transform-object/index.js";
import type { NonNullableString } from "../types/string.js";

export function isRuleKey(key: string) {
  return key.startsWith("@");
}

export function atRuleKeyInfo(key: string) {
  const spaceIndex = key.indexOf(" ");

  const isToplevelRules = spaceIndex !== -1;

  return {
    isToplevelRules,
    atRuleKey: isToplevelRules ? key.substring(0, spaceIndex) : key,
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

export function atRuleKeyMerge(
  atRule: AtRulesPrefix | NonNullableString,
  firstKey: string,
  secondKey: string
) {
  if (firstKey === "" || secondKey.startsWith(firstKey)) {
    return secondKey;
  }
  if (secondKey === "") {
    return firstKey;
  }

  switch (atRule) {
    case "@layer":
      return atRuleKeyMergeByDot(firstKey, secondKey);
    default:
      return atRuleKeyMergeByAnd(firstKey, secondKey);
  }
}

function atRuleKeyMergeByAnd(firstKey: string, secondKey: string) {
  if (firstKey === "not") {
    return `not(${secondKey})`;
  }
  return `${firstKey} and ${secondKey}`;
}

function atRuleKeyMergeByDot(firstKey: string, secondKey: string) {
  return `${firstKey}.${secondKey}`;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("Toplevel atRule", () => {
    it("Is AtRule", () => {
      expect(isRuleKey("@media screen and (min-width: 768px)")).toBeTruthy();
      expect(isRuleKey("@media")).toBeTruthy();

      expect(isRuleKey("screen and (min-width: 768px)")).toBeFalsy();
      expect(isRuleKey("_hover")).toBeFalsy();
    });

    it("Is Toplevel", () => {
      expect(
        atRuleKeyInfo("@media screen and (min-width: 768px)")
      ).toStrictEqual({
        isToplevelRules: true,
        atRuleKey: "@media",
        atRuleNestedKey: "screen and (min-width: 768px)"
      });
    });

    it("Nested atRule", () => {
      expect(atRuleKeyInfo("@media")).toStrictEqual({
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

    it("Nested Rule Key", () => {
      // Media
      expect(
        atRuleKeyMerge(
          "@media",
          "(prefers-color-scheme: dark)",
          "(prefers-reduced-motion)"
        )
      ).toBe("(prefers-color-scheme: dark) and (prefers-reduced-motion)");

      // Supports
      expect(
        atRuleKeyMerge(
          "@supports",
          "selector(h2 > p)",
          "font-tech(color-COLRv1)"
        )
      ).toBe("selector(h2 > p) and font-tech(color-COLRv1)");

      // Container
      expect(
        atRuleKeyMerge("@container", "(width > 400px)", "(height > 400px)")
      ).toBe("(width > 400px) and (height > 400px)");

      // Layer
      expect(atRuleKeyMerge("@layer", "framework", "layout")).toBe(
        "framework.layout"
      );

      // With empty
      expect(
        atRuleKeyMerge(
          "@media",
          "",
          "(prefers-color-scheme: dark) and (prefers-reduced-motion)"
        )
      ).toBe("(prefers-color-scheme: dark) and (prefers-reduced-motion)");

      // Not
      expect(
        atRuleKeyMerge(
          "@media",
          "not",
          "(prefers-color-scheme: dark) and (prefers-reduced-motion)"
        )
      ).toBe("not((prefers-color-scheme: dark) and (prefers-reduced-motion))");
      expect(
        atRuleKeyMerge(
          "@media",
          "not all",
          "(prefers-color-scheme: dark) and (prefers-reduced-motion)"
        )
      ).toBe(
        "not all and (prefers-color-scheme: dark) and (prefers-reduced-motion)"
      );
    });
  });
}
